/**
 * Policy Updates Pipeline (JavaScript port of WathbahGRC-AIEngine PolicyUpdatesPipeline / wathbah_grc.py).
 * F1 relevance → F2 summarize → F3 embedding RAG match → F4 impact analysis.
 * Uses Gemini REST API only (no ChromaDB — in-memory vectors per request).
 *
 * Server logs: lines prefixed `[PolicyUpdatePipeline]` with structured objects (timestamp + event + fields).
 * Disable with env `POLICY_PIPELINE_LOGS=0` (also `false` / `no`).
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULTS = {
  reasoningModel: 'gemini-2.5-pro',
  fastModel: 'gemini-2.5-flash',
  embeddingModel: 'gemini-embedding-001',
  /**
   * F1 needs room for bilingual JSON — outputs that hit MAX_TOKENS truncate
   * mid-string and break strict JSON.parse. Bumped from 16384 to 20480 to give
   * the document_* card-metadata fields some headroom on top of the relevance
   * verdict. salvageF1PartialJson still recovers the boolean + confidence on
   * truncation, in which case the card fields fall back to derived values.
   */
  f1MaxOutputTokens: 20480,
  f1ExcerptLimit: 10000,
  f2ChunkSize: 24000,
  f2ChunkOverlap: 1000,
  /**
   * F2 with 2.5 Pro consumes most of `maxOutputTokens` on the thinking budget,
   * so the visible JSON gets squeezed out when this is too small. Long policies
   * (10K+ chars → ~20–30 policy points) need plenty of headroom — keep large.
   */
  f2MaxOutputTokens: 32768,
  /** Trim F2's thinking budget so more of `maxOutputTokens` is available for the actual JSON output. */
  f2ThinkingBudget: 2048,
  f4MaxOutputTokens: 4096,
  f3SimilarityThreshold: 0.4,
  excerptLen: 500,
  /**
   * Gemini 2.5 thinking models reject thinkingBudget 0 and may require a positive budget.
   * Set to null in overrides to omit thinkingConfig (e.g. non-thinking models).
   */
  geminiThinkingBudget: 8192,
  /**
   * Hard ceiling on any single Gemini HTTP call. Without this, a single stalled
   * request (network blip, unusually slow generation) hangs the `await` forever —
   * on a large document's F4 stage (hundreds/thousands of sequential calls) this
   * looks exactly like a "stuck pipeline" with no error and no way to recover
   * short of killing and re-running the whole thing from scratch.
   */
  geminiRequestTimeoutMs: 45000,
  /**
   * F2 chunks go to `gemini-2.5-pro` with a large `maxOutputTokens` (see
   * `f2MaxOutputTokens`) — dense/large chunks can legitimately take longer than
   * the generic 45s `geminiRequestTimeoutMs` to finish generating. Bigger
   * documents mean more chunks, so more independent chances to exceed a short
   * timeout; give F2 its own, longer ceiling instead of sharing F1/F4's.
   */
  f2RequestTimeoutMs: 120000,
  /**
   * F4 makes one Gemini call per (regulation point × matched policy) pair — for a
   * large document this can be 1000+ calls. Running them fully sequentially is
   * what makes large-document runs take tens of minutes; a small concurrency
   * window cuts wall-clock time roughly proportionally without changing the
   * total call count or overwhelming the API.
   */
  f4Concurrency: 4,
};

/** Aborts `fetch` after `timeoutMs` so one stalled Gemini call can't hang a whole pipeline run forever. */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Splits `items` into chunks of `size` — used to run async work in bounded-concurrency batches. */
function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function policyPipelineLogsEnabled() {
  const v = process.env.POLICY_PIPELINE_LOGS;
  return !(v === '0' || v === 'false' || v === 'no');
}

/** Structured server logs — disable with POLICY_PIPELINE_LOGS=0. */
function policyPipelineLog(fields) {
  if (!policyPipelineLogsEnabled()) return;
  console.log('[PolicyUpdatePipeline]', { ts: new Date().toISOString(), ...fields });
}

const F1_SYSTEM = `You are a GRC compliance-relevance analyst. You work fluently in both Arabic (العربية) and English.
The input may be in Arabic, English, or a mix of both — handle all seamlessly.
Always respond in the SAME language as the document text. If mixed, prefer the dominant language.

You will receive:
- ORGANISATION CONTEXT: industry, jurisdiction, activities, compliance scope.
- DOCUMENT EXCERPT: the beginning of a GRC-related document. It MAY be an external regulation, a regulatory circular, a standard, a framework, an internal policy, a procedure, or a guideline — judge each on its content, not its type.

Tasks:
1. Determine whether the TOPICS / SUBJECT MATTER of this document are relevant to the organisation's compliance scope, sector, activities, regulatory mandates, or governance.
2. Extract a small set of "card-style" metadata fields about the document itself — purely from what is visible in the excerpt. Use null / empty array when a field is not stated or you are not confident. NEVER fabricate publishers, dates, or titles.

Decision rules:
- "is_relevant" should be true whenever the document's subject matter clearly overlaps the org's industry / mandates / activities (e.g. a vendor management policy is relevant to a bank with SAMA outsourcing obligations even if the document is the bank's own internal policy).
- "is_relevant" should be false ONLY when the document is unambiguously outside the org's domain (e.g. a medical device labelling regulation for a pure software fintech, or a marketing brochure with no compliance content).
- Do NOT reject on the basis of "this is an internal policy, not an external regulation" — internal policies still flow through the pipeline so we can map them to existing controls.

Card-metadata rules:
- "document_title": the official title as it appears at the top of the document (≤140 chars). If the top has only a generic header (e.g. "الفصل الأول"), prefer the regulation/standard name as written in the body.
- "document_summary": ≤2 short sentences (≤280 chars total) describing what the document is and the key change it introduces, in the source language. This is a document-level summary, NOT the relevance reasoning.
- "document_source": the publisher / gazette / authority as named in the document (e.g. "أم القرى", "وزارة التجارة", "SAMA"). null if not explicitly stated.
- "document_published_at": ISO date "YYYY-MM-DD" if a publication / issuance date is explicit in the excerpt (Hijri OK to Gregorian-convert when unambiguous). null otherwise.
- "document_tags": up to 5 short topical tags in the source language (each ≤24 chars). Empty array if you are unsure.

Respond with ONLY a JSON object (keep "reasoning" brief — ≤400 characters — so JSON is not truncated):
{
  "is_relevant": true | false,
  "confidence": 0.0-1.0,
  "reasoning": "≤2 short sentences in the document's language",
  "relevant_aspects": ["specific topics / mandates / activities that match, empty array if none"],
  "document_title": "string ≤140 chars, source language",
  "document_summary": "string ≤280 chars, source language, document-level (not relevance)",
  "document_source": "string or null",
  "document_published_at": "YYYY-MM-DD or null",
  "document_tags": ["≤5 short topical tags, source language, ≤24 chars each"]
}`;

const F2_SYSTEM = `You are a GRC policy analyst. You work fluently in both Arabic (العربية) and English.
The regulation text may be in Arabic, English, or a mix — handle all seamlessly.
Extract policy points in the SAME language as the source regulation.

You will receive a regulation document (or section thereof).

Task: Extract ALL distinct regulatory requirements and distil each into a
concise, self-contained policy-like point.

Rules:
- Each point must be a single clear obligation or requirement.
- Use imperative language ("The organisation shall…" / "يجب على المنظمة…").
- Include the original section/article reference when available.
- Do NOT add requirements that are not in the source text.
- Preserve the original language of the regulation in each point.

Respond with ONLY a JSON object:
{
  "policy_points": [
    {
      "id": "PP-001",
      "point": "The organisation shall … / يجب على المنظمة …",
      "source_reference": "Article 5(1)(a) / المادة ٥(١)(أ)" or null,
      "category": "Data Protection | Access Control | Reporting | Governance | حماية البيانات | التحكم بالوصول | …"
    }
  ]
}`;

const F4_SYSTEM = `You are a GRC policy impact analyst. You work fluently in both Arabic (العربية) and English.
The inputs may be in Arabic, English, or a mix — handle all seamlessly.
Respond in the same language as the regulation point.

You will receive:
- NEW REGULATION POINT: a single requirement from a new regulation.
- EXISTING POLICY: the current text of an existing organisational policy.

Task: Analyse how the new regulation point affects the existing policy.

Respond with ONLY a JSON object:
{
  "impact_summary": "1-2 sentence summary of how the policy is affected",
  "severity": "critical | high | medium | low | none",
  "severity_reasoning": "Why this severity level",
  "requires_amendment": true | false,
  "amendments": [
    {
      "policy_section": "Section name or number being affected",
      "current_text_summary": "Brief summary of what the section currently says",
      "required_change": "What specifically needs to change",
      "change_type": "add | modify | remove | strengthen"
    }
  ],
  "compliance_gap": "Description of the gap if the policy is not amended"
}`;

/** F4 severity labels (must match JSON "severity" enum). */
const F4_SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low', 'none'];

/**
 * @param {unknown} raw - e.g. from API body { critical?: string, high?: string, ... }
 * @returns {Record<string, string>} only non-empty trimmed strings for keys the client supplied
 */
function normalizeF4SeverityDefinitions(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of F4_SEVERITY_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const v = raw[key];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) out[key] = s;
  }
  return out;
}

/**
 * @param {Record<string, string>} defs - normalized map (subset of severity levels)
 * @returns {string} F4 system instruction; identical to F4_SYSTEM when defs is empty
 */
function buildF4SystemInstruction(defs) {
  const safe = defs && typeof defs === 'object' ? defs : {};
  const order = F4_SEVERITY_LEVELS.filter((k) => safe[k]);
  if (!order.length) return F4_SYSTEM;
  const lines = order.map((k) => `- ${k}: ${safe[k]}`);
  return `${F4_SYSTEM}

Organisation-defined severity scale — use these meanings when choosing the "severity" field and align "severity_reasoning" with this scale:
${lines.join('\n')}`;
}

function parseJsonFromLlm(raw) {
  if (raw == null) return { raw_response: String(raw) };
  let text = String(raw).trim();
  if (!text) return { raw_response: '' };
  if (text.startsWith('```')) {
    text = text.split('\n', 1)[1] || text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, -3);
    text = text.trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw_response: String(raw).slice(0, 2000) };
  }
}

function normalizeQuotesForF1Salvage(s) {
  return String(s || '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function decodeReasoningEscapedFragment(fragment) {
  return String(fragment || '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Extract reasoning value: closed quoted string if present; else truncated string to end of buffer (MAX_TOKENS mid-Arabic, etc.). */
function extractSalvagedReasoning(s) {
  const closedMatch = s.match(/["']reasoning["']\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (closedMatch) return decodeReasoningEscapedFragment(closedMatch[1]).trim() || undefined;
  const openRe = /["']reasoning["']\s*:\s*"/;
  const mo = openRe.exec(s);
  if (mo === null) return undefined;
  const start = mo.index + mo[0].length;
  let i = start;
  let buf = '';
  while (i < s.length) {
    const c = s[i++];
    if (c === '\\' && i < s.length) {
      buf += c + s[i++];
      continue;
    }
    if (c === '"') return decodeReasoningEscapedFragment(buf).trim() || undefined;
    buf += c;
  }
  const partial = decodeReasoningEscapedFragment(buf).trim();
  return partial || undefined;
}

/**
 * When output hits max tokens, JSON can truncate after "is_relevant": true —
 * salvage boolean + optional confidence / reasoning substring.
 */
function salvageF1PartialJson(text) {
  const s = normalizeQuotesForF1Salvage(text);
  /** Avoid \\b after boolean — RTL marks / commas can interfere with ASCII \\b semantics. */
  const relM =
    s.match(/["']is_relevant["']\s*:\s*(true|false)(?=\s*[,}\]\r\n]|$)/i)
    || s.match(/\bis_relevant\s*:\s*(true|false)(?=\s*[,}\]\r\n]|$)/i);
  if (!relM) return null;
  const is_relevant = relM[1].toLowerCase() === 'true';
  let confidence;
  const cM = s.match(/["']confidence["']\s*:\s*([\d.]+)/);
  if (cM) {
    const n = parseFloat(cM[1], 10);
    if (!Number.isNaN(n)) confidence = Math.min(1, Math.max(0, n));
  }
  let reasoning = extractSalvagedReasoning(s);
  const aspects = [];
  const aspectsMatch = s.match(/["']relevant_aspects["']\s*:\s*\[([\s\S]*?)\]/);
  if (aspectsMatch) {
    const inner = aspectsMatch[1].trim();
    try {
      const arr = JSON.parse(`[${inner}]`);
      if (Array.isArray(arr)) aspects.push(...arr.filter((x) => typeof x === 'string'));
    } catch (_) {
      const chunk = aspectsMatch[1];
      const quoted = chunk.match(/"((?:[^"\\]|\\.)*)"/g);
      if (quoted) {
        for (const q of quoted) {
          try {
            aspects.push(JSON.parse(q));
          } catch (_) { /* ignore */ }
        }
      }
    }
  }
  return {
    is_relevant,
    confidence: typeof confidence === 'number' ? confidence : 0.75,
    reasoning:
      reasoning && reasoning.trim()
        ? reasoning.trim()
        : '[Recovered from truncated JSON — reasoning field was incomplete; shorten inputs if you need verbatim model text.]',
    relevant_aspects: aspects,
    _recovered_truncated_json: true,
  };
}

function stripLlmJsonFence(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  if (s.startsWith('```')) {
    const cut = s.indexOf('\n');
    s = (cut >= 0 ? s.slice(cut + 1) : s.slice(3)).replace(/\n?```\s*$/,'').trim();
  }
  return s;
}

function coerceTruthyBoolean(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(s)) return true;
  if (['false', 'no', '0'].includes(s)) return false;
  return undefined;
}

function normalizeParsedF1Object(o) {
  if (!o || typeof o !== 'object') return o;
  const b = coerceTruthyBoolean(o.is_relevant);
  if (typeof b === 'boolean') return { ...o, is_relevant: b };
  return o;
}

function parseF1Response(raw) {
  if (raw == null || String(raw).trim() === '') return { raw_response: String(raw) };
  const bare = stripLlmJsonFence(raw);
  try {
    const o = normalizeParsedF1Object(JSON.parse(bare));
    if (o && typeof o.is_relevant === 'boolean') return o;
    const salvaged = salvageF1PartialJson(bare);
    if (salvaged) return salvaged;
    return { raw_response: bare.slice(0, 4000) };
  } catch (_) {
    const salvaged = salvageF1PartialJson(bare);
    if (salvaged) return salvaged;
    return { raw_response: bare.slice(0, 4000) };
  }
}

/**
 * Gemini REST often omits candidates on block, or omits parts on safety stop.
 * 2.5+ may label some parts as thought-only; if the visible text is empty, fall back to any text part.
 */
function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  let nonThought = '';
  let any = '';
  for (const p of parts) {
    if (!p || typeof p !== 'object' || typeof p.text !== 'string') continue;
    any += p.text;
    if (p.thought !== true) nonThought += p.text;
  }
  nonThought = String(nonThought || '').trim();
  if (nonThought) return nonThought;
  return String(any || '').trim();
}

/**
 * Gemini sometimes omits usable `parts[].text` (JSON MIME quirks, tooling fields, etc.).
 * Collect text from documented / observed alternate locations before declaring output empty.
 */
function extractGeminiAssistantText(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  const content = candidate.content && typeof candidate.content === 'object' ? candidate.content : null;
  /** Structured JSON object (REST occasionally surfaces separately from `.text`). */
  if (content?.parsed != null && typeof content.parsed === 'object') {
    try {
      const j = JSON.stringify(content.parsed);
      if (j && j.trim() !== '{}') return j;
    } catch (_) {
      /* ignore */
    }
  }
  for (const k of ['text', 'outputText', 'output_text']) {
    const v = content?.[k] ?? candidate?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const partsTxt = extractTextFromParts(content?.parts);
  if (partsTxt) return partsTxt;
  /** Bounded deep scan under `content` for the longest `.text` string (SDK / proto variance). */
  let best = '';
  const seen = new Set();
  function walk(node, depth) {
    if (depth > 12 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (typeof node.text === 'string' && node.text.length > best.length) best = node.text;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
    } else {
      for (const x of Object.values(node)) walk(x, depth + 1);
    }
  }
  walk(content, 0);
  return String(best || '').trim();
}

/** Gemini REST often omits candidates on block, or omits parts on safety stop. */
function extractGeminiTextOrThrow(apiResponseBody, apiRawTextSnippet) {
  const d = apiResponseBody;
  const pf = d.promptFeedback || d.prompt_feedback;
  const br = pf?.blockReason || pf?.block_reason;
  if (br) {
    throw new Error(
      `Gemini blocked the prompt (blockReason=${br}). Reduce sensitive content length or adjust the Org/Regulation text; if it persists try another Gemini model.`,
    );
  }
  const cands = d.candidates;
  if (!Array.isArray(cands) || !cands.length) {
    const tail = pf ? ` promptFeedback=${JSON.stringify(pf).slice(0, 600)}` : '';
    throw new Error(`Gemini returned no candidates.${tail} api=${apiRawTextSnippet.slice(0, 400)}`);
  }
  const c0 = cands[0];
  const fr = String(c0.finishReason || c0.finish_reason || '').toUpperCase();
  const rootText = typeof d.text === 'string' ? d.text.trim() : '';
  const textOut = extractGeminiAssistantText(c0) || rootText;
  if (!textOut) {
    const sr = c0.safetyRatings || c0.safety_ratings;
    const srStr = sr ? ` safetyRatings=${JSON.stringify(sr).slice(0, 900)}` : '';
    const peek = apiRawTextSnippet.length > 2000 ? apiRawTextSnippet.slice(0, 2000) + '…' : apiRawTextSnippet;
    throw new Error(
      `Gemini returned empty assistant text (finishReason=${fr || 'n/a'}).${srStr} ` +
        'Often: JSON MIME quirks, unsupported thinkingConfig/thinkingBudget for this endpoint, quotas, or a model/SDK response shape mismatch. Retry with overrides.reasoningModel=gemini-2.5-flash. ' +
        `Response_snippet=${JSON.stringify(peek).slice(0, 2200)}`,
    );
  }
  return textOut;
}

function chunkText(text, size, overlap) {
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d < 1e-12 ? 0 : dot / d;
}

/**
 * @param {{ includeJsonMimeType?: boolean, thinkingBudget?: number | null }} [genExtras]
 *   - thinkingBudget null/undefined: omit thinkingConfig (works for non-thinking models).
 *   - thinkingBudget positive number: Gemini 2.5 thinking mode (required for thinking-only models).
 *   Do not use 0 — the API returns 400 "Budget 0 is invalid" on thinking-only models.
 */
async function geminiGenerateContent(apiKey, modelId, userText, systemInstruction, maxTokens, temperature, genExtras = {}) {
  const includeJsonMime = genExtras.includeJsonMimeType !== false;
  let thinkingBudget = genExtras.thinkingBudget;
  if (thinkingBudget === undefined) thinkingBudget = null;

  const url = `${GEMINI_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const buildGc = () => {
    const gc = { temperature, maxOutputTokens: maxTokens };
    if (includeJsonMime) gc.responseMimeType = 'application/json';
    if (thinkingBudget !== null && typeof thinkingBudget === 'number')
      gc.thinkingConfig = { thinkingBudget };
    return gc;
  };

  const buildBody = (withSystem) => ({
    ...(withSystem ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: withSystem ? userText : `${systemInstruction}\n\n---\n\n${userText}` }] }],
    generationConfig: buildGc(),
  });

  const timeoutMs = genExtras.geminiRequestTimeoutMs ?? DEFAULTS.geminiRequestTimeoutMs;

  async function post(withSystem) {
    const body = JSON.stringify(buildBody(withSystem));
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, timeoutMs);
    const txt = await res.text();
    return { res, txt };
  }

  /** Try embedded systemInstruction first (cleaner prompts); then inline system in user msg (older API quirks). */
  let { res, txt } = await post(true);
  if (!res.ok) {
    if (genExtras.pipelineStage === 'f1') {
      policyPipelineLog({
        event: 'gemini_fallback_inline_system',
        runId: genExtras._pupRunId ?? null,
        pipelineStage: 'f1',
        modelId,
        firstHttpStatus: res.status,
        firstBodyChars: txt.length,
      });
    }
    ({ res, txt } = await post(false));
  }
  if (!res.ok) {
    if (genExtras.pipelineStage === 'f1') {
      policyPipelineLog({
        event: 'gemini_generate_failed',
        runId: genExtras._pupRunId ?? null,
        modelId,
        httpStatus: res.status,
        bodyChars: txt.length,
        includeJsonMime,
        thinkingBudget,
      });
    }
    throw new Error(`Gemini generateContent ${res.status}: ${txt.slice(0, 600)}`);
  }
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${txt.slice(0, 200)}`);
  }
  return extractGeminiTextOrThrow(data, txt);
}

async function geminiJson(apiKey, modelId, systemPrompt, userText, maxTokens, temperature, genExtras = {}) {
  const raw = await geminiGenerateContent(apiKey, modelId, userText, systemPrompt, maxTokens, temperature, genExtras);
  return parseJsonFromLlm(raw);
}

async function embedOne(apiKey, modelId, text, timeoutMs) {
  const url = `${GEMINI_BASE}/models/${modelId}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    content: { parts: [{ text: String(text).slice(0, 20000) }] },
    taskType: 'SEMANTIC_SIMILARITY',
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs ?? DEFAULTS.geminiRequestTimeoutMs);
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini embedContent ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = JSON.parse(txt);
  const values = data.embedding?.values;
  if (!values || !Array.isArray(values)) {
    throw new Error('embedContent: missing embedding.values');
  }
  return values;
}

/**
 * @param {string} apiKey
 * @param {string} modelId
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedTextsSequential(apiKey, modelId, texts) {
  const out = [];
  for (const t of texts) {
    out.push(await embedOne(apiKey, modelId, t));
  }
  return out;
}

/**
 * Match each policy point against embedded policy documents (cosine ≥ threshold).
 * @returns {Array<{ point_id, point_text, matches: Array<{ policy_id, policy_title, content_excerpt, similarity_score }> }>}
 */
function matchPolicyPointsToStore(policyPoints, policyRows, threshold, excerptLen) {
  /** policyRows: { id, title, docText, embedding }[] */
  const results = [];
  for (const pt of policyPoints) {
    const q = pt.embedding;
    if (!q) {
      results.push({ point_id: pt.id, point_text: pt.point, matches: [] });
      continue;
    }
    const matches = [];
    for (const row of policyRows) {
      const sim = cosineSimilarity(q, row.embedding);
      if (sim >= threshold) {
        matches.push({
          policy_id: row.id,
          policy_title: row.title,
          content_excerpt: row.docText.slice(0, excerptLen),
          similarity_score: Math.round(sim * 10000) / 10000,
        });
      }
    }
    matches.sort((a, b) => b.similarity_score - a.similarity_score);
    results.push({
      point_id: pt.id,
      point_text: pt.point,
      matches,
    });
  }
  return results;
}

async function f1Relevance(apiKey, cfg, orgContext, regulationText) {
  const excerpt = regulationText.slice(0, cfg.f1ExcerptLimit);
  const user = `=== ORGANISATION CONTEXT ===\n${orgContext}\n\n=== DOCUMENT EXCERPT ===\n${excerpt}`;
  /** JSON MIME + thinking models: try positive thinking budget first, then omit (for non-thinking models). */
  const tb = cfg.geminiThinkingBudget;
  const thinkingVariants =
    tb != null && typeof tb === 'number' ? [tb, null] : [null];
  const attempts = [];
  for (const thinkingBudget of thinkingVariants) {
    for (const includeJsonMimeType of [true, false]) {
      attempts.push({ includeJsonMimeType, thinkingBudget });
    }
  }

  const runId = cfg._pupRunId ?? null;
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const genExtras = {
      ...attempts[i],
      pipelineStage: 'f1',
      _pupRunId: runId,
      geminiRequestTimeoutMs: cfg.geminiRequestTimeoutMs,
    };
    policyPipelineLog({
      event: 'f1_attempt_start',
      runId,
      attemptIndex: i,
      modelId: cfg.reasoningModel,
      f1MaxOutputTokens: cfg.f1MaxOutputTokens ?? DEFAULTS.f1MaxOutputTokens,
      generation: {
        jsonMime: genExtras.includeJsonMimeType !== false,
        thinkingBudget: genExtras.thinkingBudget,
      },
    });
    try {
      const raw = await geminiGenerateContent(
        apiKey,
        cfg.reasoningModel,
        user,
        F1_SYSTEM,
        cfg.f1MaxOutputTokens ?? DEFAULTS.f1MaxOutputTokens,
        0.1,
        genExtras,
      );
      policyPipelineLog({
        event: 'f1_attempt_raw_bytes',
        runId,
        attemptIndex: i,
        extractedChars: typeof raw === 'string' ? raw.length : 0,
        extractedStartsJson: typeof raw === 'string' && /^\s*[\[{]/.test(raw),
      });
      const parsed = parseF1Response(raw);
      if (isValidF1Envelope(parsed)) {
        policyPipelineLog({
          event: 'f1_ok',
          runId,
          attemptIndex: i,
          is_relevant: parsed.is_relevant,
          confidence: parsed.confidence,
          recoveredTruncated: !!parsed._recovered_truncated_json,
        });
        return parsed;
      }
      /** Model returned text we could not coerce to F1 — retry with different MIME / thinking before giving up. */
      policyPipelineLog({
        event: 'f1_attempt_parse_invalid',
        runId,
        attemptIndex: i,
        parsedKeys:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.keys(parsed).slice(0, 24)
            : [],
        rawResponseChars: parsed?.raw_response != null ? String(parsed.raw_response).length : null,
      });
      const preview = typeof raw === 'string' ? raw.slice(0, 500) : '';
      lastErr = new Error(`F1 parse did not yield a boolean is_relevant (truncated response or wrong shape). Preview: ${preview}`);
    } catch (e) {
      lastErr = e;
      policyPipelineLog({
        event: 'f1_attempt_error',
        runId,
        attemptIndex: i,
        message: String(e?.message || e).slice(0, 450),
      });
      const msg = String(e?.message || e);
      if (msg.includes('generateContent 400')) continue;
      if (msg.includes('empty assistant text')) continue;
      if (msg.includes('blocked the prompt')) throw e;
      if (msg.includes('no candidates')) throw e;
    }
  }
  policyPipelineLog({ event: 'f1_failed_all_attempts', runId, lastError: String(lastErr?.message || lastErr || '').slice(0, 500) });
  if (lastErr) throw lastErr;
  throw new Error(
    'F1 failed: no Gemini attempt produced usable model text. Verify GEMINI_API_KEY, model id, and server logs.',
  );
}

function isValidF1Envelope(f1) {
  return f1 != null && typeof f1 === 'object' && typeof f1.is_relevant === 'boolean';
}

function cloneF2WithoutEmbeddings(f2) {
  if (!f2 || !Array.isArray(f2.policy_points)) return f2;
  return {
    ...f2,
    policy_points: f2.policy_points.map((p) => {
      const { embedding, ...rest } = p;
      return rest;
    }),
  };
}

/** Single F2 chunk call, factored out so f2Summarize can retry it with a fresh timeout. */
async function f2SummarizeChunk(apiKey, cfg, chunkStr, chunkIndex, totalChunks, f2MaxTokens, f2ThinkingBudget, timeoutMs) {
  const user = `=== REGULATION TEXT (part ${chunkIndex + 1}/${totalChunks}) ===\n${chunkStr}`;
  const f2Extras = { geminiRequestTimeoutMs: timeoutMs };
  if (f2ThinkingBudget != null && typeof f2ThinkingBudget === 'number') {
    f2Extras.thinkingBudget = f2ThinkingBudget;
  }
  return geminiJson(apiKey, cfg.reasoningModel, F2_SYSTEM, user, f2MaxTokens, 0.15, f2Extras);
}

/**
 * Extract policy points chunk-by-chunk. Each chunk is resilient to a single slow/failed
 * Gemini call: on timeout it's retried once with double the timeout (a stalled/slow
 * generation may just need more room); if it still fails, that chunk is skipped — logged
 * and excluded — instead of throwing away every point already extracted from the rest of
 * a large document. Mirrors the per-call resilience `f4Impact` already has for F4.
 */
async function f2Summarize(apiKey, cfg, regulationText) {
  const chunks = chunkText(regulationText, cfg.f2ChunkSize, cfg.f2ChunkOverlap);
  const f2MaxTokens     = cfg.f2MaxOutputTokens ?? DEFAULTS.f2MaxOutputTokens;
  const f2ThinkingBudget = cfg.f2ThinkingBudget ?? DEFAULTS.f2ThinkingBudget;
  const f2TimeoutMs = cfg.f2RequestTimeoutMs ?? DEFAULTS.f2RequestTimeoutMs;
  policyPipelineLog({
    event: 'f2_start',
    runId: cfg._pupRunId ?? null,
    chunks: chunks.length,
    regulationChars: regulationText.length,
    modelId: cfg.reasoningModel,
    maxOutputTokens: f2MaxTokens,
    thinkingBudget: f2ThinkingBudget,
    requestTimeoutMs: f2TimeoutMs,
  });
  const allPoints = [];
  let chunksFailed = 0;
  for (let i = 0; i < chunks.length; i++) {
    let result;
    let retried = false;
    try {
      result = await f2SummarizeChunk(apiKey, cfg, chunks[i], i, chunks.length, f2MaxTokens, f2ThinkingBudget, f2TimeoutMs);
    } catch (e) {
      const isTimeout = String(e?.message || e).includes('timed out');
      policyPipelineLog({
        event: 'f2_chunk_error',
        runId: cfg._pupRunId ?? null,
        chunkIndex: i + 1,
        chunkOf: chunks.length,
        error: String(e?.message || e).slice(0, 400),
        willRetry: isTimeout,
      });
      if (isTimeout) {
        retried = true;
        try {
          result = await f2SummarizeChunk(apiKey, cfg, chunks[i], i, chunks.length, f2MaxTokens, f2ThinkingBudget, f2TimeoutMs * 2);
        } catch (e2) {
          policyPipelineLog({
            event: 'f2_chunk_failed',
            runId: cfg._pupRunId ?? null,
            chunkIndex: i + 1,
            chunkOf: chunks.length,
            error: String(e2?.message || e2).slice(0, 400),
          });
          chunksFailed++;
          result = { policy_points: [] };
        }
      } else {
        chunksFailed++;
        result = { policy_points: [] };
      }
    }
    const pts = result.policy_points;
    const took = Array.isArray(pts) ? pts.length : 0;
    policyPipelineLog({
      event: 'f2_chunk',
      runId: cfg._pupRunId ?? null,
      chunkIndex: i + 1,
      chunkOf: chunks.length,
      policyPointsReturned: took,
      usedRawFallback: typeof result?.raw_response === 'string' && result.raw_response.trim().length > 0,
      retried,
    });
    if (Array.isArray(pts)) allPoints.push(...pts);
  }
  for (let idx = 0; idx < allPoints.length; idx++) {
    allPoints[idx].id = `PP-${String(idx + 1).padStart(3, '0')}`;
  }
  policyPipelineLog({
    event: 'f2_done',
    runId: cfg._pupRunId ?? null,
    totalPolicyPoints: allPoints.length,
    chunksFailed,
  });
  return { policy_points: allPoints, chunks_failed: chunksFailed };
}

/** Placeholder impact used when a single F4 call fails/times out, so one bad pair can't sink the whole run. */
function f4FailedImpact(match, errMessage) {
  return {
    policy_id: match.policy_id,
    policy_title: match.policy_title,
    similarity_score: match.similarity_score,
    impact_summary: 'Impact analysis failed for this pair — retry or review manually.',
    severity: 'none',
    severity_reasoning: null,
    requires_amendment: false,
    amendments: [],
    compliance_gap: null,
    error: String(errMessage || 'unknown error').slice(0, 500),
  };
}

async function f4Impact(apiKey, cfg, ragMatchesWithPoints) {
  const tasks = [];
  for (let itemIndex = 0; itemIndex < ragMatchesWithPoints.length; itemIndex++) {
    const item = ragMatchesWithPoints[itemIndex];
    for (let matchIndex = 0; matchIndex < (item.matches?.length || 0); matchIndex++) {
      tasks.push({ itemIndex, matchIndex, item, match: item.matches[matchIndex] });
    }
  }
  const concurrency = Math.max(1, cfg.f4Concurrency ?? DEFAULTS.f4Concurrency);
  policyPipelineLog({
    event: 'f4_start',
    runId: cfg._pupRunId ?? null,
    ragPointsWithMatches: ragMatchesWithPoints.length,
    totalImpactCalls: tasks.length,
    modelId: cfg.fastModel,
    concurrency,
  });

  const impactsByItem = ragMatchesWithPoints.map((item) => new Array(item.matches?.length || 0));
  const system = cfg.f4SystemInstruction || F4_SYSTEM;
  const maxTokens = cfg.f4MaxOutputTokens ?? DEFAULTS.f4MaxOutputTokens;
  let completed = 0;
  let failed = 0;

  for (const batch of chunkArray(tasks, concurrency)) {
    await Promise.all(
      batch.map(async (task) => {
        const { itemIndex, matchIndex, item, match } = task;
        const user =
          `=== NEW REGULATION POINT ===\n${item.point_text}\n\n` +
          `=== EXISTING POLICY (${match.policy_title}) ===\n${match.content_excerpt}`;
        try {
          const analysis = await geminiJson(apiKey, cfg.fastModel, system, user, maxTokens, 0.15, {
            _pupRunId: cfg._pupRunId,
            geminiRequestTimeoutMs: cfg.geminiRequestTimeoutMs,
          });
          impactsByItem[itemIndex][matchIndex] = {
            policy_id: match.policy_id,
            policy_title: match.policy_title,
            similarity_score: match.similarity_score,
            ...analysis,
          };
        } catch (e) {
          failed++;
          policyPipelineLog({
            event: 'f4_call_failed',
            runId: cfg._pupRunId ?? null,
            pointId: item.point_id,
            policyId: match.policy_id,
            error: e?.message || String(e),
          });
          impactsByItem[itemIndex][matchIndex] = f4FailedImpact(match, e?.message || e);
        }
      }),
    );
    completed += batch.length;
    policyPipelineLog({
      event: 'f4_progress',
      runId: cfg._pupRunId ?? null,
      completed,
      total: tasks.length,
      failed,
    });
  }

  const results = ragMatchesWithPoints.map((item, itemIndex) => ({
    point_id: item.point_id,
    point_text: item.point_text,
    impacts: impactsByItem[itemIndex],
  }));
  policyPipelineLog({
    event: 'f4_done',
    runId: cfg._pupRunId ?? null,
    regulationPointGroups: results.length,
    totalImpactCalls: tasks.length,
    failed,
  });
  return results;
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey - Gemini API key
 * @param {string} opts.orgContext
 * @param {string} opts.regulationText
 * @param {Array<{ id: string, title: string, content: string }>} opts.policies
 * @param {object} [opts.overrides] - optional model names / thresholds
 * @param {object} [opts.f4SeverityDefinitions] - optional per-level impact rubric (critical/high/medium/low/none); empty values ignored
 */
async function runPolicyUpdatePipeline(opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('apiKey is required');

  const f4SevDefs = normalizeF4SeverityDefinitions(opts.f4SeverityDefinitions);

  const cfg = {
    reasoningModel: opts.overrides?.reasoningModel || DEFAULTS.reasoningModel,
    fastModel: opts.overrides?.fastModel || DEFAULTS.fastModel,
    embeddingModel: opts.overrides?.embeddingModel || DEFAULTS.embeddingModel,
    f1MaxOutputTokens: opts.overrides?.f1MaxOutputTokens ?? DEFAULTS.f1MaxOutputTokens,
    f1ExcerptLimit: opts.overrides?.f1ExcerptLimit ?? DEFAULTS.f1ExcerptLimit,
    f2ChunkSize: opts.overrides?.f2ChunkSize ?? DEFAULTS.f2ChunkSize,
    f2ChunkOverlap: opts.overrides?.f2ChunkOverlap ?? DEFAULTS.f2ChunkOverlap,
    f2MaxOutputTokens: opts.overrides?.f2MaxOutputTokens ?? DEFAULTS.f2MaxOutputTokens,
    f2ThinkingBudget:
      opts.overrides && Object.prototype.hasOwnProperty.call(opts.overrides, 'f2ThinkingBudget')
        ? opts.overrides.f2ThinkingBudget
        : DEFAULTS.f2ThinkingBudget,
    f4MaxOutputTokens: opts.overrides?.f4MaxOutputTokens ?? DEFAULTS.f4MaxOutputTokens,
    f4Concurrency: opts.overrides?.f4Concurrency ?? DEFAULTS.f4Concurrency,
    f3SimilarityThreshold: opts.overrides?.f3SimilarityThreshold ?? DEFAULTS.f3SimilarityThreshold,
    excerptLen: opts.overrides?.excerptLen ?? DEFAULTS.excerptLen,
    geminiThinkingBudget:
      opts.overrides && Object.prototype.hasOwnProperty.call(opts.overrides, 'geminiThinkingBudget')
        ? opts.overrides.geminiThinkingBudget
        : DEFAULTS.geminiThinkingBudget,
    geminiRequestTimeoutMs: opts.overrides?.geminiRequestTimeoutMs ?? DEFAULTS.geminiRequestTimeoutMs,
    f2RequestTimeoutMs: opts.overrides?.f2RequestTimeoutMs ?? DEFAULTS.f2RequestTimeoutMs,
    f4SystemInstruction: buildF4SystemInstruction(f4SevDefs),
    skipF1: opts.overrides?.skipF1 === true,
  };

  const runId = `pup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  /** @internal correlate logs for a single HTTP request */
  cfg._pupRunId = runId;

  const orgContext = String(opts.orgContext || '');
  const regulationText = String(opts.regulationText || '');
  const policies = Array.isArray(opts.policies) ? opts.policies : [];

  if (!regulationText.trim()) {
    throw new Error('regulationText is required');
  }

  policyPipelineLog({
    event: 'pipeline_start',
    runId,
    orgContextChars: orgContext.length,
    regulationChars: regulationText.length,
    policiesInputCount: policies.length,
    reasoningModel: cfg.reasoningModel,
    fastModel: cfg.fastModel,
    embeddingModel: cfg.embeddingModel,
    hasOverrides: !!(opts.overrides && typeof opts.overrides === 'object'),
    f4SeverityDefinitionLevels: Object.keys(f4SevDefs).length,
  });

  // Embed all organisation policies once (same as wathbah_grc upload_policies → query)
  const policyRows = [];
  for (const p of policies) {
    const id = String(p.id || '').trim();
    const title = String(p.title || '').trim();
    const content = String(p.content || '').trim();
    if (!id || !content) continue;
    const docText = `${title}\n\n${content}`;
    const embedding = await embedOne(apiKey, cfg.embeddingModel, docText, cfg.geminiRequestTimeoutMs);
    policyRows.push({ id, title: title || id, docText, embedding });
  }

  policyPipelineLog({
    event: 'indexed_policies',
    runId,
    indexedCount: policyRows.length,
    embeddingModel: cfg.embeddingModel,
  });

  // F1 — can be skipped via overrides.skipF1 (e.g. internal-sources background runs)
  let f1;
  if (cfg.skipF1) {
    f1 = { is_relevant: true, confidence: 1, reasoning: 'Relevance check skipped — document assumed relevant by caller.', relevant_aspects: [], _skipped: true };
    policyPipelineLog({ event: 'f1_skipped', runId, reason: 'skipF1_override' });
  } else {
    f1 = await f1Relevance(apiKey, cfg, orgContext, regulationText);
    if (!isValidF1Envelope(f1)) {
      const raw =
        typeof f1?.raw_response === 'string' && f1.raw_response.trim() ? f1.raw_response.trim().slice(0, 900) : null;
      throw new Error(
        `F1 response was missing a boolean is_relevant (model did not return valid JSON). ${raw ? `Model text (truncated): ${raw}` : 'Often caused by Gemini returning no candidates, safety blocks, or empty output under JSON MIME mode — see server logs.'}`,
      );
    }
    if (!f1.is_relevant) {
      policyPipelineLog({
        event: 'pipeline_complete',
        runId,
        stage_reached: 'f1',
        reason: 'not_relevant_to_org',
        policy_count_indexed: policyRows.length,
      });
      return {
        stage_reached: 'f1',
        f1_relevance: f1,
        f2_summary: null,
        f3_matches: null,
        f4_impacts: null,
        policy_count_indexed: policyRows.length,
      };
    }
  }

  // F2
  const f2Raw = await f2Summarize(apiKey, cfg, regulationText);
  const f2 = cloneF2WithoutEmbeddings(f2Raw);
  const points = f2Raw.policy_points || [];
  if (!points.length) {
    policyPipelineLog({
      event: 'pipeline_complete',
      runId,
      stage_reached: 'f2',
      reason: 'no_policy_points_extracted',
      policy_count_indexed: policyRows.length,
      policyPointsExtracted: 0,
    });
    return {
      stage_reached: 'f2',
      f1_relevance: f1,
      f2_summary: f2,
      f3_matches: null,
      f4_impacts: null,
      policy_count_indexed: policyRows.length,
    };
  }

  // Embed each policy point for F3
  for (const pt of points) {
    pt.embedding = await embedOne(apiKey, cfg.embeddingModel, pt.point, cfg.geminiRequestTimeoutMs);
  }

  policyPipelineLog({
    event: 'f3_embed_points_done',
    runId,
    regulationPointsEmbedded: points.length,
    threshold: cfg.f3SimilarityThreshold,
  });

  const f3 = matchPolicyPointsToStore(points, policyRows, cfg.f3SimilarityThreshold, cfg.excerptLen);
  const withMatches = f3.filter(r => r.matches && r.matches.length);

  policyPipelineLog({
    event: 'f3_match_summary',
    runId,
    regulationPoints: f3.length,
    pointsWithMatches: withMatches.length,
    threshold: cfg.f3SimilarityThreshold,
  });

  if (!withMatches.length) {
    policyPipelineLog({
      event: 'pipeline_complete',
      runId,
      stage_reached: 'f3',
      reason: 'no_similarity_matches',
      policy_count_indexed: policyRows.length,
    });
    return {
      stage_reached: 'f3',
      f1_relevance: f1,
      f2_summary: f2,
      f3_matches: f3,
      f4_impacts: null,
      policy_count_indexed: policyRows.length,
    };
  }

  // Build f4 input shapes (point_id, point_text, matches with content_excerpt)
  const f4Input = withMatches.map(r => ({
    point_id: r.point_id,
    point_text: r.point_text,
    matches: r.matches.map(m => ({
      policy_id: m.policy_id,
      policy_title: m.policy_title,
      content_excerpt: m.content_excerpt,
      similarity_score: m.similarity_score,
    })),
  }));

  const f4 = await f4Impact(apiKey, cfg, f4Input);

  policyPipelineLog({
    event: 'pipeline_complete',
    runId,
    stage_reached: 'f4',
    reason: 'success',
    policy_count_indexed: policyRows.length,
    regulationPointsSummary: points.length,
    ragPointsWithMatches: withMatches.length,
  });

  return {
    stage_reached: 'f4',
    f1_relevance: f1,
    f2_summary: f2,
    f3_matches: f3,
    f4_impacts: f4,
    policy_count_indexed: policyRows.length,
  };
}

module.exports = {
  runPolicyUpdatePipeline,
  DEFAULTS,
  parseJsonFromLlm,
  cosineSimilarity,
  normalizeF4SeverityDefinitions,
  buildF4SystemInstruction,
};
