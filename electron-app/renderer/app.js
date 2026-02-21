const api = window.electronAPI;
let sessions = [], repositories = [], selectedSessionId = null, currentRepoForWorktree = null, searchQuery = '';
let currentFilter = 'all'; // 'all', 'active', 'intervention'
let sessionStates = new Map(); // Track real-time session states for filtering
let sessionNames = {}; // Track custom session names
let currentEditSessionId = null; // Session being renamed

// Terminal state
let terminals = new Map(); // terminalId -> { term, fitAddon }
let activeTerminalId = null;
let terminalCounter = 0;
let embeddedTerminalAvailable = false;

let searchDebounce = null;
let currentDiffCwd = null;
let currentDiffMode = 'unstaged';
let currentDiffData = null;
let terminalsPerRow = 2;
let sessionViewMode = 'tile';
let maximizedTerminalId = null;
const terminalColors = {}; // termId -> color
let repoColors = {}; // repo path -> base color hex
const TERMINAL_PALETTE = ['#e94560','#4ade80','#60a5fa','#f59e0b','#a78bfa','#fb923c','#22d3ee','#f472b6','#34d399','#fbbf24'];

function hashColor(name) {
  // Use golden angle (137.508°) multiplied by a hash seed for maximum hue spread
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  // Golden angle ensures consecutive hashes spread across the hue wheel
  const hue = (Math.abs(hash) * 137.508) % 360;
  const sat = 65 + (Math.abs(hash >> 8) % 20); // 65-85%
  const lit = 55 + (Math.abs(hash >> 16) % 15); // 55-70%
  return `hsl(${Math.round(hue)}, ${sat}%, ${lit}%)`;
}

// Shade generation: derive lighter/darker variations of a base color for worktrees
function hexToHSL(hex) {
  let r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0, s = 0, l = (max+min)/2;
  if (d > 0) {
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    if (max === r) h = ((g-b)/d + (g<b?6:0));
    else if (max === g) h = ((b-r)/d + 2);
    else h = ((r-g)/d + 4);
    h *= 60;
  }
  return { h, s: s*100, l: l*100 };
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1-l);
  const f = n => { const k = (n + h/30) % 12; return l - a * Math.max(Math.min(k-3, 9-k, 1), -1); };
  const toHex = x => Math.round(x*255).toString(16).padStart(2,'0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
function parseColorToHSL(color) {
  if (color.startsWith('hsl')) {
    const m = color.match(/hsl\((\d+),\s*(\d+)%?,\s*(\d+)%?\)/);
    if (m) return { h: +m[1], s: +m[2], l: +m[3] };
  }
  return hexToHSL(color);
}
function getWorktreeShade(baseColor, worktreeIndex, totalWorktrees) {
  const { h, s, l } = parseColorToHSL(baseColor);
  if (totalWorktrees <= 1) return baseColor;
  const minL = Math.max(25, l - 20);
  const maxL = Math.min(80, l + 20);
  const step = (maxL - minL) / (totalWorktrees - 1);
  const newL = minL + step * worktreeIndex;
  return hslToHex(h, s, newL);
}

async function init() {
  // Check if embedded terminal is available
  embeddedTerminalAvailable = await api.terminalAvailable();
  if (!embeddedTerminalAvailable) {
    console.log('Embedded terminal not available - will use external terminals');
  }
  
  // Load saved filter first
  currentFilter = await api.getFilter() || 'all';
  updateFilterButtons();
  
  // Load session names
  sessionNames = await api.getAllSessionNames() || {};
  
  // Load repo colors
  repoColors = await api.getAllRepoColors() || {};
  
  // Load session view mode
  sessionViewMode = await api.getSessionViewMode() || 'tile';
  document.getElementById(sessionViewMode === 'list' ? 'viewListBtn' : 'viewTileBtn').classList.add('active');
  document.getElementById(sessionViewMode === 'list' ? 'viewTileBtn' : 'viewListBtn').classList.remove('active');
  
  // Load terminal-only mode
  terminalOnlyMode = await api.getTerminalOnlyMode() || false;
  if (terminalOnlyMode) applyTerminalOnlyMode();
  
  await loadData();
  api.onSessionsChanged(s => { sessions = s; render(); });
  api.onRepositoriesChanged(r => { repositories = r; renderSidebar(); });
  api.onSessionStateUpdate(updateSessionState);
  
  // Terminal events - batch writes to reduce render overhead
  const termDataBuffers = new Map(); // terminalId -> pending data
  let termFlushScheduled = false;
  api.onTerminalData(({ terminalId, data }) => {
    const existing = termDataBuffers.get(terminalId) || '';
    termDataBuffers.set(terminalId, existing + data);
    if (!termFlushScheduled) {
      termFlushScheduled = true;
      requestAnimationFrame(() => {
        for (const [tid, buf] of termDataBuffers) {
          const t = terminals.get(tid);
          if (t) t.term.write(buf);
        }
        termDataBuffers.clear();
        termFlushScheduled = false;
      });
    }
  });
  api.onTerminalExit(({ terminalId, exitCode }) => {
    console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
    closeTerminal(terminalId);
  });
  
  document.getElementById('refreshBtn').addEventListener('click', loadData);
  document.getElementById('addRepoBtn').addEventListener('click', addRepository);
  document.getElementById('closeActivityBtn').addEventListener('click', closeActivityPanel);
  document.getElementById('sidebarCollapseBtn').addEventListener('click', collapseSidebar);
  document.getElementById('sidebarToggle').addEventListener('click', expandSidebar);
  document.getElementById('cancelWorktreeBtn').addEventListener('click', () => document.getElementById('worktreeModal').classList.remove('show'));
  document.getElementById('createWorktreeBtn').addEventListener('click', createWorktree);
  document.getElementById('cancelRenameBtn').addEventListener('click', () => document.getElementById('renameModal').classList.remove('show'));
  document.getElementById('saveRenameBtn').addEventListener('click', saveSessionName);
  document.getElementById('sessionNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveSessionName(); if (e.key === 'Escape') document.getElementById('renameModal').classList.remove('show'); });
  document.getElementById('quickStartBtn').addEventListener('click', showMissionModal);
  document.getElementById('cancelMissionBtn').addEventListener('click', () => document.getElementById('missionModal').classList.remove('show'));
  document.getElementById('startMissionBtn').addEventListener('click', startMissionSession);
  
  // Terminal panel events
  document.getElementById('newTerminalBtn').addEventListener('click', () => showNewTerminalDialog());
  document.getElementById('closeTerminalPanelBtn').addEventListener('click', toggleTerminalPanel);
  document.getElementById('minimizeTerminalPanelBtn').addEventListener('click', () => {
    const panel = document.getElementById('terminalPanel');
    if (panel.classList.contains('panel-minimized')) restoreTerminalPanel();
    else minimizeTerminalPanel();
  });
  document.getElementById('terminalPanelMinimized').addEventListener('click', restoreTerminalPanel);
  document.getElementById('terminalsPerRow').addEventListener('change', e => {
    terminalsPerRow = parseInt(e.target.value) || 2;
    updateTerminalGrid();
    setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 100);
  });
  initSplitter();
  // Debounce renderSessions on search input (200ms) while deep search keeps its own debounce
  document.getElementById('searchInput').addEventListener('input', e => {
    const val = e.target.value;
    handleDeepSearch(val);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { searchQuery = val.toLowerCase(); renderSessions(); }, 200);
  });
  document.getElementById('statsBtn').addEventListener('click', toggleStatsPanel);
  document.getElementById('closeStatsBtn').addEventListener('click', () => document.getElementById('statsPanel').classList.remove('open'));
  document.getElementById('closeDiffBtn').addEventListener('click', () => document.getElementById('diffPanel').classList.remove('open'));
  // Diff mode buttons
  document.querySelectorAll('.diff-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diff-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDiffMode = btn.dataset.mode;
      if (currentDiffCwd) loadDiff(currentDiffCwd, currentDiffMode);
    });
  });
  // Close search results and color pickers when clicking outside
  document.addEventListener('click', e => {
    const panel = document.getElementById('searchResultsPanel');
    const input = document.getElementById('searchInput');
    if (!panel.contains(e.target) && e.target !== input) panel.classList.remove('open');
    // Close any open color pickers
    if (!e.target.closest('.term-color-btn') && !e.target.closest('.term-color-picker') && !e.target.closest('.repo-color-btn') && !e.target.closest('.repo-color-picker')) {
      document.querySelectorAll('.term-color-picker.open, .repo-color-picker.open').forEach(p => p.classList.remove('open'));
    }
  });
  // Setup filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      api.saveFilter(currentFilter); // Persist filter selection
      renderSessions();
    });
  });
  
  // Restore saved terminals from previous session
  if (embeddedTerminalAvailable) {
    const saved = await api.getSavedTerminals();
    if (saved && saved.length > 0) {
      for (const st of saved) {
        await openEmbeddedTerminal(st.cwd, st.sessionId, st.mission || null, st.color);
      }
      api.setSavedTerminals([]);
    }
  }
  // Responsive sidebar: auto-collapse below 650px window width
  const SIDEBAR_BREAKPOINT = 650;
  let sidebarAutoCollapsed = false;
  const resizeObserver = new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    const sidebar = document.getElementById('sidebar');
    const isCollapsed = sidebar.classList.contains('collapsed');
    if (width < SIDEBAR_BREAKPOINT && !isCollapsed) {
      collapseSidebar();
      sidebarAutoCollapsed = true;
    } else if (width >= SIDEBAR_BREAKPOINT && isCollapsed && sidebarAutoCollapsed) {
      expandSidebar();
      sidebarAutoCollapsed = false;
    }
  });
  resizeObserver.observe(document.querySelector('.app'));
}

function updateFilterButtons() {
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === currentFilter);
  });
}

async function loadData() {
  [sessions, repositories] = await Promise.all([api.getSessions(), api.getRepositories()]);
  render();
}

function render() { renderSidebar(); renderSessions(); updateStats(); }
function updateStats() {
  document.getElementById('totalSessions').textContent = sessions.length;
  // Count active sessions based on real-time states
  const activeCount = sessions.filter(s => {
    const state = sessionStates.get(s.id);
    if (state?.status) {
      const t = state.status.type;
      return t === 'thinking' || t === 'executingTool' || t === 'awaitingApproval';
    }
    return s.isActive;
  }).length;
  document.getElementById('activeSessions').textContent = activeCount;
  document.getElementById('repoCount').textContent = repositories.length;
}

function renderSidebar() {
  const el = document.getElementById('repoList');
  if (!repositories.length) { el.innerHTML = '<div style="text-align:center;padding:24px;color:#666"><p>No repos</p><p style="font-size:11px;margin-top:8px">Click "Add Repo"</p></div>'; return; }
  el.innerHTML = repositories.map(r => {
    const repoName = r.path.split(/[/\\]/).pop();
    const repoColor = repoColors[r.path] || hashColor(repoName);
    const borderStyle = ` style="border-left: 4px solid ${repoColor}"`;
    return `
    <div class="repo-item"${borderStyle}>
      <div class="repo-header ${r.isExpanded?'expanded':''}" onclick="toggleRepo('${escJs(r.path)}')">
        <span class="chevron">▶</span><span class="repo-name">📁 ${esc(repoName)}</span>
        <div class="repo-actions" onclick="event.stopPropagation()">
          <button onclick="showCreateWorktree('${escJs(r.path)}')" title="New Worktree" aria-label="New Worktree">🌿</button>
          ${repositories.length > 1 ? `<button onclick="removeRepo('${escJs(r.path)}')" title="Remove Repository" aria-label="Remove Repository">✕</button>` : ''}
        </div>
      </div>
      ${r.isExpanded ? `<div class="worktree-list">${r.worktrees.map((w, wi) => {
        const shade = getWorktreeShade(repoColor, wi, r.worktrees.length);
        const wtBorder = `border-left: 4px solid ${shade};`;
        return `
        <div class="worktree-item" style="${wtBorder}">
          <div class="worktree-header"><span>${w.isWorktree?'🌿':'📂'}</span><span class="worktree-branch">${esc(w.name)}</span><span style="color:#888;font-size:10px">(${w.sessions.length})</span></div>
          <div class="worktree-path">${esc(w.path)}</div>
          <div class="worktree-actions">
            <button onclick="openTerm('${escJs(w.path)}')" title="New Session" aria-label="New Session">▶ New</button>
            <button onclick="api.openFolder('${escJs(w.path)}')" title="Open Folder" aria-label="Open Folder">📂</button>
            ${w.isWorktree?`<button onclick="delWorktree('${escJs(r.path)}','${escJs(w.path)}')" title="Delete Worktree" aria-label="Delete Worktree" style="color:#e94560">🗑</button>`:''}
          </div>
        </div>`}).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function setSessionViewMode(mode) {
  sessionViewMode = mode;
  document.getElementById('viewTileBtn').classList.toggle('active', mode === 'tile');
  document.getElementById('viewListBtn').classList.toggle('active', mode === 'list');
  api.setSessionViewMode(mode);
  renderSessions();
}

function renderSessions() {
  const el = document.getElementById('content');
  // Apply search filter (include custom session names)
  let f = searchQuery ? sessions.filter(s => ((s.summary||'')+(s.firstMessage||'')+s.branchName+s.id+(sessionNames[s.id]||'')).toLowerCase().includes(searchQuery)) : sessions;
  // Apply status filter
  if (currentFilter === 'active') {
    f = f.filter(s => {
      const state = sessionStates.get(s.id);
      if (state?.status) {
        const t = state.status.type;
        return t === 'thinking' || t === 'executingTool' || t === 'awaitingApproval';
      }
      return s.isActive;
    });
  } else if (currentFilter === 'intervention') {
    f = f.filter(s => {
      const state = sessionStates.get(s.id);
      if (state?.status) {
        const t = state.status.type;
        return t === 'waitingForUser' || t === 'awaitingApproval';
      }
      return false;
    });
  }
  if (!f.length) { el.innerHTML = `<div class="empty-state"><h2>${searchQuery || currentFilter !== 'all' ?'No matches':'No Sessions'}</h2><p style="color:#666;margin-top:8px">${currentFilter === 'active' ? 'No active sessions found' : currentFilter === 'intervention' ? 'No sessions need input' : ''}</p></div>`; return; }
  
  if (sessionViewMode === 'list') {
    el.innerHTML = `<div class="sessions-list">${f.map(s => {
      const state = sessionStates.get(s.id);
      const status = state?.status || (s.isActive ? { type: 'executingTool' } : { type: 'idle' });
      const statusText = getStatusText(status);
      const statusClass = getStatusClass(status);
      const customName = sessionNames[s.id];
      const displayName = customName || s.id.slice(0,8) + '...';
      return `
      <div class="session-list-row" data-session-id="${s.id}">
        <span class="session-status ${statusClass}" style="font-size:10px;">${statusText}</span>
        <span class="session-list-name" title="${esc(s.summary||s.firstMessage||'')}">${esc(displayName)}</span>
        <span class="session-list-meta"><span class="branch-badge">${esc(s.branchName)}</span><span>📝 ${s.messageCount}</span><span>⏱️ ${timeAgo(new Date(s.lastActivityAt))}</span></span>
        <span class="session-list-actions">
          <button onclick="viewActivity('${s.id}')" title="Activity">📊</button>
          <button onclick="resumeSess('${s.id}','${escJs(s.projectPath)}')" title="Resume">▶</button>
        </span>
      </div>`;
    }).join('')}</div>`;
  } else {
    el.innerHTML = `<div class="sessions-grid">${f.map(s => {
      const state = sessionStates.get(s.id);
      const status = state?.status || (s.isActive ? { type: 'executingTool' } : { type: 'idle' });
      const statusText = getStatusText(status);
      const statusClass = getStatusClass(status);
      const customName = sessionNames[s.id];
      const displayName = customName || s.id.slice(0,8) + '...';
      return `
      <div class="session-card ${s.isActive?'active':''}" data-session-id="${s.id}">
        <div class="session-header">
          <span class="session-name-container">
            <span class="session-name ${customName ? 'has-name' : ''}" title="Click to rename">${esc(displayName)}</span>
            <button class="edit-name-btn" onclick="event.stopPropagation(); editSessionName('${s.id}', '${esc(customName || '')}')" title="Rename session">✏️</button>
          </span>
          <span class="session-status ${statusClass}">${statusText}</span>
        </div>
        ${customName ? `<div class="session-id-row">ID: ${s.id.slice(0,8)}...</div>` : ''}
        <div class="session-summary">${esc(s.summary||s.firstMessage||'No summary')}</div>
        <div class="session-meta"><span class="branch-badge">${esc(s.branchName)}</span><span>📝 ${s.messageCount}</span><span>⏱️ ${timeAgo(new Date(s.lastActivityAt))}</span></div>
        ${renderContextBar(s.id)}
        <div id="code-changes-${s.id}" class="code-changes" style="display:none;"></div>
        <div class="session-actions"><button onclick="viewActivity('${s.id}')">📊 Activity</button><button onclick="viewDiff('${escJs(s.projectPath)}')">📝 Changes</button><button onclick="resumeSess('${s.id}','${escJs(s.projectPath)}')">▶ Resume</button></div>
      </div>`;
    }).join('')}</div>`;
  }
}

function getStatusText(status) {
  if (!status) return 'Idle';
  switch (status.type) {
    case 'thinking': return 'Thinking...';
    case 'executingTool': return `Running: ${status.name || 'tool'}`;
    case 'awaitingApproval': return `Awaiting: ${status.tool || 'approval'}`;
    case 'waitingForUser': return 'Waiting for Input';
    default: return 'Idle';
  }
}

function getStatusClass(status) {
  if (!status) return 'status-idle';
  switch (status.type) {
    case 'thinking': return 'status-thinking';
    case 'executingTool': return 'status-executing';
    case 'awaitingApproval': return 'status-awaiting';
    case 'waitingForUser': return 'status-waiting';
    default: return 'status-idle';
  }
}

// Throttle renderSessions calls from state updates
let renderSessionsTimer = null;
function throttledRenderSessions() {
  if (!renderSessionsTimer) {
    renderSessionsTimer = setTimeout(() => { renderSessionsTimer = null; renderSessions(); }, 1000);
  }
}

function updateSessionState(u) {
  // Store state for filtering
  if (u.state?.status) {
    sessionStates.set(u.sessionId, u.state);
  }
  const card = document.querySelector(`[data-session-id="${u.sessionId}"]`);
  if (!card || !u.state?.status) return;
  const st = card.querySelector('.session-status'), {type} = u.state.status;
  let txt = getStatusText(u.state.status), cls = getStatusClass(u.state.status);
  st.textContent = txt; st.className = `session-status ${cls}`;
  if (selectedSessionId === u.sessionId) {
    if (u.state.recentActivities) renderActivities(u.state.recentActivities);
    if (u.state.pendingQuestion) renderPendingQuestion(u.state.pendingQuestion, u.sessionId);
    else hidePendingQuestion();
  }
  // Re-render if filter might exclude/include this session (throttled)
  if (currentFilter !== 'all') throttledRenderSessions();
}

async function addRepository() { await api.addRepository(); await loadData(); }
async function removeRepo(p) { if (confirm(`Remove?\n${p}`)) { await api.removeRepository(p); await loadData(); } }
function toggleRepo(p) { const r = repositories.find(x => x.path === p); if (r) { r.isExpanded = !r.isExpanded; renderSidebar(); } }
function collapseAllRepos() { repositories.forEach(r => r.isExpanded = false); renderSidebar(); }
async function openTerm(dir, branch, mission) { 
  if (embeddedTerminalAvailable) {
    // Use embedded terminal
    await openEmbeddedTerminal(dir, null, mission);
  } else {
    // Fall back to external terminal
    const r = await api.openTerminal(dir, branch, mission);
    if (!r.success) alert('Error: ' + r.error);
  }
}
async function resumeSess(id, dir) { 
  if (embeddedTerminalAvailable) {
    // Use embedded terminal for resuming sessions
    await openEmbeddedTerminal(dir, id, null);
  } else {
    // Fall back to external terminal
    const r = await api.resumeSessionTerminal(id, dir);
    if (!r.success) alert('Error: ' + r.error);
  }
}

// Session Naming
function editSessionName(sessionId, currentName) {
  currentEditSessionId = sessionId;
  document.getElementById('sessionNameInput').value = currentName;
  document.getElementById('renameModal').classList.add('show');
  setTimeout(() => document.getElementById('sessionNameInput').focus(), 100);
}
async function saveSessionName() {
  if (!currentEditSessionId) return;
  const name = document.getElementById('sessionNameInput').value.trim();
  await api.setSessionName(currentEditSessionId, name);
  sessionNames = await api.getAllSessionNames() || {};
  document.getElementById('renameModal').classList.remove('show');
  currentEditSessionId = null;
  renderSessions();
}

// Quick Start with Mission
function showMissionModal() {
  // Populate working directories from repositories and their worktrees
  const select = document.getElementById('missionWorkDir');
  const options = [];
  repositories.forEach(r => {
    r.worktrees.forEach(w => {
      options.push({ path: w.path, label: `${r.path.split(/[/\\]/).pop()} / ${w.name}` });
    });
  });
  if (options.length === 0) {
    alert('Please add a repository first');
    return;
  }
  select.innerHTML = options.map(o => `<option value="${esc(o.path)}">${esc(o.label)}</option>`).join('');
  document.getElementById('missionText').value = '';
  document.getElementById('missionModal').classList.add('show');
  document.getElementById('missionText').focus();
}

async function startMissionSession() {
  const mission = document.getElementById('missionText').value.trim();
  const workDir = document.getElementById('missionWorkDir').value;
  if (!workDir) { alert('Please select a working directory'); return; }
  document.getElementById('missionModal').classList.remove('show');
  await openTerm(workDir, null, mission || undefined);
}
async function showCreateWorktree(p) {
  currentRepoForWorktree = p;
  const branches = await api.getBranches(p);
  document.getElementById('baseBranch').innerHTML = branches.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  document.getElementById('newBranchName').value = '';
  document.getElementById('worktreeModal').classList.add('show');
}
async function createWorktree() {
  const name = document.getElementById('newBranchName').value.trim(), base = document.getElementById('baseBranch').value;
  if (!name) { alert('Enter branch name'); return; }
  const r = await api.createWorktree(currentRepoForWorktree, name, base);
  if (r.success) { document.getElementById('worktreeModal').classList.remove('show'); await loadData(); } else alert('Error: ' + r.error);
}
async function delWorktree(repo, wt) { if (confirm(`Delete worktree?\n${wt}`)) { await api.deleteWorktree(repo, wt); await loadData(); } }
async function viewActivity(id) {
  selectedSessionId = id; await api.startMonitoring(id);
  const s = await api.getSessionState(id);
  if (s?.recentActivities) renderActivities(s.recentActivities);
  document.getElementById('activityPanel').classList.add('open');
}
function renderActivities(a) {
  document.getElementById('activityList').innerHTML = a.slice(-25).reverse().map(x => `
    <div class="activity-item"><div class="activity-type">${x.activityType.type}${x.activityType.name?': '+esc(x.activityType.name):''}</div>
    <div>${renderMarkdown(x.description)}</div><div class="activity-time">${new Date(x.timestamp).toLocaleTimeString()}</div></div>`).join('');
}

function renderPendingQuestion(q, sessionId) {
  const container = document.getElementById('pendingQuestionContainer');
  if (!container || !q) return;
  const session = sessions.find(s => s.id === sessionId);
  const workingDir = session?.projectPath || '';
  
  let choicesHtml = '';
  if (q.choices && q.choices.length > 0) {
    choicesHtml = `<div class="question-choices">${q.choices.map((c, i) => 
      `<button class="choice-btn" onclick="selectChoice('${sessionId}', '${escJs(c)}', '${escJs(workingDir)}')">${i+1}. ${esc(c)}</button>`
    ).join('')}</div>`;
  }
  
  container.innerHTML = `
    <div class="pending-question">
      <div class="question-header">⚠️ Input Required</div>
      <div class="question-text">${esc(q.question)}</div>
      ${choicesHtml}
      <div class="question-hint">Click an option or respond in terminal</div>
      <button class="focus-terminal-btn" onclick="focusTerminal('${sessionId}', '${escJs(workingDir)}')">📺 Open Terminal</button>
    </div>`;
  container.style.display = 'block';
}

function hidePendingQuestion() {
  const container = document.getElementById('pendingQuestionContainer');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
}

async function selectChoice(sessionId, choice, workingDir) {
  if (embeddedTerminalAvailable) {
    // Open embedded terminal and send the choice
    const termId = await openEmbeddedTerminal(workingDir, sessionId);
    // Wait a moment for terminal to connect, then send the choice
    setTimeout(() => {
      const choiceNum = parseInt(choice);
      if (!isNaN(choiceNum)) {
        api.terminalWrite(termId, `${choiceNum}\r`);
      } else {
        api.terminalWrite(termId, `${choice}\r`);
      }
    }, 1000);
  } else {
    // Fall back to external terminal
    await api.resumeSessionTerminal(sessionId, workingDir);
    alert(`Selected: "${choice}"\n\nPlease enter your choice in the terminal window.`);
  }
}

async function focusTerminal(sessionId, workingDir) {
  if (embeddedTerminalAvailable) {
    await openEmbeddedTerminal(workingDir, sessionId);
  } else {
    await api.resumeSessionTerminal(sessionId, workingDir);
  }
}

// === Sidebar Collapse/Expand ===

function collapseSidebar() {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebarToggle').classList.remove('hidden');
}

function expandSidebar() {
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('sidebarToggle').classList.add('hidden');
}

// === Embedded Terminal Functions (Grid View) ===

function toggleTerminalPanel() {
  const panel = document.getElementById('terminalPanel');
  const splitter = document.getElementById('contentSplitter');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    panel.classList.remove('panel-minimized');
    splitter.style.display = 'none';
    document.getElementById('content').style.flex = '';
    // Exit terminal-only mode so sessions remain visible
    if (terminalOnlyMode) {
      terminalOnlyMode = false;
      applyTerminalOnlyMode();
      api.setTerminalOnlyMode(false);
    }
  } else {
    showTerminalPanel();
  }
}

function showTerminalPanel() {
  const panel = document.getElementById('terminalPanel');
  const main = document.getElementById('content');
  const splitter = document.getElementById('contentSplitter');
  panel.classList.add('open');
  panel.classList.remove('panel-minimized');
  splitter.style.display = 'block';
  // Split space: sessions get 40%, terminals 60%
  main.style.flex = '0 0 40%';
  panel.style.flex = '1 1 60%';
  updateTerminalGrid();
  setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 100);
}

function hideTerminalPanel() {
  const panel = document.getElementById('terminalPanel');
  const splitter = document.getElementById('contentSplitter');
  panel.classList.remove('open');
  panel.classList.remove('panel-minimized');
  splitter.style.display = 'none';
  document.getElementById('content').style.flex = '';
  // Exit terminal-only mode so sessions remain visible
  if (terminalOnlyMode) {
    terminalOnlyMode = false;
    applyTerminalOnlyMode();
    api.setTerminalOnlyMode(false);
  }
}

function minimizeTerminalPanel() {
  const panel = document.getElementById('terminalPanel');
  const splitter = document.getElementById('contentSplitter');
  panel.classList.add('panel-minimized');
  splitter.style.display = 'none';
  document.getElementById('content').style.flex = '';
  const count = terminals.size;
  document.getElementById('terminalCountMin').textContent = count > 0 ? `(${count} open)` : '';
}

function restoreTerminalPanel() {
  const panel = document.getElementById('terminalPanel');
  panel.classList.remove('panel-minimized');
  // If not in terminal-only mode, restore the splitter and session flex
  if (!terminalOnlyMode) {
    document.getElementById('contentSplitter').style.display = 'block';
    document.getElementById('content').style.flex = '0 0 40%';
    panel.style.flex = '1 1 60%';
  }
  updateTerminalGrid();
  setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 100);
}

function initSplitter() {
  const splitter = document.getElementById('contentSplitter');
  const main = document.getElementById('content');
  const panel = document.getElementById('terminalPanel');
  const container = document.querySelector('.main-content');
  let dragging = false;
  let rafPending = false;
  
  splitter.addEventListener('mousedown', e => {
    dragging = true;
    splitter.classList.add('dragging');
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', e => {
    if (!dragging || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const rect = container.getBoundingClientRect();
      // Subtract header height
      const headerH = container.querySelector('header').getBoundingClientRect().height;
      const available = rect.height - headerH - 6; // 6px splitter
      const mouseY = e.clientY - rect.top - headerH;
      const pct = Math.max(10, Math.min(90, (mouseY / available) * 100));
      main.style.flex = `0 0 ${pct}%`;
      panel.style.flex = `1 1 ${100 - pct}%`;
    });
  });
  
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      splitter.classList.remove('dragging');
      setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 50);
    }
  });
}

function updateTerminalGrid() {
  const container = document.getElementById('terminalContainer');
  const count = terminals.size;
  // Use fewer columns than the setting when there are fewer terminals,
  // so a single terminal fills the full width.
  const cols = Math.min(count || 1, terminalsPerRow);
  const rows = Math.max(1, Math.ceil(count / cols));
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  // Update count labels
  const countEl = document.getElementById('terminalCount');
  if (countEl) countEl.textContent = count > 0 ? `(${count})` : '';
  const countMin = document.getElementById('terminalCountMin');
  if (countMin) countMin.textContent = count > 0 ? `(${count} open)` : '';
}

async function openEmbeddedTerminal(cwd, sessionId = null, mission = null, initialColor = null, blank = false) {
  // Duplicate detection: flash existing terminal instead of opening a new one
  // Skip for blank terminals — allow multiple blank terminals
  if (!blank) {
    for (const [tid, t] of terminals) {
      if ((sessionId && t.sessionId === sessionId) || (!sessionId && !t.sessionId && t.cwd === cwd)) {
        showTerminalPanel();
        const wrapper = document.getElementById(`terminal-${tid}`);
        if (wrapper) {
          wrapper.classList.remove('flash');
          void wrapper.offsetWidth;
          wrapper.classList.add('flash');
          wrapper.addEventListener('animationend', () => wrapper.classList.remove('flash'), { once: true });
        }
        t.term.focus();
        return tid;
      }
    }
  }
  
  const termId = `term-${++terminalCounter}`;
  if (blank) {
    await api.terminalCreateBlank(termId, cwd);
  } else {
    await api.terminalCreate(termId, cwd, sessionId, mission);
  }
  
  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e94560', selection: 'rgba(233, 69, 96, 0.3)' },
    fastScrollModifier: 'alt',
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  
  // Build label with session name + folder + full session ID
  const folderName = cwd.split(/[/\\]/).pop();
  const sessName = sessionId ? (sessionNames[sessionId] || null) : null;
  const nameHtml = sessName ? `<span class="term-session-name">${esc(sessName)}</span>` : '';
  const sessionLabel = sessionId ? `<span class="term-session-id" title="Click to copy: ${esc(sessionId)}" onclick="event.stopPropagation(); navigator.clipboard.writeText('${escJs(sessionId)}')">${esc(sessionId)}</span>` : '';
  const folderHtml = `<span style="color:#8b949e">${esc(folderName)}</span>`;
  
  // Color picker
  const colorPickerHtml = `<div class="term-color-picker" id="colorPicker-${termId}">${TERMINAL_PALETTE.map(c => `<div class="term-color-swatch" style="background:${c}" onclick="event.stopPropagation(); setTermColor('${termId}','${c}')"></div>`).join('')}</div>`;
  let color = initialColor || (sessionId ? (await api.getTerminalColor(sessionId)) : null);
  
  // Auto-derive color from repo color scheme if no explicit color
  if (!color) {
    const normCwd = cwd.replace(/\\/g, '/').toLowerCase();
    let bestMatch = null;
    let bestLen = 0;
    // Find the most specific (longest path) matching repo/worktree
    for (const r of repositories) {
      const repoName = r.path.split(/[/\\]/).pop();
      const baseColor = repoColors[r.path] || hashColor(repoName);
      for (let wi = 0; wi < r.worktrees.length; wi++) {
        const normWt = r.worktrees[wi].path.replace(/\\/g, '/').toLowerCase();
        if ((normCwd === normWt || normCwd.startsWith(normWt + '/')) && normWt.length > bestLen) {
          bestLen = normWt.length;
          bestMatch = { baseColor, wi, total: r.worktrees.length };
        }
      }
    }
    if (bestMatch) {
      color = getWorktreeShade(bestMatch.baseColor, bestMatch.wi, bestMatch.total);
    }
  }
  // Fallback: hash the folder name
  if (!color) color = hashColor(folderName);
  
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-instance';
  wrapper.id = `terminal-${termId}`;
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  
  const header = document.createElement('div');
  header.className = 'terminal-instance-header';
  header.style.position = 'relative';
  if (color) header.style.borderBottom = `4px solid ${color}`;
  
  // Custom terminal name (editable memo)
  const customNameId = `termName-${termId}`;
  const nameDisplayHtml = `<span class="term-custom-name" id="${customNameId}" onclick="event.stopPropagation(); editTermName('${termId}')" title="Click to add memo"></span><button class="term-add-name" onclick="event.stopPropagation(); editTermName('${termId}')" title="Add memo">✏</button>`;
  
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;position:relative;">
      <button class="term-color-btn" style="background:${color || '#8b949e'}" onclick="event.stopPropagation(); toggleColorPicker('${termId}')" title="Change color"></button>
      ${colorPickerHtml}
      <button class="terminal-instance-minimize" onclick="toggleMinimizeTerminal('${termId}')" title="Minimize">&#x25BC;</button>
      <button class="terminal-instance-maximize" onclick="toggleMaximizeTerminal('${termId}')" title="Maximize">&#x26F6;</button>
    </div>
    <span class="terminal-instance-label" title="${esc(cwd)}">${nameHtml}${nameDisplayHtml}${folderHtml} ${sessionLabel}</span>
    <div style="display:flex;align-items:center;margin-left:20px;">
      <button class="terminal-instance-close" onclick="closeTerminal('${termId}')" title="Close">&#x2715;</button>
    </div>`;
  wrapper.appendChild(header);
  
  const termArea = document.createElement('div');
  termArea.style.cssText = 'flex:1;overflow:hidden;';
  wrapper.appendChild(termArea);
  
  document.getElementById('terminalContainer').appendChild(wrapper);
  term.open(termArea);
  // Load WebGL renderer AFTER open() for GPU-accelerated rendering
  try {
    if (typeof WebglAddon !== 'undefined') {
      const wgl = new WebglAddon.WebglAddon();
      wgl.onContextLost(() => { wgl.dispose(); });
      term.loadAddon(wgl);
    }
  } catch (e) { console.warn('WebGL addon failed, using DOM renderer:', e); }
  fitAddon.fit();
  
  term.onData(data => api.terminalWrite(termId, data));
  term.onResize(({ cols, rows }) => api.terminalResize(termId, cols, rows));
  
  // Copy via Ctrl+C — copy selection if present, otherwise send interrupt
  // Paste via Ctrl+V — check for image first, then text
  term.attachCustomKeyEventHandler(e => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'c') {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true; // No selection — send interrupt (\x03) to terminal
    }
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
      e.preventDefault(); // Prevent browser native paste (which would cause double paste)
      (async () => {
        // Try clipboard image first
        const imgPath = await api.saveClipboardImage();
        if (imgPath) {
          api.terminalWrite(termId, `@${imgPath} `);
        } else {
          // Fall back to text paste
          const text = await navigator.clipboard.readText().catch(() => '');
          if (text) api.terminalWrite(termId, text);
        }
      })();
      return false;
    }
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      api.openFolder(cwd);
      return false;
    }
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'f') {
      return false; // Let document handler open terminal search
    }
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'm') {
      return false; // Let document handler toggle maximize
    }
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'n') {
      return false; // Let document handler open blank terminal
    }
    if (e.type === 'keydown' && (e.key === 'F1' || (e.shiftKey && e.key === '?'))) {
      return false; // Let document handler open shortcuts help
    }
    if (e.type === 'keydown' && e.key === 'F2') {
      return false; // Let document handler rename terminal
    }
    return true;
  });
  
  // Track focused terminal
  term.textarea.addEventListener('focus', () => { activeTerminalId = termId; });
  
  terminals.set(termId, { term, fitAddon, cwd, sessionId, color });
  if (color) terminalColors[termId] = color;

  // On first terminal, auto-switch to terminal-only mode so the sessions
  // panel collapses and terminals fill the available space.
  if (terminals.size === 1 && !terminalOnlyMode) {
    terminalOnlyMode = true;
    applyTerminalOnlyMode();
    api.setTerminalOnlyMode(true);
  }

  showTerminalPanel();
  updateTerminalGrid();
  setTimeout(() => { fitAddon.fit(); term.focus(); }, 150);
  return termId;
}

function toggleColorPicker(termId) {
  document.querySelectorAll('.term-color-picker.open').forEach(p => p.classList.remove('open'));
  const picker = document.getElementById(`colorPicker-${termId}`);
  if (!picker) return;
  // Position relative to the color button
  const btn = picker.previousElementSibling || picker.parentElement.querySelector('.term-color-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.left = rect.left + 'px';
  }
  picker.classList.toggle('open');
}

function setTermColor(termId, color) {
  const t = terminals.get(termId);
  if (!t) return;
  t.color = color;
  terminalColors[termId] = color;
  const wrapper = document.getElementById(`terminal-${termId}`);
  if (wrapper) {
    const header = wrapper.querySelector('.terminal-instance-header');
    if (header) header.style.borderBottom = `4px solid ${color}`;
    const btn = wrapper.querySelector('.term-color-btn');
    if (btn) btn.style.background = color;
  }
  if (t.sessionId) api.setTerminalColor(t.sessionId, color);
  const picker = document.getElementById(`colorPicker-${termId}`);
  if (picker) picker.classList.remove('open');
}

function toggleRepoColorPicker(repoPath) {
  document.querySelectorAll('.repo-color-picker.open').forEach(p => p.classList.remove('open'));
  const picker = document.getElementById(`repoColorPicker-${repoPath}`);
  if (!picker) return;
  const btn = picker.parentElement.querySelector('.repo-color-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.left = rect.right + 'px';
  }
  picker.classList.toggle('open');
}

function setRepoColor(repoPath, color) {
  repoColors[repoPath] = color;
  api.setRepoColor(repoPath, color);
  document.querySelectorAll('.repo-color-picker.open').forEach(p => p.classList.remove('open'));
  renderSidebar();
}

function editTermName(termId) {
  const el = document.getElementById(`termName-${termId}`);
  if (!el) return;
  const current = el.textContent || '';
  const input = document.createElement('input');
  input.className = 'term-name-input';
  input.value = current;
  input.placeholder = 'memo...';
  el.replaceWith(input);
  input.focus();
  input.select();
  const save = () => {
    const val = input.value.trim();
    const span = document.createElement('span');
    span.className = 'term-custom-name';
    span.id = `termName-${termId}`;
    span.textContent = val || '';
    span.title = 'Click to edit memo';
    span.onclick = (e) => { e.stopPropagation(); editTermName(termId); };
    input.replaceWith(span);
    const t = terminals.get(termId);
    if (t) t.customName = val;
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = current; input.blur(); } });
}

function toggleMaximizeTerminal(termId) {
  const wrapper = document.getElementById(`terminal-${termId}`);
  if (!wrapper) return;
  const t = terminals.get(termId);
  const btn = wrapper.querySelector('.terminal-instance-maximize');
  
  if (maximizedTerminalId === termId) {
    wrapper.classList.remove('maximized');
    maximizedTerminalId = null;
    if (btn) btn.textContent = '\u26F6';
    if (t) setTimeout(() => t.fitAddon.fit(), 50);
  } else {
    if (maximizedTerminalId) {
      const prev = document.getElementById(`terminal-${maximizedTerminalId}`);
      if (prev) {
        prev.classList.remove('maximized');
        const prevBtn = prev.querySelector('.terminal-instance-maximize');
        if (prevBtn) prevBtn.textContent = '\u26F6';
      }
    }
    wrapper.classList.add('maximized');
    maximizedTerminalId = termId;
    if (btn) btn.textContent = '\u25F1';
    if (t) setTimeout(() => { t.fitAddon.fit(); t.term.focus(); }, 50);
  }
}

function toggleMinimizeTerminal(termId) {
  const wrapper = document.getElementById(`terminal-${termId}`);
  if (!wrapper) return;
  const t = terminals.get(termId);
  if (wrapper.classList.contains('minimized')) {
    wrapper.classList.remove('minimized');
    wrapper.querySelector('.terminal-instance-minimize').textContent = '▼';
    if (t) setTimeout(() => t.fitAddon.fit(), 50);
  } else {
    wrapper.classList.add('minimized');
    wrapper.querySelector('.terminal-instance-minimize').textContent = '▲';
  }
}

// Legacy - no longer used but kept for compatibility
function addTerminalTab(termId, label) {}
function activateTerminal(termId) {
  const t = terminals.get(termId);
  if (t) {
    setTimeout(() => {
      t.fitAddon.fit();
      t.term.focus();
    }, 50);
  }
}

function closeTerminal(termId) {
  // Clean up maximized state
  if (maximizedTerminalId === termId) maximizedTerminalId = null;
  
  const t = terminals.get(termId);
  if (t) {
    t.term.dispose();
    api.terminalDestroy(termId);
    terminals.delete(termId);
  }
  delete terminalColors[termId];
  
  const container = document.getElementById(`terminal-${termId}`);
  if (container) container.remove();
  
  updateTerminalGrid();
  
  if (terminals.size === 0) {
    activeTerminalId = null;
    hideTerminalPanel();
  } else {
    setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 100);
  }
}

function showNewTerminalDialog() {
  // Use the first available working directory
  let defaultCwd = '';
  if (repositories.length > 0) {
    defaultCwd = repositories[0].path;
    if (repositories[0].worktrees?.length > 0) {
      defaultCwd = repositories[0].worktrees[0].path;
    }
  }
  
  if (defaultCwd) {
    openEmbeddedTerminal(defaultCwd);
  } else {
    alert('Please add a repository first');
  }
}

async function openBlankTerminal() {
  const userHome = await api.getHomeDir();
  const cwd = userHome || (repositories.length > 0 ? repositories[0].path : '');
  
  if (cwd) {
    openEmbeddedTerminal(cwd, null, null, null, true);
  } else {
    alert('Please add a repository first');
  }
}

// Window resize handler — throttled to 100ms
let _resizeTimer = null;
window.addEventListener('resize', () => {
  if (!document.getElementById('terminalPanel').classList.contains('open')) return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 100);
});
function closeActivityPanel() { document.getElementById('activityPanel').classList.remove('open'); if (selectedSessionId) { api.stopMonitoring(selectedSessionId); selectedSessionId = null; } }
function timeAgo(d) { const s = Math.floor((Date.now()-d.getTime())/1000); return s<60?'now':s<3600?`${Math.floor(s/60)}m`:s<86400?`${Math.floor(s/3600)}h`:`${Math.floor(s/86400)}d`; }
function esc(s) { return s ? s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : ''; }
function escJs(s) { return s ? s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"') : ''; }

// === MARKDOWN RENDERING ===
function renderMarkdown(text) {
  if (!text) return '';
  let s = esc(text);
  // Code blocks (```...```)
  s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code (`...`)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold (**...**)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic (*...*)
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Line breaks
  s = s.replace(/\n/g, '<br>');
  return `<span class="md-content">${s}</span>`;
}

// === CONTEXT WINDOW BAR ===
function renderContextBar(sessionId) {
  const state = sessionStates.get(sessionId);
  if (!state || !state.totalOutputTokens) return '';
  const totalTokens = (state.inputTokens || 0) + (state.totalOutputTokens || 0);
  const maxContext = 200000; // Default context window estimate
  const pct = Math.min(100, (totalTokens / maxContext) * 100);
  const colorClass = pct > 90 ? 'red' : pct > 75 ? 'orange' : 'green';
  const label = formatTokens(totalTokens) + ' / ' + formatTokens(maxContext) + ' (~' + Math.round(pct) + '%)';
  return `<div class="context-bar"><div class="context-bar-fill ${colorClass}" style="width:${pct}%"></div></div><div class="context-bar-label">${label}</div>`;
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// === STATS PANEL ===
async function toggleStatsPanel() {
  const panel = document.getElementById('statsPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) {
    await refreshStats();
  }
}

async function refreshStats() {
  const stats = await api.getGlobalStats();
  if (!stats) return;
  const el = document.getElementById('statsContent');
  
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  
  let modelHtml = '';
  if (stats.modelBreakdown) {
    const models = Object.entries(stats.modelBreakdown);
    if (models.length > 0) {
      modelHtml = '<h3 style="font-size:13px;color:#ccc;margin:16px 0 8px;">By Model</h3>' +
        models.map(([name, m]) => `
          <div class="model-row">
            <span class="model-name">${esc(name)}</span>
            <span class="model-tokens">${formatTokens(m.inputTokens + m.outputTokens)} tokens</span>
            <span class="model-cost">$${m.cost.toFixed(2)}</span>
          </div>`).join('');
    }
  }
  
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card"><div class="value">${formatTokens(totalTokens)}</div><div class="label">Total Tokens</div></div>
      <div class="stats-card"><div class="value">$${stats.estimatedCostUsd.toFixed(2)}</div><div class="label">Est. Cost</div></div>
      <div class="stats-card"><div class="value">${stats.sessionCount}</div><div class="label">Sessions</div></div>
      <div class="stats-card"><div class="value">${stats.totalMessages}</div><div class="label">Messages</div></div>
      <div class="stats-card"><div class="value">${formatTokens(stats.totalInputTokens)}</div><div class="label">Input Tokens</div></div>
      <div class="stats-card"><div class="value">${formatTokens(stats.totalOutputTokens)}</div><div class="label">Output Tokens</div></div>
      <div class="stats-card"><div class="value">${formatTokens(stats.totalCacheReadTokens)}</div><div class="label">Cache Read</div></div>
      <div class="stats-card"><div class="value">${formatTokens(stats.totalCacheCreationTokens)}</div><div class="label">Cache Created</div></div>
    </div>
    ${modelHtml}
  `;
}

// === DIFF VIEW ===
async function viewDiff(cwd) {
  currentDiffCwd = cwd;
  currentDiffMode = 'unstaged';
  document.querySelectorAll('.diff-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'unstaged'));
  document.getElementById('diffPanel').classList.add('open');
  await loadDiff(cwd, 'unstaged');
}

async function loadDiff(cwd, mode) {
  const diff = await api.getDiff(cwd, mode);
  currentDiffData = diff;
  
  // Render file list
  const fileListEl = document.getElementById('diffFileList');
  if (!diff.files || diff.files.length === 0) {
    fileListEl.innerHTML = '<div style="padding:16px;color:#666;font-size:12px;text-align:center;">No changes found</div>';
    document.getElementById('diffContent').innerHTML = '<div style="padding:24px;color:#666;text-align:center;">No changes to display</div>';
    document.getElementById('diffSummary').textContent = '';
    return;
  }
  
  fileListEl.innerHTML = diff.files.map((f, i) => `
    <div class="diff-file-item ${i===0?'selected':''}" onclick="selectDiffFile(${i})">
      <span class="diff-file-name" title="${esc(f.path)}">${statusIcon(f.status)} ${esc(f.path.split(/[/\\]/).pop())}</span>
      <span class="diff-file-stats"><span class="adds">+${f.additions}</span><span class="dels">-${f.deletions}</span></span>
    </div>`).join('');
  
  // Show first file diff
  if (diff.diffs && diff.diffs.length > 0) renderFileDiff(diff.diffs[0]);
  
  // Summary
  document.getElementById('diffSummary').textContent = `${diff.summary.filesChanged} file(s) changed, +${diff.summary.additions} -${diff.summary.deletions}`;
}

function statusIcon(status) {
  switch(status) {
    case 'added': return '🟢';
    case 'deleted': return '🔴';
    case 'renamed': return '🔵';
    default: return '🟡';
  }
}

function selectDiffFile(idx) {
  document.querySelectorAll('.diff-file-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
  if (currentDiffData?.diffs?.[idx]) renderFileDiff(currentDiffData.diffs[idx]);
}

function renderFileDiff(fileDiff) {
  const el = document.getElementById('diffContent');
  if (!fileDiff.hunks || fileDiff.hunks.length === 0) {
    el.innerHTML = '<div style="padding:24px;color:#666;">Binary file or no textual changes</div>';
    return;
  }
  el.innerHTML = fileDiff.hunks.map(h => `
    <div class="diff-hunk-header">${esc(h.header)}</div>
    ${h.lines.map(l => `<div class="diff-line ${l.type}">${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${esc(l.content)}</div>`).join('')}
  `).join('');
}

// Load code changes for session cards
async function loadCodeChanges(sessionId, cwd) {
  try {
    const changes = await api.getCodeChanges(cwd);
    const el = document.getElementById(`code-changes-${sessionId}`);
    if (!el || !changes || changes.length === 0) return;
    
    el.style.display = 'block';
    const shown = changes.slice(0, 5);
    el.innerHTML = `
      <div class="code-changes-header" onclick="viewDiff('${escJs(cwd)}')">📝 ${changes.length} file(s) changed</div>
      <div class="code-changes-list">${shown.map(f => `
        <div class="code-change-file">
          <span class="fname">${esc(f.path)}</span>
          <span class="fstats"><span class="adds">+${f.additions}</span><span class="dels">-${f.deletions}</span></span>
        </div>`).join('')}
      ${changes.length > 5 ? `<div style="font-size:10px;color:#666;margin-top:4px;">...and ${changes.length-5} more</div>` : ''}
      </div>`;
  } catch {}
}

// === DEEP SEARCH ===
function handleDeepSearch(query) {
  clearTimeout(searchDebounce);
  if (!query || query.length < 3) {
    document.getElementById('searchResultsPanel').classList.remove('open');
    return;
  }
  searchDebounce = setTimeout(async () => {
    const results = await api.deepSearch(query);
    renderSearchResults(results, query);
  }, 500);
}

function renderSearchResults(results, query) {
  const panel = document.getElementById('searchResultsPanel');
  if (!results || results.length === 0) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');
  panel.innerHTML = `<div style="padding:10px 14px;font-size:11px;color:#888;border-bottom:1px solid #0f3460;">🔍 ${results.length} result(s) across sessions</div>` +
    results.slice(0, 20).map(r => `
      <div class="search-result-item" onclick="jumpToSession('${r.sessionId}')">
        <div class="search-result-type">${r.matchType}</div>
        <div class="search-result-text">${highlightMatch(esc(r.text), query)}</div>
        <div class="search-result-session">${r.sessionId.slice(0,8)}... ${r.timestamp ? '· ' + new Date(r.timestamp).toLocaleString() : ''}</div>
      </div>`).join('');
}

function highlightMatch(text, query) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="search-result-highlight">$1</span>');
}

function jumpToSession(sessionId) {
  document.getElementById('searchResultsPanel').classList.remove('open');
  const card = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.boxShadow = '0 0 12px #e94560';
    setTimeout(() => card.style.boxShadow = '', 2000);
  }
  viewActivity(sessionId);
}

// === TERMINAL-ONLY MODE ===
let terminalOnlyMode = false;

async function toggleTerminalOnlyMode() {
  terminalOnlyMode = !terminalOnlyMode;
  applyTerminalOnlyMode();
  await api.setTerminalOnlyMode(terminalOnlyMode);
}

function applyTerminalOnlyMode() {
  const mc = document.querySelector('.main-content');
  const btn = document.getElementById('terminalOnlyToggle');
  if (terminalOnlyMode) {
    mc.classList.add('terminal-only-mode');
    btn.classList.add('active');
    btn.textContent = '⊞ Sessions';
    // Ensure terminal panel is visible
    const panel = document.getElementById('terminalPanel');
    if (!panel.classList.contains('open')) showTerminalPanel();
  } else {
    mc.classList.remove('terminal-only-mode');
    btn.classList.remove('active');
    btn.textContent = '⊞ Focus';
  }
  setTimeout(() => terminals.forEach(t => t.fitAddon.fit()), 100);
}

// === SHORTCUTS HELP MODAL ===
function toggleShortcutsHelp() {
  const overlay = document.getElementById('shortcutsHelpOverlay');
  if (overlay.classList.contains('open')) {
    closeShortcutsHelp();
  } else {
    overlay.classList.add('open');
  }
}

function closeShortcutsHelp() {
  document.getElementById('shortcutsHelpOverlay').classList.remove('open');
}

document.getElementById('shortcutsHelpOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('shortcutsHelpOverlay')) closeShortcutsHelp();
});
document.getElementById('shortcutsHelpOverlay').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeShortcutsHelp();
});

// === CTRL+F TERMINAL SEARCH ===
let termSearchSelectedIdx = 0;
let termSearchMatches = [];

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'E') {
    // Skip if xterm already handled it
    if (e.target.closest('.terminal-instance')) return;
    
    e.preventDefault();
    // Open folder of the last focused terminal
    if (activeTerminalId) {
      const t = terminals.get(activeTerminalId);
      if (t) { api.openFolder(t.cwd); return; }
    }
    // No active terminal
    const panel = document.getElementById('terminalPanel');
    if (panel && panel.classList.contains('open') && terminals.size > 0) {
      // Use the first terminal
      const first = terminals.values().next().value;
      if (first) { api.openFolder(first.cwd); return; }
    }
    alert('Please focus on a terminal first (Ctrl+Shift+E opens its folder in Explorer)');
  }
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    openTerminalSearch();
  }
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    openBlankTerminal();
  }
  if (e.key === 'F1' || (!e.ctrlKey && e.shiftKey && e.key === '?')) {
    e.preventDefault();
    toggleShortcutsHelp();
  }
  if (e.key === 'F2') {
    e.preventDefault();
    const tid = activeTerminalId || (terminals.size > 0 ? terminals.keys().next().value : null);
    if (tid) editTermName(tid);
  }
  if (e.ctrlKey && e.key === 'm') {
    e.preventDefault();
    // Toggle maximize on the active (focused) terminal
    if (activeTerminalId && terminals.has(activeTerminalId)) {
      toggleMaximizeTerminal(activeTerminalId);
    } else if (maximizedTerminalId) {
      // Restore whatever is currently maximized
      toggleMaximizeTerminal(maximizedTerminalId);
    } else if (terminals.size > 0) {
      // No focused terminal — maximize the first one
      toggleMaximizeTerminal(terminals.keys().next().value);
    }
  }
});

function openTerminalSearch() {
  const overlay = document.getElementById('terminalSearchOverlay');
  const input = document.getElementById('terminalSearchInput');
  overlay.classList.add('open');
  input.value = '';
  termSearchSelectedIdx = 0;
  termSearchMatches = [];
  renderTerminalSearchResults('');
  setTimeout(() => input.focus(), 50);
}

function closeTerminalSearch() {
  document.getElementById('terminalSearchOverlay').classList.remove('open');
}

document.getElementById('terminalSearchOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('terminalSearchOverlay')) closeTerminalSearch();
});

document.getElementById('terminalSearchInput').addEventListener('input', e => {
  termSearchSelectedIdx = 0;
  renderTerminalSearchResults(e.target.value);
});

document.getElementById('terminalSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeTerminalSearch(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); termSearchSelectedIdx = Math.min(termSearchSelectedIdx + 1, termSearchMatches.length - 1); highlightTermSearchResult(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); termSearchSelectedIdx = Math.max(termSearchSelectedIdx - 1, 0); highlightTermSearchResult(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (termSearchMatches.length > 0) selectTermSearchResult(termSearchMatches[termSearchSelectedIdx].termId);
    return;
  }
});

function renderTerminalSearchResults(query) {
  const results = document.getElementById('terminalSearchResults');
  const q = query.toLowerCase().trim();
  termSearchMatches = [];

  for (const [termId, t] of terminals) {
    const folderName = (t.cwd || '').split(/[/\\]/).pop() || '';
    const sessName = t.sessionId ? (sessionNames[t.sessionId] || '') : '';
    const sessId = t.sessionId || '';
    const memo = t.customName || '';
    const searchable = `${memo} ${sessName} ${folderName} ${sessId}`.toLowerCase();
    if (!q || searchable.includes(q)) {
      termSearchMatches.push({ termId, memo, sessName, folderName, sessId, color: t.color || '#8b949e' });
    }
  }

  if (termSearchMatches.length === 0 && terminals.size === 0) {
    results.innerHTML = '<div style="padding:12px;color:#666;text-align:center;font-size:12px;">No terminals open</div>';
    return;
  }
  if (termSearchMatches.length === 0) {
    results.innerHTML = '<div style="padding:12px;color:#666;text-align:center;font-size:12px;">No matching terminals</div>';
    return;
  }

  results.innerHTML = termSearchMatches.map((m, i) => {
    const label = m.memo || m.sessName || m.folderName || m.termId;
    const meta = m.sessId ? m.sessId.slice(0, 8) + '...' : m.folderName;
    return `<div class="terminal-search-result ${i === termSearchSelectedIdx ? 'selected' : ''}" onclick="selectTermSearchResult('${m.termId}')" data-idx="${i}">
      <span class="tsr-color" style="background:${m.color}"></span>
      <span class="tsr-name">${esc(label)}</span>
      <span class="tsr-meta">${esc(meta)}</span>
    </div>`;
  }).join('');
}

function highlightTermSearchResult() {
  document.querySelectorAll('.terminal-search-result').forEach((el, i) => {
    el.classList.toggle('selected', i === termSearchSelectedIdx);
  });
  const sel = document.querySelector('.terminal-search-result.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function selectTermSearchResult(termId) {
  closeTerminalSearch();
  const t = terminals.get(termId);
  if (!t) return;
  const wrapper = document.getElementById(`terminal-${termId}`);
  if (!wrapper) return;
  // Unminimize if needed
  if (wrapper.classList.contains('minimized')) {
    wrapper.classList.remove('minimized');
    wrapper.querySelector('.terminal-instance-minimize').textContent = '▼';
  }
  // Ensure terminal panel is visible
  showTerminalPanel();
  // Flash & focus
  wrapper.classList.remove('flash');
  void wrapper.offsetWidth;
  wrapper.classList.add('flash');
  wrapper.addEventListener('animationend', () => wrapper.classList.remove('flash'), { once: true });
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { t.fitAddon.fit(); t.term.focus(); }, 100);
}

init();
