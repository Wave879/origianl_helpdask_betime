/**
 * Compatibility routes for legacy Frappe-style frontend calls.
 * These keep older pages functional while the Worker API remains the source of truth.
 */

import { pgQuery } from '../db.js';
import { json, err, uid } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeFields(fields) {
  return Array.isArray(fields) ? fields.map((field) => String(field || '').trim()).filter(Boolean) : [];
}

function projectFields(row, fields) {
  if (!fields.length) return row;
  const out = {};
  for (const field of fields) {
    if (field === 'name') out.name = row.name ?? row.id ?? '';
    else out[field] = row[field] ?? '';
  }
  return out;
}

async function handleGetList(request, env) {
  await requireAuth(request, env);
  const body = await readJson(request);
  const doctype = String(body.doctype || '').trim().toLowerCase();
  const fields = normalizeFields(body.fields);
  const limit = Math.max(1, Math.min(100, Number(body.limit_page_length || body.limit || 20) || 20));

  if (doctype === 'employee profile' || doctype === 'user') {
    const rows = await pgQuery(env, `
      SELECT id, id AS name, full_name, email, username, role, department, is_active
      FROM users
      WHERE is_active=1
      ORDER BY full_name
      LIMIT $1
    `, [limit]);
    return json(rows.map((row) => projectFields(row, fields)));
  }

  if (doctype === 'project') {
    const rows = await pgQuery(env, `
      SELECT id, id AS name, project_name, status, progress, risk_level, deadline
      FROM projects
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return json(rows.map((row) => projectFields(row, fields)));
  }

  if (doctype === 'task') {
    const rows = await pgQuery(env, `
      SELECT id, id AS name, task_name, status, priority, deadline, assigned_to
      FROM tasks
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return json(rows.map((row) => projectFields(row, fields)));
  }

  if (doctype === 'smart calendar' || doctype === 'calendar event') {
    const rows = await pgQuery(env, `
      SELECT id, id AS name, title, start_datetime, end_datetime, location
      FROM calendar_events
      ORDER BY start_datetime DESC
      LIMIT $1
    `, [limit]);
    return json(rows.map((row) => projectFields(row, fields)));
  }

  return json([]);
}

async function handleInsert(request, env) {
  const session = await requireAuth(request, env);
  const body = await readJson(request);
  const doc = body.doc && typeof body.doc === 'object' ? body.doc : {};
  const doctype = String(doc.doctype || '').trim().toLowerCase();

  if (doctype === 'smart calendar' || doctype === 'calendar event') {
    const id = 'evt_' + uid().slice(0, 8);
    await pgQuery(env, `
      INSERT INTO calendar_events (id,title,start_datetime,end_datetime,location,created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      id,
      doc.title || 'Event',
      doc.start_datetime || null,
      doc.end_datetime || null,
      doc.room || doc.location || '',
      session.user_id,
    ]);
    return json({ ok: true, name: id, message: { name: id } });
  }

  return err('Unsupported legacy doctype', 400);
}

function portalStub(path, body) {
  const method = String(path || '').split(/[/.]/).pop();
  if (method === 'check_ai_config') {
    return { openai: false, stt: false, doc: false, search: false };
  }
  if (method === 'help_desk_chat') {
    return { ok: true, reply: 'ระบบช่วยเหลือพร้อมใช้งาน กรุณาระบุรายละเอียดที่ต้องการให้ช่วยตรวจสอบ' };
  }
  if (method === 'smart_draft') {
    return { ok: true, draft: String(body.prompt || body.context || '').trim() || 'Draft content' };
  }
  if (method === 'run_ocr') {
    return { ok: true, text: '', message: 'OCR endpoint is available' };
  }
  if (method === 'process_audio_stt') {
    return { ok: true, transcript: '', message: 'STT endpoint is available' };
  }
  if (method === 'check_compliance_inline') {
    return { ok: true, score: null, issues: [], summary: 'Compliance checker is available' };
  }
  if (method === 'save_ocr_to_knowledge') {
    return { ok: true };
  }
  if (method === 'submit_ot_claim') {
    return { ok: true };
  }
  if (method === 'send_line_notification' || method === 'send_teams_notification' || method === 'send_email_alert') {
    return { ok: true };
  }
  return { ok: true };
}

export async function handleLegacy(path, method, request, env) {
  if (path === '/frappe.client.get_list' && method === 'POST') return handleGetList(request, env);
  if (path === '/frappe.client.insert' && method === 'POST') return handleInsert(request, env);

  if (path.startsWith('/betime_solution.api.portal.') && method === 'POST') {
    await requireAuth(request, env);
    const body = await readJson(request);
    return json(portalStub(path, body));
  }

  return null;
}
