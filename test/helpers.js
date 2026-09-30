'use strict';
// Shared test helpers. Every server started here runs with GCS disabled (or a
// fake in-memory bucket), no Application Default Credentials, Sheets sync off,
// Wrike offline, and a throwaway DATA_DIR, so tests can never touch production.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSessionSigner } = require('../lib/session');

const ROOT = path.join(__dirname, '..');

// The five fallback roles used when Wrike is offline (see FALLBACK_ROLES).
const ROLES = {
  registration: 'MAAAAAEPa5hl',
  security: 'MAAAAAEQvpZa',
  tech: 'MAAAAAEPa5hz',
  food: 'MAAAAAEPa5hq',
  cleanup: 'MAAAAAEPa5hu'
};
const ADMIN_EMAIL = 'gretchen.beach@gmail.com'; // built-in default admin

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `devfest-${label}-`));
}

function baseEnv(dataDir, extra = {}) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    DISABLE_GCS: '1',
    DISABLE_SHEETS_SYNC: '1',
    WRIKE_OFFLINE: '1',
    DATA_DIR: dataDir,
    HOME: dataDir, // hides ~/.config/gcloud ADC from the child
    GOOGLE_APPLICATION_CREDENTIALS: path.join(dataDir, 'no-such-credentials.json'),
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ...extra
  };
}

// Starts `node server.js` as a real child process and waits for it to listen.
function spawnServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15000);
    const onData = d => {
      log += d.toString();
      // Wait for the end of the startup banner (printed after listen()).
      if (log.includes(`Running on http://localhost:${port}`) && log.includes('Google Sheet Source')) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${port}`, log: () => log, stop: () => stopChild(child) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${log}`)); });
  });
}

function stopChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.removeAllListeners('exit');
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

function signer(env) {
  return createSessionSigner(env.SESSION_SECRET);
}

function client(base) {
  return async function call(method, url, body, token) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, body: data };
  };
}

// Loads a fresh, independent copy of server.js in this process (its own
// appState), like a separate Cloud Run instance. Env must be set first.
function loadServerInstance(env) {
  Object.assign(process.env, env);
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(ROOT + path.sep) && !k.includes(`${path.sep}node_modules${path.sep}`) && !k.includes(`${path.sep}test${path.sep}`)) {
      delete require.cache[k];
    }
  }
  const srv = require(path.join(ROOT, 'server.js'));
  // Stand-in for Google: the "ID token" is just the email address.
  srv._googleClient.verifyIdToken = async ({ idToken, audience }) => {
    if (audience !== env.GOOGLE_CLIENT_ID) throw new Error('wrong audience');
    if (idToken === 'bad-token') throw new Error('invalid');
    return { getPayload: () => ({ email: idToken, email_verified: !idToken.startsWith('unverified') }) };
  };
  return srv;
}

// In-memory stand-in for a GCS bucket that honours ifGenerationMatch, so the
// read-merge-write retry path runs for real.
function fakeBucket() {
  const objects = new Map(); // name -> { data, generation }
  let gen = 1000;
  const stats = { saves: 0, conflicts: 0, snapshots: 0 };
  const beforeSave = [];
  function file(name, opts = {}) {
    return {
      async exists() { return [objects.has(name)]; },
      async getMetadata() {
        const o = objects.get(name);
        if (!o) { const e = new Error('No such object'); e.code = 404; throw e; }
        return [{ generation: String(o.generation) }];
      },
      async download() {
        const o = objects.get(name);
        if (!o) { const e = new Error('No such object'); e.code = 404; throw e; }
        if (opts.generation && Number(opts.generation) !== o.generation) { const e = new Error('Generation gone'); e.code = 404; throw e; }
        return [Buffer.from(o.data)];
      },
      async save(data, options = {}) {
        while (beforeSave.length) await beforeSave.shift()(name);
        const want = options.preconditionOpts && options.preconditionOpts.ifGenerationMatch;
        const cur = objects.get(name);
        if (want !== undefined && (cur ? cur.generation : 0) !== Number(want)) {
          stats.conflicts++;
          const e = new Error('Precondition Failed'); e.code = 412; throw e;
        }
        if (name.startsWith('snapshots/')) stats.snapshots++;
        else stats.saves++;
        objects.set(name, { data: String(data), generation: ++gen });
      }
    };
  }
  return {
    file,
    objects,
    stats,
    // Runs fn once, right before the next save reaches the "server".
    onceBeforeSave(fn) { beforeSave.push(fn); },
    read(name = 'devfest2026_scores_latest.json') { const o = objects.get(name); return o ? JSON.parse(o.data) : null; },
    write(obj, name = 'devfest2026_scores_latest.json') { objects.set(name, { data: JSON.stringify(obj), generation: ++gen }); }
  };
}

module.exports = { ROOT, ROLES, ADMIN_EMAIL, tmpDir, baseEnv, spawnServer, signer, client, loadServerInstance, fakeBucket };
