/* ===================================================================
   Betime Solution — Main JS Bundle
   Global utilities, realtime alerts, shared helpers
   =================================================================== */

'use strict';

window.BT = window.BT || {};
BT.config = window.BETIME_CONFIG || {};

function btResolveBasePath(pathname) {
  const raw = String(pathname || '/');
  for (const prefix of ['/web']) {
    if (raw === prefix || raw.startsWith(prefix + '/')) return prefix;
  }
  return '';
}

function btJoinPath(pathname) {
  const base = btResolveBasePath(window.location.pathname || '/');
  const raw = String(pathname || '/');
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith('mailto:') || raw.startsWith('tel:')) return raw;
  if (!base) return raw;
  if (raw === base || raw.startsWith(base + '/')) return raw;
  if (raw === '/') return `${base}/`;
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

function btApiUrl(pathname) {
  const raw = String(pathname || '');
  return btJoinPath('/api' + (raw.startsWith('/') ? raw : '/' + raw));
}

BT.basePath = btResolveBasePath(window.location.pathname || '/');
BT.url = btJoinPath;
BT.apiUrl = btApiUrl;

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

BT.getApiBaseUrl = function () {
    return localStorage.getItem('bt_api_base') || (window.BETIME_CONFIG || {}).apiBaseUrl || '';
};

BT.getToken = function () {
    return localStorage.getItem('bt_token') || '';
};

BT.hasBackend = function () {
    return true; // Always available via Pages Functions
};

BT.repairMojibake = function (value) {
    const input = String(value ?? '');
    if (!input) return input;
    if (!/[ÃÂâàï»¿�]/.test(input) && !/เน|เธ/.test(input)) return input;

    const score = (text) => {
        const thai = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
        const bad = (text.match(/[ÃÂâ�]/g) || []).length;
        const mark = (text.match(/(?:เน|เธ)/g) || []).length;
        return thai * 4 - bad * 3 - mark;
    };

    const decode = (encoding) => {
        try {
            const bytes = Uint8Array.from(input, (ch) => ch.charCodeAt(0) & 0xff);
            return new TextDecoder(encoding, { fatal: false }).decode(bytes);
        } catch {
            return input;
        }
    };

    const candidates = [input, decode('utf-8'), decode('windows-874')];
    let best = input;
    let bestScore = score(input);
    for (const candidate of candidates) {
        const candidateScore = score(candidate);
        if (candidateScore > bestScore && candidate && !candidate.includes('\uFFFD')) {
            best = candidate;
            bestScore = candidateScore;
        }
    }
    return best;
};

BT.repairThaiText = function (root = document) {
    if (!root) return;

    const repairAttrs = (el) => {
        if (!el || el.nodeType !== 1) return;
        for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'data-original-title', 'data-bs-title']) {
            if (!el.hasAttribute(attr)) continue;
            const current = el.getAttribute(attr);
            const fixed = BT.repairMojibake(current);
            if (fixed !== current) el.setAttribute(attr, fixed);
        }
    };

    const repairNode = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            const current = node.textContent || '';
            const fixed = BT.repairMojibake(current);
            if (fixed !== current) node.textContent = fixed;
            return;
        }
        if (node.nodeType !== 1) return;
        repairAttrs(node);
        if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && node.type !== 'password') {
            const current = node.value || '';
            const fixed = BT.repairMojibake(current);
            if (fixed !== current) node.value = fixed;
        }
        node.childNodes?.forEach(repairNode);
        node.querySelectorAll?.('*').forEach(repairAttrs);
    };

    if (root.title !== undefined) {
        const fixedTitle = BT.repairMojibake(root.title);
        if (fixedTitle !== root.title) root.title = fixedTitle;
    }

    repairNode(root.body || root);
};

// -----------------------------------------------------------------------
// Accessibility / safety normalizers
// -----------------------------------------------------------------------
BT.normalizeButtons = function () {
    const normalizeRoot = (root) => {
        root.querySelectorAll('button:not([type])').forEach((button) => {
            if (!button.closest('form')) {
                button.type = 'button';
            }
        });
    };

    normalizeRoot(document);

    if (!window.__btButtonObserver && typeof MutationObserver !== 'undefined' && document.body) {
        window.__btButtonObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node && node.nodeType === 1) {
                        normalizeRoot(node);
                    }
                });
            });
        });
        window.__btButtonObserver.observe(document.body, { childList: true, subtree: true });
    }
};

// -----------------------------------------------------------------------
// Realtime notification handler (called from hooks.py events)
// -----------------------------------------------------------------------
BT.initRealtimeAlerts = function () {
    if (typeof frappe === 'undefined') return;

    frappe.realtime.on('betime_alert', function (data) {
        BT.notify(BT.repairMojibake(data.message), 'info');
    });
    frappe.realtime.on('betime_billing_alert', function (data) {
        BT.notify('💳 ' + BT.repairMojibake(data.message), 'warning');
    });
    frappe.realtime.on('betime_calendar_reminder', function (data) {
        BT.notify('🗓 ' + BT.repairMojibake(data.message), 'info');
    });
    frappe.realtime.on('betime_ot_alert', function (data) {
        BT.notify('⏱ ' + BT.repairMojibake(data.message), 'info');
    });
};

// -----------------------------------------------------------------------
// Toast / Notification helper
// -----------------------------------------------------------------------
BT.notify = function (message, type = 'info') {
    message = BT.repairMojibake(message);
    type = type === 'warning' ? 'orange' : type === 'error' ? 'red' : 'blue';
    if (typeof frappe !== 'undefined') {
        frappe.show_alert({ message, indicator: type }, 7);
    } else {
        _btToast(message, type);
    }
};

function _btToast(msg, type) {
    const colors = { blue: '#1565C0', orange: '#E65100', red: '#C62828', green: '#2E7D32' };
    const el = document.createElement('div');
    el.style.cssText = `
        position:fixed; bottom:24px; right:24px; z-index:9999;
        background:${colors[type] || colors.blue}; color:#fff;
        padding:14px 20px; border-radius:10px;
        box-shadow:0 4px 16px rgba(0,0,0,0.2);
        font-family:'Sarabun',sans-serif; font-size:0.9rem;
        max-width:360px; animation:btSlideIn .3s ease;
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity='0'; setTimeout(() => el.remove(), 300); }, 5000);
}

// -----------------------------------------------------------------------
// API helper (wraps fetch with CSRF)
// -----------------------------------------------------------------------
BT.call = async function (path, args = {}, method = 'POST') {
    const token = BT.getToken();
    const res = await fetch(BT.apiUrl('/' + path.replace(/^\//, '')), {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
        },
        body: method !== 'GET' ? JSON.stringify(args) : undefined,
    });
    const text = await res.text();
    let json = {};
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(text.trim().startsWith('<')
            ? `API returned HTML instead of JSON (${res.status})`
            : (text || `Empty API response (${res.status})`));
    }
    if (!res.ok || json.error) throw new Error(json.error || res.statusText);
    return json;
};

BT.listDocs = function (doctype, fields, filters = {}, limit = 100) {
    return BT.call('frappe.client.get_list', {
        doctype,
        fields,
        filters,
        limit_page_length: limit,
    });
};

// -----------------------------------------------------------------------
// Progress bar helper
// -----------------------------------------------------------------------
BT.renderProgress = function (pct, el) {
    if (!el) return;
    const color = pct >= 100 ? 'success' : pct >= 70 ? '' : pct >= 40 ? 'warning' : 'danger';
    el.innerHTML = `
        <div class="bt-progress">
          <div class="bt-progress-bar ${color}" style="width:${pct}%"></div>
        </div>
        <small style="color:var(--bt-muted)">${pct}%</small>
    `;
};

// -----------------------------------------------------------------------
// Badge helper
// -----------------------------------------------------------------------
BT.badge = function (text, type = 'blue') {
    return `<span class="bt-badge bt-badge-${type}">${text}</span>`;
};

// -----------------------------------------------------------------------
// Status → badge color map
// -----------------------------------------------------------------------
BT.statusColor = {
    'Open':        'orange',
    'In Progress': 'blue',
    'Completed':   'green',
    'Cancelled':   'grey',
    'Blocked':     'red',
    'Active':      'green',
    'Planning':    'blue',
    'On Hold':     'orange',
    'Paid':        'green',
    'Overdue':     'red',
    'Submitted':   'orange',
    'Approved':    'green',
    'Rejected':    'red',
    'Draft':       'grey',
};

// -----------------------------------------------------------------------
// Relative date helper
// -----------------------------------------------------------------------
BT.relDate = function (dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr), now = new Date();
    const diff = Math.round((d - now) / 86400000);
    if (diff === 0) return 'วันนี้';
    if (diff === 1) return 'พรุ่งนี้';
    if (diff === -1) return 'เมื่อวาน';
    if (diff > 0) return `อีก ${diff} วัน`;
    return `${Math.abs(diff)} วันที่แล้ว`;
};

// -----------------------------------------------------------------------
// Confirm dialog helper
// -----------------------------------------------------------------------
BT.confirm = function (msg, onYes, yesLabel = 'ยืนยัน') {
    if (typeof frappe !== 'undefined') {
        frappe.confirm(msg, onYes);
    } else if (confirm(msg)) {
        onYes();
    }
};

// -----------------------------------------------------------------------
// Global frontend motion (all pages)
// -----------------------------------------------------------------------
BT.initPageAnimations = function () {
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const body = document.body;
    if (!body) return;

    if (prefersReduced) {
        body.classList.add('bt-anim-ready');
        return;
    }

    // Entry animation targets (rendered immediately on page load)
    const entrySelectors = [
        '.bt-page-header',
        '.bt-main-content > .bt-card',
        '.bt-kpi-grid .bt-card',
        '.tk-kpi-grid .bt-card',
        '.bt-dept-card',
        '.bt-chat-container',
        '.tk-toolbar',
        '.hd-chat-header',
        '.hd-input-bar'
    ].join(',');

    const entries = Array.from(document.querySelectorAll(entrySelectors));
    entries.forEach((el, i) => {
        if (el.classList.contains('bt-enter')) return;
        el.classList.add('bt-enter');
        el.style.setProperty('--bt-stagger', ((i % 10) * 55) + 'ms');
    });

    // Scroll reveal targets
    const revealSelectors = [
        '.bt-card',
        '.bt-dept-card',
        '.bt-table-wrap',
        '.tk-table-wrap',
        '.hd-chat-item',
        '.tk-table tbody tr'
    ].join(',');
    const reveals = Array.from(document.querySelectorAll(revealSelectors));

    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((items, observer) => {
            items.forEach((item) => {
                if (!item.isIntersecting) return;
                item.target.classList.add('bt-in');
                observer.unobserve(item.target);
            });
        }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });

        reveals.forEach((el, i) => {
            if (el.classList.contains('bt-reveal')) return;
            el.classList.add('bt-reveal');
            el.style.setProperty('--bt-reveal-delay', ((i % 8) * 35) + 'ms');
            io.observe(el);
        });
    }

    requestAnimationFrame(() => body.classList.add('bt-anim-ready'));
};

// -----------------------------------------------------------------------
// Init on DOMContentLoaded
// -----------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
    BT.normalizeButtons();
    BT.initRealtimeAlerts();
    BT.initPageAnimations();
    BT.repairThaiText(document);

    if (!window.__btThaiRepairObserver && typeof MutationObserver !== 'undefined' && document.body) {
        window.__btThaiRepairObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => BT.repairThaiText(node));
            });
        });
        window.__btThaiRepairObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Add slide-in animation
    const style = document.createElement('style');
    style.textContent = `@keyframes btSlideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}`;
    document.head.appendChild(style);
});
