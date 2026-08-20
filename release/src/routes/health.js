/**
 * routes/health.js — GET /health
 */

import { getPgConnectionConfig, pgFirst } from '../db.js';
import { json } from '../utils.js';

export async function handleHealth(path, method, request, env) {
  if (path === '/health' && method === 'GET') {
    const pgConfig = getPgConnectionConfig(env);
    const bindings = {
      hyperdrive: Boolean(env.HYPERDRIVE?.connectionString),
      pg_url: Boolean(env.PG_URL),
      r2: Boolean(env.BETIME_R2),
    };

    if (!pgConfig.configured) {
      return json({
        ok: false,
        service: 'betime-pages-worker',
        db: { mode: pgConfig.mode, configured: false },
        bindings,
        error: 'PostgreSQL is not configured. Set PG_URL secret or bind Hyperdrive as HYPERDRIVE.',
      }, 503);
    }

    const probe = await pgFirst(env, 'SELECT now() AS now, current_database() AS database_name');
    return json({
      ok: true,
      service: 'betime-pages-worker',
      db: {
        mode: pgConfig.mode,
        configured: true,
        database_name: probe?.database_name || null,
        now: probe?.now || null,
      },
      bindings,
    });
  }
  return null;
}
