/**
 * Lightweight PostgreSQL embedding search.
 *
 * The local PostgreSQL instance does not expose pgvector, so embeddings are
 * stored as double precision[] and scored with cosine similarity in SQL.
 */

import { pgQuery } from './db.js';

export function getEmbeddingConfig(env) {
  const forcedProvider = String(env.EMBEDDING_PROVIDER || env.EMBEDDING_API_PROVIDER || '').trim().toLowerCase();
  const openRouterKey = String(env.OPENROUTER_API_KEY || '').trim();
  const openRouterModel = String(env.OPENROUTER_EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2:free').trim();
  const openRouterUrl = String(env.OPENROUTER_EMBEDDING_URL || 'https://openrouter.ai/api/v1/embeddings').trim();
  if (forcedProvider === 'openrouter' && openRouterKey) {
    return { provider: 'openrouter', url: openRouterUrl, key: openRouterKey, model: openRouterModel };
  }

  const explicitUrl = String(env.AZURE_OPENAI_EMBEDDING_URL || env.AZURE_AI_EMBEDDING_URL || env.OPENAI_EMBEDDING_URL || '').trim();
  const endpoint = String(env.AZURE_OPENAI_ENDPOINT || env.AZURE_AI_ENDPOINT || env.OAI_ENDPOINT || '').trim().replace(/\/+$/, '');
  const deployment = String(env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || env.AZURE_AI_EMBEDDING_DEPLOYMENT || env.OAI_EMBEDDING_DEPLOY || 'text-embedding-3-small').trim();
  const apiVersion = String(env.AZURE_OPENAI_API_VERSION || env.AZURE_AI_API_VERSION || env.OAI_API_VERSION || '2024-12-01-preview').trim();
  const azureUrl = explicitUrl || (endpoint && deployment ? `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}` : '');
  const azureKey = String(env.AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_KEY || env.AZURE_AI_KEY || env.OAI_KEY || '').trim();
  if (azureUrl && azureKey) return { provider: 'azure', url: azureUrl, key: azureKey, model: deployment };

  const openAiKey = String(env.OPENAI_API_KEY || '').trim();
  const openAiModel = String(env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small').trim();
  if (openAiKey) return { provider: 'openai', url: 'https://api.openai.com/v1/embeddings', key: openAiKey, model: openAiModel };
  if (openRouterKey) return { provider: 'openrouter', url: openRouterUrl, key: openRouterKey, model: openRouterModel };
  return { provider: '', url: '', key: '', model: '' };
}

export async function createEmbedding(env, input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('query/content is required for embedding');
  const cfg = getEmbeddingConfig(env);
  if (!cfg.url || !cfg.key) throw new Error('Embedding is not configured');

  const headers = { 'Content-Type': 'application/json' };
  const payload = { input: text.slice(0, 8000) };
  if (cfg.provider === 'azure') {
    headers['api-key'] = cfg.key;
  } else if (cfg.provider === 'openrouter') {
    headers.Authorization = `Bearer ${cfg.key}`;
    headers['HTTP-Referer'] = String(env.OPENROUTER_HTTP_REFERER || 'http://127.0.0.1:8788').trim();
    headers['X-OpenRouter-Title'] = String(env.OPENROUTER_APP_TITLE || 'Betime Mana Bot').trim();
    headers['User-Agent'] = 'Betime Knowledge Embedding/1.0';
    payload.model = cfg.model;
    payload.encoding_format = 'float';
    const content = [{ type: 'text', text }];
    // This OpenRouter VL embedding model requires a multimodal input even for text knowledge.
    if (/embed-vl/i.test(cfg.model)) {
      content.push({
        type: 'image_url',
        image_url: { url: String(env.OPENROUTER_EMBEDDING_IMAGE_URL || 'https://live.staticflickr.com/3851/14825276609_098cac593d_b.jpg').trim() },
      });
    }
    payload.input = [{ content }];
  } else {
    headers.Authorization = `Bearer ${cfg.key}`;
    payload.model = cfg.model;
  }

  const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Embedding failed (${res.status}): ${data.error?.message || data.message || 'unknown error'}`);
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error('Embedding response did not include a vector');
  return vector;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value || ''));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function upsertKnowledgeEmbedding(env, article = {}) {
  const id = String(article.id || '').trim();
  if (!id) return null;
  const title = String(article.title || '').trim();
  const tags = String(article.tags || '').trim();
  const content = String(article.content || '').trim();
  if (!title && !content) return null;

  const input = `${title}\nTags: ${tags}\n${content}`.replace(/\s+/g, ' ').trim().slice(0, 8000);
  const vector = await createEmbedding(env, input);
  const cfg = getEmbeddingConfig(env);
  const contentHash = await sha256Hex(`${title}\n${tags}\n${content}`);
  const knowledgeScope = String(article.knowledge_scope || article.scope || 'global').trim() || 'global';
  const projectCode = String(article.project_code || article.projectCode || '').trim().toUpperCase();
  const subProjectCode = String(article.sub_project_code || article.subProjectCode || '').trim().toUpperCase();

  try {
    await pgQuery(
      env,
      `INSERT INTO knowledge_embeddings
         (id, article_id, knowledge_scope, project_code, sub_project_code, provider, model, dimensions, content_hash, embedding, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
       ON CONFLICT (id) DO UPDATE SET
         knowledge_scope=EXCLUDED.knowledge_scope,
         project_code=EXCLUDED.project_code,
         sub_project_code=EXCLUDED.sub_project_code,
         provider=EXCLUDED.provider,
         model=EXCLUDED.model,
         dimensions=EXCLUDED.dimensions,
         content_hash=EXCLUDED.content_hash,
         embedding=EXCLUDED.embedding,
         updated_at=now()`,
      [
        `emb_${id}`,
        id,
        knowledgeScope,
        projectCode,
        subProjectCode,
        cfg.provider,
        cfg.model,
        vector.length,
        contentHash,
        vector,
      ]
    );
  } catch (error) {
    throw new Error(`Failed to store embedding: ${error?.message || String(error)}`);
  }
  return { article_id: id, dimensions: vector.length, provider: cfg.provider, model: cfg.model };
}

function hasKnowledgeDomainHint(text) {
  const lowerText = String(text || '').toLowerCase();
  const domainTerms = [
    'erc',
    'sarabun',
    'document',
    'workflow',
    'route',
    'routing',
    'login',
    'admin',
    'user manual',
    'manual',
    '\u0e2a\u0e32\u0e23\u0e1a\u0e23\u0e23\u0e13',
    '\u0e40\u0e2d\u0e01\u0e2a\u0e32\u0e23',
    '\u0e2b\u0e19\u0e31\u0e07\u0e2a\u0e37\u0e2d',
    '\u0e25\u0e07\u0e23\u0e31\u0e1a',
    '\u0e40\u0e25\u0e02\u0e23\u0e31\u0e1a',
    '\u0e2a\u0e48\u0e07\u0e15\u0e48\u0e2d',
    '\u0e40\u0e27\u0e35\u0e22\u0e19',
    '\u0e40\u0e2a\u0e49\u0e19\u0e17\u0e32\u0e07',
    '\u0e25\u0e47\u0e2d\u0e01\u0e2d\u0e34\u0e19',
    '\u0e1c\u0e39\u0e49\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19',
    '\u0e04\u0e39\u0e48\u0e21\u0e37\u0e2d',
  ];
  return domainTerms.some((term) => lowerText.includes(term));
}

function buildScopeParams(options = {}) {
  return {
    projectCode: String(options.projectCode || options.project_code || '').trim(),
    subProjectCode: String(options.subProjectCode || options.sub_project_code || '').trim(),
  };
}

export async function findRelevantKnowledgeByEmbedding(env, queryText, options = {}) {
  const text = String(queryText || '').replace(/\s+/g, ' ').trim();
  if (text.length < 3) return [];
  if (!hasKnowledgeDomainHint(text)) return [];
  const { projectCode, subProjectCode } = buildScopeParams(options);
  const limit = typeof options === 'number' ? options : options.limit;

  let vector = [];
  try {
    vector = await createEmbedding(env, text);
  } catch {
    return [];
  }

  try {
    const rows = await pgQuery(
      env,
      `WITH scored AS (
         SELECT
           ka.id, ka.title, ka.content, ka.tags, ka.author, ka.updated_at, ka.created_at,
           COALESCE(ka.knowledge_scope, 'global') AS knowledge_scope,
           COALESCE(ka.project_code, '') AS project_code,
           COALESCE(ka.sub_project_code, '') AS sub_project_code,
           (
             SELECT COALESCE(SUM(q.val * e.val), 0)
                    / NULLIF(SQRT(SUM(q.val * q.val)) * SQRT(SUM(e.val * e.val)), 0)
             FROM unnest($1::double precision[]) WITH ORDINALITY AS q(val, idx)
             JOIN unnest(ke.embedding) WITH ORDINALITY AS e(val, idx) ON q.idx = e.idx
           ) AS vector_score
         FROM knowledge_embeddings ke
         JOIN knowledge_articles ka ON ka.id = ke.article_id
         WHERE (ka.category LIKE 'Helpdeck%' OR ka.category IN ('Project', 'Guide'))
           AND array_length(ke.embedding, 1) = array_length($1::double precision[], 1)
           AND (
             COALESCE(ka.knowledge_scope, 'global') = 'global'
             OR ($2 <> '' AND COALESCE(ka.knowledge_scope, 'global') = 'project'
                 AND (
                   lower(COALESCE(ka.project_code, '')) = lower($2)
                   OR lower(COALESCE(ka.project_code, '')) LIKE lower($2) || '-%'
                   OR lower($2) LIKE lower(COALESCE(ka.project_code, '')) || '-%'
                 ))
             OR ($2 <> '' AND COALESCE(ka.knowledge_scope, 'global') = 'sub_project'
                 AND (
                   lower(COALESCE(ka.project_code, '')) = lower($2)
                   OR lower(COALESCE(ka.project_code, '')) LIKE lower($2) || '-%'
                   OR lower($2) LIKE lower(COALESCE(ka.project_code, '')) || '-%'
                 )
                 AND ($3 = '' OR lower(COALESCE(ka.sub_project_code, '')) = lower($3)))
           )
       )
       SELECT id, title, content, tags, author, updated_at, created_at, knowledge_scope, project_code, sub_project_code, vector_score
       FROM scored
       WHERE vector_score IS NOT NULL
       ORDER BY vector_score DESC
       LIMIT $4`,
      [vector, projectCode, subProjectCode, Math.max(1, Math.min(12, Number(limit) || 6))]
    );
    const minScore = Number(env.EMBEDDING_MIN_SCORE || env.KNOWLEDGE_EMBEDDING_MIN_SCORE || 0.03);
    return rows
      .map((row) => ({ ...row, _score: Number(row.vector_score || 0) * 10, _source: 'embedding' }))
      .filter((row) => Number(row.vector_score || 0) >= minScore);
  } catch {
    return [];
  }
}
