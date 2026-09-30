'use strict';
// Two (and three) independent server instances in one process, sharing a fake
// in-memory GCS bucket that enforces ifGenerationMatch. Exercises the real
// backupToCloudStorage / restoreFromCloudStorage code paths the way Cloud Run
// runs them, without touching any real bucket. Also covers the Google sign-in
// exchange with a stubbed ID-token verifier.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, ROLES, ADMIN_EMAIL, tmpDir, baseEnv, loadServerInstance, fakeBucket, client } = require('./helpers');

const shared = baseEnv(tmpDir('shared')); // same keys/secret for every instance, like prod
const bucket = fakeBucket();
const instances = [];

async function boot(label, { seedDisk } = {}) {
  const dataDir = tmpDir(label);
  if (seedDisk) fs.copyFileSync(seedDisk, path.join(dataDir, 'scores.json'));
  // GCS is "enabled" so the real backup/restore code runs, but against the fake
  // bucket injected below. The bucket name is bogus and ADC is hidden (HOME,
  // GOOGLE_APPLICATION_CREDENTIALS), so nothing could reach real storage anyway.
  const env = { ...shared, DATA_DIR: dataDir, HOME: dataDir, GCS_BUCKET: 'local-test-not-a-real-bucket' };
  delete env.DISABLE_GCS;
  const srv = loadServerInstance(env);
  srv._setBucketForTests(bucket);
  const server = await srv.start({ port: 0 });
  const inst = { srv, server, call: client(`http://127.0.0.1:${server.address().port}`) };
  instances.push(inst);
  return inst;
}

async function signIn(inst, email) {
  const r = await inst.call('POST', '/api/auth/google', { credential: email });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

test.after(async () => {
  for (const i of instances) await new Promise(r => i.server.close(r));
});

let A, B, adminA, adminB, capA;
const ids = {};

test('Google sign-in exchange: admins, volunteers, strangers, bad tokens', async () => {
  A = await boot('inst-a');
  adminA = await signIn(A, ADMIN_EMAIL);
  const me = await A.call('GET', '/api/admin/admins', undefined, adminA);
  assert.equal(me.body.me, ADMIN_EMAIL);

  await A.call('POST', '/api/admin/assign', { taskId: ROLES.registration, firstName: 'Ana', lastName: 'Lopez', email: 'Ana.Lopez+devfest@gmail.com', phone: '650-555-0101', isCaptain: true }, adminA);
  await A.call('POST', '/api/admin/assign', { taskId: ROLES.food, firstName: 'Cy', lastName: 'Nguyen', email: 'cy@example.com', phone: '650-555-0103', isCaptain: true }, adminA);

  // Gmail dots/+tags normalise, so the captain's Google account matches her sign-up.
  const ana = await A.call('POST', '/api/auth/google', { credential: 'analopez@gmail.com' });
  assert.equal(ana.status, 200);
  assert.equal(ana.body.role, 'volunteer');
  capA = ana.body.token;

  assert.equal((await A.call('POST', '/api/auth/google', { credential: 'stranger@example.com' })).status, 403);
  assert.equal((await A.call('POST', '/api/auth/google', { credential: 'unverified@example.com' })).status, 401);
  assert.equal((await A.call('POST', '/api/auth/google', { credential: 'bad-token' })).status, 401);
  assert.equal((await A.call('POST', '/api/auth/google', {})).status, 400);

  // First sign-in bound her Google identity, so a later contact-email change keeps her access.
  await A.call('PATCH', '/api/team/me', { email: 'ana.work@example.com' }, capA);
  const again = await A.call('POST', '/api/auth/google', { credential: 'analopez@gmail.com' });
  assert.equal(again.status, 200);
  assert.equal((await A.call('POST', '/api/auth/google', { credential: 'ana.work@example.com' })).status, 403, 'contact email alone cannot sign in');
});

test('a new instance restores everything from GCS on cold start even though its disk has scores', async () => {
  await A.call('POST', '/api/admin/tasks/seed', { roleId: 'all' }, adminA);
  const gcs = bucket.read();
  assert.ok(Object.keys(gcs.tasks).length >= 30);

  // Same situation as a Cloud Run container: the image ships data/scores.json
  // with demo scores, which used to make the server skip the GCS restore.
  B = await boot('inst-b', { seedDisk: path.join(ROOT, 'data', 'scores.json') });
  assert.ok(B.srv.getState().scores.length > 0, 'disk scores loaded');
  adminB = await signIn(B, ADMIN_EMAIL);
  const boardA = (await A.call('GET', '/api/admin/tasks', undefined, adminA)).body;
  const boardB = (await B.call('GET', '/api/admin/tasks', undefined, adminB)).body;
  assert.deepEqual(boardB.totals, boardA.totals, 'tasks restored');
  assert.deepEqual(
    boardB.roles.map(r => [r.id, r.captains.map(c => c.name)]),
    boardA.roles.map(r => [r.id, r.captains.map(c => c.name)]),
    'captains restored'
  );
  const reg = boardA.roles.find(r => r.id === ROLES.registration);
  ids.t1 = reg.tasks[0].id;
  ids.t2 = reg.tasks[1].id;
  ids.t3 = reg.tasks[2].id;
});

test('concurrent writes on two instances: nothing dropped or duplicated (412 retry path)', async () => {
  // While instance A is in the middle of saving the captain's update, instance
  // B saves an admin edit to the SAME task plus a new task and a delete.
  bucket.onceBeforeSave(async () => {
    await B.call('PATCH', `/api/admin/tasks/${ids.t1}`, { location: 'Front door, left table' }, adminB);
    await B.call('POST', '/api/admin/tasks', { roleId: ROLES.registration, title: 'Made on B' }, adminB);
    await B.call('DELETE', `/api/admin/tasks/${ids.t3}`, undefined, adminB);
  });
  const conflictsBefore = bucket.stats.conflicts;
  const r = await A.call('PATCH', `/api/team/tasks/${ids.t1}`, { status: 'done', note: 'Vests handed out' }, capA);
  assert.equal(r.status, 200);
  assert.ok(bucket.stats.conflicts > conflictsBefore, 'A hit a generation conflict and retried');

  const gcs = bucket.read();
  const t1 = gcs.tasks[ids.t1];
  assert.equal(t1.status, 'done', "A's captain status kept");
  assert.equal(t1.location, 'Front door, left table', "B's admin edit kept");
  assert.equal(t1.notes.length, 1);
  assert.equal(gcs.tasks[ids.t3].deleted, true, 'delete kept');
  const live = Object.values(gcs.tasks).filter(t => !t.deleted);
  assert.equal(live.filter(t => t.title === 'Made on B').length, 1, 'new task present exactly once');
  assert.equal(new Set(live.map(t => t.title + t.roleId)).size, live.length, 'no duplicates');

  // Once each instance refreshes (every ~5s in production), both boards agree.
  await A.srv.refreshFromCloud(0);
  await B.srv.refreshFromCloud(0);
  const a = (await A.call('GET', '/api/admin/tasks', undefined, adminA)).body;
  const b = (await B.call('GET', '/api/admin/tasks', undefined, adminB)).body;
  assert.deepEqual(a.roles.map(x => x.tasks.map(t => [t.id, t.status, t.location])), b.roles.map(x => x.tasks.map(t => [t.id, t.status, t.location])));
  assert.equal(b.roles.find(x => x.id === ROLES.registration).tasks.find(t => t.id === ids.t1).status, 'done', 'admin on B sees captain update from A');

  // Re-seeding on either instance still creates nothing (deleted seed stays deleted).
  assert.equal((await B.call('POST', '/api/admin/tasks/seed', { roleId: 'all' }, adminB)).body.created, 0);
});

test('admin removal survives the backup merge, even against stale or legacy copies', async () => {
  await A.call('POST', '/api/admin/add_admin', { newAdminEmail: 'co@example.com' }, adminA);
  await B.srv.refreshFromCloud(0);
  const coOnB = await signIn(B, 'co@example.com');
  assert.equal((await B.call('GET', '/api/admin/tasks', undefined, coOnB)).status, 200);

  // A removes co@; B still has co@ allowed in memory until it merges.
  assert.equal((await A.call('POST', '/api/admin/remove_admin', { email: 'co@example.com' }, adminA)).status, 200);
  // B saves something (its stale copy lists co@ as allowed): removal must win.
  await B.call('POST', '/api/admin/tasks', { roleId: ROLES.food, title: 'Saved from stale B' }, adminB);
  assert.ok(!bucket.read().allowedAdmins.includes('co@example.com'), 'not resurrected in GCS');
  assert.equal((await B.call('GET', '/api/admin/tasks', undefined, coOnB)).status, 403, 'revoked on the other instance too');

  // An older revision that only knows the legacy array writes co@ back in.
  const legacy = bucket.read();
  legacy.allowedAdmins.push('co@example.com');
  delete legacy.adminChanges;
  bucket.write(legacy);
  await A.call('POST', '/api/admin/tasks', { roleId: ROLES.food, title: 'After legacy write' }, adminA);
  assert.ok(!bucket.read().allowedAdmins.includes('co@example.com'), 'legacy re-add does not undo an explicit removal');
});

test('captain demotion and volunteer removal also stick across instances', async () => {
  await B.srv.refreshFromCloud(0);
  const vols = (await A.call('GET', '/api/admin/volunteers', undefined, adminA)).body.volunteers;
  const cy = vols.find(v => v.firstName === 'Cy');
  await A.call('POST', `/api/admin/volunteers/${ROLES.food}/captain`, { timestamp: cy.timestamp }, adminA); // demote
  await B.call('POST', '/api/admin/tasks', { roleId: ROLES.food, title: 'B saves again' }, adminB);
  assert.equal(bucket.read().claims.find(c => c.timestamp === cy.timestamp).isCaptain, false, 'demotion not reverted');

  await A.call('DELETE', `/api/admin/volunteers/${ROLES.food}`, { timestamp: cy.timestamp }, adminA);
  await B.call('POST', '/api/admin/tasks', { roleId: ROLES.food, title: 'B saves once more' }, adminB);
  assert.equal(bucket.read().claims.some(c => c.timestamp === cy.timestamp), false, 'removal not reverted');
});

test('GCS snapshots are throttled; the latest object is written every time', () => {
  assert.ok(bucket.stats.saves >= 15, `saves=${bucket.stats.saves}`);
  assert.ok(bucket.stats.snapshots <= instances.length, `snapshots=${bucket.stats.snapshots}`);
});

test('a third instance cold-starting now sees the fully merged state', async () => {
  const C = await boot('inst-c');
  const adminC = await signIn(C, ADMIN_EMAIL);
  await A.srv.refreshFromCloud(0);
  const a = (await A.call('GET', '/api/admin/tasks', undefined, adminA)).body;
  const c = (await C.call('GET', '/api/admin/tasks', undefined, adminC)).body;
  assert.deepEqual(c.totals, a.totals);
  assert.deepEqual((await C.call('GET', '/api/admin/admins', undefined, adminC)).body.allowedAdmins, [ADMIN_EMAIL]);
});
