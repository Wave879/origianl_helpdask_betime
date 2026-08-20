#!/bin/sh

interval="${EMBEDDING_BACKFILL_INTERVAL_SECONDS:-300}"

while true; do
  node - <<'NODE'
const appUrl = 'http://betime-app:8788/web/api/helpdeck-knowledge';
const token = process.env.EMBEDDING_BACKFILL_TOKEN || '';
const apiKey = process.env.OPENROUTER_API_KEY || '';
const model = process.env.OPENROUTER_EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const referenceImage = 'https://live.staticflickr.com/3851/14825276609_098cac593d_b.jpg';
const appHeaders = { 'Content-Type': 'application/json', 'X-Internal-Embedding-Token': token };

async function request(path, body) {
  const response = await fetch(`${appUrl}${path}`, { method: 'POST', headers: appHeaders, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function run() {
  if (!apiKey) return;
  const pending = await request('/pending-embeddings', { limit: 20 });
  let stored = 0;
  for (const article of pending.data || []) {
    const text = `${article.title || ''}\nTags: ${article.tags || ''}\n${article.content || ''}`.trim();
    if (!text) continue;
    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://aidlc-bt.demotoday.net',
        'X-OpenRouter-Title': 'Betime Knowledge',
      },
      body: JSON.stringify({
        model,
        input: [{ content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: referenceImage } },
        ] }],
        encoding_format: 'float',
      }),
    });
    const result = await response.json().catch(() => ({}));
    const embedding = result.data?.[0]?.embedding;
    if (!response.ok || !Array.isArray(embedding) || !embedding.length) {
      throw new Error(result.error?.message || result.message || `OpenRouter HTTP ${response.status}`);
    }
    await request('/store-embedding', { article_id: article.id, embedding, provider: 'openrouter', model });
    stored += 1;
  }
  if (stored) console.log(`[embedding-backfill] stored ${stored} embedding(s)`);
}

run().catch((error) => { console.error('[embedding-backfill] ' + error.message); process.exitCode = 1; });
NODE
  sleep "$interval"
done
