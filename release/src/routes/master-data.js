/**
 * routes/master-data.js
 * GET/POST/PUT/DELETE /hd-master
 */

import { pgQuery, pgFirst, backendMode, usePgProxyBackend, useHyperdriveBackend, proxyToPgApi, getD1Database } from '../db.js';
import { json, err, uid } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

const HD_VALID_TABLES = new Set([
  'hd_users','hd_teams','hd_projects','hd_sub_projects','hd_questions',
  'hd_positions',
  'hd_main_team_project',
  'hd_channels','hd_projects_dev','hd_project_member_roles','hd_contacts','hd_configs','hd_sla',
  'hd_criteria','hd_sub_criteria','hd_request_types','hd_report_topics',
  'hd_topics','hd_provinces','hd_districts','hd_subdistricts','hd_postcodes',
  'hd_project_info_pdf','hd_project_manual_pdf','hd_faq_helpdeck',
  'hd_flow_products','hd_flow_areas','hd_flow_case_types',
  'hd_firebase','hd_line_tokens','hd_sync_projects','hd_sync_employees','hd_log_tm'
]);
const HD_PUBLIC_READ_TABLES = new Set([
  'hd_projects',
  'hd_sub_projects',
  'hd_projects_dev',
  'hd_sla',
  'hd_criteria',
  'hd_sub_criteria',
  'hd_flow_areas',
  'hd_flow_case_types',
  'hd_flow_products',
]);
const MASTER_PROJECT_ALIASES = new Set([
  'ERC',
  'SARABUN',
  'ERC-SARABUN',
  'BMAROD',
  'BMA-ROD',
  'BMA ROD',
  'RAOT',
  'RAOT-SARABUN',
]);

function repairMojibakeText(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const hasMojibakeShape = /\u0E40[\u0E18\u0E19]|\u0E42\u20AC|[\u0080-\u009F\uFFFD]/u.test(text);
  if (!hasMojibakeShape) return text;
  const score = (sample) => {
    const thai = (sample.match(/[ก-๙]/g) || []).length;
    const latin = (sample.match(/[A-Za-z0-9]/g) || []).length;
    const noise = (sample.match(/[^\u0E00-\u0E7F\s\-\/:.,()&%#@!?+'"`“”‘’[\]{}]/g) || []).length;
    return thai * 3 + latin * 0.5 - noise * 0.2;
  };
  const candidates = [text];
  let current = text;
  for (let i = 0; i < 3; i += 1) {
    try {
      const bytes = Uint8Array.from(current, (ch) => ch.charCodeAt(0) & 0xff);
      const utf8Fixed = new TextDecoder('utf-8').decode(bytes);
      const win874Fixed = new TextDecoder('windows-874').decode(bytes);
      if (utf8Fixed && utf8Fixed !== current) candidates.push(utf8Fixed);
      if (win874Fixed && win874Fixed !== current) candidates.push(win874Fixed);
      current = utf8Fixed;
    } catch {
      break;
    }
  }
  return candidates.sort((a, b) => score(b) - score(a))[0] || text;
}

function hasSuspiciousQuestionMarks(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  if (!questionMarks) return false;
  const visibleChars = (text.match(/[^\s]/g) || []).length || 1;
  const thaiChars = (text.match(/[ก-๙]/g) || []).length;
  if (thaiChars > 0) return false;
  if (/^\?+(?:\s+\?+)*$/u.test(text)) return true;
  return questionMarks >= 3 && (questionMarks / visibleChars) >= 0.35;
}

function normalizeMasterString(value, { collapseWhitespace = true } = {}) {
  const repaired = repairMojibakeText(String(value ?? ''));
  return collapseWhitespace ? repaired.replace(/\s+/g, ' ').trim() : repaired.trim();
}

function sanitizeExtraValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeExtraValue(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeExtraValue(item);
    return out;
  }
  if (typeof value === 'string') return normalizeMasterString(value, { collapseWhitespace: false });
  return value;
}

function sanitizeRowForResponse(row) {
  if (!row || typeof row !== 'object') return row;
  const next = { ...row };
  if (typeof next.code === 'string') next.code = normalizeMasterString(next.code);
  if (typeof next.name === 'string') next.name = normalizeMasterString(next.name);
  if (typeof next.extra === 'string' && next.extra.trim()) {
    try {
      next.extra = JSON.stringify(sanitizeExtraValue(JSON.parse(next.extra)));
    } catch {
      next.extra = normalizeMasterString(next.extra, { collapseWhitespace: false });
    }
  }
  return next;
}

function sanitizeHdMasterPayload(body = {}) {
  const next = { ...body };
  next.code = normalizeMasterString(body.code || '');
  next.name = normalizeMasterString(body.name || '');
  const rawExtra = body.extra;
  let extraObject = {};
  if (rawExtra && typeof rawExtra === 'object') {
    extraObject = sanitizeExtraValue(rawExtra);
  } else if (String(rawExtra || '').trim()) {
    try {
      extraObject = sanitizeExtraValue(JSON.parse(String(rawExtra)));
    } catch {
      extraObject = { _raw: normalizeMasterString(rawExtra, { collapseWhitespace: false }) };
    }
  }
  next.extra = JSON.stringify(extraObject);
  next.active = body.active !== false;
  next.sort_order = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;

  const suspiciousFields = [
    ['code', next.code],
    ['name', next.name],
    ...Object.entries(extraObject).filter(([, value]) => typeof value === 'string'),
  ].filter(([, value]) => hasSuspiciousQuestionMarks(value));

  if (suspiciousFields.length) {
    const fields = suspiciousFields.map(([key]) => key).join(', ');
    throw new Error(`พบข้อความเสี่ยงเป็น ??? ในฟิลด์ ${fields} กรุณาตรวจ encoding ไทย (UTF-8) ก่อนบันทึก`);
  }
  return next;
}

async function ensureOdooEmployeeMap(env) {
  if (backendMode(env) === 'd1') {
    // getD1Database imported at top of file
    const db = getD1Database(env);
    if (!db) throw new Error('D1 binding is not configured');
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS odoo_employee_map (
        odoo_employee_id TEXT PRIMARY KEY,
        employee_name TEXT NOT NULL,
        employee_ref TEXT DEFAULT '',
        source_user_id TEXT DEFAULT '',
        email TEXT DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    await db.prepare(`
      INSERT INTO odoo_employee_map (odoo_employee_id, employee_name, employee_ref, source_user_id, email, updated_at)
      SELECT
        json_extract(extra, '$.source_id') AS odoo_employee_id,
        name AS employee_name,
        '' AS employee_ref,
        id AS source_user_id,
        COALESCE(json_extract(extra, '$.email'), '') AS email,
        datetime('now') AS updated_at
      FROM hd_master
      WHERE table_name='hd_users'
        AND extra LIKE '{%'
        AND COALESCE(json_extract(extra, '$.source_id'), '') <> ''
      ON CONFLICT(odoo_employee_id) DO UPDATE SET
        employee_name=excluded.employee_name,
        source_user_id=excluded.source_user_id,
        email=excluded.email,
        updated_at=datetime('now')
    `).run();
    return;
  }

  await pgQuery(env, `
    CREATE TABLE IF NOT EXISTS odoo_employee_map (
      odoo_employee_id TEXT PRIMARY KEY,
      employee_name TEXT NOT NULL,
      employee_ref TEXT DEFAULT '',
      source_user_id TEXT DEFAULT '',
      email TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pgQuery(env, `
    INSERT INTO odoo_employee_map (odoo_employee_id, employee_name, employee_ref, source_user_id, email, updated_at)
    SELECT
      (extra::jsonb->>'source_id') AS odoo_employee_id,
      name AS employee_name,
      '' AS employee_ref,
      id AS source_user_id,
      COALESCE(extra::jsonb->>'email', '') AS email,
      now() AS updated_at
    FROM hd_master
    WHERE table_name='hd_users'
      AND extra LIKE '{%'
      AND COALESCE(extra::jsonb->>'source_id', '') <> ''
    ON CONFLICT (odoo_employee_id) DO UPDATE SET
      employee_name = EXCLUDED.employee_name,
      source_user_id = EXCLUDED.source_user_id,
      email = EXCLUDED.email,
      updated_at = now()
  `);
}

function getOdooRuntimeConfig(env) {
  const defaults = {
    url: 'http://bt.dev.demotoday.net',
    db: 'bt-helpdesk',
    login: 'admin',
    password: 'bt@admin',
  };
  return {
    url: String(env.ODOO_URL || env.ODOO_BASE_URL || env.ODOO_PUBLIC_URL || env.ODOO_HOST || defaults.url || '').replace(/\/$/, ''),
    db: String(env.ODOO_DB || defaults.db || '').trim(),
    login: String(env.ODOO_LOGIN || env.ODOO_USER || defaults.login || '').trim(),
    password: String(env.ODOO_PASSWORD || defaults.password || '').trim(),
  };
}

async function odooExecuteKw(url, db, uid, password, model, method, args = [], kwargs = {}) {
  const res = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service: 'object', method: 'execute_kw', args: [db, uid, password, model, method, args, kwargs] },
      id: 1,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const message = data?.error?.data?.message || data?.error?.message || `Odoo execute_kw ${model}.${method} failed (${res.status})`;
    throw new Error(message);
  }
  return data.result;
}

async function odooAuthenticate(url, db, login, password) {
  const res = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service: 'common', method: 'login', args: [db, login, password] },
      id: 1,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error || !data?.result) {
    const message = data?.error?.data?.message || data?.error?.message || `Odoo login failed (${res.status})`;
    throw new Error(message);
  }
  return data.result;
}

function makeSyntheticProjectRoleRow(projectRow, employee, roleType = 'dev', index = 0) {
  const extra = parseJsonObject(projectRow?.extra);
  const projectSourceId = String(extra.source_service_id || extra.source_id || '').trim();
  const employeeId = String(employee?.id || '').trim();
  const employeeName = normalizeMasterString(employee?.name || `Employee ${employeeId || index + 1}`);
  const email = String(employee?.work_email || '').trim();
  return {
    id: `synthetic_role_${projectRow?.code || projectRow?.id || 'project'}_${roleType}_${employeeId || index + 1}`,
    table_name: 'hd_project_member_roles',
    code: `${projectRow?.code || projectRow?.id || 'project'}-${roleType}-${employeeId || index + 1}`,
    name: employeeName,
    extra: JSON.stringify({
      project_id: projectSourceId ? `odoo_hd_project_${projectSourceId}` : '',
      project_code: String(projectRow?.code || '').trim(),
      project_name: String(projectRow?.name || '').trim(),
      service_id: projectSourceId,
      role_type: roleType,
      position_name: roleType.toUpperCase(),
      person_id: employeeId,
      person_code: employeeId,
      person_name: employeeName,
      employee_id: employeeId,
      employee_name: employeeName,
      email,
      team_id: projectSourceId,
      team_name_th: String(projectRow?.name || '').trim(),
      source: 'odoo-live',
      source_model: 'tcp.mdm.service',
      source_service_id: projectSourceId,
    }),
    active: true,
    sort_order: roleType === 'pm' ? index : 100 + index,
  };
}

function makeSyntheticProjectDevRow(projectRow, employee, index = 0) {
  const extra = parseJsonObject(projectRow?.extra);
  const projectSourceId = String(extra.source_service_id || extra.source_id || '').trim();
  const employeeId = String(employee?.id || '').trim();
  const employeeName = normalizeMasterString(employee?.name || `Employee ${employeeId || index + 1}`);
  return {
    id: `synthetic_dev_${projectRow?.code || projectRow?.id || 'project'}_${employeeId || index + 1}`,
    table_name: 'hd_projects_dev',
    code: employeeId || `${projectRow?.code || 'project'}-dev-${index + 1}`,
    name: employeeName,
    extra: JSON.stringify({
      employee_id: employeeId,
      employee_name: employeeName,
      parent_project: String(projectRow?.code || '').trim(),
      parent_project_ref: String(projectRow?.name || '').trim(),
      project_id: projectSourceId,
      project_code: String(projectRow?.code || '').trim(),
      project_name: String(projectRow?.name || '').trim(),
      service_id: projectSourceId,
      source: 'odoo-live',
      source_model: 'tcp.mdm.service',
      source_service_id: projectSourceId,
    }),
    active: true,
    sort_order: index,
  };
}

async function augmentProjectAssignmentsFromOdoo(env, rowsByTable) {
  const projects = Array.isArray(rowsByTable.hd_projects) ? rowsByTable.hd_projects : [];
  if (!projects.length) return;

  const cfg = getOdooRuntimeConfig(env);
  if (!cfg.url || !cfg.db || !cfg.login || !cfg.password) return;

  try {
    const uid = await odooAuthenticate(cfg.url, cfg.db, cfg.login, cfg.password);
    if (!rowsByTable.hd_project_member_roles) rowsByTable.hd_project_member_roles = [];
    if (!rowsByTable.hd_projects_dev) rowsByTable.hd_projects_dev = [];
    for (const projectRow of projects) {
      const extra = parseJsonObject(projectRow?.extra);
      const serviceId = Number(extra.source_service_id || extra.source_id || 0);
      if (!serviceId) continue;
      const projectCode = String(projectRow?.code || '').trim().toUpperCase();
      const serviceRows = await odooExecuteKw(cfg.url, cfg.db, uid, cfg.password, 'tcp.mdm.service', 'read', [[serviceId]], {
        fields: ['service_code', 'service_name', 'pm_employee_ids', 'service_dev_ids'],
      });
      const service = Array.isArray(serviceRows) ? serviceRows[0] : null;
      if (!service) continue;
      const pmIds = Array.isArray(service.pm_employee_ids) ? service.pm_employee_ids.map((value) => Number(value)).filter(Boolean) : [];
      const devIds = Array.isArray(service.service_dev_ids) ? service.service_dev_ids.map((value) => Number(value)).filter(Boolean) : [];
      const employeeIds = [...new Set([...pmIds, ...devIds])];
      if (!employeeIds.length) continue;

      // service_dev_ids points to tcp.mdm.service.dev rows, not hr.employee rows.
      const serviceDevRows = devIds.length
        ? await odooExecuteKw(cfg.url, cfg.db, uid, cfg.password, 'tcp.mdm.service.dev', 'search_read', [[['service_id', '=', serviceId]]], {
          fields: ['id', 'name', 'display_name', 'service_id'],
        })
        : [];
      const devEmployeesByServiceRowId = new Map((Array.isArray(serviceDevRows) ? serviceDevRows : []).map((row) => {
        const nameValue = Array.isArray(row?.name) ? row.name : [];
        const employeeId = Number(nameValue[0] || 0);
        const employeeName = String(nameValue[1] || row?.display_name || row?.name || '').trim();
        return [Number(row?.id || 0), { id: employeeId || Number(row?.id || 0), name: employeeName }];
      }).filter(([id, employee]) => id && employee.name));

      const employeeRows = await odooExecuteKw(cfg.url, cfg.db, uid, cfg.password, 'hr.employee', 'read', [employeeIds], {
        fields: ['name', 'work_email'],
      });
      const employeesById = new Map((Array.isArray(employeeRows) ? employeeRows : []).map((row) => [Number(row?.id || 0), row]));

      // Odoo is the source of truth for current Dev membership. Remove stale
      // local rows and refresh names that were previously stored as mojibake.
      const currentDevEmployeeIds = new Set(Array.from(devEmployeesByServiceRowId.values()).map((employee) => String(employee.id)));
      const sameProjectRow = (row) => {
        const rowExtra = parseJsonObject(row?.extra);
        const rowProjectCode = String(rowExtra.project_code || rowExtra.parent_project || row?.code || '').trim().toUpperCase();
        const rowServiceId = String(rowExtra.project_id || rowExtra.service_id || rowExtra.source_service_id || '').trim();
        return (projectCode && rowProjectCode === projectCode) || (rowServiceId && rowServiceId === String(serviceId));
      };
      const rowEmployeeId = (row) => {
        const rowExtra = parseJsonObject(row?.extra);
        return String(rowExtra.employee_id || rowExtra.person_id || row?.employee_id || row?.person_id || row?.code || '').trim();
      };
      rowsByTable.hd_projects_dev = rowsByTable.hd_projects_dev.filter((row) => {
        if (!sameProjectRow(row)) return true;
        return currentDevEmployeeIds.has(rowEmployeeId(row));
      });
      rowsByTable.hd_project_member_roles = rowsByTable.hd_project_member_roles.filter((row) => {
        if (!sameProjectRow(row)) return true;
        const rowExtra = parseJsonObject(row?.extra);
        const role = String(rowExtra.role_type || rowExtra.position_name || row?.role_type || row?.position_name || '').trim().toLowerCase();
        if (role !== 'dev') return true;
        return currentDevEmployeeIds.has(rowEmployeeId(row));
      });
      const refreshDevRowName = (row, employee) => {
        if (!row || !employee) return;
        const employeeName = normalizeMasterString(employee.name || '');
        const rowExtra = parseJsonObject(row.extra);
        row.name = employeeName;
        row.employee_name = employeeName;
        row.extra = JSON.stringify({
          ...rowExtra,
          employee_name: employeeName,
          person_name: employeeName,
          employee_id: String(employee.id || rowExtra.employee_id || ''),
        });
      };

      const hasProjectRole = (roleType, employeeId) => rowsByTable.hd_project_member_roles.some((row) => {
        const rowExtra = parseJsonObject(row?.extra);
        const rowProjectCode = String(rowExtra.project_code || row?.code || '').trim().toUpperCase();
        const rowServiceId = String(rowExtra.service_id || rowExtra.source_service_id || '').trim();
        const rowRole = String(rowExtra.role_type || rowExtra.position_name || row?.role_type || row?.position_name || '').trim().toLowerCase();
        const rowPersonId = String(rowExtra.person_id || rowExtra.employee_id || row?.person_id || row?.employee_id || '').trim();
        const rowName = String(rowExtra.person_name || rowExtra.employee_name || row?.person_name || row?.employee_name || row?.name || '').trim();
        const sameProject = (projectCode && rowProjectCode === projectCode) || (rowServiceId && rowServiceId === String(serviceId));
        return sameProject && rowRole === roleType && rowPersonId === String(employeeId) && !hasSuspiciousQuestionMarks(rowName);
      });
      const hasProjectDev = (employeeId) => rowsByTable.hd_projects_dev.some((row) => {
        const rowExtra = parseJsonObject(row?.extra);
        const rowProjectCode = String(rowExtra.project_code || rowExtra.parent_project || row?.code || '').trim().toUpperCase();
        const rowServiceId = String(rowExtra.project_id || rowExtra.service_id || rowExtra.source_service_id || '').trim();
        const rowPersonId = String(rowExtra.employee_id || rowExtra.person_id || row?.employee_id || row?.person_id || row?.code || '').trim();
        const rowName = String(rowExtra.employee_name || rowExtra.person_name || row?.employee_name || row?.person_name || row?.name || '').trim();
        const sameProject = (projectCode && rowProjectCode === projectCode) || (rowServiceId && rowServiceId === String(serviceId));
        return sameProject && rowPersonId === String(employeeId) && !hasSuspiciousQuestionMarks(rowName);
      });

      pmIds.forEach((employeeId, index) => {
        const employee = employeesById.get(employeeId);
        if (!employee || hasProjectRole('pm', employeeId)) return;
        rowsByTable.hd_project_member_roles.push(makeSyntheticProjectRoleRow(projectRow, employee, 'pm', index));
      });
      devIds.forEach((employeeId, index) => {
        const employee = devEmployeesByServiceRowId.get(employeeId) || employeesById.get(employeeId);
        if (!employee) return;
        rowsByTable.hd_projects_dev
          .filter((row) => sameProjectRow(row) && rowEmployeeId(row) === String(employee.id))
          .forEach((row) => refreshDevRowName(row, employee));
        rowsByTable.hd_project_member_roles
          .filter((row) => sameProjectRow(row) && rowEmployeeId(row) === String(employee.id))
          .forEach((row) => refreshDevRowName(row, employee));
        if (!hasProjectRole('dev', employee.id)) {
          rowsByTable.hd_project_member_roles.push(makeSyntheticProjectRoleRow(projectRow, employee, 'dev', index));
        }
        if (!hasProjectDev(employee.id)) {
          rowsByTable.hd_projects_dev.push(makeSyntheticProjectDevRow(projectRow, employee, index));
        }
      });
    }
  } catch {}
}

function parseOdooMany2One(value) {
  if (Array.isArray(value)) {
    const [id, name] = value;
    return { id: String(id || '').trim(), name: normalizeMasterString(name || '') };
  }
  if (value && typeof value === 'object') {
    return {
      id: String(value.id || value.res_id || value.value || '').trim(),
      name: normalizeMasterString(value.display_name || value.name || value.value || ''),
    };
  }
  const text = String(value || '').trim();
  return { id: text, name: text };
}

function parseOdooMany2ManyIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    if (Array.isArray(item) && item.length) {
      const id = Number(item[0]);
      if (Number.isFinite(id) && id > 0) ids.push(id);
      continue;
    }
    if (item && typeof item === 'object') {
      const id = Number(item.id || item.res_id || item.value || 0);
      if (Number.isFinite(id) && id > 0) ids.push(id);
      continue;
    }
    const id = Number(item);
    if (Number.isFinite(id) && id > 0) ids.push(id);
  }
  return [...new Set(ids)];
}

function buildProjectLookup(rowsByTable) {
  const projects = Array.isArray(rowsByTable.hd_projects) ? rowsByTable.hd_projects : [];
  const lookup = new Map();
  for (const row of projects) {
    const extra = parseJsonObject(row?.extra);
    const projectId = String(row?.id || '').trim();
    const sourceId = String(extra.source_service_id || extra.source_id || extra.external_id || '').trim();
    const code = String(row?.code || extra.project_code || extra.service_code || '').trim();
    const name = String(row?.name || extra.project_name || extra.service_name || '').trim();
    for (const key of [projectId, sourceId, code, name].filter(Boolean)) {
      const token = String(key).trim().toUpperCase();
      if (!lookup.has(token)) {
        lookup.set(token, { id: projectId, source_id: sourceId, code, name, row });
      }
    }
  }
  return lookup;
}

function makeSlaRowId(sourceId, projectPart) {
  const projectKey = String(projectPart || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'global';
  const priorityKey = String(sourceId || '').trim();
  return `hd_sla_odoo_${projectKey}_${priorityKey}`;
}

function buildCaseTypeLookup(caseTypeRows) {
  const lookup = new Map();
  for (const row of Array.isArray(caseTypeRows) ? caseTypeRows : []) {
    const id = String(row?.id || '').trim();
    const name = normalizeMasterString(row?.name || row?.code || '');
    if (!id) continue;
    lookup.set(Number(id) || id, name);
    lookup.set(id, name);
  }
  return lookup;
}

async function augmentPriorityFromOdoo(env, rowsByTable) {
  const cfg = getOdooRuntimeConfig(env);
  if (!cfg.url || !cfg.db || !cfg.login || !cfg.password) return;

  try {
    const uid = await odooAuthenticate(cfg.url, cfg.db, cfg.login, cfg.password);
    const priorityIds = await odooExecuteKw(cfg.url, cfg.db, uid, cfg.password, 'tcp.mdm.priority', 'search', [[]], {
      order: 'project_id asc, priority_level asc, id asc',
    });
    const priorityRows = Array.isArray(priorityIds) && priorityIds.length
      ? await odooExecuteKw(cfg.url, cfg.db, uid, cfg.password, 'tcp.mdm.priority', 'read', [priorityIds], {
          fields: [
            'id',
            'project_id',
            'priority_level',
            'priority_name',
            'priority_detail',
            'priority_duration_day',
            'priority_duration_hours',
            'priority_duration_minute',
            'priority_finish_day',
            'priority_finish_hours',
            'priority_finish_minute',
            'priority_tm',
            'case_type_ids',
            'active',
          ],
        })
      : [];
    const caseTypeIds = [...new Set(
      priorityRows.flatMap((row) => parseOdooMany2ManyIds(row?.case_type_ids))
    )];
    const caseTypeRows = caseTypeIds.length
      ? await odooExecuteKw(cfg.url, cfg.db, uid, cfg.password, 'tcp.mdm.case.type', 'read', [caseTypeIds], {
          fields: ['id', 'name'],
        })
      : [];
    const caseTypeLookup = buildCaseTypeLookup(caseTypeRows);
    const projectLookup = buildProjectLookup(rowsByTable);

    const syncedRows = [];
    for (const row of Array.isArray(priorityRows) ? priorityRows : []) {
      const priorityId = String(row?.id || '').trim();
      if (!priorityId) continue;
      const projectRef = parseOdooMany2One(row?.project_id);
      const projectLookupRow = projectLookup.get(String(projectRef.id || projectRef.name || '').trim().toUpperCase()) || null;
      const projectCode = projectLookupRow?.code || projectRef.name || projectRef.id || '';
      const projectName = projectLookupRow?.name || projectRef.name || projectRef.id || '';
      const caseTypeIdsForRow = parseOdooMany2ManyIds(row?.case_type_ids);
      const caseTypeNames = caseTypeIdsForRow
        .map((id) => caseTypeLookup.get(Number(id)) || caseTypeLookup.get(String(id)) || '')
        .filter(Boolean);
      const responseDuration = {
        day: Number.parseInt(String(row?.priority_duration_day ?? ''), 10) || 0,
        hours: Number.parseInt(String(row?.priority_duration_hours ?? ''), 10) || 0,
        minute: Number.parseInt(String(row?.priority_duration_minute ?? ''), 10) || 0,
      };
      const finishDuration = {
        day: Number.parseInt(String(row?.priority_finish_day ?? ''), 10) || 0,
        hours: Number.parseInt(String(row?.priority_finish_hours ?? ''), 10) || 0,
        minute: Number.parseInt(String(row?.priority_finish_minute ?? ''), 10) || 0,
      };
      const extra = {
        source: 'odoo',
        source_model: 'tcp.mdm.priority',
        source_id: priorityId,
        external_id: priorityId,
        project_id: projectRef.id || '',
        project_ref: projectRef.name || projectRef.id || '',
        project_code: projectCode || '',
        project_name: projectName || '',
        priority_level: String(row?.priority_level || '').trim(),
        priority_name: normalizeMasterString(row?.priority_name || row?.priority_level || ''),
        priority_detail: normalizeMasterString(row?.priority_detail || ''),
        priority_duration_day: responseDuration.day,
        priority_duration_hours: responseDuration.hours,
        priority_duration_minute: responseDuration.minute,
        priority_finish_day: finishDuration.day,
        priority_finish_hours: finishDuration.hours,
        priority_finish_minute: finishDuration.minute,
        priority_tm: String(row?.priority_tm || '').trim(),
        case_type_ids: caseTypeIdsForRow,
        case_type_names: caseTypeNames,
        active: row?.active !== false,
      };
      const dbRow = {
        id: makeSlaRowId(priorityId, projectCode || projectRef.id || projectRef.name),
        table_name: 'hd_sla',
        code: String(row?.priority_level || priorityId).trim(),
        name: normalizeMasterString(row?.priority_name || row?.priority_level || priorityId),
        extra: JSON.stringify(extra),
        active: row?.active !== false,
        sort_order: Number.parseInt(String(row?.priority_level || '').replace(/[^\d]/g, ''), 10) || 0,
      };
      syncedRows.push(dbRow);
    }

    await pgQuery(env, `DELETE FROM hd_master WHERE table_name='hd_sla' AND id LIKE 'hd_sla_odoo_%'`);
    for (const row of syncedRows) {
      await pgQuery(
        env,
        `INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           table_name = EXCLUDED.table_name,
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           extra = EXCLUDED.extra,
           active = EXCLUDED.active,
           sort_order = EXCLUDED.sort_order,
           updated_at = now()`,
        [row.id, row.table_name, row.code, row.name, row.extra, row.active, row.sort_order]
      );
    }

    const existingRows = Array.isArray(rowsByTable.hd_sla) ? rowsByTable.hd_sla : [];
    rowsByTable.hd_sla = [
      ...existingRows.filter((row) => !String(row?.id || '').startsWith('hd_sla_odoo_')),
      ...syncedRows,
    ];
  } catch (error) {
    console.warn('Failed to sync Odoo priorities', error);
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function cleanContextText(value) {
  return String(value || '').trim();
}

function normalizeProjectToken(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function rowProjectTokens(row) {
  const extra = parseJsonObject(row?.extra);
  return [
    row?.code,
    row?.name,
    row?.id,
    row?.project_ref,
    row?.project_ref_name,
    row?.projectCode,
    row?.projectName,
    row?.project_id,
    row?.project_code,
    row?.parent_project,
    row?.parent_project_ref,
    row?.service_id,
    row?.service_code,
    extra.source_id,
    extra.project_id,
    extra.project_code,
    extra.service_id,
    extra.service_code,
    extra.project_sync_id,
    extra.parent_project,
    extra.parent_project_ref,
    extra.project_ref,
    extra.project_ref_name,
  ]
    .map(cleanContextText)
    .filter(Boolean);
}

function matchesMasterProjectScope(row) {
  const tokens = rowProjectTokens(row);
  if (!tokens.length) return false;
  return tokens.some((token) => {
    const compact = normalizeProjectToken(token);
    if (!compact) return false;
    if (MASTER_PROJECT_ALIASES.has(token.toUpperCase())) return true;
    if (MASTER_PROJECT_ALIASES.has(compact)) return true;
    if (compact.includes('SARABUN')) return true;
    if (compact.includes('BMAROD')) return true;
    return false;
  });
}

function buildScopedProjectTokenSet(rows) {
  const tokens = new Set();
  for (const row of rows || []) {
    for (const token of rowProjectTokens(row)) {
      tokens.add(cleanContextText(token).toUpperCase());
      tokens.add(normalizeProjectToken(token));
    }
  }
  return tokens;
}

function rowMatchesProjectTokenSet(row, tokenSet) {
  const tokens = rowProjectTokens(row);
  if (!tokens.length) return false;
  return tokens.some((token) => tokenSet.has(token.toUpperCase()) || tokenSet.has(normalizeProjectToken(token)));
}

function filterTableRowsByProjectScope(rowsByTable) {
  const scopedProjects = (rowsByTable.hd_projects || []).filter(matchesMasterProjectScope);
  const projectTokenSet = buildScopedProjectTokenSet(scopedProjects);
  const projectLikeTables = [
    'hd_projects',
    'hd_sub_projects',
    'hd_projects_dev',
    'hd_project_member_roles',
    'hd_main_team_project',
    'hd_flow_areas',
    'hd_sla',
  ];
  for (const tableName of projectLikeTables) {
    const rows = rowsByTable[tableName] || [];
    if (tableName === 'hd_projects') {
      rowsByTable[tableName] = scopedProjects;
      continue;
    }
    rowsByTable[tableName] = rows.filter((row) => rowMatchesProjectTokenSet(row, projectTokenSet));
  }
  return rowsByTable;
}

function buildMasterContextIndexes(rowsByTable, employeeMapRows = [], systemUsers = []) {
  const projects = rowsByTable.hd_projects || [];
  const subProjects = rowsByTable.hd_sub_projects || [];
  const teams = rowsByTable.hd_teams || [];
  const positions = rowsByTable.hd_positions || [];
  const projectDevs = rowsByTable.hd_projects_dev || [];
  const memberRoles = rowsByTable.hd_project_member_roles || [];
  const flowAreas = rowsByTable.hd_flow_areas || [];
  const criteria = rowsByTable.hd_criteria || [];
  const subCriteria = rowsByTable.hd_sub_criteria || [];
  const sla = rowsByTable.hd_sla || [];
  const mainTeamProjects = rowsByTable.hd_main_team_project || [];
  const users = rowsByTable.hd_users || [];

  const by = (rows, pick) => {
    const out = {};
    for (const row of rows) {
      const key = cleanContextText(pick(row));
      if (!key) continue;
      if (!out[key]) out[key] = [];
      out[key].push(row);
    }
    return out;
  };
  const first = (rows, pick) => {
    const out = {};
    for (const row of rows) {
      const key = cleanContextText(pick(row));
      if (!key || out[key]) continue;
      out[key] = row;
    }
    return out;
  };
  const extraOf = (row) => parseJsonObject(row?.extra);
  const projectKeyList = (row) => {
    const extra = extraOf(row);
    return [
      row?.id,
      row?.code,
      extra.source_id,
      extra.project_id,
      extra.project_code,
      extra.service_id,
    ].map(cleanContextText).filter(Boolean);
  };

  return {
    projectsByCode: first(projects, (row) => row.code || extraOf(row).project_code || row.id || extraOf(row).source_id || ''),
    projectsById: first(projects, (row) => row.id || extraOf(row).source_id || row.code || ''),
    subProjectsByCode: first(subProjects, (row) => row.code || extraOf(row).sub_project_code || row.id || ''),
    subProjectsByParent: by(subProjects, (row) => extraOf(row).parent_project || extraOf(row).parent_project_ref || extraOf(row).project_id || extraOf(row).service_id || ''),
    teamsByCode: first(teams, (row) => row.code || extraOf(row).team_code || row.id || ''),
    teamsById: first(teams, (row) => row.id || extraOf(row).source_id || row.code || ''),
    positionsByCode: first(positions, (row) => row.code || row.id || ''),
    positionsById: first(positions, (row) => row.id || row.code || ''),
    devsByProject: by(projectDevs, (row) => extraOf(row).parent_project || extraOf(row).project_id || extraOf(row).service_id || ''),
    memberRolesByProject: by(memberRoles, (row) => extraOf(row).project_id || ''),
    areasByProject: by(flowAreas, (row) => extraOf(row).project_id || extraOf(row).project_ref || ''),
    mainTeamProjectsByProject: by(mainTeamProjects, (row) => extraOf(row).project_id || extraOf(row).project_ref || ''),
    usersByEmployeeId: first(users, (row) => extraOf(row).source_id || extraOf(row).employee_id || row.code || row.id || ''),
    usersByEmail: first(users, (row) => extraOf(row).email || row.email || ''),
    usersByCode: first(users, (row) => row.code || row.id || ''),
    employeeMapByEmployeeId: first(employeeMapRows, (row) => row.odoo_employee_id || ''),
    systemUsersById: first(systemUsers, (row) => row.id || ''),
  };
}

async function loadMasterContext(env, scope = 'helpdesk') {
  const normalizedScope = String(scope || 'helpdesk').trim().toLowerCase();
  const scopeTables = {
    helpdesk: ['hd_users', 'hd_projects', 'hd_sub_projects', 'hd_teams', 'hd_projects_dev', 'hd_project_member_roles', 'hd_flow_areas', 'hd_flow_case_types', 'hd_flow_products', 'hd_criteria', 'hd_sub_criteria', 'hd_sla'],
    admin: ['hd_users', 'hd_projects', 'hd_sub_projects', 'hd_teams', 'hd_projects_dev', 'hd_project_member_roles', 'hd_flow_areas', 'hd_flow_case_types', 'hd_flow_products', 'hd_criteria', 'hd_sub_criteria', 'hd_sla', 'hd_positions', 'hd_main_team_project'],
  };
  const tables = scopeTables[normalizedScope] || scopeTables.helpdesk;
  await ensureOdooEmployeeMap(env);
  const rowsByTable = {};
  await Promise.all(tables.map(async (tableName) => {
    try {
      rowsByTable[tableName] = await pgQuery(env, `
        SELECT id, table_name, code, name, extra, active, sort_order, created_at, updated_at
        FROM hd_master
        WHERE table_name=$1
        ORDER BY sort_order ASC, name ASC
      `, [tableName]);
    } catch {
      rowsByTable[tableName] = [];
    }
  }));
  const users = rowsByTable.hd_users || [];
  const projectDevs = rowsByTable.hd_projects_dev || [];
  if (projectDevs.length) {
    try {
      rowsByTable.hd_projects_dev = await pgQuery(env, `
        SELECT
          h.id, h.table_name, h.code, h.name, h.extra, h.active, h.sort_order, h.created_at, h.updated_at,
          COALESCE(h.extra::jsonb->>'employee_id', h.code, '') AS employee_id,
          COALESCE(m.employee_name, h.name) AS employee_name,
          COALESCE(h.extra::jsonb->>'parent_project', h.extra::jsonb->>'project_id', h.extra::jsonb->>'service_id', '') AS project_ref,
          COALESCE(h.extra::jsonb->>'parent_project_ref', h.extra::jsonb->>'project_ref', h.extra::jsonb->>'service_ref', '') AS project_ref_name
        FROM hd_master h
        LEFT JOIN odoo_employee_map m ON m.odoo_employee_id = COALESCE(h.extra::jsonb->>'employee_id', h.code)
        WHERE h.table_name='hd_projects_dev'
        ORDER BY h.sort_order ASC, h.name ASC
      `);
    } catch {
      rowsByTable.hd_projects_dev = projectDevs;
    }
  }
  const [employeeMapRows, systemUsers] = await Promise.all([
    pgQuery(env, `SELECT odoo_employee_id, employee_name, employee_ref, source_user_id, email, updated_at FROM odoo_employee_map ORDER BY employee_name, odoo_employee_id`),
    pgQuery(env, `SELECT id,email,username,full_name,role,department,is_active,must_change_password,access_mode,access_json,account_type,user_expires_at,temp_password_sent_at,created_at,updated_at FROM users ORDER BY full_name`),
  ]);
  await augmentProjectAssignmentsFromOdoo(env, rowsByTable);
  await augmentPriorityFromOdoo(env, rowsByTable);
  filterTableRowsByProjectScope(rowsByTable);
  const indexes = buildMasterContextIndexes(rowsByTable, employeeMapRows, systemUsers);
  return {
    scope: normalizedScope,
    generated_at: new Date().toISOString(),
    tables: rowsByTable,
    users,
    projects: rowsByTable.hd_projects || [],
    sub_projects: rowsByTable.hd_sub_projects || [],
    teams: rowsByTable.hd_teams || [],
    positions: rowsByTable.hd_positions || [],
    project_devs: rowsByTable.hd_projects_dev || [],
    project_member_roles: rowsByTable.hd_project_member_roles || [],
    flow_areas: rowsByTable.hd_flow_areas || [],
    flow_case_types: rowsByTable.hd_flow_case_types || [],
    flow_products: rowsByTable.hd_flow_products || [],
    criteria: rowsByTable.hd_criteria || [],
    sub_criteria: rowsByTable.hd_sub_criteria || [],
    sla: rowsByTable.hd_sla || [],
    main_team_project: rowsByTable.hd_main_team_project || [],
    employee_map: employeeMapRows,
    system_users: systemUsers,
    indexes,
  };
}

export async function handleMasterData(path, method, request, env) {
  const url = new URL(request.url);

  if (path === '/hd-context' && method === 'GET') {
    if (usePgProxyBackend(env)) {
      return proxyToPgApi(request, env, url.pathname + url.search);
    }
    await requireAuth(request, env);
    const scope = String(url.searchParams.get('scope') || 'helpdesk').trim().toLowerCase();
    try {
      const context = await loadMasterContext(env, scope);
      return json({ ok: true, data: context });
    } catch (contextErr) {
      return err('Failed to load master context: ' + (contextErr?.message || String(contextErr)), 500);
    }
  }

  if (path === '/hd-master') {
    if (usePgProxyBackend(env)) {
      return proxyToPgApi(request, env, url.pathname + url.search);
    }
    if (useHyperdriveBackend(env) || backendMode(env) === 'd1') {
      const tbl = (url.searchParams.get('table') || '').trim();
      if (!tbl || !HD_VALID_TABLES.has(tbl)) return err('Invalid table name', 400);
      if (!(method === 'GET' && HD_PUBLIC_READ_TABLES.has(tbl))) {
        await requireAuth(request, env);
      }

      if (method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (tbl === 'hd_projects_dev') {
          await ensureOdooEmployeeMap(env);
        }
        const isD1 = backendMode(env) === 'd1';
        const rows = q
          ? await pgQuery(
              env,
              tbl === 'hd_projects_dev'
                ? (isD1
                    ? `SELECT
                         h.id, h.table_name, h.code, h.name, h.extra, h.active, h.sort_order, h.created_at, h.updated_at,
                         COALESCE(json_extract(h.extra, '$.employee_id'), h.code, '') AS employee_id,
                         COALESCE(m.employee_name, h.name) AS employee_name,
                         COALESCE(json_extract(h.extra, '$.parent_project'), json_extract(h.extra, '$.project_id'), json_extract(h.extra, '$.service_id'), '') AS project_ref,
                         COALESCE(json_extract(h.extra, '$.parent_project_ref'), json_extract(h.extra, '$.project_ref'), json_extract(h.extra, '$.service_ref'), '') AS project_ref_name
                       FROM hd_master h
                       LEFT JOIN odoo_employee_map m ON m.odoo_employee_id = COALESCE(json_extract(h.extra, '$.employee_id'), h.code)
                       WHERE h.table_name=$1 AND (
                         h.name LIKE $2
                         OR h.code LIKE $2
                         OR COALESCE(json_extract(h.extra, '$.parent_project'), json_extract(h.extra, '$.project_id'), json_extract(h.extra, '$.service_id'), '') LIKE $2
                         OR COALESCE(json_extract(h.extra, '$.parent_project_ref'), json_extract(h.extra, '$.project_ref'), json_extract(h.extra, '$.service_ref'), '') LIKE $2
                       )
                       ORDER BY h.sort_order ASC, h.name ASC`
                    : `SELECT
                         h.id, h.table_name, h.code, h.name, h.extra, h.active, h.sort_order, h.created_at, h.updated_at,
                         COALESCE(h.extra::jsonb->>'employee_id', h.code, '') AS employee_id,
                         COALESCE(m.employee_name, h.name) AS employee_name,
                         COALESCE(h.extra::jsonb->>'parent_project', h.extra::jsonb->>'project_id', h.extra::jsonb->>'service_id', '') AS project_ref,
                         COALESCE(h.extra::jsonb->>'parent_project_ref', h.extra::jsonb->>'project_ref', h.extra::jsonb->>'service_ref', '') AS project_ref_name
                       FROM hd_master h
                       LEFT JOIN odoo_employee_map m ON m.odoo_employee_id = COALESCE(h.extra::jsonb->>'employee_id', h.code)
                       WHERE h.table_name=$1 AND (
                         h.name ILIKE $2
                         OR h.code ILIKE $2
                         OR COALESCE(h.extra::jsonb->>'parent_project', h.extra::jsonb->>'project_id', h.extra::jsonb->>'service_id', '') ILIKE $2
                         OR COALESCE(h.extra::jsonb->>'parent_project_ref', h.extra::jsonb->>'project_ref', h.extra::jsonb->>'service_ref', '') ILIKE $2
                       )
                       ORDER BY h.sort_order ASC, h.name ASC`)
                : `SELECT id, table_name, code, name, extra, active, sort_order, created_at, updated_at
                   FROM hd_master
                   WHERE table_name=$1 AND (name ILIKE $2 OR code ILIKE $2)
                   ORDER BY sort_order ASC, name ASC`,
              [tbl, `%${q}%`]
            )
          : await pgQuery(
              env,
              tbl === 'hd_projects_dev'
                ? (isD1
                    ? `SELECT
                         h.id, h.table_name, h.code, h.name, h.extra, h.active, h.sort_order, h.created_at, h.updated_at,
                         COALESCE(json_extract(h.extra, '$.employee_id'), h.code, '') AS employee_id,
                         COALESCE(m.employee_name, h.name) AS employee_name,
                         COALESCE(json_extract(h.extra, '$.parent_project'), json_extract(h.extra, '$.project_id'), json_extract(h.extra, '$.service_id'), '') AS project_ref,
                         COALESCE(json_extract(h.extra, '$.parent_project_ref'), json_extract(h.extra, '$.project_ref'), json_extract(h.extra, '$.service_ref'), '') AS project_ref_name
                       FROM hd_master h
                       LEFT JOIN odoo_employee_map m ON m.odoo_employee_id = COALESCE(json_extract(h.extra, '$.employee_id'), h.code)
                       WHERE h.table_name=$1
                       ORDER BY h.sort_order ASC, h.name ASC`
                    : `SELECT
                         h.id, h.table_name, h.code, h.name, h.extra, h.active, h.sort_order, h.created_at, h.updated_at,
                         COALESCE(h.extra::jsonb->>'employee_id', h.code, '') AS employee_id,
                         COALESCE(m.employee_name, h.name) AS employee_name,
                         COALESCE(h.extra::jsonb->>'parent_project', h.extra::jsonb->>'project_id', h.extra::jsonb->>'service_id', '') AS project_ref,
                         COALESCE(h.extra::jsonb->>'parent_project_ref', h.extra::jsonb->>'project_ref', h.extra::jsonb->>'service_ref', '') AS project_ref_name
                       FROM hd_master h
                       LEFT JOIN odoo_employee_map m ON m.odoo_employee_id = COALESCE(h.extra::jsonb->>'employee_id', h.code)
                       WHERE h.table_name=$1
                       ORDER BY h.sort_order ASC, h.name ASC`)
                : `SELECT id, table_name, code, name, extra, active, sort_order, created_at, updated_at
                   FROM hd_master
                   WHERE table_name=$1
                   ORDER BY sort_order ASC, name ASC`,
              [tbl]
            );
        return json({ ok: true, data: rows.map((row) => sanitizeRowForResponse(row)) });
      }

      if (method === 'POST') {
        const b = sanitizeHdMasterPayload(await request.json());
        const id = tbl + '_' + uid().slice(0, 10);
        await pgQuery(
          env,
          `INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
          [id, tbl, b.code || '', b.name || '', b.extra || '{}', b.active, b.sort_order]
        );
        return json({ ok: true, id });
      }

      if (method === 'DELETE' && url.searchParams.get('action') === 'clear') {
        await pgQuery(env, `DELETE FROM hd_master WHERE table_name=$1`, [tbl]);
        return json({ ok: true });
      }
    }
  }

  if (path.startsWith('/hd-master/')) {
    if (usePgProxyBackend(env)) {
      return proxyToPgApi(request, env, url.pathname + url.search);
    }
    await requireAuth(request, env);
    const id = path.split('/')[2];
    if (!id) return err('Invalid id', 400);

    if (method === 'PUT') {
      const b = sanitizeHdMasterPayload(await request.json());
      await pgQuery(env, `UPDATE hd_master SET code=$1, name=$2, extra=$3, active=$4, sort_order=$5, updated_at=now() WHERE id=$6`,
        [b.code || '', b.name || '', b.extra || '{}', b.active, b.sort_order, id]);
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      await pgQuery(env, `DELETE FROM hd_master WHERE id=$1`, [id]);
      return json({ ok: true });
    }
  }

  return null;
}
