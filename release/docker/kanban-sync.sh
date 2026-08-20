#!/bin/sh

interval="${KANBAN_SYNC_INTERVAL_SECONDS:-300}"

while true; do
  node -e "fetch('http://betime-app:8788/web/api/helpdesk/kanban/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Sync-Token': process.env.KANBAN_SYNC_TOKEN || '' }, body: JSON.stringify({ limit: 30000, incremental: true }) }).then(async (response) => { if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text()); console.log('[kanban-sync] Odoo incremental sync completed'); }).catch((error) => { console.error('[kanban-sync] ' + error.message); process.exitCode = 1; });"
  sleep "$interval"
done
