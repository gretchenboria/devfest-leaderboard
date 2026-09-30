'use strict';
// Custom instructions (incl. judges), the encrypted judge email list, and the
// real blast (SSE banner + batched BCC email through a mock transport).
// In-process server with GCS disabled and a throwaway DATA_DIR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROLES, ADMIN_EMAIL, tmpDir, baseEnv, signer, client, loadServerInstance } = require('./helpers');
const { mergeInstructions, normalizeInstructions } = require('../lib/stateMerge');
const { recommendedInstructions } = require('../lib/eventInstructions');
const { TEMPLATES } = require('../lib/taskTemplates');

const dataDir = tmpDir('blast');
const env = baseEnv(dataDir, { BLAST_BATCH_DELAY_MS: '0', SMTP_USER: '', SMTP_PASS: '', ADMIN_EMAIL: '' });
const sign = signer(env);
const admin = sign.sign({ email: ADMIN_EMAIL, role: 'admin' });
const volunteer = sign.sign({ email: 'vol0@example.com', role: 'volunteer' });

let srv, server, call, base;

function mockTransport({ failBatch = -1 } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(msg) {
      if (sent.length === failBatch) { sent.push({ ...msg, failed: true }); throw new Error('SMTP 421 try again later'); }
      sent.push(msg);
      return { messageId: 'mock-' + sent.length };
    }
  };
}

test.before(async () => {
  srv = loadServerInstance(env);
  server = await srv.start({ port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
  call = client(base);
});
test.after(async () => {
  srv._setMailTransportForTests(null);
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

// ---------- instructions ----------

test('recommended instructions cover every target and never mention radios or the shuttle', () => {
  const rec = recommendedInstructions();
  assert.deepEqual(Object.keys(rec).sort(), ['global', 'judges', ...Object.values(ROLES).map(id => 'role_' + id)].sort());
  for (const [target, text] of Object.entries(rec)) {
    assert.ok(text.length > 50 && text.length <= 2000, target);
    assert.doesNotMatch(text, /radio|channel|walkie|shuttle|overflow/i, target);
  }
  assert.match(rec.global, /7:00 AM/);
  assert.match(rec.global, /599 Fairchild Drive/);
  assert.match(rec.global, /Rm 127/);
  assert.match(rec.judges, /5:15–6:15 PM in Rm 117/);
  assert.match(rec['role_' + ROLES.security], /Only they wear the hi-vis vests/);
  // Task templates are also radio/shuttle free.
  assert.doesNotMatch(JSON.stringify(TEMPLATES), /radio|channel|shuttle|overflow lot/i);
});

test('instructions: admin only, validated, judges target, public judge endpoint', async () => {
  assert.equal((await call('POST', '/api/instructions', { target: 'judges', text: 'x' })).status, 401);
  assert.equal((await call('POST', '/api/instructions', { target: 'judges', text: 'x' }, volunteer)).status, 403);
  assert.equal((await call('POST', '/api/instructions', { target: 'bogus', text: 'x' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/instructions', { target: 'global', text: 'y'.repeat(2001) }, admin)).status, 400);

  assert.equal((await call('POST', '/api/instructions', { target: 'judges', text: 'Judging in Rm 117 at 5:15' }, admin)).status, 200);
  assert.equal((await call('POST', '/api/instructions', { target: 'role_' + ROLES.food, text: 'Food note' }, admin)).status, 200);
  const all = (await call('GET', '/api/instructions/all', undefined, admin)).body;
  assert.equal(all.judges, 'Judging in Rm 117 at 5:15');
  assert.equal(all.roles[ROLES.food], 'Food note');
  assert.equal((await call('GET', '/api/judge/instructions')).body.text, 'Judging in Rm 117 at 5:15');

  // Clearing a target removes it from every view.
  await call('POST', '/api/instructions', { target: 'role_' + ROLES.food, text: '' }, admin);
  assert.equal((await call('GET', '/api/instructions/all', undefined, admin)).body.roles[ROLES.food], undefined);
});

test('recommended instructions fill only empty targets, then show on the volunteer page', async () => {
  const r = await call('POST', '/api/admin/instructions/recommended', {}, admin);
  assert.equal(r.status, 200);
  assert.ok(!r.body.applied.includes('judges'), 'existing judges text is kept');
  assert.equal(r.body.applied.length, 6); // global + 5 roles
  const all = (await call('GET', '/api/instructions/all', undefined, admin)).body;
  assert.equal(all.judges, 'Judging in Rm 117 at 5:15');
  assert.equal(Object.keys(all.roles).length, 5);
  assert.match(all.global, /Volunteer call 7:00 AM/);
  const tasks = (await call('GET', '/api/volunteer/tasks')).body;
  const reg = tasks.find(t => t.id === ROLES.registration);
  assert.match(reg.venueInstructions, /Admin Update:\*\* Team 1 · Registration/);
  for (const t of tasks) assert.doesNotMatch(`${t.description} ${t.venueInstructions}`, /radio|shuttle|Room 101/i);
  // Second run changes nothing.
  assert.deepEqual((await call('POST', '/api/admin/instructions/recommended', {}, admin)).body.applied, []);
});

test('instruction merge: newest edit per target wins across instances, clears included', () => {
  const a = { instructions: { global: { text: 'old', at: 10 }, judges: { text: 'J1', at: 50 } } };
  const b = { instructions: { global: { text: 'new', at: 20 }, judges: { text: '', at: 40 }, role_X: { text: 'R', at: 5 } } };
  mergeInstructions(a, b);
  assert.equal(a.volunteerInstructions, 'new');
  assert.equal(a.judgeInstructions, 'J1');
  assert.equal(a.roleInstructions.X, 'R');
  const c = { instructions: { role_X: { text: '', at: 9 } } };
  mergeInstructions(c, b);
  assert.equal(c.roleInstructions.X, undefined, 'a newer clear beats an older text');
  // Legacy-only state (older writers) is imported as at: 0.
  const legacy = { volunteerInstructions: 'Legacy', roleInstructions: { Y: 'y' } };
  normalizeInstructions(legacy);
  assert.deepEqual(legacy.instructions.global, { text: 'Legacy', at: 0 });
  assert.equal(legacy.roleInstructions.Y, 'y');
});

// ---------- judge list ----------

test('judge email list: admin only, parses pasted text, stored encrypted', async () => {
  assert.equal((await call('GET', '/api/admin/judges')).status, 401);
  assert.equal((await call('PUT', '/api/admin/judges', { emails: 'a@b.co' }, volunteer)).status, 403);
  assert.equal((await call('PUT', '/api/admin/judges', { emails: 'good@x.com, not-an-email@' }, admin)).status, 400);

  const paste = 'Parul <Parul.Judge@example.com>, expert1@google.example\nexpert1@google.example; expert2@google.example';
  const r = await call('PUT', '/api/admin/judges', { emails: paste }, admin);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.emails, ['parul.judge@example.com', 'expert1@google.example', 'expert2@google.example']);
  assert.deepEqual((await call('GET', '/api/admin/judges', undefined, admin)).body.emails, r.body.emails);

  const raw = fs.readFileSync(path.join(dataDir, 'scores.json'), 'utf8');
  assert.ok(!raw.includes('parul.judge@example.com'), 'judge emails are not stored in plaintext');
  assert.match(JSON.parse(raw).judgeEmails.data, /^[0-9a-f]{32}:[0-9a-f]+$/);
});

// ---------- blast ----------

async function addVolunteers(n) {
  const roles = Object.values(ROLES);
  for (let i = 0; i < n; i++) {
    const r = await call('POST', '/api/admin/assign', { taskId: roles[i % roles.length], firstName: 'Vol' + i, lastName: 'T', email: `vol${i}@example.com` }, admin);
    assert.equal(r.status, 200);
  }
  // Same person on a second team must only be emailed once.
  await call('POST', '/api/admin/assign', { taskId: ROLES.tech, firstName: 'Vol0', lastName: 'T', email: 'vol0@example.com' }, admin);
}

test('blast validation and auth', async () => {
  assert.equal((await call('POST', '/api/blast', { message: 'hi' })).status, 401);
  assert.equal((await call('POST', '/api/blast', { message: 'hi' }, volunteer)).status, 403);
  assert.equal((await call('POST', '/api/blast', { message: '   ' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/blast', { message: 'x'.repeat(1001) }, admin)).status, 400);
  assert.equal((await call('POST', '/api/blast', { message: 'hi', audience: 'everyone' }, admin)).status, 400);
});

test('without SMTP the blast says "banner only" and still sends the banner (SSE + latest)', async () => {
  await addVolunteers(120);
  assert.equal((await call('GET', '/api/admin/email/status', undefined, admin)).body.configured, false);

  // Listen on the live stream.
  const ctrl = new AbortController();
  const streamRes = await fetch(base + '/api/stream', { signal: ctrl.signal });
  const reader = streamRes.body.getReader();
  let streamText = '';
  const gotBlast = (async () => {
    while (!streamText.includes('event: blast')) {
      const { value, done } = await reader.read();
      if (done) break;
      streamText += Buffer.from(value).toString();
    }
  })();

  const r = await call('POST', '/api/blast', { message: 'Awards in 10 min <b>now</b>', audience: 'volunteers' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.emailConfigured, false);
  assert.equal(r.body.message, 'Email not configured — banner only.');
  assert.equal(r.body.emailed, 0);
  assert.equal(r.body.skipped, 121); // 120 volunteers + the organizer (admin list)

  await gotBlast;
  ctrl.abort();
  assert.match(streamText, /event: blast\ndata: .*Awards in 10 min <b>now<\/b>.*"audience":"volunteers"/);
  const latest = (await call('GET', '/api/blast/latest')).body.blast;
  assert.equal(latest.message, 'Awards in 10 min <b>now</b>');
  assert.equal(latest.audience, 'volunteers');

  const test1 = await call('POST', '/api/blast', { message: 'test', test: true }, admin);
  assert.equal(test1.body.emailConfigured, false);
  assert.match(test1.body.message, /Email not configured/);
});

test('with SMTP: BCC batches of at most 50, deduped, HTML-escaped, counts returned', async () => {
  const t = mockTransport();
  srv._setMailTransportForTests(t);
  const r = await call('POST', '/api/blast', { message: 'Line 1 <script>alert(1)</script>\nLine 2 & more', audience: 'both' }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.emailConfigured, true);
  assert.equal(r.body.recipients, 124); // 120 volunteers + 1 organizer + 3 judges, vol0 counted once
  assert.equal(r.body.emailed, 124);
  assert.equal(r.body.failed, 0);
  assert.equal(r.body.skipped, 0);
  assert.equal(t.sent.length, 3);
  assert.deepEqual(t.sent.map(m => m.bcc.length), [50, 50, 24]);
  const everyone = t.sent.flatMap(m => m.bcc);
  assert.equal(new Set(everyone).size, 124);
  assert.ok(everyone.includes(ADMIN_EMAIL), 'organizers are included');
  assert.ok(everyone.includes('expert2@google.example'));
  for (const m of t.sent) {
    assert.ok(!m.html.includes('<script>'), 'message is HTML-escaped');
    assert.match(m.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;<br>Line 2 &amp; more/);
    assert.match(m.text, /Line 2 & more/);
  }
});

test('audience judges emails only judges; a failed batch is counted as failed', async () => {
  let t = mockTransport();
  srv._setMailTransportForTests(t);
  const j = await call('POST', '/api/blast', { message: 'Judges: Rm 117 now', audience: 'judges' }, admin);
  assert.equal(j.body.emailed, 3);
  assert.deepEqual(t.sent[0].bcc, ['parul.judge@example.com', 'expert1@google.example', 'expert2@google.example']);

  t = mockTransport({ failBatch: 1 });
  srv._setMailTransportForTests(t);
  const v = await call('POST', '/api/blast', { message: 'Volunteers: teardown at 9', audience: 'volunteers' }, admin);
  assert.equal(v.body.success, false);
  assert.equal(v.body.emailed, 71);
  assert.equal(v.body.failed, 50);
  assert.match(v.body.message, /50 failed/);
});

test('send test to me goes only to the signed-in admin (or ADMIN_EMAIL) and shows no banner', async () => {
  const before = (await call('GET', '/api/blast/latest')).body.blast;
  const t = mockTransport();
  srv._setMailTransportForTests(t);
  const r = await call('POST', '/api/blast', { message: 'Test run', audience: 'both', test: true }, admin);
  assert.equal(r.body.test, true);
  assert.equal(r.body.emailed, 1);
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0].bcc, [ADMIN_EMAIL]);
  assert.match(t.sent[0].subject, /^\[TEST\]/);
  assert.deepEqual((await call('GET', '/api/blast/latest')).body.blast, before);

  process.env.ADMIN_EMAIL = 'organizer@example.com';
  try {
    await call('POST', '/api/blast', { message: 'Test run 2', test: true }, admin);
    assert.deepEqual(t.sent[1].bcc, ['organizer@example.com']);
  } finally {
    process.env.ADMIN_EMAIL = '';
  }
});
