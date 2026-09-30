// Run with PLAYWRIGHT_MODULE and optional CHROMIUM_EXECUTABLE pointing to local installations.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const pages = path.resolve(__dirname, '../../../frontend/pages');
  const html = fs.readFileSync(path.join(pages, 'role-helpdesk.html'), 'utf8')
    .replace(/<script\s+src=[^>]*><\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  const css = fs.readFileSync(path.join(pages, 'assets/betime_solution/css/betime.css'), 'utf8');
  const project = { id: 'project', code: 'TEST', name: 'Test Project', extra: '{}', updated_at: '2026-09-30T00:00:00Z' };
  const other = { ...project, id: 'other', code: 'OTHER', name: 'Other Project' };
  const role = (id, projectId, label) => ({ id, active: true, extra: JSON.stringify({ project_id: projectId, person_id: 'person', role_type: label }) });
  const fixture = { complete: true, can_manage_roles: true,
    system_users: [{ id: 'person', full_name: 'Test Support', email: 'person@example.test', job_title: 'IT Support', is_active: 1 }],
    tables: { hd_users: [], hd_positions: [], hd_projects: [project, other], hd_teams: [], hd_projects_dev: [],
      hd_project_member_roles: [role('first', 'project', 'IT Support'), role('other-role', 'other', 'Requester')], hd_main_team_project: [] } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const width of [1366, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ contentType: 'text/html', body: '<html></html>' }) : route.abort());
      await page.goto('http://role.test');
      const setup = `<script>
        window.BT={initApp(){}};
        window.fixture=${JSON.stringify(fixture)};
        window.calls=[]; window.loadMode='error';
        window.fetch=async (url, options={})=>{
          calls.push({url,method:options.method||'GET'});
          if(url.includes('hd-role-context')) {
            if(loadMode==='error') return new Response(JSON.stringify({ok:false,error:'Test load failure'}),{status:503});
            if(loadMode==='incomplete') return new Response(JSON.stringify({ok:true,data:{complete:true,system_users:[]}}));
            return new Response(JSON.stringify({ok:true,data:fixture}));
          }
          if(url.includes('hd-project-roles')) return new Response(JSON.stringify({ok:true,data:{
            project:{...fixture.tables.hd_projects[0],updated_at:'2026-09-30T01:00:00Z',extra:JSON.stringify({project_support_ids:['person'],project_requester_ids:['person']})},
            project_member_roles:['IT Support','Requester'].map((label,i)=>({id:'saved'+i,active:true,extra:JSON.stringify({project_id:'project',person_id:'person',role_type:label})}))
          }}));
          throw new Error('Unexpected request: '+url);
        };
      </script>`;
      await page.setContent(setup + '<style>' + css + '</style>' + html);
      await page.waitForFunction(() => state.loadStatus === 'error');
      assert.equal(await page.locator('#roleContent').isHidden(), true);
      assert.equal(await page.locator('#retryRoleLoadBtn').isVisible(), true);
      assert.equal(await page.evaluate(() => calls.length), 1);
      await page.evaluate(() => { loadMode = 'ok'; });
      await page.locator('#retryRoleLoadBtn').click();
      await page.waitForFunction(() => state.loadStatus === 'ready');
      assert.equal(await page.locator('#peopleTbody tr[data-employee-id]').count(), 1);
      await page.evaluate(async () => { loadMode = 'incomplete'; try { await loadAllData(); } catch {} });
      assert.equal(await page.locator('#peopleTbody tr[data-employee-id]').count(), 1);
      assert.equal(await page.locator('#addPersonBtn').isHidden(), true);
      assert.equal(await page.evaluate(async () => {
        const count = calls.length;
        try { await saveProjectRolesRequest(state.projects[0], 'PUT', {}); return false; }
        catch { return calls.length === count; }
      }), true);
      await page.evaluate(() => { loadMode = 'ok'; });
      await page.locator('#retryRoleLoadBtn').click();
      await page.waitForFunction(() => state.loadStatus === 'ready');
      const results = await page.evaluate(async () => {
        const count = calls.length;
        const otherBefore = JSON.stringify(state.projects.find(p => p.id === 'other'));
        await saveEmployeeProjectMembership(state.people[0], state.projects.find(p => p.id === 'project'), 'requester');
        return { requests: calls.slice(count), otherUnchanged: otherBefore === JSON.stringify(state.projects.find(p => p.id === 'other')),
          otherRole: state.projectMemberRoles.some(r => r.id === 'other-role'),
          config: getProjectConfig(state.projects.find(p => p.id === 'project')),
          updatedAt: state.projects.find(p => p.id === 'project').updatedAt };
      });
      assert.equal(results.requests.length, 1);
      assert.equal(results.requests[0].method, 'PATCH');
      assert.equal(results.otherUnchanged, true);
      assert.equal(results.otherRole, true);
      assert.deepEqual(results.config.requesterIds, ['person']);
      assert.equal(results.updatedAt, '2026-09-30T01:00:00Z');
      await page.evaluate(() => openProjectModal('project'));
      assert.equal(await page.locator('#projectModal .project-access-table').innerText().then(t => t.includes('Test Support')), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.evaluate(async () => {
        closeAllModals();
        fixture.system_users = [];
        for (const key of Object.keys(fixture.tables)) fixture.tables[key] = [];
        await loadAllData();
      });
      assert.equal(await page.evaluate(() => state.loadStatus), 'ready');
      assert.equal(await page.locator('#roleContent').isVisible(), true);
      assert.equal(await page.locator('#peopleTbody tr[data-employee-id]').count(), 0);
      assert.deepEqual(errors, []);
      console.log(`PASS browser ${width}px: failure, retry, incomplete data protection, single save request, preserved other project`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
