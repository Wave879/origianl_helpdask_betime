/* ===================================================================
   Betime Solution — Main JS Bundle
   Global utilities, realtime alerts, shared helpers
   =================================================================== */

'use strict';

window.BT = window.BT || {};
BT.config = window.BETIME_CONFIG || {};

BT.getApiBaseUrl = function () {
    return ''; // API runs at /api/* via Pages Functions — no external URL needed
};

BT.getToken = function () {
    return localStorage.getItem('bt_token') || '';
};

BT.hasBackend = function () {
    return true; // Always available via Pages Functions
};

// -----------------------------------------------------------------------
// Realtime notification handler (called from hooks.py events)
// -----------------------------------------------------------------------
BT.initRealtimeAlerts = function () {
    if (typeof frappe === 'undefined') return;

    frappe.realtime.on('betime_alert', function (data) {
        BT.notify(data.message, 'info');
    });
    frappe.realtime.on('betime_billing_alert', function (data) {
        BT.notify('💳 ' + data.message, 'warning');
    });
    frappe.realtime.on('betime_calendar_reminder', function (data) {
        BT.notify('🗓 ' + data.message, 'info');
    });
    frappe.realtime.on('betime_ot_alert', function (data) {
        BT.notify('⏱ ' + data.message, 'info');
    });
};

// -----------------------------------------------------------------------
// Toast / Notification helper
// -----------------------------------------------------------------------
BT.notify = function (message, type = 'info') {
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
    const res = await fetch('/api/' + path.replace(/^\//, ''), {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
        },
        body: method !== 'GET' ? JSON.stringify(args) : undefined,
    });
    const json = await res.json();
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
    BT.initRealtimeAlerts();
    BT.initPageAnimations();

    // Add slide-in animation
    const style = document.createElement('style');
    style.textContent = `@keyframes btSlideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}`;
    document.head.appendChild(style);
});
