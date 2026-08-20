/**
 * routes/files.js — POST /upload, GET /files/:key
 */

import { pgQuery, pgFirst, backendMode, getD1Database } from '../db.js';
import { json, err, uid, CORS_HEADERS } from '../utils.js';
import { requireAuth, getSession } from '../middleware/auth.js';

export const FILES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS files (
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
  )`;

let filesSchemaReadyPromise = null;
export async function ensureFilesSchema(env) {
  if (filesSchemaReadyPromise) return filesSchemaReadyPromise;
  filesSchemaReadyPromise = (async () => {
    if (backendMode(env) === 'd1') {
      // getD1Database imported at top of file
      const db = getD1Database(env);
      if (!db) throw new Error('D1 binding is not configured');
      await db.prepare(FILES_TABLE_SQL).run();
      for (const stmt of [
        `ALTER TABLE files ADD COLUMN IF NOT EXISTS content_base64 TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE files ADD COLUMN IF NOT EXISTS uploaded_by TEXT`,
        `ALTER TABLE files ADD COLUMN IF NOT EXISTS related_type TEXT DEFAULT 'general'`,
        `ALTER TABLE files ADD COLUMN IF NOT EXISTS related_id TEXT DEFAULT ''`,
        `ALTER TABLE files ADD COLUMN IF NOT EXISTS is_public INTEGER DEFAULT 0`,
        `ALTER TABLE files ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'))`,
      ]) {
        try { await db.prepare(stmt).run(); } catch {}
      }
      return;
    }
    await pgQuery(env, FILES_TABLE_SQL);
    await ensurePgFilesColumns(env);
  })();
  return filesSchemaReadyPromise;
}

async function getPgTableColumns(env, tableName) {
  const rows = await pgQuery(env, `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return new Set((rows || []).map(row => String(row.column_name || '').toLowerCase()));
}

async function ensurePgFilesColumns(env) {
  const existing = await getPgTableColumns(env, 'files');
  const statements = [];
  if (!existing.has('content_base64')) statements.push(`ALTER TABLE files ADD COLUMN content_base64 TEXT DEFAULT ''`);
  if (!existing.has('uploaded_by')) statements.push(`ALTER TABLE files ADD COLUMN uploaded_by TEXT`);
  if (!existing.has('related_type')) statements.push(`ALTER TABLE files ADD COLUMN related_type TEXT DEFAULT 'general'`);
  if (!existing.has('related_id')) statements.push(`ALTER TABLE files ADD COLUMN related_id TEXT DEFAULT ''`);
  if (!existing.has('is_public')) statements.push(`ALTER TABLE files ADD COLUMN is_public INTEGER DEFAULT 0`);
  if (!existing.has('created_at')) statements.push(`ALTER TABLE files ADD COLUMN created_at TEXT DEFAULT now()`);
  for (const stmt of statements) {
    await pgQuery(env, stmt);
  }
}

function isMissingFilesColumnError(err) {
  const msg = String(err?.message || err || '');
  return /column\s+"content_base64"\s+of\s+relation\s+"files"\s+does\s+not\s+exist/i.test(msg)
    || /column\s+.*content_base64.*does not exist/i.test(msg);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function handleFiles(path, method, request, env) {
  /* ── FILE UPLOAD ──────────────────────────────────────── */
  if (path === '/upload' && method === 'POST') {
    try {
      const s = await requireAuth(request, env);
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('multipart/form-data')) return err('ต้องส่งเป็น multipart/form-data');

      const formData = await request.formData();
      const file = formData.get('file');
      if (!file || typeof file === 'string') return err('ไม่พบไฟล์ในฟอร์ม');

      const related_type = formData.get('related_type') || 'general';
      const related_id   = formData.get('related_id')   || '';
      const originalName = file.name || 'upload';
      const ext = originalName.split('.').pop() || 'bin';
      const datePrefix = new Date().toISOString().slice(0,7).replace('-','/');
      const r2Key = `dbfiles/${datePrefix}/${uid().slice(0,12)}.${ext}`;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const contentBase64 = bytesToBase64(fileBytes);
      await ensureFilesSchema(env);

      const fileId = 'file_' + uid().slice(0,8);
      const insertParams = [fileId, r2Key, originalName, file.type||'application/octet-stream', file.size||0, contentBase64, s.user_id, related_type, related_id];
      try {
        await pgQuery(env,`INSERT INTO files (id,r2_key,original_name,content_type,size_bytes,content_base64,uploaded_by,related_type,related_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, insertParams);
      } catch (insertErr) {
        if (backendMode(env) === 'pg' && isMissingFilesColumnError(insertErr)) {
          await ensurePgFilesColumns(env);
          await pgQuery(env,`INSERT INTO files (id,r2_key,original_name,content_type,size_bytes,content_base64,uploaded_by,related_type,related_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, insertParams);
        } else {
          throw insertErr;
        }
      }

      return json({ ok: true, id: fileId, r2_key: r2Key, url: `/api/files/${encodeURIComponent(r2Key)}` });
    } catch (uploadErr) {
      console.error('[upload] failed:', uploadErr);
      return json({ ok: false, error: String(uploadErr?.message || uploadErr || 'Upload failed') }, 500);
    }
  }

  if (path.startsWith('/files/') && method === 'DELETE') {
    const s = await requireAuth(request, env);
    const fileRef = decodeURIComponent(path.slice('/files/'.length));
    if (!fileRef) return err('ต้องระบุไฟล์', 400);

    await ensureFilesSchema(env);
    const meta = await pgFirst(env, `SELECT id, uploaded_by, related_type FROM files WHERE r2_key=$1 OR id=$1`, [fileRef]);
    if (!meta) return err('ไม่พบไฟล์', 404);

    const role = String(s.role || '').trim().toLowerCase();
    const canManage = ['admin', 'ceo', 'manager', 'superadmin', 'super_admin'].includes(role);
    if (String(meta.uploaded_by || '') !== String(s.user_id || '') && !canManage) return err('Permission denied', 403);

    await pgQuery(env, `DELETE FROM files WHERE id=$1`, [meta.id]);
    return json({ ok: true });
  }

  /* ── FILE SERVE ───────────────────────────────────────── */
  if (path.startsWith('/files/') && method === 'GET') {
    const r2Key = decodeURIComponent(path.slice('/files/'.length));
    if (!r2Key) return err('ต้องระบุ key', 400);

    await ensureFilesSchema(env);
    const meta = await pgFirst(env,`SELECT * FROM files WHERE r2_key=$1 OR id=$1`,[r2Key]);
    if (!meta || !meta.is_public) {
      const s = await getSession(request, env);
      if (!s) return err('Unauthorized', 401);
    }

    if (!meta?.content_base64) return err('ไม่พบไฟล์', 404);
    const body = base64ToBytes(meta.content_base64);

    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', meta.content_type || 'application/octet-stream');
    headers.set('Content-Disposition', `inline; filename="${meta?.original_name || 'file'}"`);
    return new Response(body, { headers });
  }

  return null;
}
