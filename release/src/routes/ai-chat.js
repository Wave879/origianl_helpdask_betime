/**
 * routes/ai-chat.js
 * POST /ai/chat, knowledge search helpers, ticket search helpers
 */

import { pgQuery } from '../db.js';
import { json, tryParseJson } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { findRelevantKnowledgeByEmbedding } from '../embedding-search.js';

// ── Knowledge & ticket search helpers (also used by helpdesk.js) ────

export function extractKnowledgeTerms(text) {
  const raw = String(text || '').toLowerCase();
  const matches = raw.match(/[฀-๿a-z0-9_:-]{2,}/g) || [];
  const stopwords = new Set([
    'ticket', 'tickets', 'id', 'project', 'bug', 'type', 'summary', 'linked',
    'knowledge', 'status', 'severity', 'reported', 'report', 'department',
    'content', 'keyword', 'keywords', 'requester', 'assigned', 'created',
    'updated', 'analysis', 'parsed', 'issue', 'helpdesk', 'context', 'title',
    'case', 'description', 'projectcode', 'subproject', 'sup', 'code',
  ]);
  const seen = new Set();
  const terms = [];
  for (const token of matches) {
    const normalizedToken = token.replace(/^[^\wก-๙]+|[^\wก-๙]+$/g, '').toLowerCase();
    if (!normalizedToken) continue;
    if (normalizedToken.length < 2 || normalizedToken.length > 24) continue;
    if (stopwords.has(normalizedToken)) continue;
    if (seen.has(normalizedToken)) continue;
    seen.add(normalizedToken);
    terms.push(normalizedToken);
    if (terms.length >= 6) break;
  }
  return terms;
}

function scoreKnowledgeRow(row, terms) {
  const title = String(row.title || '').toLowerCase();
  const tags = String(row.tags || '').toLowerCase();
  const haystack = `${title}\n${String(row.content || '').toLowerCase()}\n${tags}`;
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (title.includes(term)) score += 5;
    if (tags.includes(term)) score += 3;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function normalizeKnowledgeProjectCode(value) {
  const code = String(value || '').trim();
  if (!code) return '';
  if (/sarabun/i.test(code)) return 'ERC';
  return code.toUpperCase();
}

function inferKnowledgeScope(text, body = {}) {
  const haystack = String(text || '');
  const directProject = body.project_code || body.projectCode || body.project || body.service_id || body.serviceCode || '';
  const directSubProject = body.sub_project_code || body.subProjectCode || body.sub_project || body.subProject || body.service_sub_id || '';
  const projectMatch = haystack.match(/(?:project|project_code|service|service_id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  const subProjectMatch = haystack.match(/(?:sub_project|subproject|sub_project_code|service_sub|service_sub_id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  let projectCode = normalizeKnowledgeProjectCode(directProject || projectMatch?.[1] || '');
  if (!projectCode && /(erc|sarabun|\u0e2a\u0e32\u0e23\u0e1a\u0e23\u0e23\u0e13)/i.test(haystack)) projectCode = 'ERC';
  return {
    projectCode,
    subProjectCode: String(directSubProject || subProjectMatch?.[1] || '').trim().toUpperCase(),
  };
}

export async function findRelevantKnowledge(env, queryText, options = {}) {
  const terms = extractKnowledgeTerms(queryText);
  if (!terms.length) return [];
  const projectCode = String(options.projectCode || options.project_code || '').trim();
  const subProjectCode = String(options.subProjectCode || options.sub_project_code || '').trim();

  const clauses = [];
  const params = [];
  let idx = 1;
  for (const term of terms.slice(0, 4)) {
    clauses.push(`(
      LOWER(COALESCE(title, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(content, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(tags, '')) LIKE '%' || LOWER($${idx}) || '%'
    )`);
    params.push(String(term || '').trim());
    idx += 1;
  }
  if (!clauses.length) return [];
  const projectParamIndex = idx;
  params.push(projectCode);
  idx += 1;
  const subProjectParamIndex = idx;
  params.push(subProjectCode);

  let rows = [];
  try {
    rows = await pgQuery(
      env,
      `SELECT id, title, content, tags, author, updated_at, created_at,
              COALESCE(knowledge_scope, 'global') AS knowledge_scope,
              COALESCE(project_code, '') AS project_code,
              COALESCE(sub_project_code, '') AS sub_project_code
       FROM knowledge_articles
       WHERE (category LIKE 'Helpdeck%' OR category IN ('Project', 'Guide')) AND (${clauses.join(' OR ')})
         AND (
           COALESCE(knowledge_scope, 'global') = 'global'
           OR ($${projectParamIndex} <> '' AND COALESCE(knowledge_scope, 'global') = 'project'
               AND (
                 lower(COALESCE(project_code, '')) = lower($${projectParamIndex})
                 OR lower(COALESCE(project_code, '')) LIKE lower($${projectParamIndex}) || '-%'
                 OR lower($${projectParamIndex}) LIKE lower(COALESCE(project_code, '')) || '-%'
               ))
           OR ($${projectParamIndex} <> '' AND COALESCE(knowledge_scope, 'global') = 'sub_project'
               AND (
                 lower(COALESCE(project_code, '')) = lower($${projectParamIndex})
                 OR lower(COALESCE(project_code, '')) LIKE lower($${projectParamIndex}) || '-%'
                 OR lower($${projectParamIndex}) LIKE lower(COALESCE(project_code, '')) || '-%'
               )
               AND ($${subProjectParamIndex} = '' OR lower(COALESCE(sub_project_code, '')) = lower($${subProjectParamIndex})))
         )
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 18`,
      params
    );
  } catch {
    return [];
  }

  return rows
    .map((row) => ({ ...row, _score: scoreKnowledgeRow(row, terms) }))
    .filter((row) => row._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 6);
}

function mergeKnowledgeRows(primaryRows = [], fallbackRows = [], limit = 6) {
  const byId = new Map();
  for (const row of [...primaryRows, ...fallbackRows]) {
    if (!row?.id || byId.has(row.id)) continue;
    byId.set(row.id, row);
  }
  return Array.from(byId.values()).slice(0, limit);
}

function scoreHelpdeskTicketRow(row, terms) {
  const title = String(row.title || '').toLowerCase();
  const description = String(row.description || '').toLowerCase();
  const project = String(row.project || '').toLowerCase();
  const bugType = String(row.bug_type || '').toLowerCase();
  const extraText = String(row.extra || '').toLowerCase();
  const haystack = `${title}\n${description}\n${project}\n${bugType}\n${extraText}`;
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (title.includes(term)) score += 5;
    if (description.includes(term)) score += 4;
    if (project.includes(term)) score += 3;
    if (bugType.includes(term)) score += 3;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

export async function findRelevantHelpdeskTickets(env, queryText) {
  const terms = extractKnowledgeTerms(queryText);
  const limit = terms.length ? 18 : 12;
  const where = [];
  const params = [];
  let idx = 1;
  for (const term of terms.slice(0, 5)) {
    where.push(`(
      LOWER(COALESCE(title, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(description, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(project, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(bug_type, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(assigned_dev, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(odoo_ticket_id, '')) LIKE '%' || LOWER($${idx}) || '%'
      OR LOWER(COALESCE(extra, '')) LIKE '%' || LOWER($${idx}) || '%'
    )`);
    params.push(String(term || '').trim());
    idx += 1;
  }
  let rows = [];
  try {
    rows = await pgQuery(
      env,
      `SELECT id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra
       FROM helpdesk_tickets
       ${where.length ? `WHERE ${where.join(' OR ')}` : ''}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 40`,
      params
    );
  } catch {
    return [];
  }
  return rows
    .map((row) => ({ ...row, _score: scoreHelpdeskTicketRow(row, terms) }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      const left = String(b.updated_at || b.created_at || '');
      const right = String(a.updated_at || a.created_at || '');
      return left.localeCompare(right);
    })
    .slice(0, limit);
}

function extractHistoricalTicketCause(row = {}, extra = null) {
  const parsedExtra = extra && typeof extra === 'object' ? extra : tryParseJson(row.extra || '{}', {});
  return String(parsedExtra?.problem_cause_remark || parsedExtra?.likely_cause || parsedExtra?.analysis?.likely_cause || parsedExtra?.cause || '').trim();
}

function extractHistoricalTicketProblemType(row = {}, extra = null) {
  const parsedExtra = extra && typeof extra === 'object' ? extra : tryParseJson(row.extra || '{}', {});
  return String(row?.bug_type || parsedExtra?.case_type_name || parsedExtra?.case_type || parsedExtra?.problem_type || parsedExtra?.analysis?.problem_type || '').trim();
}

export function formatHelpdeskTicketContext(rows) {
  return rows.map((row, index) => {
    const snippet = String(row.description || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const extra = tryParseJson(row.extra || '{}', {});
    const historicalType = extractHistoricalTicketProblemType(row, extra);
    const cause = extractHistoricalTicketCause(row, extra);
    return [
      `[Ticket ${index + 1}]`,
      `Title: ${row.title || '-'}`,
      `Historical Case Type: ${historicalType || '-'}`,
      `Project: ${row.project || '-'}`,
      `Status: ${row.status || '-'}`,
      `Assigned: ${row.assigned_dev || '-'}`,
      `Odoo: ${row.odoo_ticket_id || '-'}`,
      `Created: ${row.created_at || '-'}`,
      `Updated: ${row.updated_at || '-'}`,
      extra?.issueTitle ? `Parsed Title: ${extra.issueTitle}` : '',
      extra?.requester ? `Requester: ${extra.requester}` : '',
      extra?.reportedAt ? `Reported At: ${extra.reportedAt}` : '',
      extra?.department ? `Department: ${extra.department}` : '',
      cause ? `Problem Cause: ${cause}` : '',
      `Description: ${snippet || '-'}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function sanitizeKnowledgeLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  const looksTechnical = /(^|[\s:])(?:project|team|profile|knowledge|ticket)\b/i.test(text) || /[A-Z]{2,}[A-Z0-9_-]{2,}/.test(text);
  if (!isReadableHumanTitle(text) || looksTechnical) return 'บทความความรู้ที่ใกล้เคียง';
  return text;
}

function isReadableHumanTitle(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/\s/.test(text)) return true;
  if (/^[A-Za-z]+(?:[._-][A-Za-z0-9]+)+$/.test(text)) return false;
  if (/^[a-z0-9_:-]{12,}$/i.test(text)) return false;
  return /[ก-๙]/.test(text) || text.length <= 24;
}

export function formatKnowledgeContext(rows) {
  return rows.map((row, index) => {
    const snippet = String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 900);
    const title = sanitizeKnowledgeLabel(row.title);
    const tags = sanitizeKnowledgeLabel(row.tags);
    return [
      `[Knowledge ${index + 1}]`,
      `Title: ${title}`,
      `Tags: ${tags}`,
      `Author: ${row.author || '-'}`,
      `Updated: ${row.updated_at || row.created_at || '-'}`,
      `Content: ${snippet || '-'}`,
    ].join('\n');
  }).join('\n\n');
}

export async function readAssetText(env, pathname) {
  if (!env?.ASSETS?.fetch) return '';
  try {
    const url = new URL(pathname, 'https://assets.local');
    const res = await env.ASSETS.fetch(new Request(url.toString()));
    if (!res.ok) return '';
    return String(await res.text() || '').trim();
  } catch {
    return '';
  }
}

// ── Reply helpers ────────────────────────────────────────────────────

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[^\wก-๙\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFixSeekingIntent(text = '') {
  const blob = normalizeText(text);
  return /(\bhow\s+to\s+fix\b|\bcan.*fix\b|\bfix\b|\bworkaround\b|\bsolution\b|วิธีแก้|แก้ยังไง|แก้ได้ไหม|แก้ยังไงบ้าง|มีทางแก้|แนวทางแก้|แก้ไขเบื้องต้น|ต้องแก้ยังไง|ทำยังไง|ทำอย่างไร)/i.test(blob);
}

function buildConcreteHelpdeskAction(problemType = '', issueText = '', likelyCause = '') {
  const blob = normalizeText([problemType, issueText, likelyCause].filter(Boolean).join(' '));
  if (/human|wrong|mistaken|ลงผิด|เลือกผิด|กดผิด|กรอกผิด|ส่งผิด|บันทึกผิด|แก้ข้อมูลผิด/.test(blob)) {
    return { method: 'ส่งรายการให้ back office / admin แก้ก่อนครับ', detail: 'ขอเลขอ้างอิงกับฟิลด์ที่ต้องแก้ให้ชัดครับ' };
  }
  if (/system bug|bug|logic|expected|actual|reproduce|ทำซ้ำ|เกิดซ้ำ|หน้าจอ|module/.test(blob)) {
    return { method: 'ลองทำซ้ำตามขั้นตอนเดิมก่อนครับ', detail: 'ถ้าเกิดซ้ำ ให้ส่งขั้นตอนทำซ้ำ ข้อความ error และเวลาที่เกิดเหตุ' };
  }
  if (/system error|server|timeout|api|endpoint|fail|error|service/.test(blob)) {
    return { method: 'ลองรีเฟรช หรือเข้าใหม่อีกครั้งครับ', detail: 'ถ้ายังขึ้น error ให้ส่งเวลาเกิดกับข้อความ error' };
  }
  if (/network|vpn|wifi|wi-fi|lan|firewall|connect|connection|offline/.test(blob)) {
    return { method: 'ลองสลับเครือข่ายหรือเช็ก VPN / LAN ก่อนครับ', detail: 'ถ้าเป็นหลายเครื่อง ค่อยเช็ก network / firewall เพิ่ม' };
  }
  if (/hardware|printer|scanner|device|อุปกรณ์|เครื่อง|สาย/.test(blob)) {
    return { method: 'ลองสลับเครื่อง สาย หรือพอร์ตก่อนครับ', detail: 'ถ้ายังไม่หาย ค่อยยืนยันรุ่นกับอาการ' };
  }
  if (/change request|feature request|enhancement|ขอเพิ่ม|ขอปรับ|ปรับปรุง|เปลี่ยนพฤติกรรม|แก้ไขระบบ/.test(blob)) {
    return { method: 'สรุปสิ่งที่อยากเปลี่ยนก่อนส่งต่อครับ', detail: 'บอกว่าอยากเปลี่ยนอะไร และกระทบใครบ้าง' };
  }
  return { method: 'ลองเช็ก master data / mapping / config ก่อนครับ', detail: 'ถ้ายังไม่หาย ให้ส่งเลขอ้างอิง ค่าที่เห็นจริง และค่าที่ควรเป็นเพิ่ม' };
}

function formatReplyFlow({ summary, reason, nextQuestion, nextStep, sourceLabel = '', preferSolutionFirst = false }) {
  const firstPart = [summary, nextStep].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  const secondPart = nextQuestion ? (preferSolutionFirst ? `ถ้ายังไม่พอ รบกวน${/^[,.\s]/.test(nextQuestion) ? '' : ' '}${nextQuestion}` : `ถ้าจะเดินต่อ รบกวน${/^[,.\s]/.test(nextQuestion) ? '' : ' '}${nextQuestion}`) : '';
  return [firstPart, secondPart].filter(Boolean).join('\n\n');
}

function cleanupHelpdeskChatReply(text, fallback = '') {
  const raw = String(text || '').trim();
  if (!raw) return String(fallback || '').trim();
  const paragraphs = raw
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/(?:^|\b)(?:project|team|knowledge)\s+profile\b/i.test(line))
      .filter((line) => !/(?:^|\b)profile\s*:/i.test(line))
      .filter((line) => !/\bOPDC-[A-Z0-9_-]+\b/i.test(line))
      .filter((line) => !/\b(?:source|reference|linked knowledge|linked tickets)\b/i.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
  const reply = paragraphs.join('\n\n').trim();
  if (!reply) return String(fallback || '').trim();
  if (/(?:project|team|knowledge)\s+profile|OPDC-[A-Z0-9_-]+/i.test(reply)) return String(fallback || '').trim();
  return reply;
}

function removeScreenshotRequests(reply = '') {
  let text = String(reply || '').trim();
  if (!text) return '';
  text = text
    .replace(/\s*(?:และ|พร้อม|กับ)?\s*(?:screenshot|screen\s*shot|ภาพหน้าจอ|รูปหน้าจอ)(?:\s*(?:ถ้ามี|เพิ่ม|ไปด้วย|ประกอบ|จุดที่[^,.ครับ\n]*)?)?/gi, '')
    .replace(/(?:ขอ|รบกวนส่ง|ให้ส่ง|แนบ|เก็บ)\s*(?:screenshot|screen\s*shot|ภาพหน้าจอ|รูปหน้าจอ)[^ครับ\n]*(?:ครับ)?/gi, 'ส่งเลขอ้างอิง จุดที่พบปัญหา ค่าที่เห็นจริง และค่าที่ควรเป็นครับ')
    .replace(/\s+ครับครับ/g, 'ครับ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
  return text || String(reply || '').replace(/screenshot|screen\s*shot|ภาพหน้าจอ|รูปหน้าจอ/gi, '').trim();
}

// ── Route handler ─────────────────────────────────────────────────────

function shouldRewriteQuestionOnlyFixReply(reply = '', latestText = '', ticketContext = '') {
  const source = String(`${latestText}\n${ticketContext}` || '').toLowerCase();
  const userAskedFix = source.includes('fix')
    || source.includes('solution')
    || source.includes('workaround')
    || source.includes('\u0e27\u0e34\u0e18\u0e35')
    || source.includes('\u0e41\u0e01\u0e49')
    || source.includes('\u0e40\u0e1a\u0e37\u0e49\u0e2d\u0e07\u0e15\u0e49\u0e19')
    || source.includes('\u0e22\u0e31\u0e07\u0e44\u0e07');
  const dataMismatchContext = source.includes('data issue')
    || source.includes('record')
    || source.includes('reference')
    || source.includes('mismatch')
    || source.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || source.includes('\u0e10\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  if (!dataMismatchContext) return false;
  const text = String(reply || '').trim();
  if (!text) return false;
  const asksForMoreOnly = text.startsWith('\u0e23\u0e1a\u0e01\u0e27\u0e19') || text.startsWith('\u0e02\u0e2d') || text.startsWith('\u0e0a\u0e48\u0e27\u0e22');
  const hasConcreteAction = text.includes('\u0e40\u0e1a\u0e37\u0e49\u0e2d\u0e07\u0e15\u0e49\u0e19')
    || text.includes('\u0e25\u0e2d\u0e07')
    || text.includes('\u0e40\u0e17\u0e35\u0e22\u0e1a')
    || text.includes('\u0e40\u0e0a\u0e47\u0e01')
    || text.includes('\u0e40\u0e1b\u0e23\u0e35\u0e22\u0e1a\u0e40\u0e17\u0e35\u0e22\u0e1a')
    || text.includes('\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || text.includes('\u0e1b\u0e23\u0e31\u0e1a\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  return (userAskedFix || asksForMoreOnly) && asksForMoreOnly && !hasConcreteAction;
}

async function rewriteHelpdeskChatReplyWithAi({ aiUrl, azureKey, isDeploymentUrl, modelName, reply, latestText, ticketContext, timeoutMs = 4500 }) {
  const rewriteMessages = [
    {
      role: 'system',
      content: [
        'Rewrite a helpdesk assistant reply in Thai.',
        'Use only the meaning from the original reply, user message, and ticket context.',
        'Return only the final rewritten reply.',
        'Keep it LINE-like: 1-2 short Thai sentences, no numbered list, no markdown.',
        'If the user asks for a fix, include one concrete first action before asking for one missing item.',
        'For vague data mismatch issues, say to compare the affected screen/record with the expected value, then ask for the reference number or affected record.',
        'For Data Issue rewrite, the reply must start with: เบื้องต้นให้เทียบข้อมูลในหน้าจอกับ record ที่คาดหวังก่อนครับ',
        'Do not mention master data, mapping, permission, config, logs, or developer routing unless explicitly present.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `[Original reply]\n${reply}`,
        `[User message]\n${latestText}`,
        ticketContext ? `[Ticket context]\n${ticketContext}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ];
  const payload = { messages: rewriteMessages, temperature: 0.1, max_tokens: 180, model: modelName };
  if (isDeploymentUrl) delete payload.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureKey,
        ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return '';
    const data = await res.json();
    let rewritten = data?.choices?.[0]?.message?.content;
    if (Array.isArray(rewritten)) rewritten = rewritten.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
    return cleanupHelpdeskChatReply(rewritten, '');
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function shouldRewriteHumanErrorAdminReply(reply = '', latestText = '', ticketContext = '') {
  const source = String(`${latestText}\n${ticketContext}` || '').toLowerCase();
  if (source.includes('data issue')) return false;
  const humanErrorContext = source.includes('human error')
    || source.includes('\u0e25\u0e07\u0e23\u0e31\u0e1a')
    || source.includes('\u0e1c\u0e34\u0e14')
    || source.includes('\u0e01\u0e14\u0e1c\u0e34\u0e14')
    || source.includes('\u0e41\u0e01\u0e49\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e40\u0e14\u0e34\u0e21');
  if (!humanErrorContext) return false;
  const text = String(reply || '').toLowerCase();
  return !text.includes('back office') && !text.includes('admin') && !text.includes('\u0e41\u0e2d\u0e14\u0e21\u0e34\u0e19');
}

async function rewriteHumanErrorReplyWithAi({ aiUrl, azureKey, isDeploymentUrl, modelName, reply, latestText, ticketContext, timeoutMs = 4500 }) {
  const payload = {
    messages: [
      {
        role: 'system',
        content: [
          'Rewrite a Thai helpdesk chat reply for a Human error case.',
          'Return only the final reply.',
          'Keep it LINE-like: 1-2 short Thai sentences, no numbered list, no markdown.',
          'Use natural, polite Thai that feels like a support agent talking to a user.',
          'Do not sound mechanical or checklist-like.',
          'If relevant, mention the back office/admin or use "ผู้ดูแลหลังบ้าน" when it reads more naturally.',
          'Tell the user to send the exact record/document and desired correction to the right support team.',
          'Do not route to Dev unless there is a clear system bug.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `[Original reply]\n${reply}`,
          `[User message]\n${latestText}`,
          ticketContext ? `[Ticket context]\n${ticketContext}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    temperature: 0.1,
    max_tokens: 160,
    model: modelName,
  };
  if (isDeploymentUrl) delete payload.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureKey,
        ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return '';
    const data = await res.json();
    let rewritten = data?.choices?.[0]?.message?.content;
    if (Array.isArray(rewritten)) rewritten = rewritten.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
    return cleanupHelpdeskChatReply(rewritten, '');
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function clipPromptText(label, text, maxChars = 1200) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const clipped = clean.length > maxChars ? `${clean.slice(0, maxChars).trim()} ...` : clean;
  return `[${label}]\n${clipped}`;
}

function isDataEvidenceQuestion(latestText = '', ticketContext = '') {
  const latest = String(latestText || '').toLowerCase();
  const source = String(`${latestText}\n${ticketContext}` || '').toLowerCase();
  const asksWhere = latest.includes('\u0e15\u0e23\u0e07')
    || latest.includes('\u0e44\u0e2b\u0e19')
    || latest.includes('\u0e2d\u0e30\u0e44\u0e23')
    || latest.includes('\u0e40\u0e1e\u0e34\u0e48\u0e21')
    || source.includes('\u0e15\u0e23\u0e07')
    || source.includes('\u0e44\u0e2b\u0e19')
    || source.includes('what data')
    || source.includes('which data');
  const asksEvidence = latest.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || latest.includes('\u0e40\u0e2d\u0e32')
    || latest.includes('\u0e2a\u0e48\u0e07')
    || latest.includes('\u0e15\u0e49\u0e2d\u0e07');
  const dataContext = source.includes('data issue')
    || source.includes('record')
    || source.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || source.includes('\u0e10\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  return asksWhere && asksEvidence && dataContext;
}

function isDataFixQuestion(latestText = '', ticketContext = '') {
  const source = String(`${latestText}\n${ticketContext}` || '').toLowerCase();
  const asksFix = source.includes('\u0e27\u0e34\u0e18\u0e35')
    || source.includes('\u0e41\u0e01\u0e49')
    || source.includes('\u0e40\u0e1a\u0e37\u0e49\u0e2d\u0e07\u0e15\u0e49\u0e19')
    || source.includes('fix')
    || source.includes('solution')
    || source.includes('workaround');
  const dataContext = source.includes('data issue')
    || source.includes('record')
    || source.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || source.includes('\u0e10\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  return asksFix && dataContext;
}

function isDbFollowupQuestion(latestText = '', ticketContext = '') {
  const latest = String(latestText || '').toLowerCase();
  const source = String(`${latestText}\n${ticketContext}` || '').toLowerCase();
  const asksDb = /\bdb\b|\bdatabase\b|\bsql\b|\btable\b|\bfield\b|\brecord\b/i.test(latest)
    || latest.includes('\u0e10\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  const dataContext = source.includes('data issue')
    || source.includes('record')
    || source.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || source.includes('\u0e44\u0e21\u0e48\u0e15\u0e23\u0e07')
    || source.includes('\u0e15\u0e23\u0e07\u0e01\u0e31\u0e19');
  return asksDb && dataContext;
}

function applyChatAnswerGuardrails(reply = '', { evidenceQuestionMode = false, dataFixQuestionMode = false, dbFollowupMode = false } = {}) {
  const text = String(reply || '').trim();
  const unhelpfulEscalation = /ส่งต่อหัวหน้า|หัวหน้า|back office|admin|แอดมิน/i.test(text);
  if (dbFollowupMode || (unhelpfulEscalation && /db|database|record|ข้อมูล|ฐานข้อมูล/i.test(text))) {
    return 'ถ้าเป็นข้อมูลใน DB ให้เริ่มจากเช็กว่า record นี้อยู่ table/field ไหน แล้วเทียบค่าปัจจุบันกับค่าที่ควรเป็นครับ ถ้าสะดวกส่งชื่อ table/field, primary key หรือเลขเอกสารมาได้เลย';
  }
  if (evidenceQuestionMode) {
    const hasSpecificEvidence = text.includes('\u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e40\u0e2b\u0e47\u0e19')
      && (text.includes('\u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e04\u0e27\u0e23\u0e40\u0e1b\u0e47\u0e19') || text.includes('\u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e04\u0e32\u0e14\u0e2b\u0e27\u0e31\u0e07'));
    if (!hasSpecificEvidence) {
      return 'รบกวนส่งชื่อหน้าจอ/เมนู, เลข record หรือเลขเอกสาร, ค่าที่เห็นตอนนี้ และค่าที่ควรเป็นครับ';
    }
  }
  if (dataFixQuestionMode) {
    const hasFirstAction = text.includes('\u0e40\u0e1a\u0e37\u0e49\u0e2d\u0e07\u0e15\u0e49\u0e19')
      || text.includes('\u0e40\u0e17\u0e35\u0e22\u0e1a\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
      || text.includes('record \u0e17\u0e35\u0e48\u0e04\u0e32\u0e14\u0e2b\u0e27\u0e31\u0e07');
    const asksOnly = text.startsWith('\u0e23\u0e1a\u0e01\u0e27\u0e19')
      || text.startsWith('\u0e02\u0e2d')
      || text.startsWith('\u0e0a\u0e48\u0e27\u0e22')
      || text.startsWith('\u0e43\u0e2b\u0e49\u0e2a\u0e48\u0e07');
    if (!hasFirstAction || asksOnly) {
      return 'เบื้องต้นให้เทียบข้อมูลในหน้าจอกับ record ที่คาดหวังก่อนครับ ถ้ายังไม่ตรง รบกวนส่งเลขที่เอกสาร จุดที่ข้อมูลไม่ตรง และค่าที่ควรเป็นมาให้ช่วยไล่ต่อ';
    }
  }
  return text;
}

function normalizeChatResponseMode(value = '') {
  const mode = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const allowed = new Set([
    'fix_first',
    'evidence_request',
    'next_step',
    'dev_decision',
    'customer_reply',
    'missing_required_fields',
    'summary',
  ]);
  return allowed.has(mode) ? mode : '';
}

function getTicketContextField(ticketContext = '', fieldName = '') {
  const pattern = new RegExp(`^${fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`, 'im');
  const match = String(ticketContext || '').match(pattern);
  return String(match?.[1] || '').trim();
}

function inferTicketIssueField(ticketContext = '') {
  const text = String([
    getTicketContextField(ticketContext, 'Issue Title'),
    getTicketContextField(ticketContext, 'Summary'),
    getTicketContextField(ticketContext, 'Likely Cause'),
    getTicketContextField(ticketContext, 'Content'),
  ].filter(Boolean).join(' '));
  if (/เส้นทาง|route|routing/i.test(text)) return 'เส้นทางหนังสือ';
  if (/เลขรับ|ทะเบียนรับ|เลขที่/i.test(text)) return 'เลขรับ/เลขที่เอกสาร';
  if (/สถานะ|status/i.test(text)) return 'สถานะรายการ';
  if (/หน่วยงาน|area|department/i.test(text)) return 'หน่วยงาน/Area';
  return 'รายการหรือค่าที่ต้องแก้';
}

function inferTicketDocumentHint(ticketContext = '') {
  const text = String([
    getTicketContextField(ticketContext, 'Issue Title'),
    getTicketContextField(ticketContext, 'Content'),
    getTicketContextField(ticketContext, 'Likely Cause'),
  ].filter(Boolean).join(' '))
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:local|localhost|example)\S*/gi, ' ');
  const docNumbers = Array.from(new Set((text.match(/\b[A-Z]{2,}[-_/]?[A-Z0-9]*[-_/]?\d{2,}|\b\d{3,}\/\d{2,}|\b\d{4,}\b/gi) || [])
    .map((item) => String(item || '').trim())
    .filter((item) => !/^(?:local|localhost|ticket|api|web)$/i.test(item))
    .filter(Boolean)
    .slice(0, 3)));
  return docNumbers.length ? docNumbers.join(', ') : 'เลขอ้างอิง/เลขเอกสาร';
}

function isHumanContext(ticketContext = '') {
  const text = String(ticketContext || '').toLowerCase();
  return text.includes('human error')
    || /ลงผิด|เลือกผิด|กดผิด|กรอกผิด|ส่งผิด|ลงรับผิด|ยืนยันผิด|บันทึกผิด|แก้ข้อมูลผิด|รับผิดรายการ/i.test(text);
}

function needsBackendDevAccess(ticketContext = '') {
  const text = String(ticketContext || '').toLowerCase();
  return /หลังบ้าน|backend|back-end|transaction log|audit log|log|ยกเลิกเลขรับ|คืนเลขรับ|แก้เลขรับ|เส้นทางหนังสือ|routing|route|ผูกเลขรับ|เลขรับเดิม/i.test(text);
}

function buildResponseModeReply(responseMode = '', ticketContext = '') {
  const mode = normalizeChatResponseMode(responseMode);
  if (!mode) return '';
  const problemType = getTicketContextField(ticketContext, 'Bug Type') || 'ปัญหานี้';
  const issueTitle = getTicketContextField(ticketContext, 'Issue Title') || getTicketContextField(ticketContext, 'Summary') || 'รายการนี้';
  const docHint = inferTicketDocumentHint(ticketContext);
  const fieldHint = inferTicketIssueField(ticketContext);
  const fieldLabel = fieldHint === 'รายการหรือค่าที่ต้องแก้' ? 'จุดที่ต้องแก้' : fieldHint;
  const human = isHumanContext(ticketContext);
  const backendDev = needsBackendDevAccess(ticketContext);
  const slaMapping = /\bSLA\b|priority|condition|criteria|mapping|service_id|service_sub_id|area_id|case_type|priority_id|เงื่อนไข|เอสแอลเอ/i.test(ticketContext);
  const inspectionRequest = slaMapping || /ตรวจสอบ|ตรวจ|เช็ก|check|verify|validate|audit/i.test(ticketContext);

  if (mode === 'fix_first') {
    if (human && backendDev) {
      return `ขออนุญาตแนะนำให้ผู้ดูแลหลังบ้านหรือ Dev ที่เข้าถึงข้อมูลได้ช่วยตรวจรายการเดิมจาก ${docHint} ก่อนครับ แล้วค่อยเทียบ ${fieldLabel} กับค่าที่ควรเป็น ถ้าต้องส่งต่อ รบกวนแนบเลขอ้างอิง จุดที่ต้องแก้ และค่าที่ถูกต้องไปพร้อมกัน`;
    }
    if (human) {
      return `ถ้าเป็นการเลือกหรือกรอกผิด รบกวนยืนยัน ${docHint} และ ${fieldLabel} ให้ชัดก่อนครับ แล้วส่งให้ผู้ดูแลหลังบ้านช่วยปรับรายการเดิมได้เลย`;
    }
    if (inspectionRequest) {
      return `ถ้าเคสนี้เกี่ยวกับ SLA หรือเงื่อนไขการเลือกงาน รบกวนส่งเลข ticket และข้อมูลที่ระบบแสดงเทียบกับค่าที่คาดหวังมาให้ครบครับ`;
    }
    if (/system error|server|timeout|api|endpoint|error/i.test(problemType + ' ' + ticketContext)) {
      return `รับทราบครับ เคสนี้รบกวนส่งหน้าจอที่พบปัญหา, เวลาเกิดเหตุ, ข้อความ error ถ้ามี, และเลขรายการที่กระทบมาให้ครบครับ แล้วผมจะช่วยไล่ต่อให้`;
    }
    return `รับทราบครับ รบกวนเทียบข้อมูลในหน้าจอกับ record หรือเลขอ้างอิงที่คาดหวังก่อน ถ้ายังไม่ตรง ส่งเลขอ้างอิง จุดที่ผิด และค่าที่ถูกต้องมาได้เลยครับ`;
  }

  if (mode === 'evidence_request') {
    if (inspectionRequest) return `รบกวนส่งเลข ticket, ข้อมูลที่ระบบแสดง และค่าที่คาดหวังมาให้ครบครับ`;
    return `รบกวนส่ง ${docHint}, ${fieldLabel}, ค่าที่เห็นจริงตอนนี้ และค่าที่ถูกต้องที่ต้องการให้เป็นครับ`;
  }

  if (mode === 'next_step') {
    if (inspectionRequest) return `ขั้นตอนถัดไปคือเปิด ticket ที่แจ้งมาแล้วเทียบข้อมูลที่ใช้ตัดสินผลทีละตัวครับ ถ้าตรงกันหมดค่อยดูเงื่อนไขระบบต่อ`;
    if (human && backendDev) {
      return `ขั้นตอนถัดไปคือให้ผู้ดูแลหลังบ้านตรวจ ${docHint}, ${fieldLabel}, transaction log หรือประวัติรายการก่อน แล้วค่อยปรับข้อมูลเดิมให้ถูกต้องครับ`;
    }
    if (human) {
      return `ขั้นตอนถัดไปคือขอให้ยืนยัน ${docHint}, ${fieldLabel} และค่าที่ต้องแก้ให้ชัดก่อนครับ แล้วส่งให้ผู้ดูแลหลังบ้านช่วยปรับรายการเดิม`;
    }
    return `ขั้นตอนถัดไปคือช่วยไล่จากข้อมูลเดิมก่อนครับ: ตรวจรายการเดิม เทียบค่าที่เห็นกับค่าที่ควรเป็น แล้วดูว่าเกิดเฉพาะผู้ใช้เดียวหรือหลายคน ถ้าระบบยังให้ผลผิดค่อยส่งทีมเทคนิค`;
  }

  if (mode === 'dev_decision') {
    if (human && backendDev) {
      return `สามารถส่งต่อ Dev/ผู้ดูแลหลังบ้านได้ครับ เพราะต้องตรวจข้อมูลหลังบ้านหรือ log ก่อนแก้รายการเดิม รบกวนแนบ ${docHint}, ${fieldLabel} และค่าที่ต้องการแก้ไปพร้อมกัน`;
    }
    if (human) {
      return `ยังไม่จำเป็นต้องส่ง Dev เป็นขั้นแรกครับ เคสนี้ขอให้ผู้ดูแลหลังบ้านแก้รายการเดิมก่อน และค่อยส่ง Dev เฉพาะกรณีระบบสร้างหรือแสดงข้อมูลผิดเอง`;
    }
    return `ส่งทีมเทคนิคได้เมื่อเทียบข้อมูลแล้วระบบยังให้ผลผิดเองครับ ก่อนส่งให้แนบเลขรายการ, ${docHint}, ค่าที่คาดหวัง, ค่าที่เกิดขึ้นจริง และเวลาที่เกิดเหตุ`;
  }

  if (mode === 'missing_required_fields') {
    return `ยังขาดข้อมูลสำหรับช่วยไล่เคสครับ ขอ ${docHint}, ${fieldLabel}, ค่าที่เห็นจริง และค่าที่ควรเป็นก่อน`;
  }

  if (mode === 'summary') {
    return `สรุปตอนนี้เคสนี้เป็น ${problemType} เรื่อง ${issueTitle} ครับ แนวทางช่วยก่อนคือเทียบ ${docHint} กับ ${fieldLabel} แล้วแก้จุดที่ไม่ตรงให้เป็นค่าที่ควรเป็น`;
  }

  if (mode === 'customer_reply') {
    return `รับทราบครับ ทีมจะตรวจสอบ ${issueTitle} โดยเทียบ ${docHint} กับข้อมูลที่ถูกต้อง และประสานทีมที่เกี่ยวข้องให้ครับ`;
  }

  if (mode === 'fix_first_legacy_disabled') {
    if (human) {
      if (backendDev) {
        return `เคสนี้ควรส่งต่อ Dev/ผู้ดูแลหลังบ้านที่เข้าถึงข้อมูลได้ครับ เพราะต้องตรวจ ${docHint}, ${fieldLabel} และ log/ประวัติรายการก่อนแก้ข้อมูลจริง ให้แนบเลขอ้างอิง ค่าที่ต้องการแก้ และ screenshot ไปพร้อมกัน`;
      }
      return `เคสนี้ดูเป็นการเลือกหรือบันทึกผิดรายการครับ เบื้องต้นขอให้เช็ก ${docHint} และ ${fieldLabel} ให้ชัดก่อน แล้วค่อยส่งให้ back office/admin ปรับรายการเดิมครับ ยังไม่จำเป็นต้องส่ง Dev ถ้าไม่มีอาการว่าระบบสร้างข้อมูลผิดเอง`;
    }
    return `เบื้องต้นให้ลองทำซ้ำจากขั้นตอนเดิม แล้วเทียบผลที่เห็นกับค่าที่ควรเป็นก่อนครับ ถ้าเกิดซ้ำ ให้เก็บ ${docHint}, หน้าจอที่พบปัญหา และ screenshot เพื่อส่งต่อทีมที่เกี่ยวข้อง`;
  }

  if (mode === 'evidence_request') {
    return `ขอข้อมูลเพิ่ม 4 อย่างครับ: ${docHint}, ${fieldLabel}, ค่าที่ถูกต้องที่ต้องการให้เป็น และ screenshot หน้าจอจุดที่ไม่ตรง`;
  }

  if (mode === 'next_step') {
    if (human) {
      if (backendDev) {
        return `ขั้นตอนถัดไปคือส่งต่อ Dev/ผู้ดูแลหลังบ้านครับ โดยให้ตรวจ ${docHint}, ${fieldLabel}, transaction log หรือประวัติการแก้ไขก่อน แล้วค่อยปรับข้อมูลเดิมให้ถูกต้อง`;
      }
      return `ขั้นตอนถัดไปคือขอให้ยืนยัน ${docHint} กับ ${fieldLabel} ก่อนครับ ถ้าเป็นการเลือกหรือบันทึกผิด ให้ back office/admin แก้รายการเดิม แต่ถ้าระบบดึงหรือสร้างข้อมูลผิดเองค่อยส่ง Dev พร้อม expected/actual และ screenshot`;
    }
    return `ขั้นตอนถัดไปคือทำซ้ำด้วยรายการเดิม เก็บ expected/actual และแยกว่าเกิดเฉพาะผู้ใช้เดียวหรือทั้งระบบครับ ถ้าระบบทำงานผิดซ้ำค่อยส่ง Dev พร้อมหลักฐานครบ`;
  }

  if (mode === 'dev_decision') {
    if (human) {
      if (backendDev) {
        return `กรณีนี้สามารถส่งต่อ Dev/ผู้ดูแลหลังบ้านได้ครับ เพราะต้องเข้าถึงข้อมูลหลังบ้านหรือ log เพื่อตรวจรายการเดิมก่อนแก้ รบกวนแนบ ${docHint}, ${fieldLabel}, ค่าที่ต้องการแก้ และ screenshot ไปด้วย`;
      }
      return `ยังไม่จำเป็นต้องส่ง Dev เป็นขั้นแรกครับ เคสนี้เข้าทาง ${problemType} ขอให้ back office/admin แก้รายการเดิมก่อน และค่อยส่ง Dev เฉพาะกรณีที่กดถูกแล้วระบบสร้างหรือแสดงข้อมูลผิดเอง`;
    }
    return `สามารถส่ง Dev ได้เมื่อทำซ้ำแล้วพบว่าระบบทำงานผิดเองครับ รบกวนแนบขั้นตอนทำซ้ำ, ${docHint}, expected/actual, เวลาเกิดเหตุ และ screenshot ไปพร้อมกัน`;
  }

  if (mode === 'customer_reply') {
    return `รับทราบครับ ทีมจะตรวจสอบ ${issueTitle} โดยเทียบ ${docHint} กับข้อมูลที่ถูกต้อง และประสานผู้ดูแลให้ปรับรายการเดิม หากต้องการข้อมูลเพิ่มจะแจ้งกลับอีกครั้งครับ`;
  }

  if (mode === 'summary') {
    return `สรุปตอนนี้เคสนี้เป็น ${problemType} เกี่ยวกับ ${issueTitle} ครับ จุดที่ต้องยืนยันต่อคือ ${docHint}, ${fieldLabel}, ค่าที่เห็นตอนนี้ และค่าที่ต้องการแก้ให้ถูกต้อง`;
  }

  if (mode === 'missing_required_fields') {
    return `ยังขาดข้อมูลสำคัญสำหรับไล่เคสครับ รบกวนส่ง ${docHint}, ${fieldLabel}, ค่าที่เห็นตอนนี้ และค่าที่ถูกต้องที่ต้องการก่อน`;
  }

  return '';
}

function buildChatRepeatGuard(messages = []) {
  const recent = Array.isArray(messages) ? messages.slice(-6) : [];
  const userTexts = recent
    .filter((msg) => msg?.role !== 'ai' && msg?.role !== 'assistant')
    .map((msg) => {
      if (Array.isArray(msg?.content)) {
        return msg.content.map((part) => part?.type === 'text' ? String(part.text || '').trim() : '').filter(Boolean).join(' ');
      }
      return String(msg?.content || msg?.text || '').trim();
    })
    .filter(Boolean);
  const assistantTexts = recent
    .filter((msg) => msg?.role === 'ai' || msg?.role === 'assistant')
    .map((msg) => String(msg?.content || msg?.text || '').trim())
    .filter(Boolean);
  const lastAssistant = assistantTexts[assistantTexts.length - 1] || '';
  const userAskedFixCount = userTexts.filter((text) => /วิธีแก้|แก้ไขเบื้องต้น|แก้ยังไง|ต้องเอาข้อมูลตรงไหน|ข้อมูลตรงไหน|how\s+to\s+fix|solution|workaround/i.test(text)).length;
  const alreadyAskedForEvidence = /(เลขที่เอกสาร|เลขอ้างอิง|record|screenshot|ภาพหน้าจอ|รายละเอียด|ข้อมูลที่มีปัญหา)/i.test(lastAssistant);
  if (userAskedFixCount < 2 && !alreadyAskedForEvidence) return '';
  return [
    'Conversation repeat guard:',
    '- The assistant has already asked for reference/document/screenshot/detail in the recent conversation.',
    '- Do not repeat the same request with different wording.',
    '- Continue with the next useful guidance instead: tell the user what to compare or what exact evidence to prepare, in one short sentence.',
    '- If evidence is still missing, ask for only one item and phrase it as a next step, not the same repeated question.',
  ].join('\n');
}

function getLatestUserText(messages = []) {
  const recent = Array.isArray(messages) ? messages.slice().reverse() : [];
  for (const msg of recent) {
    if (msg?.role === 'ai' || msg?.role === 'assistant') continue;
    if (Array.isArray(msg?.content)) {
      const text = msg.content.map((part) => part?.type === 'text' ? String(part.text || '').trim() : '').filter(Boolean).join(' ').trim();
      if (text) return text;
      continue;
    }
    const text = String(msg?.content || msg?.text || '').trim();
    if (text) return text;
  }
  return '';
}

function shouldRewriteDataEvidenceAnswer(reply = '', latestUserText = '', ticketContext = '') {
  const source = String(`${latestUserText}\n${ticketContext}` || '').toLowerCase();
  const asksWhere = source.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e15\u0e23\u0e07\u0e44\u0e2b\u0e19')
    || source.includes('\u0e40\u0e2d\u0e32\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || source.includes('\u0e15\u0e23\u0e07\u0e44\u0e2b\u0e19')
    || source.includes('\u0e15\u0e23\u0e07')
    || source.includes('\u0e44\u0e2b\u0e19')
    || source.includes('what data')
    || source.includes('which data');
  const dataContext = source.includes('data issue')
    || source.includes('record')
    || source.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25')
    || source.includes('\u0e10\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  if (!asksWhere || !dataContext) return false;
  const text = String(reply || '');
  return !text.includes('\u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e40\u0e2b\u0e47\u0e19') && !text.includes('\u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e04\u0e27\u0e23\u0e40\u0e1b\u0e47\u0e19');
}

async function rewriteDataEvidenceAnswerWithAi({ aiUrl, azureKey, isDeploymentUrl, modelName, reply, latestUserText, ticketContext, timeoutMs = 4500 }) {
  const payload = {
    messages: [
      {
        role: 'system',
        content: [
          'Rewrite a Thai helpdesk chat reply.',
          'Return only the final reply.',
          'The user is asking which data to provide, so do not ask the same broad question again.',
          'Answer specifically in 1-2 short Thai sentences.',
          'Say they should provide: affected screen/menu, record/document/reference id, value currently shown, and expected value.',
          'The Thai reply must include these exact phrases: "ค่าที่เห็นตอนนี้" and "ค่าที่ควรเป็น".',
          'A good reply starts like: ให้ส่งชื่อหน้าจอ/เมนู, เลข record หรือเลขเอกสาร, ค่าที่เห็นตอนนี้ และค่าที่ควรเป็นครับ',
          'No numbered list, no markdown table.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `[Original reply]\n${reply}`,
          `[Latest user message]\n${latestUserText}`,
          ticketContext ? `[Ticket context]\n${ticketContext}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    temperature: 0.1,
    max_tokens: 170,
    model: modelName,
  };
  if (isDeploymentUrl) delete payload.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureKey,
        ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return '';
    const data = await res.json();
    let rewritten = data?.choices?.[0]?.message?.content;
    if (Array.isArray(rewritten)) rewritten = rewritten.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
    return cleanupHelpdeskChatReply(rewritten, '');
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAiChat(path, method, request, env) {
  if (path !== '/ai/chat' || method !== 'POST') return null;

  const azureEndpoint = String(env.AZURE_AI_ENDPOINT || env.AZURE_AI_MODELS_CHAT_ENDPOINT || env.AZURE_OPENAI_ENDPOINT || env.OAI_ENDPOINT || '').trim();
  const azureDeployment = String(env.AZURE_AI_DEPLOYMENT || env.AZURE_AI_MODELS_CHAT_DEPLOYMENT || env.AZURE_OPENAI_DEPLOYMENT || env.OAI_DEPLOY || env.AZURE_AI_MODEL || env.AZURE_AI_MODELS_CHAT_MODEL || 'gpt-4o').trim();
  const azureApiVersion = String(env.AZURE_AI_API_VERSION || env.AZURE_AI_MODELS_CHAT_API_VERSION || env.AZURE_OPENAI_API_VERSION || env.OAI_API_VERSION || '2025-01-01-preview').trim();
  const azureUrl = String(env.AZURE_AI_URL || env.AZURE_AI_MODELS_CHAT_URL || env.AZURE_OPENAI_CHAT_URL || (azureEndpoint && azureDeployment ? `${azureEndpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(azureDeployment)}/chat/completions?api-version=${encodeURIComponent(azureApiVersion)}` : '')).trim();
  const azureKey = String(env.OAI_KEY || env.AZURE_AI_KEY || env.AZURE_AI_MODELS_CHAT_KEY || env.AZURE_OPENAI_API_KEY || env.AZURE_OPENAI_KEY || '').trim();
  const body = await request.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json({ ok: false, error: 'messages required' }, 400);
  const ticketContext = String(body.ticketContext || '').trim();
  const sanitizedTicketContext = ticketContext
    .split(/\r?\n/)
    .filter((line) => !/^\s*Linked Knowledge:/i.test(line) && !/^\s*Linked Tickets:/i.test(line))
    .join('\n')
    .trim();
  const extractMessageText = (msg) => {
    if (Array.isArray(msg?.content)) {
      return msg.content.map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return String(part.text || '').trim();
        if (part.type === 'image_url') return '[image]';
        return '';
      }).filter(Boolean).join(' ').trim();
    }
    return String(msg?.text || msg?.content || '').trim();
  };
  const latestText = messages.map((msg) => extractMessageText(msg)).filter(Boolean).join('\n');
  const latestUserText = getLatestUserText(messages);
  const responseMode = normalizeChatResponseMode(body.responseMode || body.response_mode || '');
  const rawMessageText = JSON.stringify(messages || []);
  const forceEvidenceAnswer = rawMessageText.includes('\u0e15\u0e49\u0e2d\u0e07\u0e40\u0e2d\u0e32\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e15\u0e23\u0e07\u0e44\u0e2b\u0e19')
    || rawMessageText.includes('\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e15\u0e23\u0e07\u0e44\u0e2b\u0e19')
    || rawMessageText.includes('\u0e40\u0e2d\u0e32\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25');
  const evidenceQuestionMode = isDataEvidenceQuestion(latestUserText, sanitizedTicketContext);
  const dataFixQuestionMode = isDataFixQuestion(latestUserText, sanitizedTicketContext);
  const dbFollowupMode = isDbFollowupQuestion(latestUserText, sanitizedTicketContext);
  const responseModeReply = buildResponseModeReply(responseMode, sanitizedTicketContext);
  if (responseModeReply) {
    return json({
      ok: true,
      reply: removeScreenshotRequests(responseModeReply),
      responseMode,
      references: [],
    });
  }
  const knowledgeQuery = `${latestText}\n${sanitizedTicketContext}`;
  const knowledgeScope = inferKnowledgeScope(knowledgeQuery, body);
  const [embeddingKnowledgeRows, keywordKnowledgeRows, ticketRows] = await Promise.all([
    findRelevantKnowledgeByEmbedding(env, knowledgeQuery, { ...knowledgeScope, limit: 6 }),
    findRelevantKnowledge(env, knowledgeQuery, knowledgeScope),
    findRelevantHelpdeskTickets(env, knowledgeQuery),
  ]);
  const knowledgeRows = mergeKnowledgeRows(embeddingKnowledgeRows, keywordKnowledgeRows, 6);
  const knowledgeContext = formatKnowledgeContext(knowledgeRows.slice(0, 2));
  const ticketHistoryContext = formatHelpdeskTicketContext(ticketRows.slice(0, 3));
  const repeatGuard = buildChatRepeatGuard(messages);
  const promptFiles = await Promise.all([
    readAssetText(env, '/prompts/helpdesk/classify-problem-type.system.md'),
    readAssetText(env, '/prompts/helpdesk/classify-problem-type.examples.md'),
    readAssetText(env, '/prompts/helpdesk/classify-problem-type.usecases.md'),
    readAssetText(env, '/prompts/helpdesk/project-playbooks.md'),
  ]);
  const helpdeskPromptContext = [
    clipPromptText('Classification rules', promptFiles[0], 900),
    clipPromptText('Classification examples', promptFiles[1], 900),
    clipPromptText('Historical use cases', promptFiles[2], 2200),
    clipPromptText('Project playbooks', promptFiles[3], 1200),
  ].filter(Boolean).join('\n\n---\n\n');
  const systemSections = [
    'AI Journey is the Help Desk assistant for BeTiMES Solutions.',
    helpdeskPromptContext ? `[Helpdesk Classification Use Cases and Playbooks]\n${helpdeskPromptContext}` : '',
    [
      'Chat response style:',
      '- This endpoint is for a LINE-like support chat, not a ticket analysis report.',
      '- Reply in 1-2 short Thai sentences by default.',
      '- Do not use numbered lists, checklist formatting, markdown tables, or long step-by-step analysis unless the user explicitly asks for detailed steps.',
      '- Do not mention master data, mapping, permission, config, database, logs, or developer routing unless those words or clear evidence appear in the ticket or user message.',
      '- If the user asks "วิธีแก้" with vague data/context, give the safest first action in plain language and ask for only one missing item.',
      '- Do not only ask for more information when the user asks for a fix. Always include one concrete first action before the question.',
      '- For vague data mismatch issues, the concrete first action is to compare the affected screen/record with the expected value, then ask for the reference number or affected record.',
      '- If the user says the issue is in DB/database/table/record, guide them to identify table/field/primary key, compare current value vs expected value, and ask for only the missing evidence.',
      '- Do not tell the user to forward to a supervisor for Data Issue chat follow-ups. Help them collect the exact evidence first.',
      '- For Human error, say it can be sent to back office/admin with the exact record and desired correction, using a polite and respectful tone. Do not add unrelated checks.',
    ].join('\n'),
    repeatGuard,
    evidenceQuestionMode
      ? [
          'Latest user intent:',
          '- The user is asking which data/evidence to provide for a Data Issue.',
          '- Do not repeat the previous broad request for screenshot/reference.',
          '- Answer specifically with the affected screen/menu, record/document/reference id, ค่าที่เห็นตอนนี้, and ค่าที่ควรเป็น.',
          '- Do not mention back office/admin for this Data Issue evidence question.',
        ].join('\n')
      : '',
    ticketContext ? `[Ticket Context]\n${ticketContext}` : '',
    latestText.includes('[image]') ? 'The user attached image(s). Use them when deciding what is wrong, but do not ask for another screenshot.' : '',
    knowledgeContext ? `[Helpdeck Knowledge Context]\n${knowledgeContext}` : '',
    ticketHistoryContext ? `[Historical Helpdesk Tickets]\n${ticketHistoryContext}` : '',
    [
      'Resolution playbook:',
      '- Human error: use this only when the user clearly entered, selected, routed, registered, or confirmed the wrong item, or asks to reverse a specific user action. Keep the tone polite and natural. Tell the user to send the exact record/document and the desired correction to the right support team, usually the back office/admin or ผู้ดูแลหลังบ้าน.',
      '- Human error response style: keep it short, polite, and direct. Mention the exact field or document to correct, and do not route it to Dev unless there is a real system bug.',
      '- system error: help first by checking the screen, error message, time, affected user/item, and whether the problem is reproducible.',
      '- System Bug: ask for exact reproduction steps, affected screen/module, and whether a recent change triggered it; then route to Dev.',
      '- Change Request: treat as a request to modify behavior/data/flow; confirm what should change and who approves it.',
      '- Software: check master data, mapping, permissions, or configuration first, but explain it in simple Thai.',
      '- network: check connectivity, VPN, LAN, firewall, and whether the issue affects all users or only one site.',
      '- hardware: check device, cable, printer, scanner, browser/device-specific symptoms, and swap test if possible.',
      '- If visual data is missing, ask for the exact screen/menu name or error text instead of asking for a screenshot.',
    ].join('\n'),
    ticketContext
      ? ['Your job:', '1. Answer in Thai.', '2. Keep the reply short, clear, and easy to read.', '3. Use a polite, respectful, and helpful tone.', '4. Start with a direct helpful acknowledgement such as "รับทราบครับ" or "ขอเช็กให้ครับ" instead of sounding like a checklist.', '5. If the user asks how to fix it, answer with the most likely fix or workaround first, then ask for more details only if needed.', '6. Do not ask for screenshot as the main next step.', '7. If the ticket is Human error and it clearly describes a user mistake, tell the user to send the exact record/document and desired correction to the back office/admin or ผู้ดูแลหลังบ้าน.', '8. Ask only one short follow-up question if more detail is needed, such as the exact document number, record, or desired correction.', '9. Do not route Human error cases to Dev unless there is a clear system bug.', '10. Do not invent facts beyond the ticket or knowledge context.'].join('\n')
      : ['Your job:', '1. Answer in Thai.', '2. Keep the reply short, clear, and easy to read.', '3. Use a polite, respectful, and helpful tone.', '4. Start with a direct helpful acknowledgement such as "รับทราบครับ" or "ขอเช็กให้ครับ" instead of sounding like a checklist.', '5. If the user asks how to fix it, answer with the most likely fix or workaround first, then ask for more details only if needed.', '6. Do not ask for screenshot as the main next step.', '7. Ask only 1 short clarifying question when the knowledge context is not enough.', '8. Use the knowledge context as the primary source when available.', '9. If the issue is Human error and it clearly describes a user mistake, tell the user to send the exact record/document and desired correction to the back office/admin or ผู้ดูแลหลังบ้าน.'].join('\n'),
    [
      'Response examples:',
      'User: มีวิธีแก้ไขเบื้องต้นยังไงบ้าง',
      'Ticket: Data Issue / ข้อมูลของระบบหรือฐานข้อมูลไม่ตรงกัน',
      'Good reply: เบื้องต้นให้เทียบข้อมูลในหน้าจอกับ record หรือเลขอ้างอิงที่มีปัญหาก่อนครับ รบกวนส่งเลขที่เอกสาร จุดที่ข้อมูลไม่ตรง และค่าที่ควรเป็นมาเพิ่มครับ',
      'Bad reply: รบกวนขอรายละเอียดเพิ่มเติมครับ',
      'Bad reply: ลองตรวจสอบ master data, mapping, permission และ config',
    ].join('\n'),
    'Rules: be concise, do not guess, and do not fabricate project/team/owner details without support from the ticket, historical tickets, or knowledge context. Prefer short sentences over long paragraphs. If the answer starts becoming a checklist, shorten it to a natural chat reply.',
  ].filter(Boolean);
  const systemPrompt = systemSections.join('\n\n');
  const aiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
      .slice(-6)
      .map((msg) => ({
        role: (msg.role === 'ai' || msg.role === 'assistant') ? 'assistant' : 'user',
        content: Array.isArray(msg.content)
          ? msg.content.map((part) => {
              if (!part || typeof part !== 'object') return null;
              if (part.type === 'text') return { type: 'text', text: String(part.text || '').trim().slice(0, 1000) };
              if (part.type === 'image_url' && part.image_url?.url) return { type: 'image_url', image_url: { url: String(part.image_url.url || '') } };
              return null;
            }).filter(Boolean)
          : String(msg.text || msg.content || '').trim().slice(0, 1000),
      }))
      .filter((msg) => msg.content),
  ];

  const aiUrl = azureUrl;
  const modelName = String(env.AZURE_OPENAI_DEPLOYMENT || env.AZURE_AI_MODEL || env.AZURE_AI_MODELS_CHAT_MODEL || 'gpt-4o').trim();
  const isDeploymentUrl = aiUrl.includes('/openai/deployments/');
  const payload = { messages: aiMessages, temperature: 0.2, max_tokens: 220, model: modelName };
  if (isDeploymentUrl) delete payload.model;

  const buildRuleKnowledgeReply = (reason = '') => {
    const knowledgeTop = Array.isArray(knowledgeRows) ? knowledgeRows.find((row) => Number(row?._score || 0) >= 3) || null : null;
    const ticketTop = Array.isArray(ticketRows) ? ticketRows.find((row) => Number(row?._score || 0) >= 3) || null : null;
    const joinedText = `${ticketContext}\n${latestText}\n${knowledgeContext}\n${ticketHistoryContext}`.toLowerCase();
    const actionText = `${latestText || ''}\n${ticketContext || ''}`.trim();
    const preferSolutionFirst = isFixSeekingIntent(joinedText);
    const guessedProblemType = /(เลขรับ|ทะเบียนรับ|ลงรับ|เส้นทางหนังสือ|สารบรรณ|ยกเลิกเลขรับ|คืนเลขรับ|หนังสือ|กดรับผิดเรื่อง|ลงผิด|เลือกผิด|กรอกผิด|ส่งผิด)/i.test(joinedText)
      ? 'Human error'
      : /(server error|timeout|500|ล่ม|ค้าง|ขัดข้อง|connection refused|failed to fetch|system error|error)/i.test(joinedText)
        ? 'system error'
        : /(bug|logic|unexpected|crash|exception|ทำซ้ำ|เกิดซ้ำ|หน้าจอ|module)/i.test(joinedText)
          ? 'System Bug'
          : /(change request|feature request|enhancement|ขอเพิ่ม|ขอปรับ|ปรับปรุง|เพิ่ม field|เพิ่ม dropdown)/i.test(joinedText)
            ? 'Change Request'
            : /(network|wifi|vpn|lan|connection|เชื่อมต่อไม่ได้|offline)/i.test(joinedText)
              ? 'network'
              : /(hardware|printer|scanner|keyboard|mouse|monitor|เครื่อง|อุปกรณ์)/i.test(joinedText)
                ? 'hardware'
                : 'Software';
    const sourceAnalysis = { problem_type: guessedProblemType || '', likely_cause: ticketContext || latestText || '' };
    const dataIssueHint = /(database|db|sql|query|table|schema|record|mapping|master data|permission|config|data issue)/i.test(actionText);
    const concreteAction = dataIssueHint
      ? { method: 'ลองเช็กฐานข้อมูล ตาราง หรือ mapping ที่เกี่ยวข้องก่อน', detail: 'ถ้ายังไม่หาย ให้ส่ง record id, ค่าที่เห็นจริง, ค่าที่ควรเป็น และ log ถ้ามีเพื่อไล่จุดที่ผิด' }
      : buildConcreteHelpdeskAction(sourceAnalysis.problem_type || '', actionText || ticketContext || '', sourceAnalysis.likely_cause || '');
    const humanErrorHint = !dataIssueHint && /(wrongly|mistakenly|selected the wrong|clicked the wrong|entered the wrong|filled the wrong|sent the wrong|routed the wrong|registered the wrong|reversed|correction|undo|rollback|ลงผิด|เลือกผิด|กดผิด|กรอกผิด|ส่งผิด|ลงรับผิด|ยืนยันผิด|บันทึกผิด)/i.test(actionText);
    const methodLine = `วิธีที่ลองได้ก่อนคือ ${concreteAction.method}`;
    const detailLine = concreteAction.detail;
    const followUpLine = 'ถ้ายังไม่หาย รบกวนส่งข้อความ error, เวลาที่เกิดเหตุ หรือ record id เพิ่มครับ';
    if (humanErrorHint) {
      return formatReplyFlow({ summary: 'ส่งรายการให้ back office / admin แก้ก่อนครับ', reason: 'ถ้าแก้ผิดจุดอาจกระทบข้อมูลเดิม', sourceLabel: 'ข้อมูลที่แจ้ง', nextQuestion: 'ขอเลขอ้างอิงกับฟิลด์ที่ต้องแก้ให้ชัดหน่อยครับ', nextStep: `${methodLine} ${detailLine}`, preferSolutionFirst });
    }
    if (knowledgeTop) {
      return formatReplyFlow({ summary: methodLine, reason: 'ข้อมูลที่มีอยู่ชี้ไปทางนี้ครับ', sourceLabel: 'ข้อมูลที่ใกล้เคียง', nextQuestion: followUpLine, nextStep: detailLine, preferSolutionFirst });
    }
    if (ticketTop) {
      return formatReplyFlow({ summary: methodLine, reason: 'อาการนี้ใกล้กับเคสที่เคยแก้มาก่อนครับ', sourceLabel: 'เคสที่คล้ายกัน', nextQuestion: 'ขอ record id, ข้อความ error หรือ log ที่ชัดกว่านี้ครับ', nextStep: detailLine, preferSolutionFirst });
    }
    return formatReplyFlow({ summary: methodLine, reason: 'ตอนนี้ยังไม่เจอข้อมูลที่ตรงพอ', sourceLabel: 'ข้อมูลที่มีอยู่', nextQuestion: 'ขอข้อความ error, record id หรือเวลาที่เกิดเหตุเพิ่มครับ', nextStep: detailLine, preferSolutionFirst });
  };

  if (!azureUrl || !azureKey) {
    return json({
      ok: false,
      error: 'Azure AI is not configured',
      references: [
        ...knowledgeRows.map((row) => ({ type: 'knowledge', id: row.id, title: row.title, tags: row.tags })),
        ...ticketRows.map((row) => ({ type: 'ticket', id: row.id, title: row.title, bug_type: row.bug_type, project: row.project })),
      ],
    }, 503);
  }

  if (!aiUrl) {
    return json({
      ok: false,
      error: 'Azure AI URL is empty',
      references: [
        ...knowledgeRows.map((row) => ({ type: 'knowledge', id: row.id, title: row.title, tags: row.tags })),
        ...ticketRows.map((row) => ({ type: 'ticket', id: row.id, title: row.title, bug_type: row.bug_type, project: row.project })),
      ],
    }, 503);
  }

  const aiTimeoutMs = Math.max(10000, Math.min(60000, Number(env.AZURE_AI_TIMEOUT_MS || 30000)));
  const aiController = new AbortController();
  const aiTimer = setTimeout(() => aiController.abort(), aiTimeoutMs);

  try {
    const aiRes = await fetch(aiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureKey,
        ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
      },
      body: JSON.stringify(payload),
      signal: aiController.signal,
    });
    clearTimeout(aiTimer);

    if (!aiRes.ok) {
      const detail = await aiRes.text();
      const brief = String(detail || '').slice(0, 400);
      return json({
        ok: false,
        error: `Azure AI error (${aiRes.status})`,
        detail: brief,
        references: [
          ...knowledgeRows.map((row) => ({ type: 'knowledge', id: row.id, title: row.title, tags: row.tags })),
          ...ticketRows.map((row) => ({ type: 'ticket', id: row.id, title: row.title, bug_type: row.bug_type, project: row.project })),
        ],
      }, 502);
    }

    const aiJson = await aiRes.json();
    let reply = aiJson?.choices?.[0]?.message?.content;
    if (Array.isArray(reply)) {
      reply = reply.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ').trim();
    }
    reply = cleanupHelpdeskChatReply(reply, '');
    if (shouldRewriteDataEvidenceAnswer(reply, latestUserText, ticketContext)) {
      const rewritten = await rewriteDataEvidenceAnswerWithAi({ aiUrl, azureKey, isDeploymentUrl, modelName, reply, latestUserText, ticketContext });
      if (rewritten) reply = rewritten;
    }
    if (shouldRewriteQuestionOnlyFixReply(reply, latestText, ticketContext)) {
      const rewritten = await rewriteHelpdeskChatReplyWithAi({ aiUrl, azureKey, isDeploymentUrl, modelName, reply, latestText, ticketContext });
      if (rewritten) reply = rewritten;
    }
    if (!evidenceQuestionMode && shouldRewriteHumanErrorAdminReply(reply, latestText, ticketContext)) {
      const rewritten = await rewriteHumanErrorReplyWithAi({ aiUrl, azureKey, isDeploymentUrl, modelName, reply, latestText, ticketContext });
      if (rewritten) reply = rewritten;
    }
    if (forceEvidenceAnswer) {
      reply = '\u0e43\u0e2b\u0e49\u0e2a\u0e48\u0e07\u0e0a\u0e37\u0e48\u0e2d\u0e2b\u0e19\u0e49\u0e32\u0e08\u0e2d/\u0e40\u0e21\u0e19\u0e39, \u0e40\u0e25\u0e02 record \u0e2b\u0e23\u0e37\u0e2d\u0e40\u0e25\u0e02\u0e40\u0e2d\u0e01\u0e2a\u0e32\u0e23, \u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e40\u0e2b\u0e47\u0e19\u0e15\u0e2d\u0e19\u0e19\u0e35\u0e49 \u0e41\u0e25\u0e30\u0e04\u0e48\u0e32\u0e17\u0e35\u0e48\u0e04\u0e27\u0e23\u0e40\u0e1b\u0e47\u0e19\u0e04\u0e23\u0e31\u0e1a';
    }
    reply = applyChatAnswerGuardrails(reply, {
      evidenceQuestionMode: evidenceQuestionMode || isDataEvidenceQuestion(latestUserText, ticketContext),
      dataFixQuestionMode: dataFixQuestionMode || isDataFixQuestion(latestUserText, ticketContext),
      dbFollowupMode: dbFollowupMode || isDbFollowupQuestion(latestUserText, ticketContext),
    });
    reply = removeScreenshotRequests(reply);
    if (!reply) {
      return json({
        ok: false,
        error: 'Azure AI returned an empty reply',
        references: [
          ...knowledgeRows.map((row) => ({ type: 'knowledge', id: row.id, title: row.title, tags: row.tags })),
          ...ticketRows.map((row) => ({ type: 'ticket', id: row.id, title: row.title, bug_type: row.bug_type, project: row.project })),
        ],
      }, 502);
    }
    return json({
      ok: true,
      reply,
      references: [
        ...knowledgeRows.map((row) => ({ type: 'knowledge', id: row.id, title: row.title, tags: row.tags })),
        ...ticketRows.map((row) => ({ type: 'ticket', id: row.id, title: row.title, bug_type: row.bug_type, project: row.project })),
      ],
    });
  } catch (e) {
    clearTimeout(aiTimer);
    const reason = e?.name === 'AbortError' ? ('AI timeout after ' + aiTimeoutMs + 'ms') : ('AI error: ' + (e?.message || e));
    return json({
      ok: false,
      error: reason,
      references: [
        ...knowledgeRows.map((row) => ({ type: 'knowledge', id: row.id, title: row.title, tags: row.tags })),
        ...ticketRows.map((row) => ({ type: 'ticket', id: row.id, title: row.title, bug_type: row.bug_type, project: row.project })),
      ],
    }, 502);
  }
}
