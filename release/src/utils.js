/**
 * utils.js — shared utility functions
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key',
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}
export function err(msg, status = 400) { return json({ ok: false, error: msg }, status); }

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
export function uid() { return crypto.randomUUID().replace(/-/g, ''); }
export function randomToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function generateTemporaryPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
export const ACCESS_SECTION_KEYS = [
  'user',
  'it_support',
  'ai',
  'knowledge_center',
  'helpdeck_knowledge',
  'notifications',
  'admin_console',
];
export const ACCESS_ROLE_DEFAULTS = {
  ceo: ACCESS_SECTION_KEYS.slice(),
  admin: ACCESS_SECTION_KEYS.slice(),
  manager: ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
  staff: ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
  hr: ['user', 'it_support', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
  it_support: ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
};
export function normalizeAccessKeys(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((v) => String(v || '').trim()).filter(Boolean)));
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return normalizeAccessKeys(parsed);
      }
    } catch {
      // fall through to comma split
    }
  }
  return Array.from(new Set(raw.split(',').map((v) => String(v || '').trim()).filter(Boolean)));
}
export function getDefaultAccessKeysForRole(role) {
  const key = String(role || 'staff').trim().toLowerCase();
  return ACCESS_ROLE_DEFAULTS[key] || ACCESS_ROLE_DEFAULTS.staff;
}
export function getEffectiveAccessKeys(role, accessMode, accessJson) {
  const normalizedMode = String(accessMode || 'role').trim().toLowerCase();
  const customKeys = normalizeAccessKeys(accessJson);
  if (String(role || '').trim().toLowerCase() === 'ceo') return ACCESS_SECTION_KEYS.slice();
  if (normalizedMode === 'custom') {
    const locked = String(role || '').trim().toLowerCase() === 'admin' ? ['admin_console'] : [];
    return Array.from(new Set([...customKeys, ...locked]));
  }
  return getDefaultAccessKeysForRole(role);
}
export function parseCookies(request) {
  const raw = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

const APP_BASE_PREFIXES = ['/web'];

export function getPublicBaseUrl(env, url) {
  const configured = String(env?.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return String(url?.origin || '').trim();
}

export function getAppBasePath(pathname = '') {
  const raw = String(pathname || '');
  for (const prefix of APP_BASE_PREFIXES) {
    if (raw === prefix || raw.startsWith(prefix + '/')) return prefix;
  }
  return '';
}

export function joinAppPath(basePath, path) {
  const base = String(basePath || '').replace(/\/$/, '');
  const raw = String(path || '/');
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith('mailto:') || raw.startsWith('tel:')) return raw;
  if (!base) return raw;
  if (raw === '/') return `${base}/`;
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

export function csvSet(value) {
  return new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}
export function buildLoginUrl(env, url, error = '') {
  const target = new URL(joinAppPath(getAppBasePath(url?.pathname), '/login'), getPublicBaseUrl(env, url));
  if (error) target.searchParams.set('error', error);
  return target.toString();
}
export function buildAppUrl(env, url, path) {
  return new URL(joinAppPath(getAppBasePath(url?.pathname), path), getPublicBaseUrl(env, url)).toString();
}
export function getDashboardPathByRole(role) {
  return '/home';
}
export function getMicrosoftConfig(env, url) {
  const tenantId = String(env.MS_ENTRA_TENANT_ID || env.MICROSOFT_TENANT_ID || env.AZURE_AD_TENANT_ID || 'common').trim();
  const clientId = String(env.MS_ENTRA_CLIENT_ID || env.MICROSOFT_CLIENT_ID || env.AZURE_AD_CLIENT_ID || '').trim();
  const clientSecret = String(env.MS_ENTRA_CLIENT_SECRET || env.MICROSOFT_CLIENT_SECRET || env.AZURE_AD_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.MS_ENTRA_REDIRECT_URI || env.MICROSOFT_REDIRECT_URI || env.AZURE_AD_REDIRECT_URI || buildAppUrl(env, url, '/api/auth/microsoft/callback')).trim();
  if (!clientId || !clientSecret) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
  };
}
export function parseJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4 || 4)) % 4);
    const jsonText = atob(padded);
    return JSON.parse(jsonText);
  } catch {
    return {};
  }
}
export function tryParseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
export function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
