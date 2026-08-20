/**
 * index.js — entry point
 * Betime Solution — Cloudflare Pages _worker.js (modular rewrite)
 * Handles /api/* routes; serves static assets for everything else.
 */

import { handleHealth } from './routes/health.js';
import { handleAuth } from './routes/auth.js';
import { handleDashboards } from './routes/dashboards.js';
import { handleProjects } from './routes/projects.js';
import { handleFinance } from './routes/finance.js';
import { handleCalendar } from './routes/calendar.js';
import { handleUsers } from './routes/users.js';
import { handleHelpdesk } from './routes/helpdesk.js';
import { handleHelpdeskChat } from './routes/helpdesk-chat.js';
import { handleAiChat } from './routes/ai-chat.js';
import { handleKnowledge } from './routes/knowledge.js';
import { handleMasterData } from './routes/master-data.js';
import { handleLineBot } from './routes/line-bot.js';
import { handleFiles } from './routes/files.js';
import { handleBusiness } from './routes/business.js';
import { handleLegacy } from './routes/legacy.js';
import { CORS_HEADERS, err } from './utils.js';

function getAppBasePath(pathname) {
  const raw = String(pathname || '');
  for (const prefix of ['/web']) {
    if (raw === prefix || raw.startsWith(prefix + '/')) return prefix;
  }
  return '';
}

function stripAppBasePath(pathname) {
  const base = getAppBasePath(pathname);
  if (!base) return String(pathname || '/');
  const raw = String(pathname || '/');
  const stripped = raw.slice(base.length) || '/';
  return stripped.startsWith('/') ? stripped : '/' + stripped;
}

function rewriteRequestForAssets(request, pathname, search = '') {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = search;
  return new Request(url.toString(), request);
}

const ROUTE_HANDLERS = [
  handleHealth,
  handleLineBot,      // before auth so webhook doesn't need auth
  handleAuth,
  handleDashboards,
  handleProjects,
  handleFinance,
  handleCalendar,
  handleUsers,
  handleHelpdeskChat, // before handleHelpdesk so /tickets/:id/chat is matched first
  handleHelpdesk,
  handleAiChat,
  handleKnowledge,
  handleMasterData,
  handleFiles,
  handleLegacy,
  handleBusiness,
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const appPathname = stripAppBasePath(url.pathname);
    const path = appPathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    if (!appPathname.startsWith('/api/')) {
      return env.ASSETS.fetch(rewriteRequestForAssets(request, appPathname, url.search));
    }

    try {
      for (const handler of ROUTE_HANDLERS) {
        const res = await handler(path, method, request, env);
        if (res) return res;
      }
    } catch (e) {
      if (e instanceof Response) return e;
      console.error(e);
      return err('Server error: ' + (e?.message || String(e)), 500);
    }

    return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
};
