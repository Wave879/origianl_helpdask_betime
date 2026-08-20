/**
 * middleware/auth.js — session and authentication helpers
 */

import { pgQuery, pgFirst } from '../db.js';
import { uid, sha256, csvSet, getEffectiveAccessKeys, normalizeAccessKeys } from '../utils.js';
import { json } from '../utils.js';

function parseTags(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createSession(env, userId) {
  const sid = uid();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await pgQuery(env, `INSERT INTO sessions (id,user_id,expires_at) VALUES ($1,$2,$3)`, [sid, userId, expires]);
  return sid;
}

export async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const user = await pgFirst(env,
    `SELECT s.user_id, u.email, u.full_name, u.role, u.department, u.tags, u.access_mode, u.access_json, u.account_type, u.user_expires_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.id = $1 AND s.expires_at > now() AND u.is_active=1
       AND (COALESCE(u.account_type,'permanent') <> 'temporary' OR u.user_expires_at IS NULL OR u.user_expires_at > now())`,
    [token]
  );
  if (!user) return null;
  return {
    ...user,
    tags: parseTags(user.tags),
    access_keys: getEffectiveAccessKeys(user.role, user.access_mode, user.access_json),
    access_json: normalizeAccessKeys(user.access_json),
  };
}

export async function requireAuth(request, env) {
  const s = await getSession(request, env);
  if (!s) throw json({ ok: false, error: 'Unauthorized' }, 401);
  return s;
}

export function resolveRoleFromEmail(email, env) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return 'staff';
  if (csvSet(env.MS_CEO_EMAILS).has(normalized)) return 'ceo';
  if (csvSet(env.MS_ADMIN_EMAILS).has(normalized)) return 'admin';
  if (csvSet(env.MS_MANAGER_EMAILS).has(normalized)) return 'manager';
  return String(env.MS_DEFAULT_ROLE || 'visitor').trim().toLowerCase() || 'visitor';
}

export async function upsertMicrosoftUser(env, profile) {
  const email = String(profile.email || '').trim().toLowerCase();
  const fullName = String(profile.full_name || '').trim();
  const department = String(profile.department || '').trim();
  let user = await pgFirst(
    env,
    `SELECT id,email,full_name,role,department,tags,is_active,access_mode,access_json,account_type,user_expires_at
     FROM users
     WHERE LOWER(email)=LOWER($1)`,
    [email]
  );

  if (user) {
    await pgQuery(
      env,
      `UPDATE users
       SET full_name=$1, department=$2, is_active=1, updated_at=now()
       WHERE id=$3`,
      [fullName || user.full_name || email, department || user.department || '', user.id]
    );
    user.full_name = fullName || user.full_name || email;
    user.department = department || user.department || '';
    user.is_active = 1;
    user.tags = parseTags(user.tags);
    user.access_keys = getEffectiveAccessKeys(user.role, user.access_mode, user.access_json);
    user.access_json = normalizeAccessKeys(user.access_json);
    return user;
  }

  const id = 'usr_' + uid().slice(0, 8);
  const role = resolveRoleFromEmail(email, env);
  await pgQuery(
    env,
    `INSERT INTO users (id,email,username,full_name,password_hash,role,department,is_active,access_mode,access_json,account_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, email, email, fullName || email, null, role, department, 1, 'role', '[]', 'permanent']
  );
  return {
    id,
    email,
    full_name: fullName || email,
    role,
    department,
    tags: [],
    is_active: 1,
    access_mode: 'role',
    access_json: [],
    access_keys: getEffectiveAccessKeys(role, 'role', '[]'),
  };
}
