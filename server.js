require('dotenv').config();
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const nodemailer = require('nodemailer');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('csv-parse/sync');
const { Storage } = require('@google-cloud/storage');
const { mergeRemoteState } = require('./lib/stateMerge');


const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'devving';
// 32-byte hex key, injected from Secret Manager (leaderboard-encryption-key)
if (!/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY || '')) {
  throw new Error('ENCRYPTION_KEY must be set to 64 hex characters');
}
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

// Returns "ivHex:cipherHex" with a fresh IV per value
function encryptField(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return iv.toString('hex') + ':' + cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
}

function decryptField(data) {
  const parts = data.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  return Buffer.concat([decipher.update(Buffer.from(parts.join(':'), 'hex')), decipher.final()]).toString();
}

const ADMIN_BEARER_TOKEN = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');

const app = express();
const PORT = process.env.PORT || 8888;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET || 'devfest2026-leaderboard-gde';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private') }));

// Local persistence file path (DATA_DIR lets local runs and tests use a scratch dir)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const LOCAL_STORAGE_FILE = path.join(DATA_DIR, 'scores.json');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Google Cloud Storage client initialization
// DISABLE_GCS=1 keeps local/dev runs from ever touching the production bucket,
// even when Application Default Credentials are present on the machine.
let storage = null;
let bucket = null;
if (process.env.DISABLE_GCS === '1') {
  console.log('[GCS] Disabled by DISABLE_GCS=1; state is kept on local disk only.');
} else {
  try {
    storage = new Storage();
    bucket = storage.bucket(GCS_BUCKET_NAME);
    console.log(`[GCS] Initialized client for bucket: ${GCS_BUCKET_NAME}`);
  } catch (err) {
    console.warn('[GCS] Cloud Storage client initialization warning:', err.message);
  }
}

// Google Sheets Config (Source of Truth)
const SHEET_CONFIG = {
  sheetId: '1-YAJhGgrphQhwlUmQcjNVDHK2uRc7jV-2XPA69z8u3E',
  gids: {
    devTrack: '2026781436',   // Gemini Dev Challenge Scores
    builderTrack: '995521338', // Vibecoding Lounge Scores
    overview: '0',             // Overview & Leaderboard
    rubric: '413381525'        // Rubric Reference
  }
};

// Official Rubric & Track Metadata from the sheet
const RUBRIC_DATA = {
  event: {
    title: "DevFest Bay Area 2026",
    subtitle: "Build, Secure, Scale: Developers and Builders in the Agentic Era",
    date: "Thursday, October 1, 2026 | 2:00 PM – 6:00 PM PDT",
    location: "Circuit Launch, Mountain View, CA",
    eventUrl: "https://gdg.community.dev/events/details/google-gdg-sunnyvale-presents-devfest-bay-area-2026/cohost-gdg-sunnyvale",
    sheetUrl: "https://docs.google.com/spreadsheets/d/1-YAJhGgrphQhwlUmQcjNVDHK2uRc7jV-2XPA69z8u3E/edit?gid=2026781436#gid=2026781436"
  },
  tracks: {
    developer: {
      name: "Developer Track (Gemini Dev Challenge)",
      targetAudience: "Software engineers, developers, cloud architects, ML/AI practitioners.",
      philosophy: "Build, Secure, Scale — production-ready multi-tier architectures, agentic orchestration, enterprise security & scalability.",
      techStack: "Full Google Ecosystem: Google Stitch (UI), Gemini API / Gemma models, Firebase Firestore / Cloud SQL backend, Google Cloud Run.",
      resources: [
        { title: "Building AI Apps with Google Ecosystem Codelab", url: "https://codelabs.developers.google.com/building-ai-apps-google-ecosystem#0" },
        { title: "Google Cloud Run Documentation", url: "https://cloud.google.com/run" },
        { title: "Gemini API Documentation", url: "https://ai.google.dev" }
      ],
      criteria: [
        {
          key: "techExecution",
          label: "Technical Execution & Gemini/Cloud Integration",
          max: 10,
          rubric: {
            "9-10": "Deep, flawless integration of Gemini/Cloud APIs.",
            "7-8": "Solid integration with minor issues.",
            "5-6": "Basic integration, some bugs.",
            "1-4": "Minimal or broken integration."
          }
        },
        {
          key: "securityPrivacy",
          label: "Security & Reliability",
          max: 10,
          rubric: {
            "9-10": "Robust security, perfect data handling.",
            "7-8": "Good security practices, minor gaps.",
            "5-6": "Basic guardrails, some vulnerabilities.",
            "1-4": "Poor security, no guardrails."
          }
        },
        {
          key: "scalabilityArch",
          label: "Scalability & Architecture",
          max: 10,
          rubric: {
            "9-10": "Highly scalable, production-ready.",
            "7-8": "Scalable with some limitations.",
            "5-6": "Basic architecture, hard to scale.",
            "1-4": "Unscalable, poor architecture."
          }
        },
        {
          key: "agenticInnovation",
          label: "Agentic Innovation & Practical Utility",
          max: 10,
          rubric: {
            "9-10": "Highly innovative, solves real problem.",
            "7-8": "Creative, useful application.",
            "5-6": "Standard application, limited utility.",
            "1-4": "Not innovative, lacks utility."
          }
        },
        {
          key: "presentationDemo",
          label: "Presentation & Live Demo",
          max: 10,
          rubric: {
            "9-10": "Flawless demo, excellent pitch.",
            "7-8": "Good demo, clear presentation.",
            "5-6": "Working demo, presentation needs work.",
            "1-4": "Broken demo, poor presentation."
          }
        }
      ]
    },
    builder: {
      name: "Builder Track (Vibecoding Lounge)",
      targetAudience: "Tech-savvy professionals without formal coding backgrounds (Product Managers, Designers, Marketers, Founders).",
      philosophy: "From Prompt to Production — vibe coding using natural language prompts in Google AI Studio build mode.",
      techStack: "Google AI Studio Build Mode (ai.studio), natural language prompting, Google Stitch UI, 1-click Cloud Run deployment.",
      resources: [
        { title: "Builder Track Kickoff: Portfolio Web App with AI", url: "https://youtu.be/xaYkxHCRmhE" },
        { title: "Builder Track Kickoff: Web Video Game & Multiplayer", url: "https://youtu.be/t4LOHNHv-r8" },
        { title: "Google Builders Portal", url: "https://goo.gle/builders" }
      ],
      criteria: [
        {
          key: "creativityConcept",
          label: "Creativity & Originality",
          max: 10,
          rubric: {
            "9-10": "Unique, fresh, highly creative concept.",
            "7-8": "Creative concept, interesting approach.",
            "5-6": "Standard concept, somewhat creative.",
            "1-4": "Unoriginal or uncreative concept."
          }
        },
        {
          key: "geminiUtilization",
          label: "Gemini AI Utilization",
          max: 10,
          rubric: {
            "9-10": "Excellent use of Gemini prompts/APIs.",
            "7-8": "Good use of Gemini features.",
            "5-6": "Basic use of Gemini.",
            "1-4": "Minimal or poor use of Gemini."
          }
        },
        {
          key: "uxDesign",
          label: "Usability & User Experience",
          max: 10,
          rubric: {
            "9-10": "Beautiful, intuitive UI/UX.",
            "7-8": "Clean UI, easy to use.",
            "5-6": "Functional UI, needs polish.",
            "1-4": "Poor UI, hard to use."
          }
        },
        {
          key: "workingPrototype",
          label: "Functional Prototype",
          max: 10,
          rubric: {
            "9-10": "Fully working, impressive prototype.",
            "7-8": "Working prototype, minor bugs.",
            "5-6": "Partially working prototype.",
            "1-4": "Broken or non-functional prototype."
          }
        },
        {
          key: "pitchClarity",
          label: "Pitch Clarity",
          max: 10,
          rubric: {
            "9-10": "Crystal clear pitch, highly engaging.",
            "7-8": "Clear pitch, good communication.",
            "5-6": "Adequate pitch, some confusion.",
            "1-4": "Unclear pitch, poor communication."
          }
        }
      ]
    }
  }
};

// In-memory data store (Persistent Memory)
let appState = {
  allowedAdmins: ['gretchen.beach@gmail.com'],
  claims: [], // Volunteer signups
  scores: [],
  registeredTeams: [], // Array of score entries
  lastSyncTime: null,
  syncStatus: "Initializing",
  gcsBackupTime: null,
  gcsStatus: "Idle"
};

// Helper: Fetch CSV from Google Sheets URL
async function fetchCsv(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_CONFIG.sheetId}/export?format=csv&gid=${gid}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
  
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DevFest-Leaderboard-App/1.0' },
      signal: controller.signal
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch CSV: ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Parse Developer Track CSV
function parseDevScores(csvText) {
  try {
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    return records.map(r => ({
      id: `dev_${r['Team Name']}_${r['Judge Name']}`.replace(/\s+/g, '_').toLowerCase(),
      track: "Developer Track",
      teamName: r['Team Name'] || '',
      judgeName: r['Judge Name'] || '',
      scores: {
        techExecution: parseFloat(r['Technical Execution'] || 0),
        securityPrivacy: parseFloat(r['Security & Privacy'] || 0),
        scalabilityArch: parseFloat(r['Scalability & Architecture'] || 0),
        agenticInnovation: parseFloat(r['Agentic Innovation & Impact'] || 0),
        presentationDemo: parseFloat(r['Presentation & Demo'] || 0)
      },
      totalScore: parseFloat(r['Total Score'] || 0),
      notes: r['Notes'] || '',
      source: 'Google Sheets',
      timestamp: new Date().toISOString()
    })).filter(r => r.teamName && !isNaN(r.totalScore) && r.totalScore > 0);
  } catch (e) {
    console.error('[Parse Dev CSV Error]', e);
    return [];
  }
}

// Parse Builder Track CSV
function parseBuilderScores(csvText) {
  try {
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
    return records.map(r => ({
      id: `builder_${r['Team Name']}_${r['Judge Name']}`.replace(/\s+/g, '_').toLowerCase(),
      track: "Builder Track",
      teamName: r['Team Name'] || '',
      judgeName: r['Judge Name'] || '',
      scores: {
        creativityConcept: parseFloat(r['Creativity & Concept'] || 0),
        geminiUtilization: parseFloat(r['Gemini AI Utilization'] || 0),
        uxDesign: parseFloat(r['UX & Design'] || 0),
        workingPrototype: parseFloat(r['Working Prototype'] || 0),
        pitchClarity: parseFloat(r['Pitch & Presentation'] || 0)
      },
      totalScore: parseFloat(r['Total Score'] || 0),
      notes: r['Notes'] || '',
      source: 'Google Sheets',
      timestamp: new Date().toISOString()
    })).filter(r => r.teamName && !isNaN(r.totalScore) && r.totalScore > 0);
  } catch (e) {
    console.error('[Parse Builder CSV Error]', e);
    return [];
  }
}

const DEFAULT_ADMINS = ['gretchen.beach@gmail.com'];
const GCS_STATE_OBJECT = 'devfest2026_scores_latest.json';
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000; // at most one GCS snapshot per 10 minutes
let lastSnapshotAt = 0;
let lastCloudPullAt = 0;

// A state file loaded from disk or GCS may predate newer keys. Make sure the
// shapes the code relies on exist, without discarding anything already there.
function ensureStateShape() {
  if (!Array.isArray(appState.allowedAdmins)) appState.allowedAdmins = [];
  if (!appState.adminChanges || typeof appState.adminChanges !== 'object') appState.adminChanges = {};
  for (const email of DEFAULT_ADMINS) {
    if (!appState.adminChanges[email]) appState.adminChanges[email] = { allowed: true, at: 0 };
  }
  // Admins listed only in the legacy array count as granted at time 0, so any
  // explicit removal recorded in adminChanges wins over them.
  for (const email of appState.allowedAdmins) {
    const key = String(email).toLowerCase();
    if (!appState.adminChanges[key]) appState.adminChanges[key] = { allowed: true, at: 0 };
  }
  appState.allowedAdmins = Object.keys(appState.adminChanges).filter(e => appState.adminChanges[e].allowed).sort();
  if (!Array.isArray(appState.claims)) appState.claims = [];
  if (!Array.isArray(appState.deletedClaims)) appState.deletedClaims = [];
  if (!Array.isArray(appState.deletedScores)) appState.deletedScores = [];
  if (!Array.isArray(appState.scores)) appState.scores = [];
  if (!appState.tasks || typeof appState.tasks !== 'object' || Array.isArray(appState.tasks)) appState.tasks = {};
}

// Merge a copy of the state read from GCS into memory (see lib/stateMerge.js).
function applyRemoteState(remote) {
  ensureStateShape();
  const { tasksChanged } = mergeRemoteState(appState, remote);
  ensureStateShape();
  if (tasksChanged) broadcastTasksChanged(null);
}

// Persist data locally to disk. Written to a temp file and renamed so a crash
// mid-write can never leave a truncated state file behind.
async function saveToLocalDisk() {
  try {
    const tmp = `${LOCAL_STORAGE_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(appState, null, 2), 'utf8');
    await fs.promises.rename(tmp, LOCAL_STORAGE_FILE);
    console.log(`[Local Disk] Saved ${appState.scores.length} score entries, ${Object.keys(appState.tasks || {}).length} tasks.`);
  } catch (err) {
    console.error('[Local Disk Error]', err);
  }
}

// Load data from local disk if available
async function loadFromLocalDisk() {
  try {
    const raw = await fs.promises.readFile(LOCAL_STORAGE_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    if (loaded && Array.isArray(loaded.scores)) {
      appState = loaded;
      ensureStateShape();
      console.log(`[Local Disk] Loaded ${appState.scores.length} entries, ${Object.keys(appState.tasks).length} tasks from cache.`);
      return true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[Local Disk] Could not load cache:', err.message);
    }
  }
  return false;
}

// Read-merge-write against GCS. The upload is conditional on the object's
// generation not having changed since we read it, so if another instance saved
// in between we re-read, re-merge and try again instead of overwriting its data.
async function writeStateToCloud() {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const file = bucket.file(GCS_STATE_OBJECT);
    let generation = 0; // 0 = "only create if it does not exist yet"
    try {
      const [meta] = await file.getMetadata();
      generation = Number(meta.generation);
    } catch (err) {
      if (err.code !== 404) throw err;
    }
    if (generation) {
      const [contents] = await bucket.file(GCS_STATE_OBJECT, { generation }).download();
      let remote = null;
      try {
        remote = JSON.parse(contents.toString('utf8'));
      } catch (e) {
        console.error('[GCS] Remote state is not valid JSON and will be replaced (older snapshots are kept):', e.message);
      }
      // If merging throws, the error propagates and nothing is uploaded, so a
      // bad merge can never overwrite the remote copy with less data.
      if (remote) applyRemoteState(remote);
    }
    lastCloudPullAt = Date.now();

    const dataToSave = JSON.stringify(appState, null, 2);
    try {
      await file.save(dataToSave, {
        contentType: 'application/json',
        resumable: false,
        metadata: { cacheControl: 'no-cache', metadata: { source: 'devfest-leaderboard-cloudrun' } },
        preconditionOpts: { ifGenerationMatch: generation }
      });
    } catch (err) {
      if (err.code === 412 && attempt < MAX_ATTEMPTS) {
        console.warn(`[GCS] State changed during backup (attempt ${attempt}); re-merging.`);
        continue;
      }
      throw err;
    }

    if (Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      lastSnapshotAt = Date.now();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await bucket.file(`snapshots/devfest_scores_${timestamp}.json`).save(dataToSave, { contentType: 'application/json', resumable: false });
    }
    return true;
  }
  return false;
}

async function runBackup() {
  try {
    appState.gcsStatus = "Backing up...";
    const ok = await writeStateToCloud();
    if (!ok) throw new Error('Could not save after repeated concurrent updates');
    appState.gcsBackupTime = new Date().toISOString();
    appState.gcsStatus = "Active & Synced";
    console.log(`[GCS] Successfully backed up state to gs://${GCS_BUCKET_NAME}/${GCS_STATE_OBJECT}`);
    return true;
  } catch (err) {
    console.error('[GCS Backup Error]', err);
    appState.gcsStatus = `Error: ${err.message}`;
    return false;
  }
}

// Sync to Cloud Storage. Calls are coalesced: while one backup runs, any number
// of new requests share a single follow-up backup that starts after it, so
// every caller's change is included in a backup that finishes after its call.
let backupRunning = null;
let backupPending = null;
function startBackup() {
  backupRunning = runBackup().finally(() => { backupRunning = null; });
  return backupRunning;
}
function backupToCloudStorage() {
  if (!bucket) {
    appState.gcsStatus = "GCS bucket not initialized";
    return Promise.resolve(false);
  }
  if (!backupRunning) return startBackup();
  if (!backupPending) {
    backupPending = backupRunning.then(() => {
      backupPending = null;
      return startBackup();
    });
  }
  return backupPending;
}

// Restore from Cloud Storage on container cold start. Always merges (never
// replaces), so it is safe to run even when the local disk already has data.
async function restoreFromCloudStorage() {
  if (!bucket) return false;
  try {
    const file = bucket.file(GCS_STATE_OBJECT);
    const [exists] = await file.exists();
    if (!exists) {
      console.log('[GCS] No existing backup found in bucket yet.');
      return false;
    }
    const [contents] = await file.download();
    const parsed = JSON.parse(contents.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return false;
    if (Array.isArray(parsed.scores) && parsed.scores.length > 0 && appState.scores.length === 0) {
      appState.scores = parsed.scores;
      appState.gcsBackupTime = parsed.gcsBackupTime;
    }
    applyRemoteState(parsed);
    lastCloudPullAt = Date.now();
    appState.gcsStatus = "Restored from GCS";
    console.log(`[GCS] Restored state: ${appState.scores.length} scores, ${appState.claims.length} volunteers, ${Object.keys(appState.tasks).length} tasks.`);
    return true;
  } catch (err) {
    console.warn('[GCS Restore Warning]', err.message);
  }
  return false;
}

// Pull other instances' changes before serving live data (at most every few
// seconds per instance), so a captain and the admin see the same board even
// when their requests land on different Cloud Run instances.
let cloudPullInFlight = null;
function refreshFromCloud(maxAgeMs = 5000) {
  if (!bucket || Date.now() - lastCloudPullAt < maxAgeMs) return Promise.resolve();
  if (!cloudPullInFlight) {
    cloudPullInFlight = (async () => {
      try {
        const [contents] = await bucket.file(GCS_STATE_OBJECT).download();
        applyRemoteState(JSON.parse(contents.toString('utf8')));
      } catch (err) {
        if (err.code !== 404) console.warn('[GCS Refresh Warning]', err.message);
      } finally {
        lastCloudPullAt = Date.now();
        cloudPullInFlight = null;
      }
    })();
  }
  return cloudPullInFlight;
}

// Sync from Google Sheets (Source of Truth)
async function syncFromGoogleSheets() {
  appState.syncStatus = "Syncing from Google Sheets...";
  try {
    console.log('[Sync] Fetching Google Sheets CSV data...');
    const [devCsv, builderCsv] = await Promise.all([
      fetchCsv(SHEET_CONFIG.gids.devTrack),
      fetchCsv(SHEET_CONFIG.gids.builderTrack)
    ]);

    const devScores = parseDevScores(devCsv);
    const builderScores = parseBuilderScores(builderCsv);
    const sheetScores = [...devScores, ...builderScores];

    console.log(`[Sync] Retrieved ${devScores.length} Dev and ${builderScores.length} Builder entries from Google Sheets.`);

    // Merge strategy:
    // Existing locally submitted scores with source === 'Judge App' are preserved
    // Scores from Google Sheets are updated or inserted
    const appSubmissions = appState.scores.filter(s => s.source === 'Judge App');

    // Combine sheets scores with non-duplicate app submissions
    const merged = [...sheetScores];
    for (const appSub of appSubmissions) {
      const alreadyInSheets = sheetScores.some(s => 
        s.teamName.toLowerCase() === appSub.teamName.toLowerCase() && 
        s.judgeName.toLowerCase() === appSub.judgeName.toLowerCase()
      );
      if (!alreadyInSheets) {
        merged.push(appSub);
      }
    }

    appState.scores = merged;
    appState.lastSyncTime = new Date().toISOString();
    appState.syncStatus = `Synced (${merged.length} total entries)`;

    // Persist to local disk and cloud storage
    await saveToLocalDisk();
    backupToCloudStorage().catch(e => console.warn('[Background GCS Backup Error]', e.message));

    return { success: true, count: merged.length, devCount: devScores.length, builderCount: builderScores.length };
  } catch (err) {
    console.error('[Sync Error]', err);
    appState.syncStatus = `Sync Failed: ${err.message}`;
    return { success: false, error: err.message };
  }
}

// Compute dynamic leaderboard
function computeLeaderboard(trackFilter = 'all') {
  let filtered = appState.scores;
  if (trackFilter === 'developer') {
    filtered = filtered.filter(s => s.track.includes('Developer'));
  } else if (trackFilter === 'builder') {
    filtered = filtered.filter(s => s.track.includes('Builder'));
  }

  // Group scores by teamName
  const teamMap = {};
  for (const entry of filtered) {
    const key = entry.teamName.trim();
    if (!teamMap[key]) {
      teamMap[key] = {
        teamName: key,
        track: entry.track,
        judges: [],
        totalPointsSum: 0,
        judgeCount: 0,
        scoresByCategory: {},
        notes: []
      };
    }
    teamMap[key].judges.push({
      judgeName: entry.judgeName,
      totalScore: entry.totalScore,
      scores: entry.scores,
      notes: entry.notes,
      source: entry.source,
      timestamp: entry.timestamp
    });
    teamMap[key].totalPointsSum += entry.totalScore;
    teamMap[key].judgeCount += 1;
    if (entry.notes) {
      teamMap[key].notes.push({ judge: entry.judgeName, note: entry.notes });
    }

    // Accumulate category scores
    for (const [cat, val] of Object.entries(entry.scores || {})) {
      if (!teamMap[key].scoresByCategory[cat]) {
        teamMap[key].scoresByCategory[cat] = { sum: 0, count: 0 };
      }
      teamMap[key].scoresByCategory[cat].sum += val;
      teamMap[key].scoresByCategory[cat].count += 1;
    }
  }

  // Calculate averages and format output
  const leaderboard = Object.values(teamMap).map(team => {
    const avgScore = Number((team.totalPointsSum / team.judgeCount).toFixed(1));
    const categoryAverages = {};
    for (const [cat, data] of Object.entries(team.scoresByCategory)) {
      categoryAverages[cat] = Number((data.sum / data.count).toFixed(1));
    }

    return {
      teamName: team.teamName,
      track: team.track,
      averageScore: avgScore,
      judgeCount: team.judgeCount,
      categoryAverages,
      judges: team.judges,
      notes: team.notes
    };
  });

  // Sort descending by averageScore
  leaderboard.sort((a, b) => b.averageScore - a.averageScore);

  // Assign ranks
  leaderboard.forEach((t, idx) => {
    t.rank = idx + 1;
  });

  return leaderboard;
}

// ----------------- API Endpoints -----------------

// Status & Health
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    event: RUBRIC_DATA.event.title,
    lastSyncTime: appState.lastSyncTime,
    syncStatus: appState.syncStatus,
    gcsBucket: GCS_BUCKET_NAME,
    gcsStatus: appState.gcsStatus,
    gcsBackupTime: appState.gcsBackupTime,
    totalScoresCount: appState.scores.length,
    sheetsUrl: RUBRIC_DATA.event.sheetUrl,
    eventUrl: RUBRIC_DATA.event.eventUrl
  });
});

// Full Rubric & Criteria
app.get('/api/rubric', (req, res) => {
  res.json(RUBRIC_DATA);
});

// Leaderboard data
app.get('/api/leaderboard', (req, res) => {
  const track = req.query.track || 'all';
  const leaderboard = computeLeaderboard(track);
  res.json({
    track,
    updatedAt: new Date().toISOString(),
    lastSyncTime: appState.lastSyncTime,
    teams: leaderboard,
    totalTeams: leaderboard.length
  });
});

// Get raw scores list


// Delete a specific score
app.delete('/api/scores/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const initialLength = appState.scores.length;
  appState.scores = appState.scores.filter(s => s.id !== id);
  if (appState.scores.length < initialLength) {
    appState.deletedScores.push(id);
    appState.lastSyncTime = new Date().toISOString();
    await saveToLocalDisk();
    await backupToCloudStorage();
    broadcastEvent('scores_updated', appState.scores);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Score not found' });
  }
});


// Team Registration Endpoints
app.get('/api/teams', (req, res) => {
  res.json({ teams: appState.registeredTeams || [] });
});

app.post('/api/teams', requireAdmin, async (req, res) => {
  const { teamName, track } = req.body;
  if (!appState.registeredTeams) appState.registeredTeams = [];
  if (teamName && !appState.registeredTeams.find(t => t.teamName.toLowerCase() === teamName.trim().toLowerCase())) {
    appState.registeredTeams.push({ teamName: teamName.trim(), track });
    appState.lastSyncTime = new Date().toISOString();
    await backupToCloudStorage();
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: 'Team already exists or invalid' });
  }
});

app.delete('/api/teams/:name', requireAdmin, async (req, res) => {
  if (!appState.registeredTeams) appState.registeredTeams = [];
  appState.registeredTeams = appState.registeredTeams.filter(t => t.teamName !== req.params.name);
  appState.lastSyncTime = new Date().toISOString();
  await backupToCloudStorage();
  res.json({ success: true });
});

// --- SERVER-SENT EVENTS (SSE) FOR SILENT BACKGROUND UPDATES ---
let sseClients = [];

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  sseClients.push({ id: clientId, res });

  // Send an initial heartbeat
  res.write('event: connected\ndata: {}\n\n');

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

function broadcastEvent(eventType, payload) {
  sseClients.forEach(client => {
    client.res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
}

// The SSE stream is public, so task events carry no task content: clients
// refetch through their authenticated endpoints when they see one.
function broadcastTasksChanged(roleId) {
  broadcastEvent('tasks_changed', { roleId: roleId || null, at: Date.now() });
}

app.get('/api/scores', (req, res) => {
  res.json({
    count: appState.scores.length,
    scores: appState.scores
  });
});

// Submit a new judge score
app.post('/api/scores', async (req, res) => {
  try {
    const { track, teamName, judgeName, scores, notes } = req.body;

    if (!teamName || !judgeName || !track || !scores) {
      return res.status(400).json({ error: 'Missing required fields: teamName, judgeName, track, scores.' });
    }

    // Calculate total score
    let totalScore = 0;
    const sanitizedScores = {};
    for (const [k, v] of Object.entries(scores)) {
      const num = Math.min(10, Math.max(0, parseFloat(v) || 0));
      sanitizedScores[k] = num;
      totalScore += num;
    }

    const newEntry = {
      id: `app_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      track: track.includes('Developer') ? 'Developer Track' : 'Builder Track',
      teamName: teamName.trim(),
      judgeName: judgeName.trim(),
      scores: sanitizedScores,
      totalScore: Number(totalScore.toFixed(1)),
      notes: (notes || '').trim(),
      source: 'Judge App',
      timestamp: new Date().toISOString()
    };

    // Check if judge already scored this team - update if so, else append
    const existingIndex = appState.scores.findIndex(s => 
      s.teamName.toLowerCase() === newEntry.teamName.toLowerCase() &&
      s.judgeName.toLowerCase() === newEntry.judgeName.toLowerCase() &&
      s.track === newEntry.track
    );

    if (existingIndex >= 0) {
      if (appState.scores[existingIndex].id !== newEntry.id) appState.deletedScores.push(appState.scores[existingIndex].id);
      appState.scores[existingIndex] = newEntry;
      console.log(`[Score Updated] ${newEntry.judgeName} re-scored ${newEntry.teamName}: ${newEntry.totalScore} pts`);
    } else {
      appState.scores.push(newEntry);
      console.log(`[Score Added] ${newEntry.judgeName} scored ${newEntry.teamName}: ${newEntry.totalScore} pts`);
    }

    // Persist locally & to Cloud Storage
    await saveToLocalDisk();
    await backupToCloudStorage();

    broadcastEvent('scores_updated', appState.scores);
    res.json({
      success: true,
      message: `Score of ${newEntry.totalScore}/50 recorded successfully!`,
      entry: newEntry
    });
  } catch (err) {
    console.error('[Score Submission Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger manual sync from Google Sheets
app.post('/api/sync', async (req, res) => {
  const result = await syncFromGoogleSheets();
  res.json(result);
});

// Trigger manual GCS snapshot
app.post('/api/backup', async (req, res) => {
  const ok = await backupToCloudStorage();
  res.json({
    success: ok,
    gcsBucket: GCS_BUCKET_NAME,
    timestamp: appState.gcsBackupTime,
    status: appState.gcsStatus
  });
});

// Export CSV for pasting back to Google Sheets
app.get('/api/export/csv', (req, res) => {
  const track = req.query.track || 'developer';
  let csv = '';
  
  if (track === 'developer') {
    csv = 'Team Name,Judge Name,Technical Execution,Security & Privacy,Scalability & Architecture,Agentic Innovation & Impact,Presentation & Demo,Total Score,Notes\n';
    const devEntries = appState.scores.filter(s => s.track.includes('Developer'));
    for (const e of devEntries) {
      const s = e.scores || {};
      csv += `"${e.teamName}","${e.judgeName}",${s.techExecution || 0},${s.securityPrivacy || 0},${s.scalabilityArch || 0},${s.agenticInnovation || 0},${s.presentationDemo || 0},${e.totalScore},"${(e.notes || '').replace(/"/g, '""')}"\n`;
    }
  } else {
    csv = 'Team Name,Judge Name,Creativity & Concept,Gemini AI Utilization,UX & Design,Working Prototype,Pitch & Presentation,Total Score,Notes\n';
    const builderEntries = appState.scores.filter(s => s.track.includes('Builder'));
    for (const e of builderEntries) {
      const s = e.scores || {};
      csv += `"${e.teamName}","${e.judgeName}",${s.creativityConcept || 0},${s.geminiUtilization || 0},${s.uxDesign || 0},${s.workingPrototype || 0},${s.pitchClarity || 0},${e.totalScore},"${(e.notes || '').replace(/"/g, '""')}"\n`;
    }
  }

  res.header('Content-Type', 'text/csv');
  res.attachment(`devfest2026_${track}_scores.csv`);
  res.send(csv);
});

// Fallback to SPA index.html


// Start Server & Initialize State

// --- INTERACTIVE STAGE LOGIC ---
let interactionQueue = [];

app.post('/api/interact', (req, res) => {
  const { teamName, action } = req.body;
  if (!teamName || !action) return res.status(400).json({ error: 'Missing teamName or action' });
  interactionQueue.push({ teamName, action, timestamp: Date.now() });
  // Keep queue manageable
  if (interactionQueue.length > 100) interactionQueue.shift();
  res.json({ success: true });
});

app.get('/api/interactions', (req, res) => {
  const current = [...interactionQueue];
  interactionQueue = []; // flush queue after reading
  res.json({ interactions: current });
});
// -------------------------------


// --- VOLUNTEER HUB LOGIC ---
 
const WRIKE_TOKEN = process.env.WRIKE_TOKEN || "eyJ0dCI6InAiLCJhbGciOiJIUzI1NiIsInR2IjoiMiJ9.eyJkIjoie1wiYVwiOjcyMjQ2OTEsXCJpXCI6OTg0MjM3MSxcImNcIjo0NzQwMjkwLFwidVwiOjI1OTQzMDAyLFwiclwiOlwiVVNcIixcInNcIjpbXCJXXCIsXCJGXCIsXCJJXCIsXCJVXCIsXCJLXCIsXCJDXCIsXCJEXCIsXCJNXCIsXCJBXCIsXCJMXCIsXCJQXCJdLFwielwiOltdLFwidFwiOjB9IiwiaWF0IjoxNzg2NTA3ODc2fQ.MfLrayA9vrem_-_2QA50izOZgJBGiRuS1RTv8Iuhygw";
const FOLDER_ID = process.env.WRIKE_FOLDER_ID || "MQAAAAEOCyNH";
const VOLUNTEERS_FILE = path.join(DATA_DIR, 'volunteers.json');

// Ensure volunteers file exists
if (!fs.existsSync(VOLUNTEERS_FILE)) {
  fs.writeFileSync(VOLUNTEERS_FILE, JSON.stringify([]));
}

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/volunteer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'volunteer.html')));

app.get('/api/volunteer/tasks', async (req, res) => {
  try {
    const url = `https://www.wrike.com/api/v4/folders/${FOLDER_ID}/tasks?fields=['description']`;
    const response = await fetch(url, { headers: { 'Authorization': `bearer ${WRIKE_TOKEN}` } });
    const data = await response.json();
    
    // Filter only tasks starting with [Volunteer]
    const vTasks = (data.data || [])
      .filter(t => t.title.startsWith('[Volunteer]'))
      .map(t => ({
        id: t.id,
        title: t.title.replace('\[Volunteer\]', '').replace(/Recruit for:?\s*/i, '').trim(),
        description: (t.description || 'DevFest Bay Area 2026 Volunteer Task').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n').replace(/&nbsp;/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/ +/g, ' ').replace(/ \n/g, '\n').replace(/\n /g, '\n').replace(/Time Commitment:/gi, '\n\n⏱️ Time Commitment:').replace(/Responsibility:/gi, '📋 Responsibility:').trim(),
        status: t.status
      }));

    // Inject Venue Deck Instructions based on team assignment
    vTasks.forEach(t => {
      const titleLower = t.title.toLowerCase();
      if (titleLower.includes('registration') || titleLower.includes('check-in')) {
        t.venueInstructions = "📍 **Venue Ops (Room 101):** 3 check-in tables for rapid NFC badging. You must ensure attendees sign the mandatory Circuit Launch digital waiver via QR code. Handle 21+ wristbanding and swag handoff.";
      } else if (titleLower.includes('wayfind') || titleLower.includes('security') || titleLower.includes('parking')) {
        t.venueInstructions = "📍 **Venue Ops (Security/Wayfinding):** Manage Moffett Blvd traffic and Google lot shuttles. Monitor door access. Circuit Launch lot is STRICTLY for speakers, VIPs, ADA, and vendor load-in.";
      } else if (titleLower.includes('tech') || titleLower.includes('av') || titleLower.includes('stage')) {
        t.venueInstructions = "📍 **Venue Ops (Tech/AV):** Main Auditorium (~120 seats). CRITICAL FLIP (10:30-11:00 AM): 20-min fast table flip from theater chairs to 15-20 foldable tables. 60 chairs must be stacked on perimeter racks.";
      } else if (titleLower.includes('food') || titleLower.includes('guest')) {
        t.venueInstructions = "📍 **Venue Ops (Food):** Rear lot tents (10-ft train track clearance). Double ID Check (verify wristband at bar). Manage Circuit Launch large cooler + ice tubs.";
      } else if (titleLower.includes('clean') || titleLower.includes('sweep')) {
        t.venueInstructions = "📍 **Venue Ops (Cleanup):** Hourly sweeps to replace bags and wipe tables. Teardown (6:30-8:30 PM): 30 tables folded, chair stacking, vacuuming, full facility reset.";
      }
      
      if (appState.roleInstructions && appState.roleInstructions[t.id]) {
        t.venueInstructions = (t.venueInstructions ? t.venueInstructions + "\n\n" : "") + "📌 **Admin Update:** " + appState.roleInstructions[t.id];
      }
    });
      
    // Read local claims
    const claims = appState.claims || [];
    const claimedIds = claims.map(c => c.taskId);
    
    // Annotate
    const finalTasks = vTasks.map(t => {
       t.claimCount = claimedIds.filter(id => id === t.id).length;
       t.claimed = t.claimCount >= 10;
       return t;
    });
    res.json(finalTasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Wrike tasks' });
  }
});

// Save minimal PII securely


async function notifyVolunteerOfSignup(volunteerEmail, firstName, taskId) {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    console.log("Volunteer email skipped: SMTP credentials not configured");
    return;
  }
  
  try {
    // Fetch task from Wrike to get title and description
    const url = `https://www.wrike.com/api/v4/tasks/${taskId}?fields=['description']`;
    const wRes = await fetch(url, { headers: { 'Authorization': `bearer ${WRIKE_TOKEN}` } });
    const wData = await wRes.json();
    let taskTitle = "Volunteer Task";
    let taskDesc = "";
    if (wData && wData.data && wData.data.length > 0) {
      taskTitle = wData.data[0].title.replace('\[Volunteer\]', '').replace(/Recruit for:?\s*/i, '').trim();
      taskDesc = (wData.data[0].description || '').replace(/<[^>]+>/g, ' ').trim();
    }

    // Determine venue instructions
    let venueInstructions = "";
    const titleLower = taskTitle.toLowerCase();
    if (titleLower.includes('registration') || titleLower.includes('check-in')) {
      venueInstructions = "📍 Venue Ops (Room 101): 3 check-in tables for rapid NFC badging. Ensure attendees sign the mandatory Circuit Launch digital waiver via QR code. Handle 21+ wristbanding and swag handoff.";
    } else if (titleLower.includes('wayfind') || titleLower.includes('security') || titleLower.includes('parking')) {
      venueInstructions = "📍 Venue Ops (Security/Wayfinding): Manage Moffett Blvd traffic and Google lot shuttles. Monitor door access. Circuit Launch lot is STRICTLY for speakers, VIPs, ADA, and vendor load-in.";
    } else if (titleLower.includes('tech') || titleLower.includes('av') || titleLower.includes('stage')) {
      venueInstructions = "📍 Venue Ops (Tech/AV): Main Auditorium (~120 seats). CRITICAL FLIP (10:30-11:00 AM): 20-min fast table flip from theater chairs to 15-20 foldable tables. 60 chairs must be stacked on perimeter racks.";
    } else if (titleLower.includes('food') || titleLower.includes('guest')) {
      venueInstructions = "📍 Venue Ops (Food): Rear lot tents (10-ft train track clearance). Double ID Check (verify wristband at bar). Manage Circuit Launch large cooler + ice tubs.";
    } else if (titleLower.includes('clean') || titleLower.includes('sweep')) {
      venueInstructions = "📍 Venue Ops (Cleanup): Hourly sweeps to replace bags and wipe tables. Teardown (6:30-8:30 PM): 30 tables folded, chair stacking, vacuuming, full facility reset.";
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    let htmlContent = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <h2 style="color: #4285F4;">You're officially on the roster, ${firstName}! 🎉</h2>
        <p>Thank you so much for signing up to help at DevFest Bay Area 2026. Here are the details for your assignment:</p>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e0e0e0;">
          <h3 style="margin-top: 0; color: #202124;">${taskTitle}</h3>
          <p style="font-size: 14px; color: #5f6368;">${taskDesc}</p>
        </div>
    `;

    if (venueInstructions) {
      htmlContent += `
        <div style="background-color: #e8f0fe; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #d2e3fc;">
          <h4 style="margin-top: 0; color: #174ea6; margin-bottom: 8px;">Important Venue Instructions</h4>
          <p style="font-size: 14px; color: #174ea6; margin: 0;">${venueInstructions}</p>
        </div>
      `;
    }


    if (appState.roleInstructions && appState.roleInstructions[taskId]) {
      venueInstructions = (venueInstructions ? venueInstructions + "<br><br>" : "") + "📌 <b>Admin Update:</b> " + appState.roleInstructions[taskId];
    }
    if (appState.volunteerInstructions) {
      htmlContent += `
        <div style="margin-top: 30px;">
          <h4 style="color: #202124;">General Organizer Instructions:</h4>
          <div style="font-size: 14px; color: #3c4043;">
            ${appState.volunteerInstructions.replace(/\n/g, '<br>')}
          </div>
        </div>
      `;
    }

    htmlContent += `
        <p style="margin-top: 30px; font-size: 14px; color: #5f6368;">
          If you need to update your phone number, you can simply sign up again on the Volunteer Hub using the same email address.<br>
          See you at Circuit Launch!
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: '"DevFest 2026 Organizing Team" <' + SMTP_USER + '>',
      to: volunteerEmail,
      subject: 'Your DevFest Volunteer Assignment: ' + taskTitle,
      html: htmlContent
    });
    console.log("Sent confirmation email to volunteer:", volunteerEmail);
  } catch(e) {
    console.error("Failed to send volunteer email:", e);
  }
}

async function notifyAdminOfSignup() {
  const { SMTP_USER, SMTP_PASS, ADMIN_EMAIL } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !ADMIN_EMAIL) {
    console.log("Email notification skipped: SMTP_USER, SMTP_PASS, or ADMIN_EMAIL not configured in .env");
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const claims = appState.claims || [];
    let htmlContent = `<h2 style="color: #4285F4;">DevFest Volunteer Update 🚀</h2>
                       <p>A new volunteer just signed up! Here is the complete list of all active sign-ups:</p>
                       <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
                         <tr style="background-color: #f3f3f3;">
                           <th>Task ID</th><th>First Name</th><th>Last Initial</th><th>Email</th><th>Phone</th>
                         </tr>`;

    claims.forEach(c => {
      // Decrypt the email for the admin
      let decryptedEmail = "Error decrypting";
      let decryptedPhone = "N/A";
      try {
        decryptedEmail = decryptField(c.emailData);
        if (c.phoneData) decryptedPhone = decryptField(c.phoneData);
      } catch (e) {
        console.error("Decryption failed for email", e);
      }

      htmlContent += `<tr>
        <td>${c.taskId}</td>
        <td>${c.firstName}</td>
        <td>${c.lastInitial}</td>
        <td><a href="mailto:${decryptedEmail}">${decryptedEmail}</a></td>
        <td>${decryptedPhone}</td>
      </tr>`;
    });

    htmlContent += `</table><p>Log in to your Admin Portal to send blast announcements!</p>`;

    await transporter.sendMail({
      from: `"DevFest Leaderboard" <${SMTP_USER}>`,
      to: ADMIN_EMAIL,
      subject: "New Volunteer Signup! 🚀",
      html: htmlContent
    });
    console.log("Admin notification email sent successfully.");
  } catch (error) {
    console.error("Failed to send admin email:", error);
  }
}

app.post('/api/volunteer/claim', async (req, res) => {
  const { taskId, firstName, lastInitial, email, phoneNumber } = req.body;
  if (!taskId || !firstName || !email || !phoneNumber) return res.status(400).json({ error: 'Missing required fields' });
  
  const claimRecord = {
    taskId,
    displayName: `${firstName} ${lastInitial}.`,
    emailData: encryptField(email),
    phoneData: encryptField(phoneNumber),
    timestamp: Date.now()
  };
  
  const claims = appState.claims || [];
  
  // Find if this email already claimed this task
  let existingIndex = -1;
  for (let i = 0; i < claims.length; i++) {
    let c = claims[i];
    if (c.taskId === taskId && c.emailData) {
      try {
        if (decryptField(c.emailData).toLowerCase() === email.toLowerCase()) {
          existingIndex = i;
          break;
        }
      } catch (e) {}
    }
  }

  if (existingIndex > -1) {
    claims[existingIndex] = claimRecord; // Update the existing sign-up
  } else {
    const existingCount = claims.filter(c => c.taskId === taskId).length;
    if (existingCount >= 10) return res.status(400).json({ error: 'This role has reached its 10-person capacity.' });
    claims.push(claimRecord);
  }
  appState.claims = claims;
  if (!appState.roleInstructions) appState.roleInstructions = {};
  if (!appState.captainInstructions) appState.captainInstructions = {};

  saveToLocalDisk();
  backupToCloudStorage();
  
  // We intentionally do not mutate the Wrike task status here anymore
  // so that unlimited volunteers can sign up for the same role without closing it.
  
  notifyAdminOfSignup(); // Fire async email
  notifyVolunteerOfSignup(email, firstName, taskId); // Send confirmation to volunteer
  res.json({ success: true, message: 'Task successfully claimed!' });
});
// -----------------------------


// --- ADMIN & INSTRUCTIONS LOGIC ---
 
const JUDGE_PASS = process.env.JUDGE_PASSWORD || "alldevswin";

if(!appState.volunteerInstructions) {
  appState.volunteerInstructions = "Welcome to the DevFest Volunteer team! Please make sure to check in at the front desk 15 minutes before your shift.";
}

app.get('/api/auth/status', (req, res) => {
  res.json({ isSetup: !!appState.admin });
});

app.post('/api/auth/setup', async (req, res) => {
  if (appState.admin) {
    return res.status(400).json({ error: 'Admin already configured' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  appState.admin = { username, hash };
  
  await saveToLocalDisk();
  await backupToCloudStorage();
  
  res.json({ success: true });
});


app.get('/api/auth/config', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload['email'];

    if (appState.allowedAdmins && appState.allowedAdmins.includes(email.toLowerCase())) {
      return res.json({ success: true, token: ADMIN_BEARER_TOKEN, email });
    }
    return res.status(403).json({ error: 'Unauthorized email: ' + email });
  } catch (err) {
    console.error("Google Auth Error:", err);
    return res.status(401).json({ error: 'Invalid Google token' });
  }
});

app.post('/api/auth', (req, res) => {
  const { username, password, type } = req.body;
  
  if (type === 'admin') {
    if (!appState.admin) return res.status(400).json({ error: 'Not setup' });
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (appState.admin.username === username && appState.admin.hash === hash) {
      return res.json({ success: true, token: ADMIN_BEARER_TOKEN });
    }
  } else if (type === 'judge') {
    if (password === JUDGE_PASS) {
      return res.json({ success: true, token: 'judge_token_mock' });
    }
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/instructions', (req, res) => {
  res.json({ text: appState.volunteerInstructions });
});



function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== 'Bearer ' + ADMIN_BEARER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}



app.post('/api/admin/volunteers/:taskId/captain', requireAdmin, async (req, res) => {
  try {
    let claims = appState.claims || [];
    const { timestamp } = req.body;
    let found = false;
    for (let c of claims) {
      if (c.taskId === req.params.taskId && c.timestamp == timestamp) {
        c.isCaptain = !c.isCaptain;
        found = true;
        break;
      }
    }
    if (found) {
      appState.claims = claims;
      saveToLocalDisk();
      backupToCloudStorage();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Volunteer not found' });
    }
  } catch(e) {
    res.status(500).json({ error: 'Failed to update captain status' });
  }
});


app.post('/api/admin/assign', requireAdmin, async (req, res) => {
  const { taskId, firstName, lastInitial, email, phone, isCaptain } = req.body;
  
  if (!taskId || !firstName || !email) return res.status(400).json({ error: 'Missing required fields' });
  
  const existingCount = (appState.claims || []).filter(c => c.taskId === taskId).length;
  // Let admins override the cap of 10 if they want, or enforce it? Let's just bypass cap for Admins.

  const claimRecord = {
    taskId,
    displayName: `${firstName} ${lastInitial || 'X'}.`,
    emailData: encryptField(email),
    phoneData: phone ? encryptField(phone) : '',
    timestamp: Date.now(),
    isCaptain: !!isCaptain
  };
  
  appState.claims = appState.claims || [];
  // Remove dummy data while we're at it (since this endpoint touches state, it will save it)
  const realNames = ['Peeya', 'Hande', 'Jaynesh', 'Veeresh', 'Ishai', 'Suresh', 'Jorge', 'Tatiana', firstName];
  appState.claims = appState.claims.filter(c => realNames.some(n => c.displayName.includes(n)));
  
  appState.claims.push(claimRecord);
  
  await saveToLocalDisk();
  await backupToCloudStorage();
  res.json({ success: true });
});

app.delete('/api/admin/volunteers/:taskId', requireAdmin, async (req, res) => {
  try {
    let claims = appState.claims || [];
    
    const { timestamp } = req.body;
    const newClaims = claims.filter(c => !(c.taskId === req.params.taskId && c.timestamp === timestamp));

    appState.claims = newClaims;
    saveToLocalDisk();
    backupToCloudStorage();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.get('/api/admin/volunteers', requireAdmin, (req, res) => {
  // Normally verify token here
  try {
    const claims = appState.claims || [];
    const results = claims.map(c => {
      let decryptedEmail = "Error decrypting";
      try {
        if (c.emailData) decryptedEmail = decryptField(c.emailData);
      } catch (e) {
        console.error("Decryption failed for email", e);
      }
      let decryptedPhone = 'N/A';
      try {
        if (c.phoneData) decryptedPhone = decryptField(c.phoneData);
      } catch (e) {}
      return {
        taskId: c.taskId,
        displayName: c.displayName,
        email: decryptedEmail,
        phone: decryptedPhone,
        isCaptain: !!c.isCaptain,
        timestamp: c.timestamp
      };
    });
    res.json({ success: true, volunteers: results });
  } catch(e) {
    res.status(500).json({ error: 'Failed to read volunteers' });
  }
});


app.post('/api/admin/add_admin', requireAdmin, async (req, res) => {
  const { newAdminEmail } = req.body;
  if (newAdminEmail && !appState.allowedAdmins.includes(newAdminEmail.toLowerCase())) {
    appState.allowedAdmins.push(newAdminEmail.toLowerCase());
    await saveToLocalDisk();
    await backupToCloudStorage();
    return res.json({ success: true, allowedAdmins: appState.allowedAdmins });
  }
  res.json({ success: true, allowedAdmins: appState.allowedAdmins });
});


app.post('/api/admin/wipe_dummies', requireAdmin, async (req, res) => {
  // Wipe dummies (keep only Peeya, Hande, Jaynesh, Veeresh, Ishai, Suresh, Jorge, Tatiana)
  const realNames = ['Peeya', 'Hande', 'Jaynesh', 'Veeresh', 'Ishai', 'Suresh', 'Jorge', 'Tatiana'];
  appState.claims = (appState.claims || []).filter(c => realNames.some(n => c.firstName.includes(n)));
  await saveToLocalDisk();
  await backupToCloudStorage();
  res.json({ success: true, claims: appState.claims });
});
app.get('/api/admin/admins', requireAdmin, (req, res) => {
  res.json({ success: true, allowedAdmins: appState.allowedAdmins });
});

app.post('/api/instructions', requireAdmin, async (req, res) => {
  if (!appState.roleInstructions) appState.roleInstructions = {};
  if (!appState.captainInstructions) appState.captainInstructions = {};
  
  const { target, text } = req.body;
  if (!target) {
    // fallback for old UI
    if (text !== undefined) {
      appState.volunteerInstructions = text;
      await saveToLocalDisk();
      await backupToCloudStorage();
      return res.json({ success: true });
    }
    return res.status(400).json({ error: 'Missing text' });
  }

  if (!text || text.trim() === '') {
    if (target === 'global') appState.volunteerInstructions = '';
    else if (target.startsWith('role_')) delete appState.roleInstructions[target.replace('role_', '')];
    else if (target.startsWith('cap_')) delete appState.captainInstructions[target.replace('cap_', '')];
  } else {
    if (target === 'global') {
      appState.volunteerInstructions = text;
    } else if (target.startsWith('role_')) {
      appState.roleInstructions[target.replace('role_', '')] = text;
    } else if (target.startsWith('cap_')) {
      appState.captainInstructions[target.replace('cap_', '')] = text;
    }
  }
  
  await saveToLocalDisk();
  await backupToCloudStorage();
  res.json({ success: true });
});

app.get('/api/instructions/all', requireAdmin, (req, res) => {
  res.json({
    global: appState.volunteerInstructions || '',
    roles: appState.roleInstructions || {},
    captains: appState.captainInstructions || {}
  });
});

app.post('/api/blast', requireAdmin, (req, res) => {
  // Dummy endpoint for Blast Notifications
  const { message } = req.body;
  console.log('📢 BLAST MESSAGE TO ALL VOLUNTEERS:', message);
  broadcastEvent('blast', { message });
  res.json({ success: true, message: 'Blast sent successfully (simulated).' });
});
// ----------------------------------

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// State is loaded and merged with GCS *before* the port opens, so no request
// can write to a half-initialised state that the restore would then replace.
async function start({ port = PORT } = {}) {
  // Step 1: Load local disk cache if available
  await loadFromLocalDisk();
  ensureStateShape();

  // Step 2: Merge the latest state from GCS. This runs on every cold start: the
  // container image ships a data/scores.json, so "local is empty" is not a
  // reliable signal that a restore is needed.
  await restoreFromCloudStorage();
  ensureStateShape();

  const server = await new Promise(resolve => {
    const s = app.listen(port, () => resolve(s));
  });
  console.log(`=======================================================`);
  console.log(`🚀 DevFest Bay Area 2026 Leaderboard & Judging App`);
  console.log(`📍 Running on http://localhost:${server.address().port}`);
  console.log(`☁️ Cloud Storage Bucket: ${bucket ? 'gs://' + GCS_BUCKET_NAME : 'disabled'}`);
  console.log(`📊 Google Sheet Source: ${SHEET_CONFIG.sheetId}`);
  console.log(`=======================================================`);

  if (process.env.DISABLE_SHEETS_SYNC === '1') {
    console.log('[Sync] Google Sheets sync disabled by DISABLE_SHEETS_SYNC=1');
    return server;
  }
  // Step 3: Initial sync from Google Sheets (source of truth)
  await syncFromGoogleSheets();

  // Background recurring sync every 45 seconds to keep live with Google Sheet
  const timer = setInterval(() => {
    syncFromGoogleSheets().catch(e => console.warn('[Auto-sync Interval Error]', e.message));
  }, 45000);
  server.on('close', () => clearInterval(timer));
  return server;
}

if (require.main === module) {
  start().catch(err => {
    console.error('[Startup Error]', err);
    process.exit(1);
  });
}

// Exported for tests (node test/*.test.js); not used in production.
module.exports = {
  app,
  start,
  getState: () => appState,
  backupToCloudStorage,
  saveToLocalDisk,
  _setBucketForTests: b => { bucket = b; lastCloudPullAt = 0; },
  _googleClient: googleClient
};
