/**
 * Policy Updates Pipeline (JavaScript port of WathbahGRC-AIEngine PolicyUpdatesPipeline / wathbah_grc.py).
 * F1 relevance → F2 summarize → F3 embedding RAG match → F4 impact analysis.
 * Uses Gemini REST API only (no ChromaDB — in-memory vectors per request).
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULTS = {
  reasoningModel: 'gemini-2.5-pro',
  fastModel: 'gemini-2.5-flash',
  embeddingModel: 'gemini-embedding-001',
  f1ExcerptLimit: 10000,
  f2ChunkSize: 24000,
  f2ChunkOverlap: 1000,
  f3SimilarityThreshold: 0.4,
  excerptLen: 500,
};

const F1_SYSTEM = `You are a GRC regulatory-relevance analyst. You work fluently in both Arabic (العربية) and English.
The input may be in Arabic, English, or a mix of both — handle all seamlessly.
Always respond in the SAME language as the regulation text. If mixed, prefer the dominant language.

You will receive:
- ORGANISATION CONTEXT: industry, jurisdiction, activities, compliance scope.
- REGULATION EXCERPT: the beginning of a new regulation document.

Task: determine whether this regulation is relevant to the organisation.

Respond with ONLY a JSON object:
{
  "is_relevant": true | false,
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentence explanation (in the regulation's language)",
  "relevant_aspects": ["list of specific aspects that match, empty if not relevant"]
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

function parseJsonFromLlm(raw) {
  if (raw == null) return { raw_response: String(raw) };
  let text = String(raw).trim();
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

async function geminiGenerateContent(apiKey, modelId, userText, systemInstruction, maxTokens, temperature) {
  const url = `${GEMINI_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const buildBody = (withSystem) => ({
    ...(withSystem ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: withSystem ? userText : `${systemInstruction}\n\n---\n\n${userText}` }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    },
  });
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(true)),
  });
  let txt = await res.text();
  if (!res.ok) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(false)),
    });
    txt = await res.text();
  }
  if (!res.ok) {
    throw new Error(`Gemini generateContent ${res.status}: ${txt.slice(0, 600)}`);
  }
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    throw new Error(`Invalid JSON from Gemini: ${txt.slice(0, 200)}`);
  }
  const parts = data.candidates?.[0]?.content?.parts;
  const textOut = parts?.map(p => p.text).join('') || '';
  return textOut;
}

async function geminiJson(apiKey, modelId, systemPrompt, userText, maxTokens, temperature) {
  const raw = await geminiGenerateContent(apiKey, modelId, userText, systemPrompt, maxTokens, temperature);
  return parseJsonFromLlm(raw);
}

async function embedOne(apiKey, modelId, text) {
  const url = `${GEMINI_BASE}/models/${modelId}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    content: { parts: [{ text: String(text).slice(0, 20000) }] },
    taskType: 'SEMANTIC_SIMILARITY',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  const user = `=== ORGANISATION CONTEXT ===\n${orgContext}\n\n=== REGULATION EXCERPT ===\n${excerpt}`;
  return geminiJson(apiKey, cfg.reasoningModel, F1_SYSTEM, user, 1024, 0.1);
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

async function f2Summarize(apiKey, cfg, regulationText) {
  const chunks = chunkText(regulationText, cfg.f2ChunkSize, cfg.f2ChunkOverlap);
  const allPoints = [];
  for (let i = 0; i < chunks.length; i++) {
    const user = `=== REGULATION TEXT (part ${i + 1}/${chunks.length}) ===\n${chunks[i]}`;
    const result = await geminiJson(apiKey, cfg.reasoningModel, F2_SYSTEM, user, 8192, 0.15);
    const pts = result.policy_points;
    if (Array.isArray(pts)) allPoints.push(...pts);
  }
  for (let idx = 0; idx < allPoints.length; idx++) {
    allPoints[idx].id = `PP-${String(idx + 1).padStart(3, '0')}`;
  }
  return { policy_points: allPoints };
}

async function f4Impact(apiKey, cfg, ragMatchesWithPoints) {
  const results = [];
  for (const item of ragMatchesWithPoints) {
    const impacts = [];
    for (const match of item.matches) {
      const user =
        `=== NEW REGULATION POINT ===\n${item.point_text}\n\n` +
        `=== EXISTING POLICY (${match.policy_title}) ===\n${match.content_excerpt}`;
      const analysis = await geminiJson(apiKey, cfg.fastModel, F4_SYSTEM, user, 2048, 0.15);
      impacts.push({
        policy_id: match.policy_id,
        policy_title: match.policy_title,
        similarity_score: match.similarity_score,
        ...analysis,
      });
    }
    results.push({
      point_id: item.point_id,
      point_text: item.point_text,
      impacts,
    });
  }
  return results;
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey - Gemini API key
 * @param {string} opts.orgContext
 * @param {string} opts.regulationText
 * @param {Array<{ id: string, title: string, content: string }>} opts.policies
 * @param {object} [opts.overrides] - optional model names / thresholds
 */
async function runPolicyUpdatePipeline(opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('apiKey is required');

  const cfg = {
    reasoningModel: opts.overrides?.reasoningModel || DEFAULTS.reasoningModel,
    fastModel: opts.overrides?.fastModel || DEFAULTS.fastModel,
    embeddingModel: opts.overrides?.embeddingModel || DEFAULTS.embeddingModel,
    f1ExcerptLimit: opts.overrides?.f1ExcerptLimit ?? DEFAULTS.f1ExcerptLimit,
    f2ChunkSize: opts.overrides?.f2ChunkSize ?? DEFAULTS.f2ChunkSize,
    f2ChunkOverlap: opts.overrides?.f2ChunkOverlap ?? DEFAULTS.f2ChunkOverlap,
    f3SimilarityThreshold: opts.overrides?.f3SimilarityThreshold ?? DEFAULTS.f3SimilarityThreshold,
    excerptLen: opts.overrides?.excerptLen ?? DEFAULTS.excerptLen,
  };

  const orgContext = String(opts.orgContext || '');
  const regulationText = String(opts.regulationText || '');
  const policies = Array.isArray(opts.policies) ? opts.policies : [];

  if (!regulationText.trim()) {
    throw new Error('regulationText is required');
  }

  // Embed all organisation policies once (same as wathbah_grc upload_policies → query)
  const policyRows = [];
  for (const p of policies) {
    const id = String(p.id || '').trim();
    const title = String(p.title || '').trim();
    const content = String(p.content || '').trim();
    if (!id || !content) continue;
    const docText = `${title}\n\n${content}`;
    const embedding = await embedOne(apiKey, cfg.embeddingModel, docText);
    policyRows.push({ id, title: title || id, docText, embedding });
  }

  // F1
  const f1 = await f1Relevance(apiKey, cfg, orgContext, regulationText);
  if (!f1.is_relevant) {
    return {
      stage_reached: 'f1',
      f1_relevance: f1,
      f2_summary: null,
      f3_matches: null,
      f4_impacts: null,
      policy_count_indexed: policyRows.length,
    };
  }

  // F2
  const f2Raw = await f2Summarize(apiKey, cfg, regulationText);
  const f2 = cloneF2WithoutEmbeddings(f2Raw);
  const points = f2Raw.policy_points || [];
  if (!points.length) {
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
    pt.embedding = await embedOne(apiKey, cfg.embeddingModel, pt.point);
  }

  const f3 = matchPolicyPointsToStore(points, policyRows, cfg.f3SimilarityThreshold, cfg.excerptLen);
  const withMatches = f3.filter(r => r.matches && r.matches.length);

  if (!withMatches.length) {
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
};
