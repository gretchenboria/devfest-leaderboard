'use strict';
// "Text from my phone": phone normalization, the admin-only recipients
// endpoint (decrypts volunteer phones, dedupes, drops invalid, groups of 20)
// and the sms: link builder in public/blast.js. GCS disabled, throwaway DATA_DIR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROLES, ADMIN_EMAIL, tmpDir, baseEnv, signer, client, loadServerInstance } = require('./helpers');
const { normalizePhone, chunk } = require('../lib/phone');
const { sms } = require('../public/blast.js');

const dataDir = tmpDir('sms');
const env = baseEnv(dataDir, { SMTP_USER: '', SMTP_PASS: '' });
const sign = signer(env);
const admin = sign.sign({ email: ADMIN_EMAIL, role: 'admin' });
const volunteer = sign.sign({ email: 'vol0@example.com', role: 'volunteer' });

let server, call;
test.before(async () => {
  const srv = loadServerInstance(env);
  server = await srv.start({ port: 0 });
  call = client(`http://127.0.0.1:${server.address().port}`);
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

test('normalizePhone: US numbers become +1XXXXXXXXXX, junk is dropped', () => {
  assert.equal(normalizePhone('(650) 555-0102'), '+16505550102');
  assert.equal(normalizePhone('650.555.0102'), '+16505550102');
  assert.equal(normalizePhone('1-650-555-0102'), '+16505550102');
  assert.equal(normalizePhone('+1 (650) 555-0102'), '+16505550102');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  for (const bad of ['', null, undefined, 'N/A', '555-0102', '123-456-7890', '650-155-0102', '+1 123 456 7890', '6505550102 ext 4', '+123', 'call me'])
    assert.equal(normalizePhone(bad), null, String(bad));
});

test('chunk splits into groups of at most n', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 20), []);
});

test('sms links: iOS and Android formats, URL-encoded body, groups of 20', () => {
  const nums = ['+16505550101', '+16505550102'];
  const msg = 'Awards in 10 min & pizza? #1 "now"\nRm 109';
  assert.equal(sms.smsHref('ios', nums, msg), 'sms://open?addresses=+16505550101,+16505550102&body=' + encodeURIComponent(msg));
  assert.equal(sms.smsHref('android', nums, msg), 'sms:+16505550101,+16505550102?body=' + encodeURIComponent(msg));
  assert.doesNotMatch(sms.smsHref('ios', nums, msg), /[ \n"#]|&(?!body=)/);

  assert.equal(sms.smsPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(sms.smsPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios'); // iPadOS
  assert.equal(sms.smsPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'android');
  assert.equal(sms.smsPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'desktop');

  const many = Array.from({ length: 45 }, (_, i) => '+1650555' + String(1000 + i));
  const ios = sms.smsLinks(many, 'hi', 'ios');
  assert.deepEqual(ios.map(l => [l.group, l.total, l.count]), [[1, 3, 20], [2, 3, 20], [3, 3, 5]]);
  const desk = sms.smsLinks(many, 'hi', 'desktop');
  assert.equal(desk.length, 6);
  assert.deepEqual([...new Set(desk.map(l => l.platform))], ['ios', 'android']);
});

test('sms recipients endpoint: admin only, decrypted, normalized, deduped, grouped', async () => {
  const url = '/api/admin/sms/recipients?audience=volunteers';
  assert.equal((await call('GET', url)).status, 401);
  assert.equal((await call('GET', url, undefined, volunteer)).status, 403);
  assert.equal((await call('GET', '/api/admin/sms/recipients?audience=everyone', undefined, admin)).status, 400);

  const roles = Object.values(ROLES);
  // 43 people with valid numbers in assorted formats.
  for (let i = 0; i < 43; i++) {
    const d = String(1000 + i);
    const phone = i % 3 === 0 ? `(650) 555-${d}` : i % 3 === 1 ? `650.555.${d}` : `+1 650 555 ${d}`;
    const r = await call('POST', '/api/admin/assign', { taskId: roles[i % roles.length], firstName: 'P' + i, lastName: 'T', email: `p${i}@example.com`, phone }, admin);
    assert.equal(r.status, 200);
  }
  // Same person on a second team (duplicate), a different person sharing a
  // number written differently (duplicate), one invalid, one without a phone.
  for (const body of [
    { taskId: ROLES.cleanup, firstName: 'P1', lastName: 'T', email: 'p1@example.com', phone: '650.555.1001' },
    { taskId: ROLES.food, firstName: 'Twin', lastName: 'T', email: 'twin@example.com', phone: '1 (650) 555-1000' },
    { taskId: ROLES.food, firstName: 'Bad', lastName: 'T', email: 'bad@example.com', phone: '555-0123' }, // no area code
    { taskId: ROLES.food, firstName: 'None', lastName: 'T', email: 'none@example.com' }
  ]) assert.equal((await call('POST', '/api/admin/assign', body, admin)).status, 200, body.firstName);

  const raw = fs.readFileSync(path.join(dataDir, 'scores.json'), 'utf8');
  assert.ok(!raw.includes('555-1000') && !raw.includes('5551000'), 'phones are stored encrypted');

  const r = await call('GET', url, undefined, admin);
  assert.equal(r.status, 200);
  const expected = Array.from({ length: 43 }, (_, i) => '+1650555' + String(1000 + i));
  assert.deepEqual(r.body.numbers, expected);
  assert.equal(r.body.groupSize, 20);
  assert.deepEqual(r.body.groups.map(g => g.length), [20, 20, 3]);
  assert.deepEqual(r.body.groups.flat(), expected);
  assert.deepEqual(r.body.counts, { signups: 47, missing: 1, invalid: 1, duplicates: 2, numbers: 43, groups: 3 });
  assert.equal(r.body.judgesEmailOnly, false);

  // Judges have no phones: an empty list with the "email only" flag, not an error.
  const j = await call('GET', '/api/admin/sms/recipients?audience=judges', undefined, admin);
  assert.equal(j.status, 200);
  assert.deepEqual(j.body.numbers, []);
  assert.equal(j.body.judgesEmailOnly, true);
  const both = await call('GET', '/api/admin/sms/recipients?audience=both', undefined, admin);
  assert.deepEqual(both.body.numbers, expected);
  assert.equal(both.body.judgesEmailOnly, true);

  // Default audience is volunteers.
  assert.deepEqual((await call('GET', '/api/admin/sms/recipients', undefined, admin)).body.numbers, expected);
});
