/**
 * routes/users.js
 * GET/POST /users, GET /notifications, POST /notifications/read
 */

import { pgQuery } from '../db.js';
import { json, err, uid, sha256, generateTemporaryPassword, normalizeAccessKeys, getEffectiveAccessKeys } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

async function requireAdmin(request, env) {
  const s = await requireAuth(request, env);
  if (!['ceo', 'admin'].includes(String(s.role || '').toLowerCase())) throw err('Permission denied', 403);
  return s;
}

async function logAudit(env, actor, targetUserId, action, details = {}) {
  await pgQuery(
    env,
    `INSERT INTO audit_logs (id, actor_user_id, actor_email, target_user_id, action, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      'aud_' + uid().slice(0, 12),
      actor?.user_id || null,
      actor?.email || null,
      targetUserId || null,
      action,
      JSON.stringify(details || {}),
    ]
  );
}

function normalizeAccountType(value) {
  return String(value || 'permanent').trim().toLowerCase() === 'temporary' ? 'temporary' : 'permanent';
}

function normalizeExpiry(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59.000Z`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
  }
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)));
    }
  } catch {}
  return Array.from(new Set(raw.split(',').map((item) => String(item || '').trim()).filter(Boolean)));
}

function serializeTags(value) {
  return JSON.stringify(parseTags(value));
}

function addTag(tags, tag) {
  const normalized = String(tag || '').trim();
  if (!normalized) return serializeTags(tags);
  const next = parseTags(tags);
  if (!next.includes(normalized)) next.push(normalized);
  return JSON.stringify(next);
}

export async function handleUsers(path, method, request, env) {
  /* USERS */
  if (path === '/users') {
    if (method === 'GET') {
      await requireAuth(request, env);
      const r = await pgQuery(env, `SELECT id,email,username,full_name,role,department,is_active,must_change_password,tags,access_mode,access_json,account_type,user_expires_at,temp_password_sent_at,created_at,updated_at FROM users ORDER BY full_name`);
      return json({ ok: true, data: r.map((row) => ({ ...row, tags: parseTags(row.tags), access_keys: getEffectiveAccessKeys(row.role, row.access_mode, row.access_json), access_json: normalizeAccessKeys(row.access_json) })) });
    }
    if (method === 'POST') {
      const s = await requireAdmin(request, env);
      const b = await request.json();
      if (!b.email) return err('email is required');
      const tempPass = String(b.password || '').trim() || generateTemporaryPassword();
      const hash = await sha256(tempPass);
      const id = 'usr_' + uid().slice(0, 8);
      const accountType = normalizeAccountType(b.account_type);
      const expiresAt = accountType === 'temporary' ? normalizeExpiry(b.user_expires_at || b.expires_at) : null;
      const tags = parseTags(b.tags);
      if (accountType === 'temporary' || tempPass) {
        if (!tags.includes('รอรับรหัส ครั้งแรก')) tags.push('รอรับรหัส ครั้งแรก');
      }
      await pgQuery(env,
        `INSERT INTO users (id,email,username,full_name,password_hash,role,department,must_change_password,tags,access_mode,access_json,account_type,user_expires_at,temp_password_sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())` ,
        [id, b.email, b.username || b.email, b.full_name || '', hash, b.role || 'staff', b.department || '', 1, JSON.stringify(tags), 'role', '[]', accountType, expiresAt]
      );
      await logAudit(env, s, id, 'user_created', { email: b.email, role: b.role || 'staff', account_type: accountType, user_expires_at: expiresAt, must_change_password: 1, tags });
      return json({ ok: true, id, temp_password: tempPass, account_type: accountType, user_expires_at: expiresAt, delivery: 'manual' });
    }
  }

  if (path.startsWith('/users/') && !path.endsWith('/access') && !path.endsWith('/password-reset') && !path.endsWith('/password-set') && !path.endsWith('/logout-all') && !path.endsWith('/sessions') && !path.endsWith('/audit')) {
    if (method === 'PUT') {
      const s = await requireAdmin(request, env);
      const userId = path.split('/')[2];
      if (!userId) return err('Invalid user id', 400);
      const b = await request.json().catch(() => ({}));
      const updates = [];
      const params = [];
      const allowedRoles = new Set(['staff', 'manager', 'admin', 'ceo', 'super_admin']);
      const nextRole = String(b.role ?? '').trim().toLowerCase();
      if (nextRole) {
        if (!allowedRoles.has(nextRole)) return err('Invalid role', 400);
        params.push(nextRole);
        updates.push(`role=$${params.length}`);
      }
      if (b.full_name !== undefined) {
        params.push(String(b.full_name || '').trim());
        updates.push(`full_name=$${params.length}`);
      }
      if (b.department !== undefined) {
        params.push(String(b.department || '').trim());
        updates.push(`department=$${params.length}`);
      }
      if (b.is_active !== undefined) {
        params.push(Boolean(b.is_active) ? 1 : 0);
        updates.push(`is_active=$${params.length}`);
      }
      if (b.tags !== undefined) {
        params.push(serializeTags(b.tags));
        updates.push(`tags=$${params.length}`);
      }
      if (b.must_change_password !== undefined) {
        params.push(Boolean(b.must_change_password) ? 1 : 0);
        updates.push(`must_change_password=$${params.length}`);
      }
      if (b.account_type !== undefined) {
        const accountType = normalizeAccountType(b.account_type);
        params.push(accountType);
        updates.push(`account_type=$${params.length}`);
        params.push(accountType === 'temporary' ? normalizeExpiry(b.user_expires_at || b.expires_at) : null);
        updates.push(`user_expires_at=$${params.length}`);
      } else if (b.user_expires_at !== undefined || b.expires_at !== undefined) {
        params.push(normalizeExpiry(b.user_expires_at || b.expires_at));
        updates.push(`user_expires_at=$${params.length}`);
      }
      if (!updates.length) return err('No fields to update', 400);
      params.push(userId);
      await pgQuery(env, `UPDATE users SET ${updates.join(', ')}, updated_at=now() WHERE id=$${params.length}`, params);
      const shouldInvalidateSessions = Boolean(nextRole) || b.is_active !== undefined || b.must_change_password !== undefined || b.account_type !== undefined || b.user_expires_at !== undefined || b.expires_at !== undefined;
      const invalidated = shouldInvalidateSessions
        ? await pgQuery(env, `DELETE FROM sessions WHERE user_id=$1`, [userId])
        : [];
      await logAudit(env, s, userId, 'user_updated', {
        role: nextRole || undefined,
        full_name: b.full_name,
        department: b.department,
        is_active: b.is_active,
        tags: b.tags,
        must_change_password: b.must_change_password,
        account_type: b.account_type,
        user_expires_at: b.user_expires_at || b.expires_at,
        sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0,
      });
      return json({ ok: true, sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0 });
    }
  }

  if (path.startsWith('/users/') && path.endsWith('/access')) {
    const s = await requireAdmin(request, env);
    const userId = path.split('/')[2];
    if (!userId) return err('Invalid user id', 400);
    if (method !== 'PUT' && method !== 'POST') return null;
    const b = await request.json().catch(() => ({}));
    const accessMode = String(b.access_mode || 'role').trim().toLowerCase() === 'custom' ? 'custom' : 'role';
    const accessKeys = normalizeAccessKeys(b.access_keys);
    await pgQuery(env,
      `UPDATE users
       SET access_mode=$1,
           access_json=$2,
           updated_at=now()
       WHERE id=$3`,
      [accessMode, JSON.stringify(accessKeys), userId]
    );
    const invalidated = await pgQuery(env, `DELETE FROM sessions WHERE user_id=$1`, [userId]);
    await logAudit(env, s, userId, 'access_update', {
      access_mode: accessMode,
      access_keys: accessKeys,
      sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0,
    });
    return json({
      ok: true,
      access_mode: accessMode,
      access_keys: accessKeys,
      sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0,
    });
  }

  if (path.startsWith('/users/') && path.endsWith('/password-reset')) {
    const s = await requireAdmin(request, env);
    const userId = path.split('/')[2];
    if (!userId) return err('Invalid user id', 400);
    const tempPass = generateTemporaryPassword();
    const hash = await sha256(tempPass);
    await pgQuery(env,
      `UPDATE users
       SET password_hash=$1,
           must_change_password=1,
           temp_password_sent_at=now(),
           updated_at=now()
       WHERE id=$2`,
      [hash, userId]
    );
    const invalidated = await pgQuery(env, `DELETE FROM sessions WHERE user_id=$1`, [userId]);
    await logAudit(env, s, userId, 'password_reset', {
      must_change_password: 1,
      sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0,
    });
    return json({
      ok: true,
      temp_password: tempPass,
      sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0,
    });
  }

  if (path.startsWith('/users/') && path.endsWith('/password-set')) {
    const s = await requireAdmin(request, env);
    const userId = path.split('/')[2];
    if (!userId) return err('Invalid user id', 400);
    const b = await request.json().catch(() => ({}));
    const newPassword = String(b.new_password || '').trim();
    if (!newPassword || newPassword.length < 6) return err('new_password must be at least 6 characters', 400);
    const forceChange = b.must_change_password === undefined ? true : Boolean(b.must_change_password);
    const hash = await sha256(newPassword);
    await pgQuery(env,
      `UPDATE users
       SET password_hash=$1,
           must_change_password=$2,
           temp_password_sent_at=now(),
           updated_at=now()
       WHERE id=$3`,
      [hash, forceChange ? 1 : 0, userId]
    );
    const invalidated = await pgQuery(env, `DELETE FROM sessions WHERE user_id=$1`, [userId]);
    await logAudit(env, s, userId, 'password_set', {
      must_change_password: forceChange,
      sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0,
    });
    return json({ ok: true, sessions_invalidated: Array.isArray(invalidated) ? invalidated.length : 0 });
  }

  if (path.startsWith('/users/') && path.endsWith('/logout-all')) {
    const s = await requireAdmin(request, env);
    const userId = path.split('/')[2];
    if (!userId) return err('Invalid user id', 400);
    const deleted = await pgQuery(env, `DELETE FROM sessions WHERE user_id=$1`, [userId]);
    await logAudit(env, s, userId, 'logout_all_sessions', { deleted: Array.isArray(deleted) ? deleted.length : 0 });
    return json({ ok: true });
  }

  if (path.startsWith('/users/') && path.endsWith('/sessions')) {
    const s = await requireAuth(request, env);
    const userId = path.split('/')[2];
    if (!userId) return err('Invalid user id', 400);
    const isSelf = String(s.user_id || '') === String(userId);
    if (!isSelf && !['ceo', 'admin'].includes(String(s.role || '').toLowerCase())) return err('Permission denied', 403);
    const rows = await pgQuery(env, `SELECT id, created_at, expires_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return json({ ok: true, data: rows });
  }

  if (path.startsWith('/users/') && path.endsWith('/audit')) {
    const s = await requireAuth(request, env);
    const userId = path.split('/')[2];
    if (!userId) return err('Invalid user id', 400);
    const isSelf = String(s.user_id || '') === String(userId);
    if (!isSelf && !['ceo', 'admin'].includes(String(s.role || '').toLowerCase())) return err('Permission denied', 403);
    const rows = await pgQuery(env,
      `SELECT id, actor_user_id, actor_email, target_user_id, action, details, created_at
       FROM audit_logs
       WHERE target_user_id=$1 OR actor_user_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    return json({ ok: true, data: rows.map((row) => ({ ...row, details: (() => { try { return JSON.parse(row.details || '{}'); } catch { return {}; } })() })) });
  }

  /* NOTIFICATIONS */
  if (path === '/notifications' && method === 'GET') {
    const s = await requireAuth(request, env);
    const r = await pgQuery(env, `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [s.user_id]);
    return json({ ok: true, data: r });
  }

  if (path === '/notifications/read' && method === 'POST') {
    const s = await requireAuth(request, env);
    const b = await request.json();
    if (b.id) {
      await pgQuery(env, `UPDATE notifications SET is_read=1 WHERE id=$1 AND user_id=$2`, [b.id, s.user_id]);
    } else {
      await pgQuery(env, `UPDATE notifications SET is_read=1 WHERE user_id=$1`, [s.user_id]);
    }
    return json({ ok: true });
  }

  return null;
}
