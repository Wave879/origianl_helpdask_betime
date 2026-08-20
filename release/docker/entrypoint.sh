#!/bin/sh
set -eu

if [ -z "${PG_URL:-}" ]; then
  echo "PG_URL is required"
  exit 1
fi

echo "Waiting for PostgreSQL..."
node ./docker/wait-for-postgres.mjs

echo "Running database migrations..."
node scripts/migrate.mjs

echo "Starting BETIME on port ${PORT:-8788}"
set -- ./node_modules/.bin/wrangler pages dev deploy/pages_bundle \
  --ip 0.0.0.0 \
  --port "${PORT:-8788}" \
  -b "PG_URL=${PG_URL}" \
  -b "PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-https://aidlc-bt.demotoday.net/web}"

if [ -n "${AZURE_AI_ENDPOINT:-}" ]; then
  set -- "$@" -b "AZURE_AI_ENDPOINT=${AZURE_AI_ENDPOINT}"
fi
if [ -n "${AZURE_AI_KEY:-}" ]; then
  set -- "$@" -b "AZURE_AI_KEY=${AZURE_AI_KEY}"
fi
if [ -n "${AZURE_AI_API_VERSION:-}" ]; then
  set -- "$@" -b "AZURE_AI_API_VERSION=${AZURE_AI_API_VERSION}"
fi
if [ -n "${AZURE_AI_MODEL:-}" ]; then
  set -- "$@" -b "AZURE_AI_MODEL=${AZURE_AI_MODEL}"
fi
if [ -n "${AZURE_AI_DEPLOYMENT:-}" ]; then
  set -- "$@" -b "AZURE_AI_DEPLOYMENT=${AZURE_AI_DEPLOYMENT}"
fi
if [ -n "${KANBAN_SYNC_TOKEN:-}" ]; then
  set -- "$@" -b "KANBAN_SYNC_TOKEN=${KANBAN_SYNC_TOKEN}"
fi
if [ -n "${EMBEDDING_PROVIDER:-}" ]; then
  set -- "$@" -b "EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER}"
fi
if [ -n "${AZURE_AI_EMBEDDING_DEPLOYMENT:-}" ]; then
  set -- "$@" -b "AZURE_AI_EMBEDDING_DEPLOYMENT=${AZURE_AI_EMBEDDING_DEPLOYMENT}"
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  set -- "$@" -b "OPENAI_API_KEY=${OPENAI_API_KEY}"
fi
if [ -n "${OPENAI_EMBEDDING_MODEL:-}" ]; then
  set -- "$@" -b "OPENAI_EMBEDDING_MODEL=${OPENAI_EMBEDDING_MODEL}"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  set -- "$@" -b "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
fi
if [ -n "${OPENROUTER_EMBEDDING_MODEL:-}" ]; then
  set -- "$@" -b "OPENROUTER_EMBEDDING_MODEL=${OPENROUTER_EMBEDDING_MODEL}"
fi
if [ -n "${AZURE_AD_CLIENT_ID:-}" ]; then
  set -- "$@" -b "AZURE_AD_CLIENT_ID=${AZURE_AD_CLIENT_ID}"
fi
if [ -n "${AZURE_AD_CLIENT_SECRET:-}" ]; then
  set -- "$@" -b "AZURE_AD_CLIENT_SECRET=${AZURE_AD_CLIENT_SECRET}"
fi
if [ -n "${AZURE_AD_TENANT_ID:-}" ]; then
  set -- "$@" -b "AZURE_AD_TENANT_ID=${AZURE_AD_TENANT_ID}"
fi
if [ -n "${AZURE_AD_REDIRECT_URI:-}" ]; then
  set -- "$@" -b "AZURE_AD_REDIRECT_URI=${AZURE_AD_REDIRECT_URI}"
fi
if [ -n "${EMBEDDING_BACKFILL_TOKEN:-}" ]; then
  set -- "$@" -b "EMBEDDING_BACKFILL_TOKEN=${EMBEDDING_BACKFILL_TOKEN}"
fi

exec "$@"
