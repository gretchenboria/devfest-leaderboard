'use strict';
// Wrike is optional: with no WRIKE_TOKEN, or a token Wrike rejects, the Hub
// keeps serving the saved/built-in roles, does not hammer Wrike, and admin
// gets a clear "Wrike not connected" status. Also guards against a token ever
// being hardcoded in server.js again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT, ROLES, ADMIN_EMAIL, tmpDir, baseEnv, spawnServer, signer, client } = require('./helpers');

function fakeWrike(handler) {
  return new Promise(resolve => {
    const hits = [];
    const server = http.createServer((req, res) => { hits.push({ url: req.url, auth: req.headers.authorization }); handler(req, res); });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/api/v4` }));
  });
}

test('server.js contains no hardcoded Wrike token', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'no JWT-looking literals');
  assert.match(src, /const WRIKE_TOKEN = \(process\.env\.WRIKE_TOKEN \|\| ''\)\.trim\(\);/);
});

test('no WRIKE_TOKEN: Hub serves fallback roles, never calls Wrike, admin sees "not connected"', async () => {
  const wrike = await fakeWrike((req, res) => { res.writeHead(500); res.end(); });
  const env = baseEnv(tmpDir('wrike-missing'), { WRIKE_OFFLINE: '', WRIKE_TOKEN: '', WRIKE_API_BASE: wrike.base });
  const srv = await spawnServer(env);
  try {
    const call = client(srv.base);
    const admin = signer(env).sign({ email: ADMIN_EMAIL, role: 'admin' });
    for (let i = 0; i < 3; i++) {
      const r = await call('GET', '/api/volunteer/tasks');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.map(t => t.id).sort(), Object.values(ROLES).sort());
    }
    const st = await call('GET', '/api/admin/wrike/status', undefined, admin);
    assert.equal(st.status, 200);
    assert.equal(st.body.connected, false);
    assert.equal(st.body.state, 'missing');
    assert.match(st.body.message, /Wrike not connected/);
    assert.equal((await call('GET', '/api/admin/wrike/status')).status, 401, 'status is admin-only');
    assert.equal(wrike.hits.length, 0, 'no calls to Wrike without a token');
    assert.equal(srv.child.exitCode, null, 'server still running');
    assert.equal((srv.log().match(/WRIKE_TOKEN is not set/g) || []).length, 1, 'warned once');
  } finally {
    await srv.stop();
    wrike.server.close();
  }
});

test('rejected token (401): one call, then backs off; Hub keeps working; admin sees "rejected"', async () => {
  const wrike = await fakeWrike((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"not_authorized"}'); });
  const env = baseEnv(tmpDir('wrike-401'), { WRIKE_OFFLINE: '', WRIKE_TOKEN: 'test-token', WRIKE_API_BASE: wrike.base });
  const srv = await spawnServer(env);
  try {
    const call = client(srv.base);
    const admin = signer(env).sign({ email: ADMIN_EMAIL, role: 'admin' });
    for (let i = 0; i < 4; i++) {
      const r = await call('GET', '/api/volunteer/tasks');
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 5);
    }
    const st = await call('GET', '/api/admin/wrike/status', undefined, admin);
    assert.equal(st.body.connected, false);
    assert.equal(st.body.state, 'rejected');
    assert.match(st.body.message, /Wrike not connected/);
    assert.equal(wrike.hits.length, 1, 'rejected token is not retried on every request');
    assert.equal(wrike.hits[0].auth, 'bearer test-token');
    assert.equal((srv.log().match(/\[Wrike\] Token rejected/g) || []).length, 1, 'logged once');
    assert.equal(srv.child.exitCode, null);
  } finally {
    await srv.stop();
    wrike.server.close();
  }
});

test('working token: roles come from Wrike and admin sees connected', async () => {
  const wrike = await fakeWrike((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'W1', title: '[Volunteer] Recruit for: Registration', description: 'Desk', status: 'Active' },
      { id: 'W2', title: 'Not a volunteer task', description: '', status: 'Active' }
    ] }));
  });
  const env = baseEnv(tmpDir('wrike-ok'), { WRIKE_OFFLINE: '', WRIKE_TOKEN: 'good', WRIKE_API_BASE: wrike.base });
  const srv = await spawnServer(env);
  try {
    const call = client(srv.base);
    const admin = signer(env).sign({ email: ADMIN_EMAIL, role: 'admin' });
    const r = await call('GET', '/api/volunteer/tasks');
    assert.deepEqual(r.body.map(t => [t.id, t.title]), [['W1', 'Registration']]);
    const st = await call('GET', '/api/admin/wrike/status', undefined, admin);
    assert.equal(st.body.connected, true);
    assert.equal(st.body.state, 'ok');
  } finally {
    await srv.stop();
    wrike.server.close();
  }
});
