/**
 * routes/line-bot.js — all /line/* endpoints
 */

import { pgQuery, pgFirst } from '../db.js';
import { json, err, uid, tryParseJson, buildAppUrl } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

// ── LINE API helpers ─────────────────────────────────────────────────

function getDefaultLineEvents() {
  return { daily_summary: true, overdue_tasks: true, new_assignments: true, approvals: true };
}

function getDefaultLineConfig() {
  return {
    token: '', secret: '', uid: '',
    reportTime: '08:00', reportFormat: 'summary',
    weekdayOnly: true, notifications: getDefaultLineEvents(),
  };
}

function normalizeLineConfig(raw = {}, webhookUrl = '') {
  const base = getDefaultLineConfig();
  const notifications = { ...base.notifications, ...(raw.notifications || {}) };
  return {
    token: String(raw.token || '').trim(),
    secret: String(raw.secret || '').trim(),
    uid: String(raw.uid || '').trim(),
    reportTime: String(raw.reportTime || base.reportTime).trim() || base.reportTime,
    reportFormat: String(raw.reportFormat || base.reportFormat).trim() || base.reportFormat,
    weekdayOnly: raw.weekdayOnly !== false,
    notifications,
    webhook: webhookUrl,
  };
}

function lineConfigResponse(config = {}) {
  return {
    webhook: config.webhook || '',
    uid: config.uid || '',
    reportTime: config.reportTime || '08:00',
    reportFormat: config.reportFormat || 'summary',
    weekdayOnly: config.weekdayOnly !== false,
    notifications: { ...getDefaultLineEvents(), ...(config.notifications || {}) },
    tokenConfigured: Boolean(config.token),
    secretConfigured: Boolean(config.secret),
  };
}

async function getStoredLineConfig(env, url) {
  const row = await pgFirst(
    env,
    `SELECT id, code, name, extra, active, created_at, updated_at
     FROM hd_master
     WHERE table_name='hd_line_tokens' AND code='line_bot_config'
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const extra = tryParseJson(row?.extra || '{}', {});
  const webhookUrl = buildAppUrl(env, url, '/api/line/webhook');
  return { row, config: normalizeLineConfig(extra, webhookUrl) };
}

async function saveStoredLineConfig(env, url, payload = {}) {
  const existing = await getStoredLineConfig(env, url);
  const merged = {
    ...existing.config,
    ...(payload.uid !== undefined ? { uid: String(payload.uid || '').trim() } : {}),
    ...(payload.reportTime !== undefined ? { reportTime: String(payload.reportTime || '').trim() || '08:00' } : {}),
    ...(payload.reportFormat !== undefined ? { reportFormat: String(payload.reportFormat || '').trim() || 'summary' } : {}),
    ...(payload.weekdayOnly !== undefined ? { weekdayOnly: payload.weekdayOnly !== false } : {}),
    ...(payload.notifications ? { notifications: { ...getDefaultLineEvents(), ...payload.notifications } } : {}),
  };
  if (payload.token !== undefined) merged.token = String(payload.token || '').trim() || existing.config.token || '';
  if (payload.secret !== undefined) merged.secret = String(payload.secret || '').trim() || existing.config.secret || '';
  const rowId = existing.row?.id || 'hd_line_tokens_' + uid().slice(0, 10);
  await pgQuery(env, `DELETE FROM hd_master WHERE table_name='hd_line_tokens' AND code='line_bot_config' AND id<>$1`, [rowId]);
  await pgQuery(env,
    `INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
     VALUES ($1,'hd_line_tokens','line_bot_config','LINE Bot Config',$2,TRUE,0,now(),now())
     ON CONFLICT (id) DO UPDATE SET extra=$2, active=TRUE, updated_at=now()`,
    [rowId, JSON.stringify(merged)]
  );
  return normalizeLineConfig(merged, buildAppUrl(env, url, '/api/line/webhook'));
}

async function addLineLog(env, type, message, meta = {}) {
  const logId = 'hd_log_tm_' + uid().slice(0, 10);
  await pgQuery(env,
    `INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
     VALUES ($1,'hd_log_tm',$2,$3,$4,TRUE,0,now(),now())`,
    [logId, String(type || 'info'), String(message || ''), JSON.stringify(meta || {})]
  ).catch(() => {});
}

async function listLineLogs(env, limit = 20) {
  const rows = await pgQuery(env,
    `SELECT id, code, name, extra, created_at
     FROM hd_master
     WHERE table_name='hd_log_tm'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((row) => ({
    id: row.id, type: row.code || 'info', message: row.name || '',
    created_at: row.created_at, meta: tryParseJson(row.extra || '{}', {}),
  }));
}

async function lineApiFetch(token, path, init = {}) {
  const response = await fetch(`https://api.line.me${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : data?.message || response.statusText;
    throw new Error(`LINE API ${response.status}: ${detail}`);
  }
  return data;
}

async function getLineBotInfo(token) {
  return await lineApiFetch(token, '/v2/bot/info', { method: 'GET' });
}

async function getLineGroupSummary(token, groupId) {
  return await lineApiFetch(token, `/v2/bot/group/${encodeURIComponent(groupId)}/summary`, { method: 'GET' });
}

async function getLineGroupMemberCount(token, groupId) {
  try {
    const data = await lineApiFetch(token, `/v2/bot/group/${encodeURIComponent(groupId)}/members/count`, { method: 'GET' });
    return Number(data?.count || 0);
  } catch { return 0; }
}

async function replyLineMessage(token, replyToken, messages) {
  return await lineApiFetch(token, '/v2/bot/message/reply', { method: 'POST', body: JSON.stringify({ replyToken, messages }) });
}

async function pushLineMessage(token, to, messages) {
  return await lineApiFetch(token, '/v2/bot/message/push', { method: 'POST', body: JSON.stringify({ to, messages }) });
}

async function verifyLineSignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const actual = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return actual === signature;
}

async function upsertLineGroup(env, group, source = 'manual') {
  const groupId = String(group.groupId || '').trim();
  if (!groupId) throw new Error('groupId is required');
  const existing = await pgFirst(env, `SELECT id, extra FROM hd_master WHERE table_name='hd_sync_projects' AND code=$1 LIMIT 1`, [groupId]);
  const oldExtra = tryParseJson(existing?.extra || '{}', {});
  const nextExtra = {
    ...oldExtra,
    groupId, pictureUrl: group.pictureUrl || oldExtra.pictureUrl || '',
    members: Number(group.members ?? oldExtra.members ?? 0),
    source, active: group.active !== false,
    lastSyncedAt: new Date().toISOString(),
  };
  const rowId = existing?.id || 'hd_sync_projects_' + uid().slice(0, 10);
  const name = String(group.name || oldExtra.name || `LINE Group ${groupId.slice(-6)}`).trim();
  nextExtra.name = name;
  await pgQuery(env,
    `INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
     VALUES ($1,'hd_sync_projects',$2,$3,$4,$5,0,now(),now())
     ON CONFLICT (id) DO UPDATE SET name=$3, extra=$4, active=$5, updated_at=now()`,
    [rowId, groupId, name, JSON.stringify(nextExtra), group.active !== false]
  );
  return { id: rowId, groupId, name, ...nextExtra };
}

async function syncSingleLineGroup(env, config, groupId, source = 'manual') {
  const summary = await getLineGroupSummary(config.token, groupId);
  const members = await getLineGroupMemberCount(config.token, groupId);
  return await upsertLineGroup(env, {
    groupId, name: summary?.groupName || `LINE Group ${String(groupId).slice(-6)}`,
    pictureUrl: summary?.pictureUrl || '', members, active: true,
  }, source);
}

async function listLineGroups(env) {
  const rows = await pgQuery(env,
    `SELECT id, code, name, extra, active, created_at, updated_at
     FROM hd_master
     WHERE table_name='hd_sync_projects'
     ORDER BY updated_at DESC, name ASC`
  );
  return rows.map((row) => {
    const extra = tryParseJson(row.extra || '{}', {});
    return {
      id: row.id, groupId: row.code, name: row.name, tag: row.name,
      members: Number(extra.members || 0), pictureUrl: extra.pictureUrl || '',
      source: extra.source || 'line-group', active: row.active !== false,
      lastSyncedAt: extra.lastSyncedAt || row.updated_at,
      tasks: { all: 0, doing: 0, done: 0, archived: 0 },
    };
  });
}

function getDefaultTaskRuleMessage() {
  return 'แจ้งเตือน: {task_name}\nผู้รับผิดชอบ: {assignee}\nกำหนด: {deadline}\nสถานะ: {status}';
}

function normalizeTaskRule(row) {
  const extra = tryParseJson(row?.extra || '{}', {});
  return {
    id: row.id, name: row.name || '', groupId: row.code || '',
    groupName: String(extra.groupName || ''),
    triggers: Array.isArray(extra.triggers) ? extra.triggers : [],
    msg: String(extra.msg || getDefaultTaskRuleMessage()),
    on: row.active !== false,
    created_at: row.created_at, updated_at: row.updated_at,
    lastSentAt: extra.lastSentAt || '', lastTestAt: extra.lastTestAt || '',
  };
}

async function listLineTaskRules(env) {
  const rows = await pgQuery(env,
    `SELECT id, code, name, extra, active, created_at, updated_at
     FROM hd_master
     WHERE table_name='hd_line_rules'
     ORDER BY updated_at DESC, name ASC`
  );
  return rows.map(normalizeTaskRule);
}

async function saveLineTaskRule(env, payload = {}, existingId = '') {
  const id = existingId || 'hd_line_rules_' + uid().slice(0, 10);
  const current = existingId
    ? await pgFirst(env, `SELECT id, code, name, extra, active, created_at, updated_at FROM hd_master WHERE id=$1`, [existingId])
    : null;
  const currentRule = current ? normalizeTaskRule(current) : null;
  const next = {
    name: String(payload.name || currentRule?.name || '').trim(),
    groupId: String(payload.groupId || currentRule?.groupId || '').trim(),
    groupName: String(payload.groupName || currentRule?.groupName || '').trim(),
    triggers: Array.isArray(payload.triggers) ? payload.triggers : (currentRule?.triggers || []),
    msg: String(payload.msg || currentRule?.msg || getDefaultTaskRuleMessage()).trim() || getDefaultTaskRuleMessage(),
    on: payload.on !== undefined ? payload.on !== false : (currentRule ? currentRule.on : true),
    lastSentAt: currentRule?.lastSentAt || '',
    lastTestAt: currentRule?.lastTestAt || '',
  };
  if (!next.name) throw new Error('Rule name is required');
  if (!next.groupId) throw new Error('LINE group is required');
  const extra = { groupName: next.groupName, triggers: next.triggers, msg: next.msg, lastSentAt: next.lastSentAt, lastTestAt: next.lastTestAt };
  await pgQuery(env,
    `INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
     VALUES ($1,'hd_line_rules',$2,$3,$4,$5,0,now(),now())
     ON CONFLICT (id) DO UPDATE SET code=$2, name=$3, extra=$4, active=$5, updated_at=now()`,
    [id, next.groupId, next.name, JSON.stringify(extra), next.on]
  );
  const saved = await pgFirst(env, `SELECT id, code, name, extra, active, created_at, updated_at FROM hd_master WHERE id=$1`, [id]);
  return normalizeTaskRule(saved);
}

function renderTaskTemplate(template, task = {}) {
  const replacements = {
    task_name: task.task_name || '-', assignee: task.assignee_name || task.assigned_to || '-',
    deadline: task.deadline || '-', status: task.status || '-',
    priority: task.priority || '-', project: task.project_name || task.project || '-',
  };
  let text = String(template || getDefaultTaskRuleMessage());
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{${key}}`, String(value || '-'));
  }
  return text;
}

async function getTasksForTrigger(env, trigger) {
  if (trigger === 'task_overdue') {
    return await pgQuery(env, `SELECT t.*, p.project_name, u.full_name assignee_name FROM tasks t LEFT JOIN projects p ON p.id=t.project LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status!='Completed' AND t.deadline::date<current_date ORDER BY t.deadline ASC LIMIT 5`);
  }
  if (trigger === 'task_assigned') {
    return await pgQuery(env, `SELECT t.*, p.project_name, u.full_name assignee_name FROM tasks t LEFT JOIN projects p ON p.id=t.project LEFT JOIN users u ON u.id=t.assigned_to WHERE t.created_at>=now()-interval '7 day' ORDER BY t.created_at DESC LIMIT 5`);
  }
  if (trigger === 'task_done') {
    return await pgQuery(env, `SELECT t.*, p.project_name, u.full_name assignee_name FROM tasks t LEFT JOIN projects p ON p.id=t.project LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status='Completed' ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC LIMIT 5`);
  }
  if (trigger === 'priority_critical') {
    return await pgQuery(env, `SELECT t.*, p.project_name, u.full_name assignee_name FROM tasks t LEFT JOIN projects p ON p.id=t.project LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status!='Completed' AND t.priority='Critical' ORDER BY t.deadline ASC NULLS LAST LIMIT 5`);
  }
  if (trigger === 'deadline_3days') {
    return await pgQuery(env, `SELECT t.*, p.project_name, u.full_name assignee_name FROM tasks t LEFT JOIN projects p ON p.id=t.project LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status!='Completed' AND t.deadline::date BETWEEN current_date AND current_date + interval '3 day' ORDER BY t.deadline ASC LIMIT 5`);
  }
  return [];
}

async function buildRuleDispatchPreview(env, rule) {
  const triggers = Array.isArray(rule.triggers) ? rule.triggers : [];
  for (const trigger of triggers) {
    const tasks = await getTasksForTrigger(env, trigger);
    if (tasks.length) return { trigger, tasks, message: renderTaskTemplate(rule.msg, tasks[0]) };
  }
  return {
    trigger: triggers[0] || '',
    tasks: [],
    message: renderTaskTemplate(rule.msg, { task_name: 'ไม่มี task ที่ตรงเงื่อนไข', assignee_name: '-', deadline: '-', status: '-', priority: '-', project_name: '-' }),
  };
}

async function sendTaskRuleTest(env, config, rule) {
  if (!config.token) throw new Error('LINE token is not configured');
  const preview = await buildRuleDispatchPreview(env, rule);
  await pushLineMessage(config.token, rule.groupId, [{ type: 'text', text: preview.message }]);
  const extra = { groupName: rule.groupName, triggers: rule.triggers, msg: rule.msg, lastSentAt: rule.lastSentAt || '', lastTestAt: new Date().toISOString() };
  await pgQuery(env, `UPDATE hd_master SET extra=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(extra), rule.id]);
  return preview;
}

async function dispatchActiveTaskRules(env, config) {
  const rules = (await listLineTaskRules(env)).filter((rule) => rule.on);
  const results = [];
  for (const rule of rules) {
    const preview = await buildRuleDispatchPreview(env, rule);
    if (!preview.tasks.length) { results.push({ ruleId: rule.id, sent: false, reason: 'no-matching-task' }); continue; }
    await pushLineMessage(config.token, rule.groupId, [{ type: 'text', text: preview.message }]);
    const extra = { groupName: rule.groupName, triggers: rule.triggers, msg: rule.msg, lastSentAt: new Date().toISOString(), lastTestAt: rule.lastTestAt || '' };
    await pgQuery(env, `UPDATE hd_master SET extra=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(extra), rule.id]);
    results.push({ ruleId: rule.id, sent: true, count: preview.tasks.length, trigger: preview.trigger });
  }
  return results;
}

async function sendDailySummaryToLine(env, config) {
  if (!config.token) throw new Error('LINE token is not configured');
  if (!config.uid) throw new Error('CEO LINE user id is not configured');
  const [ap, ot, ov, un] = await Promise.all([
    pgFirst(env, `SELECT COUNT(*)::int n FROM projects WHERE status='Active'`),
    pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed'`),
    pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed' AND deadline::date<current_date`),
    pgFirst(env, `SELECT COUNT(*)::int n FROM notifications WHERE is_read=0`),
  ]);
  const text = ['สรุป CEO ประจำวัน', `โครงการ Active: ${ap?.n || 0}`, `งานที่เปิดอยู่: ${ot?.n || 0}`, `งานเกินกำหนด: ${ov?.n || 0}`, `การแจ้งเตือนค้างอ่าน: ${un?.n || 0}`].join('\n');
  await pushLineMessage(config.token, config.uid, [{ type: 'text', text }]);
  await addLineLog(env, 'ok', 'Daily summary sent to CEO', { uid: config.uid });
  return { ok: true, message: text };
}

async function handleLineWebhook(request, env, url) {
  const { config } = await getStoredLineConfig(env, url);
  if (!config.token || !config.secret) {
    await addLineLog(env, 'err', 'Webhook called without LINE config');
    return err('LINE bot is not configured', 503);
  }
  const rawBody = await request.text();
  const signature = request.headers.get('x-line-signature') || '';
  const valid = await verifyLineSignature(config.secret, rawBody, signature);
  if (!valid) {
    await addLineLog(env, 'err', 'Invalid LINE webhook signature');
    return err('Invalid LINE signature', 401);
  }

  const payload = tryParseJson(rawBody, {});
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    const groupId = event?.source?.groupId;
    if (!groupId) continue;

    try {
      if (event.type === 'join') {
        const group = await syncSingleLineGroup(env, config, groupId, 'join');
        await addLineLog(env, 'ok', `LINE group synced: ${group.name}`, { groupId });
        if (event.replyToken) {
          await replyLineMessage(config.token, event.replyToken, [{ type: 'text', text: `เชื่อมต่อกลุ่มเรียบร้อยแล้ว\n${group.name}\nพิมพ์ /ซิงค์กลุ่ม เพื่อซิงค์ข้อมูลอีกครั้ง` }]);
        }
        continue;
      }

      const text = String(event?.message?.text || '').trim();
      if (event.type === 'message' && text) {
        if (text === '/ซิงค์กลุ่ม' || text === '/ซิงข้อมูลกลุ่ม' || text.toLowerCase() === '/syncgroup') {
          const group = await syncSingleLineGroup(env, config, groupId, 'command');
          await addLineLog(env, 'ok', `LINE group re-synced: ${group.name}`, { groupId });
          if (event.replyToken) {
            await replyLineMessage(config.token, event.replyToken, [{ type: 'text', text: `ซิงค์กลุ่มเรียบร้อยแล้ว\n${group.name}\nสมาชิก ${group.members || 0} คน` }]);
          }
        } else if (text === '/สรุป' && event.replyToken) {
          const [ap, ot, ov] = await Promise.all([
            pgFirst(env, `SELECT COUNT(*)::int n FROM projects WHERE status='Active'`),
            pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed'`),
            pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed' AND deadline::date<current_date`),
          ]);
          await replyLineMessage(config.token, event.replyToken, [{ type: 'text', text: `สรุประบบ Betime\nโครงการ Active: ${ap?.n || 0}\nงานเปิดอยู่: ${ot?.n || 0}\nงานเกินกำหนด: ${ov?.n || 0}` }]);
        }
      }
    } catch (lineErr) {
      await addLineLog(env, 'err', `LINE webhook event failed: ${lineErr.message}`, { groupId, type: event?.type || '' });
    }
  }
  return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
}

// ── Route handler ─────────────────────────────────────────────────────

export async function handleLineBot(path, method, request, env) {
  const url = new URL(request.url);

  if (path === '/line/webhook' && method === 'POST') {
    return await handleLineWebhook(request, env, url);
  }

  if (path === '/line/config' && method === 'GET') {
    await requireAuth(request, env);
    const { config } = await getStoredLineConfig(env, url);
    const logs = await listLineLogs(env, 12);
    return json({ ok: true, data: lineConfigResponse(config), logs });
  }

  if (path === '/line/config' && method === 'PUT') {
    const s = await requireAuth(request, env);
    if (!['ceo', 'admin'].includes(String(s.role || '').toLowerCase())) return err('Permission denied', 403);
    const body = await request.json();
    const config = await saveStoredLineConfig(env, url, body || {});
    await addLineLog(env, 'ok', 'LINE bot config updated', { by: s.user_id });
    return json({ ok: true, data: lineConfigResponse(config) });
  }

  if (path === '/line/config/test' && method === 'POST') {
    await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    const { config: storedConfig } = await getStoredLineConfig(env, url);
    const token = String(body?.token || '').trim() || storedConfig.token;
    if (!token) return err('LINE token is required', 400);
    const info = await getLineBotInfo(token);
    await addLineLog(env, 'ok', 'LINE bot connection test succeeded', { name: info?.displayName || '' });
    return json({ ok: true, data: info });
  }

  if (path === '/line/report/test' && method === 'POST') {
    await requireAuth(request, env);
    const { config } = await getStoredLineConfig(env, url);
    const result = await sendDailySummaryToLine(env, config);
    return json(result);
  }

  if (path === '/line/logs' && method === 'GET') {
    await requireAuth(request, env);
    return json({ ok: true, data: await listLineLogs(env, 20) });
  }

  if (path === '/line/groups' && method === 'GET') {
    await requireAuth(request, env);
    return json({ ok: true, data: await listLineGroups(env) });
  }

  if (path === '/line/task-rules' && method === 'GET') {
    await requireAuth(request, env);
    return json({ ok: true, data: await listLineTaskRules(env) });
  }

  if (path === '/line/task-rules' && method === 'POST') {
    await requireAuth(request, env);
    const body = await request.json();
    const rule = await saveLineTaskRule(env, body || {});
    await addLineLog(env, 'ok', `Task LINE rule saved`, { ruleId: rule.id, groupId: rule.groupId });
    return json({ ok: true, data: rule });
  }

  if (path === '/line/task-rules/dispatch' && method === 'POST') {
    await requireAuth(request, env);
    const { config } = await getStoredLineConfig(env, url);
    if (!config.token) return err('LINE token is not configured', 400);
    const results = await dispatchActiveTaskRules(env, config);
    await addLineLog(env, 'ok', `Task LINE rules dispatched (${results.length})`);
    return json({ ok: true, data: results });
  }

  if (path === '/line/groups/sync' && method === 'POST') {
    await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    const { config } = await getStoredLineConfig(env, url);
    if (!config.token) return err('LINE token is not configured', 400);
    const requestedGroupId = String(body?.groupId || '').trim();
    const targets = requestedGroupId
      ? [requestedGroupId]
      : (await listLineGroups(env)).map((group) => group.groupId).filter(Boolean);
    const synced = [];
    for (const groupId of targets) {
      synced.push(await syncSingleLineGroup(env, config, groupId, 'manual'));
    }
    await addLineLog(env, 'ok', `LINE group sync completed (${synced.length})`);
    return json({ ok: true, data: synced });
  }

  if (path.startsWith('/line/groups/')) {
    await requireAuth(request, env);
    const parts = path.split('/').filter(Boolean);
    const groupId = decodeURIComponent(parts[2] || '');
    const action = parts[3] || '';
    if (!groupId) return err('Invalid group id', 400);

    if (method === 'DELETE' && !action) {
      await pgQuery(env, `DELETE FROM hd_master WHERE table_name='hd_sync_projects' AND code=$1`, [groupId]);
      await addLineLog(env, 'ok', `LINE group removed`, { groupId });
      return json({ ok: true });
    }

    if (method === 'POST' && action === 'sync-members') {
      const { config } = await getStoredLineConfig(env, url);
      if (!config.token) return err('LINE token is not configured', 400);
      const group = await syncSingleLineGroup(env, config, groupId, 'manual');
      await addLineLog(env, 'ok', `LINE group synced`, { groupId });
      return json({ ok: true, data: group });
    }

    if (method === 'POST' && action === 'push') {
      const { config } = await getStoredLineConfig(env, url);
      if (!config.token) return err('LINE token is not configured', 400);
      const body = await request.json().catch(() => ({}));
      const message = String(body?.message || '').trim();
      if (!message) return err('message is required', 400);
      await pushLineMessage(config.token, groupId, [{ type: 'text', text: message }]);
      await addLineLog(env, 'ok', `LINE message pushed`, { groupId, message });
      return json({ ok: true });
    }
  }

  if (path.startsWith('/line/task-rules/')) {
    await requireAuth(request, env);
    const parts = path.split('/').filter(Boolean);
    const ruleId = decodeURIComponent(parts[2] || '');
    const action = parts[3] || '';
    if (!ruleId) return err('Invalid rule id', 400);

    if (method === 'PUT' && !action) {
      const body = await request.json();
      const rule = await saveLineTaskRule(env, body || {}, ruleId);
      await addLineLog(env, 'ok', `Task LINE rule updated`, { ruleId });
      return json({ ok: true, data: rule });
    }

    if (method === 'DELETE' && !action) {
      await pgQuery(env, `DELETE FROM hd_master WHERE id=$1 AND table_name='hd_line_rules'`, [ruleId]);
      await addLineLog(env, 'ok', `Task LINE rule removed`, { ruleId });
      return json({ ok: true });
    }

    if (method === 'POST' && action === 'test') {
      const row = await pgFirst(env, `SELECT id, code, name, extra, active, created_at, updated_at FROM hd_master WHERE id=$1 AND table_name='hd_line_rules'`, [ruleId]);
      if (!row) return err('Rule not found', 404);
      const rule = normalizeTaskRule(row);
      const { config } = await getStoredLineConfig(env, url);
      const preview = await sendTaskRuleTest(env, config, rule);
      await addLineLog(env, 'ok', `Task LINE rule test sent`, { ruleId, groupId: rule.groupId });
      return json({ ok: true, data: preview });
    }
  }

  return null;
}
