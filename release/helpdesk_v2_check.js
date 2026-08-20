
  BT.initApp('help-desk-v2.html', 'Chat V2');

  const repairBlockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
  let repairScheduled = false;

  function repairVisibleMojibake(root = document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || repairBlockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const fixed = repairMojibake(node.nodeValue);
      if (fixed !== node.nodeValue) node.nodeValue = fixed;
    }

    root.querySelectorAll('*').forEach((el) => {
      if (repairBlockedTags.has(el.tagName)) return;
      for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'data-label']) {
        if (!el.hasAttribute(attr)) continue;
        const current = el.getAttribute(attr);
        const fixed = repairMojibake(current);
        if (fixed !== current) el.setAttribute(attr, fixed);
      }
    });
  }

  function scheduleRepairVisibleMojibake() {
    if (repairScheduled) return;
    repairScheduled = true;
    queueMicrotask(() => {
      repairScheduled = false;
      repairVisibleMojibake(document.body);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    repairVisibleMojibake(document.body);
    const observer = new MutationObserver(() => scheduleRepairVisibleMojibake());
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    scheduleRepairVisibleMojibake();
  }, { once: true });

  const state = {
    projects: [],
    projectLookup: new Map(),
    projectContext: null,
    analysis: null,
    chatMessages: [],
    resultTab: 'analysis',
    flowStep: 'input',
    selectedDev: '',
    devDirectory: [],
    devDirectoryLoaded: false,
  };

  function esc(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function repairMojibake(value) {
    const text = String(value ?? '');
    if (!text) return text;

    const hasMojibakeShape = /\u0E40[\u0E18\u0E19]|\u0E42\u20AC|[\u0080-\u009F\uFFFD]/u.test(text);
    if (!hasMojibakeShape) return text;

    const score = (input) => {
      const thai = (input.match(/[\u0E00-\u0E7F]/gu) || []).length;
      const mojibake = (input.match(/\u0E40[\u0E18\u0E19]|\u0E42\u20AC|[\u0080-\u009F\uFFFD]/gu) || []).length;
      return thai * 2 - mojibake * 12;
    };

    try {
      const decoder874 = new TextDecoder('windows-874');
      const reverse874 = repairMojibake.reverse874 || (repairMojibake.reverse874 = (() => {
        const map = new Map();
        for (let byte = 0; byte <= 255; byte += 1) {
          map.set(decoder874.decode(Uint8Array.of(byte)), byte);
        }
        return map;
      })());

      const bytes = [];
      for (const ch of text) {
        if (reverse874.has(ch)) bytes.push(reverse874.get(ch));
        else if (ch.charCodeAt(0) <= 255) bytes.push(ch.charCodeAt(0));
        else return text;
      }
      const fixed = new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
      return score(fixed) > score(text) ? fixed : text;
    } catch {
      return text;
    }
  }

  function parseJsonSafe(value, fallback = {}) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function getToken() {
    return localStorage.getItem('bt_token') || '';
  }

  async function apiJson(url, options = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { ok: false, error: text }; }
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data.error || data.message || ('HTTP ' + res.status),
        ...data,
      };
    }
    return data;
  }

  function setLoading(button, loading, label) {
    if (!button) return;
    if (loading) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'กำลังประมวลผล...';
      button.disabled = true;
      return;
    }
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }

  function setResultTab(tab) {
    const nextTab = tab === 'chat' ? 'chat' : 'analysis';
    state.resultTab = nextTab;
    document.querySelectorAll('[data-result-tab]').forEach((button) => {
      const isActive = button.dataset.resultTab === nextTab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', String(isActive));
    });
    document.querySelectorAll('[data-result-pane]').forEach((pane) => {
      pane.classList.toggle('active', pane.dataset.resultPane === nextTab);
    });
    if (nextTab === 'chat' && state.analysis) {
      ensureChatStarter();
      renderChatLog();
      updateChatContextBadge();
    }
  }

  function setFlowStep(step) {
    const nextStep = ['input', 'analysis', 'chat', 'send', 'odoo'].includes(step) ? step : 'input';
    state.flowStep = nextStep;
    const steps = ['input', 'analysis', 'chat', 'send', 'odoo'];
    document.querySelectorAll('[data-flow-step]').forEach((node) => {
      const current = node.dataset.flowStep;
      const currentIndex = steps.indexOf(current);
      const nextIndex = steps.indexOf(nextStep);
      node.classList.toggle('active', current === nextStep);
      node.classList.toggle('done', currentIndex > -1 && currentIndex < nextIndex);
    });
  }

  function activateFlowView(step) {
    const nextStep = ['input', 'analysis', 'chat', 'send', 'odoo'].includes(step) ? step : 'input';
    setFlowStep(nextStep);

    if (nextStep === 'input') {
      document.getElementById('analysisSection').classList.remove('show');
      document.getElementById('chatSection').classList.remove('show');
      closeChatModal();
      closeDevModal();
      setResultTab('analysis');
      return;
    }

    document.getElementById('analysisSection').classList.add('show');

    if (nextStep === 'analysis') {
      setResultTab('analysis');
      closeChatModal();
      closeDevModal();
      return;
    }

    if (nextStep === 'chat') {
      setResultTab('chat');
      document.getElementById('chatSection').classList.add('show');
      ensureChatStarter();
      renderChatLog();
      closeDevModal();
      return;
    }

    if (nextStep === 'send' || nextStep === 'odoo') {
      setResultTab('analysis');
      document.getElementById('chatSection').classList.add('show');
      closeChatModal();
      if (nextStep === 'odoo') {
        BT.notify('\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E40\u0E23\u0E35\u0E22\u0E1A\u0E23\u0E49\u0E2D\u0E22', 'info');
      }
    }
  }

  function bindFlowStepper() {
    document.querySelectorAll('[data-flow-step]').forEach((node) => {
      if (node.dataset.flowBound === '1') return;
      node.dataset.flowBound = '1';
      node.style.cursor = 'pointer';
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.addEventListener('click', () => activateFlowView(node.dataset.flowStep));
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activateFlowView(node.dataset.flowStep);
        }
      });
    });
  }

  function normalizeProjects(rows) {
    return (rows || []).map((row) => {
      const extra = parseJsonSafe(row.extra || '{}', {});
      return {
        id: row.id,
        code: repairMojibake(row.code),
        name: repairMojibake(row.name),
        pm: repairMojibake(extra.project_pm || ''),
        description: repairMojibake(extra.project_description || ''),
        active: row.active !== false,
      };
    }).filter((item) => item.code);
  }

  function normalizeDevDirectory(rows) {
    return (rows || [])
      .map((row) => ({
        id: row.id,
        code: repairMojibake(String(row.code || '').trim()),
        name: repairMojibake(String(row.name || '').trim()),
        role: repairMojibake(String(row.role || row.position || '').trim() || String((parseJsonSafe(row.extra || '{}', {}) || {}).job_title || '').trim()),
        department: repairMojibake(String(row.department || '').trim() || String((parseJsonSafe(row.extra || '{}', {}) || {}).department || '').trim() || String((parseJsonSafe(row.extra || '{}', {}) || {}).department_name || '').trim()),
        active: row.active !== false,
      }))
      .filter((item) => item.name && item.active);
  }

  function findDevProfileByName(name) {
    return (state.devDirectory || []).find((item) => item.name === name) || null;
  }

  async function loadDevDirectory() {
    if (state.devDirectoryLoaded) return state.devDirectory;
    try {
      const data = await apiJson('/api/hd-master?table=hd_users');
      if (data.ok && Array.isArray(data.data)) {
        state.devDirectory = normalizeDevDirectory(data.data);
      } else {
        state.devDirectory = [];
      }
    } catch (error) {
      state.devDirectory = [];
    } finally {
      state.devDirectoryLoaded = true;
    }
    return state.devDirectory;
  }

  async function loadProjects() {
    // ลอง load จาก API ก่อน ?้าไม่มีข้อมูลใช้ mock data แทน
    let projects = [];
    try {
      const data = await apiJson('/api/hd-master?table=hd_projects');
      if (data.ok && data.data && data.data.length > 0) {
        projects = normalizeProjects(data.data);
      }
    } catch (e) { /* ไม่มี backend ใช้ mock แทน */ }

    if (projects.length === 0) {
      projects = [
        { id: 'mock_001', code: 'ERC', name: 'ระบบสาระสนเท? อิเล็กทรอนิกส์', pm: '', description: '', active: true },
        { id: 'mock_002', code: 'SRB', name: 'ระบบรับเรื่องร้องเรียน',          pm: '', description: '', active: true },
        { id: 'mock_003', code: 'BT',  name: 'Betime Internal',                 pm: '', description: '', active: true },
        { id: 'mock_004', code: 'CRM', name: 'CRM System',                      pm: '', description: '', active: true },
        { id: 'mock_005', code: 'HRM', name: 'HR Management',                   pm: '', description: '', active: true },
      ];
    }

    state.projects = projects.sort((a, b) => String(a.code).localeCompare(String(b.code)));
    state.projectLookup = new Map(state.projects.map((item) => [item.code, item]));
    const select = document.getElementById('projectSelect');
    select.innerHTML = '<option value="">Select project</option>' + state.projects.map((project) => (
      `<option value="${esc(project.code)}">${esc(project.code)} - ${esc(project.name)}</option>`
    )).join('');
  }

  function getIssueTerms(issueText) {
    return (String(issueText || '').toLowerCase().match(/[a-z0-9ก-๙_:-]{3,}/g) || []).slice(0, 12);
  }

  const AI_RULE_STORAGE_KEY = 'ai_setting_rules_v1';
  const DEFAULT_AI_RULES = [
    { id: 'human_error', label: 'Human error', keywords: ['\u0E01\u0E14\u0E1C\u0E34\u0E14', '\u0E25\u0E07\u0E1C\u0E34\u0E14', '\u0E04\u0E37\u0E19\u0E40\u0E25\u0E02', '\u0E25\u0E1A\u0E25\u0E33\u0E14\u0E31\u0E1A', '\u0E01\u0E23\u0E2D\u0E01\u0E1C\u0E34\u0E14', '\u0E1E\u0E34\u0E21\u0E1E\u0E4C\u0E1C\u0E34\u0E14'] },
    { id: 'system_error', label: 'system error', keywords: ['\u0E25\u0E48\u0E21', '\u0E04\u0E49\u0E32\u0E07', 'error', '\u0E1A\u0E31\u0E19\u0E17\u0E36\u0E01\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49', 'timeout', 'server error', '500'] },
    { id: 'system_bug', label: 'System Bug', keywords: ['\u0E1A\u0E31\u0E4A\u0E01', '\u0E41\u0E2A\u0E14\u0E07\u0E1C\u0E25\u0E1C\u0E34\u0E14', 'logic \u0E1C\u0E34\u0E14', '\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E0B\u0E49\u0E33', 'behavior', '\u0E2B\u0E19\u0E49\u0E32\u0E08\u0E2D'] },
    { id: 'change_request', label: 'Change Request', keywords: ['\u0E04\u0E33\u0E02\u0E2D\u0E40\u0E1E\u0E34\u0E48\u0E21', '\u0E02\u0E2D\u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19', '\u0E1B\u0E23\u0E31\u0E1A\u0E1B\u0E23\u0E38\u0E07', 'feature request', 'enhancement'] },
    { id: 'software', label: 'Software', keywords: ['\u0E2A\u0E34\u0E17\u0E18\u0E34\u0E4C', 'login', 'api', 'mapping', 'data', 'integration', 'auth', 'session'] },
    { id: 'network', label: 'network', keywords: ['\u0E40\u0E19\u0E47\u0E15', 'wifi', 'vpn', 'lan', 'connection', '\u0E2A\u0E31\u0E0D\u0E0D\u0E32\u0E13', '\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E15\u0E48\u0E2D\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49'] },
    { id: 'hardware', label: 'hardware', keywords: ['\u0E2D\u0E38\u0E1B\u0E01\u0E23\u0E13\u0E4C', 'printer', 'scanner', 'keyboard', 'mouse', 'monitor', '\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07'] },
  ];

  function loadAiRules() {
    try {
      const raw = localStorage.getItem(AI_RULE_STORAGE_KEY);
      if (!raw) return DEFAULT_AI_RULES.map((rule) => ({ ...rule }));
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_AI_RULES.map((rule) => ({ ...rule }));
      return DEFAULT_AI_RULES.map((fallbackRule, index) => {
        const saved = parsed[index] || {};
        return {
          id: fallbackRule.id,
          label: String(saved.label || fallbackRule.label).trim() || fallbackRule.label,
          keywords: Array.isArray(saved.keywords)
            ? saved.keywords.map((keyword) => String(keyword).trim()).filter(Boolean)
            : fallbackRule.keywords.slice(),
        };
      });
    } catch {
      return DEFAULT_AI_RULES.map((rule) => ({ ...rule }));
    }
  }

  function getIssueTypeLabels() {
    return loadAiRules().map((rule) => rule.label);
  }

  function normalizeIssueTypeLabel(rawValue, ticket = {}) {
    const rules = loadAiRules();
    const text = [
      rawValue || '',
      ticket.title || '',
      ticket.description || '',
      ticket.project || '',
      ticket.extra || '',
    ].join(' ').toLowerCase();

    for (const rule of rules) {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
      if (keywords.some((keyword) => text.includes(String(keyword || '').toLowerCase()))) {
        return rule.label;
      }
    }
    return rules.find((rule) => rule.label === 'Software')?.label || 'Software';
  }

  function isTicketInYear(ticket, year = '2026') {
    const stamp = String(ticket.created_at || ticket.updated_at || '');
    return stamp.startsWith(String(year));
  }

  function scoreTicket(ticket, issueText) {
    const terms = getIssueTerms(issueText);
    const hay = [
      ticket.title || '',
      ticket.description || '',
      ticket.bug_type || '',
      ticket.project || '',
      ticket.extra || '',
    ].join('\n').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (hay.includes(term)) score += 1;
      if (String(ticket.title || '').toLowerCase().includes(term)) score += 2;
    }
    return score;
  }

  function summarizeContext(project, tickets) {
    const statusCounts = {};
    const typeCounts = {};
    const ownerCounts = {};
    const recent = [];
    const scopedTickets = (tickets || []).filter((ticket) => isTicketInYear(ticket, '2026'));

    for (const ticket of scopedTickets) {
      const extra = parseJsonSafe(ticket.extra || '{}', {});
      const status = String(ticket.status || 'unknown');
      const type = normalizeIssueTypeLabel(ticket.bug_type || 'Software', ticket);
      const owner = String(extra.owner_officer || ticket.assigned_dev || '').trim();

      statusCounts[status] = (statusCounts[status] || 0) + 1;
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      if (owner) ownerCounts[owner] = (ownerCounts[owner] || 0) + 1;

      recent.push({
        id: ticket.id,
        title: ticket.title || ticket.id,
        status,
        bugType: type,
        owner,
        team: extra.owner_team || '',
        subproject: extra.subproject_name || extra.subproject_code || '',
      });
    }

    const topIssueTypes = getIssueTypeLabels()
      .map((label) => ({ name: label, count: typeCounts[label] || 0 }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count);
    const topOwners = Object.entries(ownerCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
    const openLike = (statusCounts.open || 0) + (statusCounts.process || 0);

    return {
      project,
      ticketCount: scopedTickets.length,
      openLike,
      topIssueTypes,
      topOwners,
      recentTickets: recent.slice(0, 8),
      statusCounts,
    };
  }

  function renderContext(context) {
    state.projectContext = context;
    // update KPI elements ?้ามีอยู่ใน DOM
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
    set('kpiTickets',    context.ticketCount || 0);
    set('kpiOpen',       context.openLike || 0);
    set('kpiIssueType',  context.topIssueTypes[0]?.name || '-');
    set('kpiOwner',      context.topOwners[0]?.name || '-');
    set('projectSummaryNote',
      `${context.project.code} - ${context.project.name} | PM: ${context.project.pm || '-'} | ?
?านะที่พบมาก: ${
      Object.entries(context.statusCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, count]) => `${name} (${count})`).join(', ') || '-'
      }`);
    renderProjectManagementBox(context);

    const ownerChips = document.getElementById('ownerChips');
    if (ownerChips) {
      ownerChips.innerHTML = context.topOwners.length
        ? context.topOwners.map((item) => `<span class="v2-chip">${esc(item.name)} <small>(${item.count})</small></span>`).join('')
        : '<span class="v2-chip">ยังไม่พบ owner history</span>';
    }

    const ticketList = document.getElementById('ticketList');
    if (ticketList) {
      ticketList.innerHTML = context.recentTickets.length
        ? context.recentTickets.map((ticket) => `
            <li class="v2-item">
              <div class="v2-item-title">${esc(ticket.title)}</div>
              <div class="v2-item-meta">${esc(ticket.bugType)} | ${esc(ticket.status)}${ticket.owner ? ' | ' + esc(ticket.owner) : ''}${ticket.subproject ? ' | ' + esc(ticket.subproject) : ''}</div>
            </li>
          `).join('')
        : '<li class="v2-empty">No tickets found for this project</li>';
    }
  }

  function renderProjectManagementBox(context = null) {
    const body = document.getElementById('projectManagementBody');
    if (!body) return;

    const project = context?.project || state.projectContext?.project || state.projectLookup.get(document.getElementById('projectSelect')?.value || '');
    if (!project) {
      body.innerHTML = '<div class="v2-empty">Select a project to show Project Management data</div>';
      return;
    }

    const ticketCount = context?.ticketCount ?? state.projectContext?.ticketCount ?? '-';
    const topIssue = context?.topIssueTypes?.[0]?.name || state.projectContext?.topIssueTypes?.[0]?.name || '-';
    const topOwner = context?.topOwners?.[0]?.name || state.projectContext?.topOwners?.[0]?.name || '-';
    const pmName = project.pm || '-';
    const description = project.description || 'ไม่มีคำอธิบายโปรเจกต์เพิ่มเต?';

    body.innerHTML = `
      <div class="v2-project-mgmt-grid">
        <div class="v2-project-mgmt-item">
          <div class="v2-project-mgmt-k">Project</div>
          <div class="v2-project-mgmt-v">${esc(project.code || '-')} - ${esc(project.name || '-')}</div>
        </div>
        <div class="v2-project-mgmt-item">
          <div class="v2-project-mgmt-k">PM</div>
          <div class="v2-project-mgmt-v">${esc(pmName)}</div>
        </div>
        <div class="v2-project-mgmt-item">
          <div class="v2-project-mgmt-k">Tickets</div>
          <div class="v2-project-mgmt-v">${esc(String(ticketCount))}</div>
        </div>
      </div>
      <div class="v2-project-mgmt-grid">
        <div class="v2-project-mgmt-item">
          <div class="v2-project-mgmt-k">Top Issue</div>
          <div class="v2-project-mgmt-v">${esc(topIssue)}</div>
        </div>
        <div class="v2-project-mgmt-item">
          <div class="v2-project-mgmt-k">Top Owner</div>
          <div class="v2-project-mgmt-v">${esc(topOwner)}</div>
        </div>
        <div class="v2-project-mgmt-item">
          <div class="v2-project-mgmt-k">Description</div>
          <div class="v2-project-mgmt-v">${esc(description)}</div>
        </div>
      </div>
    `;
  }

  async function loadProjectContext() {
    const projectCode = document.getElementById('projectSelect').value;
    const project = state.projectLookup.get(projectCode);
    if (!project) {
      BT.notify('Select a project first', 'warning');
      return null;
    }
    try {
      const data = await apiJson('/api/helpdesk/tickets?q=' + encodeURIComponent(projectCode) + '&year=2026');
      const tickets = (data.ok ? (data.data || []) : [])
        .filter((ticket) => String(ticket.project || '').trim() === projectCode)
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      const context = summarizeContext(project, tickets);
      renderContext(context);
      return context;
    } catch (e) {
      // ?้า API fail ให้ return empty context แทน crash
      const context = summarizeContext(project, []);
      state.projectContext = context;
      return context;
    }
  }

  function fallbackAnalysis(project, issueText, moduleArea, context) {
    const firstIssueType = context?.topIssueTypes?.[0]?.name || 'Software';
    const firstOwner     = context?.topOwners?.[0]?.name     || 'Existing project team';
    const lines          = issueText.split(/\n+/).filter(Boolean);
    return {
      summary      : lines[0] || issueText.slice(0, 120) || 'ผู้ใช้แจ้งปัญหาใหม่',
      problem_type : firstIssueType,
      severity     : /ด่วน|urgent|critical|ล่ม|เข้าไม่ได้|error|ไม่ได้เลย/i.test(issueText) ? 'high' : 'medium',
      module_or_area : moduleArea || project?.code || 'รอระบุเพิ่ม',
      likely_cause : `Based on project history ${project?.code || ''}, this case is usually related to ${firstIssueType} and handled by ${firstOwner}`,
      quick_fixes  : [
        'Capture the screen and full error message',
        'Specify the time range and affected user',
        'ลองยืนยันว่าปัญหาเกิดทุกครั้งหรือเกิดเฉพาะบางเงื่อนไข',
      ],
      clarifying_questions : [
        'ปัญหานี้เกิดกับผู้ใช้ทุกคนหรือเฉพาะบางคน?',
        'ก่อนเกิดปัญหามีการแก้ไขข้อมูลหรือ deploy อะไรหรือไม่?',
      ],
      when_to_escalate : 'Escalate to Dev if this affects core customer work or the first checks do not resolve it',
    };
  }

  function normalizeAnalysisShape(raw, fallback) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const quickFixes = Array.isArray(data.quick_fixes) ? data.quick_fixes
      : Array.isArray(data.fixes) ? data.fixes
      : Array.isArray(data.steps) ? data.steps
      : Array.isArray(data.solutions) ? data.solutions
      : fallback.quick_fixes;
    const questions = Array.isArray(data.clarifying_questions) ? data.clarifying_questions
      : Array.isArray(data.questions) ? data.questions
      : Array.isArray(data.follow_up_questions) ? data.follow_up_questions
      : fallback.clarifying_questions;

    return {
      reporter: String(data.reporter || fallback.reporter || '').trim(),
      occurred_at: String(data.occurred_at || data.occurredAt || fallback.occurred_at || '').trim(),
      office: String(data.office || fallback.office || '').trim(),
      receipt_no: String(data.receipt_no || fallback.receipt_no || '').trim(),
      urls: Array.isArray(data.urls) ? data.urls.filter(Boolean) : (fallback.urls || []),
      numbered_items: Array.isArray(data.numbered_items) ? data.numbered_items.filter(Boolean) : (fallback.numbered_items || []),
      summary: String(
        data.summary ||
        data.case_subject ||
        data.case_description ||
        fallback.summary ||
        ''
      ).trim(),
      problem_type: normalizeIssueTypeLabel(
        String(
          data.problem_type ||
          data.issue_type ||
          data.bug_type ||
          fallback.problem_type ||
          ''
        ).trim(),
        {
          title: data.summary || fallback.summary || '',
          description: data.likely_cause || fallback.likely_cause || '',
        }
      ),
      severity: String(data.severity || fallback.severity || 'medium').trim().toLowerCase(),
      module_or_area: String(
        data.module_or_area ||
        data.module ||
        data.area ||
        data.page ||
        fallback.module_or_area ||
        ''
      ).trim(),
      likely_cause: String(
        data.likely_cause ||
        data.root_cause ||
        data.cause ||
        fallback.likely_cause ||
        ''
      ).trim(),
      quick_fixes: quickFixes.filter(Boolean),
      clarifying_questions: questions.filter(Boolean),
      when_to_escalate: String(
        data.when_to_escalate ||
        data.escalate_when ||
        data.escalation ||
        fallback.when_to_escalate ||
        ''
      ).trim(),
    };
  }

  function parseAnalysisResponse(reply, fallback) {
    const text = String(reply || '').trim();
    console.log('[ChatV2] raw reply:', text.slice(0, 500));

    // ลอง extract JSON หลายรูปแบบ
    let jsonStr = null;

    // 1. match fenced JSON block
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // 2. match the largest JSON object
    if (!jsonStr) {
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) jsonStr = braceMatch[0];
    }

    // 3. ลอง parse ?ั้ง string
    if (!jsonStr) jsonStr = text;

    try {
      const parsed = JSON.parse(jsonStr);
      console.log('[ChatV2] parsed:', parsed);
      return normalizeAnalysisShape(parsed, fallback);
    } catch (e) {
      console.warn('[ChatV2] JSON parse failed, using fallback. Error:', e.message);
      // If parsing fails, keep fallback and use the reply as summary when useful.
      return normalizeAnalysisShape(
        {
          ...fallback,
          summary: text.slice(0, 200) || fallback.summary,
        },
        fallback
      );
    }
  }

  function renderAnalysis(analysis) {
    const normalized = normalizeAnalysisShape(analysis, fallbackAnalysis(
      state.projectLookup.get(document.getElementById('projectSelect').value),
      document.getElementById('issueInput').value.trim(),
      '',
      state.projectContext
    ));
    state.analysis = normalized;

    const severity = String(normalized.severity || 'medium').toLowerCase();
    const severityBadge = document.getElementById('severityBadge');
    severityBadge.className = `v2-badge ${severity}`;
    severityBadge.textContent = severity;

    document.getElementById('problemTypeBox').textContent = normalized.problem_type   || '(ไม่ระบุ)';
    document.getElementById('moduleBox').textContent      = normalized.module_or_area || '(ไม่ระบุ)';
    document.getElementById('reporterBox').textContent    = normalized.reporter       || '(ไม่ระบุ)';
    document.getElementById('occurredAtBox').textContent  = normalized.occurred_at    || '(ไม่ระบุ)';
    document.getElementById('officeBox').textContent      = normalized.office         || '(ไม่ระบุ)';
    document.getElementById('receiptBox').textContent     = normalized.receipt_no     || '(ไม่ระบุ)';
    document.getElementById('summaryBox').textContent     = normalized.summary        || '(ไม่ระบุ)';
    document.getElementById('causeBox').textContent       = normalized.likely_cause   || '(ไม่ระบุ)';
    document.getElementById('fixesBox').innerHTML =
      (normalized.quick_fixes || []).length
        ? `<ul>${normalized.quick_fixes.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
        : '<span style="color:#94a3b8">(ไม่ระบุ)</span>';
    document.getElementById('questionsBox').innerHTML =
      (normalized.clarifying_questions || []).length
        ? `<ul>${normalized.clarifying_questions.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
        : '<span style="color:#94a3b8">(ไม่ระบุ)</span>';
    const escalateBox = document.getElementById('escalateBox');
    if (escalateBox) {
      escalateBox.textContent = normalized.when_to_escalate || '(ไม่ระบุ)';
    }

    document.getElementById('analysisPreviewSeverityBadge').className = `v2-badge ${severity}`;
    document.getElementById('analysisPreviewSeverityBadge').textContent = severity;
    document.getElementById('analysisPreviewProblemTypeBox').textContent = normalized.problem_type   || '(ไม่ระบุ)';
    document.getElementById('analysisPreviewReporterBox').textContent    = normalized.reporter       || '(ไม่ระบุ)';
    document.getElementById('analysisPreviewOccurredAtBox').textContent  = normalized.occurred_at    || '(ไม่ระบุ)';
    document.getElementById('analysisPreviewOfficeBox').textContent      = normalized.office         || '(ไม่ระบุ)';
    document.getElementById('analysisPreviewReceiptBox').textContent     = normalized.receipt_no     || '(ไม่ระบุ)';
    document.getElementById('analysisPreviewSummaryBox').textContent     = normalized.summary        || '(ไม่ระบุ)';
    document.getElementById('analysisPreviewCauseBox').textContent       = normalized.likely_cause   || '(ไม่ระบุ)';
    // reset chat & dev
    state.chatMessages = [
      {
        role: 'ai',
        text: '\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E0A\u0E48\u0E27\u0E22\u0E15\u0E48\u0E2D\u0E08\u0E32\u0E01\u0E1C\u0E25\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E19\u0E35\u0E49\u0E41\u0E25\u0E49\u0E27\u0E04\u0E23\u0E31\u0E1A \u0E16\u0E32\u0E21\u0E15\u0E48\u0E2D\u0E44\u0E14\u0E49\u0E40\u0E25\u0E22 \u0E40\u0E0A\u0E48\u0E19 \u0E04\u0E27\u0E23\u0E40\u0E0A\u0E47\u0E01 log \u0E15\u0E23\u0E07\u0E44\u0E2B\u0E19 \u0E04\u0E27\u0E23\u0E16\u0E32\u0E21 user \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E2D\u0E30\u0E44\u0E23 \u0E2B\u0E23\u0E37\u0E2D\u0E04\u0E27\u0E23\u0E25\u0E2D\u0E07\u0E41\u0E01\u0E49\u0E40\u0E1A\u0E37\u0E49\u0E2D\u0E07\u0E15\u0E49\u0E19\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E44\u0E23',
      },
      {
        role: 'ai',
        text: buildChatSuggestionMessage(normalized),
      },
    ];

    document.getElementById('analysisSection').classList.add('show');
    document.getElementById('chatSection').classList.add('show');
    setResultTab('analysis');
    setFlowStep('analysis');
    renderChatLog();
  }

  function closeAnalysisModal() {
    document.getElementById('analysisModal').classList.remove('open');
  }

  function openAnalysisModal() {
    setResultTab('analysis');
    setFlowStep('analysis');
    document.getElementById('analysisModal').classList.add('open');
    document.getElementById('chatModalDock')?.classList.remove('open');
    document.getElementById('devModal').classList.remove('open');
  }

  function updateChatContextBadge() {
    const badge = document.getElementById('chatContextBadge');
    if (!badge) return;
    const analysis = state.analysis;
    if (!analysis) {
      badge.textContent = 'ยังไม่มีผลวิเคราะห์ กรุณากดวิเคราะห์ก่อน';
      return;
    }
    const parts = [
      analysis.problem_type || 'ไม่ระบุประเภท',
      analysis.module_or_area || 'ไม่ระบุพื้นที่',
      analysis.severity || 'medium',
    ];
    badge.textContent = parts.join(' • ');
  }

  function ensureChatStarter() {
    if (!state.chatMessages.length) {
      state.chatMessages.push({
        role: 'ai',
        text: 'สวัสดีครับ ผมเป็นเจ้าหน้าที่ช่วยงาน Helpdesk ถามมาได้เลยครับ ผมจะช่วยถาม-ตอบ ไล่หาสาเหตุ สรุปปัญหา และเสนอแนวทางแก้เบื้องต้นให้ครับ',
      });
    }
  }

  function buildChatSuggestionMessage(analysis) {
    const fixes = (analysis.quick_fixes || []).map((item) => `- ${item}`).join('\n') || '-';
    const questions = (analysis.clarifying_questions || []).map((item) => `- ${item}`).join('\n') || '-';
    const escalate = analysis.when_to_escalate || '-';
    return [
      'เสนอในแชท',
      '',
      'แนวทางแก้เบื้องต้น',
      fixes,
      '',
      'ควรถามเพิ่ม',
      questions,
      '',
      'เงื่อนไขที่ควรส่งต่อ',
      escalate,
    ].join('\n');
  }

  function openChatModal() {
    if (!state.analysis) {
      BT.notify('วิเคราะห์ปัญหาก่อน', 'warning');
      return;
    }
    setResultTab('chat');
    setFlowStep('chat');
    updateChatContextBadge();
    ensureChatStarter();
    renderChatLog();
    document.getElementById('chatSection').classList.add('show');
    document.getElementById('devModal').classList.remove('open');
    setTimeout(() => document.getElementById('chatInput')?.focus(), 50);
  }

  function closeChatModal() {
    document.getElementById('chatModalDock')?.classList.remove('open');
  }

  function openDevModal() {
    document.getElementById('devModal').classList.add('open');
    document.getElementById('analysisModal').classList.remove('open');
    document.getElementById('chatModalDock')?.classList.remove('open');
  }

  function closeDevModal() {
    document.getElementById('devModal').classList.remove('open');
  }

  // ปิด modal เมื่อกด overlay
  document.getElementById('analysisModal').addEventListener('click', function(e) {
    if (e.target === this) closeAnalysisModal();
  });

  // ปิด modal เมื่อกด Escape
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeAnalysisModal();
    closeChatModal();
    closeDevModal();
  });

  async function analyzeIssue() {
    const projectCode = document.getElementById('projectSelect').value;
    const issueText = document.getElementById('issueInput').value.trim();
    const project = state.projectLookup.get(projectCode);
    if (!project) {
      BT.notify('Select a project first', 'warning');
      return;
    }
    if (!issueText) {
      BT.notify('กรอกรายละเอียดปัญหาก่อน', 'warning');
      return;
    }

    const button = document.getElementById('analyzeBtn');
    setLoading(button, true, '\u0E01\u0E33\u0E25\u0E31\u0E07\u0E15\u0E2D\u0E1A...');
    try {
      const context = state.projectContext?.project?.code === projectCode ? state.projectContext : await loadProjectContext();
      const extracted = extractIssueDetails(issueText);
      const fallbackBase = fallbackAnalysis(project, issueText, extracted.office || '', context);
      const fallback = {
        ...fallbackBase,
        summary: extracted.summary || fallbackBase.summary,
        problem_type: extracted.problem_type || fallbackBase.problem_type,
        module_or_area: extracted.module_or_area || fallbackBase.module_or_area,
        likely_cause: extracted.likely_cause || fallbackBase.likely_cause,
        quick_fixes: Array.from(new Set([...(extracted.quick_fixes || []), ...(fallbackBase.quick_fixes || [])])),
        clarifying_questions: Array.from(new Set([...(extracted.clarifying_questions || []), ...(fallbackBase.clarifying_questions || [])])),
        when_to_escalate: extracted.when_to_escalate || fallbackBase.when_to_escalate,
      };
      const ticketHints = (context.recentTickets || [])
        .map((ticket) => `${ticket.title} | ${ticket.bugType} | ${ticket.status}${ticket.owner ? ' | ' + ticket.owner : ''}`)
        .slice(0, 6)
        .join('\n');

      const prompt = [
        '\u0E04\u0E38\u0E13\u0E04\u0E37\u0E2D\u0E40\u0E08\u0E49\u0E32\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48 Helpdesk \u0E17\u0E35\u0E48\u0E0A\u0E48\u0E27\u0E22\u0E16\u0E32\u0E21-\u0E15\u0E2D\u0E1A\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E2A\u0E38\u0E20\u0E32\u0E1E \u0E0A\u0E31\u0E14\u0E40\u0E08\u0E19 \u0E41\u0E25\u0E30\u0E25\u0E07\u0E21\u0E37\u0E2D\u0E0A\u0E48\u0E27\u0E22\u0E41\u0E01\u0E49\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E44\u0E14\u0E49\u0E08\u0E23\u0E34\u0E07',
        '\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48\u0E02\u0E2D\u0E07\u0E04\u0E38\u0E13\u0E04\u0E37\u0E2D\u0E16\u0E32\u0E21\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E22\u0E31\u0E07\u0E02\u0E32\u0E14 \u0E41\u0E19\u0E30\u0E19\u0E33\u0E27\u0E34\u0E18\u0E35\u0E41\u0E01\u0E49\u0E40\u0E1A\u0E37\u0E49\u0E2D\u0E07\u0E15\u0E49\u0E19 \u0E41\u0E25\u0E30\u0E1A\u0E2D\u0E01\u0E40\u0E07\u0E37\u0E48\u0E2D\u0E19\u0E44\u0E02\u0E17\u0E35\u0E48\u0E04\u0E27\u0E23\u0E2A\u0E48\u0E07\u0E15\u0E48\u0E2D\u0E16\u0E49\u0E32\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E40\u0E01\u0E34\u0E19\u0E02\u0E2D\u0E1A\u0E40\u0E02\u0E15',
        '',
        '\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E40\u0E04\u0E2A helpdesk \u0E41\u0E25\u0E49\u0E27\u0E15\u0E2D\u0E1A\u0E40\u0E1B\u0E47\u0E19 JSON \u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19',
        '{"summary":"","problem_type":"","severity":"low|medium|high|critical","module_or_area":"","likely_cause":"","quick_fixes":[""],"clarifying_questions":[""],"when_to_escalate":""}',
        '',
        'Rules:',
        '- \u0E43\u0E0A\u0E49\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22',
        '- \u0E2D\u0E34\u0E07\u0E08\u0E32\u0E01\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E42\u0E1B\u0E23\u0E40\u0E08\u0E01\u0E15\u0E4C\u0E41\u0E25\u0E30\u0E1B\u0E23\u0E30\u0E27\u0E31\u0E15\u0E34 ticket \u0E17\u0E35\u0E48\u0E43\u0E2B\u0E49\u0E44\u0E27\u0E49',
        '- problem_type \u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E14\u0E49\u0E41\u0E04\u0E48 system error, System Bug, Human error, hardware, Software, network, Change Request',
        '- quick_fixes \u0E43\u0E2B\u0E49 3 \u0E02\u0E49\u0E2D',
        '- clarifying_questions \u0E43\u0E2B\u0E49 2-3 \u0E02\u0E49\u0E2D',
        '',
        `Project: ${project.code} - ${project.name}`,
        `PM: ${project.pm || '-'}`,
        `Module hint: ${extracted.office || '-'}`,
        `Reporter: ${extracted.reporter || '-'}`,
        `Occurred at: ${extracted.occurred_at || '-'}`,
        `Receipt no: ${extracted.receipt_no || '-'}`,
        `Numbered items: ${(extracted.numbered_items || []).length ? extracted.numbered_items.map((item, index) => `${index + 1}. ${item}`).join(' | ') : '-'}`,
        `Links: ${(extracted.urls || []).length ? extracted.urls.join(' | ') : '-'}`,
        `Historical ticket count: ${context.ticketCount || 0}`,
        `Top issue types: ${(context.topIssueTypes || []).map((item) => `${item.name} (${item.count})`).join(', ') || '-'}`,
        `Top owners: ${(context.topOwners || []).map((item) => `${item.name} (${item.count})`).join(', ') || '-'}`,
        `Recent similar tickets:\n${ticketHints || '-'}`,
        '',
        `Issue detail:\n${issueText}`,
      ].join('\n');

      const aiData = await apiJson('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', text: prompt }],
          ticketContext: [
            `Project: ${project.code} - ${project.name}`,
            `Module hint: ${extracted.office || '-'}`,
            `Reporter: ${extracted.reporter || '-'}`,
            `Occurred at: ${extracted.occurred_at || '-'}`,
            `Receipt no: ${extracted.receipt_no || '-'}`,
            `Numbered items: ${(extracted.numbered_items || []).join(' || ') || '-'}`,
            `Issue detail: ${issueText}`,
          ].join('\n'),
        }),
      });

      const analysis = aiData.ok ? parseAnalysisResponse(aiData.reply, fallback) : fallback;
      console.log('[ChatV2] aiData.ok:', aiData.ok, '| reply:', String(aiData.reply||'').slice(0,200));
      console.log('[ChatV2] analysis:', JSON.stringify(analysis));
      // Debug: แสดงข้อมูลใน modal ก่อน render
      if (!analysis.summary || analysis.summary === fallback.summary) {
        console.warn('[ChatV2] WARNING: analysis used fallback or empty summary');
      }
      await loadDevDirectory();
      renderAnalysis(analysis);
      renderDevCandidates();
      document.getElementById('devList').classList.remove('show');
      BT.notify('\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E40\u0E23\u0E35\u0E22\u0E1A\u0E23\u0E49\u0E2D\u0E22', 'info');
    } catch (error) {
      BT.notify(error.message || '\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08', 'error');
    } finally {
      setLoading(button, false);
    }
  }

  function renderChatLog() {
    const log = document.getElementById('chatLog');
    log.innerHTML = state.chatMessages.map((message) => `<div class="v2-msg ${message.role}">${esc(message.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
    updateChatContextBadge();
  }

  function fallbackChatReply(question, analysis, context) {
    const fixes = (analysis.quick_fixes || []).filter(Boolean).slice(0, 3);
    const questions = (analysis.clarifying_questions || []).filter(Boolean).slice(0, 3);
    const owners = (context?.topOwners || []).slice(0, 2).map((owner) => owner.name).filter(Boolean);
    const lines = [
      '\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49\u0E23\u0E30\u0E1A\u0E1A AI \u0E15\u0E2D\u0E1A\u0E01\u0E25\u0E31\u0E1A\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49 \u0E1C\u0E21\u0E2A\u0E23\u0E38\u0E1B\u0E41\u0E19\u0E27\u0E17\u0E32\u0E07\u0E08\u0E32\u0E01\u0E1C\u0E25\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14\u0E43\u0E2B\u0E49\u0E01\u0E48\u0E2D\u0E19\u0E04\u0E23\u0E31\u0E1A',
      '',
      '\u0E04\u0E33\u0E16\u0E32\u0E21: ' + question,
      '\u0E40\u0E04\u0E2A: ' + (analysis.summary || '-'),
      '\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17/\u0E04\u0E27\u0E32\u0E21\u0E23\u0E38\u0E19\u0E41\u0E23\u0E07: ' + (analysis.problem_type || '-') + ' / ' + (analysis.severity || 'medium'),
      '',
      '\u0E41\u0E19\u0E27\u0E17\u0E32\u0E07\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E40\u0E1A\u0E37\u0E49\u0E2D\u0E07\u0E15\u0E49\u0E19:',
    ];
    if (/log|error|check|api|console|network/i.test(question)) {
      lines.push('1. \u0E40\u0E01\u0E47\u0E1A\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21 error \u0E40\u0E15\u0E47\u0E21 \u0E46 \u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E40\u0E27\u0E25\u0E32\u0E17\u0E35\u0E48\u0E40\u0E01\u0E34\u0E14\u0E1B\u0E31\u0E0D\u0E2B\u0E32', '2. \u0E15\u0E23\u0E27\u0E08 Console/Network \u0E27\u0E48\u0E32 request \u0E44\u0E2B\u0E19 fail', '3. \u0E15\u0E23\u0E27\u0E08 backend log \u0E02\u0E2D\u0E07 endpoint \u0E17\u0E35\u0E48\u0E40\u0E01\u0E35\u0E48\u0E22\u0E27\u0E02\u0E49\u0E2D\u0E07');
    } else if (fixes.length) {
      fixes.forEach((fix, index) => lines.push((index + 1) + '. ' + fix));
    } else {
      lines.push('1. \u0E25\u0E2D\u0E07\u0E17\u0E33\u0E0B\u0E49\u0E33\u0E14\u0E49\u0E27\u0E22 user \u0E40\u0E14\u0E34\u0E21\u0E41\u0E25\u0E30 user \u0E2D\u0E37\u0E48\u0E19\u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E41\u0E22\u0E01 scope', '2. \u0E15\u0E23\u0E27\u0E08\u0E27\u0E48\u0E32\u0E21\u0E35 deploy, config \u0E2B\u0E23\u0E37\u0E2D master data \u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19\u0E01\u0E48\u0E2D\u0E19\u0E40\u0E01\u0E34\u0E14\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E2B\u0E23\u0E37\u0E2D\u0E44\u0E21\u0E48', '3. \u0E41\u0E19\u0E1A screenshot, step to reproduce \u0E41\u0E25\u0E30 expected result \u0E43\u0E2B\u0E49 Dev');
    }
    if (questions.length) { lines.push('', '\u0E04\u0E27\u0E23\u0E16\u0E32\u0E21\u0E40\u0E1E\u0E34\u0E48\u0E21:'); questions.forEach((item) => lines.push('- ' + item)); }
    if (owners.length) lines.push('', '\u0E04\u0E19\u0E17\u0E35\u0E48\u0E04\u0E27\u0E23\u0E40\u0E23\u0E34\u0E48\u0E21\u0E16\u0E32\u0E21/\u0E2A\u0E48\u0E07\u0E15\u0E48\u0E2D: ' + owners.join(', '));
    lines.push('', '\u0E40\u0E07\u0E37\u0E48\u0E2D\u0E19\u0E44\u0E02\u0E2A\u0E48\u0E07\u0E15\u0E48\u0E2D: ' + (analysis.when_to_escalate || '\u0E16\u0E49\u0E32\u0E01\u0E23\u0E30\u0E17\u0E1A\u0E07\u0E32\u0E19\u0E2B\u0E25\u0E31\u0E01\u0E2B\u0E23\u0E37\u0E2D\u0E41\u0E01\u0E49\u0E40\u0E1A\u0E37\u0E49\u0E2D\u0E07\u0E15\u0E49\u0E19\u0E41\u0E25\u0E49\u0E27\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E2B\u0E32\u0E22 \u0E43\u0E2B\u0E49\u0E2A\u0E48\u0E07\u0E15\u0E48\u0E2D Dev'));
    return lines.join('\n');
  }

  async function askAi() {
    const analysis = state.analysis;
    const context = state.projectContext;
    const input = document.getElementById('chatInput');
    const question = input.value.trim();
    if (!analysis) {
      BT.notify('วิเคราะห์ปัญหาก่อน', 'warning');
      return;
    }
    if (!question) {
      BT.notify('พิมพ์คำถามก่อน', 'warning');
      return;
    }

    state.chatMessages.push({ role: 'user', text: question });
    renderChatLog();
    input.value = '';

    const button = document.getElementById('sendChatBtn');
    setLoading(button, true, '\u0E01\u0E33\u0E25\u0E31\u0E07\u0E15\u0E2D\u0E1A...');
    try {
      const aiData = await apiJson('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { role: 'user', text: [
              '?อบเป็นภาษาไทยแบบลงมือทำได้จริง',
              `Project: ${context.project.code} - ${context.project.name}`,
              `Problem type: ${analysis.problem_type}`,
              `Severity: ${analysis.severity}`,
              `Module: ${analysis.module_or_area || '-'}`,
              `Likely cause: ${analysis.likely_cause || '-'}`,
              `Question: ${question}`,
            ].join('\n') },
          ],
          ticketContext: [
            `Project: ${context.project.code} - ${context.project.name}`,
            `Issue type: ${analysis.problem_type}`,
            `Issue summary: ${analysis.summary}`,
          ].join('\n'),
        }),
      });
      const reply = aiData.ok && String(aiData.reply || '').trim()
        ? String(aiData.reply || '').trim()
        : fallbackChatReply(question, analysis, context);
      state.chatMessages.push({ role: 'ai', text: reply });
      renderChatLog();
    } catch (error) {
      state.chatMessages.push({ role: 'ai', text: fallbackChatReply(question, analysis, context) });
      renderChatLog();
    } finally {
      setLoading(button, false);
    }
  }

  function renderDevCandidates() {
    const select = document.getElementById('devSelect');
    const list = document.getElementById('devList');
    const context = state.projectContext;
    const owners = context?.topOwners || [];
    const directory = state.devDirectory || [];
    const merged = new Map();
    for (const person of directory) {
      if (!person.name) continue;
      merged.set(person.name.toLowerCase(), {
        name: person.name,
        code: person.code || '',
        role: person.role || '',
        department: person.department || '',
        count: 0,
        source: 'directory',
      });
    }
    for (const owner of owners) {
      const key = String(owner.name || '').toLowerCase();
      const current = merged.get(key) || {
        name: owner.name,
        code: '',
        role: '',
        department: '',
        count: 0,
        source: 'history',
      };
      current.count = Math.max(current.count || 0, Number(owner.count || 0));
      if (!current.code && owner.code) current.code = owner.code;
      merged.set(key, current);
    }
    const candidates = Array.from(merged.values()).sort((a, b) => {
      if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
      return String(a.name).localeCompare(String(b.name));
    });
    if (select) {
      select.innerHTML = ['<option value="">Select Dev to forward</option>']
        .concat(candidates.map((person) => {
          const label = person.count ? `${person.name} (${person.count})` : person.name;
          const role = person.role || person.department || 'ยังไม่ระบุ role';
          const suffix = [person.code, role].filter(Boolean).join(' | ');
          return `<option value="${esc(person.name)}">${esc(label + suffix)}</option>`;
        }))
        .join('');
      select.value = state.selectedDev || '';
    }
    if (list) {
      list.classList.add('show');
      list.innerHTML = candidates.length
        ? candidates.map((person) => `
            <div class="v2-item">
              <div class="v2-item-title">${esc(person.name)}</div>
              <div class="v2-item-meta">
                ${person.count ? `Handled ${person.count} cases for this project` : 'Loaded from real dev directory'}
                ${person.department ? ` | แผนก: ${esc(person.department)}` : ''}
                ${person.role ? ` | Role: ${esc(person.role)}` : ' | Role: ยังไม่ระบุ'}
                ${person.code ? ` | ${esc(person.code)}` : ''}
              </div>
            </div>
          `).join('')
        : '<div class="v2-empty">ยังไม่พบรายชื่อ Dev จากข้อมูลจริงในระบบ</div>';
    }
    const sendBtn = document.getElementById('sendToDevBtn');
    if (sendBtn) sendBtn.disabled = !state.selectedDev;
  }

  function pickDev(name) {
    state.selectedDev = name;
    BT.notify(`Selected ${name} for forwarding`, 'info');
    const select = document.getElementById('devSelect');
    if (select) select.value = name;
    const sendBtn = document.getElementById('sendToDevBtn');
    if (sendBtn) sendBtn.disabled = false;
    const list = document.getElementById('devList');
    const analysis = state.analysis || {};
    const summary = analysis.summary || document.getElementById('issueInput').value.trim();
    const devProfile = findDevProfileByName(name);
    const deptRoleText = [
      devProfile?.department || '',
      devProfile?.role || '',
    ].filter(Boolean).join(' / ') || '-';
    list.classList.add('show');
    list.innerHTML = `
      <div class="v2-analysis-box full" style="margin-bottom:12px">
        <div class="v2-analysis-k">Ready to forward</div>
        <div class="v2-analysis-v">
          <b>Dev:</b> ${esc(name)}<br>
          <b>สรุปเคส:</b> ${esc(summary)}<br>
          <b>ประเภทปัญหา:</b> ${esc(analysis.problem_type || '-')}<br>
          <b>แผนก / Role:</b> ${esc(deptRoleText)}<br>
          <b>โมดูล:</b> ${esc(analysis.module_or_area || '-')}<br>
          <b>ความรุนแรง:</b> ${esc(analysis.severity || '-')}
        </div>
      </div>
      <div class="v2-actions">
        <button class="v2-btn primary" id="submitTicketBtn" onclick="submitTicket()">
          <i class="bi bi-send"></i> สร้าง Ticket
        </button>
        <button class="v2-btn secondary" onclick="renderDevCandidates()">เปลี่ยน Dev</button>
      </div>
      <div id="ticketResult" style="margin-top:12px"></div>
    `;
  }

  async function submitTicket() {
    const analysis = state.analysis;
    const context = state.projectContext;
    const issueText = document.getElementById('issueInput').value.trim();
    const dev = state.selectedDev || '';

    if (!analysis || !context) {
      BT.notify('วิเคราะห์ปัญหาก่อนสร้าง Ticket', 'warning');
      return;
    }

    const btn = document.getElementById('submitTicketBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังสร้าง Ticket...'; }

    try {
      const payload = {
        title       : analysis.summary || issueText.slice(0, 120),
        description : [
          `Issue Detail:\n${issueText}`,
          `\nLikely cause:\n${analysis.likely_cause || '-'}`,
          `\nInitial fixes:\n${(analysis.quick_fixes || []).map((f, i) => `${i+1}. ${f}`).join('\n')}`,
        ].join('\n'),
        project      : context.project.code,
        bug_type     : analysis.problem_type || '',
        module       : analysis.module_or_area || '',
        assigned_dev : dev,
        severity     : analysis.severity || 'medium',
        // Odoo fields
        case_subject : analysis.summary || issueText.slice(0, 120),
        case_desc    : issueText,
        channel      : 'Website',
      };

      const data = await apiJson('/api/helpdesk/ticket', {
        method : 'POST',
        body   : JSON.stringify(payload),
      });

      const resultEl = document.getElementById('ticketResult');
      if (data.ok) {
        setFlowStep('odoo');
        const ticketId = data.odoo_ticket_id || data.case_ticket_id || data.local_id || '-';
        if (resultEl) resultEl.innerHTML = `
          <div class="v2-analysis-box full" style="border-color:#bbf7d0;background:#f0fdf4">
            <div class="v2-analysis-k" style="color:#047857">✅ สร้าง Ticket สำเร็จ</div>
            <div class="v2-analysis-v">
              <b>Ticket ID:</b> ${esc(String(ticketId))}<br>
              <b>Forward to:</b> ${esc(dev || '-')}<br>
              <b>Project:</b> ${esc(context.project.code)} - ${esc(context.project.name)}
            </div>
          </div>`;
        BT.notify('สร้าง Ticket สำเร็จ', 'success');
      } else {
        throw new Error(data.error || 'สร้าง Ticket ไม่สำเร็จ');
      }
    } catch (err) {
      const resultEl = document.getElementById('ticketResult');
      if (resultEl) resultEl.innerHTML = `
        <div class="v2-analysis-box full" style="border-color:#fecaca;background:#fef2f2">
          <div class="v2-analysis-k" style="color:#b91c1c">❌ เกิดข้อผิดพลาด</div>
          <div class="v2-analysis-v">${esc(err.message || 'ไม่สามารถสร้าง Ticket ได้')}</div>
        </div>`;
      BT.notify(err.message || 'สร้าง Ticket ไม่สำเร็จ', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-send"></i> สร้าง Ticket'; }
    }
  }

  function resetPage() {
    document.getElementById('projectSelect').value = '';
    document.getElementById('issueInput').value = '';
    document.getElementById('analysisSection').classList.remove('show');
    document.getElementById('chatSection').classList.remove('show');
    document.getElementById('devList').classList.remove('show');
    closeAnalysisModal();
    closeChatModal();
    closeDevModal();
    document.getElementById('devList').innerHTML = '';
    document.getElementById('chatInput').value = '';
    document.getElementById('chatLog').innerHTML = '';
    state.selectedDev = '';
    const devSelect = document.getElementById('devSelect');
    if (devSelect) devSelect.innerHTML = '<option value="">Select Dev to forward</option>';
    const sendToDevBtn = document.getElementById('sendToDevBtn');
    if (sendToDevBtn) sendToDevBtn.disabled = true;
    document.getElementById('kpiTickets').textContent = '-';
    document.getElementById('kpiOpen').textContent = '-';
    document.getElementById('kpiIssueType').textContent = '-';
    document.getElementById('kpiOwner').textContent = '-';
    document.getElementById('projectSummaryNote').textContent = 'Select a project first. The system will load owner history, issue patterns, and recent tickets.';
    document.getElementById('ownerChips').innerHTML = '<span class="v2-chip">No project selected</span>';
    document.getElementById('ticketList').innerHTML = '<li class="v2-empty">No tickets found for the selected project</li>';
    state.projectContext = null;
    state.analysis = null;
    state.chatMessages = [];
    state.resultTab = 'analysis';
    setResultTab('analysis');
    setFlowStep('input');
  }

  document.getElementById('analyzeBtn').addEventListener('click', analyzeIssue);
  document.getElementById('resetBtn').addEventListener('click', resetPage);
  document.getElementById('devSelect').addEventListener('change', (event) => {
    state.selectedDev = event.target.value || '';
    const sendBtn = document.getElementById('sendToDevBtn');
    if (sendBtn) sendBtn.disabled = !state.selectedDev;
  });
  document.getElementById('sendToDevBtn').addEventListener('click', () => {
    if (!state.selectedDev) {
      BT.notify('เลือก Dev ก่อน', 'warning');
      return;
    }
    submitTicket();
  });
  document.getElementById('sendChatBtn').addEventListener('click', askAi);
  document.getElementById('chatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      askAi();
    }
  });
  document.getElementById('projectSelect').addEventListener('change', () => {
    state.projectContext = null;
    state.analysis = null;
    state.selectedDev = '';
    document.getElementById('analysisSection').classList.remove('show');
    document.getElementById('chatSection').classList.remove('show');
    document.getElementById('devList').classList.remove('show');
    const devSelect = document.getElementById('devSelect');
    if (devSelect) devSelect.innerHTML = '<option value="">Select Dev to forward</option>';
    const sendToDevBtn = document.getElementById('sendToDevBtn');
    if (sendToDevBtn) sendToDevBtn.disabled = true;
    closeChatModal();
    closeDevModal();
    setResultTab('analysis');
    setFlowStep('input');
  });

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      bindFlowStepper();
      await loadProjects();
      await loadDevDirectory();
    } catch (error) {
      BT.notify(error.message || '\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E1B\u0E31\u0E0D\u0E2B\u0E32\u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08', 'error');
      document.getElementById('projectSelect').innerHTML = '<option value="">โหลด project ไม่สำเร็จ</option>';
    }
  });

  function truncateText(text, limit) {
    const value = String(text || '').trim().replace(/\s+/g, ' ');
    if (value.length <= limit) return value;
    return value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
  }

  function extractIssueDetails(issueText) {
    const text = String(issueText || '').trim();
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const urls = Array.from(new Set((text.match(/https?:\/\/\S+/g) || []).map((url) => url.replace(/[),.]+$/, ''))));
    const numberedItems = [];
    const bullets = [];
    let reporter = '';
    let occurredAt = '';
    let office = '';
    let receiptNo = '';

    for (const line of lines) {
      const normalized = line.replace(/\s+/g, ' ').trim();
      const isDateLine = /^\d{4}-\d{1,2}-\d{1,2}/.test(normalized) || /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(normalized);
      const explicitReporter = normalized.match(/(?:ผู้แจ้ง|ผู้รายงาน|รายงานโดย|แจ้งโดย|ผู้ส่งเรื่อง)\s*[:\-]?\s*(.+)$/i);
      const explicitOffice = normalized.match(/(?:หน่วยงาน|สำนักงาน|สำนัก|เขต|สกพ|กกพ)\s*[:\-]?\s*(.+)$/i);
      const explicitReceipt = normalized.match(/(?:เลขรับ|เลขทะเบียนรับ|ลงรับด้วยเลข|เลขที่รับ|รับเลข)\s*[:#]?\s*([0-9]{3,8})/i);
      const explicitDate = normalized.match(/(?:วันเวลา|วันที่เวลา|วันที่|เวลา)\s*[:\-]?\s*(.+)$/i);

      if (!reporter && explicitReporter) {
        reporter = explicitReporter[1].trim();
        continue;
      }
      if (!occurredAt && explicitDate) {
        occurredAt = explicitDate[1].trim();
        continue;
      }
      if (!office && explicitOffice) {
        office = explicitOffice[1].trim();
        continue;
      }
      if (!receiptNo && explicitReceipt) {
        receiptNo = explicitReceipt[1];
        continue;
      }
      if (!occurredAt && isDateLine) {
        occurredAt = normalized;
        continue;
      }
      if (!office && /สำนักงาน|สำนัก|เขต|กกพ|สกพ/i.test(normalized)) {
        office = normalized;
      }
      const itemMatch = line.match(/^\s*(\d+)[\.\)]\s*(.+)$/);
      if (itemMatch) {
        numberedItems.push(itemMatch[2].trim());
      } else if (/^[-•]\s+/.test(line)) {
        bullets.push(line.replace(/^[-•]\s+/, '').trim());
      }
      if (!receiptNo) {
        const receiptMatch = line.match(/(?:เลขรับ|เลขทะเบียนรับ|ลงรับด้วยเลข)\s*[:#]?\s*([0-9]{3,6})/i);
        if (receiptMatch) receiptNo = receiptMatch[1];
      }
    }

    if (!reporter) {
      const candidate = lines.find((line) => {
        if (!line) return false;
        if (/^https?:\/\//i.test(line)) return false;
        if (/^\d{4}-\d{1,2}-\d{1,2}/.test(line)) return false;
        if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(line)) return false;
        if (/^(\d+)[\.\)]\s+/.test(line)) return false;
        if (/^[-•]\s+/.test(line)) return false;
        if (/สำนักงาน|สำนัก|เขต|กกพ|สกพ/i.test(line)) return false;
        return line.length <= 60;
      });
      if (candidate) reporter = candidate;
    }

    const actionLine = numberedItems.find((item) => /แก้|ลงรับ|คืนเลข|ลบลำดับ|รับผิด|ยกเลิก|ลบเลข/i.test(item)) || numberedItems[0] || bullets[0] || '';
    const summary = actionLine ? truncateText(actionLine, 160) : text.slice(0, 160);
    const problemType = normalizeIssueTypeLabel(
      /เลขทะเบียนรับ|เลขรับ|ลงรับ/i.test(text)
        ? (/แก้|ลบลำดับ|คืนเลข|รับผิด|ยกเลิก/i.test(text) ? 'Human error' : 'Software')
        : /error|ผิดพลาด|ไม่ได้|ล้มเหลว|ล่ม|ค้าง|ไม่สามารถบันทึก/i.test(text)
          ? 'system error'
          : /กดผิด|เลือกผิด|กรอกผิด|ลงผิด|พิมพ์ผิด/i.test(text)
            ? 'Human error'
            : /เพิ่ม|ขอเปลี่ยน|ปรับปรุง|feature|request/i.test(text)
              ? 'Change Request'
              : 'Software',
      {
        title: actionLine || text,
        description: text,
      }
    );
    const quickFixes = [];
    if (numberedItems.length) {
      quickFixes.push('\u0E41\u0E22\u0E01\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E41\u0E01\u0E49\u0E44\u0E02\u0E2D\u0E2D\u0E01\u0E40\u0E1B\u0E47\u0E19 ' + numberedItems.length + ' \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23 \u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E43\u0E2B\u0E49\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E44\u0E14\u0E49\u0E40\u0E23\u0E47\u0E27\u0E02\u0E36\u0E49\u0E19');
      quickFixes.push('Check the receipt number and document number for each item');
    } else {
      quickFixes.push('List the items that must be corrected so the team can verify them quickly');
    }
    if (urls.length) {
      quickFixes.push('Open the attached link to review the original document page or routing path');
    }

    const clarifyingQuestions = [];
    if (!receiptNo) clarifyingQuestions.push('\u0E40\u0E25\u0E02\u0E23\u0E31\u0E1A\u0E17\u0E35\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E41\u0E01\u0E49\u0E44\u0E02\u0E04\u0E37\u0E2D\u0E40\u0E25\u0E02\u0E43\u0E14\u0E1A\u0E49\u0E32\u0E07?');
    if (!office) clarifyingQuestions.push('\u0E40\u0E1B\u0E47\u0E19\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E02\u0E2D\u0E07\u0E2A\u0E33\u0E19\u0E31\u0E01\u0E07\u0E32\u0E19\u0E2B\u0E23\u0E37\u0E2D\u0E40\u0E02\u0E15\u0E44\u0E2B\u0E19?');
    if (!occurredAt) clarifyingQuestions.push('\u0E40\u0E2B\u0E15\u0E38\u0E01\u0E32\u0E23\u0E13\u0E4C\u0E19\u0E35\u0E49\u0E40\u0E01\u0E34\u0E14\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E41\u0E25\u0E30\u0E40\u0E27\u0E25\u0E32\u0E43\u0E14?');

    const whenToEscalate = numberedItems.length > 1
      ? 'If multiple items must be corrected together or real receipt numbers are affected, forward to Dev to check database and document routing first'
      : 'If a real receipt number must be changed or document routing is affected, forward to Dev before making changes';

    return {
      reporter,
      occurred_at: occurredAt,
      office,
      receipt_no: receiptNo,
      urls,
      numbered_items: numberedItems,
      summary,
      problem_type: problemType,
      module_or_area: office || '',
      likely_cause: numberedItems.length
        ? 'จากข้อความพบว่ามีการขอแก้ไขเลขรับ/ลบลำดับ/คืนเลขรับหลายรายการ จึงน่าจะเป็นการลงรับผิดเรื่องหรือจัดลำดับหนังสือผิด'
        : 'The message mentions receipt numbers and document routing, so the receive record and document sequence should be checked in the system',
      quick_fixes: quickFixes,
      clarifying_questions: clarifyingQuestions,
      when_to_escalate: whenToEscalate,
    };
  }
