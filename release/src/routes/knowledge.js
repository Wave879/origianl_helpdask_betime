/**
 * routes/knowledge.js
 * CRUD /helpdeck-knowledge
 */

import { pgQuery, pgFirst, backendMode, usePgProxyBackend, useHyperdriveBackend, proxyToPgApi } from '../db.js';
import { json, err, uid, sha256 } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { upsertKnowledgeEmbedding } from '../embedding-search.js';

function requireBridgeAuth(request, env) {
  const expected = String(env.QDRANT_BRIDGE_API_KEY || env.QDRANT_API_KEY || '').trim();
  if (!expected) return String(env.QDRANT_BRIDGE_ALLOW_UNAUTH || '').toLowerCase() === 'true';
  const auth = String(request.headers.get('Authorization') || '').trim();
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const headerKey = String(request.headers.get('X-API-Key') || '').trim();
  if (token === expected || headerKey === expected) return true;
  return false;
}

function isInternalEmbeddingBackfill(request, env) {
  const expected = String(env.EMBEDDING_BACKFILL_TOKEN || '').trim();
  const received = String(request.headers.get('x-internal-embedding-token') || '').trim();
  return Boolean(expected && received && expected === received);
}

function getQdrantConfig(env, body = {}) {
  const rawUrl = String(env.QDRANT_URL || env.QDRANT_CLUSTER_URL || env.QDRANT_ENDPOINT || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.QDRANT_DB_API_KEY || env.QDRANT_CLOUD_API_KEY || env.QDRANT_DATABASE_API_KEY || '').trim();
  const collection = String(body.collection || env.QDRANT_COLLECTION || 'betime_helpdesk_knowledge').trim();
  return { rawUrl, apiKey, collection };
}

function getEmbeddingConfig(env) {
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
  const openAiKey = String(env.OPENAI_API_KEY || '').trim();
  const openAiModel = String(env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small').trim();
  if (azureUrl && azureKey) return { provider: 'azure', url: azureUrl, key: azureKey, model: deployment };
  if (openAiKey) return { provider: 'openai', url: 'https://api.openai.com/v1/embeddings', key: openAiKey, model: openAiModel };
  if (openRouterKey) return { provider: 'openrouter', url: openRouterUrl, key: openRouterKey, model: openRouterModel };
  return { provider: '', url: '', key: '', model: '' };
}

async function createEmbedding(env, input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('query/content is required for embedding');
  const cfg = getEmbeddingConfig(env);
  if (!cfg.url || !cfg.key) {
    throw new Error('Embedding is not configured. Set EMBEDDING_PROVIDER=openrouter + OPENROUTER_API_KEY, or Azure/OpenAI embedding variables.');
  }
  const headers = { 'Content-Type': 'application/json' };
  const payload = { input: text };
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

function qdrantHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'api-key': apiKey } : {}),
  };
}

function chunkText(text, maxChars = 3500) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  const chunks = [];
  let rest = cleaned;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function qdrantPointId(documentId, chunkIndex) {
  const hex = (await sha256(`${documentId}:${chunkIndex}`)).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function buildQdrantFilter(body = {}) {
  if (body.filter && typeof body.filter === 'object') return body.filter;
  if (body.filter && typeof body.filter === 'string') {
    try {
      const parsed = JSON.parse(body.filter);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  const projectCode = String(body.project_code || '').trim();
  const subProjectCode = String(body.sub_project_code || '').trim();
  const strict = String(body.project_strict ?? 'true').toLowerCase() !== 'false';
  const must = [];
  const should = [];
  if (projectCode) must.push({ key: 'project_code', match: { value: projectCode } });
  if (subProjectCode) {
    if (strict) must.push({ key: 'sub_project_code', match: { value: subProjectCode } });
    else should.push({ key: 'sub_project_code', match: { value: subProjectCode } });
  }
  return { ...(must.length ? { must } : {}), ...(should.length ? { should } : {}) };
}

async function qdrantFetch(env, body, path, options = {}) {
  const { rawUrl, apiKey, collection } = getQdrantConfig(env, body);
  if (!rawUrl) throw new Error('QDRANT_URL is not configured');
  if (!collection) throw new Error('QDRANT_COLLECTION is not configured');
  const url = `${rawUrl}/collections/${encodeURIComponent(collection)}${path}`;
  const res = await fetch(url, {
    method: options.method || 'POST',
    headers: qdrantHeaders(apiKey),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Qdrant failed (${res.status}): ${data.status?.error || data.message || 'unknown error'}`);
  return data;
}

async function qdrantRequest(env, body, path, payload) {
  return qdrantFetch(env, body, path, { method: 'POST', body: payload });
}

async function ensureQdrantCollection(env, body, vectorSize) {
  try {
    await qdrantFetch(env, body, '', { method: 'GET' });
    return false;
  } catch (error) {
    if (!String(error.message || '').includes('Qdrant failed (404)')) throw error;
  }
  const distance = String(env.QDRANT_DISTANCE || 'Cosine').trim();
  await qdrantFetch(env, body, '', {
    method: 'PUT',
    body: { vectors: { size: vectorSize, distance } },
  });
  return true;
}

function normalizeKnowledgeCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['project', 'โครงการ'].includes(raw)) return 'Project';
  if (['guide', 'manual', 'คู่มือ'].includes(raw)) return 'Guide';
  if (['helpdeck', 'helpdeck knowledge', 'helpdesk', 'knowledge'].includes(raw)) return 'Helpdeck';
  return 'Helpdeck';
}

function knowledgeCategoryWhereClause() {
  return `(category LIKE 'Helpdeck%' OR category IN ('Project', 'Guide'))`;
}

export async function handleKnowledge(path, method, request, env) {
  const url = new URL(request.url);

  if (path === '/helpdeck-knowledge/pending-embeddings' && method === 'POST') {
    if (!isInternalEmbeddingBackfill(request, env)) await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(Number(body.limit) || 20, 100));
    const rows = await pgQuery(
      env,
      `SELECT ka.id, ka.title, ka.content, ka.tags,
              COALESCE(ka.knowledge_scope, 'global') AS knowledge_scope,
              COALESCE(ka.project_code, '') AS project_code,
              COALESCE(ka.sub_project_code, '') AS sub_project_code
       FROM knowledge_articles ka
       WHERE (ka.category LIKE 'Helpdeck%' OR ka.category IN ('Project', 'Guide'))
         AND NOT EXISTS (SELECT 1 FROM knowledge_embeddings ke WHERE ke.article_id=ka.id)
       ORDER BY ka.updated_at ASC, ka.created_at ASC
       LIMIT $1`,
      [limit]
    );
    return json({ ok: true, data: rows });
  }

  if (path === '/helpdeck-knowledge/store-embedding' && method === 'POST') {
    if (!isInternalEmbeddingBackfill(request, env)) await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    const articleId = String(body.article_id || body.id || '').trim();
    const vector = Array.isArray(body.embedding) ? body.embedding : [];
    if (!articleId) return err('article_id is required');
    if (!vector.length || vector.length > 4096 || vector.some((value) => !Number.isFinite(Number(value)))) return err('Invalid embedding vector', 400);
    const article = await pgFirst(
      env,
      `SELECT id, title, content, tags,
              COALESCE(knowledge_scope, 'global') AS knowledge_scope,
              COALESCE(project_code, '') AS project_code,
              COALESCE(sub_project_code, '') AS sub_project_code
       FROM knowledge_articles
       WHERE id=$1 AND ${knowledgeCategoryWhereClause()}`,
      [articleId]
    );
    if (!article) return err('Knowledge article not found', 404);
    const contentHash = await sha256(`${article.title}\n${article.tags}\n${article.content}`);
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
        `emb_${article.id}`,
        article.id,
        article.knowledge_scope,
        article.project_code,
        article.sub_project_code,
        String(body.provider || 'openrouter').trim(),
        String(body.model || '').trim(),
        vector.length,
        contentHash,
        vector.map(Number),
      ]
    );
    return json({ ok: true, article_id: article.id, dimensions: vector.length });
  }

  if (path === '/helpdeck-knowledge/backfill-embeddings' && method === 'POST') {
    if (!isInternalEmbeddingBackfill(request, env)) await requireAuth(request, env);
    const cfg = getEmbeddingConfig(env);
    if (!cfg.url || !cfg.key) {
      return json({ ok: false, pending: true, error: 'Embedding is not configured' }, 409);
    }
    const body = await request.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(Number(body.limit) || 20, 100));
    const rows = await pgQuery(
      env,
      `SELECT ka.id, ka.title, ka.content, ka.tags,
              COALESCE(ka.knowledge_scope, 'global') AS knowledge_scope,
              COALESCE(ka.project_code, '') AS project_code,
              COALESCE(ka.sub_project_code, '') AS sub_project_code
       FROM knowledge_articles ka
       WHERE (ka.category LIKE 'Helpdeck%' OR ka.category IN ('Project', 'Guide'))
         AND NOT EXISTS (SELECT 1 FROM knowledge_embeddings ke WHERE ke.article_id=ka.id)
       ORDER BY ka.updated_at ASC, ka.created_at ASC
       LIMIT $1`,
      [limit]
    );
    let embedded = 0;
    const failed = [];
    for (const row of rows) {
      try {
        await upsertKnowledgeEmbedding(env, row);
        embedded += 1;
      } catch (error) {
        failed.push({ id: row.id, error: String(error?.message || error) });
      }
    }
    return json({ ok: true, embedded, attempted: rows.length, failed: failed.slice(0, 5) });
  }

  if (path === '/knowledge/qdrant-search' && method === 'POST') {
    const authOk = requireBridgeAuth(request, env);
    if (authOk === false) return err('Unauthorized Qdrant bridge request', 401);
    const body = await request.json().catch(() => ({}));
    const query = String(body.query || '').trim();
    if (!query) return err('query is required');
    const vector = await createEmbedding(env, query.slice(0, 8000));
    const limit = Math.max(1, Math.min(20, Number(body.limit || 5) || 5));
    const filter = buildQdrantFilter(body);
    const qdrantData = await qdrantRequest(env, body, `/points/search`, {
      vector,
      limit,
      filter,
      with_payload: true,
      with_vector: false,
    });
    const matches = (qdrantData.result || []).map((item) => ({
      id: item.id,
      score: item.score,
      title: item.payload?.title || '',
      content: item.payload?.content || item.payload?.text || '',
      project_code: item.payload?.project_code || '',
      sub_project_code: item.payload?.sub_project_code || '',
      tags: item.payload?.tags || '',
      source_url: item.payload?.source_url || '',
      document_id: item.payload?.document_id || '',
      chunk_index: item.payload?.chunk_index ?? null,
    }));
    return json({ ok: true, collection: getQdrantConfig(env, body).collection, filter, matches });
  }

  if (path === '/knowledge/qdrant-upsert' && method === 'POST') {
    const authOk = requireBridgeAuth(request, env);
    if (authOk === false) return err('Unauthorized Qdrant bridge request', 401);
    const body = await request.json().catch(() => ({}));
    const documentId = String(body.document_id || body.id || '').trim();
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (!documentId) return err('document_id is required');
    if (!title) return err('title is required');
    if (!content) return err('content is required');
    const chunks = chunkText(content);
    const points = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const vector = await createEmbedding(env, `${title}\n\n${chunk}`.slice(0, 8000));
      points.push({
        id: await qdrantPointId(documentId, i),
        vector,
        payload: {
          document_id: documentId,
          title,
          content: chunk,
          chunk_index: i,
          chunk_count: chunks.length,
          project_code: String(body.project_code || '').trim(),
          sub_project_code: String(body.sub_project_code || '').trim(),
          tags: String(body.tags || '').trim(),
          source_url: String(body.source_url || '').trim(),
          updated_at: new Date().toISOString(),
        },
      });
    }
    await ensureQdrantCollection(env, body, points[0].vector.length);
    const qdrantData = await qdrantFetch(env, body, `/points?wait=true`, { method: 'PUT', body: { points } });
    return json({ ok: true, collection: getQdrantConfig(env, body).collection, document_id: documentId, chunks: points.length, qdrant: qdrantData.result || qdrantData.status || qdrantData });
  }

  if (path === '/helpdeck-knowledge') {
    if (usePgProxyBackend(env)) {
      return proxyToPgApi(request, env, url.pathname + url.search);
    }
    if (useHyperdriveBackend(env) || backendMode(env) === 'd1') {
      const s = await requireAuth(request, env);
      if (method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        const previewOnly = String(url.searchParams.get('preview') || '').trim() === '1';
        const rows = q
          ? await pgQuery(
              env,
              `SELECT id, title, ${previewOnly ? `LEFT(COALESCE(content, ''), 800) AS content_preview,` : `content,`}
                      category, tags, author, created_at, updated_at,
                      COALESCE(knowledge_scope, 'global') AS knowledge_scope,
                      COALESCE(project_code, '') AS project_code,
                      COALESCE(sub_project_code, '') AS sub_project_code,
                      COALESCE(source_type, '') AS source_type,
                      COALESCE(source_ref, '') AS source_ref
               FROM knowledge_articles
               WHERE ${knowledgeCategoryWhereClause()} AND (title ILIKE $1 OR content ILIKE $1 OR tags ILIKE $1)
               ORDER BY updated_at DESC, created_at DESC`,
              [`%${q}%`]
            )
          : await pgQuery(
              env,
              `SELECT id, title, ${previewOnly ? `LEFT(COALESCE(content, ''), 800) AS content_preview,` : `content,`}
                      category, tags, author, created_at, updated_at,
                      COALESCE(knowledge_scope, 'global') AS knowledge_scope,
                      COALESCE(project_code, '') AS project_code,
                      COALESCE(sub_project_code, '') AS sub_project_code,
                      COALESCE(source_type, '') AS source_type,
                      COALESCE(source_ref, '') AS source_ref
               FROM knowledge_articles
               WHERE ${knowledgeCategoryWhereClause()}
               ORDER BY updated_at DESC, created_at DESC`
            );
        return json({ ok: true, data: rows });
      }

      if (method === 'POST') {
        const b = await request.json();
        const id = 'hk_' + uid().slice(0, 10);
        const title = (b.title || '').trim();
        const content = b.content || '';
        const tags = b.tags || '';
        const knowledgeScope = String(b.knowledge_scope || b.scope || 'global').trim() || 'global';
        const projectCode = String(b.project_code || b.projectCode || '').trim().toUpperCase();
        const subProjectCode = String(b.sub_project_code || b.subProjectCode || '').trim().toUpperCase();
        const sourceType = String(b.source_type || b.sourceType || '').trim();
        const sourceRef = String(b.source_ref || b.sourceRef || '').trim();
        const category = normalizeKnowledgeCategory(b.category || b.knowledge_category || b.tab);
        if (!title) return err('title is required');
        await pgQuery(
          env,
          `INSERT INTO knowledge_articles
             (id, title, content, category, tags, author, knowledge_scope, project_code, sub_project_code, source_type, source_ref, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())`,
          [id, title, content, category, tags, s.full_name || s.email || 'Unknown', knowledgeScope, projectCode, subProjectCode, sourceType, sourceRef]
        );
        let embedding = null;
        try {
          embedding = await upsertKnowledgeEmbedding(env, {
            id,
            title,
            content,
            tags,
            knowledge_scope: knowledgeScope,
            project_code: projectCode,
            sub_project_code: subProjectCode,
          });
        } catch {}
        return json({ ok: true, id, category, embedding });
      }
    }
  }

  if (path.startsWith('/helpdeck-knowledge/')) {
    await requireAuth(request, env);
    const id = path.split('/')[2];
    if (!id) return err('Invalid id', 400);

    if (method === 'PUT') {
      const b = await request.json();
      const title = (b.title || '').trim();
      const content = b.content || '';
      const tags = b.tags || '';
      const knowledgeScope = String(b.knowledge_scope || b.scope || 'global').trim() || 'global';
      const projectCode = String(b.project_code || b.projectCode || '').trim().toUpperCase();
      const subProjectCode = String(b.sub_project_code || b.subProjectCode || '').trim().toUpperCase();
      const sourceType = String(b.source_type || b.sourceType || '').trim();
      const sourceRef = String(b.source_ref || b.sourceRef || '').trim();
      const category = normalizeKnowledgeCategory(b.category || b.knowledge_category || b.tab);
      if (!title) return err('title is required');
      await pgQuery(
        env,
        `UPDATE knowledge_articles
         SET title=$1, content=$2, tags=$3, category=$4, knowledge_scope=$5, project_code=$6, sub_project_code=$7, source_type=$8, source_ref=$9, updated_at=now()
         WHERE id=$10 AND ${knowledgeCategoryWhereClause()}`,
        [title, content, tags, category, knowledgeScope, projectCode, subProjectCode, sourceType, sourceRef, id]
      );
      let embedding = null;
      try {
        embedding = await upsertKnowledgeEmbedding(env, {
          id,
          title,
          content,
          tags,
          knowledge_scope: knowledgeScope,
          project_code: projectCode,
          sub_project_code: subProjectCode,
        });
      } catch {}
      return json({ ok: true, category, embedding });
    }

    if (method === 'DELETE') {
      await pgQuery(env, `DELETE FROM knowledge_articles WHERE id=$1 AND ${knowledgeCategoryWhereClause()}`, [id]);
      return json({ ok: true });
    }
  }

  return null;
}
