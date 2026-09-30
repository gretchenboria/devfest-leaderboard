'use strict';
// Pure logic: task model + merge, whole-state merge, session tokens, templates.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const T = require('../lib/tasks');
const { mergeRemoteState } = require('../lib/stateMerge');
const { createSessionSigner } = require('../lib/session');
const { TEMPLATES, roleKind, seedTaskId } = require('../lib/taskTemplates');

const clone = x => structuredClone(x);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function task(fields, id) {
  return T.createTask({ id, roleId: 'R1', fields: T.normalizeFields(fields, { requireTitle: true }), by: 'Organizer' });
}

test('task validation rejects bad input', () => {
  assert.throws(() => T.normalizeFields({ title: '' }, { requireTitle: true }), /title is required/);
  assert.throws(() => T.normalizeFields({ title: 'x'.repeat(141) }), /too long/);
  assert.throws(() => T.normalizeFields({ startTime: '7:30' }), /24h time/);
  assert.throws(() => T.normalizeFields({ status: 'finished' }), /status must be/);
  assert.throws(() => T.normalizeFields({ priority: 'urgent' }), /priority must be/);
  assert.deepEqual(T.normalizeFields({ title: '  Vests  ', startTime: '07:30' }), { title: 'Vests', startTime: '07:30' });
});

test('task ids are stable random ids, not timestamps', () => {
  const a = task({ title: 'A' });
  const b = task({ title: 'B' });
  assert.match(a.id, /^t_[0-9a-f-]{36}$/);
  assert.notEqual(a.id, b.id);
});

test('merging two copies neither drops nor duplicates tasks', () => {
  const shared = task({ title: 'Shared' });
  const onlyA = task({ title: 'Only on A' });
  const onlyB = task({ title: 'Only on B' });
  const a = { [shared.id]: clone(shared), [onlyA.id]: onlyA };
  const b = { [shared.id]: clone(shared), [onlyB.id]: onlyB };
  const m1 = T.mergeTaskMaps(a, b);
  const m2 = T.mergeTaskMaps(b, a);
  assert.equal(Object.keys(m1).length, 3);
  assert.deepEqual(Object.keys(m1).sort(), [shared.id, onlyA.id, onlyB.id].sort());
  assert.deepEqual(m1, m2, 'merge is commutative');
  assert.deepEqual(T.mergeTaskMaps(m1, m1), m1, 'merge is idempotent');
});

test('concurrent edits to different fields on two instances both survive', async () => {
  const base = task({ title: 'Breakfast buffet' });
  const a = clone(base);
  const b = clone(base);
  await sleep(2);
  T.applyUpdate(a, { status: 'done' }, 'Ana L.');             // captain on instance A
  await sleep(2);
  T.applyUpdate(b, { location: 'Food canopy' }, 'Organizer'); // admin on instance B
  T.addNote(b, 'Burritos arrived', 'Organizer', 'admin');
  T.addNote(a, 'All served', 'Ana L.', 'captain');
  const m = T.mergeTask(a, b);
  assert.equal(m.status, 'done');
  assert.equal(m.location, 'Food canopy');
  assert.deepEqual(m.notes.map(n => n.text).sort(), ['All served', 'Burritos arrived']);
  assert.deepEqual(T.mergeTask(b, a), m);
});

test('same field edited on both sides: the later write wins', async () => {
  const base = task({ title: 'Check-in' });
  const a = clone(base);
  const b = clone(base);
  T.applyUpdate(a, { status: 'in_progress' }, 'x');
  await sleep(2);
  T.applyUpdate(b, { status: 'blocked' }, 'y');
  assert.equal(T.mergeTask(a, b).status, 'blocked');
  assert.equal(T.mergeTask(b, a).status, 'blocked');
});

test('deletes are sticky: an older or newer live copy never resurrects a task', async () => {
  const base = task({ title: 'Delete me' });
  const stale = clone(base);
  const tomb = T.makeTombstone(base, 'Organizer');
  await sleep(2);
  T.applyUpdate(stale, { status: 'done' }, 'captain'); // edited after the delete, elsewhere
  const m = T.mergeTaskMaps({ [base.id]: tomb }, { [base.id]: stale });
  assert.equal(m[base.id].deleted, true);
  assert.equal(T.liveTasks(m).length, 0);
  assert.equal(T.mergeTaskMaps({ [base.id]: stale }, { [base.id]: tomb })[base.id].deleted, true);
});

test('whole-state merge: tasks, claims, admins and judge scores', () => {
  const t1 = task({ title: 'One' });
  const t2 = task({ title: 'Two' });
  const local = {
    allowedAdmins: ['a@x.com', 'b@x.com'],
    adminChanges: { 'a@x.com': { allowed: true, at: 0 }, 'b@x.com': { allowed: false, at: 500 } },
    claims: [{ timestamp: 1, taskId: 'R1', displayName: 'Ana L.', isCaptain: false, captainUpdatedAt: 200 }],
    deletedClaims: [3],
    scores: [],
    tasks: { [t1.id]: t1 }
  };
  const remote = {
    allowedAdmins: ['a@x.com', 'b@x.com', 'c@x.com'], // legacy array still lists b
    claims: [
      { timestamp: 1, taskId: 'R1', displayName: 'Ana L.', isCaptain: true, captainUpdatedAt: 100 },
      { timestamp: 2, taskId: 'R1', displayName: 'Bo K.' },
      { timestamp: 3, taskId: 'R1', displayName: 'Removed P.' }
    ],
    scores: [{ id: 's1', source: 'Judge App', track: 'Developer Track', teamName: 'T', judgeName: 'J', timestamp: '2026-10-01T10:00:00Z' }],
    tasks: { [t1.id]: clone(t1), [t2.id]: t2 },
    roleInstructions: { R1: 'Bring pens' }
  };
  const { tasksChanged } = mergeRemoteState(local, remote);
  assert.equal(tasksChanged, true);
  assert.equal(Object.keys(local.tasks).length, 2);
  assert.deepEqual(local.allowedAdmins, ['a@x.com', 'c@x.com'], 'b stays removed');
  assert.deepEqual(local.claims.map(c => c.timestamp).sort(), [1, 2], 'tombstoned claim 3 not resurrected');
  assert.equal(local.claims.find(c => c.timestamp === 1).isCaptain, false, 'newer demotion wins');
  assert.equal(local.scores.length, 1, 'judge app score carried over');
  assert.deepEqual(local.roleInstructions, { R1: 'Bring pens' }, 'missing keys restored from remote');
});

test('session tokens: valid, tampered, forged, expired', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const s = createSessionSigner(secret);
  const tok = s.sign({ email: 'Ana@Example.com', role: 'volunteer' });
  assert.equal(s.verify(tok).email, 'ana@example.com');

  const [body, sig] = tok.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const elevated = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');
  assert.equal(s.verify(`${elevated}.${sig}`), null, 'payload tampering detected');
  assert.equal(s.verify(`${body}.${sig.slice(0, -2)}AA`), null, 'signature tampering detected');
  assert.equal(createSessionSigner(crypto.randomBytes(32).toString('hex')).verify(tok), null, 'other key rejected');
  assert.equal(s.verify(s.sign({ email: 'a@b.c', role: 'admin' }, { ttl: -1 })), null, 'expired rejected');
  assert.equal(s.verify('garbage'), null);
  assert.throws(() => createSessionSigner(''), /SESSION_SECRET/);
});

test('templates exist for all five teams and seed ids are deterministic', () => {
  assert.equal(roleKind('Registration'), 'registration');
  assert.equal(roleKind('Security & Wayfinding'), 'security');
  assert.equal(roleKind('Tech Support'), 'tech');
  assert.equal(roleKind('Food & Beverage'), 'food');
  assert.equal(roleKind('Event Cleanup'), 'cleanup');
  for (const [kind, list] of Object.entries(TEMPLATES)) {
    assert.ok(list.length >= 6, kind);
    assert.equal(new Set(list.map(t => t.key)).size, list.length, `${kind} keys unique`);
    for (const t of list) T.normalizeFields(t, { requireTitle: true }); // all valid
    assert.ok(!list.some(t => /stack(ing)? chairs|chair stacking/i.test(t.title)), 'no furniture hauling tasks');
  }
  assert.equal(seedTaskId('MAAAAAEPa5hl', 'crew-checkin'), seedTaskId('MAAAAAEPa5hl', 'crew-checkin'));
});
