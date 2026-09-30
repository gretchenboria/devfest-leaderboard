'use strict';
// End-to-end API test against a real `node server.js` process (GCS disabled),
// including a full process restart to prove state survives on disk.
//
// Session tokens are minted with the same SESSION_SECRET the server was given,
// which is exactly what the server does after verifying a Google ID token (the
// Google exchange itself is covered in multi-instance.test.js with a stubbed
// verifier, because a real Google token cannot be produced offline).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROLES, ADMIN_EMAIL, tmpDir, baseEnv, spawnServer, signer, client } = require('./helpers');

const dataDir = tmpDir('api');
const env = baseEnv(dataDir);
const sign = signer(env);
const tokens = {
  admin: sign.sign({ email: ADMIN_EMAIL, role: 'admin' }),
  ana: sign.sign({ email: 'ana.captain@example.com', role: 'volunteer' }),     // Registration captain
  bo: sign.sign({ email: 'bo.volunteer@example.com', role: 'volunteer' }),     // Registration member
  cy: sign.sign({ email: 'cy.captain@example.com', role: 'volunteer' }),       // Food captain
  stranger: sign.sign({ email: 'stranger@example.com', role: 'volunteer' })
};

let server;
let call;
const ids = {};

test.before(async () => {
  server = await spawnServer(env);
  call = client(server.base);
});
test.after(async () => {
  if (server) await server.stop();
});

test('server is running with GCS disabled', () => {
  assert.match(server.log(), /\[GCS\] Disabled by DISABLE_GCS=1/);
  assert.match(server.log(), /Cloud Storage Bucket: disabled/);
});

test('admin endpoints reject anonymous, forged, expired and non-admin tokens', async () => {
  const anon = await call('GET', '/api/admin/tasks');
  assert.equal(anon.status, 401);
  const forged = await call('GET', '/api/admin/tasks', undefined, tokens.admin.slice(0, -4) + 'AAAA');
  assert.equal(forged.status, 401);
  const expired = await call('GET', '/api/admin/tasks', undefined, sign.sign({ email: ADMIN_EMAIL, role: 'admin' }, { ttl: -1000 }));
  assert.equal(expired.status, 401);
  // Correctly signed, but claims "admin" for an email that is not on the list.
  const fakeAdmin = await call('GET', '/api/admin/volunteers', undefined, sign.sign({ email: 'stranger@example.com', role: 'admin' }));
  assert.equal(fakeAdmin.status, 403);
  // Real admin email but a volunteer-role token (e.g. from the team page).
  const wrongRole = await call('GET', '/api/admin/volunteers', undefined, sign.sign({ email: ADMIN_EMAIL, role: 'volunteer' }));
  assert.equal(wrongRole.status, 403);
  // The old static password bearer token no longer means anything.
  const oldStatic = await call('GET', '/api/admin/volunteers', undefined, require('crypto').createHash('sha256').update('devving').digest('hex'));
  assert.equal(oldStatic.status, 401);
  assert.equal((await call('POST', '/api/auth', { type: 'admin', username: 'admin', password: 'devving' })).status, 401);
  assert.equal((await call('POST', '/api/auth/setup', { username: 'x', password: 'y' })).status, 404);
});

test('admin builds the roster; assigning a new volunteer never removes existing ones', async () => {
  // Public sign-up (the volunteer page form).
  const pub = await call('POST', '/api/volunteer/claim', { taskId: ROLES.registration, firstName: 'Bo', lastInitial: 'K', email: 'Bo.Volunteer@example.com', phoneNumber: '(650) 555-0102' });
  assert.equal(pub.status, 200);
  const people = [
    { taskId: ROLES.registration, firstName: 'Ana', lastName: 'Lopez', email: 'ana.captain@example.com', phone: '650-555-0101', isCaptain: true },
    { taskId: ROLES.food, firstName: 'Cy', lastName: 'Nguyen', email: 'cy.captain@example.com', phone: '650-555-0103', isCaptain: true },
    { taskId: ROLES.food, firstName: 'Dee', lastName: 'Park', email: 'dee@example.com', phone: '650-555-0104' }
  ];
  let before = 1;
  for (const p of people) {
    assert.equal((await call('POST', '/api/admin/assign', p, tokens.admin)).status, 200);
    const vols = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers;
    assert.equal(vols.length, before + 1, `adding ${p.firstName} keeps everyone else`);
    before = vols.length;
  }
  const names = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers.map(v => v.displayName).sort();
  assert.deepEqual(names, ['Ana L.', 'Bo K.', 'Cy N.', 'Dee P.']);
});

test('admin seeds recommended tasks idempotently and sees roles without captains flagged', async () => {
  const first = await call('POST', '/api/admin/tasks/seed', { roleId: 'all' }, tokens.admin);
  assert.equal(first.status, 200);
  assert.ok(first.body.created >= 30, `created ${first.body.created}`);
  const again = await call('POST', '/api/admin/tasks/seed', { roleId: 'all' }, tokens.admin);
  assert.equal(again.body.created, 0, 'second seed creates nothing');
  assert.equal(again.body.skipped, first.body.created);

  const board = (await call('GET', '/api/admin/tasks', undefined, tokens.admin)).body;
  const reg = board.roles.find(r => r.id === ROLES.registration);
  const sec = board.roles.find(r => r.id === ROLES.security);
  assert.equal(reg.captains.length, 1);
  assert.equal(reg.captains[0].name, 'Ana L.');
  assert.equal(sec.captains.length, 0, 'Security has no captain yet');
  assert.equal(board.totals.total, first.body.created);
  const allIds = board.roles.flatMap(r => r.tasks.map(t => t.id));
  assert.equal(new Set(allIds).size, allIds.length, 'no duplicate tasks');
  ids.regTask = reg.tasks.find(t => t.title.startsWith('Run peak check-in')).id;
  ids.foodTask = board.roles.find(r => r.id === ROLES.food).tasks[0].id;
  ids.anaKey = reg.captains[0].key;
});

test('admin creates, bulk-adds, edits, assigns and deletes tasks', async () => {
  const created = await call('POST', '/api/admin/tasks', {
    roleId: ROLES.registration, title: 'Restock lanyards <script>alert(1)</script>', details: 'From Tent 1', location: 'Registration',
    startTime: '12:00', endTime: '12:15', priority: 'low'
  }, tokens.admin);
  assert.equal(created.status, 200);
  assert.equal(created.body.task.title, 'Restock lanyards <script>alert(1)</script>', 'stored verbatim; UIs escape on render');
  ids.custom = created.body.task.id;

  const bad = await call('POST', '/api/admin/tasks', { roleId: ROLES.registration, title: '' }, tokens.admin);
  assert.equal(bad.status, 400);
  const badRole = await call('POST', '/api/admin/tasks', { roleId: 'nope', title: 'x' }, tokens.admin);
  assert.equal(badRole.status, 400);

  const bulk = await call('POST', '/api/admin/tasks/bulk', { roleId: ROLES.food, tasks: ['Refill ice at noon', 'Count lunch boxes'] }, tokens.admin);
  assert.equal(bulk.body.created, 2);

  const assigned = await call('PATCH', `/api/admin/tasks/${ids.regTask}`, { assigneeKey: ids.anaKey, priority: 'high', note: 'Three volunteers here by 8:55' }, tokens.admin);
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.task.assignee.name, 'Ana L.');
  assert.equal(assigned.body.task.notes[0].by, 'Organizer', 'admin email not exposed');

  const notCaptain = await call('PATCH', `/api/admin/tasks/${ids.foodTask}`, { assigneeKey: ids.anaKey }, tokens.admin);
  assert.equal(notCaptain.status, 400, 'cannot assign to a captain of another role');

  const del = await call('DELETE', `/api/admin/tasks/${ids.custom}`, undefined, tokens.admin);
  assert.equal(del.status, 200);
  assert.equal((await call('PATCH', `/api/admin/tasks/${ids.custom}`, { status: 'done' }, tokens.admin)).status, 404);
});

test('captain updates status and notes on their own team task', async () => {
  const mine = (await call('GET', '/api/team/tasks', undefined, tokens.ana)).body;
  assert.deepEqual(mine.roles.map(r => r.id), [ROLES.registration], 'only her own role');
  assert.equal(mine.roles[0].canEdit, true);
  const t = mine.roles[0].tasks.find(x => x.id === ids.regTask);
  assert.deepEqual(t.assignee, { name: 'Ana L.', mine: true }, 'assignee key not sent to clients');

  const upd = await call('PATCH', `/api/team/tasks/${ids.regTask}`, { status: 'blocked', note: 'NFC reader #2 is dead' }, tokens.ana);
  assert.equal(upd.status, 200);
  assert.equal(upd.body.task.status, 'blocked');
  assert.equal(upd.body.task.notes.at(-1).by, 'Ana L.');

  const board = (await call('GET', '/api/admin/tasks', undefined, tokens.admin)).body;
  const reg = board.roles.find(r => r.id === ROLES.registration);
  assert.equal(reg.progress.blocked, 1, 'admin board shows the blocked task');
});

test('captain cannot modify another role\'s task, or edit fields beyond status/note', async () => {
  const other = await call('PATCH', `/api/team/tasks/${ids.foodTask}`, { status: 'done' }, tokens.ana);
  assert.equal(other.status, 403);
  const title = await call('PATCH', `/api/team/tasks/${ids.regTask}`, { title: 'hijacked' }, tokens.ana);
  assert.equal(title.status, 400);
  const member = await call('PATCH', `/api/team/tasks/${ids.regTask}`, { status: 'done' }, tokens.bo);
  assert.equal(member.status, 403, 'regular volunteer cannot update tasks');
  const stranger = await call('GET', '/api/team/tasks', undefined, tokens.stranger);
  assert.equal(stranger.status, 403, 'unknown Google account has no access');
  const food = (await call('GET', '/api/admin/tasks', undefined, tokens.admin)).body.roles.find(r => r.id === ROLES.food);
  assert.equal(food.tasks.find(t => t.id === ids.foodTask).status, 'todo', 'food task untouched');
});

test('roster: names for everyone, contact details only for self / own team captain / admin', async () => {
  const asBo = (await call('GET', '/api/team/roster', undefined, tokens.bo)).body.roles;
  const regBo = asBo.find(r => r.roleId === ROLES.registration);
  assert.deepEqual(regBo.captains, ['Ana L.']);
  const boSelf = regBo.members.find(m => m.isMe);
  assert.equal(boSelf.contact.email, 'Bo.Volunteer@example.com', 'sees own contact');
  const anaSeenByBo = regBo.members.find(m => m.displayName === 'Ana L.');
  assert.equal(anaSeenByBo.contact, undefined, 'regular volunteer cannot see captain contact');
  const deeSeenByBo = asBo.find(r => r.roleId === ROLES.food).members.find(m => m.displayName === 'Dee P.');
  assert.equal(deeSeenByBo.contact, undefined, 'or anyone else\'s');
  assert.ok(!JSON.stringify(asBo).includes('dee@example.com'), 'no other emails anywhere in the payload');
  assert.ok(!JSON.stringify(asBo).includes('555-0104'), 'no other phones anywhere in the payload');

  const asAna = (await call('GET', '/api/team/roster', undefined, tokens.ana)).body.roles;
  const boSeenByAna = asAna.find(r => r.roleId === ROLES.registration).members.find(m => m.displayName === 'Bo K.');
  assert.equal(boSeenByAna.contact.phone, '(650) 555-0102', 'captain sees own team contact');
  const deeSeenByAna = asAna.find(r => r.roleId === ROLES.food).members.find(m => m.displayName === 'Dee P.');
  assert.equal(deeSeenByAna.contact, undefined, 'captain does not see other teams\' contact');

  const asAdmin = (await call('GET', '/api/team/roster', undefined, tokens.admin)).body.roles;
  assert.ok(asAdmin.every(r => r.members.every(m => m.contact)), 'admin sees everything');
});

test('volunteer edits only their own record; edits apply to all their sign-ups', async () => {
  // Bo also signs up for Cleanup, then edits his profile once.
  await call('POST', '/api/volunteer/claim', { taskId: ROLES.cleanup, firstName: 'Bo', lastInitial: 'K', email: 'bo.volunteer@example.com', phoneNumber: '650 555 0102' });
  const edit = await call('PATCH', '/api/team/me', { firstName: 'Bo', lastName: 'Kowalski', phone: '650-555-9999', email: 'bo.new@example.com' }, tokens.bo);
  assert.equal(edit.status, 200);
  assert.equal(edit.body.profile.displayName, 'Bo K.');
  assert.equal(edit.body.profile.lastName, 'Kowalski');

  const vols = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers;
  const bo = vols.filter(v => v.firstName === 'Bo');
  assert.equal(bo.length, 2);
  assert.ok(bo.every(v => v.phone === '650-555-9999' && v.email === 'bo.new@example.com' && v.lastName === 'Kowalski'));
  assert.ok(vols.filter(v => v.firstName !== 'Bo').every(v => v.phone !== '650-555-9999'), 'nobody else changed');

  // Still signs in with the same Google account after changing contact email.
  const me = await call('GET', '/api/team/me', undefined, tokens.bo);
  assert.equal(me.status, 200);
  assert.equal(me.body.assignments.length, 2);
  // Claiming the new contact email as a Google login does not reach Bo's record.
  const hijack = await call('GET', '/api/team/me', undefined, sign.sign({ email: 'bo.new@example.com', role: 'volunteer' }));
  assert.equal(hijack.status, 403);
  // The profile endpoint ignores attempts to target someone else.
  const other = await call('PATCH', '/api/team/me', { personKey: ids.anaKey, firstName: 'Mallory' }, tokens.bo);
  assert.equal(other.status, 200);
  const afterOther = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers;
  assert.ok(afterOther.some(v => v.displayName === 'Ana L.'), 'Ana untouched');
  assert.equal(afterOther.filter(v => v.displayName === 'Mallory K.').length, 2, 'only Bo\'s own records changed');
  await call('PATCH', '/api/team/me', { firstName: 'Bo' }, tokens.bo);

  // Once signed in, re-submitting the public form cannot overwrite the record.
  const resubmit = await call('POST', '/api/volunteer/claim', { taskId: ROLES.registration, firstName: 'Evil', lastInitial: 'X', email: 'bo.volunteer@example.com', phoneNumber: '650 555 0000' });
  assert.equal(resubmit.status, 409);
  const invalid = await call('PATCH', '/api/team/me', { email: 'not-an-email' }, tokens.bo);
  assert.equal(invalid.status, 400);
});

test('admin can edit anyone and link a different Google sign-in email', async () => {
  const dee = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers.find(v => v.firstName === 'Dee');
  const r = await call('PATCH', `/api/admin/people/${dee.personKey}`, { lastName: 'Park-Lee', signInEmail: 'dee.google@gmail.com' }, tokens.admin);
  assert.equal(r.status, 200);
  const asDee = await call('GET', '/api/team/me', undefined, sign.sign({ email: 'dee.google@gmail.com', role: 'volunteer' }));
  assert.equal(asDee.status, 200);
  assert.equal(asDee.body.profile.lastName, 'Park-Lee');

  // Renaming a captain updates the name shown on tasks assigned to her.
  const r2 = await call('PATCH', `/api/admin/people/${ids.anaKey}`, { firstName: 'Anabel' }, tokens.admin);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.personKey, ids.anaKey, 'person key stable when only the name changes');
  const reg = (await call('GET', '/api/admin/tasks', undefined, tokens.admin)).body.roles.find(r => r.id === ROLES.registration);
  assert.equal(reg.tasks.find(t => t.id === ids.regTask).assignee.name, 'Anabel L.');
});

test('removed admin\'s existing token is rejected immediately', async () => {
  assert.equal((await call('POST', '/api/admin/add_admin', { newAdminEmail: 'co.organizer@example.com' }, tokens.admin)).status, 200);
  const coToken = sign.sign({ email: 'co.organizer@example.com', role: 'admin' });
  assert.equal((await call('GET', '/api/admin/tasks', undefined, coToken)).status, 200);
  assert.equal((await call('POST', '/api/admin/remove_admin', { email: ADMIN_EMAIL }, coToken)).status, 200, 'co-organizer can remove another admin');
  assert.equal((await call('GET', '/api/admin/tasks', undefined, tokens.admin)).status, 403, 'removed admin locked out');
  assert.equal((await call('POST', '/api/admin/remove_admin', { email: 'co.organizer@example.com' }, coToken)).status, 400, 'cannot remove yourself / last admin');
  assert.equal((await call('POST', '/api/admin/add_admin', { newAdminEmail: ADMIN_EMAIL }, coToken)).status, 200);
  assert.equal((await call('GET', '/api/admin/tasks', undefined, tokens.admin)).status, 200, 're-added admin works again');
});

test('SSE stream announces task changes without leaking task content', async () => {
  const ctrl = new AbortController();
  const res = await fetch(server.base + '/api/stream', { signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = '';
  const read = (async () => {
    while (!text.includes('event: tasks_changed')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
  })();
  await call('PATCH', `/api/team/tasks/${ids.regTask}`, { status: 'in_progress' }, tokens.ana);
  await Promise.race([read, new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event')), 5000))]);
  ctrl.abort();
  assert.match(text, /event: tasks_changed\ndata: \{"roleId":"MAAAAAEPa5hl","at":\d+\}/);
  assert.ok(!text.includes('NFC reader'), 'no task content on the public stream');
});

test('state survives a full server restart (disk)', async () => {
  const before = (await call('GET', '/api/admin/tasks', undefined, tokens.admin)).body;
  const volsBefore = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers;
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'scores.json'), 'utf8'));
  assert.ok(!JSON.stringify(onDisk).includes('bo.new@example.com'), 'PII is encrypted on disk');
  assert.ok(!JSON.stringify(onDisk).includes('Kowalski'), 'full last name is encrypted on disk');

  await server.stop();
  server = await spawnServer(env); // same DATA_DIR, keys and secret
  call = client(server.base);

  const after = (await call('GET', '/api/admin/tasks', undefined, tokens.admin)).body;
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.roles.map(r => r.tasks.map(t => [t.id, t.status, t.notes.length])), before.roles.map(r => r.tasks.map(t => [t.id, t.status, t.notes.length])));
  const volsAfter = (await call('GET', '/api/admin/volunteers', undefined, tokens.admin)).body.volunteers;
  assert.deepEqual(volsAfter, volsBefore);
  const t = (await call('GET', '/api/team/tasks', undefined, tokens.ana)).body.roles[0].tasks.find(x => x.id === ids.regTask);
  assert.equal(t.status, 'in_progress');
  assert.equal(t.notes.length, 2);
  const again = await call('POST', '/api/admin/tasks/seed', { roleId: 'all' }, tokens.admin);
  assert.equal(again.body.created, 0, 'seeding after restart still does not duplicate');
});
