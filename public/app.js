// DevFest Bay Area 2026 - Leaderboard & Judging App Client
let currentTab = 'leaderboard';
let currentTrackFilter = 'all';
let allTeams = [];
let rubricData = null;

let isProjectorMode = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Load remembered judge name
  const savedJudge = localStorage.getItem('devfest_judge_name');
  if (savedJudge && document.getElementById('judge-name-input')) {
    document.getElementById('judge-name-input').value = savedJudge;
  }

  // Fetch initial data
  await loadRubric();
  await loadStatus();
  await loadLeaderboard();

  // Setup auto-refresh every 15 seconds
  

  // Setup criteria inputs
  updateRubricCriteria();

  renderSchedule().then(() => lucide.createIcons());
});

// Switch Top & Bottom Navigation Tabs
function switchTab(tabId) {
  // Check password for judge portal
  if (tabId === 'judge' && !sessionStorage.getItem('judge_auth_passed')) {
    const pin = prompt("Enter the Judge Password to access scoring:");
    if (pin !== "alldevswin") {
      alert("Incorrect password!");
      return; // Do not switch tabs
    }
    sessionStorage.setItem('judge_auth_passed', 'true');
  }

  currentTab = tabId;
  const tabs = ['leaderboard', 'judge', 'rubric', 'sync'];
  
  tabs.forEach(t => {
    const view = document.getElementById(`view-${t}`);
    const desktopBtn = document.getElementById(`tab-btn-${t}`);
    const mobBtn = document.getElementById(`mob-nav-${t}`);

    if (view) {
      if (t === tabId) {
        view.classList.remove('hidden');
      } else {
        view.classList.add('hidden');
      }
    }

    // Desktop Nav Styling
    if (desktopBtn) {
      if (t === tabId) {
        desktopBtn.className = 'nav-tab px-3.5 py-2 rounded-xl text-sm font-semibold transition flex items-center space-x-2 bg-googleBlue text-white shadow-md shadow-blue-500/20';
      } else {
        desktopBtn.className = 'nav-tab px-3.5 py-2 rounded-xl text-sm font-medium transition flex items-center space-x-2 text-gray-600 hover:text-[#1e1e1e] hover:bg-gray-100/60';
      }
    }

    // Mobile Bottom Nav Styling
    if (mobBtn) {
      if (t === tabId) {
        mobBtn.className = 'flex flex-col items-center justify-center w-16 py-1 text-googleBlue font-bold transition scale-105';
      } else {
        mobBtn.className = 'flex flex-col items-center justify-center w-16 py-1 text-gray-600 font-medium transition';
      }
    }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabId === 'leaderboard') {
    loadLeaderboard();
  } else if (tabId === 'sync') {
    loadStatus();
  }

  lucide.createIcons();
}

// Track Filter Toggle
function setTrackFilter(track) {
  currentTrackFilter = track;
  const pills = {
    all: document.getElementById('filter-all'),
    developer: document.getElementById('filter-dev'),
    builder: document.getElementById('filter-builder')
  };

  Object.entries(pills).forEach(([key, el]) => {
    if (!el) return;
    if (key === track) {
      el.className = 'track-pill px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition bg-googleBlue text-white whitespace-nowrap shadow-sm shadow-blue-500/20';
    } else {
      el.className = 'track-pill px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition text-gray-700 hover:bg-gray-100 whitespace-nowrap';
    }
  });

  renderLeaderboard();
}

// Fetch Rubric & Track Information
async function loadRubric() {
  try {
    const res = await fetch('/api/rubric');
    rubricData = await res.json();
    renderRubricMatrix();
  } catch (err) {
    console.error('Error fetching rubric:', err);
  }
}

// Fetch App Status (GCS, Google Sheets)
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const lastSyncEl = document.getElementById('last-sync-badge');
    if (lastSyncEl && data.lastSyncTime) {
      const dt = new Date(data.lastSyncTime);
      lastSyncEl.textContent = `Synced: ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const gcsBadge = document.getElementById('gcs-badge');
    if (gcsBadge) {
      gcsBadge.textContent = `gs://${data.gcsBucket}`;
    }

    // Sync View details
    const sheetStatus = document.getElementById('sheet-status-text');
    if (sheetStatus) sheetStatus.textContent = data.syncStatus || 'Connected';

    const sheetTime = document.getElementById('sheet-sync-time');
    if (sheetTime && data.lastSyncTime) {
      sheetTime.textContent = new Date(data.lastSyncTime).toLocaleString();
    }

    const gcsStatus = document.getElementById('gcs-status-text');
    if (gcsStatus) gcsStatus.textContent = data.gcsStatus || 'Active';

    const gcsTime = document.getElementById('gcs-backup-time');
    if (gcsTime && data.gcsBackupTime) {
      gcsTime.textContent = new Date(data.gcsBackupTime).toLocaleString();
    }

    const gcsBucketDisp = document.getElementById('gcs-bucket-display');
    if (gcsBucketDisp) gcsBucketDisp.textContent = `gs://${data.gcsBucket}`;

  } catch (err) {
    console.error('Error fetching status:', err);
  }
}

// Fetch Leaderboard
async function loadLeaderboard() {
  const icon = document.getElementById('refresh-icon');
  const mobIcon = document.getElementById('mobile-refresh-icon');
  if (icon) icon.classList.add('animate-spin');
  if (mobIcon) mobIcon.classList.add('animate-spin');

  try {
    const res = await fetch(`/api/leaderboard?track=${currentTrackFilter}`);
    const data = await res.json();
    allTeams = data.teams || [];

    // Update track counts
    updateTrackCounts();

    // Populate team datalist for judge portal
    updateTeamDatalist();

    // Render leaderboard & podium
    renderLeaderboard();

    // Update status
    if (data.lastSyncTime) {
      const dt = new Date(data.lastSyncTime);
      const b = document.getElementById('last-sync-badge');
      if (b) b.textContent = `Synced: ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
  } finally {
    setTimeout(() => {
      const curIcon = document.getElementById('refresh-icon');
      const curMobIcon = document.getElementById('mobile-refresh-icon');
      if (curIcon) curIcon.classList.remove('animate-spin');
      if (curMobIcon) curMobIcon.classList.remove('animate-spin');
    }, 400);
  }
}

// Manual refresh button click
function manualRefresh() {
  loadLeaderboard();
  showToast('Refreshing live scores...');
}

// Update count badges
async function updateTrackCounts() {
  try {
    const res = await fetch('/api/leaderboard?track=all');
    const data = await res.json();
    const all = data.teams || [];
    
    const devCount = all.filter(t => t.track.includes('Developer')).length;
    const builderCount = all.filter(t => t.track.includes('Builder')).length;

    const elAll = document.getElementById('count-all');
    const elDev = document.getElementById('count-dev');
    const elBuilder = document.getElementById('count-builder');

    if (elAll) elAll.textContent = all.length;
    if (elDev) elDev.textContent = devCount;
    if (elBuilder) elBuilder.textContent = builderCount;
  } catch (e) {
    console.error('Error updating counts', e);
  }
}

// Populate datalist for judging
function updateTeamDatalist() {
  const datalist = document.getElementById('existing-teams-list');
  if (!datalist) return;
  datalist.innerHTML = '';
  const seen = new Set();
  allTeams.forEach(t => {
    if (!seen.has(t.teamName)) {
      seen.add(t.teamName);
      const opt = document.createElement('option');
      opt.value = t.teamName;
      opt.label = `${t.teamName} (${t.track})`;
      datalist.appendChild(opt);
    }
  });
}

// Render Leaderboard (Mobile Cards + Desktop Table)
function renderLeaderboard() {
  const query = (document.getElementById('search-teams')?.value || '').toLowerCase().trim();
  
  let filtered = allTeams;
  if (currentTrackFilter === 'developer') {
    filtered = filtered.filter(t => t.track.includes('Developer'));
  } else if (currentTrackFilter === 'builder') {
    filtered = filtered.filter(t => t.track.includes('Builder'));
  }

  if (query) {
    filtered = filtered.filter(t => t.teamName.toLowerCase().includes(query));
  }

  // Update badge
  const countBadge = document.getElementById('teams-count-badge');
  if (countBadge) countBadge.textContent = `${filtered.length} Teams Graded`;

  // Render Podium (Top 3)
  renderPodium(filtered.slice(0, 3));

  // Render Desktop Table & Mobile Cards
  const tbody = document.getElementById('leaderboard-table-body');
  const mobileContainer = document.getElementById('mobile-cards-container');
  const emptyState = document.getElementById('empty-state');
  
  if (tbody) tbody.innerHTML = '';
  if (mobileContainer) mobileContainer.innerHTML = '';

  if (filtered.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  } else {
    if (emptyState) emptyState.classList.add('hidden');
  }

  // Populate Desktop Table
  filtered.forEach((team, index) => {
    const isDev = team.track.includes('Developer');
    const trackBadge = isDev 
      ? `<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-600 border border-blue-500/25">⚡ Developer Track</span>`
      : `<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/15 text-yellow-600 border border-yellow-500/25">🎨 Builder Track</span>`;

    let rankBadge = `<span class="font-bold text-gray-600">#${team.rank || index + 1}</span>`;
    if (index === 0) rankBadge = `<span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-500/20 text-amber-700 font-bold border border-amber-500/40 text-xs">🥇 1</span>`;
    else if (index === 1) rankBadge = `<span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-300/20 text-slate-600 font-bold border border-slate-300/40 text-xs">🥈 2</span>`;
    else if (index === 2) rankBadge = `<span class="inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-700/20 text-amber-500 font-bold border border-amber-700/40 text-xs">🥉 3</span>`;

    if (tbody) {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-gray-100/40 transition cursor-pointer border-b border-gray-200/60';
      tr.onclick = () => showTeamDetails(team.teamName);
      tr.innerHTML = `
        <td class="py-4 px-6">${rankBadge}</td>
        <td class="py-4 px-6">
          <div class="font-bold text-[#1e1e1e] text-base">${escapeHtml(team.teamName)}</div>
          <div class="text-xs text-gray-600 mt-0.5 line-clamp-1">${team.notes?.length ? escapeHtml(team.notes[0].note) : 'No judge notes yet'}</div>
        </td>
        <td class="py-4 px-6">${trackBadge}</td>
        <td class="py-4 px-6 text-gray-700 text-xs">
          <span class="inline-flex items-center gap-1 font-semibold">
            <i data-lucide="users" class="w-3.5 h-3.5 text-gray-600"></i>
            ${team.judgeCount} ${team.judgeCount === 1 ? 'judge' : 'judges'}
          </span>
        </td>
        <td class="py-4 px-6">
          <div class="flex items-center space-x-2">
            <span class="text-lg font-extrabold text-[#1e1e1e]">${team.averageScore}</span>
            <span class="text-xs text-gray-600">/ 50</span>
          </div>
          <div class="w-24 bg-gray-100 rounded-full h-1.5 mt-1 overflow-hidden">
            <div class="bg-gradient-to-r from-googleBlue to-googleGreen h-1.5 rounded-full" style="width: ${(team.averageScore / 50) * 100}%"></div>
          </div>
        </td>
        <td class="py-4 px-6 text-right">
          <button class="p-2 text-gray-600 hover:text-[#1e1e1e] rounded-lg hover:bg-gray-300/50 transition">
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    // Populate Mobile Native Card
    if (mobileContainer) {
      const card = document.createElement('div');
      card.className = 'bg-white border border-gray-200 rounded-2xl p-4 active:scale-[0.99] transition cursor-pointer shadow-md space-y-3';
      card.onclick = () => showTeamDetails(team.teamName);

      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center space-x-2.5">
            ${rankBadge}
            <div>
              <h4 class="font-bold text-[#1e1e1e] text-base leading-tight">${escapeHtml(team.teamName)}</h4>
              <div class="mt-1 flex items-center space-x-2">
                ${trackBadge}
                <span class="text-[11px] text-gray-600">• ${team.judgeCount} ${team.judgeCount === 1 ? 'judge' : 'judges'}</span>
              </div>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <div class="text-xl font-black text-[#1e1e1e] font-display">${team.averageScore} <span class="text-xs font-normal text-gray-600">/ 50</span></div>
          </div>
        </div>

        <div class="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
          <div class="bg-gradient-to-r from-googleBlue to-googleGreen h-1.5 rounded-full" style="width: ${(team.averageScore / 50) * 100}%"></div>
        </div>

        ${team.notes?.length ? `
          <div class="text-xs text-gray-600 bg-gray-50 p-2 rounded-xl border border-gray-200/80 line-clamp-2">
            "${escapeHtml(team.notes[0].note)}"
          </div>
        ` : ''}
      `;
      mobileContainer.appendChild(card);
    }
  });

  lucide.createIcons();
}

// Render Top 3 Podium (Mobile 1st on top, Desktop 2-1-3)
function renderPodium(top3) {
  const container = document.getElementById('podium-container');
  if (!container) return;
  container.innerHTML = '';

  if (top3.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  // Define desktop orders: 1st place in center (order-2), 2nd place on left (order-1), 3rd on right (order-3)
  const meta = [
    { place: 1, label: '1st Place & Leader', color: 'border-amber-400/50 bg-amber-50/20 glow-gold', medal: '🥇', orderClass: 'order-1 md:order-2' },
    { place: 2, label: '2nd Place', color: 'border-slate-400/30 bg-slate-200/40', medal: '🥈', orderClass: 'order-2 md:order-1' },
    { place: 3, label: '3rd Place', color: 'border-amber-700/30 bg-amber-50/10', medal: '🥉', orderClass: 'order-3 md:order-3' }
  ];

  top3.forEach((team, i) => {
    const m = meta[i];
    const isDev = team.track.includes('Developer');
    const trackBadge = isDev 
      ? `<span class="px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-semibold bg-blue-500/20 text-blue-700">⚡ Developer</span>`
      : `<span class="px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-semibold bg-yellow-500/20 text-yellow-700">🎨 Builder</span>`;

    const card = document.createElement('div');
    card.className = `rounded-2xl border ${m.color} ${m.orderClass} p-4 sm:p-5 flex flex-col justify-between cursor-pointer transition hover:scale-[1.01] active:scale-[0.99] shadow-lg`;
    card.onclick = () => showTeamDetails(team.teamName);

    card.innerHTML = `
      <div>
        <div class="flex items-center justify-between">
          <span class="text-2xl">${m.medal}</span>
          <span class="text-[11px] font-bold uppercase tracking-wider text-gray-600">${m.label}</span>
        </div>
        <h3 class="text-lg sm:text-xl font-extrabold text-[#1e1e1e] mt-2 font-display">${escapeHtml(team.teamName)}</h3>
        <div class="mt-1.5 flex items-center space-x-2">
          ${trackBadge}
          <span class="text-xs text-gray-600">• ${team.judgeCount} ${team.judgeCount === 1 ? 'judge' : 'judges'}</span>
        </div>
      </div>

      <div class="mt-4 pt-3 border-t border-gray-200/80 flex items-end justify-between">
        <div>
          <span class="text-[10px] sm:text-xs text-gray-600 uppercase font-semibold">Average Score</span>
          <div class="text-2xl sm:text-3xl font-black text-[#1e1e1e] mt-0.5 font-display flex items-baseline gap-1">
            ${team.averageScore} <span class="text-xs sm:text-sm font-normal text-gray-600">/ 50</span>
          </div>
        </div>
        <button class="px-3 py-1.5 rounded-xl bg-gray-100 hover:bg-gray-300 text-xs font-semibold text-gray-800 transition">
          View Scores
        </button>
      </div>
    `;

    container.appendChild(card);
  });
}

// Show Team Details Modal
function showTeamDetails(teamName) {
  const team = allTeams.find(t => t.teamName.toLowerCase() === teamName.toLowerCase());
  if (!team) return;

  const modal = document.getElementById('details-modal');
  const content = document.getElementById('modal-content');
  if (!modal || !content) return;

  const isDev = team.track.includes('Developer');

  // Format judges list
  let judgesHtml = '';
  team.judges.forEach(j => {
    let breakdownHtml = '';
    for (const [k, v] of Object.entries(j.scores || {})) {
      breakdownHtml += `
        <div class="flex items-center justify-between text-xs py-1 border-b border-gray-200/50">
          <span class="text-gray-600 capitalize">${k.replace(/([A-Z])/g, ' $1')}</span>
          <span class="font-bold text-[#1e1e1e]">${v} / 10</span>
        </div>
      `;
    }

    judgesHtml += `
      <div class="bg-gray-50 border border-gray-200 rounded-2xl p-3.5 sm:p-4 space-y-2.5">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-googleBlue/20 text-googleBlue font-bold flex items-center justify-center text-xs">
              ${j.judgeName.substring(0, 2).toUpperCase()}
            </div>
            <div>
              <div class="text-xs sm:text-sm font-bold text-[#1e1e1e]">${escapeHtml(j.judgeName)}</div>
              <div class="text-[10px] text-gray-600">${j.source || 'Scored'} • ${j.timestamp ? new Date(j.timestamp).toLocaleDateString() : ''}</div>
            </div>
          </div>
          <div class="text-right">
            <span class="text-base sm:text-lg font-black text-emerald-600">${j.totalScore}</span>
            <span class="text-xs text-gray-600">/ 50</span>
          </div>
        </div>

        <div class="pt-1">
          ${breakdownHtml}
        </div>

        ${j.notes ? `
          <div class="bg-gray-50/60 rounded-xl p-2.5 text-xs text-gray-700 border border-gray-200">
            <strong class="text-gray-600">Notes:</strong> "${escapeHtml(j.notes)}"
          </div>
        ` : ''}
      </div>
    `;
  });

  content.innerHTML = `
    <div>
      <div class="flex items-center space-x-2 text-xs">
        <span class="px-2.5 py-0.5 rounded-full font-semibold ${isDev ? 'bg-blue-500/20 text-blue-600' : 'bg-yellow-500/20 text-yellow-600'}">
          ${team.track}
        </span>
        <span class="text-gray-600 font-semibold">Rank #${team.rank || '-'}</span>
      </div>

      <h2 class="text-xl sm:text-2xl font-extrabold text-[#1e1e1e] mt-1.5 font-display">${escapeHtml(team.teamName)}</h2>
      
      <div class="mt-3.5 p-3.5 sm:p-4 rounded-2xl bg-gradient-to-r from-blue-200/20 to-purple-200/20 border border-blue-800/40 flex items-center justify-between">
        <div>
          <span class="text-[11px] text-gray-600 uppercase font-semibold">Average Total Score</span>
          <div class="text-2xl sm:text-3xl font-black text-[#1e1e1e] mt-0.5">${team.averageScore} <span class="text-xs font-normal text-gray-600">/ 50</span></div>
        </div>
        <div class="text-right">
          <span class="text-[11px] text-gray-600 uppercase font-semibold">Total Evaluations</span>
          <div class="text-xl sm:text-2xl font-bold text-[#1e1e1e] mt-0.5">${team.judgeCount} ${team.judgeCount === 1 ? 'Judge' : 'Judges'}</div>
        </div>
      </div>

      <div class="mt-5">
        <h4 class="text-xs font-bold uppercase tracking-wider text-gray-600 mb-2.5">Individual Judge Evaluations (${team.judges.length})</h4>
        <div class="space-y-2.5">
          ${judgesHtml}
        </div>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
  lucide.createIcons();
}

function closeDetailsModal() {
  document.getElementById('details-modal')?.classList.add('hidden');
}

// Update Dynamic Rubric Criteria in Judge Portal (with Touch Steppers & Sliders)
function updateRubricCriteria() {
  const container = document.getElementById('criteria-container');
  if (!container || !rubricData) return;

  const trackVal = document.querySelector('input[name="track"]:checked')?.value || 'Developer Track';
  const isDev = trackVal.includes('Developer');
  const criteriaList = isDev ? rubricData.tracks.developer.criteria : rubricData.tracks.builder.criteria;

  container.innerHTML = '';

  criteriaList.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'bg-gray-50 border border-gray-200 rounded-2xl p-3.5 sm:p-4 space-y-2.5 transition hover:border-gray-300';

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <span class="text-[10px] sm:text-[11px] font-bold text-googleBlue uppercase tracking-wider">Criterion ${idx + 1}</span>
          <h4 class="text-xs sm:text-sm font-bold text-[#1e1e1e] mt-0.5">${c.label}</h4>
        </div>
        
        <!-- Touch Stepper & Value Display -->
        <div class="flex items-center space-x-1.5 flex-shrink-0">
          <button type="button" aria-label="Decrease score for ${c.label}" onclick="adjustScore('${c.key}', -1)" class="stepper-btn w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-gray-100 hover:bg-gray-300 active:bg-gray-400 text-[#1e1e1e] font-bold flex items-center justify-center text-sm transition focus-visible:ring-2 focus-visible:ring-googleBlue focus:outline-none">
            -
          </button>
          
          <div class="px-2 py-1 bg-gray-50 border border-gray-300 rounded-lg text-center min-w-[36px]" aria-live="polite">
            <span id="score-display-${c.key}" class="text-base sm:text-lg font-black text-googleBlue">9</span>
          </div>

          <button type="button" aria-label="Increase score for ${c.label}" onclick="adjustScore('${c.key}', 1)" class="stepper-btn w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-gray-100 hover:bg-gray-300 active:bg-gray-400 text-[#1e1e1e] font-bold flex items-center justify-center text-sm transition focus-visible:ring-2 focus-visible:ring-googleBlue focus:outline-none">
            +
          </button>
        </div>
      </div>

      <!-- Slider input for desktop / fine tuning -->
      <div>
        <input type="range" min="1" max="10" value="9" step="1" id="slider-${c.key}" name="criterion_${c.key}"
          oninput="handleSliderChange('${c.key}')"
          class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-googleBlue">
        <div class="flex justify-between text-[10px] text-gray-600 font-mono mt-1 px-1">
          <span>1</span>
          <span>5</span>
          <span>7</span>
          <span>10</span>
        </div>
      </div>

      <!-- Rubric Level Explainer -->
      <div id="rubric-hint-${c.key}" class="text-[11px] sm:text-xs bg-gray-50/90 p-2.5 rounded-xl border border-gray-200 text-gray-700">
        <span class="font-bold text-emerald-600">9-10 (Excellent):</span> ${c.rubric['9-10']}
      </div>
    `;

    container.appendChild(card);
  });

  recalculateLiveTotal();
}

// Adjust score via stepper buttons [-] / [+]
function adjustScore(key, delta) {
  const slider = document.getElementById(`slider-${key}`);
  if (!slider) return;
  let val = parseInt(slider.value) + delta;
  val = Math.max(1, Math.min(10, val));
  slider.value = val;
  handleSliderChange(key);
}

// Handle Slider Changes
function handleSliderChange(key) {
  const slider = document.getElementById(`slider-${key}`);
  const display = document.getElementById(`score-display-${key}`);
  const hint = document.getElementById(`rubric-hint-${key}`);
  if (!slider || !display) return;

  const val = parseInt(slider.value);
  display.textContent = val;

  const trackVal = document.querySelector('input[name="track"]:checked')?.value || 'Developer Track';
  const isDev = trackVal.includes('Developer');
  const criteriaList = isDev ? rubricData.tracks.developer.criteria : rubricData.tracks.builder.criteria;
  const criterion = criteriaList.find(c => c.key === key);

  if (criterion && hint) {
    if (val >= 9) {
      hint.innerHTML = `<span class="font-bold text-emerald-600">9-10 (Excellent):</span> ${criterion.rubric['9-10']}`;
    } else if (val >= 7) {
      hint.innerHTML = `<span class="font-bold text-blue-600">7-8 (Good):</span> ${criterion.rubric['7-8']}`;
    } else if (val >= 5) {
      hint.innerHTML = `<span class="font-bold text-yellow-600">5-6 (Adequate):</span> ${criterion.rubric['5-6']}`;
    } else {
      hint.innerHTML = `<span class="font-bold text-rose-600">1-4 (Needs Work):</span> ${criterion.rubric['1-4']}`;
    }
  }

  recalculateLiveTotal();
}

// Live total score calculation
function recalculateLiveTotal() {
  const sliders = document.querySelectorAll('input[type="range"]');
  let total = 0;
  sliders.forEach(s => {
    total += parseInt(s.value) || 0;
  });

  const totalEl = document.getElementById('live-total-score');
  if (totalEl) totalEl.textContent = total;
}

// Handle Score Form Submission
async function handleScoreSubmit(e) {
  e.preventDefault();
  
  const judgeNameInput = document.getElementById('judge-name-input');
  const teamNameInput = document.getElementById('team-name-input');
  const judgeName = (judgeNameInput?.value || '').trim();
  const teamName = (teamNameInput?.value || '').trim();

  // Edge Case: Missing required inputs
  if (!judgeName) {
    showToast('⚠️ Please enter your Judge Name');
    judgeNameInput?.focus();
    return;
  }
  if (!teamName) {
    showToast('⚠️ Please enter or select a Team Name');
    teamNameInput?.focus();
    return;
  }

  const submitBtn = document.getElementById('submit-score-btn');
  const originalHtml = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span>Saving to Memory & GCS...</span>`;

  try {
    const track = document.querySelector('input[name="track"]:checked')?.value || 'Developer Track';
    const notes = (document.getElementById('judge-notes')?.value || '').trim();

    // Remember judge name locally
    localStorage.setItem('devfest_judge_name', judgeName);

    // Collect slider values
    const scores = {};
    const sliders = document.querySelectorAll('input[type="range"]');
    sliders.forEach(s => {
      const key = s.name.replace('criterion_', '');
      scores[key] = parseInt(s.value) || 0;
    });

    const payload = {
      track,
      judgeName,
      teamName,
      scores,
      notes
    };

    const res = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Submission failed');

    // Confetti celebration
    if (window.confetti) {
      confetti({
        particleCount: 80,
        spread: 60,
        origin: { y: 0.6 }
      });
    }

    showToast(`✓ Evaluation recorded for "${teamName}" (${result.entry.totalScore}/50)!`);

    // Reset team and notes, keep judge
    teamNameInput.value = '';
    const notesEl = document.getElementById('judge-notes');
    if (notesEl) notesEl.value = '';

    // Reload leaderboard silently in background
    await loadLeaderboard();
    
    // Reset sliders for the next team
    sliders.forEach(s => {
      s.value = 0;
      updateSliderBackground(s);
      const valSpan = document.getElementById(`val_${s.name.split('_')[1]}`);
      if (valSpan) valSpan.innerText = '0/10';
    });
    calculateTotal();
    
    // Keep user on the judge portal and scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast(`✓ Score recorded for "${teamName}"! Ready for the next team.`);

  } catch (err) {
    alert('Error saving score: ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalHtml;
  }
}

// Render Rubric Matrix Table & Mobile Cards
function renderRubricMatrix() {
  const tbody = document.getElementById('rubric-matrix-body');
  const mobileContainer = document.getElementById('mobile-rubric-cards');
  if (!rubricData) return;
  
  if (tbody) tbody.innerHTML = '';
  if (mobileContainer) mobileContainer.innerHTML = '';

  const renderBoth = (trackName, criteria) => {
    criteria.forEach(c => {
      // Desktop Table Row
      if (tbody) {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-200 hover:bg-gray-100/30 transition';
        tr.innerHTML = `
          <td class="py-3 px-4 font-bold text-gray-700">${trackName}</td>
          <td class="py-3 px-4 font-semibold text-[#1e1e1e]">${c.label}</td>
          <td class="py-3 px-4 text-emerald-600 bg-emerald-50/10">${c.rubric['9-10']}</td>
          <td class="py-3 px-4 text-blue-600 bg-blue-50/10">${c.rubric['7-8']}</td>
          <td class="py-3 px-4 text-yellow-600 bg-yellow-50/10">${c.rubric['5-6']}</td>
          <td class="py-3 px-4 text-rose-600 bg-rose-50/10">${c.rubric['1-4']}</td>
        `;
        tbody.appendChild(tr);
      }

      // Mobile Card
      if (mobileContainer) {
        const card = document.createElement('div');
        card.className = 'bg-gray-50 border border-gray-200 rounded-2xl p-3.5 space-y-2';
        card.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-bold text-googleBlue uppercase tracking-wider">${trackName}</span>
            <span class="text-[10px] text-gray-600">10 pts max</span>
          </div>
          <h4 class="text-sm font-bold text-[#1e1e1e]">${c.label}</h4>
          <div class="space-y-1.5 pt-1 text-xs">
            <div class="p-2 rounded-xl bg-emerald-50/20 border border-emerald-200/30 text-emerald-700">
              <strong>9-10:</strong> ${c.rubric['9-10']}
            </div>
            <div class="p-2 rounded-xl bg-blue-50/20 border border-blue-200/30 text-blue-700">
              <strong>7-8:</strong> ${c.rubric['7-8']}
            </div>
            <div class="p-2 rounded-xl bg-yellow-50/20 border border-yellow-200/30 text-yellow-700">
              <strong>5-6:</strong> ${c.rubric['5-6']}
            </div>
            <div class="p-2 rounded-xl bg-rose-50/20 border border-rose-200/30 text-rose-700">
              <strong>1-4:</strong> ${c.rubric['1-4']}
            </div>
          </div>
        `;
        mobileContainer.appendChild(card);
      }
    });
  };

  renderBoth('Developer Track', rubricData.tracks.developer.criteria);
  renderBoth('Builder Track', rubricData.tracks.builder.criteria);
}

// Trigger Manual Sync from Google Sheets
async function triggerManualSync() {
  showToast('Connecting to Google Sheets source of truth...');
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Synced ${data.count} score entries from Google Sheets!`);
      await loadStatus();
      await loadLeaderboard();
    } else {
      alert('Sync warning: ' + data.error);
    }
  } catch (err) {
    alert('Failed to sync: ' + err.message);
  }
}

// Trigger Manual GCS Backup
async function triggerManualBackup() {
  showToast('Writing snapshot to Google Cloud Storage...');
  try {
    const res = await fetch('/api/backup', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Cloud Storage snapshot pushed to gs://${data.gcsBucket}`);
      await loadStatus();
    } else {
      alert('GCS Backup warning');
    }
  } catch (err) {
    alert('Failed GCS backup: ' + err.message);
  }
}

// Stage Projector Mode
function toggleProjectorMode() {
  isProjectorMode = !isProjectorMode;
  if (isProjectorMode) {
    document.body.classList.add('projector-active');
    document.getElementById('exit-projector-btn').classList.remove('hidden');
    showToast('Projector Mode enabled: Press ESC to exit');
  } else {
    document.body.classList.remove('projector-active');
    document.getElementById('exit-projector-btn').classList.add('hidden');
  }
}

// Keyboard shortcuts (ESC exits projector mode)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isProjectorMode) {
    toggleProjectorMode();
  }
});

// Toast notification helper
function showToast(msg) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = msg;
  toast.classList.remove('opacity-0', 'translate-y-4', 'pointer-events-none');
  toast.classList.add('opacity-100', 'translate-y-0');
  
  if (toast.timeoutId) clearTimeout(toast.timeoutId);
  toast.timeoutId = setTimeout(() => {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', 'translate-y-4', 'pointer-events-none');
  }, 3500);
}

// HTML escape helper
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// --- ROLE BASED ACCESS CONTROL ---
document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const role = urlParams.get('role') || 'public'; // default to public
  
  const navLeaderboard = document.querySelectorAll('#tab-btn-leaderboard, #mob-nav-leaderboard');
  const navJudge = document.querySelectorAll('#tab-btn-judge, #mob-nav-judge');
  const navRubric = document.querySelectorAll('#tab-btn-rubric, #mob-nav-rubric');
  const navSync = document.querySelectorAll('#tab-btn-sync, #mob-nav-sync');

  // Helper to hide elements
  const hideAll = (elements) => elements.forEach(el => { if(el) el.style.display = 'none'; });

  if (role === 'public') {
    hideAll(navJudge);
    hideAll(navRubric);
    hideAll(navSync);
    switchTab('leaderboard');
  } else if (role === 'judge') {
    hideAll(navSync);
    hideAll(navLeaderboard); // Exclusive view
    // Auto prompt password
    if (!sessionStorage.getItem('judge_auth_passed')) {
       const pin = prompt("Enter the Judge Password to access the portal:");
       // Call the backend to verify the judge password securely
       fetch('/api/auth', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ type: 'judge', password: pin })
       }).then(res => {
         if (res.ok) {
           sessionStorage.setItem('judge_auth_passed', 'true');
           switchTab('judge'); // Force UI to update now that auth passed
         } else {
           alert("Incorrect password! Redirecting to public view.");
           window.location.href = '/?role=public';
         }
       }).catch(() => {
         alert("Error connecting to server. Redirecting.");
         window.location.href = '/?role=public';
       });
       return; // Wait for fetch to finish
    }
    switchTab('judge');
  } else if (role === 'admin') {
    // Show everything (default CSS)
    switchTab('sync');
  }
});
// ---------------------------------


async function fetchPreRegisteredTeams() {
  try {
    const res = await fetch('/api/teams');
    const data = await res.json();
    return data.teams || [];
  } catch(e) {
    return [];
  }
}


async function renderSchedule() {
  const tbody = document.getElementById('dynamic-schedule-body');
  if (!tbody) return;
  
  const preReg = await fetchPreRegisteredTeams();
  const devTeams = preReg.filter(t => t.track.includes('Developer'));
  const builderTeams = preReg.filter(t => t.track.includes('Builder'));
  
  // Enforce at least 10 slots per track so it doesn't look empty, but allow more if registered
  const maxSlots = Math.max(10, devTeams.length, builderTeams.length);
  
  let html = '';
  for (let i = 0; i < maxSlots; i++) {
    const startMin = 15 + i * 5;
    const endMin = startMin + 5;
    const formatTime = (min) => {
      let hr = 5;
      let m = min;
      if (m >= 60) { hr = 6; m = m - 60; }
      return `${hr}:${m.toString().padStart(2, '0')} PM`;
    };
    const timeStr = `${formatTime(startMin)} - ${formatTime(endMin)}`;
    
    const devName = devTeams[i] ? devTeams[i].teamName : `Team ${i + 1} Demo`;
    const builderName = builderTeams[i] ? builderTeams[i].teamName : `Team ${i + 1} Demo`;
    
    html += `<tr><td class="p-2.5 whitespace-nowrap">${timeStr}</td><td class="p-2.5 font-bold">${devName}</td><td class="p-2.5"><span class="text-blue-600">Developer Track</span><br><span class="text-[10px] text-gray-500">Breakout 3</span></td><td class="p-2.5 text-gray-700">Olivier, Ivan, Parul, Rakesh, Shubham & Peeya</td></tr>`;
    html += `<tr><td class="p-2.5 whitespace-nowrap">${timeStr}</td><td class="p-2.5 font-bold">${builderName}</td><td class="p-2.5"><span class="text-green-600">Builder Track</span><br><span class="text-[10px] text-gray-500">Expo Hall</span></td><td class="p-2.5 text-gray-700">Gretchen, Jorge, Anu, Hemanth & Lourdes</td></tr>`;
  }
  
  html += `<tr class="bg-gray-50"><td class="p-2.5 whitespace-nowrap">6:05 PM - 6:15 PM</td><td class="p-2.5 font-bold">Judge Deliberation & Final Scoring</td><td class="p-2.5">Both Tracks<br><span class="text-[10px] text-gray-500">Breakout 3</span></td><td class="p-2.5 text-gray-700">All Judges</td></tr>`;
  html += `<tr class="bg-gray-50"><td class="p-2.5 whitespace-nowrap">6:30 PM - 9:00 PM</td><td class="p-2.5 font-bold">Awards & After Party</td><td class="p-2.5">Both Tracks<br><span class="text-[10px] text-gray-500">Main Stage</span></td><td class="p-2.5 text-gray-700">All Attendees</td></tr>`;
  
  tbody.innerHTML = html;
}
