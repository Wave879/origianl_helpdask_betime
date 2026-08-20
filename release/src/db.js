/**
 * db.js — database helpers (PostgreSQL via pg driver / Hyperdrive)
 */

import { err, CORS_HEADERS } from './utils.js';

export function backendMode(env) {
  if (env.HYPERDRIVE?.connectionString) return 'hyperdrive';
  if (env.PG_URL) return 'pg_url';
  return 'missing';
}

export function usePgProxyBackend(env) {
  return backendMode(env) === 'pg_proxy';
}

export function useHyperdriveBackend(env) {
  return backendMode(env) === 'hyperdrive' || backendMode(env) === 'pg_url';
}

function forceUtf8Connection(connStr) {
  // DB created with Thai_Thailand.874 locale causes pg client to negotiate WIN874.
  // Inject client_encoding=UTF8 as a startup parameter so Thai text is stored correctly.
  if (!connStr || connStr.includes('client_encoding')) return connStr;
  const sep = connStr.includes('?') ? '&' : '?';
  return connStr + sep + 'options=-c%20client_encoding%3DUTF8';
}

export function getPgConnectionConfig(env) {
  if (env.HYPERDRIVE?.connectionString) {
    return {
      mode: 'hyperdrive',
      connectionString: forceUtf8Connection(env.HYPERDRIVE.connectionString),
      configured: true,
    };
  }
  if (env.PG_URL) {
    return {
      mode: 'pg_url',
      connectionString: forceUtf8Connection(String(env.PG_URL)),
      configured: true,
    };
  }
  return {
    mode: 'missing',
    connectionString: '',
    configured: false,
  };
}

let pgModulePromise;
async function getPgClientCtor() {
  if (!pgModulePromise) pgModulePromise = import('pg');
  const pgModule = await pgModulePromise;
  return pgModule.Client || pgModule.default?.Client;
}

export async function pgQuery(env, sql, params = []) {
  const pgConfig = getPgConnectionConfig(env);
  if (!pgConfig.connectionString) {
    throw new Error('PostgreSQL is not configured (HYPERDRIVE binding or PG_URL)');
  }
  const Client = await getPgClientCtor();
  if (!Client) throw new Error('PostgreSQL driver (pg) is not available');

  const client = new Client({ connectionString: pgConfig.connectionString });
  await client.connect();
  try {
    await client.query("SET client_encoding='UTF8'");
    const result = await client.query(sql, params);
    return result.rows || [];
  } finally {
    await client.end();
  }
}

export async function pgFirst(env, sql, params = []) {
  const rows = await pgQuery(env, sql, params);
  return rows[0] || null;
}

export async function proxyToPgApi(request, env, targetPathWithQuery) {
  const base = String(env.PG_API_BASE || '').replace(/\/$/, '');
  if (!base) return err('PG_API_BASE is not configured', 503);

  const forwardUrl = base + targetPathWithQuery;
  const headers = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers.Authorization = auth;
  if (env.PG_API_KEY) headers['X-API-Key'] = env.PG_API_KEY;

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.text();
  }

  const upstream = await fetch(forwardUrl, {
    method: request.method,
    headers,
    body,
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get('Content-Type') || 'application/json';
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': contentType, ...CORS_HEADERS },
  });
}

export function normalizeSqlForD1(sql) {
  return String(sql)
    .replace(/::int\b/g, '')
    .replace(/::date\b/g, '')
    .replace(/::timestamptz\b/g, '')
    .replace(/::text\b/g, '')
    .replace(/::jsonb\b/g, '')
    .replace(/::uuid\b/g, '')
    .replace(/::numeric\b/g, '')
    .replace(/::bigint\b/g, '')
    .replace(/::boolean\b/g, '')
    .replace(/ILIKE/g, 'LIKE')
    .replace(/now\(\)\s*-\s*interval\s*'([0-9]+)\s+day'/gi, "datetime('now','-$1 day')")
    .replace(/now\(\)\s*\+\s*interval\s*'([0-9]+)\s+day'/gi, "datetime('now','+$1 day')")
    .replace(/current_date\s*\+\s*interval\s*'([0-9]+)\s+day'/gi, "date('now','+$1 day')")
    .replace(/to_char\(([^,]+),\s*'YYYY-MM'\)/gi, "substr($1,1,7)")
    .replace(/NULLS LAST/gi, '')
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0')
    .replace(/now\(\)/gi, "datetime('now')");
}

export function remapD1Params(sql, params = []) {
  const bound = [];
  const nextSql = String(sql).replace(/\$([0-9]+)/g, (_, rawIndex) => {
    const index = Number(rawIndex) - 1;
    bound.push(params[index]);
    return '?';
  });
  return { sql: nextSql, params: bound };
}

export function getD1Database(env) {
  return env.betime_db || env.BETIME_DB || env.DB || null;
}

let helpdeskChatSchemaReadyPromise = null;
export async function ensureHelpdeskChatSchema(env) {
  if (helpdeskChatSchemaReadyPromise) return helpdeskChatSchemaReadyPromise;
  helpdeskChatSchemaReadyPromise = (async () => {
    await pgQuery(env, `CREATE TABLE IF NOT EXISTS helpdesk_ticket_chats (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      sequence INTEGER DEFAULT 0,
      role TEXT NOT NULL,
      content_text TEXT DEFAULT '',
      content_json TEXT NOT NULL,
      sender_name TEXT DEFAULT '',
      sender_type TEXT DEFAULT '',
      session_id TEXT DEFAULT '',
      created_by TEXT,
      source TEXT DEFAULT 'helpdesk_v3',
      created_at TEXT DEFAULT now(),
      updated_at TEXT DEFAULT now()
    )`);
    await pgQuery(env, `ALTER TABLE helpdesk_ticket_chats ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT ''`);
    await pgQuery(env, `CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_chats_ticket_sequence
      ON helpdesk_ticket_chats(ticket_id, sequence, created_at)`);
    await pgQuery(env, `CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_chats_ticket_session_sequence
      ON helpdesk_ticket_chats(ticket_id, session_id, sequence, created_at)`);
    await pgQuery(env, `CREATE TABLE IF NOT EXISTS helpdesk_ticket_chat_sessions (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_by TEXT,
      source TEXT DEFAULT 'helpdesk_v3',
      created_at TEXT DEFAULT now(),
      updated_at TEXT DEFAULT now()
    )`);
    await pgQuery(env, `CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_chat_sessions_ticket_active
      ON helpdesk_ticket_chat_sessions(ticket_id, is_active, updated_at)`);
  })();
  return helpdeskChatSchemaReadyPromise;
}

let d1SchemaReadyPromise = null;
export async function ensureD1TestSchema(env) {
  if (d1SchemaReadyPromise) return d1SchemaReadyPromise;
  const db = getD1Database(env);
  if (!db) throw new Error('D1 binding is not configured');
  d1SchemaReadyPromise = (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE,
        full_name TEXT,
        password_hash TEXT,
        role TEXT DEFAULT 'staff',
        department TEXT,
        avatar_url TEXT,
        is_active INTEGER DEFAULT 1,
        must_change_password INTEGER DEFAULT 0,
        tags TEXT DEFAULT '[]',
        access_mode TEXT DEFAULT 'role',
        access_json TEXT DEFAULT '[]',
        account_type TEXT DEFAULT 'permanent',
        user_expires_at TEXT,
        temp_password_sent_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        status TEXT DEFAULT 'Active',
        progress INTEGER DEFAULT 0,
        risk_level TEXT DEFAULT 'Low',
        deadline TEXT,
        owner TEXT,
        description TEXT,
        budget REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_name TEXT NOT NULL,
        project TEXT,
        assigned_to TEXT,
        status TEXT DEFAULT 'Open',
        priority TEXT DEFAULT 'Medium',
        deadline TEXT,
        description TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS ot_claims (
        id TEXT PRIMARY KEY,
        employee TEXT NOT NULL,
        ot_date TEXT NOT NULL,
        ot_hours REAL NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'Draft',
        approved_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        invoice_no TEXT UNIQUE,
        vendor TEXT,
        amount REAL DEFAULT 0,
        due_date TEXT,
        status TEXT DEFAULT 'Unpaid',
        description TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        event_type TEXT DEFAULT 'Meeting',
        start_datetime TEXT NOT NULL,
        end_datetime TEXT,
        location TEXT,
        attendees TEXT DEFAULT '[]',
        description TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS meeting_moms (
        id TEXT PRIMARY KEY,
        project TEXT,
        meeting_date TEXT,
        attendees TEXT DEFAULT '[]',
        agenda TEXT,
        decisions TEXT,
        action_items TEXT DEFAULT '[]',
        ai_summary TEXT,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS knowledge_articles (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        category TEXT,
        tags TEXT DEFAULT '[]',
        author TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        is_read INTEGER DEFAULT 0,
        link TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS hd_master (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        code TEXT DEFAULT '',
        name TEXT NOT NULL,
        extra TEXT DEFAULT '{}',
        active INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS helpdesk_tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        project TEXT,
        bug_type TEXT DEFAULT 'Ticket',
        status TEXT DEFAULT 'open',
        assigned_dev TEXT,
        created_by TEXT,
        odoo_ticket_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        extra TEXT DEFAULT '{}'
      )`,
      `CREATE TABLE IF NOT EXISTS helpdesk_ticket_chats (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        sequence INTEGER DEFAULT 0,
        role TEXT NOT NULL,
        content_text TEXT DEFAULT '',
        content_json TEXT NOT NULL,
        sender_name TEXT DEFAULT '',
        sender_type TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        created_by TEXT,
        source TEXT DEFAULT 'helpdesk_v3',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_chats_ticket_sequence
         ON helpdesk_ticket_chats(ticket_id, sequence, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_chats_ticket_session_sequence
         ON helpdesk_ticket_chats(ticket_id, session_id, sequence, created_at)`,
      `CREATE TABLE IF NOT EXISTS helpdesk_ticket_chat_sessions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_by TEXT,
        source TEXT DEFAULT 'helpdesk_v3',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_chat_sessions_ticket_active
         ON helpdesk_ticket_chat_sessions(ticket_id, is_active, updated_at)`,
      `CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        r2_key TEXT UNIQUE NOT NULL,
        original_name TEXT NOT NULL,
        content_type TEXT DEFAULT 'application/octet-stream',
        size_bytes INTEGER DEFAULT 0,
        content_base64 TEXT NOT NULL,
        uploaded_by TEXT,
        related_type TEXT DEFAULT 'general',
        related_id TEXT DEFAULT '',
        is_public INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `INSERT OR IGNORE INTO hd_master (id,table_name,code,name,extra,active,sort_order) VALUES
       ('hd_projects_001','hd_projects','ERC','ระบบสารสนเทศ อิเล็กทรอนิกส์','{}',1,1),
       ('hd_projects_002','hd_projects','SRB','ระบบรับเรื่องร้องเรียน','{}',1,2),
       ('hd_projects_003','hd_projects','BT','Betime Internal','{}',1,3)`,
      `INSERT OR IGNORE INTO hd_master (id,table_name,code,name,extra,active,sort_order) VALUES
       ('hd_topics_001','hd_topics','BUG','Bug / Error','{}',1,1),
       ('hd_topics_002','hd_topics','NET','Network','{}',1,2),
       ('hd_topics_003','hd_topics','ACC','Account / Permission','{}',1,3),
       ('hd_topics_004','hd_topics','CHG','Change Request','{}',1,4),
       ('hd_topics_005','hd_topics','HW','Hardware','{}',1,5)`,
    ];
    for (const sql of statements) {
      await db.prepare(sql).run();
    }
    const migrations = [
      `ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN tags TEXT DEFAULT '[]'`,
      `ALTER TABLE users ADD COLUMN access_mode TEXT DEFAULT 'role'`,
      `ALTER TABLE users ADD COLUMN access_json TEXT DEFAULT '[]'`,
      `ALTER TABLE users ADD COLUMN account_type TEXT DEFAULT 'permanent'`,
      `ALTER TABLE users ADD COLUMN user_expires_at TEXT`,
      `ALTER TABLE users ADD COLUMN temp_password_sent_at TEXT`,
      `ALTER TABLE helpdesk_ticket_chats ADD COLUMN session_id TEXT DEFAULT ''`,
    ];
    for (const sql of migrations) {
      try {
        await db.prepare(sql).run();
      } catch (error) {
        if (!String(error?.message || error).includes('duplicate column name')) throw error;
      }
    }
  })();
  return d1SchemaReadyPromise;
}
