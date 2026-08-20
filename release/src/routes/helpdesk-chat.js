/**
 * routes/helpdesk-chat.js
 * GET/POST /helpdesk/tickets/:id/chat
 */

import { pgQuery, pgFirst, ensureHelpdeskChatSchema } from '../db.js';
import { json, err, uid, tryParseJson } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

async function resolveHelpdeskTicketRow(env, ticketRef) {
  const ref = String(ticketRef || '').trim();
  if (!ref) return null;
  const row = await pgFirst(
    env,
    `SELECT id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra
     FROM helpdesk_tickets
     WHERE id=$1
        OR odoo_ticket_id=$1
        OR COALESCE(extra, '') LIKE $2
        OR COALESCE(extra, '') LIKE $3
     LIMIT 1`,
    [ref, `%\"case_ticket_id\":\"${ref}\"%`, `%\"uuid\":\"${ref}\"%`]
  );
  return row || null;
}

async function createHelpdeskChatSession(env, ticketId, createdBy = '', source = 'helpdesk_v3') {
  const sessionId = `chs_${uid().slice(0, 12)}`;
  await pgQuery(
    env,
    `UPDATE helpdesk_ticket_chat_sessions SET is_active=0, updated_at=now() WHERE ticket_id=$1 AND is_active=1`,
    [ticketId]
  );
  await pgQuery(
    env,
    `INSERT INTO helpdesk_ticket_chat_sessions (id, ticket_id, is_active, created_by, source) VALUES ($1,$2,1,$3,$4)`,
    [sessionId, ticketId, createdBy || null, source || 'helpdesk_v3']
  );
  return sessionId;
}

async function resolveHelpdeskChatSessionId(env, ticketId, requestedSessionId = '') {
  const requested = String(requestedSessionId || '').trim();
  if (requested) return requested;
  const active = await pgFirst(
    env,
    `SELECT id FROM helpdesk_ticket_chat_sessions WHERE ticket_id=$1 AND is_active=1 ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    [ticketId]
  );
  if (active?.id) return String(active.id).trim();
  const legacyRows = await pgFirst(
    env,
    `SELECT COUNT(*) AS count FROM helpdesk_ticket_chats WHERE ticket_id=$1 AND COALESCE(session_id, '')=''`,
    [ticketId]
  );
  if (Number(legacyRows?.count || 0) > 0) return '';
  return createHelpdeskChatSession(env, ticketId);
}

function extractChatMessageText(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '').trim();
      if (part.type === 'image_url') return '[image]';
      return '';
    }).filter(Boolean).join(' ').trim();
  }
  return String(content?.text || content?.content || content || '').trim();
}

export async function handleHelpdeskChat(path, method, request, env) {
  const url = new URL(request.url);

  if (path.startsWith('/helpdesk/tickets/') && path.endsWith('/chat')) {
    const s = await requireAuth(request, env);
    await ensureHelpdeskChatSchema(env);
    const parts = path.split('/').filter(Boolean);
    const ticketRef = parts[2] || '';
    if (!ticketRef) return err('Invalid ticket id', 400);
    const ticketRow = await resolveHelpdeskTicketRow(env, ticketRef);
    if (!ticketRow) return err('Ticket not found', 404);
    const ticketId = String(ticketRow.id || ticketRef).trim();
    const requestedSessionId = String(url.searchParams.get('session_id') || '').trim();

    if (method === 'GET') {
      const sessionId = await resolveHelpdeskChatSessionId(env, ticketId, requestedSessionId);
      const isLegacySession = !sessionId;
      const rows = await pgQuery(
        env,
        isLegacySession
          ? `SELECT id, ticket_id, sequence, role, content_text, content_json, sender_name, sender_type, session_id, created_by, source, created_at, updated_at
             FROM helpdesk_ticket_chats
             WHERE ticket_id=$1 AND COALESCE(session_id, '')=''
             ORDER BY sequence ASC, created_at ASC, id ASC`
          : `SELECT id, ticket_id, sequence, role, content_text, content_json, sender_name, sender_type, session_id, created_by, source, created_at, updated_at
             FROM helpdesk_ticket_chats
             WHERE ticket_id=$1 AND session_id=$2
             ORDER BY sequence ASC, created_at ASC, id ASC`,
        isLegacySession ? [ticketId] : [ticketId, sessionId]
      );
      return json({
        ok: true,
        ticket_id: ticketId,
        session_id: sessionId,
        is_legacy_session: isLegacySession,
        data: rows.map((row) => ({ ...row, content_json: tryParseJson(row.content_json || '{}', {}) })),
      });
    }

    if (method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (String(body.action || '').trim().toLowerCase() === 'reset' || body.reset === true) {
        const sessionId = await createHelpdeskChatSession(env, ticketId, s.user_id, String(body.source || 'helpdesk_v3').trim() || 'helpdesk_v3');
        return json({ ok: true, ticket_id: ticketId, session_id: sessionId, reset: true });
      }
      const incoming = Array.isArray(body.messages) ? body.messages : body.message ? [body.message] : [];
      if (!incoming.length) return err('messages required', 400);
      let sessionId = String(body.session_id || '').trim();
      if (!sessionId) {
        sessionId = await resolveHelpdeskChatSessionId(env, ticketId, requestedSessionId);
      }
      if (!sessionId) sessionId = '';

      const nextSeqRow = await pgFirst(
        env,
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM helpdesk_ticket_chats WHERE ticket_id=$1 AND COALESCE(session_id, '')=$2`,
        [ticketId, sessionId]
      );
      let nextSeq = Number(nextSeqRow?.next_seq || 1);
      const saved = [];
      for (const rawMessage of incoming) {
        const message = rawMessage && typeof rawMessage === 'object' ? rawMessage : { role: 'user', content: rawMessage };
        const role = String(message.role || 'user').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
        const content = message.content ?? message.text ?? '';
        const senderName = String(message.sender_name || message.senderName || (role === 'assistant' ? 'MANA' : '')).trim();
        const senderType = String(message.sender_type || message.senderType || role).trim();
        const payload = { role, content, sender_name: senderName, sender_type: senderType };
        const contentText = extractChatMessageText(content);
        const id = `cht_${uid().slice(0, 12)}`;
        await pgQuery(
          env,
          `INSERT INTO helpdesk_ticket_chats (id, ticket_id, sequence, role, content_text, content_json, sender_name, sender_type, session_id, created_by, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, ticketId, nextSeq++, role, contentText, JSON.stringify(payload), senderName, senderType, sessionId, role === 'assistant' ? 'ai' : s.user_id, String(body.source || 'helpdesk_v3').trim() || 'helpdesk_v3']
        );
        saved.push({ id, ticket_id: ticketId, session_id: sessionId, sequence: nextSeq - 1, ...payload, content_text: contentText });
      }
      return json({ ok: true, ticket_id: ticketId, session_id: sessionId, data: saved });
    }

    return err('Method not allowed', 405);
  }

  return null;
}
