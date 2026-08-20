
BT.initApp('role-management.html', 'IT Support');

const ROLE_OPTIONS = [
  { value: 'helpdesk_admin', label: 'Helpdesk Admin', desc: 'เห็นทุกเมนูของ Helpdeck และกำหนดกฎได้' },
  { value: 'helpdesk_lead', label: 'Helpdesk Lead', desc: 'ดูภาพรวมงานและควบคุมการมองเห็นของทีมได้' },
  { value: 'helpdesk_agent', label: 'Helpdesk Agent', desc: 'เห็นเคส, วิเคราะห์, ส่งต่อ และใช้เครื่องมือปฏิบัติการ' },
  { value: 'helpdesk_viewer', label: 'Helpdesk Viewer', desc: 'ดูข้อมูลอ้างอิงและความรู้ได้แบบอ่านอย่างเดียว' },
  { value: 'odoo_sync', label: 'Odoo Sync', desc: 'ดูเฉพาะหน้าซิงก์และข้อมูลเชื่อมกับ Odoo' },
];

const MENU_OPTIONS = [
  'IT Dashboard',
  'Chat',
  'Chat V2',
  'AI Setting',
  'Ticket Kanban',
  'Helpdeck Knowledge',
  'Relationship Map',
  'User Management',
  'Team Management',
  'Project/Service',
  'Sub Project/Service',
  'Question Management',
  'Channel',
  'Project/Service - Dev',
  'Contact Customer',
  'Config Generate',
  'SLA',
  'Criteria',
  'Sub Criteria',
  'Project Management',
  'Flow Management',
];

const STORAGE_KEY = 'bt_role_visibility_rules';

function loadRules() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    return [];
  }
}

function saveRules(rules) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authHeaders() {
  const token = localStorage.getItem('bt_token') || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const employeeState = {
  all: [],
  selected: [],
};

const projectState = {
  all: [],
  selected: [],
};

let editingRuleIndex = null;

function employeeLabel(emp) {
  const name = emp?.name || emp?.code || '-';
  const code = emp?.code ? ` • ${emp.code}` : '';
  return `${name}${code}`;
}

function renderEmployeeChips() {
  const holder = document.getElementById('employeeChips');
  if (!holder) return;
  if (!employeeState.selected.length) {
    holder.innerHTML = '<span style="color:#64748b;font-size:0.82rem">ยังไม่ได้เลือกพนักงาน</span>';
    return;
  }
  holder.innerHTML = employeeState.selected.map((emp, idx) => `
    <span class="rm-chip-item">
      <span>${esc(employeeLabel(emp))}</span>
      <button type="button" aria-label="ลบพนักงาน" onclick="removeEmployee(${idx})">×</button>
    </span>
  `).join('');
}

function filterEmployees() {
  const term = (document.getElementById('employeeSearch')?.value || '').trim().toLowerCase();
  const select = document.getElementById('employeeSelect');
  if (!select) return;
  const list = employeeState.all.filter((emp) => {
    if (!term) return true;
    const hay = `${emp.name || ''} ${emp.code || ''} ${emp.email || ''}`.toLowerCase();
    return hay.includes(term);
  });
  select.innerHTML = list.length
    ? list.map((emp) => `<option value="${esc(emp.id)}">${esc(employeeLabel(emp))}${emp.active ? '' : ' (Inactive)'}</option>`).join('')
    : '<option value="">ไม่พบพนักงานที่ค้นหา</option>';
  if (list.length) select.value = list[0].id;
}

async function loadEmployees() {
  const select = document.getElementById('employeeSelect');
  if (!select) return;
  select.innerHTML = '<option value="">กำลังโหลดรายชื่อพนักงาน...</option>';
  try {
    const res = await fetch('/api/hd-master?table=hd_users', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'โหลดรายชื่อพนักงานไม่สำเร็จ');
    employeeState.all = (data.data || []).map((row) => ({
      id: row.id,
      code: row.code || '',
      name: row.name || '',
      email: (row.extra && row.extra.email) || '',
      active: row.active !== false,
    })).filter((emp) => emp.id);
    filterEmployees();
  } catch (err) {
    select.innerHTML = '<option value="">ไม่สามารถโหลดรายชื่อพนักงานได้</option>';
    BT.notify(err.message || 'โหลดรายชื่อพนักงานไม่สำเร็จ', 'warning');
  }
}

function addSelectedEmployee() {
  const select = document.getElementById('employeeSelect');
  if (!select || !select.value) return;
  const picked = employeeState.all.find((emp) => String(emp.id) === String(select.value));
  if (!picked) return;
  if (employeeState.selected.some((emp) => String(emp.id) === String(picked.id))) {
    BT.notify('พนักงานคนนี้ถูกเลือกไว้แล้ว', 'info');
    return;
  }
  employeeState.selected.push(picked);
  renderEmployeeChips();
}

function removeEmployee(index) {
  employeeState.selected.splice(index, 1);
  renderEmployeeChips();
}

function projectLabel(project) {
  const name = project?.name || project?.code || '-';
  const code = project?.code && project?.name ? ` • ${project.code}` : '';
  return `${name}${code}`;
}

function renderProjectChips() {
  const holder = document.getElementById('projectChips');
  if (!holder) return;
  if (!projectState.selected.length) {
    holder.innerHTML = '<span style="color:#92400e;font-size:0.82rem">ยังไม่ได้เลือกโครงการ</span>';
    return;
  }
  holder.innerHTML = projectState.selected.map((proj, idx) => `
    <span class="rm-chip-item project">
      <span>${esc(projectLabel(proj))}</span>
      <button type="button" aria-label="ลบโครงการ" onclick="removeProject(${idx})">×</button>
    </span>
  `).join('');
}

function filterProjects() {
  const term = (document.getElementById('projectSearch')?.value || '').trim().toLowerCase();
  const select = document.getElementById('projectSelect');
  if (!select) return;
  const list = projectState.all.filter((proj) => {
    if (!term) return true;
    const hay = `${proj.name || ''} ${proj.code || ''}`.toLowerCase();
    return hay.includes(term);
  });
  select.innerHTML = list.length
    ? list.map((proj) => `<option value="${esc(proj.id)}">${esc(projectLabel(proj))}${proj.active ? '' : ' (Inactive)'}</option>`).join('')
    : '<option value="">ไม่พบโครงการที่ค้นหา</option>';
  if (list.length) select.value = list[0].id;
}

async function loadProjects() {
  const select = document.getElementById('projectSelect');
  if (!select) return;
  select.innerHTML = '<option value="">กำลังโหลดรายชื่อโครงการ...</option>';
  try {
    const res = await fetch('/api/hd-master?table=hd_projects', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'โหลดรายชื่อโครงการไม่สำเร็จ');
    projectState.all = (data.data || []).map((row) => ({
      id: row.id,
      code: row.code || '',
      name: row.name || '',
      active: row.active !== false,
    })).filter((project) => project.id);
    filterProjects();
  } catch (err) {
    select.innerHTML = '<option value="">ไม่สามารถโหลดรายชื่อโครงการได้</option>';
    BT.notify(err.message || 'โหลดรายชื่อโครงการไม่สำเร็จ', 'warning');
  }
}

function addSelectedProject() {
  const select = document.getElementById('projectSelect');
  if (!select || !select.value) return;
  const picked = projectState.all.find((proj) => String(proj.id) === String(select.value));
  if (!picked) return;
  if (projectState.selected.some((proj) => String(proj.id) === String(picked.id))) {
    BT.notify('โครงการนี้ถูกเลือกไว้แล้ว', 'info');
    return;
  }
  projectState.selected.push(picked);
  renderProjectChips();
}

function removeProject(index) {
  projectState.selected.splice(index, 1);
  renderProjectChips();
}

function renderRoles() {
  const grid = document.getElementById('roleGrid');
  grid.innerHTML = ROLE_OPTIONS.map((role) => `
    <div class="rm-role">
      <div class="rm-role-name">${esc(role.label)}</div>
      <div class="rm-role-desc">${esc(role.desc)}</div>
      <div class="rm-badges">
        <span class="rm-chip blue">มองเห็นตามสิทธิ์</span>
        <span class="rm-chip slate">ปรับแผนกได้</span>
      </div>
    </div>
  `).join('');
}

function renderMenus() {
  const holder = document.getElementById('menuChecks');
  holder.innerHTML = MENU_OPTIONS.map((menu) => `
    <label class="rm-check">
      <input type="checkbox" value="${esc(menu)}" checked>
      <span>${esc(menu)}</span>
    </label>
  `).join('');
}

function selectedMenus() {
  return Array.from(document.querySelectorAll('#menuChecks input[type="checkbox"]:checked'))
    .map((el) => el.value);
}

function renderRules() {
  const rules = loadRules();
  const tbody = document.getElementById('rulesTbody');
  if (!rules.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;color:#64748b;padding:18px 12px">
          ยังไม่มี rule ที่บันทึกไว้
        </td>
      </tr>
    `;
    return;
  }
  tbody.innerHTML = rules.map((rule, idx) => `
    <tr>
      <td><strong>${esc(rule.roleLabel || rule.role)}</strong></td>
      <td>${esc(rule.department || '-')}</td>
      <td>${esc((rule.employees || []).map((emp) => emp.name || emp.code || '').filter(Boolean).join(', ') || '-')}</td>
      <td>${esc((rule.projects || []).map((proj) => proj.name || proj.code || '').filter(Boolean).join(', ') || '-')}</td>
      <td>${esc((rule.menus || []).join(', ') || '-')}</td>
      <td>
        <div class="rm-action-group">
          <button class="bt-btn bt-btn-secondary bt-btn-sm" onclick="editRule(${idx})">แก้ไข</button>
          <button class="bt-btn bt-btn-secondary bt-btn-sm" onclick="deleteRule(${idx})">ลบ</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function resetForm() {
  editingRuleIndex = null;
  document.getElementById('roleSelect').value = 'helpdesk_lead';
  document.getElementById('deptInput').value = '';
  document.getElementById('employeeSearch').value = '';
  document.getElementById('projectSearch').value = '';
  document.querySelectorAll('#menuChecks input[type="checkbox"]').forEach((el) => { el.checked = true; });
  employeeState.selected = [];
  projectState.selected = [];
  filterEmployees();
  renderEmployeeChips();
  filterProjects();
  renderProjectChips();
  document.getElementById('addRuleBtn').innerHTML = '+ เพิ่ม Rule';
  document.getElementById('saveSummaryBtn').style.display = '';
}

function hydrateForm(rule) {
  document.getElementById('roleSelect').value = rule.role || 'helpdesk_lead';
  document.getElementById('deptInput').value = rule.department || '';

  employeeState.selected = Array.isArray(rule.employees) ? rule.employees.map((emp) => ({
    id: emp.id,
    name: emp.name || '',
    code: emp.code || '',
    email: emp.email || '',
  })) : [];
  projectState.selected = Array.isArray(rule.projects) ? rule.projects.map((proj) => ({
    id: proj.id,
    name: proj.name || '',
    code: proj.code || '',
  })) : [];

  const menuSet = new Set(rule.menus || []);
  document.querySelectorAll('#menuChecks input[type="checkbox"]').forEach((el) => {
    el.checked = menuSet.has(el.value);
  });

  document.getElementById('employeeSearch').value = '';
  document.getElementById('projectSearch').value = '';
  filterEmployees();
  filterProjects();
  renderEmployeeChips();
  renderProjectChips();
  document.getElementById('addRuleBtn').innerHTML = 'บันทึกการแก้ไข';
  document.getElementById('saveSummaryBtn').style.display = 'none';
}

function editRule(index) {
  const rules = loadRules();
  const rule = rules[index];
  if (!rule) return;
  editingRuleIndex = index;
  hydrateForm(rule);
  BT.notify('โหลด rule มาให้แก้ไขแล้ว', 'info');
}

function deleteRule(index) {
  const rules = loadRules();
  rules.splice(index, 1);
  saveRules(rules);
  renderRules();
}

function addRule() {
  const role = document.getElementById('roleSelect').value;
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === role)?.label || role;
  const department = document.getElementById('deptInput').value.trim();
  const menus = selectedMenus();
  if (!role) {
    BT.notify('กรุณาเลือก Role', 'warning');
    return;
  }
  const rules = loadRules();
  const payload = {
    role,
    roleLabel,
    department,
    employees: employeeState.selected.map((emp) => ({
      id: emp.id,
      name: emp.name,
      code: emp.code,
      email: emp.email,
    })),
    projects: projectState.selected.map((proj) => ({
      id: proj.id,
      name: proj.name,
      code: proj.code,
    })),
    menus,
    created_at: new Date().toISOString(),
  };
  if (editingRuleIndex !== null && rules[editingRuleIndex]) {
    payload.created_at = rules[editingRuleIndex].created_at || payload.created_at;
    payload.updated_at = new Date().toISOString();
    rules[editingRuleIndex] = payload;
    editingRuleIndex = null;
  } else {
    rules.unshift(payload);
  }
  saveRules(rules);
  renderRules();
  resetForm();
  BT.notify('บันทึก Rule visibility แล้ว', 'success');
}

function initRoleManagementPage() {
  const roleSelect = document.getElementById('roleSelect');
  roleSelect.innerHTML = ROLE_OPTIONS.map((role) => `<option value="${esc(role.value)}">${esc(role.label)}</option>`).join('');
  roleSelect.value = 'helpdesk_lead';

  renderRoles();
  renderMenus();
  renderRules();
  renderEmployeeChips();
  renderProjectChips();
  loadEmployees();
  loadProjects();

  document.getElementById('addRuleBtn').addEventListener('click', addRule);
  document.getElementById('resetRuleBtn').addEventListener('click', resetForm);
  document.getElementById('addEmployeeBtn').addEventListener('click', addSelectedEmployee);
  document.getElementById('employeeSearch').addEventListener('input', filterEmployees);
  document.getElementById('addProjectBtn').addEventListener('click', addSelectedProject);
  document.getElementById('projectSearch').addEventListener('input', filterProjects);
  document.getElementById('saveSummaryBtn').addEventListener('click', () => {
    BT.notify('บันทึก rule เรียบร้อย', 'success');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRoleManagementPage);
} else {
  initRoleManagementPage();
}

