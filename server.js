const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const Database = require('better-sqlite3');
const yaml = require('js-yaml');
const XLSX = require('xlsx');
const { runPolicyUpdatePipeline } = require('./policyUpdatePipeline');

const PORT = 5555; // Wathbah server port
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

// GRC Platform configuration
const GRC_API_URL = (process.env.GRC_API_URL || 'https://grc.wathbah.dev').replace(/\/+$/, '');

/** GCS bucket for legislative internal documents (override with GCS_LEGISLATIVE_BUCKET). Uses GOOGLE_APPLICATION_CREDENTIALS or default credentials. */
const GCS_LEGISLATIVE_BUCKET_NAME = String(
  process.env.GCS_LEGISLATIVE_BUCKET || 'local-legislative-updates-docs'
).replace(/\/+$/, '');

/** GCS bucket for Policy Update Pipeline (PUP) artifacts — generated report PDFs.
 *  Override with GCS_PUP_BUCKET. Bucket must exist; create with `gsutil mb -p <project> gs://<bucket>` or in the GCS console. */
const GCS_PUP_BUCKET_NAME = String(
  process.env.GCS_PUP_BUCKET || 'pup-data'
).replace(/\/+$/, '');

/** Lazy-init GCS client for legislative uploads (optional dependency at runtime). */
let _legislativeGcsCache = null;
function getLegislativeGcsClient() {
  if (_legislativeGcsCache && _legislativeGcsCache.err)
    return { ok: false, error: _legislativeGcsCache.err };
  if (_legislativeGcsCache && _legislativeGcsCache.storage)
    return { ok: true, storage: _legislativeGcsCache.storage };
  try {
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage();
    _legislativeGcsCache = { storage };
    return { ok: true, storage };
  } catch (e) {
    const err = e.message || String(e);
    _legislativeGcsCache = { err };
    return { ok: false, error: `Google Cloud Storage: ${err}` };
  }
}

function legislativeSafeObjectSegment(name) {
  const base = path.basename(String(name || 'file')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 200) || 'file';
}

function legislativePublicUrl(bucketName, objectPath) {
  const enc = objectPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `https://storage.googleapis.com/${bucketName}/${enc}`;
}

async function legislativeSignedDownloadUrl(storage, bucketName, objectPath, mimeType) {
  const opts = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000,
  };
  if (mimeType && /pdf/i.test(String(mimeType))) opts.responseDisposition = 'inline';
  const [url] = await storage.bucket(bucketName).file(objectPath).getSignedUrl(opts);
  return url;
}

/**
 * Upload a buffer to GCS. Uses resumable upload + validation disabled to avoid
 * "Cannot call write after a stream was destroyed" (HashStreamValidator) seen
 * with resumable:false on some Windows / Node versions. Falls back to temp-file upload.
 */
async function legislativeUploadBuffer(storage, bucketName, objectPath, buf, mimeType, customMeta) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectPath);
  const saveOpts = {
    resumable: true,
    validation: false,
    timeout: 180000,
    contentType: mimeType || 'application/octet-stream',
    metadata: { metadata: customMeta },
  };
  try {
    await file.save(buf, saveOpts);
    return;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!/stream was destroyed|write after a stream was destroyed/i.test(msg)) throw err;
    console.warn('[Legislative] save() stream error, retrying via temp file:', msg.slice(0, 120));
  }
  const tmpPath = path.join(os.tmpdir(), `legislative_${crypto.randomUUID()}.upload`);
  fs.writeFileSync(tmpPath, buf);
  try {
    await bucket.upload(tmpPath, {
      destination: objectPath,
      gzip: false,
      metadata: {
        contentType: mimeType || 'application/octet-stream',
        metadata: customMeta,
      },
    });
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) { /* ignore */ }
  }
}

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
  // Public portal feed for extracted legislative updates (mutations are still
  // auth-checked inside their route handlers).
  if (pathname.startsWith('/api/legislative-updates/extracted')) return true;
  // Public read access to pipeline-run history and the portal-shaped
  // projection over it. The POST /api/ai-tools/pipeline-runs write endpoint
  // re-checks auth inside its handler, so the prefix bypass is read-only in
  // practice.
  if (pathname.startsWith('/api/ai-tools/pipeline-runs')) return true;
  if (pathname.startsWith('/api/ai-tools/pipeline-legislative-updates')) return true;
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
  '/legislative-internal-sources',
  '/legislative-external-sources',
  '/legislative-updates',
  '/pipeline-configuration',
  '/pipeline-impact-criteria',
  '/pipeline-default-org',
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

/** Match `/api/grc/...` list proxies when deployed behind path-based gateways (path is `/prefix/api/grc/...`). */
function grcProxyTailMatch(routePath, exactTail) {
  const p = String(routePath || '/').replace(/\/{2,}/g, '/');
  const t = String(exactTail || '');
  return p === t || p.endsWith(t);
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

  CREATE TABLE IF NOT EXISTS legislative_internal_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    original_file_name TEXT NOT NULL,
    mime_type TEXT DEFAULT 'application/octet-stream',
    size INTEGER DEFAULT 0,
    gcs_bucket TEXT NOT NULL,
    gcs_object_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_legislative_internal_created ON legislative_internal_sources(created_at DESC);

  /* Extracted legislative updates surfaced on the "المستجدات التشريعية" portal page.
     Status values:  new | under_analysis | completed | archived
     Impact values:  high | medium | low                                                    */
  CREATE TABLE IF NOT EXISTS legislative_extracted_updates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    source TEXT DEFAULT '',
    source_id TEXT,
    internal_source_id TEXT,
    external_url TEXT DEFAULT '',
    published_at TEXT,
    status TEXT DEFAULT 'new',
    status_label TEXT DEFAULT '',
    impact_level TEXT DEFAULT 'medium',
    impact_label TEXT DEFAULT '',
    affected_policies_count INTEGER DEFAULT 0,
    affected_policy_ids TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    language TEXT DEFAULT 'ar',
    raw_text TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lu_extracted_published ON legislative_extracted_updates(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lu_extracted_source    ON legislative_extracted_updates(source);
  CREATE INDEX IF NOT EXISTS idx_lu_extracted_status    ON legislative_extracted_updates(status);
  CREATE INDEX IF NOT EXISTS idx_lu_extracted_impact    ON legislative_extracted_updates(impact_level);
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

// Create extracted_policies table (legacy — kept for backward compat)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extracted_policies (
      id TEXT PRIMARY KEY,
      source_file TEXT NOT NULL DEFAULT '',
      policies TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);
} catch (migErr) { console.warn('extracted_policies table migration:', migErr.message); }

// Create extracted_regulations table (regulation articles from uploaded files)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extracted_regulations (
      id TEXT PRIMARY KEY,
      source_file TEXT NOT NULL DEFAULT '',
      articles TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);
} catch (migErr) { console.warn('extracted_regulations table migration:', migErr.message); }

// Create pipeline_runs table (Policy Update Pipeline execution history)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      org_context TEXT NOT NULL DEFAULT '',
      regulation_snippet TEXT NOT NULL DEFAULT '',
      regulation_text TEXT NOT NULL DEFAULT '',
      policy_count INTEGER NOT NULL DEFAULT 0,
      stage_reached TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
} catch (migErr) { console.warn('pipeline_runs table migration:', migErr.message); }

// Migrate pipeline_runs: add report-PDF columns if missing (older rows stay null →
// 'unavailable' to the client, per design — only new runs get PDFs generated).
try {
  const cols = db.pragma('table_info(pipeline_runs)').map(c => c.name);
  const addCol = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE pipeline_runs ADD COLUMN ${name} ${def}`); };
  addCol('report_pdf_status',       "TEXT DEFAULT NULL"); // 'pending' | 'ready' | 'failed' | null (unavailable)
  addCol('report_pdf_object_path',  "TEXT DEFAULT NULL"); // GCS object key inside the pup bucket
  addCol('report_pdf_bucket',       "TEXT DEFAULT NULL"); // bucket name at generation time
  addCol('report_pdf_size_bytes',   "INTEGER DEFAULT NULL");
  addCol('report_pdf_generated_at', "TEXT DEFAULT NULL");
  addCol('report_pdf_error',        "TEXT DEFAULT NULL");
} catch (migErr) { console.warn('pipeline_runs report-pdf migration:', migErr.message); }

// Create pipeline_config table (key-value store for pipeline settings)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
} catch (migErr) { console.warn('pipeline_config table migration:', migErr.message); }

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

// Extracted policies DB helpers (legacy)
const dbInsertExtractedPolicies = db.prepare(`
  INSERT INTO extracted_policies (id, source_file, policies, created_at)
  VALUES (?, ?, ?, ?)
`);
const dbGetExtractedPolicies = db.prepare(`SELECT * FROM extracted_policies WHERE id = ?`);
const dbListExtractedPolicies = db.prepare(`SELECT * FROM extracted_policies ORDER BY created_at DESC LIMIT 50`);

// Extracted regulations DB helpers
const dbInsertExtractedRegulations = db.prepare(`
  INSERT INTO extracted_regulations (id, source_file, articles, created_at)
  VALUES (?, ?, ?, ?)
`);
const dbGetExtractedRegulation = db.prepare(`SELECT * FROM extracted_regulations WHERE id = ?`);
const dbListExtractedRegulations = db.prepare(`SELECT * FROM extracted_regulations ORDER BY created_at DESC LIMIT 50`);

// Pipeline runs DB helpers
const dbInsertPipelineRun = db.prepare(`
  INSERT INTO pipeline_runs (id, org_context, regulation_snippet, regulation_text, policy_count, stage_reached, result, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const dbGetPipelineRun = db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`);
const dbListPipelineRuns = db.prepare(`
  SELECT id, org_context, regulation_snippet, regulation_text, policy_count, stage_reached, result, created_at
  FROM pipeline_runs ORDER BY created_at DESC LIMIT 100
`);
const dbSetPipelineRunReportPdfStatus = db.prepare(`
  UPDATE pipeline_runs SET report_pdf_status = ?, report_pdf_error = ? WHERE id = ?
`);
const dbSetPipelineRunReportPdfReady = db.prepare(`
  UPDATE pipeline_runs
     SET report_pdf_status = 'ready',
         report_pdf_object_path = ?,
         report_pdf_bucket = ?,
         report_pdf_size_bytes = ?,
         report_pdf_generated_at = ?,
         report_pdf_error = NULL
   WHERE id = ?
`);

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

const dbInsertLegislativeInternal = db.prepare(`
  INSERT INTO legislative_internal_sources (
    id, name, description, original_file_name, mime_type, size,
    gcs_bucket, gcs_object_path, public_url, uploaded_by, created_at
  ) VALUES (
    @id, @name, @description, @original_file_name, @mime_type, @size,
    @gcs_bucket, @gcs_object_path, @public_url, @uploaded_by, @created_at
  )
`);
const dbListLegislativeInternal = db.prepare(
  `SELECT * FROM legislative_internal_sources ORDER BY datetime(created_at) DESC`
);
const dbGetLegislativeInternal = db.prepare(
  `SELECT * FROM legislative_internal_sources WHERE id = ?`
);
const dbUpdateLegislativeInternalMeta = db.prepare(
  `UPDATE legislative_internal_sources SET name = ?, description = ? WHERE id = ?`
);
const dbDeleteLegislativeInternal = db.prepare(`DELETE FROM legislative_internal_sources WHERE id = ?`);

// ---- Legislative extracted updates DB helpers ----
const dbInsertLegislativeExtracted = db.prepare(`
  INSERT INTO legislative_extracted_updates (
    id, title, description, source, source_id, internal_source_id, external_url,
    published_at, status, status_label, impact_level, impact_label,
    affected_policies_count, affected_policy_ids, tags, language, raw_text, metadata,
    created_at, updated_at
  ) VALUES (
    @id, @title, @description, @source, @source_id, @internal_source_id, @external_url,
    @published_at, @status, @status_label, @impact_level, @impact_label,
    @affected_policies_count, @affected_policy_ids, @tags, @language, @raw_text, @metadata,
    @created_at, @updated_at
  )
`);
const dbGetLegislativeExtracted = db.prepare(
  `SELECT * FROM legislative_extracted_updates WHERE id = ?`
);
const dbDeleteLegislativeExtracted = db.prepare(
  `DELETE FROM legislative_extracted_updates WHERE id = ?`
);
const dbUpdateLegislativeExtracted = db.prepare(`
  UPDATE legislative_extracted_updates SET
    title = @title, description = @description, source = @source, source_id = @source_id,
    internal_source_id = @internal_source_id, external_url = @external_url,
    published_at = @published_at, status = @status, status_label = @status_label,
    impact_level = @impact_level, impact_label = @impact_label,
    affected_policies_count = @affected_policies_count, affected_policy_ids = @affected_policy_ids,
    tags = @tags, language = @language, raw_text = @raw_text, metadata = @metadata,
    updated_at = @updated_at
  WHERE id = @id
`);
const dbCountLegislativeExtracted = db.prepare(
  `SELECT COUNT(*) AS c FROM legislative_extracted_updates`
);

/** Map common Arabic / English aliases for status & impact onto the canonical enum used by the API. */
const LU_STATUS_ALIASES = {
  'new': 'new', 'جديد': 'new',
  'under_analysis': 'under_analysis', 'analysis': 'under_analysis',
  'in_progress': 'under_analysis', 'قيد التحليل': 'under_analysis',
  'completed': 'completed', 'complete': 'completed', 'done': 'completed', 'مكتمل': 'completed',
  'archived': 'archived', 'مؤرشف': 'archived',
};
const LU_IMPACT_ALIASES = {
  'high': 'high', 'عالي': 'high',
  'medium': 'medium', 'med': 'medium', 'متوسط': 'medium',
  'low': 'low', 'منخفض': 'low',
};
const LU_DEFAULT_STATUS_LABELS = {
  new: 'جديد',
  under_analysis: 'قيد التحليل',
  completed: 'مكتمل',
  archived: 'مؤرشف',
};
const LU_DEFAULT_IMPACT_LABELS = {
  high: 'عالي',
  medium: 'متوسط',
  low: 'منخفض',
};
function luNormalizeStatus(v) {
  const k = String(v || '').trim().toLowerCase();
  return LU_STATUS_ALIASES[k] || LU_STATUS_ALIASES[String(v || '').trim()] || null;
}
function luNormalizeImpact(v) {
  const k = String(v || '').trim().toLowerCase();
  return LU_IMPACT_ALIASES[k] || LU_IMPACT_ALIASES[String(v || '').trim()] || null;
}
function luSafeJsonParse(s, fallback) {
  if (s == null) return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function luRowToApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    source: row.source || '',
    source_id: row.source_id || null,
    internal_source_id: row.internal_source_id || null,
    external_url: row.external_url || '',
    published_at: row.published_at || null,
    status: row.status || 'new',
    status_label: row.status_label || LU_DEFAULT_STATUS_LABELS[row.status] || row.status || '',
    impact_level: row.impact_level || 'medium',
    impact_label: row.impact_label || LU_DEFAULT_IMPACT_LABELS[row.impact_level] || row.impact_level || '',
    affected_policies_count: row.affected_policies_count || 0,
    affected_policy_ids: luSafeJsonParse(row.affected_policy_ids, []),
    tags: luSafeJsonParse(row.tags, []),
    language: row.language || 'ar',
    metadata: luSafeJsonParse(row.metadata, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ───────────────────────────────────────────────────────────────
// Pipeline runs → legislative-update projection
//
// The portal renders legislative updates with luRowToApi-shaped objects (title,
// description, source, status_label, impact_label, key changes, etc.). The
// project surfaces the F1–F4 pipeline result for the same UI by deriving those
// fields from a `pipeline_runs` row.
//
// Caveats — pipeline_runs has no curated title/source columns, so we infer:
//   • title           → first non-empty line of regulationText (or fallback id)
//   • description     → F1 reasoning (or a stage-based fallback)
//   • source          → metadata.sourceFile if persisted by the caller, else ''
//   • status          → derived from stage_reached (f1 not-relevant → archived,
//                       f4 → completed, anything in between → under_analysis)
//   • impact_level    → max F4 severity across all impacts, else 'medium'
//   • tags            → unique F2 policy_point.category values
//   • affected_policies_count / ids → unique F4 policy_id set (or F3 fallback)
// ───────────────────────────────────────────────────────────────

const PIPELINE_STAGE_STATUS = {
  f1: 'under_analysis',
  f2: 'under_analysis',
  f3: 'under_analysis',
  f4: 'completed',
};

const PIPELINE_SEVERITY_TO_IMPACT = {
  critical: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
  none: 'low',
};

/** Crude language sniff: Arabic if any Arabic codepoint appears in the first 1k chars. */
function pipelineDetectLanguage(text) {
  const s = String(text || '').slice(0, 1024);
  return /[\u0600-\u06FF]/.test(s) ? 'ar' : 'en';
}

/** Best-effort title from raw regulation text. Trims to 160 chars and strips dashes/colons. */
function pipelineDeriveTitle(regulationText, fallback) {
  const t = String(regulationText || '').trim();
  if (!t) return fallback;
  for (const rawLine of t.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[\-—•·*]+\s*/, '');
    if (line.length < 4) continue;
    if (line.length <= 160) return line;
    return line.slice(0, 157) + '…';
  }
  return fallback;
}

/** Worst → best ordering for F4's "severity" enum (used for sort + reduce). */
const PIPELINE_SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
const PIPELINE_SEVERITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
};

/** Normalise an F4 impact entry's severity to a known enum value (default 'none'). */
function pipelineNormalizeSeverity(sev) {
  const s = (typeof sev === 'string' ? sev : '').trim().toLowerCase();
  return PIPELINE_SEVERITY_RANK[s] != null ? s : 'none';
}

/**
 * Re-shape F4's regulation-point-first impact tree into a policy-first tree so the
 * portal can render an "Affected policies" group-by view (each policy expands to
 * show every regulation point that touched it).
 *
 * Returned shape:
 *   [
 *     {
 *       policy_id, policy_title,
 *       is_affected, impact_level, impact_label, requires_amendment,
 *       matched_points_count, affected_points_count,
 *       matched_points: [
 *         { point_id, point_text, impact_summary, severity, severity_label,
 *           severity_reasoning, requires_amendment, similarity_score,
 *           amendments, compliance_gap, is_affected }
 *       ]
 *     },
 *   ]
 *
 * Sort order:
 *   - Top-level: meaningfully-affected policies first, then by worst severity,
 *     then by matched_points_count desc, then by policy_title.
 *   - Inside each policy: regulation points by worst severity, then similarity desc.
 */
function pipelineGroupImpactsByPolicy(f4Impacts) {
  if (!Array.isArray(f4Impacts) || !f4Impacts.length) return [];
  const byPolicy = new Map();
  for (const group of f4Impacts) {
    const pointId = group && group.point_id != null ? group.point_id : null;
    const pointText = group && typeof group.point_text === 'string' ? group.point_text : '';
    const impacts = Array.isArray(group && group.impacts) ? group.impacts : [];
    for (const imp of impacts) {
      if (!imp || imp.policy_id == null) continue;
      const pid = String(imp.policy_id);
      const sev = pipelineNormalizeSeverity(imp.severity);
      const requires = imp.requires_amendment === true;
      const meaningful = requires || sev !== 'none';
      const entry = {
        point_id: pointId,
        point_text: pointText,
        impact_summary: typeof imp.impact_summary === 'string' ? imp.impact_summary : '',
        severity: sev,
        severity_label: PIPELINE_SEVERITY_LABELS[sev],
        severity_reasoning: typeof imp.severity_reasoning === 'string' ? imp.severity_reasoning : '',
        requires_amendment: requires,
        similarity_score: typeof imp.similarity_score === 'number' ? imp.similarity_score : null,
        amendments: Array.isArray(imp.amendments) ? imp.amendments : [],
        compliance_gap: typeof imp.compliance_gap === 'string' ? imp.compliance_gap : '',
        is_affected: meaningful,
      };
      const existing = byPolicy.get(pid);
      if (existing) {
        existing.matched_points.push(entry);
        existing.policy_title = existing.policy_title || imp.policy_title || '';
      } else {
        byPolicy.set(pid, {
          policy_id: pid,
          policy_title: typeof imp.policy_title === 'string' ? imp.policy_title : '',
          matched_points: [entry],
        });
      }
    }
  }

  const policyImpactLevel = (sev) => PIPELINE_SEVERITY_TO_IMPACT[sev] || 'low';

  const out = [];
  for (const group of byPolicy.values()) {
    group.matched_points.sort((a, b) => {
      const da = PIPELINE_SEVERITY_RANK[a.severity] - PIPELINE_SEVERITY_RANK[b.severity];
      if (da !== 0) return da;
      const sa = a.similarity_score == null ? -1 : a.similarity_score;
      const sb = b.similarity_score == null ? -1 : b.similarity_score;
      return sb - sa;
    });
    let worstRank = PIPELINE_SEVERITY_RANK.none;
    let isAffected = false;
    let requiresAmendment = false;
    let affectedPoints = 0;
    for (const ent of group.matched_points) {
      const r = PIPELINE_SEVERITY_RANK[ent.severity];
      if (r < worstRank) worstRank = r;
      if (ent.is_affected) {
        isAffected = true;
        affectedPoints += 1;
      }
      if (ent.requires_amendment) requiresAmendment = true;
    }
    // Worst rank → severity string (the one with this rank value).
    const worstSev = Object.keys(PIPELINE_SEVERITY_RANK).find((k) => PIPELINE_SEVERITY_RANK[k] === worstRank) || 'none';
    const impactLevel = policyImpactLevel(worstSev);
    out.push({
      policy_id: group.policy_id,
      policy_title: group.policy_title || `Policy ${group.policy_id}`,
      is_affected: isAffected,
      impact_level: impactLevel,
      impact_label: LU_DEFAULT_IMPACT_LABELS[impactLevel] || impactLevel,
      // Carry the raw worst F4 severity too — the portal may want to show
      // "Critical" rather than collapsing it to "High" via impact_level.
      worst_severity: worstSev,
      worst_severity_label: PIPELINE_SEVERITY_LABELS[worstSev],
      requires_amendment: requiresAmendment,
      matched_points_count: group.matched_points.length,
      affected_points_count: affectedPoints,
      matched_points: group.matched_points,
    });
  }

  out.sort((a, b) => {
    if (a.is_affected !== b.is_affected) return a.is_affected ? -1 : 1;
    const da = PIPELINE_SEVERITY_RANK[a.worst_severity] - PIPELINE_SEVERITY_RANK[b.worst_severity];
    if (da !== 0) return da;
    if (b.matched_points_count !== a.matched_points_count) return b.matched_points_count - a.matched_points_count;
    return String(a.policy_title).localeCompare(String(b.policy_title));
  });

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Policy Update Pipeline · Server-side PDF report generation
//
// The same report the user used to render client-side (admin.js) is now
// produced on the server right after a pipeline run is saved, then uploaded
// to GCS (GCS_PUP_BUCKET_NAME). The download endpoint just returns a fresh
// signed URL — the user no longer waits for the browser to render the PDF.
//
// Engine: Puppeteer (headless Chrome) — perfect Arabic/RTL fidelity, reuses
// the existing report HTML/CSS verbatim.
// ───────────────────────────────────────────────────────────────────────────

const PIPELINE_STAGE_LABELS = {
  f1_relevance: 'Stage 1 · Relevance assessment',
  f2_summary: 'Stage 2 · Regulation points extracted',
  f3_matches: 'Stage 3 · Policy matching',
  f4_impacts: 'Stage 4 · Impact analysis',
};

function pipelineStageLabel(stage) {
  return PIPELINE_STAGE_LABELS[String(stage || '').toLowerCase()] || stage || '—';
}

function pipelineChangeTypeLabel(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'add') return 'Add';
  if (t === 'modify' || t === 'update') return 'Modify';
  if (t === 'remove' || t === 'delete') return 'Remove';
  return type || 'Change';
}

function pipelineReportSeverityClass(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'rpt-sev--high';
  if (s === 'medium') return 'rpt-sev--med';
  if (s === 'low') return 'rpt-sev--low';
  return 'rpt-sev--none';
}

function pipelineSkippedStagesNote(data) {
  const stage = String(data.stage_reached || '').toLowerCase();
  if (stage === 'f4_impacts') return '';
  if (stage === 'f1_relevance') return 'Stages 2–4 were skipped because the regulation was judged not relevant.';
  if (stage === 'f2_summary') return 'Stage 3 (policy matching) and Stage 4 (impact analysis) were skipped.';
  if (stage === 'f3_matches') return 'Stage 4 (impact analysis) was skipped.';
  return '';
}

function htmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** PDF report CSS — mirrored from admin.js PUP_REPORT_CSS (kept in sync intentionally). */
const PIPELINE_REPORT_CSS = `
  *{box-sizing:border-box}
  body{margin:0;font-family:'Cairo',system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;background:#fff;font-size:13px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rpt-root{padding:24px 28px 36px;max-width:780px;margin:0 auto}
  .rpt-cover{padding:28px 26px;border-radius:14px;margin-bottom:22px;page-break-inside:avoid}
  .rpt-cover-title{margin:0 0 6px;font-size:24px;font-weight:800;letter-spacing:-0.01em}
  .rpt-cover-sub{margin:0;font-size:13px;opacity:0.95}
  .rpt-cover-meta{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
  .rpt-chip{display:inline-flex;align-items:center;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,0.22);font-size:11px;font-weight:600;letter-spacing:0.02em}
  .rpt-kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:8px 0 22px}
  .rpt-kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px}
  .rpt-kpi-label{font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:6px}
  .rpt-kpi-value{font-size:22px;font-weight:700;color:#0f172a;line-height:1.1}
  .rpt-section{margin:0 0 22px;page-break-inside:auto}
  .rpt-section-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:14px;font-weight:700;margin:0 0 12px}
  .rpt-section-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,0.25);font-size:12px;font-weight:800}
  .rpt-card{border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:12px 14px;margin:0 0 10px;page-break-inside:avoid}
  .rpt-badge-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  .rpt-badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.02em;border:1px solid transparent}
  .rpt-badge--yes{background:#dcfce7;color:#166534;border-color:#bbf7d0}
  .rpt-badge--no{background:#fee2e2;color:#991b1b;border-color:#fecaca}
  .rpt-badge--confidence{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}
  .rpt-prose{margin:6px 0;color:#1e293b;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word}
  .rpt-list{margin:6px 0 0;padding-left:18px;color:#334155;font-size:12.5px}
  .rpt-list li{margin-bottom:4px}
  .rpt-note{margin:8px 0 16px;padding:10px 14px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;color:#854d0e;font-size:12px}
  .rpt-point-id{display:inline-flex;align-items:center;padding:2px 9px;border-radius:6px;background:#f1f5f9;color:#334155;font-size:11px;font-weight:700;font-family:'JetBrains Mono','Fira Code',Consolas,monospace;letter-spacing:0.01em}
  .rpt-point-meta{font-size:11px;color:#64748b;margin:4px 0 8px}
  .rpt-policy-card{border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:0 0 14px;background:#fafbfc;page-break-inside:avoid}
  .rpt-policy-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
  .rpt-policy-title{margin:0;font-size:14px;font-weight:700;color:#0f172a}
  .rpt-sev{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600}
  .rpt-sev--high{background:#fee2e2;color:#991b1b}
  .rpt-sev--med{background:#fef3c7;color:#854d0e}
  .rpt-sev--low{background:#e0f2fe;color:#075985}
  .rpt-sev--none{background:#f1f5f9;color:#475569}
  .rpt-impact-point{border-top:1px dashed #e2e8f0;padding-top:10px;margin-top:10px;page-break-inside:avoid}
  .rpt-impact-point:first-child{border-top:none;padding-top:0;margin-top:0}
  .rpt-impact-label{font-size:10.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#475569;margin:8px 0 4px}
  .rpt-amend{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 11px;margin:6px 0}
  .rpt-amend-type{display:inline-block;padding:1px 8px;border-radius:6px;background:#eef2ff;color:#3730a3;font-size:10.5px;font-weight:700;letter-spacing:0.04em;margin-right:6px}
`;

function renderPipelineReportSectionsHtml(data) {
  const parts = [];
  const f1 = data.f1_relevance;
  const f2 = data.f2_summary;
  const f3 = Array.isArray(data.f3_matches) ? data.f3_matches : null;
  const f4 = Array.isArray(data.f4_impacts) ? data.f4_impacts : null;

  if (typeof data.policy_count_indexed === 'number') {
    const policies = f4 ? pipelineGroupImpactsByPolicy(f4) : [];
    const affected = policies.filter((p) => p.is_affected).length;
    parts.push('<div class="rpt-kpi-row">');
    parts.push(
      '<div class="rpt-kpi"><div class="rpt-kpi-label">Stage reached</div><div class="rpt-kpi-value" style="font-size:15px">' +
        htmlEscape(pipelineStageLabel(data.stage_reached)) + '</div></div>'
    );
    parts.push(
      '<div class="rpt-kpi"><div class="rpt-kpi-label">Indexed policies</div><div class="rpt-kpi-value">' +
        htmlEscape(String(data.policy_count_indexed)) + '</div></div>'
    );
    parts.push(
      '<div class="rpt-kpi"><div class="rpt-kpi-label">Affected policies</div><div class="rpt-kpi-value">' +
        htmlEscape(String(affected)) + '</div></div>'
    );
    parts.push('</div>');
  }

  const skip = pipelineSkippedStagesNote(data);
  if (skip) parts.push('<p class="rpt-note">' + htmlEscape(skip) + '</p>');

  if (f1 && typeof f1 === 'object') {
    parts.push('<section class="rpt-section">');
    parts.push('<h2 class="rpt-section-head" style="background:#047857;color:#fff"><span class="rpt-section-icon">1</span> Relevance assessment</h2>');
    parts.push('<div class="rpt-card">');
    if (typeof f1.is_relevant === 'boolean') {
      parts.push('<div class="rpt-badge-row">');
      parts.push(
        '<span class="rpt-badge ' + (f1.is_relevant ? 'rpt-badge--yes' : 'rpt-badge--no') + '">' +
          htmlEscape(f1.is_relevant ? 'Relevant to organisation' : 'Not relevant') +
        '</span>'
      );
      if (typeof f1.confidence === 'number') {
        const pct = Math.round(Math.min(1, Math.max(0, f1.confidence)) * 100);
        parts.push('<span class="rpt-badge rpt-badge--confidence">Model confidence · ' + htmlEscape(String(pct)) + '%</span>');
      }
      parts.push('</div>');
      if (f1.reasoning) parts.push('<p class="rpt-prose" dir="auto">' + htmlEscape(f1.reasoning) + '</p>');
      const aspects = Array.isArray(f1.relevant_aspects) ? f1.relevant_aspects.filter(Boolean) : [];
      if (aspects.length) {
        parts.push('<ul class="rpt-list" dir="auto">');
        for (const a of aspects) parts.push('<li>' + htmlEscape(a) + '</li>');
        parts.push('</ul>');
      }
    } else {
      parts.push('<p class="rpt-prose">Relevance step did not return a valid verdict.</p>');
    }
    parts.push('</div>');
    parts.push('</section>');
  }

  if (f2 && typeof f2 === 'object') {
    const pts = Array.isArray(f2.policy_points) ? f2.policy_points : [];
    parts.push('<section class="rpt-section">');
    parts.push('<h2 class="rpt-section-head" style="background:#4f46e5;color:#fff"><span class="rpt-section-icon">2</span> Regulation points extracted</h2>');
    if (!pts.length) {
      parts.push('<div class="rpt-card"><p class="rpt-prose">No policy points returned.</p></div>');
    } else {
      for (const pt of pts) {
        parts.push('<div class="rpt-card">');
        parts.push('<span class="rpt-point-id">' + htmlEscape(pt.id || 'Point') + '</span>');
        const metaBits = [];
        if (pt.source_reference) metaBits.push('Reference: ' + pt.source_reference);
        if (pt.category) metaBits.push(pt.category);
        if (metaBits.length) parts.push('<div class="rpt-point-meta">' + htmlEscape(metaBits.join(' · ')) + '</div>');
        parts.push('<p class="rpt-prose" dir="auto" style="margin:0">' + htmlEscape(pt.point || '') + '</p>');
        parts.push('</div>');
      }
    }
    parts.push('</section>');
  }

  if (f3 && f3.length) {
    parts.push('<section class="rpt-section">');
    parts.push('<h2 class="rpt-section-head" style="background:#0d9488;color:#fff"><span class="rpt-section-icon">3</span> Policy matching</h2>');
    for (const row of f3) {
      const matches = Array.isArray(row.matches) ? row.matches : [];
      parts.push('<div class="rpt-card">');
      parts.push('<span class="rpt-point-id">' + htmlEscape(row.point_id || 'Point') + '</span>');
      parts.push('<p class="rpt-prose" dir="auto" style="margin:8px 0 10px">' + htmlEscape(row.point_text || '') + '</p>');
      if (!matches.length) {
        parts.push('<p class="rpt-point-meta">No policy matches above threshold.</p>');
      } else {
        for (const m of matches) {
          parts.push('<div style="border-top:1px dashed #e2e8f0;padding-top:8px;margin-top:8px">');
          parts.push('<strong>' + htmlEscape(m.policy_title || m.policy_id || 'Policy') + '</strong>');
          if (typeof m.similarity_score === 'number') {
            parts.push(' <span class="rpt-point-meta">· Similarity ' + htmlEscape(String(m.similarity_score)) + '</span>');
          }
          if (m.content_excerpt) {
            parts.push('<p class="rpt-prose" dir="auto" style="font-size:12px;margin:6px 0 0">' + htmlEscape(m.content_excerpt) + '</p>');
          }
          parts.push('</div>');
        }
      }
      parts.push('</div>');
    }
    parts.push('</section>');
  }

  if (f4 && f4.length) {
    const policies = pipelineGroupImpactsByPolicy(f4);
    parts.push('<section class="rpt-section">');
    parts.push('<h2 class="rpt-section-head" style="background:#c2410c;color:#fff"><span class="rpt-section-icon">4</span> Impact analysis</h2>');
    for (const policy of policies) {
      parts.push('<div class="rpt-policy-card">');
      parts.push('<div class="rpt-policy-head">');
      parts.push('<h3 class="rpt-policy-title">' + htmlEscape(policy.policy_title) + '</h3>');
      parts.push(
        '<span class="rpt-sev ' + pipelineReportSeverityClass(policy.worst_severity) + '">' +
          htmlEscape(policy.worst_severity_label) + '</span>'
      );
      if (policy.requires_amendment) {
        parts.push(' <span class="rpt-sev rpt-sev--high" style="margin-left:6px">Requires amendment</span>');
      }
      parts.push('</div>');
      for (const pt of policy.matched_points) {
        parts.push('<div class="rpt-impact-point">');
        parts.push('<span class="rpt-point-id">' + htmlEscape(pt.point_id || 'Point') + '</span>');
        parts.push('<p class="rpt-prose" dir="auto" style="margin:8px 0">' + htmlEscape(pt.point_text || '') + '</p>');
        if (pt.impact_summary) {
          parts.push('<div class="rpt-impact-label">Impact analysis</div>');
          parts.push('<p class="rpt-prose" dir="auto">' + htmlEscape(pt.impact_summary) + '</p>');
        }
        if (pt.severity_reasoning) {
          parts.push('<div class="rpt-impact-label">Severity</div>');
          parts.push('<p class="rpt-prose" dir="auto">' + htmlEscape(pt.severity_reasoning) + '</p>');
        }
        if (pt.compliance_gap) {
          parts.push('<div class="rpt-impact-label">Compliance gap</div>');
          parts.push('<p class="rpt-prose" dir="auto">' + htmlEscape(pt.compliance_gap) + '</p>');
        }
        const amds = Array.isArray(pt.amendments) ? pt.amendments : [];
        if (amds.length) {
          parts.push('<div class="rpt-impact-label">Proposed amendments (' + htmlEscape(String(amds.length)) + ')</div>');
          for (const a of amds) {
            parts.push('<div class="rpt-amend">');
            if (a.change_type) {
              parts.push('<span class="rpt-amend-type">' + htmlEscape(pipelineChangeTypeLabel(a.change_type)) + '</span>');
            }
            if (a.policy_section) parts.push('<strong>' + htmlEscape(a.policy_section) + '</strong>');
            if (a.current_text_summary) {
              parts.push('<div class="rpt-impact-label">Current</div>');
              parts.push('<p class="rpt-prose" dir="auto">' + htmlEscape(a.current_text_summary) + '</p>');
            }
            if (a.required_change) {
              parts.push('<div class="rpt-impact-label">Required change</div>');
              parts.push('<p class="rpt-prose" dir="auto">' + htmlEscape(a.required_change) + '</p>');
            }
            parts.push('</div>');
          }
        }
        parts.push('</div>');
      }
      parts.push('</div>');
    }
    parts.push('</section>');
  }

  return parts.join('');
}

function buildPipelineReportFullHtml(data, meta) {
  const sourceName = meta && meta.sourceName ? String(meta.sourceName) : 'Policy update pipeline';
  const generatedAt = meta && meta.generatedAt ? new Date(meta.generatedAt).toLocaleString() : new Date().toLocaleString();
  const stage = data && data.stage_reached ? pipelineStageLabel(data.stage_reached) : '—';
  const runId = meta && meta.runId ? String(meta.runId) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${htmlEscape(sourceName)} — Policy update pipeline report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap">
<style>${PIPELINE_REPORT_CSS}</style>
</head>
<body>
<div class="rpt-root">
  <header class="rpt-cover" style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 55%,#3b82f6 100%);color:#fff">
    <h1 class="rpt-cover-title" style="color:#fff">${htmlEscape(sourceName)}</h1>
    <p class="rpt-cover-sub">Policy update pipeline · impact report</p>
    <div class="rpt-cover-meta">
      <span class="rpt-chip">Generated: ${htmlEscape(generatedAt)}</span>
      <span class="rpt-chip">Stage: ${htmlEscape(stage)}</span>
      ${runId ? `<span class="rpt-chip">Run: ${htmlEscape(runId)}</span>` : ''}
    </div>
  </header>
  <div class="rpt-body">${renderPipelineReportSectionsHtml(data || {})}</div>
</div>
</body>
</html>`;
}

/** Lazy puppeteer import — keep the dep optional so the rest of the server still
 *  boots in environments where the Chrome binary failed to install. */
let _puppeteerCache = null;
function getPuppeteer() {
  if (_puppeteerCache && _puppeteerCache.err) return { ok: false, error: _puppeteerCache.err };
  if (_puppeteerCache && _puppeteerCache.mod) return { ok: true, mod: _puppeteerCache.mod };
  try {
    const mod = require('puppeteer');
    _puppeteerCache = { mod };
    return { ok: true, mod };
  } catch (e) {
    const err = e && e.message ? e.message : String(e);
    _puppeteerCache = { err };
    return { ok: false, error: `puppeteer missing: ${err}` };
  }
}

/** Cache a single browser process across requests — Chrome cold-start is ~1.5s. */
let _puppeteerBrowserPromise = null;
async function getSharedPuppeteerBrowser() {
  const p = getPuppeteer();
  if (!p.ok) throw new Error(p.error);
  if (_puppeteerBrowserPromise) {
    try {
      const b = await _puppeteerBrowserPromise;
      if (b && b.connected !== false && b.process && b.process()) return b;
    } catch (_) { /* fall-through, relaunch */ }
    _puppeteerBrowserPromise = null;
  }
  // Allow pointing at a system-installed Chrome (e.g. google-chrome-stable from
  // apt, which pulls in all required shared libraries). Falls back to the
  // browser Puppeteer downloaded into its cache when the env var is unset.
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  };
  const execPath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (execPath) launchOpts.executablePath = execPath;
  _puppeteerBrowserPromise = p.mod.launch(launchOpts);
  const b = await _puppeteerBrowserPromise;
  b.on('disconnected', () => { if (_puppeteerBrowserPromise) _puppeteerBrowserPromise = null; });
  return b;
}

/** Render an HTML string into a PDF buffer using a shared headless Chrome. */
async function renderHtmlToPdfBuffer(html) {
  const browser = await getSharedPuppeteerBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: ['load', 'networkidle0'], timeout: 60000 });
    // Wait for Cairo to finish loading so glyphs match the live report.
    await page.evaluateHandle('document.fonts.ready');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '10mm', right: '10mm', bottom: '12mm', left: '10mm' },
    });
    return pdf;
  } finally {
    try { await page.close({ runBeforeUnload: false }); } catch (_) { /* ignore */ }
  }
}

function pipelinePdfObjectPath(runId) {
  const safe = String(runId || 'run').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `pipeline-reports/${safe}/policy-update-report-${safe}-${ts}.pdf`;
}

function pipelinePdfDownloadFilename(runId, sourceName) {
  const base = sourceName ? String(sourceName).replace(/[^\w\s.-]/g, '').trim().slice(0, 60) : '';
  const stamp = new Date().toISOString().slice(0, 10);
  const id = String(runId || 'run').slice(0, 80);
  return (base ? `${base} — ` : '') + `Policy update report (${id}) ${stamp}.pdf`;
}

/** Background generator: PDF render + GCS upload + DB status update. Fire-and-forget. */
async function kickPipelineReportPdfGeneration(runId, data, meta = {}) {
  if (!runId || !data || typeof data !== 'object') return;
  try {
    dbSetPipelineRunReportPdfStatus.run('pending', null, runId);
  } catch (_) { /* table may not have columns in legacy installs */ }

  setImmediate(async () => {
    const startedAt = Date.now();
    try {
      const html = buildPipelineReportFullHtml(data, { ...meta, runId });
      const buf = await renderHtmlToPdfBuffer(html);
      const gcs = getLegislativeGcsClient();
      if (!gcs.ok) throw new Error(gcs.error || 'GCS unavailable');
      const objectPath = pipelinePdfObjectPath(runId);
      await legislativeUploadBuffer(
        gcs.storage,
        GCS_PUP_BUCKET_NAME,
        objectPath,
        buf,
        'application/pdf',
        { runId, generatedAt: new Date().toISOString(), source: meta.sourceName || '' }
      );
      const generatedAt = new Date().toISOString();
      try {
        dbSetPipelineRunReportPdfReady.run(objectPath, GCS_PUP_BUCKET_NAME, buf.length, generatedAt, runId);
      } catch (e) { console.warn('[PupPdf] db update failed:', e.message); }
      console.log(`[PupPdf] Run ${runId} report PDF ready (${buf.length} bytes, ${Date.now() - startedAt}ms) → gs://${GCS_PUP_BUCKET_NAME}/${objectPath}`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      try {
        dbSetPipelineRunReportPdfStatus.run('failed', msg.slice(0, 500), runId);
      } catch (_) { /* ignore */ }
      console.error(`[PupPdf] Run ${runId} report PDF generation failed:`, msg);
    }
  });
}

/** Reduce F4 severities → the strongest impact level. Returns 'medium' when no impacts exist. */
function pipelineDeriveImpactLevel(f4Impacts) {
  if (!Array.isArray(f4Impacts) || !f4Impacts.length) return 'medium';
  const order = ['high', 'medium', 'low'];
  let best = null;
  for (const group of f4Impacts) {
    for (const imp of (group.impacts || [])) {
      const sev = String(imp.severity || '').toLowerCase();
      const mapped = PIPELINE_SEVERITY_TO_IMPACT[sev];
      if (!mapped) continue;
      if (best == null || order.indexOf(mapped) < order.indexOf(best)) best = mapped;
      if (best === 'high') return 'high';
    }
  }
  return best || 'medium';
}

/**
 * @param {{ id:string, org_context:string, regulation_snippet:string, regulation_text:string,
 *           policy_count:number, stage_reached:string, result:string|object, created_at:string }} row
 * @param {{ includePipeline?: boolean }} [opts]
 * @returns {object|null} luRowToApi-shaped object + optional `pipeline` extension
 */
function pipelineRunToLegislativeUpdate(row, opts = {}) {
  if (!row) return null;
  const result = typeof row.result === 'string'
    ? (() => { try { return JSON.parse(row.result || '{}'); } catch { return {}; } })()
    : (row.result && typeof row.result === 'object' ? row.result : {});

  const stage = String(row.stage_reached || result.stage_reached || '').toLowerCase();
  const f1 = result.f1_relevance || null;
  const f2Points = Array.isArray(result.f2_summary?.policy_points) ? result.f2_summary.policy_points : [];
  const f3Matches = Array.isArray(result.f3_matches) ? result.f3_matches : [];
  const f4Impacts = Array.isArray(result.f4_impacts) ? result.f4_impacts : [];

  // F1 short-circuit (not relevant): archive it; everything else maps via PIPELINE_STAGE_STATUS.
  const status = (stage === 'f1' && f1 && f1.is_relevant === false)
    ? 'archived'
    : (PIPELINE_STAGE_STATUS[stage] || 'new');
  const impactLevel = pipelineDeriveImpactLevel(f4Impacts);

  // "Affected by this source" semantics:
  //   F4 analyses every (regulation_point × similar_policy) pair returned by F3,
  //   including pairs the model decides do NOT meaningfully affect the policy
  //   (severity="none" + requires_amendment=false). Counting all of those was
  //   misleading — the card needs the number of policies the regulation actually
  //   impacts, not the number F4 happened to inspect.
  //
  //   A policy is considered actually affected when ANY of its F4 impact entries
  //   satisfies either:
  //     - requires_amendment === true, OR
  //     - severity ∈ { critical, high, medium, low }   (i.e. not "none" / missing).
  //
  //   We dedupe across regulation points so one policy counts once even when
  //   multiple regulation points hit it.
  const NON_AFFECTING_SEVERITIES = new Set(['none', '', null, undefined]);
  const analyzedIds = new Set();
  const affectedIds = new Set();
  let countingSource = 'none';
  for (const group of f4Impacts) {
    for (const imp of (group.impacts || [])) {
      if (imp.policy_id == null) continue;
      const pid = String(imp.policy_id);
      analyzedIds.add(pid);
      const sev = typeof imp.severity === 'string' ? imp.severity.trim().toLowerCase() : imp.severity;
      const requires = imp.requires_amendment === true;
      const meaningful = requires || !NON_AFFECTING_SEVERITIES.has(sev);
      if (meaningful) affectedIds.add(pid);
    }
  }
  if (analyzedIds.size) {
    countingSource = 'f4_impacts';
  } else {
    // Fallback: pipeline never ran F4 (e.g. stopped at F3 due to no matches or
    // an error). F3 only tells us semantic overlap, not impact — so we count
    // F3 candidates as a best-effort proxy and flag the source as 'f3_matches'
    // so the portal can render a softer label if it wants to.
    for (const m of f3Matches) {
      for (const x of (m.matches || [])) {
        if (x.policy_id == null) continue;
        const pid = String(x.policy_id);
        analyzedIds.add(pid);
        affectedIds.add(pid);
      }
    }
    if (analyzedIds.size) countingSource = 'f3_matches';
  }

  // Tag set: prefer F1.document_tags when present, then merge in F2 categories.
  // F1 tags are usually 1–3 word topical strings; F2 categories are taxonomy
  // labels — together they cover both "what is this about" and "what compliance
  // domain does each rule sit in".
  const tagSet = new Set();
  const f1Tags = (f1 && Array.isArray(f1.document_tags)) ? f1.document_tags : [];
  for (const t of f1Tags) {
    const s = String(t || '').trim();
    if (s) tagSet.add(s);
  }
  for (const pt of f2Points) {
    const c = String(pt.category || '').trim();
    if (c) tagSet.add(c);
  }

  const regulationText = String(row.regulation_text || '');
  const fallbackTitle = `Pipeline run · ${row.id}`;
  // Prefer F1.document_title → heuristic first-line → static fallback. F1 may
  // legitimately return null when the excerpt has no clear heading.
  const f1Title = (f1 && typeof f1.document_title === 'string') ? f1.document_title.trim() : '';
  const title = f1Title || pipelineDeriveTitle(regulationText, fallbackTitle);
  // Prefer F1.document_summary (document-level) → F1.reasoning (relevance, but
  // still a useful blurb) → regulation_snippet.
  const f1Summary = (f1 && typeof f1.document_summary === 'string') ? f1.document_summary.trim() : '';
  const description = f1Summary
    || (f1 && typeof f1.reasoning === 'string' && f1.reasoning.trim() ? f1.reasoning.trim() : '')
    || row.regulation_snippet
    || regulationText.slice(0, 300);

  const createdAt = row.created_at || new Date().toISOString();
  // Prefer F1.document_published_at (the actual regulation publication date)
  // over created_at (when the pipeline ran). Accept only well-formed YYYY-MM-DD
  // to avoid leaking model hallucinations into a typed date field.
  const f1Published = (f1 && typeof f1.document_published_at === 'string') ? f1.document_published_at.trim() : '';
  const publishedAt = /^\d{4}-\d{2}-\d{2}$/.test(f1Published) ? f1Published : (createdAt ? String(createdAt).slice(0, 10) : null);
  const f1Source = (f1 && typeof f1.document_source === 'string') ? f1.document_source.trim() : '';

  const out = {
    id: row.id,
    title,
    description,
    source: f1Source,
    source_id: null,
    internal_source_id: null,
    external_url: '',
    published_at: publishedAt,
    status,
    status_label: LU_DEFAULT_STATUS_LABELS[status] || status,
    impact_level: impactLevel,
    impact_label: LU_DEFAULT_IMPACT_LABELS[impactLevel] || impactLevel,
    // Policies the regulation actually impacts (F4: requires_amendment OR
    // severity != "none"). This is the number the card should show.
    affected_policies_count: affectedIds.size,
    affected_policy_ids: Array.from(affectedIds),
    // Sibling diagnostics: how many policies F4 inspected in total (or, when F4
    // never ran, how many F3 candidates were considered). Useful for tooltips
    // like "Analysed 7 policies · 4 actually affected".
    analyzed_policies_count: analyzedIds.size,
    analyzed_policy_ids: Array.from(analyzedIds),
    tags: Array.from(tagSet),
    language: pipelineDetectLanguage(regulationText),
    metadata: {
      stage_reached: stage || null,
      policy_count_indexed: result.policy_count_indexed ?? null,
      policy_count_input: row.policy_count ?? null,
      f1_confidence: f1 && typeof f1.confidence === 'number' ? f1.confidence : null,
      f1_relevant: f1 && typeof f1.is_relevant === 'boolean' ? f1.is_relevant : null,
      regulation_chars: regulationText.length,
      // Which sources actually populated the card-shaped fields. Useful for the
      // portal to render a "verified by AI" badge vs. a "derived" footnote.
      derived_from: {
        title: f1Title ? 'f1' : 'heuristic',
        description: f1Summary ? 'f1_summary' : (f1 && f1.reasoning ? 'f1_reasoning' : 'snippet'),
        source: f1Source ? 'f1' : 'unknown',
        published_at: /^\d{4}-\d{2}-\d{2}$/.test(f1Published) ? 'f1' : 'pipeline_run_date',
        tags: f1Tags.length ? (f2Points.length ? 'f1+f2' : 'f1') : (f2Points.length ? 'f2' : 'none'),
        // 'f4_impacts' = filtered by requires_amendment / severity != "none"
        // 'f3_matches' = fallback when F4 never ran (count is candidates, not confirmed impacts)
        // 'none'       = neither stage produced any candidate policies
        affected_policies_count: countingSource,
      },
    },
    created_at: createdAt,
    updated_at: createdAt,
  };

  if (opts.includePipeline) {
    out.pipeline = {
      stage_reached: stage || null,
      f1_relevance: f1,
      key_changes: f2Points.map((pt) => ({
        id: pt.id || null,
        point: pt.point || '',
        source_reference: pt.source_reference || null,
        category: pt.category || null,
      })),
      f3_matches: f3Matches,
      impact_analysis: f4Impacts.map((group) => ({
        point_id: group.point_id || null,
        point_text: group.point_text || '',
        impacts: Array.isArray(group.impacts) ? group.impacts : [],
      })),
      // Same F4 data re-grouped by POLICY (each entry = one policy with the
      // regulation points that touched it underneath). The portal renders the
      // "Affected policies" group-by view from this, while `impact_analysis`
      // above keeps the regulation-point-first view available.
      impacts_by_policy: pipelineGroupImpactsByPolicy(f4Impacts),
      policy_count_indexed: result.policy_count_indexed ?? null,
    };
  }

  return out;
}

/**
 * Seed the extracted updates table with the same five Arabic items shown on the
 * "المستجدات التشريعية" portal page so the API has demo data on a fresh DB.
 * Idempotent: only seeds when the table is empty.
 */
function seedLegislativeExtractedUpdates() {
  try {
    const { c } = dbCountLegislativeExtracted.get();
    if (c > 0) return;
    const now = new Date().toISOString();
    const seed = [
      {
        id: 'lu-eng-license-update-2026',
        title: 'تعديل لائحة مزاولة المهنة الهندسية',
        description: 'صدرت تعديلات جوهرية على لائحة مزاولة المهنة الهندسية تتضمن تحديث اشتراطات الترخيص وإضافة فئات جديدة للتصنيف المهني.',
        source: 'أم القرى',
        published_at: '2026-03-05',
        status: 'new',
        impact_level: 'high',
        affected_policies_count: 5,
        tags: ['هندسة', 'ترخيص', 'تصنيف مهني'],
      },
      {
        id: 'lu-engineering-safety-2026',
        title: 'تحديث اشتراطات السلامة للمنشآت الهندسية',
        description: 'تحديث للاشتراطات الفنية للسلامة في المنشآت الهندسية مع إضافة متطلبات جديدة لفحص المباني.',
        source: 'وزارة الشؤون البلدية',
        published_at: '2026-03-04',
        status: 'under_analysis',
        impact_level: 'medium',
        affected_policies_count: 3,
        tags: ['سلامة', 'منشآت', 'مباني'],
      },
      {
        id: 'lu-cross-border-engineering-2026',
        title: 'قرار تنظيم الاستشارات الهندسية العابرة للحدود',
        description: 'قرار جديد ينظم عمل الشركات الهندسية الأجنبية داخل المملكة ويحدد شروط الترخيص والشراكة مع المكاتب المحلية.',
        source: 'هيئة المهندسين',
        published_at: '2026-03-04',
        status: 'under_analysis',
        impact_level: 'high',
        affected_policies_count: 5,
        tags: ['استشارات', 'شراكات أجنبية'],
      },
      {
        id: 'lu-office-classification-2026',
        title: 'تعميم بشأن تصنيف المكاتب الهندسية',
        description: 'تعميم يوضح آلية إعادة تصنيف المكاتب الهندسية وفق المعايير الجديدة.',
        source: 'وزارة التجارة',
        published_at: '2026-03-05',
        status: 'completed',
        impact_level: 'low',
        affected_policies_count: 1,
        tags: ['تصنيف', 'مكاتب هندسية'],
      },
      {
        id: 'lu-professional-accreditation-2026',
        title: 'تحديث معايير الاعتماد المهني للمهندسين',
        description: 'الهيئة السعودية للمهندسين تُحدِّث معايير الاعتماد المهني ومسارات التطوير المستمر للمهندسين.',
        source: 'الهيئة السعودية للمهندسين',
        published_at: '2026-03-03',
        status: 'completed',
        impact_level: 'medium',
        affected_policies_count: 2,
        tags: ['اعتماد مهني', 'تطوير'],
      },
    ];
    const insertMany = db.transaction((items) => {
      for (const it of items) {
        dbInsertLegislativeExtracted.run({
          id: it.id,
          title: it.title,
          description: it.description,
          source: it.source,
          source_id: null,
          internal_source_id: null,
          external_url: '',
          published_at: it.published_at,
          status: it.status,
          status_label: LU_DEFAULT_STATUS_LABELS[it.status] || '',
          impact_level: it.impact_level,
          impact_label: LU_DEFAULT_IMPACT_LABELS[it.impact_level] || '',
          affected_policies_count: it.affected_policies_count || 0,
          affected_policy_ids: JSON.stringify([]),
          tags: JSON.stringify(it.tags || []),
          language: 'ar',
          raw_text: '',
          metadata: JSON.stringify({}),
          created_at: now,
          updated_at: now,
        });
      }
    });
    insertMany(seed);
    console.log(`[Legislative] Seeded ${seed.length} sample extracted updates.`);
  } catch (err) {
    console.warn('[Legislative] seed extracted updates failed:', err.message);
  }
}
seedLegislativeExtractedUpdates();

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
  '.ico': 'image/x-icon',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
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

/**
 * Recover complete {...} objects from a truncated JSON array string.
 * Walks brace depth while respecting strings and escapes so it can salvage
 * partial responses when an LLM hits its output token limit mid-array.
 * Each recovered object is JSON.parsed individually; malformed ones are skipped.
 */
function salvageArticleObjects(rawJsonArrayStr) {
  if (typeof rawJsonArrayStr !== 'string' || !rawJsonArrayStr.length) return [];
  const s = rawJsonArrayStr;
  const out = [];
  let i = s.indexOf('[');
  if (i < 0) i = 0; else i++;
  while (i < s.length) {
    while (i < s.length && /\s|,/.test(s[i])) i++;
    if (i >= s.length || s[i] !== '{') break;
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') { esc = true; continue; }
        if (c === '"')  { inStr = false; continue; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          try { out.push(JSON.parse(candidate)); } catch (_) { /* skip malformed */ }
          i++;
          break;
        }
      }
    }
    if (depth !== 0) break; // truncated mid-object — done
  }
  return out;
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

/** Policy rows for Data Studio: map spreadsheets → GRC Policy bodies (PolicyWriteSerializer ~ AppliedControl writable fields; category forced to policy upstream). */
const DS_POLICY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dsPolicyTruncateRef(s, maxLen) {
  maxLen = maxLen || 100;
  if (s == null || s === '') return '';
  const t = String(s).trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen);
}

function dsPolicyOptionalBoundedInt(raw, keys, lo, hi) {
  let s = dsFirstString(raw, keys);
  if (s === '' || s == null) {
    for (const k of keys) {
      if (raw[k] != null && typeof raw[k] === 'number' && Number.isFinite(raw[k])) {
        const n = Math.trunc(raw[k]);
        if (n >= lo && n <= hi) return n;
        return undefined;
      }
    }
    return undefined;
  }
  const n = parseInt(String(s).trim(), 10);
  if (!Number.isFinite(n) || n < lo || n > hi) return undefined;
  return n;
}

function dsPolicyOptionalDate(raw, keys) {
  const s = dsFirstString(raw, keys);
  if (!s) return undefined;
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : undefined;
}

function dsPolicyNormalizeStatus(raw) {
  const s = dsFirstString(raw, ['status', 'Status', 'الحالة']);
  if (!s) return undefined;
  const norm = String(s).trim().toLowerCase().replace(/\s+/g, '_');
  const map = new Map([
    ['to_do', 'to_do'],
    ['todo', 'to_do'],
    ['in_progress', 'in_progress'],
    ['inprogress', 'in_progress'],
    ['on_hold', 'on_hold'],
    ['onhold', 'on_hold'],
    ['active', 'active'],
    ['deprecated', 'deprecated'],
    ['--', '--'],
    ['undefined', '--'],
    ['undef', '--'],
  ]);
  if (norm === '−−' || norm === '-') return '--';
  if (map.has(norm)) return map.get(norm);
  const allowed = new Set(['to_do', 'in_progress', 'on_hold', 'active', 'deprecated', '--']);
  if (allowed.has(norm)) return norm;
  return undefined;
}

function dsPolicyNormalizeCsf(raw) {
  const s = dsFirstString(raw, ['csf_function', 'CSF function', 'CSF Function', 'csf']);
  if (!s) return undefined;
  const t = String(s).trim().toLowerCase();
  const allowed = ['govern', 'identify', 'protect', 'detect', 'respond', 'recover'];
  return allowed.includes(t) ? t : undefined;
}

function dsPolicyNormalizeEffort(raw) {
  const s = dsFirstString(raw, ['effort', 'Effort']);
  if (!s) return undefined;
  const u = String(s).trim().toUpperCase();
  return ['XS', 'S', 'M', 'L', 'XL'].includes(u) ? u : undefined;
}

function dsPolicyOptionalUuid(raw, keys) {
  const v = dsFirstString(raw, keys);
  if (!v || !DS_POLICY_UUID_RE.test(v.trim())) return undefined;
  return v.trim();
}

function dsPolicyNormalizePublished(raw) {
  const s = dsFirstString(raw, ['is_published', 'Is published', 'published', 'Published']);
  if (s === '' || s == null) return undefined;
  const t = String(s).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'نعم'].includes(t)) return true;
  if (['false', '0', 'no', 'n', 'لا'].includes(t)) return false;
  return undefined;
}

/** Parsed workbook row — name required before import; folder UUID from POST body. */
function dsNormalizePolicySheetRow(raw) {
  const name = dsFirstString(raw, ['name', 'Name', 'title', 'Title', 'Policy name', 'policy_name', 'اسم السياسة']);
  let description =
    dsFirstString(raw, ['description', 'Description', 'summary', 'Summary', 'ملخص']) || '';
  if (!description.trim() && raw && typeof raw === 'object') {
    description = dsBuildDescriptionFromRow(raw);
  }
  const ref_id = dsPolicyTruncateRef(
    dsFirstString(raw, ['ref_id', 'Ref ID', 'reference', 'Reference', 'كود', 'رمز']),
    100
  );
  const observation = dsFirstString(raw, ['observation', 'Observation']);
  const link = dsFirstString(raw, ['link', 'Link', 'url', 'URL']);

  return {
    name,
    description: description.trim(),
    ref_id,
    observation: observation || undefined,
    link: link || undefined,
    status: dsPolicyNormalizeStatus(raw),
    csf_function: dsPolicyNormalizeCsf(raw),
    priority: dsPolicyOptionalBoundedInt(raw, ['priority', 'Priority'], 1, 4),
    control_impact: dsPolicyOptionalBoundedInt(raw, ['control_impact', 'Control impact', 'impact'], 1, 5),
    progress_field: dsPolicyOptionalBoundedInt(raw, ['progress_field', 'Progress', 'progress'], 0, 100),
    effort: dsPolicyNormalizeEffort(raw),
    reference_control: dsPolicyOptionalUuid(raw, ['reference_control', 'reference control', 'Reference control']),
    start_date: dsPolicyOptionalDate(raw, ['start_date', 'Start date']),
    eta: dsPolicyOptionalDate(raw, ['eta', 'Eta', 'ETA']),
    expiry_date: dsPolicyOptionalDate(raw, ['expiry_date', 'Expiry date', 'expiry']),
    is_published: dsPolicyNormalizePublished(raw),
  };
}

/** Minimal POST body for each row — aligns with GRCPolicy create (omit undefined). */
function dsBuildPolicyPostPayload(row, folderUuid) {
  const body = { name: row.name, folder: folderUuid };
  if (row.description) body.description = row.description;
  if (row.ref_id) body.ref_id = row.ref_id;
  if (row.observation) body.observation = row.observation;
  if (row.link) body.link = row.link;
  if (row.status) body.status = row.status;
  if (row.csf_function) body.csf_function = row.csf_function;
  if (row.priority != null) body.priority = row.priority;
  if (row.reference_control) body.reference_control = row.reference_control;
  if (row.effort) body.effort = row.effort;
  if (row.control_impact != null) body.control_impact = row.control_impact;
  if (row.start_date) body.start_date = row.start_date;
  if (row.eta) body.eta = row.eta;
  if (row.expiry_date) body.expiry_date = row.expiry_date;
  if (row.progress_field != null) body.progress_field = row.progress_field;
  if (row.is_published === true || row.is_published === false) body.is_published = row.is_published;
  return body;
}

function dsParseWorkbookToPolicyRows(fileBuffer) {
  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const sn = wb.SheetNames || [];
  if (!sn.length) return { error: 'Workbook has no sheets.' };
  const sheet = wb.Sheets[sn[0]];
  const objects = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const rows = [];
  let excelRowNum = 1;
  let skippedEmptyName = 0;
  for (const o of objects) {
    excelRowNum++;
    const n = dsNormalizePolicySheetRow(o);
    if (!n.name) {
      skippedEmptyName++;
      continue;
    }
    rows.push({ ...n, excelRow: excelRowNum });
  }
  return { sheetName: sn[0], rows, skippedEmptyName };
}

/** Risk scenario rows → POST /api/risk-scenarios/ (row name required; risk_assessment from column or import default). */
function dsNormalizeRiskScenarioSheetRow(raw) {
  const name = dsFirstString(raw, [
    'name',
    'Name',
    'title',
    'Title',
    'scenario',
    'Scenario',
    'risk_scenario',
    'Risk scenario',
  ]);
  const description = dsFirstString(raw, ['description', 'Description', 'summary', 'Summary']) || '';
  const ref_id = dsPolicyTruncateRef(
    dsFirstString(raw, ['ref_id', 'Ref ID', 'reference', 'Reference', 'كود', 'رمز']),
    100
  );
  const observation = dsFirstString(raw, ['observation', 'Observation']);
  const raFromCol = dsFirstString(raw, [
    'risk_assessment',
    'Risk assessment',
    'assessment',
    'assessment_uuid',
    'risk_assessment_id',
  ]);
  let risk_assessment;
  if (raFromCol && DS_POLICY_UUID_RE.test(String(raFromCol).trim())) {
    risk_assessment = String(raFromCol).trim();
  }
  return {
    name,
    description: description.trim(),
    ref_id: ref_id || undefined,
    observation: observation || undefined,
    risk_assessment,
  };
}

function dsBuildRiskScenarioPostPayload(row) {
  const body = { name: row.name, risk_assessment: row.risk_assessment };
  if (row.description) body.description = row.description;
  if (row.ref_id) body.ref_id = row.ref_id;
  if (row.observation) body.observation = row.observation;
  return body;
}

function dsParseWorkbookToRiskScenarioRows(fileBuffer) {
  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const sn = wb.SheetNames || [];
  if (!sn.length) return { error: 'Workbook has no sheets.' };
  const sheet = wb.Sheets[sn[0]];
  const objects = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const rows = [];
  let excelRowNum = 1;
  let skippedEmptyName = 0;
  for (const o of objects) {
    excelRowNum++;
    const n = dsNormalizeRiskScenarioSheetRow(o);
    if (!n.name) {
      skippedEmptyName++;
      continue;
    }
    rows.push({ ...n, excelRow: excelRowNum });
  }
  return { sheetName: sn[0], rows, skippedEmptyName };
}

/** Basename suitable for HTTP Content-Disposition filename= (ASCII, rejects path tricks). */
function dsDispositionFilenameAscii(name, fallback = 'risk-matrix-library.yaml') {
  let base = fallback;
  try {
    base = path.basename(String(name || '').trim()) || fallback;
  } catch (_) { /* keep fallback */ }
  if (!base || base === '.' || base === '..') base = fallback;
  let out = base.replace(/[^\w.\-()+@]/g, '_');
  if (!out.endsWith('.yaml') && !out.endsWith('.yml')) {
    const stem = out.replace(/\.+$/, '') || 'library';
    out = `${stem.slice(0, 180)}.yaml`;
  }
  return out.slice(0, 200);
}

/** Light validation before forwarding YAML to POST /api/stored-libraries/upload/ (risk-matrix library envelope). */
function dsValidateRiskMatrixStoredLibraryYaml(yamlStr) {
  let doc;
  try {
    doc = yaml.load(yamlStr);
  } catch (e) {
    return { error: `YAML parse error: ${e.message}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: 'YAML root must be a mapping (object).' };
  }
  if (!String(doc.urn ?? '').trim()) return { error: 'Library YAML requires urn.' };
  if (!String(doc.name ?? '').trim()) return { error: 'Library YAML requires name.' };
  if (doc.version === undefined || doc.version === null) {
    return { error: 'Library YAML requires version (integer).' };
  }
  if (!String(doc.ref_id ?? '').trim()) {
    return { error: 'Library YAML requires ref_id (stored library creation).' };
  }
  if (!doc.objects || typeof doc.objects !== 'object' || Array.isArray(doc.objects)) {
    return { error: 'Library YAML requires objects mapping.' };
  }
  const o = doc.objects;
  if (o.risk_matrices != null && o.risk_matrix != null) {
    return { error: 'Define only one of objects.risk_matrices or objects.risk_matrix.' };
  }
  const list = o.risk_matrices;
  const legacy = o.risk_matrix;
  if (list != null) {
    if (!Array.isArray(list)) return { error: 'objects.risk_matrices must be a YAML list.' };
    if (!list.length) return { error: 'objects.risk_matrices must not be empty.' };
  } else if (legacy == null) {
    return { error: 'Provide objects.risk_matrices or objects.risk_matrix.' };
  }
  return { doc };
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
  /** Trailing slashes on /api/data-studio/** would skip strict matches; use `grcProxyTailMatch(routePath, …)` so path-prefixed gateways still match. */
  const pathnameNorm =
    typeof url.pathname === 'string' ? url.pathname.replace(/\/+$/, '') || '/' : '/';
  const routePath = pathnameNorm.replace(/\/{2,}/g, '/');

  // ---- Data Studio: Excel preview (applied controls import path) ----
  if (grcProxyTailMatch(routePath, '/api/data-studio/preview-excel') && req.method === 'POST') {
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

  if (grcProxyTailMatch(routePath, '/api/data-studio/create-audit') && req.method === 'POST') {
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

  if (grcProxyTailMatch(routePath, '/api/data-studio/diagnose-grc-audits') && req.method === 'GET') {
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

  if (grcProxyTailMatch(routePath, '/api/data-studio/import-applied-controls') && req.method === 'POST') {
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

  /** Data Studio → GRC POST /api/policies/ per workbook row (PolicyWriteSerializer; category forced upstream). */
  if (grcProxyTailMatch(routePath, '/api/data-studio/import-policies') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { fileName, data, folder } = body;
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
      const parsed = dsParseWorkbookToPolicyRows(fileBuffer);
      if (parsed.error) {
        sendJSON(res, 400, { error: parsed.error });
        return;
      }
      const { rows, sheetName, skippedEmptyName } = parsed;
      const folderTrim = folder.trim();
      const created = [];
      const errors = [];

      let rowIx = 0;
      for (const row of rows) {
        rowIx++;
        const grcBody = dsBuildPolicyPostPayload(row, folderTrim);
        const rowCtx = { row: row.excelRow, index: rowIx, name: row.name };

        try {
          const grcRes = await grcFetch(`${GRC_API_URL}/api/policies/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(grcBody),
          }, reqToken);
          if (!grcRes.ok) {
            const errIn = await consumeGrcErrorBody(res, reqToken, grcRes);
            if (errIn.aborted) return;
            const eMsg = errIn.errText.slice(0, 800);
            errors.push({ ...rowCtx, error: eMsg });
            continue;
          }
          const createdObj = await grcRes.json();
          const id = createdObj.id || createdObj.uuid;
          created.push({ ...rowCtx, id, ref_id: row.ref_id || null });
          console.log(
            `[DataStudio] Policy row ${rowCtx.row} POST /api/policies/ → ${id ? String(id).slice(0, 8) + '…' : '(no id)'}`
          );
        } catch (e) {
          errors.push({ ...rowCtx, error: e.message });
        }
      }

      sendJSON(res, 200, {
        success: true,
        sheetName,
        folder: folderTrim,
        totalParsedRows: rows.length,
        skippedEmptyName: skippedEmptyName || 0,
        createdCount: created.length,
        failedCount: errors.length,
        created,
        errors,
        grcPoliciesApi: `${GRC_API_URL}/api/policies/`,
      });
    } catch (err) {
      console.error('[DataStudio] import-policies:', err.message);
      sendJSON(res, 500, { error: err.message || 'Import failed.' });
    }
    return;
  }

  /** Data Studio → GRC POST /api/risk-scenarios/ per workbook row. */
  if (grcProxyTailMatch(routePath, '/api/data-studio/import-risk-scenarios') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { fileName, data, risk_assessment } = body;
      const raDefault =
        typeof risk_assessment === 'string' ? risk_assessment.trim() : '';

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
      const parsed = dsParseWorkbookToRiskScenarioRows(fileBuffer);
      if (parsed.error) {
        sendJSON(res, 400, { error: parsed.error });
        return;
      }
      const { rows, sheetName, skippedEmptyName } = parsed;
      const created = [];
      const errors = [];

      let rowIx = 0;
      for (const row of rows) {
        rowIx++;
        const assessmentUuid =
          typeof row.risk_assessment === 'string' ? row.risk_assessment.trim() || raDefault : raDefault;

        const rowCtx = { row: row.excelRow, index: rowIx, name: row.name };
        if (!assessmentUuid) {
          errors.push({
            ...rowCtx,
            error:
              'No risk_assessment UUID. Set Step 3 “Risk assessment UUID”, add a risk_assessment column, or omit per-row overrides only after a default exists.',
          });
          continue;
        }
        const merged = { ...row, risk_assessment: assessmentUuid };
        const grcBody = dsBuildRiskScenarioPostPayload(merged);

        try {
          const grcRes = await grcFetch(
            `${GRC_API_URL}/api/risk-scenarios/`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(grcBody),
            },
            reqToken
          );
          if (!grcRes.ok) {
            const errIn = await consumeGrcErrorBody(res, reqToken, grcRes);
            if (errIn.aborted) return;
            const eMsg = errIn.errText.slice(0, 800);
            errors.push({ ...rowCtx, error: eMsg });
            continue;
          }
          const createdObj = await grcRes.json();
          const id = createdObj.id || createdObj.uuid;
          created.push({ ...rowCtx, id, ref_id: row.ref_id || null });
          console.log(
            `[DataStudio] Risk scenario row ${rowCtx.row} POST /api/risk-scenarios/ → ${id ? String(id).slice(0, 8) + '…' : '(no id)'}`
          );
        } catch (e) {
          errors.push({ ...rowCtx, error: e.message });
        }
      }

      sendJSON(res, 200, {
        success: errors.length === 0,
        sheetName,
        risk_assessment_default: raDefault || null,
        totalParsedRows: rows.length,
        skippedEmptyName: skippedEmptyName || 0,
        createdCount: created.length,
        failedCount: errors.length,
        created,
        errors,
        grcRiskScenariosApi: `${GRC_API_URL}/api/risk-scenarios/`,
      });
    } catch (err) {
      console.error('[DataStudio] import-risk-scenarios:', err.message);
      sendJSON(res, 500, { error: err.message || 'Import failed.' });
    }
    return;
  }

  /**
   * Data Studio · Risk-matrix stored library YAML → raw body + Content-Disposition (same as Policy Approve→GRC stored-libraries/upload).
   */
  if (grcProxyTailMatch(routePath, '/api/data-studio/upload-risk-matrix-library-yaml') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const yamlText = typeof body.yaml === 'string' ? body.yaml : '';
      const fileHint = typeof body.fileName === 'string' ? body.fileName.trim() : '';
      if (!yamlText.trim()) {
        sendJSON(res, 400, { error: 'yaml (UTF-8 string) is required.' });
        return;
      }
      const v = dsValidateRiskMatrixStoredLibraryYaml(yamlText);
      if (v.error) {
        sendJSON(res, 400, { error: v.error });
        return;
      }
      const fileBuffer = Buffer.from(yamlText, 'utf8');
      const dispositionFn = dsDispositionFilenameAscii(
        fileHint || `${String(v.doc.ref_id).trim().replace(/\s+/g, '_')}.yaml`,
      );

      const grcRes = await grcFetch(
        `${GRC_API_URL}/api/stored-libraries/upload/`,
        {
          method: 'POST',
          headers: {
            'Content-Disposition': `attachment; filename=${dispositionFn}`,
            'Content-Length': String(fileBuffer.length),
          },
          body: fileBuffer,
        },
        reqToken
      );
      if (!grcRes.ok) {
        const errIn = await consumeGrcErrorBody(res, reqToken, grcRes);
        if (errIn.aborted) return;
        const eMsg = errIn.errText.slice(0, 900);
        sendJSON(res, grcRes.status >= 400 && grcRes.status < 600 ? grcRes.status : 502, {
          success: false,
          error: eMsg,
          grcStoredLibrariesUpload: `${GRC_API_URL}/api/stored-libraries/upload/`,
        });
        return;
      }
      const createdObj = await grcRes.json().catch(() => ({}));
      console.log(`[DataStudio] stored-libraries/upload (risk matrix YAML) → ok`);
      sendJSON(res, 200, {
        success: true,
        result: createdObj,
        grcStoredLibrariesUpload: `${GRC_API_URL}/api/stored-libraries/upload/`,
      });
    } catch (err) {
      console.error('[DataStudio] upload-risk-matrix-library-yaml:', err.message);
      sendJSON(res, 500, { error: err.message || 'Upload failed.' });
    }
    return;
  }

  // ---- Legislative updates: internal sources (GCS + SQLite) ----
  if (url.pathname === '/api/legislative-updates/internal-sources' && req.method === 'GET') {
    try {
      const session = reqToken ? authSessions.get(reqToken) : null;
      if (!session) {
        sendJSON(res, 401, { error: 'Unauthorized.' });
        return;
      }
      const rows = dbListLegislativeInternal.all();
      const gcs = getLegislativeGcsClient();
      const sources = [];
      for (const row of rows) {
        let download_url = row.public_url;
        if (gcs.ok) {
          try {
            download_url = await legislativeSignedDownloadUrl(
              gcs.storage,
              row.gcs_bucket,
              row.gcs_object_path,
              row.mime_type
            );
          } catch (sigErr) {
            console.warn('[Legislative] signed URL:', sigErr.message);
          }
        }
        sources.push({
          id: row.id,
          name: row.name,
          description: row.description,
          original_file_name: row.original_file_name,
          mime_type: row.mime_type,
          size: row.size,
          uploaded_by: row.uploaded_by,
          created_at: row.created_at,
          download_url,
        });
      }
      sendJSON(res, 200, { success: true, sources });
    } catch (err) {
      console.error('[Legislative] list:', err);
      sendJSON(res, 500, { error: err.message || 'Failed to list sources.' });
    }
    return;
  }

  if (url.pathname === '/api/legislative-updates/internal-sources' && req.method === 'POST') {
    try {
      const session = reqToken ? authSessions.get(reqToken) : null;
      if (!session) {
        sendJSON(res, 401, { error: 'Unauthorized.' });
        return;
      }
      const gcs = getLegislativeGcsClient();
      if (!gcs.ok) {
        sendJSON(res, 503, {
          error: gcs.error,
          hint: 'Install @google-cloud/storage and set GOOGLE_APPLICATION_CREDENTIALS (or run on GCP with a service account that can sign URLs and write to the bucket).',
        });
        return;
      }
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const description = String(body.description != null ? body.description : '').trim();
      const fileName = String(body.fileName || body.originalName || '').trim();
      const mimeType = String(body.mimeType || 'application/octet-stream').trim();
      if (!name) {
        sendJSON(res, 400, { error: 'name is required.' });
        return;
      }
      if (!body.data || typeof body.data !== 'string') {
        sendJSON(res, 400, { error: 'File data (base64) is required.' });
        return;
      }
      let buf;
      try {
        buf = Buffer.from(body.data, 'base64');
      } catch {
        sendJSON(res, 400, { error: 'Invalid base64 file payload.' });
        return;
      }
      const MAX_LEGISLATIVE_FILE = 50 * 1024 * 1024;
      if (!buf.length) {
        sendJSON(res, 400, { error: 'Empty file.' });
        return;
      }
      if (buf.length > MAX_LEGISLATIVE_FILE) {
        sendJSON(res, 400, { error: 'File too large (max 50 MB).' });
        return;
      }

      const id = crypto.randomUUID();
      const safeSeg = legislativeSafeObjectSegment(fileName || 'document');
      const objectPath = `internal/${id}/${safeSeg}`;
      const bucketName = GCS_LEGISLATIVE_BUCKET_NAME;
      const file = gcs.storage.bucket(bucketName).file(objectPath);

      await legislativeUploadBuffer(
        gcs.storage,
        bucketName,
        objectPath,
        buf,
        mimeType || 'application/octet-stream',
        { uploaded_by: session.username, source_name: name }
      );

      const publicUrl = legislativePublicUrl(bucketName, objectPath);
      const createdAt = new Date().toISOString();
      const meta = {
        id,
        name,
        description,
        original_file_name: fileName || safeSeg,
        mime_type: mimeType || 'application/octet-stream',
        size: buf.length,
        gcs_bucket: bucketName,
        gcs_object_path: objectPath,
        public_url: publicUrl,
        uploaded_by: session.username,
        created_at: createdAt,
      };

      try {
        dbInsertLegislativeInternal.run(meta);
      } catch (dbErr) {
        try {
          await file.delete({ ignoreNotFound: true });
        } catch (_) { /* ignore */ }
        throw dbErr;
      }

      let download_url = publicUrl;
      try {
        download_url = await legislativeSignedDownloadUrl(
          gcs.storage,
          bucketName,
          objectPath,
          mimeType || 'application/octet-stream'
        );
      } catch (_) { /* keep publicUrl */ }

      sendJSON(res, 201, {
        success: true,
        source: {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          original_file_name: meta.original_file_name,
          mime_type: meta.mime_type,
          size: meta.size,
          uploaded_by: meta.uploaded_by,
          created_at: meta.created_at,
          download_url,
        },
      });
    } catch (err) {
      console.error('[Legislative] upload:', err);
      sendJSON(res, 500, { error: err.message || 'Upload failed.' });
    }
    return;
  }

  const luInternalOneMatch = url.pathname.match(
    /^\/api\/legislative-updates\/internal-sources\/([^/]+)$/
  );
  if (luInternalOneMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const id = luInternalOneMatch[1];
    try {
      const session = reqToken ? authSessions.get(reqToken) : null;
      if (!session) {
        sendJSON(res, 401, { error: 'Unauthorized.' });
        return;
      }
      const row = dbGetLegislativeInternal.get(id);
      if (!row) {
        sendJSON(res, 404, { error: 'Source not found.' });
        return;
      }

      if (req.method === 'DELETE') {
        const gcs = getLegislativeGcsClient();
        if (gcs.ok) {
          try {
            await gcs.storage.bucket(row.gcs_bucket).file(row.gcs_object_path).delete({ ignoreNotFound: true });
          } catch (delErr) {
            console.warn('[Legislative] GCS delete:', delErr.message);
          }
        }
        dbDeleteLegislativeInternal.run(id);
        sendJSON(res, 200, { success: true, deleted: true });
        return;
      }

      const body = await parseBody(req);
      const name = String(body.name != null ? body.name : '').trim();
      const description = String(body.description != null ? body.description : '').trim();
      if (!name) {
        sendJSON(res, 400, { error: 'name is required.' });
        return;
      }
      dbUpdateLegislativeInternalMeta.run(name, description, id);
      const updated = dbGetLegislativeInternal.get(id);
      let download_url = updated.public_url;
      const gcs = getLegislativeGcsClient();
      if (gcs.ok) {
        try {
          download_url = await legislativeSignedDownloadUrl(
            gcs.storage,
            updated.gcs_bucket,
            updated.gcs_object_path,
            updated.mime_type
          );
        } catch (sigErr) {
          console.warn('[Legislative] signed URL (patch):', sigErr.message);
        }
      }
      sendJSON(res, 200, {
        success: true,
        source: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          original_file_name: updated.original_file_name,
          mime_type: updated.mime_type,
          size: updated.size,
          uploaded_by: updated.uploaded_by,
          created_at: updated.created_at,
          download_url,
        },
      });
    } catch (err) {
      console.error('[Legislative] patch/delete:', err);
      sendJSON(res, 500, { error: err.message || 'Operation failed.' });
    }
    return;
  }

  // ---- Legislative updates: extracted updates (portal feed) ----
  // GET  /api/legislative-updates/extracted        — list with filters & pagination
  // GET  /api/legislative-updates/extracted/facets — distinct sources/statuses/impacts (for UI dropdowns)
  // GET  /api/legislative-updates/extracted/:id    — single update
  // POST /api/legislative-updates/extracted        — create (auth)
  // PATCH /api/legislative-updates/extracted/:id   — update (auth)
  // DELETE /api/legislative-updates/extracted/:id  — delete (auth)
  if (url.pathname === '/api/legislative-updates/extracted/facets' && req.method === 'GET') {
    try {
      const sources = db
        .prepare(`SELECT DISTINCT source FROM legislative_extracted_updates WHERE source <> '' ORDER BY source`)
        .all()
        .map((r) => r.source);
      const statuses = db
        .prepare(`SELECT DISTINCT status, status_label FROM legislative_extracted_updates WHERE status <> '' ORDER BY status`)
        .all()
        .map((r) => ({ value: r.status, label: r.status_label || LU_DEFAULT_STATUS_LABELS[r.status] || r.status }));
      const impacts = db
        .prepare(`SELECT DISTINCT impact_level, impact_label FROM legislative_extracted_updates WHERE impact_level <> '' ORDER BY impact_level`)
        .all()
        .map((r) => ({ value: r.impact_level, label: r.impact_label || LU_DEFAULT_IMPACT_LABELS[r.impact_level] || r.impact_level }));
      sendJSON(res, 200, { success: true, sources, statuses, impacts });
    } catch (err) {
      console.error('[Legislative] facets:', err);
      sendJSON(res, 500, { error: err.message || 'Failed to load facets.' });
    }
    return;
  }

  if (url.pathname === '/api/legislative-updates/extracted' && req.method === 'GET') {
    try {
      const q = String(url.searchParams.get('q') || '').trim();
      const sourceFilter = String(url.searchParams.get('source') || '').trim();
      const statusFilter = luNormalizeStatus(url.searchParams.get('status') || '');
      const impactFilter = luNormalizeImpact(url.searchParams.get('impact_level') || url.searchParams.get('impact') || '');
      const dateFrom = String(url.searchParams.get('date_from') || url.searchParams.get('dateFrom') || '').trim();
      const dateTo = String(url.searchParams.get('date_to') || url.searchParams.get('dateTo') || '').trim();
      let limit = parseInt(url.searchParams.get('limit') || '50', 10);
      let offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      if (limit > 200) limit = 200;
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      const where = [];
      const params = [];
      if (q) {
        where.push(`(title LIKE ? OR description LIKE ? OR source LIKE ? OR tags LIKE ?)`);
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      if (sourceFilter) { where.push(`source = ?`); params.push(sourceFilter); }
      if (statusFilter) { where.push(`status = ?`); params.push(statusFilter); }
      if (impactFilter) { where.push(`impact_level = ?`); params.push(impactFilter); }
      if (dateFrom) { where.push(`(published_at IS NULL OR published_at >= ?)`); params.push(dateFrom); }
      if (dateTo)   { where.push(`(published_at IS NULL OR published_at <= ?)`); params.push(dateTo); }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db
        .prepare(`SELECT COUNT(*) AS c FROM legislative_extracted_updates ${whereSql}`)
        .get(...params).c;
      const rows = db
        .prepare(
          `SELECT * FROM legislative_extracted_updates ${whereSql}
           ORDER BY datetime(COALESCE(published_at, created_at)) DESC, datetime(created_at) DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset);

      sendJSON(res, 200, {
        success: true,
        total,
        limit,
        offset,
        count: rows.length,
        items: rows.map(luRowToApi),
      });
    } catch (err) {
      console.error('[Legislative] extracted list:', err);
      sendJSON(res, 500, { error: err.message || 'Failed to list extracted updates.' });
    }
    return;
  }

  if (url.pathname === '/api/legislative-updates/extracted' && req.method === 'POST') {
    try {
      const session = reqToken ? authSessions.get(reqToken) : null;
      if (!session) { sendJSON(res, 401, { error: 'Unauthorized.' }); return; }
      const body = await parseBody(req);
      const title = String(body.title || '').trim();
      if (!title) { sendJSON(res, 400, { error: 'title is required.' }); return; }
      const status = luNormalizeStatus(body.status) || 'new';
      const impact = luNormalizeImpact(body.impact_level || body.impact) || 'medium';
      const id = String(body.id || '').trim() || crypto.randomUUID();
      const now = new Date().toISOString();
      const row = {
        id,
        title,
        description: String(body.description || '').trim(),
        source: String(body.source || '').trim(),
        source_id: body.source_id ? String(body.source_id) : null,
        internal_source_id: body.internal_source_id ? String(body.internal_source_id) : null,
        external_url: String(body.external_url || '').trim(),
        published_at: body.published_at ? String(body.published_at).trim() : null,
        status,
        status_label: String(body.status_label || LU_DEFAULT_STATUS_LABELS[status] || ''),
        impact_level: impact,
        impact_label: String(body.impact_label || LU_DEFAULT_IMPACT_LABELS[impact] || ''),
        affected_policies_count: Number.isFinite(+body.affected_policies_count)
          ? Math.max(0, parseInt(body.affected_policies_count, 10))
          : 0,
        affected_policy_ids: JSON.stringify(Array.isArray(body.affected_policy_ids) ? body.affected_policy_ids : []),
        tags: JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
        language: String(body.language || 'ar'),
        raw_text: String(body.raw_text || ''),
        metadata: JSON.stringify(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
        created_at: now,
        updated_at: now,
      };
      try {
        dbInsertLegislativeExtracted.run(row);
      } catch (insErr) {
        if (/UNIQUE|PRIMARY KEY/i.test(insErr.message)) {
          sendJSON(res, 409, { error: 'An update with this id already exists.' });
          return;
        }
        throw insErr;
      }
      sendJSON(res, 201, { success: true, item: luRowToApi(dbGetLegislativeExtracted.get(id)) });
    } catch (err) {
      console.error('[Legislative] extracted create:', err);
      sendJSON(res, 500, { error: err.message || 'Failed to create extracted update.' });
    }
    return;
  }

  const luExtractedOneMatch = url.pathname.match(
    /^\/api\/legislative-updates\/extracted\/([^/]+)$/
  );
  if (luExtractedOneMatch && req.method === 'GET') {
    const id = luExtractedOneMatch[1];
    try {
      const row = dbGetLegislativeExtracted.get(id);
      if (!row) { sendJSON(res, 404, { error: 'Update not found.' }); return; }
      sendJSON(res, 200, { success: true, item: luRowToApi(row) });
    } catch (err) {
      console.error('[Legislative] extracted get:', err);
      sendJSON(res, 500, { error: err.message || 'Failed to load update.' });
    }
    return;
  }

  if (luExtractedOneMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const id = luExtractedOneMatch[1];
    try {
      const session = reqToken ? authSessions.get(reqToken) : null;
      if (!session) { sendJSON(res, 401, { error: 'Unauthorized.' }); return; }
      const existing = dbGetLegislativeExtracted.get(id);
      if (!existing) { sendJSON(res, 404, { error: 'Update not found.' }); return; }

      if (req.method === 'DELETE') {
        dbDeleteLegislativeExtracted.run(id);
        sendJSON(res, 200, { success: true, deleted: true, id });
        return;
      }

      const body = await parseBody(req);
      const status = body.status != null ? (luNormalizeStatus(body.status) || existing.status) : existing.status;
      const impact = (body.impact_level != null || body.impact != null)
        ? (luNormalizeImpact(body.impact_level || body.impact) || existing.impact_level)
        : existing.impact_level;
      const merged = {
        id,
        title: body.title != null ? String(body.title).trim() : existing.title,
        description: body.description != null ? String(body.description).trim() : (existing.description || ''),
        source: body.source != null ? String(body.source).trim() : (existing.source || ''),
        source_id: body.source_id !== undefined ? (body.source_id ? String(body.source_id) : null) : existing.source_id,
        internal_source_id: body.internal_source_id !== undefined
          ? (body.internal_source_id ? String(body.internal_source_id) : null)
          : existing.internal_source_id,
        external_url: body.external_url != null ? String(body.external_url).trim() : (existing.external_url || ''),
        published_at: body.published_at !== undefined
          ? (body.published_at ? String(body.published_at).trim() : null)
          : existing.published_at,
        status,
        status_label: body.status_label != null
          ? String(body.status_label)
          : (status !== existing.status ? (LU_DEFAULT_STATUS_LABELS[status] || '') : (existing.status_label || '')),
        impact_level: impact,
        impact_label: body.impact_label != null
          ? String(body.impact_label)
          : (impact !== existing.impact_level ? (LU_DEFAULT_IMPACT_LABELS[impact] || '') : (existing.impact_label || '')),
        affected_policies_count: body.affected_policies_count != null && Number.isFinite(+body.affected_policies_count)
          ? Math.max(0, parseInt(body.affected_policies_count, 10))
          : existing.affected_policies_count,
        affected_policy_ids: Array.isArray(body.affected_policy_ids)
          ? JSON.stringify(body.affected_policy_ids)
          : existing.affected_policy_ids,
        tags: Array.isArray(body.tags) ? JSON.stringify(body.tags) : existing.tags,
        language: body.language != null ? String(body.language) : existing.language,
        raw_text: body.raw_text != null ? String(body.raw_text) : existing.raw_text,
        metadata: body.metadata && typeof body.metadata === 'object'
          ? JSON.stringify(body.metadata)
          : existing.metadata,
        updated_at: new Date().toISOString(),
      };
      if (!merged.title) { sendJSON(res, 400, { error: 'title cannot be empty.' }); return; }
      dbUpdateLegislativeExtracted.run(merged);
      sendJSON(res, 200, { success: true, item: luRowToApi(dbGetLegislativeExtracted.get(id)) });
    } catch (err) {
      console.error('[Legislative] extracted patch/delete:', err);
      sendJSON(res, 500, { error: err.message || 'Operation failed.' });
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
      // Use request-provided defs; fall back to DB-stored impact criteria
      let f4SeverityDefinitions =
        body.f4SeverityDefinitions && typeof body.f4SeverityDefinitions === 'object'
          ? body.f4SeverityDefinitions
          : undefined;
      if (!f4SeverityDefinitions || !Object.keys(f4SeverityDefinitions).some(k => f4SeverityDefinitions[k])) {
        try {
          const dbDefs = {};
          for (const k of ['critical', 'high', 'medium', 'low', 'none']) {
            const row = db.prepare('SELECT value FROM pipeline_config WHERE key = ?').get(`f4_sev_${k}`);
            if (row && row.value) dbDefs[k] = row.value;
          }
          if (Object.keys(dbDefs).length) f4SeverityDefinitions = dbDefs;
        } catch (dbErr) {
          console.warn('[PolicyUpdatePipeline] Could not load impact criteria from DB:', dbErr.message);
        }
      }
      const result = await runPolicyUpdatePipeline({
        apiKey,
        orgContext,
        regulationText,
        policies,
        overrides: body.overrides && typeof body.overrides === 'object' ? body.overrides : undefined,
        f4SeverityDefinitions,
      });
      sendJSON(res, 200, { success: true, data: result });
    } catch (err) {
      console.error('[PolicyUpdatePipeline]', err);
      sendJSON(res, 500, { error: err.message || 'Pipeline failed.' });
    }
    return;
  }

  // ---- AI Tools: Extract policies from uploaded file (Gemini 2.5 Pro → [{title, content}]) ----
  if (url.pathname === '/api/ai-tools/extract-policies-from-file' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const apiKey = GEMINI_API_KEY || req.headers['x-api-key'];
      if (!apiKey) {
        sendJSON(res, 401, { error: 'API key not configured. Add GEMINI_API_KEY to .env file.' });
        return;
      }
      const { fileName, mimeType, data } = body;
      if (!data || typeof data !== 'string') {
        sendJSON(res, 400, { error: 'data (base64) is required.' });
        return;
      }
      if (!mimeType || typeof mimeType !== 'string') {
        sendJSON(res, 400, { error: 'mimeType is required.' });
        return;
      }

      if (!genai) genai = new GoogleGenAI({ apiKey });

      const systemPrompt = `You are a legal and regulatory analyst specialising in extracting structured articles from legislation, regulations, standards, and policy documents.

Your task is to read the uploaded document and extract every article, clause, section, or rule it contains.

OUTPUT FORMAT — return ONLY a valid JSON array, no markdown fences, no commentary:
[
  {
    "article": "The exact article/section label from the document (e.g. 'Article 1', 'Section 2.3', 'Clause 4', 'المادة الأولى')",
    "title": "Short descriptive title for this article (3–8 words)",
    "text": "The full verbatim or faithfully summarised text of this article. Preserve all obligations, conditions, actors, scope, and deadlines. Be comprehensive — do not truncate."
  }
]

RULES:
- Extract ALL articles, sections, clauses, and sub-clauses — do not sample.
- article: use the exact label from the document. If no label exists, infer one (e.g. 'Section 1').
- title: concise, specific, unique per entry. Derive from the article heading or its main subject.
- text: faithful and complete. Preserve important legal language, obligations, and numeric thresholds.
- Do NOT include: table of contents, preamble metadata, signature blocks, page numbers, or revision histories as separate entries unless they contain substantive obligations.
- Preserve the source language (Arabic document → Arabic output, English document → English output).
- Output MUST be a valid JSON array parseable by JSON.parse() with no trailing commas.`;

      const userPrompt = `Extract all articles and regulatory clauses from the uploaded document "${fileName || 'document'}".
Return a JSON array where each element has "article", "title", and "text" fields as described.`;

      console.log(`[RegulationExtract] Calling Gemini 2.5 Pro for file "${fileName}" (${mimeType})`);
      const startTime = Date.now();

      const response = await genai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType, data } },
            { text: userPrompt },
          ],
        }],
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.1,
          maxOutputTokens: 32768,
          responseMimeType: 'application/json',
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const textResponse = response.text || '';
      if (!textResponse) throw new Error('No response from Gemini');

      // Parse JSON array from response
      let jsonStr = textResponse.trim();
      const fenceMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
      // Trim to first [...] block if there's surrounding text
      if (!jsonStr.startsWith('[')) {
        const openIdx = jsonStr.indexOf('[');
        if (openIdx >= 0) jsonStr = jsonStr.slice(openIdx);
      }

      let articles;
      try {
        articles = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Salvage: JSON likely truncated mid-array (Gemini hit maxOutputTokens).
        // Walk balanced braces and collect every COMPLETE {...} object.
        const salvaged = salvageArticleObjects(jsonStr);
        if (salvaged.length) {
          console.warn(`[RegulationExtract] JSON truncated — salvaged ${salvaged.length} complete articles before parse error: ${parseErr.message}`);
          articles = salvaged;
        } else {
          throw new Error(`Gemini returned unparseable JSON: ${parseErr.message}. Raw (first 500): ${jsonStr.slice(0, 500)}`);
        }
      }
      if (!Array.isArray(articles)) throw new Error('Gemini response was not a JSON array.');

      // Normalise: ensure each item has article + title + text
      articles = articles.filter(a => a && (a.article || a.title || a.text)).map((a, i) => ({
        article: String(a.article || `Article ${i + 1}`).trim(),
        title:   String(a.title   || '').trim(),
        text:    String(a.text    || a.content || a.description || '').trim(),
      }));

      console.log(`[RegulationExtract] ✅ Extracted ${articles.length} articles in ${elapsed}s`);
      sendJSON(res, 200, { success: true, articles, sourceFile: fileName || '', elapsed });
    } catch (err) {
      console.error('[PolicyExtract]', err.message);
      sendJSON(res, 500, { error: err.message || 'Extraction failed.' });
    }
    return;
  }

  // ---- AI Tools: List extracted regulations from DB ----
  if (url.pathname === '/api/ai-tools/extracted-regulations' && req.method === 'GET') {
    try {
      const rows = dbListExtractedRegulations.all();
      const data = rows.map(r => ({
        id: r.id,
        sourceFile: r.source_file || '',
        articles: (() => { try { return JSON.parse(r.articles || '[]'); } catch { return []; } })(),
        createdAt: r.created_at,
      }));
      sendJSON(res, 200, { success: true, data });
    } catch (err) {
      console.error('[ExtractedRegulations] list:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to list.' });
    }
    return;
  }

  // ---- AI Tools: Save extracted regulation to DB ----
  if (url.pathname === '/api/ai-tools/extracted-regulations' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const articles = Array.isArray(body.articles) ? body.articles : [];
      if (!articles.length) {
        sendJSON(res, 400, { error: 'articles array is required and must not be empty.' });
        return;
      }
      const id = 'er-' + crypto.randomUUID();
      const now = new Date().toISOString();
      dbInsertExtractedRegulations.run(id, String(body.sourceFile || ''), JSON.stringify(articles), now);
      sendJSON(res, 201, { success: true, id, count: articles.length });
    } catch (err) {
      console.error('[ExtractedRegulations] save:', err.message);
      sendJSON(res, 500, { error: err.message || 'Save failed.' });
    }
    return;
  }

  // ---- Pipeline Runs: Save ----
  if (url.pathname === '/api/ai-tools/pipeline-runs' && req.method === 'POST') {
    try {
      // The /api/ai-tools/pipeline-runs prefix is whitelisted in isPublicPath
      // for read access (portal feed), so we must re-check auth here for writes
      // to prevent unauthenticated inserts into pipeline_runs.
      const session = reqToken ? authSessions.get(reqToken) : null;
      if (!session) { sendJSON(res, 401, { error: 'Unauthorized.' }); return; }
      const body = await parseBody(req);
      const result = body.result && typeof body.result === 'object' ? body.result : {};
      const orgContext = String(body.orgContext || '');
      const regulationText = String(body.regulationText || '');
      const policyCount = Number.isFinite(body.policyCount) ? body.policyCount : 0;
      const stageReached = String(result.stage_reached || body.stageReached || '');
      const regulationSnippet = regulationText.slice(0, 300).replace(/\s+/g, ' ').trim();

      if (!Object.keys(result).length) {
        sendJSON(res, 400, { error: 'result object is required.' });
        return;
      }

      const id = 'pr-' + crypto.randomUUID();
      const now = new Date().toISOString();
      dbInsertPipelineRun.run(
        id,
        orgContext,
        regulationSnippet,
        regulationText,
        policyCount,
        stageReached,
        JSON.stringify(result),
        now
      );
      console.log(`[PipelineRuns] Saved run ${id} (stage: ${stageReached}, policies: ${policyCount})`);

      // Fire-and-forget: render the report HTML → PDF (puppeteer) → upload to
      // pup-data bucket → update report_pdf_* columns. The client gets the
      // run id back immediately and asks GET /report-pdf later.
      kickPipelineReportPdfGeneration(id, result, {
        sourceName: body.sourceName || body.sourceFile || '',
        generatedAt: now,
      });

      sendJSON(res, 201, { success: true, id, reportPdfStatus: 'pending' });
    } catch (err) {
      console.error('[PipelineRuns] save:', err.message);
      sendJSON(res, 500, { error: err.message || 'Save failed.' });
    }
    return;
  }

  // ---- Pipeline Runs: List ----
  if (url.pathname === '/api/ai-tools/pipeline-runs' && req.method === 'GET') {
    try {
      const rows = dbListPipelineRuns.all();
      const data = rows.map(r => ({
        ...r,
        result: (() => { try { return JSON.parse(r.result || '{}'); } catch { return {}; } })(),
      }));
      sendJSON(res, 200, { success: true, data });
    } catch (err) {
      console.error('[PipelineRuns] list:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to list.' });
    }
    return;
  }

  // ---- Pipeline Runs: Get by ID ----
  const pipelineRunMatch = url.pathname.match(/^\/api\/ai-tools\/pipeline-runs\/([^/]+)$/);
  if (pipelineRunMatch && req.method === 'GET') {
    try {
      const row = dbGetPipelineRun.get(pipelineRunMatch[1]);
      if (!row) { sendJSON(res, 404, { error: 'Run not found.' }); return; }
      sendJSON(res, 200, {
        success: true,
        data: {
          ...row,
          result: (() => { try { return JSON.parse(row.result || '{}'); } catch { return {}; } })(),
        },
      });
    } catch (err) {
      console.error('[PipelineRuns] get:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to get.' });
    }
    return;
  }

  // ---- Pipeline Runs: Report PDF download URL ----
  // Returns the current PDF status for a run. When ready, includes a fresh
  // 1-hour signed download URL pointing at the file in pup-data bucket.
  //   { status: 'ready',  url, filename, generatedAt, sizeBytes }
  //   { status: 'pending' }
  //   { status: 'failed', error }
  //   { status: 'unavailable' }       ← old run, never generated
  const pipelinePdfMatch = url.pathname.match(/^\/api\/ai-tools\/pipeline-runs\/([^/]+)\/report-pdf$/);
  if (pipelinePdfMatch && req.method === 'GET') {
    try {
      const row = dbGetPipelineRun.get(pipelinePdfMatch[1]);
      if (!row) { sendJSON(res, 404, { error: 'Run not found.' }); return; }
      const status = row.report_pdf_status || null;
      if (!status) {
        // Legacy run created before server-side PDF generation existed. Rather
        // than reporting 'unavailable' forever, generate the PDF on demand from
        // the stored result and return 'pending' so the client polls for it.
        let storedResult = null;
        try { storedResult = JSON.parse(row.result || '{}'); } catch { storedResult = null; }
        if (storedResult && typeof storedResult === 'object' && Object.keys(storedResult).length) {
          kickPipelineReportPdfGeneration(row.id, storedResult, {
            sourceName: row.regulation_snippet || '',
            generatedAt: row.created_at || new Date().toISOString(),
          });
          sendJSON(res, 200, { success: true, status: 'pending', runId: row.id });
          return;
        }
        // Truly nothing to render from — keep the honest 'unavailable' signal.
        sendJSON(res, 200, { success: true, status: 'unavailable', runId: row.id });
        return;
      }
      if (status === 'pending') {
        sendJSON(res, 200, { success: true, status: 'pending', runId: row.id });
        return;
      }
      if (status === 'failed') {
        sendJSON(res, 200, { success: true, status: 'failed', runId: row.id, error: row.report_pdf_error || 'unknown error' });
        return;
      }
      if (status === 'ready') {
        const bucket = row.report_pdf_bucket || GCS_PUP_BUCKET_NAME;
        const objectPath = row.report_pdf_object_path;
        if (!bucket || !objectPath) {
          sendJSON(res, 500, { error: 'Report PDF marked ready but object path missing.' });
          return;
        }
        const gcs = getLegislativeGcsClient();
        if (!gcs.ok) { sendJSON(res, 500, { error: gcs.error || 'GCS unavailable' }); return; }
        const filename = pipelinePdfDownloadFilename(row.id, row.regulation_snippet);
        const [signedUrl] = await gcs.storage.bucket(bucket).file(objectPath).getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + 60 * 60 * 1000,
          responseDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
          responseType: 'application/pdf',
        });
        sendJSON(res, 200, {
          success: true,
          status: 'ready',
          runId: row.id,
          url: signedUrl,
          filename,
          generatedAt: row.report_pdf_generated_at,
          sizeBytes: row.report_pdf_size_bytes,
        });
        return;
      }
      sendJSON(res, 200, { success: true, status: String(status), runId: row.id });
    } catch (err) {
      console.error('[PipelineRuns] report-pdf:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to resolve report PDF.' });
    }
    return;
  }

  // ---- Pipeline-derived Legislative Updates: list ----
  // Projects rows from `pipeline_runs` into the same luRowToApi-shape consumed
  // by the portal's legislative-update list/detail screens, with a `pipeline`
  // extension on the detail endpoint carrying F2 key-changes & F4 impacts.
  //
  // Query params (all optional): q, status, impact_level/impact, limit, offset.
  if (url.pathname === '/api/ai-tools/pipeline-legislative-updates' && req.method === 'GET') {
    try {
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const statusFilter = luNormalizeStatus(url.searchParams.get('status') || '');
      const impactFilter = luNormalizeImpact(url.searchParams.get('impact_level') || url.searchParams.get('impact') || '');
      let limit = parseInt(url.searchParams.get('limit') || '50', 10);
      let offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      if (limit > 200) limit = 200;
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      const rows = dbListPipelineRuns.all();
      const projected = rows.map((r) => pipelineRunToLegislativeUpdate(r, { includePipeline: false }));
      const filtered = projected.filter((it) => {
        if (statusFilter && it.status !== statusFilter) return false;
        if (impactFilter && it.impact_level !== impactFilter) return false;
        if (q) {
          const hay = `${it.title}\n${it.description}\n${(it.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const total = filtered.length;
      const items = filtered.slice(offset, offset + limit);

      sendJSON(res, 200, {
        success: true,
        total,
        limit,
        offset,
        count: items.length,
        items,
      });
    } catch (err) {
      console.error('[PipelineLegislative] list:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to list.' });
    }
    return;
  }

  // ---- Pipeline-derived Legislative Updates: get by id ----
  const pipelineLuMatch = url.pathname.match(/^\/api\/ai-tools\/pipeline-legislative-updates\/([^/]+)$/);
  if (pipelineLuMatch && req.method === 'GET') {
    try {
      const row = dbGetPipelineRun.get(pipelineLuMatch[1]);
      if (!row) { sendJSON(res, 404, { error: 'Pipeline run not found.' }); return; }
      const item = pipelineRunToLegislativeUpdate(row, { includePipeline: true });
      sendJSON(res, 200, { success: true, item });
    } catch (err) {
      console.error('[PipelineLegislative] get:', err.message);
      sendJSON(res, 500, { error: err.message || 'Failed to get.' });
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

  // ---- GRC Platform Proxy: Policies (native /api/policies/ — not applied-controls list) ----
  if (url.pathname === '/api/grc/policies' && req.method === 'GET') {
    try {
      const qs = url.search || '';
      const join = qs ? `${qs}&page_size=500` : '?page_size=500';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/policies/${join}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Policies list error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === '/api/grc/policies' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/policies/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status >= 400 ? grcRes.status : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Create policy error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const grcPolicyIdMatch = url.pathname.match(/^\/api\/grc\/policies\/([^/]+)\/?$/);
  if (grcPolicyIdMatch && req.method === 'PATCH') {
    try {
      const polId = grcPolicyIdMatch[1];
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/policies/${encodeURIComponent(polId)}/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] PATCH policy error:', error.message);
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

  // ---- GRC Platform Proxy: Risk scenarios (list + create; query passthrough) ----
  if (grcProxyTailMatch(routePath, '/api/grc/risk-scenarios') && req.method === 'GET') {
    try {
      const q = url.search && url.search.length > 1 ? url.search.slice(1) : 'page_size=500';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-scenarios/?${q}`, {}, reqToken);
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
  if (grcProxyTailMatch(routePath, '/api/grc/risk-scenarios') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-scenarios/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status >= 400 ? grcRes.status : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Create risk scenario error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC: Perimeters (folder scope for risk assessments) ----
  if (grcProxyTailMatch(routePath, '/api/grc/perimeters') && req.method === 'GET') {
    try {
      const q = url.search && url.search.length > 1 ? url.search.slice(1) : 'page_size=200';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/perimeters/?${q}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Perimeters list error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (grcProxyTailMatch(routePath, '/api/grc/perimeters') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/perimeters/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status >= 400 ? grcRes.status : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Create perimeter error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC: Risk matrices (required on RiskAssessment) ----
  if (grcProxyTailMatch(routePath, '/api/grc/risk-matrices') && req.method === 'GET') {
    try {
      const q = url.search && url.search.length > 1 ? url.search.slice(1) : 'page_size=200';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-matrices/?${q}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Risk matrices error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (grcProxyTailMatch(routePath, '/api/grc/risk-matrices') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-matrices/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status >= 400 ? grcRes.status : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Create risk matrix error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ---- GRC: Risk assessments (CRUD + duplicate, sync, action-plan) ----
  if (grcProxyTailMatch(routePath, '/api/grc/risk-assessments') && req.method === 'GET') {
    try {
      const q = url.search && url.search.length > 1 ? url.search.slice(1) : 'page_size=200';
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-assessments/?${q}`, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, results: data.results || data }));
    } catch (error) {
      console.error('[GRC] Risk assessments list error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (grcProxyTailMatch(routePath, '/api/grc/risk-assessments') && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const grcRes = await grcFetch(`${GRC_API_URL}/api/risk-assessments/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status >= 400 ? grcRes.status : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Create risk assessment error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const grcRaOneMatch = routePath.match(/\/api\/grc\/risk-assessments\/([^/]+)$/);
  if (grcRaOneMatch && (req.method === 'GET' || req.method === 'PATCH' || req.method === 'DELETE')) {
    try {
      const raId = grcRaOneMatch[1];
      const grcRes = await grcFetch(
        `${GRC_API_URL}/api/risk-assessments/${encodeURIComponent(raId)}/`,
        req.method === 'GET'
          ? { method: 'GET' }
          : {
              method: req.method,
              headers: { 'Content-Type': 'application/json' },
              body: req.method === 'PATCH' ? JSON.stringify(await parseBody(req)) : undefined,
            },
        reqToken
      );
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      if (req.method === 'DELETE') {
        if (grcRes.status === 204 || grcRes.status === 200) {
          res.writeHead(grcRes.status === 204 ? 204 : grcRes.status);
          res.end();
          return;
        }
        const txt = await grcRes.text();
        res.writeHead(grcRes.status, { 'Content-Type': 'application/json' });
        res.end(txt || '{}');
        return;
      }
      const data = await grcRes.json();
      res.writeHead(grcRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Risk assessment single error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const grcRaDupMatch = routePath.match(/\/api\/grc\/risk-assessments\/([^/]+)\/duplicate$/);
  if (grcRaDupMatch && req.method === 'POST') {
    try {
      const raId = grcRaDupMatch[1];
      const body = await parseBody(req);
      const grcRes = await grcFetch(
        `${GRC_API_URL}/api/risk-assessments/${encodeURIComponent(raId)}/duplicate/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        reqToken
      );
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status >= 400 ? grcRes.status : 201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Risk assessment duplicate error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const grcRaSyncMatch = routePath.match(/\/api\/grc\/risk-assessments\/([^/]+)\/sync_from_ebios_rm$/);
  if (grcRaSyncMatch && req.method === 'POST') {
    try {
      const raId = grcRaSyncMatch[1];
      let bodyStr = '{}';
      try {
        const body = await parseBody(req);
        bodyStr = JSON.stringify(body && typeof body === 'object' ? body : {});
      } catch (_) {
        bodyStr = '{}';
      }
      const grcRes = await grcFetch(
        `${GRC_API_URL}/api/risk-assessments/${encodeURIComponent(raId)}/sync_from_ebios_rm/`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyStr },
        reqToken
      );
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(grcRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: grcRes.ok, result: data }));
    } catch (error) {
      console.error('[GRC] Risk assessment sync EBIOS RM error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const grcRaActionPlanMatch = routePath.match(/\/api\/grc\/risk-assessments\/([^/]+)\/action-plan$/);
  if (grcRaActionPlanMatch && req.method === 'GET') {
    try {
      const raId = grcRaActionPlanMatch[1];
      const q = url.search && url.search.length > 1 ? url.search.slice(1) : '';
      const grcUrl = `${GRC_API_URL}/api/risk-assessments/${encodeURIComponent(raId)}/action-plan/${q ? `?${q}` : ''}`;
      const grcRes = await grcFetch(grcUrl, {}, reqToken);
      if (await finalizeGrcUpstreamError(res, reqToken, grcRes)) return;
      const data = await grcRes.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: data }));
    } catch (error) {
      console.error('[GRC] Risk assessment action-plan error:', error.message);
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

  // ---- Pipeline Config API ----

  const F4_SEV_KEYS = ['critical', 'high', 'medium', 'low', 'none'];

  // GET /api/pipeline-config/impact-criteria — Return stored severity definitions
  if (url.pathname === '/api/pipeline-config/impact-criteria' && req.method === 'GET') {
    try {
      const out = {};
      for (const k of F4_SEV_KEYS) {
        const row = db.prepare('SELECT value FROM pipeline_config WHERE key = ?').get(`f4_sev_${k}`);
        out[k] = row ? row.value : '';
      }
      sendJSON(res, 200, { success: true, data: out });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/pipeline-config/impact-criteria — Save severity definitions
  if (url.pathname === '/api/pipeline-config/impact-criteria' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const upsert = db.prepare(`INSERT INTO pipeline_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      const saveAll = db.transaction((defs) => {
        for (const k of F4_SEV_KEYS) {
          upsert.run(`f4_sev_${k}`, typeof defs[k] === 'string' ? defs[k].trim() : '');
        }
      });
      saveAll(body);
      sendJSON(res, 200, { success: true });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
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

  // ---- Unmatched API (avoid ambiguous static ENOENT → "File not found") ----
  if (pathnameNorm.startsWith('/api/')) {
    sendJSON(res, 404, {
      error: 'API route not found',
      method: req.method,
      path: pathnameNorm,
      hint:
        pathnameNorm.includes('policy') && pathnameNorm.includes('import')
          ? `Expected POST ${pathnameNorm.replace(/\/+/g, '/').replace(/\/$/, '')} — restart the server after updating (Data Studio policy import ships with this app).`
          : pathnameNorm.includes('grc') && pathnameNorm.includes('perimeters')
            ? 'If requests go through a sub-path gateway, redeploy server.js with updated /api/grc/* routing; list routes match path suffix /api/grc/perimeters.'
            : undefined,
    });
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
║   Endpoints:                                              ║
║   • GET  /                        - Serve the app         ║
║   • POST /api/analyze             - Analyze requirements  ║
║   • POST /api/ai-tools/policy-update-pipeline - F1–F4     ║
║   • GET/POST/PATCH/DELETE /api/legislative-updates/internal-sources ║
║   • GET/POST/PATCH/DELETE /api/legislative-updates/extracted        ║
║   • GET  /api/legislative-updates/extracted/facets                  ║
║   • GET  /api/ai-tools/pipeline-legislative-updates       (list)    ║
║   • GET  /api/ai-tools/pipeline-legislative-updates/:id   (detail)  ║
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
