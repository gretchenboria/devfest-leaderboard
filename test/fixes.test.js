'use strict';
// Regression tests for three organizer reports:
//  1. blasts missed organizers (admins with no volunteer sign-up) -> recipients
//     now include organizers and every decryptable volunteer, with a masked
//     per-blast delivery report;
//  2. instructions rendered "scrambled" -> stored text is repaired on read and
//     rendered escaped once with line breaks and bullets kept;
//  3. the roster email showed "undefined" names -> names come from the fields
//     the records actually have (firstName/lastNameData, or legacy displayName).
// In-process server, GCS disabled, throwaway DATA_DIR, mock mail transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, ADMIN_EMAIL, tmpDir, baseEnv, signer, client, loadServerInstance } = require('./helpers');
const { normalizeStoredText, textToHtml, maskEmail } = require('../lib/textFormat');

const dataDir = tmpDir('fixes');
const env = baseEnv(dataDir, { BLAST_BATCH_DELAY_MS: '0', SMTP_USER: '', SMTP_PASS: '', ADMIN_EMAIL: 'organizer.inbox@example.com' });
const sign = signer(env);
const admin = sign.sign({ email: ADMIN_EMAIL, role: 'admin' });
const TATIANA = 'facilitator.t@gmail.com'; // an admin/facilitator with no volunteer sign-up

let srv, server, call;

function mockTransport({ reject = [], failBatch = -1 } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(msg) {
      if (sent.length === failBatch) { sent.push({ ...msg, failed: true }); throw new Error('SMTP 421 try again later'); }
      sent.push(msg);
      const rejected = (msg.bcc || []).filter(e => reject.includes(e));
      return { messageId: 'mock-' + sent.length, rejected, rejectedErrors: rejected.map(r => ({ recipient: r, response: '550 5.1.1 user unknown' })) };
    }
  };
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out');
}

test.before(async () => {
  srv = loadServerInstance(env);
  server = await srv.start({ port: 0 });
  call = client(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await call('POST', '/api/admin/add_admin', { newAdminEmail: TATIANA }, admin)).status, 200);
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/admin/assign', { taskId: Object.values(ROLES)[i], firstName: 'Vol' + i, lastName: 'Tester', email: `vol${i}@example.com` }, admin);
    assert.equal(r.status, 200);
  }
  const claims = srv.getState().claims;
  // A legacy record (created before firstName/lastNameData existed).
  const legacy = claims[1];
  delete legacy.firstName; delete legacy.lastNameData; legacy.displayName = 'Legacy P.';
  // Contact email missing, but a sign-in email is bound: still reachable.
  const noContact = claims[2];
  noContact.identityData = noContact.emailData; delete noContact.emailData;
  // A record whose email cannot be decrypted (e.g. written with another key).
  claims.push({ taskId: ROLES.cleanup, displayName: 'Broken R.', emailData: '00'.repeat(16) + ':' + 'ab'.repeat(16), phoneData: '', timestamp: Date.now(), isCaptain: false });
  // Same inbox as vol3 through a Gmail alias would be a duplicate; the organizer's own volunteer claim too.
  await call('POST', '/api/admin/assign', { taskId: ROLES.food, firstName: 'Gretchen', lastName: 'B', email: ADMIN_EMAIL }, admin);
});
test.after(async () => {
  srv._setMailTransportForTests(null);
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

// ---------- 1. blast recipients + delivery report ----------

test('blast recipients include organizers and every decryptable volunteer, once each', () => {
  const plan = srv._email.blastRecipients('volunteers');
  assert.ok(plan.recipients.includes(TATIANA), 'admin/facilitator without a sign-up is included');
  assert.ok(plan.recipients.includes('organizer.inbox@example.com'), 'ADMIN_EMAIL is included');
  for (let i = 0; i < 4; i++) assert.ok(plan.recipients.includes(`vol${i}@example.com`), `vol${i} included`);
  assert.equal(plan.recipients.filter(e => e === ADMIN_EMAIL).length, 1, 'admin who also volunteers is emailed once');
  assert.equal(plan.recipients.length, new Set(plan.recipients).size);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'email could not be decrypted');
  assert.match(plan.skipped[0].who, /Broken R\./);
  assert.equal(plan.counts.organizers, 2); // Tatiana + ADMIN_EMAIL (the default admin already counted as a volunteer)
  assert.equal(plan.counts.duplicates, 1);

  const orgs = srv._email.blastRecipients('organizers');
  assert.deepEqual(orgs.recipients.sort(), [ADMIN_EMAIL, TATIANA, 'organizer.inbox@example.com'].sort());
  assert.equal(orgs.counts.volunteers, 0);
});

test('gmail dot/plus aliases of one inbox count once', () => {
  const plan = srv._email.blastRecipients('organizers');
  const before = plan.recipients.length;
  srv.getState().allowedAdmins.push('facilitatort+devfest@gmail.com');
  try {
    assert.equal(srv._email.blastRecipients('organizers').recipients.length, before);
  } finally { srv.getState().allowedAdmins.pop(); }
});

test('blast delivery report: counts plus masked failed/skipped recipients with reasons', async () => {
  const t = mockTransport({ reject: ['vol3@example.com'] });
  srv._setMailTransportForTests(t);
  const r = await call('POST', '/api/blast', { message: 'Doors open at 10', audience: 'volunteers' }, admin);
  assert.equal(r.status, 200);
  const rep = r.body.report;
  assert.ok(t.sent[0].bcc.includes(TATIANA), 'Tatiana was actually BCCd');
  assert.equal(rep.counts.emailed, rep.counts.intended - 2); // one rejected, one undecryptable
  assert.equal(rep.counts.failed, 1);
  assert.equal(rep.counts.skipped, 1);
  assert.deepEqual(rep.failed, [{ who: 'v***@example.com', reason: 'rejected by Gmail: 550 5.1.1 user unknown' }]);
  assert.equal(rep.skipped[0].reason, 'email could not be decrypted');
  assert.equal(r.body.failed, 1);
  assert.equal(r.body.success, false);
  const json = JSON.stringify(rep);
  assert.ok(!/vol\d@example\.com|facilitator\.t@/.test(json), 'report never contains full emails');

  // Same report is available to admins afterwards, and only to admins.
  const got = await call('GET', '/api/admin/blast/report', undefined, admin);
  assert.deepEqual(got.body.report, rep);
  assert.equal((await call('GET', '/api/admin/blast/report')).status, 401);
  // The public banner endpoint does not leak the report.
  assert.deepEqual(Object.keys((await call('GET', '/api/blast/latest')).body.blast).sort(), ['at', 'audience', 'id', 'message']);
});

test('a failed batch marks each of its recipients failed with the SMTP error', async () => {
  const t = mockTransport({ failBatch: 0 });
  srv._setMailTransportForTests(t);
  const r = await call('POST', '/api/blast', { message: 'Org sync at 8', audience: 'organizers' }, admin);
  assert.equal(r.body.report.counts.emailed, 0);
  assert.equal(r.body.report.counts.failed, 3);
  for (const f of r.body.report.failed) assert.match(f.reason, /send failed: SMTP 421/);
});

test('the sender mailbox is the To: address and is not BCCd to itself', async () => {
  process.env.SMTP_USER = TATIANA;
  try {
    const t = mockTransport();
    srv._setMailTransportForTests(t);
    const r = await call('POST', '/api/blast', { message: 'hello', audience: 'organizers' }, admin);
    assert.equal(t.sent[0].to, TATIANA);
    assert.ok(!t.sent[0].bcc.includes(TATIANA));
    assert.equal(r.body.report.counts.emailed, 3);
  } finally { process.env.SMTP_USER = ''; }
});

test('audience validation accepts organizers; SMS keeps volunteers/judges/both', async () => {
  srv._setMailTransportForTests(mockTransport());
  assert.equal((await call('POST', '/api/blast', { message: 'x', audience: 'everyone' }, admin)).status, 400);
  assert.equal((await call('GET', '/api/admin/sms/recipients?audience=organizers', undefined, admin)).status, 400);
  const sms = await call('GET', '/api/admin/sms/recipients?audience=volunteers', undefined, admin);
  assert.equal(sms.body.counts.organizersWithoutPhone, 2);
});

test('maskEmail', () => {
  assert.equal(maskEmail('t.bessarabova@gmail.com'), 't***@gmail.com');
  assert.equal(maskEmail(''), '');
});

// ---------- 2. instruction text ----------

const CLEAN = 'Team 2 · Security & Wayfinding (5).\n• Doors 9:00–10:45 AM — Rm 109×104 → HQ\n• "Quotes" & <tags> & it\'s fine';

test('instruction text round-trips special characters and newlines', () => {
  assert.equal(normalizeStoredText(CLEAN), CLEAN, 'clean text is untouched');
  const html = textToHtml(CLEAN);
  assert.equal(html, 'Team 2 · Security &amp; Wayfinding (5).<br>• Doors 9:00–10:45 AM — Rm 109×104 → HQ<br>• &quot;Quotes&quot; &amp; &lt;tags&gt; &amp; it&#39;s fine');
  assert.ok(!/&amp;amp;|&amp;#39;/.test(html), 'escaped exactly once');
});

test('corrupted stored instruction text is repaired on read', () => {
  const doubleEscaped = CLEAN.replace(/&/g, '&amp;amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  assert.equal(normalizeStoredText(doubleEscaped), CLEAN);
  const mojibake = Buffer.from(CLEAN, 'utf8').toString('latin1');
  assert.equal(normalizeStoredText(mojibake), CLEAN);
  assert.equal(normalizeStoredText(CLEAN.replace(/\n/g, '\\n')), CLEAN);
  assert.equal(normalizeStoredText(CLEAN.replace(/\n/g, '\r\n')), CLEAN);
  assert.equal(normalizeStoredText('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(normalizeStoredText('aa'.repeat(16) + ':' + 'bb'.repeat(16), { decrypt: () => 'decrypted text' }), 'decrypted text');
});

test('instruction endpoints serve repaired text (Volunteer Hub, Team page, Judge Portal, admin)', async () => {
  const st = srv.getState();
  const saved = { v: st.volunteerInstructions, j: st.judgeInstructions, r: { ...st.roleInstructions } };
  try {
    st.volunteerInstructions = CLEAN.replace(/&/g, '&amp;amp;');
    st.judgeInstructions = Buffer.from(CLEAN, 'utf8').toString('latin1');
    st.roleInstructions = { ...st.roleInstructions, [ROLES.security]: CLEAN.replace(/\n/g, '\\n') };
    assert.equal((await call('GET', '/api/instructions')).body.text, CLEAN);
    assert.equal((await call('GET', '/api/judge/instructions')).body.text, CLEAN);
    const all = (await call('GET', '/api/instructions/all', undefined, admin)).body;
    assert.equal(all.global, CLEAN);
    assert.equal(all.roles[ROLES.security], CLEAN);
    const tasks = (await call('GET', '/api/volunteer/tasks')).body;
    const sec = (Array.isArray(tasks) ? tasks : tasks.tasks).find(t => t.id === ROLES.security);
    assert.ok(sec.venueInstructions.endsWith(CLEAN));
  } finally {
    st.volunteerInstructions = saved.v; st.judgeInstructions = saved.j; st.roleInstructions = saved.r;
  }
});

test('confirmation email keeps the team update, bullets and line breaks, escaped once', () => {
  const m = srv._email.buildVolunteerConfirmationEmail({
    firstName: 'Ana & Bo', roleTitle: 'Security & Wayfinding', roleDescription: 'Line 1\nLine 2',
    venueNote: '📍 **Security & Wayfinding:** Signage.', roleNote: CLEAN, globalNote: 'Global\n• one'
  });
  assert.match(m.html, /Ana &amp; Bo/);
  assert.match(m.html, /<strong>Security &amp; Wayfinding:<\/strong>/);
  assert.ok(m.html.includes(textToHtml(CLEAN)), 'team update is included, with <br> line breaks');
  assert.match(m.html, /Global<br>• one/);
  assert.match(m.html, /Line 1<br>Line 2/);
  assert.ok(!/&amp;amp;|undefined/.test(m.html));
});

// ---------- 3. roster email names ----------

test('roster email shows a proper name on every row (new and legacy records)', async () => {
  const t = mockTransport();
  srv._setMailTransportForTests(t);
  const r = await call('POST', '/api/volunteer/claim', { taskId: ROLES.tech, firstName: 'Zoë', lastName: "O'Neil", email: 'zoe@example.com', phoneNumber: '(650) 555-0199' });
  assert.equal(r.status, 200);
  await waitFor(() => t.sent.some(m => m.to === 'organizer.inbox@example.com') && t.sent.some(m => m.to === 'zoe@example.com'));
  const roster = t.sent.find(m => m.to === 'organizer.inbox@example.com');
  assert.ok(!roster.html.includes('undefined'), 'no undefined cells');
  assert.match(roster.html, /<td>Vol0<\/td><td>Tester<\/td>/);
  assert.match(roster.html, /<td>Legacy<\/td><td>P<\/td>/, 'legacy displayName is split into first/last');
  assert.match(roster.html, /<td>Zoë<\/td><td>O&#39;Neil<\/td>/);
  assert.match(roster.html, /<td>Broken<\/td><td>R<\/td>.*\(could not decrypt\)/s);
  assert.match(roster.html, /<td>Tech Support<\/td>/, 'role title instead of the raw task id');
  const rows = srv._email.rosterRows(srv.getState().claims);
  for (const row of rows) assert.ok(row.firstName, 'every row has a first name');

  const confirm = t.sent.find(m => m.to === 'zoe@example.com');
  assert.equal(confirm.subject, 'Your DevFest Volunteer Assignment: Tech Support');
  assert.match(confirm.html, /on the roster, Zoë!/);
});
