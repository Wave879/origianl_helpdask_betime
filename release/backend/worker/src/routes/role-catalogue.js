import { pgQuery } from '../db.js';
import { sha256 } from '../utils.js';

const cache = new Map();
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = value => text(value).toLowerCase();

export async function getRoleCatalogue(env, tables, load) {
  // Check local changes on every request; recheck Odoo at most ten seconds later.
  const [stamp] = await pgQuery(env, `SELECT md5(jsonb_build_object(
    'master',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM hd_master m WHERE table_name=ANY($1::text[])),
    'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM
      (SELECT id,email,username,full_name,job_title,role,department,is_active,account_type,user_expires_at,must_change_password FROM users) u)
    )::text) AS version`, [tables]);
  const cacheKey = env.HYPERDRIVE?.connectionString || env.PG_URL;
  const previous = cache.get(cacheKey);
  if (previous?.stamp === stamp.version && previous.expires > Date.now()) return previous.data;
  const data = await load(env);
  data.version = await sha256(JSON.stringify({ tables: data.tables, system_users: data.system_users }));
  if (cache.size >= 4 && !cache.has(cacheKey)) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { stamp: stamp.version, expires: Date.now() + 10000, data });
  return data;
}

export function rolePeople(context) {
  const people = context.system_users.map(row => ({ id: row.id, name: row.full_name || row.username || row.email,
    code: row.username || row.email, email: row.email, job: text(row.job_title), department: text(row.department), system: true }));
  const aliases = new Map();
  people.forEach(person => [person.id, person.code, person.email].filter(Boolean).forEach(value => aliases.set(key(value), person)));
  for (const row of context.tables.hd_users) {
    const extra = parse(row.extra);
    if (extra.merged_into) continue;
    const email = text(row.email || extra.email || (String(row.code || '').includes('@') ? row.code : ''));
    const keys = [row.id, row.code, email, extra.linked_system_user_id, extra.linked_helpdesk_id,
      ...(extra.merged_user_ids || []), extra.user_id, extra.username, extra.employee_id, extra.employee_code].filter(Boolean).map(key);
    const existing = keys.map(value => aliases.get(value)).find(Boolean);
    const position = text(row.position || row.position_name || extra.position || extra.position_name || extra.job_title);
    const job = text(row.job_title || extra.job_title);
    if (existing) {
      if (!existing.job) existing.job = position || job;
      if (!existing.department) existing.department = text(extra.department_name || extra.department);
      keys.forEach(value => aliases.set(value, existing));
      continue;
    }
    if (context.system_users.length && key(extra.source || row.kind) !== 'manual') continue;
    const person = { id: row.id, name: row.name || row.code, code: row.code, email,
      job: [position, job].filter(Boolean).join(','), department: text(extra.department_name || extra.department) };
    people.push(person);
    keys.forEach(value => aliases.set(value, person));
  }
  return people.filter(person => person.job.split(',').some(title => key(title) === 'it support'));
}

export function roleList(context, url) {
  const kind = url.searchParams.get('kind') || 'people';
  const q = key(url.searchParams.get('q')).slice(0, 200);
  const size = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('size'), 10) || 25));
  const source = kind === 'projects' ? context.tables.hd_projects : rolePeople(context);
  const filtered = source.filter(row => !q || [row.id, row.name, row.code, row.email, row.job, row.department]
    .map(key).join(' ').includes(q)).sort((a, b) => text(a.name).localeCompare(text(b.name), 'th') || text(a.id).localeCompare(text(b.id)));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(pages, Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1));
  return { ids: filtered.slice((page - 1) * size, page * size).map(row => row.id),
    page, size, pages, total: filtered.length, totalAll: source.length, version: context.version };
}
