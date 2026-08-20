/* ===================================================================
   shared.js — Sidebar + Appbar injector for Cloudflare Pages bundle
   =================================================================== */
'use strict';

window.BT = window.BT || {};

function btResolveBasePath(pathname) {
  const raw = String(pathname || '/');
  for (const prefix of ['/web']) {
    if (raw === prefix || raw.startsWith(prefix + '/')) return prefix;
  }
  return '';
}

function btCanonicalizeBasePath(pathname) {
  return String(pathname || '/').replace(/^\/web\/web(?=\/|$)/, '/web');
}

function btJoinPath(pathname) {
  const base = btResolveBasePath(window.location.pathname || '/');
  const raw = btCanonicalizeBasePath(pathname);
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith('mailto:') || raw.startsWith('tel:')) return raw;
  if (!base) return raw;
  if (raw === base || raw.startsWith(base + '/')) return raw;
  if (raw === '/') return `${base}/`;
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

function btNormalizePath(pathname) {
  const base = btResolveBasePath(window.location.pathname || '/');
  const raw = btCanonicalizeBasePath(pathname);
  if (!base) return raw;
  if (raw === base) return '/';
  if (raw.startsWith(base + '/')) return raw.slice(base.length) || '/';
  return raw;
}

function btApiUrl(pathname) {
  const raw = String(pathname || '');
  return btJoinPath('/api' + (raw.startsWith('/') ? raw : '/' + raw));
}

BT.basePath = btResolveBasePath(window.location.pathname || '/');
BT.url = btJoinPath;
BT.apiUrl = btApiUrl;
BT.go = function (pathname) { window.location.href = btJoinPath(pathname); };
BT.replace = function (pathname) { window.location.replace(btJoinPath(pathname)); };
BT.masterContext = BT.masterContext || null;

function btAuthHeaders() {
  const token = localStorage.getItem('bt_token');
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function btMasterContextCacheKey(scope) {
  return `bt_master_context::v3::${String(scope || 'helpdesk').trim().toLowerCase()}`;
}

BT.loadHdContext = async function (options = {}) {
  const scope = String(options.scope || 'helpdesk').trim().toLowerCase() || 'helpdesk';
  const force = options.force === true;
  const cacheKey = btMasterContextCacheKey(scope);
  if (!force) {
    if (BT.masterContext && BT.masterContext.scope === scope) return BT.masterContext;
    if (window.__btMasterContextPromise && window.__btMasterContextScope === scope) return window.__btMasterContextPromise;
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
      if (cached && cached.scope === scope && cached.data) {
        BT.masterContext = cached.data;
        return cached.data;
      }
    } catch {}
  }
  const promise = fetch(BT.apiUrl(`/hd-context?scope=${encodeURIComponent(scope)}`), {
    headers: btAuthHeaders(),
    cache: 'no-store',
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'โหลด master context ไม่สำเร็จ');
      const context = data.data || {};
      BT.masterContext = context;
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ scope, data: context, savedAt: new Date().toISOString() }));
      } catch {}
      document.dispatchEvent(new CustomEvent('bt:master-context', { detail: context }));
      return context;
    })
    .finally(() => {
      if (window.__btMasterContextPromise && window.__btMasterContextScope === scope) {
        window.__btMasterContextPromise = null;
        window.__btMasterContextScope = '';
      }
    });
  window.__btMasterContextPromise = promise;
  window.__btMasterContextScope = scope;
  return promise;
};

function btRebaseStaticLinks(root = document) {
  root.querySelectorAll('[data-bt-url]').forEach((element) => {
    element.setAttribute('href', btJoinPath(element.getAttribute('data-bt-url') || '/'));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => btRebaseStaticLinks(), { once: true });
} else {
  btRebaseStaticLinks();
}

// Apply immediately so browsers do not restore previous scroll offset.
if (window.history && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

if (!window.__btFetchWrapped && typeof window.fetch === 'function') {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string') {
      if (input.startsWith('/')) input = btJoinPath(input);
    } else if (input instanceof Request) {
      const reqUrl = new URL(input.url);
      if (reqUrl.origin === window.location.origin && reqUrl.pathname.startsWith('/')) {
        const rebased = btJoinPath(reqUrl.pathname) + reqUrl.search;
        if (rebased !== reqUrl.pathname + reqUrl.search) {
          input = new Request(new URL(rebased, window.location.origin).toString(), input);
        }
      }
    }
    return nativeFetch(input, init);
  };
  window.__btFetchWrapped = true;
}

function btDefaultHomeByRole(role) {
  return BT.url('/home');
}
function btRequireAuth() {
  const p = btNormalizePath(window.location.pathname || '/');
  const publicPaths = new Set(['/', '/index.html', '/login', '/login/', '/login.html', '/login/index.html']);
  const token = localStorage.getItem('bt_token');

  if (!token && !publicPaths.has(p)) {
    window.location.replace(BT.url('/'));
    return false;
  }
  return true;
}

async function btVerifySession() {
  const token = localStorage.getItem('bt_token');
  if (!token) return false;
  try {
    const res = await fetch(BT.apiUrl('/auth/me'), {
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      BT.handleUnauthorized?.();
      return false;
    }
    return true;
  } catch {
    BT.handleUnauthorized?.();
    return false;
  }
}

function btStartSessionWatcher() {
  if (window.__btSessionWatcherStarted) return;
  window.__btSessionWatcherStarted = true;

  const ping = () => {
    if (!localStorage.getItem('bt_token')) return;
    btVerifySession();
  };

  ping();
  window.addEventListener('focus', ping);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ping();
  });
  window.setInterval(ping, 2000);
}

/* ── Icon helper (Bootstrap Icons via inline SVG-class) ────────────── */
function ic(name) {
  return `<i class="bi bi-${name}" style="font-size:0.95rem;line-height:1"></i>`;
}
function btEsc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function btNormalizeAccessKeys(value) {
  if (Array.isArray(value)) return Array.from(new Set(value.map(v => String(v || '').trim()).filter(Boolean)));
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return btNormalizeAccessKeys(parsed);
    } catch {}
  }
  return Array.from(new Set(raw.split(',').map(v => String(v || '').trim()).filter(Boolean)));
}
function btRoleDefaultAccess(role) {
  const visibleKeys = ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications', 'admin_console'];
  const defaults = {
    ceo: visibleKeys.slice(),
    admin: visibleKeys.slice(),
    manager: ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
    staff: ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
    visitor: ['user'],
    hr: ['user', 'it_support', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
    it_support: ['user', 'it_support', 'ai', 'knowledge_center', 'helpdeck_knowledge', 'notifications'],
  };
  return defaults[String(role || 'staff').trim().toLowerCase()] || defaults.staff;
}
function btEffectiveAccessKeys(user) {
  const role = String(user?.role || localStorage.getItem('bt_role') || 'staff').trim().toLowerCase();
  if (role === 'ceo') return btRoleDefaultAccess('ceo');
  const accessMode = String(user?.access_mode || 'role').trim().toLowerCase();
  const custom = btNormalizeAccessKeys(user?.access_keys || user?.access_json || []);
  if (accessMode === 'custom') {
    const locked = role === 'admin' ? ['admin_console'] : [];
    return Array.from(new Set([...custom, ...locked]));
  }
  return btRoleDefaultAccess(role);
}
function btUserHasAccessKey(key, user = null) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return true;
  const keys = btEffectiveAccessKeys(user || JSON.parse(localStorage.getItem('bt_user') || '{}'));
  return keys.includes(normalizedKey);
}
function btSidebarItemAllowed(item, role, effectiveAccess, isAdmin) {
  if (item?.strictRoles) return Array.isArray(item.roles) && item.roles.includes(role);
  if (role === 'visitor') return true;
  if (isAdmin) return true;
  const itemKey = String(item?.accessKey || '').trim();
  if (itemKey) return effectiveAccess.includes(itemKey);
  if (role === 'it_support') return item.roles && item.roles.includes('it_support');
  return !item.roles || item.roles.includes(role);
}
function btPageAccessKey(activePage) {
  const page = String(activePage || '').split('?')[0].split('/').pop() || '';
  const pageMap = {
    'home.html': 'user',
    'check-in-out.html': 'user',
    'feedback.html': 'user',
    'help-desk.html': 'user',
    'setup.html': 'user',
    'staff-dashboard.html': 'ceo_dashboard',
    'pm-dashboard.html': 'project_management',
    'projects.html': 'project_management',
    'project-co': 'project_co',
    'project-co.html': 'project_co',
    'team-tasks.html': 'project_co',
    'ot-claims.html': 'project_co',
    'invoices.html': 'project_co',
    'budget.html': 'project_co',
    'billing-alerts.html': 'project_co',
    'financial-reports.html': 'project_co',
    'docs-dashboard.html': 'project_co',
    'ocr-lab.html': 'project_co',
    'smart-drafting.html': 'project_co',
    'contract-check.html': 'project_co',
    'compliance.html': 'project_co',
    'it-dashboard.html': 'it_support',
    'role-helpdesk.html': 'user',
    'help-desk-v3.html': 'user',
    'ticket-kanban.html': 'it_support',
    'ai-setting': 'ai',
    'faq.html': 'faq',
    'secretary-dashboard.html': 'smart_secretary',
    'calendar.html': 'smart_secretary',
    'resource-booking.html': 'smart_secretary',
    'room-booking.html': 'smart_secretary',
    'vehicle-booking.html': 'smart_secretary',
    'food-planning.html': 'smart_secretary',
    'reschedule.html': 'smart_secretary',
    'finance-dashboard.html': 'finance',
    'knowledge-dashboard.html': 'knowledge_center',
    'knowledge.html': 'knowledge_center',
    'helpdeck.html': 'knowledge_center',
    'lesson-learned.html': 'knowledge_center',
    'knowledge-rag-search.html': 'knowledge_center',
    'rag-search.html': 'knowledge_center',
    'knowledge-add': 'knowledge_center',
    'knowledge-add.html': 'knowledge_center',
    'hr-dashboard.html': 'hr_module',
    'hr.html': 'hr_module',
    'skills.html': 'hr_module',
    'certificates.html': 'hr_module',
    'workload.html': 'hr_module',
    'notifications.html': 'notifications',
    'company-announcements.html': 'notifications',
    'line-group.html': 'notifications',
    'task-line-group.html': 'notifications',
    'admin.html': 'admin_console',
  };
  return pageMap[page] || '';
}
function btFirstAccessibleHref() {
  const role = String(localStorage.getItem('bt_role') || 'staff').toLowerCase();
  const user = JSON.parse(localStorage.getItem('bt_user') || '{}');
  const effectiveAccess = btEffectiveAccessKeys(user);
  const isAdmin = role === 'admin' || role === 'ceo';
  for (const section of SIDEBAR_SECTIONS) {
    if (section.topLink || !section.key) continue;
    const sectionAllowed = effectiveAccess.includes(section.key) || (section.items || []).some(item => item.accessKey && effectiveAccess.includes(item.accessKey));
    if (!sectionAllowed && !isAdmin) continue;
    const visibleItems = (section.items || []).filter(item => btSidebarItemAllowed(item, role, effectiveAccess, isAdmin));
    if (visibleItems.length) return btJoinPath(visibleItems[0].href);
  }
  return BT.url('/no-access.html');
}

/* ── Sidebar definition ────────────────────────────────────────────── */
const VISIBLE_SIDEBAR_SECTION_KEYS = ['user', 'it_support', 'ai', 'knowledge_center', 'notifications', 'admin_console'];
const SIDEBAR_SECTIONS = [
  {
    label: 'Login / SSO',
    link: BT.url('/index.html'),
    items: null,
    topLink: true,
  },
  {
    key: 'ceo_dashboard',
    label: 'CEO Dashboard',
    flat: true,
    items: [
      { label: 'Staff Dashboard',   icon: ic('display'),        href: '/staff-dashboard.html',   roles: ['ceo', 'manager', 'staff'] },
      { label: 'LINE Group',        icon: ic('people-fill'),    href: '/line-group.html',        roles: ['ceo', 'admin'] },
      { label: 'CEO Bot Setting',   icon: ic('robot'),          href: '/ceo-bot-setting.html',   roles: ['ceo', 'admin'] },
    ],
  },
  {
    key: 'user',
    label: 'User',
    items: [
      { label: 'หน้าหลัก',         icon: ic('house-door'),       href: '/home.html',         roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'Check in - out', icon: ic('clock-history'),   href: '/check-in-out.html', roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'ข้อเสนอแนะ',       icon: ic('chat-square-text'), href: '/feedback.html',     roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'Chat',           icon: ic('headset'),        href: '/help-desk.html',    roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'ถอดเสียง เอกสาร', icon: ic('mic'),          href: 'https://aidlc-bt.demotoday.net/tool/login?next=%2Ftool%2F', target: '_blank', roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'Set Up',          icon: ic('sliders2'),         href: '/setup.html',        roles: ['ceo','admin','manager','staff','it_support','hr'] },
    ],
  },
  {
    key: 'project_management',
    label: 'Project Management / เลขา',
    items: [
      { label: 'PM Dashboard',   icon: ic('kanban'),      href: '/pm-dashboard.html',  roles: ['ceo','admin','manager','staff'] },
      { label: 'Project Master', icon: ic('folder'),      href: '/projects.html',      roles: ['ceo','admin','manager','staff'] },
    ],
  },
  {
    key: 'project_co',
    label: 'Project CO.',
    items: [
      { label: 'Project CO. Dashboard', icon: ic('building'),          href: '/project-co/dashboard', roles: ['ceo','admin','manager','staff'] },
      { label: 'Meeting MOM',           icon: ic('mic'),               href: '/project-co/meeting-mom',    roles: ['ceo','admin','manager','staff'] },
      { label: 'Tracking TOR',          icon: ic('check2-square'),     href: '/my-tasks',                  roles: ['ceo','admin','manager','staff'] },
      { label: 'Team Tasks',            icon: ic('people'),            href: '/team-tasks.html',           roles: ['ceo','admin','manager','staff'] },
      { label: 'OT Claims',             icon: ic('clock'),             href: '/ot-claims.html',            roles: ['ceo','admin','manager','staff'] },
      { label: 'Invoice Tracking',      icon: ic('receipt'),           href: '/invoices.html',             roles: ['ceo','admin','manager','staff'] },
      { label: 'Budget Control',        icon: ic('briefcase'),         href: '/budget.html',               roles: ['ceo','admin','manager','staff'] },
      { label: 'Billing Alerts',        icon: ic('bell'),              href: '/billing-alerts.html',       roles: ['ceo','admin','manager','staff'] },
      { label: 'Financial Reports',     icon: ic('file-text'),         href: '/financial-reports.html',    roles: ['ceo','admin','manager','staff'] },
      { label: 'Docs Dashboard',        icon: ic('layers'),            href: '/docs-dashboard.html',       roles: ['ceo','admin','manager','staff'] },
      { label: 'OCR Lab',               icon: ic('camera'),            href: '/ocr-lab.html',              roles: ['ceo','admin','manager','staff'] },
      { label: 'Smart Drafting',        icon: ic('pencil-square'),     href: '/smart-drafting.html',       roles: ['ceo','admin','manager','staff'] },
      { label: 'Contract Check',        icon: ic('file-earmark-text'), href: '/contract-check.html',       roles: ['ceo','admin','manager','staff'] },
      { label: 'Compliance Score',      icon: ic('shield-check'),      href: '/compliance.html',           roles: ['ceo','admin','manager','staff'] },
    ],
  },
  {
    key: 'it_support',
    label: 'IT Support',
    items: [
      { label: 'IT Dashboard',  icon: ic('display'),   href: '/it-dashboard.html',                 roles: ['ceo','admin','manager','it_support'] },
      { label: 'Helpdeck Role', icon: ic('person-gear'), href: '/role-helpdesk.html',               roles: ['admin','super_admin','superadmin'], strictRoles: true },
      { label: 'รับแจ้งเรื่อง', icon: ic('chat-dots'), href: '/help-desk-v3.html',                 roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'Ticket Kanban', icon: ic('kanban'),    href: '/ticket-kanban.html',                  roles: ['ceo','admin','manager','staff','it_support','hr'] },
    ],
  },
  {
    key: 'ai',
    label: 'AI',
    items: [
      { label: 'AI Setting', icon: ic('sliders2'), href: '/ai-setting', roles: ['ceo','admin','manager','staff','it_support'] },
    ],
  },
  {
    key: 'faq',
    label: 'FAQ',
    items: [
      { label: 'FAQ ทั้งหมด', icon: ic('question-circle'), href: '/faq.html', roles: ['ceo','admin','manager','staff','it_support','hr'] },
    ],
  },
  {
    key: 'smart_secretary',
    label: 'Smart Secretary',
    items: [
      { label: 'Secretary Dashboard', icon: ic('robot'),           href: '/secretary-dashboard.html', roles: ['ceo','admin','manager','staff'] },
      { label: 'Calendar',            icon: ic('calendar3'),       href: '/calendar.html',            roles: ['ceo','admin','manager','staff'] },
      { label: 'Resource Booking',    icon: ic('building'),        href: '/resource-booking.html',    roles: ['ceo','admin','manager','staff'] },
      { label: 'Room Booking',        icon: ic('door-open'),       href: '/room-booking.html',        roles: ['ceo','admin','manager','staff'] },
      { label: 'Vehicle Booking',     icon: ic('car-front'),       href: '/vehicle-booking.html',     roles: ['ceo','admin','manager','staff'] },
      { label: 'Food Planning',       icon: ic('basket2'),         href: '/food-planning.html',       roles: ['ceo','admin','manager','staff'] },
      { label: 'Auto Reschedule',     icon: ic('arrow-repeat'),    href: '/reschedule.html',          roles: ['ceo','admin','manager','staff'] },
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    items: [
      { label: 'Finance Dashboard', icon: ic('bar-chart-line'), href: '/finance-dashboard.html', roles: ['ceo','admin','manager','staff'] },
    ],
  },
  {
    key: 'knowledge_center',
    label: 'Knowledge Center',
    items: [
      { label: 'Knowledge Dashboard', icon: ic('book'),             href: '/knowledge-dashboard.html', roles: ['ceo','admin','manager','staff','it_support'] },
      { label: 'AI Knowledge Base',   icon: ic('cpu'),              href: '/knowledge.html',           roles: ['ceo','admin','manager','staff','it_support'] },
      { label: 'Helpdeck Knowledge',  icon: ic('journal-richtext'), href: '/helpdeck.html',            accessKey: 'helpdeck_knowledge', roles: ['ceo','admin','manager','it_support'] },
      { label: 'เพิ่มข้อมูล',          icon: ic('plus-circle'),      href: '/knowledge-add?tab=project', roles: ['ceo','admin','manager','staff','it_support'] },
      { label: 'Lesson Learned',      icon: ic('lightbulb'),        href: '/lesson-learned.html',      roles: ['ceo','admin','manager','staff'] },
      { label: 'RAG Search',          icon: ic('search'),           href: '/knowledge-rag-search',     roles: ['ceo','admin','manager','staff'] },
    ],
  },
  {
    key: 'hr_module',
    label: 'HR Module',
    items: [
      { label: 'HR Dashboard',       icon: ic('people'),       href: '/hr-dashboard.html', roles: ['ceo','admin','manager','staff'] },
      { label: 'Employee Profiles',  icon: ic('person'),       href: '/hr.html',           roles: ['ceo','admin','manager','staff'] },
      { label: 'Skills Matrix',      icon: ic('mortarboard'),  href: '/skills.html',       roles: ['ceo','admin','manager','staff'] },
      { label: 'Certificates',       icon: ic('award'),        href: '/certificates.html', roles: ['ceo','admin','manager','staff'] },
      { label: 'Workload View',      icon: ic('bar-chart'),    href: '/workload.html',     roles: ['ceo','admin','manager','staff'] },
    ],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    items: [
      { label: 'LINE Alerts',         icon: ic('phone'),                href: '/notifications.html',              roles: ['ceo','admin','manager','staff'] },
      { label: 'ประกาศบริษัท', icon: ic('megaphone'), href: '/company-announcements.html', roles: ['ceo','admin','manager','staff','it_support','hr'] },
      { label: 'LINE Group',          icon: ic('people-fill'),          href: '/line-group.html',                 roles: ['ceo','admin'] },
      { label: 'Task LINE Group',     icon: ic('check2-all'),           href: '/task-line-group.html',            roles: ['ceo','admin'] },
      { label: 'Teams Notifications', icon: ic('chat'),                 href: '/notifications.html?tab=teams',   roles: ['ceo','admin','manager','staff'] },
      { label: 'Email Alerts',        icon: ic('envelope'),             href: '/notifications.html?tab=email',   roles: ['ceo','admin','manager','staff'] },
      { label: 'Escalations',         icon: ic('exclamation-triangle'), href: '/notifications.html?tab=escalation', roles: ['ceo','admin','manager'] },
    ],
  },
  {
    key: 'admin_console',
    label: 'Admin Console',
    subLabel: 'User',
    items: [
      { label: 'Admin Console', icon: ic('gear-fill'), href: '/admin.html', roles: ['ceo','admin'] },
    ],
  },
];
BT.ACCESS_SECTIONS = SIDEBAR_SECTIONS.filter((section) => section.key && VISIBLE_SIDEBAR_SECTION_KEYS.includes(section.key)).map((section) => ({
  key: section.key,
  label: section.label,
}));
BT.getDefaultAccessKeys = btRoleDefaultAccess;
BT.getEffectiveAccessKeys = btEffectiveAccessKeys;
BT.canAccessKey = btUserHasAccessKey;
BT.getPageAccessKey = btPageAccessKey;
BT.getFirstAccessibleHref = btFirstAccessibleHref;

/* ── Build sidebar HTML ─────────────────────────────────────────────── */
function buildSidebar(activePage) {
  const cur = btNormalizePath(activePage || window.location.pathname || '/').split('?')[0].split('/').pop() || 'index.html';
  const role = localStorage.getItem('bt_role') || 'staff';
  const isAdmin = role === 'admin' || role === 'ceo';
  const user = JSON.parse(localStorage.getItem('bt_user') || '{}');
  const effectiveAccess = btEffectiveAccessKeys(user);

  // role display map
  const roleLabel = {
    'ceo':        'ผู้บริหาร (CEO)',
    'admin':      'ผู้ดูแลระบบ',
    'manager':    'ผู้จัดการ',
    'hr':         'ฝ่าย HR',
    'staff':      'พนักงาน',
    'visitor':    'ผู้เยี่ยมชม',
    'it_support': 'IT Support',
  };

  // Load collapsed state from localStorage (admin only)
  const collapsedKey = 'bt_sidebar_collapsed';
  const collapsed = isAdmin
    ? JSON.parse(localStorage.getItem(collapsedKey) || '{}')
    : {};

  function fileMatch(href, page) {
    return btNormalizePath(href).split('?')[0].split('/').pop() === btNormalizePath(page).split('?')[0].split('/').pop();
  }

  function sectionHasActive(items) {
    return items.some(item => fileMatch(item.href, cur));
  }

  const userName = user.full_name || 'ผู้ใช้งาน';
  const userRole = roleLabel[role] || role;
  const initials = userName.trim().split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() || 'BT';
  const roleSubtitle = `Role: ${userRole}`;

function renderSidebarItem(item, itemClass, isActive, showRoleSubtitle) {
  const subtitle = showRoleSubtitle
    ? `<span class="bt-sidebar-item-subtext">${roleSubtitle}</span>`
    : '';
  const currentAttr = isActive ? ' aria-current="page"' : '';
  const targetAttr = item.target ? ` target="${btEsc(item.target)}"` : '';
  const relAttr = item.target === '_blank' ? ' rel="noopener noreferrer"' : '';
  return `<a href="${btEsc(btJoinPath(item.href))}" class="bt-sidebar-item ${itemClass} ${isActive}"${currentAttr}${targetAttr}${relAttr}>
      <span class="bt-si-icon">${item.icon}</span>
      <span class="bt-sidebar-item-content">
        <span class="bt-sidebar-item-title">${item.label}</span>
        ${subtitle}
      </span>
    </a>`;
  }

  let html = `
    <nav class="bt-sidebar" id="btSidebar" aria-label="หลักเมนูนำทาง">
      <div class="bt-sidebar-profile">
        <button type="button" class="bt-sidebar-close" aria-label="ปิดแถบเมนู" onclick="BT.closeSidebar()">✕</button>
        <div class="bt-profile-avatar">${initials}</div>
        <div class="bt-profile-name">${userName}</div>
        <div class="bt-profile-role">${userRole}</div>
      </div>
      <div class="bt-sidebar-nav">`;

  SIDEBAR_SECTIONS.forEach((section, sIdx) => {
    if (section.topLink) return;
    if (role === 'visitor' && section.key !== 'user') return;
    if (section.key && !VISIBLE_SIDEBAR_SECTION_KEYS.includes(section.key)) return;
    const sectionAllowed = effectiveAccess.includes(section.key) || (section.items || []).some(item => item.accessKey && effectiveAccess.includes(item.accessKey));
    if (section.key && !sectionAllowed && !isAdmin) return;
    const visibleItems = (section.items || []).filter(item => btSidebarItemAllowed(item, role, effectiveAccess, isAdmin));
    if (visibleItems.length === 0) return;

    const sectionKey = 'sec_' + sIdx;
    const hasActive = sectionHasActive(visibleItems);

    // Determine collapsed state:
    // - admin: use saved state; default open if section has active page
    // - non-admin: always open
    const isCollapsed = isAdmin
      ? (sectionKey in collapsed ? collapsed[sectionKey] : false)
      : false;

    html += `<div class="bt-sidebar-section">`;

    // ── Flat section ─────────────────────────────────────────────────
    if (section.flat) {
      html += `<div class="bt-sidebar-label">${section.label}</div>`;
      visibleItems.forEach(item => {
        const isActive = fileMatch(item.href, cur) ? 'active' : '';
        const showRoleSubtitle = /dashboard/i.test(item.label);
        html += renderSidebarItem(item, 'bt-sidebar-main-item', isActive, showRoleSubtitle);
      });
      html += `</div>`;
      return;
    }

    // ── Normal section ───────────────────────────────────────────────
    if (isAdmin) {
      // Admin: collapsible header
      html += `
        <button class="bt-sidebar-section-toggle ${isCollapsed ? '' : 'open'}"
                onclick="BT.toggleSection('${sectionKey}', this)"
                aria-expanded="${!isCollapsed}">
          <span class="bt-sidebar-label-text">${section.label}</span>
          <svg class="bt-chevron" viewBox="0 0 20 20" fill="currentColor" width="13" height="13">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
          </svg>
        </button>
        <div class="bt-sidebar-dropdown ${isCollapsed ? '' : 'open'}" id="${sectionKey}">`;
    } else {
      // Non-admin: plain label, always open
      html += `<div class="bt-sidebar-label">${section.label}</div>`;
    }

    if (section.subLabel) {
      html += `<div class="bt-sidebar-label">${section.subLabel}</div>`;
    }

    visibleItems.forEach(item => {
      const isActive = fileMatch(item.href, cur) ? 'active' : '';
      const showRoleSubtitle = /dashboard/i.test(item.label);
      html += renderSidebarItem(item, 'bt-sidebar-sub-item', isActive, showRoleSubtitle);
    });

    if (isAdmin) {
      html += `</div>`; // close bt-sidebar-dropdown
    }

    html += `</div>`; // close bt-sidebar-section
  });

  html += `
      </div>
    </nav>
  <div class="bt-sidebar-overlay" id="btOverlay" onclick="BT.sidebarToggle()"></div>`;
  return html;
}

/* ── Build appbar HTML ──────────────────────────────────────────────── */
function buildAppbar(pageTitle) {
  const user = JSON.parse(localStorage.getItem('bt_user') || '{}');
  const userName = user.full_name || 'Guest';
  const savedAnnouncements = JSON.parse(localStorage.getItem('bt_company_announcements') || 'null');
  const announcements = Array.isArray(savedAnnouncements) ? savedAnnouncements : [];
  const unreadCount = announcements.filter(a => a.unread).length;
  const tone = { info: 'blue', warning: 'orange', ok: 'green' };
  const listHtml = announcements.slice(0, 5).map(a => `
    <a href="${BT.url('/company-announcements.html')}" class="bt-annc-item ${a.unread ? 'unread' : ''}">
      <span class="bt-annc-dot ${tone[a.level] || 'blue'}"></span>
      <span class="bt-annc-texts">
        <strong>${btEsc(a.title || '-')}</strong>
        <small>${btEsc(a.time || '-')}</small>
      </span>
    </a>
  `).join('');

  return `
    <header class="bt-appbar" id="btAppbar">
      <button type="button" class="bt-hamburger" id="btHamburger" aria-label="เปิดเมนู" aria-controls="btSidebar" aria-expanded="false" onclick="BT.sidebarToggle()">&#9776;</button>
        <a href="${BT.url('/index.html')}" class="bt-appbar-brand">
          <img src="/assets/betime_solution/img/betimes-logo.png" alt="BeTiMES Solutions" class="bt-brand-logo">
      </a>
      <div class="bt-appbar-spacer" aria-hidden="true"></div>
      <div class="bt-appbar-actions">
        <div class="bt-annc-wrap" id="btAnncWrap">
          <button type="button" class="bt-annc-btn" id="btAnncBtn" aria-label="การแจ้งเตือนบริษัท" aria-controls="btAnncDropdown" aria-expanded="false" aria-haspopup="menu" onclick="BT.toggleAnnouncements(event)">
            <i class="bi bi-megaphone"></i>
            <span>ประกาศบริษัท</span>
            ${unreadCount ? `<b>${unreadCount}</b>` : ''}
          </button>
          <div class="bt-annc-dropdown" id="btAnncDropdown" onclick="event.stopPropagation()">
            <div class="bt-annc-head">
              <strong>ประกาศล่าสุด</strong>
              <a href="${BT.url('/company-announcements.html')}">ดูทั้งหมด</a>
            </div>
            <div class="bt-annc-list">${listHtml || '<div class="bt-annc-empty">ไม่มีประกาศ</div>'}</div>
          </div>
        </div>
        <button type="button" class="bt-user-chip" style="cursor:pointer;background:#FFEDD5;color:#C2410C;border:none;font-family:inherit;font-size:0.78rem;padding:0 14px;height:34px;border-radius:999px;font-weight:600" onclick="BT.logout()"><i class="bi bi-box-arrow-right" style="margin-right:5px"></i>ออกจากระบบ</button>
      </div>
    </header>`;
}

/* ── Inject into DOM ────────────────────────────────────────────────── */
BT.initApp = function (activePage, pageTitle) {
  const init = () => {
    if (!btRequireAuth()) return;
    const user = JSON.parse(localStorage.getItem('bt_user') || '{}');
    const pageAccessKey = btPageAccessKey(activePage);
    if (pageAccessKey && !btUserHasAccessKey(pageAccessKey, user)) {
      console.warn(`[BT] Page access key "${pageAccessKey}" is not enabled for this user; rendering page without redirect.`);
      BT.notify?.('หน้านี้ไม่ได้อยู่ในเมนูสิทธิ์ของผู้ใช้ แต่ระบบจะไม่เด้งออกจากหน้าที่เปิดอยู่', 'warning');
    }

    if (pageTitle) {
      document.title = `${pageTitle} — Betime Solution`;
    }

    // Keep navigation predictable: open each page at the top.
    window.scrollTo(0, 0);

    // Inject Bootstrap Icons CSS (minimal stroke icons)
    if (!document.getElementById('bt-bi-css')) {
      const link = document.createElement('link');
      link.id   = 'bt-bi-css';
      link.rel  = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css';
      document.head.appendChild(link);
    }

    // Inject appbar
    const appbarHolder = document.getElementById('bt-appbar-holder');
    if (appbarHolder) appbarHolder.innerHTML = buildAppbar(pageTitle);
    BT.refreshAnnouncements?.();

    // Inject layout wrapper with sidebar
    const layoutHolder = document.getElementById('bt-layout-holder');
    if (layoutHolder) {
      const sidebar = buildSidebar(activePage);
      layoutHolder.insertAdjacentHTML('afterbegin', sidebar);
    }

    // highlight active
    _highlightActive();
    BT.closeSidebar();
    BT.closeAnnouncements();

    // Slide-in keyframe
    if (!document.querySelector('#btSlideStyle')) {
      const s = document.createElement('style');
      s.id = 'btSlideStyle';
      s.textContent = `@keyframes btSlideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}`;
      document.head.appendChild(s);
    }

    if (!window.__btAnncBound) {
      document.addEventListener('click', (ev) => {
        const wrap = document.getElementById('btAnncWrap');
        if (!wrap) return;
        if (!wrap.contains(ev.target)) BT.closeAnnouncements();
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          BT.closeAnnouncements();
          BT.closeSidebar();
        }
      });
      window.__btAnncBound = true;
    }
  };

  const boot = async () => {
    if (!btRequireAuth()) return;
    if (!(await btVerifySession().catch(() => false))) return;
    init();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void boot(); });
  } else {
    void boot();
  }
  BT.startSessionWatcher?.();

  // Safari/Firefox can restore scroll on pageshow (bfcache). Force reset again.
  window.addEventListener('pageshow', () => {
    window.scrollTo(0, 0);
  });
  window.addEventListener('load', () => {
    window.scrollTo(0, 0);
  });
};

function _highlightActive() {
  const cur = btNormalizePath(window.location.pathname || '/').split('?')[0].split('/').pop() || 'index.html';
  document.querySelectorAll('.bt-sidebar-item').forEach(a => {
    const href = (a.getAttribute('href') || '').split('?')[0];
    const hrefFile = (a.getAttribute('href') || '').split('?')[0].split('/').pop();
    if (hrefFile && hrefFile === cur) a.classList.add('active');
  });
}

/* ── Sidebar toggle ─────────────────────────────────────────────────── */
BT.sidebarToggle = function () {
  const sb = document.getElementById('btSidebar');
  const ov = document.getElementById('btOverlay');
  const hb = document.getElementById('btHamburger');
  const next = !(sb && sb.classList.contains('open'));
  if (sb) sb.classList.toggle('open', next);
  if (ov) {
    ov.classList.toggle('open', next);
    ov.setAttribute('aria-hidden', String(!next));
  }
  if (hb) hb.setAttribute('aria-expanded', String(next));
  document.body.classList.toggle('bt-sidebar-open', next);
};

BT.closeSidebar = function () {
  const sb = document.getElementById('btSidebar');
  const ov = document.getElementById('btOverlay');
  const hb = document.getElementById('btHamburger');
  if (sb) sb.classList.remove('open');
  if (ov) {
    ov.classList.remove('open');
    ov.setAttribute('aria-hidden', 'true');
  }
  if (hb) hb.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('bt-sidebar-open');
};

/* ── Company announcements ─────────────────────────────────── */
BT.toggleAnnouncements = function (ev) {
  if (ev) ev.stopPropagation();
  const dd = document.getElementById('btAnncDropdown');
  if (!dd) return;
  const open = dd.classList.toggle('open');
  const btn = document.getElementById('btAnncBtn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
};

BT.closeAnnouncements = function () {
  const dd = document.getElementById('btAnncDropdown');
  if (dd) dd.classList.remove('open');
  const btn = document.getElementById('btAnncBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
};

BT.refreshAnnouncements = async function () {
  const list = document.querySelector('#btAnncDropdown .bt-annc-list');
  const btn = document.getElementById('btAnncBtn');
  if (!list || !btn) return;
  const user = JSON.parse(localStorage.getItem('bt_user') || '{}');
  const actorId = String(user.email || user.name || user.full_name || 'guest').toLowerCase();
  const readKey = `bt_company_announcements_read::${actorId}`;
  const readIds = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(readKey) || '[]').map(String)); } catch { return new Set(); }
  })();

  const render = (items = []) => {
    const tone = { info: 'blue', warning: 'orange', ok: 'green' };
    const unreadCount = items.filter(a => a.unread).length;
    const badge = btn.querySelector('b');
    if (badge) badge.remove();
    if (unreadCount) btn.insertAdjacentHTML('beforeend', `<b>${unreadCount}</b>`);
    list.innerHTML = items.slice(0, 5).map(a => `
      <a href="${BT.url('/company-announcements.html')}" class="bt-annc-item ${a.unread ? 'unread' : ''}">
        <span class="bt-annc-dot ${tone[a.level] || 'blue'}"></span>
        <span class="bt-annc-texts">
          <strong>${btEsc(a.title || '-')}</strong>
          <small>${btEsc(a.time || '-')}</small>
        </span>
      </a>
    `).join('') || '<div class="bt-annc-empty">ไม่มีประกาศ</div>';
  };

  try {
    const token = localStorage.getItem('bt_token') || '';
    const res = await fetch(BT.apiUrl('/announcements'), {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'load failed');
    const items = (Array.isArray(data.data) ? data.data : []).map(a => {
      const author = a.author_name || a.created_by || 'BETIME Team';
      const time = a.created_at ? new Date(a.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-';
      return {
        id: a.id || '',
        title: a.title || '-',
        time,
        level: a.is_pinned ? 'warning' : 'info',
        unread: Boolean(a.is_pinned) && !readIds.has(String(a.id || '')),
        author,
      };
    });
    localStorage.setItem('bt_company_announcements', JSON.stringify(items.slice(0, 12)));
    render(items);
  } catch {
    try {
      const cached = JSON.parse(localStorage.getItem('bt_company_announcements') || '[]');
      render(Array.isArray(cached) ? cached : []);
    } catch {
      render([]);
    }
  }
};

/* ── Section dropdown toggle ────────────────────────────────────────── */
BT.toggleSection = function (sectionKey, btn) {
  const drop = document.getElementById(sectionKey);
  if (!drop) return;
  const open = drop.classList.toggle('open');
  if (btn) {
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open);
  }

  // Save collapsed state to localStorage (admin only)
  const collapsedKey = 'bt_sidebar_collapsed';
  try {
    const collapsed = JSON.parse(localStorage.getItem(collapsedKey) || '{}');
    collapsed[sectionKey] = !open; // true = collapsed
    localStorage.setItem(collapsedKey, JSON.stringify(collapsed));
  } catch (e) {}
};

/* ── Logout ─────────────────────────────────────────────────────────── */
BT.logout = function () {
  const token = localStorage.getItem('bt_token');
  if (token) fetch(BT.apiUrl('/auth/logout'), { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
  BT.clearSession();
  window.location.href = BT.url('/');
};

BT.clearSession = function () {
  localStorage.removeItem('bt_token');
  localStorage.removeItem('bt_role');
  localStorage.removeItem('bt_user');
};

BT.clearHelpdeskStorage = function () {
  const removed = [];
  const keep = new Set(['bt_token', 'bt_role', 'bt_user', 'bt_api_base']);
  const prefixes = [
    'bt_helpdesk',
    'bt_helpdesk_v2',
    'bt_helpdesk_v3',
  ];
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (!key || keep.has(key)) continue;
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      removed.push(key);
      localStorage.removeItem(key);
    }
  }
  try {
    localStorage.removeItem('bt_sidebar_collapsed');
  } catch {}
  return removed;
};

BT.handleUnauthorized = function () {
  BT.clearSession();
  window.location.replace(BT.url('/'));
};
BT.verifySession = btVerifySession;
BT.startSessionWatcher = btStartSessionWatcher;

/* ── Backend URL prompt ─────────────────────────────────────────────── */
BT.promptBackend = function () {
  const url = prompt('ใส่ URL ของ Frappe backend:\nเช่น https://erp.yourdomain.com', BT.getApiBaseUrl());
  if (url !== null) {
    localStorage.setItem('bt_api_base', url.trim());
    window.BETIME_CONFIG = { apiBaseUrl: url.trim() };
    location.reload();
  }
};

/* ── Override getApiBaseUrl to check localStorage too ──────────────── */
