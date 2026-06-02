/* ============================
   WathbaGRC Admin Panel JS
   ============================ */

// ─── Notification Manager ────────────────────────────────────
const _notifs = []; // [{id, title, message, status:'running'|'success'|'error'|'info', result, createdAt}]
let _notifOpen = false;

function _notifRender() {
  const list  = document.getElementById('notif-list');
  const badge = document.getElementById('notif-badge');
  const btn   = document.getElementById('notif-bell-btn');
  if (!list) return;

  const running = _notifs.filter(n => n.status === 'running').length;
  const unseen  = _notifs.filter(n => n.status !== 'info' || n.unseen).length;

  if (badge) {
    if (running > 0) {
      badge.hidden = false;
      badge.textContent = running;
      badge.className = 'notif-badge notif-badge--running';
    } else if (unseen > 0) {
      badge.hidden = false;
      badge.textContent = unseen;
      badge.className = 'notif-badge';
    } else {
      badge.hidden = true;
    }
  }
  if (btn) btn.classList.toggle('is-running', running > 0);

  if (!_notifs.length) {
    list.innerHTML = '<div class="notif-empty-msg">No active processes</div>';
    return;
  }

  list.innerHTML = _notifs.map(n => {
    const iconHtml = n.status === 'running'
      ? `<span class="notif-item-icon notif-icon--running" aria-hidden="true"><span class="notif-spinner"></span></span>`
      : n.status === 'success'
        ? `<span class="notif-item-icon notif-icon--success" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
        : n.status === 'error'
          ? `<span class="notif-item-icon notif-icon--error" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>`
          : `<span class="notif-item-icon notif-icon--info" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.4"/><path d="M6 5.5V8.5M6 3.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>`;
    const timeStr = n.createdAt ? new Date(n.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
    const clickable = n.result && n.status === 'success';
    return `<div class="notif-item${clickable ? ' notif-item--clickable' : ''}" data-notif-id="${esc(n.id)}"
        ${clickable ? `onclick="onNotifClick('${esc(n.id)}')"` : ''}>
      ${iconHtml}
      <div class="notif-item-body">
        <div class="notif-item-title">${esc(n.title)}</div>
        ${n.message ? `<div class="notif-item-msg">${esc(n.message)}</div>` : ''}
      </div>
      <div class="notif-item-right">
        <span class="notif-item-time">${esc(timeStr)}</span>
        ${n.status !== 'running' ? `<button class="notif-dismiss-btn" onclick="dismissNotif(event,'${esc(n.id)}')" title="Dismiss">×</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function addNotif(id, title, message, status = 'running', result = null) {
  const existing = _notifs.findIndex(n => n.id === id);
  const entry = { id, title, message, status, result, createdAt: new Date().toISOString(), unseen: true };
  if (existing >= 0) _notifs[existing] = { ..._notifs[existing], ...entry };
  else _notifs.unshift(entry);
  _notifRender();
}

function updateNotif(id, updates) {
  const idx = _notifs.findIndex(n => n.id === id);
  if (idx < 0) return;
  _notifs[idx] = { ..._notifs[idx], ...updates };
  _notifRender();
  if (updates.status === 'success' || updates.status === 'error') {
    const panel = document.getElementById('notif-panel');
    if (panel && panel.hidden) {
      const badge = document.getElementById('notif-badge');
      if (badge) { badge.hidden = false; badge.className = 'notif-badge notif-badge--pulse'; }
    }
  }
}

function dismissNotif(e, id) {
  if (e) e.stopPropagation();
  const idx = _notifs.findIndex(n => n.id === id);
  if (idx >= 0) _notifs.splice(idx, 1);
  _notifRender();
}

function clearDoneNotifications() {
  for (let i = _notifs.length - 1; i >= 0; i--) {
    if (_notifs[i].status !== 'running') _notifs.splice(i, 1);
  }
  _notifRender();
}

function onNotifClick(id) {
  const n = _notifs.find(x => x.id === id);
  if (n && n.result) {
    toggleNotifPanel(); // close panel
    openPolicyPipelineResultModal(n.result);
  }
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  const btn   = document.getElementById('notif-bell-btn');
  if (!panel) return;
  _notifOpen = panel.hidden;
  panel.hidden = !_notifOpen;
  if (btn) btn.setAttribute('aria-expanded', String(_notifOpen));
  if (_notifOpen) {
    _notifs.forEach(n => { n.unseen = false; });
    _notifRender();
    // Close on outside click
    setTimeout(() => document.addEventListener('click', _notifOutsideClick, { once: true }), 0);
  }
}

function _notifOutsideClick(e) {
  const wrap = document.getElementById('notif-wrap');
  if (wrap && !wrap.contains(e.target)) {
    const panel = document.getElementById('notif-panel');
    if (panel) panel.hidden = true;
    _notifOpen = false;
    const btn = document.getElementById('notif-bell-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

// ─── Auth Guard ──────────────────────────────────────────────
(function checkAuth() {
  const hasCookie = document.cookie.split(';').some(c => c.trim().startsWith('wathba_token='));
  if (!hasCookie) {
    window.location.replace('/login.html');
  }
})();

async function adminLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) { /* ignore */ }
  document.cookie = 'wathba_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  window.location.replace('/login.html');
}
window.adminLogout = adminLogout;

/** GRC upstream rejected the stored token — clear local session and send user to login. */
async function redirectIfGrcSessionExpired(response) {
  if (response.status !== 401) return false;
  let data = null;
  try {
    data = await response.clone().json();
  } catch (_) {
    return false;
  }
  if (data && data.grcSessionExpired) {
    await adminLogout();
    return true;
  }
  return false;
}

const _adminNativeFetch = window.fetch.bind(window);
window.fetch = function adminPatchedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  const isGrc = url.includes('/api/grc/');
  return _adminNativeFetch(input, init).then(async (res) => {
    if (isGrc && (await redirectIfGrcSessionExpired(res))) {
      const err = new Error('GRC session expired');
      err.code = 'GRC_SESSION_EXPIRED';
      throw err;
    }
    return res;
  });
};

const API = {
  sessions: '/api/chat/sessions',
  collections: '/api/collections',
  localPrompts: '/api/local-prompts',
  prompts: 'https://muraji-api.wathbah.dev/api/prompts',
  libraries: 'https://muraji-api.wathbah.dev/api/libraries',
  orgContexts: '/api/org-contexts',
  csSessions: '/api/cs-sessions',
  controlsGenerate: '/api/controls/generate',
};

// ─── State ────────────────────────────────────────────────────
let sessions = [];
let collections = [];
let collectionFiles = {};  // storeId -> files[]
let orgContexts = [];      // placeholder for org contexts data
let frameworks = [];       // libraries/frameworks from API
let csSessions = null;     // Controls Studio sessions (cached)
let csMode = 'sessions';   // 'sessions' | 'wizard'
let csCurrentStep = 0;
let csSessionData = null;
let csLibraries = [];          // fetched frameworks for controls studio
let csCollectionsData = [];    // fetched collections with files for controls studio
let csPendingPoll = null;

// ─── DOM refs ─────────────────────────────────────────────────
const headerTitle = document.getElementById('admin-header-title'); // may be null in new layout
const toastContainer = document.getElementById('toast-container');

// ─── Navigation ───────────────────────────────────────────────

const PAGE_NAMES = {
  'dashboard': 'Dashboard',
  'audit-sessions': 'Audit Sessions',
  'audit-studio': 'Audit Studio',
  'controls-studio': 'Applied Controls Studio',
  'merge-optimizer': 'Control Merge Optimizer',
  'policy-ingestion': 'Organization Policy Ingestion',
  'org-contexts': 'Organization Contexts',
  'data-studio': 'Data Studio',
  'policy-update-pipeline': 'Policy update pipeline',
  'pipeline-history': 'Pipeline history',
  'prompts': 'Prompts',
  'file-collections': 'File Collections',
  'workbench': 'Workbench',
  'legislative-internal-sources': 'Internal sources',
  'legislative-external-sources': 'External sources',
  'pipeline-configuration': 'Pipeline configuration',
  'audit-log': 'Audit Log',
};
const VALID_PAGES = Object.keys(PAGE_NAMES);
let currentPage = null;
let currentSubId = null; // Sub-route ID (e.g. collection UUID)

function navigateTo(page, pushState = true, subId = null) {
  if (!VALID_PAGES.includes(page)) page = 'dashboard';

  const isSamePage = page === currentPage && subId === currentSubId;
  if (isSamePage) return;

  currentPage = page;
  currentSubId = subId;

  // Update URL path
  if (pushState) {
    const newPath = subId ? `/${page}/${subId}` : `/${page}`;
    if (window.location.pathname !== newPath) {
      history.pushState({ page, subId }, '', newPath);
    }
  }

  // Update sidebar
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const target = document.querySelector(`.sidebar-item[data-page="${page}"]`);
  if (target) target.classList.add('active');

  if (
    page === 'legislative-internal-sources' ||
    page === 'legislative-external-sources' ||
    page === 'pipeline-configuration'
  ) {
    const legSec = document.getElementById('section-legislative-updates');
    const legToggle = document.querySelector('.sidebar-section-toggle[data-section="legislative-updates"]');
    if (legSec) legSec.classList.add('open');
    if (legToggle) legToggle.classList.remove('collapsed');
  }

  // Update pages
  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  // Update header
  if (headerTitle) headerTitle.textContent = PAGE_NAMES[page] || page;

  // Update document title
  document.title = (PAGE_NAMES[page] || 'Admin') + ' — WathbaGRC';

  // Load data for the page
  if (page === 'dashboard') loadDashboard();
  if (page === 'audit-sessions') loadSessions();
  if (page === 'audit-studio') loadAuditStudio();
  if (page === 'file-collections') loadCollections();
  if (page === 'org-contexts') loadOrgContexts(subId);
  if (page === 'prompts') loadPrompts();
  if (page === 'controls-studio') loadControlsStudio();
  if (page === 'merge-optimizer') loadMergeOptimizer();
  if (page === 'policy-ingestion') loadPolicyIngestion(subId);
  if (page === 'data-studio') loadDataStudioPage();
  if (page === 'policy-update-pipeline') loadPolicyUpdatePipelinePage();
  if (page === 'pipeline-history') loadPipelineHistoryPage();
  if (page === 'workbench') loadWorkbench(subId);
  if (page === 'legislative-internal-sources') loadLegislativeInternalSourcesPage();
  if (page === 'legislative-external-sources') loadLegislativeExternalSourcesPage();
  if (page === 'pipeline-configuration') loadPipelineConfigurationPage();
  if (page === 'audit-log') loadAuditLog(subId);

  // Scroll to top
  window.scrollTo(0, 0);
}
window.navigateTo = navigateTo;

// Update URL without full page reload (for sub-navigation within a page)
function updateRoute(page, subId) {
  currentSubId = subId;
  const newPath = subId ? `/${page}/${subId}` : `/${page}`;
  if (window.location.pathname !== newPath) {
    history.pushState({ page, subId }, '', newPath);
  }
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  const { page, subId } = e.state || parseRoute();
  currentPage = null; // Reset so navigateTo doesn't skip
  currentSubId = null;
  navigateTo(page, false, subId);
});

// Parse page + optional sub-ID from URL pathname
function parseRoute() {
  const parts = window.location.pathname.replace(/^\//, '').split('/');
  const raw = parts[0] || '';
  let page = 'dashboard';
  let subId = parts[1] || null;

  if (raw === 'legislative-updates') {
    page = 'legislative-internal-sources';
  } else if (raw === 'pipeline-impact-criteria') {
    page = 'pipeline-configuration';
    subId = null;
  } else if (raw === 'pipeline-default-org') {
    page = 'pipeline-configuration';
    subId = 'default-org';
  } else if (raw && VALID_PAGES.includes(raw)) {
    page = raw;
  }
  return { page, subId };
}

// Sidebar nav click handlers
document.querySelectorAll('.sidebar-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.page));
});

// Sidebar section toggles
document.querySelectorAll('.sidebar-section-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const sec = document.getElementById('section-' + btn.dataset.section);
    if (sec) sec.classList.toggle('open');
    btn.classList.toggle('collapsed');
  });
});

// ─── Toast ────────────────────────────────────────────────────

function toast(type, title, msg, dur) {
  dur = dur || 4000;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const ic = {
    success: '<path d="M9 12L11 14L15 10M21 12C21 16.97 16.97 21 12 21C7.03 21 3 16.97 3 12C3 7.03 7.03 3 12 3C16.97 3 21 7.03 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    error: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8V12M12 16V16.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    warning: '<path d="M12 9V13M12 17H12.01M4.93 19H19.07C20.14 19 20.81 17.83 20.28 16.91L13.21 4.58C12.68 3.67 11.32 3.67 10.79 4.58L3.72 16.91C3.19 17.83 3.86 19 4.93 19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    info: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 16V12M12 8V8.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  el.innerHTML = '<div class="toast-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none">' + (ic[type] || ic.info) + '</svg></div><div class="toast-content"><div class="toast-title">' + esc(title) + '</div><div class="toast-message">' + esc(msg) + '</div></div><button class="toast-close"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
  el.querySelector('.toast-close').addEventListener('click', () => { el.classList.add('removing'); setTimeout(() => el.remove(), 300); });
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { if (el.parentNode) { el.classList.add('removing'); setTimeout(() => el.remove(), 300); } }, dur);
}

// ─── Helpers ──────────────────────────────────────────────────

function esc(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }

/**
 * Show a custom confirm dialog (replaces window.confirm).
 * @param {Object} opts
 * @param {string} opts.title - Dialog title
 * @param {string} opts.message - Dialog body text
 * @param {string} [opts.confirmText='Delete'] - Confirm button label
 * @param {string} [opts.cancelText='Cancel'] - Cancel button label
 * @param {string} [opts.type='danger'] - 'danger' | 'warning' | 'info'
 * @returns {Promise<boolean>} true if confirmed, false if cancelled
 */
function showConfirm({ title = 'Are you sure?', message = '', confirmText = 'Delete', cancelText = 'Cancel', type = 'danger' } = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-dialog-overlay');
    const iconEl = document.getElementById('confirm-dialog-icon');
    const titleEl = document.getElementById('confirm-dialog-title');
    const msgEl = document.getElementById('confirm-dialog-message');
    const confirmBtn = document.getElementById('confirm-dialog-confirm');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');

    titleEl.textContent = title;
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    // Icon based on type
    const icons = {
      danger: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M3 6H21M8 6V4C8 3.4 8.4 3 9 3H15C15.6 3 16 3.4 16 4V6M10 11V17M14 11V17M5 6L6 20C6 20.6 6.4 21 7 21H17C17.6 21 18 20.6 18 20L19 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      warning: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 9V13M12 17H12.01M4.93 19H19.07C20.14 19 20.81 17.83 20.28 16.91L13.21 4.58C12.68 3.67 11.32 3.67 10.79 4.58L3.72 16.91C3.19 17.83 3.86 19 4.93 19Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      info: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M12 8V12M12 16H12.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    };
    iconEl.className = 'confirm-dialog-icon ' + type;
    iconEl.innerHTML = icons[type] || icons.danger;

    // Style confirm button
    confirmBtn.className = 'confirm-dialog-btn confirm-dialog-confirm' + (type === 'info' ? ' primary' : '');

    // Show
    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('active'));

    function cleanup(result) {
      overlay.classList.remove('active');
      setTimeout(() => { overlay.style.display = 'none'; }, 200);
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) { if (e.key === 'Escape') cleanup(false); if (e.key === 'Enter') cleanup(true); }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);

    cancelBtn.focus();
  });
}

function fmtDate(s) {
  try {
    const d = new Date(s), now = new Date(), ms = now - d;
    const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (h < 24) return h + 'h ago';
    if (dy < 7) return dy + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return s || '—'; }
}

function fmtDateShort(s) {
  try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return s || '—'; }
}

function parseContext(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; }
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ─── Data Fetching ────────────────────────────────────────────

async function fetchSessions() {
  try {
    const d = await fetchJSON(API.sessions);
    sessions = d.sessions || [];
  } catch (e) { console.error('Sessions fetch error:', e); sessions = []; }
}

async function fetchCollections() {
  try {
    const d = await fetchJSON(API.collections);
    const stores = d.data?.fileSearchStores || d.data || [];
    collections = Array.isArray(stores) ? stores : [];
  } catch (e) { console.error('Collections fetch error:', e); collections = []; }
}

async function fetchCollectionFiles(storeId) {
  try {
    const d = await fetchJSON(API.collections + '/' + storeId + '/files');
    const docs = d.data?.documents || d.data?.fileSearchDocuments || [];
    collectionFiles[storeId] = docs;
    return docs;
  } catch (e) { console.error('Files fetch error:', e); collectionFiles[storeId] = []; return []; }
}

async function fetchFrameworks() {
  try {
    const d = await fetchJSON(API.libraries);
    frameworks = Array.isArray(d) ? d : (d.data || d.libraries || []);
  } catch (e) { console.error('Frameworks fetch error:', e); frameworks = []; }
}

async function fetchCsSessions() {
  try {
    const d = await fetchJSON(API.csSessions);
    csSessions = d.sessions || [];
  } catch (e) { console.error('CS sessions fetch error:', e); csSessions = []; }
}

async function fetchPromptCounts() {
  let localCount = 0, apiCount = 0;
  try {
    const d = await fetchJSON(API.localPrompts);
    localCount = (d.prompts || []).length;
  } catch (e) {}
  try {
    const d = await fetchJSON(API.prompts);
    const all = Array.isArray(d) ? d : (d.data || d.prompts || []);
    apiCount = all.length;
  } catch (e) {}
  return localCount + apiCount;
}

// ─── Dashboard ────────────────────────────────────────────────

async function loadDashboard() {
  console.log('[admin.js] loadDashboard started');
  try {
    const promptCountPromise = fetchPromptCounts();
    await Promise.all([fetchSessions(), fetchCollections(), fetchFrameworks(), fetchCsSessions()]);
    const promptCount = await promptCountPromise;
    console.log('[admin.js] Data fetched:', { sessions: sessions.length, collections: collections.length, frameworks: frameworks.length, csSessions: (csSessions||[]).length, promptCount });
    renderDashStats(promptCount);
    renderDashSessions();
    renderDashStudioSessions();
    renderDashFrameworks();
    console.log('[admin.js] Dashboard rendered');
  } catch (e) {
    console.error('[admin.js] loadDashboard error:', e);
    // Still try to render what we can
    try { renderDashStats(0); } catch (e2) { console.error('renderDashStats error:', e2); }
    try { renderDashSessions(); } catch (e2) { console.error('renderDashSessions error:', e2); }
    try { renderDashStudioSessions(); } catch (e2) { console.error('renderDashStudioSessions error:', e2); }
    try { renderDashFrameworks(); } catch (e2) { console.error('renderDashFrameworks error:', e2); }
  }
}

function renderDashStats(promptCount) {
  const el = document.getElementById('dash-stats');
  if (!el) { console.error('dash-stats element not found'); return; }
  const totalSessions = sessions.length;
  const totalCollections = collections.length;
  const totalFrameworks = frameworks.length;
  const totalFiles = collections.reduce((a, c) => a + parseInt(c.activeDocumentsCount || c.file_counts?.active || c.fileCount || 0, 10), 0);
  promptCount = promptCount || 0;

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-primary"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 4H16L18 6V16C18 16.6 17.6 17 17 17H3C2.4 17 2 16.6 2 16V5C2 4.4 2.4 4 3 4Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 10H13M7 13H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="stat-card-value">${totalSessions}</div>
      <div class="stat-card-label">Audit Sessions</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-emerald"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 4H17M3 8H12M3 12H15M3 16H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="stat-card-value">${promptCount}</div>
      <div class="stat-card-label">Prompts</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-amber"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 7V15C3 15.6 3.4 16 4 16H16C16.6 16 17 15.6 17 15V9C17 8.4 16.6 8 16 8H10L8.5 6H4C3.4 6 3 6.4 3 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="stat-card-value">${totalCollections}</div>
      <div class="stat-card-label">File Collections</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-violet"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 4H16V16H4V4Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 8H16M4 12H16M8 4V16M12 4V16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="stat-card-value">${totalFrameworks}</div>
      <div class="stat-card-label">Frameworks Loaded</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-rose"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M14 2V18M6 6V14C6 16.2 7.8 18 10 18H14M6 6L4 8M6 6L8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="stat-card-value">${(csSessions || []).length}</div>
      <div class="stat-card-label">Merge Suggestions</div>
    </div>`;
}

function renderDashSessions() {
  const list = document.getElementById('dash-sessions-list');
  const footer = document.getElementById('dash-sessions-footer');
  if (!list || !footer) return;
  const recent = sessions.slice(0, 5);

  if (!recent.length) {
    list.innerHTML = '<div style="padding:32px 20px;text-align:center;color:#9ca3af;font-size:13px">No sessions yet. Go to <a href="javascript:navigateTo(\'audit-studio\')" style="color:var(--admin-primary)">Audit Studio</a> to start.</div>';
    footer.textContent = '';
    return;
  }

  list.innerHTML = recent.map(s => {
    // Handle both API format (camelCase) and raw DB format (snake_case)
    const id = s.sessionId || s.id;
    const createdAt = s.createdAt || s.created_at;
    const msgCount = s.messageCount || s.message_count || 0;

    // Get framework name from requirements or context
    let fw = 'Unknown';
    let reqCount = 0;
    let fileCount = 0;

    if (s.requirements && s.requirements.length) {
      fw = s.requirements[0].frameworkName || 'Unknown';
      reqCount = s.requirementsCount || s.requirements.length;
    } else if (s.context) {
      const ctx = parseContext(s.context);
      fw = ctx.frameworkName || 'Unknown';
      reqCount = (ctx.selectedRequirements || ctx.requirements || []).length;
      fileCount = (ctx.selectedFiles || []).length + (ctx.contextFiles || []).length;
    }

    fileCount = fileCount || s.filesCount || 0;

    return `
      <div class="dash-session-row" onclick="goToSession('${esc(id)}')">
        <div class="dash-session-info">
          <div class="dash-session-name">${esc(fw)}</div>
          <div class="dash-session-date">${fmtDate(createdAt)}</div>
        </div>
        <div class="dash-session-stats">
          <div class="dash-session-stat"><div class="dash-session-stat-val dash-stat-purple">${reqCount}</div><div class="dash-session-stat-label">Req</div></div>
          <div class="dash-session-stat"><div class="dash-session-stat-val dash-stat-blue">${fileCount}</div><div class="dash-session-stat-label">Files</div></div>
          <div class="dash-session-stat"><div class="dash-session-stat-val dash-stat-amber">${msgCount}</div><div class="dash-session-stat-label">Msgs</div></div>
        </div>
        <svg class="dash-session-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>`;
  }).join('');

  const totalMsgs = sessions.reduce((a, s) => a + (s.messageCount || s.message_count || 0), 0);
  const totalFiles = sessions.reduce((a, s) => {
    if (s.filesCount) return a + s.filesCount;
    const ctx = parseContext(s.context);
    return a + (ctx.selectedFiles || []).length + (ctx.contextFiles || []).length;
  }, 0);
  footer.textContent = `${sessions.length} sessions • ${totalMsgs} total messages • ${totalFiles} reference files`;
}

function renderDashStudioSessions() {
  const el = document.getElementById('dash-studio-sessions');
  if (!el) return;
  const list = (csSessions || []).slice(0, 3);

  if (!list.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;font-size:12px;color:#9ca3af">
      <p>No Controls Studio sessions yet.</p>
      <button class="btn-admin-outline btn-admin-sm" onclick="navigateTo('controls-studio')" style="margin-top:8px">Open Studio</button>
    </div>`;
    return;
  }

  el.innerHTML = list.map(s => {
    const name = s.name || 'Untitled Session';
    const orgCtx = s.orgContext || (s.org_context ? (typeof s.org_context === 'string' ? JSON.parse(s.org_context) : s.org_context) : null);
    const orgName = orgCtx?.nameEn || orgCtx?.name_en || orgCtx?.nameAr || orgCtx?.name_ar || '';
    const status = s.status || 'draft';
    const statusColors = {
      draft: 'color:#9ca3af',
      generating: 'color:#f59e0b',
      generated: 'color:#10b981',
      exported: 'color:#0077cc',
      merged: 'color:#8b5cf6'
    };
    const statusBadges = {
      merged: '<span class="badge badge-purple" style="font-size:9px;margin-right:4px">⅓ merge</span>',
    };
    return `
      <div class="dash-studio-row" onclick="navigateTo('controls-studio')">
        <div class="dash-studio-info">
          <div class="dash-studio-name">${esc(name.length > 28 ? name.substring(0, 28) + '...' : name)}</div>
          ${orgName ? `<div class="dash-studio-org">${esc(orgName)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          ${statusBadges[status] || ''}
          <span class="dash-studio-status" style="${statusColors[status] || ''};font-size:11px;font-weight:500">${status}</span>
        </div>
      </div>`;
  }).join('');
}

function renderDashFrameworks() {
  const el = document.getElementById('dash-frameworks');
  if (!el) return;

  if (!frameworks.length) {
    el.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:#9ca3af">No frameworks loaded.</div>';
    return;
  }

  // Build framework summary: name + requirement count
  const fwList = frameworks.map(lib => {
    const fw = lib.content?.framework;
    if (!fw) return null;
    const name = fw.name || lib.name || 'Unknown';
    const nodes = (fw.requirement_nodes || []).filter(n => n.description);
    return { name, reqCount: nodes.length };
  }).filter(Boolean);

  const MAX_SHOW = 4;
  const visible = fwList.slice(0, MAX_SHOW);
  const remaining = fwList.length - MAX_SHOW;

  let html = '<div class="dash-fw-list">';
  visible.forEach(fw => {
    html += `
      <div class="dash-fw-row">
        <div class="dash-fw-name">${esc(fw.name.length > 28 ? fw.name.substring(0, 28) + '...' : fw.name)}</div>
        <span class="dash-fw-count">${fw.reqCount} req</span>
      </div>`;
  });
  if (remaining > 0) {
    html += `<div class="dash-fw-more">+${remaining} more framework${remaining > 1 ? 's' : ''}</div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ─── Audit Sessions Page ──────────────────────────────────────

async function loadSessions() {
  await fetchSessions();
  renderSessionsList();
}

function renderSessionsList(query) {
  const el = document.getElementById('sessions-list-full');
  if (!el) return;
  let list = sessions;
  if (query) {
    list = sessions.filter(s => {
      const fw = (s.requirements && s.requirements[0]?.frameworkName) || '';
      const q = s.query || '';
      const text = fw + ' ' + q;
      return text.toLowerCase().includes(query);
    });
  }

  if (!list.length) {
    el.innerHTML = '<div style="padding:32px 20px;text-align:center;color:#9ca3af;font-size:13px">No sessions found.</div>';
    return;
  }

  el.innerHTML = list.map(s => {
    const id = s.sessionId || s.id;
    const createdAt = s.createdAt || s.created_at;
    const msgCount = s.messageCount || s.message_count || 0;
    const fw = (s.requirements && s.requirements[0]?.frameworkName) || 'Unknown';
    const reqCount = s.requirementsCount || (s.requirements || []).length;
    const fileCount = s.filesCount || 0;
    const queryPreview = (s.query || '').substring(0, 80);
    return `
      <div class="session-row" onclick="goToSession('${esc(id)}')">
        <div>
          <div class="session-row-name">${esc(fw)}</div>
          <div class="session-row-query">${esc(queryPreview)}</div>
        </div>
        <div class="session-row-stat">${reqCount}</div>
        <div class="session-row-stat">${fileCount}</div>
        <div class="session-row-stat">${msgCount}</div>
        <div class="session-row-date">${fmtDateShort(createdAt)}</div>
        <div class="col-action">
          <button class="btn-admin-ghost btn-admin-sm" onclick="event.stopPropagation();deleteSession('${esc(id)}')" title="Delete">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

// Session search
const sessionsSearch = document.getElementById('sessions-search');
if (sessionsSearch) {
  sessionsSearch.addEventListener('input', e => renderSessionsList(e.target.value.toLowerCase().trim() || undefined));
}

function goToSession(id) {
  // Find session and set context in sessionStorage, then redirect to chat page
  const s = sessions.find(x => (x.sessionId || x.id) === id);
  if (s) {
    sessionStorage.setItem('chatSessionId', s.sessionId || s.id);
    window.location.href = 'chat.html';
  }
}
window.goToSession = goToSession;

async function deleteSession(id) {
  if (!await showConfirm({ title: 'Delete Session', message: 'Are you sure you want to delete this session?', confirmText: 'Delete' })) return;
  try {
    const r = await fetch(API.sessions + '/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('success', 'Deleted', 'Session deleted.');
    sessions = sessions.filter(s => (s.sessionId || s.id) !== id);
    renderSessionsList();
  } catch (e) { toast('error', 'Error', e.message); }
}
window.deleteSession = deleteSession;

// ─── File Collections Page ────────────────────────────────────

async function loadCollections() {
  await fetchCollections();
  renderFCStats();
  renderFCCollections();
}

function renderFCStats() {
  const el = document.getElementById('fc-stats');
  const total = collections.length;
  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-primary"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 7V15C3 15.6 3.4 16 4 16H16C16.6 16 17 15.6 17 15V9C17 8.4 16.6 8 16 8H10L8.5 6H4C3.4 6 3 6.4 3 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="stat-card-value">${total}</div>
      <div class="stat-card-label">Total Collections</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-emerald"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 4H12L16 8V16C16 16.6 15.6 17 15 17H4C3.4 17 3 16.6 3 16V5C3 4.4 3.4 4 4 4Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 4V8H16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="stat-card-value" id="fc-total-files">—</div>
      <div class="stat-card-label">Total Files</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-amber"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M7 10L9 12L13 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="stat-card-value" id="fc-active-files">—</div>
      <div class="stat-card-label">Active Files</div>
    </div>`;
}

function renderFCCollections() {
  const el = document.getElementById('fc-collections-list');
  if (!collections.length) {
    el.innerHTML = '<div class="admin-card empty-state-box"><h3>No collections</h3><p>File collections will appear here once created from the Auditor page.</p></div>';
    return;
  }

  let totalFiles = 0, totalActive = 0;

  el.innerHTML = collections.map(c => {
    const name = c.displayName || c.name || 'Untitled';
    const id = (c.name || '').replace('fileSearchStores/', '');
    return `
      <div class="fc-collection-card" data-store-id="${esc(id)}">
        <div class="fc-collection-inner" onclick="toggleFCExpand('${esc(id)}')">
          <div class="fc-collection-left">
            <div class="fc-collection-icon">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M3 7V15C3 15.6 3.4 16 4 16H16C16.6 16 17 15.6 17 15V9C17 8.4 16.6 8 16 8H10L8.5 6H4C3.4 6 3 6.4 3 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div>
              <div class="fc-collection-name">${esc(name)}</div>
              <div class="fc-collection-id">${esc(id)}</div>
            </div>
          </div>
          <div class="fc-collection-right">
            <span class="badge badge-gray" id="fc-badge-${esc(id)}">Loading…</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 5L6 7L8 5" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round"/></svg>
          </div>
        </div>
        <div class="fc-files-body" id="fc-files-${esc(id)}" style="display:none"></div>
      </div>`;
  }).join('');

  // Load file counts for each collection
  collections.forEach(async c => {
    const id = (c.name || '').replace('fileSearchStores/', '');
    const files = await fetchCollectionFiles(id);
    const badge = document.getElementById('fc-badge-' + id);
    const active = files.filter(f => f.state === 'STATE_ACTIVE').length;
    if (badge) badge.textContent = files.length + ' file' + (files.length !== 1 ? 's' : '');

    totalFiles += files.length;
    totalActive += active;

    const tfEl = document.getElementById('fc-total-files');
    const afEl = document.getElementById('fc-active-files');
    if (tfEl) tfEl.textContent = totalFiles;
    if (afEl) afEl.textContent = totalActive;
  });
}

function toggleFCExpand(storeId) {
  const body = document.getElementById('fc-files-' + storeId);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) renderFCFiles(storeId);
}
window.toggleFCExpand = toggleFCExpand;

// View a file from a collection (opens in new tab via the local copy)
function viewFileInCollection(storeId, docId) {
  if (!storeId || !docId) {
    toast('error', 'Cannot View', 'File identifier not available.');
    return;
  }
  const viewUrl = `/api/collections/${encodeURIComponent(storeId)}/files/${encodeURIComponent(docId)}/view`;
  window.open(viewUrl, '_blank');
}
window.viewFileInCollection = viewFileInCollection;

function renderFCFiles(storeId) {
  const body = document.getElementById('fc-files-' + storeId);
  const files = collectionFiles[storeId] || [];
  if (!files.length) {
    body.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:#9ca3af">No files in this collection.</div>';
    return;
  }

  body.innerHTML = '<div style="padding:8px 16px">' + files.map(f => {
    const name = f.displayName || f.name || 'Unknown';
    const state = f.state || 'UNKNOWN';
    const stateClass = state === 'STATE_ACTIVE' ? 'badge-emerald' : (state === 'STATE_PENDING' ? 'badge-amber' : 'badge-red');
    const stateLabel = state.replace('STATE_', '');
    const isActive = state === 'STATE_ACTIVE';
    const docId = (f.name || '').split('/').pop();
    return `
      <div class="org-ctx-doc" style="display:flex;align-items:center;gap:8px">
        <div class="org-ctx-doc-name" style="flex:1">${esc(name)}</div>
        <span class="badge ${stateClass}">${stateLabel}</span>
        ${isActive && docId ? `<button class="btn-admin-sm" onclick="event.stopPropagation();viewFileInCollection('${esc(storeId)}','${esc(docId)}')" title="View file" style="padding:2px 6px;font-size:11px"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M1 7C1 7 3.5 2.5 7 2.5C10.5 2.5 13 7 13 7C13 7 10.5 11.5 7 11.5C3.5 11.5 1 7 1 7Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/></svg></button>` : ''}
      </div>`;
  }).join('') + '</div>';
}

// ─── Organization Contexts Page ───────────────────────────────

async function loadOrgContexts(subId) {
  try {
    const d = await fetchJSON(API.orgContexts);
    orgContexts = d.contexts || [];
  } catch (e) { console.error('Org contexts fetch error:', e); orgContexts = []; }
  // Ensure frameworks are loaded for mandate checkboxes
  if (!frameworks || !frameworks.length) await fetchFrameworks();
  renderOrgStats();
  renderOrgContextsList();

  // If a subId is provided (deep link), open that context's detail page
  if (subId) {
    const idx = orgContexts.findIndex(c => c.id === subId);
    if (idx >= 0) {
      orgDetailCtxId = subId;
      await renderOrgContextDetail(orgContexts[idx], idx);
      return; // detail page renders its own FAB
    }
  }

  // Show chat FAB on the main list page (no specific org pre-selected)
  renderOrgChatFAB(null);
}

function renderOrgStats() {
  const el = document.getElementById('org-stats');
  if (!el) return;
  const totalDocs = orgContexts.reduce((a, c) => a + (c.documents || []).length, 0);
  const fullCoverage = orgContexts.filter(c => (c.obligatoryFrameworks || []).length >= 2).length;
  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-primary"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 5V15C3 15.6 3.4 16 4 16H16C16.6 16 17 15.6 17 15V8C17 7.4 16.6 7 16 7H10.5L9 5H4C3.4 5 3 5.4 3 6Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="stat-card-value">${orgContexts.length}</div>
      <div class="stat-card-label">Total Contexts</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-emerald"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 4H12L16 8V16C16 16.6 15.6 17 15 17H4C3.4 17 3 16.6 3 16V5C3 4.4 3.4 4 4 4Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="stat-card-value">${totalDocs}</div>
      <div class="stat-card-label">Total Documents</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon stat-bg-amber"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M7 10L9 12L13 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="stat-card-value">${fullCoverage}</div>
      <div class="stat-card-label">Full Regulatory Coverage</div>
    </div>`;
}

function renderOrgContextsList(query) {
  const el = document.getElementById('org-contexts-list');
  let list = orgContexts;
  if (query) {
    list = orgContexts.filter((ctx, i) => {
      const text = (ctx.nameEn || ctx.name || '') + ' ' + (ctx.nameAr || '') + ' ' + (ctx.sector || '') + ' ' + (ctx.obligatoryFrameworks || []).join(' ');
      return text.toLowerCase().includes(query);
    });
  }

  if (!list.length && !orgContexts.length) {
    el.innerHTML = `
      <div class="admin-card empty-state-box">
        <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M4 8V24C4 25.1 4.9 26 6 26H26C27.1 26 28 25.1 28 24V12C28 10.9 27.1 10 26 10H17L14.5 7H6C4.9 7 4 7.9 4 9Z" stroke="#cbd5e1" stroke-width="2" stroke-linecap="round"/></svg></div>
        <h3>No Organization Contexts</h3>
        <p>Organization Contexts are client and entity profiles for AI-contextualized control suggestions. Click "+ New Context" to create one.</p>
      </div>`;
    return;
  }

  if (!list.length) {
    el.innerHTML = '<div style="padding:32px 20px;text-align:center;color:#9ca3af;font-size:13px">No contexts match your search.</div>';
    return;
  }

  const sectorLabels = { banking: 'Banking & Financial Services', financial: 'Financial', government: 'Government', healthcare: 'Healthcare', energy: 'Energy & Utilities', telecom: 'Telecommunications', education: 'Education', retail: 'Retail & E-Commerce', insurance: 'Insurance', technology: 'Technology', defense: 'Defense & Military', manufacturing: 'Manufacturing', transportation: 'Transportation & Logistics', custom: 'Custom', other: 'Other' };
  const sectorBadgeLabels = { banking: 'Financial', financial: 'Financial', government: 'Government', healthcare: 'Healthcare', energy: 'Energy', telecom: 'Telecom', education: 'Education', retail: 'Retail', insurance: 'Insurance', technology: 'Technology', defense: 'Defense', manufacturing: 'Manufacturing', transportation: 'Transport', custom: 'Custom', other: 'Other' };
  const sizeLabels = { small: 'Small', medium: 'Medium', large: 'Large', enterprise: 'Enterprise' };
  const maturityLabels = { 1: 'Initial', 2: 'Developing', 3: 'Defined', 4: 'Managed', 5: 'Optimizing' };

  // Badge colors: [bg, text] — light transparent backgrounds
  const maturityBadge = { 1: ['#fef2f2','#dc2626'], 2: ['#fff7ed','#ea580c'], 3: ['#eff6ff','#2563eb'], 4: ['#ecfdf5','#059669'], 5: ['#ecfdf5','#047857'] };
  const sectorBadge = { banking: ['#eff6ff','#1d4ed8'], financial: ['#eff6ff','#1d4ed8'], government: ['#eff6ff','#2563eb'], healthcare: ['#f0fdfa','#0d9488'], energy: ['#fffbeb','#b45309'], telecom: ['#f5f3ff','#7c3aed'], education: ['#ecfdf5','#059669'], retail: ['#fdf2f8','#db2777'], insurance: ['#eef2ff','#4f46e5'], technology: ['#f0f9ff','#0369a1'], defense: ['#f8fafc','#475569'], manufacturing: ['#fafaf9','#57534e'], transportation: ['#ecfeff','#0e7490'], custom: ['#f9fafb','#4b5563'], other: ['#f9fafb','#4b5563'] };
  const sectorAvatarColor = { banking: '#0077cc', financial: '#0077cc', government: '#2563eb', healthcare: '#0d9488', energy: '#d97706', telecom: '#8b5cf6', education: '#10b981', retail: '#ec4899', insurance: '#6366f1', technology: '#0284c7', defense: '#64748b', manufacturing: '#78716c', transportation: '#0891b2', custom: '#6b7280', other: '#6b7280' };

  el.innerHTML = list.map(ctx => {
    const origIdx = orgContexts.indexOf(ctx);
    const sectorDisplay = ctx.sectorCustom || sectorBadgeLabels[ctx.sector] || ctx.sector || '';
    const matLvl = ctx.complianceMaturity || 1;
    const [matBg, matFg] = maturityBadge[matLvl] || ['#f9fafb','#4b5563'];
    const [secBg, secFg] = sectorBadge[ctx.sector] || ['#f0fdfa','#0d9488'];
    const avatarColor = sectorAvatarColor[ctx.sector] || '#0d9488';

    // Framework pills: show max 2, then +N
    const fws = ctx.obligatoryFrameworks || [];
    const fwVisible = fws.slice(0, 2);
    const fwExtra = fws.length - 2;
    const fwHtml = fwVisible.map(f => `<span class="org-fw-pill">${esc(f.length > 18 ? f.substring(0,16) + '...' : f)}</span>`).join('') + (fwExtra > 0 ? `<span class="org-fw-pill org-fw-more">+${fwExtra}</span>` : '');

    // Doc count
    const docCount = (ctx.documents || []).length;

    // Build detail rows
    const govLabel = { centralized: 'Centralized', decentralized: 'Decentralized', federated: 'Federated', hybrid: 'Hybrid' };
    const detailPairs = [
      ctx.governanceStructure ? ['Governance', govLabel[ctx.governanceStructure] || ctx.governanceStructure] : null,
      ctx.dataClassification ? ['Data Classification', ctx.dataClassification] : null,
      ctx.geographicScope ? ['Geographic Scope', ctx.geographicScope] : null,
      ctx.itInfrastructure ? ['IT Infrastructure', ctx.itInfrastructure] : null,
    ].filter(Boolean);
    const allFwHtml = fws.map(f => `<span class="org-fw-pill">${esc(f)}</span>`).join('');
    const mandates = ctx.regulatoryMandates || [];
    const mandHtml = mandates.map(m => `<span class="org-fw-pill" style="color:#b45309;background:#fffbeb;border-color:#fde68a">${esc(m)}</span>`).join('');
    const objectives = ctx.strategicObjectives || [];
    const policies = ctx.policies || [];
    const policiesHtml = policies.map(p => {
      const name = typeof p === 'object' ? p.name : p;
      const refId = typeof p === 'object' && p.refId ? ` (${esc(p.refId)})` : '';
      return `<span class="org-fw-pill" style="color:#4338ca;background:#eef2ff;border-color:#c7d2fe">${esc(name)}${refId}</span>`;
    }).join('');
    const metrics = ctx.trackingMetrics || [];
    const metricsHtml = metrics.map(m => {
      const mName = typeof m === 'object' ? m.name : m;
      return `<span class="org-fw-pill" style="color:#047857;background:#ecfdf5;border-color:#a7f3d0">${esc(mName)}</span>`;
    }).join('');
    const riskScenarios = ctx.riskScenarios || [];
    const riskScenariosHtml = riskScenarios.map(r => {
      const rName = typeof r === 'object' ? r.name : r;
      return `<span class="org-fw-pill" style="color:#dc2626;background:#fef2f2;border-color:#fecaca">${esc(rName)}</span>`;
    }).join('');

    return `
      <div class="org-ctx-card" id="org-card-${origIdx}">
        <div class="org-ctx-header" onclick="toggleOrgContext(${origIdx})">
          <div class="org-ctx-header-left">
            <div class="org-ctx-avatar" style="background:${avatarColor}">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M4 16V6C4 5.4 4.4 5 5 5H9L10.5 3H15C15.6 3 16 3.4 16 4V16C16 16.6 15.6 17 15 17H5C4.4 17 4 16.6 4 16Z" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M7 10H13M7 13H10" stroke="white" stroke-width="1.3" stroke-linecap="round"/></svg>
            </div>
            <div class="org-ctx-names">
              <div class="org-ctx-name-row">
                <span class="org-ctx-name">${esc(ctx.nameEn || ctx.name)}</span>
                ${ctx.nameAr ? `<span class="org-ctx-name-ar">${esc(ctx.nameAr)}</span>` : ''}
              </div>
              <div class="org-ctx-tags">
                ${sectorDisplay ? `<span class="org-ctx-tag" style="background:${secBg};color:${secFg}">${esc(sectorDisplay)}</span>` : ''}
                ${ctx.size ? `<span class="org-ctx-tag org-ctx-tag-gray">${esc(sizeLabels[ctx.size] || ctx.size)}</span>` : ''}
                <span class="org-ctx-tag" style="background:${matBg};color:${matFg}">${maturityLabels[matLvl] || matLvl}</span>
              </div>
            </div>
          </div>
          <div class="org-ctx-right">
            <div class="org-ctx-fws">${fwHtml}</div>
            ${docCount > 0 ? `<span class="org-ctx-docs">${docCount} docs</span>` : ''}
            <button class="org-ctx-action-btn" onclick="event.stopPropagation();openOrgContextDetail(${origIdx})" title="Open">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2H12V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 2L7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 8V11C10 11.6 9.6 12 9 12H3C2.4 12 2 11.6 2 11V5C2 4.4 2.4 4 3 4H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            <button class="org-ctx-action-btn" onclick="event.stopPropagation();editOrgContext(${origIdx})" title="Edit">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="org-ctx-action-btn" onclick="event.stopPropagation();deleteOrgContext(${origIdx})" title="Delete">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <svg class="org-ctx-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </div>
        </div>
        <div class="org-ctx-expand">
          ${detailPairs.length ? `<div class="org-ctx-detail-grid">${detailPairs.map(([k,v]) => `<div class="org-ctx-detail-item"><span class="org-ctx-detail-label">${k}</span><span class="org-ctx-detail-value">${esc(v)}</span></div>`).join('')}</div>` : ''}
          ${fws.length ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Obligatory Frameworks</span><div class="org-ctx-detail-pills">${allFwHtml}</div></div>` : ''}
          ${mandates.length ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Regulatory Mandates</span><div class="org-ctx-detail-pills">${mandHtml}</div></div>` : ''}
          ${objectives.length ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Strategic Objectives</span><ul class="org-ctx-objectives">${objectives.map(o => `<li>${esc(o)}</li>`).join('')}</ul></div>` : ''}
          ${policies.length ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Policies</span><div class="org-ctx-detail-pills">${policiesHtml}</div></div>` : ''}
          ${metrics.length ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Tracking Metrics</span><div class="org-ctx-detail-pills">${metricsHtml}</div></div>` : ''}
          ${riskScenarios.length ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Risk Scenarios</span><div class="org-ctx-detail-pills">${riskScenariosHtml}</div></div>` : ''}
          ${ctx.notes ? `<div class="org-ctx-detail-section"><span class="org-ctx-detail-label">Notes</span><p class="org-ctx-notes-text">${esc(ctx.notes)}</p></div>` : ''}
        </div>
      </div>`;
  }).join('');
}
window.toggleOrgContext = function(idx) {
  const card = document.getElementById('org-card-' + idx);
  if (!card) return;
  card.classList.toggle('expanded');
};

// Org Context Modal
const orgModal = document.getElementById('org-modal-overlay');
const orgModalClose = document.getElementById('org-modal-close');
const orgModalCancel = document.getElementById('org-modal-cancel');
const orgModalSave = document.getElementById('org-modal-save');
const orgModalTitle = document.getElementById('org-modal-title');
let editingOrgIdx = null;

let grcFrameworksCache = null; // cached GRC frameworks for mandate checkboxes

async function populateMandatesFromFrameworks() {
  const container = document.getElementById('org-mandates-options');
  if (!container) return;

  // Show loading state
  container.innerHTML = '<span class="admin-form-hint" style="color:#9ca3af">Loading frameworks from GRC…</span>';

  // Fetch from GRC frameworks API (use cache if available)
  if (!grcFrameworksCache) {
    try {
      const d = await fetch('/api/grc/frameworks').then(r => r.json());
      if (d.success && Array.isArray(d.results)) {
        grcFrameworksCache = d.results;
      } else {
        grcFrameworksCache = [];
      }
    } catch (e) {
      console.error('GRC frameworks fetch error for mandates:', e);
      grcFrameworksCache = [];
    }
  }

  const fwList = grcFrameworksCache
    .filter(fw => fw.id || fw.uuid)
    .map(fw => ({ id: fw.id || fw.uuid, name: fw.name || fw.ref_id || '' }));

  if (!fwList.length) {
    container.innerHTML = '<span class="admin-form-hint" style="color:#9ca3af">No frameworks loaded. Please check your connection.</span>';
    return;
  }
  container.innerHTML = fwList.map(fw =>
    `<label class="mandate-chip-option"><input type="checkbox" value="${esc(fw.id)}" data-name="${esc(fw.name)}" onchange="renderObjFwMappingGrid()"> ${esc(fw.name)}</label>`
  ).join('');
}

async function openOrgModal() {
  await populateMandatesFromFrameworks();
  orgModal.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Fetch GRC objectives if not cached
  if (!grcObjectivesCache) {
    const labelEl = document.getElementById('org-objectives-label');
    if (labelEl) labelEl.textContent = 'Loading objectives…';
    await fetchGrcObjectives();
  }
  // Render checkboxes (editOrgContext will call with selectedIds separately)
  if (editingOrgIdx === null) {
    renderObjectivesCheckboxes([]);
  }
  // Close dropdown by default
  const dd = document.getElementById('org-objectives-dropdown');
  if (dd) dd.classList.remove('open');

  // Fetch GRC policies if not cached
  if (!grcPoliciesCache) {
    const polLabel = document.getElementById('org-policies-label');
    if (polLabel) polLabel.textContent = 'Loading policies…';
    await fetchGrcPolicies();
  }
  if (editingOrgIdx === null) {
    renderPoliciesCheckboxes([]);
  }
  const polDd = document.getElementById('org-policies-dropdown');
  if (polDd) polDd.classList.remove('open');

  // Fetch GRC metrics if not cached
  if (!grcMetricsCache) {
    const metLabel = document.getElementById('org-metrics-label');
    if (metLabel) metLabel.textContent = 'Loading metrics…';
    await fetchGrcMetrics();
  }
  if (editingOrgIdx === null) {
    renderMetricsCheckboxes([]);
  }
  const metDd = document.getElementById('org-metrics-dropdown');
  if (metDd) metDd.classList.remove('open');

  // Fetch GRC risk scenarios if not cached
  if (!grcRiskScenariosCache) {
    const rsLabel = document.getElementById('org-risk-scenarios-label');
    if (rsLabel) rsLabel.textContent = 'Loading risk scenarios…';
    await fetchGrcRiskScenarios();
  }
  if (editingOrgIdx === null) {
    renderRiskScenariosCheckboxes([]);
  }
  const rsDd = document.getElementById('org-risk-scenarios-dropdown');
  if (rsDd) rsDd.classList.remove('open');
}
function closeOrgModal() { orgModal.classList.remove('active'); document.body.style.overflow = ''; editingOrgIdx = null; clearOrgForm(); }
let orgObjectives = []; // temp state for objectives list (now stores {id, name} objects)
let grcObjectivesCache = null; // cache fetched GRC objectives

async function fetchGrcObjectives() {
  try {
    const res = await fetch('/api/grc/organisation-objectives');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    grcObjectivesCache = (data.results || []).map(o => ({ id: o.id, name: o.name, description: o.description || '' }));
    return grcObjectivesCache;
  } catch (err) {
    console.error('Failed to fetch GRC objectives:', err);
    grcObjectivesCache = [];
    return [];
  }
}

function renderObjectivesCheckboxes(selectedIds = []) {
  const labelEl = document.getElementById('org-objectives-label');
  const optionsEl = document.getElementById('org-objectives-options');
  if (!optionsEl) return;

  if (!grcObjectivesCache || grcObjectivesCache.length === 0) {
    if (labelEl) labelEl.textContent = 'No objectives available';
    optionsEl.innerHTML = '';
    return;
  }

  optionsEl.innerHTML = grcObjectivesCache.map(obj => {
    const checked = selectedIds.includes(obj.id) ? 'checked' : '';
    return `<label>
      <input type="checkbox" value="${esc(obj.id)}" ${checked} onchange="updateObjectivesLabel()">
      <span><strong>${esc(obj.name)}</strong>${obj.description ? '<br><span style="font-size:10px;color:#9ca3af">' + esc(obj.description) + '</span>' : ''}</span>
    </label>`;
  }).join('');

  updateObjectivesLabel();
}

function toggleObjectivesDropdown() {
  const dd = document.getElementById('org-objectives-dropdown');
  if (dd) dd.classList.toggle('open');
}
window.toggleObjectivesDropdown = toggleObjectivesDropdown;

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  const dd = document.getElementById('org-objectives-dropdown');
  if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

function updateObjectivesLabel() {
  const labelEl = document.getElementById('org-objectives-label');
  const chipsEl = document.getElementById('org-objectives-chips');
  const checkboxes = document.querySelectorAll('#org-objectives-options input[type="checkbox"]:checked');
  const count = checkboxes.length;

  if (labelEl) {
    if (count === 0) {
      labelEl.textContent = 'Select objectives…';
      labelEl.classList.remove('has-selection');
    } else {
      labelEl.textContent = `${count} objective${count > 1 ? 's' : ''} selected`;
      labelEl.classList.add('has-selection');
    }
  }

  // Render chips
  if (chipsEl) {
    if (count === 0) {
      chipsEl.innerHTML = '';
    } else {
      chipsEl.innerHTML = Array.from(checkboxes).map(cb => {
        const obj = grcObjectivesCache?.find(o => o.id === cb.value);
        if (!obj) return '';
        return `<span class="multiselect-chip">
          ${esc(obj.name)}
          <button type="button" class="multiselect-chip-remove" onclick="removeObjectiveById('${esc(obj.id)}')">&times;</button>
        </span>`;
      }).join('');
    }
  }
  // Re-render Objective ↔ Framework mapping grid when objectives change
  renderObjFwMappingGrid();
}
window.updateObjectivesLabel = updateObjectivesLabel;

function removeObjectiveById(id) {
  const cb = document.querySelector(`#org-objectives-options input[value="${id}"]`);
  if (cb) { cb.checked = false; updateObjectivesLabel(); }
}
window.removeObjectiveById = removeObjectiveById;

function getSelectedObjectives() {
  // Returns UUID array for chain resolution
  const checkboxes = document.querySelectorAll('#org-objectives-options input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value).filter(Boolean);
}

function getSelectedObjectiveIds() {
  const checkboxes = document.querySelectorAll('#org-objectives-options input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ── Policies (from GRC applied-controls) ──
let grcPoliciesCache = null;

async function fetchGrcPolicies() {
  try {
    const res = await fetch('/api/grc/policies');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    grcPoliciesCache = (data.results || []).map(p => ({
      id: p.id,
      name: p.name || '',
      refId: p.ref_id || '',
      description: p.description || p.observation || '',
      category: p.category || '',
      status: p.status || '',
      csfFunction: p.csf_function || '',
      folder: p.folder ? (p.folder.str || '') : '',
    }));
    return grcPoliciesCache;
  } catch (err) {
    console.error('Failed to fetch GRC policies:', err);
    grcPoliciesCache = [];
    return [];
  }
}

function renderPoliciesCheckboxes(selectedIds = []) {
  const labelEl = document.getElementById('org-policies-label');
  const optionsEl = document.getElementById('org-policies-options');
  if (!optionsEl) return;

  if (!grcPoliciesCache || grcPoliciesCache.length === 0) {
    if (labelEl) labelEl.textContent = 'No policies available';
    optionsEl.innerHTML = '';
    return;
  }

  optionsEl.innerHTML = grcPoliciesCache.map(pol => {
    const checked = selectedIds.includes(pol.id) ? 'checked' : '';
    const badge = pol.refId ? `<span style="color:#6b7280;font-size:10px;margin-left:4px">${esc(pol.refId)}</span>` : '';
    return `<label>
      <input type="checkbox" value="${esc(pol.id)}" ${checked} onchange="updatePoliciesLabel()">
      <span>${esc(pol.name)}${badge}</span>
    </label>`;
  }).join('');

  updatePoliciesLabel();
}

function togglePoliciesDropdown() {
  const dd = document.getElementById('org-policies-dropdown');
  if (dd) dd.classList.toggle('open');
}
window.togglePoliciesDropdown = togglePoliciesDropdown;

// Close policies dropdown when clicking outside
document.addEventListener('click', e => {
  const dd = document.getElementById('org-policies-dropdown');
  if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

function filterPoliciesDropdown(query) {
  const q = (query || '').toLowerCase();
  const options = document.querySelectorAll('#org-policies-options label');
  options.forEach(lbl => {
    const text = lbl.textContent.toLowerCase();
    lbl.style.display = text.includes(q) ? '' : 'none';
  });
}
window.filterPoliciesDropdown = filterPoliciesDropdown;

function updatePoliciesLabel() {
  const labelEl = document.getElementById('org-policies-label');
  const chipsEl = document.getElementById('org-policies-chips');
  const checkboxes = document.querySelectorAll('#org-policies-options input[type="checkbox"]:checked');
  const count = checkboxes.length;

  if (labelEl) {
    labelEl.textContent = count === 0 ? 'Select policies…' : `${count} polic${count === 1 ? 'y' : 'ies'} selected`;
  }

  if (chipsEl) {
    if (count === 0) {
      chipsEl.innerHTML = '';
    } else {
      chipsEl.innerHTML = Array.from(checkboxes).map(cb => {
        const pol = grcPoliciesCache?.find(p => p.id === cb.value);
        if (!pol) return '';
        return `<span class="multiselect-chip">
          ${esc(pol.name)}
          <button type="button" onclick="removePolicyById('${esc(pol.id)}')" class="multiselect-chip-remove">&times;</button>
        </span>`;
      }).join('');
    }
  }
}
window.updatePoliciesLabel = updatePoliciesLabel;

function removePolicyById(id) {
  const cb = document.querySelector(`#org-policies-options input[value="${id}"]`);
  if (cb) { cb.checked = false; updatePoliciesLabel(); }
}
window.removePolicyById = removePolicyById;

function getSelectedPolicies() {
  const checkboxes = document.querySelectorAll('#org-policies-options input[type="checkbox"]:checked');
  const selected = [];
  checkboxes.forEach(cb => {
    const pol = grcPoliciesCache?.find(p => p.id === cb.value);
    if (pol) selected.push({ id: pol.id, name: pol.name, refId: pol.refId });
  });
  return selected;
}

function getSelectedPolicyIds() {
  const checkboxes = document.querySelectorAll('#org-policies-options input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ── Tracking Metrics (from GRC metric-instances) ──
let grcMetricsCache = null;

async function fetchGrcMetrics() {
  try {
    const res = await fetch('/api/grc/metric-instances');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    grcMetricsCache = (data.results || []).map(m => ({
      id: m.id,
      name: m.name || '',
      description: m.description || '',
      value: m.value != null ? m.value : '',
      target: m.target != null ? m.target : '',
      result: m.result || '',
    }));
    return grcMetricsCache;
  } catch (err) {
    console.error('Failed to fetch GRC metrics:', err);
    grcMetricsCache = [];
    return [];
  }
}

function renderMetricsCheckboxes(selectedIds = []) {
  const labelEl = document.getElementById('org-metrics-label');
  const optionsEl = document.getElementById('org-metrics-options');
  if (!optionsEl) return;

  if (!grcMetricsCache || grcMetricsCache.length === 0) {
    if (labelEl) labelEl.textContent = 'No metrics available';
    optionsEl.innerHTML = '';
    return;
  }

  optionsEl.innerHTML = grcMetricsCache.map(m => {
    const checked = selectedIds.includes(m.id) ? 'checked' : '';
    const desc = m.description ? `<br><span style="font-size:10px;color:#9ca3af">${esc(m.description)}</span>` : '';
    return `<label>
      <input type="checkbox" value="${esc(m.id)}" ${checked} onchange="updateMetricsLabel()">
      <span><strong>${esc(m.name)}</strong>${desc}</span>
    </label>`;
  }).join('');

  updateMetricsLabel();
}

function toggleMetricsDropdown() {
  const dd = document.getElementById('org-metrics-dropdown');
  if (dd) dd.classList.toggle('open');
}
window.toggleMetricsDropdown = toggleMetricsDropdown;

// Close metrics dropdown when clicking outside
document.addEventListener('click', e => {
  const dd = document.getElementById('org-metrics-dropdown');
  if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

function filterMetricsDropdown(query) {
  const q = (query || '').toLowerCase();
  const options = document.querySelectorAll('#org-metrics-options label');
  options.forEach(lbl => {
    const text = lbl.textContent.toLowerCase();
    lbl.style.display = text.includes(q) ? '' : 'none';
  });
}
window.filterMetricsDropdown = filterMetricsDropdown;

function updateMetricsLabel() {
  const labelEl = document.getElementById('org-metrics-label');
  const chipsEl = document.getElementById('org-metrics-chips');
  const checkboxes = document.querySelectorAll('#org-metrics-options input[type="checkbox"]:checked');
  const count = checkboxes.length;

  if (labelEl) {
    labelEl.textContent = count === 0 ? 'Select metrics…' : `${count} metric${count > 1 ? 's' : ''} selected`;
  }

  if (chipsEl) {
    if (count === 0) {
      chipsEl.innerHTML = '';
    } else {
      chipsEl.innerHTML = Array.from(checkboxes).map(cb => {
        const m = grcMetricsCache?.find(met => met.id === cb.value);
        if (!m) return '';
        return `<span class="multiselect-chip">
          ${esc(m.name)}
          <button type="button" onclick="removeMetricById('${esc(m.id)}')" class="multiselect-chip-remove">&times;</button>
        </span>`;
      }).join('');
    }
  }
}
window.updateMetricsLabel = updateMetricsLabel;

function removeMetricById(id) {
  const cb = document.querySelector(`#org-metrics-options input[value="${id}"]`);
  if (cb) { cb.checked = false; updateMetricsLabel(); }
}
window.removeMetricById = removeMetricById;

function getSelectedMetrics() {
  const checkboxes = document.querySelectorAll('#org-metrics-options input[type="checkbox"]:checked');
  const selected = [];
  checkboxes.forEach(cb => {
    const m = grcMetricsCache?.find(met => met.id === cb.value);
    if (m) selected.push({ id: m.id, name: m.name });
  });
  return selected;
}

function getSelectedMetricIds() {
  const checkboxes = document.querySelectorAll('#org-metrics-options input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ── Risk Scenarios (from GRC risk-scenarios) ──
let grcRiskScenariosCache = null;

async function fetchGrcRiskScenarios() {
  try {
    const res = await fetch('/api/grc/risk-scenarios/');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    grcRiskScenariosCache = (data.results || []).map(r => ({
      id: r.id,
      name: r.name || '',
      description: r.description || '',
      treatment: r.treatment || '',
      ref_id: r.ref_id || '',
    }));
    return grcRiskScenariosCache;
  } catch (err) {
    console.error('Failed to fetch GRC risk scenarios:', err);
    grcRiskScenariosCache = [];
    return [];
  }
}

function renderRiskScenariosCheckboxes(selectedIds = []) {
  const labelEl = document.getElementById('org-risk-scenarios-label');
  const optionsEl = document.getElementById('org-risk-scenarios-options');
  if (!optionsEl) return;

  if (!grcRiskScenariosCache || grcRiskScenariosCache.length === 0) {
    if (labelEl) labelEl.textContent = 'No risk scenarios available';
    optionsEl.innerHTML = '';
    return;
  }

  optionsEl.innerHTML = grcRiskScenariosCache.map(r => {
    const checked = selectedIds.includes(r.id) ? 'checked' : '';
    const desc = r.description ? `<br><span style="font-size:10px;color:#9ca3af">${esc(r.description)}</span>` : '';
    const treat = r.treatment ? `<br><span style="font-size:10px;color:#6b7280">Treatment: ${esc(r.treatment)}</span>` : '';
    return `<label>
      <input type="checkbox" value="${esc(r.id)}" ${checked} onchange="updateRiskScenariosLabel()">
      <span><strong>${esc(r.name)}</strong>${desc}${treat}</span>
    </label>`;
  }).join('');

  updateRiskScenariosLabel();
}

function toggleRiskScenariosDropdown() {
  const dd = document.getElementById('org-risk-scenarios-dropdown');
  if (dd) dd.classList.toggle('open');
}
window.toggleRiskScenariosDropdown = toggleRiskScenariosDropdown;

// Close risk scenarios dropdown when clicking outside
document.addEventListener('click', e => {
  const dd = document.getElementById('org-risk-scenarios-dropdown');
  if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

function filterRiskScenariosDropdown(query) {
  const q = (query || '').toLowerCase();
  const options = document.querySelectorAll('#org-risk-scenarios-options label');
  options.forEach(lbl => {
    const text = lbl.textContent.toLowerCase();
    lbl.style.display = text.includes(q) ? '' : 'none';
  });
}
window.filterRiskScenariosDropdown = filterRiskScenariosDropdown;

function updateRiskScenariosLabel() {
  const labelEl = document.getElementById('org-risk-scenarios-label');
  const chipsEl = document.getElementById('org-risk-scenarios-chips');
  const checkboxes = document.querySelectorAll('#org-risk-scenarios-options input[type="checkbox"]:checked');
  const count = checkboxes.length;

  if (labelEl) {
    labelEl.textContent = count === 0 ? 'Select risk scenarios…' : `${count} risk scenario${count > 1 ? 's' : ''} selected`;
  }

  if (chipsEl) {
    if (count === 0) {
      chipsEl.innerHTML = '';
    } else {
      chipsEl.innerHTML = Array.from(checkboxes).map(cb => {
        const r = grcRiskScenariosCache?.find(rs => rs.id === cb.value);
        if (!r) return '';
        return `<span class="multiselect-chip">
          ${esc(r.name)}
          <button type="button" onclick="removeRiskScenarioById('${esc(r.id)}')" class="multiselect-chip-remove">&times;</button>
        </span>`;
      }).join('');
    }
  }
}
window.updateRiskScenariosLabel = updateRiskScenariosLabel;

function removeRiskScenarioById(id) {
  const cb = document.querySelector(`#org-risk-scenarios-options input[value="${id}"]`);
  if (cb) { cb.checked = false; updateRiskScenariosLabel(); }
}
window.removeRiskScenarioById = removeRiskScenarioById;

function getSelectedRiskScenarios() {
  // Returns UUID array for chain resolution
  const checkboxes = document.querySelectorAll('#org-risk-scenarios-options input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value).filter(Boolean);
}

function getSelectedRiskScenarioIds() {
  const checkboxes = document.querySelectorAll('#org-risk-scenarios-options input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// ── Objective ↔ Framework Mapping ──
let _objFwMapState = {}; // { objUuid: [fwUuid, ...] }

function renderObjFwMappingGrid() {
  const section = document.getElementById('obj-fw-mapping-section');
  const grid = document.getElementById('obj-fw-mapping-grid');
  if (!section || !grid) return;

  const objIds = getSelectedObjectives();
  const fwCbs = document.querySelectorAll('#org-mandates-options input[type="checkbox"]:checked');
  const fws = Array.from(fwCbs).map(cb => ({
    id: cb.value,
    name: cb.getAttribute('data-name') || cb.parentElement?.textContent?.trim() || cb.value
  }));

  if (objIds.length === 0 || fws.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const objs = objIds.map(id => {
    const cached = (grcObjectivesCache || []).find(o => o.id === id);
    return { id, name: cached ? cached.name : id.substring(0, 8) + '…' };
  });

  let html = '<table class="obj-fw-map-table"><thead><tr><th>Objective</th>';
  fws.forEach(fw => { html += `<th title="${esc(fw.name)}">${esc(fw.name.length > 20 ? fw.name.substring(0, 18) + '…' : fw.name)}</th>`; });
  html += '</tr></thead><tbody>';

  objs.forEach(obj => {
    html += `<tr><td title="${esc(obj.name)}">${esc(obj.name.length > 30 ? obj.name.substring(0, 28) + '…' : obj.name)}</td>`;
    fws.forEach(fw => {
      const checked = (_objFwMapState[obj.id] || []).includes(fw.id) ? 'checked' : '';
      html += `<td style="text-align:center"><input type="checkbox" ${checked} data-obj="${esc(obj.id)}" data-fw="${esc(fw.id)}" onchange="updateObjFwMap(this)" /></td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  grid.innerHTML = html;
}

function updateObjFwMap(cb) {
  const objId = cb.getAttribute('data-obj');
  const fwId = cb.getAttribute('data-fw');
  if (!_objFwMapState[objId]) _objFwMapState[objId] = [];
  if (cb.checked) {
    if (!_objFwMapState[objId].includes(fwId)) _objFwMapState[objId].push(fwId);
  } else {
    _objFwMapState[objId] = _objFwMapState[objId].filter(f => f !== fwId);
  }
}
window.updateObjFwMap = updateObjFwMap;
window.renderObjFwMappingGrid = renderObjFwMappingGrid;

function getObjectiveFrameworkMap() {
  // Clean: remove empty arrays
  const clean = {};
  for (const [k, v] of Object.entries(_objFwMapState)) {
    if (Array.isArray(v) && v.length > 0) clean[k] = v;
  }
  return clean;
}

// ── Add Objective Modal ──
const addObjModal = document.getElementById('add-obj-modal-overlay');

async function openAddObjectiveModal() {
  if (!addObjModal) return;
  addObjModal.classList.add('active');
  document.getElementById('add-obj-name').value = '';

  // Fetch folders for the select
  const folderSelect = document.getElementById('add-obj-folder');
  folderSelect.innerHTML = '<option value="">Loading folders…</option>';
  try {
    const res = await fetch('/api/grc/folders?content_type=DO&content_type=GL');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const folders = data.folders || data.results || [];
    if (folders.length === 0) {
      folderSelect.innerHTML = '<option value="">No folders available</option>';
    } else {
      folderSelect.innerHTML = '<option value="">Select a folder…</option>' +
        folders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    }
  } catch (err) {
    console.error('Failed to fetch folders:', err);
    folderSelect.innerHTML = '<option value="">Error loading folders</option>';
  }
  document.getElementById('add-obj-name').focus();
}
window.openAddObjectiveModal = openAddObjectiveModal;

function closeAddObjectiveModal() {
  if (addObjModal) addObjModal.classList.remove('active');
}
window.closeAddObjectiveModal = closeAddObjectiveModal;

async function saveNewObjective() {
  const name = document.getElementById('add-obj-name').value.trim();
  const folder = document.getElementById('add-obj-folder').value;

  if (!name) {
    toast('error', 'Validation', 'Name is required.');
    document.getElementById('add-obj-name').focus();
    return;
  }
  if (!folder) {
    toast('error', 'Validation', 'Please select a folder.');
    document.getElementById('add-obj-folder').focus();
    return;
  }

  const saveBtn = document.getElementById('add-obj-save');
  saveBtn.disabled = true;
  try {
    const res = await fetch('/api/grc/organisation-objectives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || 'HTTP ' + res.status);
    }
    const data = await res.json();
    toast('success', 'Created', `Objective "${name}" created in GRC.`);
    closeAddObjectiveModal();

    // Refresh the objectives cache and re-render checkboxes
    grcObjectivesCache = null;
    await fetchGrcObjectives();
    // Preserve any currently checked items
    const currentlySelected = getSelectedObjectiveIds();
    // Auto-select the newly created objective
    const newId = data.result?.id;
    if (newId && !currentlySelected.includes(newId)) currentlySelected.push(newId);
    renderObjectivesCheckboxes(currentlySelected);
  } catch (err) {
    console.error('Create objective error:', err);
    toast('error', 'Failed', err.message);
  } finally {
    saveBtn.disabled = false;
  }
}
window.saveNewObjective = saveNewObjective;

// Close modal on Escape / overlay click
if (addObjModal) {
  addObjModal.addEventListener('click', e => { if (e.target === addObjModal) closeAddObjectiveModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && addObjModal.classList.contains('active')) closeAddObjectiveModal(); });
}

function clearOrgForm() {
  document.getElementById('org-name-en').value = '';
  document.getElementById('org-name-ar').value = '';
  document.getElementById('org-sector').value = '';
  document.getElementById('org-sector-custom').value = '';
  document.getElementById('org-sector-custom-row').style.display = 'none';
  document.getElementById('org-size').value = '';
  document.getElementById('org-maturity').value = 1;
  updateMaturityLabels(1);
  document.querySelectorAll('#org-mandates-options input[type="checkbox"]').forEach(c => c.checked = false);
  document.getElementById('org-governance').value = '';
  document.getElementById('org-data-classification').value = '';
  document.getElementById('org-geographic').value = '';
  document.getElementById('org-it-infra').value = '';
  orgObjectives = [];
  renderObjectivesCheckboxes([]);
  renderPoliciesCheckboxes([]);
  renderMetricsCheckboxes([]);
  renderRiskScenariosCheckboxes([]);
  _objFwMapState = {};
  const mapSection = document.getElementById('obj-fw-mapping-section');
  if (mapSection) mapSection.style.display = 'none';
  document.getElementById('org-notes').value = '';
}

function updateMaturityLabels(val) {
  document.querySelectorAll('.maturity-labels span').forEach(s => {
    s.classList.toggle('active', s.dataset.val === String(val));
  });
}

// Maturity slider
document.getElementById('org-maturity')?.addEventListener('input', e => updateMaturityLabels(e.target.value));

// Sector "custom" toggle
document.getElementById('org-sector')?.addEventListener('change', e => {
  document.getElementById('org-sector-custom-row').style.display = e.target.value === 'custom' ? '' : 'none';
});

document.getElementById('btn-new-context').addEventListener('click', () => {
  editingOrgIdx = null;
  orgModalTitle.textContent = 'New Organization Context';
  orgModalSave.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Create Context';
  clearOrgForm();
  openOrgModal();
  document.getElementById('org-name-en').focus();
});

orgModalClose.addEventListener('click', closeOrgModal);
orgModalCancel.addEventListener('click', closeOrgModal);
orgModal.addEventListener('click', e => { if (e.target === orgModal) closeOrgModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && orgModal.classList.contains('active')) closeOrgModal(); });

orgModalSave.addEventListener('click', async () => {
  const nameEn = document.getElementById('org-name-en').value.trim();
  const nameAr = document.getElementById('org-name-ar').value.trim();
  const sector = document.getElementById('org-sector').value;
  const sectorCustom = document.getElementById('org-sector-custom').value.trim();
  const size = document.getElementById('org-size').value;
  const maturity = parseInt(document.getElementById('org-maturity').value) || 1;
  const mandates = [];
  const frameworkUuids = []; // UUIDs for chain resolution
  const frameworkNames = []; // Names for display / regulatory mandates
  document.querySelectorAll('#org-mandates-options input[type="checkbox"]:checked').forEach(c => {
    mandates.push(c.value); // value is now a UUID
    frameworkUuids.push(c.value);
    const fwName = c.getAttribute('data-name') || c.parentElement?.textContent?.trim() || c.value;
    frameworkNames.push(fwName);
  });
  const governance = document.getElementById('org-governance').value;
  const dataCls = document.getElementById('org-data-classification').value;
  const geo = document.getElementById('org-geographic').value;
  const itInfra = document.getElementById('org-it-infra').value;
  const notes = document.getElementById('org-notes').value.trim();

  if (!nameEn) { toast('error', 'Validation', 'Name (English) is required.'); document.getElementById('org-name-en').focus(); return; }
  if (!sector) { toast('error', 'Validation', 'Industry vertical is required.'); document.getElementById('org-sector').focus(); return; }
  if (!size) { toast('error', 'Validation', 'Entity size is required.'); document.getElementById('org-size').focus(); return; }

  const body = {
    nameEn,
    nameAr,
    sector,
    sectorCustom: sector === 'custom' ? sectorCustom : '',
    size,
    complianceMaturity: maturity,
    regulatoryMandates: frameworkNames, // Display names for backward compat
    governanceStructure: governance,
    dataClassification: dataCls,
    geographicScope: geo,
    itInfrastructure: itInfra,
    strategicObjectives: getSelectedObjectives(), // UUID array
    obligatoryFrameworks: frameworkUuids,          // UUID array
    policies: getSelectedPolicies(),
    trackingMetrics: getSelectedMetrics(),
    riskScenarios: getSelectedRiskScenarios(),     // UUID array
    objectiveFrameworkMap: getObjectiveFrameworkMap(), // Objective → Framework mapping
    notes,
    isActive: true,
  };

  orgModalSave.disabled = true;
  try {
    let r;
    if (editingOrgIdx !== null) {
      const id = orgContexts[editingOrgIdx].id;
      r = await fetch(API.orgContexts + '/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      r = await fetch(API.orgContexts, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + r.status); }

    toast('success', editingOrgIdx !== null ? 'Updated' : 'Created', 'Context "' + nameEn + '" saved.');
    closeOrgModal();
    await loadOrgContexts();
  } catch (e) {
    console.error('Save org profile error:', e);
    toast('error', 'Save Failed', e.message);
  } finally {
    orgModalSave.disabled = false;
  }
});

// Edit org profile
async function editOrgContext(idx) {
  const ctx = orgContexts[idx];
  if (!ctx) return;
  editingOrgIdx = idx;
  orgModalTitle.textContent = 'Edit Organization Context';
  orgModalSave.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7L6 10L11 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Save Changes';
  document.getElementById('org-name-en').value = ctx.nameEn || ctx.name || '';
  document.getElementById('org-name-ar').value = ctx.nameAr || '';
  document.getElementById('org-sector').value = ctx.sector || '';
  document.getElementById('org-sector-custom').value = ctx.sectorCustom || '';
  document.getElementById('org-sector-custom-row').style.display = ctx.sector === 'custom' ? '' : 'none';
  document.getElementById('org-size').value = ctx.size || '';
  document.getElementById('org-maturity').value = ctx.complianceMaturity || 1;
  updateMaturityLabels(ctx.complianceMaturity || 1);
  document.getElementById('org-governance').value = ctx.governanceStructure || '';
  document.getElementById('org-data-classification').value = ctx.dataClassification || '';
  document.getElementById('org-geographic').value = ctx.geographicScope || '';
  document.getElementById('org-it-infra').value = ctx.itInfrastructure || '';
  document.getElementById('org-notes').value = ctx.notes || '';
  await openOrgModal(); // populates mandate checkboxes from frameworks first + fetches objectives

  // Pre-select saved objectives (supports both UUID array and legacy name array)
  const savedObjs = ctx.strategicObjectives || [];
  const objSelectedIds = savedObjs.map(v => {
    if (typeof v === 'string' && v.includes('-')) return v; // Already a UUID
    // Legacy: match by name → id
    const match = (grcObjectivesCache || []).find(o => o.name === v);
    return match ? match.id : null;
  }).filter(Boolean);
  renderObjectivesCheckboxes(objSelectedIds);

  // Now set mandates/frameworks checkboxes (supports both UUID and legacy name)
  const savedFws = ctx.obligatoryFrameworks || [];
  const savedMandates = ctx.regulatoryMandates || [];
  document.querySelectorAll('#org-mandates-options input[type="checkbox"]').forEach(c => {
    const fwName = c.getAttribute('data-name') || '';
    // Match by UUID (new format) or by name (old format)
    c.checked = savedFws.includes(c.value) || savedMandates.includes(c.value) || savedMandates.includes(fwName);
  });

  // Pre-select saved policies by matching id
  const savedPolicies = ctx.policies || [];
  const savedPolicyIds = savedPolicies.map(p => typeof p === 'object' ? p.id : p).filter(Boolean);
  renderPoliciesCheckboxes(savedPolicyIds);

  // Pre-select saved metrics by matching id or name → id
  const savedMetrics = ctx.trackingMetrics || [];
  const savedMetricIds = savedMetrics.map(m => typeof m === 'object' ? m.id : m).filter(Boolean);
  // Also match by name if stored as strings
  const metricIdsByName = (grcMetricsCache || [])
    .filter(met => savedMetrics.includes(met.name))
    .map(met => met.id);
  const allMetricIds = [...new Set([...savedMetricIds, ...metricIdsByName])];
  renderMetricsCheckboxes(allMetricIds);

  // Pre-select saved risk scenarios (supports UUID array, {id,name} objects, and legacy name strings)
  const savedRiskScenarios = ctx.riskScenarios || [];
  const rsSelectedIds = savedRiskScenarios.map(r => {
    if (typeof r === 'object' && r.id) return r.id; // Legacy {id, name} object
    if (typeof r === 'string' && r.includes('-')) return r; // UUID
    // Legacy: match by name → id
    const match = (grcRiskScenariosCache || []).find(rs => rs.name === r);
    return match ? match.id : null;
  }).filter(Boolean);
  renderRiskScenariosCheckboxes(rsSelectedIds);

  // Restore Objective ↔ Framework mapping
  _objFwMapState = ctx.objectiveFrameworkMap || {};
  renderObjFwMappingGrid();

  document.getElementById('org-name-en').focus();
}
window.editOrgContext = editOrgContext;

// Delete org profile
async function deleteOrgContext(idx) {
  const ctx = orgContexts[idx];
  if (!ctx) return;
  if (!await showConfirm({ title: 'Delete Profile', message: `Delete "${ctx.nameEn || ctx.name}"? Any Controls Studio sessions using this profile will lose their org context.`, confirmText: 'Delete' })) return;
  try {
    const r = await fetch(API.orgContexts + '/' + ctx.id, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'HTTP ' + r.status); }
    toast('success', 'Deleted', 'Context deleted.');
    await loadOrgContexts();
  } catch (e) {
    console.error('Delete org context error:', e);
    toast('error', 'Delete Failed', e.message);
  }
}
window.deleteOrgContext = deleteOrgContext;

// ─── Org Context Detail Page ─────────────────────────────────
let orgDetailCtxId = null;

async function openOrgContextDetail(idx) {
  const ctx = orgContexts[idx];
  if (!ctx) return;
  orgDetailCtxId = ctx.id;
  updateRoute('org-contexts', ctx.id);
  await renderOrgContextDetail(ctx, idx);
}
window.openOrgContextDetail = openOrgContextDetail;

function orgBackToList() {
  orgDetailCtxId = null;
  updateRoute('org-contexts', null);
  // Show list UI, hide detail
  const container = document.getElementById('page-org-contexts').querySelector('.page-container');
  container.querySelectorAll('.org-detail-page').forEach(el => el.remove());
  container.querySelectorAll('.org-list-section').forEach(el => el.style.display = '');
  // Also show the header
  const hdr = container.querySelector('.page-header');
  if (hdr) hdr.style.display = '';
}
window.orgBackToList = orgBackToList;

async function renderOrgContextDetail(ctx, idx) {
  const container = document.getElementById('page-org-contexts').querySelector('.page-container');

  // Pre-fetch GRC caches in parallel for UUID → name resolution
  await Promise.all([
    !grcFrameworksCache ? fetch('/api/grc/frameworks').then(r => r.json()).then(d => { grcFrameworksCache = (d.success && Array.isArray(d.results)) ? d.results : []; }).catch(() => { grcFrameworksCache = []; }) : Promise.resolve(),
    !grcObjectivesCache ? fetchGrcObjectives() : Promise.resolve(),
    !grcRiskScenariosCache ? fetchGrcRiskScenarios() : Promise.resolve(),
  ]);

  // Hide list sections
  const header = container.querySelector('.page-header');
  if (header) header.style.display = 'none';
  container.querySelectorAll('.org-stats-grid, .admin-search-bar, #org-contexts-list').forEach(el => {
    el.classList.add('org-list-section');
    el.style.display = 'none';
  });
  // Remove old detail if any
  container.querySelectorAll('.org-detail-page').forEach(el => el.remove());

  const sectorLabels = { banking: 'Banking & Financial Services', financial: 'Financial', government: 'Government', healthcare: 'Healthcare', energy: 'Energy & Utilities', telecom: 'Telecommunications', education: 'Education', retail: 'Retail & E-Commerce', insurance: 'Insurance', technology: 'Technology', defense: 'Defense & Military', manufacturing: 'Manufacturing', transportation: 'Transportation & Logistics', custom: 'Custom', other: 'Other' };
  const sizeLabels = { small: 'Small', medium: 'Medium', large: 'Large', enterprise: 'Enterprise' };
  const govLabel = { centralized: 'Centralized', decentralized: 'Decentralized', federated: 'Federated', hybrid: 'Hybrid' };
  const matLabels = { 1: 'Initial', 2: 'Developing', 3: 'Defined', 4: 'Managed', 5: 'Optimizing' };

  const name = ctx.nameEn || ctx.name || 'Untitled';
  const nameAr = ctx.nameAr || '';
  const sector = ctx.sectorCustom || sectorLabels[ctx.sector] || ctx.sector || '—';
  const size = sizeLabels[ctx.size] || ctx.size || '—';
  const maturity = ctx.complianceMaturity || 1;
  const gov = govLabel[ctx.governanceStructure] || ctx.governanceStructure || '—';
  const dataCls = ctx.dataClassification || '—';
  const geo = ctx.geographicScope || '—';
  const itInfra = ctx.itInfrastructure || '—';
  const fws = ctx.obligatoryFrameworks || [];
  const mandates = ctx.regulatoryMandates || [];
  const objectives = ctx.strategicObjectives || [];
  const policies = ctx.policies || [];
  const trackingMetrics = ctx.trackingMetrics || [];
  const riskScenarios = ctx.riskScenarios || [];
  const docs = ctx.documents || [];
  const notes = ctx.notes || '';

  // Resolve UUIDs to names for display (falls back to raw value if not a UUID)
  const resolveUuid = (val, cache) => {
    if (typeof val === 'object' && val.name) return val.name;
    if (typeof val === 'string' && val.includes('-') && cache) {
      const match = cache.find(c => c.id === val);
      return match ? match.name : val;
    }
    return val;
  };

  const fwPills = fws.map(f => {
    const fwName = resolveUuid(f, grcFrameworksCache?.map(fw => ({ id: fw.id || fw.uuid, name: fw.name || fw.ref_id })));
    return `<span class="org-fw-pill">${esc(fwName)}</span>`;
  }).join('') || '<span style="color:#9ca3af">None</span>';
  const mandPills = mandates.map(m => `<span class="org-fw-pill" style="color:#b45309;background:#fffbeb;border-color:#fde68a">${esc(m)}</span>`).join('') || '<span style="color:#9ca3af">None</span>';
  const policyPills = policies.map(p => {
    const pName = typeof p === 'object' ? p.name : p;
    const refId = typeof p === 'object' && p.refId ? ` (${esc(p.refId)})` : '';
    return `<span class="org-fw-pill" style="color:#4338ca;background:#eef2ff;border-color:#c7d2fe">${esc(pName)}${refId}</span>`;
  }).join('') || '<span style="color:#9ca3af">None</span>';

  const objPills = objectives.map(o => {
    const oName = resolveUuid(o, grcObjectivesCache);
    return `<span class="org-fw-pill" style="color:#7c3aed;background:#ede9fe;border-color:#c4b5fd">${esc(oName)}</span>`;
  }).join('') || '<span style="color:#9ca3af">None</span>';

  const metricPills = trackingMetrics.map(m => {
    const mName = typeof m === 'object' ? m.name : m;
    return `<span class="org-fw-pill" style="color:#047857;background:#ecfdf5;border-color:#a7f3d0">${esc(mName)}</span>`;
  }).join('') || '<span style="color:#9ca3af">None</span>';

  const riskScenarioPills = riskScenarios.map(r => {
    const rName = resolveUuid(r, grcRiskScenariosCache);
    return `<span class="org-fw-pill" style="color:#dc2626;background:#fef2f2;border-color:#fecaca">${esc(rName)}</span>`;
  }).join('') || '<span style="color:#9ca3af">None</span>';

  const docsHtml = docs.length
    ? docs.map(d => `<div class="org-detail-doc-row"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.3"/></svg><span>${esc(d.name || d)}</span></div>`).join('')
    : '<span style="color:#9ca3af">No documents</span>';

  const matDots = [1,2,3,4,5].map(n =>
    `<span class="org-detail-mat-dot ${n <= maturity ? 'active' : ''}" title="Level ${n}: ${matLabels[n]}">${n}</span>`
  ).join('');

  const detailEl = document.createElement('div');
  detailEl.className = 'org-detail-page';
  detailEl.innerHTML = `
    <div class="org-detail-top">
      <button class="pi-back-btn" onclick="orgBackToList()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="org-detail-top-info">
        <div class="org-detail-breadcrumb">Admin &gt; Organization Contexts</div>
        <div class="org-detail-title">${esc(name)} ${nameAr ? `<span class="org-detail-title-ar">${esc(nameAr)}</span>` : ''}</div>
      </div>
      <div class="org-detail-top-actions">
        <button class="pi-btn pi-btn-view" onclick="editOrgContext(${idx})"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Edit</button>
        <button class="org-ctx-action-btn" style="color:#ef4444" onclick="deleteOrgContext(${idx})" title="Delete"><svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>

    <div class="org-detail-grid">
      <div class="org-detail-card">
        <div class="org-detail-card-title">General Information</div>
        <div class="org-detail-field-grid">
          <div class="org-detail-field"><div class="org-detail-field-label">Sector</div><div class="org-detail-field-value">${esc(sector)}</div></div>
          <div class="org-detail-field"><div class="org-detail-field-label">Organization Size</div><div class="org-detail-field-value">${esc(size)}</div></div>
          <div class="org-detail-field"><div class="org-detail-field-label">Governance Structure</div><div class="org-detail-field-value">${esc(gov)}</div></div>
          <div class="org-detail-field"><div class="org-detail-field-label">Data Classification</div><div class="org-detail-field-value">${esc(dataCls)}</div></div>
          <div class="org-detail-field"><div class="org-detail-field-label">Geographic Scope</div><div class="org-detail-field-value">${esc(geo)}</div></div>
          <div class="org-detail-field"><div class="org-detail-field-label">IT Infrastructure</div><div class="org-detail-field-value">${esc(itInfra)}</div></div>
        </div>
      </div>

      <div class="org-detail-card">
        <div class="org-detail-card-title">Compliance Maturity</div>
        <div class="org-detail-maturity">
          <div class="org-detail-mat-bar">${matDots}</div>
          <div class="org-detail-mat-label">Level ${maturity} — ${matLabels[maturity] || maturity}</div>
        </div>
      </div>
    </div>

    <div class="org-detail-card">
      <div class="org-detail-card-title">Obligatory Frameworks</div>
      <div class="org-detail-pills">${fwPills}</div>
    </div>

    <div class="org-detail-card">
      <div class="org-detail-card-title">Regulatory Mandates</div>
      <div class="org-detail-pills">${mandPills}</div>
    </div>

    ${policies.length ? `<div class="org-detail-card">
      <div class="org-detail-card-title">Policies</div>
      <div class="org-detail-pills">${policyPills}</div>
    </div>` : ''}

    <div class="org-detail-card">
      <div class="org-detail-card-title">Strategic Objectives</div>
      <div class="org-detail-pills">${objPills}</div>
    </div>

    <div class="org-detail-card">
      <div class="org-detail-card-title">Tracking Metrics</div>
      <div class="org-detail-pills">${metricPills}</div>
    </div>

    <div class="org-detail-card">
      <div class="org-detail-card-title">Risk Scenarios</div>
      <div class="org-detail-pills">${riskScenarioPills}</div>
    </div>

    <!-- Chain Resolution -->
    <div class="org-detail-card" style="border:1px solid #6366f1;background:linear-gradient(135deg,rgba(99,102,241,.04),rgba(139,92,246,.04))">
      <div class="org-detail-card-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>🔗 Entity Chain</span>
        <button class="pi-btn" style="font-size:11px;padding:4px 10px;color:#6366f1;border:1px solid #c7d2fe;background:#eef2ff" onclick="resolveChain('${esc(ctx.id)}')" title="Force re-resolve the chain">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style="margin-right:3px;vertical-align:-1px"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/></svg>
          Re-resolve
        </button>
      </div>
      <div id="chain-result-${esc(ctx.id)}" class="chain-result-container" style="margin-top:8px;min-height:40px">
        <div class="chain-loading">
          <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#6366f1" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/></svg>
          <span>Resolving entity chain…</span>
        </div>
      </div>
    </div>

    ${docs.length ? `<div class="org-detail-card">
      <div class="org-detail-card-title">Documents</div>
      <div class="org-detail-section-body">${docsHtml}</div>
    </div>` : ''}

    ${notes ? `<div class="org-detail-card">
      <div class="org-detail-card-title">Notes</div>
      <div class="org-detail-notes">${esc(notes)}</div>
    </div>` : ''}

    <div class="org-detail-card">
      <div class="org-detail-card-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>File Attachments</span>
        <label class="pi-btn pi-btn-primary" style="cursor:pointer;font-size:12px;padding:5px 12px;margin:0">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="margin-right:4px;vertical-align:-2px"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>Upload File
          <input type="file" id="org-file-upload-${esc(ctx.id)}" style="display:none" onchange="orgUploadFile('${esc(ctx.id)}', this)" multiple accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp" />
        </label>
      </div>
      <div id="org-files-list-${esc(ctx.id)}" class="org-files-list">
        <div style="text-align:center;padding:16px;color:#9ca3af"><svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Loading files...</div>
      </div>
    </div>
  `;

  container.appendChild(detailEl);

  // Load files for this org context
  orgLoadFiles(ctx.id);

  // Auto-resolve and render chain
  autoResolveChain(ctx.id);

  // Add floating chat button + chat panel
  renderOrgChatFAB(ctx);
}

// ---- Chain Resolution UI ----

async function resolveChain(orgId) {
  const container = document.getElementById('chain-result-' + orgId);
  if (!container) return;

  container.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:#9ca3af;font-size:13px">
    <svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    Resolving chain — fetching from CISO Assistant…
  </div>`;

  try {
    const res = await fetch('/api/chain/resolve/' + orgId, { method: 'POST' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || 'HTTP ' + res.status);
    }
    const data = await res.json();
    const rowCount = data.data?.chainRows || data.rowsInserted || 0;
    toast('success', 'Chain Resolved', `${rowCount} chain paths resolved.`);

    // Now fetch and render the chain
    await renderChainVisualization(orgId, container);
  } catch (err) {
    console.error('Chain resolve error:', err);
    container.innerHTML = `<div style="color:#ef4444;font-size:13px">❌ Failed: ${esc(err.message)}</div>`;
    toast('error', 'Chain Error', err.message);
  }
}
window.resolveChain = resolveChain;

// ── Chain data cache for tab switching ──
window._chainCache = window._chainCache || {};

async function renderChainVisualization(orgId, container) {
  try {
    const [chainRes, summaryRes] = await Promise.all([
      fetch('/api/chain/' + orgId),
      fetch('/api/chain/' + orgId + '/summary')
    ]);
    if (!chainRes.ok) throw new Error('Failed to load chain');
    const chainData = await chainRes.json();
    const summaryData = summaryRes.ok ? await summaryRes.json() : null;

    const rows = chainData.chain || [];
    if (!rows.length) {
      container.innerHTML = '<span style="color:#9ca3af;font-size:12px">No chain paths found. Make sure objectives, frameworks, and controls are configured.</span>';
      return;
    }

    // ── Parse rows into shared structures ──
    const parsed = parseChainRows(rows);
    const { uniqObj, uniqFw, uniqReq, uniqRisk, uniqCtrl, tree, nodeMap, edgeSet } = parsed;
    const unm = summaryData?.unmitigatedRisks || [];

    // Cache for tab switching
    window._chainCache[orgId] = { rows, parsed, summaryData, unm };

    // ── Summary strip (shared between tabs) ──
    const summaryHtml = buildChainSummaryStrip(uniqObj, uniqFw, uniqReq, uniqRisk, uniqCtrl, unm);

    // ── Tabs ──
    const tabsHtml = `<div class="chain-tabs">
      <button class="chain-tab active" id="chain-tab-net-${esc(orgId)}" onclick="switchChainTab('${esc(orgId)}','network')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="3" cy="3" r="1.5" fill="currentColor"/><circle cx="11" cy="3" r="1.5" fill="currentColor"/><circle cx="7" cy="11" r="1.5" fill="currentColor"/><path d="M3 3L11 3M3 3L7 11M11 3L7 11" stroke="currentColor" stroke-width="0.8"/></svg>
        Network
      </button>
      <button class="chain-tab" id="chain-tab-acc-${esc(orgId)}" onclick="switchChainTab('${esc(orgId)}','accordion')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10M2 7h10M2 11h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4 5L6 7L4 9" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Accordion
      </button>
    </div>`;

    // ── Tab panels ──
    container.innerHTML = summaryHtml + tabsHtml + `
      <div id="chain-panel-net-${orgId}" class="chain-panel active"></div>
      <div id="chain-panel-acc-${orgId}" class="chain-panel" style="display:none"></div>`;

    // Render network tab immediately
    renderChainNetworkTab(orgId);

  } catch (err) {
    console.error('Chain visualization error:', err);
    container.innerHTML = `<span style="color:#ef4444;font-size:12px">Error loading chain: ${esc(err.message)}</span>`;
  }
}

// ── Parse chain rows into tree + graph structures ──
function parseChainRows(rows) {
  const tree = new Map();
  const nodeMap = new Map();
  const edgeSet = new Set();
  const uniqObj = new Set(), uniqFw = new Set(), uniqReq = new Set(), uniqRisk = new Set(), uniqCtrl = new Set();

  const addNode = (id, label, group, title) => { if (!id || nodeMap.has(id)) return; nodeMap.set(id, { id, label, group, title }); };
  const addEdge = (from, to) => { if (!from || !to) return; const k = from + '|' + to; if (!edgeSet.has(k)) edgeSet.add(k); };

  for (const r of rows) {
    const objId = r.objective?.uuid, fwId = r.framework?.uuid, reqId = r.requirement?.uuid, rskId = r.riskScenario?.uuid, ctlId = r.control?.uuid;

    if (objId) { uniqObj.add(objId); addNode('obj-' + objId, truncLabel(r.objective.name, 24), 'objective', r.objective.name); }
    if (fwId)  { uniqFw.add(fwId);   addNode('fw-' + fwId, truncLabel(r.framework.name, 24), 'framework', r.framework.name); }
    if (reqId) { uniqReq.add(reqId);  addNode('req-' + reqId, r.requirement.refId || truncLabel(r.requirement.name, 18), 'requirement', (r.requirement.refId ? r.requirement.refId + ': ' : '') + r.requirement.name); }
    if (rskId) { uniqRisk.add(rskId); addNode('rsk-' + rskId, truncLabel(r.riskScenario.name, 22), 'risk', r.riskScenario.name); }
    if (ctlId) { uniqCtrl.add(ctlId); addNode('ctl-' + ctlId, truncLabel(r.control.name, 22), 'control', r.control.name + (r.control.status ? ' [' + r.control.status + ']' : '')); }

    if (objId && fwId) addEdge('obj-' + objId, 'fw-' + fwId);
    if (fwId && reqId) addEdge('fw-' + fwId, 'req-' + reqId);
    if (reqId && rskId) addEdge('req-' + reqId, 'rsk-' + rskId);
    if (reqId && ctlId) addEdge('req-' + reqId, 'ctl-' + ctlId);
    if (rskId && ctlId) addEdge('rsk-' + rskId, 'ctl-' + ctlId);

    // Build tree (for accordion)
    const objKey = objId || '_none_', objName = r.objective?.name || 'No Objective Linked';
    const fwKey = fwId || '_none_', fwName = r.framework?.name || 'No Framework';
    const reqKey = reqId || '_none_', reqRef = r.requirement?.refId || '', reqName = r.requirement?.name || reqRef || 'Unknown';

    if (!tree.has(objKey)) tree.set(objKey, { name: objName, frameworks: new Map() });
    const oN = tree.get(objKey);
    if (!oN.frameworks.has(fwKey)) oN.frameworks.set(fwKey, { name: fwName, requirements: new Map() });
    const fN = oN.frameworks.get(fwKey);
    if (!fN.requirements.has(reqKey)) fN.requirements.set(reqKey, { refId: reqRef, name: reqName, risks: new Map(), controls: new Map() });
    const rN = fN.requirements.get(reqKey);
    if (r.riskScenario?.name && rskId) rN.risks.set(rskId, r.riskScenario.name);
    if (r.control?.name && ctlId) rN.controls.set(ctlId, { name: r.control.name, status: r.control.status });
  }

  return { tree, nodeMap, edgeSet, uniqObj, uniqFw, uniqReq, uniqRisk, uniqCtrl };
}

function buildChainSummaryStrip(uniqObj, uniqFw, uniqReq, uniqRisk, uniqCtrl, unm) {
  const sep = `<div class="chain-strip-sep"><svg width="8" height="10" viewBox="0 0 8 10"><path d="M1 1L6 5L1 9" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg></div>`;
  return `<div class="chain-strip">
    <div class="chain-strip-item"><span class="chain-strip-num">${uniqObj.size || '—'}</span><span class="chain-strip-txt">Objectives</span></div>${sep}
    <div class="chain-strip-item"><span class="chain-strip-num">${uniqFw.size}</span><span class="chain-strip-txt">Frameworks</span></div>${sep}
    <div class="chain-strip-item"><span class="chain-strip-num">${uniqReq.size}</span><span class="chain-strip-txt">Requirements</span></div>${sep}
    <div class="chain-strip-item"><span class="chain-strip-num">${uniqRisk.size}</span><span class="chain-strip-txt">Risks</span></div>${sep}
    <div class="chain-strip-item ${uniqCtrl.size ? '' : 'chain-strip-warn'}"><span class="chain-strip-num">${uniqCtrl.size}</span><span class="chain-strip-txt">Controls</span></div>
    ${unm.length ? `<div class="chain-strip-sep">|</div><div class="chain-strip-item chain-strip-warn"><span class="chain-strip-num">${unm.length}</span><span class="chain-strip-txt">Unmitigated</span></div>` : ''}
  </div>`;
}

// ── Tab switching ──
function switchChainTab(orgId, tab) {
  const netTab = document.getElementById('chain-tab-net-' + orgId);
  const accTab = document.getElementById('chain-tab-acc-' + orgId);
  const netPanel = document.getElementById('chain-panel-net-' + orgId);
  const accPanel = document.getElementById('chain-panel-acc-' + orgId);
  if (!netTab || !accTab || !netPanel || !accPanel) return;

  if (tab === 'network') {
    netTab.classList.add('active'); accTab.classList.remove('active');
    netPanel.style.display = ''; accPanel.style.display = 'none';
    // Re-fit network
    const net = window._chainNets?.[orgId];
    if (net) setTimeout(() => { net.redraw(); net.fit({ animation: { duration: 300 } }); }, 50);
  } else {
    accTab.classList.add('active'); netTab.classList.remove('active');
    accPanel.style.display = ''; netPanel.style.display = 'none';
    // Lazy-render accordion on first switch
    if (!accPanel.dataset.rendered) {
      renderChainAccordionTab(orgId);
      accPanel.dataset.rendered = '1';
    }
  }
}
window.switchChainTab = switchChainTab;

// ──────────────────────────────────────────
// TAB 1: Network Graph
// ──────────────────────────────────────────
function renderChainNetworkTab(orgId) {
  const panel = document.getElementById('chain-panel-net-' + orgId);
  if (!panel) return;
  const cache = window._chainCache[orgId];
  if (!cache) return;
  const { nodeMap, edgeSet } = cache.parsed;

  // Legend
  const legendHtml = `<div class="chain-legend">
    <span class="chain-legend-item"><span class="chain-legend-dot" style="background:#7c3aed"></span>Objective</span>
    <span class="chain-legend-item"><span class="chain-legend-dot" style="background:#2563eb"></span>Framework</span>
    <span class="chain-legend-item"><span class="chain-legend-dot" style="background:#475569"></span>Requirement</span>
    <span class="chain-legend-item"><span class="chain-legend-dot" style="background:#f59e0b"></span>Risk</span>
    <span class="chain-legend-item"><span class="chain-legend-dot" style="background:#059669"></span>Control</span>
  </div>`;

  // Search bar
  const searchHtml = `<div class="chain-search-wrap">
    <svg class="chain-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M16 16L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <input type="text" class="chain-search-input" id="chain-search-${orgId}" placeholder="Search nodes…" autocomplete="off" />
    <div class="chain-search-results" id="chain-search-results-${orgId}"></div>
  </div>`;

  panel.innerHTML = `<div class="chain-toolbar">
    ${legendHtml}
    <div class="chain-toolbar-right">
      ${searchHtml}
      <div class="chain-toolbar-btns">
        <button class="chain-tb-btn" onclick="chainNetFit('${esc(orgId)}')" title="Fit all">⤢ Fit</button>
        <button class="chain-tb-btn" onclick="chainNetTogglePhysics('${esc(orgId)}')" title="Toggle physics">⚡ Physics</button>
        <button class="chain-tb-btn" onclick="chainNetFullscreen('${esc(orgId)}')" title="Fullscreen" id="chain-fs-btn-${esc(orgId)}">⛶ Fullscreen</button>
      </div>
    </div>
  </div>
  <div style="position:relative">
    <div id="chain-net-${orgId}" class="chain-net-container"></div>
    <div class="chain-node-info" id="chain-node-info-${orgId}"></div>
  </div>`;

  // Build vis-network
  const nodeStyles = {
    objective:   { color: { background: '#ede9fe', border: '#7c3aed', highlight: { background: '#ddd6fe', border: '#6d28d9' } }, font: { color: '#4c1d95', size: 14, face: 'Inter, system-ui, sans-serif', bold: { color: '#4c1d95' } }, shape: 'box', borderWidth: 2, margin: 10 },
    framework:   { color: { background: '#dbeafe', border: '#2563eb', highlight: { background: '#bfdbfe', border: '#1d4ed8' } }, font: { color: '#1e3a5f', size: 13, face: 'Inter, system-ui, sans-serif' }, shape: 'box', borderWidth: 2, margin: 8 },
    requirement: { color: { background: '#f1f5f9', border: '#94a3b8', highlight: { background: '#e2e8f0', border: '#64748b' } }, font: { color: '#334155', size: 11, face: 'Inter, system-ui, sans-serif' }, shape: 'box', borderWidth: 1, margin: 6 },
    risk:        { color: { background: '#fef3c7', border: '#f59e0b', highlight: { background: '#fde68a', border: '#d97706' } }, font: { color: '#78350f', size: 11, face: 'Inter, system-ui, sans-serif' }, shape: 'diamond', borderWidth: 2, margin: 8 },
    control:     { color: { background: '#d1fae5', border: '#059669', highlight: { background: '#a7f3d0', border: '#047857' } }, font: { color: '#064e3b', size: 11, face: 'Inter, system-ui, sans-serif' }, shape: 'box', borderWidth: 2, margin: 7, shapeProperties: { borderRadius: 12 } },
  };

  const visNodes = [];
  for (const n of nodeMap.values()) {
    const style = nodeStyles[n.group] || nodeStyles.requirement;
    visNodes.push({ id: n.id, label: n.label, title: n.title, group: n.group, ...style,
      level: n.group === 'objective' ? 0 : n.group === 'framework' ? 1 : n.group === 'requirement' ? 2 : n.group === 'risk' ? 3 : 4 });
  }

  const edgeColorMap = { obj: '#a78bfa', fw: '#60a5fa', req: '#94a3b8', rsk: '#fbbf24', ctl: '#34d399' };
  const visEdges = [];
  for (const key of edgeSet) {
    const [from, to] = key.split('|');
    visEdges.push({ from, to,
      color: { color: edgeColorMap[from.split('-')[0]] || '#d1d5db', highlight: '#6366f1', opacity: 0.7 },
      arrows: { to: { enabled: true, scaleFactor: 0.5, type: 'arrow' } },
      smooth: { type: 'cubicBezier', roundness: 0.4 }, width: 1.5 });
  }

  const netEl = document.getElementById('chain-net-' + orgId);
  if (!netEl || typeof vis === 'undefined') return;

  const nodesDS = new vis.DataSet(visNodes);
  const edgesDS = new vis.DataSet(visEdges);

  const network = new vis.Network(netEl, { nodes: nodesDS, edges: edgesDS }, {
    layout: { hierarchical: { enabled: true, direction: 'LR', sortMethod: 'directed', levelSeparation: 220, nodeSpacing: 30, treeSpacing: 40, blockShifting: true, edgeMinimization: true, parentCentralization: true } },
    physics: { enabled: false },
    interaction: { hover: true, tooltipDelay: 150, zoomView: true, dragView: true, navigationButtons: false, keyboard: { enabled: true } },
    edges: { smooth: { type: 'cubicBezier', roundness: 0.4 } },
  });

  window._chainNets = window._chainNets || {};
  window._chainNets[orgId] = network;
  window._chainNodeDS = window._chainNodeDS || {};
  window._chainNodeDS[orgId] = nodesDS;
  network.once('stabilized', () => { network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } }); });

  // ── Search functionality ──
  const searchInput = document.getElementById('chain-search-' + orgId);
  const resultsEl = document.getElementById('chain-search-results-' + orgId);
  const allNodes = visNodes.map(n => ({ id: n.id, label: n.label, title: n.title || n.label, group: n.group }));

  const groupIcons = { objective: '🎯', framework: '📋', requirement: '📄', risk: '⚠️', control: '🛡️' };
  const groupColors = { objective: '#7c3aed', framework: '#2563eb', requirement: '#64748b', risk: '#f59e0b', control: '#059669' };

  let searchTimeout = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const q = searchInput.value.trim().toLowerCase();
      if (q.length < 2) { resultsEl.style.display = 'none'; return; }
      const hits = allNodes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.label || '').toLowerCase().includes(q)).slice(0, 15);
      if (!hits.length) {
        resultsEl.innerHTML = '<div class="chain-sr-empty">No matches</div>';
      } else {
        resultsEl.innerHTML = hits.map(h =>
          `<div class="chain-sr-item" data-nid="${esc(h.id)}">
            <span class="chain-sr-icon" style="color:${groupColors[h.group] || '#64748b'}">${groupIcons[h.group] || '●'}</span>
            <span class="chain-sr-label">${esc(h.title || h.label)}</span>
            <span class="chain-sr-type">${esc(h.group)}</span>
          </div>`
        ).join('');
      }
      resultsEl.style.display = 'block';
    }, 150);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { resultsEl.style.display = 'none'; searchInput.blur(); }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = resultsEl.querySelector('.chain-sr-item');
      if (first) first.focus();
    }
  });

  resultsEl.addEventListener('click', (e) => {
    const item = e.target.closest('.chain-sr-item');
    if (!item) return;
    const nid = item.dataset.nid;
    chainNetNavigateTo(orgId, nid);
    resultsEl.style.display = 'none';
    searchInput.value = '';
  });

  resultsEl.addEventListener('keydown', (e) => {
    const item = e.target.closest('.chain-sr-item');
    if (!item) return;
    if (e.key === 'Enter') { item.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); const next = item.nextElementSibling; if (next) next.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); const prev = item.previousElementSibling; if (prev) prev.focus(); else searchInput.focus(); }
    if (e.key === 'Escape') { resultsEl.style.display = 'none'; searchInput.focus(); }
  });

  // Close search results on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.chain-search-wrap')) resultsEl.style.display = 'none';
  });

  // ── Node click → info panel ──
  const infoEl = document.getElementById('chain-node-info-' + orgId);
  network.on('click', params => {
    if (params.nodes.length === 1) {
      const nid = params.nodes[0];
      showChainNodeInfo(orgId, nid, network, nodesDS, infoEl);
    } else {
      infoEl.style.display = 'none';
    }
  });
  network.on('deselectNode', () => { infoEl.style.display = 'none'; });
}

// ──────────────────────────────────────────
// TAB 2: Accordion Tree
// ──────────────────────────────────────────
function renderChainAccordionTab(orgId) {
  const panel = document.getElementById('chain-panel-acc-' + orgId);
  if (!panel) return;
  const cache = window._chainCache[orgId];
  if (!cache) return;
  const { tree } = cache.parsed;

  // Filter control
  let html = `<div class="ct-filter-bar">
    <span class="ct-filter-label">Show:</span>
    <button class="ct-filter-btn active" data-filter="all" onclick="chainAccFilter('${esc(orgId)}','all',this)">All</button>
    <button class="ct-filter-btn" data-filter="covered" onclick="chainAccFilter('${esc(orgId)}','covered',this)">✅ With Controls</button>
    <button class="ct-filter-btn" data-filter="gaps" onclick="chainAccFilter('${esc(orgId)}','gaps',this)">⚠️ Gaps Only</button>
  </div>`;

  html += '<div class="chain-tree" id="chain-tree-' + orgId + '">';

  for (const [objKey, objNode] of tree) {
    let objReqC = 0, objCoveredC = 0, objGapC = 0;
    const objCtrlS = new Set(), objRiskS = new Set();
    for (const fw of objNode.frameworks.values()) {
      objReqC += fw.requirements.size;
      for (const rq of fw.requirements.values()) {
        rq.controls.forEach((_, k) => objCtrlS.add(k));
        rq.risks.forEach((_, k) => objRiskS.add(k));
        if (rq.controls.size > 0) objCoveredC++; else objGapC++;
      }
    }

    html += `<div class="ct-node ct-obj open">
      <div class="ct-header ct-obj-hdr" onclick="this.parentElement.classList.toggle('open')">
        <svg class="ct-chev" width="10" height="10" viewBox="0 0 10 10"><path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="ct-icon">🎯</span>
        <span class="ct-lbl">${esc(objNode.name)}</span>
        <div class="ct-badges">
          <span class="ct-b ct-b-fw">${objNode.frameworks.size} fw</span>
          <span class="ct-b ct-b-req">${objReqC} req</span>
          <span class="ct-b ${objRiskS.size ? 'ct-b-risk' : 'ct-b-dim'}">${objRiskS.size} risks</span>
          <span class="ct-b ${objCtrlS.size ? 'ct-b-ctrl' : 'ct-b-dim'}">${objCtrlS.size} ctrls</span>
        </div>
      </div>
      <div class="ct-children">`;

    for (const [, fwNode] of objNode.frameworks) {
      const fwCtrlS = new Set(), fwRiskS = new Set();
      const coveredArr = [], gapArr = [];
      for (const rq of fwNode.requirements.values()) {
        rq.controls.forEach((_, k) => fwCtrlS.add(k));
        rq.risks.forEach((_, k) => fwRiskS.add(k));
        if (rq.controls.size > 0) coveredArr.push(rq); else gapArr.push(rq);
      }
      const totalReqs = fwNode.requirements.size;
      const pct = totalReqs ? Math.round((coveredArr.length / totalReqs) * 100) : 0;

      html += `<div class="ct-node ct-fw">
        <div class="ct-header ct-fw-hdr" onclick="this.parentElement.classList.toggle('open')">
          <svg class="ct-chev" width="10" height="10" viewBox="0 0 10 10"><path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="ct-icon">📋</span>
          <span class="ct-lbl">${esc(fwNode.name)}</span>
          <div class="ct-badges">
            <span class="ct-b ct-b-req">${totalReqs} req</span>
            <span class="ct-b ${fwRiskS.size ? 'ct-b-risk' : 'ct-b-dim'}">${fwRiskS.size} risks</span>
            <span class="ct-b ${fwCtrlS.size ? 'ct-b-ctrl' : 'ct-b-dim'}">${fwCtrlS.size} ctrls</span>
          </div>
          <div class="ct-progress" title="${coveredArr.length}/${totalReqs} requirements covered (${pct}%)">
            <div class="ct-progress-bar" style="width:${pct}%"></div>
            <span class="ct-progress-txt">${pct}%</span>
          </div>
        </div>
        <div class="ct-children">`;

      // Coverage summary banner inside framework
      html += `<div class="ct-coverage-banner">
        <div class="ct-cov-stat ct-cov-ok"><span>${coveredArr.length}</span> covered</div>
        <div class="ct-cov-stat ct-cov-gap"><span>${gapArr.length}</span> gaps</div>
        <div class="ct-cov-stat ct-cov-risk"><span>${fwRiskS.size}</span> risks</div>
        <div class="ct-cov-stat ct-cov-ctrl"><span>${fwCtrlS.size}</span> controls</div>
      </div>`;

      for (const [, reqNode] of fwNode.requirements) {
        const hasCtrls = reqNode.controls.size > 0, hasRisks = reqNode.risks.size > 0, hasKids = hasCtrls || hasRisks;

        html += `<div class="ct-node ct-req ${hasCtrls ? 'ct-covered' : 'ct-gap'}" data-coverage="${hasCtrls ? 'covered' : 'gap'}">
          <div class="ct-header ct-req-hdr" ${hasKids ? 'onclick="this.parentElement.classList.toggle(\'open\')"' : ''}>
            ${hasKids ? '<svg class="ct-chev" width="9" height="9" viewBox="0 0 10 10"><path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<span class="ct-dot"></span>'}
            <span class="ct-req-ref">${esc(reqNode.refId || '—')}</span>
            <span class="ct-lbl ct-req-name" title="${esc(reqNode.name)}">${esc(reqNode.name)}</span>
            ${hasCtrls ? `<span class="ct-b ct-b-ctrl ct-b-sm">${reqNode.controls.size} 🛡️</span>` : ''}
            ${hasRisks ? `<span class="ct-b ct-b-risk ct-b-sm">${reqNode.risks.size} ⚠️</span>` : ''}
            ${!hasCtrls ? '<span class="ct-gap-tag">no control</span>' : ''}
          </div>`;

        if (hasKids) {
          html += `<div class="ct-children ct-leaves">`;
          for (const [, ctrl] of reqNode.controls) {
            const stCls = ctrl.status === 'active' ? 'ct-st-active' : (ctrl.status === 'in_progress' ? 'ct-st-prog' : 'ct-st-todo');
            html += `<div class="ct-leaf ct-leaf-ctrl"><span class="ct-leaf-ic">🛡️</span><span>${esc(ctrl.name)}</span><span class="ct-st ${stCls}">${esc(ctrl.status || 'to_do')}</span></div>`;
          }
          for (const [, riskName] of reqNode.risks) {
            html += `<div class="ct-leaf ct-leaf-risk"><span class="ct-leaf-ic">⚠️</span><span>${esc(riskName)}</span></div>`;
          }
          html += `</div>`;
        }
        html += `</div>`; // ct-req
      }
      html += `</div></div>`; // ct-fw
    }
    html += `</div></div>`; // ct-obj
  }
  html += '</div>';
  panel.innerHTML = html;
}

// Accordion filter: all / covered / gaps
function chainAccFilter(orgId, filter, btn) {
  // Toggle active button
  const bar = btn.parentElement;
  bar.querySelectorAll('.ct-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const tree = document.getElementById('chain-tree-' + orgId);
  if (!tree) return;
  const reqs = tree.querySelectorAll('.ct-req[data-coverage]');
  for (const r of reqs) {
    if (filter === 'all') { r.style.display = ''; }
    else if (filter === 'covered') { r.style.display = r.dataset.coverage === 'covered' ? '' : 'none'; }
    else if (filter === 'gaps') { r.style.display = r.dataset.coverage === 'gap' ? '' : 'none'; }
  }
}
window.chainAccFilter = chainAccFilter;

function truncLabel(text, max) {
  if (!text) return '—';
  return text.length > max ? text.substring(0, max - 1) + '…' : text;
}

// ── Network toolbar helpers ──
function chainNetFit(orgId) {
  const net = window._chainNets?.[orgId];
  if (net) net.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
}
window.chainNetFit = chainNetFit;

function chainNetTogglePhysics(orgId) {
  const net = window._chainNets?.[orgId];
  if (!net) return;
  const enabled = !net.physics?.physicsEnabled;
  net.setOptions({ physics: { enabled } });
  if (enabled) setTimeout(() => net.setOptions({ physics: { enabled: false } }), 3000);
}
window.chainNetTogglePhysics = chainNetTogglePhysics;

function chainNetFullscreen(orgId) {
  const netEl = document.getElementById('chain-net-' + orgId);
  if (!netEl) return;
  const wrapper = netEl.parentElement; // container that holds strip + toolbar + graph

  if (wrapper.classList.contains('chain-fullscreen')) {
    // Exit fullscreen
    wrapper.classList.remove('chain-fullscreen');
    netEl.style.height = '500px';
    const btn = document.getElementById('chain-fs-btn-' + orgId);
    if (btn) btn.textContent = '⛶ Fullscreen';
    document.body.style.overflow = '';
  } else {
    // Enter fullscreen
    wrapper.classList.add('chain-fullscreen');
    netEl.style.height = 'calc(100vh - 90px)';
    const btn = document.getElementById('chain-fs-btn-' + orgId);
    if (btn) btn.textContent = '✕ Exit';
    document.body.style.overflow = 'hidden';
  }
  // Re-fit after resize
  const net = window._chainNets?.[orgId];
  if (net) setTimeout(() => { net.redraw(); net.fit({ animation: { duration: 400 } }); }, 100);
}
window.chainNetFullscreen = chainNetFullscreen;

// Exit fullscreen on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const fsEl = document.querySelector('.chain-fullscreen');
    if (fsEl) {
      const netEl = fsEl.querySelector('.chain-net-container');
      if (netEl) {
        const orgId = netEl.id.replace('chain-net-', '');
        chainNetFullscreen(orgId);
      }
    }
  }
});

// ── Navigate to node (zoom + select + highlight neighbors) ──
function chainNetNavigateTo(orgId, nodeId) {
  const net = window._chainNets?.[orgId];
  if (!net) return;
  net.selectNodes([nodeId]);
  net.focus(nodeId, { scale: 1.5, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
  // Show info panel
  const nodesDS = window._chainNodeDS?.[orgId];
  const infoEl = document.getElementById('chain-node-info-' + orgId);
  if (nodesDS && infoEl) showChainNodeInfo(orgId, nodeId, net, nodesDS, infoEl);
}
window.chainNetNavigateTo = chainNetNavigateTo;

// ── Node info panel (appears on click / navigate) ──
function showChainNodeInfo(orgId, nodeId, network, nodesDS, infoEl) {
  const node = nodesDS.get(nodeId);
  if (!node) { infoEl.style.display = 'none'; return; }

  const groupIcons = { objective: '🎯', framework: '📋', requirement: '📄', risk: '⚠️', control: '🛡️' };
  const groupColors = { objective: '#7c3aed', framework: '#2563eb', requirement: '#64748b', risk: '#f59e0b', control: '#059669' };

  const connNodes = network.getConnectedNodes(nodeId);
  const incoming = connNodes.filter(c => {
    const edges = network.getConnectedEdges(c);
    return edges.some(eid => {
      const ed = network.body.data.edges.get(eid);
      return ed && ed.to === nodeId;
    });
  });
  const outgoing = connNodes.filter(c => {
    const edges = network.getConnectedEdges(c);
    return edges.some(eid => {
      const ed = network.body.data.edges.get(eid);
      return ed && ed.from === nodeId;
    });
  });

  const renderConn = (ids, label) => {
    if (!ids.length) return '';
    return `<div class="cni-section"><span class="cni-sec-lbl">${esc(label)}</span>` +
      ids.map(id => {
        const n = nodesDS.get(id);
        if (!n) return '';
        return `<div class="cni-conn" tabindex="0" onclick="chainNetNavigateTo('${esc(orgId)}','${esc(id)}')" title="Navigate to ${esc(n.title || n.label)}">
          <span style="color:${groupColors[n.group] || '#64748b'}">${groupIcons[n.group] || '●'}</span>
          <span>${esc(n.title || n.label)}</span>
        </div>`;
      }).join('') + '</div>';
  };

  infoEl.innerHTML = `
    <div class="cni-header">
      <span class="cni-icon" style="color:${groupColors[node.group] || '#64748b'}">${groupIcons[node.group] || '●'}</span>
      <div class="cni-titles">
        <span class="cni-type">${esc(node.group)}</span>
        <span class="cni-name">${esc(node.title || node.label)}</span>
      </div>
      <button class="cni-close" onclick="this.closest('.chain-node-info').style.display='none'" title="Close">✕</button>
    </div>
    <div class="cni-body">
      ${renderConn(incoming, '← Incoming')}
      ${renderConn(outgoing, '→ Outgoing')}
      ${!connNodes.length ? '<span class="cni-empty">No connections</span>' : ''}
    </div>`;
  infoEl.style.display = 'block';
}
window.showChainNodeInfo = showChainNodeInfo;

// Auto-load chain on detail page if previously resolved
async function autoResolveChain(orgId) {
  const container = document.getElementById('chain-result-' + orgId);
  if (!container) return;

  // Show loading indicator
  container.innerHTML = `<div class="chain-loading">
    <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#6366f1" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/></svg>
    <span>Resolving entity chain…</span>
  </div>`;

  try {
    // Resolve (POST) then render
    const res = await fetch('/api/chain/resolve/' + orgId, { method: 'POST' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || 'HTTP ' + res.status);
    }
    await renderChainVisualization(orgId, container);
  } catch (err) {
    console.error('Auto-resolve chain error:', err);
    container.innerHTML = `<div style="color:#ef4444;font-size:13px;display:flex;align-items:center;gap:6px">
      ❌ <span>${esc(err.message)}</span>
      <button class="pi-btn" style="font-size:11px;padding:3px 10px;margin-left:8px;color:#6366f1;border:1px solid #c7d2fe;background:#eef2ff" onclick="autoResolveChain('${esc(orgId)}')">Retry</button>
    </div>`;
  }
}
window.autoResolveChain = autoResolveChain;

// ---- Org Context Chat ----

let orgChatSessionId = null;
let orgChatOrgId = null;
let orgChatOpen = false;
let orgChatSelectedStores = []; // store IDs selected by user

let orgChatStep = 1; // 1 = select stores, 2 = chat

function renderOrgChatFAB(ctx) {
  // Remove previous FAB/panel if any
  document.querySelectorAll('.org-chat-fab, .org-chat-panel').forEach(el => el.remove());

  const ctxName = ctx ? esc(ctx.nameEn || ctx.name || 'Organization') : 'Organizations';

  // Floating action button
  const fab = document.createElement('button');
  fab.className = 'org-chat-fab';
  fab.title = 'Chat with organization documents';
  fab.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  fab.onclick = () => toggleOrgChat(ctx);
  document.body.appendChild(fab);

  // Chat panel (hidden initially)
  const panel = document.createElement('div');
  panel.className = 'org-chat-panel';
  panel.id = 'org-chat-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="org-chat-header">
      <div class="org-chat-header-info">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span id="org-chat-header-title">Chat — ${ctxName}</span>
      </div>
      <div class="org-chat-header-actions">
        <button class="org-chat-header-btn" id="org-chat-back-btn" title="Back to stores" onclick="orgChatGoToStep1()" style="display:none"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="org-chat-header-btn" id="org-chat-expand-btn" title="Expand" onclick="orgChatToggleExpand()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 2h4M2 2v4M14 14h-4M14 14v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        <button class="org-chat-header-btn" title="Close" onclick="toggleOrgChat()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      </div>
    </div>

    <!-- STEP 1: Select collections -->
    <div class="org-chat-step" id="org-chat-step1">
      <div class="org-chat-stores" id="org-chat-stores">
        <div class="org-chat-stores-label">Select document stores to include:</div>
        <div class="org-chat-stores-list" id="org-chat-stores-list">
          <div style="padding:8px;color:#9ca3af;font-size:12px">Loading stores...</div>
        </div>
      </div>
      <div class="org-chat-step1-footer">
        <div class="org-chat-selected-count" id="org-chat-selected-count">0 stores selected</div>
        <button class="org-chat-start-btn" id="org-chat-start-btn" onclick="orgChatGoToStep2()" disabled>Start Chat <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>

    <!-- STEP 2: Chat conversation -->
    <div class="org-chat-step" id="org-chat-step2" style="display:none">
      <div class="org-chat-messages" id="org-chat-messages">
        <div class="org-chat-welcome">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="color:#6366f1"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg>
          <div class="org-chat-welcome-title">Organization Assistant</div>
          <div class="org-chat-welcome-sub">Ask questions about the uploaded documents and policies.</div>
        </div>
      </div>
      <div class="org-chat-input-area">
        <textarea id="org-chat-input" class="org-chat-input" placeholder="Ask about organization documents..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();orgChatSend();}"></textarea>
        <button class="org-chat-send-btn" id="org-chat-send-btn" onclick="orgChatSend()" title="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  orgChatStep = 1;
  orgChatLoadStores(ctx);
}

function orgChatUpdateSelectedCount() {
  const countEl = document.getElementById('org-chat-selected-count');
  const startBtn = document.getElementById('org-chat-start-btn');
  const n = orgChatSelectedStores.length;
  if (countEl) countEl.textContent = n + ' store' + (n !== 1 ? 's' : '') + ' selected';
  if (startBtn) startBtn.disabled = n === 0;
}

function orgChatGoToStep2() {
  if (!orgChatSelectedStores.length) return;
  orgChatStep = 2;
  const step1 = document.getElementById('org-chat-step1');
  const step2 = document.getElementById('org-chat-step2');
  const backBtn = document.getElementById('org-chat-back-btn');
  const titleEl = document.getElementById('org-chat-header-title');
  if (step1) step1.style.display = 'none';
  if (step2) step2.style.display = 'flex';
  if (backBtn) backBtn.style.display = 'flex';
  if (titleEl) titleEl.textContent = 'Chat — ' + orgChatSelectedStores.length + ' store' + (orgChatSelectedStores.length !== 1 ? 's' : '');
  const input = document.getElementById('org-chat-input');
  if (input) setTimeout(() => input.focus(), 100);
}
window.orgChatGoToStep2 = orgChatGoToStep2;

function orgChatGoToStep1() {
  orgChatStep = 1;
  const step1 = document.getElementById('org-chat-step1');
  const step2 = document.getElementById('org-chat-step2');
  const backBtn = document.getElementById('org-chat-back-btn');
  if (step1) step1.style.display = 'flex';
  if (step2) step2.style.display = 'none';
  if (backBtn) backBtn.style.display = 'none';
}
window.orgChatGoToStep1 = orgChatGoToStep1;

let orgChatExpanded = false;
function orgChatToggleExpand() {
  const panel = document.getElementById('org-chat-panel');
  const btn = document.getElementById('org-chat-expand-btn');
  const fab = document.querySelector('.org-chat-fab');
  if (!panel) return;
  orgChatExpanded = !orgChatExpanded;
  panel.classList.toggle('expanded', orgChatExpanded);
  if (fab) fab.style.display = orgChatExpanded ? 'none' : '';
  if (btn) {
    btn.title = orgChatExpanded ? 'Collapse' : 'Expand';
    btn.innerHTML = orgChatExpanded
      ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 2v3H2M11 14v-3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 2h4M2 2v4M14 14h-4M14 14v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  }
}
window.orgChatToggleExpand = orgChatToggleExpand;

async function orgChatLoadStores(currentCtx) {
  const listEl = document.getElementById('org-chat-stores-list');
  if (!listEl) return;
  orgChatSelectedStores = [];
  try {
    const r = await fetch('/api/org-contexts');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const allOrgs = d.contexts || [];
    const orgsWithStores = allOrgs.filter(o => o.storeId);
    if (!orgsWithStores.length) {
      listEl.innerHTML = '<div style="padding:8px;color:#9ca3af;font-size:12px">No document stores available. Upload files to an organization first.</div>';
      return;
    }

    const currentId = currentCtx ? currentCtx.id : null;

    if (currentCtx && currentCtx.storeId) {
      orgChatSelectedStores = [currentCtx.storeId];
    } else {
      orgChatSelectedStores = orgsWithStores.map(o => o.storeId);
    }

    listEl.innerHTML = orgsWithStores.map((org, i) => {
      const isChecked = orgChatSelectedStores.includes(org.storeId);
      const isCurrent = org.id === currentId;
      return `<div class="org-chat-store-accordion ${isChecked ? 'selected' : ''}" data-storeid="${esc(org.storeId)}">
        <div class="org-chat-store-header" onclick="orgChatToggleAccordion(this)">
          <input type="checkbox" value="${esc(org.storeId)}" data-orgid="${esc(org.id)}" ${isChecked ? 'checked' : ''} onchange="orgChatToggleStore(this)" onclick="event.stopPropagation()" />
          <span class="org-chat-store-name">${esc(org.nameEn || org.name || 'Organization')}</span>
          ${isCurrent ? '<span class="org-chat-store-badge">Current</span>' : ''}
          <svg class="org-chat-store-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 5.5L7 8.5L10 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="org-chat-store-files" id="org-chat-files-${esc(org.id)}" style="display:none">
          <div class="org-chat-files-loading"><svg class="spinner" width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Loading files...</div>
        </div>
      </div>`;
    }).join('');

    // Pre-fetch files for each store
    orgsWithStores.forEach(org => orgChatFetchStoreFiles(org.id));
    orgChatUpdateSelectedCount();

  } catch (err) {
    console.error('Load org stores error:', err);
    listEl.innerHTML = '<div style="padding:8px;color:#ef4444;font-size:12px">Failed to load stores.</div>';
  }
}

function orgChatToggleAccordion(headerEl) {
  const accordion = headerEl.closest('.org-chat-store-accordion');
  if (!accordion) return;
  const filesEl = accordion.querySelector('.org-chat-store-files');
  if (!filesEl) return;
  const isOpen = filesEl.style.display !== 'none';
  filesEl.style.display = isOpen ? 'none' : 'block';
  accordion.classList.toggle('open', !isOpen);
}
window.orgChatToggleAccordion = orgChatToggleAccordion;

async function orgChatFetchStoreFiles(orgId) {
  const filesEl = document.getElementById('org-chat-files-' + orgId);
  if (!filesEl) return;
  try {
    const r = await fetch(`/api/org-contexts/${orgId}/files`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const files = (d.data && d.data.documents) || [];
    if (!files.length) {
      filesEl.innerHTML = '<div class="org-chat-files-empty">No files uploaded</div>';
      return;
    }
    filesEl.innerHTML = files.map(f => {
      const displayName = f.displayName || (f.name || '').split('/').pop();
      const state = (f.state || '').toUpperCase();
      const isActive = state === 'ACTIVE';
      return `<div class="org-chat-file-row">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.3"/></svg>
        <span class="org-chat-file-name">${esc(displayName)}</span>
        ${isActive ? '<span class="org-chat-file-status active">●</span>' : '<span class="org-chat-file-status processing">●</span>'}
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Fetch store files error:', err);
    filesEl.innerHTML = '<div class="org-chat-files-empty" style="color:#ef4444">Failed to load</div>';
  }
}

function orgChatToggleStore(checkbox) {
  const storeId = checkbox.value;
  const accordion = checkbox.closest('.org-chat-store-accordion');
  if (checkbox.checked) {
    if (!orgChatSelectedStores.includes(storeId)) orgChatSelectedStores.push(storeId);
    if (accordion) accordion.classList.add('selected');
  } else {
    orgChatSelectedStores = orgChatSelectedStores.filter(s => s !== storeId);
    if (accordion) accordion.classList.remove('selected');
  }
  orgChatSessionId = null;
  orgChatUpdateSelectedCount();
}
window.orgChatToggleStore = orgChatToggleStore;

function toggleOrgChat(ctx) {
  const panel = document.getElementById('org-chat-panel');
  if (!panel) return;
  orgChatOpen = !orgChatOpen;
  panel.style.display = orgChatOpen ? 'flex' : 'none';
  if (orgChatOpen) {
    // Use provided ctx, or fall back to first org that has a store
    if (ctx) {
      orgChatOrgId = ctx.id;
    } else if (!orgChatOrgId) {
      const withStore = orgContexts.find(o => o.storeId);
      orgChatOrgId = withStore ? withStore.id : (orgContexts[0] ? orgContexts[0].id : null);
    }
    const input = document.getElementById('org-chat-input');
    if (input) setTimeout(() => input.focus(), 100);
  }
}
window.toggleOrgChat = toggleOrgChat;

function orgChatReset() {
  orgChatSessionId = null;
  // Clear messages
  const msgs = document.getElementById('org-chat-messages');
  if (msgs) {
    msgs.innerHTML = `<div class="org-chat-welcome">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="color:#6366f1"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5"/></svg>
      <div class="org-chat-welcome-title">Organization Assistant</div>
      <div class="org-chat-welcome-sub">Ask questions about the uploaded documents and policies.</div>
    </div>`;
  }
  const input = document.getElementById('org-chat-input');
  if (input) input.value = '';
  // Go back to step 1
  orgChatGoToStep1();
}
window.orgChatReset = orgChatReset;

async function orgChatSend() {
  const input = document.getElementById('org-chat-input');
  const sendBtn = document.getElementById('org-chat-send-btn');
  const msgsEl = document.getElementById('org-chat-messages');
  if (!input || !msgsEl) return;

  const message = input.value.trim();
  if (!message) return;
  if (!orgChatOrgId) return;

  // Clear welcome if present
  const welcome = msgsEl.querySelector('.org-chat-welcome');
  if (welcome) welcome.remove();

  // Add user message bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'org-chat-msg user';
  userBubble.innerHTML = `<div class="org-chat-msg-content">${escHtml(message)}</div>`;
  msgsEl.appendChild(userBubble);

  // Add thinking indicator
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'org-chat-msg ai';
  thinkingEl.innerHTML = `<div class="org-chat-msg-content org-chat-thinking"><svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Thinking...</div>`;
  msgsEl.appendChild(thinkingEl);
  msgsEl.scrollTop = msgsEl.scrollHeight;

  input.value = '';
  input.disabled = true;
  if (sendBtn) sendBtn.disabled = true;

  try {
    const payload = {
      message,
      storeIds: orgChatSelectedStores,
    };
    if (orgChatSessionId) payload.sessionId = orgChatSessionId;

    const r = await fetch(`/api/org-contexts/${orgChatOrgId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const d = await r.json();
    thinkingEl.remove();

    if (!r.ok || !d.success) {
      throw new Error(d.error || 'Chat request failed');
    }

    orgChatSessionId = d.sessionId;

    // Add AI response bubble
    const aiBubble = document.createElement('div');
    aiBubble.className = 'org-chat-msg ai';
    let sourcesHtml = '';
    if (d.sources && d.sources.length) {
      sourcesHtml = `<div class="org-chat-sources">${d.sources.map(s => `<span class="org-chat-source-pill" title="${esc(s.uri || '')}">${esc(s.title || 'Source')}</span>`).join('')}</div>`;
    }
    aiBubble.innerHTML = `<div class="org-chat-msg-content">${formatOrgChatMarkdown(d.message || '')}</div>${sourcesHtml}`;
    msgsEl.appendChild(aiBubble);
    msgsEl.scrollTop = msgsEl.scrollHeight;

  } catch (err) {
    thinkingEl.remove();
    console.error('[OrgChat] Error:', err);
    const errBubble = document.createElement('div');
    errBubble.className = 'org-chat-msg ai';
    errBubble.innerHTML = `<div class="org-chat-msg-content org-chat-error">Error: ${escHtml(err.message)}</div>`;
    msgsEl.appendChild(errBubble);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  } finally {
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}
window.orgChatSend = orgChatSend;

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatOrgChatMarkdown(text) {
  // Simple markdown-like formatting
  let html = escHtml(text);
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Code blocks
  html = html.replace(/```[\s\S]*?```/g, m => {
    const code = m.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
    return `<pre><code>${code}</code></pre>`;
  });
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  // Lists
  html = html.replace(/(?:^|<br>)[-•]\s+(.*?)(?=<br>|$)/g, '<li>$1</li>');
  if (html.includes('<li>')) html = html.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>');
  return html;
}

// Clean up chat on navigating away
const origOrgBackToList = window.orgBackToList;
window.orgBackToList = function() {
  document.querySelectorAll('.org-chat-fab, .org-chat-panel').forEach(el => el.remove());
  orgChatSessionId = null;
  orgChatOrgId = null;
  orgChatOpen = false;
  orgChatExpanded = false;
  orgChatSelectedStores = [];
  if (origOrgBackToList) origOrgBackToList();
};

// ---- Org Context File Attachments ----

async function orgLoadFiles(orgId) {
  const listEl = document.getElementById('org-files-list-' + orgId);
  if (!listEl) return;
  try {
    const r = await fetch(`/api/org-contexts/${orgId}/files`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const files = (d.data && d.data.documents) || [];
    const storeId = d.storeId || '';
    if (!files.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">No files attached yet. Upload files to attach them to this organization.</div>';
      return;
    }
    listEl.innerHTML = files.map(f => {
      const docName = f.name || '';
      const docId = docName.split('/').pop();
      const displayName = f.displayName || docId;
      const state = (f.state || '').toUpperCase();
      const isActive = state === 'ACTIVE';
      const statusBadge = isActive
        ? '<span class="pi-file-status active">Active</span>'
        : `<span class="pi-file-status processing">${esc(state || 'PROCESSING')}</span>`;
      return `<div class="org-file-row">
        <div class="org-file-info">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.3"/></svg>
          <span class="org-file-name">${esc(displayName)}</span>
          ${statusBadge}
        </div>
        <div class="org-file-actions">
          ${isActive ? `<button class="pi-file-action-btn view" title="View file" onclick="event.stopPropagation();orgViewFile('${esc(orgId)}','${esc(docId)}','${esc(displayName)}')"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7s2.2-4.5 6-4.5S13 7 13 7s-2.2 4.5-6 4.5S1 7 1 7z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/></svg></button>` : ''}
          <button class="pi-file-action-btn delete" title="Delete file" onclick="event.stopPropagation();orgDeleteFile('${esc(orgId)}','${esc(docId)}','${esc(displayName)}')"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Org files load error:', err);
    listEl.innerHTML = '<div style="text-align:center;padding:16px;color:#ef4444;font-size:13px">Failed to load files.</div>';
  }
}
window.orgLoadFiles = orgLoadFiles;

async function orgUploadFile(orgId, input) {
  const files = input.files;
  if (!files || !files.length) return;
  const listEl = document.getElementById('org-files-list-' + orgId);
  if (listEl) {
    listEl.innerHTML = '<div style="text-align:center;padding:16px;color:#6366f1"><svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Uploading ' + files.length + ' file(s)...</div>';
  }

  for (const file of files) {
    try {
      const data = await fileToBase64(file);
      const r = await fetch(`/api/org-contexts/${orgId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', data })
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Upload failed'); }
      console.log(`[OrgFiles] Uploaded: ${file.name}`);
    } catch (err) {
      console.error(`[OrgFiles] Upload error for ${file.name}:`, err);
      toast('error', 'Upload failed', `"${file.name}": ${err.message}`);
    }
  }

  input.value = '';
  // Reload files list
  orgLoadFiles(orgId);
}
window.orgUploadFile = orgUploadFile;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function orgViewFile(orgId, fileId, fileName) {
  const url = `/api/org-contexts/${orgId}/files/${fileId}`;
  window.open(url, '_blank');
}
window.orgViewFile = orgViewFile;

async function orgDeleteFile(orgId, fileId, fileName) {
  const ok = await wbConfirm('Delete file', `Delete "${escapeHtml(fileName)}"?`, { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    const r = await fetch(`/api/org-contexts/${orgId}/files/${fileId}`, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Delete failed'); }
    console.log(`[OrgFiles] Deleted: ${fileName}`);
    orgLoadFiles(orgId);
  } catch (err) {
    console.error('[OrgFiles] Delete error:', err);
    wbAlert('Delete failed', `Failed to delete: ${escapeHtml(err.message)}`, { danger: true });
  }
}
window.orgDeleteFile = orgDeleteFile;

// Org search
const orgSearch = document.getElementById('org-search');
if (orgSearch) {
  orgSearch.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    renderOrgContextsList(q);
  });
}

// ─── Prompts Page ────────────────────────────────────────────

const PROMPTS_API_URL = 'https://muraji-api.wathbah.dev/api/prompts';
const LOCAL_PROMPTS_URL = '/api/local-prompts';
const PROMPTS_HIDDEN_IDS = ['64d28cc6-e8c2-4de1-8842-e1f9c65e9173'];

let adminLocalPrompts = [];
let adminApiPrompts = [];
let promptEditId = null;
let promptEditSource = null; // 'local' | 'api'

async function loadPrompts() {
  const listEl = document.getElementById('admin-prompts-list');
  if (listEl) listEl.innerHTML = '<div class="studio-loading"><svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading prompts...</span></div>';
  await Promise.all([fetchLocalPrompts(), fetchApiPrompts()]);
  renderPromptsList();
}

async function fetchLocalPrompts() {
  try {
    const r = await fetch(LOCAL_PROMPTS_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    adminLocalPrompts = d.prompts || [];
  } catch (e) { console.error('Local prompts error:', e); adminLocalPrompts = []; }
}

async function fetchApiPrompts() {
  try {
    const r = await fetch(PROMPTS_API_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    adminApiPrompts = Array.isArray(d) ? d : (d.data || d.prompts || []);
    adminApiPrompts = adminApiPrompts.filter(p => !PROMPTS_HIDDEN_IDS.includes(p._id || p.id));
  } catch (e) { console.error('API prompts error:', e); adminApiPrompts = []; }
}

function renderPromptsList(q) {
  const listEl = document.getElementById('admin-prompts-list');
  if (!listEl) return;

  let fLocal = adminLocalPrompts;
  let fApi = adminApiPrompts;
  if (q) {
    fLocal = adminLocalPrompts.filter(p => (p.name || '').toLowerCase().includes(q) || (p.content || '').toLowerCase().includes(q));
    fApi = adminApiPrompts.filter(p => (p.name || '').toLowerCase().includes(q) || (p.content || '').toLowerCase().includes(q));
  }

  let html = '';

  if (fLocal.length > 0) {
    html += '<div class="ap-section-header"><h3 class="ap-section-title">Local Prompts</h3><span class="badge badge-primary badge-round">Used by App</span></div>';
    html += '<div class="ap-grid">';
    fLocal.forEach(p => { html += promptCard(p, 'local'); });
    html += '</div>';
  }

  if (fApi.length > 0) {
    html += '<div class="ap-section-header" style="margin-top:20px"><h3 class="ap-section-title">API Prompts</h3><span class="badge badge-gray badge-round">From Muraji API</span></div>';
    html += '<div class="ap-grid">';
    fApi.forEach(p => { html += promptCard(p, 'api'); });
    html += '</div>';
  }

  if (!html) {
    html = '<div class="admin-card empty-state-box" style="text-align:center;padding:40px"><h3>No prompts found</h3><p style="color:#6b7280;font-size:12px">Create a new prompt or check your API connection.</p></div>';
  }

  listEl.innerHTML = html;
}

function promptCard(p, src) {
  const id = p._id || p.id;
  const nm = p.name || 'Untitled';
  const v = p.version || 1;
  const ct = p.content || '';
  const prev = ct.substring(0, 180);
  const isL = src === 'local';
  const cAt = p.created_at || p.createdAt;
  const uAt = p.updated_at || p.updatedAt;

  let note = '';
  if (id === '8c0a228d-1fa7-47f6-9df6-4354b72f8134') note = 'Used in both applied control and requirement evidence assessments';
  if (id === 'b596eb43-d411-4fe6-9d80-0ab113673678') note = 'Used in extracting entities from evidence in CISO version';

  return `
    <div class="ap-card ${isL ? 'ap-card-local' : ''}">
      <div class="ap-card-top">
        <div class="ap-card-name-row">
          <span class="ap-card-name">${esc(nm)}</span>
          ${isL ? '<span class="badge badge-emerald" style="font-size:9px">LOCAL</span>' : ''}
          ${!isL ? '<span class="badge badge-gray" style="font-size:9px">v' + v + '</span>' : ''}
        </div>
        <div class="ap-card-actions">
          <button class="btn-admin-ghost btn-admin-sm" onclick="adminEditPrompt('${esc(id)}','${src}')" title="Edit">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          ${!isL ? `<button class="btn-admin-ghost btn-admin-sm" onclick="adminDeletePrompt('${esc(id)}','${esc(nm).replace(/'/g, "\\\\'")}')" title="Delete">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>` : ''}
        </div>
      </div>
      ${prev ? `<div class="ap-card-preview"><pre>${esc(prev)}${ct.length > 180 ? '…' : ''}</pre></div>` : ''}
      <div class="ap-card-footer">
        ${uAt ? `<span class="ap-card-date">Updated ${fmtRelDate(uAt)}</span>` : ''}
        ${cAt ? `<span class="ap-card-date">Created ${fmtRelDate(cAt)}</span>` : ''}
      </div>
      ${note ? `<div class="ap-card-note">${esc(note)}</div>` : ''}
    </div>`;
}

function fmtRelDate(s) {
  try {
    const d = new Date(s), n = new Date(), ms = n - d;
    const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; if (h < 24) return h + 'h ago'; if (dy < 7) return dy + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return s; }
}

// Prompts search
const adminPromptsSearch = document.getElementById('admin-prompts-search');
if (adminPromptsSearch) {
  adminPromptsSearch.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    renderPromptsList(q || undefined);
  });
}

// Prompt modal
const promptModal = document.getElementById('prompt-modal-overlay');
const promptModalTitle = document.getElementById('prompt-modal-title');
const promptModalClose = document.getElementById('prompt-modal-close');
const promptModalCancel = document.getElementById('prompt-modal-cancel');
const promptModalSave = document.getElementById('prompt-modal-save');

function openPromptModal() { promptModal.classList.add('active'); document.body.style.overflow = 'hidden'; }
function closePromptModal() { promptModal.classList.remove('active'); document.body.style.overflow = ''; promptEditId = null; promptEditSource = null; document.getElementById('prompt-edit-name').value = ''; document.getElementById('prompt-edit-content').value = ''; }

promptModalClose?.addEventListener('click', closePromptModal);
promptModalCancel?.addEventListener('click', closePromptModal);
promptModal?.addEventListener('click', e => { if (e.target === promptModal) closePromptModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && promptModal?.classList.contains('active')) closePromptModal(); });

// New prompt
document.getElementById('btn-new-prompt')?.addEventListener('click', () => {
  promptEditId = null;
  promptEditSource = 'api';
  promptModalTitle.textContent = 'New Prompt';
  document.getElementById('prompt-edit-name').value = '';
  document.getElementById('prompt-edit-content').value = '';
  openPromptModal();
  document.getElementById('prompt-edit-name').focus();
});

// Edit prompt
async function adminEditPrompt(id, src) {
  promptEditId = id;
  promptEditSource = src || 'api';
  promptModalTitle.textContent = 'Edit Prompt';

  const nameEl = document.getElementById('prompt-edit-name');
  const contentEl = document.getElementById('prompt-edit-content');

  if (src === 'local') {
    const c = adminLocalPrompts.find(p => p.id === id);
    nameEl.value = c?.name || '';
    contentEl.value = c?.content || '';
    openPromptModal();
    try {
      const r = await fetch(LOCAL_PROMPTS_URL + '/' + id);
      if (r.ok) { const d = await r.json(); const p = d.prompt || d; nameEl.value = p.name || ''; contentEl.value = p.content || ''; }
    } catch (e) { console.error(e); toast('error', 'Error', e.message); }
  } else {
    const c = adminApiPrompts.find(p => (p._id || p.id) === id);
    nameEl.value = c?.name || '';
    contentEl.value = c?.content || '';
    openPromptModal();
    try {
      const r = await fetch(PROMPTS_API_URL + '/' + id);
      if (r.ok) { const d = await r.json(); const p = d.data || d.prompt || d; nameEl.value = p.name || ''; contentEl.value = p.content || ''; }
    } catch (e) { console.error(e); toast('error', 'Error', e.message); }
  }
  nameEl.focus();
}
window.adminEditPrompt = adminEditPrompt;

// Save prompt
promptModalSave?.addEventListener('click', async () => {
  const nm = document.getElementById('prompt-edit-name').value.trim();
  const ct = document.getElementById('prompt-edit-content').value.trim();
  if (!nm) { toast('error', 'Validation', 'Name is required.'); document.getElementById('prompt-edit-name').focus(); return; }
  if (!ct) { toast('error', 'Validation', 'Content is required.'); document.getElementById('prompt-edit-content').focus(); return; }

  const body = { name: nm, content: ct };
  const btnT = promptModalSave.querySelector('.btn-text');
  const btnL = promptModalSave.querySelector('.btn-loading');

  try {
    promptModalSave.disabled = true;
    if (btnT) btnT.classList.add('hidden');
    if (btnL) btnL.classList.remove('hidden');

    let r;
    if (promptEditSource === 'local' && promptEditId) {
      r = await fetch(LOCAL_PROMPTS_URL + '/' + promptEditId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else if (promptEditId) {
      r = await fetch(PROMPTS_API_URL + '/' + promptEditId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      r = await fetch(PROMPTS_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error || 'HTTP ' + r.status); }

    closePromptModal();
    toast('success', promptEditId ? 'Updated' : 'Created', 'Prompt "' + nm + '" saved.');
    await loadPrompts();
  } catch (e) {
    console.error(e);
    toast('error', 'Save Failed', e.message);
  } finally {
    promptModalSave.disabled = false;
    if (btnT) btnT.classList.remove('hidden');
    if (btnL) btnL.classList.add('hidden');
  }
});

// Delete prompt
async function adminDeletePrompt(id, nm) {
  if (!await showConfirm({ title: 'Delete Prompt', message: `Delete "${nm}"?`, confirmText: 'Delete' })) return;
  try {
    const r = await fetch(PROMPTS_API_URL + '/' + id, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error || 'HTTP ' + r.status); }
    toast('success', 'Deleted', '"' + nm + '" deleted.');
    await loadPrompts();
  } catch (e) { console.error(e); toast('error', 'Delete Failed', e.message); }
}
window.adminDeletePrompt = adminDeletePrompt;

// Clear cache
document.getElementById('btn-prompts-clear-cache')?.addEventListener('click', async () => {
  try {
    const r = await fetch(PROMPTS_API_URL + '/cache/clear', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('success', 'Cache Cleared', 'API prompt cache cleared.');
    await loadPrompts();
  } catch (e) { console.error(e); toast('error', 'Failed', e.message); }
});

// ─── Controls Studio ──────────────────────────────────────────

const CS_STEPS = [
  { label: 'Org Context', icon: '1' },
  { label: 'Requirements', icon: '2' },
  { label: 'References', icon: '3' },
  { label: 'Generate', icon: '4' },
  { label: 'Review', icon: '5' },
  { label: 'Export', icon: '6' },
];

/** Map persisted step from previous wizard order (Req→Ref→Org) to Org→Req→Ref first. */
function migrateCsWizardStep(stored) {
  const s = stored == null ? 0 : Number(stored);
  if (Number.isNaN(s)) return 0;
  if (s <= 2) return [1, 2, 0][s];
  return s;
}

/** Set of obligatory framework identifiers from org profile (UUIDs from GRC + lowercased lookups). Missing/empty mandates → null. */
function csOrgMandatoryFrameworkKeySet(orgCtx) {
  if (!orgCtx || !Array.isArray(orgCtx.obligatoryFrameworks)) return null;
  const raw = orgCtx.obligatoryFrameworks.map(x => String(x).trim()).filter(Boolean);
  if (!raw.length) return null;
  const set = new Set();
  raw.forEach(r => {
    set.add(r);
    set.add(r.toLowerCase());
  });
  return set;
}

function csGrcFrameworkMatchesMandatory(fw, keySet) {
  if (!fw || !keySet || keySet.size === 0) return false;
  const candidates = [];
  for (const prop of ['id', 'uuid', 'urn']) {
    const v = fw[prop];
    if (v != null && String(v).trim()) candidates.push(String(v).trim());
  }
  for (const prop of ['ref_id', 'name']) {
    const v = fw[prop];
    if (v != null && String(v).trim()) candidates.push(String(v).trim());
  }
  return candidates.some(p => keySet.has(p) || keySet.has(p.toLowerCase()));
}

/** GRC frameworks that match the org’s obligatory framework list only. */
function csGetStudioFrameworksForOrg(orgCtx, allLibraries) {
  if (!Array.isArray(allLibraries) || !allLibraries.length || !orgCtx) return [];
  const keySet = csOrgMandatoryFrameworkKeySet(orgCtx);
  if (!keySet) return [];
  return allLibraries.filter(fw => csGrcFrameworkMatchesMandatory(fw, keySet));
}

/** Remove requirement selections / cached trees that are outside the selected org’s permitted frameworks. */
function csSyncStudioRequirementsToOrgFrameworks() {
  if (!csSessionData) return;
  const org = csSessionData.orgContext;
  const allowedFw = csGetStudioFrameworksForOrg(org, csLibraries || []);
  const allowedIds = new Set(allowedFw.map(fw => String(fw.id)));
  Object.keys(csFrameworkTrees).forEach(k => {
    if (!allowedIds.has(String(k))) delete csFrameworkTrees[k];
  });
  const keySet = csOrgMandatoryFrameworkKeySet(org);
  if (!org || !keySet || allowedIds.size === 0) {
    csSessionData.requirements = [];
  } else {
    csSessionData.requirements = (csSessionData.requirements || []).filter(r =>
      r.frameworkId != null && allowedIds.has(String(r.frameworkId))
    );
  }
}

// CS Sessions — DB-backed via API
let csCachedSessions = null; // in-memory cache, loaded from API

async function csGetSessions() {
  if (csCachedSessions !== null) return csCachedSessions;
  try {
    const d = await fetchJSON(API.csSessions);
    csCachedSessions = d.sessions || [];
  } catch (e) { console.error('csGetSessions:', e); csCachedSessions = []; }
  return csCachedSessions;
}

async function csSaveSession(session) {
  try {
    const existing = (await csGetSessions()).find(s => s.id === session.id);
    const method = existing ? 'PUT' : 'POST';
    const url = existing ? API.csSessions + '/' + session.id : API.csSessions;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
    const data = await res.json();
    if (data.success && data.session) {
      // Update cache
      if (csCachedSessions) {
        const idx = csCachedSessions.findIndex(s => s.id === data.session.id);
        if (idx >= 0) csCachedSessions[idx] = data.session;
        else csCachedSessions.unshift(data.session);
      }
      return data.session;
    }
  } catch (e) { console.error('csSaveSession:', e); }
  return session;
}

async function csDeleteSession(id) {
  try {
    await fetch(API.csSessions + '/' + id, { method: 'DELETE' });
    if (csCachedSessions) csCachedSessions = csCachedSessions.filter(s => s.id !== id);
  } catch (e) { console.error('csDeleteSession:', e); }
}

function loadControlsStudio() {
  if (csMode === 'sessions') csShowSessions();
}

async function csShowSessions() {
  csMode = 'sessions';
  csJustExported = false;
  document.getElementById('cs-step-indicator').style.display = 'none';
  document.getElementById('cs-back-to-sessions').style.display = 'none';

  // Reset subtitle
  const subtitleEl = document.querySelector('#page-controls-studio .page-subtitle');
  if (subtitleEl) subtitleEl.textContent = 'AI-powered control suggestions for framework requirements — proactive setup before audits';

  const content = document.getElementById('cs-content');
  content.innerHTML = '<div class="studio-loading"><svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading sessions...</span></div>';

  csCachedSessions = null;
  const csSessions = await csGetSessions();

  // Compute stats
  const totalSessions = csSessions.length;
  const totalControls = csSessions.reduce((a, s) => a + (s.controls || []).length, 0);
  const totalExported = csSessions.filter(s => s.status === 'exported').reduce((a, s) => a + (s.controls || []).length, 0);
  const exported = csSessions.filter(s => s.status === 'exported').length;
  const mergeAvailable = 0; // placeholder for future merge feature

  let h = `
    <div class="cs-stats-grid">
      <div class="cs-stat-card">
        <div class="cs-stat-icon cs-stat-icon-primary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4H14M2 8H14M2 12H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <div class="cs-stat-value">${totalSessions}</div>
        <div class="cs-stat-label">Total Sessions</div>
      </div>
      <div class="cs-stat-card">
        <div class="cs-stat-icon cs-stat-icon-emerald">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M6 8L7.5 9.5L10 6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="cs-stat-value">${totalControls}</div>
        <div class="cs-stat-label">Controls Generated</div>
      </div>
      <div class="cs-stat-card">
        <div class="cs-stat-icon cs-stat-icon-sky">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 8L7 11L12 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 8A5 5 0 1 1 3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <div class="cs-stat-value">${totalExported}</div>
        <div class="cs-stat-label">Controls Exported</div>
      </div>
      <div class="cs-stat-card">
        <div class="cs-stat-icon cs-stat-icon-amber">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 4L8 7L11 4M5 9L8 12L11 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="cs-stat-value">${mergeAvailable}</div>
        <div class="cs-stat-label">Merge Available</div>
      </div>
    </div>`;

  // Session list card
  h += `<div class="cs-list-card">`;
  h += `<div class="cs-list-header">
    <div>
      <h2 class="cs-list-title">Studio Sessions</h2>
      <p class="cs-list-subtitle">${exported} exported, ${totalSessions - exported} in progress</p>
    </div>
    <button class="btn-admin-primary btn-admin-sm" onclick="csNewSession()">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      New Session
    </button>
  </div>`;

  if (!csSessions.length) {
    h += `<div class="cs-empty-state">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="16" stroke="#e5e7eb" stroke-width="2"/><path d="M14 20L18 24L26 16" stroke="#d1d5db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h3>No studio sessions yet</h3>
      <p>Start a new session to generate AI-suggested applied controls for your framework requirements.</p>
    </div>`;
  } else {
    h += '<div class="cs-list-rows">';
    h += csSessions.map(s => {
      const reqCount = (s.requirements || []).length;
      const ctrlCount = (s.controls || []).length;
      const exportedCtrl = s.status === 'exported' ? ctrlCount : 0;

      // Status badge
      const statusCfg = s.status === 'exported'
        ? { label: 'Exported', cls: 'cs-badge-emerald' }
        : s.status === 'generated'
        ? { label: 'Generated', cls: 'cs-badge-amber' }
        : { label: 'Draft', cls: 'cs-badge-gray' };

      // Org context name
      const orgName = s.orgContext?.nameEn || s.orgContext?.name || '';

      // Framework names from requirements
      const fwSet = new Set();
      (s.requirements || []).forEach(r => { if (r.frameworkName) fwSet.add(r.frameworkName); });
      const fwNames = [...fwSet];

      // Action config
      let actionLabel, actionIcon;
      if (s.status === 'draft') { actionLabel = 'Resume'; actionIcon = '<path d="M5 3L12 8L5 13V3Z" fill="currentColor"/>'; }
      else if (s.status === 'generated') { actionLabel = 'Review'; actionIcon = '<path d="M2 8C2 8 5 3 8 3C11 3 14 8 14 8C14 8 11 13 8 13C5 13 2 8 2 8Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>'; }
      else { actionLabel = 'View Results'; actionIcon = '<path d="M2 8C2 8 5 3 8 3C11 3 14 8 14 8C14 8 11 13 8 13C5 13 2 8 2 8Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/>'; }

      return `
        <div class="cs-session-row" onclick="csOpenSession('${esc(s.id)}')">
          <div class="cs-session-main">
            <div class="cs-session-name-row">
              <span class="cs-session-name">${esc(s.name || 'Unnamed Session')}</span>
              <span class="cs-badge ${statusCfg.cls}">${statusCfg.label}</span>
            </div>
            <div class="cs-session-meta">
              <span class="cs-meta-date">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2 6H12M5 2V4M9 2V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                ${fmtDate(s.created_at || s.createdAt)}
              </span>
              ${orgName ? `<span>${esc(orgName)}</span>` : ''}
              ${fwNames.length ? `<span class="cs-meta-sep">|</span><span>${esc(fwNames.join(', '))}</span>` : ''}
            </div>
          </div>
          <div class="cs-session-numbers">
            <div class="cs-num-col">
              <div class="cs-num-val">${reqCount}</div>
              <div class="cs-num-label">Reqs</div>
            </div>
            <div class="cs-num-col">
              <div class="cs-num-val">${ctrlCount}</div>
              <div class="cs-num-label">Generated</div>
            </div>
            <div class="cs-num-col">
              <div class="cs-num-val cs-num-emerald">${exportedCtrl}</div>
              <div class="cs-num-label">Exported</div>
            </div>
          </div>
          <div class="cs-session-actions">
            <button class="cs-action-btn" onclick="event.stopPropagation();csOpenSession('${esc(s.id)}')">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">${actionIcon}</svg>
              ${actionLabel}
            </button>
            <button class="cs-delete-btn" onclick="event.stopPropagation();csDeleteSessionConfirm('${esc(s.id)}','${esc((s.name || 'Unnamed').replace(/'/g, "\\'"))}')">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <svg class="cs-row-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>`;
    }).join('');
    h += '</div>';
  }
  h += '</div>';

  content.innerHTML = h;
}
window.csShowSessions = csShowSessions;

async function csNewSession() {
  const sessions = await csGetSessions();
  csSessionData = {
    id: Date.now().toString(),
    name: 'Session ' + (sessions.length + 1),
    created_at: new Date().toISOString(),
    step: 0,
    requirements: [],
    collections: [],
    selectedFiles: [],
    sessionFiles: [],
    orgContext: null,
    controls: [],
    status: 'draft',
    complianceAssessment: '',
  };
  // Save to DB immediately
  await csSaveSession(csSessionData);
  csCurrentStep = 0;
  csMode = 'wizard';
  document.getElementById('cs-back-to-sessions').style.display = '';
  csRenderWizard();
}
window.csNewSession = csNewSession;

async function csOpenSession(id) {
  try {
    const d = await fetchJSON(API.csSessions + '/' + id);
    if (d.success && d.session) {
      csSessionData = d.session;
      const orgId = csSessionData.orgContext && csSessionData.orgContext.id;
      if (orgId) {
        try {
          const od = await fetchJSON(API.orgContexts + '/' + encodeURIComponent(orgId));
          if (od.success && od.context) {
            csSessionData.orgContext = { ...csSessionData.orgContext, ...od.context };
          }
        } catch (_) { /* use embedded org only */ }
      }
      // For exported/generated sessions, jump straight to the review step
      if (csSessionData.status === 'exported' || csSessionData.status === 'generated') {
        csCurrentStep = 4; // Review step
      } else {
        csCurrentStep = migrateCsWizardStep(csSessionData.step);
        csSessionData.step = csCurrentStep;
      }
      csMode = 'wizard';
      document.getElementById('cs-back-to-sessions').style.display = '';

      // Update subtitle with session name
      const subtitleEl = document.querySelector('#page-controls-studio .page-subtitle');
      if (subtitleEl && csSessionData.name) {
        subtitleEl.innerHTML = 'Viewing results for: <strong>' + esc(csSessionData.name) + '</strong>';
      }

      csRenderWizard();
    }
  } catch (e) {
    console.error('csOpenSession:', e);
    toast('error', 'Error', 'Could not load session.');
  }
}
window.csOpenSession = csOpenSession;

async function csDeleteSessionConfirm(id, name) {
  if (!await showConfirm({ title: 'Delete Session', message: `Delete session "${name}"?`, confirmText: 'Delete' })) return;
  await csDeleteSession(id);
  toast('success', 'Deleted', 'Session deleted.');
  csCachedSessions = null; // Force refresh
  csShowSessions();
}
window.csDeleteSessionConfirm = csDeleteSessionConfirm;

function csRenderWizard() {
  // Step indicator - hide for exported/generated sessions viewing results
  const indEl = document.getElementById('cs-step-indicator');
  const isReadOnly = csSessionData.status === 'exported' || csSessionData.status === 'generated';
  if (isReadOnly && csCurrentStep === 4) {
    indEl.style.display = 'none';
  } else {
    indEl.style.display = '';
  }
  let stepsH = '<div class="cs-steps-row">';
  CS_STEPS.forEach((s, i) => {
    const state = i < csCurrentStep ? 'completed' : (i === csCurrentStep ? 'current' : 'future');
    const clickable = i <= csCurrentStep ? 'clickable' : '';
    stepsH += `
      <div class="cs-step-item ${clickable}" ${clickable ? `onclick="csGoStep(${i})"` : ''}>
        <div class="cs-step-circle ${state}">
          ${state === 'completed' ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7L6 10L11 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : (i + 1)}
        </div>
        <span class="cs-step-label ${state}">${s.label}</span>
      </div>`;
    if (i < CS_STEPS.length - 1) {
      stepsH += `<div class="cs-step-line ${i < csCurrentStep ? 'completed' : 'future'}"></div>`;
    }
  });
  stepsH += '</div>';
  indEl.innerHTML = stepsH;

  // Render current step content
  const content = document.getElementById('cs-content');
  switch (csCurrentStep) {
    case 0: csRenderStepOrgContext(content); break;
    case 1: csRenderStepRequirements(content); break;
    case 2: csRenderStepReferences(content); break;
    case 3: csRenderStepGenerate(content); break;
    case 4: csRenderStepReview(content); break;
    case 5: csRenderStepExport(content); break;
    default: csRenderStepOrgContext(content);
  }
}

function csGoStep(i) {
  if (i <= csCurrentStep) {
    csCurrentStep = i;
    if (csSessionData) csSessionData.step = i;
    csRenderWizard();
  }
}
window.csGoStep = csGoStep;

// Step 2: Requirements — with real data
function csRenderStepRequirements(el) {
  const reqs = csSessionData.requirements || [];
  const fwCount = new Set(reqs.map(r => r.frameworkName)).size;
  el.innerHTML = `
    <div class="cs-wizard-card">
      <div class="cs-wizard-header navy">
        <div class="cs-wizard-header-title">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="white" stroke-width="1.5"/><path d="M6 9L8 11L12 7" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Step 2: Select Requirements
        </div>
        <div class="cs-wizard-header-desc">Choose requirements only from frameworks linked to this organization profile (<strong>Obligatory frameworks</strong> in Organization Contexts). Expand a framework to select sections.</div>
        <div class="cs-wizard-header-stat">
          <span class="big" id="cs-req-count">${reqs.length}</span>
          <span class="label">requirements from ${fwCount} frameworks</span>
        </div>
      </div>
      <div class="cs-wizard-body">
        <div class="studio-search-bar" style="margin-bottom:10px">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M9 9L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <input type="text" placeholder="Search frameworks..." id="cs-fw-search" autocomplete="off">
          <div class="studio-search-actions">
            <button type="button" class="btn-studio-filter" id="cs-select-all-btn">Select All</button>
            <button type="button" class="btn-studio-filter" id="cs-clear-all-btn">Clear</button>
          </div>
        </div>
        <div id="cs-fw-list" class="studio-fw-list" style="max-height:55vh;overflow-y:auto">
          <div class="studio-loading"><svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading frameworks...</span></div>
        </div>
      </div>
      <div class="cs-wizard-footer">
        <button class="btn-admin-ghost" onclick="csSaveStep();csCurrentStep=0;csSessionData.step=0;csRenderWizard()">← Back</button>
        <button class="btn-admin-primary" onclick="csSaveStep();csCurrentStep=2;csSessionData.step=2;csRenderWizard()">
          Next &nbsp;→
        </button>
      </div>
    </div>`;

  // Fetch frameworks from GRC + compliance assessments
  (async () => {
    if (!csLibraries.length) {
      try {
        const d = await fetch('/api/grc/frameworks').then(r => r.json());
        if (d.success && Array.isArray(d.results)) csLibraries = d.results;
      } catch (e) { console.error('CS GRC frameworks fetch:', e); }
    }
    csSyncStudioRequirementsToOrgFrameworks();
    await csSaveStep();
    csRenderFwList();
    csAttachFwSearch();
    csUpdateReqCount();
  })();
}

// When compliance assessment changes, fetch its tree (keys = RA UUIDs)
async function csOnComplianceAssessmentChange() {
  const caSelect = document.getElementById('cs-compliance-assessment');
  const statusEl = document.getElementById('cs-ca-status');
  const caId = caSelect ? caSelect.value : '';

  csSessionData.complianceAssessment = caId;
  csSessionData.caTree = null; // reset cached CA tree

  // Clear framework tree caches so they reload from CA tree
  Object.keys(csFrameworkTrees).forEach(k => delete csFrameworkTrees[k]);

  if (!caId) {
    if (statusEl) statusEl.textContent = 'Select the compliance assessment to link requirements from';
    return;
  }

  if (statusEl) statusEl.innerHTML = '<span style="color:#60a5fa">Loading compliance assessment tree...</span>';

  try {
    const d = await fetch(`/api/grc/compliance-assessments/${caId}/tree`).then(r => r.json());
    if (!d.success || !d.tree) throw new Error('No tree data');
    csSessionData.caTree = d.tree;
    console.log(`[Step 1] CA tree loaded for ${caId}`, Object.keys(d.tree).length, 'top-level entries');
    if (statusEl) statusEl.innerHTML = `<span style="color:#10b981">✓ Compliance assessment loaded</span>`;

    csSyncStudioRequirementsToOrgFrameworks();
    csRenderFwList();
  } catch (err) {
    console.error('[Step 1] Failed to fetch CA tree:', err);
    if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444">⚠ ${err.message}</span>`;
  }
}
window.csOnComplianceAssessmentChange = csOnComplianceAssessmentChange;

// Cache for loaded framework trees  { fwId -> flatNodes[] }
const csFrameworkTrees = {};

function csRenderFwList() {
  const listEl = document.getElementById('cs-fw-list');
  if (!listEl) return;
  const reqs = csSessionData.requirements || [];
  const org = csSessionData.orgContext;

  if (!csLibraries.length) {
    listEl.innerHTML = '<div class="studio-empty-msg">No frameworks loaded from GRC.</div>';
    return;
  }

  if (!org) {
    listEl.innerHTML = '<div class="studio-empty-msg">Select an Organization Context first (go back to step 1).</div>';
    return;
  }

  const mandateKeys = csOrgMandatoryFrameworkKeySet(org);
  if (!mandateKeys) {
    listEl.innerHTML = '<div class="studio-empty-msg">This organization profile has no obligatory frameworks. <button type="button" class="inline-link" onclick="navigateTo(\'org-contexts\')">Open Organization Contexts</button> to edit the profile and select frameworks.</div>';
    return;
  }

  const fwList = csGetStudioFrameworksForOrg(org, csLibraries);
  if (!fwList.length) {
    listEl.innerHTML = '<div class="studio-empty-msg">No GRC frameworks match this profile’s obligatory framework list. Confirm mandate IDs in <button type="button" class="inline-link" onclick="navigateTo(\'org-contexts\')">Organization Contexts</button> match frameworks in your GRC tenant.</div>';
    return;
  }

  let html = '';
  fwList.forEach((fw, li) => {
    const fwName = fw.name || fw.ref_id || 'Unknown Framework';
    const groupId = 'csg-' + li;
    const fwId = fw.id;
    // Count selected requirements in this framework
    const selectedInGroup = reqs.filter(r => r.frameworkId === fwId).length;
    const cachedNodes = csFrameworkTrees[fwId];
    const nodeCount = cachedNodes ? cachedNodes.length : '';

    html += `<div class="studio-fw-group collapsed" data-group-id="${groupId}" data-fw-id="${fwId}">
      <div class="studio-fw-group-header">
        <div class="cs-fw-cb" onclick="event.stopPropagation();csToggleFwGroup('${groupId}','${esc(fwName)}')" style="cursor:pointer">
          <span class="studio-cb-mark ${cachedNodes && selectedInGroup === cachedNodes.length && cachedNodes.length > 0 ? 'checked' : (selectedInGroup > 0 ? 'indeterminate' : '')}"></span>
        </div>
        <div class="studio-fw-group-toggle" onclick="csGrcFwToggleGroup(this, '${fwId}')">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${esc(fwName)}</span>
          ${fw.provider ? `<span style="font-size:10px;color:#6b7280;margin-left:6px">(${esc(fw.provider)})</span>` : ''}
        </div>
        <div class="studio-fw-group-actions">
          <span class="studio-fw-group-count">${selectedInGroup > 0 ? selectedInGroup + '/' : ''}${nodeCount || '…'} req</span>
        </div>
      </div>
      <div class="studio-fw-group-items" id="cs-fw-items-${fwId}">
        ${cachedNodes ? csRenderFwTreeItems(cachedNodes, fwId, fwName, groupId, reqs) : '<div class="studio-loading"><svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading requirements…</span></div>'}
      </div>
    </div>`;
  });

  listEl.innerHTML = html;
}

// Flatten a GRC tree into assessable leaf nodes
function csFlattenTree(tree, depth = 0) {
  const nodes = [];
  for (const [nodeId, node] of Object.entries(tree)) {
    if (node.assessable) {
      nodes.push({
        nodeId,
        urn: node.urn || '',
        ref_id: node.ref_id || '',
        name: node.name || '',
        description: node.description || '',
        depth,
        assessable: true,
      });
    }
    if (node.children && Object.keys(node.children).length > 0) {
      nodes.push(...csFlattenTree(node.children, depth + 1));
    }
  }
  return nodes;
}

// Render requirement items for a loaded tree
function csRenderFwTreeItems(nodes, fwId, fwName, groupId, reqs) {
  return nodes.map(node => {
    const opt = {
      frameworkId: fwId,
      frameworkName: fwName,
      nodeId: node.nodeId,
      nodeUrn: node.urn,
      refId: node.ref_id,
      name: node.name,
      description: node.description,
      depth: node.depth,
      assessable: node.assessable,
    };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(opt))));
    const isSelected = reqs.some(r => r.nodeUrn === node.urn || r.nodeId === node.nodeId);
    const depthDot = node.depth === 0 ? '●' : node.depth === 1 ? '○' : node.depth === 2 ? '◦' : '·';
    const label = node.description || node.name || node.ref_id || '';
    return `<div class="studio-fw-item${isSelected ? ' selected' : ''}" data-opt="${encoded}" data-group-id="${groupId}" data-search="${esc((node.ref_id + ' ' + label + ' ' + fwName).toLowerCase())}" onclick="csToggleReq(this)">
      <div class="studio-fw-item-checkbox"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="studio-fw-item-content">
        ${node.ref_id ? `<span class="studio-fw-ref">${esc(node.ref_id)}</span>` : ''}
        <span class="studio-fw-desc"><span class="studio-fw-depth">${depthDot}</span> ${esc(label)}</span>
      </div>
    </div>`;
  }).join('');
}

// Toggle group: expand/collapse. On first expand, fetch tree from GRC.
async function csGrcFwToggleGroup(el, fwId) {
  const group = el.closest('.studio-fw-group');
  if (!group) return;
  const wasCollapsed = group.classList.contains('collapsed');
  group.classList.toggle('collapsed');

  // If expanding and tree not yet loaded, fetch it
  if (wasCollapsed && !csFrameworkTrees[fwId]) {
    const itemsEl = document.getElementById('cs-fw-items-' + fwId);
    if (!itemsEl) return;
    itemsEl.innerHTML = '<div class="studio-loading"><svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading requirements…</span></div>';
    try {
      let tree;
      // If CA tree is loaded, extract this framework's subtree (keys = RA UUIDs)
      const caTree = csSessionData.caTree;
      if (caTree && caTree[fwId]) {
        // CA tree has framework IDs at top level, children underneath
        tree = caTree[fwId].children || caTree[fwId];
        console.log(`[GRC] Using CA tree for framework ${fwId}`);
      } else {
        // Fallback: fetch from framework tree endpoint (keys = requirement node UUIDs)
        const d = await fetch(`/api/grc/frameworks/${fwId}/tree`).then(r => r.json());
        if (!d.success || !d.tree) throw new Error('No tree data');
        tree = d.tree;
        console.log(`[GRC] Using framework tree for ${fwId} (no CA tree available)`);
      }
      const flat = csFlattenTree(tree);
      csFrameworkTrees[fwId] = flat;
      // Find framework info
      const fw = csLibraries.find(f => f.id === fwId);
      const fwName = fw ? (fw.name || fw.ref_id) : 'Unknown';
      const groupId = group.dataset.groupId;
      const reqs = csSessionData.requirements || [];
      itemsEl.innerHTML = csRenderFwTreeItems(flat, fwId, fwName, groupId, reqs);
      // Update count in header
      const countEl = group.querySelector('.studio-fw-group-count');
      const selectedInGroup = reqs.filter(r => r.frameworkId === fwId).length;
      if (countEl) countEl.textContent = (selectedInGroup > 0 ? selectedInGroup + '/' : '') + flat.length + ' req';
    } catch (err) {
      console.error('[GRC] Tree fetch error:', err);
      itemsEl.innerHTML = '<div class="studio-empty-msg">Failed to load requirements.</div>';
    }
  }
}
window.csGrcFwToggleGroup = csGrcFwToggleGroup;

function csDecodeOpt(enc) {
  return JSON.parse(decodeURIComponent(escape(atob(enc))));
}

function csFwToggleGroup(el) {
  el.closest('.studio-fw-group').classList.toggle('collapsed');
}
window.csFwToggleGroup = csFwToggleGroup;

// Match a requirement by nodeId or nodeUrn (GRC uses nodeId, legacy uses nodeUrn)
function csReqMatch(r, opt) {
  if (opt.nodeId && r.nodeId === opt.nodeId) return true;
  if (opt.nodeUrn && r.nodeUrn === opt.nodeUrn) return true;
  return false;
}

function csToggleReq(itemEl) {
  const opt = csDecodeOpt(itemEl.dataset.opt);
  if (!csSessionData.requirements) csSessionData.requirements = [];
  const idx = csSessionData.requirements.findIndex(r => csReqMatch(r, opt));
  if (idx === -1) {
    csSessionData.requirements.push(opt);
    itemEl.classList.add('selected');
    console.log(`[Req Selected] refId=${opt.refId}, nodeId=${opt.nodeId}, nodeUrn=${opt.nodeUrn}, name=${opt.name}`);
  } else {
    csSessionData.requirements.splice(idx, 1);
    itemEl.classList.remove('selected');
    console.log(`[Req Deselected] refId=${opt.refId}, nodeId=${opt.nodeId}, nodeUrn=${opt.nodeUrn}`);
  }
  csUpdateReqCount();
  csUpdateFwGroupCheckboxes();
}
window.csToggleReq = csToggleReq;

function csToggleFwGroup(groupId, fwName) {
  if (!csSessionData.requirements) csSessionData.requirements = [];
  const group = document.querySelector(`.studio-fw-group[data-group-id="${groupId}"]`);
  if (!group) return;
  const items = group.querySelectorAll('.studio-fw-item');
  // Check if all visible items in group are selected
  const allSelected = Array.from(items).every(i => i.classList.contains('selected'));

  items.forEach(item => {
    const opt = csDecodeOpt(item.dataset.opt);
    const idx = csSessionData.requirements.findIndex(r => csReqMatch(r, opt));
    if (allSelected) {
      // Deselect all in group
      if (idx >= 0) csSessionData.requirements.splice(idx, 1);
      item.classList.remove('selected');
    } else {
      // Select all in group
      if (idx === -1) csSessionData.requirements.push(opt);
      item.classList.add('selected');
    }
  });
  csUpdateReqCount();
  csUpdateFwGroupCheckboxes();
}
window.csToggleFwGroup = csToggleFwGroup;

function csUpdateReqCount() {
  const reqs = csSessionData.requirements || [];
  const countEl = document.getElementById('cs-req-count');
  if (countEl) countEl.textContent = reqs.length;
  const fwCount = new Set(reqs.map(r => r.frameworkName)).size;
  const labelEl = countEl?.nextElementSibling;
  if (labelEl) labelEl.textContent = `requirements from ${fwCount} framework${fwCount !== 1 ? 's' : ''}`;
}

function csUpdateFwGroupCheckboxes() {
  const reqs = csSessionData.requirements || [];
  document.querySelectorAll('#cs-fw-list .studio-fw-group').forEach(group => {
    const items = group.querySelectorAll('.studio-fw-item');
    const total = items.length;
    const selected = Array.from(items).filter(i => i.classList.contains('selected')).length;
    const cb = group.querySelector('.cs-fw-cb .studio-cb-mark');
    if (cb) {
      cb.classList.toggle('checked', selected === total && total > 0);
      cb.classList.toggle('indeterminate', selected > 0 && selected < total);
    }
    const countEl = group.querySelector('.studio-fw-group-count');
    if (countEl) countEl.textContent = (selected > 0 ? selected + '/' : '') + total + ' req';
  });
}

function csAttachFwSearch() {
  const input = document.getElementById('cs-fw-search');
  if (input) {
    input.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('#cs-fw-list .studio-fw-group').forEach(group => {
        const items = group.querySelectorAll('.studio-fw-item');
        let vis = 0;
        items.forEach(item => {
          const match = !q || (item.dataset.search || '').includes(q);
          item.style.display = match ? '' : 'none';
          if (match) vis++;
        });
        group.style.display = vis > 0 ? '' : 'none';
        if (q && vis > 0) group.classList.remove('collapsed');
        else if (!q) group.classList.add('collapsed');
      });
    });
  }
  const selAllBtn = document.getElementById('cs-select-all-btn');
  if (selAllBtn) {
    selAllBtn.addEventListener('click', () => {
      if (!csSessionData.requirements) csSessionData.requirements = [];
      document.querySelectorAll('#cs-fw-list .studio-fw-item:not([style*="display: none"])').forEach(item => {
        const opt = csDecodeOpt(item.dataset.opt);
        if (!csSessionData.requirements.some(r => csReqMatch(r, opt))) {
          csSessionData.requirements.push(opt);
          item.classList.add('selected');
        }
      });
      csUpdateReqCount();
      csUpdateFwGroupCheckboxes();
    });
  }
  const clearBtn = document.getElementById('cs-clear-all-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      csSessionData.requirements = [];
      document.querySelectorAll('#cs-fw-list .studio-fw-item.selected').forEach(i => i.classList.remove('selected'));
      csUpdateReqCount();
      csUpdateFwGroupCheckboxes();
    });
  }
}

async function csSaveStep() {
  // Save current session to DB
  if (csSessionData) {
    await csSaveSession(csSessionData);
  }
}
window.csSaveStep = csSaveStep;

// Step 3: References — with real data (collections + files + upload)
function csRenderStepReferences(el) {
  if (!csSessionData.selectedFiles) csSessionData.selectedFiles = [];
  if (!csSessionData.collections) csSessionData.collections = [];
  if (!csSessionData.sessionFiles) csSessionData.sessionFiles = [];

  const selectedFileCount = csSessionData.selectedFiles.length;
  const selectedCollCount = csSessionData.collections.length;

  el.innerHTML = `
    <div class="cs-wizard-card">
      <div class="cs-wizard-header emerald">
        <div class="cs-wizard-header-title">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M16 11V15C16 15.6 15.6 16 15 16H3C2.4 16 2 15.6 2 15V11" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M12 6L9 3L6 6M9 3V11" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Step 3: Attach Reference Files
        </div>
        <div class="cs-wizard-header-desc">Select file collections with regulatory guidance, best practices, or existing control catalogs to inform AI suggestions.</div>
        <div class="cs-wizard-header-stat">
          <span class="big" id="cs-ref-file-count">${selectedFileCount}</span>
          <span class="label" id="cs-ref-coll-label">files from ${selectedCollCount} collections</span>
        </div>
      </div>
      <div class="cs-wizard-body">
        <button class="btn-studio-new-coll" type="button" id="cs-new-coll-btn">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5V11C2 11.6 2.4 12 3 12H11C11.6 12 12 11.6 12 11V7C12 6.4 11.6 6 11 6H7L5.5 4H3C2.4 4 2 4.4 2 5Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 7V10M5.5 8.5H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          New Collection
        </button>
        <div id="cs-ref-collections" class="studio-coll-list" style="max-height:280px;overflow-y:auto">
          <div class="studio-loading"><svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading collections...</span></div>
        </div>
        <div class="cs-session-upload-section">
          <label class="studio-field-label" style="margin-top:12px">Per-Session Upload</label>
          <div class="cs-drop-zone" id="cs-drop-zone">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M17 12V15C17 15.6 16.6 16 16 16H4C3.4 16 3 15.6 3 15V12" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round"/><path d="M13 7L10 4L7 7" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 4V13" stroke="#9ca3af" stroke-width="1.5" stroke-linecap="round"/></svg>
            <div class="cs-drop-text">Drop additional files for this session</div>
            <div class="cs-drop-hint">PDF, DOCX, XLSX</div>
          </div>
          <div id="cs-session-files-list" class="cs-session-files"></div>
        </div>
      </div>
      <div class="cs-wizard-footer">
        <button class="btn-admin-ghost" onclick="csSaveStep();csCurrentStep=1;csSessionData.step=1;csRenderWizard()">← Back</button>
        <button class="btn-admin-primary" onclick="csSaveStep();csCurrentStep=3;csSessionData.step=3;csRenderWizard()">
          Next &nbsp;→
        </button>
      </div>
    </div>`;

  // Load and render collections
  (async () => {
    await csFetchCollections();
    csRenderRefCollections();
    csRenderSessionFiles();
  })();

  // New Collection button
  const newCollBtn = document.getElementById('cs-new-coll-btn');
  if (newCollBtn) {
    newCollBtn.onclick = () => {
      const name = prompt('Collection name:');
      if (!name || !name.trim()) return;
      (async () => {
        try {
          toast('info', 'Creating...', `Setting up "${name}"...`);
          const res = await fetch('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name.trim() }) });
          const data = await res.json();
          if (data.success) {
            toast('success', 'Created', `"${name}" is ready.`);
            await csFetchCollections();
            csRenderRefCollections();
          } else throw new Error(data.error || 'Failed');
        } catch (err) { toast('error', 'Error', err.message); }
      })();
    };
  }

  // Per-session file upload (click + drag-and-drop)
  const dropZone = document.getElementById('cs-drop-zone');
  if (dropZone) {
    dropZone.onclick = () => csUploadSessionFiles();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      csProcessSessionFiles(files);
    };
  }
}

async function csFetchCollections() {
  try {
    const d = await fetchJSON(API.collections);
    const stores = d.data?.fileSearchStores || d.data || [];
    csCollectionsData = Array.isArray(stores) ? stores : [];
    await Promise.all(csCollectionsData.map(async store => {
      try {
        const sid = store.name.split('/').pop();
        const fd = await fetchJSON(API.collections + '/' + sid + '/files');
        store.files = fd.data?.documents || fd.data?.fileSearchDocuments || [];
      } catch { store.files = []; }
    }));
  } catch (e) { console.error('CS collections fetch:', e); csCollectionsData = []; }
}

function csRenderRefCollections() {
  const listEl = document.getElementById('cs-ref-collections');
  if (!listEl) return;

  if (!csCollectionsData.length) {
    listEl.innerHTML = '<div class="studio-empty-msg">No collections yet. Create one above.</div>';
    return;
  }

  let html = '';
  csCollectionsData.forEach(store => {
    const storeId = store.name.split('/').pop();
    const displayName = store.displayName || store.name || 'Untitled';
    const files = store.files || [];
    const activeFiles = files.filter(f => f.state === 'STATE_ACTIVE');
    const isCollSelected = csSessionData.collections.includes(storeId);
    const someFilesSelected = files.some(f => (csSessionData.selectedFiles || []).includes(storeId + '::' + (f.name || f.displayName)));

    html += `<div class="studio-coll-group collapsed" data-store-id="${storeId}">
      <div class="studio-coll-header">
        <div class="studio-coll-cb" onclick="event.stopPropagation();csToggleColl('${esc(storeId)}')">
          <span class="studio-cb-mark ${isCollSelected ? 'checked' : (someFilesSelected ? 'indeterminate' : '')}"></span>
        </div>
        <div class="studio-coll-toggle" onclick="this.closest('.studio-coll-group').classList.toggle('collapsed')">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="studio-coll-name">${esc(displayName)}</span>
        </div>
        <div class="studio-coll-actions">
          <span class="studio-coll-badge">${files.length} files</span>
          <button type="button" class="btn-studio-coll-upload" onclick="event.stopPropagation();csUploadToColl('${esc(storeId)}')" title="Upload">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M12 9V11.5C12 12.1 11.6 12.5 11 12.5H3C2.4 12.5 2 12.1 2 11.5V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.5 4.5L7 2L4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 2V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Upload
          </button>
          <button type="button" class="btn-studio-coll-delete" onclick="event.stopPropagation();csDeleteColl('${esc(storeId)}','${esc(displayName).replace(/'/g, "\\'")}')" title="Delete">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="studio-coll-files">`;

    if (!files.length) {
      html += '<div class="studio-empty-msg" style="font-size:11px">No files — click Upload.</div>';
    } else {
      files.forEach(f => {
        const fName = f.displayName || f.name || 'File';
        const state = f.state || 'UNKNOWN';
        const isActive = state === 'STATE_ACTIVE';
        const fileKey = storeId + '::' + (f.name || f.displayName);
        const isFileSelected = (csSessionData.selectedFiles || []).includes(fileKey);
        const stateClass = isActive ? 'active' : (state === 'STATE_PENDING' ? 'pending' : 'failed');
        const stateLabel = isActive ? 'Active' : (state === 'STATE_PENDING' ? 'Processing...' : 'Failed');
        const stateIcon = isActive ? '✓' : (state === 'STATE_PENDING' ? '◌' : '✗');

        const csDocId = (f.name || '').split('/').pop();
        html += `<div class="studio-file-item ${isFileSelected ? 'file-selected' : ''}" data-file-key="${esc(fileKey)}">
          ${isActive ? `<div class="studio-file-cb" onclick="event.stopPropagation();csToggleFile('${esc(storeId)}','${esc(fileKey).replace(/'/g, "\\'")}')"><span class="studio-cb-mark ${isFileSelected ? 'checked' : ''}"></span></div>` : '<span style="width:22px;display:inline-block"></span>'}
          <svg class="studio-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H9L13 6V14C13 14.6 12.6 15 12 15H3C2.4 15 2 14.6 2 14V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 2V6H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="studio-file-name">${esc(fName)}</span>
          <span class="studio-file-state ${stateClass}">${stateIcon} ${stateLabel}</span>
          ${isActive && csDocId ? `<button class="btn-admin-sm" onclick="event.stopPropagation();viewFileInCollection('${esc(storeId)}','${esc(csDocId)}')" title="View file" style="padding:2px 6px;font-size:11px;margin-left:auto"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M1 7C1 7 3.5 2.5 7 2.5C10.5 2.5 13 7 13 7C13 7 10.5 11.5 7 11.5C3.5 11.5 1 7 1 7Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/></svg></button>` : ''}
        </div>`;
      });
    }

    html += '</div></div>';
  });

  listEl.innerHTML = html;

  // Auto-poll pending
  const pendingTotal = csCollectionsData.reduce((s, c) => s + (c.files || []).filter(f => f.state === 'STATE_PENDING').length, 0);
  if (csPendingPoll) clearTimeout(csPendingPoll);
  if (pendingTotal > 0) {
    csPendingPoll = setTimeout(async () => {
      await csFetchCollections();
      csRenderRefCollections();
    }, 5000);
  }
}

function csToggleColl(storeId) {
  if (!csSessionData.collections) csSessionData.collections = [];
  if (!csSessionData.selectedFiles) csSessionData.selectedFiles = [];
  const store = csCollectionsData.find(s => s.name.split('/').pop() === storeId);
  const activeFiles = (store?.files || []).filter(f => f.state === 'STATE_ACTIVE');
  const idx = csSessionData.collections.indexOf(storeId);

  if (idx >= 0) {
    csSessionData.collections.splice(idx, 1);
    activeFiles.forEach(f => {
      const key = storeId + '::' + (f.name || f.displayName);
      const fi = csSessionData.selectedFiles.indexOf(key);
      if (fi >= 0) csSessionData.selectedFiles.splice(fi, 1);
    });
  } else {
    csSessionData.collections.push(storeId);
    activeFiles.forEach(f => {
      const key = storeId + '::' + (f.name || f.displayName);
      if (!csSessionData.selectedFiles.includes(key)) csSessionData.selectedFiles.push(key);
    });
  }
  csUpdateRefCheckboxes();
  csUpdateRefCounts();
}
window.csToggleColl = csToggleColl;

function csToggleFile(storeId, fileKey) {
  if (!csSessionData.selectedFiles) csSessionData.selectedFiles = [];
  if (!csSessionData.collections) csSessionData.collections = [];
  const idx = csSessionData.selectedFiles.indexOf(fileKey);
  if (idx >= 0) csSessionData.selectedFiles.splice(idx, 1);
  else csSessionData.selectedFiles.push(fileKey);

  // Update collection state
  const store = csCollectionsData.find(s => s.name.split('/').pop() === storeId);
  if (store) {
    const activeFiles = (store.files || []).filter(f => f.state === 'STATE_ACTIVE');
    const allSelected = activeFiles.length > 0 && activeFiles.every(f => csSessionData.selectedFiles.includes(storeId + '::' + (f.name || f.displayName)));
    const ci = csSessionData.collections.indexOf(storeId);
    if (allSelected && ci === -1) csSessionData.collections.push(storeId);
    else if (!allSelected && ci >= 0) csSessionData.collections.splice(ci, 1);
  }
  csUpdateRefCheckboxes();
  csUpdateRefCounts();
}
window.csToggleFile = csToggleFile;

function csUpdateRefCheckboxes() {
  document.querySelectorAll('#cs-ref-collections .studio-coll-group[data-store-id]').forEach(g => {
    const sid = g.dataset.storeId;
    const isC = csSessionData.collections.includes(sid);
    const store = csCollectionsData.find(s => s.name.split('/').pop() === sid);
    const someSelected = (store?.files || []).some(f => (csSessionData.selectedFiles || []).includes(sid + '::' + (f.name || f.displayName)));

    const cb = g.querySelector('.studio-coll-header .studio-cb-mark');
    if (cb) { cb.classList.toggle('checked', isC); cb.classList.toggle('indeterminate', !isC && someSelected); }

    g.querySelectorAll('.studio-file-item[data-file-key]').forEach(fEl => {
      const key = fEl.dataset.fileKey;
      const isSel = (csSessionData.selectedFiles || []).includes(key);
      fEl.classList.toggle('file-selected', isSel);
      const fcb = fEl.querySelector('.studio-cb-mark');
      if (fcb) fcb.classList.toggle('checked', isSel);
    });
  });
}

function csUpdateRefCounts() {
  const fileCount = (csSessionData.selectedFiles || []).length;
  const collCount = (csSessionData.collections || []).length;
  const el1 = document.getElementById('cs-ref-file-count');
  const el2 = document.getElementById('cs-ref-coll-label');
  if (el1) el1.textContent = fileCount;
  if (el2) el2.textContent = `files from ${collCount} collection${collCount !== 1 ? 's' : ''}`;
}

async function csUploadToColl(storeId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.doc,.docx,.txt,.csv,.xlsx,.xls,.json,.html,.xml,.md,.pptx,.rtf,.zip';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      toast('info', 'Uploading...', `Uploading "${file.name}"...`);
      const res = await fetch(`/api/collections/${storeId}/files`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        toast('success', 'Uploaded', `"${file.name}" uploaded.`);
        await csFetchCollections();
        csRenderRefCollections();
      } else throw new Error(data.error || 'Upload failed');
    } catch (err) { toast('error', 'Upload Error', err.message); }
  };
  input.click();
}
window.csUploadToColl = csUploadToColl;

async function csDeleteColl(storeId, displayName) {
  if (!await showConfirm({ title: 'Delete Collection', message: `Delete "${displayName}"? This removes all files.`, confirmText: 'Delete' })) return;
  try {
    const res = await fetch(`/api/collections/${storeId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      toast('success', 'Deleted', `"${displayName}" deleted.`);
      // Remove from selections
      csSessionData.collections = (csSessionData.collections || []).filter(c => c !== storeId);
      csSessionData.selectedFiles = (csSessionData.selectedFiles || []).filter(f => !f.startsWith(storeId + '::'));
      await csFetchCollections();
      csRenderRefCollections();
      csUpdateRefCounts();
    } else throw new Error(data.error || 'Delete failed');
  } catch (err) { toast('error', 'Delete Error', err.message); }
}
window.csDeleteColl = csDeleteColl;

// Per-session file upload (context files embedded in prompt)
function csUploadSessionFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.pdf,.doc,.docx,.txt,.csv,.xlsx,.xls,.json,.html,.xml,.md,.pptx';
  input.onchange = (e) => csProcessSessionFiles(Array.from(e.target.files));
  input.click();
}

async function csProcessSessionFiles(files) {
  if (!csSessionData.sessionFiles) csSessionData.sessionFiles = [];
  for (const file of files) {
    if (csSessionData.sessionFiles.some(f => f.name === file.name)) { toast('info', 'Duplicate', `"${file.name}" already attached.`); continue; }
    if (file.size > 20 * 1024 * 1024) { toast('error', 'Too Large', `"${file.name}" exceeds 20MB.`); continue; }
    try {
      const content = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Read failed')); r.readAsText(file); });
      csSessionData.sessionFiles.push({ name: file.name, size: file.size, content });
    } catch (err) { toast('error', 'Read Error', err.message); }
  }
  csRenderSessionFiles();
}

function csRenderSessionFiles() {
  const listEl = document.getElementById('cs-session-files-list');
  if (!listEl) return;
  const files = csSessionData.sessionFiles || [];
  if (!files.length) { listEl.innerHTML = ''; return; }
  listEl.innerHTML = files.map((f, i) => {
    const sizeKB = (f.size / 1024).toFixed(1);
    return `<div class="studio-ctx-item">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H9L13 6V14C13 14.6 12.6 15 12 15H3C2.4 15 2 14.6 2 14V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 2V6H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <div class="studio-ctx-item-info">
        <span class="studio-ctx-item-name">${esc(f.name)}</span>
        <span class="studio-ctx-item-size">${sizeKB} KB</span>
      </div>
      <button class="studio-ctx-item-remove" onclick="csRemoveSessionFile(${i})" title="Remove">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  }).join('');
}

function csRemoveSessionFile(idx) {
  if (!csSessionData.sessionFiles) return;
  csSessionData.sessionFiles.splice(idx, 1);
  csRenderSessionFiles();
}
window.csRemoveSessionFile = csRemoveSessionFile;

// Step 3: Org Context — with real data from DB
function csRenderStepOrgContext(el) {
  const selected = csSessionData.orgContext;
  el.innerHTML = `
    <div class="cs-wizard-card">
      <div class="cs-wizard-header sky">
        <div class="cs-wizard-header-title">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2L14 5V9C14 12 11.5 14.5 9 15C6.5 14.5 4 12 4 9V5L9 2Z" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Step 3: Organization Context <span style="background:rgba(255,255,255,0.2);padding:1px 6px;border-radius:4px;font-size:10px;font-weight:500;margin-left:4px">Required</span>
        </div>
        <div class="cs-wizard-header-desc">Select the organization profile to tailor AI-generated controls. Different profiles produce different controls for the same requirement.</div>
        <div class="cs-wizard-header-stat">
          <span class="big" id="cs-org-selected">${selected ? '✓' : '⚠'}</span>
          <span class="label">${selected ? esc(selected.nameEn || selected.name || '') : 'no profile selected — required for generation'}</span>
        </div>
      </div>
      <div class="cs-wizard-body">
        <div id="cs-org-list" style="display:flex;flex-direction:column;gap:8px">
          <div class="studio-loading"><svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Loading profiles...</span></div>
        </div>
        <p style="font-size:11px;color:#9ca3af;margin-top:10px;text-align:center">
          Don't see your org? <button class="inline-link" onclick="navigateTo('org-contexts')">Create a new Organization Context</button>.
        </p>
      </div>
      <div class="cs-wizard-footer">
        <div></div>
        <button class="btn-admin-primary" onclick="csSaveStep();csCurrentStep=1;csSessionData.step=1;csRenderWizard()" ${!selected ? 'disabled title="Select an Organization Context first"' : ''}>
          Next &nbsp;→
        </button>
      </div>
    </div>`;

  // Fetch org contexts
  (async () => {
    let contexts = [];
    try {
      const d = await fetchJSON(API.orgContexts);
      contexts = d.contexts || [];
    } catch (e) { console.error('CS org contexts fetch:', e); }

    const listEl = document.getElementById('cs-org-list');
    if (!listEl) return;

    if (!contexts.length) {
      listEl.innerHTML = '<div class="studio-empty-msg" style="color:#dc2626">No Organization Contexts found. You must <button class="inline-link" onclick="navigateTo(\'org-contexts\')">create a context</button> before generating controls.</div>';
      return;
    }

    const sectorLabels = { banking: 'Banking & Financial Services', government: 'Government', healthcare: 'Healthcare', energy: 'Energy & Utilities', telecom: 'Telecommunications', education: 'Education', retail: 'Retail & E-Commerce', insurance: 'Insurance', technology: 'Technology', defense: 'Defense & Military', manufacturing: 'Manufacturing', transportation: 'Transportation & Logistics', custom: 'Custom', other: 'Other' };
    const sizeLabels = { small: 'Small', medium: 'Medium', large: 'Large', enterprise: 'Enterprise' };
    const maturityLabels = { 1: 'Initial', 2: 'Developing', 3: 'Defined', 4: 'Managed', 5: 'Optimizing' };

    let html = '';

    contexts.forEach(ctx => {
      const isSelected = selected && String(selected.id) === String(ctx.id);
      const tags = (ctx.obligatoryFrameworks || []).map(f => `<span class="badge badge-primary badge-round" style="font-size:9px">${esc(f)}</span>`).join(' ');
      const mandTags = (ctx.regulatoryMandates || []).map(m => `<span class="badge badge-amber badge-round" style="font-size:9px">${esc(m)}</span>`).join(' ');
      const sectorDisplay = ctx.sectorCustom || sectorLabels[ctx.sector] || ctx.sector || '';
      const mat = ctx.complianceMaturity || 1;
      html += `<div class="cs-org-option ${isSelected ? 'selected' : ''}" onclick="csSelectOrg('${esc(String(ctx.id))}', this)">
        <div class="cs-org-radio"><span class="cs-org-radio-dot ${isSelected ? 'active' : ''}"></span></div>
        <div class="cs-org-option-content">
          <div class="cs-org-option-name">${esc(ctx.nameEn || ctx.name)}${ctx.nameAr ? ` <span style="color:#9ca3af;font-weight:400">${esc(ctx.nameAr)}</span>` : ''}</div>
          <div class="cs-org-option-desc">
            ${sectorDisplay ? esc(sectorDisplay) : ''}
            ${ctx.size ? ' • ' + esc(sizeLabels[ctx.size] || ctx.size) : ''}
            • Maturity ${mat}/5 (${maturityLabels[mat] || mat})
            ${tags ? ' ' + tags : ''}
            ${mandTags ? ' ' + mandTags : ''}
          </div>
        </div>
      </div>`;
    });

    listEl.innerHTML = html;

    // Store contexts for selection lookup
    listEl._contexts = contexts;
  })();
}

function csSelectOrg(ctxId, rowEl) {
  // Deselect all
  document.querySelectorAll('#cs-org-list .cs-org-option').forEach(o => {
    o.classList.remove('selected');
    const dot = o.querySelector('.cs-org-radio-dot');
    if (dot) dot.classList.remove('active');
  });
  // Select clicked
  rowEl.classList.add('selected');
  const dot = rowEl.querySelector('.cs-org-radio-dot');
  if (dot) dot.classList.add('active');

  if (ctxId === null || ctxId === 'null') {
    csSessionData.orgContext = null;
  } else {
    const listEl = document.getElementById('cs-org-list');
    const contexts = listEl?._contexts || [];
    csSessionData.orgContext = contexts.find(c => String(c.id) === String(ctxId)) || null;
  }
  csSyncStudioRequirementsToOrgFrameworks();
  // Update header
  const countEl = document.getElementById('cs-org-selected');
  if (countEl) {
    countEl.textContent = csSessionData.orgContext ? '✓' : '⚠';
    const labelEl = countEl.nextElementSibling;
    if (labelEl) labelEl.textContent = csSessionData.orgContext ? (csSessionData.orgContext.nameEn || csSessionData.orgContext.name || '') : 'no profile selected — required for generation';
  }
  // Enable/disable Next button
  const nextBtn = document.querySelector('.cs-wizard-footer .btn-admin-primary');
  if (nextBtn && nextBtn.textContent.includes('Next')) {
    nextBtn.disabled = !csSessionData.orgContext;
    nextBtn.title = csSessionData.orgContext ? '' : 'Select an Organization Context first';
  }
}
window.csSelectOrg = csSelectOrg;

// Step 4: Generate
function csRenderStepGenerate(el) {
  const reqs = (csSessionData.requirements || []).length;
  const files = (csSessionData.selectedFiles || []).length + (csSessionData.sessionFiles || []).length;
  const cols = (csSessionData.collections || []).length;
  const orgCtx = csSessionData.orgContext;
  const hasOrg = orgCtx && orgCtx.nameEn;
  const maturityLabels = { 1: 'Initial', 2: 'Developing', 3: 'Defined', 4: 'Managed', 5: 'Optimizing' };

  el.innerHTML = `
    <div class="cs-wizard-card">
      <div class="cs-wizard-header navy">
        <div class="cs-wizard-header-title">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2V4M9 14V16M4 9H2M16 9H14M5 5L3.5 3.5M14.5 14.5L13 13M5 13L3.5 14.5M14.5 3.5L13 5" stroke="white" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="9" r="3" stroke="white" stroke-width="1.5"/></svg>
          Generate Controls
        </div>
        <div class="cs-wizard-header-desc">AI will analyze requirements and suggest applied controls tailored to your organization profile</div>
      </div>
      <div class="cs-wizard-body">
        ${!hasOrg ? `
          <div class="cs-gen-blocked">
            <div class="cs-gen-blocked-icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M16 4L28 28H4L16 4Z" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 13V19M16 23V23.01" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>
            </div>
            <h3 style="font-size:14px;font-weight:600;color:#dc2626;margin:0 0 4px">Organization Context Required</h3>
            <p style="font-size:12px;color:#6b7280;max-width:400px;margin:0 auto 16px">
              An Organization Context is required to generate contextual controls.
              A "Government, Enterprise, Maturity 2" org gets different controls than "Healthcare, Medium, Maturity 4" for the same requirement.
            </p>
            <button class="btn-admin-primary" onclick="csCurrentStep=0;csSessionData.step=0;csRenderWizard()">
              ← Go back to select a profile
            </button>
            <p style="font-size:11px;color:#9ca3af;margin-top:12px">
              No contexts yet? <button class="inline-link" onclick="navigateTo('org-contexts')">Create one in Org Contexts</button>.
            </p>
          </div>
        ` : `
        <div class="cs-gen-summary">
          <div class="cs-gen-box">
            <div class="cs-gen-box-header">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="#6b7280" stroke-width="1.2"/><path d="M5 7L6.5 8.5L9 5.5" stroke="#6b7280" stroke-width="1.2" stroke-linecap="round"/></svg>
              Requirements
            </div>
            <div class="cs-gen-box-val">${reqs}</div>
            <div class="cs-gen-box-sub">from selected frameworks</div>
          </div>
          <div class="cs-gen-box">
            <div class="cs-gen-box-header">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5V11C2 11.6 2.4 12 3 12H11C11.6 12 12 11.6 12 11V7C12 6.4 11.6 6 11 6H7L5.5 4H3C2.4 4 2 4.4 2 5Z" stroke="#6b7280" stroke-width="1.2" stroke-linecap="round"/></svg>
              Reference Files
            </div>
            <div class="cs-gen-box-val">${files}</div>
            <div class="cs-gen-box-sub">${cols} collection${cols !== 1 ? 's' : ''} + session files</div>
          </div>
          <div class="cs-gen-box">
            <div class="cs-gen-box-header">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1L12 4V7C12 10 9.5 12.5 7 13C4.5 12.5 2 10 2 7V4L7 1Z" stroke="#6b7280" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Organization Context
            </div>
            <div class="cs-gen-box-val">${esc(orgCtx.nameEn || orgCtx.name || '')}</div>
            <div class="cs-gen-box-sub">${esc(orgCtx.sectorCustom || orgCtx.sector || '')}, ${esc(orgCtx.size || '')}, Maturity ${orgCtx.complianceMaturity || 1}/5</div>
          </div>
        </div>
        <div class="cs-gen-ready">
          <div class="cs-gen-ready-icon">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M14 4V7M14 21V24M7 14H4M24 14H21M8 8L5.5 5.5M22.5 22.5L20 20M8 20L5.5 22.5M22.5 5.5L20 8" stroke="var(--admin-primary)" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="14" r="4" stroke="var(--admin-primary)" stroke-width="2"/></svg>
          </div>
          <h3 style="font-size:14px;font-weight:600;color:#111827;margin:0 0 4px">Ready to Generate</h3>
          <p style="font-size:12px;color:#6b7280;max-width:380px;margin:0 auto">AI will analyze each requirement against your reference documents and organization profile to suggest tailored applied controls. Existing controls from this session will be considered to avoid duplicates.</p>
        </div>
        `}
      </div>
      <div class="cs-wizard-footer">
        <button class="btn-admin-ghost" onclick="csCurrentStep=2;csSessionData.step=2;csRenderWizard()">← Back</button>
        ${hasOrg ? `<button class="btn-admin-primary" onclick="csStartGenerate()">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1V3M7 11V13M3 7H1M13 7H11M4 4L2.5 2.5M11.5 11.5L10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="7" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>
          Generate Controls
        </button>` : '<div></div>'}
      </div>
    </div>`;
}

let csGenerating = false;
let csJustExported = false; // true right after csDoExport, reset when navigating away

async function csStartGenerate() {
  if (csGenerating) return;
  const reqs = csSessionData.requirements || [];
  if (!reqs.length) { toast('error', 'No Requirements', 'Select at least one requirement before generating.'); return; }
  if (!csSessionData.orgContext || !csSessionData.orgContext.nameEn) {
    toast('error', 'Context Required', 'An Organization Context is required to generate controls. Go back and select one.');
    return;
  }

  csGenerating = true;
  const content = document.getElementById('cs-content');

  // Show generating progress UI
  content.innerHTML = `
    <div class="cs-wizard-card">
      <div class="cs-wizard-header navy">
        <div class="cs-wizard-header-title">
          <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="white" stroke-width="2" stroke-opacity="0.3"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
          Generating Controls...
        </div>
        <div class="cs-wizard-header-desc">AI is analyzing ${reqs.length} requirement${reqs.length !== 1 ? 's' : ''} and generating applied controls. This may take a few minutes.</div>
      </div>
      <div class="cs-wizard-body" style="padding:32px">
        <div class="cs-gen-progress">
          <div class="cs-gen-progress-bar-wrap">
            <div class="cs-gen-progress-bar" id="cs-progress-bar" style="width:0%"></div>
          </div>
          <div class="cs-gen-progress-text" id="cs-progress-text">Starting... 0 / ${reqs.length}</div>
          <div class="cs-gen-progress-log" id="cs-progress-log"></div>
        </div>
      </div>
    </div>`;

  try {
    // Prepare context files from session uploads
    const ctxFiles = (csSessionData.sessionFiles || []).map(f => ({
      name: f.name,
      content: f.content,
    }));

    // Build body
    const body = {
      requirements: reqs.map(r => ({
        refId: r.refId,
        name: r.name,
        description: r.description,
        frameworkName: r.frameworkName,
        nodeUrn: r.nodeUrn,
        nodeId: r.nodeId,
        depth: r.depth,
      })),
      orgContext: csSessionData.orgContext || null,
      contextFiles: ctxFiles.length ? ctxFiles : undefined,
    };

    // Show progress updates in the log
    const logEl = document.getElementById('cs-progress-log');
    const barEl = document.getElementById('cs-progress-bar');
    const textEl = document.getElementById('cs-progress-text');

    const addLog = (msg, type = 'info') => {
      if (logEl) {
        const d = document.createElement('div');
        d.className = 'cs-progress-log-item ' + type;
        d.textContent = msg;
        logEl.appendChild(d);
        logEl.scrollTop = logEl.scrollHeight;
      }
    };

    addLog(`Sending ${reqs.length} requirements to AI engine...`);

    const res = await fetch('/api/controls/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    console.log('[Controls] AI generation response:', data);

    if (barEl) barEl.style.width = '100%';
    if (textEl) textEl.textContent = `Done!`;

    if (!data.success) {
      throw new Error(data.error || 'Generation failed');
    }

    const controls = data.data?.controls || [];
    const progress = data.data?.progress || {};
    console.log('[Controls] Parsed controls:', controls);
    console.log('[Controls] Progress:', progress);

    addLog(`✓ Generated ${controls.length} controls for ${progress.completed || reqs.length} requirements`, 'success');
    if (progress.failed > 0) addLog(`⚠ ${progress.failed} requirements failed`, 'warn');

    // Tag each control with a unique ID and selected=true
    csSessionData.controls = controls.map((c, i) => ({ ...c, id: 'ctrl-' + Date.now() + '-' + i, selected: true }));
    csSessionData.status = 'generated';
    csSessionData.step = 4;
    csCurrentStep = 4;

    // Save session
    csSaveStep();

    toast('success', 'Controls Generated', `${controls.length} controls generated successfully.`);

    // Brief delay to show success state
    await new Promise(r => setTimeout(r, 1200));
    csRenderWizard();

  } catch (err) {
    console.error('Controls generation error:', err);
    toast('error', 'Generation Failed', err.message);
    const logEl = document.getElementById('cs-progress-log');
    if (logEl) {
      const d = document.createElement('div');
      d.className = 'cs-progress-log-item error';
      d.textContent = '✗ ' + err.message;
      logEl.appendChild(d);
    }
    // Show retry button
    const content = document.getElementById('cs-content');
    if (content) {
      const footer = content.querySelector('.cs-wizard-footer');
      if (!footer) {
        content.querySelector('.cs-wizard-card')?.insertAdjacentHTML('beforeend', `
          <div class="cs-wizard-footer">
            <button class="btn-admin-ghost" onclick="csCurrentStep=3;csSessionData.step=3;csRenderWizard()">← Back</button>
            <button class="btn-admin-primary" onclick="csStartGenerate()">Retry</button>
          </div>`);
      }
    }
  } finally {
    csGenerating = false;
  }
}
window.csStartGenerate = csStartGenerate;

// Step 5: Review
function csRenderStepReview(el) {
  const controls = csSessionData.controls || [];
  const selectedCount = controls.filter(c => c.selected !== false).length;
  let exportedIds = csSessionData.exportedControlIds || [];
  // Legacy: if session exported but no IDs tracked, treat all as exported
  if (exportedIds.length === 0 && csSessionData.status === 'exported') {
    exportedIds = controls.map(c => c.id).filter(Boolean);
  }
  const hasExported = exportedIds.length > 0;
  const alreadyExportedCount = hasExported ? controls.filter(c => exportedIds.includes(c.id)).length : 0;
  const newCount = hasExported ? controls.length - alreadyExportedCount : controls.length;

  // Category / CSF / Priority configs (GRC-compatible)
  const catLabel = { policy: 'Policy', process: 'Process', technical: 'Technical', physical: 'Physical', preventive: 'Preventive', detective: 'Detective', corrective: 'Corrective', directive: 'Directive' };
  const catColor = { policy: 'cs-tag-blue', process: 'cs-tag-amber', technical: 'cs-tag-emerald', physical: 'cs-tag-gray', preventive: 'cs-tag-blue', detective: 'cs-tag-orange', corrective: 'cs-tag-red', directive: 'cs-tag-teal' };
  const csfLabel = { identify: 'Identify', protect: 'Protect', detect: 'Detect', respond: 'Respond', recover: 'Recover', govern: 'Govern' };
  const csfColor = { identify: 'cs-tag-sky', protect: 'cs-tag-teal', detect: 'cs-tag-orange', respond: 'cs-tag-red', recover: 'cs-tag-emerald', govern: 'cs-tag-gray' };
  // Support both integer (GRC: 1-4) and string (legacy) priorities
  const prioLabel = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low', critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const prioColor = { 1: 'cs-tag-red', 2: 'cs-tag-red', 3: 'cs-tag-amber', 4: 'cs-tag-gray', critical: 'cs-tag-red', high: 'cs-tag-red', medium: 'cs-tag-amber', low: 'cs-tag-gray' };

  // Read-only mode for exported sessions
  const readOnly = csSessionData.status === 'exported';

  el.innerHTML = `
    <div class="cs-review-card">
      <div class="cs-review-header">
        <div class="cs-review-header-row">
          ${readOnly
            ? '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 9C2 9 5 4 9 4C13 4 16 9 16 9C16 9 13 14 9 14C5 14 2 9 2 9Z" stroke="white" stroke-width="1.5"/><circle cx="9" cy="9" r="2.5" stroke="white" stroke-width="1.5"/></svg>'
            : '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 9L8 12L13 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
          <span class="cs-review-header-title">${readOnly ? 'Export Results' : 'Step 5: Review & Edit'}</span>
        </div>
        <p class="cs-review-header-desc">${readOnly
          ? 'Viewing previously exported controls. You can re-export selected controls or start a new session.'
          : 'Review AI-generated control suggestions. Edit, add, or remove controls before exporting.'}</p>
        <div class="cs-review-header-stats">
          <span class="cs-review-big" id="cs-review-selected">${selectedCount}</span>
          <span class="cs-review-of">of ${controls.length} selected</span>
          ${hasExported ? `
            <span class="cs-review-divider"></span>
            <span class="cs-review-exported-badge">${alreadyExportedCount} already exported</span>
            <span class="cs-review-of">|</span>
            <span class="cs-review-new-badge">${newCount} new</span>
          ` : ''}
        </div>
      </div>
      <div class="cs-review-body">
        ${controls.length ? `
          <div class="cs-review-toolbar">
            <div class="cs-review-toolbar-left">
              ${!readOnly ? `
                <button class="cs-toolbar-btn" onclick="csSelectAllControls(true)">Select All</button>
                <button class="cs-toolbar-btn cs-toolbar-btn-ghost" onclick="csSelectAllControls(false)">Deselect All</button>
              ` : ''}
              ${hasExported ? `
                <div class="cs-filter-tabs">
                  <svg class="cs-filter-icon" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 2H11L7 6.5V9L5 10V6.5L1 2Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <button class="cs-filter-tab active" data-filter="all" onclick="csFilterControls('all',this)">All (${controls.length})</button>
                  <button class="cs-filter-tab" data-filter="new" onclick="csFilterControls('new',this)">New (${newCount})</button>
                  <button class="cs-filter-tab" data-filter="existing" onclick="csFilterControls('existing',this)">Existing (${alreadyExportedCount})</button>
                </div>
              ` : ''}
            </div>
            ${!readOnly ? `
              <button class="cs-toolbar-btn cs-toolbar-add" onclick="csAddManualControl()">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2V10M2 6H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                Add Manual Control
              </button>
            ` : ''}
          </div>
          <div class="cs-ctrl-list" id="cs-ctrl-list">
            ${(() => {
              // Group controls by requirement
              const reqGroups = [];
              const reqGroupMap = new Map(); // key → group index
              const ungrouped = [];

              controls.forEach((c, i) => {
                const reqs = c.linkedRequirements || [];
                if (reqs.length > 0) {
                  reqs.forEach(r => {
                    const key = (r.nodeUrn || r.refId || r.name || '').toLowerCase();
                    if (!reqGroupMap.has(key)) {
                      reqGroupMap.set(key, reqGroups.length);
                      reqGroups.push({ refId: r.refId || '', name: r.name || '', framework: r.framework || '', controls: [] });
                    }
                    const group = reqGroups[reqGroupMap.get(key)];
                    if (!group.controls.some(gc => gc.id === c.id)) group.controls.push(c);
                  });
                } else if (c.requirementRefId) {
                  const key = (c.requirementRefId || '').toLowerCase();
                  if (!reqGroupMap.has(key)) {
                    reqGroupMap.set(key, reqGroups.length);
                    reqGroups.push({ refId: c.requirementRefId, name: c.requirementName || '', framework: c.framework || '', controls: [] });
                  }
                  reqGroups[reqGroupMap.get(key)].controls.push(c);
                } else {
                  ungrouped.push(c);
                }
              });

              // Helper to render a single control card
              const renderCtrl = (c, idx) => {
                const isSelected = c.selected !== false;
                const isExported = exportedIds.includes(c.id);
                const cat = c.category || c.control_type || '';
                const csf = c.csf_function || c.csfFunction || '';
                const prio = c.priority || c.implementation_priority || '';
                return `<div class="cs-ctrl-item ${isSelected ? 'cs-ctrl-selected' : 'cs-ctrl-deselected'} ${isExported ? 'cs-ctrl-exported' : ''}" data-ctrl-id="${esc(c.id)}" data-exported="${isExported}">
                  <div class="cs-ctrl-row-main">
                    ${!readOnly ? `
                      <div class="cs-ctrl-check" onclick="csToggleControl('${esc(c.id)}')">
                        <div class="cs-ctrl-checkbox ${isSelected ? 'checked' : ''}">
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </div>
                      </div>
                    ` : ''}
                    <div class="cs-ctrl-content" onclick="csExpandControl('${esc(c.id)}')">
                      <div class="cs-ctrl-name-line">
                        <span class="cs-ctrl-name" dir="rtl">${esc(c.name || c.name_ar || 'Control ' + (idx+1))}</span>
                        ${(c.linkedRequirements || []).length > 1 ? `<span class="cs-tag cs-tag-sky" style="font-size:9px;padding:1px 6px;margin-left:4px" title="This control covers ${(c.linkedRequirements || []).length} requirements">${(c.linkedRequirements || []).length} reqs</span>` : ''}
                        ${isExported ? `<span class="cs-exported-pill"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2"/><path d="M4 6L5.5 7.5L8 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Exported</span>` : ''}
                      </div>
                      <div class="cs-ctrl-desc-line" dir="rtl">${esc(c.description || '')}</div>
                    </div>
                    <div class="cs-ctrl-tags">
                      ${cat ? `<span class="cs-tag ${catColor[cat] || 'cs-tag-gray'}">${esc(catLabel[cat] || cat)}</span>` : ''}
                      ${csf ? `<span class="cs-tag ${csfColor[csf] || 'cs-tag-gray'}">${esc(csfLabel[csf] || csf)}</span>` : ''}
                      ${prio ? `<span class="cs-tag ${prioColor[prio] || 'cs-tag-gray'}">${esc(prioLabel[prio] || prio)}</span>` : ''}
                    </div>
                    ${!readOnly ? `
                      <button class="cs-ctrl-edit-btn" onclick="event.stopPropagation();csExpandControl('${esc(c.id)}')" title="Edit">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      </button>
                    ` : ''}
                    <svg class="cs-ctrl-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                  </div>
                  <div class="cs-ctrl-expand" id="cs-ctrl-expand-${esc(c.id)}">
                    ${readOnly ? `
                      ${c.implementation_guidance ? `<div class="cs-ctrl-detail"><span class="cs-ctrl-detail-label">Implementation Guidance</span><p>${esc(c.implementation_guidance)}</p></div>` : ''}
                      ${c.rationale ? `<div class="cs-ctrl-detail"><span class="cs-ctrl-detail-label">Rationale</span><p>${esc(c.rationale)}</p></div>` : ''}
                      ${(c.effort || c.effort_estimate) ? `<div class="cs-ctrl-detail"><span class="cs-ctrl-detail-label">Effort</span><span class="cs-tag cs-tag-gray">${esc(c.effort || c.effort_estimate)}</span></div>` : ''}
                      ${c.status ? `<div class="cs-ctrl-detail"><span class="cs-ctrl-detail-label">Status</span><span class="cs-tag cs-tag-gray">${esc(c.status)}</span></div>` : ''}
                      ${(c.evidence_examples && c.evidence_examples.length) ? `<div class="cs-ctrl-detail"><span class="cs-ctrl-detail-label">Evidence Examples</span><div class="cs-ctrl-detail-pills">${c.evidence_examples.map(e => `<span class="cs-tag cs-tag-gray">${esc(e)}</span>`).join('')}</div></div>` : ''}
                    ` : `
                      <form class="cs-edit-form" data-ctrl-id="${esc(c.id)}" onsubmit="event.preventDefault();csSaveControl('${esc(c.id)}')">
                        <div class="cs-edit-row">
                          <div class="cs-edit-field cs-edit-field-full">
                            <label>Name</label>
                            <input type="text" name="name" value="${esc(c.name || c.name_ar || '')}" placeholder="Control name" />
                          </div>
                        </div>
                        <div class="cs-edit-row">
                          <div class="cs-edit-field cs-edit-field-full">
                            <label>Description</label>
                            <textarea name="description" rows="3" placeholder="Control description">${esc(c.description || c.description_ar || '')}</textarea>
                          </div>
                        </div>
                        <div class="cs-edit-row cs-edit-row-grid">
                          <div class="cs-edit-field">
                            <label>Category</label>
                            <select name="category">
                              <option value="">— None —</option>
                              ${Object.entries(catLabel).map(([k,v]) => `<option value="${k}" ${(c.category||c.control_type)===k?'selected':''}>${v}</option>`).join('')}
                            </select>
                          </div>
                          <div class="cs-edit-field">
                            <label>CSF Function</label>
                            <select name="csf_function">
                              <option value="">— None —</option>
                              ${Object.entries(csfLabel).map(([k,v]) => `<option value="${k}" ${(c.csf_function||c.csfFunction)===k?'selected':''}>${v}</option>`).join('')}
                            </select>
                          </div>
                          <div class="cs-edit-field">
                            <label>Priority</label>
                            <select name="priority">
                              <option value="1" ${String(c.priority)==='1'||c.priority==='critical'?'selected':''}>Critical (1)</option>
                              <option value="2" ${String(c.priority)==='2'||c.priority==='high'?'selected':''}>High (2)</option>
                              <option value="3" ${String(c.priority)==='3'||c.priority==='medium'||!c.priority?'selected':''}>Medium (3)</option>
                              <option value="4" ${String(c.priority)==='4'||c.priority==='low'?'selected':''}>Low (4)</option>
                            </select>
                          </div>
                          <div class="cs-edit-field">
                            <label>Effort</label>
                            <select name="effort">
                              <option value="S" ${(c.effort||c.effort_estimate||'').toUpperCase()==='S'?'selected':''}>S (Small)</option>
                              <option value="M" ${(c.effort||c.effort_estimate||'M').toUpperCase()==='M'?'selected':''}>M (Medium)</option>
                              <option value="L" ${(c.effort||c.effort_estimate||'').toUpperCase()==='L'?'selected':''}>L (Large)</option>
                              <option value="XL" ${(c.effort||c.effort_estimate||'').toUpperCase()==='XL'?'selected':''}>XL (Extra Large)</option>
                            </select>
                          </div>
                        </div>
                        <div class="cs-edit-row">
                          <div class="cs-edit-field cs-edit-field-full">
                            <label>Implementation Guidance</label>
                            <textarea name="implementation_guidance" rows="2" placeholder="How to implement this control">${esc(c.implementation_guidance || '')}</textarea>
                          </div>
                        </div>
                        <div class="cs-edit-row cs-edit-row-grid">
                          <div class="cs-edit-field">
                            <label>Status</label>
                            <select name="status">
                              <option value="to_do" ${(c.status||'to_do')==='to_do'?'selected':''}>To Do</option>
                              <option value="in_progress" ${c.status==='in_progress'?'selected':''}>In Progress</option>
                              <option value="active" ${c.status==='active'?'selected':''}>Active</option>
                              <option value="done" ${c.status==='done'?'selected':''}>Done</option>
                            </select>
                          </div>
                          <div class="cs-edit-field">
                            <label>Framework</label>
                            <input type="text" name="framework" value="${esc(c.framework || '')}" placeholder="e.g. PDPL, NCA-ECC" />
                          </div>
                        </div>
                        <div class="cs-edit-actions">
                          <button type="submit" class="btn-admin-primary cs-edit-save-btn">
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            Save Changes
                          </button>
                          <button type="button" class="cs-toolbar-btn cs-toolbar-btn-ghost" onclick="csExpandControl('${esc(c.id)}')">Cancel</button>
                          <button type="button" class="cs-edit-delete-btn" onclick="csDeleteControl('${esc(c.id)}')">
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                            Remove
                          </button>
                        </div>
                      </form>
                    `}
                  </div>
                </div>`;
              };

              // Render requirement groups
              let html = '';
              reqGroups.forEach((group, gi) => {
                const selInGroup = group.controls.filter(c => c.selected !== false).length;
                html += `<div class="cs-req-group" data-req-group="${gi}">
                  <div class="cs-req-group-header" onclick="csToggleReqGroup(${gi})">
                    <div class="cs-req-group-toggle">
                      <svg class="cs-req-group-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </div>
                    <div class="cs-req-group-info">
                      ${group.refId ? `<span class="cs-req-group-refid">${esc(group.refId)}</span>` : ''}
                      <span class="cs-req-group-name" dir="auto">${esc(group.name || 'Unnamed Requirement')}</span>
                    </div>
                    <div class="cs-req-group-meta">
                      ${group.framework ? `<span class="cs-tag cs-tag-primary" style="font-size:9px">${esc(group.framework)}</span>` : ''}
                      <span class="cs-req-group-count">${selInGroup}/${group.controls.length} controls</span>
                    </div>
                  </div>
                  <div class="cs-req-group-body">
                    ${group.controls.map((c, ci) => renderCtrl(c, ci)).join('')}
                  </div>
                </div>`;
              });

              // Render ungrouped controls
              if (ungrouped.length > 0) {
                html += `<div class="cs-req-group" data-req-group="ungrouped">
                  <div class="cs-req-group-header" onclick="csToggleReqGroup('ungrouped')">
                    <div class="cs-req-group-toggle">
                      <svg class="cs-req-group-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </div>
                    <div class="cs-req-group-info">
                      <span class="cs-req-group-name">Manually Added Controls</span>
                    </div>
                    <div class="cs-req-group-meta">
                      <span class="cs-req-group-count">${ungrouped.length} controls</span>
                    </div>
                  </div>
                  <div class="cs-req-group-body">
                    ${ungrouped.map((c, ci) => renderCtrl(c, ci)).join('')}
                  </div>
                </div>`;
              }
              return html;
            })()}
          </div>
        ` : `
          <div class="cs-review-empty">No controls generated yet. Go back and generate controls.</div>
        `}
      </div>
      <div class="cs-review-footer">
        <button class="cs-footer-back" onclick="${readOnly ? "csCachedSessions=null;csShowSessions()" : "csCurrentStep=3;csSessionData.step=3;csRenderWizard()"}">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7L9 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          ${readOnly ? 'Back to Sessions' : 'Back'}
        </button>
        <div class="cs-footer-right">
          ${!readOnly ? `
            <span class="cs-footer-count" id="cs-review-footer-count">${selectedCount} controls selected</span>
            <button class="btn-admin-primary" onclick="csSaveStep();csCurrentStep=5;csSessionData.step=5;csRenderWizard()">
              Proceed to Export
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          ` : `
            <button class="btn-admin-primary" onclick="csSaveStep();csCurrentStep=5;csSessionData.step=5;csRenderWizard()">
              Re-Export Selected
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          `}
        </div>
      </div>
    </div>`;
}

function csExpandControl(ctrlId) {
  const expandEl = document.getElementById('cs-ctrl-expand-' + ctrlId);
  if (!expandEl) return;
  const item = expandEl.closest('.cs-ctrl-item');
  if (!item) return;
  item.classList.toggle('expanded');
}
window.csExpandControl = csExpandControl;

function csToggleReqGroup(groupIdx) {
  const group = document.querySelector(`.cs-req-group[data-req-group="${groupIdx}"]`);
  if (!group) return;
  group.classList.toggle('cs-req-group-collapsed');
}
window.csToggleReqGroup = csToggleReqGroup;

function csFilterControls(filter, btn) {
  // Update active tab
  document.querySelectorAll('.cs-filter-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const exportedIds = csSessionData.exportedControlIds || [];
  document.querySelectorAll('.cs-ctrl-item[data-ctrl-id]').forEach(item => {
    const isExported = item.getAttribute('data-exported') === 'true';
    if (filter === 'all') item.style.display = '';
    else if (filter === 'new') item.style.display = isExported ? 'none' : '';
    else if (filter === 'existing') item.style.display = isExported ? '' : 'none';
  });
}
window.csFilterControls = csFilterControls;

function csAddManualControl() {
  const controls = csSessionData.controls = csSessionData.controls || [];
  const newId = 'ctrl-manual-' + Date.now();
  const newCtrl = {
    id: newId,
    name: '',
    description: '',
    category: 'process',
    csf_function: 'govern',
    priority: 3,
    effort: 'M',
    status: 'to_do',
    selected: true,
    framework: '',
    requirementRefId: '',
    linkedRequirements: [],
  };
  controls.push(newCtrl);
  csSaveStep();
  csRenderWizard();
  // Auto-expand the new control for editing
  setTimeout(() => {
    const item = document.querySelector(`.cs-ctrl-item[data-ctrl-id="${newId}"]`);
    if (item) {
      item.classList.add('expanded');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const nameInput = item.querySelector('input[name="name"]');
      if (nameInput) nameInput.focus();
    }
  }, 100);
  toast('info', 'Added', 'New control added — fill in the details below.');
}
window.csAddManualControl = csAddManualControl;

function csSaveControl(ctrlId) {
  const form = document.querySelector(`.cs-edit-form[data-ctrl-id="${ctrlId}"]`);
  if (!form) return;
  const ctrl = (csSessionData.controls || []).find(c => c.id === ctrlId);
  if (!ctrl) return;

  const fd = new FormData(form);
  ctrl.name = fd.get('name') || 'Untitled Control';
  ctrl.description = fd.get('description') || '';
  ctrl.category = fd.get('category') || '';
  ctrl.csf_function = fd.get('csf_function') || '';
  ctrl.csfFunction = fd.get('csf_function') || '';
  ctrl.priority = parseInt(fd.get('priority'), 10) || 3;
  ctrl.effort = fd.get('effort') || 'M';
  ctrl.status = fd.get('status') || 'to_do';
  ctrl.implementation_guidance = fd.get('implementation_guidance') || '';
  ctrl.framework = fd.get('framework') || '';

  csSaveStep();
  csRenderWizard();
  toast('success', 'Saved', `Control "${ctrl.name}" updated.`);
}
window.csSaveControl = csSaveControl;

async function csDeleteControl(ctrlId) {
  const ctrl = (csSessionData.controls || []).find(c => c.id === ctrlId);
  const name = ctrl?.name || 'this control';
  if (!await showConfirm({ title: 'Remove Control', message: `Remove "${name}"?`, confirmText: 'Remove', type: 'warning' })) return;
  csSessionData.controls = (csSessionData.controls || []).filter(c => c.id !== ctrlId);
  csSaveStep();
  csRenderWizard();
  toast('info', 'Removed', `Control removed.`);
}
window.csDeleteControl = csDeleteControl;

function csToggleControl(ctrlId) {
  const ctrl = (csSessionData.controls || []).find(c => c.id === ctrlId);
  if (!ctrl) return;
  ctrl.selected = ctrl.selected === false ? true : false;

  // Update DOM without full re-render
  const item = document.querySelector(`.cs-ctrl-item[data-ctrl-id="${ctrlId}"]`);
  if (item) {
    item.classList.toggle('cs-ctrl-deselected', !ctrl.selected);
    item.classList.toggle('cs-ctrl-selected', ctrl.selected);
    const cb = item.querySelector('.cs-ctrl-checkbox');
    if (cb) cb.classList.toggle('checked', ctrl.selected);
  }
  csUpdateReviewCount();
}
window.csToggleControl = csToggleControl;

function csSelectAllControls(selectAll) {
  (csSessionData.controls || []).forEach(c => c.selected = selectAll);
  document.querySelectorAll('.cs-ctrl-item[data-ctrl-id]').forEach(item => {
    item.classList.toggle('cs-ctrl-deselected', !selectAll);
    item.classList.toggle('cs-ctrl-selected', selectAll);
    const cb = item.querySelector('.cs-ctrl-checkbox');
    if (cb) cb.classList.toggle('checked', selectAll);
  });
  csUpdateReviewCount();
}
window.csSelectAllControls = csSelectAllControls;

function csUpdateReviewCount() {
  const selected = (csSessionData.controls || []).filter(c => c.selected !== false).length;
  const el = document.getElementById('cs-review-selected');
  if (el) el.textContent = selected;
  const fc = document.getElementById('cs-review-footer-count');
  if (fc) fc.textContent = selected + ' controls selected';
}


// Step 6: Export
function csRenderStepExport(el) {
  const controls = csSessionData.controls || [];
  const selected = controls.filter(c => c.selected !== false);
  const total = selected.length;
  const fwSet = new Set(); const reqSet = new Set();
  selected.forEach(c => {
    const reqs = c.linkedRequirements || [];
    if (reqs.length > 0) {
      reqs.forEach(r => { if (r.framework) fwSet.add(r.framework); if (r.refId) reqSet.add(r.refId); });
    } else {
      if (c.framework) fwSet.add(c.framework); if (c.requirementRefId) reqSet.add(c.requirementRefId);
    }
  });

  if (csSessionData.status === 'exported' && csJustExported) {
    csJustExported = false; // reset the flag
    // ── Export Complete view (only shown right after actual export) ──
    el.innerHTML = `
      <div class="cs-review-card">
        <div class="cs-export-header-done">
          <div class="cs-review-header-row">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 9L8 12L13 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="9" r="7" stroke="white" stroke-width="1.5"/></svg>
            <span class="cs-review-header-title">Export Complete</span>
          </div>
          <p class="cs-review-header-desc" style="color:#bbf7d0">Controls have been successfully exported to WathbaGRC.</p>
        </div>
        <div class="cs-export-done-body">
          <div class="cs-export-done-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12" stroke="#10b981" stroke-width="2"/><path d="M11 16L14 19L21 12" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <h3 class="cs-export-done-title">Successfully Exported to WathbaGRC</h3>
          <div class="cs-export-done-stats">
            <div class="cs-export-done-stat cs-export-done-stat-emerald">
              <div class="cs-export-done-stat-val">${total}</div>
              <div class="cs-export-done-stat-label">Controls Created</div>
            </div>
            <div class="cs-export-done-stat cs-export-done-stat-gray">
              <div class="cs-export-done-stat-val">0</div>
              <div class="cs-export-done-stat-label">Failed</div>
            </div>
          </div>
          <div class="cs-export-done-meta">
            <div class="cs-export-meta-row"><span>Frameworks</span><span>${esc([...fwSet].join(', ') || '—')}</span></div>
            <div class="cs-export-meta-row"><span>Linked Requirements</span><span>${reqSet.size}</span></div>
            <div class="cs-export-meta-row"><span>Exported At</span><span>${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
          </div>
          <div class="cs-export-done-actions">
            <button class="btn-admin-primary" onclick="csNewSession()">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              New Session
            </button>
            <button class="cs-footer-back" onclick="csCachedSessions=null;csShowSessions()">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4H14M2 8H14M2 12H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              Session History
            </button>
            <button class="cs-footer-merge" onclick="navigateTo('merge-optimizer')">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 4L8 7L11 4M5 9L8 12L11 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Merge Optimizer
            </button>
          </div>
        </div>
      </div>`;
    return;
  }

  // Exported tracking — if session was already exported but exportedControlIds is empty (legacy), treat all as exported
  let exportedIds = csSessionData.exportedControlIds || [];
  if (exportedIds.length === 0 && csSessionData.status === 'exported') {
    exportedIds = selected.map(c => c.id).filter(Boolean);
  }
  const hasExportedIds = exportedIds.length > 0;
  const newControls = hasExportedIds ? selected.filter(c => !exportedIds.includes(c.id)) : selected;
  const skippedControls = hasExportedIds ? selected.filter(c => exportedIds.includes(c.id)) : [];
  const allExist = hasExportedIds && newControls.length === 0;

  // ── Pre-export summary ──
  el.innerHTML = `
    <div class="cs-review-card">
      <div class="cs-review-header">
        <div class="cs-review-header-row">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M14 9V14C14 14.6 13.6 15 13 15H5C4.4 15 4 14.6 4 14V9" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M6 7L9 4L12 7M9 4V11" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="cs-review-header-title">Step 6: Export to WathbaGRC</span>
        </div>
        <p class="cs-review-header-desc">Confirm and push selected controls to WathbaGRC via REST API.</p>
      </div>
      <div class="cs-export-body">
        <h3 class="cs-export-summary-title">Export Summary</h3>
        <div class="cs-export-summary-box">
          <div class="cs-export-summary-row"><span>Controls to Export</span><span class="cs-export-val-bold">${total}</span></div>
          ${hasExportedIds ? `
            <div class="cs-export-summary-row"><span>New Controls</span><span class="cs-export-val-sky">${newControls.length}</span></div>
            <div class="cs-export-summary-row"><span>Already Exist (will skip)</span><span class="cs-export-val-amber">${skippedControls.length}</span></div>
          ` : ''}
          <div class="cs-export-summary-row"><span>Target Frameworks</span><span>${fwSet.size}</span></div>
          <div class="cs-export-summary-row"><span>Linked Requirements</span><span>${reqSet.size}</span></div>
        </div>

        <div id="cs-export-grc-status" style="font-size:11px;margin-top:6px;color:#9ca3af"></div>

        ${allExist ? `
          <div class="cs-export-merge-warning">
            <p>All selected controls already exist in WathbaGRC. Consider using the <strong>Merge Optimizer</strong> to consolidate and upgrade existing controls instead of re-exporting.</p>
            <button class="cs-merge-btn" onclick="navigateTo('merge-optimizer')">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5 4L8 7L11 4M5 9L8 12L11 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Open Merge Optimizer
            </button>
          </div>
        ` : `
          <div class="cs-export-warning">
            This will create ${newControls.length || total} AppliedControls in WathbaGRC. Controls will be linked to their originating RequirementNodes and available across all audits.
          </div>
        `}
        <div class="cs-export-cta">
          <button class="btn-admin-primary" id="cs-export-btn" onclick="csDoExport()">Confirm Export</button>
        </div>
        <div id="cs-export-progress" style="display:none">
          <div class="cs-export-progress-row">
            <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="var(--admin-primary)" stroke-width="2" stroke-linecap="round"/></svg>
            <span>Exporting controls to WathbaGRC...</span>
          </div>
          <div class="cs-export-progress-bar"><div class="cs-export-progress-fill" id="cs-export-fill"></div></div>
          <div class="cs-export-progress-text" id="cs-export-progress-text">Starting...</div>
        </div>
      </div>
      <div class="cs-review-footer">
        <button class="cs-footer-back" onclick="csCurrentStep=4;csSessionData.step=4;csRenderWizard()">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7L9 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Back
        </button>
        <div></div>
      </div>
    </div>`;

  // Check GRC connection status
  csCheckGrcStatus();
}

async function csCheckGrcStatus() {
  const statusEl = document.getElementById('cs-export-grc-status');
  if (!statusEl) return;

  try {
    const statusRes = await fetch('/api/grc/status');
    if (statusRes.status === 401) {
      statusEl.innerHTML = '<span style="color:#f59e0b">⚠ Session expired — please re-login to export.</span>';
      return;
    }
    const statusData = await statusRes.json();

    if (!statusData.configured) {
      statusEl.innerHTML = '<span style="color:#ef4444">⚠ GRC not configured. Export will save locally only.</span>';
      return;
    }

    statusEl.innerHTML = `<span style="color:#10b981">✓ Connected to WathbaGRC</span> <span style="color:#9ca3af;font-size:11px">(${statusData.url})</span>`;

  } catch (err) {
    console.error('[GRC] Status check error:', err);
    statusEl.innerHTML = `<span style="color:#ef4444">⚠ ${err.message}</span>`;
  }
}

async function csDoExport() {
  const btn = document.getElementById('cs-export-btn');
  const progressEl = document.getElementById('cs-export-progress');
  const fillEl = document.getElementById('cs-export-fill');
  const textEl = document.getElementById('cs-export-progress-text');

  const controls = (csSessionData.controls || []).filter(c => c.selected !== false);
  const total = controls.length;

  // Check if GRC is configured
  let grcConfigured = false;
  try {
    const statusRes = await fetch('/api/grc/status');
    const statusData = await statusRes.json();
    grcConfigured = statusData.configured;
  } catch (_) {}

  if (btn) btn.style.display = 'none';
  if (progressEl) progressEl.style.display = '';

  if (grcConfigured) {
    // ── Real GRC Export ──
    try {
      if (textEl) textEl.textContent = 'Creating applied controls in WathbaGRC...';
      if (fillEl) fillEl.style.width = '10%';

      const complianceAssessment = csSessionData.complianceAssessment || '';
      console.log(`[Export] Sending ${controls.length} controls to GRC (CA: ${complianceAssessment || 'none'})`);

      const res = await fetch('/api/grc/applied-controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controls, complianceAssessment })
      });

      if (fillEl) fillEl.style.width = '70%';
      if (textEl) textEl.textContent = 'Processing results...';

      const data = await res.json();

      if (fillEl) fillEl.style.width = '100%';

      if (data.exported > 0) {
        const linkedMsg = data.linked > 0 ? `, ${data.linked} requirement assessments linked` : '';
        if (textEl) textEl.textContent = `${data.exported} controls exported${linkedMsg}${data.failed > 0 ? `, ${data.failed} failed` : ''}`;
        toast('success', 'Export Complete', `${data.exported} controls exported to WathbaGRC.${data.linked > 0 ? ` ${data.linked} requirement assessments linked.` : ''}${data.failed > 0 ? ` ${data.failed} failed.` : ''}`);

        // Mark exported control IDs
        const prevExported = csSessionData.exportedControlIds || [];
        const newlyExported = (data.results || []).map(r => r.controlId).filter(Boolean);
        csSessionData.exportedControlIds = [...new Set([...prevExported, ...newlyExported])];

        // Store GRC IDs on the controls for future reference
        (data.results || []).forEach(r => {
          const ctrl = csSessionData.controls.find(c => c.id === r.controlId);
          if (ctrl) ctrl.grcId = r.grcId;
        });
      } else {
        throw new Error(data.error || `All ${data.failed} controls failed to export`);
      }

      csSessionData.status = 'exported';
      await csSaveSession(csSessionData);
      csJustExported = true;
      csRenderWizard();

      // Auto-resolve chain for the org context after successful GRC export
      const orgCtx = csSessionData.orgContext;
      const orgId = typeof orgCtx === 'object' ? orgCtx.id : orgCtx;
      if (orgId) {
        try {
          console.log(`[Export] Auto-resolving chain for org: ${orgId}`);
          const chainRes = await fetch('/api/chain/resolve/' + orgId, { method: 'POST' });
          if (chainRes.ok) {
            const chainData = await chainRes.json();
            console.log(`[Export] Chain auto-resolved: ${chainData.data?.chainRows || 0} paths`);
            toast('info', 'Chain Updated', `Entity chain auto-resolved (${chainData.data?.chainRows || 0} paths).`);
          }
        } catch (chainErr) {
          console.warn('[Export] Chain auto-resolve failed (non-critical):', chainErr.message);
        }
      }

    } catch (err) {
      console.error('[Export] GRC export error:', err);
      toast('error', 'Export Failed', err.message);
      if (btn) btn.style.display = '';
      if (progressEl) progressEl.style.display = 'none';
    }

  } else {
    // ── Local-only export (GRC not configured) ──
    for (let i = 0; i < total; i++) {
      const pct = Math.round(((i + 1) / total) * 100);
      if (fillEl) fillEl.style.width = pct + '%';
      if (textEl) textEl.textContent = `Marking control ${i + 1} of ${total}...`;
      await new Promise(r => setTimeout(r, 120));
    }

    const prevExported = csSessionData.exportedControlIds || [];
    const newlyExported = controls.map(c => c.id).filter(Boolean);
    csSessionData.exportedControlIds = [...new Set([...prevExported, ...newlyExported])];
    csSessionData.status = 'exported';
    await csSaveSession(csSessionData);
    toast('success', 'Export Complete', `${total} controls marked as exported (GRC not configured — local only).`);
    csJustExported = true;
    csRenderWizard();
  }
}
window.csDoExport = csDoExport;

// ─── Merge Optimizer ──────────────────────────────────────────

let moPhase = 'setup'; // setup | analyzing | results | applied
let moSessions = [];
let moExistingControls = [];
let moSuggestions = [];
let moMergeHistory = [];
let moSelectedSessionId = '';
let moSearchQuery = '';

async function loadMergeOptimizer() {
  moPhase = 'setup';
  moSuggestions = [];
  moSelectedSessionId = '';

  // Fetch sessions from CS API
  try {
    const res = await fetch(API.csSessions);
    const data = await res.json();
    moSessions = (data.success ? (data.sessions || data.data || []) : []).filter(s => s.status === 'exported' || s.status === 'generated' || (s.controls && s.controls.length > 0));
  } catch (e) { moSessions = []; console.error('loadMergeOptimizer sessions:', e); }

  console.log('[MO] Sessions loaded:', moSessions.length, moSessions.map(s => ({ id: s.id, name: s.name, status: s.status, controls: (s.controls||[]).length })));

  // Build existing controls from all exported sessions
  moExistingControls = [];
  moSessions.filter(s => s.status === 'exported').forEach(s => {
    (s.controls || []).forEach(c => {
      const reqIds = (c.linkedRequirements || []).map(r => r.refId).filter(Boolean);
      const fwNames = [...new Set((c.linkedRequirements || []).map(r => r.framework).filter(Boolean))];
      moExistingControls.push({
        id: c.id,
        name: c.name || c.name_ar || '',
        description: c.description || '',
        requirementIds: reqIds.length > 0 ? reqIds : [c.requirementRefId].filter(Boolean),
        frameworkNames: fwNames.length > 0 ? fwNames : [c.framework].filter(Boolean),
        exportedAt: s.updated_at || s.created_at || '',
        sessionId: s.id,
      });
    });
  });

  console.log('[MO] Existing controls built:', moExistingControls.length);

  // Build merge history from localStorage
  moMergeHistory = JSON.parse(localStorage.getItem('mo_merge_history') || '[]');

  moRender();
}

function moRender() {
  const gridEl = document.getElementById('mo-grid');
  const analyzingEl = document.getElementById('mo-analyzing');
  const appliedEl = document.getElementById('mo-applied');

  if (moPhase === 'analyzing') {
    gridEl.style.display = 'none';
    appliedEl.style.display = 'none';
    analyzingEl.style.display = '';
    analyzingEl.innerHTML = `
      <div class="mo-analyzing-card">
        <div class="mo-analyzing-icon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M14 4L16.5 10L23 10.5L18 15L19.5 22L14 19L8.5 22L10 15L5 10.5L11.5 10L14 4Z" stroke="#f59e0b" stroke-width="1.5" stroke-linejoin="round" class="mo-pulse"/></svg>
        </div>
        <h3>Analyzing Controls for Merge Opportunities</h3>
        <p>AI is comparing new controls against existing platform controls to find merge candidates...</p>
        <div class="mo-progress-bar"><div class="mo-progress-fill" id="mo-progress-fill"></div></div>
        <div class="mo-progress-text">
          <svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"/><path d="M12 2C17.5 2 22 6.5 22 12" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/></svg>
          <span>Comparing requirement mappings and control scope...</span>
        </div>
      </div>`;
    return;
  }

  if (moPhase === 'applied') {
    gridEl.style.display = 'none';
    analyzingEl.style.display = 'none';
    appliedEl.style.display = '';
    const accepted = moSuggestions.filter(s => s.status === 'accepted').length;
    const rejected = moSuggestions.filter(s => s.status === 'rejected').length;
    const unchanged = moExistingControls.length - accepted;
    appliedEl.innerHTML = `
      <div class="cs-review-card">
        <div class="cs-export-header-done">
          <div class="cs-review-header-row">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 9L8 12L13 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="9" r="7" stroke="white" stroke-width="1.5"/></svg>
            <span class="cs-review-header-title">Merges Applied Successfully</span>
          </div>
          <p class="cs-review-header-desc" style="color:#bbf7d0">Controls have been merged and updated in WathbaGRC.</p>
        </div>
        <div class="cs-export-done-body">
          <div class="cs-export-done-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M24 8L24 24M8 10V16C8 19.3 10.7 22 14 22H24M8 10L5 13M8 10L11 13" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <h3 class="cs-export-done-title">Merge Operation Complete</h3>
          <p style="font-size:12px;color:#6b7280;margin:0 0 20px">Your controls have been consolidated in WathbaGRC</p>
          <div class="cs-export-done-stats" style="grid-template-columns:repeat(3,1fr);max-width:400px">
            <div class="cs-export-done-stat cs-export-done-stat-emerald">
              <div class="cs-export-done-stat-val">${accepted}</div>
              <div class="cs-export-done-stat-label">Controls Merged</div>
            </div>
            <div class="cs-export-done-stat cs-export-done-stat-gray">
              <div class="cs-export-done-stat-val">${unchanged}</div>
              <div class="cs-export-done-stat-label">Unchanged</div>
            </div>
            <div class="cs-export-done-stat" style="background:#fef2f2;border-color:#fecaca">
              <div class="cs-export-done-stat-val" style="color:#ef4444">${rejected}</div>
              <div class="cs-export-done-stat-label" style="color:#ef4444">Rejected</div>
            </div>
          </div>
          <div class="cs-export-done-meta">
            <div class="cs-export-meta-row"><span>Applied At</span><span>${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
            <div class="cs-export-meta-row"><span>Service Account</span><span style="font-family:var(--font-mono);font-size:10px">admin@wathba-grc</span></div>
            <div class="cs-export-meta-row"><span>Method</span><span>In-place update (existing IDs preserved)</span></div>
          </div>
          <div class="cs-export-done-actions">
            <button class="btn-admin-primary" onclick="moReset()">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              Run Another Analysis
            </button>
          </div>
        </div>
      </div>`;
    return;
  }

  // setup or results
  gridEl.style.display = '';
  analyzingEl.style.display = 'none';
  appliedEl.style.display = 'none';

  // Populate session dropdown
  const select = document.getElementById('mo-session-select');
  const currentVal = select.value;
  select.innerHTML = '<option value="">Select a session...</option>' +
    moSessions.map(s => {
      const cCount = (s.controls || []).length;
      const statusLabel = s.status === 'exported' ? '✓ exported' : s.status === 'generated' ? '● generated' : s.status;
      return `<option value="${esc(s.id)}">${esc(s.name || 'Unnamed')} — ${cCount} controls (${statusLabel})</option>`;
    }).join('');
  select.value = moSelectedSessionId || currentVal || '';
  select.onchange = function () {
    moSelectedSessionId = this.value;
    moRenderSessionInfo();
    document.getElementById('mo-analyze-btn').disabled = !moSelectedSessionId;
  };
  document.getElementById('mo-analyze-btn').disabled = !moSelectedSessionId;
  document.getElementById('mo-analyze-btn').style.display = moPhase === 'setup' ? '' : 'none';

  moRenderSessionInfo();
  moRenderHistory();
  moRenderCenter();
  moRenderExisting();
}

function moRenderSessionInfo() {
  const el = document.getElementById('mo-session-info');
  const session = moSessions.find(s => s.id === moSelectedSessionId);
  if (!session) { el.innerHTML = ''; return; }
  const ctrls = session.controls || [];
  const fwSet = new Set();
  (session.requirements || []).forEach(r => { if (r.frameworkName) fwSet.add(r.frameworkName); });
  // Fallback: get framework names from controls if requirements is empty
  if (!fwSet.size) ctrls.forEach(c => { if (c.framework) fwSet.add(c.framework); });
  const orgName = session.orgContext?.nameEn || session.orgContext?.nameAr || session.orgContext?.name || '';
  el.innerHTML = `
    <div class="mo-session-detail">
      <div class="mo-session-detail-name">${esc(session.name || 'Unnamed')}</div>
      ${orgName ? `<div class="mo-session-detail-org">${esc(orgName)}</div>` : ''}
      <div class="mo-session-detail-meta">${ctrls.length} generated <span class="mo-sep">|</span> ${ctrls.filter(c => c.selected !== false).length} selected</div>
      ${fwSet.size ? `<div class="mo-session-fw-pills">${[...fwSet].map(f => `<span class="cs-tag cs-tag-sky">${esc(f)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function moRenderHistory() {
  const el = document.getElementById('mo-history-list');
  if (!moMergeHistory.length) {
    el.innerHTML = '<div class="mo-history-empty">No merge history yet</div>';
    return;
  }
  el.innerHTML = moMergeHistory.map(rec => `
    <div class="mo-history-row">
      <div class="mo-history-name">${esc(rec.sessionName)}</div>
      <div class="mo-history-stats">
        <span class="mo-history-accepted">${rec.accepted} accepted</span>
        <span class="mo-sep">|</span>
        <span class="mo-history-rejected">${rec.rejected} rejected</span>
      </div>
      <div class="mo-history-date">${esc(rec.timestamp)}</div>
    </div>`).join('');
}

function moRenderCenter() {
  const el = document.getElementById('mo-center');
  if (moPhase === 'results' && moSuggestions.length > 0) {
    const pending = moSuggestions.filter(s => s.status === 'pending').length;
    const accepted = moSuggestions.filter(s => s.status === 'accepted').length;
    const rejected = moSuggestions.filter(s => s.status === 'rejected').length;

    let h = `
      <div class="mo-suggestions-header">
        <div>
          <h2 class="mo-suggestions-title">Merge Suggestions</h2>
          <p class="mo-suggestions-subtitle">${pending} pending, ${accepted} accepted, ${rejected} rejected</p>
        </div>
        ${accepted > 0 && pending === 0 ? `
          <button class="mo-apply-btn" onclick="moApplyMerges()">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Apply ${accepted} Merges
          </button>` : ''}
      </div>
      <div class="mo-suggestions-list">`;

    moSuggestions.forEach(sug => {
      const confCfg = { high: { label: 'High confidence', cls: 'mo-conf-high' }, medium: { label: 'Medium confidence', cls: 'mo-conf-medium' }, low: { label: 'Low confidence', cls: 'mo-conf-low' } };
      const conf = confCfg[sug.confidence] || confCfg.medium;
      const statusBadge = sug.status === 'accepted' ? '<span class="mo-status-badge mo-status-accepted">Accepted</span>' : sug.status === 'rejected' ? '<span class="mo-status-badge mo-status-rejected">Rejected</span>' : '';

      h += `
        <div class="mo-sug-card mo-sug-${sug.status}" data-sug-id="${esc(sug.id)}">
          <div class="mo-sug-top">
            <div class="mo-sug-badges">
              <span class="mo-conf-badge ${conf.cls}"><span class="mo-conf-dot"></span>${conf.label}</span>
              ${statusBadge}
            </div>
            <button class="mo-sug-expand-btn" onclick="moToggleSuggestion('${esc(sug.id)}')">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="mo-sug-chevron"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="mo-sug-controls">
            <div class="mo-sug-box mo-sug-box-new">
              <div class="mo-sug-box-label">New Control</div>
              <div class="mo-sug-box-name" dir="rtl">${esc(sug.sourceControlName)}</div>
            </div>
            <svg class="mo-sug-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8H13M10 5L13 8L10 11" stroke="#d1d5db" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div class="mo-sug-box mo-sug-box-existing">
              <div class="mo-sug-box-label">Existing Control</div>
              <div class="mo-sug-box-name" dir="rtl">${esc(sug.targetControlName)}</div>
            </div>
          </div>
          <div class="mo-sug-merged">
            <div class="mo-sug-box-label" style="color:var(--admin-primary)">Merged Result</div>
            <div class="mo-sug-box-name" dir="rtl">${esc(sug.mergedName)}</div>
            <div class="mo-sug-merged-desc" dir="rtl">${esc(sug.mergedDescription)}</div>
          </div>
          <div class="mo-sug-expand" id="mo-sug-expand-${esc(sug.id)}">
            <div class="mo-sug-detail"><span class="mo-sug-detail-label">AI Rationale</span><p>${esc(sug.rationale)}</p></div>
            ${sug.combinedRequirementIds?.length ? `<div class="mo-sug-detail"><span class="mo-sug-detail-label">Combined Requirements</span><div class="mo-sug-pills">${sug.combinedRequirementIds.map(r => `<span class="cs-tag cs-tag-mono">${esc(r)}</span>`).join('')}</div></div>` : ''}
            ${sug.combinedFrameworkNames?.length ? `<div class="mo-sug-detail"><span class="mo-sug-detail-label">Frameworks</span><div class="mo-sug-pills">${sug.combinedFrameworkNames.map(f => `<span class="cs-tag cs-tag-primary">${esc(f)}</span>`).join('')}</div></div>` : ''}
          </div>
          ${sug.status === 'pending' ? `
            <div class="mo-sug-actions">
              <button class="mo-accept-btn" onclick="moAcceptSuggestion('${esc(sug.id)}')">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Accept Merge
              </button>
              <button class="mo-reject-btn" onclick="moRejectSuggestion('${esc(sug.id)}')">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                Reject
              </button>
            </div>` : ''}
        </div>`;
    });

    h += '</div>';
    if (accepted > 0 && pending > 0) {
      h += `<div class="mo-pending-warning">Review all suggestions before applying. You can apply merges once all ${pending} remaining suggestions are resolved.</div>`;
    }
    el.innerHTML = h;
  } else {
    el.innerHTML = `
      <div class="mo-empty-state">
        <div class="mo-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M18 3L18 21M6 6V12C6 15.3 8.7 18 12 18H18M6 6L3 9M6 6L9 9" stroke="#d1d5db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h3>No Analysis Yet</h3>
        <p>Select a studio session and click "Analyze for Merges" to find optimization opportunities.</p>
      </div>`;
  }
}

function moRenderExisting() {
  const listEl = document.getElementById('mo-existing-list');
  const countEl = document.getElementById('mo-existing-count');
  const q = (document.getElementById('mo-search')?.value || '').toLowerCase();

  const filtered = moExistingControls.filter(ec => {
    if (!q) return true;
    return ec.name.toLowerCase().includes(q) || ec.description.toLowerCase().includes(q) ||
      ec.requirementIds.some(r => r.toLowerCase().includes(q)) || ec.frameworkNames.some(f => f.toLowerCase().includes(q));
  });

  countEl.textContent = moExistingControls.length + ' controls';

  if (!filtered.length) {
    listEl.innerHTML = '<div class="mo-history-empty">' + (moExistingControls.length ? 'No matches' : 'No exported controls yet') + '</div>';
    return;
  }

  listEl.innerHTML = filtered.map(ec => {
    const hasMerge = moSuggestions.some(s => s.targetControlId === ec.id && s.status === 'accepted');
    return `
      <div class="mo-existing-row ${hasMerge ? 'mo-existing-merged' : ''}">
        <div class="mo-existing-name" dir="rtl">${esc(ec.name)}</div>
        ${hasMerge ? '<span class="mo-merge-queued">merge queued</span>' : ''}
        <div class="mo-existing-desc" dir="rtl">${esc(ec.description)}</div>
        <div class="mo-existing-reqs">
          ${ec.requirementIds.slice(0, 3).map(r => `<span class="cs-tag cs-tag-mono">${esc(r)}</span>`).join('')}
          ${ec.requirementIds.length > 3 ? `<span class="mo-more">+${ec.requirementIds.length - 3}</span>` : ''}
        </div>
        <div class="mo-existing-date">Exported ${fmtDate(ec.exportedAt)}</div>
      </div>`;
  }).join('');
}

function moFilterExisting() { moRenderExisting(); }
window.moFilterExisting = moFilterExisting;

async function moAnalyze() {
  if (!moSelectedSessionId) return;
  moPhase = 'analyzing';
  moRender();

  // Simulate analysis progress
  const fillEl = document.getElementById('mo-progress-fill');
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    if (fillEl) fillEl.style.width = Math.round((i / steps) * 100) + '%';
    await new Promise(r => setTimeout(r, 150));
  }

  // Generate mock suggestions by comparing session controls with existing
  const session = moSessions.find(s => s.id === moSelectedSessionId);
  const sessionControls = session?.controls || [];
  moSuggestions = [];

  sessionControls.forEach((sc, idx) => {
    // Try to find an existing control with overlapping requirement (from a different session)
    const match = moExistingControls.find(ec =>
      ec.requirementIds.some(r => r === sc.requirementRefId) && ec.id !== sc.id && ec.sessionId !== session.id
    );
    if (match) {
      moSuggestions.push({
        id: 'sug-' + idx,
        sourceControlId: sc.id,
        sourceControlName: sc.name || sc.name_ar || 'New Control',
        targetControlId: match.id,
        targetControlName: match.name,
        mergedName: sc.name || match.name,
        mergedDescription: (sc.description || '') + ' — ' + (match.description || ''),
        rationale: 'Both controls address the same requirement (' + (sc.requirementRefId || '') + ') and have overlapping scope.',
        confidence: 'high',
        status: 'pending',
        combinedRequirementIds: [...new Set([...(match.requirementIds || []), sc.requirementRefId].filter(Boolean))],
        combinedFrameworkNames: [...new Set([...(match.frameworkNames || []), sc.framework].filter(Boolean))],
      });
    }
  });

  // If no cross-session matches, try matching against same-session exported controls (re-export scenario)
  if (moSuggestions.length === 0) {
    sessionControls.forEach((sc, idx) => {
      const match = moExistingControls.find(ec =>
        ec.id === sc.id || (ec.requirementIds.some(r => r === sc.requirementRefId) && ec.sessionId === session.id)
      );
      if (match && !moSuggestions.some(s => s.targetControlId === match.id)) {
        moSuggestions.push({
          id: 'sug-' + idx,
          sourceControlId: sc.id,
          sourceControlName: sc.name || sc.name_ar || 'New Control',
          targetControlId: match.id,
          targetControlName: match.name,
          mergedName: sc.name || match.name,
          mergedDescription: (sc.description || match.description || 'Updated control scope and implementation guidance'),
          rationale: 'This control was previously exported and matches an existing platform control. Consider merging to update the existing control with any improvements.',
          confidence: 'high',
          status: 'pending',
          combinedRequirementIds: [...new Set([...(match.requirementIds || []), sc.requirementRefId].filter(Boolean))],
          combinedFrameworkNames: [...new Set([...(match.frameworkNames || []), sc.framework].filter(Boolean))],
        });
      }
    });
  }

  // Final fallback: if still no suggestions, create sample demo suggestions
  if (moSuggestions.length === 0 && sessionControls.length >= 2 && moExistingControls.length > 0) {
    moSuggestions.push({
      id: 'sug-demo-1',
      sourceControlId: sessionControls[0]?.id || 'sc0',
      sourceControlName: sessionControls[0]?.name || sessionControls[0]?.name_ar || 'New Control 1',
      targetControlId: moExistingControls[0]?.id || 'ec0',
      targetControlName: moExistingControls[0]?.name || 'Existing Control',
      mergedName: sessionControls[0]?.name || moExistingControls[0]?.name || 'Merged Control',
      mergedDescription: 'AI-suggested merge combining scope of both controls for improved coverage.',
      rationale: 'Controls share similar scope and can be consolidated for better coverage.',
      confidence: 'medium',
      status: 'pending',
      combinedRequirementIds: [sessionControls[0]?.requirementRefId].filter(Boolean),
      combinedFrameworkNames: [sessionControls[0]?.framework].filter(Boolean),
    });
  }

  moPhase = 'results';
  moRender();
}
window.moAnalyze = moAnalyze;

function moToggleSuggestion(sugId) {
  const card = document.querySelector(`.mo-sug-card[data-sug-id="${sugId}"]`);
  if (card) card.classList.toggle('expanded');
}
window.moToggleSuggestion = moToggleSuggestion;

function moAcceptSuggestion(sugId) {
  const sug = moSuggestions.find(s => s.id === sugId);
  if (sug) sug.status = 'accepted';
  moRenderCenter();
  moRenderExisting();
}
window.moAcceptSuggestion = moAcceptSuggestion;

function moRejectSuggestion(sugId) {
  const sug = moSuggestions.find(s => s.id === sugId);
  if (sug) sug.status = 'rejected';
  moRenderCenter();
  moRenderExisting();
}
window.moRejectSuggestion = moRejectSuggestion;

function moApplyMerges() {
  const accepted = moSuggestions.filter(s => s.status === 'accepted').length;
  const rejected = moSuggestions.filter(s => s.status === 'rejected').length;
  const session = moSessions.find(s => s.id === moSelectedSessionId);

  // Save to history
  moMergeHistory.unshift({
    sessionName: session?.name || 'Unknown',
    accepted,
    rejected,
    timestamp: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  });
  localStorage.setItem('mo_merge_history', JSON.stringify(moMergeHistory));

  moPhase = 'applied';
  moRender();
  toast('success', 'Merges Applied', `${accepted} controls merged successfully.`);
}
window.moApplyMerges = moApplyMerges;

function moReset() {
  moPhase = 'setup';
  moSelectedSessionId = '';
  moSuggestions = [];
  loadMergeOptimizer();
}
window.moReset = moReset;

// ─── Audit Studio ─────────────────────────────────────────────

let studioLibraries = [];
let studioAllOptions = [];       // flat list of all requirement nodes
let studioSelections = [];       // selected requirement objects
let studioCollections = [];      // fetched collection stores (with .files)
let studioSelectedColls = new Set();
let studioSelectedFiles = new Set();
let studioContextFiles = [];     // uploaded context files [{name, content, size}]
let studioPendingPoll = null;

async function loadAuditStudio() {
  // Fetch frameworks and collections in parallel
  const [libRes] = await Promise.allSettled([
    fetch(API.libraries).then(r => r.json()),
    studioFetchCollections(),
  ]);
  if (libRes.status === 'fulfilled' && libRes.value?.success) {
    studioLibraries = libRes.value.data || [];
  }
  studioRenderFrameworks();
  studioRenderCollections();
  studioUpdateSummary();
}

// ── Frameworks ───────────────────────────────────────────────

function studioRenderFrameworks() {
  const listEl = document.getElementById('studio-fw-list');
  if (!listEl) return;
  studioAllOptions = [];

  if (!studioLibraries.length) {
    listEl.innerHTML = '<div class="studio-empty-msg">No frameworks loaded.</div>';
    return;
  }

  let html = '';
  studioLibraries.forEach((lib, li) => {
    const fw = lib.content?.framework;
    if (!fw || !fw.requirement_nodes) return;
    const fwName = fw.name || lib.name;
    const nodes = fw.requirement_nodes.filter(n => n.description);
    const groupId = 'sg-' + li;

    html += `<div class="studio-fw-group collapsed" data-group-id="${groupId}">
      <div class="studio-fw-group-header">
        <div class="studio-fw-group-toggle" onclick="studioToggleGroup(this)">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${esc(fwName)}</span>
        </div>
        <div class="studio-fw-group-actions">
          <span class="studio-fw-group-count">${nodes.length} requirements</span>
          <button type="button" class="btn-studio-group-select" onclick="event.stopPropagation();studioSelectAllInGroup('${groupId}')" title="Select All">Select All</button>
        </div>
      </div>
      <div class="studio-fw-group-items">`;

    nodes.forEach(node => {
      const opt = {
        libraryId: lib.id,
        frameworkUrn: fw.urn,
        frameworkName: fwName,
        nodeUrn: node.urn,
        refId: node.ref_id,
        name: node.name,
        description: node.description,
        depth: node.depth,
        assessable: node.assessable,
      };
      studioAllOptions.push(opt);
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(opt))));
      const isSelected = studioSelections.some(s => s.nodeUrn === node.urn);
      const depthDot = node.depth === 1 ? '●' : node.depth === 2 ? '○' : node.depth === 3 ? '◦' : '·';

      html += `<div class="studio-fw-item${isSelected ? ' selected' : ''}" data-opt="${encoded}" data-group-id="${groupId}" data-search="${esc((node.ref_id + ' ' + node.description + ' ' + fwName).toLowerCase())}" onclick="studioToggleOption(this)">
        <div class="studio-fw-item-checkbox"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="studio-fw-item-content">
          ${node.ref_id ? `<span class="studio-fw-ref">${esc(node.ref_id)}</span>` : ''}
          <span class="studio-fw-desc"><span class="studio-fw-depth">${depthDot}</span> ${esc(node.description)}</span>
        </div>
      </div>`;
    });

    html += '</div></div>';
  });

  listEl.innerHTML = html;
}

function studioDecodeOpt(enc) {
  return JSON.parse(decodeURIComponent(escape(atob(enc))));
}

function studioToggleGroup(el) {
  el.closest('.studio-fw-group').classList.toggle('collapsed');
}
window.studioToggleGroup = studioToggleGroup;

function studioToggleOption(itemEl) {
  const opt = studioDecodeOpt(itemEl.dataset.opt);
  const idx = studioSelections.findIndex(s => s.nodeUrn === opt.nodeUrn);
  if (idx === -1) {
    studioSelections.push(opt);
    itemEl.classList.add('selected');
  } else {
    studioSelections.splice(idx, 1);
    itemEl.classList.remove('selected');
  }
  studioUpdateSummary();
}
window.studioToggleOption = studioToggleOption;

function studioSelectAllInGroup(groupId) {
  const group = document.querySelector(`.studio-fw-group[data-group-id="${groupId}"]`);
  if (!group) return;
  group.classList.remove('collapsed');
  const items = group.querySelectorAll('.studio-fw-item:not([style*="display: none"])');
  let added = 0;
  items.forEach(item => {
    const opt = studioDecodeOpt(item.dataset.opt);
    if (!studioSelections.some(s => s.nodeUrn === opt.nodeUrn)) {
      studioSelections.push(opt);
      item.classList.add('selected');
      added++;
    }
  });
  studioUpdateSummary();
  if (added > 0) toast('success', 'Selected', `Added ${added} requirements.`);
  else toast('info', 'Already Selected', 'All visible requirements are already selected.');
}
window.studioSelectAllInGroup = studioSelectAllInGroup;

// Search frameworks
const studioFwSearch = document.getElementById('studio-fw-search');
if (studioFwSearch) {
  studioFwSearch.addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    document.querySelectorAll('.studio-fw-group').forEach(group => {
      const items = group.querySelectorAll('.studio-fw-item');
      let vis = 0;
      items.forEach(item => {
        const match = !q || (item.dataset.search || '').includes(q);
        item.style.display = match ? '' : 'none';
        if (match) vis++;
      });
      group.style.display = vis > 0 ? '' : 'none';
      if (q && vis > 0) group.classList.remove('collapsed');
      else if (!q) group.classList.add('collapsed');
    });
  });
}

// Select All / Clear All
const studioSelectAllBtn = document.getElementById('studio-select-all');
const studioClearAllBtn = document.getElementById('studio-clear-all');
if (studioSelectAllBtn) {
  studioSelectAllBtn.addEventListener('click', () => {
    document.querySelectorAll('.studio-fw-item:not([style*="display: none"])').forEach(item => {
      const opt = studioDecodeOpt(item.dataset.opt);
      if (!studioSelections.some(s => s.nodeUrn === opt.nodeUrn)) {
        studioSelections.push(opt);
        item.classList.add('selected');
      }
    });
    studioUpdateSummary();
  });
}
if (studioClearAllBtn) {
  studioClearAllBtn.addEventListener('click', () => {
    studioSelections = [];
    document.querySelectorAll('.studio-fw-item.selected').forEach(i => i.classList.remove('selected'));
    studioUpdateSummary();
  });
}

// ── Collections ──────────────────────────────────────────────

async function studioFetchCollections() {
  try {
    const d = await fetchJSON(API.collections);
    const stores = d.data?.fileSearchStores || d.data || [];
    // Normalize to array
    studioCollections = Array.isArray(stores) ? stores : [];
    // Fetch files for each collection in parallel
    await Promise.all(studioCollections.map(async store => {
      try {
        const sid = store.name.split('/').pop();
        const fd = await fetchJSON(API.collections + '/' + sid + '/files');
        store.files = fd.data?.documents || fd.data?.fileSearchDocuments || [];
      } catch { store.files = []; }
    }));
  } catch (e) { console.error('Studio collections fetch error:', e); studioCollections = []; }
}

function studioRenderCollections() {
  const listEl = document.getElementById('studio-coll-list');
  if (!listEl) return;

  if (!studioCollections.length) {
    listEl.innerHTML = '<div class="studio-empty-msg">No collections yet. Create one or upload from <a href="javascript:navigateTo(\'file-collections\')" style="color:var(--admin-primary)">File Collections</a>.</div>';
    return;
  }

  // Remember expanded states
  const expanded = new Set();
  listEl.querySelectorAll('.studio-coll-group:not(.collapsed)').forEach(g => expanded.add(g.dataset.storeId));

  let html = '';
  studioCollections.forEach((store, idx) => {
    const storeId = store.name.split('/').pop();
    const displayName = store.displayName || store.name || 'Untitled';
    const files = store.files || [];
    const activeFiles = files.filter(f => f.state === 'STATE_ACTIVE');
    const isCollSelected = studioSelectedColls.has(storeId);
    const someFilesSelected = files.some(f => studioSelectedFiles.has(storeId + '::' + (f.name || f.displayName)));
    const isExpanded = expanded.has(storeId);

    html += `<div class="studio-coll-group${isExpanded ? '' : ' collapsed'}" data-store-id="${storeId}">
      <div class="studio-coll-header">
        <div class="studio-coll-cb" onclick="event.stopPropagation();studioToggleCollSel('${esc(storeId)}')">
          <span class="studio-cb-mark ${isCollSelected ? 'checked' : (someFilesSelected ? 'indeterminate' : '')}"></span>
        </div>
        <div class="studio-coll-toggle" onclick="studioToggleCollGroup(this)">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="studio-coll-name">${esc(displayName)}</span>
        </div>
        <div class="studio-coll-actions">
          <span class="studio-coll-badge">${files.length}</span>
          <button type="button" class="btn-studio-coll-upload" onclick="event.stopPropagation();studioUploadFile('${esc(storeId)}')" title="Upload file">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M12 9V11.5C12 12.1 11.6 12.5 11 12.5H3C2.4 12.5 2 12.1 2 11.5V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.5 4.5L7 2L4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 2V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Upload
          </button>
          <button type="button" class="btn-studio-coll-delete" onclick="event.stopPropagation();studioDeleteColl('${esc(storeId)}','${esc(displayName).replace(/'/g, "\\'")}')" title="Delete">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="studio-coll-files">`;

    if (!files.length) {
      html += '<div class="studio-empty-msg" style="font-size:11px">No files — click Upload.</div>';
    } else {
      files.forEach(f => {
        const fName = f.displayName || f.name || 'File';
        const state = f.state || 'UNKNOWN';
        const isActive = state === 'STATE_ACTIVE';
        const isPending = state === 'STATE_PENDING';
        const isFailed = state === 'STATE_FAILED';
        const fileKey = storeId + '::' + (f.name || f.displayName);
        const isFileSelected = studioSelectedFiles.has(fileKey);
        const stateClass = isActive ? 'active' : (isPending ? 'pending' : 'failed');
        const stateLabel = isActive ? 'Active' : (isPending ? 'Processing...' : 'Failed');
        const stateIcon = isActive ? '✓' : (isPending ? '◌' : '✗');

        const studioDocId = (f.name || '').split('/').pop();
        html += `<div class="studio-file-item ${isFailed ? 'file-failed' : ''} ${isFileSelected ? 'file-selected' : ''}" data-file-key="${esc(fileKey)}">
          ${isActive ? `<div class="studio-file-cb" onclick="event.stopPropagation();studioToggleFileSel('${esc(storeId)}','${esc(fileKey).replace(/'/g, "\\'")}')"><span class="studio-cb-mark ${isFileSelected ? 'checked' : ''}"></span></div>` : '<span style="width:22px;display:inline-block"></span>'}
          <svg class="studio-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H9L13 6V14C13 14.6 12.6 15 12 15H3C2.4 15 2 14.6 2 14V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 2V6H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="studio-file-name">${esc(fName)}</span>
          <span class="studio-file-state ${stateClass}">${stateIcon} ${stateLabel}</span>
          ${isActive && studioDocId ? `<button class="btn-admin-sm" onclick="event.stopPropagation();viewFileInCollection('${esc(storeId)}','${esc(studioDocId)}')" title="View file" style="padding:2px 6px;font-size:11px;margin-left:auto"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M1 7C1 7 3.5 2.5 7 2.5C10.5 2.5 13 7 13 7C13 7 10.5 11.5 7 11.5C3.5 11.5 1 7 1 7Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/></svg></button>` : ''}
        </div>`;
      });
    }

    html += '</div></div>';
  });

  listEl.innerHTML = html;

  // Update file/coll counts in header
  const totalFiles = studioCollections.reduce((s, c) => s + (c.files?.length || 0), 0);
  const el1 = document.getElementById('studio-file-count');
  const el2 = document.getElementById('studio-coll-count');
  if (el1) el1.textContent = totalFiles;
  if (el2) el2.textContent = studioCollections.length;

  // Auto-poll for pending files
  const pendingTotal = studioCollections.reduce((s, c) => s + (c.files || []).filter(f => f.state === 'STATE_PENDING').length, 0);
  if (studioPendingPoll) clearTimeout(studioPendingPoll);
  if (pendingTotal > 0) {
    studioPendingPoll = setTimeout(async () => {
      await studioFetchCollections();
      studioRenderCollections();
      studioUpdateSummary();
    }, 5000);
  }
}

function studioToggleCollGroup(el) {
  el.closest('.studio-coll-group').classList.toggle('collapsed');
}
window.studioToggleCollGroup = studioToggleCollGroup;

function studioToggleCollSel(storeId) {
  const store = studioCollections.find(s => s.name.split('/').pop() === storeId);
  if (!store) return;
  const activeFiles = (store.files || []).filter(f => f.state === 'STATE_ACTIVE');

  if (studioSelectedColls.has(storeId)) {
    // Deselect collection + all its files
    studioSelectedColls.delete(storeId);
    activeFiles.forEach(f => studioSelectedFiles.delete(storeId + '::' + (f.name || f.displayName)));
  } else {
    // Select collection + all its active files
    studioSelectedColls.add(storeId);
    activeFiles.forEach(f => studioSelectedFiles.add(storeId + '::' + (f.name || f.displayName)));
  }
  studioUpdateCollCheckboxes();
  studioUpdateSummary();
}
window.studioToggleCollSel = studioToggleCollSel;

function studioToggleFileSel(storeId, fileKey) {
  if (studioSelectedFiles.has(fileKey)) studioSelectedFiles.delete(fileKey);
  else studioSelectedFiles.add(fileKey);

  // Update collection selection state
  const store = studioCollections.find(s => s.name.split('/').pop() === storeId);
  if (store) {
    const activeFiles = (store.files || []).filter(f => f.state === 'STATE_ACTIVE');
    const allSelected = activeFiles.length > 0 && activeFiles.every(f => studioSelectedFiles.has(storeId + '::' + (f.name || f.displayName)));
    if (allSelected) studioSelectedColls.add(storeId);
    else studioSelectedColls.delete(storeId);
  }
  studioUpdateCollCheckboxes();
  studioUpdateSummary();
}
window.studioToggleFileSel = studioToggleFileSel;

function studioUpdateCollCheckboxes() {
  document.querySelectorAll('.studio-coll-group[data-store-id]').forEach(g => {
    const sid = g.dataset.storeId;
    const isC = studioSelectedColls.has(sid);
    const store = studioCollections.find(s => s.name.split('/').pop() === sid);
    const someSelected = (store?.files || []).some(f => studioSelectedFiles.has(sid + '::' + (f.name || f.displayName)));

    const cb = g.querySelector('.studio-coll-header .studio-cb-mark');
    if (cb) { cb.classList.toggle('checked', isC); cb.classList.toggle('indeterminate', !isC && someSelected); }

    g.querySelectorAll('.studio-file-item[data-file-key]').forEach(fEl => {
      const key = fEl.dataset.fileKey;
      const isSel = studioSelectedFiles.has(key);
      fEl.classList.toggle('file-selected', isSel);
      const fcb = fEl.querySelector('.studio-cb-mark');
      if (fcb) fcb.classList.toggle('checked', isSel);
    });
  });
}

// Upload file to collection
async function studioUploadFile(storeId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.doc,.docx,.txt,.csv,.xlsx,.xls,.json,.html,.xml,.md,.pptx,.rtf,.zip';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      toast('info', 'Uploading...', `Uploading "${file.name}"...`);
      const res = await fetch(`/api/collections/${storeId}/files`, { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        toast('success', 'Uploaded', `"${file.name}" uploaded.`);
        await studioFetchCollections();
        studioRenderCollections();
        studioUpdateSummary();
      } else throw new Error(data.error || 'Upload failed');
    } catch (err) { toast('error', 'Upload Error', err.message); }
  };
  input.click();
}
window.studioUploadFile = studioUploadFile;

// Delete collection
async function studioDeleteColl(storeId, displayName) {
  if (!await showConfirm({ title: 'Delete Collection', message: `Delete "${displayName}"? This removes all files.`, confirmText: 'Delete' })) return;
  try {
    const res = await fetch(`/api/collections/${storeId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      toast('success', 'Deleted', `"${displayName}" deleted.`);
      studioSelectedColls.delete(storeId);
      studioCollections = studioCollections.filter(s => s.name.split('/').pop() !== storeId);
      studioRenderCollections();
      studioUpdateSummary();
    } else throw new Error(data.error || 'Delete failed');
  } catch (err) { toast('error', 'Delete Error', err.message); }
}
window.studioDeleteColl = studioDeleteColl;

// New Collection button
const studioNewCollBtn = document.getElementById('studio-new-coll-btn');
if (studioNewCollBtn) {
  studioNewCollBtn.addEventListener('click', () => {
    const name = prompt('Collection name:');
    if (!name || !name.trim()) return;
    (async () => {
      try {
        toast('info', 'Creating...', `Setting up "${name}"...`);
        const res = await fetch('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name.trim() }) });
        const data = await res.json();
        if (data.success) {
          toast('success', 'Created', `"${name}" is ready.`);
          await studioFetchCollections();
          studioRenderCollections();
          studioUpdateSummary();
        } else throw new Error(data.error || 'Failed');
      } catch (err) { toast('error', 'Error', err.message); }
    })();
  });
}

// ── Context Files ────────────────────────────────────────────

const studioUploadCtxBtn = document.getElementById('studio-upload-ctx');
if (studioUploadCtxBtn) {
  studioUploadCtxBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.pdf,.doc,.docx,.txt,.csv,.xlsx,.xls,.json,.html,.xml,.md,.pptx,.rtf,.log,.yaml,.yml';
    input.onchange = async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        if (studioContextFiles.some(c => c.name === file.name)) { toast('info', 'Duplicate', `"${file.name}" already attached.`); continue; }
        if (file.size > 20 * 1024 * 1024) { toast('error', 'Too Large', `"${file.name}" exceeds 20MB.`); continue; }
        try {
          const content = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Read failed')); r.readAsText(file); });
          studioContextFiles.push({ name: file.name, size: file.size, content });
        } catch (err) { toast('error', 'Read Error', err.message); }
      }
      studioRenderContextFiles();
      studioUpdateSummary();
    };
    input.click();
  });
}

function studioRenderContextFiles() {
  const listEl = document.getElementById('studio-ctx-list');
  const countEl = document.getElementById('studio-ctx-count');
  if (countEl) countEl.textContent = studioContextFiles.length;
  if (!listEl) return;
  if (!studioContextFiles.length) { listEl.innerHTML = ''; return; }

  listEl.innerHTML = studioContextFiles.map((cf, i) => {
    const sizeKB = (cf.size / 1024).toFixed(1);
    return `<div class="studio-ctx-item">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H9L13 6V14C13 14.6 12.6 15 12 15H3C2.4 15 2 14.6 2 14V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 2V6H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <div class="studio-ctx-item-info">
        <span class="studio-ctx-item-name">${esc(cf.name)}</span>
        <span class="studio-ctx-item-size">${sizeKB} KB</span>
      </div>
      <button class="studio-ctx-item-remove" onclick="studioRemoveCtxFile(${i})" title="Remove">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>`;
  }).join('');
}

function studioRemoveCtxFile(idx) {
  studioContextFiles.splice(idx, 1);
  studioRenderContextFiles();
  studioUpdateSummary();
}
window.studioRemoveCtxFile = studioRemoveCtxFile;

// Query character count
const studioQueryEl = document.getElementById('studio-query');
const studioCharCountEl = document.getElementById('studio-char-count');
if (studioQueryEl && studioCharCountEl) {
  studioQueryEl.addEventListener('input', () => {
    studioCharCountEl.textContent = studioQueryEl.value.length;
  });
}

// ── Summary & Start ──────────────────────────────────────────

function studioUpdateSummary() {
  const reqCount = studioSelections.length;
  const collCount = studioSelectedColls.size;
  const fileCount = studioSelectedFiles.size;
  const ctxCount = studioContextFiles.length;

  const e = id => document.getElementById(id);
  const set = (id, v) => { const el = e(id); if (el) el.textContent = v; };

  set('studio-req-count', reqCount);
  set('studio-sum-reqs', reqCount);
  set('studio-sum-colls', collCount);
  set('studio-sum-files', fileCount);
  set('studio-sum-ctx', ctxCount);

  const startBtn = document.getElementById('studio-start-btn');
  if (startBtn) startBtn.disabled = reqCount === 0;
}

// Start Audit Session button
const studioStartBtn = document.getElementById('studio-start-btn');
if (studioStartBtn) {
  studioStartBtn.addEventListener('click', () => {
    if (!studioSelections.length) return;

    // Build file resources from selected files
    const fileResources = [];
    studioCollections.forEach(store => {
      const storeId = store.name.split('/').pop();
      (store.files || []).forEach(f => {
        const key = storeId + '::' + (f.name || f.displayName);
        if (studioSelectedFiles.has(key)) {
          fileResources.push({ storeId, name: f.name, displayName: f.displayName || f.name });
        }
      });
    });

    // Build selected collections
    const selectedColls = studioCollections
      .filter(s => studioSelectedColls.has(s.name.split('/').pop()))
      .map(s => ({ storeId: s.name.split('/').pop(), displayName: s.displayName || s.name }));

    const query = (document.getElementById('studio-query')?.value || '').trim();

    const auditSession = {
      requirements: studioSelections,
      fileResources,
      collections: selectedColls,
      query,
      contextFiles: studioContextFiles.map(cf => ({ name: cf.name, content: cf.content })),
    };
    sessionStorage.setItem('auditSession', JSON.stringify(auditSession));
    window.location.href = '/chat.html';
  });
}

// ═══════════════════════════════════════════════════════════════
// POLICY INGESTION
// ═══════════════════════════════════════════════════════════════

let piCollections = [];
let piPhase = 'collections'; // collections | collection-detail | config-modal | generating | review | success
let piSelectedCollectionId = null;
let piSelectedFileIds = [];
let piGenerationResult = null;
let piReviewPolicies = [];
let piReviewNodes = [];
let piGrcFrameworksCache = null;
let piActiveTab = 'files'; // 'files' | 'history'
let piHistoryCache = {}; // collectionId -> history array

// API base for policy collections
const PI_API = '/api/policy-collections';

function piCollectionFileCount(c) {
  if (!c) return 0;
  const n = c.fileCount != null ? Number(c.fileCount) : (Array.isArray(c.files) ? c.files.length : 0);
  return Number.isFinite(n) ? n : 0;
}

/** Gemini page tokens for Previous / Next in collection file grid */
let piFilesPagePrevTokens = [];
let piFilesPageActiveToken = '';
let piFilesDisplayStart = 0;
let piFilesDisplayEnd = 0;
let piFilesPageLoading = false;

async function piRefreshCollectionDetail(collId, filesPageToken, rangeMode = 'reset') {
  const qs = new URLSearchParams();
  if (filesPageToken) qs.set('filesPageToken', filesPageToken);
  const suffix = qs.toString() ? `?${qs}` : '';
  const fresh = await fetchJSON(`${PI_API}/${collId}${suffix}`);
  if (!fresh.success || !fresh.data) throw new Error(fresh.error || 'Failed to load collection');
  const data = fresh.data;
  const idx = piCollections.findIndex(c => c.id === collId);
  if (idx >= 0) piCollections[idx] = data;
  else piCollections.push(data);

  piFilesPageActiveToken = filesPageToken;

  const len = (data.files || []).length;
  if (rangeMode === 'reset') {
    piFilesDisplayStart = len ? 1 : 0;
    piFilesDisplayEnd = len;
  } else if (rangeMode === 'next') {
    piFilesDisplayStart = piFilesDisplayEnd + 1;
    piFilesDisplayEnd = piFilesDisplayStart + len - 1;
  } else if (rangeMode === 'prev') {
    piFilesDisplayEnd = piFilesDisplayStart - 1;
    piFilesDisplayStart = len ? piFilesDisplayEnd - len + 1 : 0;
  }
}
// Fetch GRC frameworks for the config modal (reuses existing cache)
async function piFetchFrameworks() {
  if (piGrcFrameworksCache) return piGrcFrameworksCache;
  try {
    const res = await fetch('/api/grc/frameworks');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    piGrcFrameworksCache = (data.results || []).map(fw => ({
      id: fw.id || fw.urn || '',
      name: fw.name || fw.ref_id || 'Unknown',
      requirementCount: fw.requirement_count || 0,
    }));
    return piGrcFrameworksCache;
  } catch (err) {
    console.warn('Failed to fetch GRC frameworks for PI:', err);
    piGrcFrameworksCache = [];
    return [];
  }
}

// Fetch collections from API
async function piFetchCollections() {
  try {
    const res = await fetch(PI_API);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    piCollections = data.data || [];
    return piCollections;
  } catch (err) {
    console.error('Failed to fetch policy collections:', err);
    piCollections = [];
    return [];
  }
}

async function loadPolicyIngestion(collectionId) {
  piPhase = 'collections';
  piSelectedCollectionId = null;
  piSelectedFileIds = [];
  piGenerationResult = null;
  piReviewPolicies = [];
  piReviewNodes = [];
  piActiveTab = 'files';
  // Show loading state
  const el = document.getElementById('pi-content');
  if (el) el.innerHTML = '<div style="text-align:center;padding:60px;color:#9ca3af"><div class="pi-spinner-icon" style="margin:0 auto 12px"><svg width="24" height="24" class="pi-spinner" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.3"/><path d="M7 2C10 2 12 4.7 12 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>Loading collections…</div>';
  await piFetchCollections();
  await piFetchFrameworks();

  // If a collection ID was provided in the URL, open it directly
  if (collectionId) {
    const coll = piCollections.find(c => c.id === collectionId);
    if (coll) {
      await piOpenCollection(collectionId);
      return; // piOpenCollection calls piRender()
    }
  }

  piRender();
}

function piRender() {
  const el = document.getElementById('pi-content');
  if (!el) return;
  const coll = piCollections.find(c => c.id === piSelectedCollectionId) || null;

  if (piPhase === 'collections') {
    el.innerHTML = piRenderCollectionsList();
  } else if (piPhase === 'collection-detail' || piPhase === 'config-modal') {
    el.innerHTML = coll ? piRenderCollectionDetail(coll) : '';
    if (piPhase === 'config-modal' && coll) {
      el.innerHTML += piRenderConfigModal(coll);
      piLoadFoldersForConfig(); // Load GRC folders into the selector
    }
    if (coll && piActiveTab === 'files') {
      queueMicrotask(() => piAttachPolicyDropzone(coll.id));
    }
  } else if (piPhase === 'generating') {
    el.innerHTML = piRenderProgress();
    piStartProgressAnimation();
  } else if (piPhase === 'review') {
    el.innerHTML = piRenderReview();
  } else if (piPhase === 'success') {
    el.innerHTML = piRenderSuccess();
  } else if (piPhase === 'history-detail') {
    // Rendered directly by piRenderHistoryDetail — do nothing here
  }
}

// ─── Collections List ──────────────────────────────────
function piRenderCollectionsList() {
  const statusCfg = { ready: { label: 'Ready', cls: 'pi-status-ready' }, empty: { label: 'Empty', cls: 'pi-status-empty' }, generating: { label: 'Generating', cls: 'pi-status-generating' }, generated: { label: 'Generated', cls: 'pi-status-generated' }, approved: { label: 'Approved', cls: 'pi-status-generated' } };

  if (piCollections.length === 0) {
    return `
      <div class="pi-header">
        <div class="pi-header-left">
          <div class="pi-header-title"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M5 8H10M5 10.5H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><h1>Organization Policy Ingestion</h1></div>
          <p class="pi-header-subtitle">Upload your organizational policy documents and automatically convert them into a system-compliant policy library</p>
        </div>
        <button class="btn-admin-primary" onclick="piCreateNew()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> New Collection</button>
      </div>
      <div class="pi-empty">
        <div class="pi-empty-icon"><svg width="32" height="32" viewBox="0 0 16 16" fill="none"><path d="M2 5V12C2 12.6 2.4 13 3 13H13C13.6 13 14 12.6 14 12V7C14 6.4 13.6 6 13 6H8L6.5 4H3C2.4 4 2 4.4 2 5Z" stroke="currentColor" stroke-width="1.5"/></svg></div>
        <h3>No collections created yet</h3>
        <p>Create a new collection and upload your policy documents</p>
        <button class="btn-admin-primary" onclick="piCreateNew()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> New Collection</button>
      </div>`;
  }

  const rows = piCollections.map(c => {
    const sc = statusCfg[c.status] || statusCfg.empty;
    const genCount = c.generatedPoliciesCount != null ? ` (${c.generatedPoliciesCount} policies)` : '';
    return `<tr>
      <td><div class="pi-coll-name"><div class="pi-coll-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M5 8H10M5 10.5H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></div><div class="pi-coll-info"><div class="pi-coll-title">${esc(c.name)}</div>${c.description ? `<div class="pi-coll-desc">${esc(c.description)}</div>` : ''}</div></div></td>
      <td class="center"><span class="pi-files-count">${piCollectionFileCount(c)} ${piCollectionFileCount(c) === 1 ? 'file' : 'files'}</span></td>
      <td class="center"><span class="pi-status ${sc.cls}">${c.status === 'generated' ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ' : ''}${sc.label}${genCount}</span></td>
      <td class="center"><span class="pi-date">${esc(c.lastUpdated)}</span></td>
      <td class="right"><div class="pi-actions">
        <button class="pi-btn pi-btn-view" onclick="piOpenCollection('${c.id}')"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M1 6C1 6 3 2 6 2C9 2 11 6 11 6C11 6 9 10 6 10C3 10 1 6 1 6Z" stroke="currentColor" stroke-width="1.2"/></svg> View</button>
        ${c.status === 'ready' ? `<button class="pi-btn pi-btn-generate" onclick="piStartGeneration('${c.id}')"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1L7.5 4L11 4.5L8.5 7L9 10.5L6 9L3 10.5L3.5 7L1 4.5L4.5 4L6 1Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg> Generate Policies</button>` : ''}
        ${c.status === 'generated' ? `<button class="pi-btn pi-btn-library"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/></svg> View Library</button>` : ''}
        <button class="pi-btn pi-btn-delete" onclick="event.stopPropagation();piDeleteCollection('${c.id}')" title="Delete collection"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4H13M5.5 4V3C5.5 2.4 5.9 2 6.5 2H9.5C10.1 2 10.5 2.4 10.5 3V4M6.5 7V11.5M9.5 7V11.5M4 4L4.5 13C4.5 13.6 4.9 14 5.5 14H10.5C11.1 14 11.5 13.6 11.5 13L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div></td>
    </tr>`;
  }).join('');

  return `
    <div class="pi-header">
      <div class="pi-header-left">
        <div class="pi-header-title"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M5 8H10M5 10.5H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><h1>Organization Policy Ingestion</h1></div>
        <p class="pi-header-subtitle">Upload your organizational policy documents and automatically convert them into a system-compliant policy library</p>
      </div>
      <button class="btn-admin-primary" onclick="piCreateNew()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> New Collection</button>
    </div>
    <div class="pi-table-card"><table class="pi-table"><thead><tr>
      <th>Collection Name</th><th class="center">Files</th><th class="center">Status</th><th class="center">Last Updated</th><th class="right">Actions</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function piCreateNew() {
  try {
    toast('info', 'Creating…', 'Creating new collection…');
    const res = await fetch(PI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Collection', description: '' }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to create collection');
    piCollections.push(data.data);
    piFilesPagePrevTokens = [];
    piFilesPageActiveToken = '';
    const d = data.data;
    piFilesDisplayStart = (d.files || []).length ? 1 : 0;
    piFilesDisplayEnd = (d.files || []).length;
    piSelectedCollectionId = data.data.id;
    piSelectedFileIds = [];
    piPhase = 'collection-detail';
    piRender();
    toast('success', 'Created', 'Collection created successfully.');
  } catch (err) {
    toast('error', 'Error', err.message);
  }
}
window.piCreateNew = piCreateNew;

async function piOpenCollection(id) {
  piSelectedCollectionId = id;
  piSelectedFileIds = [];
  piActiveTab = 'files';
  piPhase = 'collection-detail';

  // Update URL to include collection ID
  updateRoute('policy-ingestion', id);

  piFilesPagePrevTokens = [];
  piFilesPageActiveToken = '';
  try {
    await piRefreshCollectionDetail(id, '', 'reset');
  } catch (err) {
    console.warn('piOpenCollection refresh:', err);
    toast('error', 'Load failed', err.message || 'Could not load files for this collection');
    const coll = piCollections.find(c => c.id === id);
    if (coll && !coll.files) coll.files = [];
  }
  piRender();
}
window.piOpenCollection = piOpenCollection;

async function piStartGeneration(id) {
  piSelectedCollectionId = id;
  piSelectedFileIds = [];
  piPhase = 'config-modal';
  piFilesPagePrevTokens = [];
  try {
    await piRefreshCollectionDetail(id, '', 'reset');
  } catch (err) {
    console.warn('piStartGeneration:', err);
    toast('error', 'Load failed', err.message || 'Could not load collection for generation');
    piPhase = 'collections';
  }
  piRender();
}
window.piStartGeneration = piStartGeneration;

function piBackToCollections() {
  piPhase = 'collections';
  piSelectedCollectionId = null;
  piSelectedFileIds = [];
  piActiveTab = 'files';
  // Remove collection ID from URL
  updateRoute('policy-ingestion', null);
  piRender();
}
window.piBackToCollections = piBackToCollections;

async function piDeleteCollection(id) {
  const coll = piCollections.find(c => c.id === id);
  const name = coll ? coll.name : 'this collection';
  if (!await showConfirm({ title: 'Delete Collection', message: `Delete "${name}"? This will permanently remove the collection, all its files, and generation history. This action cannot be undone.`, confirmText: 'Delete' })) return;
  try {
    const res = await fetch(`${PI_API}/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      toast('success', 'Deleted', `Collection "${name}" has been deleted`);
      piCollections = piCollections.filter(c => c.id !== id);
      delete piHistoryCache[id];
      delete piHistoryDetailCache[id];
      if (piSelectedCollectionId === id) {
        piSelectedCollectionId = null;
        piPhase = 'collections';
      }
      piRender();
    } else {
      toast('error', 'Error', data.error || 'Failed to delete collection');
    }
  } catch (e) {
    console.error('Delete collection error:', e);
    toast('error', 'Error', 'Failed to delete collection');
  }
}
window.piDeleteCollection = piDeleteCollection;

// ─── Collection Detail ─────────────────────────────────
function piRenderCollectionDetail(coll) {
  const fileTypeIcons = { pdf: 'pi-file-icon-pdf', docx: 'pi-file-icon-docx', pptx: 'pi-file-icon-pptx', txt: 'pi-file-icon-txt', png: 'pi-file-icon-png', jpg: 'pi-file-icon-jpg' };
  const totalFiles = piCollectionFileCount(coll);
  const pageFiles = coll.files || [];
  const pageIds = pageFiles.map(f => f.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => piSelectedFileIds.includes(id));
  const hasSelectedFiles = piSelectedFileIds.length > 0;
  const genLabel = hasSelectedFiles ? `Generate (${piSelectedFileIds.length} selected)` : 'Generate (all files)';
  const genDisabled = totalFiles === 0;

  // ── Files Tab Content ──
  let filesHtml = '';
  if (pageFiles.length > 0) {
    const selectAll = `<div class="pi-select-all">
      <label><input type="checkbox" ${allPageSelected ? 'checked' : ''} onchange="piToggleAllFiles()"><span>Select all on this page</span></label>
      ${piSelectedFileIds.length > 0 ? `<span class="pi-selected-count">(${piSelectedFileIds.length} selected)</span>` : ''}
    </div>`;

    const cards = pageFiles.map(f => {
      const sel = piSelectedFileIds.includes(f.id);
      const isActive = f.state === 'STATE_ACTIVE';
      const stateLabel = isActive ? '☁ Active' : (f.state === 'STATE_PENDING' ? '⏳ Processing...' : '⏳ ' + (f.state || ''));
      const stateClass = isActive ? 'pi-gemini-synced' : 'pi-gemini-pending';
      return `<div class="pi-file-card${sel ? ' selected' : ''}">
        <input type="checkbox" ${sel ? 'checked' : ''} onchange="piToggleFile('${f.id}')">
        <div class="pi-file-icon ${fileTypeIcons[f.type] || 'pi-file-icon-txt'}"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/></svg></div>
        <div class="pi-file-info"><div class="pi-file-name">${esc(f.name)}</div><div class="pi-file-meta">${esc(f.size)} · <span class="${stateClass}">${stateLabel}</span></div></div>
        <div class="pi-file-actions">
          ${isActive ? `<button class="pi-file-action-btn view" title="Open file" onclick="event.stopPropagation();piOpenFile('${f.id}','${esc(f.name)}','${esc(f.type || '')}')"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7s2.2-4.5 6-4.5S13 7 13 7s-2.2 4.5-6 4.5S1 7 1 7z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/></svg></button>` : ''}
          <button class="pi-file-action-btn delete" title="Delete" onclick="piDeleteFile('${f.id}')"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4H12M4 4V3C4 2.4 4.4 2 5 2H9C9.6 2 10 2.4 10 3V4M5 6.5V10.5M7 6.5V10.5M9 6.5V10.5M3 4L4 12H10L11 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
        ${sel ? '<div class="pi-file-selected-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' : ''}
      </div>`;
    }).join('');

    const prevDis = piFilesPagePrevTokens.length === 0 || piFilesPageLoading ? 'disabled' : '';
    const nextDis = !(coll.filesNextPageToken) || piFilesPageLoading ? 'disabled' : '';
    let filesFooter = '';
    if (totalFiles > 0 && piFilesDisplayEnd >= piFilesDisplayStart && piFilesDisplayStart > 0) {
      const pageSize = coll.filesPageSize || 20;
      const onSinglePage = !coll.filesNextPageToken && piFilesPagePrevTokens.length === 0;
      const rangeHint = onSinglePage ? ` · ${pageSize} per page` : '';
      filesFooter = `<div class="pi-files-footer">
        <span class="pi-files-page-range">${esc(`Showing ${piFilesDisplayStart}–${piFilesDisplayEnd} of ${totalFiles}${rangeHint}`)}</span>
        <div class="pi-files-pagination-btns">
          <button type="button" class="pi-btn pi-btn-view pi-files-page-btn" ${prevDis} onclick="piFilesPagePrev()" title="Previous page">Previous</button>
          <button type="button" class="pi-btn pi-btn-view pi-files-page-btn" ${nextDis} onclick="piFilesPageNext()" title="${coll.filesNextPageToken ? 'Next page' : 'No further pages'}">Next</button>
        </div>
      </div>`;
    }

    filesHtml = selectAll + `<div class="pi-files-grid">${cards}</div>` + filesFooter;
  } else if (totalFiles > 0) {
    filesHtml = `<div class="pi-files-empty"><div class="pi-files-empty-icon"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M14 10V13C14 13.6 13.6 14 13 14H3C2.4 14 2 13.6 2 13V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11 5L8 2L5 5M8 2V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><p>No files on this page</p></div>`;
  } else {
    filesHtml = `<div class="pi-files-empty"><div class="pi-files-empty-icon"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M14 10V13C14 13.6 13.6 14 13 14H3C2.4 14 2 13.6 2 13V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11 5L8 2L5 5M8 2V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><p>No files in this collection</p></div>`;
  }

  const filesTabContent = `
    ${filesHtml}
    <div class="pi-dropzone" id="pi-dropzone-root" onclick="piTriggerUpload()">
      <svg width="24" height="24" viewBox="0 0 16 16" fill="none"><path d="M14 10V13C14 13.6 13.6 14 13 14H3C2.4 14 2 13.6 2 13V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11 5L8 2L5 5M8 2V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <p>Drag files or folders here, or browse below</p>
      <div class="pi-dropzone-links" onclick="event.stopPropagation()">
        <button type="button" class="pi-dropzone-btn" onclick="piTriggerUpload()">Browse files</button>
        <span class="pi-dropzone-links-sep">·</span>
        <button type="button" class="pi-dropzone-btn" onclick="piTriggerFolderUpload()">Browse folder</button>
      </div>
      <p class="pi-dropzone-hint">PDF, DOCX, PPTX, TXT, PNG, JPG — subfolders included for folder uploads. Max 50 MB per file.</p>
    </div>`;

  // ── History Tab Content ──
  const history = piHistoryCache[coll.id] || [];
  const historyLoading = !piHistoryCache.hasOwnProperty(coll.id);
  let historyTabContent = '';
  if (historyLoading) {
    historyTabContent = `<div style="text-align:center;padding:32px 0;color:#9ca3af"><svg class="pi-spin" width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#e5e7eb" stroke-width="2"/><path d="M10 2A8 8 0 0 1 18 10" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/></svg><p style="margin-top:8px;font-size:12px">Loading history…</p></div>`;
  } else if (history.length === 0) {
    historyTabContent = `<div style="text-align:center;padding:40px 0;color:#9ca3af">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="margin:0 auto 12px"><circle cx="12" cy="12" r="10" stroke="#d1d5db" stroke-width="1.5"/><path d="M12 6V12L16 14" stroke="#d1d5db" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <p style="font-size:13px;font-weight:500;color:#6b7280">No generation history yet</p>
      <p style="font-size:11px;margin-top:4px">Run a policy generation to see results here</p>
    </div>`;
  } else {
    const rows = history.map(h => {
      const date = new Date(h.createdAt);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const genTypeLabels = { framework: 'Framework', controls: 'Controls', both: 'Both' };
      const genTypeLabel = genTypeLabels[h.generationType] || h.generationType;
      const genTypeClass = h.generationType === 'framework' ? 'pi-hist-type-framework' :
                           h.generationType === 'controls' ? 'pi-hist-type-controls' : 'pi-hist-type-both';

      const statusLabels = {
        generated: { label: 'Generated', cls: 'pi-hist-status-generated' },
        approved: { label: 'Approved', cls: 'pi-hist-status-approved' },
        approved_with_errors: { label: 'Approved (errors)', cls: 'pi-hist-status-warning' },
        failed: { label: 'Failed', cls: 'pi-hist-status-failed' },
      };
      const st = statusLabels[h.status] || { label: h.status, cls: '' };

      const confClass = h.confidenceScore >= 80 ? 'pi-confidence-high' : h.confidenceScore >= 60 ? 'pi-confidence-mid' : 'pi-confidence-low';

      let itemsLabel = '';
      if (h.generationType === 'framework') {
        itemsLabel = `${h.nodesCount} nodes`;
      } else if (h.generationType === 'controls') {
        itemsLabel = `${h.controlsCount} controls`;
      } else {
        itemsLabel = `${h.nodesCount} nodes · ${h.controlsCount} controls`;
      }

      const canView = h.hasData && h.status !== 'failed';
      const viewBtn = canView
        ? `<button class="pi-hist-view-btn" onclick="event.stopPropagation();piViewHistoryEntry('${esc(h.id)}')" title="View generated data"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3"/></svg></button>`
        : '';

      return `<div class="pi-hist-row ${canView ? 'pi-hist-row-clickable' : ''}" ${canView ? `onclick="piViewHistoryEntry('${esc(h.id)}')"` : ''}>
        <div class="pi-hist-cell pi-hist-date">
          <div class="pi-hist-date-main">${dateStr}</div>
          <div class="pi-hist-date-time">${timeStr}</div>
        </div>
        <div class="pi-hist-cell"><span class="pi-hist-type-badge ${genTypeClass}">${genTypeLabel}</span></div>
        <div class="pi-hist-cell"><span class="pi-hist-status-badge ${st.cls}">${st.label}</span></div>
        <div class="pi-hist-cell pi-hist-items">${itemsLabel}</div>
        <div class="pi-hist-cell"><span class="pi-confidence-badge ${confClass}" style="font-size:10px;padding:2px 8px">${h.confidenceScore}%</span></div>
        <div class="pi-hist-cell pi-hist-time-cell">${esc(h.generationTime || '-')}</div>
        <div class="pi-hist-cell pi-hist-files-cell">${h.sourceFileCount} file${h.sourceFileCount !== 1 ? 's' : ''}</div>
        <div class="pi-hist-cell pi-hist-urn">${h.libraryUrn ? `<span class="pi-hist-urn-text" title="${esc(h.libraryUrn)}">${esc(h.libraryUrn)}</span>` : '<span style="color:#d1d5db">—</span>'}</div>
        <div class="pi-hist-cell">${viewBtn}</div>
        ${h.errorMessage ? `<div class="pi-hist-cell pi-hist-error" title="${esc(h.errorMessage)}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#ef4444" stroke-width="1.3"/><path d="M8 5V9M8 11V11.5" stroke="#ef4444" stroke-width="1.3" stroke-linecap="round"/></svg></div>` : ''}
      </div>`;
    }).join('');

    historyTabContent = `
      <div class="pi-hist-header-row">
        <div class="pi-hist-hcell">Date</div>
        <div class="pi-hist-hcell">Type</div>
        <div class="pi-hist-hcell">Status</div>
        <div class="pi-hist-hcell">Items</div>
        <div class="pi-hist-hcell">Confidence</div>
        <div class="pi-hist-hcell">Duration</div>
        <div class="pi-hist-hcell">Files</div>
        <div class="pi-hist-hcell">Library URN</div>
        <div class="pi-hist-hcell"></div>
      </div>
      <div class="pi-hist-body">${rows}</div>`;
  }

  const historyCount = history.length;

  return `
    <div class="pi-detail-header">
      <button class="pi-back-btn" onclick="piBackToCollections()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div style="flex:1">
        <div class="pi-detail-breadcrumb">Admin &gt; Organization Policy Ingestion</div>
        <div class="pi-detail-title" onclick="piStartEditName()" id="pi-name-display">${esc(coll.name)} <svg class="pi-edit-icon" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></div>
        <input type="text" class="pi-detail-title-input" id="pi-name-input" value="${esc(coll.name)}" style="display:none" onblur="piCommitName()" onkeydown="piNameKeydown(event)">
      </div>
      <button class="pi-delete-collection-btn" onclick="piDeleteCollection('${coll.id}')" title="Delete collection"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4H13M5.5 4V3C5.5 2.4 5.9 2 6.5 2H9.5C10.1 2 10.5 2.4 10.5 3V4M6.5 7V11.5M9.5 7V11.5M4 4L4.5 13C4.5 13.6 4.9 14 5.5 14H10.5C11.1 14 11.5 13.6 11.5 13L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
    <div class="pi-detail-card">
      <div class="pi-detail-card-header">
        <div>
          <div class="pi-detail-desc" onclick="piStartEditDesc()" id="pi-desc-display">${coll.description || 'Add a description...'} <svg class="pi-edit-icon" width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></div>
          <input type="text" class="pi-detail-desc-input" id="pi-desc-input" value="${esc(coll.description)}" style="display:none" placeholder="Add a description..." onblur="piCommitDesc()" onkeydown="piDescKeydown(event)">
          <div class="pi-detail-file-count">${totalFiles} ${totalFiles === 1 ? 'file' : 'files'}</div>
        </div>
        <div class="pi-detail-actions pi-detail-upload-actions">
          <button type="button" class="pi-btn pi-btn-view" onclick="piTriggerUpload()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 8V11C12 11.6 11.6 12 11 12H3C2.4 12 2 11.6 2 11V8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M9.5 4L7 1.5L4.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 1.5V8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Upload Files</button>
          <button type="button" class="pi-btn pi-btn-view" onclick="piTriggerFolderUpload()" title="Upload all supported files from a folder (including subfolders)"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4.5h3l1.2-1.5h5.8a1 1 0 011 1V11a1 1 0 01-1 1H2a1 1 0 01-1-1V5.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 6.5h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".35"/></svg> Upload folder</button>
          <button class="btn-admin-primary" onclick="piGenerateFromDetail()" ${genDisabled ? 'disabled' : ''} title="${genDisabled ? 'Upload files first' : (!hasSelectedFiles ? 'All files in this collection will be used' : '')}"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1L8.5 4L12 4.5L9.5 7L10 10.5L7 9L4 10.5L4.5 7L2 4.5L5.5 4L7 1Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg> ${genLabel}</button>
        </div>
      </div>
      <div id="pi-upload-progress-container"></div>
    <input type="file" id="pi-file-input" style="display:none" multiple accept=".pdf,.docx,.pptx,.txt,.png,.jpg,.jpeg" onchange="piHandleFileUpload(event)">
    <input type="file" id="pi-folder-input" style="display:none" webkitdirectory directory multiple onchange="piHandleFolderUpload(event)">
      <div class="pi-tabs">
        <button class="pi-tab${piActiveTab === 'files' ? ' active' : ''}" onclick="piSwitchTab('files')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.3"/></svg>
          Files <span class="pi-tab-count">${totalFiles}</span>
        </button>
        <button class="pi-tab${piActiveTab === 'history' ? ' active' : ''}" onclick="piSwitchTab('history')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 1H10L13 4V14C13 14.6 12.6 15 12 15H3C2.4 15 2 14.6 2 14V2C2 1.4 2.4 1 3 1Z" stroke="currentColor" stroke-width="1.3"/><path d="M5 8H11M5 10.5H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          Extracted Policies ${historyCount > 0 ? `<span class="pi-tab-count">${historyCount}</span>` : ''}
        </button>
      </div>
      <div class="pi-tab-content">
        ${piActiveTab === 'files' ? filesTabContent : historyTabContent}
      </div>
    </div>`;
}

function piStartEditName() {
  document.getElementById('pi-name-display').style.display = 'none';
  const inp = document.getElementById('pi-name-input');
  inp.style.display = '';
  inp.focus();
  inp.select();
}
window.piStartEditName = piStartEditName;

async function piCommitName() {
  const inp = document.getElementById('pi-name-input');
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (coll && inp.value.trim()) {
    coll.name = inp.value.trim();
    try {
      await fetch(`${PI_API}/${coll.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: coll.name }),
      });
    } catch (e) { console.warn('Save name error:', e); }
  }
  piRender();
}
window.piCommitName = piCommitName;

function piNameKeydown(e) { if (e.key === 'Enter') piCommitName(); if (e.key === 'Escape') piRender(); }
window.piNameKeydown = piNameKeydown;

function piStartEditDesc() {
  document.getElementById('pi-desc-display').style.display = 'none';
  const inp = document.getElementById('pi-desc-input');
  inp.style.display = '';
  inp.focus();
  inp.select();
}
window.piStartEditDesc = piStartEditDesc;

async function piCommitDesc() {
  const inp = document.getElementById('pi-desc-input');
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (coll) {
    coll.description = inp.value.trim();
    try {
      await fetch(`${PI_API}/${coll.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: coll.description }),
      });
    } catch (e) { console.warn('Save desc error:', e); }
  }
  piRender();
}
window.piCommitDesc = piCommitDesc;

function piDescKeydown(e) { if (e.key === 'Enter') piCommitDesc(); if (e.key === 'Escape') piRender(); }
window.piDescKeydown = piDescKeydown;

function piSwitchTab(tab) {
  piActiveTab = tab;
  if (tab === 'history' && piSelectedCollectionId && !piHistoryCache.hasOwnProperty(piSelectedCollectionId)) {
    piLoadHistory(piSelectedCollectionId);
  }
  piRender();
}
window.piSwitchTab = piSwitchTab;

async function piLoadHistory(collId) {
  try {
    const res = await fetch(`${PI_API}/${collId}/history`);
    const data = await res.json();
    if (data.success) {
      piHistoryCache[collId] = data.data || [];
    } else {
      piHistoryCache[collId] = [];
    }
  } catch (e) {
    console.warn('Failed to load history:', e);
    piHistoryCache[collId] = [];
  }
  piRender();
}

// ── History Detail Viewer ──
let piHistoryDetailCache = {};
/** Set while history detail DOM is rendered; used by edit/save/delete actions */
let piHistoryDetailOpenId = null;

/** URN closure: seed urn + descendants linked by parent_urn (for cascading delete). */
function piFrameworkDescendantUrns(seedUrn, nodes) {
  const out = new Set();
  if (seedUrn) out.add(seedUrn);
  let changed = true;
  while (changed) {
    changed = false;
    for (const x of nodes) {
      const u = x && x.urn;
      if (!u || out.has(u)) continue;
      if (x.parent_urn && out.has(x.parent_urn)) {
        out.add(u);
        changed = true;
      }
    }
  }
  return out;
}

function piFrameworkReviewIdsToRemove(node, nodes) {
  const rm = new Set([node.id]);
  if (!node.urn) return rm;
  const urns = piFrameworkDescendantUrns(node.urn, nodes);
  for (const x of nodes) {
    if (x.urn && urns.has(x.urn)) rm.add(x.id);
  }
  return rm;
}

function piSyncFrameworkResultFromReview() {
  if (!piGenerationResult) return;
  const genType = piGenerationResult.generationType || 'both';
  if (genType !== 'framework' && genType !== 'both') return;
  piGenerationResult.requirementNodes = piReviewNodes.slice();
  piGenerationResult.totalNodes = piReviewNodes.length;
  piGenerationResult.assessableNodes = piReviewNodes.filter(n => n.assessable).length;
}

async function piViewHistoryEntry(historyId) {
  if (!piSelectedCollectionId) return;

  // If we already have it cached, render immediately
  if (piHistoryDetailCache[historyId]) {
    piRenderHistoryDetail(piHistoryDetailCache[historyId]);
    return;
  }

  // Show loading state
  piPhase = 'history-detail';
  const contentEl = document.getElementById('pi-content');
  if (contentEl) contentEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:400px;flex-direction:column;gap:12px">
    <svg class="pi-spin" width="28" height="28" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#e5e7eb" stroke-width="2"/><path d="M10 2A8 8 0 0 1 18 10" stroke="#0077cc" stroke-width="2" stroke-linecap="round"/></svg>
    <p style="color:#6b7280;font-size:13px">Loading generation data…</p>
  </div>`;

  try {
    const res = await fetch(`${PI_API}/${piSelectedCollectionId}/history/${historyId}`);
    const data = await res.json();
    if (data.success && data.data) {
      piHistoryDetailCache[historyId] = data.data;
      piRenderHistoryDetail(data.data);
    } else {
      toast('error', 'Error', data.error || 'Failed to load history detail');
      piPhase = 'collection-detail';
      piRender();
    }
  } catch (e) {
    console.error('Failed to load history detail:', e);
    toast('error', 'Error', 'Failed to load history entry');
    piPhase = 'collection-detail';
    piRender();
  }
}
window.piViewHistoryEntry = piViewHistoryEntry;

function piRenderHistoryDetail(entry) {
  const pageEl = document.getElementById('pi-content');
  if (!pageEl) return;
  piPhase = 'history-detail';
  piHistoryDetailOpenId = entry.id;

  const date = new Date(entry.createdAt);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const genTypeLabels = { framework: 'Framework', controls: 'Controls', both: 'Both' };
  const genTypeLabel = genTypeLabels[entry.generationType] || entry.generationType;
  const genTypeClass = entry.generationType === 'framework' ? 'pi-hist-type-framework' :
                       entry.generationType === 'controls' ? 'pi-hist-type-controls' : 'pi-hist-type-both';
  const statusLabels = {
    generated: { label: 'Generated', cls: 'pi-hist-status-generated' },
    approved: { label: 'Approved', cls: 'pi-hist-status-approved' },
    approved_with_errors: { label: 'Approved (errors)', cls: 'pi-hist-status-warning' },
    failed: { label: 'Failed', cls: 'pi-hist-status-failed' },
  };
  const st = statusLabels[entry.status] || { label: entry.status, cls: '' };

  const exData = entry.extractionData || {};
  const policies = exData.policies || [];
  const reqNodes = exData.requirementNodes || [];
  const csfDist = exData.csfDistribution || entry.summary?.csfDistribution || {};
  const catDist = exData.categoryDistribution || entry.summary?.categoryDistribution || {};

  // Build framework nodes section
  let nodesSection = '';
  if (reqNodes.length > 0) {
    const nodesHtml = reqNodes.map((n, i) => {
      const indent = Math.min((n.depth || 1) - 1, 4) * 20;
      return `<div class="pi-hist-detail-node" style="padding-left:${indent}px">
        <div class="pi-hist-detail-node-header">
          <span class="pi-hist-detail-node-ref">${esc(n.ref_id || n.urn || `N-${i+1}`)}</span>
          <span class="pi-hist-detail-node-name">${esc(n.name)}</span>
          ${n.assessable ? '<span class="pi-hist-detail-badge pi-hist-detail-badge-assess">Assessable</span>' : ''}
          <div class="pi-hist-detail-node-actions">
            <button type="button" class="pi-policy-edit-btn" onclick="event.stopPropagation();piHistEditFrameworkNodeIdx(${i})" title="Edit"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
            <button type="button" class="pi-policy-delete-btn" onclick="event.stopPropagation();piHistDeleteFrameworkNodeIdx(${i})" title="Delete"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4H12M4 4V3C4 2.4 4.4 2 5 2H9C9.6 2 10 2.4 10 3V4M5 6.5V10.5M7 6.5V10.5M9 6.5V10.5M3 4L4 12H10L11 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
        </div>
        <div class="pi-hist-detail-node-body" id="pi-hist-rn-body-${i}">${n.description ? `<div class="pi-hist-detail-node-desc">${esc(n.description)}</div>` : ''}</div>
      </div>`;
    }).join('');
    nodesSection = `
      <div class="pi-hist-detail-section">
        <div class="pi-hist-detail-section-header">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L12 5V11L8 14L4 11V5L8 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Framework Nodes <span class="pi-tab-count">${reqNodes.length}</span>
          <span style="color:#9ca3af;font-weight:400;margin-left:6px">(${(exData.assessableNodes || reqNodes.filter(n=>n.assessable).length)} assessable)</span>
        </div>
        <div class="pi-hist-detail-nodes-list">${nodesHtml}</div>
      </div>`;
  }

  // Build controls/policies section
  let controlsSection = '';
  if (policies.length > 0) {
    const controlsHtml = policies.map((p, i) => {
      const csfColors = { govern:'#6366f1', protect:'#0ea5e9', detect:'#f59e0b', respond:'#ef4444', recover:'#10b981', identify:'#8b5cf6' };
      const csfColor = csfColors[p.csfFunction] || '#6b7280';
      return `<div class="pi-hist-detail-control">
        <div class="pi-hist-detail-control-header">
          <span class="pi-hist-detail-control-code">${esc(p.code || `RC-${i+1}`)}</span>
          <span class="pi-hist-detail-control-name">${esc(p.name)}</span>
          <span class="pi-hist-detail-badge" style="background:${csfColor}15;color:${csfColor};border:1px solid ${csfColor}30">${esc((p.csfFunction||'').charAt(0).toUpperCase()+(p.csfFunction||'').slice(1))}</span>
          <span class="pi-hist-detail-badge" style="background:#f3f4f6;color:#374151">${esc((p.category||'').charAt(0).toUpperCase()+(p.category||'').slice(1))}</span>
          <div class="pi-hist-detail-node-actions">
            <button type="button" class="pi-policy-edit-btn" onclick="event.stopPropagation();piHistEditControlIdx(${i})" title="Edit"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
            <button type="button" class="pi-policy-delete-btn" onclick="event.stopPropagation();piHistDeleteControlIdx(${i})" title="Delete"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4H12M4 4V3C4 2.4 4.4 2 5 2H9C9.6 2 10 2.4 10 3V4M5 6.5V10.5M7 6.5V10.5M9 6.5V10.5M3 4L4 12H10L11 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
        </div>
        <div id="pi-hist-rc-body-${i}">${p.description ? `<div class="pi-hist-detail-control-desc">${esc(p.description)}</div>` : ''}</div>
      </div>`;
    }).join('');
    controlsSection = `
      <div class="pi-hist-detail-section">
        <div class="pi-hist-detail-section-header">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M5 8L7 10L11 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Reference Controls <span class="pi-tab-count">${policies.length}</span>
        </div>
        <div class="pi-hist-detail-controls-list">${controlsHtml}</div>
      </div>`;
  }

  // Distribution charts
  let distSection = '';
  const csfEntries = Object.entries(csfDist).filter(([,v]) => v > 0);
  const catEntries = Object.entries(catDist).filter(([,v]) => v > 0);
  if (csfEntries.length > 0 || catEntries.length > 0) {
    const csfColors = { govern:'#6366f1', protect:'#0ea5e9', detect:'#f59e0b', respond:'#ef4444', recover:'#10b981', identify:'#8b5cf6' };
    const csfBars = csfEntries.map(([fn, cnt]) => {
      const total = csfEntries.reduce((s,[,v])=>s+v,0);
      const pct = total > 0 ? Math.round(cnt/total*100) : 0;
      const color = csfColors[fn] || '#6b7280';
      return `<div class="pi-hist-dist-item"><div class="pi-hist-dist-label">${fn.charAt(0).toUpperCase()+fn.slice(1)}</div><div class="pi-hist-dist-bar"><div class="pi-hist-dist-fill" style="width:${pct}%;background:${color}"></div></div><div class="pi-hist-dist-val">${cnt}</div></div>`;
    }).join('');
    const catBars = catEntries.map(([cat, cnt]) => {
      const total = catEntries.reduce((s,[,v])=>s+v,0);
      const pct = total > 0 ? Math.round(cnt/total*100) : 0;
      return `<div class="pi-hist-dist-item"><div class="pi-hist-dist-label">${cat.charAt(0).toUpperCase()+cat.slice(1)}</div><div class="pi-hist-dist-bar"><div class="pi-hist-dist-fill" style="width:${pct}%;background:#0077cc"></div></div><div class="pi-hist-dist-val">${cnt}</div></div>`;
    }).join('');
    distSection = `<div class="pi-hist-detail-section">
      <div class="pi-hist-detail-section-header">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="9" width="3" height="5" rx="0.5" stroke="currentColor" stroke-width="1.2"/><rect x="6.5" y="5" width="3" height="9" rx="0.5" stroke="currentColor" stroke-width="1.2"/><rect x="11" y="2" width="3" height="12" rx="0.5" stroke="currentColor" stroke-width="1.2"/></svg>
        Distribution
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        ${csfBars ? `<div><div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:8px">CSF Functions</div>${csfBars}</div>` : ''}
        ${catBars ? `<div><div style="font-size:11px;font-weight:600;color:#374151;margin-bottom:8px">Categories</div>${catBars}</div>` : ''}
      </div>
    </div>`;
  }

  // Config summary
  const cfg = entry.config || {};
  const cfgItems = [];
  if (cfg.libraryName) cfgItems.push(['Library', cfg.libraryName]);
  if (cfg.language) cfgItems.push(['Language', cfg.language]);
  if (cfg.detailLevel) cfgItems.push(['Detail Level', cfg.detailLevel]);
  if (cfg.provider) cfgItems.push(['Provider', cfg.provider]);
  const cfgHtml = cfgItems.map(([k,v]) => `<div class="pi-hist-cfg-item"><span class="pi-hist-cfg-key">${esc(k)}</span><span class="pi-hist-cfg-val">${esc(v)}</span></div>`).join('');

  const yamlPreviewSvg = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2.5 12.5v-9h8l2.5 2.5v6.5h-8" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M4.5 4.5v-2h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4.5 8.5h7M4.5 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  const canHistPreviewYaml = !!(exData && (exData.extractedLibrary || policies.length || reqNodes.length));

  // No data message
  let noDataMsg = '';
  if (policies.length === 0 && reqNodes.length === 0) {
    noDataMsg = `<div style="text-align:center;padding:40px 0;color:#9ca3af">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="margin:0 auto 12px"><path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="#d1d5db" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 17L12 22L22 17" stroke="#d1d5db" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 12L12 17L22 12" stroke="#d1d5db" stroke-width="1.5" stroke-linejoin="round"/></svg>
      <p style="font-size:13px;font-weight:500;color:#6b7280">No extraction data available for this entry</p>
      <p style="font-size:11px;margin-top:4px">This generation was recorded before data storage was enabled</p>
    </div>`;
  }

  pageEl.innerHTML = `
    <div class="pi-detail-header">
      <button class="pi-back-btn" onclick="piBackFromHistoryDetail()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div style="flex:1">
        <div class="pi-detail-breadcrumb">Extracted Policies &gt; Generation Detail</div>
        <div class="pi-detail-title" style="font-size:18px">${dateStr} at ${timeStr}</div>
      </div>
    </div>
    <div class="pi-detail-card">
      <div style="padding:16px 20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;border-bottom:1px solid #f3f4f6">
        <span class="pi-hist-type-badge ${genTypeClass}" style="font-size:12px;padding:4px 12px">${genTypeLabel}</span>
        <span class="pi-hist-status-badge ${st.cls}" style="font-size:12px;padding:4px 12px">${st.label}</span>
        <div style="margin-left:auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center">
          ${canHistPreviewYaml ? `<button type="button" class="pi-btn pi-btn-preview-yaml pi-hist-preview-yaml" onclick="piHistPreviewYaml()">${yamlPreviewSvg} Preview YAML</button>` : ''}
          <div style="display:flex;gap:20px;font-size:12px;color:#6b7280">
          <span>⏱ ${esc(entry.generationTime || '-')}</span>
          <span>📄 ${entry.sourceFileCount} file${entry.sourceFileCount !== 1 ? 's' : ''}</span>
          ${entry.nodesCount > 0 ? `<span>🔷 ${entry.nodesCount} nodes</span>` : ''}
          ${entry.controlsCount > 0 ? `<span>✅ ${entry.controlsCount} controls</span>` : ''}
          </div>
        </div>
      </div>
      ${cfgHtml ? `<div style="padding:12px 20px;border-bottom:1px solid #f3f4f6;display:flex;flex-wrap:wrap;gap:8px">${cfgHtml}</div>` : ''}
      <div style="padding:20px">
        ${noDataMsg || ''}
        ${nodesSection}
        ${controlsSection}
        ${distSection}
      </div>
    </div>
    ${entry.libraryUrn ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border-radius:8px;font-size:12px;color:#6b7280">Library URN: <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;font-size:11px">${esc(entry.libraryUrn)}</code></div>` : ''}
    ${entry.errorMessage ? `<div style="margin-top:12px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:12px;color:#b91c1c"><strong>Error:</strong> ${esc(entry.errorMessage)}</div>` : ''}
  `;
}

async function piHistPersistEntry(entry) {
  const collId = entry.collectionId || piSelectedCollectionId;
  if (!collId) {
    toast('error', 'Error', 'Missing collection');
    return null;
  }
  const ex = entry.extractionData || {};
  try {
    const res = await fetch(`${PI_API}/${collId}/history/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extractionData: ex }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Save failed');
    piHistoryDetailCache[entry.id] = data.data;
    delete piHistoryCache[collId];
    return data.data;
  } catch (e) {
    toast('error', 'Save failed', e.message);
    return null;
  }
}

function piHistCurrentEntry() {
  if (!piHistoryDetailOpenId) return null;
  return piHistoryDetailCache[piHistoryDetailOpenId];
}

async function piHistEditFrameworkNodeIdx(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const nodes = entry.extractionData.requirementNodes || [];
  const n = nodes[idx];
  if (!n) return;
  const wrap = document.getElementById(`pi-hist-rn-body-${idx}`);
  if (!wrap) return;
  const assessChk = n.assessable ? ' checked' : '';
  wrap.innerHTML = `<div class="pi-edit-form">
    <div class="pi-edit-row"><label>Ref ID</label><input type="text" id="pi-hist-rn-ref-${idx}" class="pi-form-input" value="${esc(n.ref_id || '')}"></div>
    <div class="pi-edit-row"><label>Name</label><input type="text" id="pi-hist-rn-name-${idx}" class="pi-form-input" value="${esc(n.name || '')}"></div>
    <div class="pi-edit-row"><label>Description</label><textarea id="pi-hist-rn-desc-${idx}" class="pi-form-input" rows="4">${esc(n.description || '')}</textarea></div>
    <div class="pi-edit-row-inline">
      <div class="pi-edit-row"><label>Depth</label><input type="number" id="pi-hist-rn-depth-${idx}" class="pi-form-input" min="1" max="99" value="${Number(n.depth) || 1}"></div>
      <div class="pi-edit-row" style="align-self:flex-end"><label style="visibility:hidden">Assess</label><label style="text-transform:none;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="pi-hist-rn-assess-${idx}"${assessChk}> Assessable</label></div>
    </div>
    <div class="pi-edit-row"><label>URN (read-only)</label><input type="text" readonly class="pi-form-input" style="opacity:0.85" value="${esc(n.urn || '')}"></div>
    <div class="pi-edit-actions"><button type="button" class="pi-btn pi-btn-view" onclick="piHistCancelFrameworkEdit(${idx})">Cancel</button><button type="button" class="btn-admin-primary" onclick="piHistSaveFrameworkEdit(${idx})">Save</button></div>
  </div>`;
}

function piHistCancelFrameworkEdit(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const nodes = entry.extractionData.requirementNodes || [];
  const n = nodes[idx];
  const wrap = document.getElementById(`pi-hist-rn-body-${idx}`);
  if (!wrap || !n) return;
  wrap.innerHTML = n.description ? `<div class="pi-hist-detail-node-desc">${esc(n.description)}</div>` : '';
}

async function piHistSaveFrameworkEdit(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const nodes = entry.extractionData.requirementNodes || [];
  const n = nodes[idx];
  if (!n) return;
  n.ref_id = document.getElementById(`pi-hist-rn-ref-${idx}`)?.value?.trim() ?? n.ref_id;
  n.name = document.getElementById(`pi-hist-rn-name-${idx}`)?.value?.trim() || n.name;
  n.description = document.getElementById(`pi-hist-rn-desc-${idx}`)?.value?.trim() || '';
  n.depth = Math.max(1, parseInt(document.getElementById(`pi-hist-rn-depth-${idx}`)?.value, 10) || n.depth || 1);
  n.assessable = !!document.getElementById(`pi-hist-rn-assess-${idx}`)?.checked;
  const updated = await piHistPersistEntry(entry);
  if (updated) {
    toast('success', 'Saved', 'Framework node updated');
    piRenderHistoryDetail(updated);
  }
}

async function piHistDeleteFrameworkNodeIdx(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const nodes = entry.extractionData.requirementNodes || [];
  const n = nodes[idx];
  if (!n) return;
  const rmIds = piFrameworkReviewIdsToRemove(n, nodes);
  const rmCount = rmIds.size;
  const msg = rmCount > 1
    ? `Remove this node and ${rmCount - 1} descendant(s) from saved history?`
    : 'Remove this requirement node from saved history?';
  if (!(await showConfirm({ title: 'Remove node', message: msg, confirmText: 'Remove', type: 'warning' }))) return;
  entry.extractionData.requirementNodes = nodes.filter(x => !rmIds.has(x.id));
  const updated = await piHistPersistEntry(entry);
  if (updated) {
    toast('success', 'Removed', 'Framework node deleted');
    piRenderHistoryDetail(updated);
  }
}

function piHistEditControlIdx(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const policies = entry.extractionData.policies || [];
  const p = policies[idx];
  if (!p) return;
  const wrap = document.getElementById(`pi-hist-rc-body-${idx}`);
  if (!wrap) return;
  const catOpts = ['policy', 'process', 'technical', 'physical', 'procedure'];
  const csfOpts = ['govern', 'protect', 'detect', 'respond', 'recover', 'identify'];
  const c = (p.category || 'policy').toLowerCase();
  const f = (p.csfFunction || 'govern').toLowerCase();
  const catSel = catOpts.map(x => `<option value="${x}"${c === x ? ' selected' : ''}>${x.charAt(0).toUpperCase() + x.slice(1)}</option>`).join('');
  const csfSel = csfOpts.map(x => `<option value="${x}"${f === x ? ' selected' : ''}>${x.charAt(0).toUpperCase() + x.slice(1)}</option>`).join('');
  wrap.innerHTML = `<div class="pi-edit-form">
    <div class="pi-edit-row"><label>Name</label><input type="text" id="pi-hist-rc-name-${idx}" class="pi-form-input" value="${esc(p.name || '')}"></div>
    <div class="pi-edit-row"><label>Ref / Code</label><input type="text" id="pi-hist-rc-code-${idx}" class="pi-form-input" value="${esc(p.code || '')}"></div>
    <div class="pi-edit-row"><label>Description</label><textarea id="pi-hist-rc-desc-${idx}" class="pi-form-input" rows="4">${esc(p.description || '')}</textarea></div>
    <div class="pi-edit-row-inline"><div class="pi-edit-row"><label>Category</label><select id="pi-hist-rc-cat-${idx}" class="pi-form-select">${catSel}</select></div><div class="pi-edit-row"><label>CSF Function</label><select id="pi-hist-rc-csf-${idx}" class="pi-form-select">${csfSel}</select></div></div>
    <div class="pi-edit-actions"><button type="button" class="pi-btn pi-btn-view" onclick="piHistCancelControlEdit(${idx})">Cancel</button><button type="button" class="btn-admin-primary" onclick="piHistSaveControlEdit(${idx})">Save</button></div>
  </div>`;
}

function piHistCancelControlEdit(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const p = entry.extractionData.policies[idx];
  const wrap = document.getElementById(`pi-hist-rc-body-${idx}`);
  if (!wrap || !p) return;
  wrap.innerHTML = p.description ? `<div class="pi-hist-detail-control-desc">${esc(p.description)}</div>` : '';
}

async function piHistSaveControlEdit(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  const p = entry.extractionData.policies[idx];
  if (!p) return;
  p.name = document.getElementById(`pi-hist-rc-name-${idx}`)?.value?.trim() || p.name;
  p.code = document.getElementById(`pi-hist-rc-code-${idx}`)?.value?.trim() || p.code;
  p.description = document.getElementById(`pi-hist-rc-desc-${idx}`)?.value?.trim() || '';
  p.category = document.getElementById(`pi-hist-rc-cat-${idx}`)?.value || p.category;
  p.csfFunction = document.getElementById(`pi-hist-rc-csf-${idx}`)?.value || p.csfFunction;
  const updated = await piHistPersistEntry(entry);
  if (updated) {
    toast('success', 'Saved', 'Reference control updated');
    piRenderHistoryDetail(updated);
  }
}

async function piHistDeleteControlIdx(idx) {
  const entry = piHistCurrentEntry();
  if (!entry || !entry.extractionData) return;
  if (!(await showConfirm({ title: 'Remove control', message: 'Remove this reference control from saved history?', confirmText: 'Remove', type: 'warning' }))) return;
  const policies = entry.extractionData.policies || [];
  policies.splice(idx, 1);
  entry.extractionData.policies = policies;
  const updated = await piHistPersistEntry(entry);
  if (updated) {
    toast('success', 'Removed', 'Reference control deleted');
    piRenderHistoryDetail(updated);
  }
}

window.piHistEditFrameworkNodeIdx = piHistEditFrameworkNodeIdx;
window.piHistDeleteFrameworkNodeIdx = piHistDeleteFrameworkNodeIdx;
window.piHistSaveFrameworkEdit = piHistSaveFrameworkEdit;
window.piHistCancelFrameworkEdit = piHistCancelFrameworkEdit;
window.piHistEditControlIdx = piHistEditControlIdx;
window.piHistDeleteControlIdx = piHistDeleteControlIdx;
window.piHistSaveControlEdit = piHistSaveControlEdit;
window.piHistCancelControlEdit = piHistCancelControlEdit;

function piBackFromHistoryDetail() {
  piPhase = 'collection-detail';
  piActiveTab = 'history';
  piRender();
}
window.piBackFromHistoryDetail = piBackFromHistoryDetail;

function piToggleFile(id) {
  const idx = piSelectedFileIds.indexOf(id);
  if (idx === -1) piSelectedFileIds.push(id); else piSelectedFileIds.splice(idx, 1);
  piRender();
}
window.piToggleFile = piToggleFile;

function piToggleAllFiles() {
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (!coll || !coll.files || coll.files.length === 0) return;
  const pageIds = coll.files.map(f => f.id);
  const allPageSelected = pageIds.every(id => piSelectedFileIds.includes(id));
  if (allPageSelected) {
    piSelectedFileIds = piSelectedFileIds.filter(id => !pageIds.includes(id));
  } else {
    const set = new Set(piSelectedFileIds);
    pageIds.forEach(pid => set.add(pid));
    piSelectedFileIds = Array.from(set);
  }
  piRender();
}
window.piToggleAllFiles = piToggleAllFiles;

async function piFilesPageNext() {
  if (piFilesPageLoading) return;
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (!coll || !coll.filesNextPageToken) return;
  piFilesPageLoading = true;
  try {
    const nextTok = coll.filesNextPageToken;
    piFilesPagePrevTokens.push(piFilesPageActiveToken);
    await piRefreshCollectionDetail(coll.id, nextTok, 'next');
  } catch (err) {
    piFilesPagePrevTokens.pop();
    toast('error', 'Pagination', err.message || 'Could not load next page');
  } finally {
    piFilesPageLoading = false;
    piRender();
  }
}
window.piFilesPageNext = piFilesPageNext;

async function piFilesPagePrev() {
  if (piFilesPageLoading || piFilesPagePrevTokens.length === 0) return;
  piFilesPageLoading = true;
  const prevTok = piFilesPagePrevTokens.pop();
  try {
    await piRefreshCollectionDetail(piSelectedCollectionId, prevTok, 'prev');
  } catch (err) {
    piFilesPagePrevTokens.push(prevTok);
    toast('error', 'Pagination', err.message || 'Could not load previous page');
  } finally {
    piFilesPageLoading = false;
    piRender();
  }
}
window.piFilesPagePrev = piFilesPagePrev;

function piOpenFile(fileId, fileName, fileType) {
  const url = `${PI_API}/${piSelectedCollectionId}/files/${fileId}`;
  const viewable = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt'].includes((fileType || '').toLowerCase());

  if (viewable) {
    // Open in a modal viewer
    const overlay = document.createElement('div');
    overlay.className = 'pi-file-viewer-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const isPdf = fileType === 'pdf';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fileType);
    const isTxt = fileType === 'txt';

    let content = '';
    if (isPdf) {
      content = `<iframe src="${url}" class="pi-file-viewer-frame"></iframe>`;
    } else if (isImage) {
      content = `<img src="${url}" class="pi-file-viewer-image" alt="${esc(fileName)}">`;
    } else if (isTxt) {
      content = `<iframe src="${url}" class="pi-file-viewer-frame" style="background:#fff"></iframe>`;
    }

    overlay.innerHTML = `
      <div class="pi-file-viewer">
        <div class="pi-file-viewer-header">
          <div class="pi-file-viewer-title">${esc(fileName)}</div>
          <div class="pi-file-viewer-actions">
            <a href="${url}" download="${esc(fileName)}" class="pi-file-viewer-btn" title="Download"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 11V13C2 13.6 2.4 14 3 14H13C13.6 14 14 13.6 14 13V11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5 7L8 10L11 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 2V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></a>
            <a href="${url}" target="_blank" class="pi-file-viewer-btn" title="Open in new tab"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9 2H14V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2L7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12 9V13C12 13.6 11.6 14 11 14H3C2.4 14 2 13.6 2 13V5C2 4.4 2.4 4 3 4H7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></a>
            <button class="pi-file-viewer-btn close" onclick="this.closest('.pi-file-viewer-overlay').remove()" title="Close"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
          </div>
        </div>
        <div class="pi-file-viewer-body">${content}</div>
      </div>`;
    document.body.appendChild(overlay);
    // Allow escape key to close
    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  } else {
    // Non-viewable files: just download
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  }
}
window.piOpenFile = piOpenFile;

async function piDeleteFile(fileId) {
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (!coll) return;
  try {
    const res = await fetch(`${PI_API}/${coll.id}/files/${fileId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Delete failed');

    piFilesPagePrevTokens = [];
    await piRefreshCollectionDetail(coll.id, '', 'reset');
    piSelectedFileIds = piSelectedFileIds.filter(id => id !== fileId);
    piRender();
    toast('success', 'Deleted', 'File removed from collection');
  } catch (err) {
    toast('error', 'Delete Error', err.message);
  }
}
window.piDeleteFile = piDeleteFile;

/** Policy ingestion: allowed file extensions (basename), case-insensitive */
const PI_UPLOAD_EXT_RE = /\.(pdf|docx|pptx|txt|png|jpe?g)$/i;

function piPolicyUploadDisplayName(file) {
  const rp = file.webkitRelativePath || file._piRelPath;
  if (rp && String(rp).trim()) return String(rp).replace(/\\/g, '/');
  return file.name;
}

function piFilterPolicyIngestionFiles(fileList) {
  return fileList.filter(f => PI_UPLOAD_EXT_RE.test(f.name));
}

function piReadEntriesBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function piWalkDirectoryEntry(dirEntry, pathPrefix, out) {
  const reader = dirEntry.createReader();
  let batch;
  do {
    batch = await piReadEntriesBatch(reader);
    for (let i = 0; i < batch.length; i++) {
      const ent = batch[i];
      const rel = pathPrefix ? `${pathPrefix}/${ent.name}` : ent.name;
      if (ent.isFile) {
        await new Promise((resolve, reject) => {
          ent.file(
            f => {
              try {
                Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true });
              } catch (e) {
                f._piRelPath = rel;
              }
              out.push(f);
              resolve();
            },
            reject
          );
        });
      } else if (ent.isDirectory) {
        await piWalkDirectoryEntry(ent, rel, out);
      }
    }
  } while (batch.length > 0);
}

async function piCollectFilesFromDataTransfer(dt) {
  const out = [];
  if (!dt) return out;
  if (dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) {
        if (entry.isFile) {
          await new Promise((resolve, reject) => entry.file(f => { out.push(f); resolve(); }, reject));
        } else if (entry.isDirectory) {
          await piWalkDirectoryEntry(entry, entry.name, out);
        }
      } else if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }
  if (dt.files && dt.files.length) return Array.from(dt.files);
  return out;
}

function piTriggerUpload() {
  document.getElementById('pi-file-input')?.click();
}
window.piTriggerUpload = piTriggerUpload;

function piTriggerFolderUpload() {
  document.getElementById('pi-folder-input')?.click();
}
window.piTriggerFolderUpload = piTriggerFolderUpload;

function piAttachPolicyDropzone(collId) {
  const root = document.getElementById('pi-dropzone-root');
  if (!root || collId !== piSelectedCollectionId) return;

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const enterOver = (e) => { stop(e); root.classList.add('pi-dropzone-active'); };
  const maybeLeave = (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('pi-dropzone-active');
  };

  root.addEventListener('dragenter', enterOver);
  root.addEventListener('dragover', enterOver);
  root.addEventListener('dragleave', maybeLeave);
  root.addEventListener('drop', async (e) => {
    stop(e);
    root.classList.remove('pi-dropzone-active');
    const coll = piCollections.find(c => c.id === collId);
    if (!coll) return;
    let raw = [];
    try {
      raw = await piCollectFilesFromDataTransfer(e.dataTransfer);
    } catch (err) {
      console.warn('Drop scan error:', err);
      toast('error', 'Drop failed', err.message || 'Could not read dropped items');
      return;
    }
    const files = piFilterPolicyIngestionFiles(raw);
    if (raw.length && !files.length) {
      toast('info', 'No supported files', 'Only PDF, DOCX, PPTX, TXT, PNG, and JPG are accepted.');
      return;
    }
    if (files.length < raw.length) {
      toast('info', 'Some files skipped', `${raw.length - files.length} file(s) ignored (unsupported type).`);
    }
    await piUploadFilesToCollection(coll, files);
  });
}

async function piUploadFilesToCollection(coll, filesToUpload) {
  if (!coll || !filesToUpload.length) return;

  const UPLOAD_MAX_ATTEMPTS = 4;
  const UPLOAD_RETRY_MS_BASE = 1200;
  /** Space batch uploads to reduce provider rate limits (many failures after ~10 uploads). */
  const PI_UPLOAD_GAP_MS = 2500;

  const container = document.getElementById('pi-upload-progress-container');
  const total = filesToUpload.length;
  const bulk = total > 1;

  if (container) {
    container.classList.toggle('pi-upload-batch-mode', bulk);
    container.innerHTML = '';
  }

  const displayNames = filesToUpload.map(f => piPolicyUploadDisplayName(f));

  let summaryEl = null;
  const setSummary = currentIndex => {
    if (!summaryEl || !bulk) return;
    const safeIdx = Math.max(0, Math.min(currentIndex, total - 1));
    const num = Math.min(currentIndex + 1, total);
    const cur = displayNames[safeIdx] || '';
    const line1 = `Uploading ${total} files · ${num} / ${total}`;
    summaryEl.innerHTML = `<div class="pi-upload-batch-line1">${esc(line1)}</div>` +
      (cur ? `<div class="pi-upload-batch-line2" title="${esc(cur)}">${esc('Current: ' + cur)}</div>` : '');
  };

  if (bulk && container) {
    summaryEl = document.createElement('div');
    summaryEl.className = 'pi-upload-batch-summary';
    container.appendChild(summaryEl);
  }

  const rowEls = [];
  for (let i = 0; i < total; i++) {
    const displayName = displayNames[i];
    const uid = 'pi-up-' + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2, 9);
    const progressEl = document.createElement('div');
    progressEl.className = 'pi-upload-progress' + (bulk ? ' pi-upload-queued' : '');
    progressEl.id = uid;
    progressEl.innerHTML = `
      <div class="pi-upload-progress-info">
        <span class="pi-upload-progress-name" title="${esc(displayName)}">${esc(displayName)}</span>
        <div class="pi-upload-progress-trailing">
          <span class="pi-upload-progress-pct">${bulk ? '—' : '0%'}</span>
          <span class="pi-upload-progress-index-badge pi-upload-index-badge pi-upload-index-badge-queue">${bulk ? 'Queued' : 'Waiting'}</span>
        </div>
      </div>
      <div class="pi-upload-progress-bar"><div class="pi-upload-progress-fill" style="width:0%"></div></div>
      <div class="pi-upload-progress-status">${bulk ? 'Waiting in queue…' : 'Preparing file…'}</div>`;
    if (container) container.appendChild(progressEl);
    rowEls.push(progressEl);
  }

  if (bulk) setSummary(0);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 0));

    const file = filesToUpload[i];
    const displayName = displayNames[i];
    const progressEl = rowEls[i];

    rowEls.forEach((row, j) => {
      row.classList.toggle('pi-upload-active', j === i);
    });

    if (bulk) {
      progressEl.classList.remove('pi-upload-queued');
      setSummary(i);
    }

    const pctEl = progressEl.querySelector('.pi-upload-progress-pct');
    const badgeEl = progressEl.querySelector('.pi-upload-progress-index-badge');
    const fillEl = progressEl.querySelector('.pi-upload-progress-fill');
    const statusEl = progressEl.querySelector('.pi-upload-progress-status');

    const setIndexBadge = (variant, text) => {
      if (!badgeEl) return;
      badgeEl.textContent = text;
      badgeEl.className = `pi-upload-progress-index-badge pi-upload-index-badge pi-upload-index-badge-${variant}`;
    };

    const applyFinalIndexingBadge = ix => {
      if (!badgeEl) return;
      if (!ix) {
        setIndexBadge('ready', 'Indexed');
        return;
      }
      if (!ix.operationComplete) {
        setIndexBadge('pending', 'Indexing');
        return;
      }
      if (ix.documentFetched && ix.documentState === 'STATE_ACTIVE') {
        setIndexBadge('ready', 'Indexed');
        return;
      }
      if (ix.documentFetched && ix.documentState) {
        const s = ix.documentState.replace(/^STATE_/, '').toLowerCase();
        const label = s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Pending';
        setIndexBadge('pending', label);
        return;
      }
      setIndexBadge('ready', 'Indexed');
    };

    setIndexBadge('reading', 'Reading');

    const setProgress = (pct, statusText) => {
      if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
      if (fillEl) fillEl.style.width = `${pct}%`;
      if (statusEl && statusText) statusEl.textContent = statusText;
    };

    const fadeRemove = delayMs => {
      setTimeout(() => {
        progressEl.style.transition = 'opacity 0.4s ease, max-height 0.4s ease, margin 0.4s ease, padding 0.4s ease';
        progressEl.style.opacity = '0';
        progressEl.style.maxHeight = '0';
        progressEl.style.marginBottom = '0';
        progressEl.style.padding = '0 14px';
        setTimeout(() => progressEl.remove(), 450);
      }, delayMs);
    };

    const runOneUpload = base64Payload =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${PI_API}/${coll.id}/files`);
        xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            const uploadPct = 30 + (e.loaded / e.total) * 40;
            setProgress(uploadPct, 'Uploading…');
            setIndexBadge('uploading', 'Uploading');
          }
        });
        xhr.upload.addEventListener('load', () => {
          setProgress(75, 'Indexing…');
          setIndexBadge('indexing', 'Indexing');
        });

        xhr.onload = () => {
          try {
            const resp = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300 && resp.success) {
              resolve(resp);
            } else {
              reject(new Error(resp.error || `Upload failed (${xhr.status})`));
            }
          } catch (e) {
            reject(new Error('Invalid server response'));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.timeout = 300000;

        xhr.send(JSON.stringify({
          fileName: displayName,
          mimeType: file.type || 'application/octet-stream',
          data: base64Payload,
        }));
      });

    try {
      let base64 = null;
      let lastErr = null;

      for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt > 1) {
            const waitMs = UPLOAD_RETRY_MS_BASE * Math.pow(2, attempt - 2);
            const sec = Math.max(1, Math.ceil(waitMs / 1000));
            setProgress(18, `Retry ${attempt - 1}/${UPLOAD_MAX_ATTEMPTS - 1} in ${sec}s…`);
            await new Promise(r => setTimeout(r, waitMs));
            progressEl.classList.remove('pi-upload-error');
            progressEl.classList.remove('pi-upload-index-warning');
          }

          if (!base64) {
            setProgress(10, attempt > 1 ? 'Reading file… (retry)' : 'Reading file…');
            base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = reader.result;
                const s = typeof dataUrl === 'string' ? dataUrl : '';
                const idx = s.indexOf(',');
                if (idx < 0) reject(new Error('Could not read file (invalid data)'));
                else resolve(s.slice(idx + 1));
              };
              reader.onerror = () => reject(new Error('Could not read file'));
              reader.readAsDataURL(file);
            });
          }

          const uploadLabel =
            attempt > 1 ? `Uploading… (${attempt}/${UPLOAD_MAX_ATTEMPTS})` : 'Uploading…';
          setProgress(30, uploadLabel);
          setIndexBadge('uploading', 'Uploading');
          const uploadResp = await runOneUpload(base64);
          const ix = uploadResp.indexingStatus;
          const statusLine =
            ix && ix.summaryLabel ? ix.summaryLabel : 'Uploaded successfully ✓';
          setProgress(100, statusLine);
          applyFinalIndexingBadge(ix);
          progressEl.classList.toggle(
            'pi-upload-index-warning',
            !!(
              ix &&
              (!ix.operationComplete ||
                (ix.documentFetched &&
                  ix.documentState &&
                  ix.documentState !== 'STATE_ACTIVE'))
            )
          );
          progressEl.classList.add('pi-upload-success');
          progressEl.classList.remove('pi-upload-active');
          succeeded++;

          if (!bulk) {
            fadeRemove(3000);
            toast('success', 'Uploaded', displayName.length > 60 ? `"${displayName.slice(0, 57)}…"` : `"${displayName}"`);
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err && err.message ? String(err.message) : '';
          if (/Could not read file|invalid data/i.test(msg)) base64 = null;
          console.warn(
            `[Policy upload] "${displayName}" attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS}:`,
            msg || err
          );
          if (attempt === UPLOAD_MAX_ATTEMPTS) break;
          setIndexBadge('pending', 'Retry');
          setProgress(
            22,
            `Failed: ${msg || 'Unknown error'} · will retry`
          );
        }
      }

      if (lastErr) throw lastErr;

      if (bulk && i < total - 1) {
        await new Promise(r => setTimeout(r, PI_UPLOAD_GAP_MS));
      }
    } catch (err) {
      failed++;
      progressEl.classList.remove('pi-upload-active');
      setProgress(100, `Failed: ${err.message}`);
      setIndexBadge('error', 'Failed');
      progressEl.classList.add('pi-upload-error');
      fadeRemove(8000);
      toast('error', 'Upload Error', `"${displayName.length > 40 ? displayName.slice(0, 37) + '…' : displayName}": ${err.message}`);
    }
  }

  if (bulk && summaryEl) {
    const tail = failed ? ` · ${failed} failed` : '';
    summaryEl.innerHTML = `<div class="pi-upload-batch-line1 pi-upload-batch-done">${esc(`Finished · ${succeeded}/${total} uploaded${tail}`)}</div>`;
  }

  rowEls.forEach(row => row.classList.remove('pi-upload-active'));

  try {
    piFilesPagePrevTokens = [];
    await piRefreshCollectionDetail(coll.id, '', 'reset');
  } catch (e) { console.warn('Could not refresh collection:', e); }

  const liveProgressBars = container ? Array.from(container.children) : [];
  try {
    piRender();
  } catch (e) {
    console.warn('piRender after upload:', e);
  }
  const newContainer = document.getElementById('pi-upload-progress-container');
  if (newContainer) {
    liveProgressBars.forEach(bar => newContainer.appendChild(bar));
    newContainer.classList.toggle('pi-upload-batch-mode', bulk && liveProgressBars.length > 0);
  }

  if (bulk) {
    if (failed === 0) {
      toast('success', 'Batch complete', `${succeeded} file${succeeded !== 1 ? 's' : ''} uploaded.`);
    } else if (succeeded === 0) {
      toast('error', 'Upload failed', `All ${failed} file${failed !== 1 ? 's' : ''} failed.`);
    } else {
      toast('info', 'Batch finished', `${succeeded} succeeded, ${failed} failed. Expand errors on each row if needed.`);
    }
  }
}

async function piHandleFileUpload(event) {
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (!coll) return;
  const filesToUpload = Array.from(event.target.files || []);
  event.target.value = '';
  await piUploadFilesToCollection(coll, filesToUpload);
}
window.piHandleFileUpload = piHandleFileUpload;

async function piHandleFolderUpload(event) {
  const coll = piCollections.find(c => c.id === piSelectedCollectionId);
  if (!coll) return;
  const raw = Array.from(event.target.files || []);
  event.target.value = '';
  const files = piFilterPolicyIngestionFiles(raw);
  if (raw.length && !files.length) {
    toast('info', 'No supported files', 'This folder has no PDF, DOCX, PPTX, TXT, PNG, or JPG files.');
    return;
  }
  if (files.length < raw.length) {
    toast('info', 'Some files skipped', `${raw.length - files.length} file(s) ignored (unsupported type).`);
  }
  await piUploadFilesToCollection(coll, files);
}
window.piHandleFolderUpload = piHandleFolderUpload;

function piGenerateFromDetail() {
  piPhase = 'config-modal';
  piRender();
}
window.piGenerateFromDetail = piGenerateFromDetail;

// ─── Config Modal ──────────────────────────────────────
function piRenderConfigModal(coll) {
  const total = piCollectionFileCount(coll);
  let filesBlock = '';
  if (piSelectedFileIds.length > 0) {
    const files = (coll.files || []).filter(f => piSelectedFileIds.includes(f.id));
    filesBlock = files.map(f => `
    <div class="pi-included-file"><span>${esc(f.name)}</span><button onclick="piRemoveIncludedFile('${f.id}')"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9 3L3 9M3 3L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
  `).join('');
  } else if (total > 0) {
    filesBlock = `<div class="pi-included-all-hint">${esc(`All ${total} file${total !== 1 ? 's' : ''} in this collection will be included.`)}</div>`;
  } else {
    filesBlock = '<div style="text-align:center;padding:8px"><span style="font-size:10px;color:#9ca3af">No files in collection</span></div>';
  }

  return `
    <div class="pi-modal-overlay" onclick="piCloseConfigModal(event)">
      <div class="pi-modal" onclick="event.stopPropagation()">
        <div class="pi-modal-header">
          <div><h2>Policy Generation Settings</h2><p>Configure generation settings before starting</p></div>
          <button class="pi-modal-close" onclick="piCloseConfig()"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        </div>
        <div class="pi-modal-body">
          <div>
            <label class="pi-form-label">Generation Type <span style="color:#ef4444">*</span></label>
            <p class="pi-form-hint" style="margin-bottom:8px">Choose what to extract from the documents</p>
            <div class="pi-detail-radio-group">
              <label class="pi-radio-option active" id="pi-radio-framework" onclick="piSetGenerationType('framework')">
                <input type="radio" name="pi-gen-type" value="framework" checked>
                <div>
                  <div class="pi-radio-title" style="display:flex;align-items:center;gap:6px">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2L12 5V11L8 14L4 11V5L8 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                    Generate Policy Framework
                  </div>
                  <div class="pi-radio-desc">Extract document structure as a compliance framework with requirement nodes for assessments</div>
                </div>
              </label>
              <label class="pi-radio-option" id="pi-radio-controls" onclick="piSetGenerationType('controls')">
                <input type="radio" name="pi-gen-type" value="controls">
                <div>
                  <div class="pi-radio-title" style="display:flex;align-items:center;gap:6px">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M5 8L7 10L11 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Generate Reference Controls
                  </div>
                  <div class="pi-radio-desc">Extract reusable procedures and controls that become Applied Controls (Policies) in GRC</div>
                </div>
              </label>
              <label class="pi-radio-option" id="pi-radio-both" onclick="piSetGenerationType('both')">
                <input type="radio" name="pi-gen-type" value="both">
                <div>
                  <div class="pi-radio-title" style="display:flex;align-items:center;gap:6px">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2L12 5V11L8 14L4 11V5L8 2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M5.5 8L7 9.5L10.5 6.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Generate Both
                  </div>
                  <div class="pi-radio-desc">Extract framework structure + reference controls in a single library (full extraction)</div>
                </div>
              </label>
            </div>
          </div>
          <div><label class="pi-form-label">Library Name</label><input type="text" class="pi-form-input" id="pi-cfg-lib-name" value="${esc(coll.name)}" placeholder="e.g., Information Security Policies"></div>
          <div><label class="pi-form-label">Provider / Organization</label><input type="text" class="pi-form-input" id="pi-cfg-provider" value="" placeholder="Organization name"></div>
          <div id="pi-cfg-folder-row" style="display:none"><label class="pi-form-label">GRC Folder <span style="color:#ef4444">*</span></label><p class="pi-form-hint">Policies will be created in this GRC folder</p><select class="pi-form-select" id="pi-cfg-folder"><option value="">Loading folders…</option></select></div>
          <div><label class="pi-form-label">Language</label><select class="pi-form-select" id="pi-cfg-lang"><option value="en">English</option><option value="ar">Arabic</option><option value="ar+en">Arabic + English</option></select></div>
          <div>
            <label class="pi-form-label">Detail Level</label>
            <div class="pi-detail-radio-group">
              <label class="pi-radio-option active" id="pi-radio-comprehensive" onclick="piSetDetailLevel('comprehensive')"><input type="radio" name="pi-detail" checked><div><div class="pi-radio-title">Comprehensive</div><div class="pi-radio-desc">Extract all sections and sub-sections</div></div></label>
              <label class="pi-radio-option" id="pi-radio-summary" onclick="piSetDetailLevel('summary')"><input type="radio" name="pi-detail"><div><div class="pi-radio-title">Summary</div><div class="pi-radio-desc">Main sections only</div></div></label>
            </div>
          </div>
          <div><label class="pi-form-label">Included Files</label><div class="pi-included-files" id="pi-cfg-files">${filesBlock}</div></div>
        </div>
        <div class="pi-modal-footer">
          <button class="pi-btn pi-btn-view" onclick="piCloseConfig()">Cancel</button>
          <button class="btn-admin-primary" onclick="piStartGenerate()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1L8.5 4L12 4.5L9.5 7L10 10.5L7 9L4 10.5L4.5 7L2 4.5L5.5 4L7 1Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg> Start Generation</button>
        </div>
      </div>
    </div>`;
}

async function piLoadFoldersForConfig() {
  const sel = document.getElementById('pi-cfg-folder');
  if (!sel) return;
  try {
    const res = await fetch('/api/grc/folders?content_type=DO&content_type=GL');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const folders = data.folders || data.results || [];
    if (folders.length === 0) {
      sel.innerHTML = '<option value="">No folders available</option>';
    } else {
      sel.innerHTML = '<option value="">Select a folder…</option>' +
        folders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
      // Auto-select the "Global" folder/domain by default
      const globalFolder = folders.find(f => /^global$/i.test((f.name || '').trim()));
      if (globalFolder) sel.value = globalFolder.id;
    }
  } catch (err) {
    console.warn('Failed to load GRC folders for PI config:', err);
    sel.innerHTML = '<option value="">Error loading folders</option>';
  }
}

function piCloseConfigModal(e) { if (e.target === e.currentTarget) piCloseConfig(); }
window.piCloseConfigModal = piCloseConfigModal;

function piCloseConfig() { piPhase = 'collection-detail'; piRender(); }
window.piCloseConfig = piCloseConfig;

function piSetGenerationType(type) {
  document.getElementById('pi-radio-framework')?.classList.toggle('active', type === 'framework');
  document.getElementById('pi-radio-controls')?.classList.toggle('active', type === 'controls');
  document.getElementById('pi-radio-both')?.classList.toggle('active', type === 'both');
  // Show/hide folder selector: needed for controls and both (policies are created in a folder)
  const needsFolder = type === 'controls' || type === 'both';
  const folderRow = document.getElementById('pi-cfg-folder-row');
  if (folderRow) folderRow.style.display = needsFolder ? '' : 'none';
}
window.piSetGenerationType = piSetGenerationType;

function piSetDetailLevel(level) {
  document.getElementById('pi-radio-comprehensive')?.classList.toggle('active', level === 'comprehensive');
  document.getElementById('pi-radio-summary')?.classList.toggle('active', level === 'summary');
}
window.piSetDetailLevel = piSetDetailLevel;

function piRemoveIncludedFile(fileId) {
  const el = document.getElementById('pi-cfg-files');
  if (el) {
    const item = el.querySelector(`[onclick*="${fileId}"]`)?.closest('.pi-included-file');
    if (item) item.remove();
  }
}
window.piRemoveIncludedFile = piRemoveIncludedFile;

let piCurrentConfig = {}; // Store config for approve step

function piStartGenerate() {
  // Collect config values from the modal
  const generationType = document.getElementById('pi-radio-framework')?.classList.contains('active') ? 'framework'
    : document.getElementById('pi-radio-controls')?.classList.contains('active') ? 'controls' : 'both';
  const libraryName = document.getElementById('pi-cfg-lib-name')?.value?.trim() || 'Untitled Library';
  const provider = document.getElementById('pi-cfg-provider')?.value?.trim() || '';
  const folder = document.getElementById('pi-cfg-folder')?.value || '';
  const language = document.getElementById('pi-cfg-lang')?.value || 'en';
  const detailLevel = document.getElementById('pi-radio-comprehensive')?.classList.contains('active') ? 'comprehensive' : 'summary';

  // For controls/both mode, folder is required (policies are created in a folder)
  if ((generationType === 'controls' || generationType === 'both') && !folder) {
    toast('error', 'Missing Folder', 'Please select a GRC folder for policy creation.');
    return;
  }

  // Collect selected framework IDs
  const linkedFrameworkIds = [];
  document.querySelectorAll('.pi-fw-item input[type="checkbox"]:checked').forEach(cb => {
    linkedFrameworkIds.push(cb.value);
  });

  // Collect selected file IDs from included files
  const selectedFileIds = piSelectedFileIds.length > 0 ? piSelectedFileIds : undefined;

  piCurrentConfig = { generationType, libraryName, provider, folder, language, detailLevel, linkedFrameworkIds };

  piPhase = 'generating';
  piRender();

  // Call the extraction API with generationType
  piRunExtraction(piSelectedCollectionId, {
    generationType, libraryName, provider, language, detailLevel, linkedFrameworkIds, selectedFileIds,
  });
}
window.piStartGenerate = piStartGenerate;

async function piRunExtraction(collId, config) {
  try {
    const res = await fetch(`${PI_API}/${collId}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    piStopProgressAnimation();
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Extraction failed');

    piGenerationResult = data.data;
    piReviewPolicies = data.data.policies || [];
    piReviewNodes = data.data.requirementNodes || [];
    // Invalidate history cache so next visit shows the new entry
    delete piHistoryCache[collId];
    piPhase = 'review';
    piRender();

    const genType = data.data.generationType || 'both';
    if (genType === 'framework') {
      toast('success', 'Framework Extracted', `${piReviewNodes.length} requirement nodes (${data.data.assessableNodes || 0} assessable) extracted from ${data.data.sourceFileCount || 0} files.`);
    } else if (genType === 'both') {
      toast('success', 'Full Extraction Complete', `${piReviewNodes.length} requirement nodes + ${piReviewPolicies.length} reference controls extracted from ${data.data.sourceFileCount || 0} files.`);
    } else {
      toast('success', 'Controls Extracted', `${piReviewPolicies.length} reference controls extracted from ${data.data.sourceFileCount || 0} files.`);
    }
  } catch (err) {
    piStopProgressAnimation();
    console.error('Policy extraction error:', err);
    toast('error', 'Extraction Failed', err.message);
    piPhase = 'collection-detail';
    piRender();
  }
}

// ─── Generation Progress ───────────────────────────────
const PI_STEPS = [
  { label: 'Reading Documents', icon: 'search' },
  { label: 'Analyzing Content & Extracting Policies', icon: 'sparkles' },
  { label: 'Building Library Structure', icon: 'network' },
  { label: 'Linking Policies to Frameworks', icon: 'link' },
  { label: 'Quality Review', icon: 'shield' },
];

function piRenderProgress() {
  const stepsHtml = PI_STEPS.map((s, i) => `
    <div class="pi-step" id="pi-step-${i}">
      <div class="pi-step-icon pending" id="pi-step-icon-${i}"><svg width="14" height="14" class="${i === 0 ? 'pi-spinner' : ''}" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.3"/><path d="M7 2C10 2 12 4.7 12 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <span class="pi-step-label pending" id="pi-step-label-${i}">${s.label}</span>
    </div>
  `).join('');

  return `
    <div class="pi-header">
      <div class="pi-header-left">
        <div class="pi-header-title"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M5 8H10M5 10.5H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><h1>Organization Policy Ingestion</h1></div>
      </div>
    </div>
    <div class="pi-progress-card">
      <div class="pi-progress-inner">
        <div class="pi-progress-icon"><svg width="36" height="36" viewBox="0 0 14 14" fill="none"><path d="M7 1L8.5 4L12 4.5L9.5 7L10 10.5L7 9L4 10.5L4.5 7L2 4.5L5.5 4L7 1Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg></div>
        <h3 class="pi-progress-title">Analyzing documents and generating policies...</h3>
        <p class="pi-progress-desc">You can navigate away and come back later — generation will continue in the background</p>
        <div class="pi-steps">${stepsHtml}</div>
        <div class="pi-progress-bar"><div class="pi-progress-fill" id="pi-progress-fill" style="width:0%"></div></div>
        <div class="pi-progress-stats"><span id="pi-progress-pct">0%</span><span id="pi-progress-remaining">Remaining: ~6s</span></div>
      </div>
    </div>`;
}

let piProgressTimer = null;

function piStartProgressAnimation() {
  let currentStep = 0;
  let progress = 0;

  // Activate first step
  piUpdateStepUI(0, 'active');

  // Slowly advance progress bar (indeterminate-ish, max 90% until real API responds)
  piProgressTimer = setInterval(() => {
    progress = Math.min(progress + 0.5, 90);
    const fillEl = document.getElementById('pi-progress-fill');
    const pctEl = document.getElementById('pi-progress-pct');
    const remEl = document.getElementById('pi-progress-remaining');
    if (fillEl) fillEl.style.width = progress + '%';
    if (pctEl) pctEl.textContent = Math.round(progress) + '%';
    if (remEl) remEl.textContent = 'Analyzing documents with Wathbah AI…';

    // Advance steps based on progress
    const stepIdx = Math.min(Math.floor(progress / (90 / PI_STEPS.length)), PI_STEPS.length - 1);
    if (stepIdx > currentStep) {
      piUpdateStepUI(currentStep, 'done');
      currentStep = stepIdx;
      piUpdateStepUI(currentStep, 'active');
    }
  }, 200);
}

function piStopProgressAnimation() {
  if (piProgressTimer) { clearInterval(piProgressTimer); piProgressTimer = null; }
}

function piUpdateStepUI(idx, state) {
  const iconEl = document.getElementById(`pi-step-icon-${idx}`);
  const labelEl = document.getElementById(`pi-step-label-${idx}`);
  if (!iconEl || !labelEl) return;

  iconEl.className = 'pi-step-icon ' + state;
  labelEl.className = 'pi-step-label ' + state;

  if (state === 'done') {
    iconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else if (state === 'active') {
    iconEl.innerHTML = '<svg width="14" height="14" class="pi-spinner" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.3"/><path d="M7 2C10 2 12 4.7 12 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  }
}

// ─── Policy Review ─────────────────────────────────────
function piRenderReview() {
  if (!piGenerationResult) return '';
  const r = piGenerationResult;
  const genType = r.generationType || 'both';
  const confClass = r.confidenceScore >= 80 ? 'pi-confidence-high' : r.confidenceScore >= 60 ? 'pi-confidence-mid' : 'pi-confidence-low';
  const confBarClass = r.confidenceScore >= 80 ? 'background:#059669' : r.confidenceScore >= 60 ? 'background:#d97706' : 'background:#dc2626';

  // ── Framework mode: render requirement nodes tree ──
  if (genType === 'framework') {
    const nodes = piReviewNodes || [];
    const totalNodes = nodes.length;
    const assessableCount = nodes.filter(n => n.assessable).length;
    const structuralCount = totalNodes - assessableCount;

    // Build indented tree view of requirement nodes
    const nodesHtml = nodes.map((n, idx) => {
      const indent = Math.max(0, (n.depth || 1) - 1) * 20;
      const isAssessable = !!n.assessable;
      const depthLabel = n.depth === 1 ? 'Root' : n.depth === 2 ? 'Section' : n.depth === 3 ? 'Sub-section' : 'Requirement';
      const assessBadge = isAssessable
        ? '<span class="pi-policy-tag" style="background:#dcfce7;color:#166534;font-size:9px;padding:1px 6px;border-radius:4px">Assessable</span>'
        : '<span class="pi-policy-tag" style="background:#f3f4f6;color:#6b7280;font-size:9px;padding:1px 6px;border-radius:4px">Structural</span>';

      return `
        <div class="pi-policy-item" style="margin-left:${indent}px">
          <div class="pi-policy-item-header" onclick="piTogglePolicy('${n.id}')">
            <div class="pi-policy-toggle"><svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="${idx === 0 ? 'M3 5L6 8L9 5' : 'M5 3L8 6L5 9'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <span class="pi-policy-code" style="min-width:40px">${esc(n.ref_id || '')}</span>
            <span class="pi-policy-name">${esc(n.name)}</span>
            <div class="pi-policy-tags">
              ${assessBadge}
              <span style="font-size:9px;color:#9ca3af">${depthLabel}</span>
              <button type="button" class="pi-policy-edit-btn" onclick="event.stopPropagation();piEditFrameworkNode('${n.id}')" title="Edit"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
              <button type="button" class="pi-policy-delete-btn" onclick="event.stopPropagation();piDeleteFrameworkNode('${n.id}')" title="Delete"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4H12M4 4V3C4 2.4 4.4 2 5 2H9C9.6 2 10 2.4 10 3V4M5 6.5V10.5M7 6.5V10.5M9 6.5V10.5M3 4L4 12H10L11 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </div>
          <div class="pi-policy-detail${idx === 0 ? ' open' : ''}" id="pi-policy-detail-${n.id}">
            ${n.description ? `<div class="pi-policy-detail-section"><div class="pi-policy-detail-label">Description</div><p class="pi-policy-detail-text">${esc(n.description)}</p></div>` : ''}
            <div class="pi-policy-detail-section" style="display:flex;gap:16px;flex-wrap:wrap">
              <div><span class="pi-policy-detail-label">Depth:</span> ${n.depth}</div>
              <div><span class="pi-policy-detail-label">URN:</span> <span style="font-size:10px;color:#6b7280;font-family:monospace">${esc(n.urn || '')}</span></div>
            </div>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="pi-review-header">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M8 2L12 5V11L8 14L4 11V5L8 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        <h1>Review Generated Framework</h1>
      </div>
      <p class="pi-review-subtitle">Review the framework structure extracted from your documents before creating the library</p>

      <div class="pi-review-stats"><div class="pi-review-stats-grid">
        <div><div class="pi-review-stat-label">Library Name</div><div class="pi-review-stat-value">${esc(r.libraryName)}</div></div>
        <div><div class="pi-review-stat-label">Source Files</div><div class="pi-review-stat-value">${r.sourceFileCount} files</div></div>
        <div><div class="pi-review-stat-label">Total Nodes</div><div class="pi-review-stat-value">${totalNodes} nodes</div></div>
        <div><div class="pi-review-stat-label">Assessable</div><div class="pi-review-stat-value">${assessableCount} requirements</div></div>
      </div></div>

      <div class="pi-policy-panel">
        <div class="pi-policy-panel-header" style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%)">
          <h3><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L12 5V11L8 14L4 11V5L8 2Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg> ${esc(r.libraryName)}</h3>
          <p>${totalNodes} requirement nodes — ${assessableCount} assessable, ${structuralCount} structural</p>
        </div>
        <div class="pi-policy-list" style="max-height:500px;overflow-y:auto">
          ${nodesHtml}
        </div>
      </div>

      <div class="pi-review-footer">
        <button class="pi-btn pi-btn-discard" onclick="piDiscard()">Discard & Delete</button>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="pi-btn pi-btn-preview-yaml" onclick="piPreviewYaml()"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2.5 12.5v-9h8l2.5 2.5v6.5h-8" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M4.5 4.5v-2h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4.5 8.5h7M4.5 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Preview YAML</button>
          <button class="pi-btn pi-btn-regenerate" onclick="piRegenerate()"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6C1 3.2 3.2 1 6 1C8.8 1 11 3.2 11 6C11 8.8 8.8 11 6 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4 6L1 6L1 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg> Regenerate</button>
          <button class="pi-btn pi-btn-approve" onclick="piApprove()"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Approve & Upload Library</button>
        </div>
      </div>`;
  }

  // ── Controls / Both mode: render reference controls ──
  const catLabels = { policy: { label: 'Policy', cls: 'pi-tag-policy' }, process: { label: 'Process', cls: 'pi-tag-process' }, technical: { label: 'Technical', cls: 'pi-tag-technical' }, physical: { label: 'Physical', cls: 'pi-tag-physical' }, procedure: { label: 'Procedure', cls: 'pi-tag-process' } };
  const csfLabels = { govern: { label: 'Govern', cls: 'pi-tag-govern' }, protect: { label: 'Protect', cls: 'pi-tag-protect' }, detect: { label: 'Detect', cls: 'pi-tag-detect' }, respond: { label: 'Respond', cls: 'pi-tag-respond' }, recover: { label: 'Recover', cls: 'pi-tag-recover' }, identify: { label: 'Identify', cls: 'pi-tag-identify' } };

  const policiesHtml = piReviewPolicies.map((p, idx) => {
    const cat = catLabels[p.category] || catLabels.policy;
    const csf = csfLabels[p.csfFunction] || csfLabels.govern;
    const expanded = idx === 0;

    return `
      <div class="pi-policy-item">
        <div class="pi-policy-item-header" onclick="piTogglePolicy('${p.id}')">
          <div class="pi-policy-toggle"><svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="${expanded ? 'M3 5L6 8L9 5' : 'M5 3L8 6L5 9'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <span class="pi-policy-code">${esc(p.code)}</span>
          <span class="pi-policy-name">${esc(p.name)}</span>
          <div class="pi-policy-tags">
            <span class="pi-policy-tag ${cat.cls}">${cat.label}</span>
            <span class="pi-policy-tag ${csf.cls}">${csf.label}</span>
            <button class="pi-policy-edit-btn" onclick="event.stopPropagation();piEditPolicy('${p.id}')" title="Edit"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
            <button class="pi-policy-delete-btn" onclick="event.stopPropagation();piDeletePolicy('${p.id}')"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4H12M4 4V3C4 2.4 4.4 2 5 2H9C9.6 2 10 2.4 10 3V4M5 6.5V10.5M7 6.5V10.5M9 6.5V10.5M3 4L4 12H10L11 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
        </div>
        <div class="pi-policy-detail${expanded ? ' open' : ''}" id="pi-policy-detail-${p.id}">
          <div class="pi-policy-detail-section"><div class="pi-policy-detail-label">Description</div><p class="pi-policy-detail-text">${esc(p.description)}</p></div>
          ${p.sourceFile ? `<div class="pi-policy-detail-section"><div class="pi-policy-detail-label">Source</div><div class="pi-policy-detail-source"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.3"/></svg><span>${esc(p.sourceFile)}</span>${p.sourcePages ? `<span class="pages">(${esc(p.sourcePages)})</span>` : ''}</div></div>` : ''}
          <div class="pi-policy-detail-section">
            <div class="pi-policy-detail-label">Linked Requirements</div>
            <div class="pi-policy-reqs">${(p.linkedRequirements || []).map(r2 => `<span class="pi-policy-req-pill">${esc(r2)}</span>`).join('') || '<span style="color:#9ca3af;font-size:11px">None</span>'}</div>
            <div class="pi-policy-reqs" style="margin-top:6px">${(p.linkedFrameworks || []).map(fw => `<span class="pi-policy-fw-pill">${esc(fw)}</span>`).join('')}</div>
          </div>
        </div>
      </div>`;
  }).join('');

  // ── For "both" mode: also build framework nodes panel ──
  let bothNodesHtml = '';
  if (genType === 'both' && piReviewNodes.length > 0) {
    const nodes = piReviewNodes;
    bothNodesHtml = `
      <div class="pi-policy-panel" style="margin-bottom:16px">
        <div class="pi-policy-panel-header" style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%)">
          <h3><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L12 5V11L8 14L4 11V5L8 2Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg> Framework — ${esc(r.libraryName)}</h3>
          <p>${nodes.length} requirement nodes — ${nodes.filter(n => n.assessable).length} assessable</p>
        </div>
        <div class="pi-policy-list" style="max-height:300px;overflow-y:auto">
          ${nodes.map((n, idx) => {
            const indent = Math.max(0, (n.depth || 1) - 1) * 20;
            const isAssessable = !!n.assessable;
            const depthLabel = n.depth === 1 ? 'Root' : n.depth === 2 ? 'Section' : n.depth === 3 ? 'Sub-section' : 'Requirement';
            const assessBadge = isAssessable
              ? '<span class="pi-policy-tag" style="background:#dcfce7;color:#166534;font-size:9px;padding:1px 6px;border-radius:4px">Assessable</span>'
              : '<span class="pi-policy-tag" style="background:#f3f4f6;color:#6b7280;font-size:9px;padding:1px 6px;border-radius:4px">Structural</span>';
  return `
              <div class="pi-policy-item" style="margin-left:${indent}px">
                <div class="pi-policy-item-header" onclick="piTogglePolicy('${n.id}')">
                  <div class="pi-policy-toggle"><svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M5 3L8 6L5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
                  <span class="pi-policy-code" style="min-width:40px">${esc(n.ref_id || '')}</span>
                  <span class="pi-policy-name">${esc(n.name)}</span>
                  <div class="pi-policy-tags">${assessBadge}<span style="font-size:9px;color:#9ca3af">${depthLabel}</span>
                  <button type="button" class="pi-policy-edit-btn" onclick="event.stopPropagation();piEditFrameworkNode('${n.id}')" title="Edit"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M10.5 2.5L11.5 3.5L4 11H2.5V9.5L10.5 2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
                  <button type="button" class="pi-policy-delete-btn" onclick="event.stopPropagation();piDeleteFrameworkNode('${n.id}')" title="Delete"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4H12M4 4V3C4 2.4 4.4 2 5 2H9C9.6 2 10 2.4 10 3V4M5 6.5V10.5M7 6.5V10.5M9 6.5V10.5M3 4L4 12H10L11 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                  </div>
                </div>
                <div class="pi-policy-detail" id="pi-policy-detail-${n.id}">
                  ${n.description ? `<div class="pi-policy-detail-section"><div class="pi-policy-detail-label">Description</div><p class="pi-policy-detail-text">${esc(n.description)}</p></div>` : ''}
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  const isBoth = genType === 'both';
  const panelTitle = isBoth ? 'Framework + Reference Controls' : 'Reference Controls';
  const reviewSubtitle = isBoth
    ? 'Review the framework and reference controls extracted from your documents'
    : 'Review the reference controls extracted from your documents before creating the library and policies';
  const approveLabel = 'Approve & Upload Library';

  return `
    <div class="pi-review-header"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M5 8L7 10L11 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><h1>Review Generated ${esc(panelTitle)}</h1></div>
    <p class="pi-review-subtitle">${reviewSubtitle}</p>

    <div class="pi-review-stats"><div class="pi-review-stats-grid">
      <div><div class="pi-review-stat-label">Library Name</div><div class="pi-review-stat-value">${esc(r.libraryName)}</div></div>
      <div><div class="pi-review-stat-label">Source Files</div><div class="pi-review-stat-value">${r.sourceFileCount} files</div></div>
      <div><div class="pi-review-stat-label">Extracted Controls</div><div class="pi-review-stat-value">${piReviewPolicies.length} controls</div></div>
      ${isBoth ? `<div><div class="pi-review-stat-label">Requirement Nodes</div><div class="pi-review-stat-value">${piReviewNodes.length} nodes</div></div>` : ''}
    </div></div>

    ${bothNodesHtml}

    <div class="pi-policy-panel">
      <div class="pi-policy-panel-header">
        <h3><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="white" stroke-width="1.5"/><path d="M5.5 8L7 9.5L10.5 6.5" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> ${isBoth ? 'Reference Controls' : esc(r.libraryName)}</h3>
        <p>${piReviewPolicies.length} extracted reference controls — click to view details or edit</p>
      </div>
      <div class="pi-policy-list">
        ${policiesHtml}
        <button class="pi-add-policy-btn" onclick="piAddControl()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Add Control Manually</button>
      </div>
    </div>

    <div class="pi-review-footer">
      <button class="pi-btn pi-btn-discard" onclick="piDiscard()">Discard & Delete</button>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="pi-btn pi-btn-preview-yaml" onclick="piPreviewYaml()"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2.5 12.5v-9h8l2.5 2.5v6.5h-8" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M4.5 4.5v-2h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4.5 8.5h7M4.5 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Preview YAML</button>
        <button class="pi-btn pi-btn-regenerate" onclick="piRegenerate()"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6C1 3.2 3.2 1 6 1C8.8 1 11 3.2 11 6C11 8.8 8.8 11 6 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M4 6L1 6L1 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg> Regenerate</button>
        <button class="pi-btn pi-btn-approve" onclick="piApprove()"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ${approveLabel}</button>
      </div>
    </div>`;
}

function piTogglePolicy(id) {
  const detail = document.getElementById(`pi-policy-detail-${id}`);
  if (detail) detail.classList.toggle('open');
  // Update toggle arrow
  const item = detail?.closest('.pi-policy-item');
  if (item) {
    const toggle = item.querySelector('.pi-policy-toggle svg path');
    if (toggle) {
      const isOpen = detail.classList.contains('open');
      toggle.setAttribute('d', isOpen ? 'M3 5L6 8L9 5' : 'M5 3L8 6L5 9');
    }
  }
}
window.piTogglePolicy = piTogglePolicy;

async function piDeleteFrameworkNode(id) {
  const n = piReviewNodes.find(x => x.id === id);
  if (!n) return;
  const rm = piFrameworkReviewIdsToRemove(n, piReviewNodes);
  const msg = rm.size > 1
    ? `Remove this node and ${rm.size - 1} descendant(s)?`
    : 'Remove this requirement node?';
  if (!(await showConfirm({ title: 'Remove node', message: msg, confirmText: 'Remove', type: 'warning' }))) return;
  piReviewNodes = piReviewNodes.filter(x => !rm.has(x.id));
  piSyncFrameworkResultFromReview();
  piRender();
}
window.piDeleteFrameworkNode = piDeleteFrameworkNode;

function piEditFrameworkNode(id) {
  const n = piReviewNodes.find(x => x.id === id);
  if (!n) return;
  const det = document.getElementById(`pi-policy-detail-${id}`);
  if (!det) return;
  det.classList.add('open');
  const item = det.closest('.pi-policy-item');
  if (item) { const t = item.querySelector('.pi-policy-toggle svg path'); if (t) t.setAttribute('d', 'M3 5L6 8L9 5'); }
  const assessChk = n.assessable ? ' checked' : '';
  det.innerHTML = `<div class="pi-edit-form">
    <div class="pi-edit-row"><label>Ref ID</label><input type="text" id="pi-fn-edit-ref-${id}" class="pi-form-input" value="${esc(n.ref_id || '')}"></div>
    <div class="pi-edit-row"><label>Name</label><input type="text" id="pi-fn-edit-name-${id}" class="pi-form-input" value="${esc(n.name)}"></div>
    <div class="pi-edit-row"><label>Description</label><textarea id="pi-fn-edit-desc-${id}" class="pi-form-input" rows="4">${esc(n.description || '')}</textarea></div>
    <div class="pi-edit-row-inline">
      <div class="pi-edit-row"><label>Depth</label><input type="number" id="pi-fn-edit-depth-${id}" class="pi-form-input" min="1" max="99" value="${Number(n.depth) || 1}"></div>
      <div class="pi-edit-row" style="align-self:flex-end"><label style="visibility:hidden">—</label><label style="text-transform:none;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="pi-fn-edit-assess-${id}"${assessChk}> Assessable</label></div>
    </div>
    <div class="pi-edit-row"><label>URN (read-only)</label><input type="text" readonly class="pi-form-input" style="opacity:0.85" value="${esc(n.urn || '')}"></div>
    <div class="pi-edit-actions"><button type="button" class="pi-btn pi-btn-view" onclick="piRender()">Cancel</button><button type="button" class="btn-admin-primary" onclick='piSaveFrameworkNodeEdit(${JSON.stringify(id)})'>Save Changes</button></div>
  </div>`;
}
window.piEditFrameworkNode = piEditFrameworkNode;

function piSaveFrameworkNodeEdit(id) {
  const n = piReviewNodes.find(x => x.id === id);
  if (!n) return;
  n.ref_id = document.getElementById(`pi-fn-edit-ref-${id}`)?.value?.trim() ?? n.ref_id;
  n.name = document.getElementById(`pi-fn-edit-name-${id}`)?.value?.trim() || n.name;
  n.description = document.getElementById(`pi-fn-edit-desc-${id}`)?.value?.trim() || '';
  n.depth = Math.max(1, parseInt(document.getElementById(`pi-fn-edit-depth-${id}`)?.value, 10) || n.depth || 1);
  n.assessable = !!document.getElementById(`pi-fn-edit-assess-${id}`)?.checked;
  piSyncFrameworkResultFromReview();
  toast('success', 'Saved', `Updated "${n.name}"`);
  piRender();
}
window.piSaveFrameworkNodeEdit = piSaveFrameworkNodeEdit;

async function piDeletePolicy(id) {
  if (!await showConfirm({ title: 'Remove Control', message: 'Remove this control from the list?', confirmText: 'Remove', type: 'warning' })) return;
  piReviewPolicies = piReviewPolicies.filter(p => p.id !== id);
  piRender();
}
window.piDeletePolicy = piDeletePolicy;

function piEditPolicy(id) {
  const p = piReviewPolicies.find(x => x.id === id);
  if (!p) return;
  const catOpts = ['policy','process','technical','physical','procedure'];
  const csfOpts = ['govern','protect','detect','respond','recover','identify'];
  const catSel = catOpts.map(c => `<option value="${c}"${p.category===c?' selected':''}>${c[0].toUpperCase()+c.slice(1)}</option>`).join('');
  const csfSel = csfOpts.map(c => `<option value="${c}"${p.csfFunction===c?' selected':''}>${c[0].toUpperCase()+c.slice(1)}</option>`).join('');
  const det = document.getElementById(`pi-policy-detail-${id}`);
  if (!det) return;
  det.classList.add('open');
  const item = det.closest('.pi-policy-item');
  if (item) { const t = item.querySelector('.pi-policy-toggle svg path'); if (t) t.setAttribute('d','M3 5L6 8L9 5'); }
  det.innerHTML = `<div class="pi-edit-form">
    <div class="pi-edit-row"><label>Name</label><input type="text" id="pi-edit-name-${id}" class="pi-form-input" value="${esc(p.name)}"></div>
    <div class="pi-edit-row"><label>Ref ID</label><input type="text" id="pi-edit-code-${id}" class="pi-form-input" value="${esc(p.code)}"></div>
    <div class="pi-edit-row"><label>Description</label><textarea id="pi-edit-desc-${id}" class="pi-form-input" rows="3">${esc(p.description)}</textarea></div>
    <div style="display:flex;gap:12px"><div class="pi-edit-row" style="flex:1"><label>Category</label><select id="pi-edit-cat-${id}" class="pi-form-select">${catSel}</select></div><div class="pi-edit-row" style="flex:1"><label>CSF Function</label><select id="pi-edit-csf-${id}" class="pi-form-select">${csfSel}</select></div></div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid #f3f4f6"><button class="pi-btn pi-btn-view" onclick="piRender()">Cancel</button><button class="btn-admin-primary" onclick="piSaveEdit('${id}')">Save Changes</button></div>
  </div>`;
}
window.piEditPolicy = piEditPolicy;

function piSaveEdit(id) {
  const p = piReviewPolicies.find(x => x.id === id);
  if (!p) return;
  p.name = document.getElementById(`pi-edit-name-${id}`)?.value?.trim() || p.name;
  p.code = document.getElementById(`pi-edit-code-${id}`)?.value?.trim() || p.code;
  p.description = document.getElementById(`pi-edit-desc-${id}`)?.value?.trim() || p.description;
  p.category = document.getElementById(`pi-edit-cat-${id}`)?.value || p.category;
  p.csfFunction = document.getElementById(`pi-edit-csf-${id}`)?.value || p.csfFunction;
  toast('success', 'Saved', `Updated "${p.name}"`);
  piRender();
}
window.piSaveEdit = piSaveEdit;

function piAddControl() {
  const newId = 'gp-manual-' + Date.now();
  const idx = piReviewPolicies.length + 1;
  piReviewPolicies.push({ id: newId, code: `RC-NEW-${String(idx).padStart(2,'0')}`, name: 'New Control', description: '', category: 'policy', csfFunction: 'govern', sourceFile: 'Manual', sourcePages: '', linkedRequirements: [] });
  piRender();
  setTimeout(() => piEditPolicy(newId), 100);
}
window.piAddControl = piAddControl;

function piDiscard() { piBackToCollections(); }
window.piDiscard = piDiscard;

function piRegenerate() {
  piPhase = 'generating';
  piRender();
  // Re-run extraction with the same config
  piRunExtraction(piSelectedCollectionId, piCurrentConfig);
}
window.piRegenerate = piRegenerate;

function piShowYamlPreviewModal(yamlText, filename) {
  document.querySelector('.pi-yaml-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'pi-yaml-preview-overlay';
  const safeName = esc(filename || 'library.yaml');
  overlay.innerHTML = `
    <div class="pi-yaml-preview-dialog">
      <div class="pi-yaml-preview-header">
        <div>
          <div class="pi-yaml-preview-title">Library YAML preview</div>
          <div class="pi-yaml-preview-subtitle">${safeName} — same shape as GRC stored-libraries upload (YAML-serialized).</div>
        </div>
        <div class="pi-yaml-preview-header-actions">
          <button type="button" class="pi-btn pi-btn-preview-yaml-copy">Copy</button>
          <button type="button" class="pi-yaml-preview-close" aria-label="Close">&times;</button>
        </div>
      </div>
      <pre class="pi-yaml-preview-pre"></pre>
    </div>`;
  overlay.querySelector('.pi-yaml-preview-pre').textContent = yamlText || '';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.pi-yaml-preview-close').addEventListener('click', close);
  overlay.querySelector('.pi-btn-preview-yaml-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(yamlText || '');
      toast('success', 'Copied', 'YAML copied to clipboard.');
    } catch (e) {
      toast('error', 'Copy failed', e.message || 'Could not copy');
    }
  });
  document.body.appendChild(overlay);
}

async function piPreviewYaml() {
  if (!piSelectedCollectionId) return;
  const genType = piGenerationResult?.generationType || piCurrentConfig?.generationType || 'both';
  const payload = { folder: piCurrentConfig.folder || '' };
  if (genType === 'controls' || genType === 'both') payload.policies = piReviewPolicies;
  if (genType === 'framework' || genType === 'both') payload.requirementNodes = piReviewNodes;

  const btns = document.querySelectorAll('.pi-btn-preview-yaml');
  btns.forEach(b => { b.disabled = true; b.dataset._o = b.innerHTML; b.innerHTML = '…'; });
  try {
    const res = await fetch(`${PI_API}/${piSelectedCollectionId}/preview-library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
    piShowYamlPreviewModal(data.data.yaml, data.data.filename);
  } catch (err) {
    toast('error', 'Preview failed', err.message);
  } finally {
    btns.forEach(b => { b.disabled = false; if (b.dataset._o) b.innerHTML = b.dataset._o; });
  }
}
window.piPreviewYaml = piPreviewYaml;

async function piHistPreviewYaml() {
  const entry = piHistCurrentEntry();
  if (!entry) return;
  const collId = entry.collectionId || piSelectedCollectionId;
  if (!collId) return;
  const genType = entry.generationType || 'both';
  const ex = entry.extractionData || {};
  const payload = { folder: (entry.config && entry.config.folder) || '' };
  if (genType === 'controls' || genType === 'both') payload.policies = ex.policies || [];
  if (genType === 'framework' || genType === 'both') payload.requirementNodes = ex.requirementNodes || [];

  const btns = document.querySelectorAll('.pi-hist-preview-yaml');
  btns.forEach(b => { b.disabled = true; b.dataset._o = b.innerHTML; b.innerHTML = '…'; });
  try {
    const res = await fetch(`${PI_API}/${collId}/history/${entry.id}/preview-library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
    piShowYamlPreviewModal(data.data.yaml, data.data.filename);
  } catch (err) {
    toast('error', 'Preview failed', err.message);
  } finally {
    btns.forEach(b => { b.disabled = false; if (b.dataset._o) b.innerHTML = b.dataset._o; });
  }
}
window.piHistPreviewYaml = piHistPreviewYaml;

async function piApprove() {
  if (!piSelectedCollectionId) return;
  const genType = piGenerationResult?.generationType || piCurrentConfig?.generationType || 'both';
  const folder = piCurrentConfig.folder || '';

  // Set approve buttons to loading state
  document.querySelectorAll('.pi-btn-approve').forEach(btn => {
    btn.disabled = true;
    btn.dataset.origHtml = btn.innerHTML;
    btn.innerHTML = '<svg class="pi-spin" width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><path d="M10 2A8 8 0 0 1 18 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Uploading…';
  });

  try {
    toast('info', 'Approving…', 'Uploading library to GRC platform…');

    const approveBody = { folder, generationType: genType };
    if (genType === 'controls' || genType === 'both') {
      approveBody.policies = piReviewPolicies;
    }
    if (genType === 'framework' || genType === 'both') {
      approveBody.requirementNodes = piReviewNodes;
    }

    const res = await fetch(`${PI_API}/${piSelectedCollectionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(approveBody),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Approve failed');

    const coll = piCollections.find(c => c.id === piSelectedCollectionId);
    if (coll) {
      coll.status = 'approved';
      coll.generatedPoliciesCount = genType === 'framework' ? piReviewNodes.length : piReviewPolicies.length;
      coll.lastUpdated = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    if (data.data.libraryCreated) {
      const rcCount = data.data.created || 0;
      const rcMsg = rcCount > 0 ? ` ${rcCount} reference controls verified.` : '';
      toast('success', 'Library Created!', `Library uploaded to GRC successfully.${rcMsg} Applied controls can be added manually in the GRC platform.`);
    } else {
      toast('error', 'Library Error', data.data.libraryError || 'Failed to upload library to GRC.');
    }

    // Invalidate history cache after approve
    if (piSelectedCollectionId) delete piHistoryCache[piSelectedCollectionId];
    piPhase = 'success';
    piRender();
  } catch (err) {
    toast('error', 'Approve Error', err.message);
    // Restore approve buttons
    document.querySelectorAll('.pi-btn-approve').forEach(btn => {
      btn.disabled = false;
      if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml;
    });
  }
}
window.piApprove = piApprove;

// ─── Success Screen ────────────────────────────────────
function piRenderSuccess() {
  if (!piGenerationResult) return '';
  const r = piGenerationResult;
  const genType = r.generationType || 'both';
  const isFramework = genType === 'framework';
  const isBoth = genType === 'both';
  const hasControls = genType === 'controls' || isBoth;

  const controlsCount = piReviewPolicies.length;
  const nodesCount = piReviewNodes.length;

  const successTitle = isFramework ? 'Framework library created successfully!'
    : isBoth ? 'Full library created successfully!'
    : 'Controls library created successfully!';
  const successDesc = isFramework
    ? 'Your documents have been converted into a compliance framework for assessments'
    : isBoth ? 'Your documents have been converted into a framework + reference controls with applied policies'
    : 'Your documents have been converted into reference controls and applied policies';
  const genTypeLabel = isFramework ? 'Policy Framework' : isBoth ? 'Framework + Reference Controls' : 'Reference Controls';

  const infoText = isFramework
    ? `The framework library has been created under Governance → Libraries with ${nodesCount} requirement nodes. You can now use this framework for compliance assessments.`
    : isBoth
    ? `The library has been created under Governance → Libraries with ${nodesCount} requirement nodes and ${controlsCount} reference controls. ${controlsCount} policies have been generated under Governance → Policies.`
    : `The library has been created under Governance → Libraries, and ${controlsCount} reference controls have been generated as policies under Governance → Policies. You can now audit these policies and link them to requirement assessments.`;

  return `
    <div class="pi-header">
      <div class="pi-header-left">
        <div class="pi-header-title"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/><path d="M5 8H10M5 10.5H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><h1>Organization Policy Ingestion</h1></div>
      </div>
    </div>
    <div class="pi-success-card">
      <div class="pi-success-banner" ${isFramework ? 'style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%)"' : ''}>
        <h3><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="white" stroke-width="1.5"/><path d="M5 8L7 10L11 6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ${successTitle}</h3>
        <p>${successDesc}</p>
      </div>
      <div class="pi-success-body" style="text-align:center">
        <div class="pi-success-icon"><svg width="32" height="32" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#059669" stroke-width="1.5"/><path d="M5 8L7 10L11 6" stroke="#059669" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>

        <div class="pi-success-stats">
          ${hasControls ? `<div class="pi-success-stat pi-success-stat-green"><div class="pi-success-stat-val">${controlsCount}</div><div class="pi-success-stat-label">Reference Controls</div></div>` : ''}
          ${(isFramework || isBoth) ? `<div class="pi-success-stat pi-success-stat-blue"><div class="pi-success-stat-val">${nodesCount}</div><div class="pi-success-stat-label">Requirement Nodes</div></div>` : ''}
          <div class="pi-success-stat pi-success-stat-gray"><div class="pi-success-stat-val">${r.sourceFileCount}</div><div class="pi-success-stat-label">Source Files</div></div>
        </div>

        <div class="pi-success-details">
          <div class="pi-success-detail-row"><span class="label">Library Name</span><span class="value">${esc(r.libraryName)}</span></div>
          <div class="pi-success-detail-row"><span class="label">Generation Type</span><span class="value">${genTypeLabel}</span></div>
          ${hasControls ? `<div class="pi-success-detail-row"><span class="label">Policies Created</span><span class="value">${controlsCount}</span></div>` : ''}
          <div class="pi-success-detail-row"><span class="label">Confidence Score</span><span class="value" style="color:#059669">${r.confidenceScore}%</span></div>
        </div>

        <div class="pi-success-info"><p>${infoText}</p></div>

        <div class="pi-success-actions">
          <button class="btn-admin-primary"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.5"/></svg> View Library in Governance</button>
          ${hasControls ? `<button class="pi-btn pi-btn-view"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2H10L13 5V13C13 13.6 12.6 14 12 14H3C2.4 14 2 13.6 2 13V3C2 2.4 2.4 2 3 2Z" stroke="currentColor" stroke-width="1.3"/></svg> View Policies</button>` : ''}
          <button class="pi-btn pi-btn-view" onclick="piBackToCollections()"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2V12M2 7H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Generate More</button>
        </div>

        <button class="pi-success-back" onclick="piBackToCollections()"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L3 6L8 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Back to Admin</button>
      </div>
    </div>`;
}

// ─── Workbench ────────────────────────────────────────────────

let wbAdminUser = 'admin';
(async function fetchAdminIdentity() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data.username) wbAdminUser = data.username;
    }
  } catch (_) {}
})();

const MURAJI_API = 'https://muraji-api.wathbah.dev/api/libraries';
let wbLibraries = [];
let wbCurrentLibrary = null;
let wbCurrentNode = null;
let wbDirty = false;
let wbCurrentDetailView = 'tree';
let wbBulkAbort = false;

const NOTE_SUBTYPES = [
  { value: 'note', label: 'Note' },
  { value: 'auditor_comment', label: 'Auditor Comment' },
  { value: 'internal_guidance', label: 'Internal Guidance' },
  { value: 'historical_finding', label: 'Historical Finding' },
  { value: 'other', label: 'Other' }
];

const WB_AI_SERVICE_ACCOUNT = 'muraji-ai';

function makeAuditFields(existing) {
  const now = new Date().toISOString();
  if (existing) return { ...existing, updated_at: now, updated_by: wbAdminUser };
  return { created_at: now, created_by: wbAdminUser, updated_at: now, updated_by: wbAdminUser };
}

function makeAiAuditFields() {
  const now = new Date().toISOString();
  return { created_at: now, created_by: WB_AI_SERVICE_ACCOUNT, updated_at: now, updated_by: WB_AI_SERVICE_ACCOUNT };
}

const wbAuditLog = [];
function wbLogAudit(action, details) {
  wbAuditLog.push({
    timestamp: new Date().toISOString(),
    actor: details.actor || wbAdminUser,
    triggered_by: details.triggered_by || wbAdminUser,
    action,
    requirement_urn: details.urn || (wbCurrentNode && wbCurrentNode.urn) || null,
    item_type: details.item_type || null,
    item_id: details.item_id || null,
    summary: details.summary || null,
    before: details.before || null,
    snapshot: details.snapshot || null,
    count: details.count || null
  });
}

// CISO's RA edit page renders the input widget off `question.type` and only
// recognises `unique_choice` | `multiple_choice` | `date` | `text`. Earlier
// versions of this admin wrote the literal string `'question'` (our internal
// item_type) into that field, which caused CISO to render an empty card.
// Normalise here so legacy rows are healed the next time they're touched.
const CISO_VALID_QUESTION_TYPES = new Set(['unique_choice', 'multiple_choice', 'date', 'text']);
function normalizeQuestionType(q) {
  if (q && CISO_VALID_QUESTION_TYPES.has(q.type)) return q.type;
  return Array.isArray(q && q.choices) && q.choices.length > 1 ? 'unique_choice' : 'text';
}

function migrateQuestionItem(qUrn, q, idx) {
  return {
    ...q,
    type: normalizeQuestionType(q),
    item_type: 'question',
    content_ar: q.content_ar || q.text || '',
    content_en: q.content_en || '',
    included_in_ai_scope: q.included_in_ai_scope !== undefined ? q.included_in_ai_scope : (q.excluded !== true),
    provenance: q.provenance || 'manual',
    generation_metadata: q.generation_metadata || null,
    created_at: q.created_at || null,
    created_by: q.created_by || null,
    updated_at: q.updated_at || null,
    updated_by: q.updated_by || null,
    display_order: q.display_order !== undefined ? q.display_order : idx
  };
}

function migrateEvidenceFromText(text) {
  if (!text) return [];
  return text.split('\n').filter(l => l.trim()).map((line, idx) => {
    let l = line.replace(/^-\s*/, '').trim();
    let excluded = false;
    if (l.startsWith('[EXCLUDED] ')) { excluded = true; l = l.substring(11); }
    const colonIdx = l.indexOf(':');
    let title = '', description = l;
    if (colonIdx > 0 && colonIdx < 80) { title = l.substring(0, colonIdx).trim(); description = l.substring(colonIdx + 1).trim(); }
    return {
      id: idx, title, description,
      item_type: 'typical_evidence',
      content_ar: description,
      content_en: '',
      excluded: excluded,
      included_in_ai_scope: !excluded,
      provenance: 'manual',
      generation_metadata: null,
      created_at: null, created_by: null, updated_at: null, updated_by: null,
      display_order: idx
    };
  });
}

function migrateNoteItem(note, idx) {
  return {
    ...note,
    item_type: 'admin_note',
    subtype: note.subtype || 'note',
    subtype_label: note.subtype_label || '',
    content_ar: note.content_ar || note.text || '',
    content_en: note.content_en || '',
    included_in_ai_scope: note.included_in_ai_scope !== undefined ? note.included_in_ai_scope : false,
    provenance: note.provenance || 'manual',
    generation_metadata: note.generation_metadata || null,
    created_at: note.created_at || note.date || null,
    created_by: note.created_by || null,
    updated_at: note.updated_at || note.date || null,
    updated_by: note.updated_by || null,
    display_order: note.display_order !== undefined ? note.display_order : idx
  };
}

function getEvidenceItems(node) {
  if (Array.isArray(node.typical_evidence_items) && node.typical_evidence_items.length) {
    return node.typical_evidence_items.map((it, idx) => migrateEvidenceItem(it, idx));
  }
  return migrateEvidenceFromText(node.typical_evidence);
}

function migrateEvidenceItem(it, idx) {
  const inScope = it.included_in_ai_scope !== undefined ? it.included_in_ai_scope : (it.excluded !== true);
  return {
    ...it,
    item_type: 'typical_evidence',
    content_ar: it.content_ar || it.description || '',
    content_en: it.content_en || '',
    excluded: !inScope,
    included_in_ai_scope: inScope,
    provenance: it.provenance || 'manual',
    generation_metadata: it.generation_metadata || null,
    created_at: it.created_at || null, created_by: it.created_by || null,
    updated_at: it.updated_at || null, updated_by: it.updated_by || null,
    display_order: it.display_order !== undefined ? it.display_order : idx
  };
}

function getOrderedItems(node) {
  const questions = node.questions ? Object.entries(node.questions).map(([qUrn, q], idx) => {
    const m = migrateQuestionItem(qUrn, q, idx);
    return { ...m, _urn: qUrn };
  }) : [];
  const evidence = getEvidenceItems(node).map(e => ({ ...e, item_type: 'typical_evidence' }));
  const notes = (node.admin_notes || []).map((n, i) => migrateNoteItem(n, i));
  return [...questions, ...evidence, ...notes].sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));
}

function evidenceItemsToTextLegacy(items) {
  return items.map(it => {
    const prefix = !it.included_in_ai_scope ? '[EXCLUDED] ' : '';
    if (it.title) return `- ${prefix}${it.title}: ${it.content_ar || it.description || ''}`;
    return `- ${prefix}${it.content_ar || it.description || ''}`;
  }).join('\n');
}

function subtypeBadgeLabel(subtype, label) {
  const found = NOTE_SUBTYPES.find(s => s.value === subtype);
  if (subtype === 'other' && label) return label;
  return found ? found.label : 'Note';
}

function provenanceBadge(prov) {
  if (prov === 'ai_generated') return '<span class="wb-badge wb-badge-ai">AI</span>';
  return '<span class="wb-badge wb-badge-manual">Manual</span>';
}

function formatTimestamp(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch(_) { return ts; }
}

const wbIconEye = '<svg width="18" height="18" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 7C1 7 3 3 7 3C11 3 13 7 13 7C13 7 11 11 7 11C3 11 1 7 1 7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.5"/></svg>';
const wbIconEyeOff = '<svg width="18" height="18" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 7C1 7 3 3 7 3C11 3 13 7 13 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2 12L12 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function wbShowView(view) {
  document.getElementById('wb-content').style.display = view === 'grid' ? '' : 'none';
  const isDetail = (view === 'tree' || view === 'status');
  document.getElementById('wb-detail').style.display = isDetail ? '' : 'none';
  document.getElementById('wb-req-detail').style.display = view === 'req' ? '' : 'none';
  if (isDetail) {
    wbCurrentDetailView = view;
    const treeCont = document.getElementById('wb-tree-container');
    const statusCont = document.getElementById('wb-status-container');
    const searchWrap = document.getElementById('wb-search-bar-wrap');
    treeCont.style.display = view === 'tree' ? '' : 'none';
    statusCont.style.display = view === 'status' ? '' : 'none';
    if (searchWrap) searchWrap.style.display = view === 'tree' ? '' : 'none';
    document.querySelectorAll('.wb-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  }
}

let legislativeInternalPageWired = false;
/** @type {Array<Record<string, unknown>>} */
let luInternalSourcesCache = [];

const LU_ICON_PREVIEW =
  '<svg class="lu-preview-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s4.2-7 10-7 10 7 10 7-4.2 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/></svg>';
const LU_ICON_EDIT =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.84058 2.85709L13.1432 7.15979L4.45285 15.8501H0.150146V11.5474L8.84058 2.85709Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M11.25 1.75L14.25 4.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const LU_ICON_TRASH =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3.5a1.5 1.5 0 0 1 1.5-1.5h0a1.5 1.5 0 0 1 1.5 1.5v1M12.5 4.5v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V4.5M6.5 7v4M9.5 7v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function luBuildDocPreviewCell(href, fileName) {
  if (!href)
    return '<span class="lu-action-preview-placeholder" title="No preview available">—</span>';
  const safeName = fileName ? String(fileName).replace(/"/g, '') : '';
  const t = safeName ? `Preview “${safeName}” in new tab` : 'Preview document in new tab';
  return `<a class="lu-doc-open lu-doc-open--preview lu-action-preview" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t)}">${LU_ICON_PREVIEW}<span class="visually-hidden">Preview document</span></a>`;
}

function openLuAddModal() {
  const o = document.getElementById('lu-add-modal-overlay');
  if (!o) return;
  document.getElementById('lu-input-name').value = '';
  document.getElementById('lu-input-description').value = '';
  document.getElementById('lu-input-file').value = '';
  const err = document.getElementById('lu-modal-error');
  if (err) {
    err.textContent = '';
    err.style.display = 'none';
  }
  o.classList.add('active');
  o.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeLuAddModal() {
  const o = document.getElementById('lu-add-modal-overlay');
  if (!o) return;
  o.classList.remove('active');
  o.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const submit = document.getElementById('lu-add-modal-submit');
  if (submit) {
    const btnText = submit.querySelector('.btn-text');
    const loading = document.getElementById('lu-add-modal-loading');
    if (btnText) btnText.classList.remove('hidden');
    if (loading) loading.classList.add('hidden');
    submit.disabled = false;
  }
}

function luFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result;
      const i = typeof s === 'string' ? s.indexOf(',') : -1;
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    r.onerror = () => reject(new Error('Failed to read file'));
    r.readAsDataURL(file);
  });
}

function openLuEditModal(id) {
  const row = luInternalSourcesCache.find((s) => s.id === id);
  const o = document.getElementById('lu-edit-modal-overlay');
  if (!row || !o) return;
  document.getElementById('lu-edit-input-id').value = String(row.id);
  document.getElementById('lu-edit-input-name').value = String(row.name || '');
  document.getElementById('lu-edit-input-description').value = String(
    row.description != null ? row.description : '',
  );
  const hint = document.getElementById('lu-edit-file-hint');
  if (hint) hint.textContent = row.original_file_name ? String(row.original_file_name) : '—';
  const err = document.getElementById('lu-edit-modal-error');
  if (err) {
    err.textContent = '';
    err.style.display = 'none';
  }
  o.classList.add('active');
  o.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeLuEditModal() {
  const o = document.getElementById('lu-edit-modal-overlay');
  if (!o) return;
  o.classList.remove('active');
  o.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const submit = document.getElementById('lu-edit-modal-submit');
  if (submit) {
    const btnText = submit.querySelector('.btn-text');
    const loading = document.getElementById('lu-edit-modal-loading');
    if (btnText) btnText.classList.remove('hidden');
    if (loading) loading.classList.add('hidden');
    submit.disabled = false;
  }
}

async function luDeleteInternalSource(id) {
  const row = luInternalSourcesCache.find((s) => s.id === id);
  const label = row && row.name ? String(row.name) : 'this source';
  if (!window.confirm(`Delete “${label}”? The file will be removed from storage.`)) return;
  try {
    const res = await fetch(
      `/api/legislative-updates/internal-sources/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    toast('success', 'Deleted', 'Source removed.');
    loadLegislativeInternalSourcesList();
  } catch (e) {
    toast('error', 'Delete failed', e.message || String(e));
  }
}

function initLegislativeInternalPageListeners() {
  const addBtn = document.getElementById('lu-add-source-btn');
  const overlay = document.getElementById('lu-add-modal-overlay');
  const closeBtn = document.getElementById('lu-add-modal-close');
  const cancelBtn = document.getElementById('lu-add-modal-cancel');
  const submitBtn = document.getElementById('lu-add-modal-submit');
  const editOverlay = document.getElementById('lu-edit-modal-overlay');
  const editClose = document.getElementById('lu-edit-modal-close');
  const editCancel = document.getElementById('lu-edit-modal-cancel');
  const editSubmit = document.getElementById('lu-edit-modal-submit');
  const tableWrap = document.getElementById('lu-internal-table-wrap');

  if (addBtn) addBtn.addEventListener('click', () => openLuAddModal());
  if (closeBtn) closeBtn.addEventListener('click', () => closeLuAddModal());
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeLuAddModal());
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeLuAddModal();
    });
  }
  if (editClose) editClose.addEventListener('click', () => closeLuEditModal());
  if (editCancel) editCancel.addEventListener('click', () => closeLuEditModal());
  if (editOverlay) {
    editOverlay.addEventListener('click', (e) => {
      if (e.target === editOverlay) closeLuEditModal();
    });
  }
  if (tableWrap && !tableWrap.dataset.luAct) {
    tableWrap.dataset.luAct = '1';
    tableWrap.addEventListener('click', (e) => {
      const editBtn = e.target.closest('[data-lu-edit]');
      if (editBtn) {
        openLuEditModal(editBtn.getAttribute('data-lu-edit'));
        return;
      }
      const delBtn = e.target.closest('[data-lu-delete]');
      if (delBtn) luDeleteInternalSource(delBtn.getAttribute('data-lu-delete'));
    });
  }
  if (editSubmit) {
    editSubmit.addEventListener('click', async () => {
      const err = document.getElementById('lu-edit-modal-error');
      const idEl = document.getElementById('lu-edit-input-id');
      const id = idEl && idEl.value ? idEl.value.trim() : '';
      const name = document.getElementById('lu-edit-input-name').value.trim();
      const description = document.getElementById('lu-edit-input-description').value.trim();
      if (err) {
        err.style.display = 'none';
        err.textContent = '';
      }
      if (!id) return;
      if (!name) {
        if (err) {
          err.textContent = 'Name is required.';
          err.style.display = 'block';
        }
        return;
      }
      const btnText = editSubmit.querySelector('.btn-text');
      const loading = document.getElementById('lu-edit-modal-loading');
      if (btnText) btnText.classList.add('hidden');
      if (loading) loading.classList.remove('hidden');
      editSubmit.disabled = true;
      try {
        const res = await fetch(
          `/api/legislative-updates/internal-sources/${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description }),
          },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || res.statusText);
        closeLuEditModal();
        toast('success', 'Saved', 'Source updated.');
        loadLegislativeInternalSourcesList();
      } catch (e) {
        if (err) {
          err.textContent = e.message || String(e);
          err.style.display = 'block';
        }
      } finally {
        if (btnText) btnText.classList.remove('hidden');
        if (loading) loading.classList.add('hidden');
        editSubmit.disabled = false;
      }
    });
  }
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const err = document.getElementById('lu-modal-error');
      const name = document.getElementById('lu-input-name').value.trim();
      const description = document.getElementById('lu-input-description').value.trim();
      const fileInput = document.getElementById('lu-input-file');
      const file = fileInput.files && fileInput.files[0];
      err.style.display = 'none';
      err.textContent = '';
      if (!name) {
        err.textContent = 'Name is required.';
        err.style.display = 'block';
        return;
      }
      if (!file) {
        err.textContent = 'Please choose a file.';
        err.style.display = 'block';
        return;
      }
      const btnText = submitBtn.querySelector('.btn-text');
      const loading = document.getElementById('lu-add-modal-loading');
      if (btnText) btnText.classList.add('hidden');
      if (loading) loading.classList.remove('hidden');
      submitBtn.disabled = true;
      try {
        const data = await luFileToBase64(file);
        const res = await fetch('/api/legislative-updates/internal-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            data,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || json.hint || res.statusText);
        closeLuAddModal();
        toast('success', 'Uploaded', 'Source saved. Extracting policies…');
        loadLegislativeInternalSourcesList();
        // Trigger Gemini policy extraction in the background
        onPupPolicyFileSelected(file, 'internal-sources');
      } catch (e) {
        err.textContent = e.message || String(e);
        err.style.display = 'block';
      } finally {
        if (btnText) btnText.classList.remove('hidden');
        if (loading) loading.classList.add('hidden');
        submitBtn.disabled = false;
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const addO = document.getElementById('lu-add-modal-overlay');
    if (addO && addO.classList.contains('active')) closeLuAddModal();
    const editO = document.getElementById('lu-edit-modal-overlay');
    if (editO && editO.classList.contains('active')) closeLuEditModal();
  });
}

// ─── Internal Sources tabs ─────────────────────────────────────────────────

let luIsActiveTab = 'files';

function showLuIsTab(tab) {
  luIsActiveTab = tab;
  const tabs = document.querySelectorAll('.lu-is-tab');
  tabs.forEach(btn => {
    const on = btn.getAttribute('data-lu-is-tab') === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const filesPanel = document.getElementById('lu-is-panel-files');
  const policiesPanel = document.getElementById('lu-is-panel-policies');
  if (filesPanel)    { filesPanel.hidden    = tab !== 'files';    }
  if (policiesPanel) { policiesPanel.hidden = tab !== 'policies'; }

  if (tab === 'policies') loadLuExtractedRegulations();
}

function initLuIsTabs() {
  document.querySelectorAll('.lu-is-tab').forEach(btn => {
    btn.addEventListener('click', () => showLuIsTab(btn.getAttribute('data-lu-is-tab')));
  });
}

async function loadLuExtractedRegulations() {
  const loadEl  = document.getElementById('lu-ep-loading');
  const emptyEl = document.getElementById('lu-ep-empty');
  const gridEl  = document.getElementById('lu-ep-grid');
  const errEl   = document.getElementById('lu-ep-error');
  if (!gridEl) return;

  if (loadEl)  { loadEl.style.display = 'flex'; }
  if (emptyEl) { emptyEl.style.display = 'none'; }
  if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
  gridEl.innerHTML = '';

  try {
    const res  = await fetch('/api/ai-tools/extracted-regulations');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);

    if (loadEl) loadEl.style.display = 'none';
    const records = json.data || [];

    // Update tab badge
    const totalArticles = records.reduce((s, r) => s + (r.articles ? r.articles.length : 0), 0);
    const badge = document.getElementById('lu-is-tab-policies-count');
    if (badge) badge.textContent = totalArticles > 0 ? String(totalArticles) : '';

    if (!records.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    // Store raw data for the modal
    window._luEpRecords = records;

    gridEl.innerHTML = records.map((record, idx) => {
      const dateStr  = record.createdAt ? new Date(record.createdAt).toLocaleString() : '—';
      const fileName = record.sourceFile || 'Unknown file';
      const articles = Array.isArray(record.articles) ? record.articles : [];
      const articleItems = articles.map((a, ai) => {
        const uid = `acc-${idx}-${ai}`;
        return `<div class="lu-acc-item" id="${uid}">
          <button type="button" class="lu-acc-trigger" onclick="toggleLuAccItem('${uid}')" aria-expanded="false">
            <span class="lu-ep-article-label">${esc(a.article || '')}</span>
            <span class="lu-acc-title">${esc(a.title || '')}</span>
            <svg class="lu-acc-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="lu-acc-body" hidden>
            <p class="lu-ep-policy-content">${esc(a.text || '')}</p>
          </div>
        </div>`;
      }).join('');

      const groupId = `lu-group-${idx}`;
      return `<div class="lu-ep-group" id="${groupId}">
        <button type="button" class="lu-ep-group-header lu-ep-group-toggle" onclick="toggleLuGroup('${groupId}')" aria-expanded="false">
          <div class="lu-ep-group-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1zm0 0v4h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div class="lu-ep-group-meta">
            <div class="lu-ep-group-file" title="${esc(fileName)}">${esc(fileName)}</div>
            <div class="lu-ep-group-date">${esc(dateStr)}</div>
          </div>
          <span class="lu-ep-group-badge">${articles.length} article${articles.length === 1 ? '' : 's'}</span>
          <svg class="lu-ep-group-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="lu-ep-group-body" hidden>
          <div class="lu-acc-list">${articleItems || '<p style="padding:12px 16px;font-size:12px;color:#94a3b8">No articles in this extraction.</p>'}</div>
          <div class="lu-ep-group-actions">
            <button class="lu-ep-raw-btn" onclick="openLuRawModal(${idx})">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5 3L1 8l4 5M11 3l4 5-4 5M9 2l-2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              Raw data
            </button>
          </div>
        </div>
      </div>`;
    }).join('');

    // Wire raw data modal close on overlay click
    const rawOverlay = document.getElementById('lu-raw-modal-overlay');
    if (rawOverlay) {
      rawOverlay.onclick = e => { if (e.target === rawOverlay) closeLuRawModal(); };
    }

  } catch (e) {
    if (loadEl)  loadEl.style.display  = 'none';
    if (errEl)   { errEl.textContent = e.message || String(e); errEl.style.display = 'block'; }
  }
}

function toggleLuGroup(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  const btn  = group.querySelector('.lu-ep-group-toggle');
  const body = group.querySelector('.lu-ep-group-body');
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  body.hidden = open;
  group.classList.toggle('is-open', !open);
}

function toggleLuAccItem(uid) {
  const item    = document.getElementById(uid);
  if (!item) return;
  const trigger = item.querySelector('.lu-acc-trigger');
  const body    = item.querySelector('.lu-acc-body');
  const open    = trigger.getAttribute('aria-expanded') === 'true';
  trigger.setAttribute('aria-expanded', String(!open));
  body.hidden = open;
  item.classList.toggle('is-open', !open);
}

function openLuRawModal(idx) {
  const records = window._luEpRecords || [];
  const record  = records[idx];
  if (!record) return;
  const overlay = document.getElementById('lu-raw-modal-overlay');
  const pre     = document.getElementById('lu-raw-modal-pre');
  const title   = document.getElementById('lu-raw-modal-title');
  if (!overlay || !pre) return;
  if (title) title.textContent = record.sourceFile || 'Raw extracted regulation';
  pre.textContent = JSON.stringify(record.articles || record.policies, null, 2);
  overlay.classList.add('active');
}

function closeLuRawModal() {
  const overlay = document.getElementById('lu-raw-modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

async function loadLegislativeInternalSourcesList() {
  const loadEl = document.getElementById('lu-internal-loading');
  const emptyEl = document.getElementById('lu-internal-empty');
  const wrap = document.getElementById('lu-internal-table-wrap');
  const tbody = document.getElementById('lu-internal-tbody');
  const errEl = document.getElementById('lu-internal-error');
  if (!loadEl || !tbody) return;
  if (errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }
  loadEl.style.display = 'flex';
  if (emptyEl) emptyEl.style.display = 'none';
  if (wrap) wrap.style.display = 'none';
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/legislative-updates/internal-sources');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    loadEl.style.display = 'none';
    const sources = json.sources || [];
    luInternalSourcesCache = sources;
    const filesBadge = document.getElementById('lu-is-tab-files-count');
    if (filesBadge) filesBadge.textContent = sources.length > 0 ? String(sources.length) : '';
    if (!sources.length) {
      if (emptyEl) {
        emptyEl.style.display = 'flex';
      }
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (wrap) wrap.style.display = 'block';
    tbody.innerHTML = sources
      .map((s) => {
        const dateStr = s.created_at ? new Date(s.created_at).toLocaleString() : '—';
        const href = s.download_url ? String(s.download_url) : '';
        const sid = escapeHtml(String(s.id));
        const fname = s.original_file_name ? String(s.original_file_name) : '';
        return `<tr class="lu-data-row" data-lu-id="${sid}">
        <td class="lu-col-name"><span class="lu-cell-name">${escapeHtml(s.name)}</span></td>
        <td class="lu-desc lu-col-desc">${escapeHtml(s.description || '') || '<span class="lu-desc-empty">—</span>'}</td>
        <td class="lu-col-user lu-cell-muted">${escapeHtml(s.uploaded_by || '—')}</td>
        <td class="lu-col-date lu-cell-muted">${escapeHtml(dateStr)}</td>
        <td class="lu-col-actions"><div class="lu-row-actions">
          <button type="button" class="lu-icon-btn" data-lu-edit="${sid}" aria-label="Edit source">${LU_ICON_EDIT}</button>
          <button type="button" class="lu-icon-btn lu-icon-btn--danger" data-lu-delete="${sid}" aria-label="Delete source">${LU_ICON_TRASH}</button>
          ${luBuildDocPreviewCell(href, fname)}
        </div></td>
      </tr>`;
      })
      .join('');
  } catch (e) {
    loadEl.style.display = 'none';
    luInternalSourcesCache = [];
    if (errEl) {
      errEl.textContent = e.message || String(e);
      errEl.style.display = 'block';
    }
  }
}

function loadLegislativeExternalSourcesPage() {
  /* Static placeholder until connectors ship */
}

let pcfgTabsWired = false;

function showPcfgTab(slug, pushHistory) {
  const tab = slug === 'default-org' ? 'default-org' : 'impact';
  const pageRoot = document.getElementById('page-pipeline-configuration');
  if (!pageRoot) return;
  pageRoot.querySelectorAll('[data-pcfg-tab]').forEach((btn) => {
    const on = btn.getAttribute('data-pcfg-tab') === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const impactPanel = document.getElementById('pcfg-panel-impact');
  const orgPanel = document.getElementById('pcfg-panel-default-org');
  if (impactPanel) {
    const show = tab === 'impact';
    impactPanel.hidden = !show;
    impactPanel.style.display = show ? '' : 'none';
  }
  if (orgPanel) {
    const show = tab === 'default-org';
    orgPanel.hidden = !show;
    orgPanel.style.display = show ? '' : 'none';
    if (show) loadPcfgDefaultOrgPanel();
  }
  if (pushHistory && currentPage === 'pipeline-configuration') {
    if (tab === 'default-org') updateRoute('pipeline-configuration', 'default-org');
    else updateRoute('pipeline-configuration', null);
  }
}

const PCFG_DEFAULT_ORG_KEY = 'wathba_default_pipeline_org';

function getPcfgDefaultOrgId() {
  try { return localStorage.getItem(PCFG_DEFAULT_ORG_KEY) || ''; } catch { return ''; }
}

function setPcfgDefaultOrgId(id) {
  try {
    if (id) localStorage.setItem(PCFG_DEFAULT_ORG_KEY, id);
    else localStorage.removeItem(PCFG_DEFAULT_ORG_KEY);
  } catch { /* ignore */ }
}

async function loadPcfgDefaultOrgPanel() {
  const listEl   = document.getElementById('pcfg-org-list');
  const loadEl   = document.getElementById('pcfg-org-loading');
  const emptyEl  = document.getElementById('pcfg-org-empty');
  if (!listEl) return;

  if (loadEl)  { loadEl.style.display = 'flex'; }
  if (emptyEl) { emptyEl.style.display = 'none'; }
  listEl.innerHTML = '';

  let orgs = [];
  try {
    const d = await fetchJSON(API.orgContexts);
    orgs = Array.isArray(d.contexts) ? d.contexts : [];
  } catch (e) {
    if (loadEl) loadEl.style.display = 'none';
    listEl.innerHTML = `<p style="color:#ef4444;font-size:13px">Failed to load organisations: ${esc(e.message)}</p>`;
    return;
  }

  if (loadEl) loadEl.style.display = 'none';

  if (!orgs.length) {
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }

  const currentDefault = getPcfgDefaultOrgId();

  listEl.innerHTML = orgs.map(org => {
    const id      = String(org.id || '');
    const name    = org.nameEn || org.name || 'Untitled';
    const sector  = org.sector || org.sectorCustom || '';
    const country = org.country || org.geographic_scope || '';
    const isDefault = id && id === currentDefault;
    const initials = name.split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

    return `<div class="pcfg-org-card${isDefault ? ' is-default' : ''}" data-org-id="${esc(id)}">
      <div class="pcfg-org-avatar">${esc(initials)}</div>
      <div class="pcfg-org-info">
        <div class="pcfg-org-name">${esc(name)}</div>
        ${sector || country ? `<div class="pcfg-org-meta">${[sector, country].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      </div>
      ${isDefault
        ? `<span class="pcfg-org-badge-default">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Default
          </span>`
        : `<button class="pcfg-org-set-default-btn" onclick="onSetPcfgDefaultOrg('${esc(id)}')">Set as default</button>`
      }
    </div>`;
  }).join('');
}

function onSetPcfgDefaultOrg(id) {
  setPcfgDefaultOrgId(id);
  loadPcfgDefaultOrgPanel();
  toast('success', 'Default organisation set', 'This org will be pre-selected in the pipeline.');
}

function loadPipelineConfigurationPage() {
  const slug = currentSubId === 'default-org' ? 'default-org' : 'impact';
  showPcfgTab(slug, false);

  const pageRoot = document.getElementById('page-pipeline-configuration');
  if (!pageRoot) return;
  if (!pcfgTabsWired) {
    pcfgTabsWired = true;
    pageRoot.querySelectorAll('[data-pcfg-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-pcfg-tab');
        showPcfgTab(t === 'default-org' ? 'default-org' : 'impact', true);
      });
    });
  }
}

function loadLegislativeInternalSourcesPage() {
  if (!legislativeInternalPageWired) {
    legislativeInternalPageWired = true;
    initLegislativeInternalPageListeners();
    initLuIsTabs();
  }
  showLuIsTab('files');
  loadLegislativeInternalSourcesList();
}

async function loadWorkbench(subId) {
  if (subId) {
    await loadWorkbenchDetail(subId);
  } else {
    wbShowView('grid');
    await loadWorkbenchFrameworks();
  }
}

async function loadWorkbenchFrameworks() {
  const grid = document.getElementById('wb-frameworks-grid');
  const loading = document.getElementById('wb-frameworks-loading');
  grid.innerHTML = '';
  loading.style.display = 'flex';
  try {
    const res = await fetch(MURAJI_API);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const json = await res.json();
    wbLibraries = json.data || json;
    loading.style.display = 'none';
    if (!wbLibraries.length) {
      grid.innerHTML = '<div class="wb-empty"><p>No frameworks found.</p></div>';
      return;
    }
    grid.innerHTML = wbLibraries.map(lib => {
      const fw = (lib.content && lib.content.framework) || lib.framework || {};
      const reqCount = (fw.requirement_nodes || []).length;
      const assessableCount = (fw.requirement_nodes || []).filter(n => n.assessable).length;
      const questionsCount = (fw.requirement_nodes || []).reduce((sum, n) => sum + Object.keys(n.questions || {}).length, 0);
      return `<div class="wb-framework-card" data-lib-id="${lib._id || lib.id}">
        <div class="wb-card-header">
          <span class="wb-card-tab">${escapeHtml(fw.tab || fw.ref_id || '')}</span>
        </div>
        <h3 class="wb-card-title">${escapeHtml(fw.name || lib.name || 'Unnamed Framework')}</h3>
        <p class="wb-card-ref">${escapeHtml(fw.ref_id || '')}</p>
        <p class="wb-card-desc">${escapeHtml((fw.description || lib.description || '').substring(0, 150))}${(fw.description || lib.description || '').length > 150 ? '...' : ''}</p>
        <div class="wb-card-stats">
          <span class="wb-stat"><strong>${reqCount}</strong> nodes</span>
          <span class="wb-stat"><strong>${assessableCount}</strong> assessable</span>
          <span class="wb-stat"><strong>${questionsCount}</strong> questions</span>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.wb-framework-card').forEach(card => {
      card.addEventListener('click', () => {
        const libId = card.dataset.libId;
        navigateTo('workbench', true, libId);
      });
    });
  } catch (e) {
    loading.style.display = 'none';
    grid.innerHTML = `<div class="wb-empty"><p>Failed to load frameworks: ${escapeHtml(e.message)}</p></div>`;
  }
}

async function loadWorkbenchDetail(libId) {
  wbShowView('tree');

  let lib = wbLibraries.find(l => (l._id || l.id) === libId);
  if (!lib) {
    try {
      const res = await fetch(MURAJI_API);
      if (res.ok) {
        const json = await res.json();
        wbLibraries = json.data || json;
        lib = wbLibraries.find(l => (l._id || l.id) === libId);
      }
    } catch (_) {}
  }
  if (!lib) {
    document.getElementById('wb-tree-container').innerHTML = '<div class="wb-empty"><p>Framework not found.</p></div>';
    return;
  }
  wbCurrentLibrary = lib;
  const fw = (lib.content && lib.content.framework) || lib.framework || {};
  document.getElementById('wb-detail-title').textContent = fw.name || 'Framework';
  document.getElementById('wb-detail-subtitle').textContent = fw.description || '';
  const assessableCount = (fw.requirement_nodes || []).filter(n => n.assessable).length;
  const questionsCount = (fw.requirement_nodes || []).reduce((sum, n) => sum + Object.keys(n.questions || {}).length, 0);
  document.getElementById('wb-detail-meta').innerHTML = `
    <span class="wb-meta-chip">${escapeHtml(fw.ref_id || '')}</span>
    <span class="wb-meta-chip">${assessableCount} assessable</span>
    <span class="wb-meta-chip">${questionsCount} questions</span>`;

  document.getElementById('wb-back-btn').onclick = () => navigateTo('workbench', true, null);

  const searchInput = document.getElementById('wb-search-input');
  searchInput.value = '';
  searchInput.oninput = () => renderWbTree(fw.requirement_nodes || [], searchInput.value.trim().toLowerCase());

  document.getElementById('wb-view-tree-btn').onclick = () => { wbShowView('tree'); };
  document.getElementById('wb-view-status-btn').onclick = () => { wbShowView('status'); renderWbStatusView(); };

  renderWbTree(fw.requirement_nodes || [], '');
  wbShowView('tree');
}

function buildNodeTree(nodes) {
  const map = {};
  const roots = [];
  nodes.forEach(n => { map[n.urn] = { ...n, children: [] }; });
  nodes.forEach(n => {
    if (n.parent_urn && map[n.parent_urn]) {
      map[n.parent_urn].children.push(map[n.urn]);
    } else {
      roots.push(map[n.urn]);
    }
  });
  return roots;
}

function nodeMatchesSearch(node, query) {
  if (!query) return true;
  const fields = [node.name, node.ref_id, node.description, node.typical_evidence].filter(Boolean);
  if (fields.some(f => f.toLowerCase().includes(query))) return true;
  if (node.questions) {
    for (const q of Object.values(node.questions)) {
      if (q.text && q.text.toLowerCase().includes(query)) return true;
    }
  }
  return false;
}

function treeHasMatch(node, query) {
  if (nodeMatchesSearch(node, query)) return true;
  return (node.children || []).some(c => treeHasMatch(c, query));
}

function renderWbTree(nodes, query) {
  const container = document.getElementById('wb-tree-container');
  const tree = buildNodeTree(nodes);
  const filtered = query ? tree.filter(n => treeHasMatch(n, query)) : tree;
  if (!filtered.length) {
    container.innerHTML = '<div class="wb-empty"><p>No matching requirements found.</p></div>';
    return;
  }
  container.innerHTML = filtered.map(n => renderWbNode(n, query)).join('');
  container.querySelectorAll('.wb-node-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const children = btn.closest('.wb-node').querySelector('.wb-node-children');
      if (children) {
        children.classList.toggle('collapsed');
        btn.classList.toggle('collapsed');
      }
    });
  });
  container.querySelectorAll('.wb-open-req-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRequirementDetail(btn.dataset.urn);
    });
  });
}

function renderWbNode(node, query) {
  if (query && !treeHasMatch(node, query)) return '';
  const hasChildren = node.children && node.children.length > 0;
  const isAssessable = node.assessable;
  const questions = node.questions ? Object.entries(node.questions) : [];
  const depthClass = `wb-depth-${Math.min(node.depth || 1, 4)}`;

  let html = `<div class="wb-node ${depthClass} ${isAssessable ? 'wb-node-assessable' : ''}">`;
  html += `<div class="wb-node-header">`;
  if (hasChildren) {
    html += `<button class="wb-node-toggle collapsed" title="Toggle"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2L8 6L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  } else {
    html += `<span class="wb-node-bullet"></span>`;
  }
  html += `<span class="wb-node-ref">${escapeHtml(node.ref_id || '')}</span>`;
  html += `<span class="wb-node-name">${escapeHtml(node.name || node.description || '')}</span>`;
  if (isAssessable) html += `<span class="wb-badge wb-badge-assessable">assessable</span>`;
  if (questions.length) html += `<span class="wb-badge wb-badge-questions">${questions.length} Q</span>`;
  if (isAssessable) html += `<button class="wb-open-req-btn" data-urn="${escapeHtml(node.urn)}" title="Open requirement detail">Edit <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2L8 6L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  html += `</div>`;

  if (node.description && node.name) {
    html += `<div class="wb-node-description">${escapeHtml(node.description)}</div>`;
  }

  if (isAssessable && (questions.length || node.typical_evidence)) {
    html += `<div class="wb-node-content">`;
    if (questions.length) {
      html += `<div class="wb-questions-section">`;
      html += `<h4 class="wb-section-label">Questions</h4>`;
      html += `<div class="wb-questions-list">`;
      questions.forEach(([qUrn, q], idx) => {
        html += `<div class="wb-question">`;
        html += `<div class="wb-question-header"><span class="wb-question-num">Q${idx + 1}</span><span class="wb-question-text">${escapeHtml(q.text || '')}</span></div>`;
        if (q.choices && q.choices.length) {
          html += `<div class="wb-choices">`;
          q.choices.forEach(c => {
            const cls = c.value === 'Yes' ? 'wb-choice-yes' : c.value === 'No' ? 'wb-choice-no' : 'wb-choice-partial';
            html += `<span class="wb-choice ${cls}">${escapeHtml(c.value)}</span>`;
          });
          html += `</div>`;
        }
        html += `</div>`;
      });
      html += `</div></div>`;
    }
    if (node.typical_evidence) {
      html += `<div class="wb-evidence-section">`;
      html += `<h4 class="wb-section-label">Typical Evidence</h4>`;
      html += `<div class="wb-evidence-text">${formatEvidence(node.typical_evidence)}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  if (hasChildren) {
    html += `<div class="wb-node-children collapsed">`;
    node.children.forEach(c => { html += renderWbNode(c, query); });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

function formatEvidence(text) {
  return text.split('\n').map(line => {
    line = line.trim();
    if (!line) return '';
    if (line.startsWith('- ')) {
      const parts = line.substring(2).split(':');
      if (parts.length > 1) {
        return `<div class="wb-evidence-item"><strong>${escapeHtml(parts[0].trim())}</strong>: ${escapeHtml(parts.slice(1).join(':').trim())}</div>`;
      }
      return `<div class="wb-evidence-item">${escapeHtml(line.substring(2))}</div>`;
    }
    return `<div class="wb-evidence-item">${escapeHtml(line)}</div>`;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Requirement Detail Panel ─────────────────────────────────

function openRequirementDetail(urn) {
  if (!wbCurrentLibrary) return;
  const fw = (wbCurrentLibrary.content && wbCurrentLibrary.content.framework) || wbCurrentLibrary.framework || {};
  const nodes = fw.requirement_nodes || [];
  const node = nodes.find(n => n.urn === urn);
  if (!node) return;
  wbCurrentNode = node;
  wbDirty = false;

  wbShowView('req');

  const breadcrumbParts = [];
  breadcrumbParts.push(fw.name || 'Framework');
  let pUrn = node.parent_urn;
  const ancestors = [];
  while (pUrn) {
    const parent = nodes.find(p => p.urn === pUrn);
    if (!parent) break;
    ancestors.unshift(parent.ref_id ? `${parent.ref_id} ${parent.name || ''}`.trim() : (parent.name || ''));
    pUrn = parent.parent_urn;
  }
  breadcrumbParts.push(...ancestors);
  breadcrumbParts.push(node.ref_id || node.name || 'Requirement');
  breadcrumbParts.push('Workbench');
  document.getElementById('wb-req-ref').innerHTML = `<span class="wb-breadcrumb-trail">${breadcrumbParts.map(escapeHtml).join(' <span class="wb-breadcrumb-sep">›</span> ')}</span>`;
  document.getElementById('wb-req-name').textContent = node.name || node.description || '';
  document.getElementById('wb-req-desc').textContent = node.name ? (node.description || '') : '';

  const returnView = wbCurrentDetailView || 'tree';
  document.getElementById('wb-req-back-btn').onclick = async () => {
    if (wbDirty) {
      const discard = await wbConfirm('Unsaved changes', 'You have unsaved changes. Do you want to discard them?', { confirmLabel: 'Discard', danger: true });
      if (!discard) return;
    }
    wbDirty = false;
    wbShowView(returnView);
    if (returnView === 'status') renderWbStatusView();
  };
  document.getElementById('wb-save-btn').onclick = () => saveRequirement();
  document.getElementById('wb-add-question-btn').onclick = () => addQuestionRow();
  document.getElementById('wb-add-evidence-btn').onclick = () => addEvidenceRow();
  document.getElementById('wb-add-note-btn').onclick = () => addNoteRow();
  document.getElementById('wb-regen-questions-btn').onclick = () => regenSection('question');
  document.getElementById('wb-regen-evidence-btn').onclick = () => regenSection('typical_evidence');

  const genBody = document.getElementById('wb-gen-body');
  genBody.style.display = 'none';
  document.querySelector('.wb-gen-chevron').classList.remove('wb-gen-chevron-open');
  const toggleGen = () => {
    const open = genBody.style.display !== 'none';
    genBody.style.display = open ? 'none' : '';
    document.querySelector('.wb-gen-chevron').classList.toggle('wb-gen-chevron-open', !open);
  };
  document.getElementById('wb-gen-toggle-btn').onclick = toggleGen;
  document.querySelector('.wb-gen-header').onclick = (e) => {
    if (e.target.closest('.wb-gen-toggle-btn')) return;
    toggleGen();
  };
  const steeringEl = document.getElementById('wb-gen-steering');
  steeringEl.value = '';
  const charCountEl = document.getElementById('wb-gen-char-count');
  charCountEl.textContent = '0 / 2000';
  steeringEl.oninput = () => { charCountEl.textContent = `${steeringEl.value.length} / 2000`; };
  document.getElementById('wb-gen-status').textContent = '';
  document.getElementById('wb-gen-run-btn').onclick = () => runAiGeneration();

  renderQuestionsList();
  renderEvidenceList();
  renderNotesList();
  updateDirtyState(false);
}

function markDirty() { updateDirtyState(true); }
function updateDirtyState(dirty) {
  wbDirty = dirty;
  document.getElementById('wb-dirty-badge').style.display = dirty ? '' : 'none';
  document.getElementById('wb-save-btn').disabled = !dirty;
}

// ── Questions CRUD ──

function renderQuestionsList() {
  const list = document.getElementById('wb-questions-list');
  const questions = wbCurrentNode.questions ? Object.entries(wbCurrentNode.questions) : [];
  if (!questions.length) {
    list.innerHTML = '<div class="wb-req-empty">No questions yet. Click "Add Question" to create one.</div>';
    return;
  }
  list.innerHTML = questions.map(([qUrn, rawQ], idx) => {
    const q = migrateQuestionItem(qUrn, rawQ, idx);
    const inScope = q.included_in_ai_scope !== false;
    const choicesHtml = (q.choices || []).map(c => {
      const cls = c.value === 'Yes' ? 'wb-choice-yes' : c.value === 'No' ? 'wb-choice-no' : 'wb-choice-partial';
      return `<span class="wb-choice ${cls}">${escapeHtml(c.value)}</span>`;
    }).join('');
    return `<div class="wb-req-item ${!inScope ? 'wb-req-item-excluded' : ''}" data-urn="${escapeHtml(qUrn)}">
      <div class="wb-req-item-header">
        <button class="wb-scope-toggle ${!inScope ? 'wb-scope-off' : ''}" data-action="toggle-question" data-urn="${escapeHtml(qUrn)}" title="${!inScope ? 'Include in AI scope' : 'Exclude from AI scope'}">${!inScope ? wbIconEyeOff : wbIconEye}</button>
        <span class="wb-req-item-num">Q${idx + 1}</span>
        <span class="wb-badge wb-badge-type">question</span>
        ${provenanceBadge(q.provenance)}
        ${q.updated_at ? `<span class="wb-item-meta">${q.updated_by ? escapeHtml(q.updated_by) + ' · ' : ''}${formatTimestamp(q.updated_at)}</span>` : ''}
        <div class="wb-req-item-actions">
          <button class="wb-req-edit-btn" data-action="edit-question" data-urn="${escapeHtml(qUrn)}" title="Edit">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="wb-req-delete-btn" data-action="delete-question" data-urn="${escapeHtml(qUrn)}" title="Delete">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M10 4V11C10 11.6 9.6 12 9 12H5C4.4 12 4 11.6 4 11V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="wb-req-item-body wb-bilingual">
        <div class="wb-lang-ar" dir="rtl">${escapeHtml(q.content_ar || q.text || '')}</div>
        ${q.content_en ? `<div class="wb-lang-en-wrap wb-collapsed"><button class="wb-lang-toggle" onclick="this.parentElement.classList.toggle('wb-collapsed')">EN</button><div class="wb-lang-en">${escapeHtml(q.content_en)}</div></div>` : ''}
      </div>
      ${choicesHtml ? `<div class="wb-req-item-choices">${choicesHtml}</div>` : ''}
    </div>`;
  }).join('');
  attachItemActions(list);
}

function addQuestionRow() {
  const nodeUrn = wbCurrentNode.urn || '';
  if (!wbCurrentNode.questions) wbCurrentNode.questions = {};
  const existingCount = Object.keys(wbCurrentNode.questions).length;
  const qNum = existingCount + 1;
  const qUrn = `${nodeUrn}:question:${qNum}`;

  showItemEditor('question', null, (data) => {
    const audit = makeAuditFields();
    wbCurrentNode.questions[qUrn] = {
      type: 'unique_choice',
      item_type: 'question',
      text: data.content_ar,
      content_ar: data.content_ar,
      content_en: data.content_en || '',
      included_in_ai_scope: true,
      provenance: 'manual',
      generation_metadata: null,
      ...audit,
      display_order: existingCount,
      choices: [
        { urn: `${qUrn}:choice:1`, value: 'Yes' },
        { urn: `${qUrn}:choice:2`, value: 'No' },
        { urn: `${qUrn}:choice:3`, value: 'Partial' }
      ]
    };
    wbLogAudit('create_item', { item_type: 'question', item_id: qUrn, summary: data.content_ar.substring(0, 60) });
    markDirty();
    renderQuestionsList();
  });
}

function editQuestion(qUrn) {
  const q = wbCurrentNode.questions[qUrn];
  if (!q) return;
  const migrated = migrateQuestionItem(qUrn, q, 0);
  showItemEditor('question', migrated, (data) => {
    const before = q.content_ar || q.text || '';
    q.text = data.content_ar;
    q.content_ar = data.content_ar;
    q.content_en = data.content_en || '';
    q.type = normalizeQuestionType(q);
    const audit = makeAuditFields(q);
    Object.assign(q, audit);
    wbLogAudit('edit_item', { item_type: 'question', item_id: qUrn, summary: `edited`, before });
    markDirty();
    renderQuestionsList();
  });
}

async function deleteQuestion(qUrn) {
  const ok = await wbConfirm('Delete question', 'Are you sure you want to delete this question?', { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const deleted = wbCurrentNode.questions[qUrn];
  wbLogAudit('delete_item', { item_type: 'question', item_id: qUrn, summary: (deleted && deleted.content_ar) || (deleted && deleted.text) || qUrn });
  delete wbCurrentNode.questions[qUrn];
  reindexQuestions();
  markDirty();
  renderQuestionsList();
}

function reindexQuestions() {
  const nodeUrn = wbCurrentNode.urn || '';
  const entries = Object.values(wbCurrentNode.questions || {});
  wbCurrentNode.questions = {};
  entries.forEach((q, idx) => {
    const qNum = idx + 1;
    const qUrn = `${nodeUrn}:question:${qNum}`;
    q.choices = (q.choices || []).map((c, ci) => ({
      urn: `${qUrn}:choice:${ci + 1}`, value: c.value
    }));
    q.display_order = idx;
    wbCurrentNode.questions[qUrn] = q;
  });
}

// ── Evidence CRUD ──

function renderEvidenceList() {
  const list = document.getElementById('wb-evidence-list');
  const items = getEvidenceItems(wbCurrentNode);
  if (!items.length) {
    list.innerHTML = '<div class="wb-req-empty">No typical evidence yet. Click "Add Evidence" to create one.</div>';
    return;
  }
  list.innerHTML = items.map((it, idx) => {
    const inScope = it.included_in_ai_scope !== false;
    return `<div class="wb-req-item ${!inScope ? 'wb-req-item-excluded' : ''}" data-idx="${idx}">
    <div class="wb-req-item-header">
      <button class="wb-scope-toggle ${!inScope ? 'wb-scope-off' : ''}" data-action="toggle-evidence" data-idx="${idx}" title="${!inScope ? 'Include in AI scope' : 'Exclude from AI scope'}">${!inScope ? wbIconEyeOff : wbIconEye}</button>
      <span class="wb-req-item-num">E${idx + 1}</span>
      ${it.title ? `<span class="wb-req-item-ev-title">${escapeHtml(it.title)}</span>` : ''}
      <span class="wb-badge wb-badge-type">evidence</span>
      ${provenanceBadge(it.provenance)}
      ${it.updated_at ? `<span class="wb-item-meta">${it.updated_by ? escapeHtml(it.updated_by) + ' · ' : ''}${formatTimestamp(it.updated_at)}</span>` : ''}
      <div class="wb-req-item-actions">
        <button class="wb-req-edit-btn" data-action="edit-evidence" data-idx="${idx}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="wb-req-delete-btn" data-action="delete-evidence" data-idx="${idx}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M10 4V11C10 11.6 9.6 12 9 12H5C4.4 12 4 11.6 4 11V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="wb-req-item-body wb-bilingual">
      <div class="wb-lang-ar" dir="rtl">${escapeHtml(it.content_ar || it.description || '')}</div>
      ${it.content_en ? `<div class="wb-lang-en-wrap wb-collapsed"><button class="wb-lang-toggle" onclick="this.parentElement.classList.toggle('wb-collapsed')">EN</button><div class="wb-lang-en">${escapeHtml(it.content_en)}</div></div>` : ''}
    </div>
  </div>`;
  }).join('');
  attachItemActions(list);
}

function syncEvidenceToNode(items) {
  wbCurrentNode.typical_evidence_items = items;
  wbCurrentNode.typical_evidence = evidenceItemsToTextLegacy(items);
}

function addEvidenceRow() {
  showItemEditor('evidence', null, (data) => {
    const items = getEvidenceItems(wbCurrentNode);
    const audit = makeAuditFields();
    items.push({
      id: items.length, title: data.title || '',
      item_type: 'typical_evidence',
      description: data.content_ar,
      content_ar: data.content_ar,
      content_en: data.content_en || '',
      excluded: false,
      included_in_ai_scope: true,
      provenance: 'manual',
      generation_metadata: null,
      ...audit,
      display_order: items.length
    });
    wbLogAudit('create_item', { item_type: 'typical_evidence', item_id: String(items.length - 1), summary: data.content_ar.substring(0, 60) });
    syncEvidenceToNode(items);
    markDirty();
    renderEvidenceList();
  });
}

function editEvidence(idx) {
  const items = getEvidenceItems(wbCurrentNode);
  const item = items[idx];
  if (!item) return;
  showItemEditor('evidence', item, (data) => {
    const before = items[idx].content_ar || items[idx].description || '';
    items[idx].title = data.title || '';
    items[idx].description = data.content_ar;
    items[idx].content_ar = data.content_ar;
    items[idx].content_en = data.content_en || '';
    const audit = makeAuditFields(items[idx]);
    Object.assign(items[idx], audit);
    wbLogAudit('edit_item', { item_type: 'typical_evidence', item_id: String(idx), summary: `edited`, before });
    syncEvidenceToNode(items);
    markDirty();
    renderEvidenceList();
  });
}

async function deleteEvidence(idx) {
  const ok = await wbConfirm('Delete evidence', 'Are you sure you want to delete this evidence item?', { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const items = getEvidenceItems(wbCurrentNode);
  const deleted = items[idx];
  wbLogAudit('delete_item', { item_type: 'typical_evidence', item_id: String(idx), summary: (deleted && deleted.content_ar) || (deleted && deleted.description) || '' });
  items.splice(idx, 1);
  items.forEach((it, i) => { it.display_order = i; });
  syncEvidenceToNode(items);
  markDirty();
  renderEvidenceList();
}

// ── Admin Notes CRUD ──

function renderNotesList() {
  const list = document.getElementById('wb-notes-list');
  const rawNotes = wbCurrentNode.admin_notes || [];
  const notes = rawNotes.map((n, i) => migrateNoteItem(n, i));
  if (!notes.length) {
    list.innerHTML = '<div class="wb-req-empty">No admin notes yet. Click "Add Note" to create one.</div>';
    return;
  }
  list.innerHTML = notes.map((note, idx) => {
    const inScope = note.included_in_ai_scope !== false;
    const stLabel = subtypeBadgeLabel(note.subtype, note.subtype_label);
    return `<div class="wb-req-item wb-req-item-note ${!inScope ? 'wb-req-item-excluded' : ''}" data-idx="${idx}">
    <div class="wb-req-item-header">
      <button class="wb-scope-toggle ${!inScope ? 'wb-scope-off' : ''}" data-action="toggle-note" data-idx="${idx}" title="${!inScope ? 'Include in AI scope' : 'Exclude from AI scope'}">${!inScope ? wbIconEyeOff : wbIconEye}</button>
      <span class="wb-req-item-num">N${idx + 1}</span>
      <span class="wb-badge wb-badge-subtype wb-badge-subtype-${escapeHtml(note.subtype || 'note')}">${escapeHtml(stLabel)}</span>
      ${provenanceBadge(note.provenance)}
      ${note.updated_at ? `<span class="wb-item-meta">${note.updated_by ? escapeHtml(note.updated_by) + ' · ' : ''}${formatTimestamp(note.updated_at)}</span>` : ''}
      <div class="wb-req-item-actions">
        <button class="wb-req-edit-btn" data-action="edit-note" data-idx="${idx}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="wb-req-delete-btn" data-action="delete-note" data-idx="${idx}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M10 4V11C10 11.6 9.6 12 9 12H5C4.4 12 4 11.6 4 11V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="wb-req-item-body wb-bilingual">
      <div class="wb-lang-ar" dir="rtl">${escapeHtml(note.content_ar || note.text || '')}</div>
      ${note.content_en ? `<div class="wb-lang-en-wrap wb-collapsed"><button class="wb-lang-toggle" onclick="this.parentElement.classList.toggle('wb-collapsed')">EN</button><div class="wb-lang-en">${escapeHtml(note.content_en)}</div></div>` : ''}
    </div>
  </div>`;
  }).join('');
  attachItemActions(list);
}

function addNoteRow() {
  showItemEditor('admin_note', null, (data) => {
    if (!wbCurrentNode.admin_notes) wbCurrentNode.admin_notes = [];
    const audit = makeAuditFields();
    wbCurrentNode.admin_notes.push({
      text: data.content_ar,
      item_type: 'admin_note',
      content_ar: data.content_ar,
      content_en: data.content_en || '',
      subtype: data.subtype || 'note',
      subtype_label: data.subtype_label || '',
      included_in_ai_scope: false,
      provenance: 'manual',
      generation_metadata: null,
      ...audit,
      display_order: wbCurrentNode.admin_notes.length
    });
    wbLogAudit('create_item', { item_type: 'admin_note', item_id: String(wbCurrentNode.admin_notes.length - 1), summary: data.content_ar.substring(0, 60) });
    markDirty();
    renderNotesList();
  });
}

function editNote(idx) {
  const notes = wbCurrentNode.admin_notes || [];
  const note = notes[idx];
  if (!note) return;
  const migrated = migrateNoteItem(note, idx);
  showItemEditor('admin_note', migrated, (data) => {
    const before = notes[idx].content_ar || notes[idx].text || '';
    notes[idx].text = data.content_ar;
    notes[idx].content_ar = data.content_ar;
    notes[idx].content_en = data.content_en || '';
    notes[idx].subtype = data.subtype || 'note';
    notes[idx].subtype_label = data.subtype_label || '';
    const audit = makeAuditFields(notes[idx]);
    Object.assign(notes[idx], audit);
    wbLogAudit('edit_item', { item_type: 'admin_note', item_id: String(idx), summary: `edited`, before });
    markDirty();
    renderNotesList();
  });
}

async function deleteNote(idx) {
  const ok = await wbConfirm('Delete note', 'Are you sure you want to delete this admin note?', { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const notes = wbCurrentNode.admin_notes || [];
  const deleted = notes[idx];
  wbLogAudit('delete_item', { item_type: 'admin_note', item_id: String(idx), summary: (deleted && deleted.content_ar) || '' });
  notes.splice(idx, 1);
  notes.forEach((n, i) => { n.display_order = i; });
  markDirty();
  renderNotesList();
}

// ── Action dispatcher ──

async function persistScopeToggle() {
  if (!wbCurrentLibrary || !wbCurrentNode) return;
  const libId = wbCurrentLibrary._id || wbCurrentLibrary.id;
  const pendingLog = wbAuditLog.splice(0);
  try {
    await fetch(`${MURAJI_API}/${libId}/controls`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{
          code: wbCurrentNode.ref_id,
          typical_requirements: wbCurrentNode.typical_evidence || '',
          typical_evidence_items: wbCurrentNode.typical_evidence_items || getEvidenceItems(wbCurrentNode),
          questions: wbCurrentNode.questions || {},
          admin_notes: wbCurrentNode.admin_notes || [],
          audit_log: pendingLog
        }]
      })
    });
  } catch (e) {
    wbAuditLog.unshift(...pendingLog);
    console.error('Scope toggle persist failed:', e);
  }
}

function toggleQuestionScope(qUrn) {
  const q = wbCurrentNode.questions[qUrn];
  if (!q) return;
  const newVal = !(q.included_in_ai_scope !== false);
  q.included_in_ai_scope = newVal;
  q.excluded = !newVal;
  Object.assign(q, makeAuditFields(q));
  wbLogAudit('toggle_scope', { item_type: 'question', item_id: qUrn, summary: `scope → ${newVal ? 'on' : 'off'}` });
  renderQuestionsList();
  persistScopeToggle();
}

function toggleEvidenceScope(idx) {
  const items = getEvidenceItems(wbCurrentNode);
  const newVal = !(items[idx].included_in_ai_scope !== false);
  items[idx].included_in_ai_scope = newVal;
  items[idx].excluded = !newVal;
  Object.assign(items[idx], makeAuditFields(items[idx]));
  wbLogAudit('toggle_scope', { item_type: 'typical_evidence', item_id: String(idx), summary: `scope → ${newVal ? 'on' : 'off'}` });
  syncEvidenceToNode(items);
  renderEvidenceList();
  persistScopeToggle();
}

function toggleNoteScope(idx) {
  const notes = wbCurrentNode.admin_notes || [];
  const newVal = !(notes[idx].included_in_ai_scope !== false);
  notes[idx].included_in_ai_scope = newVal;
  notes[idx].excluded = !newVal;
  Object.assign(notes[idx], makeAuditFields(notes[idx]));
  wbLogAudit('toggle_scope', { item_type: 'admin_note', item_id: String(idx), summary: `scope → ${newVal ? 'on' : 'off'}` });
  renderNotesList();
  persistScopeToggle();
}

function attachItemActions(container) {
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const urn = btn.dataset.urn;
      const idx = parseInt(btn.dataset.idx, 10);
      if (action === 'edit-question') editQuestion(urn);
      if (action === 'delete-question') deleteQuestion(urn);
      if (action === 'toggle-question') toggleQuestionScope(urn);
      if (action === 'edit-evidence') editEvidence(idx);
      if (action === 'delete-evidence') deleteEvidence(idx);
      if (action === 'toggle-evidence') toggleEvidenceScope(idx);
      if (action === 'edit-note') editNote(idx);
      if (action === 'delete-note') deleteNote(idx);
      if (action === 'toggle-note') toggleNoteScope(idx);
    });
  });
}

// ── Inline Item Editor ──

function showItemEditor(type, existingItem, onSave) {
  const existing = document.querySelector('.wb-inline-editor');
  if (existing) existing.remove();

  const sectionMap = { question: 'questions', evidence: 'evidence', admin_note: 'notes' };
  const section = document.getElementById(`wb-req-${sectionMap[type] || type}-section`);

  const isNote = type === 'admin_note';
  const isEvidence = type === 'evidence';
  const contentAr = existingItem ? (existingItem.content_ar || existingItem.text || existingItem.description || '') : '';
  const contentEn = existingItem ? (existingItem.content_en || '') : '';
  const title = existingItem ? (existingItem.title || '') : '';
  const subtype = existingItem ? (existingItem.subtype || 'note') : 'note';
  const subtypeLabel = existingItem ? (existingItem.subtype_label || '') : '';

  const subtypeOptions = NOTE_SUBTYPES.map(s =>
    `<option value="${s.value}" ${s.value === subtype ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  const editor = document.createElement('div');
  editor.className = 'wb-inline-editor';
  editor.innerHTML = `
    ${isNote ? `
      <div class="wb-editor-row">
        <label class="wb-editor-label">Subtype</label>
        <select class="wb-inline-select wb-subtype-select">${subtypeOptions}</select>
        <input type="text" class="wb-inline-title wb-subtype-label-input" placeholder="Custom subtype label (max 60)" maxlength="60" value="${escapeHtml(subtypeLabel)}" style="display:${subtype === 'other' ? '' : 'none'}">
      </div>` : ''}
    ${isEvidence ? `
      <div class="wb-editor-row">
        <label class="wb-editor-label">Title (optional)</label>
        <input type="text" class="wb-inline-title" placeholder="Evidence title" value="${escapeHtml(title)}">
      </div>` : ''}
    <div class="wb-editor-row">
      <label class="wb-editor-label">Arabic <span class="wb-required">*</span></label>
      <textarea class="wb-inline-textarea wb-ar-input" rows="3" dir="rtl" placeholder="المحتوى بالعربي...">${escapeHtml(contentAr)}</textarea>
    </div>
    <div class="wb-editor-row">
      <label class="wb-editor-label">English <span class="wb-optional">(optional)</span></label>
      <textarea class="wb-inline-textarea wb-en-input" rows="2" placeholder="English content...">${escapeHtml(contentEn)}</textarea>
    </div>
    <div class="wb-inline-actions">
      <button class="btn-admin-ghost wb-inline-cancel">Cancel</button>
      <button class="btn-admin-primary wb-inline-save">Save</button>
    </div>`;
  section.appendChild(editor);

  if (isNote) {
    const subtypeSelect = editor.querySelector('.wb-subtype-select');
    const labelInput = editor.querySelector('.wb-subtype-label-input');
    subtypeSelect.onchange = () => {
      labelInput.style.display = subtypeSelect.value === 'other' ? '' : 'none';
    };
  }

  const arInput = editor.querySelector('.wb-ar-input');
  arInput.focus();
  arInput.setSelectionRange(arInput.value.length, arInput.value.length);

  editor.querySelector('.wb-inline-cancel').onclick = () => editor.remove();
  editor.querySelector('.wb-inline-save').onclick = () => {
    const ar = editor.querySelector('.wb-ar-input').value.trim();
    const en = editor.querySelector('.wb-en-input').value.trim();
    if (!ar) { editor.querySelector('.wb-ar-input').classList.add('wb-input-error'); return; }

    const result = { content_ar: ar, content_en: en };
    if (isEvidence) result.title = editor.querySelector('.wb-inline-title').value.trim();
    if (isNote) {
      result.subtype = editor.querySelector('.wb-subtype-select').value;
      result.subtype_label = result.subtype === 'other' ? editor.querySelector('.wb-subtype-label-input').value.trim() : '';
      if (result.subtype === 'other' && !result.subtype_label) {
        editor.querySelector('.wb-subtype-label-input').classList.add('wb-input-error');
        return;
      }
    }
    editor.remove();
    onSave(result);
  };
  arInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') editor.remove(); });
}

// ── Background Job System ──

const wbJobs = new Map();
let wbJobCounter = 0;

function createJob(label, type) {
  const id = ++wbJobCounter;
  const job = {
    id, label, type,
    status: 'running',
    progress: { done: 0, total: 0, current: '' },
    results: [],
    startedAt: Date.now(),
    completedAt: null,
    onComplete: null
  };
  wbJobs.set(id, job);
  refreshJobIndicator();
  return job;
}

function updateJobProgress(job, done, total, current) {
  job.progress = { done, total, current };
  refreshJobIndicator();
}

function completeJob(job, results) {
  job.status = 'completed';
  job.completedAt = Date.now();
  job.results = results || [];
  const succeeded = results ? results.filter(r => r.ok).length : 0;
  const failed = results ? results.filter(r => !r.ok).length : 0;

  if (typeof toast === 'function') {
    const elapsed = ((job.completedAt - job.startedAt) / 1000).toFixed(0);
    toast('success', 'Job Complete',
      `${job.label}: ${succeeded} succeeded, ${failed} failed (${elapsed}s)`);
  }

  setTimeout(() => { wbJobs.delete(job.id); refreshJobIndicator(); }, 30000);
  refreshJobIndicator();
  if (job.onComplete) job.onComplete(job);
}

function failJob(job, error) {
  job.status = 'failed';
  job.completedAt = Date.now();
  if (typeof toast === 'function') toast('error', 'Job Failed', `${job.label}: ${error}`);
  setTimeout(() => { wbJobs.delete(job.id); refreshJobIndicator(); }, 30000);
  refreshJobIndicator();
}

function refreshJobIndicator() {
  const indicator = document.getElementById('wb-jobs-indicator');
  if (!indicator) return;
  const running = Array.from(wbJobs.values()).filter(j => j.status === 'running');
  const completed = Array.from(wbJobs.values()).filter(j => j.status !== 'running');

  if (running.length === 0 && completed.length === 0) {
    indicator.style.display = 'none';
    return;
  }
  indicator.style.display = '';
  const labelEl = document.getElementById('wb-jobs-label');
  const detailEl = document.getElementById('wb-jobs-detail');
  const spinnerEl = indicator.querySelector('.wb-jobs-spinner');

  if (running.length > 0) {
    const j = running[0];
    spinnerEl.style.display = '';
    labelEl.textContent = `${running.length} job${running.length > 1 ? 's' : ''} running`;
    if (j.progress.total > 0) {
      detailEl.textContent = `${j.progress.done}/${j.progress.total}`;
    } else {
      detailEl.textContent = j.progress.current || '';
    }
  } else {
    spinnerEl.style.display = 'none';
    const last = completed[completed.length - 1];
    const ok = last.results.filter(r => r.ok).length;
    labelEl.textContent = `Job done: ${ok}/${last.results.length}`;
    detailEl.textContent = '';
  }
}

const WB_FOREGROUND_TIMEOUT = 15000;

// ── AI Generation ──

function wbConfirm(title, message, opts = {}) {
  const { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = opts;
  return new Promise((resolve) => {
    const existing = document.querySelector('.wb-confirm-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'wb-confirm-overlay';
    overlay.innerHTML = `
      <div class="wb-confirm-modal">
        <h3 class="wb-confirm-title">${escapeHtml(title)}</h3>
        <div class="wb-confirm-body"><p>${message}</p></div>
        <div class="wb-confirm-actions">
          <button class="btn-admin-ghost wb-confirm-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="${danger ? 'btn-admin-danger' : 'btn-admin-primary'} wb-confirm-accept">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.wb-confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.wb-confirm-accept').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

function wbAlert(title, message, opts = {}) {
  const { buttonLabel = 'OK', danger = false } = opts;
  return new Promise((resolve) => {
    const existing = document.querySelector('.wb-confirm-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'wb-confirm-overlay';
    overlay.innerHTML = `
      <div class="wb-confirm-modal">
        <h3 class="wb-confirm-title">${escapeHtml(title)}</h3>
        <div class="wb-confirm-body"><p>${message}</p></div>
        <div class="wb-confirm-actions">
          <button class="${danger ? 'btn-admin-danger' : 'btn-admin-primary'} wb-confirm-accept">${escapeHtml(buttonLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.wb-confirm-accept').onclick = () => { overlay.remove(); resolve(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } });
  });
}

function showReplaceConfirmation(qCount, eCount, doQuestions, doEvidence) {
  return new Promise((resolve) => {
    const existing = document.querySelector('.wb-confirm-overlay');
    if (existing) existing.remove();

    const lines = [];
    if (doQuestions && qCount > 0) lines.push(`${qCount} question${qCount !== 1 ? 's' : ''}`);
    if (doEvidence && eCount > 0) lines.push(`${eCount} evidence item${eCount !== 1 ? 's' : ''}`);
    const summary = lines.join(' and ');

    const overlay = document.createElement('div');
    overlay.className = 'wb-confirm-overlay';
    overlay.innerHTML = `
      <div class="wb-confirm-modal">
        <div class="wb-confirm-icon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M14 2L2 26H26L14 2Z" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 10V16" stroke="#dc2626" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="20" r="1.2" fill="#dc2626"/></svg>
        </div>
        <h3 class="wb-confirm-title">Replace existing items?</h3>
        <div class="wb-confirm-body">
          <p>This will <strong>permanently delete</strong> ${summary} for this requirement and replace them with newly generated content.</p>
          <ul class="wb-confirm-warnings">
            <li>Any manual edits to those items will be lost</li>
            <li>The deletion will be recorded in the audit log (prior content is recoverable through audit history)</li>
          </ul>
        </div>
        <div class="wb-confirm-actions">
          <button class="btn-admin-ghost wb-confirm-cancel">Cancel</button>
          <button class="btn-admin-danger wb-confirm-accept">I understand, replace all</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.wb-confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.wb-confirm-accept').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

async function regenSection(sectionType) {
  if (!wbCurrentNode) return;
  const label = sectionType === 'question' ? 'questions' : 'typical evidence';
  const existingCount = sectionType === 'question'
    ? Object.keys(wbCurrentNode.questions || {}).length
    : getEvidenceItems(wbCurrentNode).length;

  const steering = await new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'wb-confirm-overlay';
    overlay.innerHTML = `
      <div class="wb-confirm-modal" style="max-width:460px">
        <div class="wb-confirm-icon" style="color:#d97706">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M1 12C1 5.9 5.9 1 12 1C16.1 1 19.6 3.4 21.2 6.9M23 12C23 18.1 18.1 23 12 23C7.9 23 4.4 20.6 2.8 17.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 2V7H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 22V17H8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h3 class="wb-confirm-title">Re-generate ${label}</h3>
        <div class="wb-confirm-body">
          ${existingCount > 0 ? `<div class="wb-confirm-warnings"><p>This will <strong>delete all ${existingCount} existing ${label}</strong> and replace them with new AI-generated items.</p><p>Any manual edits will be lost. The deletion will be recorded in the audit log.</p></div>` : `<p>AI will generate new ${label} for this requirement.</p>`}
          <label style="display:block;margin-top:12px;font-size:12px;font-weight:600;color:#64748b">Steering instructions <span style="font-weight:400;color:#94a3b8">(optional, max 2000 chars)</span></label>
          <textarea id="wb-regen-steering" style="width:100%;margin-top:4px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px;resize:vertical;min-height:60px" maxlength="2000" placeholder="e.g. Focus on cloud-hosted core banking systems."></textarea>
        </div>
        <div class="wb-confirm-actions">
          <button class="btn-admin-secondary wb-confirm-cancel">Cancel</button>
          <button class="btn-admin-danger wb-confirm-ok">${existingCount > 0 ? 'I understand, replace all' : 'Generate'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.wb-confirm-cancel').onclick = () => { overlay.remove(); resolve(null); };
    overlay.querySelector('.wb-confirm-ok').onclick = () => {
      const v = overlay.querySelector('#wb-regen-steering').value.trim();
      overlay.remove();
      resolve(v);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
  });
  if (steering === null) return;

  const regenBtn = document.getElementById(sectionType === 'question' ? 'wb-regen-questions-btn' : 'wb-regen-evidence-btn');
  regenBtn.disabled = true;
  regenBtn.textContent = 'Generating...';

  const capturedNode = wbCurrentNode;
  const requirement = JSON.stringify({
    urn: capturedNode.urn, ref_id: capturedNode.ref_id,
    name: capturedNode.name, description: capturedNode.description,
    parent_section: capturedNode.parent_urn || ''
  });
  let localPromptTemplate = '';
  let promptVersion = null;
  try {
    const r = await fetch('/api/local-prompts'); const j = await r.json();
    if (j.prompts && j.prompts[0]) { localPromptTemplate = j.prompts[0].content || ''; promptVersion = j.prompts[0].updated_at || j.prompts[0].id || null; }
  } catch (_) {}
  const userPrompt = localPromptTemplate
    ? localPromptTemplate.replace('{{REQUIREMENT}}', requirement).replace('{{USER_PROMPT}}', steering || '').replace('{{CONTEXT_FILES}}', '')
    : `Analyze this requirement: ${requirement}${steering ? '\n\nAdditional instructions: ' + steering : ''}`;

  let movedToBg = false;
  let bgJob = null;
  const bgTimer = setTimeout(() => {
    movedToBg = true;
    bgJob = createJob(`Re-gen ${label}: ${capturedNode.ref_id || capturedNode.urn}`, 'single');
    updateJobProgress(bgJob, 0, 1, 'Waiting for AI...');
    regenBtn.disabled = false;
    regenBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M1 7C1 3.7 3.7 1 7 1C9.4 1 11.4 2.5 12.3 4.5M13 7C13 10.3 10.3 13 7 13C4.6 13 2.6 11.5 1.7 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12 1.5V4.5H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12.5V9.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Re-generate`;
    if (typeof toast === 'function') toast('info', 'Moved to background', 'Re-generation continues in the background — you can navigate away.');
  }, WB_FOREGROUND_TIMEOUT);

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement, prompt: userPrompt })
    });
    clearTimeout(bgTimer);
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `HTTP ${res.status}`); }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Generation failed');
    const data = json.data;
    const apiMeta = json.meta || {};

    const genMeta = {
      prompt_template: apiMeta.prompt_template || 'requirement-analyzer',
      prompt_template_version: apiMeta.prompt_template_version || promptVersion,
      steering_prompt: steering || null,
      triggered_by: wbAdminUser, generated_at: new Date().toISOString(),
      model: apiMeta.model || 'gemini-2.5-pro'
    };
    const audit = makeAiAuditFields();

    if (sectionType === 'question' && data.questions && data.questions.length) {
      const existingQs = capturedNode.questions || {};
      const dc = Object.keys(existingQs).length;
      if (dc) {
        const snapshot = JSON.parse(JSON.stringify(existingQs));
        wbLogAudit('ai_wipe_replace', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'question', count: dc, snapshot, summary: `section re-gen: wiped ${dc} questions` });
      }
      const nodeUrn = capturedNode.urn || '';
      const newQuestions = {};
      data.questions.forEach((q, idx) => {
        const qNum = idx + 1;
        const qUrn = `${nodeUrn}:question:${qNum}`;
        const qText = q.question || q.text || '';
        newQuestions[qUrn] = {
          type: 'unique_choice', item_type: 'question', text: qText, content_ar: qText,
          content_en: q.question_en || q.text_en || '',
          included_in_ai_scope: true, provenance: 'ai_generated',
          generation_metadata: genMeta, ...audit, display_order: idx,
          choices: [
            { urn: `${qUrn}:choice:1`, value: 'Yes' },
            { urn: `${qUrn}:choice:2`, value: 'No' },
            { urn: `${qUrn}:choice:3`, value: 'Partial' }
          ]
        };
      });
      capturedNode.questions = newQuestions;
      wbLogAudit('ai_generate', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'question', count: data.questions.length, summary: `section re-gen: generated ${data.questions.length} questions` });
    }

    if (sectionType === 'typical_evidence' && data.typical_evidence && data.typical_evidence.length) {
      const existingEvidence = getEvidenceItems(capturedNode);
      const dc = existingEvidence.length;
      if (dc) {
        const snapshot = JSON.parse(JSON.stringify(existingEvidence));
        wbLogAudit('ai_wipe_replace', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'typical_evidence', count: dc, snapshot, summary: `section re-gen: wiped ${dc} evidence items` });
      }
      const newItems = data.typical_evidence
        .filter(e => e.title || e.description)
        .map((e, idx) => ({
          id: idx, title: e.title || '', description: e.description || '',
          item_type: 'typical_evidence',
          content_ar: e.description || '', content_en: e.description_en || '',
          excluded: false, included_in_ai_scope: true, provenance: 'ai_generated',
          generation_metadata: genMeta, ...audit, display_order: idx
        }));
      capturedNode.typical_evidence_items = newItems;
      capturedNode.typical_evidence = evidenceItemsToTextLegacy(newItems);
      wbLogAudit('ai_generate', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'typical_evidence', count: newItems.length, summary: `section re-gen: generated ${newItems.length} evidence items` });
    }

    if (movedToBg) {
      completeJob(bgJob, [{ ref: capturedNode.ref_id, ok: true }]);
    }
    if (wbCurrentNode === capturedNode) {
      if (sectionType === 'question') renderQuestionsList();
      else renderEvidenceList();
      markDirty();
    }
    if (typeof toast === 'function') toast('success', 'Re-generated', `${label} have been re-generated successfully.`);
  } catch (e) {
    clearTimeout(bgTimer);
    if (movedToBg && bgJob) failJob(bgJob, e.message);
    if (typeof toast === 'function') toast('error', 'Re-generation failed', e.message);
  } finally {
    regenBtn.disabled = false;
    regenBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M1 7C1 3.7 3.7 1 7 1C9.4 1 11.4 2.5 12.3 4.5M13 7C13 10.3 10.3 13 7 13C4.6 13 2.6 11.5 1.7 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12 1.5V4.5H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12.5V9.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Re-generate`;
  }
}

async function runAiGeneration() {
  if (!wbCurrentNode) return;
  const steering = document.getElementById('wb-gen-steering').value.trim();
  const doReplace = document.getElementById('wb-gen-replace').checked;
  const doQuestions = document.getElementById('wb-gen-questions').checked;
  const doEvidence = document.getElementById('wb-gen-evidence').checked;

  if (!doQuestions && !doEvidence) {
    if (typeof toast === 'function') toast('error', 'Nothing selected', 'Select at least one generation target.');
    return;
  }

  if (doReplace) {
    const qCount = doQuestions ? Object.keys(wbCurrentNode.questions || {}).length : 0;
    const eCount = doEvidence ? getEvidenceItems(wbCurrentNode).length : 0;
    const total = qCount + eCount;
    if (total > 0) {
      const confirmed = await showReplaceConfirmation(qCount, eCount, doQuestions, doEvidence);
      if (!confirmed) return;
    }
  }

  const runBtn = document.getElementById('wb-gen-run-btn');
  const statusEl = document.getElementById('wb-gen-status');
  runBtn.disabled = true;
  runBtn.innerHTML = '<div class="spinner-sm"></div> Generating...';
  statusEl.textContent = 'Calling AI...';
  statusEl.className = 'wb-gen-status';

  let promptVersion = null;
  try { const pr = await fetch('/api/local-prompts'); const pj = await pr.json(); if (pj.prompts && pj.prompts[0]) promptVersion = pj.prompts[0].updated_at || pj.prompts[0].id || null; } catch (_) {}

  const capturedNode = wbCurrentNode;
  const capturedLib = wbCurrentLibrary;
  const fw = capturedLib ? ((capturedLib.content && capturedLib.content.framework) || capturedLib.framework || {}) : {};
  const parentNodes = (fw.requirement_nodes || []).filter(n => {
    let pUrn = capturedNode.parent_urn;
    while (pUrn) {
      const parent = (fw.requirement_nodes || []).find(p => p.urn === pUrn);
      if (!parent) break;
      if (parent.urn === n.urn) return true;
      pUrn = parent.parent_urn;
    }
    return false;
  });
  const breadcrumb = parentNodes.map(p => `${p.ref_id || ''} ${p.name || ''}`).join(' > ');

  const requirement = {
    ref_id: capturedNode.ref_id || '',
    name: capturedNode.name || '',
    description: capturedNode.description || '',
    nodeUrn: capturedNode.urn || '',
    framework: fw.name || '',
    framework_ref_id: fw.ref_id || '',
    breadcrumb
  };

  let userPrompt = steering || 'No additional context provided.';
  if (steering) userPrompt = `[Admin steering instructions]: ${steering}`;

  let movedToBackground = false;
  let bgJob = null;
  const bgTimer = setTimeout(() => {
    movedToBackground = true;
    bgJob = createJob(`Generate ${capturedNode.ref_id || capturedNode.name || 'requirement'}`, 'single');
    updateJobProgress(bgJob, 0, 1, 'Waiting for AI...');
    statusEl.textContent = 'Moved to background — you can navigate away.';
    statusEl.className = 'wb-gen-status wb-gen-status-bg';
    runBtn.disabled = false;
    runBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8 1V3M8 13V15M3 8H1M15 8H13M4 4L2.5 2.5M13.5 13.5L12 12M4 12L2.5 13.5M13.5 2.5L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.3"/></svg> Generate with AI`;
  }, WB_FOREGROUND_TIMEOUT);

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement, prompt: userPrompt })
    });
    clearTimeout(bgTimer);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Generation failed');
    const data = json.data;
    const apiMeta = json.meta || {};

    const genMeta = {
      prompt_template: apiMeta.prompt_template || 'requirement-analyzer',
      prompt_template_version: apiMeta.prompt_template_version || promptVersion,
      steering_prompt: steering || null,
      triggered_by: wbAdminUser,
      generated_at: new Date().toISOString(),
      model: apiMeta.model || 'gemini-2.5-pro'
    };
    const audit = makeAiAuditFields();

    if (doQuestions && data.questions && data.questions.length) {
      const nodeUrn = capturedNode.urn || '';
      if (doReplace) {
        const existingQs = capturedNode.questions || {};
        const deletedCount = Object.keys(existingQs).length;
        if (deletedCount) {
          const snapshot = JSON.parse(JSON.stringify(existingQs));
          wbLogAudit('ai_wipe_replace', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'question', count: deletedCount, snapshot, summary: `wiped ${deletedCount} questions for re-generation` });
        }
      }
      const newQuestions = {};
      const existingCount = doReplace ? 0 : Object.keys(capturedNode.questions || {}).length;
      data.questions.forEach((q, idx) => {
        const qNum = existingCount + idx + 1;
        const qUrn = `${nodeUrn}:question:${qNum}`;
        const qText = q.question || q.text || '';
        newQuestions[qUrn] = {
          type: 'unique_choice', item_type: 'question', text: qText, content_ar: qText,
          content_en: q.question_en || q.text_en || '',
          included_in_ai_scope: true, provenance: 'ai_generated',
          generation_metadata: genMeta, ...audit, display_order: existingCount + idx,
          choices: [
            { urn: `${qUrn}:choice:1`, value: 'Yes' },
            { urn: `${qUrn}:choice:2`, value: 'No' },
            { urn: `${qUrn}:choice:3`, value: 'Partial' }
          ]
        };
      });
      if (doReplace) { capturedNode.questions = newQuestions; }
      else { capturedNode.questions = { ...(capturedNode.questions || {}), ...newQuestions }; }
      wbLogAudit('ai_generate', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'question', count: data.questions.length, summary: `generated ${data.questions.length} questions` });
    }

    if (doEvidence && data.typical_evidence && data.typical_evidence.length) {
      if (doReplace) {
        const existingEv = getEvidenceItems(capturedNode);
        const deletedCount = existingEv.length;
        if (deletedCount) {
          const snapshot = JSON.parse(JSON.stringify(existingEv));
          wbLogAudit('ai_wipe_replace', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'typical_evidence', count: deletedCount, snapshot, summary: `wiped ${deletedCount} evidence items for re-generation` });
        }
      }
      const existingItems = doReplace ? [] : getEvidenceItems(capturedNode);
      const newItems = data.typical_evidence
        .filter(e => e.title || e.description)
        .map((e, idx) => ({
          id: existingItems.length + idx, title: e.title || '',
          item_type: 'typical_evidence',
          description: e.description || '', content_ar: e.description || '',
          content_en: e.description_en || '', excluded: false,
          included_in_ai_scope: true, provenance: 'ai_generated',
          generation_metadata: genMeta, ...audit,
          display_order: existingItems.length + idx
        }));
      const merged = [...existingItems, ...newItems];
      capturedNode.typical_evidence_items = merged;
      capturedNode.typical_evidence = evidenceItemsToTextLegacy(merged);
      wbLogAudit('ai_generate', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: capturedNode.urn, item_type: 'typical_evidence', count: newItems.length, summary: `generated ${newItems.length} evidence items` });
    }

    if (movedToBackground) {
      completeJob(bgJob, [{ ref: capturedNode.ref_id, ok: true, qAdded: data.questions?.length || 0, eAdded: data.typical_evidence?.length || 0 }]);
      if (wbCurrentNode === capturedNode) {
        renderQuestionsList();
        renderEvidenceList();
        markDirty();
      }
    } else {
      renderQuestionsList();
      renderEvidenceList();
      markDirty();
      statusEl.textContent = 'Generation complete.';
      statusEl.className = 'wb-gen-status wb-gen-status-ok';
      if (typeof toast === 'function') toast('success', 'Generated', 'AI content generated. Review and save.');
    }
  } catch (e) {
    clearTimeout(bgTimer);
    if (movedToBackground && bgJob) {
      failJob(bgJob, e.message);
    } else {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.className = 'wb-gen-status wb-gen-status-err';
      if (typeof toast === 'function') toast('error', 'Generation Failed', e.message);
    }
  } finally {
    if (!movedToBackground) {
      runBtn.disabled = false;
      runBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8 1V3M8 13V15M3 8H1M15 8H13M4 4L2.5 2.5M13.5 13.5L12 12M4 12L2.5 13.5M13.5 2.5L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.3"/></svg> Generate with AI`;
    }
  }
}

// ── Save to API ──

async function saveRequirement() {
  if (!wbCurrentLibrary || !wbCurrentNode) return;
  const libId = wbCurrentLibrary._id || wbCurrentLibrary.id;
  const saveBtn = document.getElementById('wb-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  const evidenceText = wbCurrentNode.typical_evidence || '';
  const evidenceItems = wbCurrentNode.typical_evidence_items || getEvidenceItems(wbCurrentNode);
  const questions = wbCurrentNode.questions || {};
  const adminNotes = wbCurrentNode.admin_notes || [];

  const pendingLog = wbAuditLog.splice(0);

  try {
    const apiUrl = `${MURAJI_API}/${libId}/controls`;
    const res = await fetch(apiUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [{
          code: wbCurrentNode.ref_id,
          typical_requirements: evidenceText,
          typical_evidence_items: evidenceItems,
          questions: questions,
          admin_notes: adminNotes,
          audit_log: pendingLog
        }]
      })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || data.error || `HTTP ${res.status}`);
    }
    updateDirtyState(false);
    if (typeof toast === 'function') toast('success', 'Saved', 'Requirement updated successfully.');
  } catch (e) {
    wbAuditLog.unshift(...pendingLog);
    if (typeof toast === 'function') toast('error', 'Save Failed', e.message);
  } finally {
    saveBtn.disabled = wbDirty ? false : true;
    saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M11 1H3C2.4 1 2 1.4 2 2V12C2 12.6 2.4 13 3 13H11C11.6 13 12 12.6 12 12V4L9 1Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 1V4H12M5 8H9M5 10.5H7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Save Changes`;
  }
}

// ─── Status View ──────────────────────────────────────────────

let wbPopulationMinQ = 1;
let wbPopulationMinE = 1;

function getRequirementStatus(node) {
  const questions = node.questions ? Object.values(node.questions) : [];
  const qInScope = questions.filter(q => q.included_in_ai_scope !== false);
  const eItems = getEvidenceItems(node);
  const eInScope = eItems.filter(e => e.included_in_ai_scope !== false);
  const qTotal = questions.length;
  const eTotal = eItems.length;
  if (qTotal === 0 && eTotal === 0) return 'empty';
  const allQScoped = qTotal > 0 && qInScope.length === qTotal;
  const allEScoped = eTotal > 0 && eInScope.length === eTotal;
  if (allQScoped && allEScoped && qInScope.length >= wbPopulationMinQ && eInScope.length >= wbPopulationMinE) return 'full';
  if (qTotal > 0 || eTotal > 0) return 'partial';
  return 'empty';
}

function getStatusLabel(status) {
  const map = { full: 'Full', partial: 'Partial', empty: 'Empty' };
  return map[status] || status;
}

function getStatusClass(status) {
  return `wb-status-chip wb-status-${status}`;
}

function collectParentSections(nodes) {
  const parents = new Map();
  nodes.forEach(n => {
    if (n.assessable && n.parent_urn) {
      const parent = nodes.find(p => p.urn === n.parent_urn);
      if (parent) parents.set(parent.urn, parent);
    }
  });
  return Array.from(parents.values());
}

function getAssessableRows() {
  if (!wbCurrentLibrary) return [];
  const fw = (wbCurrentLibrary.content && wbCurrentLibrary.content.framework) || wbCurrentLibrary.framework || {};
  const nodes = fw.requirement_nodes || [];
  return nodes.filter(n => n.assessable).map(n => {
    const qCount = n.questions ? Object.keys(n.questions).length : 0;
    const evidenceItems = Array.isArray(n.typical_evidence_items) ? n.typical_evidence_items.length
      : (n.typical_evidence ? n.typical_evidence.split('\n').filter(l => l.trim()).length : 0);
    const noteCount = Array.isArray(n.admin_notes) ? n.admin_notes.length : 0;
    const status = getRequirementStatus(n);
    const parent = nodes.find(p => p.urn === n.parent_urn);
    return { node: n, qCount, evidenceItems, noteCount, status, parent };
  });
}

function renderWbStatusView() {
  if (!wbCurrentLibrary) return;
  const fw = (wbCurrentLibrary.content && wbCurrentLibrary.content.framework) || wbCurrentLibrary.framework || {};
  const nodes = fw.requirement_nodes || [];

  const parentFilter = document.getElementById('wb-parent-filter');
  const currentVal = parentFilter.value;
  const sections = collectParentSections(nodes);
  parentFilter.innerHTML = '<option value="all">All sections</option>' +
    sections.map(s => `<option value="${escapeHtml(s.urn)}">${escapeHtml(s.ref_id || '')} ${escapeHtml(s.name || '')}</option>`).join('');
  parentFilter.value = currentVal;

  const rows = getAssessableRows();

  const full = rows.filter(r => r.status === 'full').length;
  const partial = rows.filter(r => r.status === 'partial').length;
  const empty = rows.filter(r => r.status === 'empty').length;
  document.getElementById('wb-status-summary').innerHTML = `
    <div class="wb-summary-card wb-summary-full"><span class="wb-summary-num">${full}</span><span class="wb-summary-label">Full</span></div>
    <div class="wb-summary-card wb-summary-partial"><span class="wb-summary-num">${partial}</span><span class="wb-summary-label">Partial</span></div>
    <div class="wb-summary-card wb-summary-empty"><span class="wb-summary-num">${empty}</span><span class="wb-summary-label">Empty</span></div>
    <div class="wb-summary-card wb-summary-total"><span class="wb-summary-num">${rows.length}</span><span class="wb-summary-label">Total</span></div>`;

  renderStatusTable(rows);
  wireStatusEvents();
}

function filterAndSortRows(rows) {
  const statusVal = document.getElementById('wb-status-filter').value;
  const parentVal = document.getElementById('wb-parent-filter').value;
  const sortVal = document.getElementById('wb-sort-select').value;

  let filtered = rows;
  if (statusVal !== 'all') filtered = filtered.filter(r => r.status === statusVal);
  if (parentVal !== 'all') filtered = filtered.filter(r => r.node.parent_urn === parentVal);

  filtered.sort((a, b) => {
    switch (sortVal) {
      case 'status-asc': {
        const order = { empty: 0, partial: 1, full: 2 };
        return (order[a.status] ?? 1) - (order[b.status] ?? 1);
      }
      case 'status-desc': {
        const order = { full: 0, partial: 1, empty: 2 };
        return (order[a.status] ?? 1) - (order[b.status] ?? 1);
      }
      case 'questions': return b.qCount - a.qCount;
      default: return (a.node.ref_id || '').localeCompare(b.node.ref_id || '');
    }
  });
  return filtered;
}

function renderStatusTable(rows) {
  const filtered = filterAndSortRows(rows);
  const tbody = document.getElementById('wb-status-tbody');

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="wb-st-empty">No matching requirements.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const parentLabel = r.parent ? (r.parent.ref_id || r.parent.name || '') : '';
    return `<tr data-urn="${escapeHtml(r.node.urn)}">
      <td class="wb-st-check"><input type="checkbox" class="wb-row-check" data-urn="${escapeHtml(r.node.urn)}"></td>
      <td class="wb-st-ref">${escapeHtml(r.node.ref_id || '')}</td>
      <td class="wb-st-name">
        <span class="wb-st-name-text">${escapeHtml(r.node.name || r.node.description || '')}</span>
        ${parentLabel ? `<span class="wb-st-parent-label">${escapeHtml(parentLabel)}</span>` : ''}
      </td>
      <td class="wb-st-q">${r.qCount}</td>
      <td class="wb-st-e">${r.evidenceItems}</td>
      <td class="wb-st-n">${r.noteCount}</td>
      <td class="wb-st-status"><span class="${getStatusClass(r.status)}">${getStatusLabel(r.status)}</span></td>
      <td class="wb-st-action"><button class="wb-st-edit-btn" data-urn="${escapeHtml(r.node.urn)}" title="Edit">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button></td>
    </tr>`;
  }).join('');

  updateBulkUI();
}

function wireStatusEvents() {
  document.getElementById('wb-status-filter').onchange = () => renderStatusTable(getAssessableRows());
  document.getElementById('wb-parent-filter').onchange = () => renderStatusTable(getAssessableRows());
  document.getElementById('wb-sort-select').onchange = () => renderStatusTable(getAssessableRows());
  document.getElementById('wb-threshold-filter').onchange = (e) => {
    const [q, ev] = e.target.value.split(',').map(Number);
    wbPopulationMinQ = q;
    wbPopulationMinE = ev;
    renderWbStatusView();
  };

  document.getElementById('wb-select-all').onchange = (e) => {
    document.querySelectorAll('.wb-row-check').forEach(c => { c.checked = e.target.checked; });
    updateBulkUI();
  };

  document.getElementById('wb-status-tbody').onclick = (e) => {
    const editBtn = e.target.closest('.wb-st-edit-btn');
    if (editBtn) { openRequirementDetail(editBtn.dataset.urn); return; }
    const checkbox = e.target.closest('.wb-row-check');
    if (checkbox) { setTimeout(updateBulkUI, 0); return; }
  };

  document.getElementById('wb-bulk-gen-btn').onclick = () => runBulkGeneration();

  const bulkSteeringEl = document.getElementById('wb-bulk-steering');
  const bulkCharCount = document.getElementById('wb-bulk-char-count');
  bulkSteeringEl.oninput = () => { bulkCharCount.textContent = `${bulkSteeringEl.value.length} / 2000`; };
}

function updateBulkUI() {
  const checked = document.querySelectorAll('.wb-row-check:checked');
  const actions = document.getElementById('wb-bulk-actions');
  const countEl = document.getElementById('wb-bulk-count');
  const steeringWrap = document.getElementById('wb-bulk-steering-wrap');
  if (checked.length > 0) {
    actions.style.display = '';
    steeringWrap.style.display = '';
    countEl.textContent = `${checked.length} selected`;
  } else {
    actions.style.display = 'none';
    steeringWrap.style.display = 'none';
  }
}

async function runBulkGeneration() {
  const checked = Array.from(document.querySelectorAll('.wb-row-check:checked'));
  if (!checked.length || !wbCurrentLibrary) return;

  const mode = document.getElementById('wb-bulk-mode').value;
  const isReplace = mode === 'regenerate';
  const steering = document.getElementById('wb-bulk-steering').value.trim();

  const capturedLib = wbCurrentLibrary;
  const fw = (capturedLib.content && capturedLib.content.framework) || capturedLib.framework || {};
  const nodes = fw.requirement_nodes || [];
  const urns = checked.map(c => c.dataset.urn);
  let targetNodes = urns.map(u => nodes.find(n => n.urn === u)).filter(Boolean);

  if (mode === 'empty-only') {
    targetNodes = targetNodes.filter(n => getRequirementStatus(n) === 'empty');
    if (!targetNodes.length) {
      if (typeof toast === 'function') toast('info', 'Nothing to generate', 'All selected requirements already have content.');
      return;
    }
  }

  if (isReplace) {
    let totalQDelete = 0, totalEDelete = 0;
    targetNodes.forEach(n => {
      totalQDelete += n.questions ? Object.keys(n.questions).length : 0;
      totalEDelete += getEvidenceItems(n).length;
    });
    if (totalQDelete + totalEDelete > 0) {
      const confirmed = await showBulkReplaceConfirmation(targetNodes.length, totalQDelete, totalEDelete);
      if (!confirmed) return;
    }
  } else {
    const goAhead = await wbConfirm('Bulk generation', `Generate AI content for <strong>${targetNodes.length}</strong> empty requirement(s)? This will run as a background job.`, { confirmLabel: 'Generate' });
    if (!goAhead) return;
  }

  const job = createJob(`Bulk ${isReplace ? 're-generate' : 'generate'} (${targetNodes.length} reqs)`, 'bulk');
  const total = targetNodes.length;

  const progressWrap = document.getElementById('wb-bulk-progress');
  const fill = document.getElementById('wb-progress-fill');
  const textEl = document.getElementById('wb-progress-text');
  const genBtn = document.getElementById('wb-bulk-gen-btn');
  const resultsEl = document.getElementById('wb-bulk-results');
  progressWrap.style.display = '';
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';
  fill.style.width = '0%';
  genBtn.disabled = true;
  genBtn.innerHTML = '<div class="spinner-sm"></div> Running in background...';

  let bulkPromptVersion = null;
  try { const pr = await fetch('/api/local-prompts'); const pj = await pr.json(); if (pj.prompts && pj.prompts[0]) bulkPromptVersion = pj.prompts[0].updated_at || pj.prompts[0].id || null; } catch (_) {}

  const processBulk = async () => {
    const results = [];
    let done = 0;

    for (const node of targetNodes) {
      if (wbBulkAbort) break;
      done++;
      updateJobProgress(job, done, total, node.ref_id || node.name || '');
      fill.style.width = `${(done / total) * 100}%`;
      textEl.textContent = `Processing ${done}/${total}: ${node.ref_id || node.name || ''}...`;

      const parentNodes = nodes.filter(n => {
        let pUrn = node.parent_urn;
        while (pUrn) {
          const parent = nodes.find(p => p.urn === pUrn);
          if (!parent) break;
          if (parent.urn === n.urn) return true;
          pUrn = parent.parent_urn;
        }
        return false;
      });
      const breadcrumb = parentNodes.map(p => `${p.ref_id || ''} ${p.name || ''}`).join(' > ');
      const requirement = {
        ref_id: node.ref_id || '', name: node.name || '',
        description: node.description || '', nodeUrn: node.urn || '',
        framework: fw.name || '', framework_ref_id: fw.ref_id || '', breadcrumb
      };
      const userPrompt = steering ? `[Admin steering instructions]: ${steering}` : 'No additional context provided.';

      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requirement, prompt: userPrompt })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Generation failed');
        const data = json.data;
        const bulkApiMeta = json.meta || {};

        const bulkGenMeta = {
          prompt_template: bulkApiMeta.prompt_template || 'requirement-analyzer',
          prompt_template_version: bulkApiMeta.prompt_template_version || bulkPromptVersion,
          steering_prompt: steering || null,
          triggered_by: wbAdminUser,
          generated_at: new Date().toISOString(),
          model: bulkApiMeta.model || 'gemini-2.5-pro'
        };
        const bulkAudit = makeAiAuditFields();
        let qAdded = 0, eAdded = 0;

        if (data.questions && data.questions.length) {
          if (isReplace) {
            const existingQs = node.questions || {};
            const dc = Object.keys(existingQs).length;
            if (dc) {
              const snapshot = JSON.parse(JSON.stringify(existingQs));
              wbLogAudit('ai_wipe_replace', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: node.urn, item_type: 'question', count: dc, snapshot, summary: `bulk: wiped ${dc} questions` });
            }
          }
          const baseCount = isReplace ? 0 : Object.keys(node.questions || {}).length;
          const newQuestions = {};
          data.questions.forEach((q, idx) => {
            const qNum = baseCount + idx + 1;
            const qUrn = `${node.urn}:question:${qNum}`;
            const qText = q.question || q.text || '';
            newQuestions[qUrn] = {
              type: 'unique_choice', item_type: 'question', text: qText, content_ar: qText,
              content_en: q.question_en || q.text_en || '',
              included_in_ai_scope: true, provenance: 'ai_generated',
              generation_metadata: bulkGenMeta, ...bulkAudit,
              display_order: baseCount + idx,
              choices: [
                { urn: `${qUrn}:choice:1`, value: 'Yes' },
                { urn: `${qUrn}:choice:2`, value: 'No' },
                { urn: `${qUrn}:choice:3`, value: 'Partial' }
              ]
            };
          });
          node.questions = isReplace ? newQuestions : { ...(node.questions || {}), ...newQuestions };
          qAdded = data.questions.length;
          wbLogAudit('ai_generate', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: node.urn, item_type: 'question', count: qAdded, summary: `bulk: generated ${qAdded} questions` });
        } else if (isReplace) { node.questions = {}; }

        if (data.typical_evidence && data.typical_evidence.length) {
          if (isReplace) {
            const existingEv = getEvidenceItems(node);
            const dc = existingEv.length;
            if (dc) {
              const snapshot = JSON.parse(JSON.stringify(existingEv));
              wbLogAudit('ai_wipe_replace', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: node.urn, item_type: 'typical_evidence', count: dc, snapshot, summary: `bulk: wiped ${dc} evidence items` });
            }
          }
          const existingItems = isReplace ? [] : getEvidenceItems(node);
          const newItems = data.typical_evidence
            .filter(e => e.title || e.description)
            .map((e, idx) => ({
              id: existingItems.length + idx, title: e.title || '',
              item_type: 'typical_evidence',
              description: e.description || '', content_ar: e.description || '',
              content_en: e.description_en || '', excluded: false,
              included_in_ai_scope: true, provenance: 'ai_generated',
              generation_metadata: bulkGenMeta, ...bulkAudit,
              display_order: existingItems.length + idx
            }));
          const merged = [...existingItems, ...newItems];
          node.typical_evidence_items = merged;
          node.typical_evidence = evidenceItemsToTextLegacy(merged);
          eAdded = newItems.length;
          wbLogAudit('ai_generate', { actor: WB_AI_SERVICE_ACCOUNT, triggered_by: wbAdminUser, urn: node.urn, item_type: 'typical_evidence', count: eAdded, summary: `bulk: generated ${eAdded} evidence items` });
        } else if (isReplace) { node.typical_evidence_items = []; node.typical_evidence = ''; }

        const libId = capturedLib._id || capturedLib.id;
        const bulkPendingLog = wbAuditLog.splice(0);
        await fetch(`${MURAJI_API}/${libId}/controls`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{
              code: node.ref_id,
              typical_requirements: node.typical_evidence || '',
              typical_evidence_items: node.typical_evidence_items || [],
              questions: node.questions || {},
              admin_notes: node.admin_notes || [],
              audit_log: bulkPendingLog
            }]
          })
        });
        results.push({ ref: node.ref_id || node.name, ok: true, qAdded, eAdded });
      } catch (e) {
        results.push({ ref: node.ref_id || node.name, ok: false, error: e.message });
        console.error(`Bulk gen failed for ${node.ref_id}:`, e);
      }
    }

    completeJob(job, results);

    const succeeded = results.filter(r => r.ok).length;
    const failedCount = results.filter(r => !r.ok).length;
    fill.style.width = '100%';
    textEl.textContent = `Done: ${succeeded} succeeded, ${failedCount} failed out of ${total}.`;
    genBtn.disabled = false;
    genBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8 1V3M8 13V15M3 8H1M15 8H13M4 4L2.5 2.5M13.5 13.5L12 12M4 12L2.5 13.5M13.5 2.5L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.3"/></svg> Run`;

    resultsEl.style.display = '';
    resultsEl.innerHTML = `<h4 class="wb-results-title">Results</h4>` + results.map(r => {
      if (r.ok) return `<div class="wb-result-row wb-result-ok"><span class="wb-result-ref">${escapeHtml(r.ref)}</span> <span class="wb-result-detail">+${r.qAdded}Q, +${r.eAdded}E</span></div>`;
      return `<div class="wb-result-row wb-result-fail"><span class="wb-result-ref">${escapeHtml(r.ref)}</span> <span class="wb-result-error">${escapeHtml(r.error)}</span></div>`;
    }).join('');

    if (wbCurrentLibrary === capturedLib && wbCurrentDetailView === 'status') renderWbStatusView();
    document.getElementById('wb-select-all').checked = false;
  };

  processBulk();
}

function showBulkReplaceConfirmation(reqCount, totalQ, totalE) {
  return new Promise((resolve) => {
    const existing = document.querySelector('.wb-confirm-overlay');
    if (existing) existing.remove();

    const parts = [];
    if (totalQ > 0) parts.push(`${totalQ} question${totalQ !== 1 ? 's' : ''}`);
    if (totalE > 0) parts.push(`${totalE} evidence item${totalE !== 1 ? 's' : ''}`);
    const summary = parts.join(' and ');

    const overlay = document.createElement('div');
    overlay.className = 'wb-confirm-overlay';
    overlay.innerHTML = `
      <div class="wb-confirm-modal">
        <div class="wb-confirm-icon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><path d="M14 2L2 26H26L14 2Z" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 10V16" stroke="#dc2626" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="20" r="1.2" fill="#dc2626"/></svg>
        </div>
        <h3 class="wb-confirm-title">Bulk re-generate ${reqCount} requirement${reqCount !== 1 ? 's' : ''}?</h3>
        <div class="wb-confirm-body">
          <p>This will <strong>permanently delete</strong> ${summary} across ${reqCount} requirement${reqCount !== 1 ? 's' : ''} and replace them with newly generated content.</p>
          <ul class="wb-confirm-warnings">
            <li>Any manual edits to those items will be lost</li>
            <li>The deletion will be recorded in the audit log (prior content is recoverable through audit history)</li>
          </ul>
        </div>
        <div class="wb-confirm-actions">
          <button class="btn-admin-ghost wb-confirm-cancel">Cancel</button>
          <button class="btn-admin-danger wb-confirm-accept">I understand, replace all</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.wb-confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.wb-confirm-accept').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

// ─── Audit Log ────────────────────────────────────────────────

let alComplianceAssessments = [];
let alCurrentCA = null;
let alRequirementAssessments = [];
let alRequirements = [];

const AL_STATUS_LABELS = {
  to_do: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done'
};
const AL_STATUS_COLORS = {
  to_do: '#94a3b8', in_progress: '#f59e0b', in_review: '#8b5cf6', done: '#22c55e'
};
const AL_RESULT_LABELS = {
  not_assessed: 'Not Assessed', compliant: 'Compliant', partially_compliant: 'Partially Compliant',
  non_compliant: 'Non-Compliant', not_applicable: 'N/A'
};
const AL_RESULT_COLORS = {
  not_assessed: '#94a3b8', compliant: '#22c55e', partially_compliant: '#f59e0b',
  non_compliant: '#ef4444', not_applicable: '#6b7280'
};

function alShowView(view) {
  document.getElementById('al-ca-list-view').style.display = view === 'list' ? '' : 'none';
  document.getElementById('al-ra-list-view').style.display = view === 'ras' ? '' : 'none';
  document.getElementById('al-ra-detail-view').style.display = view === 'detail' ? '' : 'none';
}

async function loadAuditLog(subId) {
  alShowView('list');
  const grid = document.getElementById('al-ca-grid');
  grid.innerHTML = '<div class="al-loading"><div class="spinner-sm"></div> Loading compliance assessments...</div>';
  try {
    const res = await fetch('/api/grc/compliance-assessments');
    const json = await res.json();
    alComplianceAssessments = json.results || [];
    if (subId) {
      await alOpenCA(subId);
    } else {
      alRenderCAGrid();
    }
  } catch (e) {
    grid.innerHTML = `<div class="al-error">Failed to load compliance assessments: ${e.message}</div>`;
  }
}

function alRenderCAGrid(filter) {
  const grid = document.getElementById('al-ca-grid');
  const q = (filter || '').toLowerCase();
  const filtered = q
    ? alComplianceAssessments.filter(ca => {
        const name = (ca.name || ca.str || '').toLowerCase();
        const fw = ((ca.framework && ca.framework.str) || '').toLowerCase();
        return name.includes(q) || fw.includes(q);
      })
    : alComplianceAssessments;

  if (!filtered.length) {
    grid.innerHTML = `<div class="al-empty">No compliance assessments found${q ? ` matching "${filter}"` : ''}.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(ca => {
    const name = ca.name || ca.str || 'Unnamed Assessment';
    const fw = (ca.framework && ca.framework.str) || '';
    const perimeter = (ca.perimeter && ca.perimeter.str) || '';
    const locked = ca.is_locked;
    const created = ca.created_at ? new Date(ca.created_at).toLocaleDateString() : '';
    return `<div class="al-ca-card" data-ca-id="${ca.id}">
      <div class="al-ca-card-header">
        <h3 class="al-ca-card-title">${escapeHtml(name)}</h3>
        ${locked ? '<span class="al-badge al-badge-locked">Locked</span>' : ''}
      </div>
      <div class="al-ca-card-meta">
        ${fw ? `<span class="al-ca-meta-item"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M5 6H11M5 8.5H9M5 11H7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> ${escapeHtml(fw)}</span>` : ''}
        ${perimeter ? `<span class="al-ca-meta-item"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/></svg> ${escapeHtml(perimeter)}</span>` : ''}
        ${created ? `<span class="al-ca-meta-item"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 1V4M11 1V4M2 7H14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> ${created}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.al-ca-card').forEach(card => {
    card.addEventListener('click', () => alOpenCA(card.dataset.caId));
  });
}

async function alOpenCA(caId) {
  alShowView('ras');
  alCurrentCA = alComplianceAssessments.find(c => c.id === caId) || { id: caId, name: caId };
  const title = alCurrentCA.name || alCurrentCA.str || 'Assessment';
  document.getElementById('al-ra-title').textContent = title;
  const fw = (alCurrentCA.framework && alCurrentCA.framework.str) || '';
  document.getElementById('al-ra-subtitle').textContent = fw;

  updateRoute('audit-log', caId);

  document.getElementById('al-ra-back-btn').onclick = () => {
    alShowView('list');
    updateRoute('audit-log', null);
    alRenderCAGrid(document.getElementById('al-ca-search').value);
  };

  const tbody = document.getElementById('al-ra-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="al-loading"><div class="spinner-sm"></div> Loading requirement assessments...</td></tr>';

  try {
    const assessable = document.getElementById('al-filter-assessable').value;
    const qs = assessable ? `?assessable=${assessable}` : '';
    const res = await fetch(`/api/grc/compliance-assessments/${caId}/requirements-list${qs}`);
    const json = await res.json();
    if (!json.success && json.error) throw new Error(json.error);
    alRequirementAssessments = json.requirement_assessments || [];
    alRequirements = json.requirements || [];
    alRenderRATable();
    alWireRAFilters();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="al-error">Failed to load: ${e.message}</td></tr>`;
  }
}

function alWireRAFilters() {
  const handler = () => alRenderRATable();
  document.getElementById('al-filter-status').onchange = handler;
  document.getElementById('al-filter-result').onchange = handler;
  document.getElementById('al-ra-search').oninput = handler;
  document.getElementById('al-filter-assessable').onchange = async () => {
    if (alCurrentCA) await alOpenCA(alCurrentCA.id);
  };
}

function alRenderRATable() {
  const tbody = document.getElementById('al-ra-tbody');
  const statusF = document.getElementById('al-filter-status').value;
  const resultF = document.getElementById('al-filter-result').value;
  const q = (document.getElementById('al-ra-search').value || '').toLowerCase();

  let rows = alRequirementAssessments;
  if (statusF) rows = rows.filter(r => r.status === statusF);
  if (resultF) rows = rows.filter(r => r.result === resultF);
  if (q) rows = rows.filter(r => {
    const ref = (r.requirement && r.requirement.ref_id) || '';
    const name = (r.requirement && r.requirement.name) || r.name || '';
    const desc = (r.requirement && r.requirement.description) || r.description || '';
    return ref.toLowerCase().includes(q) || name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
  });

  const stats = document.getElementById('al-ra-stats');
  const totalCount = alRequirementAssessments.length;
  const statusCounts = {};
  alRequirementAssessments.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
  stats.innerHTML = `<span class="al-stat-total">${totalCount} total</span>` +
    Object.entries(statusCounts).map(([s, c]) =>
      `<span class="al-stat-chip" style="--chip-color:${AL_STATUS_COLORS[s] || '#94a3b8'}">${AL_STATUS_LABELS[s] || s}: ${c}</span>`
    ).join('');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="al-empty">No matching requirement assessments.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(ra => {
    const req = ra.requirement || {};
    const refId = req.ref_id || '';
    const name = req.name || ra.name || '';
    const status = ra.status || 'to_do';
    const result = ra.result || 'not_assessed';
    const evidenceCount = (ra.evidences || []).length;
    const controlsCount = (ra.applied_controls || []).length;
    const updated = ra.updated_at ? alRelativeDate(ra.updated_at) : '';

    return `<tr class="al-ra-row" data-ra-id="${ra.id}">
      <td class="al-td-ref"><span class="al-ref-badge">${escapeHtml(refId)}</span></td>
      <td class="al-td-name">${escapeHtml(name)}</td>
      <td class="al-td-status"><span class="al-status-badge" style="--badge-color:${AL_STATUS_COLORS[status] || '#94a3b8'}">${AL_STATUS_LABELS[status] || status}</span></td>
      <td class="al-td-result"><span class="al-result-badge" style="--badge-color:${AL_RESULT_COLORS[result] || '#94a3b8'}">${AL_RESULT_LABELS[result] || result}</span></td>
      <td class="al-td-count">${evidenceCount}</td>
      <td class="al-td-count">${controlsCount}</td>
      <td class="al-td-date">${updated}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.al-ra-row').forEach(row => {
    row.addEventListener('click', () => alOpenRADetail(row.dataset.raId));
  });
}

function alRelativeDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString();
}

function alOpenRADetail(raId) {
  const ra = alRequirementAssessments.find(r => r.id === raId);
  if (!ra) return;
  alShowView('detail');
  const req = ra.requirement || {};
  document.getElementById('al-detail-title').textContent = `${req.ref_id || ''} — ${req.name || ra.name || ''}`;
  document.getElementById('al-detail-subtitle').textContent = (alCurrentCA && alCurrentCA.name) || '';
  document.getElementById('al-detail-back-btn').onclick = () => {
    alShowView('ras');
    alRenderRATable();
  };

  const content = document.getElementById('al-detail-content');
  const status = ra.status || 'to_do';
  const result = ra.result || 'not_assessed';
  const extResult = ra.extended_result;

  content.innerHTML = `
    <div class="al-detail-grid">
      <div class="al-detail-card al-detail-card-wide">
        <h4 class="al-detail-card-title">Overview</h4>
        <div class="al-detail-field-grid">
          <div class="al-detail-field">
            <label>Status</label>
            <span class="al-status-badge" style="--badge-color:${AL_STATUS_COLORS[status]}">${AL_STATUS_LABELS[status] || status}</span>
          </div>
          <div class="al-detail-field">
            <label>Result</label>
            <span class="al-result-badge" style="--badge-color:${AL_RESULT_COLORS[result]}">${AL_RESULT_LABELS[result] || result}</span>
          </div>
          ${extResult ? `<div class="al-detail-field"><label>Extended Result</label><span class="al-ext-result">${escapeHtml(extResult.replace(/_/g, ' '))}</span></div>` : ''}
          ${ra.score != null ? `<div class="al-detail-field"><label>Score</label><span>${ra.score}${ra.compliance_assessment ? ` / ${ra.compliance_assessment.max_score}` : ''}</span></div>` : ''}
          ${ra.eta ? `<div class="al-detail-field"><label>ETA</label><span>${ra.eta}</span></div>` : ''}
          ${ra.due_date ? `<div class="al-detail-field"><label>Due Date</label><span>${ra.due_date}</span></div>` : ''}
          <div class="al-detail-field"><label>Assessable</label><span>${ra.assessable ? 'Yes' : 'No'}</span></div>
          <div class="al-detail-field"><label>Locked</label><span>${ra.is_locked ? 'Yes' : 'No'}</span></div>
        </div>
      </div>

      <div class="al-detail-card">
        <h4 class="al-detail-card-title">Requirement</h4>
        <div class="al-detail-field"><label>URN</label><span class="al-mono">${escapeHtml(req.urn || '')}</span></div>
        <div class="al-detail-field"><label>Ref ID</label><span class="al-ref-badge">${escapeHtml(req.ref_id || '')}</span></div>
        ${req.description ? `<div class="al-detail-field"><label>Description</label><p class="al-detail-desc">${escapeHtml(req.description)}</p></div>` : ''}
        ${req.annotation ? `<div class="al-detail-field"><label>Annotation</label><p class="al-detail-desc">${escapeHtml(req.annotation)}</p></div>` : ''}
        ${req.typical_evidence ? `<div class="al-detail-field"><label>Typical Evidence</label><p class="al-detail-desc">${escapeHtml(req.typical_evidence)}</p></div>` : ''}
      </div>

      <div class="al-detail-card">
        <h4 class="al-detail-card-title">Observation</h4>
        <p class="al-detail-desc">${ra.observation ? escapeHtml(ra.observation) : '<em class="al-muted">No observation recorded.</em>'}</p>
      </div>

      ${alRenderAnswersCard(ra, req)}
      ${alRenderLinkedCard('Evidence', ra.evidences)}
      ${alRenderLinkedCard('Applied Controls', ra.applied_controls)}
      ${alRenderLinkedCard('Security Exceptions', ra.security_exceptions)}

      <div class="al-detail-card">
        <h4 class="al-detail-card-title">Timestamps</h4>
        <div class="al-detail-field-grid">
          <div class="al-detail-field"><label>Created</label><span>${ra.created_at ? new Date(ra.created_at).toLocaleString() : '—'}</span></div>
          <div class="al-detail-field"><label>Updated</label><span>${ra.updated_at ? new Date(ra.updated_at).toLocaleString() : '—'}</span></div>
        </div>
      </div>

      <div class="al-detail-card al-detail-card-wide al-audit-log-card">
        <h4 class="al-detail-card-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1C4.1 1 1 4.1 1 8s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7z" stroke="currentColor" stroke-width="1.3"/><path d="M8 4V8L10.5 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Audit Log
        </h4>
        <div id="al-audit-log-entries">
          <div class="al-loading"><div class="spinner-sm"></div> Loading audit log...</div>
        </div>
      </div>
    </div>
  `;

  alFetchAuditLog(ra.id);
}

async function alFetchAuditLog(raId) {
  const container = document.getElementById('al-audit-log-entries');
  try {
    const res = await fetch(`/api/grc/requirement-assessments/${raId}/audit-log`);
    const json = await res.json();
    if (!json.success && json.error) throw new Error(json.error);
    const entries = json.entries || [];
    if (!entries.length) {
      container.innerHTML = '<div class="al-empty">No audit log entries.</div>';
      return;
    }
    container.innerHTML = `<div class="al-timeline">${entries.map(alRenderAuditEntry).join('')}</div>`;
  } catch (e) {
    container.innerHTML = `<div class="al-error">Failed to load audit log: ${e.message}</div>`;
  }
}

function alRenderAuditEntry(entry) {
  const ts = entry.timestamp ? new Date(entry.timestamp) : null;
  const timeStr = ts ? ts.toLocaleString() : '';
  const relTime = ts ? alRelativeDate(entry.timestamp) : '';
  const actor = entry.actor || 'System';
  const action = entry.action || 'update';
  const isAI = actor === 'AI Service' || (entry.additional_data && entry.additional_data.action_type === 'info');

  const actionIcon = {
    create: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    update: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5L14.5 4.5L5 14H2V11L11.5 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    delete: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4H13M5 4V13H11V4M7 7V10M9 7V10M6 4V2H10V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M8 5V5.5M8 7.5V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };
  const actionColor = { create: '#22c55e', update: '#3b82f6', delete: '#ef4444', info: '#8b5cf6' };

  const changes = entry.changes || {};
  const changedFields = Object.keys(changes);
  const ad = entry.additional_data || {};

  let changesHtml = '';
  if (changedFields.length) {
    changesHtml = `<div class="al-log-changes">${changedFields.map(field => {
      const [oldVal, newVal] = changes[field];
      const oldStr = oldVal == null || oldVal === '' ? '<em class="al-muted">empty</em>' : escapeHtml(String(oldVal));
      const newStr = newVal == null || newVal === '' ? '<em class="al-muted">empty</em>' : escapeHtml(String(newVal));
      return `<div class="al-log-change-row">
        <span class="al-log-field">${escapeHtml(field.replace(/_/g, ' '))}</span>
        <span class="al-log-old">${oldStr}</span>
        <svg class="al-log-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6H10M7 3L10 6L7 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="al-log-new">${newStr}</span>
      </div>`;
    }).join('')}</div>`;
  }

  let metaHtml = '';
  if (isAI && ad.description) {
    metaHtml = `<div class="al-log-ai-meta">
      <span class="al-log-ai-desc">${escapeHtml(ad.description)}</span>
      ${ad.applied_fields ? `<span class="al-log-ai-fields">Fields: ${ad.applied_fields.join(', ')}</span>` : ''}
    </div>`;
  } else if (ad.folder) {
    metaHtml = `<div class="al-log-folder">${escapeHtml(ad.folder)}</div>`;
  }

  return `<div class="al-timeline-entry" data-action="${action}">
    <div class="al-timeline-dot" style="--dot-color:${actionColor[action] || '#94a3b8'}">
      ${actionIcon[action] || actionIcon.update}
    </div>
    <div class="al-timeline-body">
      <div class="al-timeline-header">
        <span class="al-log-actor ${isAI ? 'al-log-actor-ai' : ''}">${escapeHtml(actor)}</span>
        <span class="al-log-action-badge" style="--badge-color:${actionColor[action] || '#94a3b8'}">${action}</span>
        <span class="al-log-time" title="${timeStr}">${relTime}</span>
      </div>
      ${changesHtml}
      ${metaHtml}
    </div>
  </div>`;
}

function alRenderAnswersCard(ra, req) {
  const answers = ra.answers || {};
  const questions = req.questions || {};
  const entries = Object.entries(answers);
  if (!entries.length) return '';
  return `<div class="al-detail-card">
    <h4 class="al-detail-card-title">Answers</h4>
    <div class="al-answers-list">
      ${entries.map(([qUrn, aUrn]) => {
        const q = questions[qUrn];
        const qText = q ? (q.text || q.content_ar || qUrn) : qUrn;
        let aText = aUrn;
        if (q && q.choices) {
          const choice = q.choices.find(c => c.urn === aUrn);
          if (choice) aText = choice.value;
        }
        return `<div class="al-answer-row">
          <span class="al-answer-q">${escapeHtml(qText)}</span>
          <span class="al-answer-a">${escapeHtml(String(aText))}</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function alRenderLinkedCard(title, items) {
  if (!items || !items.length) return '';
  return `<div class="al-detail-card">
    <h4 class="al-detail-card-title">${title} <span class="al-count-badge">${items.length}</span></h4>
    <div class="al-linked-list">
      ${items.map(it => `<div class="al-linked-item">${escapeHtml(it.str || it.name || it.id)}</div>`).join('')}
    </div>
  </div>`;
}

// Wire search on CA grid
document.getElementById('al-ca-search').addEventListener('input', (e) => {
  alRenderCAGrid(e.target.value);
});

// ─── Data Studio (Excel upload / import preview) ──────────────

const DATA_STUDIO_CA_STORAGE_KEY = 'ds_data_studio_compliance_assessment_uuid';

let dataStudioUploadWired = false;
/** Policies pane (Data Studio): Excel → POST /api/policies/ */
let dataStudioPolicyUploadWired = false;
let dataStudioPolicyLastFile = null;
/** Hub cards switching applied / policies / risk-scenarios panes */
let dataStudioHubWired = false;
let policyUpdatePipelineWired = false;
/** Cached list for Policy update pipeline org dropdown (from GET /api/org-contexts) */
let pupOrgContextsCache = [];
let policyUpdatePipelineLastRaw = null;
let policyUpdatePipelineResultModalWired = false;
/** Active fetch: abort to cancel in-flight policy pipeline run from the UI */
let pupPipelineAbortController = null;
/** Policy update pipeline wizard: 0 organisation, 1 regulation, 2 policies */
let pupStepperIndex = 0;
const PUP_PIPELINE_LAST_STEP = 2;
let dataStudioLastFile = null;

function restoreDataStudioSavedAudit() {
  const caEl = document.getElementById('ds-compliance-assessment');
  if (!caEl || caEl.value.trim()) return;
  try {
    const saved = localStorage.getItem(DATA_STUDIO_CA_STORAGE_KEY);
    if (saved) caEl.value = saved;
  } catch (_) { /* ignore */ }
}

function persistDataStudioAuditUuid(uuid) {
  const v = String(uuid || '').trim();
  if (!v) return;
  try {
    localStorage.setItem(DATA_STUDIO_CA_STORAGE_KEY, v);
  } catch (_) { /* ignore */ }
}

const DATA_STUDIO_VALID_PANES = new Set(['applied', 'policies', 'risk-scenarios']);

function dataStudioPaneFromHash() {
  const h = (typeof location !== 'undefined' ? location.hash || '' : '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase();
  if (h === 'policies') return 'policies';
  if (h === 'risk-scenarios') return 'risk-scenarios';
  return 'applied';
}

/** Switch Data Studio area; updates URL (/data-studio or /data-studio#…) when syncUrl is true. */
function setDataStudioPane(slug, opts) {
  opts = opts || {};
  const syncUrl = opts.syncUrl !== false;
  const pane = DATA_STUDIO_VALID_PANES.has(slug) ? slug : 'applied';

  document.querySelectorAll('#page-data-studio .ds-hub-card').forEach(btn => {
    const id = btn.getAttribute('data-ds-pane');
    const active = id === pane;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  document.querySelectorAll('#page-data-studio .ds-pane').forEach(el => {
    const id = el.getAttribute('data-ds-pane');
    const active = id === pane;
    el.classList.toggle('ds-pane-active', active);
    el.setAttribute('aria-hidden', active ? 'false' : 'true');
  });

  if (syncUrl && currentPage === 'data-studio' && window.location.pathname === '/data-studio') {
    const desired = pane === 'applied' ? '/data-studio' : `/data-studio#${pane}`;
    const current = `${window.location.pathname}${window.location.hash || ''}`;
    if (current !== desired) {
      history.replaceState({ page: 'data-studio', subId: null }, '', desired);
    }
  }

  if (pane === 'risk-scenarios') {
    ensureRiskStudioLoaded();
  }
}
window.setDataStudioPane = setDataStudioPane;

function syncDataStudioPaneFromHash() {
  setDataStudioPane(dataStudioPaneFromHash(), { syncUrl: false });
}

const RISK_STUDIO_ASSESSMENT_KEY = 'ds_risk_studio_last_assessment_uuid';
let riskStudioPanelWired = false;
let riskStudioStepperWired = false;
/** Data Studio risk wizard: 0 matrix, 1 folder/perimeter seed, 2 assessment POST, 3 scenarios */
let drsStepperIndex = 0;
const DRS_RISK_STUDIO_LAST_STEP = 3;
let dataStudioRiskScenarioLastFile = null;
let dataStudioRiskScenarioUploadWired = false;
let drsWizardBusy = false;

function setRiskStudioWizardBusy(on) {
  drsWizardBusy = !!on;
  syncDataRiskStudioStepperDOM();
}

function syncDataRiskStudioStepperDOM() {
  const root = document.getElementById('ds-pane-risk-scenarios');
  if (!root) return;
  const idx = drsStepperIndex;
  const total = DRS_RISK_STUDIO_LAST_STEP + 1;
  root.querySelectorAll('.drs-step-panel').forEach(panel => {
    const i = Number.parseInt(panel.getAttribute('data-drs-step-index'), 10);
    if (Number.isNaN(i)) return;
    const on = i === idx;
    if (on) {
      panel.removeAttribute('hidden');
      panel.hidden = false;
    } else {
      panel.setAttribute('hidden', '');
      panel.hidden = true;
    }
  });

  root.querySelectorAll('[data-drs-step-label]').forEach(label => {
    const i = Number.parseInt(label.getAttribute('data-drs-step-label'), 10);
    if (Number.isNaN(i)) return;
    label.classList.toggle('is-active', i === idx);
    label.classList.toggle('is-done', i < idx);
    if (i === idx) label.setAttribute('aria-current', 'step');
    else label.removeAttribute('aria-current');
  });

  const fill = document.getElementById('drs-stepper-progress-fill');
  if (fill) fill.style.width = `${((idx + 1) / total) * 100}%`;

  const back = document.getElementById('drs-step-back');
  const next = document.getElementById('drs-step-next');
  const statusEl = document.getElementById('drs-step-status');
  if (back) back.disabled = idx === 0 || drsWizardBusy;
  if (next) {
    const last = idx >= DRS_RISK_STUDIO_LAST_STEP;
    next.hidden = last;
    next.setAttribute('aria-hidden', last ? 'true' : 'false');
    if (!last) {
      next.disabled = drsWizardBusy;
      next.textContent = idx === 2 ? 'Create assessment & continue' : 'Next step';
    }
  }
  if (statusEl) statusEl.textContent = `Step ${idx + 1} of ${total}`;
}

function drsRiskStepperGo(delta) {
  drsStepperIndex = Math.max(0, Math.min(DRS_RISK_STUDIO_LAST_STEP, drsStepperIndex + delta));
  syncDataRiskStudioStepperDOM();
}

function drsRiskStepperBack() {
  if (drsWizardBusy) return;
  drsRiskStepperGo(-1);
}

function drsRiskStepperNext() {
  if (drsStepperIndex >= DRS_RISK_STUDIO_LAST_STEP || drsWizardBusy) return;
  if (drsStepperIndex === 0) {
    const risk_matrix = document.getElementById('dsr-matrix-select')?.value?.trim();
    if (!risk_matrix) {
      toast('error', 'Risk matrix', 'Reload the matrix list and choose one — or create a matrix — before continuing.');
      return;
    }
    drsRiskStepperGo(1);
    return;
  }
  if (drsStepperIndex === 1) {
    const folder = document.getElementById('dsr-folder-select')?.value?.trim();
    if (!folder) {
      toast('error', 'Folder', 'Reload folders if needed and choose one before continuing.');
      return;
    }
    void (async () => {
      setRiskStudioWizardBusy(true);
      try {
        await loadRiskStudioPerimetersForFolder();
        drsRiskStepperGo(1);
      } finally {
        setRiskStudioWizardBusy(false);
      }
    })();
    return;
  }
  if (drsStepperIndex === 2) {
    void (async () => {
      setRiskStudioWizardBusy(true);
      try {
        const ok = await runRiskStudioCreateAssessment();
        if (ok) drsRiskStepperGo(1);
      } finally {
        setRiskStudioWizardBusy(false);
      }
    })();
    return;
  }
}

function initDataRiskStudioStepper() {
  if (riskStudioStepperWired) return;
  const back = document.getElementById('drs-step-back');
  const next = document.getElementById('drs-step-next');
  if (!back || !next) return;
  riskStudioStepperWired = true;
  back.addEventListener('click', () => drsRiskStepperBack());
  next.addEventListener('click', () => drsRiskStepperNext());
  drsStepperIndex = 0;
  syncDataRiskStudioStepperDOM();
}

function initRiskStudioPanel() {
  if (riskStudioPanelWired) return;
  const root = document.getElementById('ds-pane-risk-scenarios');
  if (!root) return;
  riskStudioPanelWired = true;
  initDataRiskStudioStepper();
  document.getElementById('dsr-btn-reload-matrices-only')?.addEventListener('click', () => loadRiskStudioMatrices().catch(() => {}));
  document.getElementById('dsr-btn-reload-risk-folders')?.addEventListener('click', () =>
    refreshDataStudioFolderSelects().catch(() => {}),
  );
  document.getElementById('dsr-btn-create-matrix')?.addEventListener('click', () => runRiskStudioUploadRiskMatrixLibraryYaml());
  document.getElementById('dsm-file-risk-yaml')?.addEventListener('change', syncRiskStudioRiskYamlLabel);
  document.getElementById('dsm-file-risk-yaml-browse')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('dsm-file-risk-yaml')?.click();
  });
  document.getElementById('dsm-file-risk-yaml')?.closest('.ds-upload-field')?.querySelector('.ds-upload-bar')?.addEventListener('click', e => {
    if ((e.target).closest('.ds-upload-browse')) return;
    e.preventDefault();
    document.getElementById('dsm-file-risk-yaml')?.click();
  });
  document.getElementById('dsr-folder-select')?.addEventListener('change', () => loadRiskStudioPerimetersForFolder().catch(() => {}));
  document.getElementById('dsr-btn-create-perimeter')?.addEventListener('click', () => runRiskStudioCreatePerimeter());
  document.getElementById('dsr-btn-create-scenario')?.addEventListener('click', () => runRiskStudioCreateScenario());
  document.getElementById('dsr-btn-action-plan')?.addEventListener('click', () => runRiskStudioActionPlan());
}

function restoreRiskStudioAssessmentField() {
  const el = document.getElementById('dsr-assessment-uuid');
  if (!el || el.value.trim()) return;
  try {
    const s = localStorage.getItem(RISK_STUDIO_ASSESSMENT_KEY);
    if (s) el.value = s;
  } catch (_) { /* ignore */ }
}

function persistRiskStudioAssessment(uuid) {
  const v = String(uuid || '').trim();
  if (!v) return;
  try {
    localStorage.setItem(RISK_STUDIO_ASSESSMENT_KEY, v);
  } catch (_) { /* ignore */ }
}

async function loadRiskStudioPrereqs() {
  initRiskStudioPanel();
  await loadRiskStudioMatrices();
  await refreshDataStudioFolderSelects();
  await loadRiskStudioPerimetersForFolder();
  restoreRiskStudioAssessmentField();
}

function syncRiskStudioRiskYamlLabel() {
  const fileInput = document.getElementById('dsm-file-risk-yaml');
  const label = document.getElementById('dsm-matrix-yaml-label');
  const f = fileInput?.files?.[0];
  if (!label) return;
  if (f) {
    label.textContent = f.name;
    label.classList.remove('is-empty');
  } else {
    label.textContent = 'No file selected';
    label.classList.add('is-empty');
  }
}

/** POST /api/stored-libraries/upload/ via JSON body relay (multipart built on server) — same flow as Libraries YAML modal. */
async function runRiskStudioUploadRiskMatrixLibraryYaml() {
  const fileInput = document.getElementById('dsm-file-risk-yaml');
  const file = fileInput?.files?.[0];
  const logEl = document.getElementById('dsr-log');
  const btn = document.getElementById('dsr-btn-create-matrix');

  if (!file) {
    toast('error', 'Risk matrix library', 'Choose a .yaml risk-matrix stored library file (see template).');
    return;
  }
  const lower = String(file.name || '').toLowerCase();
  if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) {
    toast('error', 'Risk matrix library', 'Use a .yaml or .yml file.');
    return;
  }

  let yaml;
  try {
    yaml = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Could not read file.'));
      reader.readAsText(file, 'UTF-8');
    });
  } catch (e) {
    toast('error', 'Risk matrix library', e.message || 'Read failed.');
    return;
  }
  if (!String(yaml || '').trim()) {
    toast('error', 'Risk matrix library', 'File is empty.');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/data-studio/upload-risk-matrix-library-yaml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ fileName: file.name, yaml }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || j.detail || r.statusText || 'Upload failed');

    const res = j.result || {};
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent = JSON.stringify(res, null, 2);
    }
    toast(
      'success',
      'Library uploaded',
      'Stored library uploaded and loaded — use Reload risk matrices, then choose a matrix.',
    );
    if (fileInput) fileInput.value = '';
    syncRiskStudioRiskYamlLabel();
    await loadRiskStudioMatrices();
  } catch (e) {
    toast('error', 'Risk matrix library', e.message || '');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadRiskStudioPerimetersForFolder() {
  const folderSel = document.getElementById('dsr-folder-select');
  const perSel = document.getElementById('dsr-perimeter-select');
  if (!folderSel || !perSel) return;
  const folder = folderSel.value;
  perSel.innerHTML = '<option value="">Loading…</option>';
  try {
    let q = 'page_size=200';
    if (folder) q += `&folder=${encodeURIComponent(folder)}`;
    const r = await fetch(`/api/grc/perimeters/?${q}`, { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Perimeters request failed');
    const list = Array.isArray(j.results) ? j.results : [];
    perSel.innerHTML = '<option value="">— Choose perimeter —</option>' +
      list.map(p => {
        const id = p.id || p.uuid;
        const label = p.name || p.ref_id || id;
        return `<option value="${esc(id)}">${esc(label)}</option>`;
      }).join('');
    if (list.length === 1) {
      const onlyId = list[0].id || list[0].uuid;
      if (onlyId) perSel.value = onlyId;
    }
  } catch (e) {
    perSel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

async function loadRiskStudioMatrices() {
  const sel = document.getElementById('dsr-matrix-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const r = await fetch('/api/grc/risk-matrices/?page_size=200', { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Risk matrices request failed');
    const list = Array.isArray(j.results) ? j.results : [];
    const enabled = list.filter(m => m.is_enabled !== false);
    const use = enabled.length ? enabled : list;
    sel.innerHTML = '<option value="">— Choose risk matrix —</option>' +
      use.map(m => {
        const id = m.id || m.uuid;
        const label = m.name || m.ref_id || id;
        return `<option value="${esc(id)}">${esc(label)}${m.is_enabled === false ? ' (disabled)' : ''}</option>`;
      }).join('');
    if (prev && use.some(m => String(m.id || m.uuid) === String(prev))) {
      sel.value = prev;
    } else if (!prev && use.length === 1) {
      const onlyId = use[0].id || use[0].uuid;
      if (onlyId) sel.value = onlyId;
    }
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

async function runRiskStudioCreatePerimeter() {
  const name = document.getElementById('dsr-perimeter-name')?.value?.trim();
  const folder = document.getElementById('dsr-folder-select')?.value;
  const logEl = document.getElementById('dsr-log');
  if (!name || !folder) {
    toast('error', 'Perimeter', 'Enter a name and choose a folder.');
    return;
  }
  if (name.includes('/')) {
    toast('error', 'Perimeter', 'Name must not contain /.');
    return;
  }
  try {
    const r = await fetch('/api/grc/perimeters/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, folder }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || j.detail || r.statusText || 'Create failed');
    const res = j.result || j;
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent = JSON.stringify(res, null, 2);
    }
    toast('success', 'Perimeter created', res.name || '');
    await loadRiskStudioPerimetersForFolder();
    const id = res.id || res.uuid;
    const perSel = document.getElementById('dsr-perimeter-select');
    if (perSel && id) perSel.value = id;
    document.getElementById('dsr-perimeter-name').value = '';
  } catch (e) {
    toast('error', 'Perimeter', e.message || '');
  }
}

async function runRiskStudioCreateAssessment() {
  const name = document.getElementById('dsr-ra-name')?.value?.trim();
  const perimeter = document.getElementById('dsr-perimeter-select')?.value;
  const risk_matrix = document.getElementById('dsr-matrix-select')?.value;
  const description = document.getElementById('dsr-ra-description')?.value?.trim();
  const ref_id = document.getElementById('dsr-ra-ref-id')?.value?.trim();
  const logEl = document.getElementById('dsr-log');
  if (!String(perimeter || '').trim()) {
    toast(
      'error',
      'Risk assessment',
      'Choose a perimeter. If the list is empty, go back to step 2 (Folder & perimeter), pick or create a perimeter, then use Next to refresh the list.',
    );
    return false;
  }
  if (!String(risk_matrix || '').trim()) {
    toast(
      'error',
      'Risk assessment',
      'Risk matrix missing — return to step 1 (Risk matrix), reload the list, and select one.',
    );
    return false;
  }
  if (!name) {
    toast('error', 'Risk assessment', 'Enter an assessment name.');
    return false;
  }
  const body = { name, perimeter, risk_matrix };
  if (description) body.description = description;
  if (ref_id) body.ref_id = ref_id;
  try {
    const r = await fetch('/api/grc/risk-assessments/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || j.detail || r.statusText || 'Create failed');
    const res = j.result || j;
    const id = res.id || res.uuid;
    persistRiskStudioAssessment(id);
    const assessEl = document.getElementById('dsr-assessment-uuid');
    if (assessEl && id) assessEl.value = id;
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent = JSON.stringify(res, null, 2);
    }
    toast('success', 'Risk assessment created', id ? String(id).slice(0, 13) + '…' : '');
    return true;
  } catch (e) {
    toast('error', 'Risk assessment', e.message || '');
    return false;
  }
}

async function runRiskStudioCreateScenario() {
  const risk_assessment = document.getElementById('dsr-assessment-uuid')?.value?.trim();
  const name = document.getElementById('dsr-scenario-name')?.value?.trim();
  const logEl = document.getElementById('dsr-log');
  if (!risk_assessment || !name) {
    toast('error', 'Scenario', 'Assessment UUID and scenario name are required.');
    return;
  }
  try {
    const r = await fetch('/api/grc/risk-scenarios/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ risk_assessment, name }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || j.detail || r.statusText || 'Create failed');
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent = JSON.stringify(j.result || j, null, 2);
    }
    toast('success', 'Scenario created', name);
    document.getElementById('dsr-scenario-name').value = '';
  } catch (e) {
    toast('error', 'Scenario', e.message || '');
  }
}

async function runRiskStudioActionPlan() {
  const id = document.getElementById('dsr-assessment-uuid')?.value?.trim();
  const logEl = document.getElementById('dsr-log');
  if (!id) {
    toast('error', 'Action plan', 'Enter a risk assessment UUID first.');
    return;
  }
  try {
    const r = await fetch(`/api/grc/risk-assessments/${encodeURIComponent(id)}/action-plan/`, { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || 'Request failed');
    if (logEl) {
      logEl.style.display = 'block';
      logEl.textContent = JSON.stringify(j.result || j, null, 2);
    }
    toast('success', 'Action plan', 'Loaded from GRC.');
  } catch (e) {
    toast('error', 'Action plan', e.message || '');
  }
}

function ensureRiskStudioLoaded() {
  loadRiskStudioPrereqs().catch(() => {});
}

function initDataStudioHub() {
  if (dataStudioHubWired) return;
  const grid = document.querySelector('#page-data-studio .ds-hub-grid');
  if (!grid) return;
  dataStudioHubWired = true;
  grid.querySelectorAll('.ds-hub-card').forEach(btn => {
    btn.addEventListener('click', () => {
      setDataStudioPane(btn.getAttribute('data-ds-pane') || 'applied');
    });
  });
  window.addEventListener('hashchange', () => {
    if (currentPage === 'data-studio') syncDataStudioPaneFromHash();
  });
}

function loadDataStudioPage() {
  restoreDataStudioSavedAudit();
  loadDataStudioGrcOptions().catch(() => {});
  syncDataStudioPaneFromHash();
}

async function refreshDataStudioFolderSelects() {
  const selects = [];
  const s1 = document.getElementById('ds-folder-select');
  const s2 = document.getElementById('dsp-folder-select');
  const s3 = document.getElementById('dsr-folder-select');
  if (s1) selects.push(s1);
  if (s2) selects.push(s2);
  if (s3) selects.push(s3);
  if (!selects.length) return;

  const prevVals = selects.map(sel => ({ sel, prev: sel.value }));
  selects.forEach(sel => {
    sel.innerHTML = '<option value="">Loading…</option>';
  });

  try {
    const fr = await fetch('/api/grc/folders?page_size=500');
    const fj = await fr.json();
    if (!fr.ok) throw new Error(fj.error || 'Folders request failed');
    let folders = fj.folders;
    if (!Array.isArray(folders)) folders = Array.isArray(folders?.results) ? folders.results : [];
    const opts =
      '<option value="">— Choose folder —</option>' +
      folders.map(f => {
        const id = f.id || f.uuid;
        const label = f.name || f.name_en || f.title || id;
        return `<option value="${esc(id)}">${esc(label)}</option>`;
      }).join('');
    prevVals.forEach(({ sel, prev }) => {
      sel.innerHTML = opts;
      if (prev) sel.value = prev;
    });
  } catch (e) {
    const errOpts = `<option value="">${esc(e.message)}</option>`;
    prevVals.forEach(({ sel }) => {
      sel.innerHTML = errOpts;
    });
  }
}

async function loadDataStudioGrcOptions() {
  await refreshDataStudioFolderSelects();
  loadDataStudioFrameworkOptions().catch(() => {});
}

async function loadDataStudioFrameworkOptions() {
  const sel = document.getElementById('ds-framework-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Loading frameworks…</option>';
  try {
    const r = await fetch('/api/grc/frameworks');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Frameworks request failed');
    const list = Array.isArray(j.results) ? j.results : (Array.isArray(j) ? j : []);
    if (!list.length) {
      sel.innerHTML = '<option value="">— no frameworks loaded in GRC —</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Choose framework —</option>' +
      list.map(f => {
        const id = f.id || f.uuid;
        const label = `${f.name || f.ref_id || id}${f.ref_id ? ` (${f.ref_id})` : ''}`;
        return `<option value="${esc(id)}" data-name="${esc(f.name || '')}">${esc(label)}</option>`;
      }).join('');
    if (prev) sel.value = prev;
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

async function runDataStudioCreateAudit() {
  const fwSel = document.getElementById('ds-framework-select');
  const nameInput = document.getElementById('ds-audit-name');
  const auditInput = document.getElementById('ds-compliance-assessment');
  const folderSel = document.getElementById('ds-folder-select');
  const btn = document.getElementById('ds-btn-create-audit');
  const logEl = document.getElementById('ds-import-log');

  const framework = fwSel && fwSel.value ? String(fwSel.value).trim() : '';
  if (!framework) {
    toast('error', 'Pick a framework', 'Choose the framework that the new audit should host (RAs are auto-generated from this framework on insert).');
    return;
  }
  const name = nameInput && nameInput.value ? String(nameInput.value).trim() : '';
  const folder = folderSel && folderSel.value ? String(folderSel.value).trim() : '';
  const perimeterEl = document.getElementById('ds-perimeter-uuid');
  const perimeter = perimeterEl && perimeterEl.value ? String(perimeterEl.value).trim() : '';

  if (btn) btn.disabled = true;
  if (logEl) {
    logEl.style.display = 'block';
    logEl.textContent = 'Creating compliance assessment in GRC…\nPOST /api/compliance-assessments/ → GRC will auto-generate one RequirementAssessment per requirement node in the framework.';
  }
  try {
    const body = { framework };
    if (name) body.name = name;
    if (folder) body.folder = folder;
    if (perimeter) body.perimeter = perimeter;
    const r = await fetch('/api/data-studio/create-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      const grcDetail = j.grcResponse ? `\n\nGRC said: ${j.grcResponse}` : '';
      const detail = j.detail ? `\n\nDetail: ${j.detail}` : '';
      const hint = j.hint ? `\n\nHint: ${j.hint}` : '';
      throw new Error((j.error || r.statusText || 'Create audit failed') + grcDetail + detail + hint);
    }
    if (auditInput) {
      auditInput.value = j.id;
      persistDataStudioAuditUuid(j.id);
    }
    const lines = [
      'Created compliance assessment ✓',
      `  id:        ${j.id}`,
      `  name:      ${j.name || ''}`,
      `  framework: ${j.frameworkName || j.framework}`,
      j.folder ? `  folder:    ${j.folder}` : '',
      `  RAs auto-generated by GRC: ${j.raCount == null ? '(unknown — count endpoint did not respond)' : j.raCount}`,
      '',
      'Audit UUID has been pasted into the field above.',
      'Next: click "Import all rows to GRC" if you have not imported yet, or re-run import to attach more rows to this audit.',
    ].filter(Boolean);
    if (logEl) logEl.textContent = lines.join('\n');
    toast('success', 'Audit created', `${j.name || 'Compliance assessment'} (${j.raCount != null ? `${j.raCount} RAs auto-generated` : 'RAs auto-generated'}).`);
  } catch (e) {
    console.error('[Data Studio create-audit]', e);
    if (logEl) logEl.textContent = e.message || String(e);
    toast('error', 'Create audit failed', (e.message || '').split('\n')[0]);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function getDataStudioComplianceAssessmentUuid() {
  const caEl = document.getElementById('ds-compliance-assessment');
  const caManual = caEl && caEl.value ? String(caEl.value).trim() : '';
  const caSession =
    !caManual && typeof csSessionData !== 'undefined' && csSessionData && csSessionData.complianceAssessment
      ? String(csSessionData.complianceAssessment).trim()
      : '';
  return caManual || caSession || '';
}

async function runDataStudioGrCImport() {
  const folder = document.getElementById('ds-folder-select')?.value;
  const logEl = document.getElementById('ds-import-log');
  const btn = document.getElementById('ds-btn-import-grc');
  if (!dataStudioLastFile || !folder) {
    toast('error', 'Missing inputs', 'Choose a GRC folder and load an Excel file first.');
    return;
  }
  const complianceAssessmentUuid = getDataStudioComplianceAssessmentUuid();
  // Import options (UI toggles removed): always enabled
  const autoPickComplianceAssessment = true;
  const autoCreateAuditIfMissing = true;
  const rollUpUnknownRefs = true;
  const fwSelectEl = document.getElementById('ds-framework-select');
  const frameworkUuid = fwSelectEl && fwSelectEl.value ? String(fwSelectEl.value).trim() : '';
  const perimeterEl = document.getElementById('ds-perimeter-uuid');
  const perimeterUuid = perimeterEl && perimeterEl.value ? String(perimeterEl.value).trim() : '';
  if (!btn) return;
  if (btn) btn.disabled = true;
  if (logEl) {
    logEl.style.display = 'block';
    logEl.textContent = 'Importing… This can take several minutes for large sheets.';
  }
  try {
    const body = {
      fileName: dataStudioLastFile.name,
      data: dataStudioLastFile.data,
      folder,
      autoPickComplianceAssessment,
      autoCreateAuditIfMissing,
      rollUpUnknownRefs,
      ...(complianceAssessmentUuid ? { complianceAssessment: complianceAssessmentUuid } : {}),
      ...(frameworkUuid ? { framework: frameworkUuid } : {}),
      ...(perimeterUuid ? { perimeter: perimeterUuid } : {}),
    };
    console.log('[Data Studio] import request', {
      folder,
      autoPickComplianceAssessment,
      autoCreateAuditIfMissing,
      rollUpUnknownRefs,
      complianceAssessment: complianceAssessmentUuid || '(none)',
      framework: frameworkUuid || '(none)',
      perimeter: perimeterUuid || '(auto-discover)',
    });
    const r = await fetch('/api/data-studio/import-applied-controls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.log('[Data Studio] import response (error)', r.status, j);
      let msg = [j.error, j.hint].filter(Boolean).join(' — ');
      if (j.diagnostics && typeof j.diagnostics === 'object' && Object.keys(j.diagnostics).length) {
        msg = `${msg}\n${JSON.stringify(j.diagnostics)}`;
      }
      throw new Error(msg || r.statusText || 'Import failed');
    }
    console.log('[Data Studio] import response', j);
    const modeLine = j.linkOnly ? 'Mode: link only (no new applied controls)' : 'Mode: import (create controls)';
    const ph1 = (j.phases && j.phases.phase1) || {};
    const ph2 = (j.phases && j.phases.phase2) || {};
    const execMode = (j.phases && j.phases.executionMode) || 'row_by_row';
    const phase1Lines = [
      `STEP 1 (per row) — ${j.linkOnly ? 'match existing applied control by ref_id' : 'POST /api/applied-controls/ and capture UUID'}`,
      `  Resolved: ${ph1.resolved != null ? ph1.resolved : (j.linkOnly ? j.matchedExistingCount : j.createdCount)} / ${ph1.attempted != null ? ph1.attempted : j.totalParsed}`,
      `  Failed:   ${ph1.failed != null ? ph1.failed : '—'}`,
    ];
    const raPostAllowed = !!(ph2.raPostAllowed);
    const step2Headline = raPostAllowed
      ? 'STEP 2 (per row) — POST /api/requirement-assessments/ using the STEP 1 UUID (PATCH existing RA on fallback)'
      : 'STEP 2 (per row) — PATCH the existing /api/requirement-assessments/ found by (compliance_assessment, requirement.ref_id) — never creates new RAs';
    const phase2Lines = [
      step2Headline,
      typeof j.rollUpUnknownRefs === 'boolean'
        ? `  Roll-up workbook refs → parent RA: ${j.rollUpUnknownRefs ? 'ON (numeric codes like 5.1.1.x attach to standard 5.1.1 when present)' : 'OFF (exact requirement__ref_id only)'}`
        : '',
      `  Audit: ${ph2.ranAgainstAudit ? (j.complianceAssessmentName ? `${j.complianceAssessmentName} (${ph2.ranAgainstAudit})` : ph2.ranAgainstAudit) : '— none (skipped on every row) —'}`,
      ph2.skippedReason ? `  Skipped: ${ph2.skippedReason}` : '',
      `  Linked:   ${ph2.linked != null ? ph2.linked : (j.linkedAtCreateCount || 0)} / ${ph2.attempted != null ? ph2.attempted : '—'}`,
      `    — via PATCH existing RA:                  ${(ph2.breakdown && ph2.breakdown.via_patch_existing_ra) != null ? ph2.breakdown.via_patch_existing_ra : (j.linkedByPatchCount || 0)}`,
      raPostAllowed
        ? `    — via POST /api/requirement-assessments/: ${(ph2.breakdown && ph2.breakdown.via_post_requirement_assessment) != null ? ph2.breakdown.via_post_requirement_assessment : (j.linkedByPostCount || 0)}`
        : '',
      `  Rows where requirement__ref_id resolved to an RA: ${j.refIdOverlapCount != null ? j.refIdOverlapCount : '—'}`,
    ].filter(Boolean);
    const summary = [
      modeLine,
      `Execution: ${execMode === 'row_by_row' ? 'row-by-row (POST control → link RA → next row)' : execMode}`,
      `GRC: ${j.grcApi || ''}`,
      j.complianceAssessmentAutoCreated
        ? `Audit: AUTO-CREATED "${j.complianceAssessmentName || ''}" (${j.complianceAssessmentId}) from framework "${(j.autoCreatedFramework && j.autoCreatedFramework.name) || (j.autoCreatedFramework && j.autoCreatedFramework.id) || '?'}"${j.autoCreatedFrameworkScore ? ` — ref_id overlap ${j.autoCreatedFrameworkScore}` : ''}`
        : (j.complianceAssessmentAutoSelected ? 'Audit: auto-selected (best ref_id match)' : ''),
      `Total rows parsed: ${j.totalParsed}`,
      `Failed (any step): ${j.failedCount}`,
      '',
      ...phase1Lines,
      '',
      ...phase2Lines,
    ].filter(Boolean).join('\n');
    if (j.complianceAssessmentId) persistDataStudioAuditUuid(j.complianceAssessmentId);
    if (j.refIdMatchHint) {
      console.warn('[Data Studio]', j.refIdMatchHint);
    }
    const auditS = (j.auditRefIdSample || []).join(', ');
    const excelS = (j.excelRefIdSample || []).join(', ');
    const cross = [summary, '', `Audit ref_id sample: ${auditS || '—'}`, `Excel ref_id sample: ${excelS || '—'}`];
    if (j.refIdMatchHint) cross.push('', j.refIdMatchHint);
    if (Array.isArray(j.linkWarnings) && j.linkWarnings.length) {
      cross.push('', 'Warnings:', ...j.linkWarnings.map(w => `• ${w}`));
    }
    const errLines = (j.errors || []).slice(0, 30).map(e => `Row ${e.row} (${e.ref_id}): ${e.error}`);
    const linkErr = (j.linkErrors || []).slice(0, 30).map(e => {
      const loc = e.row != null ? `Row ${e.row}` : (e.ref_id || '—');
      const ra = e.raId ? ` RA ${e.raId}` : '';
      const step = e.step ? ` [${e.step}]` : '';
      const msg = e.error != null ? e.error : e.warning != null ? e.warning : '';
      return `${loc}${ra}${step}: ${msg}`;
    });
    const phase1Sample = Array.isArray(j.phase1)
      ? j.phase1.filter(p => p.controlId).slice(0, 8).map(p =>
          `  Row ${p.row} ${p.ref_id || '—'} → control ${p.controlId} (${p.mode})`
        )
      : [];
    const phase1Errors = Array.isArray(j.phase1)
      ? j.phase1.filter(p => !p.controlId).slice(0, 8).map(p =>
          `  Row ${p.row} ${p.ref_id || '—'} → ${p.mode}: ${p.error || ''}`
        )
      : [];
    const phase2Sample = Array.isArray(j.phase2)
      ? j.phase2.filter(p => p.linked).slice(0, 8).map(p =>
          `  Row ${p.row} ${p.ref_id || '—'} → control ${p.controlId} ⇄ RA ${p.raId || '?'} (${p.mode || ''})`
        )
      : [];
    const phase2Errors = Array.isArray(j.phase2)
      ? j.phase2.filter(p => !p.linked).slice(0, 8).map(p =>
          `  Row ${p.row} ${p.ref_id || '—'} → control ${p.controlId} → not linked${p.error ? ` (${p.error})` : ''}`
        )
      : [];

    if (logEl) {
      const parts = [cross.join('\n')];
      if (phase1Sample.length) parts.push('', 'STEP 1 sample (first 8 UUIDs received):', ...phase1Sample);
      if (phase1Errors.length) parts.push('', 'STEP 1 errors (first 8):', ...phase1Errors);
      if (phase2Sample.length) parts.push('', 'STEP 2 sample (first 8 RAs linked from those UUIDs):', ...phase2Sample);
      if (phase2Errors.length) parts.push('', 'STEP 2 not-linked (first 8):', ...phase2Errors);
      if (errLines.length) parts.push('', 'Row errors:', ...errLines);
      if (linkErr.length) parts.push('', 'Link errors:', ...linkErr);
      logEl.textContent = parts.join('\n');
    }
    if (j.refIdMatchHint) {
      toast('warning', 'Import: requirement refs', 'No rows matched requirement__ref_id for the audit you set — see import log.');
    }
    if (Array.isArray(j.linkWarnings) && j.linkWarnings.length) {
      toast('warning', 'Import: linking', j.linkWarnings[0]);
    }
    const hadRefs = Array.isArray(j.excelRefIdSample) && j.excelRefIdSample.length > 0;
    const noAudit = !j.complianceAssessmentId;
    if (j.failedCount === 0) {
      if (noAudit && hadRefs) {
        toast(
          'warning',
          'Import finished — controls not linked',
          `${j.createdCount} control(s) created without audit UUID; Requirement assessments tab will be empty until you link (${j.createdCount ? 're-import with audit UUID in the field above' : 'see log'}).`
        );
      } else {
        toast('success', 'Import finished', `${j.createdCount} controls created.`);
      }
    } else {
      toast('info', 'Import finished with errors', `${j.createdCount} created, ${j.failedCount} failed — see log below.`);
    }
  } catch (e) {
    console.error('[Data Studio import]', e);
    if (logEl) logEl.textContent = e.message || String(e);
    toast('error', 'Import failed', e.message || '');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function initDataStudioUpload() {
  if (dataStudioUploadWired) return;
  const drop = document.getElementById('ds-dropzone');
  const input = document.getElementById('ds-file-input');
  if (!drop || !input) return;
  dataStudioUploadWired = true;

  const openPicker = () => input.click();

  drop.addEventListener('click', e => {
    if (e.target.closest('a,button')) return;
    openPicker();
  });
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  ['dragenter', 'dragover'].forEach(ev => {
    drop.addEventListener(ev, e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('ds-dropzone-active');
    });
  });
  drop.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!drop.contains(e.relatedTarget)) drop.classList.remove('ds-dropzone-active');
  });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('ds-dropzone-active');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleDataStudioFile(f);
  });

  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) handleDataStudioFile(f);
    input.value = '';
  });

  const importBtn = document.getElementById('ds-btn-import-grc');
  if (importBtn) importBtn.addEventListener('click', () => runDataStudioGrCImport());
  const createAuditBtn = document.getElementById('ds-btn-create-audit');
  if (createAuditBtn) createAuditBtn.addEventListener('click', () => runDataStudioCreateAudit());
  const fwSelect = document.getElementById('ds-framework-select');
  const auditNameInput = document.getElementById('ds-audit-name');
  if (fwSelect && auditNameInput) {
    fwSelect.addEventListener('change', () => {
      const opt = fwSelect.options[fwSelect.selectedIndex];
      const fwName = opt ? (opt.getAttribute('data-name') || opt.textContent || '').trim() : '';
      if (fwName && !auditNameInput.value) {
        auditNameInput.value = `${fwName.split(' (')[0]} – Controls Catalog`;
      }
    });
  }

  const caInput = document.getElementById('ds-compliance-assessment');
  if (caInput) {
    caInput.addEventListener('change', () => persistDataStudioAuditUuid(caInput.value));
  }
}

function initDataStudioPolicyUpload() {
  if (dataStudioPolicyUploadWired) return;
  const drop = document.getElementById('dsp-dropzone');
  const input = document.getElementById('dsp-file-input');
  if (!drop || !input) return;
  dataStudioPolicyUploadWired = true;

  const openPicker = () => input.click();

  drop.addEventListener('click', e => {
    if (e.target.closest('a,button')) return;
    openPicker();
  });
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  ['dragenter', 'dragover'].forEach(ev => {
    drop.addEventListener(ev, e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('ds-dropzone-active');
    });
  });
  drop.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!drop.contains(e.relatedTarget)) drop.classList.remove('ds-dropzone-active');
  });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('ds-dropzone-active');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleDataStudioPolicyFile(f);
  });

  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) handleDataStudioPolicyFile(f);
    input.value = '';
  });

  const importBtn = document.getElementById('dsp-btn-import-grc');
  if (importBtn) importBtn.addEventListener('click', () => runDataStudioPolicyImport());
}

async function handleDataStudioPolicyFile(file) {
  const statusEl = document.getElementById('dsp-status');
  const preview = document.getElementById('dsp-preview');
  const theadRow = document.getElementById('dsp-preview-thead');
  const tbody = document.querySelector('#dsp-preview-table tbody');
  const metaEl = document.getElementById('dsp-preview-meta');
  if (!statusEl || !preview || !theadRow || !tbody || !metaEl) return;

  const nameLower = (file.name || '').toLowerCase();
  if (!/\.(xlsx|xls|csv)$/.test(nameLower)) {
    toast('error', 'Invalid file', 'Choose an Excel (.xlsx, .xls) or .csv file.');
    return;
  }
  statusEl.textContent = 'Reading file…';
  preview.style.display = 'none';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read file.'));
      r.readAsDataURL(file);
    });
    const data = typeof dataUrl === 'string' && dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

    const r = await fetch('/api/data-studio/preview-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || r.statusText || 'Upload failed');
    }
    if (!j.success) throw new Error(j.error || 'Preview failed');

    metaEl.innerHTML = `
      <strong>${esc(j.fileName || file.name)}</strong>
      · Sheet: <code>${esc(j.activeSheet || '')}</code>
      · <span class="ds-meta-rows">${Number(j.totalRows) || 0} data rows</span>
      ${(j.sheetNames && j.sheetNames.length > 1) ? ` · ${j.sheetNames.length} sheets (preview uses the first)` : ''}
    `;

    const headers = j.previewHeaders || [];
    theadRow.innerHTML = headers.map(h => `<th>${esc(String(h))}</th>`).join('');
    const rows = j.preview || [];
    tbody.innerHTML = rows.map(row => {
      const cells = headers.map(h => {
        const v = row[h];
        const s = v != null && v !== '' ? String(v) : '';
        return `<td>${esc(s)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    preview.style.display = 'block';
    dataStudioPolicyLastFile = { name: file.name, data };
    const importPanel = document.getElementById('dsp-import-panel');
    const importBtn = document.getElementById('dsp-btn-import-grc');
    if (importPanel) importPanel.style.display = 'block';
    if (importBtn) importBtn.disabled = false;
    const logEl = document.getElementById('dsp-import-log');
    if (logEl) {
      logEl.style.display = 'none';
      logEl.textContent = '';
    }
    refreshDataStudioFolderSelects().catch(() => {});

    statusEl.textContent = rows.length
      ? `Showing ${rows.length} preview row${rows.length === 1 ? '' : 's'}${(j.totalRows > rows.length) ? ` of ${j.totalRows}` : ''}. Choose folder and import — each row POSTs to GRC /api/policies/.`
      : 'No data rows after the header row.';
    toast('success', 'File loaded', 'Policy import preview is ready.');
  } catch (err) {
    console.error('[Data Studio policies]', err);
    statusEl.textContent = '';
    toast('error', 'Could not read spreadsheet', err.message || 'Unknown error');
  }
}

async function runDataStudioPolicyImport() {
  const folder = document.getElementById('dsp-folder-select')?.value;
  const logEl = document.getElementById('dsp-import-log');
  const btn = document.getElementById('dsp-btn-import-grc');
  if (!dataStudioPolicyLastFile || !folder) {
    toast('error', 'Missing inputs', 'Choose a GRC folder and load a spreadsheet first.');
    return;
  }
  if (btn) btn.disabled = true;
  if (logEl) {
    logEl.style.display = 'block';
    logEl.textContent = 'POST /api/policies/ per row…';
  }
  try {
    const r = await fetch('/api/data-studio/import-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        fileName: dataStudioPolicyLastFile.name,
        data: dataStudioPolicyLastFile.data,
        folder,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || r.statusText || 'Import failed');
    }
    if (logEl) {
      logEl.textContent = JSON.stringify(
        {
          createdCount: j.createdCount,
          failedCount: j.failedCount,
          sheetName: j.sheetName,
          errors: j.errors,
          created: j.created,
        },
        null,
        2
      );
    }
    if (!j.failedCount) {
      toast('success', 'Policies imported', `${j.createdCount} policy(ies) created in GRC.`);
    } else if (j.createdCount) {
      toast('warning', 'Import partially failed', `${j.createdCount} created, ${j.failedCount} failed — see log.`);
    } else {
      toast('error', 'Import failed', `${j.failedCount} row(s) failed — see log.`);
    }
  } catch (e) {
    console.error('[Data Studio policy import]', e);
    if (logEl) logEl.textContent = e.message || String(e);
    toast('error', 'Import failed', e.message || '');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function initDataStudioRiskScenarioUpload() {
  if (dataStudioRiskScenarioUploadWired) return;
  const drop = document.getElementById('dsrs-dropzone');
  const input = document.getElementById('dsrs-file-input');
  if (!drop || !input) return;
  dataStudioRiskScenarioUploadWired = true;

  const openPicker = () => input.click();

  drop.addEventListener('click', e => {
    if (e.target.closest('a,button')) return;
    openPicker();
  });
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  ['dragenter', 'dragover'].forEach(ev => {
    drop.addEventListener(ev, e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('ds-dropzone-active');
    });
  });
  drop.addEventListener('dragleave', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!drop.contains(e.relatedTarget)) drop.classList.remove('ds-dropzone-active');
  });
  drop.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('ds-dropzone-active');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleDataStudioRiskScenarioFile(f);
  });

  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) handleDataStudioRiskScenarioFile(f);
    input.value = '';
  });

  document.getElementById('dsrs-btn-import-grc')?.addEventListener('click', () => runDataStudioRiskScenarioImport());
}

async function handleDataStudioRiskScenarioFile(file) {
  const statusEl = document.getElementById('dsrs-status');
  const preview = document.getElementById('dsrs-preview');
  const theadRow = document.getElementById('dsrs-preview-thead');
  const tbody = document.querySelector('#dsrs-preview-table tbody');
  const metaEl = document.getElementById('dsrs-preview-meta');
  if (!statusEl || !preview || !theadRow || !tbody || !metaEl) return;

  const nameLower = (file.name || '').toLowerCase();
  if (!/\.(xlsx|xls|csv)$/.test(nameLower)) {
    toast('error', 'Invalid file', 'Choose an Excel (.xlsx, .xls) or .csv file.');
    return;
  }
  statusEl.textContent = 'Reading file…';
  preview.style.display = 'none';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read file.'));
      r.readAsDataURL(file);
    });
    const data = typeof dataUrl === 'string' && dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

    const r = await fetch('/api/data-studio/preview-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || r.statusText || 'Upload failed');
    }
    if (!j.success) throw new Error(j.error || 'Preview failed');

    metaEl.innerHTML = `
      <strong>${esc(j.fileName || file.name)}</strong>
      · Sheet: <code>${esc(j.activeSheet || '')}</code>
      · <span class="ds-meta-rows">${Number(j.totalRows) || 0} data rows</span>
      ${(j.sheetNames && j.sheetNames.length > 1) ? ` · ${j.sheetNames.length} sheets (preview uses the first)` : ''}
    `;

    const headers = j.previewHeaders || [];
    theadRow.innerHTML = headers.map(h => `<th>${esc(String(h))}</th>`).join('');
    const rows = j.preview || [];
    tbody.innerHTML = rows.map(row => {
      const cells = headers.map(h => {
        const v = row[h];
        const s = v != null && v !== '' ? String(v) : '';
        return `<td>${esc(s)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    preview.style.display = 'block';
    dataStudioRiskScenarioLastFile = { name: file.name, data };
    const importPanel = document.getElementById('dsrs-import-panel');
    const importBtn = document.getElementById('dsrs-btn-import-grc');
    if (importPanel) importPanel.style.display = 'block';
    if (importBtn) importBtn.disabled = false;
    const logEl = document.getElementById('dsrs-import-log');
    if (logEl) {
      logEl.style.display = 'none';
      logEl.textContent = '';
    }

    statusEl.textContent = rows.length
      ? `Showing ${rows.length} preview row${rows.length === 1 ? '' : 's'}. Each row needs a name column; set risk assessment UUID in the field above or add a risk_assessment column.`
      : 'No data rows after the header row.';
    toast('success', 'File loaded', 'Risk scenario spreadsheet preview ready.');
  } catch (err) {
    console.error('[Data Studio risk scenarios Excel]', err);
    statusEl.textContent = '';
    toast('error', 'Could not read spreadsheet', err.message || 'Unknown error');
  }
}

async function runDataStudioRiskScenarioImport() {
  const risk_assessment = document.getElementById('dsr-assessment-uuid')?.value?.trim() || '';
  const logEl = document.getElementById('dsrs-import-log');
  const btn = document.getElementById('dsrs-btn-import-grc');
  if (!dataStudioRiskScenarioLastFile) {
    toast('error', 'No file', 'Load a spreadsheet first.');
    return;
  }
  if (btn) btn.disabled = true;
  if (logEl) {
    logEl.style.display = 'block';
    logEl.textContent = risk_assessment
      ? 'POST /api/risk-scenarios/ per row…'
      : 'POST /api/risk-scenarios/ per row (using risk_assessment column or default)…';
  }
  try {
    const r = await fetch('/api/data-studio/import-risk-scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        fileName: dataStudioRiskScenarioLastFile.name,
        data: dataStudioRiskScenarioLastFile.data,
        risk_assessment,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || r.statusText || 'Import failed');
    }
    if (logEl) {
      logEl.textContent = JSON.stringify(
        {
          createdCount: j.createdCount,
          failedCount: j.failedCount,
          sheetName: j.sheetName,
          errors: j.errors,
          created: j.created,
        },
        null,
        2
      );
    }
    if (!j.failedCount) {
      toast('success', 'Scenarios imported', `${j.createdCount} scenario(s) created in GRC.`);
    } else if (j.createdCount) {
      toast('warning', 'Import partially failed', `${j.createdCount} created, ${j.failedCount} failed — see log.`);
    } else {
      toast('error', 'Import failed', `${j.failedCount} row(s) failed — see log.`);
    }
  } catch (e) {
    console.error('[Data Studio risk scenario import]', e);
    if (logEl) logEl.textContent = e.message || String(e);
    toast('error', 'Import failed', e.message || '');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleDataStudioFile(file) {
  const statusEl = document.getElementById('ds-status');
  const preview = document.getElementById('ds-preview');
  const theadRow = document.getElementById('ds-preview-thead');
  const tbody = document.querySelector('#ds-preview-table tbody');
  const metaEl = document.getElementById('ds-preview-meta');
  const nameLower = (file.name || '').toLowerCase();
  if (!/\.(xlsx|xls|csv)$/.test(nameLower)) {
    toast('error', 'Invalid file', 'Choose an Excel (.xlsx, .xls) or .csv file.');
    return;
  }
  statusEl.textContent = 'Reading file…';
  preview.style.display = 'none';
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read file.'));
      r.readAsDataURL(file);
    });
    const data = typeof dataUrl === 'string' && dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

    const r = await fetch('/api/data-studio/preview-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || r.statusText || 'Upload failed');
    }
    if (!j.success) throw new Error(j.error || 'Preview failed');

    metaEl.innerHTML = `
      <strong>${esc(j.fileName || file.name)}</strong>
      · Sheet: <code>${esc(j.activeSheet || '')}</code>
      · <span class="ds-meta-rows">${Number(j.totalRows) || 0} data rows</span>
      ${(j.sheetNames && j.sheetNames.length > 1) ? ` · ${j.sheetNames.length} sheets (preview uses the first)` : ''}
    `;

    const headers = j.previewHeaders || [];
    theadRow.innerHTML = headers.map(h => `<th>${esc(String(h))}</th>`).join('');
    const rows = j.preview || [];
    tbody.innerHTML = rows.map(row => {
      const cells = headers.map(h => {
        const v = row[h];
        const s = v != null && v !== '' ? String(v) : '';
        return `<td>${esc(s)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    preview.style.display = 'block';
    dataStudioLastFile = { name: file.name, data };
    const importPanel = document.getElementById('ds-import-panel');
    const importBtn = document.getElementById('ds-btn-import-grc');
    if (importPanel) importPanel.style.display = 'block';
    if (importBtn) importBtn.disabled = false;
    const logEl = document.getElementById('ds-import-log');
    if (logEl) { logEl.style.display = 'none'; logEl.textContent = ''; }
    loadDataStudioGrcOptions().catch(() => {});

    statusEl.textContent = rows.length
      ? `Showing ${rows.length} preview row${rows.length === 1 ? '' : 's'}${(j.totalRows > rows.length) ? ` of ${j.totalRows}` : ''}. Choose a folder and run import to push all ${j.totalRows} row(s) to GRC.`
      : 'No data rows after the header row.';
    toast('success', 'File loaded', 'Preview is ready.');
  } catch (err) {
    console.error('[Data Studio]', err);
    statusEl.textContent = '';
    toast('error', 'Could not read spreadsheet', err.message || 'Unknown error');
  }
}

/**
 * Same shape as server.js buildOrgProfileText — plain text for pipeline org context (no "missing profile" filler).
 */
function formatOrgProfileTextForPipeline(orgContext) {
  if (!orgContext) return '';
  const p = [];
  if (orgContext.nameEn) p.push(`Organization: ${orgContext.nameEn}`);
  if (orgContext.nameAr) p.push(`Arabic Name: ${orgContext.nameAr}`);
  const sectorLabels = { banking: 'Banking & Financial Services', government: 'Government', healthcare: 'Healthcare', energy: 'Energy & Utilities', telecom: 'Telecommunications', education: 'Education', retail: 'Retail & E-Commerce', insurance: 'Insurance', technology: 'Technology', other: 'Other' };
  const sizeLabels = { small: 'Small (1–50)', medium: 'Medium (51–500)', large: 'Large (501–5000)', enterprise: 'Enterprise (5000+)' };
  const sector = orgContext.sectorCustom || sectorLabels[orgContext.sector] || orgContext.sector;
  if (sector) p.push(`Industry Vertical: ${sector}`);
  if (orgContext.size) p.push(`Entity Size: ${sizeLabels[orgContext.size] || orgContext.size}`);
  if (orgContext.complianceMaturity) p.push(`Compliance Maturity Level: ${orgContext.complianceMaturity} / 5`);
  if (orgContext.regulatoryMandates && orgContext.regulatoryMandates.length) p.push(`Active Regulatory Mandates: ${orgContext.regulatoryMandates.join(', ')}`);
  if (orgContext.governanceStructure) p.push(`Governance Structure: ${orgContext.governanceStructure}`);
  if (orgContext.dataClassification) p.push(`Data Classification Level: ${orgContext.dataClassification}`);
  if (orgContext.geographicScope) p.push(`Geographic Scope: ${orgContext.geographicScope}`);
  if (orgContext.itInfrastructure) p.push(`IT Infrastructure Type: ${orgContext.itInfrastructure}`);
  if (orgContext.strategicObjectives && orgContext.strategicObjectives.length) p.push(`Strategic Objectives:\n${orgContext.strategicObjectives.map(o => '  - ' + o).join('\n')}`);
  if (orgContext.obligatoryFrameworks && orgContext.obligatoryFrameworks.length) p.push(`Obligatory Frameworks: ${orgContext.obligatoryFrameworks.join(', ')}`);
  if (orgContext.policies && orgContext.policies.length) p.push(`Linked Policies:\n${orgContext.policies.map(pol => '  - ' + (pol.name || pol)).join('\n')}`);
  if (orgContext.trackingMetrics && orgContext.trackingMetrics.length) p.push(`Tracking Metrics:\n${orgContext.trackingMetrics.map(m => '  - ' + (m.name || m)).join('\n')}`);
  if (orgContext.riskScenarios && orgContext.riskScenarios.length) p.push(`Risk Scenarios:\n${orgContext.riskScenarios.map(r => '  - ' + (r.name || r)).join('\n')}`);
  if (orgContext.notes) p.push(`Additional Notes: ${orgContext.notes}`);
  return p.join('\n');
}

/** Sample bundles: organisation + regulation + policies aligned per sector so scope matches the excerpt. Values = `#pup-preset-select`. */
const PUP_DATASETS = Object.freeze({
  'python-demo': {
    orgContext:
      `Industry: Financial Technology (Fintech)\n` +
      `Jurisdiction: Saudi Arabia, MENA region\n` +
      `Activities: Digital payments, consumer lending, KYC/AML processing\n` +
      `Compliance scope: SAMA regulations, NCA ECC, PDPL`,
    regulation:
      `Article 1 — Scope\n` +
      `This regulation applies to all financial institutions processing personal data\n` +
      `of residents. Institutions must implement data protection impact assessments\n` +
      `for high-risk processing activities.\n\n` +
      `Article 2 — Data Breach Notification\n` +
      `In the event of a personal data breach, the institution shall notify the\n` +
      `supervisory authority within 72 hours. Affected individuals must be notified\n` +
      `without undue delay when the breach poses a high risk to their rights.\n\n` +
      `Article 3 — Data Protection Officer\n` +
      `Institutions processing personal data on a large scale shall appoint a\n` +
      `Data Protection Officer who reports directly to senior management.\n\n` +
      `Article 4 — Cross-border Transfers\n` +
      `Personal data shall not be transferred outside the Kingdom unless adequate\n` +
      `safeguards are in place as determined by the supervisory authority.\n\n` +
      `Article 5 — Record of Processing (RoPA)\n` +
      `Controllers shall maintain an up-to-date register of processing activities,\n` +
      `including purposes, categories of data subjects, lawful bases, recipients,\n` +
      `and approximate retention timelines, available to the supervisory authority on request.\n\n` +
      `Article 6 — Third-party processors\n` +
      `Where processing is carried out by a processor, the institution shall impose\n` +
      `binding duties of confidentiality, sub-processor oversight, deletion or return\n` +
      `at termination, and shall remain accountable for demonstrating compliance.`,
    policies: [
      {
        id: 'POL-001',
        title: 'Data Protection Policy',
        content:
          'The organisation shall protect all personal data in accordance with PDPL and sector guidance. Sensitive customer attributes shall be labelled in the catalogue; encryption at rest and in transit applies to Confidential and Restricted classifications. Access follows least-privilege provisioning with periodic recertification.',
      },
      {
        id: 'POL-002',
        title: 'Incident Response Policy',
        content:
          'Security incidents that may affect regulatory reporting shall be routed through the CIRP within SLAs aligned to breach articles. Dedicated bridges exist for liaison with supervisory authority filings; post-incident reviews feed concrete remediation trackers.',
      },
      {
        id: 'POL-003',
        title: 'Access Control Policy',
        content:
          'Logical access grants require manager attestation tied to RBAC bundles; privileged accounts mandate MFA plus PAM session recording where supported. Separation of duties is enforced for disbursement-adjacent or customer-data-heavy roles.',
      },
      {
        id: 'POL-004',
        title: 'Data Retention & Lawful Basis Register',
        content:
          'The organisation shall document retention rationales per portfolio and reconcile marketing/CRM artefacts against lawful bases recorded in RoPA dashboards. Routine purges honour regulatory minimums/maximums; legal holds supersede deletion until released.',
      },
    ],
  },
  energy: {
    orgContext:
      `Industry: Energy & Utilities — power generation and transmission\n` +
      `Jurisdiction: Saudi Arabia\n` +
      `Activities: Bulk electric operations, OT/ICS, metering, outage management; NCA ECC and sector incident norms\n` +
      `Compliance scope: NCA ECC, OT security programme, competent-authority notifications for disruptions`,
    regulation:
      `Article 1 — Scope\n` +
      `This regulation applies to operators of designated essential energy services and related critical digital infrastructure supporting continuity of electricity supply.\n\n` +
      `Article 2 — Operational technology governance\n` +
      `Operators shall inventory material OT assets, enforce logical separation between corporate IT networks and OT environments, and document remote-access paths to OT.\n\n` +
      `Article 3 — Cyber incident reporting\n` +
      `Operators shall classify cyber incidents according to national sector guidance and report material incidents affecting energy continuity to the competent authority within mandated time windows.\n\n` +
      `Article 4 — Third-party connectivity\n` +
      `Vendor and cloud connectivity into operational environments shall undergo security assessment and contractual controls prior to production use.\n\n` +
      `Article 5 — Business continuity and restoration drills\n` +
      `Essential operators shall exercise restoration of SCADA-visible controls and failover paths at intervals defined internally but not less ambitious than supervisory expectations, evidenced by artefacts.\n\n` +
      `Article 6 — Physical security linkage\n` +
      `Perimeter breaches or extended loss of CCTV or access control impacting OT sites shall be correlated with ICS monitoring and escalated jointly to physical-security and ICS SOCs.`,
    policies: [
      {
        id: 'POL-E1',
        title: 'OT / SCADA Security Policy',
        content:
          'The organisation SHALL maintain granular logical and physical access controls for EMS, DCS and field controllers. Contractor laptops SHALL NOT dual-home between corporate Wi-Fi and OT VLANs. Remote maintenance mandates MFA-bound jump bastions whose sessions are keystroke-logged thirty days.',
      },
      {
        id: 'POL-E2',
        title: 'Critical Infrastructure Incident Response',
        content:
          'Cyber events SHALL be labelled P1-P4 blending IEC 62443 style impact on delivery. ICS CERT bridges SHALL open within fifteen minutes when generation derates exceed configured MW deltas. Disclosure packets SHALL include affected EMS RTU lists redacted yet auditable internally.',
      },
      {
        id: 'POL-E3',
        title: 'IT/OT segmentation standard',
        content:
          'DMZs SHALL segment historian north-south traffic; unsolicited east-west traversal between EMS and ERP is denied by default-change windows with CAB tickets. ICS protocol allow-lists MUST be regenerated after vendor firmware bumps.',
      },
      {
        id: 'POL-E4',
        title: 'OT Change & Patch Governance',
        content:
          'Golden images for substation relays SHALL be hashed and promoted through staging racks only. Emergency patches exceeding forty-eight idle hours post vendor advisory SHALL undergo retroactive CAB with compensating outage windows.',
      },
    ],
  },
  healthcare: {
    orgContext:
      `Industry: Healthcare — acute and ambulatory providers on a unified EHR\n` +
      `Jurisdiction: Saudi Arabia — PDPL, MOH and sector circulars\n` +
      `Activities: Patient care, referrals, billing, clinical research cohorts processing identifiable health data\n` +
      `Compliance scope: PDPL treatment/processing bases, confidentiality of identifiable patient records, breach notification pathways`,
    regulation:
      `Article 1 — Scope\n` +
      `This regulation applies to licensed healthcare establishments that process identifiable patient health data within electronic clinical systems.\n\n` +
      `Article 2 — Access accountability\n` +
      `Providers shall ensure individual accountability for accesses to identifiable patient charts, retain audit logs of views and substantive edits for the period stipulated by competent health authorities, and review exceptions.\n\n` +
      `Article 3 — Continuity of treatment disclosures\n` +
      `Disclosures strictly necessary among authorised clinicians for continuity of care may proceed where documented in the medical record subject to organisational minimum-necessary limits.\n\n` +
      `Article 4 — Breach preparedness\n` +
      `Healthcare providers shall maintain procedures to detect unauthorised processing of identifiable patient information and escalate to the privacy office according to enacted timelines.\n\n` +
      `Article 5 — Research and secondary uses\n` +
      `Use of pseudonymised or identifiable datasets for research shall require documented ethical review where applicable, data minimisation, and technical controls preventing re-linkage beyond approved cohorts.\n\n` +
      `Article 6 — Medical device and integration security\n` +
      `Biomedical devices or middleware that synchronise measurements into the EHR shall be inventoried with firmware baselines and monitored interfaces to prevent unauthorised data injection or tampering.`,
    policies: [
      {
        id: 'POL-H1',
        title: 'Patient Privacy & Confidentiality Policy',
        content:
          'Workforce members SHALL access PHI only inside approved break-glass or routine roles evidenced by quarterly attestations; unattended clinical terminals lock within ninety seconds. Photography of screens in patient areas is prohibited except controlled tele-radiology rooms.',
      },
      {
        id: 'POL-H2',
        title: 'Electronic Health Record Access Policy',
        content:
          'RBAC templates SHALL segregate prescribing, transcription, auditing, coding, research extract, and payer-facing views. Custodians SHALL reconcile orphan accounts weekly; inactive licenses auto-suspend seven days.',
      },
      {
        id: 'POL-H3',
        title: 'Healthcare Breach Assessment Policy',
        content:
          'Potential compromise indicators SHALL converge in the Privacy SOC within two hours containing affected systems list, PHI types, approximate headcount impacted, containment actions, clock start for supervisory clock metrics.',
      },
      {
        id: 'POL-H4',
        title: 'Research Data & Consent Stewardship Policy',
        content:
          'Secondary research extracts SHALL originate from cohort builders with IRB artefacts attached; cryptographic tokens SHALL replace identifiers where longitudinal linkage is mandated; revocation SHALL propagate nightly to datalake subsets.',
      },
    ],
  },
  'dga-saudi': {
    orgContext:
      `Entity profile: Saudi public-sector digital government programme participant (composite illustrative)\n` +
      `Goals: Elevate citizen/business portals, interoperable services, bilingual authoritative UX\n` +
      `Hosting: National / qualified cloud posture for regulated workloads; NDMO-aligned labelling narratives\n` +
      `Security: ECC-aligned baselines mapped to hardened builds; SOC telemetry routed to centralized logging fabrics\n` +
      `⚠ Synthetic bundle for pipeline testing — not official Digital Government Authority (DGA) or gazetted statutory text.`,
    regulation:
      `[Synthetic bilingual excerpt — illustrative only — aligned to common Saudi digital-government themes]\n\n` +
      `Article DG-1 — النطاق / Scope\n` +
      `تنطبق هذه الأحكام على الجهات الحكومية التي تقدّم خدمات رقمية للمواطنين والقطاع الخاص وفق قائمة تصنيف الخدمات المعتمدة، بما يشمل منصّات مشتركة وحوسبة مؤهّلة وفق المتطلبات الوطنية.\n\n` +
      `Article DG-2 — Protective markings & hosting eligibility\n` +
      `Systems SHALL stamp NDMO-consistent classifications; workloads at elevated tiers SHALL reside only on approved sovereign or eligible cloud foundations with attestable continuous compliance artefacts.\n\n` +
      `Article DG-3 — Identity federation & delegated consent\n` +
      `Channels SHALL integrate staged authentication for risky profile mutations; repeatable data-sharing journeys SHALL propagate machine-readable consent tokens across bounded interoperability APIs.\n\n` +
      `Article DG-4 — Interoperability & API lifecycle\n` +
      `Cross-entity interfaces SHALL advertise semantic version policies, deprecation clocks, SLA dashboards, anomaly throttling matrices, and discoverable openness metadata compatible with central catalogues.\n\n` +
      `Article DG-5 — ولوجية المحتوى / Accessibility & parity\n` +
      `المسارات العامة ذات المعاملات يجب أن تحقق أهداف ولوجية ثنائية اللغة (العربية والإنجليزية) بما في ذلك الملاحة بلوحة المفاتيح والنص البديل لعناصر الواجهة.\n\n` +
      `Article DG-6 — Incident choreography\n` +
      `Material breaches touching authenticated citizen profiles SHALL mobilise ECC IR playbooks in parallel with programme continuity desks, preserving immutable event timelines.`,
    policies: [
      {
        id: 'POL-DGA1',
        title: 'Sovereign cloud & data classification onboarding',
        content:
          'Tenant onboarding SHALL ingest classification manifests; cryptography SHALL default to customer-managed-root keys above OFFICIAL; DR drills SHALL simulate provider brown-out failover every six months measured by synthetic traffic mirroring bilingual catalogues.',
      },
      {
        id: 'POL-DGA2',
        title: 'Citizen IAM & session choreography',
        content:
          'Risk-based step-up binds device posture plus behavioral velocity; orphaned OAuth integrations SHALL revoke automatically; multilingual error payloads SHALL carry correlation IDs without leaking PII to edge caches.',
      },
      {
        id: 'POL-DGA3',
        title: 'Interoperability API stewardship',
        content:
          'Breaking schema migrations SHALL traverse dual-run shadow validation; SLA breach burn-down SHALL page owning ministry product owners; punitive throttles escalate through transparent appeal desk before hard blocks.',
      },
      {
        id: 'POL-DGA4',
        title: 'Bilingual UX & accessibility release gate',
        content:
          'RTL-first components SHALL gate merges; axe-core plus manual Arabic typography checks SHALL attach to CMS publish hooks; downloadable PDF artefacts SHALL honour tagged-structure quality bars before CDN promotion.',
      },
    ],
  },
});

/** After first hydrate, revisit same SPA session keeps user edits unless they change preset. */
let pupPipelineDatasetHydrated = false;

function applyPupBundledPreset(key) {
  const ds = PUP_DATASETS[key];
  if (!ds || !ds.policies) return;
  const orgTa = document.getElementById('pup-org-context');
  const regTa = document.getElementById('pup-regulation');
  const polTa = document.getElementById('pup-policies-json');
  const orgSel = document.getElementById('pup-org-select');
  const polJson = JSON.stringify(ds.policies, null, 2);
  if (orgTa) orgTa.value = ds.orgContext;
  if (regTa) regTa.value = ds.regulation;
  if (polTa) polTa.value = polJson;
  if (orgSel && orgSel.value) orgSel.value = '';
}

function onPupPresetSelectChange() {
  const presetSel = document.getElementById('pup-preset-select');
  if (!presetSel) return;
  const v = presetSel.value;
  pupPipelineDatasetHydrated = true;
  if (v === 'custom' || !PUP_DATASETS[v]) return;
  applyPupBundledPreset(v);
}

function maybeHydrateInitialPupPipelineDataset() {
  if (pupPipelineDatasetHydrated) return;
  const presetSel = document.getElementById('pup-preset-select');
  if (!presetSel) return;
  const v = presetSel.value || 'python-demo';
  pupPipelineDatasetHydrated = true;
  if (v === 'custom' || !PUP_DATASETS[v]) return;
  applyPupBundledPreset(v);
}

async function refreshPolicyUpdatePipelineOrgDropdown() {
  const sel = document.getElementById('pup-org-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select organization context —</option>';
  try {
    const d = await fetchJSON(API.orgContexts);
    pupOrgContextsCache = Array.isArray(d.contexts) ? d.contexts : [];
  } catch (e) {
    console.error('[Policy pipeline] org contexts fetch failed:', e);
    pupOrgContextsCache = [];
    sel.innerHTML = `<option value="">Unable to load contexts</option>`;
    return;
  }
  for (const c of pupOrgContextsCache) {
    const id = c.id || '';
    const label = c.nameEn || c.name || id || 'Untitled';
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  // Restore previous selection, or fall back to the configured default org
  const defaultId = getPcfgDefaultOrgId();
  const restoreId = (prev && pupOrgContextsCache.some(x => String(x.id) === String(prev))) ? prev
    : (defaultId && pupOrgContextsCache.some(x => String(x.id) === String(defaultId))) ? defaultId
    : '';
  if (restoreId) {
    sel.value = restoreId;
    onPolicyUpdatePipelineOrgSelect();
  }
}

function onPolicyUpdatePipelineOrgSelect() {
  const sel = document.getElementById('pup-org-select');
  const ta = document.getElementById('pup-org-context');
  if (!sel || !ta) return;
  const id = sel.value;
  if (!id) return;
  const ctx = pupOrgContextsCache.find(x => String(x.id) === String(id));
  if (ctx) ta.value = formatOrgProfileTextForPipeline(ctx);
}

function syncPolicyPipelineStepperDOM() {
  const idx = pupStepperIndex;
  const total = PUP_PIPELINE_LAST_STEP + 1;
  document.querySelectorAll('.pup-step-panel').forEach((panel) => {
    const i = Number.parseInt(panel.getAttribute('data-pup-step-index'), 10);
    if (Number.isNaN(i)) return;
    const on = i === idx;
    if (on) {
      panel.removeAttribute('hidden');
      panel.hidden = false;
    } else {
      panel.setAttribute('hidden', '');
      panel.hidden = true;
    }
  });

  document.querySelectorAll('[data-pup-step-label]').forEach((label) => {
    const i = Number.parseInt(label.getAttribute('data-pup-step-label'), 10);
    if (Number.isNaN(i)) return;
    label.classList.toggle('is-active', i === idx);
    label.classList.toggle('is-done', i < idx);
    if (i === idx) label.setAttribute('aria-current', 'step');
    else label.removeAttribute('aria-current');
  });

  const fill = document.getElementById('pup-stepper-progress-fill');
  if (fill) fill.style.width = `${((idx + 1) / total) * 100}%`;

  const cap = document.getElementById('pup-step-caption');
  if (cap) {
    const names = ['Organisation', 'Regulation', 'Policies'];
    cap.textContent = `Step ${idx + 1} of ${total} · ${names[idx] || ''}`;
  }

  const back = document.getElementById('pup-step-back');
  const next = document.getElementById('pup-step-next');
  const run = document.getElementById('pup-run-btn');
  if (back) back.disabled = idx === 0;
  if (next && run) {
    const last = idx >= PUP_PIPELINE_LAST_STEP;
    next.hidden = last;
    next.setAttribute('aria-hidden', last ? 'true' : 'false');
    run.hidden = !last;
    run.setAttribute('aria-hidden', !last ? 'true' : 'false');
  }
}

function resetPolicyPipelineStepper() {
  pupStepperIndex = 0;
  syncPolicyPipelineStepperDOM();
}

function pupStepperGo(delta) {
  pupStepperIndex = Math.max(0, Math.min(PUP_PIPELINE_LAST_STEP, pupStepperIndex + delta));
  syncPolicyPipelineStepperDOM();
  if (pupStepperIndex === PUP_PIPELINE_LAST_STEP) {
    loadPupPoliciesFromGrc();
  }
}

function pupStepperBack() {
  pupStepperGo(-1);
}

function pupStepperNext() {
  if (pupStepperIndex === 1) {
    const reg = document.getElementById('pup-regulation');
    if (!reg || !(String(reg.value || '').trim())) {
      toast('error', 'Regulation required', 'Add regulation text before continuing.');
      if (reg) reg.focus();
      return;
    }
  }
  pupStepperGo(1);
}

function loadPolicyUpdatePipelinePage() {
  initPolicyUpdatePipeline();
  initPupExtractModal();
  refreshPolicyUpdatePipelineOrgDropdown().catch(() => {});
  fetchGrcPolicies().catch(() => {});
}

function setPupPipelineLoadingOverlay(visible) {
  const ov = document.getElementById('pup-pipeline-loading-overlay');
  if (!ov) return;
  if (visible) {
    ov.hidden = false;
    ov.setAttribute('aria-hidden', 'false');
    document.body.classList.add('pup-pipeline-overlay-open');
  } else {
    ov.hidden = true;
    ov.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('pup-pipeline-overlay-open');
  }
}

function initPolicyUpdatePipeline() {
  if (policyUpdatePipelineWired) return;
  const orgSel = document.getElementById('pup-org-select');
  const runBtn = document.getElementById('pup-run-btn');
  const backBtn = document.getElementById('pup-step-back');
  const nextBtn = document.getElementById('pup-step-next');
  const presetSel = document.getElementById('pup-preset-select');
  const cancelPipelineBtn = document.getElementById('pup-pipeline-cancel-btn');
  const fillSevBtn = document.getElementById('pup-f4-fill-defaults');
  const loadGrcPoliciesBtn = document.getElementById('pup-load-grc-policies');
  if (!orgSel || !runBtn || !backBtn || !nextBtn || !presetSel) return;
  policyUpdatePipelineWired = true;
  if (fillSevBtn) fillSevBtn.addEventListener('click', () => fillPupSeveritySuggestedDefinitions());
  if (loadGrcPoliciesBtn) loadGrcPoliciesBtn.addEventListener('click', () => loadPupPoliciesFromGrc());
  if (cancelPipelineBtn) {
    cancelPipelineBtn.addEventListener('click', () => {
      if (pupPipelineAbortController) pupPipelineAbortController.abort();
    });
  }
  runBtn.addEventListener('click', () => runPolicyUpdatePipeline());
  orgSel.addEventListener('change', () => onPolicyUpdatePipelineOrgSelect());
  presetSel.addEventListener('change', () => onPupPresetSelectChange());
  backBtn.addEventListener('click', () => pupStepperBack());
  nextBtn.addEventListener('click', () => pupStepperNext());
  resetPolicyPipelineStepper();
  maybeHydrateInitialPupPipelineDataset();
}

const PUP_STAGE_LABELS = {
  f1: 'Relevance',
  f2: 'Extract policy points',
  f3: 'Policy match',
  f4: 'Impact',
};

function pupStageLabel(sr) {
  const k = String(sr || '').toLowerCase();
  return PUP_STAGE_LABELS[k] || (sr ? String(sr) : 'Pipeline');
}

function pupSkippedStagesNote(data) {
  const f1 = data && data.f1_relevance;
  if (f1 && typeof f1 === 'object' && typeof f1.is_relevant !== 'boolean') return null;
  const s = String(data.stage_reached || '').toLowerCase();
  if (s === 'f1') {
    return 'Later stages were not run because this regulation was classified as not relevant to the organisation.';
  }
  if (s === 'f2') {
    return 'Matching and impact were not run — no policy points could be extracted from the regulation text.';
  }
  if (s === 'f3') {
    return 'Impact analysis was not run — no regulation points matched your indexed policies above the similarity threshold.';
  }
  return null;
}

function pupSeverityClass(sev) {
  const s = String(sev || 'none').toLowerCase().replace(/\s+/g, '-');
  if (['critical', 'high', 'medium', 'low', 'none'].includes(s)) return `pup-sev-${s}`;
  return 'pup-sev-none';
}

function renderPolicyPipelineResultHtml(data) {
  if (!data || typeof data !== 'object') {
    return '<p class="pup-result-prose">' + esc(String(data)) + '</p>';
  }

  const parts = [];
  parts.push('<div class="pup-result-top">');
  parts.push('<span class="pup-result-badge-stage">' + esc(pupStageLabel(data.stage_reached)) + '</span>');
  if (typeof data.policy_count_indexed === 'number') {
    parts.push(
      '<span class="pup-result-meta">Indexed policies · <strong>' +
        esc(String(data.policy_count_indexed)) +
        '</strong></span>'
    );
  }
  parts.push('</div>');

  const skip = pupSkippedStagesNote(data);
  if (skip) parts.push('<p class="pup-result-note">' + esc(skip) + '</p>');

  const f1 = data.f1_relevance;
  if (f1 && typeof f1 === 'object') {
    parts.push('<div class="pup-result-panel">');
    parts.push('<h4>Relevance assessment</h4>');
    if (typeof f1.is_relevant !== 'boolean') {
      parts.push(
        '<p class="pup-result-note">The model did not return valid JSON (expected a boolean <code>is_relevant</code>). ' +
          'This is <strong>not</strong> the same as “not relevant” — the API response was empty, blocked, or unparsable. Retry, shorten inputs, or check your Gemini key / model.</p>'
      );
      parts.push(
        '<p class="pup-result-meta">The pipeline runs in order — <strong>relevance → extraction → matching → impact</strong>. Later stages do not start unless the relevance step returns valid JSON ' +
          'with <code>is_relevant: true</code> (truncated Arabic/English responses often die mid-<code>"reasoning"</code> string).</p>'
      );
      if (f1.raw_response != null && String(f1.raw_response).trim()) {
        parts.push('<p class="pup-result-meta">Raw model text (truncated)</p>');
        parts.push('<pre class="pup-result-excerpt">' + esc(String(f1.raw_response).slice(0, 4000)) + '</pre>');
      }
    } else {
      parts.push('<div class="pup-result-relevance-row">');
      const rel = !!f1.is_relevant;
      parts.push(
        '<span class="pup-result-pill ' +
          (rel ? 'pup-result-pill-yes' : 'pup-result-pill-no') +
          '">' +
          esc(rel ? 'Relevant to organisation' : 'Not relevant') +
          '</span>'
      );
      if (typeof f1.confidence === 'number') {
        const pct = Math.round(Math.min(1, Math.max(0, f1.confidence)) * 100);
        parts.push(
          '<span class="pup-result-confidence">Model confidence · <strong>' + esc(String(pct)) + '%</strong></span>'
        );
      }
      parts.push('</div>');
      if (f1.reasoning) {
        parts.push('<p class="pup-result-prose">' + esc(f1.reasoning) + '</p>');
      }
      const aspects = Array.isArray(f1.relevant_aspects) ? f1.relevant_aspects.filter(Boolean) : [];
      if (aspects.length) {
        parts.push('<ul class="pup-result-list">');
        for (const a of aspects) parts.push('<li>' + esc(a) + '</li>');
        parts.push('</ul>');
      }
    }
    parts.push('</div>');
  }

  const f2 = data.f2_summary;
  if (f2 && typeof f2 === 'object') {
    const pts = Array.isArray(f2.policy_points) ? f2.policy_points : [];
    parts.push('<div class="pup-result-panel">');
    parts.push('<h4>Regulation points extracted</h4>');
    if (!pts.length) {
      parts.push('<p class="pup-result-prose">No policy points returned.</p>');
    } else {
      for (const pt of pts) {
        parts.push('<div class="pup-result-point-card">');
        parts.push('<div class="pup-result-point-head">' + esc(pt.id || 'Point') + '</div>');
        const metaBits = [];
        if (pt.source_reference) metaBits.push('Reference: ' + pt.source_reference);
        if (pt.category) metaBits.push(pt.category);
        if (metaBits.length) {
          parts.push('<div class="pup-result-point-meta">' + esc(metaBits.join(' · ')) + '</div>');
        }
        parts.push('<p class="pup-result-prose" style="margin:0">' + esc(pt.point || '') + '</p>');
        parts.push('</div>');
      }
    }
    parts.push('</div>');
  }

  const f3 = data.f3_matches;
  if (Array.isArray(f3)) {
    parts.push('<div class="pup-result-panel">');
    parts.push('<h4>Policy matching</h4>');
    if (!f3.length) {
      parts.push('<p class="pup-result-prose">No points to match.</p>');
    } else {
      for (const row of f3) {
        const matches = Array.isArray(row.matches) ? row.matches : [];
        parts.push('<div class="pup-result-point-card">');
        parts.push('<div class="pup-result-point-head">' + esc(row.point_id || 'Point') + '</div>');
        parts.push('<p class="pup-result-prose" style="margin:0">' + esc(row.point_text || '') + '</p>');
        if (!matches.length) {
          parts.push('<p class="pup-result-meta" style="margin-top:10px">No policy matches above threshold.</p>');
        } else {
          for (const m of matches) {
            parts.push('<div class="pup-result-match-box">');
            parts.push('<div class="pup-result-match-policy">' + esc(m.policy_title || m.policy_id || 'Policy') + '</div>');
            if (typeof m.similarity_score === 'number') {
              parts.push(
                '<div class="pup-result-sim">Similarity · <strong>' + esc(String(m.similarity_score)) + '</strong></div>'
              );
            }
            if (m.content_excerpt) {
              parts.push('<div class="pup-result-excerpt">' + esc(m.content_excerpt) + '</div>');
            }
            parts.push('</div>');
          }
        }
        parts.push('</div>');
      }
    }
    parts.push('</div>');
  }

  const f4 = data.f4_impacts;
  if (Array.isArray(f4) && f4.length) {
    parts.push('<div class="pup-result-panel">');
    parts.push('<h4>Impact analysis</h4>');
    for (const block of f4) {
      parts.push('<div class="pup-result-point-card">');
      parts.push('<div class="pup-result-point-head">' + esc(block.point_id || '') + '</div>');
      parts.push(
        '<p class="pup-result-prose" style="margin:0;margin-bottom:10px">' + esc(block.point_text || '') + '</p>'
      );
      const impacts = Array.isArray(block.impacts) ? block.impacts : [];
      if (!impacts.length) parts.push('<p class="pup-result-meta">No impact rows.</p>');
      for (const imp of impacts) {
        const sev = pupSeverityClass(imp.severity);
        parts.push('<div class="pup-result-impact-card ' + sev + '">');
        parts.push('<div class="pup-result-impact-head">' + esc(imp.policy_title || imp.policy_id || 'Policy') + '</div>');
        if (imp.impact_summary) {
          parts.push('<p class="pup-result-prose" style="margin:10px 0 6px">' + esc(imp.impact_summary) + '</p>');
        }
        parts.push('<dl class="pup-result-dl">');
        if (imp.severity) parts.push('<dt>Severity</dt><dd>' + esc(String(imp.severity)) + '</dd>');
        if (imp.severity_reasoning) parts.push('<dt>Rationale</dt><dd>' + esc(imp.severity_reasoning) + '</dd>');
        if (typeof imp.requires_amendment === 'boolean') {
          parts.push('<dt>Requires amendment</dt><dd>' + esc(String(imp.requires_amendment)) + '</dd>');
        }
        if (imp.compliance_gap) parts.push('<dt>Compliance gap</dt><dd>' + esc(imp.compliance_gap) + '</dd>');
        parts.push('</dl>');
        const amds = Array.isArray(imp.amendments) ? imp.amendments : [];
        if (amds.length) {
          parts.push('<p style="margin:12px 0 6px;font-size:11px;font-weight:600;color:#111827">Suggested amendments</p>');
          parts.push('<ol class="pup-result-amends">');
          for (const a of amds) {
            const head = [];
            if (a.change_type) head.push('[' + a.change_type + ']');
            if (a.policy_section) head.push(a.policy_section);
            parts.push('<li><strong>' + esc(head.join(' ').trim()) + '</strong>');
            if (a.required_change) {
              parts.push('<div style="margin-top:4px">' + esc(a.required_change) + '</div>');
            }
            if (a.current_text_summary) {
              parts.push('<div style="margin-top:4px;font-size:11px;color:#64748b"><em>Current summary:</em> ' + esc(a.current_text_summary) + '</div>');
            }
            parts.push('</li>');
          }
          parts.push('</ol>');
        }
        if (
          typeof imp.raw_response === 'string' &&
          imp.raw_response &&
          !(imp.severity || imp.impact_summary)
        ) {
          parts.push('<pre style="margin-top:10px;font-size:11px;line-height:1.4;background:#fef2f2;padding:8px;border-radius:6px">' + esc(imp.raw_response) + '</pre>');
        }
        parts.push('</div>');
      }
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  parts.push('<details class="pup-result-raw-details"><summary>Raw JSON</summary><pre>');
  parts.push(esc(JSON.stringify(data, null, 2)));
  parts.push('</pre></details>');
  return parts.join('');
}

function closePolicyPipelineResultModal() {
  const overlay = document.getElementById('pup-result-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const shell = overlay.querySelector('.pup-result-modal-shell');
  const expandBtn = document.getElementById('pup-result-modal-expand');
  if (shell) shell.classList.remove('pup-result-modal-shell--expanded');
  if (expandBtn) {
    expandBtn.classList.remove('is-expanded');
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.setAttribute('aria-label', 'Expand result');
    expandBtn.title = 'Expand';
  }
}

function openPolicyPipelineResultModal(data) {
  const overlay = document.getElementById('pup-result-modal-overlay');
  const bodyEl = document.getElementById('pup-result-modal-body');
  const titleEl = document.getElementById('pup-result-modal-title');
  if (!overlay || !bodyEl) return;
  const shell = overlay.querySelector('.pup-result-modal-shell');
  const expandBtn = document.getElementById('pup-result-modal-expand');
  if (shell) shell.classList.remove('pup-result-modal-shell--expanded');
  if (expandBtn) {
    expandBtn.classList.remove('is-expanded');
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.setAttribute('aria-label', 'Expand result');
    expandBtn.title = 'Expand';
  }
  policyUpdatePipelineLastRaw = data;
  if (titleEl) {
    titleEl.textContent =
      data && typeof data === 'object' && data.stage_reached != null
        ? 'Pipeline result · ' + pupStageLabel(data.stage_reached)
        : 'Pipeline result';
  }
  bodyEl.innerHTML = renderPolicyPipelineResultHtml(data);
  bodyEl.scrollTop = 0;
  overlay.classList.add('active');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function initPolicyPipelineResultModalListeners() {
  if (policyUpdatePipelineResultModalWired) return;
  const overlay = document.getElementById('pup-result-modal-overlay');
  const closeBtn = document.getElementById('pup-result-modal-close');
  const closeBtnFooter = document.getElementById('pup-result-modal-close-btn');
  const confirmBtn = document.getElementById('pup-result-modal-confirm-btn');
  const copyBtn = document.getElementById('pup-result-modal-copy-json');
  if (!overlay || !document.body) return;
  policyUpdatePipelineResultModalWired = true;
  const close = () => closePolicyPipelineResultModal();
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (closeBtnFooter) closeBtnFooter.addEventListener('click', close);
  if (confirmBtn) confirmBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) close();
  });
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!policyUpdatePipelineLastRaw) {
        toast('error', 'Nothing to copy', 'Run the pipeline first.');
        return;
      }
      try {
        await navigator.clipboard.writeText(JSON.stringify(policyUpdatePipelineLastRaw, null, 2));
        toast('success', 'Copied', 'Full pipeline JSON copied to clipboard.');
      } catch (err) {
        toast('error', 'Copy failed', err.message || String(err));
      }
    });
  }
  const expandBtn = document.getElementById('pup-result-modal-expand');
  const shell = document.querySelector('#pup-result-modal-overlay .pup-result-modal-shell');
  if (expandBtn && shell) {
    expandBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = shell.classList.toggle('pup-result-modal-shell--expanded');
      expandBtn.classList.toggle('is-expanded', on);
      expandBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      expandBtn.setAttribute('aria-label', on ? 'Shrink result' : 'Expand result');
      expandBtn.title = on ? 'Shrink' : 'Expand';
    });
  }
}

/** Suggested severity rubric for the policy pipeline UI (optional one-click fill). "None" stays empty — add text only if you want a custom definition. */
const PUP_SEVERITY_SUGGESTED_DEFINITIONS = {
  critical:
    'Regulatory or business-stopping exposure: immediate compliance failure, prohibition on processing, or severe remediation obligations; policy change is mandatory before relying on current controls.',
  high:
    'Material gap affecting current operations, customer contracts, or audit and regulatory posture; remediate on an accelerated timeline.',
  medium: 'Meaningful gap with moderate exposure; schedule policy updates through the normal change process.',
  low: 'Minor clarification or tightening, or low residual risk if unchanged in the near term.',
};

function fillPupSeveritySuggestedDefinitions() {
  const map = [
    ['pup-f4-sev-critical', PUP_SEVERITY_SUGGESTED_DEFINITIONS.critical],
    ['pup-f4-sev-high', PUP_SEVERITY_SUGGESTED_DEFINITIONS.high],
    ['pup-f4-sev-medium', PUP_SEVERITY_SUGGESTED_DEFINITIONS.medium],
    ['pup-f4-sev-low', PUP_SEVERITY_SUGGESTED_DEFINITIONS.low],
  ];
  for (const [id, text] of map) {
    const el = document.getElementById(id);
    if (el) el.value = text;
  }
  const noneEl = document.getElementById('pup-f4-sev-none');
  if (noneEl) noneEl.value = '';
  toast('success', 'Definitions filled', 'You can edit any level before running the pipeline.');
}

function collectPupF4SeverityDefinitions() {
  const ids = [
    ['critical', 'pup-f4-sev-critical'],
    ['high', 'pup-f4-sev-high'],
    ['medium', 'pup-f4-sev-medium'],
    ['low', 'pup-f4-sev-low'],
    ['none', 'pup-f4-sev-none'],
  ];
  const out = {};
  for (const [key, id] of ids) {
    const el = document.getElementById(id);
    const t = el ? String(el.value || '').trim() : '';
    if (t) out[key] = t;
  }
  return out;
}

// ─── Policy file extraction ────────────────────────────────────────────────

let pupExtractedPoliciesResult = null; // holds the last extraction for the modal

function openPupExtractModal(articles, sourceFile, elapsed, context) {
  const overlay = document.getElementById('pup-extract-modal-overlay');
  const body = document.getElementById('pup-extract-modal-body');
  const meta = document.getElementById('pup-extract-modal-meta');
  const runLabel = document.getElementById('pup-extract-run-label');
  if (!overlay || !body) return;

  // context: 'pipeline' (PUP page) | 'internal-sources'
  pupExtractedPoliciesResult = { articles, sourceFile, context: context || 'pipeline' };

  if (meta) {
    meta.textContent = `${articles.length} article${articles.length === 1 ? '' : 's'} · ${sourceFile}${elapsed ? ' · ' + elapsed + 's' : ''}`;
  }
  if (runLabel) {
    runLabel.textContent = context === 'internal-sources' ? 'Save regulation' : 'Run pipeline';
  }

  body.innerHTML = articles.map((a, i) =>
    `<div class="pup-extract-policy-card">
      <span class="pup-extract-article-label">${esc(a.article || 'Article ' + (i + 1))}</span>
      <p class="pup-extract-policy-title">${esc(a.title || '')}</p>
      <p class="pup-extract-policy-content">${esc(a.text || '')}</p>
    </div>`
  ).join('');

  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
}

function closePupExtractModal() {
  const overlay = document.getElementById('pup-extract-modal-overlay');
  if (overlay) { overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); }
}

let _pupExtractStageTimer = null;

function setPupExtractLoading(visible, fileName) {
  const ov = document.getElementById('pup-extract-loading-overlay');
  const lbl = document.getElementById('pup-extract-loading-label');
  if (!ov) return;

  if (visible) {
    ov.hidden = false;
    ov.setAttribute('aria-hidden', 'false');

    // Stage messages + pill progression
    const stages = [
      { label: `Reading "${fileName || 'document'}"…`,   pill: 0 },
      { label: 'Analysing document structure…',           pill: 1 },
      { label: 'Extracting regulation articles…',         pill: 2 },
      { label: 'Finalising results…',                     pill: 2 },
    ];
    const pills = [0, 1, 2].map(i => document.getElementById(`pup-extract-stage-${i}`));

    function applyStage(idx) {
      const s = stages[Math.min(idx, stages.length - 1)];
      if (lbl) lbl.textContent = s.label;
      pills.forEach((p, i) => {
        if (!p) return;
        p.classList.toggle('is-active', i === s.pill);
        p.classList.toggle('is-done', i < s.pill);
        p.classList.toggle('is-active', i === s.pill && idx < stages.length - 1 || (i === s.pill && idx === stages.length - 1));
      });
    }

    applyStage(0);
    let stageIdx = 1;
    const delays = [4000, 8000, 14000]; // advance at 4s, 12s, 26s
    function scheduleNext(delay) {
      _pupExtractStageTimer = setTimeout(() => {
        applyStage(stageIdx);
        stageIdx++;
        if (stageIdx < stages.length) scheduleNext(delays[stageIdx - 1] || 8000);
      }, delay);
    }
    scheduleNext(delays[0]);

  } else {
    ov.hidden = true;
    ov.setAttribute('aria-hidden', 'true');
    if (_pupExtractStageTimer) { clearTimeout(_pupExtractStageTimer); _pupExtractStageTimer = null; }
    // Reset pills
    [0, 1, 2].forEach(i => {
      const p = document.getElementById(`pup-extract-stage-${i}`);
      if (p) { p.classList.remove('is-active', 'is-done'); }
    });
  }
}

async function onPupPolicyFileSelected(file, context) {
  if (!file) return;
  const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword', 'text/plain', 'text/markdown'];
  if (!allowed.includes(file.type) && !file.name.match(/\.(pdf|docx?|txt|md)$/i)) {
    toast('error', 'Unsupported file', 'Please upload a PDF, Word, or text document.');
    return;
  }

  const extractNotifId = `extract-${Date.now()}`;
  addNotif(extractNotifId, `Extracting: ${file.name}`, 'Analysing document with Gemini…', 'running');
  setPupExtractLoading(true, file.name);
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const r = await fetch('/api/ai-tools/extract-policies-from-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', data: base64 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || 'Extraction failed');

    const { articles, elapsed } = j;
    if (!articles || !articles.length) {
      updateNotif(extractNotifId, { status: 'info', message: 'No articles found in document.' });
      toast('info', 'No articles found', 'Gemini could not find any regulation articles in this document.');
      return;
    }
    updateNotif(extractNotifId, { status: 'success', message: `${articles.length} article${articles.length === 1 ? '' : 's'} extracted` });

    if (context === 'internal-sources') {
      // Skip the modal — save and run pipeline automatically
      const regulationText = articles.map(a =>
        `${a.article}${a.title ? ' — ' + a.title : ''}\n${a.text}`
      ).join('\n\n');
      fetch('/api/ai-tools/extracted-regulations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articles, sourceFile: file.name }),
      }).catch(() => {});
      toast('info', 'Pipeline started', `Running pipeline for "${file.name}" in the background.`);
      runPipelineInBackground(regulationText, file.name);
      return;
    }

    openPupExtractModal(articles, file.name, elapsed, context || 'pipeline');
  } catch (err) {
    console.error('[RegulationExtract]', err);
    updateNotif(extractNotifId, { status: 'error', message: err.message || 'Extraction failed' });
    toast('error', 'Extraction failed', err.message || 'Could not extract regulation from file.');
  } finally {
    setPupExtractLoading(false);
    // Reset file input so same file can be re-selected
    const fi = document.getElementById('pup-policy-file-input');
    if (fi) fi.value = '';
  }
}

async function onPupExtractRunPipeline() {
  if (!pupExtractedPoliciesResult) return;
  const { articles, sourceFile, context } = pupExtractedPoliciesResult;

  // Save to DB
  try {
    await fetch('/api/ai-tools/extracted-regulations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles, sourceFile }),
    });
  } catch (e) {
    console.warn('[RegulationExtract] DB save failed (non-fatal):', e.message);
  }

  // Reconstruct regulation plain text from articles
  const regulationText = articles.map(a =>
    `${a.article}${a.title ? ' — ' + a.title : ''}\n${a.text}`
  ).join('\n\n');

  closePupExtractModal();
  pupExtractedPoliciesResult = null;

  if (context === 'internal-sources') {
    // Fire pipeline in the background and track via notification system
    runPipelineInBackground(regulationText, sourceFile);
    return;
  }

  // PUP context: fill regulation textarea and run pipeline
  const regEl = document.getElementById('pup-regulation');
  if (regEl) regEl.value = regulationText;

  const statusEl = document.getElementById('pup-grc-policies-status');
  if (statusEl) { statusEl.innerHTML = ''; statusEl.textContent = `${articles.length} article${articles.length === 1 ? '' : 's'} extracted from "${sourceFile}"`; }

  runPolicyUpdatePipeline();
}

function initPupExtractModal() {
  const cancelBtn = document.getElementById('pup-extract-cancel-btn');
  const runBtn = document.getElementById('pup-extract-run-btn');
  const uploadBtn = document.getElementById('pup-upload-extract-btn');
  const fileInput = document.getElementById('pup-policy-file-input');

  if (cancelBtn) cancelBtn.addEventListener('click', closePupExtractModal);
  if (runBtn) runBtn.addEventListener('click', onPupExtractRunPipeline);
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) onPupPolicyFileSelected(fileInput.files[0]);
    });
  }

  // Close on backdrop click
  const overlay = document.getElementById('pup-extract-modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closePupExtractModal(); });
  }
}

async function loadPupPoliciesFromGrc() {
  const btn = document.getElementById('pup-load-grc-policies');
  const statusEl = document.getElementById('pup-grc-policies-status');
  const polEl = document.getElementById('pup-policies-json');
  if (!polEl) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  polEl.classList.add('pup-policies-textarea-loading');
  if (statusEl) {
    statusEl.className = 'pup-grc-status';
    statusEl.innerHTML = '<span class="pup-grc-spinner"></span>Loading policies from GRC…';
  }

  try {
    const policies = await fetchGrcPolicies();
    if (!policies.length) {
      if (statusEl) { statusEl.innerHTML = ''; statusEl.textContent = 'No policies found in GRC.'; }
      toast('info', 'No policies', 'The GRC API returned no policies.');
      return;
    }
    const mapped = policies.map(p => ({
      id: String(p.id),
      title: p.refId ? `[${p.refId}] ${p.name}` : p.name,
      content: p.description || p.name,
    }));
    polEl.value = JSON.stringify(mapped, null, 2);
    const label = `${mapped.length} polic${mapped.length === 1 ? 'y' : 'ies'} loaded from GRC`;
    if (statusEl) { statusEl.innerHTML = ''; statusEl.textContent = label; }
    toast('success', 'Policies loaded', label);
  } catch (err) {
    console.error('[Policy pipeline] loadPupPoliciesFromGrc:', err);
    if (statusEl) { statusEl.innerHTML = ''; statusEl.textContent = 'Failed to load from GRC.'; }
    toast('error', 'Load failed', err.message || 'Could not fetch policies from GRC.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Load from GRC'; }
    polEl.classList.remove('pup-policies-textarea-loading');
  }
}

async function runPolicyUpdatePipeline() {
  const orgEl = document.getElementById('pup-org-context');
  const regEl = document.getElementById('pup-regulation');
  const polEl = document.getElementById('pup-policies-json');
  const outEl = document.getElementById('pup-result');
  const stepperCard = document.querySelector('#page-policy-update-pipeline .pup-stepper-card--modern');
  const btn = document.getElementById('pup-run-btn');
  const stepBack = document.getElementById('pup-step-back');
  const stepNext = document.getElementById('pup-step-next');
  if (!regEl || !btn) return;

  const regulationText = (regEl.value || '').trim();
  if (!regulationText) {
    toast('error', 'Missing regulation', 'Paste regulation text first.');
    return;
  }

  let policies = [];
  const rawPol = (polEl && polEl.value) ? polEl.value.trim() : '';
  if (rawPol) {
    try {
      const parsed = JSON.parse(rawPol);
      policies = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      toast('error', 'Invalid JSON', 'Policies must be a JSON array.');
      return;
    }
  }

  btn.disabled = true;
  if (stepBack) stepBack.disabled = true;
  if (stepNext) stepNext.disabled = true;
  pupPipelineAbortController = new AbortController();
  const { signal } = pupPipelineAbortController;
  setPupPipelineLoadingOverlay(true);
  if (stepperCard) stepperCard.setAttribute('aria-busy', 'true');
  if (outEl) {
    outEl.style.display = 'none';
    outEl.textContent = '';
  }

  try {
    const r = await fetch('/api/ai-tools/policy-update-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        orgContext: orgEl ? orgEl.value : '',
        regulationText,
        policies,
        f4SeverityDefinitions: collectPupF4SeverityDefinitions(),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || 'Request failed');
    const payload = j.data != null ? j.data : j;
    if (outEl) {
      outEl.style.display = 'none';
      outEl.textContent = '';
    }
    openPolicyPipelineResultModal(payload);
    toast('success', 'Pipeline finished', `Stage: ${payload.stage_reached || 'done'}`);
    addNotif(`pup-fg-${Date.now()}`, 'Pipeline complete', `Stage reached: ${pupStageLabel(payload.stage_reached)}`, 'success', payload);

    // Persist result to DB (non-blocking, non-fatal)
    fetch('/api/ai-tools/pipeline-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgContext: orgEl ? orgEl.value : '',
        regulationText,
        policyCount: policies.length,
        result: payload,
      }),
    }).then(r => r.json()).then(saved => {
      if (saved && saved.id) console.log('[PipelineRuns] Saved run:', saved.id);
    }).catch(e => console.warn('[PipelineRuns] Save failed (non-fatal):', e.message));
  } catch (e) {
    if (e && e.name === 'AbortError') {
      toast('info', 'Cancelled', 'Pipeline request was cancelled. The server may still finish processing.');
      closePolicyPipelineResultModal();
      return;
    }
    console.error('[Policy update pipeline]', e);
    closePolicyPipelineResultModal();
    if (outEl) {
      outEl.style.display = 'block';
      outEl.textContent = e.message || String(e);
    }
    toast('error', 'Pipeline failed', e.message || '');
  } finally {
    pupPipelineAbortController = null;
    btn.disabled = false;
    if (stepNext) stepNext.disabled = false;
    syncPolicyPipelineStepperDOM();
    setPupPipelineLoadingOverlay(false);
    if (stepperCard) stepperCard.removeAttribute('aria-busy');
  }
}

// ─── Background Pipeline Run (triggered from internal sources) ─

async function runPipelineInBackground(regulationText, sourceFile) {
  const runId = `bg-pipeline-${Date.now()}`;
  addNotif(runId, `Pipeline: ${sourceFile}`, 'Loading org context…', 'running');

  try {
    // ── 1. Resolve org context ──────────────────────────────────
    let orgContextText = '';
    let orgName = '';
    const defaultOrgId = getPcfgDefaultOrgId();

    // Use already-cached orgs if available, otherwise fetch
    let allOrgs = Array.isArray(pupOrgContextsCache) && pupOrgContextsCache.length
      ? pupOrgContextsCache
      : [];
    if (!allOrgs.length) {
      try {
        const od = await fetchJSON(API.orgContexts);
        allOrgs = Array.isArray(od.contexts) ? od.contexts : [];
        pupOrgContextsCache = allOrgs;
      } catch (e) { console.warn('[BgPipeline] org fetch failed:', e.message); }
    }

    // Pick: configured default → first available
    const org = (defaultOrgId && allOrgs.find(o => String(o.id) === String(defaultOrgId)))
      || allOrgs[0]
      || null;

    if (org) {
      orgContextText = formatOrgProfileTextForPipeline(org);
      orgName = org.nameEn || org.name || 'Unknown org';
      updateNotif(runId, { message: `Org: ${orgName} · Fetching GRC policies…` });
    } else {
      updateNotif(runId, { message: '⚠ No org context found · Fetching GRC policies…' });
      toast('warning', 'No default org set', 'Go to Pipeline Configuration → Default org selection to set one.');
    }

    // ── 2. GRC policies ────────────────────────────────────────
    let policies = [];
    try {
      const rawPols = await fetchGrcPolicies();
      policies = rawPols.map(p => ({
        id:      String(p.id),
        title:   p.refId ? `[${p.refId}] ${p.name}` : p.name,
        content: p.description || p.name,
      }));
    } catch (e) { console.warn('[BgPipeline] GRC policies fetch failed:', e.message); }

    updateNotif(runId, { message: `Running · ${orgName || 'no org'} · ${policies.length} policies · ${sourceFile}` });

    // ── 3. Run the pipeline ────────────────────────────────────
    const r = await fetch('/api/ai-tools/policy-update-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgContext:    orgContextText,
        regulationText,
        policies,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || 'Pipeline failed');
    const payload = j.data != null ? j.data : j;

    // ── 4. Persist to DB ───────────────────────────────────────
    fetch('/api/ai-tools/pipeline-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgContext: orgContextText, regulationText, policyCount: policies.length, result: payload }),
    }).catch(() => {});

    updateNotif(runId, {
      status:  'success',
      message: `Stage: ${pupStageLabel(payload.stage_reached)} · ${policies.length} policies · click to view`,
      result:  payload,
    });

  } catch (e) {
    console.error('[BgPipeline]', e);
    updateNotif(runId, { status: 'error', message: e.message || 'Pipeline failed' });
  }
}

// ─── Pipeline History ──────────────────────────────────────────

async function loadPipelineHistoryPage() {
  const loadEl  = document.getElementById('ph-loading');
  const emptyEl = document.getElementById('ph-empty');
  const errEl   = document.getElementById('ph-error');
  const gridEl  = document.getElementById('ph-grid');
  if (!gridEl) return;

  if (loadEl)  { loadEl.style.display = 'flex'; }
  if (emptyEl) { emptyEl.style.display = 'none'; }
  if (errEl)   { errEl.style.display = 'none'; errEl.textContent = ''; }
  gridEl.innerHTML = '';

  try {
    const res  = await fetch('/api/ai-tools/pipeline-runs');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);

    if (loadEl) loadEl.style.display = 'none';
    const runs = json.data || [];

    if (!runs.length) {
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    gridEl.innerHTML = runs.map(run => {
      const date    = run.created_at ? new Date(run.created_at).toLocaleString() : '—';
      const stage   = run.stage_reached || '—';
      const snippet = run.regulation_snippet || 'No regulation text';
      const org     = run.org_context ? run.org_context.slice(0, 80).replace(/\s+/g, ' ').trim() : '—';
      const count   = run.policy_count ?? '—';
      const stageColor = stage === 'f4' ? '#16a34a' : stage === 'f3' ? '#ca8a04' : stage === 'f2' ? '#2563eb' : stage === 'f1' ? '#9333ea' : '#64748b';

      return `<div class="ph-card" onclick="openPhRunDetail('${esc(run.id)}')">
        <div class="ph-card-header">
          <span class="ph-stage-badge" style="background:${stageColor}1a;color:${stageColor};border-color:${stageColor}40">${esc(pupStageLabel ? pupStageLabel(stage) : stage)}</span>
          <span class="ph-card-date">${esc(date)}</span>
        </div>
        <p class="ph-card-snippet">${esc(snippet)}</p>
        <div class="ph-card-meta">
          <span class="ph-meta-item">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M5 7h6M5 10h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            ${esc(String(count))} polic${count === 1 ? 'y' : 'ies'}
          </span>
          ${org !== '—' ? `<span class="ph-meta-item">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="6" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5 6V5a3 3 0 0 1 6 0v1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            ${esc(org)}…
          </span>` : ''}
        </div>
        <div class="ph-card-arrow" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </div>`;
    }).join('');

  } catch (e) {
    if (loadEl) loadEl.style.display = 'none';
    if (errEl)  { errEl.textContent = e.message || String(e); errEl.style.display = 'block'; }
  }
}

async function openPhRunDetail(id) {
  try {
    const res  = await fetch(`/api/ai-tools/pipeline-runs/${encodeURIComponent(id)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    openPolicyPipelineResultModal(json.data.result);
  } catch (e) {
    toast('error', 'Could not load run', e.message || String(e));
  }
}

// ─── Init ─────────────────────────────────────────────────────

console.log('[admin.js] Script loaded, readyState:', document.readyState);

function initApp() {
  initDataStudioHub();
  initDataStudioUpload();
  initDataStudioPolicyUpload();
  initDataStudioRiskScenarioUpload();
  initPolicyPipelineResultModalListeners();
  initPolicyUpdatePipeline();
  initPupExtractModal();
  const { page, subId } = parseRoute();
  console.log(`[admin.js] Initializing → route: /${page}${subId ? '/' + subId : ''}`);
  navigateTo(page, true, subId);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
