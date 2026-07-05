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
const murajiActions = document.getElementById('prompts-muraji-actions');
const modalOverlay = document.getElementById('prompt-modal-overlay');
const modalTitle = document.getElementById('prompt-modal-title');
const modalClose = document.getElementById('prompt-modal-close');
const modalCancel = document.getElementById('prompt-modal-cancel');
const modalSave = document.getElementById('prompt-modal-save');
const inputKey = document.getElementById('prompt-key');
const inputKeyReadonly = document.getElementById('prompt-key-readonly');
const inputName = document.getElementById('prompt-name');
const inputDescription = document.getElementById('prompt-description');
const inputContent = document.getElementById('prompt-content');
const inputActive = document.getElementById('prompt-active');
const keyRow = document.getElementById('prompt-key-row');
const keyReadonlyRow = document.getElementById('prompt-key-readonly-row');
const descriptionRow = document.getElementById('prompt-description-row');
const activeRow = document.getElementById('prompt-active-row');
const toastContainer = document.getElementById('toast-container');

let allPrompts = [];
let localPrompts = [];
let editingPromptId = null;
let editingSource = null;
let activeTab = 'local';

function promptMatchesQuery(p, q) {
  const hay = [p.name, p.key, p.description, p.content].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function setTab(tab) {
  activeTab = tab === 'muraji' ? 'muraji' : 'local';
  document.querySelectorAll('[data-prompts-tab]').forEach(btn => {
    const isActive = btn.dataset.promptsTab === activeTab;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  if (murajiActions) murajiActions.style.display = activeTab === 'muraji' ? 'flex' : 'none';
  const q = promptsSearch.value.toLowerCase().trim();
  renderAll(q || undefined);
}

document.querySelectorAll('[data-prompts-tab]').forEach(btn => {
  btn.addEventListener('click', () => setTab(btn.dataset.promptsTab));
});

function updateTabCounts() {
  const localCount = document.getElementById('prompts-tab-local-count');
  const murajiCount = document.getElementById('prompts-tab-muraji-count');
  if (localCount) localCount.textContent = localPrompts.length ? String(localPrompts.length) : '';
  if (murajiCount) murajiCount.textContent = allPrompts.length ? String(allPrompts.length) : '';
}

// ─── Fetch ─────────────────────────────────────────────────────

async function fetchAll() {
  await Promise.all([fetchLocal(), fetchApi()]);
  updateTabCounts();
  setTab(activeTab);
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
  } catch (e) { console.error('Muraji prompts error:', e); allPrompts = []; }
}

// ─── Render ────────────────────────────────────────────────────

function renderAll(q) {
  let html = '';

  if (activeTab === 'local') {
    let fLocal = localPrompts;
    if (q) fLocal = localPrompts.filter(p => promptMatchesQuery(p, q));

    if (fLocal.length > 0) {
      html += '<div class="prompts-section-header"><h2 class="prompts-section-title">Local Prompts</h2><span class="prompts-section-badge">Used by the app</span></div>';
      fLocal.forEach(p => { html += card(p, 'local'); });
    } else {
      html = '<div class="prompts-empty"><p class="empty-title">No local prompts found</p></div>';
    }
  } else {
    let fApi = allPrompts;
    if (q) fApi = allPrompts.filter(p => promptMatchesQuery(p, q));

    if (fApi.length > 0) {
      html += '<div class="prompts-section-header"><h2 class="prompts-section-title">Muraji\' Prompts</h2><span class="prompts-section-badge secondary">Muraji API</span></div>';
      fApi.forEach(p => { html += card(p, 'api'); });
    } else {
      html = '<div class="prompts-empty"><p class="empty-title">No Muraji prompts found</p><p class="empty-subtitle">Create a Muraji prompt or check your API connection.</p></div>';
    }
  }

  promptsList.innerHTML = html;
}

function card(p, src) {
  const id = p._id || p.id;
  const nm = p.name || 'Untitled';
  const key = p.key || '';
  const desc = p.description || '';
  const v = p.version || 1;
  const cAt = p.created_at || p.createdAt;
  const uAt = p.updated_at || p.updatedAt;
  const ct = p.content || '';
  const prev = ct.substring(0, 200);
  const isL = src === 'local';
  const isActive = p.is_active !== false;

  let h = '<div class="prompt-card' + (isL ? ' prompt-card-local' : '') + (!isL && !isActive ? ' prompt-card-inactive' : '') + '" data-id="' + esc(id) + '">';
  h += '<div class="prompt-card-header"><div class="prompt-card-info"><h3 class="prompt-card-name">' + esc(nm) + '</h3>';
  if (isL) h += '<span class="prompt-local-badge">LOCAL</span>';
  if (!isL && key) h += '<span class="prompt-key-badge">' + esc(key) + '</span>';
  h += '</div><div class="prompt-card-meta">';
  if (!isL) h += '<span class="prompt-version-badge">v' + v + '</span>';
  if (!isL) h += '<span class="prompt-status-badge ' + (isActive ? 'active' : 'inactive') + '">' + (isActive ? 'Active' : 'Inactive') + '</span>';
  h += '</div></div>';
  if (desc) h += '<div class="prompt-card-desc">' + esc(desc) + '</div>';
  if (prev) h += '<div class="prompt-card-preview"><pre>' + esc(prev) + (ct.length > 200 ? '…' : '') + '</pre></div>';
  h += '<div class="prompt-card-footer"><div class="prompt-card-dates">';
  if (uAt) h += '<span class="prompt-date">Updated ' + fmtD(uAt) + '</span>';
  if (cAt) h += '<span class="prompt-date">Created ' + fmtD(cAt) + '</span>';
  h += '</div><div class="prompt-card-actions">';
  h += '<button class="btn-prompt-action btn-prompt-edit" onclick="editPrompt(\'' + esc(id) + '\',\'' + src + '\')" title="Edit"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 2L12 4L5 11H3V9L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Edit</button>';
  if (!isL) h += '<button class="btn-prompt-action btn-prompt-delete" onclick="deletePrompt(\'' + esc(id) + '\',\'' + esc(nm).replace(/'/g, "\\'") + '\')" title="Delete"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4H11M5 4V3C5 2.4 5.4 2 6 2H8C8.6 2 9 2.4 9 3V4M6 7V10M8 7V10M4 4L5 12H9L10 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Delete</button>';
  h += '</div></div>';

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

function clrForm() {
  inputKey.value = '';
  inputKeyReadonly.value = '';
  inputName.value = '';
  inputDescription.value = '';
  inputContent.value = '';
  inputActive.checked = true;
}

function configureModalFields(source, isCreate) {
  const isMuraji = source === 'api';
  if (keyRow) keyRow.hidden = !isMuraji || !isCreate;
  if (keyReadonlyRow) keyReadonlyRow.hidden = !isMuraji || isCreate;
  if (descriptionRow) descriptionRow.hidden = !isMuraji;
  if (activeRow) activeRow.hidden = !isMuraji || isCreate;
}

function fillForm(p) {
  inputKey.value = p.key || '';
  inputKeyReadonly.value = p.key || '';
  inputName.value = p.name || '';
  inputDescription.value = p.description || '';
  inputContent.value = p.content || '';
  inputActive.checked = p.is_active !== false;
}

function openModal() { modalOverlay.classList.add('active'); document.body.style.overflow = 'hidden'; }
function closeModal() { modalOverlay.classList.remove('active'); document.body.style.overflow = ''; editingPromptId = null; editingSource = null; clrForm(); configureModalFields('local', true); }

btnCreatePrompt.addEventListener('click', () => {
  editingPromptId = null;
  editingSource = 'api';
  modalTitle.textContent = 'New Muraji Prompt';
  clrForm();
  configureModalFields('api', true);
  openModal();
  inputKey.focus();
});
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalOverlay.classList.contains('active')) closeModal(); });

// ─── Edit ──────────────────────────────────────────────────────

async function editPrompt(id, src) {
  editingPromptId = id;
  editingSource = src || 'api';
  modalTitle.textContent = src === 'local' ? 'Edit Local Prompt' : 'Edit Muraji Prompt';
  clrForm();
  configureModalFields(src || 'api', false);

  if (src === 'local') {
    fillForm(localPrompts.find(p => p.id === id) || {});
    openModal();
    try {
      const r = await fetch(LOCAL_PROMPTS_API + '/' + id);
      if (r.ok) {
        const d = await r.json();
        fillForm(d.prompt || d);
      }
    } catch (e) { console.error(e); toast('error', 'Error', e.message); }
    inputName.focus();
    return;
  }

  fillForm(allPrompts.find(p => (p._id || p.id) === id) || {});
  openModal();
  try {
    const r = await fetch(PROMPTS_API + '/' + id);
    if (r.ok) {
      const d = await r.json();
      fillForm(d.data || d.prompt || d);
    }
  } catch (e) { console.error(e); toast('error', 'Error', e.message); }
  inputName.focus();
}
window.editPrompt = editPrompt;

// ─── Save ──────────────────────────────────────────────────────

modalSave.addEventListener('click', async () => {
  const key = inputKey.value.trim();
  const nm = inputName.value.trim();
  const desc = inputDescription.value.trim();
  const ct = inputContent.value.trim();
  const isActive = inputActive.checked;

  if (editingSource === 'api' && !editingPromptId) {
    if (!key) { toast('error', 'Validation', 'Key is required.'); inputKey.focus(); return; }
    if (!/^[a-z0-9_]+$/.test(key)) {
      toast('error', 'Validation', 'Key must use lowercase letters, numbers, and underscores only.');
      inputKey.focus();
      return;
    }
  }
  if (!nm) { toast('error', 'Validation', 'Name is required.'); inputName.focus(); return; }
  if (!ct) { toast('error', 'Validation', 'Content is required.'); inputContent.focus(); return; }

  const btnT = modalSave.querySelector('.btn-text');
  const btnL = modalSave.querySelector('.btn-loading');
  const savedSource = editingSource;
  const wasEditing = !!editingPromptId;

  try {
    modalSave.disabled = true;
    if (btnT) btnT.classList.add('hidden');
    if (btnL) btnL.classList.remove('hidden');

    let r;
    if (savedSource === 'local' && editingPromptId) {
      r = await fetch(LOCAL_PROMPTS_API + '/' + editingPromptId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nm, content: ct }),
      });
    } else if (editingPromptId) {
      const body = { name: nm, content: ct, is_active: isActive, description: desc || '' };
      r = await fetch(PROMPTS_API + '/' + editingPromptId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      const body = { key, name: nm, content: ct };
      if (desc) body.description = desc;
      r = await fetch(PROMPTS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || e.error || 'HTTP ' + r.status); }

    closeModal();
    toast('success', wasEditing ? 'Updated' : 'Created', 'Prompt "' + nm + '" saved.');
    setTab(savedSource === 'local' ? 'local' : 'muraji');
    await fetchAll();
  } catch (e) { console.error(e); toast('error', 'Save Failed', e.message); }
  finally { modalSave.disabled = false; if (btnT) btnT.classList.remove('hidden'); if (btnL) btnL.classList.add('hidden'); }
});

// ─── Delete ────────────────────────────────────────────────────

async function deletePrompt(id, nm) {
  if (!confirm('Delete "' + nm + '"? This cannot be undone.')) return;
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
    toast('success', 'Cache Cleared', 'Muraji prompt cache cleared.');
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
