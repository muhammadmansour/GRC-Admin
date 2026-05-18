const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const Database = require('better-sqlite3');
const yaml = require('js-yaml');
const XLSX = require('xlsx');
const { runPolicyUpdatePipeline } = require('./policyUpdatePipeline');

const PORT = Number(process.env.PORT) || 3333; // stage-version default
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';

// File Search uploads: Gemini indexing often exceeds the default 2min poll when batching large PDFs
const GEMINI_FILE_SEARCH_INDEX_POLL_MS = 480000;

// Load environment variables from .env file
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    });
  } catch (error) {
    console.warn('No .env file found or error loading it:', error.message);
  }
}

loadEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// GRC Platform configuration (stage-version → https://grc-stage.wathbahs.com/)
const GRC_API_URL = String(process.env.GRC_API_URL || 'https://grc-stage.wathbahs.com')
  .trim()
  .replace(/\/+$/, '');

/** Browser-facing Muraji API origin (libraries + prompts). Set `MURAJI_API_URL` or `MURAJI_BASE_URL` in `.env`. */
const MURAJI_API_URL = String(
  process.env.MURAJI_API_URL || process.env.MURAJI_BASE_URL || 'https://muraji-stage.wathbahs.com',
)
  .trim()
  .replace(/\/+$/, '');

// ==========================================
// Authentication (via GRC IAM)
// ==========================================

// Maps local session token → GRC auth token
const authSessions = new Map(); // { localToken: { grcToken, username } }

function generateLocalToken() {
  return crypto.randomBytes(48).toString('hex');
}

function isValidToken(token) {
  return token && authSessions.has(token);
}

function getGrcToken(localToken) {
  const session = authSessions.get(localToken);
  return session ? session.grcToken : null;
}

// Helper: make authenticated GRC API fetch
function grcFetch(url, options = {}, localToken) {
  const grcToken = localToken ? getGrcToken(localToken) : null;
  const headers = { ...(options.headers || {}) };
  if (grcToken) {
    headers['Authorization'] = `Token ${grcToken}`;
  }
  return fetch(url, { ...options, headers });
}

/** True if upstream GRC rejected our stored Token (session must be cleared). */
function isGrcInvalidTokenBody(status, errText) {
  if (status !== 401) return false;
  const s = errText || '';
  if (/invalid\s*token/i.test(s)) return true;
  try {
    const j = JSON.parse(s);
    const d = j && j.detail != null ? String(j.detail) : '';
    if (/invalid/i.test(d) && /token/i.test(d)) return true;
  } catch (_) { /* not JSON */ }
  return false;
}

/**
 * When GRC returns 401 with invalid token: delete local session, send 401 JSON with grcSessionExpired.
 * If grcRes.ok → returns false. If handled invalid token → returns true (caller must return).
 * Otherwise throws Error with GRC body.
 */
async function finalizeGrcUpstreamError(httpRes, reqToken, grcRes) {
  if (grcRes.ok) return false;
  const errText = await grcRes.text();
  if (reqToken && isGrcInvalidTokenBody(grcRes.status, errText)) {
    authSessions.delete(reqToken);
    httpRes.writeHead(401, { 'Content-Type': 'application/json' });
    httpRes.end(JSON.stringify({
      success: false,
      grcSessionExpired: true,
      error: errText.trim(),
    }));
    return true;
  }
  throw new Error(`GRC API ${grcRes.status}: ${errText}`);
}

/**
 * Read failed GRC response body exactly once (do not call .text()/.json() on grcRes after this).
 * On invalid-token 401: clears session and sends JSON to client — returns { aborted: true }.
 * For any other error: returns { aborted: false, status, errText } (no throw).
 */
async function consumeGrcErrorBody(httpRes, reqToken, grcRes) {
  const errText = await grcRes.text();
  if (reqToken && isGrcInvalidTokenBody(grcRes.status, errText)) {
    authSessions.delete(reqToken);
    httpRes.writeHead(401, { 'Content-Type': 'application/json' });
    httpRes.end(JSON.stringify({
      success: false,
      grcSessionExpired: true,
      error: errText.trim(),
    }));
    return { aborted: true, status: grcRes.status, errText: '' };
  }
  return { aborted: false, status: grcRes.status, errText };
}

// Public paths that don't need auth
const PUBLIC_PATHS = new Set([
  '/login.html', '/login.css', '/login.js',
  '/api/auth/login', '/api/auth/logout', '/api/auth/check',
]);

function isPublicPath(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Fonts / favicons
  if (pathname.endsWith('.woff2') || pathname.endsWith('.woff') || pathname === '/favicon.ico') return true;
  // Policy collections API is public for now
  if (pathname.startsWith('/api/policy-collections')) return true;
  return false;
}

/**
 * Admin SPA client routes — must match admin.js (navigateTo / history paths).
 * Serves admin.html so refresh/deep-links work after auth passes.
 */
const ADMIN_SPA_ROUTE_PREFIXES = [
  '/dashboard',
  '/audit-sessions',
  '/audit-studio',
  '/controls-studio',
  '/merge-optimizer',
  '/policy-ingestion',
  '/policy-update-pipeline',
  '/org-contexts',
  '/data-studio',
  '/prompts',
  '/file-collections',
  '/workbench',
  '/audit-log',
];

function isAdminSpaPath(pathname) {
  let p = pathname == null ? '' : String(pathname);
  try {
    p = decodeURIComponent(p.replace(/\+/g, ' '));
  } catch (_) { /* malformed encoding */ }
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '/' || p === '') return true;
  return ADMIN_SPA_ROUTE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function getTokenFromRequest(req) {
  // Check cookie
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  for (const c of cookies) {
    if (c.startsWith('wathba_token=')) return c.substring('wathba_token='.length);
  }
  // Check Authorization header (for API clients)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.substring(7);
  return null;
}

// ==========================================
// SQLite Database
// ==========================================

const db = new Database(path.join(__dirname, 'sessions.db'));
db.pragma('journal_mode = WAL');  // Better performance for concurrent reads

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    context TEXT NOT NULL DEFAULT '{}',
    system_prompt TEXT NOT NULL DEFAULT '',
    cached_content_name TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

  CREATE TABLE IF NOT EXISTS local_prompts (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS org_contexts (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_ar TEXT DEFAULT '',
    sector TEXT DEFAULT '',
    sector_custom TEXT DEFAULT '',
    size TEXT DEFAULT '',
    compliance_maturity INTEGER DEFAULT 1,
    regulatory_mandates TEXT DEFAULT '[]',
    governance_structure TEXT DEFAULT '',
    data_classification TEXT DEFAULT '',
    geographic_scope TEXT DEFAULT '',
    it_infrastructure TEXT DEFAULT '',
    strategic_objectives TEXT DEFAULT '[]',
    obligatory_frameworks TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    store_id TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cs_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    step INTEGER NOT NULL DEFAULT 0,
    requirements TEXT NOT NULL DEFAULT '[]',
    collections TEXT NOT NULL DEFAULT '[]',
    selected_files TEXT NOT NULL DEFAULT '[]',
    session_files TEXT NOT NULL DEFAULT '[]',
    org_context TEXT DEFAULT NULL,
    controls TEXT NOT NULL DEFAULT '[]',
    framework TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policy_collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    store_id TEXT DEFAULT '',
    status TEXT DEFAULT 'empty',
    config TEXT DEFAULT '{}',
    extraction_result TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS policy_files (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT DEFAULT 'application/octet-stream',
    size INTEGER DEFAULT 0,
    local_path TEXT DEFAULT '',
    store_doc_name TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES policy_collections(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_policy_files_collection ON policy_files(collection_id);

  CREATE TABLE IF NOT EXISTS policy_generation_history (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL,
    generation_type TEXT DEFAULT 'both',
    status TEXT DEFAULT 'generated',
    config TEXT DEFAULT '{}',
    summary TEXT DEFAULT '{}',
    library_urn TEXT DEFAULT NULL,
    controls_count INTEGER DEFAULT 0,
    nodes_count INTEGER DEFAULT 0,
    confidence_score INTEGER DEFAULT 0,
    generation_time TEXT DEFAULT '',
    source_file_count INTEGER DEFAULT 0,
    error_message TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES policy_collections(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_policy_gen_history_collection ON policy_generation_history(collection_id);

  CREATE TABLE IF NOT EXISTS ciso_entity_cache (
    id          TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    name        TEXT,
    ref_id      TEXT,
    status      TEXT,
    data        TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(id, entity_type)
  );

  CREATE INDEX IF NOT EXISTS idx_cache_type ON ciso_entity_cache(entity_type);

  CREATE TABLE IF NOT EXISTS org_context_chain (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_context_id              TEXT NOT NULL,
    objective_uuid              TEXT,
    framework_uuid              TEXT,
    requirement_uuid            TEXT,
    compliance_assessment_uuid  TEXT,
    requirement_assessment_uuid TEXT,
    risk_scenario_uuid          TEXT,
    applied_control_uuid        TEXT,
    resolved_at                 TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (org_context_id) REFERENCES org_contexts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_chain_org ON org_context_chain(org_context_id);
  CREATE INDEX IF NOT EXISTS idx_chain_fw  ON org_context_chain(framework_uuid);
`);

// Migrate policy_generation_history: add extraction_data and policy_uuid columns if missing
try {
  const histCols = db.pragma('table_info(policy_generation_history)').map(c => c.name);
  if (!histCols.includes('extraction_data')) {
    db.exec(`ALTER TABLE policy_generation_history ADD COLUMN extraction_data TEXT DEFAULT NULL`);
    console.log('[Migration] Added extraction_data column to policy_generation_history');
  }
  if (!histCols.includes('policy_uuid')) {
    db.exec(`ALTER TABLE policy_generation_history ADD COLUMN policy_uuid TEXT`);
    console.log('[Migration] Added policy_uuid column to policy_generation_history');
  }
} catch (migErr) { console.warn('policy_generation_history migration:', migErr.message); }

// Migrate policy_collections: add policy_uuid column if missing
try {
  const pcCols = db.pragma('table_info(policy_collections)').map(c => c.name);
  if (!pcCols.includes('policy_uuid')) {
    db.exec(`ALTER TABLE policy_collections ADD COLUMN policy_uuid TEXT`);
    console.log('[Migration] Added policy_uuid column to policy_collections');
  }
} catch (migErr) { console.warn('policy_collections migration:', migErr.message); }

// Migrate policy_files: add gemini_file_name and gemini_file_uri columns if missing
try {
  const pfCols = db.pragma('table_info(policy_files)').map(c => c.name);
  if (!pfCols.includes('gemini_file_name')) {
    db.exec(`ALTER TABLE policy_files ADD COLUMN gemini_file_name TEXT DEFAULT ''`);
    console.log('[Migration] Added gemini_file_name column to policy_files');
  }
  if (!pfCols.includes('gemini_file_uri')) {
    db.exec(`ALTER TABLE policy_files ADD COLUMN gemini_file_uri TEXT DEFAULT ''`);
    console.log('[Migration] Added gemini_file_uri column to policy_files');
  }
} catch (migErr) { console.warn('policy_files migration:', migErr.message); }

// Migrate cs_sessions: add exported_control_ids if missing
try {
  const csCols = db.pragma('table_info(cs_sessions)').map(c => c.name);
  if (!csCols.includes('exported_control_ids')) {
    db.exec(`ALTER TABLE cs_sessions ADD COLUMN exported_control_ids TEXT NOT NULL DEFAULT '[]'`);
  }
} catch (migErr) { console.warn('CS sessions migration:', migErr.message); }

// Migrate org_contexts: add new profile columns if missing
try {
  const cols = db.pragma('table_info(org_contexts)').map(c => c.name);
  const addCol = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE org_contexts ADD COLUMN ${name} ${def}`); };
  addCol('sector_custom', "TEXT DEFAULT ''");
  addCol('compliance_maturity', 'INTEGER DEFAULT 1');
  addCol('regulatory_mandates', "TEXT DEFAULT '[]'");
  addCol('governance_structure', "TEXT DEFAULT ''");
  addCol('data_classification', "TEXT DEFAULT ''");
  addCol('geographic_scope', "TEXT DEFAULT ''");
  addCol('it_infrastructure', "TEXT DEFAULT ''");
  addCol('strategic_objectives', "TEXT DEFAULT '[]'");
  addCol('policies', "TEXT DEFAULT '[]'");
  addCol('tracking_metrics', "TEXT DEFAULT '[]'");
  addCol('risk_scenarios', "TEXT DEFAULT '[]'");
  addCol('controls', "TEXT DEFAULT '[]'");
  addCol('objective_framework_map', "TEXT DEFAULT '{}'");
  addCol('store_id', "TEXT DEFAULT ''");
} catch (migErr) { console.warn('Org profile migration:', migErr.message); }

console.log('SQLite database initialized (sessions.db)');

// DB helper functions
const dbInsertSession = db.prepare(`
  INSERT INTO sessions (id, context, system_prompt, cached_content_name, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const dbInsertMessage = db.prepare(`
  INSERT INTO messages (session_id, role, text, created_at)
  VALUES (?, ?, ?, ?)
`);

const dbGetSession = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

const dbGetMessages = db.prepare(`
  SELECT role, text, created_at FROM messages WHERE session_id = ? ORDER BY id ASC
`);

const dbListSessions = db.prepare(`
  SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
  FROM sessions s ORDER BY s.created_at DESC
`);

const dbDeleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const dbDeleteSessionMessages = db.prepare(`DELETE FROM messages WHERE session_id = ?`);

// Local prompts DB helpers
const dbGetLocalPrompt = db.prepare(`SELECT * FROM local_prompts WHERE id = ?`);
const dbGetLocalPromptByKey = db.prepare(`SELECT * FROM local_prompts WHERE key = ?`);
const dbListLocalPrompts = db.prepare(`SELECT * FROM local_prompts ORDER BY name ASC`);
const dbInsertLocalPrompt = db.prepare(`
  INSERT OR IGNORE INTO local_prompts (id, key, name, content, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const dbUpdateLocalPrompt = db.prepare(`
  UPDATE local_prompts SET name = ?, content = ?, updated_at = ? WHERE id = ?
`);

// Org contexts DB helpers
const dbListOrgContexts = db.prepare(`SELECT * FROM org_contexts ORDER BY created_at DESC`);
const dbGetOrgContext = db.prepare(`SELECT * FROM org_contexts WHERE id = ?`);
const dbInsertOrgContext = db.prepare(`
  INSERT INTO org_contexts (id, name_en, name_ar, sector, sector_custom, size, compliance_maturity, regulatory_mandates, governance_structure, data_classification, geographic_scope, it_infrastructure, strategic_objectives, obligatory_frameworks, policies, tracking_metrics, risk_scenarios, objective_framework_map, notes, is_active, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const dbUpdateOrgContext = db.prepare(`
  UPDATE org_contexts SET name_en = ?, name_ar = ?, sector = ?, sector_custom = ?, size = ?, compliance_maturity = ?, regulatory_mandates = ?, governance_structure = ?, data_classification = ?, geographic_scope = ?, it_infrastructure = ?, strategic_objectives = ?, obligatory_frameworks = ?, policies = ?, tracking_metrics = ?, risk_scenarios = ?, objective_framework_map = ?, notes = ?, is_active = ?, updated_at = ? WHERE id = ?
`);
const dbDeleteOrgContext = db.prepare(`DELETE FROM org_contexts WHERE id = ?`);

const dbUpdateOrgContextStoreId = db.prepare(`UPDATE org_contexts SET store_id = ?, updated_at = ? WHERE id = ?`);

// ---- CISO Entity Cache DB helpers ----
const dbGetCachedEntity = db.prepare(`SELECT * FROM ciso_entity_cache WHERE id = ? AND entity_type = ?`);
const dbUpsertCachedEntity = db.prepare(`
  INSERT INTO ciso_entity_cache (id, entity_type, name, ref_id, status, data, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id, entity_type) DO UPDATE SET
    name = excluded.name, ref_id = excluded.ref_id, status = excluded.status,
    data = excluded.data, fetched_at = excluded.fetched_at
`);
const dbGetCachedEntitiesByType = db.prepare(`SELECT * FROM ciso_entity_cache WHERE entity_type = ?`);
const dbClearCacheByType = db.prepare(`DELETE FROM ciso_entity_cache WHERE entity_type = ?`);

// ---- Org Context Chain DB helpers ----
const dbInsertChainRow = db.prepare(`
  INSERT INTO org_context_chain (org_context_id, objective_uuid, framework_uuid, requirement_uuid, compliance_assessment_uuid, requirement_assessment_uuid, risk_scenario_uuid, applied_control_uuid, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);
const dbDeleteChainByOrg = db.prepare(`DELETE FROM org_context_chain WHERE org_context_id = ?`);
const dbGetChainByOrg = db.prepare(`
  SELECT
    c.id AS chain_id,
    c.org_context_id,
    c.objective_uuid,
    c.framework_uuid,
    c.requirement_uuid,
    c.compliance_assessment_uuid,
    c.requirement_assessment_uuid,
    c.risk_scenario_uuid,
    c.applied_control_uuid,
    c.resolved_at,
    obj.name AS objective_name, obj.ref_id AS objective_ref,
    fw.name AS framework_name, fw.ref_id AS framework_ref,
    req.name AS requirement_name, req.ref_id AS requirement_ref,
    ca.name AS compliance_assessment_name,
    ra.name AS requirement_assessment_name, ra.status AS requirement_assessment_status,
    rs.name AS risk_scenario_name, rs.ref_id AS risk_scenario_ref, rs.status AS risk_scenario_status,
    ac.name AS control_name, ac.ref_id AS control_ref, ac.status AS control_status
  FROM org_context_chain c
  LEFT JOIN ciso_entity_cache obj ON obj.id = c.objective_uuid AND obj.entity_type = 'objective'
  LEFT JOIN ciso_entity_cache fw  ON fw.id  = c.framework_uuid AND fw.entity_type = 'framework'
  LEFT JOIN ciso_entity_cache req ON req.id = c.requirement_uuid AND req.entity_type = 'requirement'
  LEFT JOIN ciso_entity_cache ca  ON ca.id  = c.compliance_assessment_uuid AND ca.entity_type = 'compliance_assessment'
  LEFT JOIN ciso_entity_cache ra  ON ra.id  = c.requirement_assessment_uuid AND ra.entity_type = 'requirement_assessment'
  LEFT JOIN ciso_entity_cache rs  ON rs.id  = c.risk_scenario_uuid AND rs.entity_type = 'risk_scenario'
  LEFT JOIN ciso_entity_cache ac  ON ac.id  = c.applied_control_uuid AND ac.entity_type = 'applied_control'
  WHERE c.org_context_id = ?
  ORDER BY c.id
`);

// ==========================================
// Chain Resolution Engine
// ==========================================

// Fetch a single CISO Assistant entity, using cache with TTL
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchCachedEntity(entityType, uuid, apiPath, localToken) {
  if (!uuid) return null;

  // Check cache first
  const cached = dbGetCachedEntity.get(uuid, entityType);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < CACHE_TTL_MS) {
      return JSON.parse(cached.data || '{}');
    }
  }

  // Fetch from CISO Assistant API
  try {
    const res = await grcFetch(`${GRC_API_URL}${apiPath}`, {}, localToken);
    if (!res.ok) {
      console.warn(`[Chain] Failed to fetch ${entityType} ${uuid}: ${res.status}`);
      return cached ? JSON.parse(cached.data || '{}') : null; // Return stale cache if available
    }
    const data = await res.json();
    const name = data.name || data.ref_id || '';
    const refId = data.ref_id || '';
    const status = data.status || '';
    dbUpsertCachedEntity.run(uuid, entityType, name, refId, status, JSON.stringify(data));
    return data;
  } catch (err) {
    console.error(`[Chain] Error fetching ${entityType} ${uuid}:`, err.message);
    return cached ? JSON.parse(cached.data || '{}') : null;
  }
}

// Fetch a paginated list from CISO Assistant API
async function fetchPaginatedList(apiPath, localToken) {
  const results = [];
  let url = `${GRC_API_URL}${apiPath}`;
  while (url) {
    try {
      const res = await grcFetch(url, {}, localToken);
      if (!res.ok) { console.warn(`[Chain] Paginated fetch failed: ${res.status} for ${url}`); break; }
      const data = await res.json();
      const items = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);
      results.push(...items);
      url = data.next || null;
    } catch (err) {
      console.error(`[Chain] Paginated fetch error:`, err.message);
      break;
    }
  }
  return results;
}

// Cache a batch of entities
function cacheEntities(entityType, entities) {
  for (const e of entities) {
    const id = e.id || e.uuid;
    if (!id) continue;
    dbUpsertCachedEntity.run(
      id, entityType,
      e.name || e.ref_id || '',
      e.ref_id || '',
      e.status || '',
      JSON.stringify(e)
    );
  }
}

// Main chain resolution function
async function resolveOrgContextChain(orgContextId, localToken) {
  console.log(`[Chain] Resolving chain for org_context: ${orgContextId}`);

  // 1. Load org_context
  const orgRow = dbGetOrgContext.get(orgContextId);
  if (!orgRow) throw new Error(`Org context not found: ${orgContextId}`);

  const objectiveUuids = JSON.parse(orgRow.strategic_objectives || '[]').filter(v => typeof v === 'string' && v.includes('-'));
  const frameworkUuids = JSON.parse(orgRow.obligatory_frameworks || '[]').filter(v => typeof v === 'string' && v.includes('-'));
  const riskUuids = JSON.parse(orgRow.risk_scenarios || '[]').filter(v => typeof v === 'string' && v.includes('-'));
  // Objective → Framework mapping (user-defined)
  let objFwMap = {};
  try { objFwMap = JSON.parse(orgRow.objective_framework_map || '{}'); } catch {}
  // controls field may be used for applied_control UUIDs
  let controlUuids = [];
  try { controlUuids = JSON.parse(orgRow.controls || '[]').filter(v => typeof v === 'string' && v.includes('-')); } catch {}

  console.log(`[Chain] UUIDs — objectives: ${objectiveUuids.length}, frameworks: ${frameworkUuids.length}, risks: ${riskUuids.length}, controls: ${controlUuids.length}`);
  console.log(`[Chain] Objective-Framework map keys: ${Object.keys(objFwMap).length}`);

  // 2. Fetch objectives
  const objectives = [];
  for (const uuid of objectiveUuids) {
    const obj = await fetchCachedEntity('objective', uuid, `/api/organisation-objectives/${uuid}/`, localToken);
    if (obj) objectives.push({ uuid, ...obj });
  }
  console.log(`[Chain] Fetched ${objectives.length} objectives`);

  // 3. Fetch frameworks
  const frameworks = [];
  for (const uuid of frameworkUuids) {
    const fw = await fetchCachedEntity('framework', uuid, `/api/frameworks/${uuid}/`, localToken);
    if (fw) frameworks.push({ uuid, ...fw });
  }
  console.log(`[Chain] Fetched ${frameworks.length} frameworks`);

  // 4. For each framework, fetch requirement nodes
  const fwRequirements = new Map(); // framework_uuid → [requirement nodes]
  for (const fw of frameworks) {
    const reqs = await fetchPaginatedList(`/api/requirement-nodes/?framework=${fw.uuid}&page_size=500`, localToken);
    cacheEntities('requirement', reqs);
    // Only keep assessable (leaf) requirements
    const assessable = reqs.filter(r => r.assessable !== false);
    fwRequirements.set(fw.uuid, assessable);
    console.log(`[Chain] Framework "${fw.name}": ${assessable.length} assessable requirements (${reqs.length} total)`);
  }

  // 5. For each framework, fetch compliance assessments — AUTO-CREATE if none exist (Gap 2)
  const fwComplianceAssessments = new Map(); // framework_uuid → [compliance assessments]
  for (const fw of frameworks) {
    let cas = await fetchPaginatedList(`/api/compliance-assessments/?framework=${fw.uuid}&page_size=100`, localToken);
    cacheEntities('compliance_assessment', cas);

    // GAP 2 FIX: Auto-create a compliance assessment if none exists for this framework
    if (cas.length === 0) {
      console.log(`[Chain] No compliance assessment found for "${fw.name}" — auto-creating one...`);
      try {
        const caName = `Auto-Assessment: ${fw.name || fw.ref_id || fw.uuid}`;
        const createRes = await grcFetch(`${GRC_API_URL}/api/compliance-assessments/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: caName,
            framework: fw.uuid,
            description: `Auto-created by chain resolver for framework: ${fw.name || fw.uuid}`,
          })
        }, localToken);

        if (createRes.ok) {
          const newCA = await createRes.json();
          console.log(`[Chain] Auto-created compliance assessment: ${newCA.id} ("${caName}")`);
          cacheEntities('compliance_assessment', [newCA]);
          cas = [newCA];
        } else {
          const errText = await createRes.text().catch(() => '');
          console.warn(`[Chain] Failed to auto-create CA for "${fw.name}": ${createRes.status} ${errText}`);
        }
      } catch (caErr) {
        console.warn(`[Chain] Error auto-creating CA for "${fw.name}":`, caErr.message);
      }
    }

    fwComplianceAssessments.set(fw.uuid, cas);
    console.log(`[Chain] Framework "${fw.name}": ${cas.length} compliance assessment(s)`);
  }

  // 6. For each compliance assessment, fetch requirement assessments (+ their linked controls)
  //    Force fresh fetch (skip cache) to pick up any recently-linked controls
  const reqToRA = new Map(); // requirement_uuid → { ra, caUuid }
  for (const [fwUuid, cas] of fwComplianceAssessments) {
    for (const ca of cas) {
      const caId = ca.id || ca.uuid;
      const ras = await fetchPaginatedList(`/api/requirement-assessments/?compliance_assessment=${caId}&page_size=1000`, localToken);
      cacheEntities('requirement_assessment', ras);
      let raWithControls = 0;
      for (const ra of ras) {
        const reqId = typeof ra.requirement === 'string' ? ra.requirement : (ra.requirement?.id || '');
        if (reqId) {
          reqToRA.set(reqId, { ra, caUuid: caId });
          const acCount = Array.isArray(ra.applied_controls) ? ra.applied_controls.length : 0;
          if (acCount > 0) raWithControls++;
        }
      }
      console.log(`[Chain] CA "${ca.name || caId}": ${ras.length} requirement assessments (${raWithControls} have controls)`);
    }
  }

  // 7. Fetch risk scenarios
  const riskScenarios = [];
  for (const uuid of riskUuids) {
    const rs = await fetchCachedEntity('risk_scenario', uuid, `/api/risk-scenarios/${uuid}/`, localToken);
    if (rs) riskScenarios.push({ uuid, ...rs });
  }
  console.log(`[Chain] Fetched ${riskScenarios.length} risk scenarios`);

  // 8. Build risk → controls mapping from risk scenario data
  const riskToControls = new Map(); // risk_uuid → [control_uuids]
  for (const rs of riskScenarios) {
    const linkedControls = Array.isArray(rs.applied_controls) ? rs.applied_controls.map(ac =>
      typeof ac === 'string' ? ac : (ac?.id || ac?.uuid || '')
    ).filter(Boolean) : [];
    riskToControls.set(rs.uuid, linkedControls);
  }

  // 9. Fetch and cache applied controls
  const allControlUuids = new Set([...controlUuids]);
  // Add controls from risk scenarios
  for (const ctrls of riskToControls.values()) ctrls.forEach(c => allControlUuids.add(c));
  // Add controls from requirement assessments
  for (const { ra } of reqToRA.values()) {
    const raControls = Array.isArray(ra.applied_controls) ? ra.applied_controls.map(ac =>
      typeof ac === 'string' ? ac : (ac?.id || ac?.uuid || '')
    ).filter(Boolean) : [];
    raControls.forEach(c => allControlUuids.add(c));
  }

  for (const uuid of allControlUuids) {
    await fetchCachedEntity('applied_control', uuid, `/api/applied-controls/${uuid}/`, localToken);
  }
  console.log(`[Chain] Cached ${allControlUuids.size} applied controls`);

  // 10. Build reverse mapping: control → [risk_uuids] for quick lookup
  const controlToRisks = new Map();
  for (const [riskUuid, ctrls] of riskToControls) {
    for (const c of ctrls) {
      if (!controlToRisks.has(c)) controlToRisks.set(c, []);
      controlToRisks.get(c).push(riskUuid);
    }
  }

  // 10b. Build requirement → control mapping from Controls Studio sessions
  //      This bridges the gap when controls were generated but RA linkage hasn't propagated yet
  const csReqToControls = new Map(); // requirement_uuid → [control_uuid]
  try {
    const csSessions = db.prepare(
      `SELECT controls, grc_export_result FROM cs_sessions WHERE org_context_id = ? ORDER BY updated_at DESC LIMIT 5`
    ).all(orgContextId);
    for (const sess of csSessions) {
      const ctrls = JSON.parse(sess.controls || '[]');
      const exportResult = JSON.parse(sess.grc_export_result || '{}');
      const exportedControls = exportResult.results || [];

      // Build name → grcId from export result
      const nameToGrcId = new Map();
      for (const ec of exportedControls) {
        if (ec.grcId && ec.name) nameToGrcId.set(ec.name.toLowerCase().trim(), ec.grcId);
      }

      for (const ctrl of ctrls) {
        // Get GRC UUID for this control
        let grcId = ctrl.grcId || null;
        if (!grcId && ctrl.name) grcId = nameToGrcId.get(ctrl.name.toLowerCase().trim()) || null;
        if (!grcId) continue;

        // Map each linked requirement → this control
        const linkedReqs = ctrl.linkedRequirements || [];
        for (const lr of linkedReqs) {
          const reqNodeId = lr.nodeId || '';
          if (!reqNodeId) continue;
          if (!csReqToControls.has(reqNodeId)) csReqToControls.set(reqNodeId, []);
          const list = csReqToControls.get(reqNodeId);
          if (!list.includes(grcId)) list.push(grcId);
          // Also ensure this control is in allControlUuids for caching
          allControlUuids.add(grcId);
        }
      }
    }
    if (csReqToControls.size > 0) {
      console.log(`[Chain] CS sessions: found ${csReqToControls.size} requirements mapped to controls`);
      // Fetch any new control UUIDs discovered
      for (const uuid of allControlUuids) {
        await fetchCachedEntity('applied_control', uuid, `/api/applied-controls/${uuid}/`, localToken);
      }
    }
  } catch (csErr) {
    console.warn('[Chain] Error reading CS sessions for req→control mapping:', csErr.message);
  }

  // 11. Clear existing chain rows and build new ones
  dbDeleteChainByOrg.run(orgContextId);

  let chainCount = 0;
  const insertChain = db.transaction(() => {
    for (const fw of frameworks) {
      const reqs = fwRequirements.get(fw.uuid) || [];

      // GAP 1 FIX: Use objective_framework_map for targeted Objective ↔ Framework linking
      // Build list of objectives that map to this framework
      let fwObjectives = [];
      if (Object.keys(objFwMap).length > 0) {
        // User-defined mapping: only include objectives that explicitly map to this framework
        for (const [objUuid, fwUuids] of Object.entries(objFwMap)) {
          if (Array.isArray(fwUuids) && fwUuids.includes(fw.uuid)) {
            const obj = objectives.find(o => o.uuid === objUuid);
            if (obj) fwObjectives.push(obj);
          }
        }
        // If no mapping found for this framework, still create rows with null objective
        if (fwObjectives.length === 0) fwObjectives = [{ uuid: null }];
      } else {
        // No mapping defined: fall back to linking all objectives (cross-product)
        fwObjectives = objectives.length > 0 ? objectives : [{ uuid: null }];
      }

      for (const req of reqs) {
        const reqId = req.id || req.uuid;
        const raInfo = reqToRA.get(reqId);
        const caUuid = raInfo?.caUuid || null;
        const raUuid = raInfo ? (raInfo.ra.id || raInfo.ra.uuid || null) : null;

        // Get controls linked to this requirement assessment
        let raControls = raInfo && Array.isArray(raInfo.ra.applied_controls)
          ? raInfo.ra.applied_controls.map(ac => typeof ac === 'string' ? ac : (ac?.id || ac?.uuid || '')).filter(Boolean)
          : [];

        // Also check if any org-level controls mention this requirement via CS session data
        if (raControls.length === 0 && csReqToControls.size > 0) {
          const csCtrlIds = csReqToControls.get(reqId) || [];
          if (csCtrlIds.length > 0) raControls = csCtrlIds;
        }

        for (const obj of fwObjectives) {
          if (raControls.length > 0) {
            // Requirement HAS controls
            for (const ctrlUuid of raControls) {
              // Find risks linked to this specific control
              const ctrlRisks = controlToRisks.get(ctrlUuid) || [];

              if (ctrlRisks.length > 0) {
                for (const riskUuid of ctrlRisks) {
                  dbInsertChainRow.run(orgContextId, obj.uuid || null, fw.uuid, reqId, caUuid, raUuid, riskUuid, ctrlUuid);
                  chainCount++;
                }
              } else {
                // Control exists but no risk linked via it — include org-level risks
                if (riskScenarios.length > 0) {
                  for (const rs of riskScenarios) {
                    dbInsertChainRow.run(orgContextId, obj.uuid || null, fw.uuid, reqId, caUuid, raUuid, rs.uuid, ctrlUuid);
                    chainCount++;
                  }
                } else {
                  dbInsertChainRow.run(orgContextId, obj.uuid || null, fw.uuid, reqId, caUuid, raUuid, null, ctrlUuid);
                  chainCount++;
                }
              }
            }
          } else {
            // Requirement has NO controls — include org-level risks if any
            if (riskScenarios.length > 0) {
              for (const rs of riskScenarios) {
                dbInsertChainRow.run(orgContextId, obj.uuid || null, fw.uuid, reqId, caUuid, raUuid, rs.uuid, null);
                chainCount++;
              }
            } else {
              dbInsertChainRow.run(orgContextId, obj.uuid || null, fw.uuid, reqId, caUuid, raUuid, null, null);
              chainCount++;
            }
          }
        }
      }
    }
  });

  insertChain();
  console.log(`[Chain] Resolution complete: ${chainCount} chain rows inserted for ${orgContextId}`);

  return {
    orgContextId,
    objectives: objectives.length,
    frameworks: frameworks.length,
    requirements: [...fwRequirements.values()].reduce((sum, arr) => sum + arr.length, 0),
    riskScenarios: riskScenarios.length,
    appliedControls: allControlUuids.size,
    chainRows: chainCount,
  };
}

function orgContextToJSON(r) {
  return {
    id: r.id,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    sector: r.sector,
    sectorCustom: r.sector_custom || '',
    size: r.size,
    complianceMaturity: r.compliance_maturity || 1,
    regulatoryMandates: JSON.parse(r.regulatory_mandates || '[]'),
    governanceStructure: r.governance_structure || '',
    dataClassification: r.data_classification || '',
    geographicScope: r.geographic_scope || '',
    itInfrastructure: r.it_infrastructure || '',
    strategicObjectives: JSON.parse(r.strategic_objectives || '[]'),
    obligatoryFrameworks: JSON.parse(r.obligatory_frameworks || '[]'),
    policies: JSON.parse(r.policies || '[]'),
    trackingMetrics: JSON.parse(r.tracking_metrics || '[]'),
    riskScenarios: JSON.parse(r.risk_scenarios || '[]'),
    objectiveFrameworkMap: JSON.parse(r.objective_framework_map || '{}'),
    notes: r.notes,
    storeId: r.store_id || '',
    isActive: !!r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Controls Studio sessions DB helpers
const dbListCsSessions = db.prepare(`SELECT * FROM cs_sessions ORDER BY updated_at DESC`);
const dbGetCsSession = db.prepare(`SELECT * FROM cs_sessions WHERE id = ?`);
const dbInsertCsSession = db.prepare(`
  INSERT INTO cs_sessions (id, name, status, step, requirements, collections, selected_files, session_files, org_context, controls, framework, exported_control_ids, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const dbUpdateCsSession = db.prepare(`
  UPDATE cs_sessions SET name = ?, status = ?, step = ?, requirements = ?, collections = ?, selected_files = ?, session_files = ?, org_context = ?, controls = ?, framework = ?, exported_control_ids = ?, updated_at = ? WHERE id = ?
`);
const dbDeleteCsSession = db.prepare(`DELETE FROM cs_sessions WHERE id = ?`);

function csSessionToJSON(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    step: row.step,
    requirements: JSON.parse(row.requirements || '[]'),
    collections: JSON.parse(row.collections || '[]'),
    selectedFiles: JSON.parse(row.selected_files || '[]'),
    sessionFiles: JSON.parse(row.session_files || '[]'),
    orgContext: row.org_context ? JSON.parse(row.org_context) : null,
    controls: JSON.parse(row.controls || '[]'),
    framework: row.framework || '',
    exportedControlIds: JSON.parse(row.exported_control_ids || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Policy collections DB helpers
const dbListPolicyCollections = db.prepare(`SELECT * FROM policy_collections ORDER BY updated_at DESC`);
const dbGetPolicyCollection = db.prepare(`SELECT * FROM policy_collections WHERE id = ?`);
const dbInsertPolicyCollection = db.prepare(`
  INSERT INTO policy_collections (id, name, description, store_id, status, config, extraction_result, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const dbUpdatePolicyCollection = db.prepare(`
  UPDATE policy_collections SET name = ?, description = ?, status = ?, config = ?, extraction_result = ?, updated_at = ? WHERE id = ?
`);
const dbDeletePolicyCollection = db.prepare(`DELETE FROM policy_collections WHERE id = ?`);

// Policy files DB helpers
const dbListPolicyFiles = db.prepare(`SELECT * FROM policy_files WHERE collection_id = ? ORDER BY created_at ASC`);
const dbGetPolicyFile = db.prepare(`SELECT * FROM policy_files WHERE id = ?`);
const dbInsertPolicyFile = db.prepare(`
  INSERT INTO policy_files (id, collection_id, name, mime_type, size, local_path, store_doc_name, gemini_file_name, gemini_file_uri, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const dbUpdatePolicyFileGemini = db.prepare(`UPDATE policy_files SET gemini_file_name = ?, gemini_file_uri = ? WHERE id = ?`);
const dbUpdatePolicyFileStoreDoc = db.prepare(`UPDATE policy_files SET store_doc_name = ? WHERE id = ?`);
const dbUpdatePolicyCollectionStoreId = db.prepare(`UPDATE policy_collections SET store_id = ? WHERE id = ?`);
const dbDeletePolicyFile = db.prepare(`DELETE FROM policy_files WHERE id = ?`);
const dbDeletePolicyFilesForCollection = db.prepare(`DELETE FROM policy_files WHERE collection_id = ?`);

// Policy generation history DB helpers
const dbInsertGenHistory = db.prepare(`
  INSERT INTO policy_generation_history (id, collection_id, generation_type, status, config, summary, library_urn, controls_count, nodes_count, confidence_score, generation_time, source_file_count, error_message, extraction_data, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const dbUpdateGenHistoryStatus = db.prepare(`UPDATE policy_generation_history SET status = ?, library_urn = ?, error_message = ? WHERE id = ?`);
const dbUpdateGenHistoryExtraction = db.prepare(`
  UPDATE policy_generation_history
  SET extraction_data = ?, nodes_count = ?, controls_count = ?
  WHERE id = ? AND collection_id = ?
`);
const dbListGenHistory = db.prepare(`SELECT * FROM policy_generation_history WHERE collection_id = ? ORDER BY created_at DESC`);
const dbGetLatestGenHistory = db.prepare(`SELECT * FROM policy_generation_history WHERE collection_id = ? ORDER BY created_at DESC LIMIT 1`);
const dbGetGenHistoryById = db.prepare(`SELECT * FROM policy_generation_history WHERE id = ?`);

function mapGeminiDocToPolicyFile(doc) {
  const displayName = doc.displayName || doc.name || '';
  const docName = doc.name || '';
  const docId = docName.split('/').pop();
  const ext = displayName.split('.').pop().toLowerCase();
  const sizeBytes = parseInt(doc.sizeBytes || '0', 10);
  return {
    id: docId,
    documentName: docName,
    name: displayName,
    type: ext,
    state: doc.state || 'UNKNOWN',
    mimeType: doc.mimeType || '',
    sizeBytes,
    size: sizeBytes > 1024 * 1024 ? (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB' : (sizeBytes / 1024).toFixed(0) + ' KB',
    createTime: doc.createTime || '',
    updateTime: doc.updateTime || '',
  };
}

async function policyCollectionToJSON(row, apiKey, opts = {}) {
  const summaryOnly = opts.summaryOnly === true;
  const filesPageToken = typeof opts.filesPageToken === 'string' ? opts.filesPageToken : '';

  const storeId = row.store_id || '';
  let files = [];
  let fileCount = 0;
  let filesNextPageToken = '';

  if (storeId && apiKey) {
    try {
      const storeName = storeId.startsWith('fileSearchStores/') ? storeId : `fileSearchStores/${storeId}`;
      fileCount = await getCachedDocumentCount(storeName, apiKey);

      if (!summaryOnly) {
        const page = await listStoreDocumentsPage(storeName, apiKey, FILE_SEARCH_DOCUMENT_PAGE_SIZE_UI, filesPageToken);
        files = (page.documents || []).map(mapGeminiDocToPolicyFile);
        filesNextPageToken = page.nextPageToken || '';
      }
    } catch (err) {
      console.warn(`[Policy] Could not list docs for store ${storeId}:`, err.message);
    }
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    storeId,
    status: fileCount > 0 ? 'ready' : 'empty',
    config: JSON.parse(row.config || '{}'),
    extractionResult: row.extraction_result ? JSON.parse(row.extraction_result) : null,
    files,
    fileCount,
    filesNextPageToken: summaryOnly ? '' : filesNextPageToken,
    filesPageSize: summaryOnly ? undefined : FILE_SEARCH_DOCUMENT_PAGE_SIZE_UI,
    lastUpdated: new Date(row.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function piCloneJson(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/** Apply Policy Ingestion review edits from the approve/preview POST body onto a cloned extracted library (`libObjects` is extraction objects root). */
function mergePolicyIngestionFrontendEdits(libObjects, body, generationType) {
  if (!body || !libObjects) return;

  const editedPolicies = body.policies && body.policies.length ? body.policies : null;
  if ((generationType === 'controls' || generationType === 'both') && libObjects.reference_controls) {
    const refControls = libObjects.reference_controls;
    if (editedPolicies && refControls.length) {
      libObjects.reference_controls = refControls.map(rc => {
        const edited = editedPolicies.find(p =>
          (p.code || p.ref_id) === rc.ref_id || p.name === rc.name
        );
        if (edited) {
          return {
            ...rc,
            name: edited.name || rc.name,
            description: edited.description != null ? edited.description : rc.description,
            category: edited.category || rc.category,
            csf_function: edited.csfFunction || edited.csf_function || rc.csf_function,
          };
        }
        return rc;
      });
    }
  }

  const editedNodes = body.requirementNodes && body.requirementNodes.length ? body.requirementNodes : null;
  if (editedNodes && libObjects.framework && (generationType === 'framework' || generationType === 'both')) {
    const origNodes = libObjects.framework.requirement_nodes || [];
    libObjects.framework.requirement_nodes = editedNodes.map(ed => {
      const o = origNodes.find(x =>
        (ed.ref_id && x.ref_id === ed.ref_id) || (ed.urn && x.urn === ed.urn)
      ) || {};
      return {
        ...o,
        urn: ed.urn || o.urn,
        ref_id: ed.ref_id != null ? ed.ref_id : o.ref_id,
        name: ed.name != null ? ed.name : o.name,
        description: ed.description != null ? ed.description : (o.description ?? ''),
        assessable: ed.assessable != null ? !!ed.assessable : !!o.assessable,
        depth: ed.depth != null ? ed.depth : (o.depth || 1),
        parent_urn: ed.parent_urn !== undefined ? ed.parent_urn : o.parent_urn,
      };
    });
  }
}

/** Build the library upload object; mutates `result` (parsed extraction_result) when cloneResult is false so approve persists merged edits. */
function buildPolicyIngestionLibraryUploadPayload(row, body, cloneResult = false) {
  const result = cloneResult ? piCloneJson(JSON.parse(row.extraction_result || '{}')) : JSON.parse(row.extraction_result || '{}');
  const config = JSON.parse(row.config || '{}');
  const generationType = result.generationType || config.generationType || 'both';

  const extractedLibrary = result.extractedLibrary || {};
  const libObjects = extractedLibrary.objects || extractedLibrary;
  mergePolicyIngestionFrontendEdits(libObjects, body || {}, generationType);

  let uploadObjects = {};
  if (generationType === 'framework') {
    uploadObjects = { framework: libObjects.framework || {} };
  } else if (generationType === 'controls') {
    uploadObjects = { reference_controls: libObjects.reference_controls || [] };
  } else {
    uploadObjects = {};
    if (libObjects.framework) uploadObjects.framework = libObjects.framework;
    if (libObjects.reference_controls && libObjects.reference_controls.length > 0) {
      uploadObjects.reference_controls = libObjects.reference_controls;
    }
  }

  const libraryPayload = {
    urn: extractedLibrary.urn || `urn:${(config.provider || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}:risk:library:${(config.libraryName || row.name || 'policy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    locale: extractedLibrary.locale || config.language || 'en',
    ref_id: extractedLibrary.ref_id || (config.libraryName || row.name || 'policy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: extractedLibrary.name || config.libraryName || row.name,
    description: extractedLibrary.description || row.description || `AI-extracted ${generationType} library from ${result.sourceFileCount || 0} document(s).`,
    copyright: extractedLibrary.copyright || `© ${config.provider || 'Organization'} ${new Date().getFullYear()}`,
    version: extractedLibrary.version || 1,
    provider: extractedLibrary.provider || config.provider || '',
    packager: extractedLibrary.packager || 'wathba',
    objects: uploadObjects,
  };

  const filename = `${libraryPayload.ref_id || 'ai-policy-library'}.yaml`;
  return { libraryPayload, filename, generationType, result, libObjects, uploadObjects };
}

// Ensure policy-uploads directory exists
const POLICY_UPLOADS_DIR = path.join(__dirname, 'policy-uploads');
if (!fs.existsSync(POLICY_UPLOADS_DIR)) fs.mkdirSync(POLICY_UPLOADS_DIR, { recursive: true });

// Ensure collection-uploads directory exists (local copies of file-search files for viewing)
const COLLECTION_UPLOADS_DIR = path.join(__dirname, 'collection-uploads');
if (!fs.existsSync(COLLECTION_UPLOADS_DIR)) fs.mkdirSync(COLLECTION_UPLOADS_DIR, { recursive: true });

// Gemini SDK client + in-memory chat sessions (SDK ChatSession objects)
let genai = null;
const chatSessions = {};  // sessionId -> { chat: SDK ChatSession, systemPrompt: string }
const policyChats = {};   // sessionId -> { chat: SDK ChatSession, storeIds, history, createdAt }

// Load prompt templates from files (used as seed defaults)
const promptTemplatePath = path.join(__dirname, 'prompts', 'requirement-analyzer.txt');
let promptTemplate = '';

try {
  promptTemplate = fs.readFileSync(promptTemplatePath, 'utf-8');
} catch (error) {
  console.error('Error loading prompt template:', error.message);
  process.exit(1);
}

const chatPromptPath = path.join(__dirname, 'prompts', 'chat-auditor.txt');
let chatPromptFileContent = '';

try {
  chatPromptFileContent = fs.readFileSync(chatPromptPath, 'utf-8');
} catch (error) {
  console.warn('Chat prompt template not found.');
}

const controlsPromptPath = path.join(__dirname, 'prompts', 'controls-generator.txt');
let controlsPromptTemplate = '';

try {
  controlsPromptTemplate = fs.readFileSync(controlsPromptPath, 'utf-8');
} catch (error) {
  console.warn('Controls generator prompt template not found.');
}

const policyExtractorPath = path.join(__dirname, 'prompts', 'policy-extractor.txt');
let policyExtractorPrompt = '';

try {
  policyExtractorPrompt = fs.readFileSync(policyExtractorPath, 'utf-8');
} catch (error) {
  console.warn('Policy extractor prompt template not found.');
}

// Load the framework-extractor prompt (framework + requirement_nodes only)
const frameworkExtractorPath = path.join(__dirname, 'prompts', 'framework-extractor.txt');
let frameworkExtractorPrompt = '';
try {
  frameworkExtractorPrompt = fs.readFileSync(frameworkExtractorPath, 'utf-8');
} catch (error) {
  console.warn('Framework extractor prompt template not found.');
}

// Load the reference-controls-extractor prompt (controls only)
const refControlsExtractorPath = path.join(__dirname, 'prompts', 'reference-controls-extractor.txt');
let refControlsExtractorPrompt = '';
try {
  refControlsExtractorPrompt = fs.readFileSync(refControlsExtractorPath, 'utf-8');
} catch (error) {
  console.warn('Reference controls extractor prompt template not found.');
}

// Seed the chat-auditor prompt into the DB if not already present
const CHAT_AUDITOR_PROMPT_ID = 'local-chat-auditor';
const now = new Date().toISOString();
dbInsertLocalPrompt.run(
  CHAT_AUDITOR_PROMPT_ID,
  'chat_auditor',
  'Chat Auditor (Start Audit Session)',
  chatPromptFileContent || 'You are an expert compliance and governance auditor for the Wathbah Auditor platform.',
  now,
  now
);

// Seed the controls-generator prompt into the DB — always update to latest template
const CONTROLS_GENERATOR_PROMPT_ID = 'local-controls-generator';
dbInsertLocalPrompt.run(
  CONTROLS_GENERATOR_PROMPT_ID,
  'controls_generator',
  'Controls Generator (Applied Controls Studio)',
  controlsPromptTemplate || 'You are an expert GRC consultant who specializes in designing applied controls for regulatory frameworks.',
  now,
  now
);
// Force-update to latest prompt template (in case DB had older version)
if (controlsPromptTemplate) {
  dbUpdateLocalPrompt.run('Controls Generator (Applied Controls Studio)', controlsPromptTemplate, now, CONTROLS_GENERATOR_PROMPT_ID);
}

// Seed the policy-extractor prompt into the DB
const POLICY_EXTRACTOR_PROMPT_ID = 'local-policy-extractor';
dbInsertLocalPrompt.run(
  POLICY_EXTRACTOR_PROMPT_ID,
  'policy_extractor',
  'Policy Extractor (Policy Ingestion)',
  policyExtractorPrompt || 'You are a GRC policy extraction engine for the CISO Assistant platform.',
  now,
  now
);
if (policyExtractorPrompt) {
  dbUpdateLocalPrompt.run('Policy Extractor (Policy Ingestion)', policyExtractorPrompt, now, POLICY_EXTRACTOR_PROMPT_ID);
}

// Seed the framework-extractor prompt into the DB
const FRAMEWORK_EXTRACTOR_PROMPT_ID = 'local-framework-extractor';
dbInsertLocalPrompt.run(
  FRAMEWORK_EXTRACTOR_PROMPT_ID,
  'framework_extractor',
  'Framework Extractor (Policy Ingestion — Framework)',
  frameworkExtractorPrompt || 'You are a GRC framework extraction engine for the CISO Assistant platform.',
  now,
  now
);
if (frameworkExtractorPrompt) {
  dbUpdateLocalPrompt.run('Framework Extractor (Policy Ingestion — Framework)', frameworkExtractorPrompt, now, FRAMEWORK_EXTRACTOR_PROMPT_ID);
}

// Seed the reference-controls-extractor prompt into the DB
const REF_CONTROLS_EXTRACTOR_PROMPT_ID = 'local-ref-controls-extractor';
dbInsertLocalPrompt.run(
  REF_CONTROLS_EXTRACTOR_PROMPT_ID,
  'ref_controls_extractor',
  'Reference Controls Extractor (Policy Ingestion — Controls)',
  refControlsExtractorPrompt || 'You are a GRC reference controls extraction engine for the CISO Assistant platform.',
  now,
  now
);
if (refControlsExtractorPrompt) {
  dbUpdateLocalPrompt.run('Reference Controls Extractor (Policy Ingestion — Controls)', refControlsExtractorPrompt, now, REF_CONTROLS_EXTRACTOR_PROMPT_ID);
}

// Helper: get the current policy extractor prompt from DB
function getPolicyExtractorPrompt() {
  const row = dbGetLocalPromptByKey.get('policy_extractor');
  return row ? row.content : policyExtractorPrompt || 'You are a GRC policy extraction engine for the CISO Assistant platform.';
}

// Helper: get the framework extractor prompt from DB
function getFrameworkExtractorPrompt() {
  const row = dbGetLocalPromptByKey.get('framework_extractor');
  return row ? row.content : frameworkExtractorPrompt || 'You are a GRC framework extraction engine for the CISO Assistant platform.';
}

// Helper: get the reference controls extractor prompt from DB
function getRefControlsExtractorPrompt() {
  const row = dbGetLocalPromptByKey.get('ref_controls_extractor');
  return row ? row.content : refControlsExtractorPrompt || 'You are a GRC reference controls extraction engine for the CISO Assistant platform.';
}

// Helper: get the current chat auditor prompt from DB (always use DB as source of truth)
function getChatAuditorPrompt() {
  const row = dbGetLocalPromptByKey.get('chat_auditor');
  return row ? row.content : (chatPromptFileContent || 'You are an expert compliance and governance auditor for the Wathbah Auditor platform.');
}

// Helper: get the current controls generator prompt from DB (always use DB as source of truth)
function getControlsGeneratorPrompt() {
  const row = dbGetLocalPromptByKey.get('controls_generator');
  return row ? row.content : (controlsPromptTemplate || 'You are an expert GRC consultant who specializes in designing applied controls for regulatory frameworks.');
}

// MIME types for static files
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Safe JSON response helper — handles Unicode (Arabic, etc.) without ByteString errors
function sendJSON(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  const buf = Buffer.from(jsonStr, 'utf-8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

// Parse JSON body from request
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_SIZE = 150 * 1024 * 1024; // 150MB limit for base64 file uploads

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        reject(new Error('Request body too large (max 150MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ─── Data Studio: Excel row → GRC applied control fields ─────────────

function dsFirstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

function dsBuildDescriptionFromRow(o) {
  const lines = [];
  const persp = [dsFirstString(o, ['كود المنظور']), dsFirstString(o, ['اسم المنظور'])].filter(Boolean).join(' — ');
  if (persp) lines.push(`المنظور: ${persp}`);
  const axis = [dsFirstString(o, ['كود المحور']), dsFirstString(o, ['اسم المحور'])].filter(Boolean).join(' — ');
  if (axis) lines.push(`المحور: ${axis}`);
  const std = [dsFirstString(o, ['كود المعيار']), dsFirstString(o, ['اسم المعيار'])].filter(Boolean).join(' — ');
  if (std) lines.push(`المعيار: ${std}`);
  const reqText = dsFirstString(o, ['نص المتطلب بحسب وثيقة هيئة الحكومة الرقمية', 'description', 'Requirement text']);
  if (reqText) lines.push(reqText);
  return lines.join('\n\n').trim();
}

function dsNormalizeImportRow(raw) {
  const refRaw = dsFirstString(raw, ['كود المتطلب', 'ref_id', 'Ref ID', 'requirement_ref']);
  const ref_id = refRaw ? dsNormalizeRefId(refRaw) : '';
  const name = dsFirstString(raw, ['اسم الكنترول', 'name', 'Name', 'control_name']);
  let description = dsFirstString(raw, ['description', 'Description', 'full_description']);
  if (!description) description = dsBuildDescriptionFromRow(raw);
  return { ref_id, name, description };
}

/** Normalize requirement ref_id for comparison (trim + Unicode NFKC). */
function dsNormalizeRefId(s) {
  if (s == null || s === '') return '';
  return String(s).trim().normalize('NFKC');
}

/** Hyphen / dot comparable form for cross-checking Excel vs GRC refs. */
function dsComparableRefId(s) {
  if (s == null || s === '') return '';
  let t = String(s).trim().normalize('NFKC').replace(/\u2212/g, '-');
  t = t.replace(/\s+/g, '').replace(/-/g, '.');
  return t;
}

/** Aliases so e.g. 4-8 and 4.8 can match when the framework uses one form in SQL and another in Excel. */
function dsRefIdAliasKeys(ref) {
  const base = dsNormalizeRefId(ref);
  if (!base) return [];
  const out = new Set([base, base.toLowerCase()]);
  out.add(base.replace(/−/g, '-'));
  out.add(base.replace(/\s+/g, ''));
  const dotsToHyphens = base.replace(/\./g, '-');
  const hypsToDots = base.replace(/-/g, '.');
  if (dotsToHyphens !== base) out.add(dotsToHyphens);
  if (hypsToDots !== base) out.add(hypsToDots);
  return [...out].filter(Boolean);
}

/**
 * Qyias / MHRSD: sheet rows may use 4+ numeric segments (e.g. 5.1.1.1) while the assessable
 * framework node is 3 levels (5.1.1). Hyphen forms (5-1-1-1) are normalized to the same walk.
 */
function dsNumericDottedParentPrefixes(ref) {
  const k = dsNormalizeRefId(ref);
  if (!k) return [];
  const unified = k.replace(/\u2212/g, '-').replace(/-/g, '.');
  const parts = unified.split('.').filter(Boolean);
  if (parts.length < 2) return [];
  if (!parts.every(p => /^\d+$/.test(p))) return [];
  const out = [];
  for (let len = parts.length - 1; len >= 1; len--) {
    const prefix = parts.slice(0, len).join('.');
    if (prefix) out.push(prefix);
  }
  return out;
}

function dsRollUpUnknownRefsEnabled(ctx) {
  return !ctx || ctx.rollUpUnknownRefs !== false;
}

/**
 * First non-empty RA list for a single normalized ref key (aliases + dot/hyphen comparable scan).
 * @param {string} candidateNormalized
 * @param {Map<string, object[]>} refToRas
 * @returns {object[]|null}
 */
function dsLookupRaListForNormalizedRef(candidateNormalized, refToRas) {
  if (!candidateNormalized || !refToRas || refToRas.size === 0) return null;
  for (const alias of dsRefIdAliasKeys(candidateNormalized)) {
    const list = refToRas.get(alias);
    if (list && list.length) return list;
  }
  const comp = dsComparableRefId(candidateNormalized);
  if (!comp) return null;
  for (const key of refToRas.keys()) {
    if (dsComparableRefId(key) !== comp) continue;
    const list = refToRas.get(key) || [];
    if (list.length) return list;
  }
  return null;
}

function dsAddRaToRefMap(refToRas, refKey, ra) {
  const raId = ra.id || ra.uuid;
  for (const alias of dsRefIdAliasKeys(refKey)) {
    if (!refToRas.has(alias)) refToRas.set(alias, []);
    const list = refToRas.get(alias);
    if (!list.some(r => (r.id || r.uuid) === raId)) list.push(ra);
  }
}

/**
 * Pick requirement assessment id(s) for a row ref from dsBuildRefIdToRasMap output.
 * Matches export/link logic when GET ?requirement__ref_id= is incomplete on some GRC builds.
 */
function dsRaIdsFromSheetRef(rowRef, refToRas, linkErrors, ctx) {
  if (!rowRef || !refToRas || refToRas.size === 0) return [];
  const k = dsNormalizeRefId(rowRef);
  if (!k) return [];
  const rollUp = dsRollUpUnknownRefsEnabled(ctx);
  const candidates = rollUp ? [k, ...dsNumericDottedParentPrefixes(k)] : [k];
  const seenCand = new Set();
  for (const cand of candidates) {
    if (!cand || seenCand.has(cand)) continue;
    seenCand.add(cand);
    const list = dsLookupRaListForNormalizedRef(cand, refToRas);
    if (!list || !list.length) continue;
    const ids = [...new Set(list.map(ra => String(ra.id || ra.uuid || '').trim()).filter(Boolean))].sort();
    if (!ids.length) continue;
    if (cand !== k && linkErrors) {
      linkErrors.push({
        ...ctx,
        step: 'ref_roll_up',
        warning: `Sheet ref "${k}" linked to requirement assessment for parent "${cand}" (Qyias 3-level roll-up).`,
      });
    }
    if (ids.length > 1 && linkErrors) {
      linkErrors.push({
        ...ctx,
        error: `Multiple requirement assessments (${ids.length}) for ref "${cand}" in this audit — linking first (${ids[0]}).`,
      });
    }
    return [ids[0]];
  }
  return [];
}

function dsFirstRaForSheetRef(rowRef, refToRas, ctx) {
  if (!rowRef || !refToRas || refToRas.size === 0) return null;
  const k = dsNormalizeRefId(rowRef);
  if (!k) return null;
  const rollUp = dsRollUpUnknownRefsEnabled(ctx);
  const candidates = rollUp ? [k, ...dsNumericDottedParentPrefixes(k)] : [k];
  const seenCand = new Set();
  for (const cand of candidates) {
    if (!cand || seenCand.has(cand)) continue;
    seenCand.add(cand);
    const list = dsLookupRaListForNormalizedRef(cand, refToRas);
    if (list && list.length) return list[0];
  }
  return null;
}

/** Framework requirement node UUID for a workbook ref (from an existing RA row in the audit). */
function dsRequirementUuidFromSheetRef(rowRef, refToRas, ctx) {
  const ra = dsFirstRaForSheetRef(rowRef, refToRas, ctx);
  return ra ? dsRequirementUuidFromRa(ra) : '';
}

/** Count rows whose كود المتطلب hits the audit map by alias key or comparable (dot/hyphen) form. */
function dsCountSheetRowsMatchingAuditRefs(rows, refToRas) {
  if (!refToRas || refToRas.size === 0) return 0;
  let n = 0;
  for (const row of rows) {
    const k = dsNormalizeRefId(row.ref_id);
    if (!k) continue;
    const candidates = [k, ...dsNumericDottedParentPrefixes(k)];
    const seenCand = new Set();
    let hit = false;
    for (const cand of candidates) {
      if (!cand || seenCand.has(cand)) continue;
      seenCand.add(cand);
      const list = dsLookupRaListForNormalizedRef(cand, refToRas);
      if (list && list.length) {
        hit = true;
        break;
      }
    }
    if (hit) n++;
  }
  return n;
}

function dsRequirementUuidFromRa(ra) {
  const req = ra && ra.requirement;
  if (!req) return '';
  if (typeof req === 'string') return req.trim();
  if (typeof req === 'object') return String(req.id || req.uuid || '').trim();
  return '';
}

function dsEmbeddedRequirementRefId(ra) {
  const req = ra && ra.requirement;
  if (req && typeof req === 'object') {
    return dsNormalizeRefId(req.ref_id || req.refId || '');
  }
  return '';
}

/** Ref used to match Excel rows — API list/detail may expose it on the RA instead of nested `requirement`. */
function dsRefIdFromRequirementAssessment(ra) {
  if (!ra || typeof ra !== 'object') return '';
  const top = dsNormalizeRefId(
    ra.requirement_ref_id ?? ra.requirement_ref ?? ra.requirementRefId ?? ''
  );
  if (top) return top;
  const emb = dsEmbeddedRequirementRefId(ra);
  if (emb) return emb;
  return dsNormalizeRefId(ra.ref_id || ra.refId || '');
}

async function dsFetchAllRequirementAssessmentsForCA(caId, grcUrl, reqToken, res) {
  let allRAs = [];
  let raUrl = `${grcUrl}/api/requirement-assessments/?compliance_assessment=${encodeURIComponent(caId)}&page_size=500`;
  while (raUrl) {
    const raRes = await grcFetch(raUrl, {}, reqToken);
    if (!raRes.ok) {
      if (res && (await finalizeGrcUpstreamError(res, reqToken, raRes))) return null;
      const t = await raRes.text();
      throw new Error(`Failed to list requirement assessments: ${raRes.status} ${t.slice(0, 300)}`);
    }
    const raData = await raRes.json();
    allRAs = allRAs.concat(Array.isArray(raData.results) ? raData.results : []);
    raUrl = raData.next || null;
  }
  return allRAs;
}

/** Paginated list of compliance assessments (audits). Returns null if GRC auth failed and response was finalized. */
async function dsFetchAllComplianceAssessments(grcUrl, reqToken, res) {
  let all = [];
  let nextUrl = `${grcUrl}/api/compliance-assessments/?page_size=500`;
  while (nextUrl) {
    const r = await grcFetch(nextUrl, {}, reqToken);
    if (!r.ok) {
      if (res && (await finalizeGrcUpstreamError(res, reqToken, r))) return null;
      const t = await r.text();
      throw new Error(`Failed to list compliance assessments: ${r.status} ${t.slice(0, 240)}`);
    }
    const d = await r.json();
    all = all.concat(Array.isArray(d.results) ? d.results : []);
    nextUrl = d.next || null;
  }
  return all;
}

/**
 * Pick the compliance assessment whose requirement assessments best match row ref_ids (كود المتطلب).
 * Full overlap short-circuits the scan. Returns null if GRC auth aborts mid-flight.
 */
async function dsPickComplianceAssessmentForRows(rows, grcUrl, reqToken, res) {
  const rowsWithRef = rows.filter(r => dsNormalizeRefId(r.ref_id));
  if (!rowsWithRef.length) {
    return {
      caId: null,
      caName: null,
      allRAs: [],
      built: null,
      score: 0,
      rowsWithRef: 0,
    };
  }
  const cas = await dsFetchAllComplianceAssessments(grcUrl, reqToken, res);
  if (cas === null) return null;

  let best = { caId: null, caName: null, score: -1, allRAs: [], built: null };
  const target = rowsWithRef.length;

  for (const ca of cas) {
    const caId = ca.id || ca.uuid;
    if (!caId) continue;
    const allRAs = await dsFetchAllRequirementAssessmentsForCA(caId, grcUrl, reqToken, res);
    if (allRAs === null) return null;
    if (!allRAs.length) continue;
    const built = await dsBuildRefIdToRAsMap(allRAs, grcUrl, reqToken, res);
    if (built === null) return null;
    const score = dsCountSheetRowsMatchingAuditRefs(rows, built.refToRas);
    if (score > best.score) {
      best = {
        caId,
        caName: ca.name || ca.basename || String(caId),
        score,
        allRAs,
        built,
      };
    }
    if (score === target) {
      console.log(`[DataStudio] Auto-picked compliance assessment "${best.caName}" (${best.caId}) — full overlap ${score}/${target}`);
      break;
    }
  }

  return { ...best, rowsWithRef: target };
}

/** Paginated list of frameworks. Returns null if GRC auth aborts mid-flight. */
async function dsFetchAllFrameworks(grcUrl, reqToken, res) {
  let all = [];
  let nextUrl = `${grcUrl}/api/frameworks/?page_size=200`;
  while (nextUrl) {
    const r = await grcFetch(nextUrl, {}, reqToken);
    if (!r.ok) {
      if (res && (await finalizeGrcUpstreamError(res, reqToken, r))) return null;
      const t = await r.text();
      throw new Error(`Failed to list frameworks: ${r.status} ${t.slice(0, 240)}`);
    }
    const d = await r.json();
    all = all.concat(Array.isArray(d.results) ? d.results : []);
    nextUrl = d.next || null;
  }
  return all;
}

/** Distinct normalized ref_ids of every assessable requirement node in a framework. */
async function dsFetchFrameworkRequirementRefIds(frameworkId, grcUrl, reqToken, res) {
  const refs = new Set();
  let nextUrl = `${grcUrl}/api/requirement-nodes/?framework=${encodeURIComponent(frameworkId)}&page_size=500`;
  while (nextUrl) {
    const r = await grcFetch(nextUrl, {}, reqToken);
    if (!r.ok) {
      if (res && (await finalizeGrcUpstreamError(res, reqToken, r))) return null;
      const t = await r.text();
      throw new Error(`Failed to list requirement-nodes for framework ${frameworkId}: ${r.status} ${t.slice(0, 240)}`);
    }
    const d = await r.json();
    for (const node of Array.isArray(d.results) ? d.results : []) {
      const ref = dsNormalizeRefId(node.ref_id || node.refId || '');
      if (ref) refs.add(ref);
    }
    nextUrl = d.next || null;
  }
  return refs;
}

/** Count sheet rows whose ref_id (alias / comparable form) appears in the framework's requirement node ref_id set. */
function dsCountSheetRowsMatchingFrameworkRefs(rows, frameworkRefSet) {
  if (!frameworkRefSet || frameworkRefSet.size === 0) return 0;
  const compSet = new Set();
  for (const k of frameworkRefSet) {
    const c = dsComparableRefId(k);
    if (c) compSet.add(c);
  }
  let n = 0;
  for (const row of rows) {
    const k = dsNormalizeRefId(row.ref_id);
    if (!k) continue;
    const candidates = [k, ...dsNumericDottedParentPrefixes(k)];
    const seenCand = new Set();
    let hit = false;
    for (const cand of candidates) {
      if (!cand || seenCand.has(cand)) continue;
      seenCand.add(cand);
      if (dsRefIdAliasKeys(cand).some(alias => frameworkRefSet.has(alias))) {
        hit = true;
        break;
      }
      const rc = dsComparableRefId(cand);
      if (rc && compSet.has(rc)) {
        hit = true;
        break;
      }
    }
    if (hit) n++;
  }
  return n;
}

/**
 * Pick the GRC framework whose requirement nodes best match the sheet's ref_ids.
 * Used as a fallback when no compliance assessment exists yet — we then auto-create
 * a CA from the best framework so STEP 2 has somewhere to PATCH.
 * Returns null only if GRC auth aborted mid-flight.
 */
async function dsPickFrameworkForRows(rows, grcUrl, reqToken, res) {
  const rowsWithRef = rows.filter(r => dsNormalizeRefId(r.ref_id));
  if (!rowsWithRef.length) {
    return { framework: null, score: 0, rowsWithRef: 0 };
  }
  const fws = await dsFetchAllFrameworks(grcUrl, reqToken, res);
  if (fws === null) return null;

  let best = { framework: null, score: -1 };
  const target = rowsWithRef.length;
  for (const fw of fws) {
    const fwId = fw.id || fw.uuid;
    if (!fwId) continue;
    const refs = await dsFetchFrameworkRequirementRefIds(fwId, grcUrl, reqToken, res);
    if (refs === null) return null;
    if (!refs.size) continue;
    const score = dsCountSheetRowsMatchingFrameworkRefs(rows, refs);
    if (score > best.score) {
      best = { framework: fw, score };
    }
    if (score === target) {
      console.log(
        `[DataStudio] Framework auto-pick: full overlap ${score}/${target} on "${fw.name || fw.ref_id || fwId}" — short-circuit.`
      );
      break;
    }
  }
  return { ...best, rowsWithRef: target };
}

/**
 * Look up a perimeter UUID for a CA POST. CISO Assistant requires perimeter on
 * /api/compliance-assessments/. Strategy:
 *   1) If folder given, try /api/perimeters/?folder=<folder>
 *   2) Fallback to /api/perimeters/?folder__id=<folder>
 *   3) Fallback to first perimeter on the instance
 * Returns '' if none could be found, or null if GRC auth aborted mid-flight.
 */
async function dsFindPerimeterForFolder(folderId, grcUrl, reqToken, res) {
  const tryUrls = [];
  if (folderId) {
    tryUrls.push(`${grcUrl}/api/perimeters/?folder=${encodeURIComponent(folderId)}&page_size=20`);
    tryUrls.push(`${grcUrl}/api/perimeters/?folder__id=${encodeURIComponent(folderId)}&page_size=20`);
  }
  tryUrls.push(`${grcUrl}/api/perimeters/?page_size=20`);

  for (const u of tryUrls) {
    const r = await grcFetch(u, {}, reqToken);
    if (!r.ok) {
      if (res && (await finalizeGrcUpstreamError(res, reqToken, r))) return null;
      continue;
    }
    const d = await r.json();
    const list = Array.isArray(d.results) ? d.results : [];
    if (list.length) {
      const id = String(list[0].id || list[0].uuid || '').trim();
      if (id) return id;
    }
  }
  return '';
}

/**
 * Create a compliance assessment from a framework via GRC API. Tries several body shapes
 * to absorb schema differences between CISO Assistant versions: perimeter is required in
 * recent versions (per the curl in the conversation), version + status are also typical.
 * Returns the created CA object or null on failure (after pushing an error string into linkErrors).
 */
async function dsCreateComplianceAssessmentForFramework({
  framework,
  folder,
  perimeter,
  name,
  description,
  version,
  status,
  grcUrl,
  reqToken,
  res,
  linkErrors,
}) {
  const fwId = framework.id || framework.uuid;
  if (!fwId) return null;
  const fwName = framework.name || framework.ref_id || fwId;
  const auditName = name || `${fwName} – Controls Catalog`;
  const auditDesc =
    description ||
    'Auto-created by Data Studio import — host audit so requirement-assessments can be PATCHed with imported applied controls.';
  const auditVersion = version || '1.0';
  const auditStatus = status || 'in_progress';

  let perimeterId = perimeter && typeof perimeter === 'string' ? perimeter.trim() : '';
  if (!perimeterId) {
    const found = await dsFindPerimeterForFolder(folder || '', grcUrl, reqToken, res);
    if (found === null) return null; // auth aborted
    perimeterId = found;
    if (perimeterId) {
      console.log(`[DataStudio] Auto-discovered perimeter ${perimeterId} for new audit.`);
    } else {
      console.warn('[DataStudio] No perimeter found in GRC — POST will likely fail. Provide body.perimeter or create a perimeter in GRC.');
    }
  }

  // Body variants from richest to leanest. The first that GRC accepts wins.
  // Mirror of the curl you supplied: { name, framework, perimeter, version, status }.
  const tryBodies = [];
  if (perimeterId) {
    tryBodies.push({
      name: auditName,
      framework: fwId,
      perimeter: perimeterId,
      version: auditVersion,
      status: auditStatus,
      description: auditDesc,
      ...(folder ? { folder } : {}),
    });
    tryBodies.push({
      name: auditName,
      framework: fwId,
      perimeter: perimeterId,
      version: auditVersion,
      status: auditStatus,
      description: auditDesc,
    });
    tryBodies.push({
      name: auditName,
      framework: fwId,
      perimeter: perimeterId,
      description: auditDesc,
    });
  }
  // Last-resort attempts without perimeter (older CISO Assistant where it was optional).
  tryBodies.push({
    name: auditName,
    framework: fwId,
    version: auditVersion,
    status: auditStatus,
    description: auditDesc,
    ...(folder ? { folder } : {}),
  });
  tryBodies.push({ name: auditName, framework: fwId, description: auditDesc });

  let lastErr = '';
  let lastStatus = 0;
  for (let i = 0; i < tryBodies.length; i++) {
    const grcRes = await grcFetch(`${grcUrl}/api/compliance-assessments/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tryBodies[i]),
    }, reqToken);
    if (grcRes.ok) {
      const newCA = await grcRes.json();
      console.log(
        `[DataStudio] Auto-created compliance assessment "${auditName}" → ${newCA.id || newCA.uuid} (framework ${fwName} / ${fwId}; perimeter ${perimeterId || '(none)'}; attempt ${i + 1}/${tryBodies.length})`
      );
      return newCA;
    }
    if (res && (await finalizeGrcUpstreamError(res, reqToken, grcRes))) return null;
    lastErr = await grcRes.text();
    lastStatus = grcRes.status;
    if (grcRes.status !== 400 || i + 1 >= tryBodies.length) {
      const msg = `Failed to auto-create compliance assessment for framework ${fwName} (${fwId}): ${grcRes.status} ${lastErr.slice(0, 400)}`;
      console.warn(`[DataStudio] ${msg}`);
      if (linkErrors) linkErrors.push({ step: 'auto_create_compliance_assessment', error: msg });
      return null;
    }
    console.warn(
      `[DataStudio] Auto-create CA attempt ${i + 1}/${tryBodies.length} failed with ${grcRes.status}, retrying with reduced body. GRC said: ${lastErr.slice(0, 200)}`
    );
  }
  if (linkErrors) {
    linkErrors.push({ step: 'auto_create_compliance_assessment', error: `exhausted body variants (last status ${lastStatus}): ${lastErr.slice(0, 300)}` });
  }
  return null;
}

/**
 * Build map: normalized requirement ref_id → [RA objects from list endpoint].
 * Fetches requirement-nodes when list view omits ref_id (common).
 */
async function dsBuildRefIdToRAsMap(allRAs, grcUrl, reqToken, res) {
  const fetchedRefByUuid = new Map();
  const uuidsNeedingFetch = new Set();

  for (const ra of allRAs) {
    const haveRef = dsRefIdFromRequirementAssessment(ra);
    const uuid = dsRequirementUuidFromRa(ra);
    if (!haveRef && uuid) uuidsNeedingFetch.add(uuid);
  }

  for (const uuid of uuidsNeedingFetch) {
    let ref = '';
    const tryUrls = [
      `${grcUrl}/api/requirement-nodes/${encodeURIComponent(uuid)}/`,
      `${grcUrl}/api/requirement-nodes/${encodeURIComponent(uuid)}`,
      `${grcUrl}/api/requirements/${encodeURIComponent(uuid)}/`,
      `${grcUrl}/api/requirements/${encodeURIComponent(uuid)}`,
    ];
    for (const u of tryUrls) {
      const r = await grcFetch(u, {}, reqToken);
      if (!r.ok) {
        if (res && (await finalizeGrcUpstreamError(res, reqToken, r))) return null;
        continue;
      }
      const node = await r.json();
      ref = dsNormalizeRefId(node.ref_id || node.refId || '');
      break;
    }
    if (!ref) {
      console.warn(`[DataStudio] No ref_id resolved for requirement UUID ${uuid}`);
    }
    fetchedRefByUuid.set(uuid, ref);
  }

  const refToRas = new Map();
  const canonical = new Set();
  for (const ra of allRAs) {
    const uuid = dsRequirementUuidFromRa(ra);
    let refKey = dsRefIdFromRequirementAssessment(ra);
    if (!refKey && uuid) refKey = fetchedRefByUuid.get(uuid) || '';
    if (!refKey) continue;
    canonical.add(refKey);
    dsAddRaToRefMap(refToRas, refKey, ra);
  }
  const auditRefIdSample = [...canonical].sort().slice(0, 40);
  return {
    refToRas,
    auditRefIdsDistinct: canonical.size,
    auditRefIdSample,
  };
}

/** Ensure AppliedControl.requirement_assessments includes all raIds (GRC UI reads this M2M). */
async function dsEnsureAppliedControlHasRequirementAssessments(controlId, raIds, grcUrl, reqToken, res, linkErrors, ctx) {
  if (!controlId || !raIds || !raIds.length) return { ok: true };
  const want = [...new Set(raIds.map(id => String(id)))];
  const url = `${grcUrl}/api/applied-controls/${encodeURIComponent(controlId)}/`;
  const acGet = await grcFetch(url, {}, reqToken);
  if (!acGet.ok) {
    const errIn = await consumeGrcErrorBody(res, reqToken, acGet);
    if (errIn.aborted) return { ok: false, aborted: true };
    linkErrors.push({
      ...ctx,
      step: 'ac_get_before_patch_requirement_assessments',
      error: (errIn.errText || '').slice(0, 400),
    });
    return { ok: false, aborted: false };
  }
  const d = await acGet.json();
  const existing = [];
  const raw =
    d.requirement_assessments ??
    d.requirement_assessment_set ??
    d.linked_requirement_assessments ??
    d.assessed_requirements;
  if (Array.isArray(raw)) {
    for (const x of raw) {
      const id = typeof x === 'object' && x && x !== null ? String(x.id || x.uuid || '') : String(x);
      if (id) existing.push(id);
    }
  }
  const need = want.filter(id => !existing.includes(id));
  if (!need.length) return { ok: true };
  const merged = [...new Set([...existing, ...want])];
  const tryBodies = [
    () => ({ requirement_assessments: merged }),
    () => ({ requirement_assessments: merged.map(id => ({ id })) }),
  ];
  let lastPe = '';
  for (let bi = 0; bi < tryBodies.length; bi++) {
    const acPatch = await grcFetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tryBodies[bi]()),
    }, reqToken);
    if (acPatch.ok) {
      console.log(
        `[DataStudio] PATCH applied-controls/${String(controlId).slice(0, 8)}… requirement_assessments → ${merged.length} id(s)`
      );
      return { ok: true };
    }
    if (res && (await finalizeGrcUpstreamError(res, reqToken, acPatch))) return { ok: false, aborted: true };
    lastPe = await acPatch.text();
    if (acPatch.status === 400 && bi + 1 < tryBodies.length) continue;
    linkErrors.push({ ...ctx, step: 'ac_patch_requirement_assessments', error: lastPe.slice(0, 500) });
    return { ok: false, aborted: false };
  }
  linkErrors.push({ ...ctx, step: 'ac_patch_requirement_assessments', error: lastPe.slice(0, 500) });
  return { ok: false, aborted: false };
}

/** Extract new requirement-assessment UUID from GRC 201 Location header when body omits id. */
function dsRaIdFromGrcRequirementAssessmentLocation(postRes) {
  try {
    const loc = postRes.headers.get('Location') || postRes.headers.get('location') || '';
    const m = loc.match(/requirement-assessments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?/i);
    if (m) return m[1];
    const tail = loc.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
    if (tail) return tail[1];
  } catch (_) { /* ignore */ }
  return '';
}

/**
 * Row-by-row step after POST /api/applied-controls/: (1) POST /api/requirement-assessments/ to attach requirement + control;
 * (2) if that fails, PATCH existing RA(s) (merge applied_controls) + PATCH applied control.
 * @returns {Promise<{ aborted?: boolean, linked: boolean, mode?: string, raId?: string }>}
 */
async function dsRowLinkAppliedControlToRequirement({
  controlId,
  complianceAssessmentId,
  rowRef,
  refToRasMap,
  grcUrl,
  reqToken,
  res,
  linkErrors,
  ctx,
  raControlsCache,
  preferPostFirst,
  raIndexedRefIds,
}) {
  const cid = String(controlId || '').trim();
  if (!cid || !complianceAssessmentId || !dsNormalizeRefId(rowRef)) {
    return { linked: false };
  }

  const patchExisting = async () => {
    let found = refToRasMap
      ? dsRaIdsFromSheetRef(rowRef, refToRasMap, linkErrors, ctx)
      : [];
    if (!found.length) {
      const apiFound = await dsFindRequirementAssessmentIdsForRef(
        complianceAssessmentId,
        rowRef,
        grcUrl,
        reqToken,
        res,
        linkErrors,
        ctx
      );
      if (apiFound === null) return { aborted: true };
      found = apiFound;
    }
    if (!found.length) {
      linkErrors.push({
        ...ctx,
        error: `No requirement assessment in this audit matches ref "${rowRef}" (indexed ${raIndexedRefIds || 0} refs; POST link not used or failed).`,
      });
      return { linked: false };
    }
    const raSideOk = await dsAppendAppliedControlToRequirementAssessments(
      cid, found, grcUrl, reqToken, res, linkErrors, ctx, raControlsCache
    );
    if (!raSideOk) return { aborted: true };
    const sync = await dsEnsureAppliedControlHasRequirementAssessments(
      cid, found, grcUrl, reqToken, res, linkErrors, ctx
    );
    if (sync.aborted) return { aborted: true };
    if (!sync.ok) return { linked: false, raId: found[0] || '' };
    return { linked: true, mode: 'patch_existing_ra', raId: found[0] || '' };
  };

  if (preferPostFirst !== false && refToRasMap && refToRasMap.size > 0) {
    const reqUuid = dsRequirementUuidFromSheetRef(rowRef, refToRasMap, ctx);
    if (reqUuid) {
      const postBody = {
        compliance_assessment: complianceAssessmentId,
        requirement: reqUuid,
        applied_controls: [cid],
        result: 'not_assessed',
        status: 'to_do',
      };
      const postRes = await grcFetch(`${grcUrl}/api/requirement-assessments/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      }, reqToken);
      if (postRes.ok) {
        let raId = dsRaIdFromGrcRequirementAssessmentLocation(postRes);
        try {
          const data = await postRes.json();
          const fromBody = String(data.id || data.uuid || '').trim();
          if (fromBody) raId = fromBody;
        } catch (_) { /* empty or non-JSON body */ }
        if (!raId && refToRasMap) {
          const resolved = dsRaIdsFromSheetRef(rowRef, refToRasMap, linkErrors, ctx);
          raId = resolved[0] || '';
        }
        if (raId) {
          const raSideOk = await dsAppendAppliedControlToRequirementAssessments(
            cid, [raId], grcUrl, reqToken, res, linkErrors, ctx, raControlsCache
          );
          if (!raSideOk) return { aborted: true };
          const sync = await dsEnsureAppliedControlHasRequirementAssessments(
            cid, [raId], grcUrl, reqToken, res, linkErrors, ctx
          );
          if (sync.aborted) return { aborted: true };
          if (!sync.ok) return { linked: false, raId };
          return { linked: true, mode: 'post_requirement_assessment', raId };
        }
        return patchExisting();
      }
      const errIn = await consumeGrcErrorBody(res, reqToken, postRes);
      if (errIn.aborted) return { aborted: true };
      linkErrors.push({
        ...ctx,
        step: 'ra_post_link',
        error: `POST /api/requirement-assessments/ (${postRes.status}): ${(errIn.errText || '').slice(0, 400)} — falling back to PATCH on existing RA.`,
      });
    }
  }

  return patchExisting();
}

/**
 * GRC UI and list views often surface M2M via RequirementAssessment.applied_controls.
 * Mirrors Phase 2 of /api/grc/applied-controls export — PATCH each RA with merged IDs.
 * @param {Map<string, string[]>} [raControlsCache] raId -> last known applied_control ids (avoids redundant GETs).
 */
async function dsAppendAppliedControlToRequirementAssessments(controlId, raIds, grcUrl, reqToken, res, linkErrors, ctx, raControlsCache) {
  const cid = String(controlId || '').trim();
  if (!cid || !raIds || !raIds.length) return true;
  const uniqueRa = [...new Set(raIds.map(id => String(id).trim()).filter(Boolean))];
  for (const raId of uniqueRa) {
    let existing = raControlsCache && raControlsCache.get(raId);
    if (!existing) {
      const raRes = await grcFetch(`${grcUrl}/api/requirement-assessments/${encodeURIComponent(raId)}/`, {}, reqToken);
      if (!raRes.ok) {
        if (res && (await finalizeGrcUpstreamError(res, reqToken, raRes))) return false;
        const t = await raRes.text();
        linkErrors.push({ ...ctx, raId, step: 'ra_get_applied_controls', error: t.slice(0, 400) });
        continue;
      }
      const d = await raRes.json();
      existing = [];
      const raw = d.applied_controls;
      if (Array.isArray(raw)) {
        for (const x of raw) {
          const id = typeof x === 'object' && x && x !== null ? String(x.id || x.uuid || '') : String(x);
          if (id) existing.push(id);
        }
      }
      if (raControlsCache) raControlsCache.set(raId, existing);
    }
    if (existing.includes(cid)) continue;
    const merged = [...new Set([...existing, cid])];
    const raBodies = [
      () => ({ applied_controls: merged }),
      () => ({ applied_controls: merged.map(id => ({ id })) }),
    ];
    let raPatched = false;
    let lastRaPe = '';
    for (let bi = 0; bi < raBodies.length; bi++) {
      const patchRes = await grcFetch(`${grcUrl}/api/requirement-assessments/${encodeURIComponent(raId)}/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(raBodies[bi]()),
      }, reqToken);
      if (patchRes.ok) {
        raPatched = true;
        break;
      }
      if (res && (await finalizeGrcUpstreamError(res, reqToken, patchRes))) return false;
      lastRaPe = await patchRes.text();
      if (patchRes.status === 400 && bi + 1 < raBodies.length) continue;
      linkErrors.push({ ...ctx, raId, step: 'ra_patch_applied_controls', error: lastRaPe.slice(0, 500) });
      break;
    }
    if (raPatched && raControlsCache) raControlsCache.set(raId, merged);
  }
  return true;
}

/**
 * Resolve requirement assessment UUID(s) for one row using GRC list filter:
 * GET /api/requirement-assessments/?compliance_assessment=&requirement__ref_id=
 * Tries normalized ref + alias variants (dots/hyphens).
 * @returns {Promise<string[]|null>} null only if GRC auth aborted; [] if no row; one id if found (first if several).
 */
async function dsFindRequirementAssessmentIdsForRef(caId, rowRef, grcUrl, reqToken, res, linkErrors, ctx) {
  const ref = dsNormalizeRefId(rowRef);
  if (!ref || !caId) return [];
  const rollUp = dsRollUpUnknownRefsEnabled(ctx);
  const candRefs = rollUp ? [ref, ...dsNumericDottedParentPrefixes(ref)] : [ref];
  const tryVals = [];
  const seenTry = new Set();
  for (const cand of candRefs) {
    if (!cand) continue;
    for (const v of [cand, ...dsRefIdAliasKeys(cand)]) {
      if (!v || seenTry.has(v)) continue;
      seenTry.add(v);
      tryVals.push(v);
      if (tryVals.length >= 40) break;
    }
    if (tryVals.length >= 40) break;
  }
  for (let ti = 0; ti < tryVals.length; ti++) {
    const r = tryVals[ti];
    const q = new URLSearchParams({
      compliance_assessment: String(caId),
      requirement__ref_id: r,
      page_size: '50',
    });
    const url = `${grcUrl}/api/requirement-assessments/?${q.toString()}`;
    const raRes = await grcFetch(url, {}, reqToken);
    if (!raRes.ok) {
      const errIn = await consumeGrcErrorBody(res, reqToken, raRes);
      if (errIn.aborted) return null;
      continue;
    }
    const data = await raRes.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) continue;
    const ids = [...new Set(results.map(ra => String(ra.id || ra.uuid || '')).filter(Boolean))].sort();
    if (!ids.length) continue;
    if (r !== ref && linkErrors) {
      linkErrors.push({
        ...ctx,
        step: 'ref_roll_up',
        warning: `Sheet ref "${ref}" resolved requirement__ref_id="${r}" via parent prefix (Qyias 3-level roll-up).`,
      });
    }
    if (ids.length > 1 && linkErrors) {
      linkErrors.push({
        ...ctx,
        error: `Multiple requirement assessments (${ids.length}) for ref "${r}" in this audit — linking first (${ids[0]}).`,
      });
    }
    return [ids[0]];
  }
  return [];
}

function dsAppliedControlRefFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  return dsNormalizeRefId(item.ref_id || item.refId || '');
}

function dsAppliedControlFolderIdFromItem(item) {
  const f = item && item.folder;
  if (f == null) return '';
  if (typeof f === 'string') return f.trim();
  if (typeof f === 'object') return String(f.id || f.uuid || '').trim();
  return '';
}

/**
 * Locate an existing applied control in a folder by ref_id (GRC list filters + paginated folder scan).
 * @returns {Promise<string[]|null>} null if auth aborted; [] if none; one id if found.
 */
async function dsFindAppliedControlIdForRefInFolder(folderId, rowRef, grcUrl, reqToken, res, linkErrors, ctx) {
  const ref = dsNormalizeRefId(rowRef);
  const folder = String(folderId || '').trim();
  if (!ref || !folder) return [];
  const tryVals = [...new Set([ref, ...dsRefIdAliasKeys(ref)])].slice(0, 12);
  const matchesTry = (item, rTry) => {
    const ir = dsAppliedControlRefFromItem(item);
    if (!ir || !rTry) return false;
    if (dsNormalizeRefId(ir) === dsNormalizeRefId(rTry)) return true;
    return dsComparableRefId(ir) === dsComparableRefId(rTry);
  };
  const inScopeFolder = item => {
    const fid = dsAppliedControlFolderIdFromItem(item);
    return !fid || fid === folder;
  };

  const folderFilterBases = [{ folder }, { folder__id: folder }, { folder_id: folder }];

  for (const base of folderFilterBases) {
    for (const r of tryVals) {
      const q = new URLSearchParams({ ...base, ref_id: r, page_size: '80' });
      const url = `${grcUrl}/api/applied-controls/?${q.toString()}`;
      const acRes = await grcFetch(url, {}, reqToken);
      if (!acRes.ok) {
        const errIn = await consumeGrcErrorBody(res, reqToken, acRes);
        if (errIn.aborted) return null;
        continue;
      }
      const data = await acRes.json();
      const results = Array.isArray(data.results) ? data.results : [];
      const hits = results.filter(it => inScopeFolder(it) && matchesTry(it, r));
      if (!hits.length) continue;
      const id = String(hits[0].id || hits[0].uuid || '').trim();
      if (!id) continue;
      if (hits.length > 1 && linkErrors) {
        linkErrors.push({
          ...ctx,
          error: `Multiple applied controls match ref "${r}" in this folder — linking first (${id}).`,
        });
      }
      return [id];
    }
  }

  for (const base of folderFilterBases) {
    let nextUrl = `${grcUrl}/api/applied-controls/?${new URLSearchParams({ ...base, page_size: '500' }).toString()}`;
    const seen = new Set();
    while (nextUrl) {
      if (seen.has(nextUrl)) break;
      seen.add(nextUrl);
      const acRes = await grcFetch(nextUrl, {}, reqToken);
      if (!acRes.ok) {
        const errIn = await consumeGrcErrorBody(res, reqToken, acRes);
        if (errIn.aborted) return null;
        break;
      }
      const data = await acRes.json();
      const results = Array.isArray(data.results) ? data.results : [];
      const hits = results.filter(it => {
        if (!inScopeFolder(it)) return false;
        const ir = dsAppliedControlRefFromItem(it);
        if (!ir) return false;
        return tryVals.some(tv => matchesTry(it, tv) || dsComparableRefId(ir) === dsComparableRefId(tv));
      });
      if (hits.length) {
        const id = String(hits[0].id || hits[0].uuid || '').trim();
        if (hits.length > 1 && linkErrors) {
          linkErrors.push({
            ...ctx,
            error: `Multiple applied controls match ref "${ref}" in folder (list scan) — linking first (${id}).`,
          });
        }
        return id ? [id] : [];
      }
      const nxt = data.next;
      nextUrl = typeof nxt === 'string' && nxt ? nxt : null;
    }
  }
  return [];
}

function dsParseWorkbookToNormalizedRows(fileBuffer) {
  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const sn = wb.SheetNames || [];
  if (!sn.length) return { error: 'Workbook has no sheets.' };
  const sheet = wb.Sheets[sn[0]];
  const objects = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const rows = [];
  for (const o of objects) {
    const n = dsNormalizeImportRow(o);
    if (!n.name) continue;
    rows.push(n);
  }
  return { sheetName: sn[0], rows };
}

// ==========================================
// Gemini Analysis API
// ==========================================

// Call Gemini API for a single requirement
async function callGeminiAPIForSingle(requirement, userPrompt, apiKey, contextFiles) {
  // Format context files content for the prompt
  let contextFilesText = 'No context files provided.';
  if (contextFiles && contextFiles.length > 0) {
    contextFilesText = contextFiles.map((cf, i) => {
      // Truncate very large files to avoid token limits (keep first ~8000 chars)
      const content = cf.content && cf.content.length > 8000
        ? cf.content.substring(0, 8000) + '\n... [truncated — file too large to include fully]'
        : (cf.content || '(empty file)');
      return `### File ${i + 1}: ${cf.name}\n\`\`\`\n${content}\n\`\`\``;
    }).join('\n\n');
  }

  const fullPrompt = promptTemplate
    .replace('{{REQUIREMENT}}', JSON.stringify(requirement, null, 2))
    .replace('{{USER_PROMPT}}', userPrompt || 'No additional context provided.')
    .replace('{{CONTEXT_FILES}}', contextFilesText);

  const requestBody = {
    contents: [{
      parts: [{
        text: fullPrompt
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
    }
  };

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!textResponse) {
    throw new Error('No response from Gemini API');
  }

  let jsonStr = textResponse.trim();
  
  console.log('Raw Gemini response length:', textResponse.length);
  
  const jsonMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
    console.log('Extracted from markdown code block');
  }
  
  if (!jsonStr.startsWith('{')) {
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      jsonStr = jsonObjectMatch[0];
      console.log('Extracted JSON object from text');
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    
    if (!parsed.typical_evidence || !Array.isArray(parsed.typical_evidence)) {
      parsed.typical_evidence = [];
    }
    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      parsed.questions = [];
    }
    if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) {
      parsed.suggestions = [];
    }
    
    console.log('Parsed successfully:', {
      evidence_count: parsed.typical_evidence.length,
      questions_count: parsed.questions.length,
      suggestions_count: parsed.suggestions.length
    });
    
    return parsed;
  } catch (e) {
    console.error('Failed to parse Gemini response as JSON');
    console.error('Parse error:', e.message);
    console.error('First 500 chars of response:', textResponse.substring(0, 500));
    
    try {
      const evidenceMatch = jsonStr.match(/"typical_evidence"\s*:\s*\[([\s\S]*?)\]/);
      const questionsMatch = jsonStr.match(/"questions"\s*:\s*\[([\s\S]*?)\]/);
      
      if (evidenceMatch || questionsMatch) {
        console.log('Attempting partial extraction...');
        return {
          typical_evidence: evidenceMatch ? JSON.parse('[' + evidenceMatch[1] + ']') : [],
          questions: questionsMatch ? JSON.parse('[' + questionsMatch[1] + ']') : [],
          suggestions: []
        };
      }
    } catch (e2) {
      console.error('Partial extraction also failed:', e2.message);
    }
    
    throw new Error('Failed to parse AI response. Please try again.');
  }
}

// Call Gemini API for multiple requirements (batch processing)
async function callGeminiAPIForMultiple(requirements, userPrompt, apiKey, contextFiles) {
  console.log(`Processing ${requirements.length} requirements...`);
  
  const CONCURRENCY_LIMIT = 3;
  const results = [];
  
  for (let i = 0; i < requirements.length; i += CONCURRENCY_LIMIT) {
    const batch = requirements.slice(i, i + CONCURRENCY_LIMIT);
    const batchPromises = batch.map(async (requirement, batchIndex) => {
      const index = i + batchIndex;
      console.log(`Analyzing requirement ${index + 1}/${requirements.length}: ${requirement.refId || 'No ref'}`);
      
      try {
        const analysis = await callGeminiAPIForSingle(requirement, userPrompt, apiKey, contextFiles);
        return {
          requirement,
          analysis,
          success: true
        };
      } catch (error) {
        console.error(`Failed to analyze requirement ${index + 1}:`, error.message);
        return {
          requirement,
          analysis: {
            typical_evidence: [],
            questions: [],
            suggestions: []
          },
          success: false,
          error: error.message
        };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }
  
  return { results };
}

// ==========================================
// Gemini Controls Generation API
// ==========================================

function buildOrgProfileText(orgContext) {
  if (!orgContext) return 'No organization profile provided. Generate industry-agnostic controls.';
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

// ---- Batch Controls Generation (single or chunked API calls) ----
const CHUNK_SIZE = 15; // Max requirements per API call (keeps output under token limit)

async function callGeminiForChunk(chunkRequirements, orgContext, contextFiles, apiKey) {
  const orgContextText = buildOrgProfileText(orgContext);

  // Build reference files text
  let refFilesText = 'No reference files provided.';
  if (contextFiles && contextFiles.length > 0) {
    refFilesText = contextFiles.map((cf, i) => {
      const content = cf.content && cf.content.length > 8000
        ? cf.content.substring(0, 8000) + '\n... [truncated]'
        : (cf.content || '(empty)');
      return `### File ${i + 1}: ${cf.name}\n\`\`\`\n${content}\n\`\`\``;
    }).join('\n\n');
  }

  // Build ALL requirements text (numbered list)
  const reqsText = chunkRequirements.map((req, i) => {
    return [
      `### Requirement ${i + 1}`,
      `- **Ref ID**: ${req.refId || 'N/A'}`,
      `- **Framework**: ${req.frameworkName || 'Unknown'}`,
      `- **Name**: ${req.name || ''}`,
      `- **Description**: ${req.description || ''}`,
      req.depth !== undefined ? `- **Depth**: ${req.depth}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const fullPrompt = getControlsGeneratorPrompt()
    .replace('{{ORG_CONTEXT}}', orgContextText)
    .replace('{{REFERENCE_FILES}}', refFilesText)
    .replace('{{REQUIREMENTS}}', reqsText);

  // Scale output tokens based on number of requirements (~1500 tokens per requirement)
  const outputTokens = Math.min(65536, Math.max(8192, chunkRequirements.length * 1500));

  const requestBody = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: outputTokens,
    }
  };

  console.log(`[Controls] Calling Gemini for ${chunkRequirements.length} requirements (maxOutput: ${outputTokens} tokens)`);

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log('[Controls AI Response]', textResponse);
  if (!textResponse) throw new Error('No response from Gemini API');

  // Parse JSON from response
  let jsonStr = textResponse.trim();
  const jsonMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  if (!jsonStr.startsWith('{')) {
    const obj = jsonStr.match(/\{[\s\S]*\}/);
    if (obj) jsonStr = obj[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.controls || !Array.isArray(parsed.controls)) parsed.controls = [];
    return parsed.controls;
  } catch (e) {
    console.error('Controls JSON parse failed:', e.message, 'First 500:', textResponse.substring(0, 500));
    return [];
  }
}

async function generateControlsBatch(requirements, orgContext, contextFiles, apiKey) {
  const allControls = [];
  const progress = { total: requirements.length, completed: 0, failed: 0 };

  // Build a lookup map: refId → requirement metadata
  const reqLookup = new Map();
  for (const req of requirements) {
    const key = (req.refId || '').toLowerCase().trim();
    if (key) {
      reqLookup.set(key, {
        refId: req.refId || '',
        name: req.name || req.description || '',
        framework: req.frameworkName || '',
        nodeUrn: req.nodeUrn || '',
        nodeId: req.nodeId || '',
      });
    }
  }

  // Split requirements into chunks of CHUNK_SIZE
  const chunks = [];
  for (let i = 0; i < requirements.length; i += CHUNK_SIZE) {
    chunks.push(requirements.slice(i, i + CHUNK_SIZE));
  }

  console.log(`[Controls] Processing ${requirements.length} requirements in ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}`);

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    console.log(`[Controls] Chunk ${ci + 1}/${chunks.length}: ${chunk.length} requirements (${chunk.map(r => r.refId || '?').join(', ')})`);

    try {
      const rawControls = await callGeminiForChunk(chunk, orgContext, contextFiles, apiKey);
      console.log(`[Controls] Chunk ${ci + 1} returned ${rawControls.length} controls`);

      // Map AI response controls to linkedRequirements using for_requirements
      for (const ctrl of rawControls) {
        const forReqs = ctrl.for_requirements || [];
        const linkedRequirements = [];

        for (const refId of forReqs) {
          const key = (refId || '').toLowerCase().trim();
          const reqMeta = reqLookup.get(key);
          if (reqMeta) {
            linkedRequirements.push({ ...reqMeta });
          } else {
            // Fuzzy fallback: try to find requirement that contains this refId
            const fallback = requirements.find(r => (r.refId || '').toLowerCase().includes(key) || key.includes((r.refId || '').toLowerCase()));
            if (fallback) {
              linkedRequirements.push({
                refId: fallback.refId || '',
                name: fallback.name || fallback.description || '',
                framework: fallback.frameworkName || '',
                nodeUrn: fallback.nodeUrn || '',
                nodeId: fallback.nodeId || '',
              });
            } else {
              console.warn(`[Controls] Unknown refId "${refId}" in for_requirements — skipping`);
            }
          }
        }

        // If AI didn't return for_requirements, link to all requirements in this chunk (fallback)
        if (linkedRequirements.length === 0) {
          console.warn(`[Controls] Control "${ctrl.name}" has no valid for_requirements — linking to all chunk requirements`);
          for (const req of chunk) {
            linkedRequirements.push({
              refId: req.refId || '',
              name: req.name || req.description || '',
              framework: req.frameworkName || '',
              nodeUrn: req.nodeUrn || '',
              nodeId: req.nodeId || '',
            });
          }
        }

        // Clean up AI-only fields, add linkedRequirements
        const { for_requirements, ...controlData } = ctrl;
        allControls.push({
          ...controlData,
          linkedRequirements,
          // Legacy fields for backward compatibility (use first linked requirement)
          requirementRefId: linkedRequirements[0]?.refId || '',
          requirementName: linkedRequirements[0]?.name || '',
          framework: linkedRequirements[0]?.framework || '',
          requirementUrn: linkedRequirements[0]?.nodeUrn || '',
          requirementNodeId: linkedRequirements[0]?.nodeId || '',
        });
      }

      progress.completed += chunk.length;
    } catch (err) {
      console.error(`[Controls] Chunk ${ci + 1} failed:`, err.message);
      progress.failed += chunk.length;
    }
  }

  // Post-processing: deduplicate controls with identical names (across chunks)
  const deduped = [];
  const nameMap = new Map();
  for (const ctrl of allControls) {
    const key = (ctrl.name || '').toLowerCase().trim();
    if (key && nameMap.has(key)) {
      const existing = deduped[nameMap.get(key)];
      for (const rl of (ctrl.linkedRequirements || [])) {
        const alreadyLinked = existing.linkedRequirements.some(r => r.refId === rl.refId && r.nodeUrn === rl.nodeUrn);
        if (!alreadyLinked) {
          existing.linkedRequirements.push(rl);
        }
      }
      console.log(`[Controls] Dedup merged: "${ctrl.name}" (now ${existing.linkedRequirements.length} reqs)`);
    } else {
      nameMap.set(key, deduped.length);
      deduped.push(ctrl);
    }
  }

  if (deduped.length < allControls.length) {
    console.log(`[Controls] Deduplication: ${allControls.length} → ${deduped.length} unique controls`);
  }

  console.log(`[Controls] Final: ${deduped.length} unique controls covering ${requirements.length} requirements`);
  return { controls: deduped, progress };
}

// ---- Question-to-Control Conversion ----
async function convertQuestionToControl(question, requirement, orgContext, apiKey) {
  const orgContextText = buildOrgProfileText(orgContext);

  const prompt = `You are a GRC expert. A compliance question was asked during an audit or assessment. Your job is to generate an Applied Control that, if implemented, would make the answer to this question "Yes / Compliant."

## Organization Profile

${orgContextText}

## Source Requirement

Framework: ${requirement?.frameworkName || 'Unknown'}
${requirement?.refId ? `Ref ID: ${requirement.refId}` : ''}
Name: ${requirement?.name || 'N/A'}
Description: ${requirement?.description || 'N/A'}

## Compliance Question

"${question}"

## Instructions

Generate exactly ONE applied control that directly addresses this question. The control should be specific enough that implementing it would definitively answer the question with "Yes / Compliant."

CRITICAL: Respond with ONLY valid JSON. No markdown. Start with { end with }.

{
  "control": {
    "name": "Control name in English (5-15 words)",
    "name_ar": "اسم الضابط بالعربية",
    "description": "Detailed description (30-80 words) of what the control entails, how to implement it, and what evidence demonstrates compliance",
    "description_ar": "وصف تفصيلي للضابط",
    "control_type": "preventive|detective|corrective|directive",
    "implementation_priority": "critical|high|medium|low",
    "effort_estimate": "Low|Medium|High",
    "relevance_score": 85,
    "evidence_examples": ["Evidence 1", "Evidence 2"],
    "source_question": "${question.replace(/"/g, '\\"')}"
  }
}`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5, topK: 40, topP: 0.95, maxOutputTokens: 4096 }
  };

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textResponse) throw new Error('No response from Gemini API');

  let jsonStr = textResponse.trim();
  const jsonMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();
  if (!jsonStr.startsWith('{')) {
    const obj = jsonStr.match(/\{[\s\S]*\}/);
    if (obj) jsonStr = obj[0];
  }

  const parsed = JSON.parse(jsonStr);
  return parsed.control || parsed;
}

// ==========================================
// Gemini File Search Store (Collections) API
// ==========================================

// Create a file search store
async function createFileSearchStore(displayName, apiKey) {
  const res = await fetch(`${GEMINI_BASE_URL}/fileSearchStores?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create store failed (${res.status}): ${err}`);
  }
  return res.json();
}

// List all file search stores
async function listFileSearchStores(apiKey) {
  const res = await fetch(`${GEMINI_BASE_URL}/fileSearchStores?key=${apiKey}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`List stores failed (${res.status}): ${err}`);
  }
  return res.json();
}

// Delete a file search store
async function deleteFileSearchStore(storeName, apiKey) {
  const res = await fetch(`${GEMINI_BASE_URL}/${storeName}?key=${apiKey}&force=true`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Delete store failed (${res.status}): ${err}`);
  }
  // DELETE may return empty body
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Upload file directly to a file search store using resumable upload protocol.
// This combines file upload + store import in a single operation.
async function uploadFileToStore(storeName, fileName, mimeType, fileBuffer, apiKey) {
  const sizeBytes = fileBuffer.length;

  // URL-encode the filename for HTTP headers (non-ASCII chars like Arabic are not allowed in headers)
  const encodedFileName = encodeURIComponent(fileName);

  // Step 1: Initiate resumable upload — get the upload URL
  const initRes = await fetch(`${GEMINI_UPLOAD_URL}/${storeName}:uploadToFileSearchStore?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'X-Goog-Upload-File-Name': encodedFileName
    },
    body: JSON.stringify({
      displayName: fileName
    })
  });

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`Upload initiation failed (${initRes.status}): ${err}`);
  }

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Server did not return an upload URL.');
  }

  // Step 2: Upload the actual file bytes to the upload URL
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(sizeBytes),
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-File-Name': encodedFileName
    },
    body: fileBuffer
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`File upload failed (${uploadRes.status}): ${err}`);
  }

  return uploadRes.json();
}

/** Gemini ListDocuments caps page_size at 20 (INVALID_ARGUMENT otherwise). */
const GEMINI_FILE_SEARCH_DOCUMENT_PAGE_MAX = 20;
/** UI list page size for policy collection file grids (`pageSize` / `pageToken`). */
const FILE_SEARCH_DOCUMENT_PAGE_SIZE_UI = GEMINI_FILE_SEARCH_DOCUMENT_PAGE_MAX;
/** Full-store scans use the same max page size; loop with nextPageToken. */
const LIST_STORE_DOCUMENTS_PAGE_SIZE_BULK = GEMINI_FILE_SEARCH_DOCUMENT_PAGE_MAX;

const policyStoreDocCountCache = new Map(); // bare store id -> { count, ts }

function invalidatePolicyStoreDocCountCache(storeIdBare) {
  if (storeIdBare == null || storeIdBare === '') return;
  policyStoreDocCountCache.delete(String(storeIdBare).replace(/^fileSearchStores\//, ''));
}

async function listStoreDocumentsPage(storeName, apiKey, pageSize, pageToken) {
  const safeSize = Math.min(GEMINI_FILE_SEARCH_DOCUMENT_PAGE_MAX, Math.max(1, pageSize | 0 || FILE_SEARCH_DOCUMENT_PAGE_SIZE_UI));
  const qs = new URLSearchParams({ key: apiKey, pageSize: String(safeSize) });
  if (pageToken) qs.set('pageToken', pageToken);
  const res = await fetch(`${GEMINI_BASE_URL}/${storeName}/documents?${qs}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`List documents failed (${res.status}): ${err}`);
  }
  const page = await res.json();
  return {
    documents: page.documents || [],
    nextPageToken: typeof page.nextPageToken === 'string' ? page.nextPageToken : '',
  };
}

async function listAllStoreDocuments(storeName, apiKey) {
  const allDocuments = [];
  let pageToken = '';
  do {
    const page = await listStoreDocumentsPage(storeName, apiKey, LIST_STORE_DOCUMENTS_PAGE_SIZE_BULK, pageToken);
    allDocuments.push(...(page.documents || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return { documents: allDocuments };
}

// List documents in a file search store (paginates until exhaustion)
async function listStoreDocuments(storeName, apiKey) {
  return listAllStoreDocuments(storeName, apiKey);
}

async function countDocumentsInStore(storeName, apiKey) {
  let n = 0;
  let pageToken = '';
  do {
    const page = await listStoreDocumentsPage(storeName, apiKey, LIST_STORE_DOCUMENTS_PAGE_SIZE_BULK, pageToken);
    n += (page.documents || []).length;
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return n;
}

async function getCachedDocumentCount(storeName, apiKey) {
  const bare = storeName.replace(/^fileSearchStores\//, '');
  const hit = policyStoreDocCountCache.get(bare);
  const TTL_MS = 60000;
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.count;
  const count = await countDocumentsInStore(storeName, apiKey);
  policyStoreDocCountCache.set(bare, { count, ts: Date.now() });
  return count;
}

// Delete a document from a file search store (force=true to delete even if it has chunks)
async function deleteDocument(documentName, apiKey) {
  const res = await fetch(`${GEMINI_BASE_URL}/${documentName}?key=${apiKey}&force=true`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Delete document failed (${res.status}): ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function safeJsonForLog(value, maxLen = 4000) {
  if (value == null) return String(value);
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (s.length > maxLen) return `${s.slice(0, maxLen)}… (+${s.length - maxLen} more chars)`;
    return s;
  } catch {
    return '[unserializable]';
  }
}

// Poll a long-running operation until done
async function pollOperation(operationName, apiKey, maxWaitMs = 120000) {
  const start = Date.now();
  let lastOp = null;
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${GEMINI_BASE_URL}/${operationName}?key=${apiKey}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(
        `[Gemini][operations] poll HTTP ${res.status} ${operationName}:`,
        safeJsonForLog(errText, 1200)
      );
      break;
    }
    lastOp = await res.json();
    console.log(
      `[Gemini][operations] poll ${operationName} (${Math.round((Date.now() - start) / 1000)}s elapsed):`,
      safeJsonForLog(lastOp, 2500)
    );
    if (lastOp.done) return lastOp;
    await new Promise(r => setTimeout(r, 3000));
  }
  if (lastOp) {
    console.warn(
      `[Gemini][operations] poll stopped after ${maxWaitMs}ms (done=false); last response:`,
      safeJsonForLog(lastOp, 2500)
    );
  } else {
    console.warn(`[Gemini][operations] poll stopped with no successful response: ${operationName}`);
  }
  return { done: false, note: 'Still processing in background' };
}

/** Whether Gemini LRO finished; missing `done` on non-operation bodies counts as complete. */
function geminiUploadOperationLooksComplete(op) {
  if (!op || typeof op !== 'object') return false;
  if (op.done === true) return true;
  if (op.done === false) return false;
  const nm = op.name || '';
  if (typeof nm === 'string' && nm.includes('operations/')) return false;
  return true;
}

/** File Search document resource name from upload LRO `response` (shape varies). */
function extractDocumentResourceNameFromUploadOp(op) {
  const r = op && op.response;
  if (!r || typeof r !== 'object') return '';
  // UploadToFileSearchStoreResponse uses documentName (see google.ai.generativelanguage UploadToFileSearchStoreResponse)
  if (typeof r.documentName === 'string' && r.documentName.includes('/documents/')) return r.documentName;
  if (typeof r.name === 'string' && r.name.includes('/documents/')) return r.name;
  const d = r.document;
  if (d && typeof d.name === 'string') return d.name;
  if (typeof d === 'string' && d.includes('/documents/')) return d;
  return '';
}

async function getFileSearchDocument(documentName, apiKey) {
  if (!documentName || !apiKey) return null;
  const pathSeg = documentName.replace(/^\//, '');
  try {
    const res = await fetch(`${GEMINI_BASE_URL}/${pathSeg}?key=${apiKey}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(
        `[Gemini][documents] GET ${pathSeg} HTTP ${res.status}:`,
        safeJsonForLog(errText, 1200)
      );
      return null;
    }
    const doc = await res.json();
    console.log(`[Gemini][documents] GET ${pathSeg}:`, safeJsonForLog(doc, 4000));
    return doc;
  } catch (e) {
    console.warn(`[Gemini][documents] GET ${pathSeg}: ${e.message}`);
    return null;
  }
}

async function buildPolicyIndexingStatus(finalResult, apiKey) {
  console.log('[Policy][indexing] LRO / upload finalResult:', safeJsonForLog(finalResult, 3500));

  const operationComplete = geminiUploadOperationLooksComplete(finalResult);
  let documentName = extractDocumentResourceNameFromUploadOp(finalResult);
  let documentState = '';
  let documentFetched = false;

  if (operationComplete && documentName && apiKey) {
    console.log('[Policy][indexing] fetching document state:', documentName);
    const doc = await getFileSearchDocument(documentName, apiKey);
    if (doc && typeof doc === 'object') {
      documentFetched = true;
      documentState = typeof doc.state === 'string' ? doc.state : '';
    }
  } else if (operationComplete && !documentName) {
    console.log('[Policy][indexing] operation complete but no document resource name in LRO response');
  }

  let summaryLabel = '';
  if (!operationComplete) {
    summaryLabel = 'Uploaded · indexing still in progress';
  } else if (documentFetched && documentState === 'STATE_ACTIVE') {
    summaryLabel = 'Indexed & ready ✓';
  } else if (documentFetched && documentState) {
    summaryLabel = `Indexing: ${documentState.replace(/^STATE_/, '').toLowerCase()}`;
  } else if (operationComplete) {
    summaryLabel = 'Indexing finished ✓';
  } else {
    summaryLabel = 'Uploaded successfully ✓';
  }

  const indexingStatus = {
    operationComplete,
    documentName: documentName || null,
    documentState: documentState || null,
    documentFetched,
    summaryLabel,
  };
  console.log('[Policy][indexing] indexingStatus for client:', safeJsonForLog(indexingStatus, 2000));
  return indexingStatus;
}

/**
 * ASCII-safe unique disk name for stored uploads. Arabic/Unicode-only names become identical
 * after /[^a-zA-Z0-9._-]/g sanitization (e.g. many files → "_____.pdf"), which overwrites
 * local copies and corrupts _metadata.json mappings.
 */
function uniqueAsciiLocalFileName(originalFileName, fileBuffer) {
  const raw = originalFileName || 'file';
  const ext = path.extname(raw);
  const extLower = (ext || '').toLowerCase() || '.bin';
  const baseStem = ext ? path.basename(raw, ext) : raw;
  let stem = baseStem
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!stem) stem = 'file';
  if (stem.length > 48) stem = stem.slice(0, 48);
  const hash12 = crypto.createHash('sha256').update(fileBuffer).digest('hex').slice(0, 12);
  return `${stem}_${hash12}${extLower}`;
}

// ==========================================
// Static File Server
// ==========================================

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// ==========================================
// HTTP Server
// ==========================================

const server = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- Bootstrap script: Muraji base URL from `.env` (load before admin.js / app.js / prompts.js) ----
  if (req.method === 'GET' && url.pathname === '/client-env.js') {
    const payload = Buffer.from(`window.__MURAJI_BASE_URL__=${JSON.stringify(MURAJI_API_URL)};\n`, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': payload.length,
    });
    res.end(payload);
    return;
  }

  // ---- Auth: Login endpoint (via GRC IAM) ----
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      if (!username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Username and password are required.' }));
        return;
      }

      // Authenticate via GRC IAM API
      console.log(`[Auth] Logging in via GRC IAM for user: ${username}`);
      const grcLoginRes = await fetch(`${GRC_API_URL}/api/iam/login/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (!grcLoginRes.ok) {
        const errText = await grcLoginRes.text();
        console.log(`[Auth] GRC login failed for ${username}: ${grcLoginRes.status}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid username or password' }));
        return;
      }

      const grcData = await grcLoginRes.json();
      const grcToken = grcData.token || grcData.key || grcData.access;
      if (!grcToken) {
        console.error('[Auth] GRC login response missing token:', JSON.stringify(grcData));
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'GRC login succeeded but no token returned.' }));
        return;
      }

      // Create local session linked to GRC token
      const localToken = generateLocalToken();
      authSessions.set(localToken, { grcToken, username });
      console.log(`[Auth] Login successful for ${username} — GRC token stored`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, token: localToken }));
    } catch (error) {
      console.error('[Auth] Login error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Login failed: ' + error.message }));
    }
    return;
  }

  // ---- Auth: Logout endpoint ----
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = getTokenFromRequest(req);
    if (token) authSessions.delete(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ---- Auth: Check endpoint ----
  if (url.pathname === '/api/auth/check' && req.method === 'GET') {
    const token = getTokenFromRequest(req);
    const valid = isValidToken(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: valid }));
    return;
  }

  // ---- Auth: Me endpoint ----
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const token = getTokenFromRequest(req);
    const session = token ? authSessions.get(token) : null;
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: true, username: session.username }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
    }
    return;
  }

  // ---- Auth Guard ----
  if (!isPublicPath(url.pathname)) {
    const token = getTokenFromRequest(req);
    if (!isValidToken(token)) {
      // For API requests, return 401
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized. Please log in.' }));
        return;
      }
      // For page requests (HTML or SPA routes), redirect to login
      if (isAdminSpaPath(url.pathname) || url.pathname.endsWith('.html')) {
        res.writeHead(302, { 'Location': '/login.html' });
        res.end();
        return;
      }
      // Static assets (css, js) — allow through so login page renders correctly
      // But only known login assets are in PUBLIC_PATHS; others need auth
      // Actually, let CSS/JS through since they don't expose data
      const ext = path.extname(url.pathname);
      if (['.css', '.js', '.svg', '.png', '.jpg', '.ico', '.woff', '.woff2'].includes(ext)) {
        // Allow static assets through (no sensitive data)
      } else {
        res.writeHead(302, { 'Location': '/login.html' });
        res.end();
        return;
      }
    }
  }

  // Extract local token for GRC-authenticated fetch calls
  const reqToken = getTokenFromRequest(req);

  // ---- Data Studio: Excel preview (applied controls import path) ----
  if (url.pathname === '/api/data-studio/preview-excel' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { fileName, data } = body;
      if (!data || typeof data !== 'string') {
        sendJSON(res, 400, { error: 'data (base64) is required.' });
        return;
      }
      const lower = String(fileName || '').toLowerCase();
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls') && !lower.endsWith('.csv')) {
        sendJSON(res, 400, { error: 'Only Excel (.xlsx, .xls) or CSV files are supported.' });
        return;
      }
      let fileBuffer;
      try {
        fileBuffer = Buffer.from(data, 'base64');
      } catch {
        sendJSON(res, 400, { error: 'Invalid base64 payload.' });
        return;
      }
      if (!fileBuffer.length) {
        sendJSON(res, 400, { error: 'Empty file.' });
        return;
      }
      const wb = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetNames = wb.SheetNames || [];
      if (!sheetNames.length) {
        sendJSON(res, 400, { error: 'Workbook has no sheets.' });
        return;
      }
      const firstSheet = sheetNames[0];
      const sheet = wb.Sheets[firstSheet];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
      const headers = headerRow.map((h, i) => {
        const s = h != null && String(h).trim() !== '' ? String(h).trim() : `Column ${i + 1}`;
        return s;
      });
      const dataRows = rows.slice(1);
      const previewLimit = 25;
      const preview = dataRows.slice(0, previewLimit).map(row => {
        const arr = Array.isArray(row) ? row : [];
        const o = {};
        headers.forEach((h, i) => {
          o[h] = arr[i] != null && arr[i] !== '' ? arr[i] : '';
        });
        return o;
      });
      sendJSON(res, 200, {
        success: true,
        fileName: fileName || 'upload',
        sheetNames,
        activeSheet: firstSheet,
        totalRows: dataRows.length,
        previewHeaders: headers,
        previewRowCount: preview.length,
        preview,
      });
    } catch (err) {
      console.error('[DataStudio] preview-excel:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to parse workbook.' });
    }
    return;
  }

  if (url.pathname === '/api/data-studio/create-audit' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const framework =
        body.framework && typeof body.framework === 'string' ? body.framework.trim() : '';
      const folder =
        body.folder && typeof body.folder === 'string' ? body.folder.trim() : '';
      const customName = body.name && typeof body.name === 'string' ? body.name.trim() : '';
      const description =
        body.description && typeof body.description === 'string'
          ? body.description.trim()
          : 'Created from Data Studio to host requirement-assessments for imported applied controls. RAs were auto-generated by GRC on insert (CISO Assistant ComplianceAssessment.create_requirement_assessments).';
      const perimeter =
        body.perimeter && typeof body.perimeter === 'string' ? body.perimeter.trim() : '';
      const version = body.version && typeof body.version === 'string' ? body.version.trim() : '1.0';
      const status = body.status && typeof body.status === 'string' ? body.status.trim() : 'in_progress';

      if (!framework) {
        sendJSON(res, 400, { error: 'framework (UUID) is required.' });
        return;
      }

      // Resolve the framework name so we can build a sensible default audit name.
      let frameworkName = '';
      try {
        const fwRes = await grcFetch(
          `${GRC_API_URL}/api/frameworks/${encodeURIComponent(framework)}/`,
          {},
          reqToken
        );
        if (fwRes.ok) {
          const fwData = await fwRes.json();
          frameworkName = fwData.name || fwData.ref_id || '';
        } else if (await finalizeGrcUpstreamError(res, reqToken, fwRes)) {
          return;
        }
      } catch (_) { /* non-fatal — name is optional */ }

      const localLinkErrors = [];
      const newCA = await dsCreateComplianceAssessmentForFramework({
        framework: { id: framework, name: frameworkName },
        folder,
        perimeter,
        name: customName || null,
        description,
        version,
        status,
        grcUrl: GRC_API_URL,
        reqToken,
        res,
        linkErrors: localLinkErrors,
      });

      if (!newCA) {
        const last = localLinkErrors[localLinkErrors.length - 1];
        sendJSON(res, 500, {
          error: 'create-audit failed — could not POST /api/compliance-assessments/.',
          attemptedFramework: framework,
          frameworkName: frameworkName || null,
          providedPerimeter: perimeter || null,
          hint: 'CISO Assistant typically requires perimeter. Provide body.perimeter (UUID) or create a perimeter under your folder in GRC. The server will then auto-discover it.',
          detail: last ? last.error : null,
        });
        return;
      }

      const newId = newCA.id || newCA.uuid;

      // Confirm RAs were auto-generated by GRC on insert (give the DB a moment to commit).
      let raCount = null;
      try {
        const raRes = await grcFetch(
          `${GRC_API_URL}/api/requirement-assessments/?compliance_assessment=${encodeURIComponent(newId)}&page_size=1`,
          {},
          reqToken
        );
        if (raRes.ok) {
          const d = await raRes.json();
          if (typeof d.count === 'number') raCount = d.count;
        }
      } catch (_) { /* non-fatal */ }

      console.log(
        `[DataStudio] New CA ${newId} has ${raCount == null ? '?' : raCount} requirement-assessments auto-generated.`
      );

      sendJSON(res, 200, {
        success: true,
        id: newId,
        name: newCA.name || customName || `${frameworkName || 'Framework'} – Controls Catalog`,
        framework,
        frameworkName: frameworkName || null,
        folder: newCA.folder || folder || null,
        perimeter: newCA.perimeter || perimeter || null,
        version: newCA.version || version,
        status: newCA.status || status,
        raCount,
        grcApi: GRC_API_URL,
      });
    } catch (err) {
      console.error('[DataStudio] create-audit:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to create audit.' });
    }
    return;
  }

  if (url.pathname === '/api/data-studio/diagnose-grc-audits' && req.method === 'GET') {
    try {
      // 1) every compliance assessment + a small sample of its requirement-assessment ref_ids
      const cas = await dsFetchAllComplianceAssessments(GRC_API_URL, reqToken, res);
      if (cas === null) return; // response already finalized by helper

      const audits = [];
      for (const ca of cas) {
        const caId = ca.id || ca.uuid;
        if (!caId) continue;
        const ras = await dsFetchAllRequirementAssessmentsForCA(caId, GRC_API_URL, reqToken, res);
        if (ras === null) return;
        let raRefIdsSample = [];
        let auditRefIdsDistinct = 0;
        if (ras.length) {
          const built = await dsBuildRefIdToRAsMap(ras, GRC_API_URL, reqToken, res);
          if (built === null) return;
          auditRefIdsDistinct = built.auditRefIdsDistinct;
          raRefIdsSample = (built.auditRefIdSample || []).slice(0, 30);
        }
        let frameworkInfo = null;
        const fw = ca.framework;
        if (fw && typeof fw === 'object') {
          frameworkInfo = { id: fw.id || fw.uuid || null, name: fw.name || fw.ref_id || null };
        } else if (fw && typeof fw === 'string') {
          frameworkInfo = { id: fw, name: null };
        }
        audits.push({
          id: caId,
          name: ca.name || ca.basename || String(caId),
          framework: frameworkInfo,
          raCount: ras.length,
          distinctRefIds: auditRefIdsDistinct,
          raRefIdsSample,
        });
      }

      // 2) every framework + a small sample of its requirement-node ref_ids
      const frameworks = [];
      let nextUrl = `${GRC_API_URL}/api/frameworks/?page_size=200`;
      while (nextUrl) {
        const r = await grcFetch(nextUrl, {}, reqToken);
        if (!r.ok) {
          if (await finalizeGrcUpstreamError(res, reqToken, r)) return;
          break;
        }
        const d = await r.json();
        frameworks.push(...(Array.isArray(d.results) ? d.results : []));
        nextUrl = d.next || null;
      }
      const frameworkSummaries = [];
      for (const fw of frameworks.slice(0, 50)) {
        const fwId = fw.id || fw.uuid;
        if (!fwId) continue;
        let nodeRefIdsSample = [];
        let requirementCount = 0;
        try {
          const nr = await grcFetch(
            `${GRC_API_URL}/api/requirement-nodes/?framework=${encodeURIComponent(fwId)}&page_size=80`,
            {},
            reqToken
          );
          if (nr.ok) {
            const nd = await nr.json();
            requirementCount = typeof nd.count === 'number' ? nd.count : (Array.isArray(nd.results) ? nd.results.length : 0);
            const refs = (Array.isArray(nd.results) ? nd.results : [])
              .map(n => dsNormalizeRefId(n.ref_id || n.refId || ''))
              .filter(Boolean);
            nodeRefIdsSample = [...new Set(refs)].slice(0, 30);
          }
        } catch (_) { /* ignore per-framework fetch error */ }
        frameworkSummaries.push({
          id: fwId,
          name: fw.name || fw.ref_id || String(fwId),
          ref_id: fw.ref_id || null,
          urn: fw.urn || null,
          requirementCount,
          nodeRefIdsSample,
        });
      }

      sendJSON(res, 200, {
        grcApi: GRC_API_URL,
        totalComplianceAssessments: cas.length,
        totalFrameworks: frameworks.length,
        audits,
        frameworks: frameworkSummaries,
      });
    } catch (err) {
      console.error('[DataStudio] diagnose-grc-audits:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to diagnose GRC audits.' });
    }
    return;
  }

  if (url.pathname === '/api/data-studio/import-applied-controls' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { fileName, data, folder, complianceAssessment } = body;
      const linkOnly = body.linkOnly === true || body.mode === 'link_only';
      // STEP 2 default: PATCH the existing requirement-assessment looked up by
      // (compliance_assessment, requirement.ref_id). RAs are auto-generated by GRC
      // when an audit is created (RequirementAssessment.bulk_create off the framework
      // — see mhrsd_sync_to_grc.py and CISO Assistant models.py:6077-6110), so POSTing
      // /api/requirement-assessments/ would produce duplicates of rows that already
      // exist. Callers can opt back into POST-first by sending body.allowRaPost: true.
      // body.skipRaPost: true is still honored as the explicit "PATCH-only" flag.
      const preferPostFirst =
        body.allowRaPost === true && body.skipRaPost !== true;
      // Qyias assessable standards are 3 levels (e.g. 5.1.1) while MHRSD rows often use 4+ (5.1.1.1).
      // Default ON: resolve those to the parent standard’s requirement assessment. Opt out: body.rollUpUnknownRefs === false.
      const rollUpUnknownRefs = body.rollUpUnknownRefs !== false;
      let complianceAssessmentId =
        complianceAssessment && typeof complianceAssessment === 'string' && complianceAssessment.trim()
          ? complianceAssessment.trim()
          : null;
      // Caller-supplied framework UUID for the auto-create-audit fallback. When set, we skip the
      // expensive framework-scan and POST the new audit directly from this framework.
      const explicitFrameworkUuid =
        body.framework && typeof body.framework === 'string' && body.framework.trim()
          ? body.framework.trim()
          : null;
      // Optional perimeter UUID to forward into the audit POST.
      const explicitPerimeterUuid =
        body.perimeter && typeof body.perimeter === 'string' && body.perimeter.trim()
          ? body.perimeter.trim()
          : null;
      if (!folder || typeof folder !== 'string') {
        sendJSON(res, 400, { error: 'folder (UUID) is required.' });
        return;
      }
      if (!data || typeof data !== 'string') {
        sendJSON(res, 400, { error: 'data (base64) is required.' });
        return;
      }
      const lower = String(fileName || '').toLowerCase();
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls') && !lower.endsWith('.csv')) {
        sendJSON(res, 400, { error: 'Only Excel (.xlsx, .xls) or CSV files are supported.' });
        return;
      }
      let fileBuffer;
      try {
        fileBuffer = Buffer.from(data, 'base64');
      } catch {
        sendJSON(res, 400, { error: 'Invalid base64 payload.' });
        return;
      }
      const parsed = dsParseWorkbookToNormalizedRows(fileBuffer);
      if (parsed.error) {
        sendJSON(res, 400, { error: parsed.error });
        return;
      }
      const { rows, sheetName } = parsed;
      const created = [];
      const errors = [];

      let raCountInCA = 0;
      let raIndexedRefIds = 0;
      let auditRefIdSample = [];
      const linkErrors = [];
      let complianceAssessmentName = null;
      let complianceAssessmentAutoSelected = false;
      let complianceAssessmentAutoCreated = false;
      let autoCreatedFramework = null;
      let autoCreatedFrameworkScore = null;

      const rowsWantRefLink = rows.some(r => dsNormalizeRefId(r.ref_id));

      const autoPickCa =
        body.autoPickComplianceAssessment !== false &&
        !complianceAssessmentId &&
        rowsWantRefLink;

      // Default ON: when no audit matches, auto-create one from the best framework so STEP 2 has something to PATCH.
      // Opt out with body.autoCreateAuditIfMissing === false.
      const autoCreateAuditEnabled =
        body.autoCreateAuditIfMissing !== false && rowsWantRefLink;

      if (autoPickCa) {
        console.log('[DataStudio] autoPickComplianceAssessment: scanning GRC audits for best كود المتطلب match…');
        const pick = await dsPickComplianceAssessmentForRows(rows, GRC_API_URL, reqToken, res);
        if (pick === null) return;
        if (pick.caId && pick.score > 0) {
          complianceAssessmentId = pick.caId;
          complianceAssessmentName = pick.caName;
          complianceAssessmentAutoSelected = true;
          console.log(
            `[DataStudio] Auto-selected audit "${pick.caName}" (${pick.caId}) — ${pick.score}/${pick.rowsWithRef} sheet rows match requirement refs in this audit`
          );
        } else {
          console.log(
            `[DataStudio] Auto-pick found no audit with overlapping requirement refs (${pick.rowsWithRef} rows in sheet have كود المتطلب).`
          );
        }
      }

      // ─── Auto-create audit fallback ──────────────────────────
      // No CA in scope, but we have rows with ref_ids. Two paths:
      //   (a) Caller supplied body.framework → POST a placeholder audit from
      //       THAT framework directly (skip the scan).
      //   (b) Otherwise scan GRC frameworks and pick the one whose requirement
      //       nodes overlap the sheet best.
      // GRC's create_requirement_assessments() bulk-inserts one RA per
      // requirement on insert, giving STEP 2 a target to PATCH.
      // ─────────────────────────────────────────────────────────
      if (!complianceAssessmentId && autoCreateAuditEnabled) {
        let frameworkForAudit = null;
        if (explicitFrameworkUuid) {
          // Resolve framework name (best-effort) and skip the scan entirely.
          let fwName = '';
          try {
            const fwRes = await grcFetch(
              `${GRC_API_URL}/api/frameworks/${encodeURIComponent(explicitFrameworkUuid)}/`,
              {},
              reqToken
            );
            if (fwRes.ok) {
              const fwData = await fwRes.json();
              fwName = fwData.name || fwData.ref_id || '';
            } else if (await finalizeGrcUpstreamError(res, reqToken, fwRes)) {
              return;
            }
          } catch (_) { /* non-fatal — name is cosmetic */ }
          frameworkForAudit = { id: explicitFrameworkUuid, name: fwName };
          autoCreatedFramework = { id: explicitFrameworkUuid, name: fwName || null };
          autoCreatedFrameworkScore = 'caller-specified';
          console.log(
            `[DataStudio] Using caller-supplied framework "${fwName || explicitFrameworkUuid}" for auto-create-audit (no scan).`
          );
        } else {
          console.log('[DataStudio] No audit matched — scanning GRC frameworks to auto-create a host audit…');
          const fwPick = await dsPickFrameworkForRows(rows, GRC_API_URL, reqToken, res);
          if (fwPick === null) return;
          if (fwPick.framework && fwPick.score > 0) {
            frameworkForAudit = fwPick.framework;
            autoCreatedFramework = {
              id: fwPick.framework.id || fwPick.framework.uuid,
              name: fwPick.framework.name || fwPick.framework.ref_id || null,
            };
            autoCreatedFrameworkScore = `${fwPick.score}/${fwPick.rowsWithRef}`;
            console.log(
              `[DataStudio] Best framework match: "${autoCreatedFramework.name || autoCreatedFramework.id}" (${fwPick.score}/${fwPick.rowsWithRef}). Creating audit…`
            );
          } else {
            console.log(
              `[DataStudio] No framework found whose requirement-node ref_ids overlap the sheet. STEP 2 will be skipped. Load the matching library into GRC, then re-run.`
            );
          }
        }

        if (frameworkForAudit) {
          const newCA = await dsCreateComplianceAssessmentForFramework({
            framework: frameworkForAudit,
            folder,
            perimeter: explicitPerimeterUuid,
            name: typeof body.autoCreatedAuditName === 'string' && body.autoCreatedAuditName.trim()
              ? body.autoCreatedAuditName.trim()
              : null,
            grcUrl: GRC_API_URL,
            reqToken,
            res,
            linkErrors,
          });
          if (newCA) {
            complianceAssessmentId = newCA.id || newCA.uuid;
            complianceAssessmentName = newCA.name || `${autoCreatedFramework.name || 'Framework'} – Controls Catalog`;
            complianceAssessmentAutoCreated = true;
          } else {
            console.warn(
              `[DataStudio] Auto-create CA failed for framework "${autoCreatedFramework.name || autoCreatedFramework.id}". STEP 2 will be skipped — see linkErrors for the GRC response.`
            );
          }
        }
      }

      if (linkOnly && !complianceAssessmentId) {
        sendJSON(res, 400, {
          error:
            'linkOnly needs a compliance assessment: paste audit UUID, leave Auto-pick on so an existing audit can be selected, or leave Auto-create on so a host audit can be made from the best-matching framework (no framework matched in your GRC — load the library first).',
        });
        return;
      }

      if (complianceAssessmentId) {
        const metaRes = await grcFetch(
          `${GRC_API_URL}/api/compliance-assessments/${encodeURIComponent(complianceAssessmentId)}/`,
          {},
          reqToken
        );
        if (metaRes.ok) {
          try {
            const meta = await metaRes.json();
            complianceAssessmentName = meta.name || meta.basename || '';
          } catch (_) { /* ignore */ }
        }
        console.log(
          `[DataStudio] RA linking: audit ${complianceAssessmentId} — per row: POST requirement-assessment when possible, else PATCH existing RA`
        );
      } else if (rowsWantRefLink) {
        console.log('[DataStudio] No complianceAssessment in request — creating controls only (folder + name); add audit UUID to link RAs.');
      }

      console.log(
        '[DataStudio] import:',
        linkOnly ? 'linkOnly (match existing controls + link RAs)' : 'create applied controls',
        '| complianceAssessmentId =',
        complianceAssessmentId || '(none)'
      );

      const excelRefIdSample = [...new Set(rows.map(r => dsNormalizeRefId(r.ref_id)).filter(Boolean))].sort().slice(0, 40);

      let refToRasMap = null;
      if (complianceAssessmentId) {
        const allRAsForCa = await dsFetchAllRequirementAssessmentsForCA(
          complianceAssessmentId,
          GRC_API_URL,
          reqToken,
          res
        );
        if (allRAsForCa === null) return;
        raCountInCA = allRAsForCa.length;
        const built = await dsBuildRefIdToRAsMap(allRAsForCa, GRC_API_URL, reqToken, res);
        if (built === null) return;
        refToRasMap = built.refToRas;
        raIndexedRefIds = built.auditRefIdsDistinct;
        auditRefIdSample = built.auditRefIdSample;
        console.log(
          `[DataStudio] RA index: ${raIndexedRefIds} distinct refs from ${raCountInCA} requirement assessments`
        );
      }

      let linkedAtCreateCount = 0;
      let rowsWithResolvedRa = 0;
      let linkedByPostCount = 0;
      let linkedByPatchCount = 0;
      const raAppliedControlsCache = new Map();

      // ─── ROW-BY-ROW EXECUTION ────────────────────────────────
      // For every Excel row we do the full POST-then-LINK cycle in order
      // before moving on to the next row:
      //   STEP 1 — POST /api/applied-controls/ (or, in linkOnly mode,
      //            match an existing one by ref_id) → capture UUID.
      //   STEP 2 — using that fresh UUID immediately POST
      //            /api/requirement-assessments/ to attach the requirement
      //            (falls back to PATCH on an existing RA).
      // Each row appends one entry to phase1[] (the UUID resolution) and,
      // when a compliance assessment is in scope and a UUID was obtained,
      // one entry to phase2[] (the RA link). This keeps both arrays for
      // reporting while preserving the row-by-row execution order so a
      // partial run leaves earlier rows fully committed (control + RA).
      // ─────────────────────────────────────────────────────────
      const phase1 = [];
      const phase2 = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowCtx = { row: i + 2, ref_id: row.ref_id || '', name: row.name || '' };

        // STEP 1 — resolve applied-control UUID for this row
        let controlId = null;
        let createdMode = null;

        if (!row.name) {
          const eMsg = 'Missing control name (اسم الكنترول / name)';
          errors.push({ row: rowCtx.row, ref_id: rowCtx.ref_id, error: eMsg });
          phase1.push({ ...rowCtx, controlId: null, mode: linkOnly ? 'match_skipped' : 'create_skipped', error: eMsg });
          continue;
        }

        if (linkOnly) {
          if (!dsNormalizeRefId(row.ref_id)) {
            const eMsg = 'linkOnly requires كود المتطلب / ref_id on each row to find the existing applied control.';
            errors.push({ row: rowCtx.row, ref_id: rowCtx.ref_id, error: eMsg });
            phase1.push({ ...rowCtx, controlId: null, mode: 'match_failed', error: eMsg });
            continue;
          }
          const foundAc = await dsFindAppliedControlIdForRefInFolder(
            folder,
            row.ref_id,
            GRC_API_URL,
            reqToken,
            res,
            linkErrors,
            { row: rowCtx.row, ref_id: rowCtx.ref_id }
          );
          if (foundAc === null) return;
          if (!foundAc.length) {
            const eMsg = 'No applied control in this folder with ref_id matching كود المتطلب (tried API filters + folder list scan).';
            errors.push({ row: rowCtx.row, ref_id: rowCtx.ref_id, error: eMsg });
            phase1.push({ ...rowCtx, controlId: null, mode: 'match_failed', error: eMsg });
            continue;
          }
          controlId = foundAc[0];
          createdMode = 'matched_existing';
          created.push({ ref_id: row.ref_id, id: controlId, name: row.name, linkOnly: true });
          phase1.push({ ...rowCtx, controlId, mode: createdMode });
          console.log(
            `[DataStudio] Row ${rowCtx.row} (${rowCtx.ref_id || '—'}) STEP 1 matched existing control ${controlId}`
          );
        } else {
          const grcBody = {
            name: row.name,
            description: row.description || '',
            folder,
            status: 'to_do',
            csf_function: 'govern',
          };
          if (row.ref_id) grcBody.ref_id = row.ref_id;

          try {
            const grcRes = await grcFetch(`${GRC_API_URL}/api/applied-controls/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(grcBody),
            }, reqToken);
            if (!grcRes.ok) {
              const errIn = await consumeGrcErrorBody(res, reqToken, grcRes);
              if (errIn.aborted) return;
              const eMsg = errIn.errText.slice(0, 800);
              errors.push({ row: rowCtx.row, ref_id: rowCtx.ref_id, error: eMsg });
              phase1.push({ ...rowCtx, controlId: null, mode: 'create_failed', error: eMsg });
              continue;
            }
            const createdObj = await grcRes.json();
            controlId = createdObj.id || createdObj.uuid;
            createdMode = 'created';
            created.push({ ref_id: row.ref_id, id: controlId, name: row.name });
            phase1.push({ ...rowCtx, controlId, mode: createdMode });
            console.log(
              `[DataStudio] Row ${rowCtx.row} (${rowCtx.ref_id || '—'}) STEP 1 POST applied-control → UUID ${controlId}`
            );
          } catch (e) {
            errors.push({ row: rowCtx.row, ref_id: rowCtx.ref_id, error: e.message });
            phase1.push({ ...rowCtx, controlId: null, mode: 'create_failed', error: e.message });
            continue;
          }
        }

        // STEP 2 — immediately link this row's UUID to its requirement assessment
        if (!controlId || !complianceAssessmentId || !dsNormalizeRefId(row.ref_id)) {
          continue;
        }
        try {
          const lr = await dsRowLinkAppliedControlToRequirement({
            controlId,
            complianceAssessmentId,
            rowRef: row.ref_id,
            refToRasMap,
            grcUrl: GRC_API_URL,
            reqToken,
            res,
            linkErrors,
            ctx: { row: rowCtx.row, ref_id: rowCtx.ref_id, rollUpUnknownRefs },
            raControlsCache: raAppliedControlsCache,
            preferPostFirst,
            raIndexedRefIds,
          });
          if (lr.aborted) return;
          if (lr.linked) {
            linkedAtCreateCount++;
            rowsWithResolvedRa++;
            if (lr.mode === 'post_requirement_assessment') linkedByPostCount++;
            else if (lr.mode === 'patch_existing_ra') linkedByPatchCount++;
          }
          phase2.push({
            row: rowCtx.row,
            ref_id: rowCtx.ref_id,
            controlId,
            raId: lr.raId || null,
            linked: !!lr.linked,
            mode: lr.mode || null,
          });
          console.log(
            `[DataStudio] Row ${rowCtx.row} (${rowCtx.ref_id}) STEP 2 ${
              lr.linked
                ? `linked control ${controlId} ⇄ RA ${lr.raId || '?'} (${lr.mode})`
                : 'link FAILED — see linkErrors'
            }`
          );
        } catch (e) {
          errors.push({ row: rowCtx.row, ref_id: rowCtx.ref_id || '', error: e.message });
          phase2.push({
            row: rowCtx.row,
            ref_id: rowCtx.ref_id,
            controlId,
            raId: null,
            linked: false,
            mode: null,
            error: e.message,
          });
        }
      }

      const phase1Resolved = phase1.filter(p => p.controlId).length;
      console.log(
        `[DataStudio] Done: ${phase1Resolved}/${phase1.length} rows resolved a control UUID; ${linkedAtCreateCount}/${phase2.length} linked (POST: ${linkedByPostCount}, PATCH: ${linkedByPatchCount}).`
      );
      if (!complianceAssessmentId) {
        console.log('[DataStudio] STEP 2 skipped on every row: no compliance assessment in scope (controls created without RA links).');
      }

      const refIdOverlapCount = rowsWithResolvedRa;

      const linkWarnings = [];
      if (!complianceAssessmentId && rowsWantRefLink) {
        if (autoCreateAuditEnabled) {
          linkWarnings.push(
            'Auto-create-audit was on but no GRC framework had requirement-node ref_ids overlapping this sheet — load the matching library into GRC, then re-run.'
          );
        } else if (autoPickCa) {
          linkWarnings.push(
            'Auto-pick did not find a GRC audit whose requirement refs overlap this sheet, and auto-create is disabled. Enable Auto-create or paste an audit UUID.'
          );
        } else {
          linkWarnings.push(
            'No audit UUID, auto-pick disabled, auto-create disabled — controls were created without requirement assessment links. Enable Auto-create or paste an audit UUID.'
          );
        }
      }
      if (complianceAssessmentAutoCreated && complianceAssessmentId) {
        linkWarnings.push(
          `Auto-created host audit "${complianceAssessmentName}" (${complianceAssessmentId}) from framework "${(autoCreatedFramework && autoCreatedFramework.name) || (autoCreatedFramework && autoCreatedFramework.id) || '?'}" — requirement-assessments were auto-generated by GRC and STEP 2 is PATCHing them.`
        );
      } else if (complianceAssessmentId && complianceAssessmentName) {
        linkWarnings.push(`Requirement links use audit: ${complianceAssessmentName} (${complianceAssessmentId})`);
      }
      if (linkOnly) {
        linkWarnings.push(
          preferPostFirst
            ? 'linkOnly: matched existing applied controls by ref_id; per row: POST requirement-assessment when allowRaPost is set, else PATCH existing RA.'
            : 'linkOnly: matched existing applied controls by ref_id; per row: PATCH the existing RA (compliance_assessment + requirement.ref_id) to attach the control. No new RAs are created.'
        );
      }
      if (!preferPostFirst && complianceAssessmentId) {
        linkWarnings.push(
          'STEP 2 mode: PATCH-only on existing requirement-assessments (RAs are auto-generated by GRC when an audit is created — see CISO Assistant ComplianceAssessment.create_requirement_assessments).'
        );
      }
      if (rollUpUnknownRefs) {
        linkWarnings.push(
          'Requirement ref roll-up is ON: fully numeric dotted codes (e.g. 5.1.1.1) link to the nearest parent ref that exists on the audit (e.g. 5.1.1). Send rollUpUnknownRefs: false to disable.'
        );
      }

      const newControlsCount = linkOnly ? 0 : created.filter(c => !c.linkOnly).length;
      const matchedExistingCount = linkOnly ? created.length : 0;

      const phase2Attempted = phase2.length;
      const phase2LinkErrors = phase2.filter(p => !p.linked).length;

      const step2Desc = preferPostFirst
        ? 'STEP 2 per row — POST /api/requirement-assessments/ using STEP 1 UUID, fallback PATCH existing RA (allowRaPost mode — may create duplicates of GRC-auto-generated RAs)'
        : 'STEP 2 per row — PATCH the existing /api/requirement-assessments/ found by (compliance_assessment, requirement.ref_id) to attach the STEP 1 UUID (no RA POSTs — matches mhrsd_sync_to_grc.py and CISO Assistant data model)';

      const phases = {
        executionMode: 'row_by_row',
        description:
          'Each row runs STEP 1 (POST applied control / match existing) → STEP 2 (PATCH the existing requirement-assessment to attach the STEP 1 UUID) before the next row starts.',
        phase1: {
          name: linkOnly
            ? 'STEP 1 per row — match existing applied control by ref_id (no POST)'
            : 'STEP 1 per row — POST /api/applied-controls/ and capture UUID',
          attempted: phase1.length,
          resolved: phase1Resolved,
          failed: phase1.length - phase1Resolved,
          mode: linkOnly ? 'match_existing' : 'create_new',
        },
        phase2: {
          name: step2Desc,
          ranAgainstAudit: complianceAssessmentId || null,
          attempted: phase2Attempted,
          linked: linkedAtCreateCount,
          failed: complianceAssessmentId ? phase2LinkErrors : 0,
          rollUpUnknownRefs,
          skippedReason: complianceAssessmentId
            ? null
            : 'No compliance assessment in scope — STEP 2 skipped on every row. Only applied controls were imported (the --skip-link case in mhrsd_sync_to_grc.py).',
          breakdown: {
            via_patch_existing_ra: linkedByPatchCount,
            via_post_requirement_assessment: linkedByPostCount,
          },
          raPostAllowed: preferPostFirst,
        },
      };

      const importResponse = {
        success: errors.length === 0,
        linkOnly,
        rollUpUnknownRefs,
        preferPostRequirementAssessment: preferPostFirst,
        autoPickComplianceAssessmentOffered: autoPickCa,
        autoCreateAuditOffered: autoCreateAuditEnabled,
        grcApi: GRC_API_URL,
        sheetName,
        totalParsed: rows.length,
        complianceAssessmentId,
        complianceAssessmentName: complianceAssessmentName || null,
        complianceAssessmentAutoSelected,
        complianceAssessmentAutoCreated,
        autoCreatedFramework,
        autoCreatedFrameworkScore,
        linkWarnings,
        createdCount: newControlsCount,
        matchedExistingCount,
        failedCount: errors.length,
        linkedAtCreateCount,
        linkedByPostCount,
        linkedByPatchCount,
        raCountInCA,
        raIndexedRefIds,
        refIdOverlapCount,
        auditRefIdSample,
        excelRefIdSample,
        refIdMatchHint:
          complianceAssessmentId && rowsWantRefLink && refIdOverlapCount === 0 && excelRefIdSample.length
            ? 'No rows got a requirement assessment via requirement__ref_id for this audit. Check framework ref_ids in GRC match column كود المتطلب.'
            : null,
        created,
        errors,
        linkErrors: linkErrors.length ? linkErrors.slice(0, 200) : [],
        phases,
        phase1,
        phase2,
      };
      console.log('[DataStudio] import-applied-controls response:', {
        ...importResponse,
        phase1: `[${phase1.length} entries]`,
        phase2: `[${phase2.length} entries]`,
        created: `[${created.length} entries]`,
      });
      sendJSON(res, 200, importResponse);
    } catch (err) {
      console.error('[DataStudio] import-applied-controls:', err);
      sendJSON(res, 500, { error: err.message || 'Import failed.' });
    }
    return;
  }

  // ---- AI Tools: Policy update pipeline (F1–F4, Gemini) ----
  if (url.pathname === '/api/ai-tools/policy-update-pipeline' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];
      if (!apiKey) {
        sendJSON(res, 401, { error: 'API key not configured. Add GEMINI_API_KEY to .env file.' });
        return;
      }
      const orgContext = body.orgContext != null ? String(body.orgContext) : '';
      const regulationText = body.regulationText != null ? String(body.regulationText) : '';
      const policies = Array.isArray(body.policies) ? body.policies : [];
      if (!regulationText.trim()) {
        sendJSON(res, 400, { error: 'regulationText is required.' });
        return;
      }
      const result = await runPolicyUpdatePipeline({
        apiKey,
        orgContext,
        regulationText,
        policies,
        overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : undefined,
      });
      sendJSON(res, 200, { success: true, data: result });
    } catch (err) {
      console.error('[PolicyUpdatePipeline]', err);
      sendJSON(res, 500, { error: err.message || 'Pipeline failed.' });
    }
    return;
  }

  // ---- Analyze API ----
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      console.log('Received analysis request');
      
      const { requirement, requirements, prompt, contextFiles } = body;
      
      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];

      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured. Add GEMINI_API_KEY to .env file.' }));
        return;
      }

      if (contextFiles && contextFiles.length > 0) {
        console.log(`Context files attached: ${contextFiles.length} (${contextFiles.map(f => f.name).join(', ')})`);
      }

      if (requirements && Array.isArray(requirements) && requirements.length > 0) {
        console.log(`Batch analysis for ${requirements.length} requirements`);
        const result = await callGeminiAPIForMultiple(requirements, prompt, apiKey, contextFiles);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: result }));
        return;
      }
      
      if (!requirement) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Requirement(s) required.' }));
        return;
      }

      const result = await callGeminiAPIForSingle(requirement, prompt, apiKey, contextFiles);
      let promptTemplateVersion = null;
      try {
        const stat = fs.statSync(promptTemplatePath);
        promptTemplateVersion = stat.mtime.toISOString();
      } catch (_) {}
      const templateMeta = {
        model: 'gemini-2.5-pro',
        prompt_template: 'requirement-analyzer',
        prompt_template_version: promptTemplateVersion
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result, meta: templateMeta }));
    } catch (error) {
      console.error('Analyze API Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Controls Generation API ----
  if (url.pathname === '/api/controls/generate' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { requirements, orgContext, contextFiles } = body;

      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured. Add GEMINI_API_KEY to .env file.' }));
        return;
      }

      // Block generation if no org profile
      if (!orgContext || !orgContext.nameEn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Organization Profile is required. Please select or create an Organization Profile before generating controls.' }));
        return;
      }

      if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'At least one requirement is needed.' }));
        return;
      }

      console.log(`[Controls] Generating controls for ${requirements.length} requirements` +
        ` (org: ${orgContext.nameEn}, sector: ${orgContext.sectorCustom || orgContext.sector || 'N/A'}, maturity: ${orgContext.complianceMaturity || 'N/A'})` +
        (contextFiles?.length ? `, ${contextFiles.length} context files` : ''));

      const result = await generateControlsBatch(requirements, orgContext, contextFiles, apiKey);

      console.log(`[Controls] Done: ${result.controls.length} controls generated, ${result.progress.failed} reqs failed`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));
    } catch (error) {
      console.error('[Controls] Generate API Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Question-to-Control Conversion API ----
  if (url.pathname === '/api/controls/from-question' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { question, requirement, orgContext } = body;

      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured.' }));
        return;
      }

      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Question is required.' }));
        return;
      }

      if (!orgContext || !orgContext.nameEn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Organization Profile is required to convert questions to controls.' }));
        return;
      }

      console.log(`[Q2Control] Converting question for org "${orgContext.nameEn}": "${question.substring(0, 80)}..."`);
      const control = await convertQuestionToControl(question, requirement, orgContext, apiKey);
      console.log(`[Q2Control] Generated: "${control.name}"`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, control }));
    } catch (error) {
      console.error('[Q2Control] Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: List frameworks ----
  if (url.pathname === '/api/grc/frameworks' && req.method === 'GET') {
    try {
      const grcRes = await grcFetch(`${GRC_API_URL}/api/frameworks/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Frameworks error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get framework requirement tree ----
  const fwTreeMatch = url.pathname.match(/^\/api\/grc\/frameworks\/([^/]+)\/tree$/);
  if (fwTreeMatch && req.method === 'GET') {
    try {
      const fwId = fwTreeMatch[1];
      const grcRes = await grcFetch(`${GRC_API_URL}/api/frameworks/${fwId}/tree/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tree: data }));
    } catch (error) {
      console.error('[GRC] Framework tree error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get compliance assessment tree (RA UUIDs as keys) ----
  const caTreeMatch = url.pathname.match(/^\/api\/grc\/compliance-assessments\/([^/]+)\/tree$/);
  if (caTreeMatch && req.method === 'GET') {
    try {
      const caId = caTreeMatch[1];
      console.log(`[GRC] Fetching tree for compliance assessment ${caId}`);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/compliance-assessments/${caId}/tree/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tree: data }));
    } catch (error) {
      console.error('[GRC] Compliance assessment tree error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get requirement nodes count for a framework ----
  if (url.pathname === '/api/grc/requirement-nodes' && req.method === 'GET') {
    try {
      const qs = url.search || '';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/requirement-nodes/${qs}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: data.count, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Requirement nodes error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get compliance assessments ----
  if (url.pathname === '/api/grc/compliance-assessments' && req.method === 'GET') {
    try {
      const qs = url.search || '';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/compliance-assessments/${qs}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Compliance assessments error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get / PATCH single applied control ----
  const acItemMatch = url.pathname.match(/^\/api\/grc\/applied-controls\/([^/]+)$/);
  if (acItemMatch && req.method === 'GET') {
    try {
      const acId = acItemMatch[1];
      const grcRes = await grcFetch(`${GRC_API_URL}/api/applied-controls/${acId}/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (error) {
      console.error('[GRC] GET applied-control error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (acItemMatch && req.method === 'PATCH') {
    try {
      const acId = acItemMatch[1];
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/applied-controls/${acId}/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (error) {
      console.error('[GRC] PATCH applied-control error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: List policies (applied controls) ----
  if (url.pathname === '/api/grc/policies' && req.method === 'GET') {
    try {
      const qs = url.search || '';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/applied-controls/${qs ? qs + '&page_size=500' : '?page_size=500'}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Policies error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get organisation objectives ----
  if (url.pathname === '/api/grc/organisation-objectives' && req.method === 'GET') {
    try {
      const grcRes = await grcFetch(`${GRC_API_URL}/api/organisation-objectives/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Organisation objectives error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Create organisation objective ----
  if (url.pathname === '/api/grc/organisation-objectives' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      console.log(`[GRC] Creating organisation objective: "${body.name}"`);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/organisation-objectives/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      console.log(`[GRC] Organisation objective created: ${data.id}`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: data }));
    } catch (error) {
      console.error('[GRC] Create organisation objective error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get metric instances ----
  if (url.pathname === '/api/grc/metric-instances' && req.method === 'GET') {
    try {
      const grcRes = await grcFetch(`${GRC_API_URL}/api/metrology/metric-instances/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Metric instances error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get risk scenarios ----
  if (url.pathname === '/api/grc/risk-scenarios' && req.method === 'GET') {
    try {
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-scenarios/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Risk scenarios error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get folders (with query params) ----
  if (url.pathname === '/api/grc/folders' && req.method === 'GET') {
    try {
      const qs = url.search || '';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/folders/${qs}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, folders: data.results || data }));
    } catch (error) {
      console.error('[GRC] Folders error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Compliance assessment requirements_list ----
  const caReqListMatch = url.pathname.match(/^\/api\/grc\/compliance-assessments\/([^/]+)\/requirements-list$/);
  if (caReqListMatch && req.method === 'GET') {
    try {
      const caId = caReqListMatch[1];
      const qs = url.search || '?assessable=true';
      console.log(`[GRC] Fetching requirements_list for CA ${caId}`);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/compliance-assessments/${caId}/requirements_list/${qs}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...data }));
    } catch (error) {
      console.error('[GRC] Requirements list error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Get requirement assessments ----
  if (url.pathname === '/api/grc/requirement-assessments' && req.method === 'GET') {
    try {
      const qs = url.search || '';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/requirement-assessments/${qs}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Requirement assessments error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: RA audit log ----
  const raAuditMatch = url.pathname.match(/^\/api\/grc\/requirement-assessments\/([^/]+)\/audit-log$/);
  if (raAuditMatch && req.method === 'GET') {
    try {
      const raId = raAuditMatch[1];
      console.log(`[GRC] Fetching audit log for RA ${raId}`);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/requirement-assessments/${raId}/audit-log/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, entries: data }));
    } catch (error) {
      console.error('[GRC] RA audit log error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: GET / PATCH single requirement assessment ----
  const raOneMatch = url.pathname.match(/^\/api\/grc\/requirement-assessments\/([^/]+)$/);
  if (raOneMatch && req.method === 'GET') {
    try {
      const raId = raOneMatch[1];
      const grcRes = await grcFetch(`${GRC_API_URL}/api/requirement-assessments/${raId}/`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (error) {
      console.error('[GRC] GET requirement-assessment error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (raOneMatch && req.method === 'PATCH') {
    try {
      const raId = raOneMatch[1];
      const body = await parseBody(req);
      console.log(`[GRC] PATCH requirement-assessment ${raId}:`, JSON.stringify(body));
      const grcRes = await grcFetch(`${GRC_API_URL}/api/requirement-assessments/${raId}/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (error) {
      console.error('[GRC] PATCH requirement-assessment error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Proxy: Export applied controls ----
  if (url.pathname === '/api/grc/applied-controls' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { controls, folder } = body;
      if (!controls || !Array.isArray(controls) || controls.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No controls to export.' }));
        return;
      }
      console.log(`[GRC Export] Exporting ${controls.length} controls${folder ? ` to folder ${folder}` : ' (root folder)'}`);

      const prioMap = { critical: 1, high: 2, medium: 3, low: 4 };
      const effortMap = { low: 'S', small: 'S', s: 'S', medium: 'M', m: 'M', high: 'L', large: 'L', l: 'L', 'extra-large': 'XL', xl: 'XL' };

      const results = [];
      const errors = [];

      // ── Phase 1: POST all applied controls to GRC ──
      // Pre-fetch existing applied controls to handle duplicates
      let existingControls = [];
      try {
        const listRes = await grcFetch(`${GRC_API_URL}/api/applied-controls/?page_size=1000`, {}, reqToken);
        if (await finalizeGrcUpstreamError(res, reqToken, listRes)) return;
        if (listRes.ok) {
          const listData = await listRes.json();
          existingControls = Array.isArray(listData.results) ? listData.results : [];
          console.log(`[GRC Export] Fetched ${existingControls.length} existing applied controls`);
        }
      } catch (_) {}

      for (let i = 0; i < controls.length; i++) {
        const c = controls[i];
        try {
          const grcBody = {
            name: c.name || c.name_ar || 'Untitled Control',
            description: c.description || c.description_ar || '',
            status: c.status || 'to_do',
            priority: typeof c.priority === 'number' ? c.priority : (prioMap[(c.priority || c.implementation_priority || 'medium').toLowerCase()] || 3),
            category: c.category || c.control_type || '',
            csf_function: c.csf_function || c.csfFunction || '',
            effort: effortMap[(c.effort || c.effort_estimate || 'M').toLowerCase()] || c.effort || 'M',
          };
          if (c.ref_id) grcBody.ref_id = c.ref_id;

          // Only include folder if provided (otherwise GRC uses root folder)
          if (folder) grcBody.folder = folder;

          console.log(`[GRC Export] ${i + 1}/${controls.length}: POST "${grcBody.name}" (priority: ${grcBody.priority}, category: ${grcBody.category})`);

          const grcRes = await grcFetch(`${GRC_API_URL}/api/applied-controls/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(grcBody)
          }, reqToken);

          // Collect requirement node IDs this control is linked to
          const controlReqNodeIds = (c.linkedRequirements || []).map(r => r.nodeId).filter(Boolean);
          // Fallback to legacy single field
          if (controlReqNodeIds.length === 0 && c.requirementNodeId) controlReqNodeIds.push(c.requirementNodeId);

          if (grcRes.ok) {
            const created = await grcRes.json();
            results.push({
              controlId: c.id,
              grcId: created.id,
              name: grcBody.name,
              success: true,
              requirementNodeIds: controlReqNodeIds,
              linkedRA: []
            });
          } else {
            let errText = '';
            try {
              if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
            } catch (e) {
              const m = e.message || '';
              errText = m.replace(/^GRC API \d+: /, '') || m;
            }
            // If duplicate name error, find existing control and reuse its UUID
            const isDuplicate = grcRes.status === 400 && errText.includes('already used');

            if (isDuplicate) {
              const existing = existingControls.find(ec => ec.name === grcBody.name);
              if (existing) {
                console.log(`[GRC Export] "${grcBody.name}" already exists (${existing.id}) — reusing`);
                results.push({
                  controlId: c.id,
                  grcId: existing.id,
                  name: grcBody.name,
                  success: true,
                  reused: true,
                  requirementNodeIds: controlReqNodeIds,
                  linkedRA: []
                });
              } else {
                console.warn(`[GRC Export] "${grcBody.name}" is duplicate but not found in existing list`);
                errors.push({ controlId: c.id, name: c.name, error: errText });
              }
            } else {
              throw new Error(`${grcRes.status}: ${errText}`);
            }
          }
        } catch (err) {
          console.error(`[GRC Export] Failed "${c.name}":`, err.message);
          errors.push({ controlId: c.id, name: c.name, error: err.message });
        }
      }

      console.log(`[GRC Export] Phase 1 done: ${results.length} controls created, ${errors.length} failed`);

      // ── Phase 2: Link applied controls to requirement assessments ──
      // Each control is linked ONLY to the requirement(s) it was generated for,
      // NOT to all requirements indiscriminately.
      let totalLinked = 0;

      // Build a map: requirementNodeId → [grcId, grcId, ...] (only controls for THAT requirement)
      const reqNodeToControlGrcIds = new Map();
      for (const r of results) {
        if (!r.grcId) continue;
        for (const nodeId of (r.requirementNodeIds || [])) {
          if (!nodeId) continue;
          if (!reqNodeToControlGrcIds.has(nodeId)) reqNodeToControlGrcIds.set(nodeId, []);
          const list = reqNodeToControlGrcIds.get(nodeId);
          if (!list.includes(r.grcId)) list.push(r.grcId);
        }
      }

      const selectedReqNodeIds = [...reqNodeToControlGrcIds.keys()];

      if (selectedReqNodeIds.length === 0) {
        console.log(`[GRC Link] No requirement UUIDs on controls — skipping`);
      } else {
        console.log(`[GRC Link] Linking controls to ${selectedReqNodeIds.length} requirement(s) (targeted per-requirement)`);

        try {
          // Step 1: Fetch ALL compliance assessments
          const caRes = await grcFetch(`${GRC_API_URL}/api/compliance-assessments/`, {}, reqToken);
          if (await finalizeGrcUpstreamError(res, reqToken, caRes)) return;
          const caData = await caRes.json();
          const allCAs = Array.isArray(caData.results) ? caData.results : [];
          console.log(`[GRC Link] Found ${allCAs.length} compliance assessment(s)`);

          // Step 2: Loop over each CA, fetch its RAs, filter & PATCH
          for (const ca of allCAs) {
            const caId = ca.id || ca.uuid;
            if (!caId) continue;

            let allRAs = [];
            let raUrl = `${GRC_API_URL}/api/requirement-assessments/?compliance_assessment=${caId}&page_size=1000`;
            while (raUrl) {
              const raRes = await grcFetch(raUrl, {}, reqToken);
              if (!raRes.ok) {
                try {
                  if (await finalizeGrcUpstreamError(res, reqToken, raRes)) return;
                } catch (_) {
                  console.warn(`[GRC Link] Failed to fetch RAs for CA ${caId}: ${raRes.status}`);
                  break;
                }
              }
              const raData = await raRes.json();
              allRAs = allRAs.concat(Array.isArray(raData.results) ? raData.results : []);
              raUrl = raData.next || null;
            }

            // Step 3: Filter — match RA.requirement to selected requirement nodes, skip done
            const targetRAs = allRAs.filter(ra => {
              const reqId = typeof ra.requirement === 'string' ? ra.requirement : (ra.requirement?.id || '');
              return selectedReqNodeIds.includes(reqId) && ra.status !== 'done';
            });

            if (targetRAs.length === 0) continue;
            console.log(`[GRC Link] CA ${ca.name || caId}: ${targetRAs.length} matching RA(s) from ${allRAs.length} total`);

            // Step 4: PATCH each matching RA — link ONLY the controls generated for that specific requirement
            for (const ra of targetRAs) {
              const raId = ra.id || ra.uuid;
              if (!raId) continue;

              const raReqId = typeof ra.requirement === 'string' ? ra.requirement : (ra.requirement?.id || '');
              const controlGrcIdsForThisReq = reqNodeToControlGrcIds.get(raReqId) || [];
              if (controlGrcIdsForThisReq.length === 0) continue;

              try {
                // Preserve existing linked controls
                const existingRaw = Array.isArray(ra.applied_controls) ? ra.applied_controls : [];
                const existingIds = existingRaw.map(ac =>
                  typeof ac === 'object' && ac !== null ? (ac.id || ac.uuid || '') : String(ac)
                ).filter(Boolean);
                const merged = [...new Set([...existingIds, ...controlGrcIdsForThisReq])];

                const newCount = merged.length - existingIds.length;
                if (newCount === 0) {
                  console.log(`[GRC Link] RA ${raId} — all ${controlGrcIdsForThisReq.length} controls already linked, skipping`);
                  continue;
                }
                console.log(`[GRC Link] PATCH RA ${raId} ← ${newCount} new (${controlGrcIdsForThisReq.length} for this req), ${merged.length} total applied_controls`);

                const patchRes = await grcFetch(`${GRC_API_URL}/api/requirement-assessments/${raId}/`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ applied_controls: merged })
                }, reqToken);

                if (patchRes.ok) {
                  console.log(`[GRC Link] ✓ RA ${raId} linked`);
                  totalLinked++;
                } else {
                  try {
                    if (await finalizeGrcUpstreamError(res, reqToken, patchRes)) return;
                  } catch (e) {
                    const errText = (e.message || '').replace(/^GRC API \d+: /, '');
                    console.warn(`[GRC Link] Failed PATCH RA ${raId}: ${patchRes.status} ${errText}`);
                  }
                }
              } catch (patchErr) {
                console.warn(`[GRC Link] Error on RA ${raId}:`, patchErr.message);
              }
            }
          }
        } catch (fetchErr) {
          console.error(`[GRC Link] Error:`, fetchErr.message);
        }
      }

      console.log(`[GRC Export] Done: ${results.length} created, ${errors.length} failed, ${totalLinked} RAs linked`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: errors.length === 0,
        exported: results.length,
        failed: errors.length,
        linked: totalLinked,
        results,
        errors
      }));
    } catch (error) {
      console.error('[GRC Export] Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC Platform Config Check ----
  if (url.pathname === '/api/grc/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configured: true,
      url: GRC_API_URL,
    }));
    return;
  }

  // ---- List all chat sessions ----
  if (url.pathname === '/api/chat/sessions' && req.method === 'GET') {
    try {
      const rows = dbListSessions.all();
      const sessions = rows.map(row => {
        const ctx = JSON.parse(row.context || '{}');
        const reqs = ctx.requirements || [];
        const files = ctx.fileResources || [];
        const query = ctx.query || '';

        return {
          sessionId: row.id,
          createdAt: row.created_at,
          query,
          messageCount: row.message_count,
          requirementsCount: reqs.length,
          filesCount: files.length,
          collectionsCount: (ctx.collections || []).length,
          requirements: reqs.map(r => ({
            refId: r.refId || '',
            description: r.description || r.name || '',
            frameworkName: r.frameworkName || ''
          })),
          collections: (ctx.collections || []).map(c => ({
            storeId: c.storeId,
            displayName: c.displayName || c.storeId
          })),
          fileResources: files.map(f => ({
            storeId: f.storeId,
            fileId: f.fileId,
            documentName: f.documentName || ''
          }))
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessions }));
    } catch (error) {
      console.error('List sessions error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Get chat session history ----
  const sessionMatch = url.pathname.match(/^\/api\/chat\/sessions\/([0-9a-f-]+)$/);
  if (sessionMatch && req.method === 'GET') {
    try {
      const sessionId = sessionMatch[1];
      const row = dbGetSession.get(sessionId);

      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found.' }));
        return;
      }

      // Get history from DB
      const messages = dbGetMessages.all(sessionId);
      const history = messages.map(m => ({
        role: m.role,
        text: m.text
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        sessionId,
        createdAt: row.created_at,
        context: JSON.parse(row.context || '{}'),
        history
      }));
    } catch (error) {
      console.error('Get session error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Delete chat session ----
  if (sessionMatch && req.method === 'DELETE') {
    try {
      const sessionId = sessionMatch[1];
      const row = dbGetSession.get(sessionId);

      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found.' }));
        return;
      }

      // Delete messages first, then session
      dbDeleteSessionMessages.run(sessionId);
      dbDeleteSession.run(sessionId);

      // Remove from in-memory cache
      delete chatSessions[sessionId];

      console.log(`Session deleted: ${sessionId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Delete session error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Create new chat session ----
  if (url.pathname === '/api/chat/sessions' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { context } = body;
      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];

      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured.' }));
        return;
      }

      // Lazy-init the SDK client
      if (!genai) {
        genai = new GoogleGenAI({ apiKey });
      }

      // Generate proper UUID
      const sessionId = crypto.randomUUID();

      // Build the system instruction from context (read from DB)
      let systemPrompt = getChatAuditorPrompt();

      if (context) {
        // Inject selected requirements with full details
        if (context.requirements && context.requirements.length > 0) {
          systemPrompt += `\n\n---\n## SESSION CONTEXT: Selected Requirements (${context.requirements.length} total)\n`;
          const groupedByFramework = {};
          context.requirements.forEach(r => {
            const fw = r.frameworkName || 'Unknown Framework';
            if (!groupedByFramework[fw]) groupedByFramework[fw] = [];
            groupedByFramework[fw].push(r);
          });
          Object.entries(groupedByFramework).forEach(([fw, reqs]) => {
            systemPrompt += `\n### Framework: ${fw}\n`;
            reqs.forEach((r, i) => {
              systemPrompt += `${i + 1}. **[${r.refId || 'N/A'}]** ${r.description || r.name || ''}`;
              if (r.nodeUrn) systemPrompt += ` (URN: ${r.nodeUrn})`;
              systemPrompt += `\n`;
            });
          });
        }

        // Inject reference files / collections info
        if (context.fileResources && context.fileResources.length > 0) {
          systemPrompt += `\n---\n## SESSION CONTEXT: Reference Files (${context.fileResources.length} files)\n`;
          systemPrompt += `The user has uploaded the following reference documents for cross-referencing:\n`;
          context.fileResources.forEach((f, i) => {
            systemPrompt += `${i + 1}. Store: ${f.storeName || f.storeId}, Document: ${f.documentName || f.fileId}\n`;
          });
          systemPrompt += `\nUse these documents to ground your analysis in the user's actual policies and evidence when possible.\n`;
        }

        // Inject uploaded context files content
        if (context.contextFiles && context.contextFiles.length > 0) {
          systemPrompt += `\n---\n## SESSION CONTEXT: Uploaded Context Files (${context.contextFiles.length} files)\n`;
          systemPrompt += `The user has uploaded the following documents as additional context. Use their content to ground your analysis:\n\n`;
          context.contextFiles.forEach((cf, i) => {
            // Truncate to ~8000 chars per file to avoid token overflow
            const content = cf.content && cf.content.length > 8000
              ? cf.content.substring(0, 8000) + '\n... [truncated]'
              : (cf.content || '(empty file)');
            systemPrompt += `### File ${i + 1}: ${cf.name}\n\`\`\`\n${content}\n\`\`\`\n\n`;
          });
        }

        // Inject user query context
        if (context.query) {
          systemPrompt += `\n---\n## SESSION CONTEXT: User's Initial Query\n"${context.query}"\n`;
          systemPrompt += `\nAddress this query directly in your first response. Tailor all analysis to this specific focus area.\n`;
        }
      }

      // Create Gemini cached content to store the session context on Gemini's servers
      let cachedContentName = null;
      try {
        const cache = await genai.caches.create({
          model: 'gemini-2.5-pro',
          config: {
            contents: [{
              role: 'user',
              parts: [{ text: `Session ${sessionId} initialized. Awaiting first query.` }]
            }, {
              role: 'model',
              parts: [{ text: 'Session ready. I have loaded all the audit context and I am ready to analyze your requirements.' }]
            }],
            displayName: `wathbah-audit-${sessionId}`,
            systemInstruction: systemPrompt,
            ttl: '3600s' // 1 hour TTL
          }
        });
        cachedContentName = cache.name;
        console.log(`Gemini cache created: ${cachedContentName}`);
      } catch (cacheErr) {
        console.warn(`Cache creation failed (will use direct system instruction): ${cacheErr.message}`);
      }

      // Build File Search grounding tool from selected collections
      const fileSearchStoreNames = [];
      if (context && context.collections && context.collections.length > 0) {
        context.collections.forEach(c => {
          const sid = c.storeId || '';
          if (sid) {
            const fullName = sid.startsWith('fileSearchStores/') ? sid : `fileSearchStores/${sid}`;
            if (!fileSearchStoreNames.includes(fullName)) fileSearchStoreNames.push(fullName);
          }
        });
      }
      // Also gather store IDs from individual file resources
      if (context && context.fileResources && context.fileResources.length > 0) {
        context.fileResources.forEach(f => {
          const sid = f.storeId || '';
          if (sid) {
            const fullName = sid.startsWith('fileSearchStores/') ? sid : `fileSearchStores/${sid}`;
            if (!fileSearchStoreNames.includes(fullName)) fileSearchStoreNames.push(fullName);
          }
        });
      }

      // Create SDK chat session — with cached content if available, otherwise system instruction
      const chatConfig = {
        temperature: 0.7,
        maxOutputTokens: 8192
      };

      if (cachedContentName) {
        chatConfig.cachedContent = cachedContentName;
      } else {
        chatConfig.systemInstruction = systemPrompt;
      }

      // Add File Search grounding if collections were selected
      if (fileSearchStoreNames.length > 0) {
        chatConfig.tools = [{ fileSearch: { fileSearchStoreNames } }];
        console.log(`[Audit Chat] File Search Stores attached:`, fileSearchStoreNames);
      }

      const createdAt = new Date().toISOString();

      // Save session to DB
      dbInsertSession.run(
        sessionId,
        JSON.stringify(context || {}),
        systemPrompt,
        cachedContentName,
        createdAt
      );

      // Keep in-memory chat session for active conversations
      chatSessions[sessionId] = {
        id: sessionId,
        cachedContentName,
        systemPrompt,
        context: context || {},
        createdAt,
        fileSearchStoreNames,
        chat: genai.chats.create({
          model: 'gemini-2.5-pro',
          config: chatConfig
        })
      };

      console.log(`Chat session created & persisted: ${sessionId} (cache: ${cachedContentName || 'none'}, prompt: ${systemPrompt.length} chars, fileSearch: ${fileSearchStoreNames.length} stores)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        sessionId,
        cachedContent: cachedContentName || null
      }));
    } catch (error) {
      console.error('Create session error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Send message to chat session ----
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { sessionId, message } = body;
      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];

      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API key not configured.' }));
        return;
      }

      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sessionId is required.' }));
        return;
      }

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required.' }));
        return;
      }

      // Lazy-init the SDK client
      if (!genai) {
        genai = new GoogleGenAI({ apiKey });
      }

      // Ensure in-memory session exists (restore from DB if needed)
      if (!chatSessions[sessionId]) {
        const row = dbGetSession.get(sessionId);
        if (row) {
          // Rebuild in-memory chat session from DB
          const savedMessages = dbGetMessages.all(sessionId);
          const history = savedMessages.map(m => ({
            role: m.role === 'ai' ? 'model' : 'user',
            parts: [{ text: m.text }]
          }));

          // Always use systemInstruction when restoring (cached content may have expired — TTL is 1h)
          const chatConfig = {
            systemInstruction: row.system_prompt || 'You are an expert compliance auditor.',
            temperature: 0.7,
            maxOutputTokens: 8192
          };

          // Provide history so the SDK ChatSession resumes from where it left off
          if (history.length > 0) {
            chatConfig.history = history;
          }

          // Restore File Search grounding from saved context
          const savedCtx = JSON.parse(row.context || '{}');
          const restoredStoreNames = [];
          if (savedCtx.collections && savedCtx.collections.length > 0) {
            savedCtx.collections.forEach(c => {
              const sid = c.storeId || '';
              if (sid) {
                const fullName = sid.startsWith('fileSearchStores/') ? sid : `fileSearchStores/${sid}`;
                if (!restoredStoreNames.includes(fullName)) restoredStoreNames.push(fullName);
              }
            });
          }
          if (savedCtx.fileResources && savedCtx.fileResources.length > 0) {
            savedCtx.fileResources.forEach(f => {
              const sid = f.storeId || '';
              if (sid) {
                const fullName = sid.startsWith('fileSearchStores/') ? sid : `fileSearchStores/${sid}`;
                if (!restoredStoreNames.includes(fullName)) restoredStoreNames.push(fullName);
              }
            });
          }
          if (restoredStoreNames.length > 0) {
            chatConfig.tools = [{ fileSearch: { fileSearchStoreNames: restoredStoreNames } }];
            console.log(`[Audit Chat] Restored File Search Stores:`, restoredStoreNames);
          }

          chatSessions[sessionId] = {
            id: sessionId,
            cachedContentName: null, // Don't reuse expired cache
            systemPrompt: row.system_prompt,
            context: savedCtx,
            createdAt: row.created_at,
            fileSearchStoreNames: restoredStoreNames,
            chat: genai.chats.create({
              model: 'gemini-2.5-pro',
              config: chatConfig
            })
          };
          console.log(`Chat session restored from DB: ${sessionId} (${history.length} messages, ${restoredStoreNames.length} file search stores)`);
        } else {
          // No DB record — create a fresh session
          const createdAt = new Date().toISOString();
          const sysPrompt = getChatAuditorPrompt();
          dbInsertSession.run(sessionId, '{}', sysPrompt, null, createdAt);

          chatSessions[sessionId] = {
            id: sessionId,
            cachedContentName: null,
            systemPrompt: sysPrompt,
            context: {},
            createdAt,
            chat: genai.chats.create({
              model: 'gemini-2.5-pro',
              config: {
                systemInstruction: sysPrompt,
                temperature: 0.7,
                maxOutputTokens: 8192
              }
            })
          };
          console.log(`Chat session created on-the-fly & persisted: ${sessionId}`);
        }
      }

      const session = chatSessions[sessionId];

      // Send message — SDK ChatSession handles history automatically
      const historyLen = session.chat.getHistory ? session.chat.getHistory(false).length : 0;
      console.log(`Session ${sessionId}: sending message to Gemini (history: ${historyLen} msgs)`);
      const response = await session.chat.sendMessage({ message });
      const reply = response.text || 'No response generated.';

      // Persist both user message and AI reply to DB
      const now = new Date().toISOString();
      dbInsertMessage.run(sessionId, 'user', message, now);
      dbInsertMessage.run(sessionId, 'ai', reply, now);

      console.log(`Session ${sessionId}: got reply (${reply.length} chars) — messages persisted to DB`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, reply, sessionId }));
    } catch (error) {
      console.error('Chat API Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Local Prompts API ----
  if (url.pathname === '/api/local-prompts' && req.method === 'GET') {
    try {
      const rows = dbListLocalPrompts.all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, prompts: rows }));
    } catch (error) {
      console.error('List local prompts error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const localPromptMatch = url.pathname.match(/^\/api\/local-prompts\/([^\/]+)$/);
  if (localPromptMatch && req.method === 'GET') {
    try {
      const row = dbGetLocalPrompt.get(localPromptMatch[1]);
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prompt not found.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, prompt: row }));
    } catch (error) {
      console.error('Get local prompt error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (localPromptMatch && req.method === 'PUT') {
    try {
      const id = localPromptMatch[1];
      const row = dbGetLocalPrompt.get(id);
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prompt not found.' }));
        return;
      }
      const body = await parseBody(req);
      const name = body.name || row.name;
      const content = body.content !== undefined ? body.content : row.content;
      const updatedAt = new Date().toISOString();
      dbUpdateLocalPrompt.run(name, content, updatedAt, id);
      console.log(`Local prompt updated: ${id} ("${name}", ${content.length} chars)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, prompt: { ...row, name, content, updated_at: updatedAt } }));
    } catch (error) {
      console.error('Update local prompt error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Org Contexts API ----
  // ---- Controls Studio Sessions API ----
  const csMatch = url.pathname.match(/^\/api\/cs-sessions(?:\/([^\/]+))?$/);

  if (url.pathname === '/api/cs-sessions' && req.method === 'GET') {
    try {
      const rows = dbListCsSessions.all();
      const sessions = rows.map(csSessionToJSON);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessions }));
    } catch (error) {
      console.error('List CS sessions error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === '/api/cs-sessions' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const id = body.id || crypto.randomUUID();
      const now = new Date().toISOString();
      dbInsertCsSession.run(
        id,
        body.name || '',
        body.status || 'draft',
        body.step || 0,
        JSON.stringify(body.requirements || []),
        JSON.stringify(body.collections || []),
        JSON.stringify(body.selectedFiles || []),
        JSON.stringify(body.sessionFiles || []),
        body.orgContext ? JSON.stringify(body.orgContext) : null,
        JSON.stringify(body.controls || []),
        body.framework || '',
        JSON.stringify(body.exportedControlIds || []),
        now,
        now
      );
      const row = dbGetCsSession.get(id);
      console.log(`CS session created: ${id} ("${body.name}")`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, session: csSessionToJSON(row) }));
    } catch (error) {
      console.error('Create CS session error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (csMatch && csMatch[1] && req.method === 'GET') {
    try {
      const row = dbGetCsSession.get(csMatch[1]);
      if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, session: csSessionToJSON(row) }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (csMatch && csMatch[1] && req.method === 'PUT') {
    try {
      const id = csMatch[1];
      const existing = dbGetCsSession.get(id);
      if (!existing) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
      const body = await parseBody(req);
      const now = new Date().toISOString();
      dbUpdateCsSession.run(
        body.name !== undefined ? body.name : existing.name,
        body.status !== undefined ? body.status : existing.status,
        body.step !== undefined ? body.step : existing.step,
        body.requirements !== undefined ? JSON.stringify(body.requirements) : existing.requirements,
        body.collections !== undefined ? JSON.stringify(body.collections) : existing.collections,
        body.selectedFiles !== undefined ? JSON.stringify(body.selectedFiles) : existing.selected_files,
        body.sessionFiles !== undefined ? JSON.stringify(body.sessionFiles) : existing.session_files,
        body.orgContext !== undefined ? (body.orgContext ? JSON.stringify(body.orgContext) : null) : existing.org_context,
        body.controls !== undefined ? JSON.stringify(body.controls) : existing.controls,
        body.framework !== undefined ? body.framework : existing.framework,
        body.exportedControlIds !== undefined ? JSON.stringify(body.exportedControlIds) : existing.exported_control_ids,
        now,
        id
      );
      const updated = dbGetCsSession.get(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, session: csSessionToJSON(updated) }));
    } catch (error) {
      console.error('Update CS session error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (csMatch && csMatch[1] && req.method === 'DELETE') {
    try {
      const id = csMatch[1];
      const row = dbGetCsSession.get(id);
      if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
      dbDeleteCsSession.run(id);
      console.log(`CS session deleted: ${id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Delete CS session error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Org Contexts API ----
  if (url.pathname === '/api/org-contexts' && req.method === 'GET') {
    try {
      const rows = dbListOrgContexts.all();
      const contexts = rows.map(orgContextToJSON);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, contexts }));
    } catch (error) {
      console.error('List org contexts error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === '/api/org-contexts' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const id = body.id || crypto.randomUUID();
      const now = new Date().toISOString();
      dbInsertOrgContext.run(
        id,
        body.nameEn || body.name || '',
        body.nameAr || '',
        body.sector || '',
        body.sectorCustom || '',
        body.size || '',
        body.complianceMaturity || 1,
        JSON.stringify(body.regulatoryMandates || []),
        body.governanceStructure || '',
        body.dataClassification || '',
        body.geographicScope || '',
        body.itInfrastructure || '',
        JSON.stringify(body.strategicObjectives || []),
        JSON.stringify(body.obligatoryFrameworks || []),
        JSON.stringify(body.policies || []),
        JSON.stringify(body.trackingMetrics || []),
        JSON.stringify(body.riskScenarios || []),
        JSON.stringify(body.objectiveFrameworkMap || {}),
        body.notes || '',
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : 1,
        now,
        now
      );
      const row = dbGetOrgContext.get(id);
      console.log(`Org context created: ${id} ("${body.nameEn || body.name}")`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, context: orgContextToJSON(row) }));
    } catch (error) {
      console.error('Create org context error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const orgCtxMatch = url.pathname.match(/^\/api\/org-contexts\/([^\/]+)$/);
  if (orgCtxMatch && req.method === 'GET') {
    try {
      const row = dbGetOrgContext.get(orgCtxMatch[1]);
      if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, context: orgContextToJSON(row) }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (orgCtxMatch && req.method === 'PUT') {
    try {
      const id = orgCtxMatch[1];
      const row = dbGetOrgContext.get(id);
      if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
      const body = await parseBody(req);
      const now = new Date().toISOString();
      dbUpdateOrgContext.run(
        body.nameEn !== undefined ? body.nameEn : row.name_en,
        body.nameAr !== undefined ? body.nameAr : row.name_ar,
        body.sector !== undefined ? body.sector : row.sector,
        body.sectorCustom !== undefined ? body.sectorCustom : (row.sector_custom || ''),
        body.size !== undefined ? body.size : row.size,
        body.complianceMaturity !== undefined ? body.complianceMaturity : (row.compliance_maturity || 1),
        body.regulatoryMandates !== undefined ? JSON.stringify(body.regulatoryMandates) : (row.regulatory_mandates || '[]'),
        body.governanceStructure !== undefined ? body.governanceStructure : (row.governance_structure || ''),
        body.dataClassification !== undefined ? body.dataClassification : (row.data_classification || ''),
        body.geographicScope !== undefined ? body.geographicScope : (row.geographic_scope || ''),
        body.itInfrastructure !== undefined ? body.itInfrastructure : (row.it_infrastructure || ''),
        body.strategicObjectives !== undefined ? JSON.stringify(body.strategicObjectives) : (row.strategic_objectives || '[]'),
        body.obligatoryFrameworks !== undefined ? JSON.stringify(body.obligatoryFrameworks) : row.obligatory_frameworks,
        body.policies !== undefined ? JSON.stringify(body.policies) : (row.policies || '[]'),
        body.trackingMetrics !== undefined ? JSON.stringify(body.trackingMetrics) : (row.tracking_metrics || '[]'),
        body.riskScenarios !== undefined ? JSON.stringify(body.riskScenarios) : (row.risk_scenarios || '[]'),
        body.objectiveFrameworkMap !== undefined ? JSON.stringify(body.objectiveFrameworkMap) : (row.objective_framework_map || '{}'),
        body.notes !== undefined ? body.notes : row.notes,
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : row.is_active,
        now,
        id
      );
      const updated = dbGetOrgContext.get(id);
      console.log(`Org context updated: ${id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, context: orgContextToJSON(updated) }));
    } catch (error) {
      console.error('Update org context error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (orgCtxMatch && req.method === 'DELETE') {
    try {
      const id = orgCtxMatch[1];
      const row = dbGetOrgContext.get(id);
      if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }

      // Clean up Gemini File Search Store + local files
      const orgStoreId = row.store_id || '';
      if (orgStoreId) {
        const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];
        if (apiKey) {
          try {
            await deleteFileSearchStore(`fileSearchStores/${orgStoreId}`, apiKey);
            console.log(`[OrgFiles] Deleted File Search Store: ${orgStoreId}`);
          } catch (delErr) { console.warn(`[OrgFiles] Could not delete store: ${delErr.message}`); }
        }
        try {
          const storeDir = path.join(COLLECTION_UPLOADS_DIR, orgStoreId);
          if (fs.existsSync(storeDir)) fs.rmSync(storeDir, { recursive: true, force: true });
        } catch (rmErr) { console.warn(`[OrgFiles] Could not remove local dir: ${rmErr.message}`); }
      }

      dbDeleteOrgContext.run(id);
      console.log(`Org context deleted: ${id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Delete org context error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Org Context File Attachments ----
  const orgFileMatch = url.pathname.match(/^\/api\/org-contexts\/([^\/]+)\/files(?:\/([^\/]+))?$/);
  if (orgFileMatch) {
    const orgId = orgFileMatch[1];
    const fileId = orgFileMatch[2];
    const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];

    const orgRow = dbGetOrgContext.get(orgId);
    if (!orgRow) { sendJSON(res, 404, { error: 'Organization context not found' }); return; }

    try {
      // POST /api/org-contexts/:id/files — Upload file
      if (!fileId && req.method === 'POST') {
        if (!apiKey) { sendJSON(res, 401, { error: 'Gemini API key not configured.' }); return; }

        const body = await parseBody(req);
        const { fileName, mimeType, data } = body;
        if (!fileName || !data) { sendJSON(res, 400, { error: 'fileName and data (base64) are required.' }); return; }

        const fileBuffer = Buffer.from(data, 'base64');
        const mime = mimeType || 'application/octet-stream';

        // Ensure org has a File Search Store (create if needed)
        let storeId = orgRow.store_id || '';
        if (!storeId) {
          const safeName = ((orgRow.name_en || 'Org') + ' Files').replace(/[^\x20-\x7E]/g, '_');
          console.log(`[OrgFiles] Creating File Search Store for org "${orgRow.name_en}"...`);
          const storeResult = await createFileSearchStore(safeName, apiKey);
          let store = storeResult;
          if (storeResult.name && !storeResult.done && !storeResult.name.startsWith('fileSearchStores/')) {
            store = await pollOperation(storeResult.name, apiKey);
            store = store.response || store;
          }
          storeId = (store.name || '').replace('fileSearchStores/', '');
          dbUpdateOrgContextStoreId.run(storeId, new Date().toISOString(), orgId);
          console.log(`[OrgFiles] File Search Store created: ${storeId}`);
        }

        // Upload to Gemini File Search Store
        const storeName = `fileSearchStores/${storeId}`;
        console.log(`[OrgFiles] Uploading "${fileName}" to ${storeName}...`);
        const result = await uploadFileToStore(storeName, fileName, mime, fileBuffer, apiKey);
        let finalResult = result;
        if (result.name && !result.done) {
          finalResult = await pollOperation(result.name, apiKey, GEMINI_FILE_SEARCH_INDEX_POLL_MS);
        }

        // Save local copy for viewing
        try {
          const oStoreDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          if (!fs.existsSync(oStoreDir)) fs.mkdirSync(oStoreDir, { recursive: true });
          const oSafeFileName = uniqueAsciiLocalFileName(fileName, fileBuffer);
          fs.writeFileSync(path.join(oStoreDir, oSafeFileName), fileBuffer);
          const oMetaPath = path.join(oStoreDir, '_metadata.json');
          let oMeta = {};
          try { oMeta = JSON.parse(fs.readFileSync(oMetaPath, 'utf-8')); } catch {}
          const oDocPath = extractDocumentResourceNameFromUploadOp(finalResult);
          const oDocId =
            (oDocPath && oDocPath.includes('/documents/') && oDocPath.split('/').pop()) ||
            oSafeFileName;
          oMeta[oDocId] = { originalName: fileName, localFile: oSafeFileName, mimeType: mime, size: fileBuffer.length, uploadedAt: new Date().toISOString() };
          oMeta[oSafeFileName] = oMeta[oDocId];
          fs.writeFileSync(oMetaPath, JSON.stringify(oMeta, null, 2));
          console.log(`[OrgFiles] Local copy saved for "${fileName}"`);
        } catch (localErr) {
          console.warn(`[OrgFiles] Could not save local copy: ${localErr.message}`);
        }

        sendJSON(res, 200, { success: true, data: finalResult });
        return;
      }

      // GET /api/org-contexts/:id/files — List files
      if (!fileId && req.method === 'GET') {
        const storeId = orgRow.store_id || '';
        if (!storeId) { sendJSON(res, 200, { success: true, storeId: '', data: { documents: [] } }); return; }
        const storeName = `fileSearchStores/${storeId}`;
        const docs = await listStoreDocuments(storeName, apiKey);
        sendJSON(res, 200, { success: true, storeId, data: docs });
        return;
      }

      // GET /api/org-contexts/:id/files/:fileId — View/download file
      if (fileId && req.method === 'GET') {
        const storeId = orgRow.store_id || '';
        if (!storeId) { sendJSON(res, 404, { error: 'No files store for this organization.' }); return; }
        try {
          const storeDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          const metaPath = path.join(storeDir, '_metadata.json');
          if (!fs.existsSync(metaPath)) { sendJSON(res, 404, { error: 'No local files found.' }); return; }
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          const fileMeta = meta[fileId];
          if (!fileMeta) { sendJSON(res, 404, { error: 'File not found locally.' }); return; }
          const localFilePath = path.join(storeDir, fileMeta.localFile);
          if (!fs.existsSync(localFilePath)) { sendJSON(res, 404, { error: 'Local file removed.' }); return; }
          const fileContent = fs.readFileSync(localFilePath);
          res.writeHead(200, {
            'Content-Type': fileMeta.mimeType || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${encodeURIComponent(fileMeta.originalName || fileMeta.localFile)}"`,
            'Content-Length': fileContent.length
          });
          res.end(fileContent);
        } catch (viewErr) {
          console.error('[OrgFiles] File view error:', viewErr.message);
          sendJSON(res, 500, { error: viewErr.message });
        }
        return;
      }

      // DELETE /api/org-contexts/:id/files/:fileId — Delete file
      if (fileId && req.method === 'DELETE') {
        const storeId = orgRow.store_id || '';
        if (!storeId) { sendJSON(res, 404, { error: 'No files store for this organization.' }); return; }
        const documentName = `fileSearchStores/${storeId}/documents/${fileId}`;
        console.log(`[OrgFiles] Deleting document: ${documentName}`);
        await deleteDocument(documentName, apiKey);

        // Remove local copy
        try {
          const storeDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          const metaPath = path.join(storeDir, '_metadata.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (meta[fileId]) {
              const localFile = path.join(storeDir, meta[fileId].localFile);
              if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
              delete meta[meta[fileId].localFile];
              delete meta[fileId];
              fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            }
          }
        } catch (delLocalErr) {
          console.warn(`[OrgFiles] Could not remove local copy: ${delLocalErr.message}`);
        }

        sendJSON(res, 200, { success: true });
        return;
      }

      sendJSON(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      console.error('[OrgFiles] Error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ---- Org Context Chat ----
  const orgChatMatch = url.pathname.match(/^\/api\/org-contexts\/([^\/]+)\/chat$/);
  if (orgChatMatch && req.method === 'POST') {
    const orgId = orgChatMatch[1];
    const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];
    if (!apiKey) { sendJSON(res, 401, { error: 'Gemini API key not configured.' }); return; }

    const orgRow = dbGetOrgContext.get(orgId);
    if (!orgRow) { sendJSON(res, 404, { error: 'Organization context not found' }); return; }

    try {
      const body = await parseBody(req);
      const userMessage = (body.message || '').trim();
      if (!userMessage) { sendJSON(res, 400, { error: 'message is required.' }); return; }

      // Collect File Search Store IDs from request (multi-select) + org's own store
      let storeIds = body.storeIds || [];
      if (typeof storeIds === 'string') storeIds = [storeIds];
      // Always include this org's own store if it has one
      const ownStore = orgRow.store_id || '';
      if (ownStore && !storeIds.includes(ownStore)) storeIds.unshift(ownStore);

      // Session management
      let sessionId = body.sessionId || null;
      const orgName = orgRow.name_en || 'Organization';
      const systemInstruction = body.systemInstruction || `You are Wathbah AI, an expert assistant for governance, risk, and compliance (GRC). You are helping with the organization "${orgName}". Answer questions based on the uploaded documents and organization context. Be precise, cite specific document sections when possible, and format your responses clearly with markdown.`;

      // Build File Search grounding tool
      const tools = [];
      if (storeIds.length > 0) {
        const fileSearchStoreNames = storeIds.map(id =>
          id.startsWith('fileSearchStores/') ? id : `fileSearchStores/${id}`
        );
        tools.push({ fileSearch: { fileSearchStoreNames } });
        console.log(`[OrgChat] Using File Search Stores:`, fileSearchStoreNames);
      }

      // Ensure Gemini SDK is initialized
      if (!genai) genai = new GoogleGenAI({ apiKey });

      // Reuse or create chat session (stored in policyChats with orgchat- prefix)
      if (!sessionId || !policyChats[sessionId]) {
        sessionId = 'orgchat-' + crypto.randomUUID();
        console.log(`[OrgChat] Creating session ${sessionId} for org "${orgName}" with ${storeIds.length} store(s)`);

        const chatConfig = {
          systemInstruction,
          temperature: 0.7,
          maxOutputTokens: 8192,
        };
        if (tools.length > 0) chatConfig.tools = tools;

        policyChats[sessionId] = {
          chat: genai.chats.create({ model: 'gemini-2.5-pro', config: chatConfig }),
          storeIds,
          history: [],
          createdAt: new Date().toISOString(),
        };
      }

      const session = policyChats[sessionId];
      console.log(`[OrgChat] Session ${sessionId} — user: "${userMessage.substring(0, 80)}..."`);

      const result = await session.chat.sendMessage({ message: userMessage });
      const aiText = result.text || '';

      // Extract grounding metadata
      const groundingMetadata = result.candidates?.[0]?.groundingMetadata || null;
      const groundingChunks = groundingMetadata?.groundingChunks || [];
      const sources = groundingChunks.map(chunk => ({
        title: chunk.retrievedContext?.title || null,
        uri: chunk.retrievedContext?.uri || null,
      })).filter(s => s.title || s.uri);

      session.history.push(
        { role: 'user', text: userMessage, timestamp: new Date().toISOString() },
        { role: 'model', text: aiText, sources, timestamp: new Date().toISOString() }
      );

      sendJSON(res, 200, {
        success: true,
        sessionId,
        message: aiText,
        sources,
        turnCount: Math.floor(session.history.length / 2),
      });
    } catch (chatErr) {
      console.error(`[OrgChat] Error:`, chatErr.message);
      sendJSON(res, 500, { error: chatErr.message });
    }
    return;
  }

  // ---- Policy Collections API ----
  const policyCollMatch = url.pathname.match(/^\/api\/policy-collections(?:\/([^\/]+))?(?:\/(files|extract|approve|preview-library|history|sync|chat)(?:\/([^\/]+))?(?:\/([^\/]+))?)?$/);
  if (policyCollMatch) {
    let collId = policyCollMatch[1];
    let subResource = policyCollMatch[2]; // 'files' | 'extract' | 'approve' | 'preview-library' | 'history' | 'sync' | 'chat'
    const fileId = policyCollMatch[3];
    const histSub = policyCollMatch[4]; // e.g. 'preview-library' for .../history/:id/preview-library
    const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];

    try {
      // POST /api/policy-collections/chat — Chat without a specific collection (pass storeIds in body)
      if (collId === 'chat' && !subResource && req.method === 'POST') {
        collId = null;
        subResource = 'chat';
      }

      // GET /api/policy-collections/overview — Hierarchical view of all collections + files from Gemini
      if (collId === 'overview' && req.method === 'GET') {
        const rows = dbListPolicyCollections.all();
        const overview = await Promise.all(rows.map(async row => {
          const storeId = row.store_id || '';
          let files = [];
          if (storeId && apiKey) {
            try {
              const storeName = storeId.startsWith('fileSearchStores/') ? storeId : `fileSearchStores/${storeId}`;
              const result = await listStoreDocuments(storeName, apiKey);
              files = (result.documents || []).map(doc => ({
                documentName: doc.name || '',
                name: doc.displayName || doc.name || '',
                sizeBytes: parseInt(doc.sizeBytes || '0', 10),
                createTime: doc.createTime || '',
                updateTime: doc.updateTime || '',
              }));
            } catch (err) {
              console.warn(`[Overview] Could not list docs for store ${storeId}:`, err.message);
            }
          }
          return {
            id: row.id,
            name: row.name,
            description: row.description || '',
            storeId,
            status: row.status || 'empty',
            fileCount: files.length,
            created: row.created_at,
            files,
          };
        }));

        const totalFiles = overview.reduce((sum, c) => sum + c.fileCount, 0);

        sendJSON(res, 200, {
          success: true,
          totalCollections: overview.length,
          totalFiles,
          data: overview,
        });
        return;
      }

      // GET /api/policy-collections — List all (file counts only; no per-file payload)
      if (!collId && req.method === 'GET') {
        const rows = dbListPolicyCollections.all();
        const collections = await Promise.all(rows.map(r => policyCollectionToJSON(r, apiKey, { summaryOnly: true })));
        sendJSON(res, 200, { success: true, data: collections });
        return;
      }

      // POST /api/policy-collections — Create new (+ File Search Store)
      if (!collId && !subResource && req.method === 'POST') {
        const body = await parseBody(req);
        const newId = 'pc-' + crypto.randomUUID();
        const collName = body.name || 'New Collection';
        const now2 = new Date().toISOString();

        // Create a Gemini File Search Store for this collection
        let storeId = '';
        if (apiKey) {
          try {
            const safeName = collName.replace(/[^\x20-\x7E]/g, '_');
            console.log(`[Policy] Creating File Search Store for new collection "${safeName}"...`);
            const storeResult = await createFileSearchStore(safeName, apiKey);

            let store = storeResult;
            if (storeResult.name && !storeResult.done && !storeResult.name.startsWith('fileSearchStores/')) {
              store = await pollOperation(storeResult.name, apiKey);
              store = store.response || store;
            }

            const fullStoreName = store.name || '';
            storeId = fullStoreName.replace('fileSearchStores/', '');
            console.log(`[Policy] File Search Store created: ${storeId}`);
          } catch (storeErr) {
            console.error(`[Policy] Failed to create File Search Store:`, storeErr.message);
          }
        }

        dbInsertPolicyCollection.run(
          newId,
          collName,
          body.description || '',
          storeId,
          'empty',
          '{}',
          null,
          now2,
          now2
        );
        const newRow = dbGetPolicyCollection.get(newId);
        sendJSON(res, 201, { success: true, data: await policyCollectionToJSON(newRow, apiKey) });
        return;
      }

      // DELETE /api/policy-collections/:id — Delete collection + File Search Store (like Audit Studio)
      if (collId && !subResource && req.method === 'DELETE') {
        const collRow = dbGetPolicyCollection.get(collId);

        // Delete the File Search Store (automatically deletes all docs inside)
        if (collRow && collRow.store_id) {
          invalidatePolicyStoreDocCountCache(collRow.store_id);
          try {
            const storeName = `fileSearchStores/${collRow.store_id}`;
            console.log(`[Policy] Deleting store: ${storeName}`);
            await deleteFileSearchStore(storeName, apiKey);
            console.log(`[Policy] Deleted File Search Store: ${storeName}`);
          } catch (delErr) {
            console.warn(`[Policy] Could not delete File Search Store:`, delErr.message);
          }
        }

        // Clean up local DB records
        dbDeletePolicyFilesForCollection.run(collId);
        dbDeletePolicyCollection.run(collId);
        sendJSON(res, 200, { success: true });
        return;
      }

      // PUT /api/policy-collections/:id — Update name/description
      if (collId && !subResource && req.method === 'PUT') {
        const body = await parseBody(req);
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
        const now2 = new Date().toISOString();
        dbUpdatePolicyCollection.run(
          body.name !== undefined ? body.name : row.name,
          body.description !== undefined ? body.description : row.description,
          row.status,
          row.config,
          row.extraction_result,
          now2,
          collId
        );
        const updated = dbGetPolicyCollection.get(collId);
        sendJSON(res, 200, { success: true, data: await policyCollectionToJSON(updated, apiKey) });
        return;
      }

      // GET /api/policy-collections/:id — Get single collection (files page via Gemini pageToken)
      if (collId && !subResource && req.method === 'GET') {
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
        const filesPageToken = url.searchParams.get('filesPageToken') || '';
        sendJSON(res, 200, {
          success: true,
          data: await policyCollectionToJSON(row, apiKey, { filesPageToken }),
        });
        return;
      }

      // POST /api/policy-collections/:id/files — Upload file to File Search Store (Gemini-first, like Audit Studio)
      if (collId && subResource === 'files' && !fileId && req.method === 'POST') {
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Collection not found' }); return; }

        if (!apiKey) {
          sendJSON(res, 401, { error: 'Gemini API key not configured. Cannot upload files.' });
          return;
        }

        const body = await parseBody(req);
        const { fileName, mimeType, data } = body;
        if (!fileName || !data) {
          sendJSON(res, 400, { error: 'fileName and data (base64) are required.' });
          return;
        }

        const fileBuffer = Buffer.from(data, 'base64');
        const mime = mimeType || 'application/octet-stream';

        // Ensure collection has a File Search Store
        let storeId = row.store_id || '';
        if (!storeId) {
          const safeName = (row.name || 'Policy Collection').replace(/[^\x20-\x7E]/g, '_');
          console.log(`[Policy] Creating File Search Store (retroactive) for "${safeName}"...`);
          const storeResult = await createFileSearchStore(safeName, apiKey);
          let store = storeResult;
          if (storeResult.name && !storeResult.done && !storeResult.name.startsWith('fileSearchStores/')) {
            store = await pollOperation(storeResult.name, apiKey);
            store = store.response || store;
          }
          storeId = (store.name || '').replace('fileSearchStores/', '');
          dbUpdatePolicyCollectionStoreId.run(storeId, collId);
          console.log(`[Policy] File Search Store created: ${storeId}`);
        }

        // Upload to File Search Store (same pattern as Audit Studio)
        const storeName = `fileSearchStores/${storeId}`;
        console.log(`[Policy] Uploading "${fileName}" to ${storeName}...`);
        const result = await uploadFileToStore(storeName, fileName, mime, fileBuffer, apiKey);
        console.log(`[Policy] Upload result:`, JSON.stringify(result).slice(0, 300));

        // Poll if long-running operation
        let finalResult = result;
        if (result.name && !result.done) {
          finalResult = await pollOperation(result.name, apiKey, GEMINI_FILE_SEARCH_INDEX_POLL_MS);
          console.log(`[Policy] Upload complete:`, finalResult.done);
          if (!finalResult.done) {
            console.warn(
              `[Policy] Indexing still in progress after ${GEMINI_FILE_SEARCH_INDEX_POLL_MS / 1000}s for "${fileName}" — may succeed in background; consider spacing uploads if failures persist.`
            );
          }
        }

        // Save local copy for viewing/downloading
        try {
          const pStoreDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          if (!fs.existsSync(pStoreDir)) fs.mkdirSync(pStoreDir, { recursive: true });
          const pSafeFileName = uniqueAsciiLocalFileName(fileName, fileBuffer);
          const pLocalFilePath = path.join(pStoreDir, pSafeFileName);
          fs.writeFileSync(pLocalFilePath, fileBuffer);
          const pMetaPath = path.join(pStoreDir, '_metadata.json');
          let pMeta = {};
          try { pMeta = JSON.parse(fs.readFileSync(pMetaPath, 'utf-8')); } catch {}
          const pDocPath = extractDocumentResourceNameFromUploadOp(finalResult);
          const pDocId =
            (pDocPath && pDocPath.includes('/documents/') && pDocPath.split('/').pop()) ||
            pSafeFileName;
          pMeta[pDocId] = { originalName: fileName, localFile: pSafeFileName, mimeType: mime, size: fileBuffer.length, uploadedAt: new Date().toISOString() };
          pMeta[pSafeFileName] = pMeta[pDocId];
          fs.writeFileSync(pMetaPath, JSON.stringify(pMeta, null, 2));
          console.log(`[Policy] Local copy saved: ${pLocalFilePath}`);
        } catch (pLocalErr) {
          console.warn(`[Policy] Could not save local copy of "${fileName}": ${pLocalErr.message}`);
        }

        console.log(`[Policy] File "${fileName}" uploaded to store ${storeId}`);
        invalidatePolicyStoreDocCountCache(storeId);
        const indexingStatus = await buildPolicyIndexingStatus(finalResult, apiKey);
        sendJSON(res, 200, { success: true, data: finalResult, indexingStatus });
        return;
      }

      // GET /api/policy-collections/:id/files — List files from Gemini File Search Store (like Audit Studio)
      if (collId && subResource === 'files' && !fileId && req.method === 'GET') {
        const collRow = dbGetPolicyCollection.get(collId);
        if (!collRow) {
          sendJSON(res, 404, { error: 'Collection not found' });
          return;
        }
        const storeId = collRow.store_id || '';
        if (!storeId) {
          sendJSON(res, 200, { success: true, storeId: '', data: { documents: [] } });
          return;
        }

        const storeName = `fileSearchStores/${storeId}`;
        console.log(`[Policy] Listing documents in ${storeName}`);
        const docs = await listStoreDocuments(storeName, apiKey);

        sendJSON(res, 200, { success: true, storeId, data: docs });
        return;
      }

      // GET /api/policy-collections/:id/files/:fileId — View/download a locally stored file
      if (collId && subResource === 'files' && fileId && req.method === 'GET') {
        const collRow = dbGetPolicyCollection.get(collId);
        const storeId = collRow?.store_id || '';
        if (!storeId) {
          sendJSON(res, 404, { error: 'Collection has no store' });
          return;
        }
        try {
          const storeDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          const metaPath = path.join(storeDir, '_metadata.json');
          if (!fs.existsSync(metaPath)) {
            sendJSON(res, 404, { error: 'No local files found for this collection.' });
            return;
          }
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          const fileMeta = meta[fileId];
          if (!fileMeta) {
            sendJSON(res, 404, { error: 'File not found locally.' });
            return;
          }
          const localFilePath = path.join(storeDir, fileMeta.localFile);
          if (!fs.existsSync(localFilePath)) {
            sendJSON(res, 404, { error: 'Local file has been removed.' });
            return;
          }
          const fileContent = fs.readFileSync(localFilePath);
          const mime = fileMeta.mimeType || 'application/octet-stream';
          const originalName = fileMeta.originalName || fileMeta.localFile;
          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Disposition': `inline; filename="${encodeURIComponent(originalName)}"`,
            'Content-Length': fileContent.length
          });
          res.end(fileContent);
        } catch (viewErr) {
          console.error('[Policy] File view error:', viewErr.message);
          sendJSON(res, 500, { error: viewErr.message });
        }
        return;
      }

      // DELETE /api/policy-collections/:id/files/:fileId — Delete file from File Search Store (like Audit Studio)
      if (collId && subResource === 'files' && fileId && req.method === 'DELETE') {
        const collRow = dbGetPolicyCollection.get(collId);
        const storeId = collRow?.store_id || '';
        if (!storeId) {
          sendJSON(res, 404, { error: 'Collection has no store' });
          return;
        }

        const documentName = `fileSearchStores/${storeId}/documents/${fileId}`;
        console.log(`[Policy] Deleting document: ${documentName}`);
        await deleteDocument(documentName, apiKey);
        invalidatePolicyStoreDocCountCache(storeId);

        sendJSON(res, 200, { success: true });
        return;
      }

      // POST /api/policy-collections/:id/sync — Sync existing files to Gemini + File Search
      if (collId && subResource === 'sync' && req.method === 'POST') {
        if (!apiKey) {
          sendJSON(res, 401, { error: 'Gemini API key not configured.' });
          return;
        }
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Collection not found' }); return; }

        if (!genai) genai = new GoogleGenAI({ apiKey });

        // Ensure collection has a File Search Store
        let storeId = row.store_id || '';
        if (!storeId) {
          try {
            const safeName = (row.name || 'Policy Collection').replace(/[^\x20-\x7E]/g, '_');
            console.log(`[Sync] Creating File Search Store for "${safeName}"...`);
            const storeResult = await createFileSearchStore(safeName, apiKey);
            let store = storeResult;
            if (storeResult.name && !storeResult.done && !storeResult.name.startsWith('fileSearchStores/')) {
              store = await pollOperation(storeResult.name, apiKey);
              store = store.response || store;
            }
            storeId = (store.name || '').replace('fileSearchStores/', '');
            dbUpdatePolicyCollectionStoreId.run(storeId, collId);
            console.log(`[Sync] File Search Store created: ${storeId}`);
          } catch (err) {
            sendJSON(res, 500, { error: `Failed to create File Search Store: ${err.message}` });
            return;
          }
        }

        // Files are now managed directly in Gemini File Search Store — nothing to sync
        const storeName2 = `fileSearchStores/${storeId}`;
        const docs = await listStoreDocuments(storeName2, apiKey);
        const fileCount = (docs.documents || []).length;
        console.log(`[Sync] Collection ${collId} has ${fileCount} file(s) in store ${storeId}`);
        sendJSON(res, 200, { success: true, storeId, fileCount, message: 'Files managed directly in Gemini File Search Store.' });
        return;
      }

      // POST /api/policy-collections/:id/extract — Run Gemini extraction
      if (collId && subResource === 'extract' && req.method === 'POST') {
        if (!apiKey) {
          sendJSON(res, 401, { error: 'Gemini API key not configured.' });
          return;
        }
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Collection not found' }); return; }

        const body = await parseBody(req);
        const config = {
          generationType: body.generationType || 'both',
          libraryName: body.libraryName || row.name,
          provider: body.provider || row.name || 'Organization',
          language: body.language || 'en',
          detailLevel: body.detailLevel || 'comprehensive',
          linkedFrameworkIds: body.linkedFrameworkIds || [],
        };

        // Save config
        const now2 = new Date().toISOString();
        dbUpdatePolicyCollection.run(row.name, row.description, 'generating', JSON.stringify(config), null, now2, collId);

        // Get files from Gemini File Search Store (no local DB dependency)
        const storeId = row.store_id || '';
        if (!storeId) {
          sendJSON(res, 400, { error: 'Collection has no File Search Store.' });
          return;
        }

        const storeName = `fileSearchStores/${storeId}`;
        let storeDocs = [];
        try {
          const result = await listStoreDocuments(storeName, apiKey);
          storeDocs = (result.documents || []).filter(doc => doc.state === 'STATE_ACTIVE');
        } catch (listErr) {
          sendJSON(res, 500, { error: `Could not list files: ${listErr.message}` });
          return;
        }

        // Optionally filter by selected document IDs
        if (body.selectedFileIds && body.selectedFileIds.length > 0) {
          storeDocs = storeDocs.filter(doc => {
            const docId = (doc.name || '').split('/').pop();
            return body.selectedFileIds.includes(docId);
          });
        }

        if (storeDocs.length === 0) {
          sendJSON(res, 400, { error: 'No files to extract from.' });
          return;
        }

        console.log(`[Policy Extraction] Starting for collection "${row.name}" with ${storeDocs.length} file(s)...`);

        try {
          // Initialize Gemini SDK
          if (!genai) genai = new GoogleGenAI({ apiKey });

          // Determine generation type: 'framework', 'controls', or 'both' (legacy)
          const generationType = config.generationType || 'both';

          // Pick the right system prompt based on generation type
          let systemPrompt;
          if (generationType === 'framework') {
            systemPrompt = getFrameworkExtractorPrompt();
          } else if (generationType === 'controls') {
            systemPrompt = getRefControlsExtractorPrompt();
          } else {
            systemPrompt = getPolicyExtractorPrompt(); // Legacy: both framework + controls
          }

          // Compute slugs for URN generation
          const orgSlug = (config.provider || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const libSlug = (config.libraryName || row.name || 'policy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          // Build the task description based on generation type
          let taskDesc;
          if (generationType === 'framework') {
            taskDesc = 'Extract the document structure into a CISO Assistant framework library (framework + requirement_nodes ONLY, no reference_controls).';
          } else if (generationType === 'controls') {
            taskDesc = 'Extract reusable reference controls (procedures, technical controls, processes) into a CISO Assistant controls library (reference_controls ONLY, no framework).';
          } else {
            taskDesc = 'Extract all policies from the uploaded document(s) into a full CISO Assistant library (framework + requirement_nodes + reference_controls).';
          }

          const fileNames = storeDocs.map(d => d.displayName || d.name || 'document').join(', ');
          let userPrompt = `${taskDesc}\n\n`;
          userPrompt += `Documents to analyze: ${fileNames}\n\n`;
          userPrompt += `Use these EXACT values in the output JSON:\n`;
          userPrompt += `- urn: "urn:${orgSlug}:risk:library:${libSlug}"\n`;
          userPrompt += `- locale: "${config.language || 'en'}"\n`;
          userPrompt += `- ref_id: "${libSlug}"\n`;
          userPrompt += `- name: "${config.libraryName}"\n`;
          userPrompt += `- provider: "${config.provider || ''}"\n`;
          userPrompt += `- copyright: "© ${config.provider || 'Organization'} ${new Date().getFullYear()}"\n`;
          userPrompt += `- <org-slug>: "${orgSlug}"\n`;
          userPrompt += `- <lib-slug>: "${libSlug}"\n\n`;
          userPrompt += `Configuration:\n`;
          userPrompt += `- Generation Type: ${generationType}\n`;
          userPrompt += `- Detail Level: ${config.detailLevel}\n`;
          if (config.linkedFrameworkIds && config.linkedFrameworkIds.length > 0) {
            userPrompt += `- Link to Framework IDs: ${config.linkedFrameworkIds.join(', ')}\n`;
          }
          userPrompt += `\nPlease analyze ALL the documents from the file search store and extract into the JSON structure specified by your instructions. Return ONLY valid JSON.`;

          // Use File Search grounding (same as chat) — files are in the store, no need to re-upload
          const fileSearchStoreNames = [storeName];

          console.log(`[Policy Extraction] Calling Gemini with File Search grounding (store: ${storeId}, ${storeDocs.length} docs)...`);
          const startTime = Date.now();

          const response = await genai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            config: {
              systemInstruction: systemPrompt,
              tools: [{ fileSearch: { fileSearchStoreNames } }],
              temperature: 0.2,
              maxOutputTokens: 65536,
            },
          });

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[Policy Extraction] Gemini responded in ${elapsed}s`);

          const textResponse = response.text || '';
          if (!textResponse) throw new Error('No response from Gemini');

          // Parse JSON from response
          let jsonStr = textResponse.trim();
          const jsonMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) jsonStr = jsonMatch[1].trim();
          if (!jsonStr.startsWith('{')) {
            const obj = jsonStr.match(/\{[\s\S]*\}/);
            if (obj) jsonStr = obj[0];
          }

          const extractedLibrary = JSON.parse(jsonStr);

          // The AI returns the full library structure (with top-level urn, name, objects, etc.)
          // Extract the objects part for metadata computation
          const libObjects = extractedLibrary.objects || extractedLibrary;
          const refControls = libObjects.reference_controls || [];
          const framework = libObjects.framework || {};
          const reqNodes = framework.requirement_nodes || [];
          const assessableNodes = reqNodes.filter(n => n.assessable);
          const csfFunctions = [...new Set(refControls.map(rc => rc.csf_function).filter(Boolean))];
          const categories = [...new Set(refControls.map(rc => rc.category).filter(Boolean))];

          // Compute confidence from annotations
          let totalConfidence = 0;
          let confCount = 0;
          // For framework mode: parse annotations from assessable nodes
          assessableNodes.forEach(n => {
            try {
              const ann = JSON.parse(n.annotation || '{}');
              if (ann.confidence) { totalConfidence += ann.confidence; confCount++; }
            } catch (e) { /* ignore */ }
          });
          // For controls mode: parse annotations from reference controls
          refControls.forEach(rc => {
            try {
              const ann = JSON.parse(rc.annotation || '{}');
              if (ann.confidence) { totalConfidence += ann.confidence; confCount++; }
            } catch (e) { /* ignore */ }
          });
          const avgConfidence = confCount > 0 ? Math.round((totalConfidence / confCount) * 100) : 85;

          // Build result based on generation type
          const result = {
            id: 'pg-' + crypto.randomUUID(),
            collectionId: collId,
            generationType, // 'framework', 'controls', or 'both'
            libraryName: config.libraryName,
            provider: config.provider,
            language: config.language,
            confidenceScore: avgConfidence,
            generationTime: elapsed + 's',
            sourceFileCount: storeDocs.length,
            extractedLibrary,
            linkedFrameworks: config.linkedFrameworkIds || [],
          };

          if (generationType === 'framework') {
            // Framework mode: expose requirement nodes for review
            result.requirementNodes = reqNodes.map((rn, i) => ({
              id: 'rn-' + (i + 1),
              urn: rn.urn || '',
              ref_id: rn.ref_id || '',
              name: rn.name || 'Unnamed Node',
              description: rn.description || '',
              assessable: !!rn.assessable,
              depth: rn.depth || 1,
              parent_urn: rn.parent_urn || null,
            }));
            result.totalNodes = reqNodes.length;
            result.assessableNodes = assessableNodes.length;
            result.policies = []; // No policies in framework mode
          } else if (generationType === 'controls') {
            // Controls mode: expose reference controls for review (displayed as "policies")
            result.policies = refControls.map((rc, i) => ({
              id: 'gp-' + (i + 1),
              code: rc.ref_id || `RC-${i + 1}`,
              name: rc.name || 'Unnamed Control',
              description: rc.description || '',
              category: rc.category || 'policy',
              csfFunction: rc.csf_function || 'govern',
              sourceFile: storeDocs.length === 1 ? (storeDocs[0].displayName || 'Document') : 'Multiple files',
              sourcePages: '',
              linkedRequirements: [],
              linkedFrameworks: config.linkedFrameworkIds || [],
            }));
            result.csfDistribution = csfFunctions;
            result.categoryDistribution = categories;
          } else {
            // "Both" mode: full library with framework + controls
            result.requirementNodes = reqNodes.map((rn, i) => ({
              id: 'rn-' + (i + 1),
              urn: rn.urn || '',
              ref_id: rn.ref_id || '',
              name: rn.name || 'Unnamed Node',
              description: rn.description || '',
              assessable: !!rn.assessable,
              depth: rn.depth || 1,
              parent_urn: rn.parent_urn || null,
            }));
            result.totalNodes = reqNodes.length;
            result.assessableNodes = assessableNodes.length;
            result.policies = refControls.map((rc, i) => ({
              id: 'gp-' + (i + 1),
              code: rc.ref_id || `RC-${i + 1}`,
              name: rc.name || 'Unnamed Control',
              description: rc.description || '',
              category: rc.category || 'policy',
              csfFunction: rc.csf_function || 'govern',
              sourceFile: storeDocs.length === 1 ? (storeDocs[0].displayName || 'Document') : 'Multiple files',
              sourcePages: '',
              linkedRequirements: assessableNodes.filter(n => (n.reference_controls || []).includes(rc.urn)).map(n => n.ref_id || n.name).slice(0, 5),
              linkedFrameworks: config.linkedFrameworkIds || [],
            }));
            result.csfDistribution = csfFunctions;
            result.categoryDistribution = categories;
          }

          // Save to DB
          const now3 = new Date().toISOString();
          dbUpdatePolicyCollection.run(row.name, row.description, 'generated', JSON.stringify(config), JSON.stringify(result), now3, collId);

          // Save to generation history
          const historyId = 'gh-' + crypto.randomUUID();
          const historySummary = {
            libraryName: config.libraryName,
            provider: config.provider,
            language: config.language,
            detailLevel: config.detailLevel,
            csfDistribution: csfFunctions,
            categoryDistribution: categories,
          };
          dbInsertGenHistory.run(
            historyId, collId, generationType, 'generated',
            JSON.stringify(config), JSON.stringify(historySummary),
            null, // library_urn (not yet approved)
            refControls.length, reqNodes.length, avgConfidence,
            elapsed + 's', storeDocs.length, null,
            JSON.stringify(result), // extraction_data — full generated result
            now3
          );
          result.historyId = historyId;

          console.log(`[Policy Extraction] ✅ [${generationType}] Extracted ${refControls.length} reference controls, ${reqNodes.length} requirement nodes (${assessableNodes.length} assessable)`);

          sendJSON(res, 200, { success: true, data: result });

          // No cleanup needed — files stay in File Search Store

        } catch (extractErr) {
          console.error('[Policy Extraction] Error:', extractErr.message);
          const now3 = new Date().toISOString();
          dbUpdatePolicyCollection.run(row.name, row.description, 'ready', JSON.stringify(config), null, now3, collId);
          // Save failed extraction to history
          try {
            const histErrId = 'gh-' + crypto.randomUUID();
            dbInsertGenHistory.run(
              histErrId, collId, config.generationType || 'both', 'failed',
              JSON.stringify(config), '{}', null, 0, 0, 0, '', storeDocs.length,
              extractErr.message, null, now3
            );
          } catch (e) { /* ignore history save error */ }
          sendJSON(res, 500, { error: extractErr.message });
        }
        return;
      }

      // POST /api/policy-collections/:id/preview-library — YAML preview of the payload that would be uploaded (no GRC call)
      if (collId && subResource === 'preview-library' && req.method === 'POST') {
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
        if (!row.extraction_result) {
          sendJSON(res, 400, { error: 'No extraction result to preview. Run extraction first.' });
          return;
        }
        const body = await parseBody(req);
        try {
          const { libraryPayload, filename, generationType } = buildPolicyIngestionLibraryUploadPayload(row, body, true);
          const yamlStr = yaml.dump(libraryPayload, { lineWidth: 100, skipInvalid: false });
          sendJSON(res, 200, {
            success: true,
            data: { yaml: yamlStr, filename, generationType },
          });
        } catch (preErr) {
          console.error('[Policy Preview] ', preErr.message);
          sendJSON(res, 500, { error: preErr.message });
        }
        return;
      }

      // POST /api/policy-collections/:id/approve — Push full library + policies to GRC
      if (collId && subResource === 'approve' && req.method === 'POST') {
        const row = dbGetPolicyCollection.get(collId);
        if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
        if (!row.extraction_result) { sendJSON(res, 400, { error: 'No extraction result to approve.' }); return; }

        const body = await parseBody(req);
        const { libraryPayload, filename, generationType, result, uploadObjects, libObjects } = buildPolicyIngestionLibraryUploadPayload(row, body, false);

        console.log(`[Policy Approve] Generation type: ${generationType}`);

        console.log(`[Policy Approve] Step 1: Uploading ${generationType} library "${libraryPayload.name}" (${libraryPayload.urn}) as ${filename}`);

        // ── Step 1: Upload library via the existing YAML upload API ──
        let libraryCreated = false;
        let libraryError = null;
        let storedLibraryData = null;

        try {
          const libBody = Buffer.from(JSON.stringify(libraryPayload, null, 2), 'utf-8');
          const libRes = await grcFetch(`${GRC_API_URL}/api/stored-libraries/upload/`, {
            method: 'POST',
            headers: {
              'Content-Disposition': `attachment; filename=${filename}`,
              'Content-Length': String(libBody.length),
            },
            body: libBody,
          }, reqToken);

          if (await finalizeGrcUpstreamError(res, reqToken, libRes)) return;
          storedLibraryData = await libRes.json();
          libraryCreated = true;
          console.log(`[Policy Approve] ✅ Library uploaded & loaded: ${storedLibraryData.id || storedLibraryData.status}`);
        } catch (libErr) {
          libraryError = libErr.message;
          console.error(`[Policy Approve] ⚠ Library upload exception: ${libErr.message}`);
        }

        // Reference controls are created automatically when the library is uploaded.
        // Applied controls are added manually by the user in the GRC platform.
        const grcResults = [];
        const grcErrors = [];

        // Verify reference controls were created in GRC after library upload
        if (libraryCreated && storedLibraryData && generationType !== 'framework') {
          try {
            const rcRes = await grcFetch(
              `${GRC_API_URL}/api/reference-controls/?library=${storedLibraryData.loaded_library || ''}&page_size=500`,
              {}, reqToken
            );
            if (await finalizeGrcUpstreamError(res, reqToken, rcRes)) return;
            const rcData = await rcRes.json();
            const rcList = rcData.results || rcData || [];
            console.log(`[Policy Approve] ✅ Verified ${rcList.length} reference controls created in GRC from library upload`);
            rcList.forEach(rc => {
              grcResults.push({ id: rc.id, name: rc.name || rc.ref_id, success: true });
            });
          } catch (e) {
            console.warn(`[Policy Approve] Could not verify reference controls: ${e.message}`);
          }
        }

        // ── Step 3: Save approved state ──
        const now2 = new Date().toISOString();
        result.approved = true;
        result.approvedAt = now2;
        result.libraryCreated = libraryCreated;
        result.libraryUrn = libraryPayload.urn;
        result.libraryError = libraryError;
        result.grcResults = grcResults;
        result.grcErrors = grcErrors;
        dbUpdatePolicyCollection.run(row.name, row.description, 'approved', row.config, JSON.stringify(result), now2, collId);

        // Update the generation history record with approve result
        const historyId = result.historyId;
        if (historyId) {
          const approveStatus = grcErrors.length > 0 ? 'approved_with_errors' : 'approved';
          dbUpdateGenHistoryStatus.run(approveStatus, libraryPayload.urn, grcErrors.length > 0 ? `${grcErrors.length} errors during push` : null, historyId);
        }

        const totalItems = generationType === 'framework'
          ? (libObjects.framework?.requirement_nodes?.length || 0)
          : (uploadObjects.reference_controls?.length || 0);
        console.log(`[Policy Approve] ✅ [${generationType}] Done: library=${libraryCreated ? 'created' : 'failed'}, ${grcResults.length} reference controls verified (${grcErrors.length} errors)`);

        sendJSON(res, 200, {
          success: true,
          data: {
            approved: true,
            generationType,
            libraryCreated,
            libraryUrn: libraryPayload.urn,
            libraryError,
            created: grcResults.length,
            errors: grcErrors.length,
            total: totalItems,
            grcResults,
            grcErrors,
          }
        });
        return;
      }

      // POST /api/policy-collections/:id/history/:historyId/preview-library — YAML from this history row’s extraction_data (+ body edits)
      if (collId && subResource === 'history' && fileId && histSub === 'preview-library' && req.method === 'POST') {
        const r = dbGetGenHistoryById.get(fileId);
        if (!r) { sendJSON(res, 404, { error: 'History entry not found' }); return; }
        if (r.collection_id !== collId) { sendJSON(res, 404, { error: 'History entry not found' }); return; }
        if (!r.extraction_data || !String(r.extraction_data).trim()) {
          sendJSON(res, 400, { error: 'No extraction data for this history entry.' });
          return;
        }
        const body = await parseBody(req);
        const collRow = dbGetPolicyCollection.get(collId);
        let cfg = {};
        try { cfg = JSON.parse(r.config || '{}'); } catch (e) { cfg = {}; }
        const pseudoRow = {
          extraction_result: r.extraction_data,
          config: r.config,
          name: collRow?.name || cfg.libraryName || 'Policy library',
          description: collRow?.description || '',
        };
        try {
          const { libraryPayload, filename, generationType } = buildPolicyIngestionLibraryUploadPayload(pseudoRow, body, true);
          const yamlStr = yaml.dump(libraryPayload, { lineWidth: 100, skipInvalid: false });
          sendJSON(res, 200, {
            success: true,
            data: { yaml: yamlStr, filename, generationType },
          });
        } catch (preErr) {
          console.error('[Policy History Preview] ', preErr.message);
          sendJSON(res, 500, { error: preErr.message });
        }
        return;
      }

      // GET /api/policy-collections/:id/history/:historyId — Single history entry with full data
      if (collId && subResource === 'history' && fileId && !histSub && req.method === 'GET') {
        const r = dbGetGenHistoryById.get(fileId);
        if (!r) { sendJSON(res, 404, { error: 'History entry not found' }); return; }
        if (r.collection_id !== collId) { sendJSON(res, 404, { error: 'History entry not found' }); return; }
        sendJSON(res, 200, {
          success: true,
          data: {
            id: r.id,
            collectionId: r.collection_id,
            generationType: r.generation_type,
            status: r.status,
            config: JSON.parse(r.config || '{}'),
            summary: JSON.parse(r.summary || '{}'),
            libraryUrn: r.library_urn,
            controlsCount: r.controls_count,
            nodesCount: r.nodes_count,
            confidenceScore: r.confidence_score,
            generationTime: r.generation_time,
            sourceFileCount: r.source_file_count,
            errorMessage: r.error_message,
            extractionData: r.extraction_data ? JSON.parse(r.extraction_data) : null,
            createdAt: r.created_at,
          },
        });
        return;
      }

      // PATCH /api/policy-collections/:id/history/:historyId — Update stored extraction_data (e.g. edits in History detail)
      if (collId && subResource === 'history' && fileId && !histSub && req.method === 'PATCH') {
        const row = dbGetGenHistoryById.get(fileId);
        if (!row) { sendJSON(res, 404, { error: 'History entry not found' }); return; }
        if (row.collection_id !== collId) { sendJSON(res, 404, { error: 'History entry not found' }); return; }
        const body = await parseBody(req);
        let ex = body.extractionData;
        if (ex === undefined || ex === null) {
          sendJSON(res, 400, { error: 'extractionData is required' });
          return;
        }
        if (typeof ex === 'string') {
          try { ex = JSON.parse(ex); } catch (e) {
            sendJSON(res, 400, { error: 'extractionData must be a JSON object' });
            return;
          }
        }
        if (typeof ex !== 'object' || Array.isArray(ex)) {
          sendJSON(res, 400, { error: 'extractionData must be a JSON object' });
          return;
        }

        const rn = Array.isArray(ex.requirementNodes) ? ex.requirementNodes : [];
        const pol = Array.isArray(ex.policies) ? ex.policies : [];
        ex.requirementNodes = rn;
        ex.policies = pol;
        ex.totalNodes = rn.length;
        ex.assessableNodes = rn.filter(n => n && n.assessable).length;

        const csf = {};
        const cat = {};
        for (const p of pol) {
          if (!p) continue;
          const c = (p.csfFunction || 'govern').toLowerCase();
          csf[c] = (csf[c] || 0) + 1;
          const k = (p.category || 'policy').toLowerCase();
          cat[k] = (cat[k] || 0) + 1;
        }
        ex.csfDistribution = csf;
        ex.categoryDistribution = cat;

        const nodesCount = rn.length;
        const controlsCount = pol.length;
        const extractionStr = JSON.stringify(ex);
        dbUpdateGenHistoryExtraction.run(extractionStr, nodesCount, controlsCount, fileId, collId);

        const r = dbGetGenHistoryById.get(fileId);
        sendJSON(res, 200, {
          success: true,
          data: {
            id: r.id,
            collectionId: r.collection_id,
            generationType: r.generation_type,
            status: r.status,
            config: JSON.parse(r.config || '{}'),
            summary: JSON.parse(r.summary || '{}'),
            libraryUrn: r.library_urn,
            controlsCount: r.controls_count,
            nodesCount: r.nodes_count,
            confidenceScore: r.confidence_score,
            generationTime: r.generation_time,
            sourceFileCount: r.source_file_count,
            errorMessage: r.error_message,
            extractionData: r.extraction_data ? JSON.parse(r.extraction_data) : null,
            createdAt: r.created_at,
          },
        });
        return;
      }

      // GET /api/policy-collections/:id/history — List generation history
      if (collId && subResource === 'history' && !fileId && req.method === 'GET') {
        const rows = dbListGenHistory.all(collId);
        const history = rows.map(r => ({
          id: r.id,
          collectionId: r.collection_id,
          generationType: r.generation_type,
          status: r.status,
          config: JSON.parse(r.config || '{}'),
          summary: JSON.parse(r.summary || '{}'),
          libraryUrn: r.library_urn,
          controlsCount: r.controls_count,
          nodesCount: r.nodes_count,
          confidenceScore: r.confidence_score,
          generationTime: r.generation_time,
          sourceFileCount: r.source_file_count,
          errorMessage: r.error_message,
          hasData: !!r.extraction_data,
          createdAt: r.created_at,
        }));
        sendJSON(res, 200, { success: true, data: history });
        return;
      }

      // ── POST /api/policy-collections/chat — Chat with files using Gemini 2.5 Pro + File Search grounding ──
      // Also handles: POST /api/policy-collections/:collectionId/chat
      if (subResource === 'chat' && req.method === 'POST') {
        if (!apiKey) {
          sendJSON(res, 401, { error: 'Gemini API key not configured.' });
          return;
        }

        const body = await parseBody(req);
        const userMessage = (body.message || '').trim();
        if (!userMessage) {
          sendJSON(res, 400, { error: 'message is required.' });
          return;
        }

        // Collect File Search Store IDs — from body or from the collection's storeId
        let storeIds = body.storeIds || [];
        if (typeof storeIds === 'string') storeIds = [storeIds];

        // If called as /api/policy-collections/:id/chat, auto-include that collection's store
        if (collId && collId !== 'chat') {
          const coll = dbGetPolicyCollection.get(collId);
          if (coll && coll.store_id && !storeIds.includes(coll.store_id)) {
            storeIds.unshift(coll.store_id);
          }
        }

        // Session management — allow multi-turn conversations
        let sessionId = body.sessionId || null;
        const systemInstruction = body.systemInstruction || 'You are Wathbah AI, a helpful assistant specialized in governance, risk, compliance (GRC), and organizational policy analysis. Answer questions based on the provided documents. Be precise, cite specific sections when possible, and format your responses clearly.';

        // Build File Search grounding tool
        const tools = [];
        if (storeIds.length > 0) {
          const fileSearchStoreNames = storeIds.map(id =>
            id.startsWith('fileSearchStores/') ? id : `fileSearchStores/${id}`
          );
          tools.push({ fileSearch: { fileSearchStoreNames } });
          console.log(`[Chat] Using File Search Stores:`, fileSearchStoreNames);
        }

        try {
          // Ensure Gemini SDK is initialized
          if (!genai) genai = new GoogleGenAI({ apiKey });

          // Reuse or create chat session
          if (!sessionId || !policyChats[sessionId]) {
            sessionId = 'pchat-' + crypto.randomUUID();
            console.log(`[Chat] Creating new session ${sessionId} with ${storeIds.length} store(s)`);

            const chatConfig = {
              systemInstruction,
              temperature: 0.7,
              maxOutputTokens: 8192,
            };

            if (tools.length > 0) {
              chatConfig.tools = tools;
            }

            policyChats[sessionId] = {
              chat: genai.chats.create({
                model: 'gemini-2.5-pro',
                config: chatConfig,
              }),
              storeIds,
              history: [],
              createdAt: new Date().toISOString(),
            };
          }

          const session = policyChats[sessionId];
          console.log(`[Chat] Session ${sessionId} — user: "${userMessage.substring(0, 80)}..."`);

          // Send message via SDK chat (multi-turn)
          const result = await session.chat.sendMessage({ message: userMessage });

          // Extract text response
          const aiText = result.text || '';

          // Extract grounding metadata if present
          const groundingMetadata = result.candidates?.[0]?.groundingMetadata || null;
          const groundingChunks = groundingMetadata?.groundingChunks || [];
          const sources = groundingChunks.map(chunk => ({
            title: chunk.retrievedContext?.title || null,
            uri: chunk.retrievedContext?.uri || null,
          })).filter(s => s.title || s.uri);

          // Track history
          session.history.push(
            { role: 'user', text: userMessage, timestamp: new Date().toISOString() },
            { role: 'model', text: aiText, sources, timestamp: new Date().toISOString() }
          );

          sendJSON(res, 200, {
            success: true,
            sessionId,
            message: aiText,
            sources,
            turnCount: Math.floor(session.history.length / 2),
          });

        } catch (chatErr) {
          console.error(`[Chat] Error in session ${sessionId}:`, chatErr.message);
          sendJSON(res, 500, { error: chatErr.message });
        }
        return;
      }

      // Fallback
      sendJSON(res, 405, { error: 'Method not allowed' });

    } catch (error) {
      console.error('Policy Collections API Error:', error.message);
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  // ---- Collections API ----
  const collectionsMatch = url.pathname.match(/^\/api\/collections(?:\/([^\/]+))?(?:\/(files)(?:\/([^\/]+))?(?:\/(view))?)?$/);
  if (collectionsMatch) {
    const storeId = collectionsMatch[1];
    const isFiles = collectionsMatch[2] === 'files';
    const fileId = collectionsMatch[3]; // optional file ID for single-file ops
    const isView = collectionsMatch[4] === 'view'; // /view suffix for downloading
    const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];

    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not configured.' }));
      return;
    }

    try {
      // POST /api/collections — Create a new file search store
      if (!storeId && req.method === 'POST') {
        const body = await parseBody(req);
        const displayName = body.displayName || 'Untitled Collection';
        console.log(`Creating file search store: "${displayName}"`);
        
        const store = await createFileSearchStore(displayName, apiKey);
        console.log('Store created:', store);
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: store }));
        return;
      }

      // GET /api/collections — List all file search stores
      if (!storeId && req.method === 'GET') {
        console.log('Listing file search stores...');
        const stores = await listFileSearchStores(apiKey);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: stores }));
        return;
      }

      // DELETE /api/collections/:id — Delete a file search store
      if (storeId && !isFiles && req.method === 'DELETE') {
        const storeName = `fileSearchStores/${storeId}`;
        console.log(`Deleting store: ${storeName}`);
        
        await deleteFileSearchStore(storeName, apiKey);

        // Clean up local copies
        try {
          const localStoreDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          if (fs.existsSync(localStoreDir)) {
            fs.rmSync(localStoreDir, { recursive: true, force: true });
            console.log(`Local files cleaned up for store ${storeId}`);
          }
        } catch (cleanErr) {
          console.warn(`Could not clean up local files for store ${storeId}: ${cleanErr.message}`);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // POST /api/collections/:id/files — Upload file to a store
      if (storeId && isFiles && !fileId && req.method === 'POST') {
        const body = await parseBody(req);
        const { fileName, mimeType, data } = body;

        if (!fileName || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'fileName and data (base64) are required.' }));
          return;
        }

        const storeName = `fileSearchStores/${storeId}`;
        console.log(`Uploading file "${fileName}" to store ${storeName}`);

        // Upload directly to the file search store (resumable protocol)
        const fileBuffer = Buffer.from(data, 'base64');
        const result = await uploadFileToStore(
          storeName,
          fileName,
          mimeType || 'application/octet-stream',
          fileBuffer,
          apiKey
        );
        console.log('Upload + index result:', JSON.stringify(result).slice(0, 200));

        // Poll the operation if it's a long-running operation
        let finalResult = result;
        if (result.name && !result.done) {
          console.log('Polling upload operation...');
          finalResult = await pollOperation(result.name, apiKey, GEMINI_FILE_SEARCH_INDEX_POLL_MS);
          console.log('Upload complete:', finalResult.done);
        }

        // Save a local copy for viewing/downloading
        try {
          const storeDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
          const safeFileName = uniqueAsciiLocalFileName(fileName, fileBuffer);
          const localFilePath = path.join(storeDir, safeFileName);
          fs.writeFileSync(localFilePath, fileBuffer);
          // Also save metadata for name mapping
          const metaPath = path.join(storeDir, '_metadata.json');
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
          // Extract the document ID from the result (the Gemini API returns it)
          const docPath = extractDocumentResourceNameFromUploadOp(finalResult);
          const docId =
            (docPath && docPath.includes('/documents/') && docPath.split('/').pop()) ||
            safeFileName;
          meta[docId] = { originalName: fileName, localFile: safeFileName, mimeType: mimeType || 'application/octet-stream', size: fileBuffer.length, uploadedAt: new Date().toISOString() };
          // Also store by safe filename as a fallback lookup
          meta[safeFileName] = meta[docId];
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          console.log(`Local copy saved: ${localFilePath} (docId: ${docId})`);
        } catch (localErr) {
          console.warn(`Could not save local copy of "${fileName}": ${localErr.message}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: finalResult
        }));
        return;
      }

      // GET /api/collections/:id/files/:fileId/view — Download/view a locally stored file
      if (storeId && isFiles && fileId && isView && req.method === 'GET') {
        try {
          const storeDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          const metaPath = path.join(storeDir, '_metadata.json');

          if (!fs.existsSync(metaPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No local files found for this collection. Files uploaded before local storage was enabled cannot be viewed.' }));
            return;
          }

          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          const fileMeta = meta[fileId];

          if (!fileMeta) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found locally. It may have been uploaded before local storage was enabled.' }));
            return;
          }

          const localFilePath = path.join(storeDir, fileMeta.localFile);
          if (!fs.existsSync(localFilePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Local file has been removed.' }));
            return;
          }

          const fileContent = fs.readFileSync(localFilePath);
          const mime = fileMeta.mimeType || 'application/octet-stream';
          const originalName = fileMeta.originalName || fileMeta.localFile;

          // Set headers for inline viewing (browser will display PDFs, images, etc.)
          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Disposition': `inline; filename="${encodeURIComponent(originalName)}"`,
            'Content-Length': fileContent.length
          });
          res.end(fileContent);
        } catch (viewErr) {
          console.error('File view error:', viewErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: viewErr.message }));
        }
        return;
      }

      // GET /api/collections/:id/files — List files in a store
      if (storeId && isFiles && !fileId && req.method === 'GET') {
        const storeName = `fileSearchStores/${storeId}`;
        console.log(`Listing documents in ${storeName}`);
        
        const docs = await listStoreDocuments(storeName, apiKey);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: docs }));
        return;
      }

      // DELETE /api/collections/:id/files/:fileId — Delete a single file
      if (storeId && isFiles && fileId && !isView && req.method === 'DELETE') {
        const documentName = `fileSearchStores/${storeId}/documents/${fileId}`;
        console.log(`Deleting document: ${documentName}`);
        
        await deleteDocument(documentName, apiKey);

        // Also clean up local copy
        try {
          const delStoreDir = path.join(COLLECTION_UPLOADS_DIR, storeId);
          const delMetaPath = path.join(delStoreDir, '_metadata.json');
          if (fs.existsSync(delMetaPath)) {
            const delMeta = JSON.parse(fs.readFileSync(delMetaPath, 'utf-8'));
            if (delMeta[fileId]) {
              const localFile = delMeta[fileId].localFile;
              if (localFile) {
                const localPath = path.join(delStoreDir, localFile);
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
              }
              delete delMeta[fileId];
              // Clean up the safe-name alias too
              Object.keys(delMeta).forEach(k => {
                if (delMeta[k] && delMeta[k].localFile === delMeta[fileId]?.localFile) delete delMeta[k];
              });
              fs.writeFileSync(delMetaPath, JSON.stringify(delMeta, null, 2));
            }
          }
        } catch (delLocalErr) {
          console.warn(`Could not clean up local file for ${fileId}: ${delLocalErr.message}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Fallback — method not allowed
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));

    } catch (error) {
      console.error('Collections API Error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- Chain Resolution API ----

  // POST /api/chain/resolve/:orgContextId — Trigger full chain resolution
  const chainResolveMatch = url.pathname.match(/^\/api\/chain\/resolve\/([^\/]+)$/);
  if (chainResolveMatch && req.method === 'POST') {
    try {
      const orgContextId = chainResolveMatch[1];
      console.log(`[Chain API] Resolve request for org: ${orgContextId}`);
      const result = await resolveOrgContextChain(orgContextId, reqToken);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));
    } catch (error) {
      console.error('[Chain API] Resolve error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /api/chain/:orgContextId — Get full resolved chain
  const chainGetMatch = url.pathname.match(/^\/api\/chain\/([^\/]+)$/);
  if (chainGetMatch && req.method === 'GET') {
    try {
      const orgContextId = chainGetMatch[1];
      const rows = dbGetChainByOrg.all(orgContextId);
      const orgRow = dbGetOrgContext.get(orgContextId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        orgContext: orgRow ? { id: orgRow.id, nameEn: orgRow.name_en, nameAr: orgRow.name_ar } : null,
        chainRows: rows.length,
        chain: rows.map(r => ({
          chainId: r.chain_id,
          objective: r.objective_uuid ? { uuid: r.objective_uuid, name: r.objective_name, refId: r.objective_ref } : null,
          framework: r.framework_uuid ? { uuid: r.framework_uuid, name: r.framework_name, refId: r.framework_ref } : null,
          requirement: r.requirement_uuid ? { uuid: r.requirement_uuid, name: r.requirement_name, refId: r.requirement_ref } : null,
          complianceAssessment: r.compliance_assessment_uuid ? { uuid: r.compliance_assessment_uuid, name: r.compliance_assessment_name } : null,
          requirementAssessment: r.requirement_assessment_uuid ? { uuid: r.requirement_assessment_uuid, name: r.requirement_assessment_name, status: r.requirement_assessment_status } : null,
          riskScenario: r.risk_scenario_uuid ? { uuid: r.risk_scenario_uuid, name: r.risk_scenario_name, refId: r.risk_scenario_ref, status: r.risk_scenario_status } : null,
          control: r.applied_control_uuid ? { uuid: r.applied_control_uuid, name: r.control_name, refId: r.control_ref, status: r.control_status } : null,
          resolvedAt: r.resolved_at,
        })),
      }));
    } catch (error) {
      console.error('[Chain API] Get chain error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // GET /api/chain/:orgContextId/summary — Aggregate stats
  const chainSummaryMatch = url.pathname.match(/^\/api\/chain\/([^\/]+)\/summary$/);
  if (chainSummaryMatch && req.method === 'GET') {
    try {
      const orgContextId = chainSummaryMatch[1];
      const rows = dbGetChainByOrg.all(orgContextId);
      const orgRow = dbGetOrgContext.get(orgContextId);

      // Aggregate: controls per framework
      const fwControlMap = {};
      // Aggregate: coverage per objective
      const objCoverageMap = {};
      // Aggregate: unmitigated risks
      const unmitigatedRisks = new Set();
      // Track unique entities
      const uniqueObjectives = new Set();
      const uniqueFrameworks = new Set();
      const uniqueRequirements = new Set();
      const uniqueRisks = new Set();
      const uniqueControls = new Set();

      for (const r of rows) {
        if (r.objective_uuid) uniqueObjectives.add(r.objective_uuid);
        if (r.framework_uuid) uniqueFrameworks.add(r.framework_uuid);
        if (r.requirement_uuid) uniqueRequirements.add(r.requirement_uuid);
        if (r.risk_scenario_uuid) uniqueRisks.add(r.risk_scenario_uuid);
        if (r.applied_control_uuid) uniqueControls.add(r.applied_control_uuid);

        // Controls per framework
        if (r.framework_uuid && r.applied_control_uuid) {
          const fwKey = r.framework_name || r.framework_uuid;
          if (!fwControlMap[fwKey]) fwControlMap[fwKey] = new Set();
          fwControlMap[fwKey].add(r.applied_control_uuid);
        }

        // Coverage per objective
        if (r.objective_uuid) {
          const objKey = r.objective_name || r.objective_uuid;
          if (!objCoverageMap[objKey]) objCoverageMap[objKey] = { frameworks: new Set(), requirements: new Set(), risks: new Set(), controls: new Set() };
          if (r.framework_uuid) objCoverageMap[objKey].frameworks.add(r.framework_uuid);
          if (r.requirement_uuid) objCoverageMap[objKey].requirements.add(r.requirement_uuid);
          if (r.risk_scenario_uuid) objCoverageMap[objKey].risks.add(r.risk_scenario_uuid);
          if (r.applied_control_uuid) objCoverageMap[objKey].controls.add(r.applied_control_uuid);
        }

        // Unmitigated risks
        if (r.risk_scenario_uuid && !r.applied_control_uuid) {
          unmitigatedRisks.add(r.risk_scenario_name || r.risk_scenario_uuid);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        orgContext: orgRow ? { id: orgRow.id, nameEn: orgRow.name_en } : null,
        totals: {
          chainRows: rows.length,
          objectives: uniqueObjectives.size,
          frameworks: uniqueFrameworks.size,
          requirements: uniqueRequirements.size,
          riskScenarios: uniqueRisks.size,
          appliedControls: uniqueControls.size,
        },
        controlsPerFramework: Object.entries(fwControlMap).map(([fw, ctrls]) => ({
          framework: fw,
          controlCount: ctrls.size,
        })),
        coveragePerObjective: Object.entries(objCoverageMap).map(([obj, sets]) => ({
          objective: obj,
          frameworks: sets.frameworks.size,
          requirements: sets.requirements.size,
          risks: sets.risks.size,
          controls: sets.controls.size,
        })),
        unmitigatedRisks: [...unmitigatedRisks],
      }));
    } catch (error) {
      console.error('[Chain API] Summary error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // ---- Client-side routes (serve admin.html for SPA pages) ----
  if (isAdminSpaPath(url.pathname)) {
    serveStaticFile(res, path.join(__dirname, 'admin.html'));
    return;
  }

  // ---- Static Files ----
  let filePath = path.join(__dirname, url.pathname);
  serveStaticFile(res, filePath);
});

server.listen(PORT, () => {
  const apiKeyStatus = GEMINI_API_KEY ? '✅ Configured' : '❌ Not configured';
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 Wathbah Auditor Assistant                            ║
║                                                           ║
║   Server running at: http://localhost:${PORT}               ║
║                                                           ║
║   Gemini API Key: ${apiKeyStatus.padEnd(36)}║
║                                                           ║
║   GRC API:    ${String(GRC_API_URL).slice(0, 44).padEnd(44)}║
║   Muraji API: ${String(MURAJI_API_URL).slice(0, 44).padEnd(44)}║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /                        - Serve the app         ║
║   • POST /api/analyze             - Analyze requirements  ║
║   • POST /api/ai-tools/policy-update-pipeline - F1–F4     ║
║   • GET  /api/collections         - List collections      ║
║   • POST /api/collections         - Create collection     ║
║   • DELETE /api/collections/:id   - Delete collection     ║
║   • GET  /api/collections/:id/files - List files          ║
║   • POST /api/collections/:id/files - Upload file         ║
║   • DELETE /api/collections/:id/files/:fid - Delete file  ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
