const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('csv-parse/sync');
const { Storage } = require('@google-cloud/storage');

const app = express();
const PORT = process.env.PORT || 8888;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET || 'devfest2026-leaderboard-gde';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Local persistence file path
const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_STORAGE_FILE = path.join(DATA_DIR, 'scores.json');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Google Cloud Storage client initialization
let storage = null;
let bucket = null;
try {
  storage = new Storage();
  bucket = storage.bucket(GCS_BUCKET_NAME);
  console.log(`[GCS] Initialized client for bucket: ${GCS_BUCKET_NAME}`);
} catch (err) {
  console.warn('[GCS] Cloud Storage client initialization warning:', err.message);
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
  scores: [], // Array of score entries
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

// Persist data locally to disk
async function saveToLocalDisk() {
  try {
    await fs.promises.writeFile(LOCAL_STORAGE_FILE, JSON.stringify(appState, null, 2), 'utf8');
    console.log(`[Local Disk] Saved ${appState.scores.length} score entries.`);
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
      console.log(`[Local Disk] Loaded ${appState.scores.length} entries from cache.`);
      return true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[Local Disk] Could not load cache:', err.message);
    }
  }
  return false;
}

// Sync to Cloud Storage
async function backupToCloudStorage() {
  if (!bucket) {
    appState.gcsStatus = "GCS bucket not initialized";
    return false;
  }
  try {
    appState.gcsStatus = "Backing up...";
    const dataToSave = JSON.stringify(appState, null, 2);
    
    // Save latest
    const file = bucket.file('devfest2026_scores_latest.json');
    await file.save(dataToSave, {
      contentType: 'application/json',
      metadata: {
        cacheControl: 'no-cache',
        source: 'devfest-leaderboard-cloudrun'
      }
    });

    // Save timestamped snapshot
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotFile = bucket.file(`snapshots/devfest_scores_${timestamp}.json`);
    await snapshotFile.save(dataToSave, {
      contentType: 'application/json'
    });

    appState.gcsBackupTime = new Date().toISOString();
    appState.gcsStatus = "Active & Synced";
    console.log(`[GCS] Successfully backed up scores to gs://${GCS_BUCKET_NAME}/devfest2026_scores_latest.json`);
    return true;
  } catch (err) {
    console.error('[GCS Backup Error]', err);
    appState.gcsStatus = `Error: ${err.message}`;
    return false;
  }
}

// Restore from Cloud Storage on container cold start if needed
async function restoreFromCloudStorage() {
  if (!bucket) return false;
  try {
    const file = bucket.file('devfest2026_scores_latest.json');
    const [exists] = await file.exists();
    if (!exists) {
      console.log('[GCS] No existing backup found in bucket yet.');
      return false;
    }
    const [contents] = await file.download();
    const parsed = JSON.parse(contents.toString('utf8'));
    if (parsed && Array.isArray(parsed.scores) && parsed.scores.length > 0) {
      console.log(`[GCS] Restored ${parsed.scores.length} scores from Cloud Storage!`);
      // Merge with appState
      appState.scores = parsed.scores;
      appState.gcsBackupTime = parsed.gcsBackupTime;
      appState.gcsStatus = "Restored from GCS";
      return true;
    }
  } catch (err) {
    console.warn('[GCS Restore Warning]', err.message);
  }
  return false;
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
      appState.scores[existingIndex] = newEntry;
      console.log(`[Score Updated] ${newEntry.judgeName} re-scored ${newEntry.teamName}: ${newEntry.totalScore} pts`);
    } else {
      appState.scores.push(newEntry);
      console.log(`[Score Added] ${newEntry.judgeName} scored ${newEntry.teamName}: ${newEntry.totalScore} pts`);
    }

    // Persist locally & to Cloud Storage
    await saveToLocalDisk();
    await backupToCloudStorage();

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
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server & Initialize State
app.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 DevFest Bay Area 2026 Leaderboard & Judging App`);
  console.log(`📍 Running on http://localhost:${PORT}`);
  console.log(`☁️ Cloud Storage Bucket: gs://${GCS_BUCKET_NAME}`);
  console.log(`📊 Google Sheet Source: ${SHEET_CONFIG.sheetId}`);
  console.log(`=======================================================`);

  // Step 1: Load local disk cache if available
  await loadFromLocalDisk();

  // Step 2: Try to restore latest from GCS if local was empty
  if (appState.scores.length === 0) {
    await restoreFromCloudStorage();
  }

  // Step 3: Initial sync from Google Sheets (source of truth)
  await syncFromGoogleSheets();

  // Background recurring sync every 45 seconds to keep live with Google Sheet
  setInterval(() => {
    syncFromGoogleSheets().catch(e => console.warn('[Auto-sync Interval Error]', e.message));
  }, 45000);
});
