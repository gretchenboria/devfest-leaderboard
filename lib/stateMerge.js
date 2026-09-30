'use strict';
// Merges a copy of appState read from Cloud Storage into this instance's
// in-memory appState. Used on cold start (restore) and before every backup, so
// that one instance never overwrites what another instance saved, and so that
// deletions (removed admins, removed volunteers, demoted captains, deleted
// scores and tasks) are not resurrected by an older copy.

const { mergeTaskMaps } = require('./tasks');

// Keys an instance may simply not have yet (e.g. a fresh container). If the
// local copy has never set them, take the remote value instead of erasing it.
const FILL_IF_MISSING = ['roleInstructions', 'captainInstructions', 'registeredTeams'];

// adminChanges: { [email]: { allowed, at, by } }. The latest change per email
// wins; on a tie, removal wins. Emails that only appear in a legacy
// allowedAdmins array count as { allowed: true, at: 0 }.
function adminChangeLog(state) {
  const log = {};
  for (const [email, ch] of Object.entries(state.adminChanges || {})) {
    if (ch && typeof ch === 'object') log[email.toLowerCase()] = { ...ch, at: Number(ch.at) || 0, allowed: !!ch.allowed };
  }
  for (const email of state.allowedAdmins || []) {
    const k = String(email).toLowerCase();
    if (!log[k]) log[k] = { allowed: true, at: 0 };
  }
  return log;
}

function mergeAdmins(local, remote) {
  const out = adminChangeLog(local);
  for (const [email, ch] of Object.entries(adminChangeLog(remote))) {
    const mine = out[email];
    if (!mine || ch.at > mine.at || (ch.at === mine.at && mine.allowed && !ch.allowed)) out[email] = ch;
  }
  local.adminChanges = out;
  local.allowedAdmins = Object.keys(out).filter(e => out[e].allowed).sort();
}

function mergeClaims(localClaims, remoteClaims, deleted) {
  const byTs = new Map();
  for (const c of [...(localClaims || []), ...(remoteClaims || [])]) {
    if (!c || deleted.has(c.timestamp)) continue;
    const seen = byTs.get(c.timestamp);
    if (!seen) {
      byTs.set(c.timestamp, c);
      continue;
    }
    // Same claim on both sides: an explicit captain toggle (captainUpdatedAt)
    // beats an older or legacy one. Legacy records with no toggle time keep the
    // old rule of preferring isCaptain = true.
    const ts = seen.captainUpdatedAt || 0;
    const tc = c.captainUpdatedAt || 0;
    if (tc > ts) {
      seen.isCaptain = !!c.isCaptain;
      seen.captainUpdatedAt = tc;
    } else if (tc === ts && c.isCaptain) {
      seen.isCaptain = true;
    }
    // Profile edits (name / contact) carry profileUpdatedAt; newest wins.
    if ((c.profileUpdatedAt || 0) > (seen.profileUpdatedAt || 0)) {
      for (const k of PROFILE_FIELDS) {
        if (c[k] === undefined) delete seen[k];
        else seen[k] = c[k];
      }
      seen.profileUpdatedAt = c.profileUpdatedAt;
    }
  }
  return [...byTs.values()];
}
const PROFILE_FIELDS = ['displayName', 'firstName', 'lastNameData', 'emailData', 'phoneData', 'identityData'];

// Scores from Google Sheets are re-derived every sync, so only in-app ("Judge
// App") submissions need carrying across instances and restarts.
function mergeScores(localScores, remoteScores, deleted) {
  const out = (localScores || []).filter(s => s && !deleted.has(s.id));
  const ids = new Set(out.map(s => s.id));
  for (const s of remoteScores || []) {
    if (s && s.source === 'Judge App' && !ids.has(s.id) && !deleted.has(s.id)) {
      out.push(s);
      ids.add(s.id);
    }
  }
  // One in-app entry per judge + team + track: keep the newest.
  const newest = new Map();
  for (const s of out) {
    if (s.source !== 'Judge App') continue;
    const key = `${s.track}|${(s.teamName || '').toLowerCase()}|${(s.judgeName || '').toLowerCase()}`;
    const cur = newest.get(key);
    if (!cur || String(s.timestamp) > String(cur.timestamp)) newest.set(key, s);
  }
  return out.filter(s => s.source !== 'Judge App' || newest.get(`${s.track}|${(s.teamName || '').toLowerCase()}|${(s.judgeName || '').toLowerCase()}`) === s);
}

// Mutates `local`. Returns { tasksChanged } so callers can notify live clients.
function mergeRemoteState(local, remote) {
  if (!remote || typeof remote !== 'object') return { tasksChanged: false };

  mergeAdmins(local, remote);

  const deletedClaims = new Set([...(local.deletedClaims || []), ...(remote.deletedClaims || [])]);
  local.deletedClaims = [...deletedClaims];
  local.claims = mergeClaims(local.claims, remote.claims, deletedClaims);

  const deletedScores = new Set([...(local.deletedScores || []), ...(remote.deletedScores || [])]);
  local.deletedScores = [...deletedScores];
  local.scores = mergeScores(local.scores, remote.scores, deletedScores);

  if (remote.volunteerInstructions && !local.volunteerInstructions) {
    local.volunteerInstructions = remote.volunteerInstructions;
  }
  for (const k of FILL_IF_MISSING) {
    if ((local[k] === undefined || local[k] === null) && remote[k] !== undefined && remote[k] !== null) {
      local[k] = remote[k];
    }
  }

  const before = JSON.stringify(local.tasks || {});
  local.tasks = mergeTaskMaps(local.tasks || {}, remote.tasks || {});
  return { tasksChanged: JSON.stringify(local.tasks) !== before };
}

module.exports = { mergeRemoteState, mergeClaims, mergeAdmins, mergeScores, PROFILE_FIELDS };
