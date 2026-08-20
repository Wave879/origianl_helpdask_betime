import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path

import psycopg2


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PG_URL = "postgres://postgres:123456@localhost:5432/Betime_DB"


def load_dev_vars(path: Path) -> dict:
    data = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def pg_url_from_env(env: dict) -> str:
    pg_url = env.get("PG_URL") or DEFAULT_PG_URL
    if "client_encoding" not in pg_url:
        pg_url += ("&" if "?" in pg_url else "?") + "options=-c%20client_encoding%3DUTF8"
    return pg_url


def embedding_config(env: dict) -> dict:
    forced = (env.get("EMBEDDING_PROVIDER") or env.get("EMBEDDING_API_PROVIDER") or "").strip().lower()
    openrouter_key = (env.get("OPENROUTER_API_KEY") or "").strip()
    openrouter_model = (env.get("OPENROUTER_EMBEDDING_MODEL") or "nvidia/llama-nemotron-embed-vl-1b-v2:free").strip()
    openrouter_url = (env.get("OPENROUTER_EMBEDDING_URL") or "https://openrouter.ai/api/v1/embeddings").strip()
    if forced == "openrouter" and openrouter_key:
        return {"provider": "openrouter", "url": openrouter_url, "key": openrouter_key, "model": openrouter_model}

    endpoint = (env.get("AZURE_OPENAI_ENDPOINT") or env.get("AZURE_AI_ENDPOINT") or env.get("OAI_ENDPOINT") or "").strip().rstrip("/")
    deployment = (env.get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT") or env.get("AZURE_AI_EMBEDDING_DEPLOYMENT") or env.get("OAI_EMBEDDING_DEPLOY") or "text-embedding-3-small").strip()
    api_version = (env.get("AZURE_OPENAI_API_VERSION") or env.get("AZURE_AI_API_VERSION") or env.get("OAI_API_VERSION") or "2024-12-01-preview").strip()
    explicit_url = (env.get("AZURE_OPENAI_EMBEDDING_URL") or env.get("AZURE_AI_EMBEDDING_URL") or env.get("OPENAI_EMBEDDING_URL") or "").strip()
    azure_url = explicit_url or (f"{endpoint}/openai/deployments/{deployment}/embeddings?api-version={api_version}" if endpoint and deployment else "")
    azure_key = (env.get("AZURE_OPENAI_API_KEY") or env.get("AZURE_OPENAI_KEY") or env.get("AZURE_AI_KEY") or env.get("OAI_KEY") or "").strip()
    if azure_url and azure_key:
        return {"provider": "azure", "url": azure_url, "key": azure_key, "model": deployment}

    openai_key = (env.get("OPENAI_API_KEY") or "").strip()
    openai_model = (env.get("OPENAI_EMBEDDING_MODEL") or "text-embedding-3-small").strip()
    if openai_key:
        return {"provider": "openai", "url": "https://api.openai.com/v1/embeddings", "key": openai_key, "model": openai_model}
    if openrouter_key:
        return {"provider": "openrouter", "url": openrouter_url, "key": openrouter_key, "model": openrouter_model}
    raise RuntimeError("Embedding provider is not configured")


def normalize_text(value: str, limit: int = 8000) -> str:
    return " ".join(str(value or "").split())[:limit]


def content_hash(row: dict) -> str:
    payload = "\n".join([row["title"] or "", row["tags"] or "", row["content"] or ""])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def create_embeddings(cfg: dict, texts: list[str], env: dict) -> list[list[float]]:
    body = {"input": texts, "model": cfg["model"], "encoding_format": "float"}
    headers = {"Content-Type": "application/json"}
    if cfg["provider"] == "azure":
        headers["api-key"] = cfg["key"]
        body = {"input": texts}
    elif cfg["provider"] == "openrouter":
        headers["Authorization"] = f"Bearer {cfg['key']}"
        headers["HTTP-Referer"] = env.get("OPENROUTER_HTTP_REFERER") or "http://127.0.0.1:8788"
        headers["X-Title"] = env.get("OPENROUTER_APP_TITLE") or "Betime Mana Bot"
    else:
        headers["Authorization"] = f"Bearer {cfg['key']}"

    req = urllib.request.Request(
        cfg["url"],
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")[:500]
        raise RuntimeError(f"Embedding failed ({exc.code}): {detail}") from exc
    vectors = [item.get("embedding") for item in data.get("data", [])]
    if len(vectors) != len(texts) or any(not isinstance(v, list) or not v for v in vectors):
        raise RuntimeError("Embedding response did not include all vectors")
    return vectors


def ensure_schema(cur) -> None:
    sql = (ROOT / "migrations" / "sql" / "006_knowledge_embeddings.sql").read_text(encoding="utf-8")
    cur.execute(sql)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--where", default="ka.id LIKE 'erc_sarabun_%'", help="SQL WHERE condition for knowledge_articles, alias ka")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--sleep", type=float, default=0.25)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    env = load_dev_vars(ROOT / ".dev.vars")
    cfg = embedding_config(env)
    conn = psycopg2.connect(pg_url_from_env(env))
    conn.set_client_encoding("UTF8")
    cur = conn.cursor()
    ensure_schema(cur)
    conn.commit()

    cur.execute(
        f"""
        SELECT ka.id, ka.title, ka.content, ka.tags,
               COALESCE(ka.knowledge_scope, 'global') AS knowledge_scope,
               COALESCE(ka.project_code, '') AS project_code,
               COALESCE(ka.sub_project_code, '') AS sub_project_code,
               COALESCE(ke.content_hash, '') AS existing_hash,
               COALESCE(ke.knowledge_scope, '') AS existing_scope,
               COALESCE(ke.project_code, '') AS existing_project_code,
               COALESCE(ke.sub_project_code, '') AS existing_sub_project_code
        FROM knowledge_articles ka
        LEFT JOIN knowledge_embeddings ke ON ke.article_id = ka.id
        WHERE ka.category LIKE 'Helpdeck%' AND ({args.where})
        ORDER BY ka.id
        """
    )
    rows = []
    for article_id, title, content, tags, knowledge_scope, project_code, sub_project_code, existing_hash, existing_scope, existing_project_code, existing_sub_project_code in cur.fetchall():
        row = {
            "id": article_id,
            "title": title or "",
            "content": content or "",
            "tags": tags or "",
            "knowledge_scope": knowledge_scope or "global",
            "project_code": (project_code or "").upper(),
            "sub_project_code": (sub_project_code or "").upper(),
        }
        row_hash = content_hash(row)
        metadata_changed = (
            row["knowledge_scope"] != (existing_scope or "")
            or row["project_code"] != (existing_project_code or "")
            or row["sub_project_code"] != (existing_sub_project_code or "")
        )
        if args.force or metadata_changed or row_hash != (existing_hash or ""):
            row["hash"] = row_hash
            rows.append(row)

    done = 0
    for offset in range(0, len(rows), args.batch_size):
        batch = rows[offset : offset + args.batch_size]
        texts = [
            normalize_text(f"{item['title']}\nTags: {item['tags']}\n{item['content']}")
            for item in batch
        ]
        vectors = create_embeddings(cfg, texts, env)
        for item, vector in zip(batch, vectors):
            cur.execute(
                """
                INSERT INTO knowledge_embeddings
                  (id, article_id, knowledge_scope, project_code, sub_project_code, provider, model, dimensions, content_hash, embedding, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (id) DO UPDATE SET
                  knowledge_scope=EXCLUDED.knowledge_scope,
                  project_code=EXCLUDED.project_code,
                  sub_project_code=EXCLUDED.sub_project_code,
                  provider=EXCLUDED.provider,
                  model=EXCLUDED.model,
                  dimensions=EXCLUDED.dimensions,
                  content_hash=EXCLUDED.content_hash,
                  embedding=EXCLUDED.embedding,
                  updated_at=now()
                """,
                (
                    f"emb_{item['id']}",
                    item["id"],
                    item["knowledge_scope"],
                    item["project_code"],
                    item["sub_project_code"],
                    cfg["provider"],
                    cfg["model"],
                    len(vector),
                    item["hash"],
                    vector,
                ),
            )
            done += 1
        conn.commit()
        print(json.dumps({"embedded": done, "total": len(rows), "last_id": batch[-1]["id"]}, ensure_ascii=False))
        if args.sleep:
            time.sleep(args.sleep)

    cur.execute("SELECT COUNT(*), MIN(dimensions), MAX(dimensions) FROM knowledge_embeddings WHERE article_id LIKE 'erc_sarabun_%'")
    summary = cur.fetchone()
    print(json.dumps({"ok": True, "provider": cfg["provider"], "model": cfg["model"], "updated": done, "summary": summary}, ensure_ascii=False, indent=2))
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
