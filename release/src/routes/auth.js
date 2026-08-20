/**
 * routes/auth.js
 * GET  /auth/microsoft/start
 * GET  /auth/microsoft/callback
 * POST /auth/login
 * POST /auth/logout
 * POST /auth/change-password
 * GET  /auth/me
 */

import { pgQuery, pgFirst } from '../db.js';
import { json, err, sha256, randomToken, parseCookies, csvSet, getMicrosoftConfig, parseJwtPayload, buildLoginUrl, buildAppUrl, getDashboardPathByRole, getEffectiveAccessKeys, normalizeAccessKeys } from '../utils.js';
import { requireAuth, getSession, createSession, upsertMicrosoftUser } from '../middleware/auth.js';

function parseTags(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildMicrosoftCallbackHtml(env, url, sessionToken, user) {
  const safeToken = JSON.stringify(sessionToken).replace(/</g, '\\u003c');
  const safeRole = JSON.stringify(user.role || 'staff').replace(/</g, '\\u003c');
  const safeUser = JSON.stringify(user).replace(/</g, '\\u003c');
  const destination = JSON.stringify(buildAppUrl(env, url, getDashboardPathByRole(user.role || 'staff'))).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signing in...</title>
</head>
<body style="font-family:Sarabun,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#0f172a">
  <div style="text-align:center">
    <div style="font-size:1.1rem;font-weight:700;margin-bottom:8px">กำลังเข้าสู่ระบบด้วย Microsoft</div>
    <div style="color:#64748b">โปรดรอสักครู่...</div>
  </div>
  <script>
    localStorage.setItem('bt_token', ${safeToken});
    localStorage.setItem('bt_role', ${safeRole});
    localStorage.setItem('bt_user', JSON.stringify(${safeUser}));
    window.location.replace(${destination});
  </script>
</body>
</html>`;
}

export async function handleAuth(path, method, request, env) {
  const url = new URL(request.url);

  if (path === '/auth/microsoft/start' && method === 'GET') {
    const config = getMicrosoftConfig(env, url);
    if (!config) {
      return Response.redirect(buildLoginUrl(env, url, 'Microsoft SSO ยังไม่ได้ตั้งค่าในระบบ'), 302);
    }

    const state = randomToken(18);
    const scopes = String(env.MS_ENTRA_SCOPES || 'openid profile email User.Read').trim();
    const authUrl = new URL(config.authorizeUrl);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'select_account');

    const headers = new Headers({ Location: authUrl.toString() });
    headers.append('Set-Cookie', `bt_ms_state=${encodeURIComponent(state)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  }

  if (path === '/auth/microsoft/callback' && method === 'GET') {
    const config = getMicrosoftConfig(env, url);
    if (!config) {
      return Response.redirect(buildLoginUrl(env, url, 'Microsoft SSO ยังไม่ได้ตั้งค่าในระบบ'), 302);
    }

    const cookies = parseCookies(request);
    const reqState = url.searchParams.get('state') || '';
    const cookieState = cookies.bt_ms_state || '';
    const clearStateCookie = 'bt_ms_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';

    if (url.searchParams.get('error')) {
      const msg = url.searchParams.get('error_description') || url.searchParams.get('error') || 'Microsoft sign-in failed';
      const headers = new Headers({ Location: buildLoginUrl(env, url, msg) });
      headers.append('Set-Cookie', clearStateCookie);
      return new Response(null, { status: 302, headers });
    }

    const code = url.searchParams.get('code') || '';
    if (!code || !reqState || !cookieState || reqState !== cookieState) {
      const headers = new Headers({ Location: buildLoginUrl(env, url, 'Microsoft sign-in state ไม่ถูกต้อง') });
      headers.append('Set-Cookie', clearStateCookie);
      return new Response(null, { status: 302, headers });
    }

    const scopes = String(env.MS_ENTRA_SCOPES || 'openid profile email User.Read').trim();
    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        scope: scopes,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData.error_description || tokenData.error || 'Exchange token ไม่สำเร็จ';
      const headers = new Headers({ Location: buildLoginUrl(env, url, msg) });
      headers.append('Set-Cookie', clearStateCookie);
      return new Response(null, { status: 302, headers });
    }

    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,department', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const graphData = await graphRes.json().catch(() => ({}));
    const jwtClaims = parseJwtPayload(tokenData.id_token);
    const email = String(graphData.mail || graphData.userPrincipalName || jwtClaims.email || jwtClaims.preferred_username || '').trim().toLowerCase();

    if (!email) {
      const headers = new Headers({ Location: buildLoginUrl(env, url, 'ไม่พบอีเมลจากบัญชี Microsoft') });
      headers.append('Set-Cookie', clearStateCookie);
      return new Response(null, { status: 302, headers });
    }

    const allowedDomains = csvSet(env.MS_ALLOWED_DOMAINS || env.MS_ALLOWED_DOMAIN || 'betimes.biz');
    const emailDomain = (email.split('@')[1] || '').trim().toLowerCase();
    if (allowedDomains.size && !allowedDomains.has(emailDomain)) {
      const headers = new Headers({ Location: buildLoginUrl(env, url, 'อีเมลองค์กรนี้ไม่ได้รับอนุญาตให้เข้าสู่ระบบ') });
      headers.append('Set-Cookie', clearStateCookie);
      return new Response(null, { status: 302, headers });
    }

    const user = await upsertMicrosoftUser(env, {
      email,
      full_name: graphData.displayName || jwtClaims.name || email,
      department: graphData.department || '',
    });
    const sessionToken = await createSession(env, user.id);
    const html = buildMicrosoftCallbackHtml(env, url, sessionToken, user);
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': clearStateCookie,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (path === '/auth/login' && method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }
    const { email, password } = body || {};
    if (!email || !password) return err('กรุณากรอก email และรหัสผ่าน');
    const hash = await sha256(password);
    const user = await pgFirst(env,
      `SELECT id,email,full_name,role,department,tags,must_change_password,access_mode,access_json,account_type,user_expires_at FROM users
       WHERE (email=$1 OR username=$1) AND password_hash=$2 AND is_active=1
         AND (COALESCE(account_type,'permanent') <> 'temporary' OR user_expires_at IS NULL OR user_expires_at > now())`,
      [email, hash]
    );
    if (!user) return err('Email หรือรหัสผ่านไม่ถูกต้อง', 401);
    user.tags = parseTags(user.tags);
    user.access_keys = getEffectiveAccessKeys(user.role, user.access_mode, user.access_json);
    user.access_json = normalizeAccessKeys(user.access_json);
    const sid = await createSession(env, user.id);
    return json({ ok: true, token: sid, user, must_change_password: Number(user.must_change_password) === 1 });
  }

  if (path === '/auth/change-password' && method === 'POST') {
    const s = await requireAuth(request, env);
    const { current_password, new_password } = await request.json();
    if (!new_password || new_password.length < 6) return err('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
    const newHash = await sha256(new_password);
    const user = await pgFirst(env, `SELECT id,password_hash,must_change_password FROM users WHERE id=$1`, [s.user_id]);
    if (!user) return err('Unauthorized', 401);
    const forcedChange = Number(user.must_change_password) === 1;
    if (!forcedChange) {
      const currentHash = await sha256(current_password || '');
      if (String(user.password_hash || '') !== currentHash) return err('รหัสผ่านปัจจุบันไม่ถูกต้อง', 401);
    }
    if (String(user.password_hash || '') === newHash) return err('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม', 400);
    await pgQuery(env, `UPDATE users SET password_hash=$1, must_change_password=0, updated_at=now() WHERE id=$2`, [newHash, s.user_id]);
    return json({ ok: true });
  }

  if (path === '/auth/logout' && method === 'POST') {
    const s = await getSession(request, env);
    if (s) {
      const t = (request.headers.get('Authorization') || '').slice(7);
      await pgQuery(env, `DELETE FROM sessions WHERE id=$1`, [t]);
    }
    return json({ ok: true });
  }

  if (path === '/auth/me' && method === 'GET') {
    const s = await requireAuth(request, env);
    return json({ ok: true, user: s });
  }

  return null;
}
