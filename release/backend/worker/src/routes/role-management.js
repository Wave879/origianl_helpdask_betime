import { pgTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { json, err, uid } from '../utils.js';

export function canManageRoles(session) {
  return ['admin', 'ceo', 'superadmin', 'super_admin'].includes(String(session?.role || '').toLowerCase());
}

export async function requireRoleAdmin(request, env) {
  const session = await requireAuth(request, env);
  if (!canManageRoles(session)) throw err('เฉพาะผู้ดูแลระบบที่จัดการสิทธิ์โครงการได้', 403);
  return session;
}

const labels = { pm: 'PM', support: 'IT Support', dev: 'Dev', requester: 'Requester' };
const parse = value => typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
const text = value => String(value ?? '').trim();
const key = value => text(value).toLowerCase();
function roleOf(value) {
  const role = key(value);
  return Object.keys(labels).find(r => r === role || key(labels[r]) === role) || '';
}

export function validateRoleConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err('ข้อมูลสิทธิ์ไม่ถูกต้อง', 400);
  const result = { pmId: text(body.pmId || '') };
  if (body.pmId != null && typeof body.pmId !== 'string') throw err('PM ไม่ถูกต้อง', 400);
  for (const name of ['supportIds', 'devIds', 'requesterIds']) {
    if (!Array.isArray(body[name]) || body[name].some(id => typeof id !== 'string' || !id.trim())) {
      throw err('ต้องระบุรายการผู้ใช้ให้ครบทุกประเภทสิทธิ์', 400);
    }
    if (body[name].length > 1000) throw err('จำนวนผู้ใช้เกินกำหนด', 400);
    result[name] = [...new Set(body[name].map(text))];
  }
  return result;
}

export async function saveProjectRoles(env, session, projectId, method, body) {
  return pgTransaction(env, async query => {
    const [project] = await query("SELECT * FROM hd_master WHERE id=$1 AND table_name='hd_projects' FOR UPDATE", [projectId]);
    if (!project) throw err('ไม่พบโครงการ', 404);
    if (body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== new Date(project.updated_at).getTime()) {
      throw err('ข้อมูลโครงการเปลี่ยนแล้ว กรุณาปิดแล้วเปิดหน้าใหม่ก่อนบันทึก', 409);
    }
    const users = await query('SELECT id, full_name, email, username FROM users');
    const people = await query("SELECT id, code, name, extra FROM hd_master WHERE table_name='hd_users'");
    const identities = new Map(users.map(u => [u.id, { id: u.id, name: u.full_name || u.email, code: u.username || u.email }]));
    for (const p of people) {
      const extra = parse(p.extra);
      const account = users.find(u => u.id === extra.linked_system_user_id)
        || users.find(u => key(extra.email) && key(u.email) === key(extra.email));
      const person = account ? identities.get(account.id) : { id: p.id, name: p.name || p.code, code: p.code };
      identities.set(p.id, person);
      for (const alias of extra.merged_user_ids || []) identities.set(alias, person);
    }
    const resolve = id => {
      const person = identities.get(id);
      if (!person) throw err('ไม่พบผู้ใช้ที่เลือก กรุณาโหลดรายชื่อใหม่', 400);
      return person;
    };
    const projectExtra = parse(project.extra);
    const beforeExtra = { ...projectExtra };
    const existing = await query(`SELECT * FROM hd_master WHERE table_name='hd_project_member_roles'
      AND (extra::jsonb->>'project_id'=$1 OR
        (COALESCE(extra::jsonb->>'project_id','')='' AND extra::jsonb->>'project_code'=$2))`, [project.id, project.code]);
    for (const row of existing) {
      if (row.active === false) continue;
      const extra = parse(row.extra);
      if (!roleOf(extra.role_type || extra.position_name) || !identities.has(text(extra.person_id))) {
        throw err('สิทธิ์เดิมมีข้อมูลผู้ใช้หรือบทบาทไม่ครบ กรุณาตรวจรายการเดิมก่อนบันทึก', 409);
      }
    }
    let config;
    if (method === 'PUT') {
      config = validateRoleConfig(body);
    } else {
      const role = roleOf(body.role);
      if (!role || !['add', 'remove'].includes(body.action)) throw err('การแก้ไขสิทธิ์ไม่ถูกต้อง', 400);
      const person = resolve(text(body.personId));
      config = validateRoleConfig({ pmId: projectExtra.project_pm || '',
        supportIds: projectExtra.project_support_ids || [], devIds: projectExtra.project_dev_ids || [],
        requesterIds: projectExtra.project_requester_ids || [] });
      if (existing.length) {
        config = { pmId: '', supportIds: [], devIds: [], requesterIds: [] };
        for (const row of existing) {
          if (row.active === false) continue;
          const extra = parse(row.extra);
          const r = roleOf(extra.role_type || extra.position_name);
          if (!r) throw err('มีสิทธิ์เดิมที่ไม่รู้จัก กรุณาตรวจข้อมูลก่อนบันทึก', 409);
          const p = resolve(text(extra.person_id));
          if (r === 'pm') config.pmId = p.id;
          else config[r === 'support' ? 'supportIds' : r === 'dev' ? 'devIds' : 'requesterIds'].push(p.id);
        }
      }
      if (role === 'pm') {
        if (body.action === 'add') config.pmId = person.id;
        else if (config.pmId && resolve(config.pmId).id === person.id) config.pmId = '';
      } else {
        const field = role === 'support' ? 'supportIds' : role === 'dev' ? 'devIds' : 'requesterIds';
        config[field] = config[field].map(id => resolve(id).id).filter(id => id !== person.id);
        if (body.action === 'add') config[field].push(person.id);
      }
    }
    config.pmId = config.pmId ? resolve(config.pmId).id : '';
    for (const field of ['supportIds', 'devIds', 'requesterIds']) config[field] = [...new Set(config[field].map(id => resolve(id).id))];
    // Validate everything before deleting. A failure below rolls back both records and project metadata.
    for (const row of existing) await query('DELETE FROM hd_master WHERE id=$1', [row.id]);
    const members = [ ...(config.pmId ? [[config.pmId, 'pm']] : []),
      ...config.supportIds.map(id => [id, 'support']), ...config.devIds.map(id => [id, 'dev']),
      ...config.requesterIds.map(id => [id, 'requester']) ];
    for (const [id, role] of members) {
      const person = resolve(id);
      const extra = { source: 'ui-role-editor', project_id: project.id, project_code: project.code,
        project_name: project.name, person_id: person.id, person_code: person.code, person_name: person.name,
        role_type: labels[role], position_name: labels[role], source_table: 'ui', source_row_id: '' };
      await query(`INSERT INTO hd_master (id,table_name,code,name,extra,active,sort_order)
        VALUES ($1,'hd_project_member_roles',$2,$3,$4,true,0)`,
      ['hd_project_member_roles_' + uid(), `${project.code}|${id}|${labels[role]}`, `${project.name} - ${person.name}`, JSON.stringify(extra)]);
    }
    Object.assign(projectExtra, { project_pm: config.pmId, project_support_ids: config.supportIds,
      project_dev_ids: config.devIds, project_requester_ids: config.requesterIds });
    await query('UPDATE hd_master SET extra=$1, updated_at=now() WHERE id=$2', [JSON.stringify(projectExtra), project.id]);
    await query(`INSERT INTO audit_logs (id,actor_user_id,actor_email,action,details) VALUES ($1,$2,$3,$4,$5)`,
      ['aud_' + uid(), session.user_id, session.email, 'project_roles_saved', JSON.stringify({ project_id: project.id, method, before: beforeExtra, config })]);
    return config;
  });
}

export async function handleRoleManagement(path, method, request, env) {
  if (!path.startsWith('/hd-project-roles/')) return null;
  const session = await requireRoleAdmin(request, env);
  if (!['PUT', 'PATCH'].includes(method)) return err('Method not allowed', 405);
  const id = decodeURIComponent(path.slice('/hd-project-roles/'.length));
  let body;
  try { body = await request.json(); } catch { return err('ข้อมูล JSON ไม่ถูกต้อง', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err('ข้อมูลไม่ถูกต้อง', 400);
  return json({ ok: true, data: await saveProjectRoles(env, session, id, method, body) });
}
