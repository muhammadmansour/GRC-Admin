// Auth guard
if (!document.cookie.split(';').some(c => c.trim().startsWith('wathba_token='))) {
  window.location.replace('/login.html');
}

const PROMPTS_API = 'https://muraji-api.wathbah.dev/api/prompts';
const LOCAL_PROMPTS_API = '/api/local-prompts';

const promptsList = document.getElementById('prompts-list');
const promptsSearch = document.getElementById('prompts-search');
const btnCreatePrompt = document.getElementById('btn-create-prompt');
const btnClearCache = document.getElementById('btn-clear-cache');
const modalOverlay = document.getElementById('prompt-modal-overlay');
const modalTitle = document.getElementById('prompt-modal-title');
const modalClose = document.getElementById('prompt-modal-close');
const modalCancel = document.getElementById('prompt-modal-cancel');
const modalSave = document.getElementById('prompt-modal-save');
const inputName = document.getElementById('prompt-name');
const inputContent = document.getElementById('prompt-content');
const toastContainer = document.getElementById('toast-container');

let allPrompts = [];
let localPrompts = [];
let editingPromptId = null;
let editingSource = null;
const HIDDEN_IDS = ['64d28cc6-e8c2-4de1-8842-e1f9c65e9173'];

// ─── Fetch ─────────────────────────────────────────────────────

async function fetchAll() {
  await Promise.all([fetchLocal(), fetchApi()]);
  renderAll();
}

async function fetchLocal() {
  try {
    const r = await fetch(LOCAL_PROMPTS_API);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    localPrompts = d.prompts || [];
  } catch (e) { console.error('Local prompts error:', e); localPrompts = []; }
}

async function fetchApi() {
  try {
    const r = await fetch(PROMPTS_API);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    allPrompts = Array.isArray(d) ? d : (d.data || d.prompts || []);
    allPrompts = allPrompts.filter(p => !HIDDEN_IDS.includes(p._id || p.id));
  } catch (e) { console.error('API prompts error:', e); allPrompts = []; }
}

// ─── Render ────────────────────────────────────────────────────

function renderAll(q) {
  let html = '';
  let fLocal = localPrompts;
  let fApi = allPrompts;
  if (q) {
    fLocal = localPrompts.filter(p => (p.name||'').toLowerCase().includes(q) || (p.content||'').toLowerCase().includes(q));
    fApi = allPrompts.filter(p => (p.name||'').toLowerCase().includes(q) || (p.content||'').toLowerCase().includes(q));
  }

  if (fLocal.length > 0) {
    html += '<div class="prompts-section-header"><h2 class="prompts-section-title">Local Prompts</h2><span class="prompts-section-badge">Used by the app</span></div>';
    fLocal.forEach(p => { html += card(p, 'local'); });
  }

  if (fApi.length > 0) {
    html += '<div class="prompts-section-header" style="margin-top:2rem"><h2 class="prompts-section-title">API Prompts</h2><span class="prompts-section-badge secondary">From Muraji API</span></div>';
    fApi.forEach(p => { html += card(p, 'api'); });
  }

  if (!html) html = '<div class="prompts-empty"><p class="empty-title">No prompts found</p></div>';
  promptsList.innerHTML = html;
}

function card(p, src) {
  const id = p._id || p.id, nm = p.name || 'Untitled', v = p.version || 1;
  const cAt = p.created_at || p.createdAt, uAt = p.updated_at || p.updatedAt;
  const ct = p.content || '', prev = ct.substring(0, 200), isL = src === 'local';
  let h = '<div class="prompt-card' + (isL ? ' prompt-card-local' : '') + '" data-id="' + esc(id) + '">';
  h += '<div class="prompt-card-header"><div class="prompt-card-info"><h3 class="prompt-card-name">' + esc(nm) + '</h3>';
  if (isL) h += '<span class="prompt-local-badge">LOCAL</span>';
  h += '</div><div class="prompt-card-meta">';
  if (!isL) h += '<span class="prompt-version-badge">v' + v + '</span>';
  h += '</div></div>';
  if (prev) h += '<div class="prompt-card-preview"><pre>' + esc(prev) + (ct.length > 200 ? '…' : '') + '</pre></div>';
  h += '<div class="prompt-card-footer"><div class="prompt-card-dates">';
  if (uAt) h += '<span class="prompt-date">Updated ' + fmtD(uAt) + '</span>';
  if (cAt) h += '<span class="prompt-date">Created ' + fmtD(cAt) + '</span>';
  h += '</div><div class="prompt-card-actions">';
  h += '<button class="btn-prompt-action btn-prompt-edit" onclick="editPrompt(\'' + esc(id) + '\',\'' + src + '\')" title="Edit"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Edit</button>';
  if (!isL) h += '<button class="btn-prompt-action btn-prompt-delete" onclick="deletePrompt(\'' + esc(id) + '\',\'' + esc(nm).replace(/'/g, "\\'") + '\')" title="Delete"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Delete</button>';
  h += '</div></div>';
  // Special notes
  if (id === '8c0a228d-1fa7-47f6-9df6-4354b72f8134') {
    h += '<div class="prompt-card-note">Used in both applied control and requirement evidence assessments</div>';
  }
  if (id === 'b596eb43-d411-4fe6-9d80-0ab113673678') {
    h += '<div class="prompt-card-note">Used in extracting entities from evidence in CISO version</div>';
  }
  h += '</div>';
  return h;
}

// ─── Search ────────────────────────────────────────────────────

promptsSearch.addEventListener('input', e => { renderAll(e.target.value.toLowerCase().trim() || undefined); });

// ─── Modal ─────────────────────────────────────────────────────

function openModal() { modalOverlay.classList.add('active'); document.body.style.overflow = 'hidden'; }
function clrForm() { inputName.value = ''; inputContent.value = ''; }
function closeModal() { modalOverlay.classList.remove('active'); document.body.style.overflow = ''; editingPromptId = null; editingSource = null; clrForm(); }

btnCreatePrompt.addEventListener('click', () => { editingPromptId = null; editingSource = 'api'; modalTitle.textContent = 'New Prompt'; clrForm(); openModal(); inputName.focus(); });
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalOverlay.classList.contains('active')) closeModal(); });

// ─── Edit ──────────────────────────────────────────────────────

async function editPrompt(id, src) {
  editingPromptId = id; editingSource = src || 'api';
  modalTitle.textContent = 'Edit Prompt';

  if (src === 'local') {
    const c = localPrompts.find(p => p.id === id);
    inputName.value = c?.name || ''; inputContent.value = c?.content || '';
    openModal();
    try {
      const r = await fetch(LOCAL_PROMPTS_API + '/' + id);
      if (r.ok) { const d = await r.json(); const p = d.prompt || d; inputName.value = p.name || ''; inputContent.value = p.content || ''; }
    } catch (e) { console.error(e); toast('error', 'Error', e.message); }
  } else {
    const c = allPrompts.find(p => (p._id || p.id) === id);
    inputName.value = c?.name || ''; inputContent.value = c?.content || '';
    openModal();
    try {
      const r = await fetch(PROMPTS_API + '/' + id);
      if (r.ok) { const d = await r.json(); const p = d.data || d.prompt || d; inputName.value = p.name || ''; inputContent.value = p.content || ''; }
    } catch (e) { console.error(e); toast('error', 'Error', e.message); }
  }
  inputName.focus();
}
window.editPrompt = editPrompt;

// ─── Save ──────────────────────────────────────────────────────

modalSave.addEventListener('click', async () => {
  const nm = inputName.value.trim(), ct = inputContent.value.trim();
  if (!nm) { toast('error', 'Validation', 'Name is required.'); inputName.focus(); return; }
  if (!ct) { toast('error', 'Validation', 'Content is required.'); inputContent.focus(); return; }
  const body = { name: nm, content: ct };
  const btnT = modalSave.querySelector('.btn-text'), btnL = modalSave.querySelector('.btn-loading');
  try {
    modalSave.disabled = true;
    if (btnT) btnT.classList.add('hidden');
    if (btnL) btnL.classList.remove('hidden');
    let r;
    if (editingSource === 'local' && editingPromptId) {
      r = await fetch(LOCAL_PROMPTS_API + '/' + editingPromptId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else if (editingPromptId) {
      r = await fetch(PROMPTS_API + '/' + editingPromptId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      r = await fetch(PROMPTS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error || 'HTTP ' + r.status); }
    closeModal();
    toast('success', editingPromptId ? 'Updated' : 'Created', 'Prompt "' + nm + '" saved.');
    await fetchAll();
  } catch (e) { console.error(e); toast('error', 'Save Failed', e.message); }
  finally { modalSave.disabled = false; if (btnT) btnT.classList.remove('hidden'); if (btnL) btnL.classList.add('hidden'); }
});

// ─── Delete ────────────────────────────────────────────────────

async function deletePrompt(id, nm) {
  if (!confirm('Delete "' + nm + '"?')) return;
  try {
    const r = await fetch(PROMPTS_API + '/' + id, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error || 'HTTP ' + r.status); }
    toast('success', 'Deleted', '"' + nm + '" deleted.');
    await fetchAll();
  } catch (e) { console.error(e); toast('error', 'Delete Failed', e.message); }
}
window.deletePrompt = deletePrompt;

// ─── Clear Cache ───────────────────────────────────────────────

btnClearCache.addEventListener('click', async () => {
  try {
    const r = await fetch(PROMPTS_API + '/cache/clear', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('success', 'Cache Cleared', 'Done.');
    await fetchAll();
  } catch (e) { console.error(e); toast('error', 'Failed', e.message); }
});

// ─── Helpers ───────────────────────────────────────────────────

function esc(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function fmtD(s) {
  try {
    const d = new Date(s), n = new Date(), ms = n - d;
    const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; if (h < 24) return h + 'h ago'; if (dy < 7) return dy + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return s; }
}

function toast(type, title, msg, dur) {
  dur = dur || 5000;
  const el = document.createElement('div'); el.className = 'toast ' + type;
  const ic = { success: '<path d="M9 12L11 14L15 10M21 12C21 16.97 16.97 21 12 21C7.03 21 3 16.97 3 12C3 7.03 7.03 3 12 3C16.97 3 21 7.03 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>', error: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8V12M12 16V16.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', info: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 16V12M12 8V8.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' };
  el.innerHTML = '<div class="toast-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none">' + (ic[type] || ic.info) + '</svg></div><div class="toast-content"><div class="toast-title">' + esc(title) + '</div><div class="toast-message">' + esc(msg) + '</div></div><button class="toast-close"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
  el.querySelector('.toast-close').addEventListener('click', () => { el.classList.add('removing'); setTimeout(() => el.remove(), 300); });
  toastContainer.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { if (el.parentNode) { el.classList.add('removing'); setTimeout(() => el.remove(), 300); } }, dur);
}

fetchAll();
