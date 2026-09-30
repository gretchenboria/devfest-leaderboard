'use strict';
// Team task model for the Volunteer Hub.
//
// A task belongs to a role (functional team, e.g. Registration) and can be
// assigned to one of that role's captains. Tasks live in appState.tasks as a
// map { [id]: task } so two copies of the state can be merged without
// duplicates.
//
// Merge model (Cloud Run may run several instances, each with its own copy):
//   - every editable field carries its own last-write time in task.v[field],
//     so concurrent edits to different fields on different instances both survive
//   - notes are append-only and unioned by note id
//   - deletion leaves a tombstone ({ id, deleted: true }) and is sticky: a
//     deleted task never comes back from an older copy
// mergeTask(a, b) is commutative, so every instance converges on the same result.

const crypto = require('crypto');

const STATUSES = ['todo', 'in_progress', 'done', 'blocked'];
const PRIORITIES = ['high', 'normal', 'low'];
// Fields that carry a per-field write time and merge last-writer-wins.
const FIELDS = ['roleId', 'title', 'details', 'location', 'startTime', 'endTime', 'priority', 'status', 'assignee'];
const LIMITS = { title: 140, details: 2000, location: 120, note: 1000, notesPerTask: 200, tasks: 1000, bulk: 50 };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class TaskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function newTaskId() {
  return 't_' + crypto.randomUUID();
}

function cleanText(value, max, field, required) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new TaskError(400, `${field} must be text`);
  const v = value.replace(/\r\n?/g, '\n').trim();
  if (required && !v) throw new TaskError(400, `${field} is required`);
  if (v.length > max) throw new TaskError(400, `${field} is too long (max ${max} characters)`);
  return v;
}

function cleanTime(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new TaskError(400, `${field} must be a 24h time like 07:30`);
  }
  return value;
}

// Validates the plain editable fields present in `input`. roleId and assignee
// need server context (known roles, current captains) and are checked there.
function normalizeFields(input, { requireTitle = false } = {}) {
  if (!input || typeof input !== 'object') throw new TaskError(400, 'Invalid task payload');
  const out = {};
  if (requireTitle || 'title' in input) out.title = cleanText(input.title, LIMITS.title, 'title', true);
  if ('details' in input) out.details = cleanText(input.details, LIMITS.details, 'details', false);
  if ('location' in input) out.location = cleanText(input.location, LIMITS.location, 'location', false);
  if ('startTime' in input) out.startTime = cleanTime(input.startTime, 'startTime');
  if ('endTime' in input) out.endTime = cleanTime(input.endTime, 'endTime');
  if ('priority' in input) {
    if (!PRIORITIES.includes(input.priority)) throw new TaskError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
    out.priority = input.priority;
  }
  if ('status' in input) out.status = cleanStatus(input.status);
  return out;
}

function cleanStatus(status) {
  if (!STATUSES.includes(status)) throw new TaskError(400, `status must be one of ${STATUSES.join(', ')}`);
  return status;
}

function cleanNote(text) {
  return cleanText(text, LIMITS.note, 'note', true);
}

// Next write time for a task: wall clock, but always after the task's last
// write so a later edit on the same instance wins even if the clock stepped back.
function nextStamp(task) {
  return Math.max(Date.now(), (task && task.updatedAt ? task.updatedAt : 0) + 1);
}

function createTask({ id, roleId, fields, assignee = null, seedKey = null, by }) {
  const now = Date.now();
  const task = {
    id: id || newTaskId(),
    roleId,
    title: '',
    details: '',
    location: '',
    startTime: '',
    endTime: '',
    priority: 'normal',
    status: 'todo',
    assignee: assignee || null,
    notes: [],
    seedKey,
    createdAt: now,
    updatedAt: now,
    updatedBy: by,
    v: {}
  };
  Object.assign(task, fields);
  for (const f of FIELDS) task.v[f] = now;
  return task;
}

// Applies already-validated field changes. Returns true if anything changed.
function applyUpdate(task, changes, by) {
  const at = nextStamp(task);
  let changed = false;
  for (const [field, value] of Object.entries(changes)) {
    if (!FIELDS.includes(field)) continue;
    if (JSON.stringify(task[field]) === JSON.stringify(value)) continue;
    task[field] = value;
    task.v[field] = at;
    changed = true;
  }
  if (changed) {
    task.updatedAt = at;
    task.updatedBy = by;
  }
  return changed;
}

function addNote(task, text, by, byRole) {
  if (task.notes.length >= LIMITS.notesPerTask) throw new TaskError(400, 'This task has too many notes');
  const at = nextStamp(task);
  task.notes.push({ id: 'n_' + crypto.randomUUID(), text, by, byRole, at });
  task.updatedAt = at;
  task.updatedBy = by;
}

function makeTombstone(task, by) {
  return {
    id: task.id,
    roleId: task.roleId,
    seedKey: task.seedKey || null,
    deleted: true,
    createdAt: task.createdAt,
    updatedAt: nextStamp(task),
    updatedBy: by
  };
}

// Deterministic tie-break so merge(a, b) === merge(b, a).
function pickByString(x, y) {
  return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
}

function mergeTask(a, b) {
  if (!a) return structuredClone(b);
  if (!b) return structuredClone(a);

  if (a.deleted || b.deleted) {
    const tombs = [a, b].filter(t => t.deleted);
    let pick = tombs[0];
    if (tombs.length === 2) {
      pick = a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? a : b) : pickByString(a, b);
    }
    return { ...structuredClone(pick), updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0) };
  }

  const out = { id: a.id, v: {} };
  for (const f of FIELDS) {
    const ta = (a.v && a.v[f]) || 0;
    const tb = (b.v && b.v[f]) || 0;
    let value;
    if (ta !== tb) value = ta > tb ? a[f] : b[f];
    else value = pickByString(a[f] === undefined ? null : a[f], b[f] === undefined ? null : b[f]);
    out[f] = structuredClone(value === undefined ? null : value);
    out.v[f] = Math.max(ta, tb);
  }

  const notes = new Map();
  for (const n of [...(a.notes || []), ...(b.notes || [])]) {
    if (n && n.id && !notes.has(n.id)) notes.set(n.id, structuredClone(n));
  }
  out.notes = [...notes.values()].sort((x, y) => (x.at - y.at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  out.seedKey = a.seedKey || b.seedKey || null;
  out.createdAt = Math.min(a.createdAt || Infinity, b.createdAt || Infinity);
  if (!Number.isFinite(out.createdAt)) out.createdAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  const newer = a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? a : b) : pickByString(a, b);
  out.updatedBy = newer.updatedBy;
  return out;
}

function mergeTaskMaps(local, remote) {
  const out = {};
  const ids = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const id of ids) {
    const merged = mergeTask(local && local[id], remote && remote[id]);
    if (merged && merged.id === id) out[id] = merged;
  }
  return out;
}

function liveTasks(map) {
  return Object.values(map || {}).filter(t => t && !t.deleted);
}

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

function compareTasks(x, y) {
  const sx = x.startTime || '99:99';
  const sy = y.startTime || '99:99';
  if (sx !== sy) return sx < sy ? -1 : 1;
  const px = PRIORITY_ORDER[x.priority] ?? 1;
  const py = PRIORITY_ORDER[y.priority] ?? 1;
  if (px !== py) return px - py;
  return (x.createdAt || 0) - (y.createdAt || 0);
}

// The shape sent to clients: drops the internal per-field clock.
function publicTask(task) {
  const { v, ...rest } = task;
  return rest;
}

function progressOf(tasks) {
  const counts = { total: tasks.length, todo: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status]++;
  return counts;
}

module.exports = {
  STATUSES,
  PRIORITIES,
  FIELDS,
  LIMITS,
  TaskError,
  newTaskId,
  normalizeFields,
  cleanStatus,
  cleanNote,
  createTask,
  applyUpdate,
  addNote,
  makeTombstone,
  mergeTask,
  mergeTaskMaps,
  liveTasks,
  compareTasks,
  publicTask,
  progressOf
};
