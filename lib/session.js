'use strict';
// Stateless, signed session tokens issued after Google sign-in.
//
//   token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, first part))
//   payload = { v: 1, email, role: "admin" | "volunteer", iat, exp }   (times in ms)
//
// Nothing is stored server-side, so any Cloud Run instance can verify a token.
// A token only proves who signed in and when. Every request still checks
// current state (allowedAdmins, captain flags), so revoking access takes effect
// immediately without tracking sessions.

const crypto = require('crypto');

const ROLES = ['admin', 'volunteer'];
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // one event day

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function createSessionSigner(secretHex, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(secretHex || '')) {
    throw new Error('SESSION_SECRET must be set to 64 hex characters');
  }
  const key = Buffer.from(secretHex, 'hex');
  const mac = data => crypto.createHmac('sha256', key).update(data).digest();

  function sign({ email, role }, { now = Date.now(), ttl = ttlMs } = {}) {
    if (!email || !ROLES.includes(role)) throw new Error('Invalid session payload');
    const body = b64url(JSON.stringify({ v: 1, email: String(email).toLowerCase(), role, iat: now, exp: now + ttl }));
    return `${body}.${b64url(mac(body))}`;
  }

  // Returns the payload, or null if the token is malformed, forged or expired.
  function verify(token, { now = Date.now() } = {}) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const given = Buffer.from(parts[1], 'base64url');
    const expected = mac(parts[0]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || payload.v !== 1 || typeof payload.email !== 'string' || !ROLES.includes(payload.role)) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload;
  }

  return { sign, verify };
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

module.exports = { createSessionSigner, bearerToken, ROLES, DEFAULT_TTL_MS };
