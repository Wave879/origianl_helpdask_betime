/**
 * routes/helpdesk.js
 * POST /helpdesk/ticket, GET/PUT /helpdesk/tickets, migrate endpoints, /helpdesk/analyze
 */

import { pgQuery, pgFirst, backendMode } from '../db.js';
import { json, err, uid, tryParseJson } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { findRelevantKnowledge, findRelevantHelpdeskTickets, formatKnowledgeContext, formatHelpdeskTicketContext, readAssetText } from './ai-chat.js';

// ── Odoo helpers ─────────────────────────────────────────────────────

function isNumericOdooId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function extractOdooNumericId(value) {
  const text = String(value || '').trim();
  if (isNumericOdooId(text)) return text;
  const match = text.match(/_(\d+)(?:_[0-9a-f]+)?$/i);
  return match ? match[1] : '';
}

function pickOdooSourceId(row, fallback = '') {
  if (!row) return fallback;
  if (isNumericOdooId(row.source_id)) return String(row.source_id);
  try {
    const extra = typeof row.extra === 'string' ? JSON.parse(row.extra || '{}') : (row.extra || {});
    const sourceCandidates = [
      extra.source_id,
      extra.source_service_id,
      extra.source_sub_service_id,
      extra.source_project_id,
      extra.source_sub_project_id,
      extra.project_id,
      extra.service_id,
      extra.parent_project_id,
      extra.external_id,
    ];
    for (const candidate of sourceCandidates) {
      if (isNumericOdooId(candidate)) return String(candidate);
      const parsedSourceId = extractOdooNumericId(candidate);
      if (parsedSourceId) return parsedSourceId;
    }
  } catch {}
  const parsedRowId = extractOdooNumericId(row.id);
  if (parsedRowId) return parsedRowId;
  return fallback;
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

async function callOdooLookup(env, model, domain = [], fields = ['id', 'name']) {
  const cfg = getOdooRuntimeConfig(env);
  if (!cfg.url || !cfg.db || !cfg.login || !cfg.password) return [];
  let auth;
  try {
    auth = await odooRpcAuthenticate(cfg.url, cfg.db, cfg.login, cfg.password);
    auth.mode = 'session';
  } catch {
    auth = await odooJsonRpcLogin(cfg.url, cfg.db, cfg.login, cfg.password);
  }
  if (auth.mode === 'execute_kw') {
    return await odooExecuteKw(cfg.url, cfg.db, auth.uid, cfg.password, model, 'search_read', [domain], { fields, limit: 5 });
  }
  return await odooRpcCall(cfg.url, auth.session_id, model, 'search_read', [domain], { fields, limit: 5 });
}

async function resolveOdooIdByLiveLookup(env, model, { code = '', name = '', codeField = 'code', nameField = 'name', parentField = '', parentId = '' } = {}) {
  const rawCode = String(code || '').trim();
  const rawName = String(name || '').trim();
  const rawParentId = String(parentId || '').trim();
  const fieldList = ['id', nameField, codeField];
  if (parentField) fieldList.push(parentField);
  const attempts = [];
  if (rawCode) {
    const domain = [[codeField, '=', rawCode]];
    if (parentField && rawParentId) domain.push([parentField, '=', Number(rawParentId)]);
    attempts.push(domain);
  }
  if (rawName) {
    const domain = [[nameField, '=', rawName]];
    if (parentField && rawParentId) domain.push([parentField, '=', Number(rawParentId)]);
    attempts.push(domain);
  }
  if (rawCode) {
    const domain = [[codeField, 'ilike', rawCode]];
    if (parentField && rawParentId) domain.push([parentField, '=', Number(rawParentId)]);
    attempts.push(domain);
  }
  if (rawName) {
    const domain = [[nameField, 'ilike', rawName]];
    if (parentField && rawParentId) domain.push([parentField, '=', Number(rawParentId)]);
    attempts.push(domain);
  }
  for (const domain of attempts) {
    try {
      const rows = await callOdooLookup(env, model, domain, fieldList);
      const match = Array.isArray(rows) ? rows.find((row) => row && row.id) : null;
      if (match?.id) return String(match.id);
    } catch {}
  }
  return '';
}

function caseTypeDisplayLabel(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  const labels = {
    system_error: 'System Error',
    system_bug: 'System Bug',
    human_error: 'Human Error',
    hardware: 'Hardware',
    software: 'Software',
    network: 'Network',
    change_request: 'Change Request',
    power_outage: 'Power Outage',
    network_issue: 'Network Issue',
    server_failure: 'Server Failure',
    application_error: 'Application Error',
    security_incident: 'Security Incident',
    hardware_failure: 'Hardware Failure',
    software_bug: 'Software Bug',
    performance_issue: 'Performance Issue',
    backup_failure: 'Backup Failure',
    other: 'Other',
    data: 'Data',
  };
  return labels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function mapCaseTypeToAreaSubLabel(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (key === 'change_request') return 'Change Request';
  if (key === 'other') return 'Notification';
  if (key === 'data') return 'Notification';
  return 'Error/Bug';
}

function normalizeOdooCriteriaLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('mandatory')) return 'Mandatory';
  if (raw.includes('high')) return 'High';
  if (raw.includes('medium')) return 'Medium';
  if (raw.includes('low')) return 'Low';
  return '';
}

function odooCriteriaIdFromLabel(value) {
  const label = String(value || '').trim().toLowerCase();
  if (label === 'mandatory') return '1';
  if (label === 'high') return '2';
  if (label === 'medium') return '3';
  if (label === 'low') return '4';
  return '';
}

function normalizeOdooImpactLevel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (['yes', 'impact', 'impacted', 'high', 'medium', 'low', 'affected', 'true', '1'].includes(raw)) return 'yes';
  if (['no', 'none', 'not_impact', 'not impacted', 'false', '0'].includes(raw)) return 'no';
  return '';
}

function resolveOdooChannelId(channel) {
  const value = String(channel || '').trim().toLowerCase();
  if (isNumericOdooId(value)) return Number(value);
  const map = {
    'face to face': 1,
    website: 2,
    web: 2,
    line: 3,
    call: 4,
    'call center': 4,
    email: 5,
    'google form': 10,
  };
  return map[value] || null;
}

function toOdooInt(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function normalizeOdooDatetime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/i);
  if (isoMatch) return `${isoMatch[1]} ${isoMatch[2]}`;
  const thaiMonthMap = {
    มกราคม: '01',
    กุมภาพันธ์: '02',
    มีนาคม: '03',
    เมษายน: '04',
    พฤษภาคม: '05',
    มิถุนายน: '06',
    กรกฎาคม: '07',
    สิงหาคม: '08',
    กันยายน: '09',
    ตุลาคม: '10',
    พฤศจิกายน: '11',
    ธันวาคม: '12',
  };
  const thaiParts = raw.split(/\s+/).filter(Boolean);
  if (thaiParts.length >= 3) {
    const [dayRaw, monthRaw, yearRaw, timeRaw = '00:00:00'] = thaiParts;
    const monthKey = String(monthRaw || '').replace(/\./g, '').trim();
    let month = thaiMonthMap[monthKey] || thaiMonthMap[monthKey.slice(0, 3)] || '';
    if (!month) {
      for (const [name, num] of Object.entries(thaiMonthMap)) {
        if (String(monthRaw || '').includes(name)) {
          month = num;
          break;
        }
      }
    }
    if (/^\d{1,2}$/.test(dayRaw) && /^\d{4}$/.test(yearRaw) && month) {
      const day = String(dayRaw).padStart(2, '0');
      const year = String(yearRaw).padStart(4, '0');
      return `${year}-${month}-${day} ${timeRaw}`;
    }
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}:${pad(parsed.getUTCSeconds())}`;
}

async function normalizeOdooDatetimeWithAi(env, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = normalizeOdooDatetime(raw);
  if (normalized && normalized !== raw) return normalized;
  if (!/[A-Za-zก-๙]/.test(raw)) return normalized || null;
  try {
    const { azureUrl, azureKey, modelName, isDeploymentUrl } = resolveAzureChatConfig(env);
    const res = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureKey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: [
              'Convert date/time text to Odoo datetime format.',
              'Output exactly one line in format YYYY-MM-DD HH:MM:SS.',
              'Use Asia/Bangkok time when the input is a Thai human-readable date.',
              'If the input already has a timezone or is ISO, keep the same instant and convert to the target format.',
              'If you cannot confidently convert, return an empty string.',
            ].join(' '),
          },
          {
            role: 'user',
            content: `Input: ${raw}`,
          },
        ],
        temperature: 0,
        max_tokens: 24,
        model: modelName,
      }),
    });
    const data = await res.json().catch(() => ({}));
    let text = String(data?.choices?.[0]?.message?.content || '').trim();
    text = text.split(/\r?\n/)[0].trim();
    const match = text.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/);
    if (match) return match[1];
    if (!isDeploymentUrl && text && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
      return normalizeOdooDatetime(text);
    }
  } catch {}
  return normalized || null;
}

function stripDataUrlBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const dataUrl = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i);
  return (dataUrl ? dataUrl[2] : raw).replace(/\s+/g, '');
}

function isLikelyImageMime(value) {
  return /^image\//i.test(String(value || '').trim());
}

function guessAttachmentName(item, fallback = 'attachment') {
  if (item && typeof item === 'object') {
    return String(item.name || item.file_name || item.filename || item.original_name || item.attachment_name || fallback).trim() || fallback;
  }
  return fallback;
}

function extractFileLookupKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const apiMatch = raw.match(/\/api\/files\/([^?#]+)/i) || raw.match(/\/files\/([^?#]+)/i);
  if (apiMatch) return decodeURIComponent(apiMatch[1] || '');
  if (/^(?:dbfiles\/|file_|upl_|[A-Za-z0-9_-]{8,})/.test(raw) && !/^data:/i.test(raw) && !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return raw;
  return '';
}

async function loadStoredFileMeta(env, value) {
  const key = extractFileLookupKey(value);
  if (!key) return null;
  try {
    return await pgFirst(env, `SELECT original_name, content_type, content_base64 FROM files WHERE r2_key=$1 OR id=$1 LIMIT 1`, [key]);
  } catch {
    return null;
  }
}

async function normalizeOdooBinaryItem(env, item, fallbackName = 'attachment') {
  if (!item) return null;
  const obj = item && typeof item === 'object' ? item : {};
  const rawValue = typeof item === 'string'
    ? item
    : (obj.content_base64 || obj.base64 || obj.data || obj.file || obj.image || obj.url || obj.r2_key || obj.id || '');
  let contentBase64 = stripDataUrlBase64(rawValue);
  let name = guessAttachmentName(obj, fallbackName);
  let contentType = String(obj.content_type || obj.mimetype || obj.mime || '').trim();

  if (!contentBase64 || /^https?:\/\//i.test(String(rawValue || '')) || /^\/?(?:api\/)?files\//i.test(String(rawValue || ''))) {
    const stored = await loadStoredFileMeta(env, rawValue || obj.r2_key || obj.id || obj.url || '');
    if (stored?.content_base64) {
      contentBase64 = stripDataUrlBase64(stored.content_base64);
      name = String(stored.original_name || name || fallbackName).trim();
      contentType = String(stored.content_type || contentType || '').trim();
    }
  }

  if (!contentBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) return null;
  return { contentBase64, name, contentType };
}

async function buildOdooImageCommands(env, items = []) {
  const commands = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = await normalizeOdooBinaryItem(env, item, 'case-image');
    if (!normalized) continue;
    if (normalized.contentType && !isLikelyImageMime(normalized.contentType)) continue;
    commands.push([0, 0, {
      image_date: new Date().toISOString(),
      image_file: normalized.contentBase64,
    }]);
  }
  return commands;
}

async function buildOdooAttachmentCommands(env, items = []) {
  const commands = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = await normalizeOdooBinaryItem(env, item, 'attachment');
    if (!normalized) continue;
    commands.push([0, 0, {
      attachment_date: new Date().toISOString(),
      attachment_name: normalized.name || 'attachment',
      attachment_file: normalized.contentBase64,
    }]);
  }
  return commands;
}

function extractOdooChatText(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) {
    return message.map((part) => extractOdooChatText(part)).filter(Boolean).join('\n').trim();
  }
  if (typeof message === 'object') {
    if (message.type === 'text') return String(message.text || '').trim();
    if (message.type === 'image_url') return '[image]';
    const content = message.chat_message ?? message.content_text ?? message.content ?? message.text ?? message.message ?? '';
    return extractOdooChatText(content);
  }
  return String(message || '').trim();
}

function normalizeOdooChatState(message) {
  const raw = message && typeof message === 'object'
    ? String(message.chat_state || message.state || message.role || message.sender_type || '').trim().toLowerCase()
    : '';
  if (!raw) return 'note';
  if (raw === 'assistant' || raw === 'ai' || raw === 'mana') return 'mana_reply';
  if (raw === 'user' || raw === 'customer') return 'customer_message';
  return raw.slice(0, 64);
}

function normalizeOdooChatDate(message, fallbackDate = '') {
  if (message && typeof message === 'object') {
    return normalizeOdooDatetime(message.chat_state_date || message.created_at || message.createdAt || message.updated_at || message.timestamp || message.date || '') || normalizeOdooDatetime(fallbackDate);
  }
  return normalizeOdooDatetime(fallbackDate);
}

function normalizeOdooChatEmployeeId(message, fallbackEmployeeId = '') {
  if (message && typeof message === 'object') {
    return toOdooInt(message.employee_id || message.employeeId || message.odoo_employee_id || message.odooEmployeeId || fallbackEmployeeId);
  }
  return toOdooInt(fallbackEmployeeId);
}

function parseTicketExtra(value) {
  if (!value) return {};
  if (typeof value === 'object') return value || {};
  return tryParseJson(value, {});
}

function hydrateHelpdeskTicketRow(row) {
  if (!row) return null;
  const extra = parseTicketExtra(row.extra);
  const merged = { ...extra, ...row, extra };
  merged.id = String(row.id || extra.id || '').trim();
  merged.title = String(row.title || extra.title || extra.issueTitle || extra.summary || '').trim();
  merged.description = String(row.description || extra.description || '').trim();
  // Keep the original six-field template separate from Odoo's case_desc. Odoo
  // intentionally receives only the issue detail, while reopening a ticket
  // must restore everything the requester entered.
  merged.templateDescription = String(extra.templateDescription || extra.template_description || '').trim();
  merged.template_description = merged.templateDescription;
  merged.project = String(row.project || extra.project || extra.projectCode || extra.project_code || '').trim();
  merged.projectCode = String(extra.projectCode || extra.project_code || row.project || '').trim();
  merged.projectName = String(extra.projectName || extra.project_name || '').trim();
  merged.subprojectCode = String(extra.subprojectCode || extra.subproject_code || extra.sub_project || '').trim();
  merged.subprojectName = String(extra.subprojectName || extra.subproject_name || extra.sub_project_name || '').trim();
  merged.status = String(row.status || extra.status || 'draft').trim() || 'draft';
  merged.bug_type = String(row.bug_type || extra.bug_type || extra.problem_type || '').trim();
  merged.problem_type = String(extra.problem_type || merged.bug_type || '').trim();
  merged.analysis = extra.analysis || merged.analysis || null;
  merged.odooTicketId = String(row.odoo_ticket_id || extra.odooTicketId || extra.odoo_ticket_id || extra.ticketNo || extra.case_ticket_id || '').trim();
  merged.ticketNo = merged.odooTicketId;
  merged.assignedDev = String(row.assigned_dev || extra.assignedDev || extra.assigned_dev || '').trim();
  merged.requester = String(extra.requester || extra.requester_name || extra.template_requester || extra.customer || '').trim();
  merged.createdAt = row.created_at || extra.createdAt || extra.created_at || '';
  // Use the event time that corresponds to the Case's current Odoo status.
  merged.updated_at = extra.odoo_status_at || extra.odoo_write_date || extra.write_date || row.updated_at || '';
  merged.updatedAt = merged.updated_at || extra.updatedAt || extra.updated_at || '';
  return merged;
}

function buildHelpdeskTicketExtra(input = {}, existingExtra = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const rawExtra = parseTicketExtra(source.extra);
  const merged = { ...existingExtra, ...rawExtra, ...source };
  delete merged.extra;
  merged.projectCode = String(source.projectCode || source.project_code || source.project || merged.projectCode || merged.project_code || '').trim();
  merged.project_code = merged.projectCode;
  merged.projectName = String(source.projectName || source.project_name || merged.projectName || merged.project_name || '').trim();
  merged.project_name = merged.projectName;
  merged.subprojectCode = String(source.subprojectCode || source.subproject_code || source.sub_project || merged.subprojectCode || merged.subproject_code || merged.sub_project || '').trim();
  merged.subproject_code = merged.subprojectCode;
  merged.subprojectName = String(source.subprojectName || source.subproject_name || source.sub_project_name || merged.subprojectName || merged.subproject_name || merged.sub_project_name || '').trim();
  merged.subproject_name = merged.subprojectName;
  merged.assignedDev = String(source.assignedDev || source.assigned_dev || merged.assignedDev || merged.assigned_dev || '').trim();
  merged.assigned_dev = merged.assignedDev;
  merged.odooTicketId = String(source.odooTicketId || source.odoo_ticket_id || source.ticketNo || source.case_ticket_id || merged.odooTicketId || merged.odoo_ticket_id || merged.ticketNo || merged.case_ticket_id || '').trim();
  merged.odoo_ticket_id = merged.odooTicketId;
  merged.ticketNo = merged.odooTicketId;
  merged.createdAt = source.createdAt || source.created_at || merged.createdAt || merged.created_at || '';
  merged.updatedAt = source.updatedAt || source.updated_at || merged.updatedAt || merged.updated_at || '';
  if (source.analysis && typeof source.analysis === 'object') merged.analysis = source.analysis;
  if (source.routeMode != null) merged.routeMode = source.routeMode;
  if (source.routeTarget != null) merged.routeTarget = source.routeTarget;
  if (source.routeTargetLabel != null) merged.routeTargetLabel = source.routeTargetLabel;
  return merged;
}

async function findHelpdeskTicketRecord(env, refs = []) {
  const normalized = Array.from(new Set((Array.isArray(refs) ? refs : []).map((ref) => String(ref || '').trim()).filter(Boolean)));
  for (const ref of normalized) {
    const row = await pgFirst(
      env,
      `SELECT id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra
       FROM helpdesk_tickets
       WHERE id=$1
          OR odoo_ticket_id=$1
          OR extra->>'case_ticket_id'=$1
          OR extra->>'odoo_ticket_id'=$1
          OR extra->>'odooTicketId'=$1
          OR extra->>'ticketNo'=$1
          OR extra->>'uuid'=$1
          OR COALESCE(extra::text, '') LIKE $2
          OR COALESCE(extra::text, '') LIKE $3
       ORDER BY
         CASE WHEN created_by='odoo-sync' THEN 1 ELSE 0 END,
         updated_at DESC NULLS LAST,
         created_at DESC NULLS LAST
       LIMIT 1`,
      [ref, `%\"case_ticket_id\":\"${ref}\"%`, `%\"uuid\":\"${ref}\"%`]
    );
    if (row) return row;
  }
  return null;
}

function collectOdooChatMessages(payload = {}, fallbackDate = '') {
  const sources = [
    payload.chat_messages,
    payload.mana_chat_messages,
    payload.chat_history,
    payload.mana_history,
    payload.odoo_chat_messages,
  ];
  const messages = [];
  for (const source of sources) {
    if (Array.isArray(source)) messages.push(...source);
  }
  const summary = String(payload.mana_summary || payload.mana_reply || payload.ai_summary || '').trim();
  if (summary) {
    messages.push({
      role: 'assistant',
      sender_name: 'MANA',
      chat_state: 'mana_summary',
      chat_state_date: fallbackDate,
      content: summary,
    });
  }
  return messages;
}

function buildOdooChatCommands(messages = [], fallbackEmployeeId = '', fallbackDate = '') {
  const commands = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = extractOdooChatText(message);
    if (!text) continue;
    const vals = {
      chat_message: text.slice(0, 1024),
      chat_state: normalizeOdooChatState(message),
      chat_state_date: normalizeOdooChatDate(message, fallbackDate) || normalizeOdooDatetime(new Date()),
    };
    const employeeId = normalizeOdooChatEmployeeId(message, fallbackEmployeeId);
    if (employeeId) vals.employee_id = employeeId;
    commands.push([0, 0, vals]);
    if (commands.length >= 20) break;
  }
  return commands;
}

function odooCommandVals(commands = []) {
  return (Array.isArray(commands) ? commands : [])
    .map((command) => Array.isArray(command) ? command[2] : null)
    .filter((vals) => vals && typeof vals === 'object');
}

function normalizeOdooCaseType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'other';
  if (text === 'human_error' || text.includes('human')) return 'human_error';
  if (text === 'system_bug' || text.includes('system bug') || text === 'bug') return 'system_bug';
  if (text === 'system_error' || text.includes('system error')) return 'system_error';
  if (text === 'change_request' || text.includes('change')) return 'change_request';
  if (text === 'network' || text.includes('network')) return 'network';
  if (text === 'hardware' || text.includes('hardware')) return 'hardware';
  if (text === 'software' || text.includes('software')) return 'software';
  if (text === 'data' || text.includes('data')) return 'data';
  return 'other';
}

export async function odooRpcAuthenticate(baseUrl, db, login, password) {
  const res = await fetch(`${baseUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 BETIME Helpdesk',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { db, login, password },
    }),
  });
  const data = await res.json().catch(() => ({}));
  const setCookie = res.headers.get('set-cookie') || '';
  const cookieSessionIdMatch = setCookie.match(/(?:^|;\s*|,\s*)session_id=([^;,\s]+)/i);
  const cookieSessionId = cookieSessionIdMatch ? String(cookieSessionIdMatch[1] || '').trim() : '';
  const rpcSessionId = String(data?.result?.session_id || '').trim();
  const effectiveSessionId = cookieSessionId || rpcSessionId;
  if (!res.ok || data?.error || !effectiveSessionId) {
    const msg = data?.error?.data?.message || data?.error?.message || `Odoo auth failed (${res.status})`;
    throw new Error(msg);
  }
  return { ...(data.result || {}), session_id: effectiveSessionId, cookie_session_id: cookieSessionId || undefined };
}

export async function odooRpcCall(baseUrl, sessionId, model, method, args = [], kwargs = {}) {
  const encodedModel = encodeURIComponent(model);
  const encodedMethod = encodeURIComponent(method);
  const res = await fetch(`${baseUrl}/web/dataset/call_kw/${encodedModel}/${encodedMethod}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 BETIME Helpdesk',
      'Cookie': `session_id=${sessionId}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.data?.message || data?.error?.message || `Odoo RPC ${model}.${method} failed (${res.status})`;
    throw new Error(msg);
  }
  return data.result;
}

export async function odooJsonRpcLogin(baseUrl, db, login, password) {
  const res = await fetch(`${baseUrl}/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 BETIME Helpdesk',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service: 'common', method: 'login', args: [db, login, password] },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error || !data?.result) {
    const msg = data?.error?.data?.message || data?.error?.message || `Odoo JSON-RPC login failed (${res.status})`;
    throw new Error(msg);
  }
  return { mode: 'execute_kw', uid: data.result };
}

export async function odooExecuteKw(baseUrl, db, uid, password, model, method, args = [], kwargs = {}) {
  const res = await fetch(`${baseUrl}/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 BETIME Helpdesk',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service: 'object', method: 'execute_kw', args: [db, uid, password, model, method, args, kwargs] },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.data?.message || data?.error?.message || `Odoo execute_kw ${model}.${method} failed (${res.status})`;
    throw new Error(msg);
  }
  return data.result;
}

function odooRelationId(value) {
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function odooRelationName(value) {
  return String(Array.isArray(value) ? value[1] : '').trim();
}

function mapOdooCaseStatusToLocal(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['open', 'new', 'draft', 'pending'].includes(value)) return 'open';
  if (['process', 'in_progress', 'assigned'].includes(value)) return 'process';
  if (['finish'].includes(value)) return 'finish';
  if (['closed', 'done', 'resolved'].includes(value)) return 'closed';
  if (['cancel', 'cancelled', 'canceled', 'failed', 'retry'].includes(value)) return 'cancel';
  return 'other';
}

function getOdooCaseStatusAt(item = {}) {
  const value = String(item.case_status || '').trim().toLowerCase();
  const first = (...dates) => dates.find((date) => String(date || '').trim()) || null;
  if (['finish', 'closed', 'done', 'resolved'].includes(value)) {
    return first(item.case_date_finish, item.finish_date, item.write_date, item.active_date, item.create_date);
  }
  if (['process', 'in_progress', 'assigned'].includes(value)) {
    return first(item.case_date_process, item.active_date, item.write_date, item.create_date);
  }
  if (['cancel', 'cancelled', 'canceled', 'failed', 'retry'].includes(value)) {
    return first(item.case_date_cancel, item.write_date, item.active_date, item.create_date);
  }
  return first(item.active_date, item.case_date, item.create_date, item.write_date);
}

function mapLocalKanbanStatusToOdoo(status) {
  const value = mapOdooCaseStatusToLocal(status);
  if (value === 'finish') return 'finish';
  if (value === 'closed') return 'closed';
  if (value === 'cancel') return 'cancel';
  if (value === 'process') return 'process';
  return 'open';
}

async function getOdooCaseCaller(env) {
  const cfg = getOdooRuntimeConfig(env);
  if (!cfg.url || !cfg.db || !cfg.login || !cfg.password) throw new Error('Odoo connection is not configured');
  try {
    const auth = await odooRpcAuthenticate(cfg.url, cfg.db, cfg.login, cfg.password);
    return (model, method, args = [], kwargs = {}) => odooRpcCall(cfg.url, auth.session_id, model, method, args, kwargs);
  } catch {
    const auth = await odooJsonRpcLogin(cfg.url, cfg.db, cfg.login, cfg.password);
    return (model, method, args = [], kwargs = {}) => odooExecuteKw(cfg.url, cfg.db, auth.uid, cfg.password, model, method, args, kwargs);
  }
}

function getStoredOdooCaseId(extra) {
  const value = extra?.odoo_case_id || extra?.odooCaseId || extra?.odoo_response?.id || '';
  return isNumericOdooId(value) ? String(value) : '';
}

function isInternalKanbanSync(request, env) {
  const expected = String(env.KANBAN_SYNC_TOKEN || '').trim();
  const received = String(request.headers.get('x-internal-sync-token') || '').trim();
  return Boolean(expected && received && expected === received);
}

async function resolveOdooProjectId(env, code, name) {
  const rawCode = String(code || '').trim();
  const rawName = String(name || '').trim();
  if (isNumericOdooId(rawCode)) return rawCode;
  if (!rawCode && !rawName) return rawCode;
  try {
    if (backendMode(env) === 'd1') return rawCode;
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_projects'
        AND (
          lower(code)=lower($1) OR lower(name)=lower($1) OR id=$1
          OR lower(code)=lower($2) OR lower(name)=lower($2)
          OR lower(COALESCE(extra::jsonb->>'project_code',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'project_name',''))=lower($2)
        )
      ORDER BY
        CASE WHEN lower(code)=lower($1) AND COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END,
        CASE WHEN lower(COALESCE(extra::jsonb->>'project_code',''))=lower($1) AND COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END,
        CASE WHEN lower(code)=lower($1) THEN 0 ELSE 1 END,
        CASE WHEN lower(name)=lower($2) AND COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END,
        CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END,
        CASE WHEN id LIKE 'odoo_%' THEN 0 ELSE 1 END
      LIMIT 1
    `, [rawCode, rawName]);
    const localId = pickOdooSourceId(row, '');
    if (localId) return localId;
  } catch {
    // continue to live lookup
  }
  return await resolveOdooIdByLiveLookup(env, 'tcp.mdm.service', {
    code: rawCode,
    name: rawName,
    codeField: 'service_code',
    nameField: 'service_name',
  }) || rawCode;
}

async function resolveOdooSubProjectId(env, code, name, projectSourceId) {
  const rawCode = String(code || '').trim();
  const rawName = String(name || '').trim();
  const parent = String(projectSourceId || '').trim();
  if (isNumericOdooId(rawCode)) {
    try {
      const domain = [['id', '=', Number(rawCode)]];
      if (isNumericOdooId(parent)) domain.push(['service_id', '=', Number(parent)]);
      const rows = await callOdooLookup(env, 'tcp.mdm.service.sub', domain, ['id', 'service_id', 'service_sub_code', 'service_sub_name']);
      if (Array.isArray(rows) && rows.some((row) => String(row?.id || '') === rawCode)) return rawCode;
    } catch {}
    return '';
  }
  if (!rawCode && !rawName) return rawCode;
  const liveId = await resolveOdooIdByLiveLookup(env, 'tcp.mdm.service.sub', {
    code: rawCode,
    name: rawName,
    codeField: 'service_sub_code',
    nameField: 'service_sub_name',
    parentField: 'service_id',
    parentId: parent,
  });
  if (liveId) return liveId;
  try {
    if (backendMode(env) === 'd1') return rawCode;
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_sub_projects'
        AND (
          lower(code)=lower($1) OR lower(name)=lower($1) OR id=$1
          OR lower(code)=lower($2) OR lower(name)=lower($2)
          OR lower(COALESCE(extra::jsonb->>'sub_project_code',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'sub_project_name',''))=lower($2)
        )
      ORDER BY
        CASE WHEN COALESCE(extra::jsonb->>'parent_project','')=$3 THEN 0 ELSE 1 END,
        CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END,
        CASE WHEN id LIKE 'odoo_%' THEN 0 ELSE 1 END
      LIMIT 1
    `, [rawCode, rawName, parent]);
    let localId = '';
    try {
      const extra = typeof row?.extra === 'string' ? JSON.parse(row.extra || '{}') : (row?.extra || {});
      for (const candidate of [extra.source_sub_id, extra.source_id, extra.source_sub_project_id, extra.external_id]) {
        if (isNumericOdooId(candidate)) { localId = String(candidate); break; }
      }
    } catch {}
    if (localId && localId !== parent) return localId;
  } catch {
    // continue to live lookup
  }
  return rawCode;
}

async function resolveOdooPriority(env, projectSourceId, requestedPriority, requestedPriorityId) {
  const rawPriorityId = String(requestedPriorityId || '').trim();
  const rawPriority = String(requestedPriority || '').trim();
  const projectId = String(projectSourceId || '').trim();
  if (isNumericOdooId(rawPriorityId) && Number(rawPriorityId) < 100) {
    return { priority: rawPriority || rawPriorityId, priority_id: null, priority_level: rawPriorityId };
  }
  try {
    if (backendMode(env) === 'd1' || !projectId) return { priority: rawPriority || 'Medium', priority_id: requestedPriorityId || null, priority_level: '' };
    const preferredLevel = /high|critical|urgent|เร่ง|สูง/i.test(rawPriority) ? '1' : /low|ต่ำ/i.test(rawPriority) ? '4' : '2';
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_sla'
        AND COALESCE(extra::jsonb->>'project_id','')=$1
      ORDER BY
        CASE WHEN code=$2 THEN 0 ELSE 1 END,
        CASE WHEN code='2' THEN 0 ELSE 1 END,
        code
      LIMIT 1
    `, [projectId, preferredLevel]);
    if (!row) return { priority: rawPriority || 'Medium', priority_id: requestedPriorityId || null, priority_level: '' };
    const priorityId = pickOdooSourceId(row, '');
    return {
      priority: row.name || rawPriority || row.code,
      priority_id: priorityId ? Number(priorityId) : (requestedPriorityId || null),
      priority_level: row.code || preferredLevel,
    };
  } catch {
    return { priority: rawPriority || 'Medium', priority_id: requestedPriorityId || null, priority_level: '' };
  }
}

async function resolveOdooDefaultAreaId(env, projectSourceId) {
  const projectId = String(projectSourceId || '').trim();
  if (!projectId) return '';
  try {
    if (backendMode(env) === 'd1') return '';
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_flow_areas'
        AND COALESCE(extra::jsonb->>'project_id','')=$1
      ORDER BY
        COALESCE(NULLIF(extra::jsonb->>'sequence','')::int, 999999),
        code,
        name
      LIMIT 1
    `, [projectId]);
    return pickOdooSourceId(row, '');
  } catch {
    return '';
  }
}

async function resolveOdooAreaIdByText(env, projectSourceId, areaText) {
  const projectId = String(projectSourceId || '').trim();
  const rawText = String(areaText || '').trim();
  if (!projectId || !rawText) return '';
  try {
    if (backendMode(env) === 'd1') return '';
    const normalized = rawText.toLowerCase();
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_flow_areas'
        AND COALESCE(extra::jsonb->>'project_id','')=$1
        AND (
          lower(name)=lower($2)
          OR lower(code)=lower($2)
          OR lower(COALESCE(extra::jsonb->>'area_name',''))=lower($2)
          OR lower(COALESCE(extra::jsonb->>'area_id',''))=lower($2)
          OR lower(name) LIKE $3
          OR lower(COALESCE(extra::jsonb->>'area_name','')) LIKE $3
        )
      ORDER BY
        CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,
        CASE WHEN lower(COALESCE(extra::jsonb->>'area_name',''))=lower($2) THEN 0 ELSE 1 END,
        CASE WHEN lower(code)=lower($2) THEN 0 ELSE 1 END,
        COALESCE(NULLIF(extra::jsonb->>'sequence','')::int, 999999),
        name
      LIMIT 1
    `, [projectId, rawText, `%${normalized}%`]);
    return pickOdooSourceId(row, '');
  } catch {
    return '';
  }
}

async function resolveOdooCriteriaIdByText(env, criteriaText) {
  const rawText = String(criteriaText || '').trim();
  if (!rawText) return '';
  try {
    if (backendMode(env) === 'd1') return '';
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_criteria'
        AND (
          lower(name)=lower($1)
          OR lower(code)=lower($1)
          OR lower(COALESCE(extra::jsonb->>'criteria_name',''))=lower($1)
          OR lower(name) LIKE $2
          OR lower(COALESCE(extra::jsonb->>'criteria_name','')) LIKE $2
        )
      ORDER BY
        CASE WHEN lower(name)=lower($1) THEN 0 ELSE 1 END,
        CASE WHEN lower(COALESCE(extra::jsonb->>'criteria_name',''))=lower($1) THEN 0 ELSE 1 END,
        name
      LIMIT 1
    `, [rawText, `%${rawText.toLowerCase()}%`]);
    return pickOdooSourceId(row, '');
  } catch {
    return '';
  }
}

async function resolveOdooOwnerInfo(env, projectSourceId, projectCode, projectName) {
  const rawProjectId = String(projectSourceId || '').trim();
  const rawProjectCode = String(projectCode || '').trim();
  const rawProjectName = String(projectName || '').trim();
  try {
    if (backendMode(env) === 'd1') {
      return { owner_team_id: '', owner_team_name: '', owner_officer_id: '', owner_officer_name: '' };
    }
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_teams'
        AND (
          lower(code)=lower($1)
          OR lower(name)=lower($2)
          OR lower(COALESCE(extra::jsonb->>'team_code',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'team_name_en',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'team_name_th',''))=lower($2)
        )
      ORDER BY
        CASE WHEN lower(COALESCE(extra::jsonb->>'team_code',''))=lower($1) THEN 0 ELSE 1 END,
        CASE WHEN lower(code)=lower($1) THEN 0 ELSE 1 END,
        CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END
      LIMIT 1
    `, [rawProjectCode, rawProjectName]);
    const extra = tryParseJson(row?.extra, {});
    const ownerTeamId = pickOdooSourceId(row, '');
    const ownerOfficerId = extractOdooNumericId(extra.owner_id || extra.owner_ref || extra.project_pm || '');
    if (ownerTeamId || ownerOfficerId) {
      return {
        owner_team_id: ownerTeamId,
        owner_team_name: row?.name || extra.team_name_th || extra.team_name_en || rawProjectName || '',
        owner_officer_id: ownerOfficerId,
        owner_officer_name: extra.owner_name || '',
      };
    }

    const pmRow = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra
      FROM hd_master
      WHERE table_name='hd_project_member_roles'
        AND COALESCE(extra::jsonb->>'project_id','')=$1
        AND lower(COALESCE(extra::jsonb->>'role_type',''))='pm'
      ORDER BY id
      LIMIT 1
    `, [rawProjectId ? `odoo_hd_project_${rawProjectId}` : '']);
    const pmExtra = tryParseJson(pmRow?.extra, {});
    if (pmRow?.id) {
      return {
        owner_team_id: ownerTeamId,
        owner_team_name: row?.name || extra.team_name_th || extra.team_name_en || rawProjectName || '',
        owner_officer_id: extractOdooNumericId(pmExtra.person_id || pmExtra.person_code || ''),
        owner_officer_name: pmExtra.person_name || '',
      };
    }

    const teamFallbackRow = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra, extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_teams'
        AND (
          lower(code)=lower($1)
          OR lower(name)=lower($2)
          OR lower(COALESCE(extra::jsonb->>'team_code',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'team_name_en',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'team_name_th',''))=lower($2)
        )
      ORDER BY
        CASE WHEN lower(COALESCE(extra::jsonb->>'team_code',''))=lower($1) THEN 0 ELSE 1 END,
        CASE WHEN lower(code)=lower($1) THEN 0 ELSE 1 END,
        CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(extra::jsonb->>'source_id','') ~ '^\\d+$' THEN 0 ELSE 1 END
      LIMIT 1
    `, [rawProjectCode, rawProjectName]);
    const teamFallbackExtra = tryParseJson(teamFallbackRow?.extra, {});
    const fallbackMemberRef = Array.isArray(teamFallbackExtra.member_ids) && teamFallbackExtra.member_ids.length
      ? teamFallbackExtra.member_ids[0]
      : Array.isArray(teamFallbackExtra.team_member_refs) && teamFallbackExtra.team_member_refs.length
        ? teamFallbackExtra.team_member_refs[0]
        : '';
    const teamFallbackId = pickOdooSourceId(teamFallbackRow, '');

    return {
      owner_team_id: ownerTeamId || teamFallbackId,
      owner_team_name: row?.name || teamFallbackRow?.name || extra.team_name_th || extra.team_name_en || rawProjectName || '',
      owner_officer_id: extractOdooNumericId(pmExtra.person_id || pmExtra.person_code || fallbackMemberRef || ''),
      owner_officer_name: pmExtra.person_name || teamFallbackExtra.owner_name || (Array.isArray(teamFallbackExtra.member_names) ? teamFallbackExtra.member_names[0] : '') || '',
    };
  } catch {
    return { owner_team_id: '', owner_team_name: '', owner_officer_id: '', owner_officer_name: '' };
  }
}

async function resolveOdooOwnerByEmployeeCode(env, employeeCode) {
  const rawCode = String(employeeCode || '').trim();
  if (!rawCode || backendMode(env) === 'd1') return { owner_officer_id: '', owner_officer_name: '' };
  try {
    const row = await pgFirst(env, `
      SELECT id, code, name, extra::text AS extra,
             extra::jsonb->>'source_id' AS source_id
      FROM hd_master
      WHERE table_name='hd_users'
        AND (
          lower(code)=lower($1)
          OR lower(COALESCE(extra::jsonb->>'employee_code',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'employee_id',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'employee_ref',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'work_email',''))=lower($1)
          OR lower(COALESCE(extra::jsonb->>'email',''))=lower($1)
        )
      ORDER BY CASE WHEN lower(code)=lower($1) THEN 0 ELSE 1 END, id
      LIMIT 1
    `, [rawCode]);
    const extra = tryParseJson(row?.extra, {});
    const ownerOfficerId = extractOdooNumericId(
      row?.source_id || extra.source_id || extra.employee_id || extra.employee_ref || row?.id || ''
    );
    return {
      owner_officer_id: ownerOfficerId,
      owner_officer_name: String(row?.name || extra.employee_name || extra.name || '').trim(),
    };
  } catch {
    return { owner_officer_id: '', owner_officer_name: '' };
  }
}

// ── analyseHelpdeskIssueWith4o ───────────────────────────────────────

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function resolveAzureChatConfig(env) {
  const explicitUrl = String(env.AZURE_AI_URL || env.AZURE_AI_MODELS_CHAT_URL || env.AZURE_OPENAI_CHAT_URL || '').trim();
  const endpoint = String(env.AZURE_AI_ENDPOINT || env.AZURE_AI_MODELS_CHAT_ENDPOINT || env.AZURE_OPENAI_ENDPOINT || env.OAI_ENDPOINT || '').trim();
  const azureKey = String(env.AZURE_AI_KEY || env.AZURE_AI_MODELS_CHAT_KEY || env.AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_KEY || env.OAI_KEY || '').trim();
  const modelName = String(env.AZURE_AI_MODEL || env.AZURE_AI_MODELS_CHAT_MODEL || env.AZURE_OPENAI_MODEL || 'gpt-4o').trim();
  const deployment = String(env.AZURE_AI_DEPLOYMENT || env.AZURE_AI_MODELS_CHAT_DEPLOYMENT || env.AZURE_OPENAI_DEPLOYMENT || env.OAI_DEPLOY || modelName).trim();
  const apiVersion = String(env.AZURE_AI_API_VERSION || env.AZURE_AI_MODELS_CHAT_API_VERSION || env.AZURE_OPENAI_API_VERSION || env.OAI_API_VERSION || '2024-12-01-preview').trim();
  const azureUrl = explicitUrl || (endpoint && deployment ? `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}` : '');
  if (!azureUrl || !azureKey) throw new Error('Azure AI is not configured');
  return { azureUrl, azureKey, modelName, isDeploymentUrl: azureUrl.includes('/openai/deployments/') };
}

async function analyseHelpdeskIssueWith4o(env, input = {}) {
  const { azureUrl, azureKey, modelName, isDeploymentUrl } = resolveAzureChatConfig(env);
  const issueTitle = String(input.issueTitle || '').trim();
  const requester = String(input.requester || '').trim();
  const reportedAt = String(input.reportedAt || '').trim();
  const department = String(input.department || '').trim();
  const contentLines = Array.isArray(input.contentLines)
    ? input.contentLines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  const contentText = String(input.contentText || '').trim();
  const rawDescription = String(input.description || '').trim();
  const projectCode = String(input.projectCode || '').trim();
  const projectName = String(input.projectName || '').trim();
  const subprojectCode = String(input.subprojectCode || '').trim();
  const subprojectName = String(input.subprojectName || '').trim();
  const urls = Array.isArray(input.urls) ? input.urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
  const knowledgeQuery = [issueTitle, requester, department, rawDescription, contentText, projectCode, projectName, subprojectCode, subprojectName, ...contentLines, ...urls].filter(Boolean).join('\n');
  const knowledgeRows = await findRelevantKnowledge(env, knowledgeQuery, {
    projectCode,
    subProjectCode: subprojectCode,
  });
  const knowledgeContext = formatKnowledgeContext(knowledgeRows);
  const ticketRows = await findRelevantHelpdeskTickets(env, knowledgeQuery);
  const ticketContext = formatHelpdeskTicketContext(ticketRows);

  const promptFiles = await Promise.all([
    readAssetText(env, '/prompts/helpdesk/analyze-ticket.system.md'),
    readAssetText(env, '/prompts/helpdesk/classify-problem-type.system.md'),
    readAssetText(env, '/prompts/helpdesk/classify-problem-type.examples.md'),
    readAssetText(env, '/prompts/helpdesk/classify-problem-type.usecases.md'),
    readAssetText(env, '/prompts/helpdesk/project-playbooks.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/human-error.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/system-error.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/system-bug.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/change-request.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/software.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/network.md'),
    readAssetText(env, '/prompts/helpdesk/problem-types/hardware.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/human-error.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/system-error.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/system-bug.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/change-request.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/software.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/network.md'),
    readAssetText(env, '/prompts/helpdesk/possible-causes/hardware.md'),
  ]);
  const promptFromFiles = promptFiles.filter(Boolean).join('\n\n---\n\n');

  const fallbackSystemPrompt = [
    'You are a senior helpdesk analyst and project lead.',
    'Analyze the issue and return valid JSON only with this exact shape:',
    '{',
    '  "parsed_fields": {"issueTitle":"...","requesterName":"...","reportedAt":"...","department":"...","area":"...","contentText":"...","contentLines":["..."],"urls":["..."]},',
    '  "problem_type": "Human error | system error | System Bug | Change Request | Software | network | hardware",',
    '  "problem_type_reason": "...",',
    '  "problem_type_confidence": "low | medium | high",',
    '  "alternative_problem_types": ["..."],',
    '  "severity": "low | medium | high",',
    '  "priority_level": "low | medium | high",',
    '  "priority_detail": "...",',
    '  "impact": "...",',
    '  "urgency": "...",',
    '  "criteria": "...",',
    '  "sub_criteria": "...",',
    '  "module_or_area": "...",',
    '  "summary": "...",',
    '  "likely_cause": "...",',
    '  "possible_causes": [{"cause":"...","reason":"...","evidence":["..."],"what_to_check_next":["..."]}],',
    '  "quick_fixes": ["..."],',
    '  "clarifying_questions": ["..."],',
    '  "when_to_escalate": "...",',
    '  "keywords": ["..."],',
    '  "parsed_issue_title": "...",',
    '  "parsed_requester": "...",',
    '  "parsed_reported_at": "...",',
    '  "parsed_department": "...",',
    '  "parsed_content_lines": ["..."],',
    '  "parsed_content_text": "...",',
    '  "parsed_urls": ["..."],',
    '  "linked_knowledge": [{"title":"...","tags":"..."}]',
    '}',
    'Rules:',
    '- Use the exact category list above for problem_type.',
    '- If it is about wrong clicking, wrong route, wrong receive number, or user mistake, use Human error.',
    '- If it is about app/API/data/auth/session/mapping, use Software.',
    '- If it is about server, timeout, 500, or failed system response, use system error.',
    '- If it is about abnormal logic or behavior bug, use System Bug.',
    '- If the case is Change Request, infer priority_level from impact, urgency, and related criteria patterns. Explain the basis briefly in priority_detail.',
    '- Use historical helpdesk tickets as the primary source of pattern matching and prior cases.',
    '- If similar historical helpdesk tickets exist, they should drive problem_type first and may be listed in linked_tickets.',
    '- Use Helpdeck Knowledge as supporting evidence after ticket history, and mention the closest matching article in linked_knowledge.',
    '- Do not use hardcoded category overrides; base problem_type strictly on the issue description, linked ticket history, and knowledge context.',
    '- Keep answers practical and concise for a PM/helpdesk workflow.',
    '- If evidence is mixed, choose the closest supported category instead of leaving it unclear.',
    '- Do not invent facts.',
  ].join('\n');
  const systemPrompt = promptFromFiles || fallbackSystemPrompt;

  const userPrompt = [
    `Project: ${projectCode || '-'}${projectName ? ' - ' + projectName : ''}`,
    `Sup Project: ${subprojectCode || '-'}${subprojectName ? ' - ' + subprojectName : ''}`,
    `Issue title: ${issueTitle || '-'}`,
    `Requester: ${requester || '-'}`,
    `Reported at: ${reportedAt || '-'}`,
    `Department: ${department || '-'}`,
    '',
    'Raw description:',
    rawDescription || '',
    '',
    'Parsed content lines:',
    ...contentLines.map((line) => `- ${line}`),
    '',
    'Known URLs:',
    ...urls.map((u) => `- ${u}`),
    '',
    knowledgeContext ? 'Helpdeck Knowledge context:' : '',
    knowledgeContext || '',
    '',
    ticketContext ? 'Historical helpdesk tickets:' : '',
    ticketContext || '',
  ].join('\n');

  const payload = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 1600,
  };
  if (!isDeploymentUrl) payload.model = modelName;

  const res = await fetch(azureUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': azureKey,
      ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Azure AI error (${res.status}): ${raw.slice(0, 300)}`);

  const jsonResp = JSON.parse(raw);
  const content = stripCodeFences(jsonResp?.choices?.[0]?.message?.content || '');
  if (!content) throw new Error('Empty AI response');

  const asText = (value, fallback = '') => {
    if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join('\n').trim() || fallback;
    return String(value || '').trim() || fallback;
  };
  const asArray = (value) => {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  };

  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      parsed = JSON.parse(content.slice(start, end + 1));
    } else {
      throw new Error('AI did not return valid JSON');
    }
  }
  const parsedFields = parsed?.parsed_fields && typeof parsed.parsed_fields === 'object' ? parsed.parsed_fields : {};

  function normalizeProblemTypeLabel(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text.includes('ยังไม่ชัดเจน') || text.includes('unclear') || text.includes('unknown')) return '';
    if (text.includes('human')) return 'Human error';
    if (text.includes('system bug')) return 'System Bug';
    if (text.includes('system error')) return 'system error';
    if (text.includes('change')) return 'Change Request';
    if (text.includes('hardware')) return 'hardware';
    if (text.includes('network')) return 'network';
    if (text.includes('software')) return 'Software';
    return '';
  }

  function normalizePriorityLevelLabel(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (/(p1|critical|urgent|high|สูง|เร่งด่วน)/i.test(text) || text.includes('critical') || text.includes('urgent')) return 'high';
    if (/(p2|medium|normal|moderate|กลาง)/i.test(text) || text.includes('medium') || text.includes('moderate') || text.includes('normal')) return 'medium';
    if (/(p3|p4|low|minor|ต่ำ)/i.test(text) || text.includes('low') || text.includes('minor')) return 'low';
    return '';
  }

  function voteProblemTypeFromRows(rows = []) {
    const counts = new Map();
    for (const row of rows) {
      const label = normalizeProblemTypeLabel(row?.bug_type || row?.problem_type || row?.title || row?.tags || '');
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [label, count] of counts.entries()) {
      if (count > bestCount) { best = label; bestCount = count; }
    }
    return best;
  }

  function inferProblemTypeFromText(text) {
    const value = String(text || '').toLowerCase();
    if (/(เลขรับ|ทะเบียนรับ|ลงรับ|เส้นทางหนังสือ|สารบรรณ|ยกเลิกเลขรับ|คืนเลขรับ|หนังสือ|กดรับผิดเรื่อง)/i.test(value)) return 'Human error';
    if (/(server error|timeout|500|ล่ม|ค้าง|ขัดข้อง|connection refused|failed to fetch)/i.test(value)) return 'system error';
    if (/(bug|logic ผิด|logic|behavior|ผิดปกติ|unexpected|crash|exception)/i.test(value)) return 'System Bug';
    if (/(feature request|ขอเพิ่ม|ขอปรับ|enhancement|ปรับปรุง|เพิ่ม field|เพิ่ม dropdown)/i.test(value)) return 'Change Request';
    if (/(network|wifi|vpn|lan|connection|เชื่อมต่อไม่ได้)/i.test(value)) return 'network';
    if (/(hardware|printer|scanner|keyboard|mouse|monitor|เครื่อง|อุปกรณ์)/i.test(value)) return 'hardware';
    return 'Software';
  }

  const normalizedAIType = normalizeProblemTypeLabel(parsed.problem_type);
  const ticketVoteType = voteProblemTypeFromRows(ticketRows);
  const knowledgeVoteType = voteProblemTypeFromRows(knowledgeRows);
  const issueTextForAnalysis = [issueTitle, rawDescription, contentText, ...contentLines].filter(Boolean).join('\n');
  const textVoteType = inferProblemTypeFromText(issueTextForAnalysis);
  const finalProblemType = normalizedAIType || ticketVoteType || knowledgeVoteType || textVoteType || 'Software';
  const issueTextForPriority = issueTextForAnalysis;
  const normalizedPriority = normalizePriorityLevelLabel(parsed.priority_level);
  const inferredPriority = /(urgent|critical|เร่งด่วน|ด่วน|production|กระทบหลายคน|ใช้งานไม่ได้)/i.test(issueTextForPriority)
    ? 'high'
    : /(minor|เล็กน้อย|ปรับเล็กน้อย|low impact)/i.test(issueTextForPriority)
      ? 'low'
      : 'medium';
  const finalPriorityLevel = finalProblemType === 'Change Request' ? (normalizedPriority || inferredPriority) : '';
  const finalPriorityDetail = finalProblemType === 'Change Request'
    ? String(parsed.priority_detail || parsed.priority_reason || 'ประเมินจาก Criteria / Sub Criteria และข้อมูลที่มีอยู่').trim()
    : '';
  const reasonEvidence = [
    normalizedAIType ? `AI classified as ${normalizedAIType}` : '',
    ticketVoteType ? `Historical tickets suggest ${ticketVoteType}` : '',
    knowledgeVoteType ? `Knowledge context suggests ${knowledgeVoteType}` : '',
    textVoteType ? `Text pattern suggests ${textVoteType}` : '',
  ].filter(Boolean);
  const finalProblemTypeReason = asText(
    parsed.problem_type_reason || parsed.reason,
    reasonEvidence.length ? reasonEvidence.join(' / ') : `เลือก ${finalProblemType} จากรายละเอียดปัญหาและบริบทของโครงการ`
  );
  const confidenceRaw = String(parsed.problem_type_confidence || parsed.confidence || '').trim().toLowerCase();
  const finalConfidence = /^(high|medium|low)$/i.test(confidenceRaw) ? confidenceRaw : (normalizedAIType || ticketVoteType ? 'high' : 'medium');
  const alternativeProblemTypes = asArray(parsed.alternative_problem_types)
    .map(normalizeProblemTypeLabel)
    .filter((value, index, arr) => value && value !== finalProblemType && arr.indexOf(value) === index);
  const compactText = (value, fallback = '') => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    return text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
  };
  const buildLikelyCauseSummary = (problemType, issueText) => {
    const text = String(issueText || '').toLowerCase();
    const sourceHint = compactText(issueTitle || rawDescription || contentText || contentLines[0] || '', '');
    const fallbackByType = {
      Software: 'อาจเกี่ยวกับข้อมูล ระบบ หรือสิทธิ์ผู้ใช้',
      'Human error': 'อาจเกี่ยวข้องกับการทำรายการผิดขั้นตอน',
      'system error': 'อาจเกี่ยวข้องกับระบบหรือการเชื่อมต่อขัดข้อง',
      'System Bug': 'อาจเกี่ยวข้องกับบั๊กใน logic ของระบบ',
      'Change Request': 'เป็นคำขอปรับปรุงหรือเพิ่มฟังก์ชันในระบบ',
      network: 'อาจเกี่ยวข้องกับเครือข่ายหรือการเชื่อมต่อ',
      hardware: 'อาจเกี่ยวข้องกับอุปกรณ์หรือไดรเวอร์',
    };
    if (problemType === 'Human error') {
      if (/(กดผิด|เลือกผิด|ยืนยันผิด|ลงรับผิด|รับผิดเรื่อง|คลิกผิด|ส่งผิด|บันทึกผิด)/i.test(text)) return 'น่าจะเกิดจากการกดหรือยืนยันรายการผิดขั้นตอน';
      if (/(เลขรับ|ทะเบียนรับ|เส้นทางหนังสือ|ลงรับ|รับเรื่อง)/i.test(text)) return 'น่าจะเกิดจากการลงรับหรือจัดการเลขรับผิดขั้นตอน';
      return 'น่าจะเกิดจากการทำรายการผิดขั้นตอน';
    }
    if (problemType === 'system error') {
      if (/(timeout|500|api|endpoint|server|connection|เชื่อมต่อ|ไม่ตอบสนอง)/i.test(text)) return 'อาจเกิดจากระบบหรือ API ตอบกลับไม่สมบูรณ์';
      return 'อาจเกิดจากระบบหรือการเชื่อมต่อขัดข้อง';
    }
    if (problemType === 'System Bug') {
      if (/(logic|เงื่อนไข|flow|ขั้นตอน|คำนวณ|แสดงผล|ผิดปกติ|unexpected|exception)/i.test(text)) return 'อาจเป็นบั๊กใน logic หรือขั้นตอนทำงานของระบบ';
      return 'อาจเป็นบั๊กของระบบจากเงื่อนไขการทำงาน';
    }
    if (problemType === 'Change Request') return 'เป็นคำขอปรับปรุงหรือเพิ่มฟังก์ชันในระบบ';
    if (problemType === 'network') return 'อาจเกิดจากเครือข่ายหรือการเชื่อมต่อไม่เสถียร';
    if (problemType === 'hardware') return 'อาจเกี่ยวกับอุปกรณ์หรือไดรเวอร์ที่ใช้งาน';
    if (/(login|signin|ล็อกอิน|password|otp|auth|session|permission|สิทธิ์)/i.test(text)) return 'อาจเกี่ยวกับสิทธิ์ผู้ใช้หรือการยืนยันตัวตน';
    if (/(data|ข้อมูล|record|mapping|master data|report|รายงาน)/i.test(text)) return 'อาจเกี่ยวกับข้อมูลต้นทางหรือ mapping ของระบบ';
    return fallbackByType[problemType] || fallbackByType.Software || (sourceHint ? `อาจเกี่ยวข้องกับ${compactText(problemType || 'Software')}` : 'อาจเกี่ยวข้องกับข้อมูล ระบบ หรือสิทธิ์ผู้ใช้');
  };
  const fallbackPossibleCauses = (() => {
    const causeMap = {
      'Human error': [{ cause: 'ผู้ใช้อาจเลือกหรือยืนยันรายการผิด', reason: 'รายละเอียดมีลักษณะเป็นการแก้ไขรายการ/เลขรับ/เส้นทางหลังจาก action ของผู้ใช้', evidence: reasonEvidence, what_to_check_next: ['เลขเอกสารหรือรายการที่ต้องแก้', 'transaction log', 'เส้นทางหนังสือก่อนแก้ไข'] }],
      'system error': [{ cause: 'ระบบหรือ API อาจตอบกลับไม่สำเร็จ', reason: 'รายละเอียดมีลักษณะ timeout/server/error หรือ endpoint ไม่ตอบสนอง', evidence: reasonEvidence, what_to_check_next: ['server log', 'HTTP status', 'ช่วงเวลาที่เกิดเหตุ', 'payload ที่ส่งเข้า API'] }],
      'System Bug': [{ cause: 'logic ของระบบอาจทำงานผิดจากผลลัพธ์ที่ควรเป็น', reason: 'รายละเอียดชี้ว่าผู้ใช้ทำขั้นตอนถูก แต่ผลลัพธ์ผิดปกติ', evidence: reasonEvidence, what_to_check_next: ['ขั้นตอนทำซ้ำ', 'expected vs actual result', 'recent deploy', 'ข้อมูลตัวอย่าง'] }],
      'Change Request': [{ cause: 'ระบบเดิมอาจยังไม่รองรับความต้องการใหม่', reason: 'รายละเอียดเป็นการขอเพิ่ม/ปรับ/เปลี่ยนพฤติกรรมของระบบ', evidence: reasonEvidence, what_to_check_next: ['impact', 'urgency', 'criteria', 'sub criteria', 'scope ที่ต้องพัฒนา'] }],
      Software: [{ cause: 'อาจเกี่ยวข้องกับข้อมูล, สิทธิ์, session, report หรือ mapping', reason: 'ยังไม่เข้าเงื่อนไขเฉพาะของ bug/error/change request อย่างชัดเจน', evidence: reasonEvidence, what_to_check_next: ['master data', 'user permission', 'session/auth', 'mapping หรือ report parameter'] }],
      network: [{ cause: 'การเชื่อมต่อเครือข่ายอาจไม่สมบูรณ์', reason: 'รายละเอียดมีลักษณะ connection/VPN/LAN/Wi-Fi', evidence: reasonEvidence, what_to_check_next: ['VPN/LAN/Wi-Fi', 'DNS/firewall', 'endpoint reachability'] }],
      hardware: [{ cause: 'อุปกรณ์หรือ driver อาจมีปัญหา', reason: 'รายละเอียดเกี่ยวข้องกับเครื่องหรืออุปกรณ์ปลายทาง', evidence: reasonEvidence, what_to_check_next: ['สาย/ไฟ/connection', 'driver', 'สถานะอุปกรณ์'] }],
    };
    return causeMap[finalProblemType] || causeMap.Software;
  })();
  const parsedPossibleCauses = Array.isArray(parsed.possible_causes)
    ? parsed.possible_causes.map((item) => {
        if (typeof item === 'string') return { cause: item, reason: '', evidence: [], what_to_check_next: [] };
        return {
          cause: asText(item?.cause || item?.title || item?.name, ''),
          reason: asText(item?.reason || item?.detail, ''),
          evidence: asArray(item?.evidence),
          what_to_check_next: asArray(item?.what_to_check_next || item?.checklist || item?.next_steps),
        };
      }).filter((item) => item.cause || item.reason)
    : [];

  return {
    problem_type: finalProblemType,
    problem_type_reason: finalProblemTypeReason,
    problem_type_confidence: finalConfidence,
    alternative_problem_types: alternativeProblemTypes,
    severity: asText(parsed.severity, 'medium'),
    priority_level: finalPriorityLevel,
    priority_detail: finalPriorityDetail,
    impact: asText(parsed.impact, ''),
    urgency: asText(parsed.urgency, ''),
    criteria: asText(parsed.criteria || parsed.criteria_name, ''),
    sub_criteria: asText(parsed.sub_criteria || parsed.sub_criteria_name, ''),
    module_or_area: asText(parsed.module_or_area, department || projectName || 'General'),
    summary: asText(parsed.summary, issueTitle || rawDescription || '-'),
    likely_cause: (() => {
      const parsedLikelyCause = asText(parsed.likely_cause, '');
      if (parsedLikelyCause && !/(ยังไม่ชัดเจน|ไม่ชัดเจน|วิเคราะห์จากข้อมูลที่มีอยู่|จากข้อมูลที่มีอยู่|unclear|unknown|not sure)/i.test(parsedLikelyCause)) {
        return compactText(parsedLikelyCause, buildLikelyCauseSummary(finalProblemType, issueTextForAnalysis));
      }
      return buildLikelyCauseSummary(finalProblemType, issueTextForAnalysis);
    })(),
    possible_causes: parsedPossibleCauses.length ? parsedPossibleCauses : fallbackPossibleCauses,
    quick_fixes: Array.isArray(parsed.quick_fixes) ? parsed.quick_fixes : [],
    clarifying_questions: Array.isArray(parsed.clarifying_questions) ? parsed.clarifying_questions : [],
    when_to_escalate: asText(parsed.when_to_escalate, 'ยังไม่ชัดเจน'),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    parsed_issue_title: asText(parsed.parsed_issue_title || parsedFields.issueTitle, issueTitle || ''),
    parsed_requester: asText(parsed.parsed_requester || parsedFields.requesterName, requester || ''),
    parsed_reported_at: asText(parsed.parsed_reported_at || parsedFields.reportedAt, reportedAt || ''),
    parsed_department: asText(parsed.parsed_department || parsedFields.department || parsedFields.area, department || ''),
    parsed_content_lines: Array.isArray(parsed.parsed_content_lines) ? parsed.parsed_content_lines : (Array.isArray(parsedFields.contentLines) ? parsedFields.contentLines : contentLines),
    parsed_content_text: asText(parsed.parsed_content_text || parsedFields.contentText, contentText || rawDescription || ''),
    parsed_urls: Array.isArray(parsed.parsed_urls) ? parsed.parsed_urls : (Array.isArray(parsedFields.urls) ? parsedFields.urls : urls),
    linked_knowledge: Array.isArray(parsed.linked_knowledge) ? parsed.linked_knowledge : knowledgeRows.map((row) => ({ title: row.title || '', tags: row.tags || '' })),
    linked_tickets: Array.isArray(parsed.linked_tickets) ? parsed.linked_tickets : ticketRows.map((row) => ({ id: row.id || '', title: row.title || '', bug_type: row.bug_type || '', status: row.status || '', project: row.project || '' })),
  };
}

// ── Route handler ─────────────────────────────────────────────────────

async function normalizeHelpdeskTemplateWithAi(env, input = {}) {
  const { azureUrl, azureKey, modelName, isDeploymentUrl } = resolveAzureChatConfig(env);
  const rawText = String(input.description || input.text || '').trim().slice(0, 6000);
  if (!rawText) throw new Error('description is required');
  const payload = {
    messages: [
      {
        role: 'system',
        content: [
          'You extract helpdesk ticket text into exactly 6 fields for a Thai helpdesk form.',
          'Return valid JSON only. Do not add markdown.',
          'Shape:',
          '{"issueTitle":"","requester":"","reportedAt":"","area":"","employeeCode":"","details":[""],"confidence":"low|medium|high","notes":""}',
          'Rules:',
          '- Preserve original wording as much as possible.',
          '- If the input appears to be 6 positional lines, map line 1 title, line 2 requester, line 3 reportedAt, line 4 area, line 5 employeeCode, line 6+ details.',
          '- URLs and numbered sub-items belong in details.',
          '- Do not invent missing required values. Leave missing fields empty and set confidence low.',
          '- reportedAt may keep the original format if present.',
        ].join('\n'),
      },
      { role: 'user', content: ['Raw helpdesk text:', rawText].join('\n') },
    ],
    temperature: 0,
    max_tokens: 700,
  };
  if (!isDeploymentUrl) payload.model = modelName;

  const res = await fetch(azureUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': azureKey,
      ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Azure AI error (${res.status}): ${raw.slice(0, 300)}`);
  const jsonResp = JSON.parse(raw);
  const content = stripCodeFences(jsonResp?.choices?.[0]?.message?.content || '');
  if (!content) throw new Error('AI returned empty template detection');

  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('AI did not return valid JSON');
    parsed = JSON.parse(content.slice(start, end + 1));
  }
  const details = Array.isArray(parsed.details)
    ? parsed.details.map((line) => String(line || '').trim()).filter(Boolean)
    : String(parsed.details || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	  const fields = {
	    issueTitle: String(parsed.issueTitle || '').trim(),
	    requester: String(parsed.requester || '').trim(),
	    reportedAt: String(parsed.reportedAt || '').trim(),
	    area: String(parsed.area || '').trim(),
    employeeCode: String(parsed.employeeCode || '').trim(),
    details,
	    confidence: /^(low|medium|high)$/i.test(String(parsed.confidence || '')) ? String(parsed.confidence).toLowerCase() : 'medium',
	    notes: String(parsed.notes || '').trim(),
	  };
	  const requiredFields = [
	    { no: 1, key: 'issueTitle', label: 'หัวข้อ' },
	    { no: 2, key: 'requester', label: 'ชื่อผู้แจ้ง' },
	    { no: 3, key: 'reportedAt', label: 'วันเวลารับแจ้ง' },
	    { no: 4, key: 'area', label: 'Area' },
	    { no: 5, key: 'employeeCode', label: 'รหัสพนักงาน' },
	    { no: 6, key: 'details', label: 'รายละเอียด' },
	  ];
	  const missing = requiredFields
	    .filter((field) => field.key === 'details'
	      ? !fields.details.length
	      : !String(fields[field.key] || '').trim())
	    .map((field) => ({ no: field.no, key: field.key, label: field.label }));
	  const normalizedText = [
    `1.หัวข้อ: ${fields.issueTitle}`,
    `2.ชื่อผู้แจ้ง: ${fields.requester}`,
    `3.วันเวลารับแจ้ง: ${fields.reportedAt}`,
    `4.Area: ${fields.area}`,
    `5.ให้กรอกรหัสพนักงานตัวเอง: ${fields.employeeCode}`,
    '6.รายละเอียด:',
    ...fields.details,
  ].join('\n').trim();
	  return {
	    fields,
	    normalizedText,
	    complete: missing.length === 0,
	    missing,
	    missingText: missing.map((field) => `ข้อ ${field.no} ${field.label}`).join(', '),
	  };
	}

export async function handleHelpdesk(path, method, request, env) {
  const url = new URL(request.url);

  /* ── POST /helpdesk/ticket ─────────────────────────────── */
  if (path === '/helpdesk/ticket' && method === 'POST') {
    const s = await requireAuth(request, env);
    const payload = await request.json();
    const title = (payload.title || payload.subject || payload.case_subject || '').trim();
    const description = (payload.description || payload.case_desc || '').trim();
    if (!title) return err('title/subject is required');

    const requestHost = String(url.hostname || '').trim().toLowerCase();
    const isLocalHelpdeskRuntime = requestHost === '127.0.0.1' || requestHost === 'localhost';
    const odooDefaults = {
      url: 'http://bt.dev.demotoday.net',
      db: 'bt-helpdesk',
      login: 'admin',
      password: 'bt@admin',
      channel: 'Website',
    };
    const ODOO_URL = String(
      env.ODOO_URL ||
      env.ODOO_BASE_URL ||
      env.ODOO_PUBLIC_URL ||
      env.ODOO_HOST ||
      odooDefaults.url ||
      'http://bt.dev.demotoday.net'
    ).replace(/\/$/, '');
    const ODOO_DB  = env.ODOO_DB  || odooDefaults.db;
    const ODOO_LOGIN = String(env.ODOO_LOGIN || env.ODOO_USER || odooDefaults.login || '').trim();
    const ODOO_PASSWORD = String(env.ODOO_PASSWORD || odooDefaults.password || '').trim();
    const directCreateSetting = String(env.ODOO_DIRECT_CREATE || '').trim().toLowerCase();
    const allowLegacyInsertCase = ['legacy', 'insert_case', 'fallback'].includes(directCreateSetting);
    const useDirectOdooCreate = !!ODOO_LOGIN && !!ODOO_PASSWORD && directCreateSetting !== '0' && !allowLegacyInsertCase;

    const channel = payload.channel || env.ODOO_CHANNEL || odooDefaults.channel;
    const channelId = payload.channel_id || resolveOdooChannelId(channel);
    const normalizedCaseType = normalizeOdooCaseType(payload.case_type || payload.bug_type || 'Ticket');
    const normalizedCaseTypeName = caseTypeDisplayLabel(normalizedCaseType);
    const normalizedAreaSubLabel = String(payload.area_sub_name || payload.case_type_name || '').trim() || mapCaseTypeToAreaSubLabel(normalizedCaseType);
    const imagesSource = Array.isArray(payload.images) ? payload.images : Array.isArray(payload.case_images) ? payload.case_images : [];
    const images = imagesSource.map((img) => (typeof img === 'string' ? { image: img } : img && typeof img === 'object' ? img : { image: String(img || '') })).filter((img) => String(img.image || '').trim());
    const attachmentsSource = Array.isArray(payload.attachments) ? payload.attachments
      : Array.isArray(payload.case_attachments) ? payload.case_attachments
        : Array.isArray(payload.files) ? payload.files
          : [];
    const chatMessagesSource = collectOdooChatMessages(payload, payload.case_date || payload.reported_at || payload.reportedAt || '');
    const rawTicketStatus = String(payload.ticket_status || payload.case_status || payload.status || 'open').trim().toLowerCase();
    const routeMode = String(payload.route_mode || '').trim().toLowerCase();
    const ticketStatus = ['closed', 'done', 'resolved'].includes(rawTicketStatus)
      ? 'closed'
      : ['process', 'in_process', 'in progress', 'in-progress', 'assigned'].includes(rawTicketStatus) || routeMode === 'forward'
        ? 'process'
        : 'open';
    const delegateOfficerId = extractOdooNumericId(payload.delegate_officer_id || payload.route_target_employee_id || payload.route_target || '');
    const assignDevRowName = Array.isArray(payload.assign_dev_rows)
      ? String(payload.assign_dev_rows.find((item) => item && typeof item === 'object' && (item.assign_emp_name || item.employee_name))?.assign_emp_name || '').trim()
      : '';
    const delegateOfficerName = String(payload.delegate_officer || payload.assign_dev_name || assignDevRowName || payload.assigned_dev || payload.route_target || '').trim();
    const requesterName = String(payload.requester || payload.requester_name || payload.customer || payload.customer_name || payload.activity_contact_name || '').trim();
    const activityStatus = Number(payload.activity_status);
    const hasActivityStatus = Number.isFinite(activityStatus);
    const extraPayload = {
      template_description: String(payload.template_description || payload.templateDescription || payload.original_description || description).trim(),
      templateDescription: String(payload.template_description || payload.templateDescription || payload.original_description || description).trim(),
      template_issue_title: String(payload.template_issue_title || payload.issueTitle || title).trim(),
      template_requester: String(payload.template_requester || payload.requester || payload.requester_name || '').trim(),
      template_reported_at: String(payload.template_reported_at || payload.reportedAt || payload.reported_at || '').trim(),
      template_area: String(payload.template_area || payload.area || payload.area_name || payload.department || '').trim(),
      template_employee_code: String(payload.template_employee_code || payload.employee_code || payload.employeeCode || '').trim(),
      template_content_text: String(payload.template_content_text || payload.contentText || payload.case_desc || description).trim(),
      area: String(payload.area || payload.area_name || payload.department || payload.location || '').trim(),
      area_name: String(payload.area_name || payload.area || payload.department || payload.location || '').trim(),
      area_id: String(payload.area_id || payload.areaId || '').trim(),
      department: String(payload.department || payload.area_name || payload.area || '').trim(),
      project_name: payload.project_name || '',
      sub_project: payload.sub_project || '',
      sub_project_name: payload.sub_project_name || '',
      service_id: payload.service_id || payload.project || '',
      service_sub_id: payload.service_sub_id || payload.sub_project || '',
      case_ticket_id: payload.case_ticket_id || payload.uuid || '',
      case_subject: payload.case_subject || title,
      case_desc: payload.case_desc || description,
      case_note: payload.case_note || '',
      problem_cause_remark: payload.problem_cause_remark || payload.likely_cause || '',
      customer: requesterName,
      case_type: normalizedCaseType,
      case_type_name: payload.case_type_name || payload.case_type || payload.bug_type || '',
      priority: payload.priority || '',
      priority_id: payload.priority_id || null,
      route_mode: payload.route_mode || '',
      route_target: payload.route_target || '',
      delegate_team_id: payload.delegate_team_id || '',
      delegate_team: payload.delegate_team || '',
      delegate_officer_id: payload.delegate_officer_id || '',
      delegate_officer: payload.delegate_officer || payload.assigned_dev || payload.route_target || '',
      assign_dev_name: payload.assign_dev_name || delegateOfficerName || '',
      activity_contact_name: payload.activity_contact_name || '',
      activity_tel: payload.activity_tel || '',
      activity_email: payload.activity_email || '',
      activity_description: payload.activity_description || '',
      employee_code: payload.employee_code || payload.employeeCode || '',
      case_images: imagesSource,
      case_attachments: attachmentsSource,
      odoo_chat_messages: chatMessagesSource,
    };

    const uuid = payload.uuid || s.user_id || uid().slice(0, 12);

    const persistLocalTicket = async (odooTicketId = '') => {
      const externalTicketId = String(odooTicketId || '').trim();
      const localTicketId = 'hdt_' + uid().slice(0, 8);
      const kanbanStatus = ticketStatus === 'closed' ? 'closed' : (routeMode === 'forward' ? 'process' : ticketStatus);
      const kanbanProject = extraPayload.project_name || payload.project_name || payload.service_name || payload.service_id || payload.project || null;
      const kanbanType = extraPayload.case_type_name || normalizedCaseTypeName || payload.case_type || payload.bug_type || normalizedCaseType || null;
      const kanbanAssigned = extraPayload.delegate_officer || extraPayload.owner_officer || delegateOfficerName || payload.assigned_dev || payload.route_target || null;
      const kanbanExtra = {
        ...extraPayload,
        kanban_mirror: true,
        kanban_source: externalTicketId ? 'odoo_ticket_create' : 'local_ticket_create',
        kanban_status: kanbanStatus,
        mirrored_at: new Date().toISOString(),
      };
      try {
        const existing = externalTicketId
          ? await pgFirst(env, `SELECT id FROM helpdesk_tickets WHERE odoo_ticket_id=$1 LIMIT 1`, [externalTicketId])
          : null;
        if (existing?.id) {
          await pgQuery(env,
            `UPDATE helpdesk_tickets
             SET title=$2, description=$3, project=$4, bug_type=$5, status=$6, module=$7, location=$8,
                 assigned_dev=$9, created_by=$10, extra=$11, updated_at=now()
             WHERE id=$1`,
            [
              existing.id, title, description,
              kanbanProject,
              kanbanType,
              kanbanStatus,
              payload.module || payload.service_name || payload.department || null,
              extraPayload.area || payload.location || payload.department || null,
              kanbanAssigned,
              s.user_id,
              JSON.stringify(kanbanExtra),
            ]
          );
          return existing.id;
        }
        await pgQuery(env,
          `INSERT INTO helpdesk_tickets (id, title, description, project, bug_type, status, module, location, assigned_dev, created_by, odoo_ticket_id, extra)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            localTicketId, title, description,
            kanbanProject,
            kanbanType,
            kanbanStatus,
            payload.module || payload.service_name || payload.department || null,
            extraPayload.area || payload.location || payload.department || null,
            kanbanAssigned,
            s.user_id,
            externalTicketId,
            JSON.stringify(kanbanExtra),
          ]
        );
      } catch (_) {}
      return localTicketId;
    };

    const odooProjectId = await resolveOdooProjectId(env, payload.project_code || payload.project || payload.service_id || '', payload.project_name || '');
    const odooSubProjectId = await resolveOdooSubProjectId(env, payload.sub_project_code || payload.sub_project || payload.service_sub_id || '', payload.sub_project_name || '', odooProjectId);
    const odooPriority = await resolveOdooPriority(env, odooProjectId, payload.priority || 'Medium', payload.priority_id || null);
    const odooAreaText = payload.area || payload.area_name || payload.department || payload.location || payload.module || '';
    const explicitAreaId = extractOdooNumericId(payload.area_id || payload.areaId || '');
    const odooAreaId = explicitAreaId || await resolveOdooAreaIdByText(env, odooProjectId, odooAreaText) || await resolveOdooDefaultAreaId(env, odooProjectId);
    const normalizedCriteriaLabel = normalizeOdooCriteriaLabel(payload.criteria || payload.criteria_name || '');
    const odooCriteriaId = normalizedCriteriaLabel
      ? (odooCriteriaIdFromLabel(normalizedCriteriaLabel) || await resolveOdooCriteriaIdByText(env, normalizedCriteriaLabel))
      : '';
    const projectOwnerInfo = await resolveOdooOwnerInfo(env, odooProjectId, payload.project_name ? (payload.service_id || payload.project || '') : (payload.project_code || payload.service_code || payload.service_id || payload.project || ''), payload.project_name || '');
    const employeeOwnerInfo = await resolveOdooOwnerByEmployeeCode(env, payload.employee_code || payload.employeeCode || '');
    const odooOwnerInfo = {
      ...projectOwnerInfo,
      ...(employeeOwnerInfo.owner_officer_id ? employeeOwnerInfo : {}),
    };
    extraPayload.odoo_project_id = odooProjectId || '';
    extraPayload.odoo_sub_project_id = odooSubProjectId || '';
    extraPayload.odoo_priority = odooPriority.priority || '';
    extraPayload.odoo_priority_id = odooPriority.priority_id || null;
    extraPayload.odoo_priority_level = odooPriority.priority_level || '';
    extraPayload.odoo_area_id = odooAreaId || '';
    extraPayload.odoo_criteria_id = odooCriteriaId || '';
    extraPayload.odoo_case_type = normalizedCaseType || '';
    extraPayload.odoo_case_type_name = normalizedCaseTypeName || '';
    extraPayload.odoo_area_sub_label = normalizedAreaSubLabel || '';
    extraPayload.odoo_owner_team_id = odooOwnerInfo.owner_team_id || '';
    extraPayload.odoo_owner_officer_id = odooOwnerInfo.owner_officer_id || '';
    extraPayload.odoo_delegate_team_id = payload.delegate_team_id || odooOwnerInfo.owner_team_id || '';
    extraPayload.odoo_delegate_officer_id = delegateOfficerId || '';
    const odooCaseDate = await normalizeOdooDatetimeWithAi(env, payload.case_date || payload.reported_at || payload.reportedAt || null);
    const odooActiveDate = await normalizeOdooDatetimeWithAi(env, payload.active_date || null);
    const odooFinishDate = await normalizeOdooDatetimeWithAi(env, payload.finish_date || payload.case_date_finish || null);
    const odooCaseDateProcess = await normalizeOdooDatetimeWithAi(env, payload.case_date_process || null);
    const odooCaseDateFinish = await normalizeOdooDatetimeWithAi(env, payload.case_date_finish || payload.finish_date || null);
    const odooParams = {
      db: ODOO_DB, channel, channel_id: channelId, uuid,
      case_subject: title, case_desc: description,
      case_date: odooCaseDate,
      active_date: odooActiveDate,
      finish_date: odooFinishDate,
      case_date_process: odooCaseDateProcess,
      case_date_finish: odooCaseDateFinish,
      project: odooProjectId || payload.service_id || payload.project || null,
      project_name: payload.project_name || '',
      service_id: odooProjectId || payload.service_id || payload.project || null,
      service_name: payload.project_name || '',
      project_service: odooProjectId || payload.service_id || payload.project || null,
      project_service_id: odooProjectId || payload.service_id || payload.project || null,
      project_service_name: payload.project_name || '',
      sub_project: odooSubProjectId || payload.service_sub_id || payload.sub_project || null,
      sub_project_name: payload.sub_project_name || '',
      service_sub_id: odooSubProjectId || payload.service_sub_id || payload.sub_project || null,
      service_sub_name: payload.sub_project_name || '',
      project_service_sub: odooSubProjectId || payload.service_sub_id || payload.sub_project || null,
      project_service_sub_id: odooSubProjectId || payload.service_sub_id || payload.sub_project || null,
      project_service_sub_name: payload.sub_project_name || '',
      case_lat: payload.case_lat || payload.lat || null,
      case_lng: payload.case_lng || payload.lng || null,
      area_id: odooAreaId || null, area_sub_id: payload.area_sub_id || null,
      area_sub_name: normalizedAreaSubLabel || '',
      case_type: normalizedCaseType, case_type_name: normalizedCaseTypeName,
      criteria: normalizedCriteriaLabel || '', criteria_id: odooCriteriaId || null,
      criteria_name: normalizedCriteriaLabel || '',
      owner_team_id: odooOwnerInfo.owner_team_id || null,
      owner_team_name: odooOwnerInfo.owner_team_name || '',
      owner_officer_id: odooOwnerInfo.owner_officer_id || null,
      owner_officer_name: odooOwnerInfo.owner_officer_name || '',
      delegate_team_id: payload.delegate_team_id || odooOwnerInfo.owner_team_id || null,
      delegate_team_name: payload.delegate_team || odooOwnerInfo.owner_team_name || '',
      delegate_officer_id: delegateOfficerId || null,
      delegate_officer_name: delegateOfficerName || '',
      assign_dev_name: delegateOfficerName || '',
      team_id: odooOwnerInfo.owner_team_id || null,
      activity_contact_name: payload.requester || payload.requester_name || payload.activity_contact_name || payload.contact_name || requesterName || s.full_name || '',
      activity_tel: payload.activity_tel || payload.tel || payload.phone || '',
      activity_email: payload.activity_email || payload.email || s.email || '',
      activity_status: hasActivityStatus ? activityStatus : 1,
      activity_description: payload.activity_description || '',
      case_status: ticketStatus, ticket_status: ticketStatus, case_images: images,
      case_ticket_id: payload.case_ticket_id || payload.uuid || '',
      case_note: payload.case_note || description,
      customer: requesterName || s.full_name || '',
      customer_name: payload.customer || payload.customer_name || payload.activity_contact_name || s.full_name || '',
      contact_name: payload.activity_contact_name || payload.contact_name || payload.customer || payload.customer_name || s.full_name || '',
      partner_name: payload.customer || payload.customer_name || payload.activity_contact_name || s.full_name || '',
      priority: String(odooPriority.priority_level || '2'),
      priority_id: odooPriority.priority_id || payload.priority_id || null,
      priority_name: odooPriority.priority || payload.priority || 'Medium',
      priority_level: String(odooPriority.priority_level || '2'),
      priority_detail: payload.priority_detail || '',
      problem_cause_remark: payload.problem_cause_remark || payload.likely_cause || '',
      impact_level: normalizeOdooImpactLevel(payload.impact_level || payload.impact || ''),
      impact: payload.impact || '', urgency: payload.urgency || '',
      change_detail: payload.change_detail || '',
      route_mode: payload.route_mode || '', route_target: payload.route_target || '',
    };
    extraPayload.odoo_request_params = odooParams;

    if (!useDirectOdooCreate && !allowLegacyInsertCase) {
      return err('Odoo direct create is not configured on this runtime. Please set ODOO_LOGIN and ODOO_PASSWORD before creating tickets from this flow.', 503);
    }

    let odooRes;
    let odooData;
    let odooChatSync = null;
    let odooSubmitStage = 'prepare';
    try {
      if (useDirectOdooCreate) {
        odooSubmitStage = 'auth';
        let auth;
        try {
          auth = await odooRpcAuthenticate(ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD);
          auth.mode = 'session';
        } catch (sessionAuthErr) {
          auth = await odooJsonRpcLogin(ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD);
          auth.session_auth_error = String(sessionAuthErr?.message || sessionAuthErr || '').slice(0, 300);
        }
        const callOdoo = (model, rpcMethod, rpcArgs = [], rpcKwargs = {}) => (
          auth.mode === 'execute_kw'
            ? odooExecuteKw(ODOO_URL, ODOO_DB, auth.uid, ODOO_PASSWORD, model, rpcMethod, rpcArgs, rpcKwargs)
            : odooRpcCall(ODOO_URL, auth.session_id, model, rpcMethod, rpcArgs, rpcKwargs)
        );
        const explicitCaseTicketId = String(payload.case_ticket_id || payload.odoo_ticket_id || payload.ticket_no || '').trim();
        odooSubmitStage = 'build_files';
        const imageCommands = await buildOdooImageCommands(env, imagesSource);
        const attachmentCommands = await buildOdooAttachmentCommands(env, attachmentsSource);
        const chatCommands = buildOdooChatCommands(
          chatMessagesSource,
          delegateOfficerId || odooOwnerInfo.owner_officer_id || '',
          payload.case_date || payload.reported_at || payload.reportedAt || ''
        );
        const createVals = {
          channel_id: toOdooInt(channelId),
          service_id: toOdooInt(odooProjectId || payload.service_id || payload.project),
          service_sub_id: toOdooInt(odooSubProjectId || payload.service_sub_id || payload.sub_project),
          area_id: toOdooInt(odooAreaId), area_sub_id: toOdooInt(payload.area_sub_id),
          owner_team_id: toOdooInt(odooOwnerInfo.owner_team_id),
          owner_officer_id: toOdooInt(odooOwnerInfo.owner_officer_id),
          delegate_team_id: toOdooInt(payload.delegate_team_id || odooOwnerInfo.owner_team_id),
          delegate_officer_id: toOdooInt(delegateOfficerId),
          priority_id: toOdooInt(odooPriority.priority_id || payload.priority_id),
          case_ticket_id: explicitCaseTicketId,
          case_subject: title, case_desc: description, case_note: payload.case_note || description,
          case_status: ticketStatus,
          customer: requesterName || s.full_name || '',
          case_type: normalizedCaseType, uuid,
          case_date: odooCaseDate,
          active_date: odooActiveDate,
          finish_date: odooFinishDate,
          case_date_process: odooCaseDateProcess,
          case_date_finish: odooCaseDateFinish,
          impact_level: normalizeOdooImpactLevel(payload.impact_level || payload.impact || ''),
          problem_cause_remark: payload.problem_cause_remark || payload.likely_cause || '',
          change_detail: payload.change_detail || '',
          activity_ids: [[0, 0, {
            activity_date: odooCaseDate,
            activity_contact_name: payload.requester || payload.requester_name || payload.activity_contact_name || payload.contact_name || requesterName || s.full_name || '',
            activity_tel: payload.activity_tel || payload.tel || payload.phone || '',
            activity_email: payload.activity_email || payload.email || s.email || '',
            activity_status: hasActivityStatus ? activityStatus : 1,
            activity_description: payload.activity_description || '',
          }]],
        };
        if (imageCommands.length) createVals.image_ids = imageCommands;
        if (attachmentCommands.length) createVals.attach_ids = attachmentCommands;
        if (routeMode === 'forward' && delegateOfficerId) {
          const assignDate = odooCaseDateProcess || odooActiveDate || odooCaseDate || '';
          const assignDueDate = odooFinishDate || odooCaseDateFinish || assignDate || '';
          createVals.assign_dev_ids = [[0, 0, {
            assign_emp_id: toOdooInt(delegateOfficerId),
            assign_date: assignDate, assign_due_date: assignDueDate,
            assign_status: 'assign',
          }]];
        }
        if (odooCriteriaId) createVals.criteria_id = toOdooInt(odooCriteriaId);
        Object.keys(createVals).forEach((key) => {
          const value = createVals[key];
          if (value === null || value === '' || value === undefined) delete createVals[key];
        });
        if (Array.isArray(createVals.activity_ids)) {
          createVals.activity_ids = createVals.activity_ids.map((command) => {
            if (!Array.isArray(command) || !command[2] || typeof command[2] !== 'object') return command;
            const vals = { ...command[2] };
            if (!vals.activity_date) delete vals.activity_date;
            if (!vals.activity_contact_name) delete vals.activity_contact_name;
            if (!vals.activity_tel) delete vals.activity_tel;
            if (!vals.activity_email) delete vals.activity_email;
            if (!vals.activity_description) delete vals.activity_description;
            return [command[0], command[1], vals];
          });
        }
        if (Array.isArray(createVals.assign_dev_ids)) {
          createVals.assign_dev_ids = createVals.assign_dev_ids.map((command) => {
            if (!Array.isArray(command) || !command[2] || typeof command[2] !== 'object') return command;
            const vals = { ...command[2] };
            if (!vals.assign_date) delete vals.assign_date;
            if (!vals.assign_due_date) delete vals.assign_due_date;
            return [command[0], command[1], vals];
          });
        }
        extraPayload.odoo_direct_create_vals = createVals;

        odooSubmitStage = 'create_case';
        const createdId = await callOdoo('tcp.txn.case', 'create', [createVals], {});
        // Odoo custom defaults can replace service relations during create. Verify and repair
        // them immediately so a case cannot keep a Sub Project from another service.
        odooSubmitStage = 'verify_service_relations';
        const expectedServiceId = toOdooInt(odooProjectId);
        const expectedSubServiceId = toOdooInt(odooSubProjectId);
        const createdRows = await callOdoo('tcp.txn.case', 'read', [[createdId], ['service_id', 'service_sub_id']], {});
        const createdRow = Array.isArray(createdRows) ? (createdRows[0] || {}) : {};
        const actualServiceId = toOdooInt(odooRelationId(createdRow.service_id));
        const actualSubServiceId = toOdooInt(odooRelationId(createdRow.service_sub_id));
        const relationFix = {};
        if (expectedServiceId && actualServiceId !== expectedServiceId) relationFix.service_id = expectedServiceId;
        if (expectedSubServiceId && actualSubServiceId !== expectedSubServiceId) relationFix.service_sub_id = expectedSubServiceId;
        if (Object.keys(relationFix).length) {
          await callOdoo('tcp.txn.case', 'write', [[createdId], relationFix], {});
          const verifiedRows = await callOdoo('tcp.txn.case', 'read', [[createdId], ['service_id', 'service_sub_id']], {});
          const verifiedRow = Array.isArray(verifiedRows) ? (verifiedRows[0] || {}) : {};
          if (expectedServiceId && toOdooInt(odooRelationId(verifiedRow.service_id)) !== expectedServiceId
            || expectedSubServiceId && toOdooInt(odooRelationId(verifiedRow.service_sub_id)) !== expectedSubServiceId) {
            throw new Error('Odoo บันทึก Project/Sub Project ไม่ตรงกับที่เลือก กรุณาตรวจสอบข้อมูล Master ใน Odoo');
          }
        }
        if (chatCommands.length) {
          odooSubmitStage = 'sync_chat';
          const chatVals = odooCommandVals(chatCommands).map((vals) => ({ ...vals, case_id: createdId }));
          const createdChatIds = [];
          const chatErrors = [];
          for (const vals of chatVals) {
            try {
              createdChatIds.push(await callOdoo('tcp.txn.case.chat', 'create', [vals], {}));
            } catch (chatErr) {
              chatErrors.push(String(chatErr?.message || chatErr || 'Odoo chat sync failed').slice(0, 500));
            }
          }
          odooChatSync = {
            attempted: chatVals.length,
            created: createdChatIds.length,
            ids: createdChatIds,
            errors: chatErrors,
          };
          extraPayload.odoo_chat_sync = odooChatSync;
        }
        odooSubmitStage = 'read_case';
        const records = await callOdoo('tcp.txn.case', 'read',
          [[createdId], ['case_ticket_id','service_id','service_sub_id','priority_id','channel_id','area_id','area_sub_id','customer','case_type','criteria_id','impact_level','owner_team_id','owner_officer_id','delegate_team_id','delegate_officer_id','assign_dev_ids','chat_ids','active_date','finish_date','case_date_process','case_date_finish','priority_active_date','priority_finish_date']], {});
        const directRecord = Array.isArray(records) ? (records[0] || {}) : {};
        odooData = {
          result: {
            status: 200,
            response: { id: createdId, case_ticket_id: directRecord.case_ticket_id || createdId, ...directRecord, chat_sync: odooChatSync },
            mode: 'direct_create',
          },
        };
      } else {
        odooSubmitStage = 'legacy_insert_case';
        odooRes = await fetch(`${ODOO_URL}/api/insert_case`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: odooParams }),
        });
        odooData = await odooRes.json().catch(() => ({}));
      }
    } catch (fetchErr) {
      const localId = await persistLocalTicket('');
      if (String(env.ODOO_LOCAL_FALLBACK || '').trim() === '1') {
        return json({ ok: true, delivery: 'local_fallback', local_id: localId, odoo_stage: odooSubmitStage, warning: `Odoo submit failed at ${odooSubmitStage}: ` + (fetchErr?.message || String(fetchErr)) });
      }
      throw fetchErr;
    }

    if (odooData.error) {
      const msg = odooData.error?.data?.message || odooData.error?.message || 'Odoo error';
      return err('Odoo error: ' + msg, 502);
    }

    const result = odooData.result || {};
    if (result.status !== 200) return err('Odoo rejected: ' + (result.response || 'unknown error'), 502);

    const response = result.response || {};
    const many2OneId = (value) => Array.isArray(value) ? (value[0] || '') : (value || '');
    const many2OneName = (value) => Array.isArray(value) ? (value[1] || '') : '';
    const readableText = (...values) => {
      for (const value of values) {
        const text = String(value || '').trim();
        const compact = text.replace(/\s+/g, '');
        const questionMarks = (compact.match(/\?/g) || []).length;
        if (text && questionMarks < Math.max(3, compact.length / 3)) return text;
      }
      return '';
    };
    const odoo_ticket_id = response?.case_ticket_id || response?.id || null;
    const assignDevIds = Array.isArray(response.assign_dev_ids) ? response.assign_dev_ids : [];
    Object.assign(extraPayload, {
      odoo_response: response,
      odoo_case_id: response.id || null,
      case_ticket_id: odoo_ticket_id || extraPayload.case_ticket_id || uuid,
      project_code: payload.project_code || payload.service_code || payload.service_id || payload.project || '',
      project_name: readableText(many2OneName(response.service_id), payload.project_name, extraPayload.project_name),
      service_id: many2OneId(response.service_id) || odooProjectId || payload.service_id || payload.project || '',
      subproject_code: payload.subproject_code || payload.service_sub_code || payload.service_sub_id || payload.sub_project || '',
      subproject_name: readableText(many2OneName(response.service_sub_id), payload.subproject_name, payload.sub_project_name, extraPayload.sub_project_name, payload.service_sub_id, payload.sub_project),
      service_sub_id: many2OneId(response.service_sub_id) || odooSubProjectId || payload.service_sub_id || payload.sub_project || '',
      priority: readableText(many2OneName(response.priority_id), odooPriority.priority, payload.priority),
      priority_id: many2OneId(response.priority_id) || odooPriority.priority_id || payload.priority_id || '',
      priority_level: odooPriority.priority_level || payload.priority_level || '',
      priority_active_date: response.priority_active_date || payload.active_date || '',
      priority_finish_date: response.priority_finish_date || payload.finish_date || payload.case_date_finish || '',
      channel: readableText(many2OneName(response.channel_id), channel),
      channel_id: many2OneId(response.channel_id) || channelId || '',
      area: readableText(many2OneName(response.area_id), payload.area_name, payload.area, odooAreaText, payload.department, payload.location),
      area_id: many2OneId(response.area_id) || odooAreaId || payload.area_id || '',
      area_sub_id: many2OneId(response.area_sub_id) || payload.area_sub_id || '',
      criteria: readableText(many2OneName(response.criteria_id), normalizedCriteriaLabel, payload.criteria, payload.criteria_name),
      criteria_id: many2OneId(response.criteria_id) || odooCriteriaId || payload.criteria_id || '',
      owner_team: readableText(many2OneName(response.owner_team_id), odooOwnerInfo.owner_team_name),
      owner_team_id: many2OneId(response.owner_team_id) || odooOwnerInfo.owner_team_id || '',
      owner_officer: readableText(many2OneName(response.owner_officer_id), odooOwnerInfo.owner_officer_name),
      owner_officer_id: many2OneId(response.owner_officer_id) || odooOwnerInfo.owner_officer_id || '',
      delegate_team: readableText(many2OneName(response.delegate_team_id), payload.delegate_team, odooOwnerInfo.owner_team_name),
      delegate_team_id: many2OneId(response.delegate_team_id) || payload.delegate_team_id || odooOwnerInfo.owner_team_id || '',
      delegate_officer: readableText(many2OneName(response.delegate_officer_id), delegateOfficerName),
      delegate_officer_id: many2OneId(response.delegate_officer_id) || delegateOfficerId || '',
      assign_dev_ids: assignDevIds,
      assign_dev_count: assignDevIds.length,
      chat_ids: Array.isArray(response.chat_ids) ? response.chat_ids : [],
      case_status: ticketStatus,
      ticket_status: ticketStatus,
      route_mode: payload.route_mode || '',
      route_target: payload.route_target || '',
      customer: response.customer || requesterName || s.full_name || '',
    });
    const localTicketId = await persistLocalTicket(String(odoo_ticket_id || ''));

    return json({
      ok: true, delivery: 'odoo',
      odoo_mode: result.mode || (useDirectOdooCreate ? 'direct_create' : 'insert_case'),
      odoo_ticket_id, case_ticket_id: odoo_ticket_id,
      local_ticket_id: localTicketId,
      chat_sync: result.response?.chat_sync || null,
      detail: result.response,
    });
  }

  /* ── POST /helpdesk/analyze ──────────────────────────── */
  if (path === '/helpdesk/template-normalize' && method === 'POST') {
    await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    try {
      const result = await normalizeHelpdeskTemplateWithAi(env, body || {});
      return json({ ok: true, ...result });
    } catch (templateErr) {
      return err('AI template detection failed: ' + (templateErr?.message || String(templateErr)), 502);
    }
  }

  if (path === '/helpdesk/analyze' && method === 'POST') {
    await requireAuth(request, env);
    const body = await request.json();
    try {
      const analysis = await analyseHelpdeskIssueWith4o(env, body || {});
      return json({ ok: true, analysis });
    } catch (analyzeErr) {
      const issueText = String(body?.description || body?.contentText || body?.issueTitle || '').trim();
      const parsedLines = Array.isArray(body?.contentLines) ? body.contentLines.map((line) => String(line || '').trim()).filter(Boolean) : [];
      const projectName = String(body?.projectName || '').trim();
      const department = String(body?.department || '').trim();
      const problemType = /(เลขรับ|ทะเบียนรับ|ลงรับ|เส้นทางหนังสือ|สารบรรณ|ยกเลิกเลขรับ|คืนเลขรับ|หนังสือ|กดรับผิดเรื่อง)/i.test(issueText)
        ? 'Human error'
        : /(server error|timeout|500|ล่ม|ค้าง|connection refused|failed to fetch|api|endpoint|server)/i.test(issueText)
          ? 'system error'
          : /(bug|logic|behavior|ผิดปกติ|unexpected|crash|exception|ผิดพลาด|fail)/i.test(issueText)
            ? 'System Bug'
            : /(feature request|ขอเพิ่ม|ขอปรับ|enhancement|เพิ่ม field|เพิ่ม dropdown)/i.test(issueText)
              ? 'Change Request'
              : /(hardware|printer|scanner|keyboard|mouse|monitor|อุปกรณ์|เครื่อง)/i.test(issueText)
                ? 'hardware'
                : /(network|wifi|vpn|lan|connection|เชื่อมต่อไม่ได้)/i.test(issueText)
                  ? 'network'
                  : /(data|ข้อมูล|record|mapping|master data)/i.test(issueText)
                    ? 'Software'
                    : 'Software';
      const severity = /(critical|urgent|ด่วน|เร่งด่วน|production|หยุดงาน|ล่มทั้งระบบ|ใช้ไม่ได้)/i.test(issueText) ? 'high' : /(minor|เล็กน้อย|ถามข้อมูล|สอบถาม|clarify|info)/i.test(issueText) ? 'low' : 'medium';
      const priorityLevel = problemType === 'Change Request' ? (/(urgent|critical|เร่งด่วน|ด่วน|production|กระทบหลายคน|ใช้งานไม่ได้)/i.test(issueText) ? 'high' : /(minor|เล็กน้อย|ปรับเล็กน้อย|low impact)/i.test(issueText) ? 'low' : 'medium') : '';
      const priorityDetail = problemType === 'Change Request' ? 'ประเมินจาก Criteria / Sub Criteria และข้อมูลที่มีอยู่' : '';
      const summary = String(body?.issueTitle || parsedLines[0] || issueText || 'Ticket').trim().slice(0, 120);
      const isDatabaseIssue = /(?:\bdb\b|database|sql|query|table|schema|connection|timeout)/i.test(issueText);
      const problemReason = problemType === 'Human error' ? 'รายละเอียดเข้ากลุ่มการกด/เลือก/ลงรับ/เส้นทางหนังสือผิด จึงจัดเป็น Human error' : problemType === 'system error' ? 'รายละเอียดมีลักษณะ server/API/timeout/500 หรือการตอบสนองระบบล้มเหลว' : problemType === 'System Bug' ? 'รายละเอียดมีลักษณะพฤติกรรมระบบผิดปกติหรือ logic ทำงานผิด' : problemType === 'Change Request' ? 'รายละเอียดเป็นการขอเพิ่ม/ปรับ/เปลี่ยนพฤติกรรมระบบ' : problemType === 'network' ? 'รายละเอียดเกี่ยวกับการเชื่อมต่อเครือข่าย' : problemType === 'hardware' ? 'รายละเอียดเกี่ยวกับอุปกรณ์หรือเครื่องปลายทาง' : 'รายละเอียดเข้ากลุ่ม software/data/auth/report ทั่วไป';
      const clarifyingQuestions = isDatabaseIssue ? ['ขอชื่อฐานข้อมูลหรือชื่อตารางที่เกี่ยวข้อง', 'มีข้อความ error หรือ query ที่รันแล้วล้มเหลวไหม', 'เกิดกับทุกคนหรือเฉพาะบาง user'] : ['ขอเลขอ้างอิงของรายการที่ต้องแก้', 'ต้องแก้ฟิลด์ไหน และให้เป็นค่าอะไร', 'เป็นรายการเดียวหรือหลายรายการ'];
      const possibleCauses = [{ cause: problemType === 'Change Request' ? 'ระบบเดิมอาจยังไม่รองรับความต้องการใหม่' : problemType === 'Human error' ? 'ผู้ใช้อาจเลือกหรือยืนยันรายการผิด' : problemType === 'system error' ? 'ระบบหรือ API อาจตอบกลับไม่สำเร็จ' : problemType === 'System Bug' ? 'logic ของระบบอาจทำงานผิดจากผลลัพธ์ที่ควรเป็น' : 'ต้องตรวจข้อมูลบริบทเพิ่มเติม', reason: problemReason, evidence: [summary].filter(Boolean), what_to_check_next: problemType === 'Change Request' ? ['impact', 'urgency', 'criteria', 'sub criteria'] : problemType === 'Human error' ? (isDatabaseIssue ? ['ชื่อฐานข้อมูล/ชื่อตารางที่เกี่ยวข้อง', 'transaction log', 'ข้อมูลก่อนแก้ไข'] : ['เลขเอกสาร/รายการที่ต้องแก้', 'transaction log', 'ข้อมูลก่อนแก้ไข']) : ['เลขรายการหรือ record ที่ตรวจ', 'expected/actual', 'ผู้ใช้และช่วงเวลาที่เกิดปัญหา'] }];
      return json({ ok: true, analysis: { problem_type: problemType, problem_type_reason: problemReason, problem_type_confidence: 'medium', alternative_problem_types: problemType === 'Human error' ? ['Software'] : [], severity, priority_level: priorityLevel, priority_detail: priorityDetail, impact: '', urgency: '', criteria: '', sub_criteria: '', module_or_area: department || projectName || 'General', summary, likely_cause: /(เลขรับ|ทะเบียนรับ|ลงรับ|เส้นทางหนังสือ|สารบรรณ|ยกเลิกเลขรับ|คืนเลขรับ|หนังสือ|กดรับผิดเรื่อง)/i.test(issueText) ? 'มีโอกาสเกี่ยวข้องกับเลขรับ, เส้นทางหนังสือ, หรือการกดเลือก/ยืนยันผิดรายการ' : /(login|signin|ล็อกอิน|password|otp|auth)/i.test(issueText) ? 'อาจเกี่ยวข้องกับ session, สิทธิ์ผู้ใช้, หรือข้อมูลล็อกอินไม่ตรง' : isDatabaseIssue ? 'อาจเกี่ยวข้องกับฐานข้อมูล, query, หรือการเชื่อมต่อระบบ' : /(data|ข้อมูล|record|mapping|master data)/i.test(issueText) ? 'อาจเกี่ยวข้องกับข้อมูลต้นทาง, mapping, หรือ master data ไม่ครบ' : /(network|timeout|api|endpoint|server)/i.test(issueText) ? 'อาจเกี่ยวข้องกับ endpoint, server, timeout, หรือการเชื่อมต่อ' : 'ยังไม่ชัดเจน', possible_causes: possibleCauses, quick_fixes: ['เก็บรายละเอียด error หรือ screenshot ให้ครบ', 'ตรวจช่วงเวลาที่เกิดปัญหาและผู้ใช้ที่ได้รับผลกระทบ', 'ลองทำซ้ำด้วยขั้นตอนเดิมเพื่อแยกสาเหตุ'], clarifying_questions: clarifyingQuestions, when_to_escalate: 'ถ้าตรวจเบื้องต้นแล้วไม่หาย ให้ส่งต่อ Dev พร้อม screenshot, log และขั้นตอนที่ทำ', keywords: Array.from(new Set(String(issueText || '').split(/\s+/).filter((v) => v.length > 2).slice(0, 8))), parsed_issue_title: String(body?.issueTitle || '').trim(), parsed_requester: String(body?.requester || '').trim(), parsed_reported_at: String(body?.reportedAt || '').trim(), parsed_department: String(body?.department || '').trim(), parsed_content_lines: parsedLines, parsed_content_text: String(body?.contentText || body?.description || '').trim(), parsed_urls: Array.isArray(body?.urls) ? body.urls.map((u) => String(u || '').trim()).filter(Boolean) : [], linked_knowledge: [], linked_tickets: [], _source: 'local-fallback', _error: String(analyzeErr?.message || analyzeErr || 'analysis failed') } });
    }
  }

  /* ── POST /helpdesk/kanban/sync ────────────────────────── */
  if (path === '/helpdesk/kanban/sync' && method === 'POST') {
    if (!isInternalKanbanSync(request, env)) await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    const incremental = body.incremental === true;
    const limit = Math.max(1, Math.min(Number(body.limit) || 30000, 30000));
    const cursorRow = incremental
      ? await pgFirst(env, `SELECT MAX(extra->>'odoo_write_date') AS cursor FROM helpdesk_tickets WHERE created_by='odoo-sync'`)
      : null;
    const cursor = String(cursorRow?.cursor || '').trim();
    const domain = incremental && cursor ? [['write_date', '>', cursor]] : [];
    const fields = [
      'id', 'case_ticket_id', 'case_subject', 'case_desc', 'case_status', 'case_type',
      'service_id', 'service_sub_id', 'customer', 'owner_team_id', 'owner_officer_id',
      'delegate_team_id', 'delegate_officer_id', 'priority_id',
      'case_date', 'active_date', 'finish_date', 'case_date_process', 'case_date_finish', 'case_date_cancel',
      'create_date', 'write_date',
    ];
    const callOdoo = await getOdooCaseCaller(env);
    const cases = await callOdoo('tcp.txn.case', 'search_read', [domain], {
      fields,
      order: incremental ? 'write_date asc, id asc' : 'write_date desc, id desc',
      limit,
    });
    const rows = Array.isArray(cases) ? cases : [];
    const ticketNumbers = rows.map((item) => String(item.case_ticket_id || '').trim()).filter(Boolean);
    const odooCaseIds = rows.map((item) => String(item.id || '').trim()).filter(Boolean);
    const existingRows = ticketNumbers.length || odooCaseIds.length
      ? await pgQuery(env,
        `SELECT id, odoo_ticket_id, created_by, updated_at, extra
         FROM helpdesk_tickets
         WHERE odoo_ticket_id = ANY($1::text[])
            OR extra->>'case_ticket_id' = ANY($1::text[])
            OR extra->>'odoo_ticket_id' = ANY($1::text[])
            OR extra->>'odooTicketId' = ANY($1::text[])
            OR extra->>'ticketNo' = ANY($1::text[])
            OR extra->>'odoo_case_id' = ANY($2::text[])
         ORDER BY
           CASE WHEN created_by='odoo-sync' THEN 1 ELSE 0 END,
           updated_at DESC NULLS LAST`,
        [ticketNumbers, odooCaseIds]
      )
      : [];
    const existingByTicket = new Map();
    const existingByOdooCaseId = new Map();
    for (const item of existingRows) {
      const extra = parseTicketExtra(item.extra);
      const keys = [
        item.odoo_ticket_id,
        extra.case_ticket_id,
        extra.odoo_ticket_id,
        extra.odooTicketId,
        extra.ticketNo,
      ].map((value) => String(value || '').trim()).filter(Boolean);
      for (const key of keys) {
        if (!existingByTicket.has(key)) existingByTicket.set(key, item);
      }
      const caseId = String(extra.odoo_case_id || '').trim();
      if (caseId && !existingByOdooCaseId.has(caseId)) existingByOdooCaseId.set(caseId, item);
    }
    let imported = 0;
    let updated = 0;

    for (const item of rows) {
      const odooCaseId = String(item.id || '').trim();
      if (!odooCaseId) continue;
      const ticketNo = String(item.case_ticket_id || `ODOO-${odooCaseId}`).trim();
      const existing = existingByTicket.get(ticketNo) || existingByOdooCaseId.get(odooCaseId);
      const existingExtra = parseTicketExtra(existing?.extra);
      const project = odooRelationName(item.service_id) || odooRelationId(item.service_id);
      const assignedDev = odooRelationName(item.delegate_officer_id) || odooRelationName(item.owner_officer_id);
      const requester = String(existingExtra.template_requester || existingExtra.requester || existingExtra.requester_name || item.customer || existingExtra.customer || '').trim();
      const extra = {
        ...existingExtra,
        odoo_case_id: odooCaseId,
        odoo_case_status: String(item.case_status || '').trim(),
        odoo_create_date: item.create_date || null,
        odoo_write_date: item.write_date || item.create_date || null,
        odoo_case_date: item.case_date || null,
        odoo_active_date: item.active_date || null,
        odoo_finish_date: item.finish_date || null,
        odoo_case_date_process: item.case_date_process || null,
        odoo_case_date_finish: item.case_date_finish || null,
        odoo_case_date_cancel: item.case_date_cancel || null,
        odoo_status_at: getOdooCaseStatusAt(item),
        odoo_synced_at: new Date().toISOString(),
        case_ticket_id: ticketNo,
        projectCode: project,
        projectName: project,
        service_id: odooRelationId(item.service_id),
        subprojectCode: odooRelationName(item.service_sub_id) || odooRelationId(item.service_sub_id),
        subprojectName: odooRelationName(item.service_sub_id),
        service_sub_id: odooRelationId(item.service_sub_id),
        owner_team_id: odooRelationId(item.owner_team_id),
        owner_team: odooRelationName(item.owner_team_id),
        owner_officer_id: odooRelationId(item.owner_officer_id),
        owner_officer: odooRelationName(item.owner_officer_id),
        delegate_team_id: odooRelationId(item.delegate_team_id),
        delegate_team: odooRelationName(item.delegate_team_id),
        delegate_officer_id: odooRelationId(item.delegate_officer_id),
        delegate_officer: odooRelationName(item.delegate_officer_id),
        priority_id: odooRelationId(item.priority_id),
        priority: odooRelationName(item.priority_id),
        customer: String(item.customer || existingExtra.customer || requester || '').trim(),
        requester,
        requester_name: requester,
        case_type: String(item.case_type || '').trim(),
      };
      const rowId = String(existing?.id || `odoo_case_${odooCaseId}`).trim();
      await pgQuery(
        env,
        `INSERT INTO helpdesk_tickets (id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, extra, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()),COALESCE($12::timestamptz, now()))
         ON CONFLICT (odoo_ticket_id) WHERE odoo_ticket_id IS NOT NULL AND odoo_ticket_id <> '' DO UPDATE SET
           title=EXCLUDED.title, description=EXCLUDED.description, project=EXCLUDED.project,
           bug_type=EXCLUDED.bug_type, status=EXCLUDED.status, assigned_dev=EXCLUDED.assigned_dev,
           odoo_ticket_id=EXCLUDED.odoo_ticket_id, extra=EXCLUDED.extra, updated_at=EXCLUDED.updated_at`,
        [
          rowId,
          String(item.case_subject || `Odoo Case ${ticketNo}`).trim(),
          String(item.case_desc || '').trim(),
          project,
          String(item.case_type || 'Ticket').trim() || 'Ticket',
          mapOdooCaseStatusToLocal(item.case_status),
          assignedDev,
          'odoo-sync',
          ticketNo,
          JSON.stringify(extra),
          item.create_date || null,
          item.write_date || item.create_date || null,
        ]
      );
      if (existing) updated += 1;
      else imported += 1;
    }
    return json({ ok: true, imported, updated, total: rows.length, source: 'odoo', incremental, cursor: cursor || null });
  }

  /* ── GET /helpdesk/tickets ─────────────────────────────── */
  if (path === '/helpdesk/tickets' && method === 'GET') {
    const s = await requireAuth(request, env);
    const q = (url.searchParams.get('q') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const year = (url.searchParams.get('year') || '').trim();
    const kanban = ['1', 'true', 'yes'].includes((url.searchParams.get('kanban') || '').trim().toLowerCase());
    const mine = ['1', 'true', 'yes'].includes((url.searchParams.get('mine') || '').trim().toLowerCase());
    const where = [];
    const params = [];
    if (mine) {
      params.push(s.user_id);
      where.push(`created_by=$${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      where.push(`(title ILIKE $${idx} OR description ILIKE $${idx} OR project ILIKE $${idx} OR assigned_dev ILIKE $${idx} OR odoo_ticket_id ILIKE $${idx})`);
    }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    if (year) { params.push(Number(year)); where.push(`EXTRACT(YEAR FROM COALESCE(created_at, updated_at)) = $${params.length}`); }
    const rows = await pgQuery(env, `
      SELECT id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra
      FROM (
        SELECT DISTINCT ON (COALESCE(NULLIF(odoo_ticket_id, ''), NULLIF(extra->>'case_ticket_id', ''), id))
          id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra,
          COALESCE(NULLIF(odoo_ticket_id, ''), NULLIF(extra->>'case_ticket_id', ''), id) AS dedupe_key
        FROM helpdesk_tickets
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY
          COALESCE(NULLIF(odoo_ticket_id, ''), NULLIF(extra->>'case_ticket_id', ''), id),
          CASE WHEN created_by='odoo-sync' THEN 1 ELSE 0 END,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST
      ) deduped
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${kanban ? 30000 : 1000}
    `, params);
    return json({ ok: true, data: rows.map((row) => hydrateHelpdeskTicketRow(row)) });
  }

  /* ── POST /helpdesk/tickets ────────────────────────────── */
  if (path === '/helpdesk/tickets' && method === 'POST') {
    const s = await requireAuth(request, env);
    const b = await request.json().catch(() => ({}));
    const refs = [
      String(b.id || '').trim(),
      String(b.case_ticket_id || '').trim(),
      String(b.odoo_ticket_id || '').trim(),
      String(b.odooTicketId || '').trim(),
      String(b.ticketNo || '').trim(),
      String(b.ticket_id || '').trim(),
    ].filter(Boolean);
    const existing = await findHelpdeskTicketRecord(env, refs);
    const rowId = String(existing?.id || b.id || ('hdt_' + uid().slice(0, 8))).trim();
    const existingExtra = parseTicketExtra(existing?.extra);
    const extra = buildHelpdeskTicketExtra({ ...b, id: rowId }, existingExtra);
    const title = String(b.title || b.issueTitle || extra.issueTitle || b.description || extra.description || 'Ticket').trim();
    const description = String(b.description || extra.description || '').trim();
    const project = String(b.project || b.projectCode || b.project_code || extra.project || extra.projectCode || extra.project_code || '').trim();
    const bugType = String(b.bug_type || b.problem_type || extra.problem_type || extra.bug_type || 'Ticket').trim() || 'Ticket';
    const status = String(b.status || extra.status || existing?.status || 'draft').trim() || 'draft';
    const assignedDev = String(b.assigned_dev || b.assignedDev || extra.assignedDev || extra.assigned_dev || existing?.assigned_dev || '').trim();
    const odooTicketId = String(b.odoo_ticket_id || b.odooTicketId || b.ticketNo || extra.odooTicketId || extra.odoo_ticket_id || extra.ticketNo || existing?.odoo_ticket_id || '').trim();
    if (existing?.id) {
      await pgQuery(
        env,
        `UPDATE helpdesk_tickets
         SET title=$2, description=$3, project=$4, bug_type=$5, status=$6, assigned_dev=$7, odoo_ticket_id=$8, extra=$9, updated_at=now()
         WHERE id=$1`,
        [rowId, title, description, project, bugType, status, assignedDev, odooTicketId, JSON.stringify(extra)]
      );
    } else {
      await pgQuery(
        env,
        `INSERT INTO helpdesk_tickets (id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [rowId, title, description, project, bugType, status, assignedDev, s.user_id, odooTicketId, JSON.stringify(extra)]
      );
    }
    const row = await pgFirst(env, `SELECT id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra FROM helpdesk_tickets WHERE id=$1`, [rowId]);
    return json({ ok: true, data: hydrateHelpdeskTicketRow(row) });
  }

  /* ── GET /helpdesk/tickets/:id ─────────────────────────── */
  if (path.startsWith('/helpdesk/tickets/') && method === 'GET') {
    await requireAuth(request, env);
    const ref = path.split('/')[3];
    if (!ref) return err('Invalid ticket id', 400);
    const row = await findHelpdeskTicketRecord(env, [ref]);
    if (!row) return err('Ticket not found', 404);
    return json({ ok: true, data: hydrateHelpdeskTicketRow(row) });
  }

  /* ── PUT /helpdesk/tickets/:id ─────────────────────────── */
  if (path.startsWith('/helpdesk/tickets/') && method === 'PUT') {
    await requireAuth(request, env);
    const id = path.split('/')[3];
    if (!id) return err('Invalid ticket id', 400);
    const b = await request.json();
    const refs = [id, String(b.case_ticket_id || '').trim(), String(b.odoo_ticket_id || '').trim(), String(b.odooTicketId || '').trim(), String(b.ticketNo || '').trim(), String(b.ticket_id || '').trim()].filter(Boolean);
    let existing = await findHelpdeskTicketRecord(env, refs);
    let resolvedId = String(existing?.id || id).trim();
    if (!existing) return err('Ticket not found', 404);

    if (b.sync_odoo === true && Object.prototype.hasOwnProperty.call(b, 'status')) {
      const odooCaseId = getStoredOdooCaseId(parseTicketExtra(existing.extra));
      if (!odooCaseId) return err('Ticket นี้ยังไม่เชื่อมกับ Odoo จึงเปลี่ยนสถานะจาก Kanban ไม่ได้', 409);
      const callOdoo = await getOdooCaseCaller(env);
      await callOdoo('tcp.txn.case', 'write', [[Number(odooCaseId)], { case_status: mapLocalKanbanStatusToOdoo(b.status) }]);
    }

    const fields = [];
    const params = [];
    const extra = buildHelpdeskTicketExtra(b, parseTicketExtra(existing.extra));

    if (Object.prototype.hasOwnProperty.call(b, 'status')) { params.push(String(b.status || '').trim() || 'open'); fields.push(`status=$${params.length}`); }
    if (Object.prototype.hasOwnProperty.call(b, 'assigned_dev')) { params.push(String(b.assigned_dev || '').trim()); fields.push(`assigned_dev=$${params.length}`); }
    if (Object.prototype.hasOwnProperty.call(b, 'assignedDev') && !Object.prototype.hasOwnProperty.call(b, 'assigned_dev')) { params.push(String(b.assignedDev || '').trim()); fields.push(`assigned_dev=$${params.length}`); }
    if (Object.prototype.hasOwnProperty.call(b, 'title')) { params.push(String(b.title || '').trim() || 'Ticket'); fields.push(`title=$${params.length}`); }
    if (Object.prototype.hasOwnProperty.call(b, 'project') || Object.prototype.hasOwnProperty.call(b, 'projectCode') || Object.prototype.hasOwnProperty.call(b, 'project_code')) {
      params.push(String(b.project || b.projectCode || b.project_code || '').trim());
      fields.push(`project=$${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'odoo_ticket_id') || Object.prototype.hasOwnProperty.call(b, 'odooTicketId') || Object.prototype.hasOwnProperty.call(b, 'ticketNo')) {
      params.push(String(b.odoo_ticket_id || b.odooTicketId || b.ticketNo || '').trim());
      fields.push(`odoo_ticket_id=$${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'bug_type')) { params.push(String(b.bug_type || '').trim() || 'Ticket'); fields.push(`bug_type=$${params.length}`); const nextType = String(b.bug_type || '').trim() || 'Ticket'; extra.problem_type = nextType; extra.analysis = { ...(extra.analysis || {}), problem_type: nextType }; }
    if (Object.prototype.hasOwnProperty.call(b, 'analysis_problem_type')) { const nextType = String(b.analysis_problem_type || '').trim() || 'Ticket'; extra.problem_type = nextType; extra.analysis = { ...(extra.analysis || {}), problem_type: nextType }; if (!Object.prototype.hasOwnProperty.call(b, 'bug_type')) { params.push(nextType); fields.push(`bug_type=$${params.length}`); } }
    if (Object.prototype.hasOwnProperty.call(b, 'description')) { params.push(String(b.description || '')); fields.push(`description=$${params.length}`); }
    if (Object.prototype.hasOwnProperty.call(b, 'extra')) { const incomingExtra = typeof b.extra === 'string' ? tryParseJson(b.extra, {}) : (b.extra || {}); Object.assign(extra, incomingExtra || {}); }

    if (Object.keys(extra).length) { params.push(JSON.stringify(extra)); fields.push(`extra=$${params.length}`); }
    if (!fields.length) return err('No fields to update', 400);
    params.push(resolvedId);
    await pgQuery(env, `UPDATE helpdesk_tickets SET ${fields.join(', ')}, updated_at=now() WHERE id=$${params.length}`, params);
    const row = await pgFirst(env, `SELECT id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra FROM helpdesk_tickets WHERE id=$1`, [resolvedId]);
    return json({ ok: true, data: hydrateHelpdeskTicketRow(row) });
  }

  /* ── Migration endpoints ─────────────────────────────── */
  if (path === '/helpdesk/migrate-import' && method === 'POST') {
    const s = await requireAuth(request, env);
    const { type, data } = await request.json();
    if (type === 'tickets' && Array.isArray(data)) {
      let imported = 0;
      let failed = 0;
      const errors = [];
      for (const ticket of data) {
        try {
          const title = (ticket.title || '').trim();
          if (!title) { failed++; continue; }
          await pgQuery(env,
            `INSERT INTO helpdesk_tickets (id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT(id) DO UPDATE SET title=$2, updated_at=$11`,
            [ticket.id || 'hdt_' + uid().slice(0, 8), title, ticket.description || '', ticket.project || '', ticket.bug_type || 'Ticket', ticket.status || 'open', ticket.assigned_dev || '', ticket.created_by || s.user_id, ticket.odoo_ticket_id || '', ticket.created_at || new Date().toISOString(), ticket.updated_at || new Date().toISOString()]
          );
          imported++;
        } catch (e) {
          failed++;
          errors.push(e.message);
        }
      }
      return json({ ok: true, imported, failed, errors: errors.slice(0, 5) });
    }
    return err('Invalid migration type', 400);
  }

  if (path === '/helpdesk/migrate-status' && method === 'GET') {
    await requireAuth(request, env);
    const ticketCount = await pgFirst(env, `SELECT COUNT(*)::int as count FROM helpdesk_tickets WHERE odoo_ticket_id IS NOT NULL AND odoo_ticket_id != ''`);
    return json({ ok: true, migrated_tickets: ticketCount?.count || 0 });
  }

  return null;
}
