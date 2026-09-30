// Isolated integration checks. ROLE_TEST_DATABASE must be a disposable database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { saveProjectRoles, handleRoleManagement, canManageRoles } from '../src/routes/role-management.js';
import { handleMasterData, loadRoleContext, ROLE_CONTEXT_TABLES } from '../src/routes/master-data.js';

const database = process.env.ROLE_TEST_DATABASE;
assert.match(database || '', /^betime_role_test_[a-z0-9_]+$/);
const url = new URL(process.env.PG_URL);
url.pathname = '/' + database;
const env = { PG_URL: url.toString() };
const client = new pg.Client({ connectionString: env.PG_URL });
await client.connect();
const query = (sql, args = []) => client.query(sql, args);
try {
  await query(`CREATE TABLE hd_master (id TEXT PRIMARY KEY,table_name TEXT,code TEXT,name TEXT,extra TEXT DEFAULT '{}',active BOOLEAN DEFAULT true,sort_order INTEGER DEFAULT 0,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE users (id TEXT PRIMARY KEY,full_name TEXT,email TEXT,username TEXT,role TEXT,department TEXT,tags TEXT DEFAULT '[]',access_mode TEXT DEFAULT 'role',access_json TEXT DEFAULT '[]',account_type TEXT DEFAULT 'permanent',user_expires_at TIMESTAMPTZ,is_active INTEGER DEFAULT 1);
    CREATE TABLE sessions (id TEXT PRIMARY KEY,user_id TEXT,expires_at TIMESTAMPTZ);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY,actor_user_id TEXT,actor_email TEXT,action TEXT,details TEXT);
    INSERT INTO users (id,full_name,email,username,role) VALUES ('account','Support person','person@example.test','person','staff'),('admin','Admin','admin@example.test','admin','admin');
    INSERT INTO sessions VALUES ('staff-session','account',now()+interval '1 hour'),('admin-session','admin',now()+interval '1 hour');
    INSERT INTO hd_master (id,table_name,code,name) VALUES ('project','hd_projects','TEST','Test project');`);
  for (let n = 1; n <= 3; n++) await query("INSERT INTO hd_master (id,table_name,name,extra) VALUES ($1,'hd_users','Support person',$2)",
    ['dup' + n, JSON.stringify({ email: n === 2 ? ' PERSON@example.test ' : 'person@example.test', source: 'manual', position_name: 'IT Support', job_title: n === 3 ? 'Helpdesk' : '' })]);
  await query("INSERT INTO hd_master (id,table_name,extra) VALUES ('legacy-role','hd_project_member_roles',$1)",
    [JSON.stringify({ project_id: 'project', person_id: 'dup3', role_type: 'Requester' })]);
  await query('BEGIN');
  await query(fs.readFileSync(fileURLToPath(new URL('../migrations/sql/014_role_user_identity.sql', import.meta.url)), 'utf8'));
  await query('COMMIT');
  assert.equal((await query('SELECT * FROM hd_user_merge_archive')).rowCount, 2);
  assert.equal((await query("SELECT * FROM hd_master WHERE table_name='hd_users' AND extra::jsonb->>'merged_into' IS NULL")).rowCount, 1);
  assert.equal((await query("SELECT extra::jsonb->>'person_id' id FROM hd_master WHERE id='legacy-role'")).rows[0].id, 'dup1');
  await assert.rejects(query("INSERT INTO hd_master(id,table_name,extra) VALUES ('again','hd_users',$1)", [JSON.stringify({ email: 'PERSON@example.test' })]), e => e.code === '23505');
  console.log('PASS duplicate migration: archive, preserved role, unique email');

  const request = (token, method, body, path='/api/hd-master?table=hd_users') => new Request('http://test'+path,
    { method, headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const expectStatus = async (work, code) => {
    try { const response = await work(); assert.equal(response.status, code); }
    catch (error) { if (!(error instanceof Response)) throw error; assert.equal(error.status, code); }
  };
  await expectStatus(() => handleMasterData('/hd-master','POST',request('staff-session','POST',{}),env),403);
  await expectStatus(() => handleMasterData('/hd-master/project','PUT',request('staff-session','PUT',{},'/api/hd-master/project'),env),403);
  await expectStatus(() => handleRoleManagement('/hd-project-roles/project','PUT',request('staff-session','PUT',{}),env),403);
  await expectStatus(() => handleRoleManagement('/hd-project-roles/project','PUT',request('invalid','PUT',{}),env),401);
  assert.ok(canManageRoles({role:'admin'})); assert.ok(!canManageRoles({role:'staff'}));
  const duplicate = await handleMasterData('/hd-master','POST',request('admin-session','POST',{name:'Other',extra:JSON.stringify({email:'Person@example.test'})}),env);
  assert.equal((await duplicate.json()).existing, true);
  const simultaneous = await Promise.all(Array.from({length:3}, () => handleMasterData('/hd-master','POST',request('admin-session','POST',{name:'New',extra:JSON.stringify({email:'new@example.test',source:'manual'})}),env).then(r=>r.json())));
  assert.equal(new Set(simultaneous.map(r=>r.id)).size,1);
  console.log('PASS API authorization and concurrent duplicate prevention');

  await query('ALTER TABLE users ADD COLUMN job_title TEXT, ADD COLUMN must_change_password INTEGER DEFAULT 0');
  await query("INSERT INTO hd_master (id,table_name,name) VALUES ('unused-sla','hd_sla','Not used on Role')");
  const roleContext = await loadRoleContext(env);
  assert.equal(roleContext.complete, true);
  assert.deepEqual(Object.keys(roleContext.tables), ROLE_CONTEXT_TABLES);
  assert.equal(roleContext.tables.hd_sla, undefined);
  assert.equal(roleContext.tables.hd_users.filter(row => row.id.startsWith('dup')).length, 1);
  assert.equal(roleContext.system_users.length, 2);
  await query('ALTER TABLE users RENAME COLUMN job_title TO unavailable_job_title');
  await assert.rejects(loadRoleContext(env));
  const failedContext = await handleMasterData('/hd-role-context', 'GET',
    new Request('http://test/api/hd-role-context', { headers: { Authorization: 'Bearer admin-session' } }), env);
  assert.equal(failedContext.status, 503);
  assert.equal((await failedContext.json()).ok, false);
  await query('ALTER TABLE users RENAME COLUMN unavailable_job_title TO job_title');
  assert.equal((await loadRoleContext(env)).complete, true);
  const realFetch = globalThis.fetch;
  await query(`UPDATE hd_master SET extra='{"source_service_id":123}' WHERE id='project'`);
  try {
    globalThis.fetch = async () => { throw new Error('Simulated Odoo outage'); };
    await assert.rejects(loadRoleContext(env), /Odoo/);
  } finally {
    globalThis.fetch = realFetch;
    await query("UPDATE hd_master SET extra='{}' WHERE id='project'");
  }
  console.log('PASS focused role context, explicit failure and recovery');

  const actor={user_id:'admin',email:'admin@example.test',role:'admin'};
  const cfg={pmId:'',supportIds:['account'],devIds:[],requesterIds:['account']};
  const saved = await saveProjectRoles(env,actor,'project','PUT',cfg);
  assert.equal(saved.project.id, 'project');
  assert.ok(saved.project.updated_at);
  assert.equal(saved.project_member_roles.length, 2);
  assert.deepEqual(saved.project_member_roles.map(row => JSON.parse(row.extra).role_type).sort(), ['IT Support', 'Requester']);
  const snapshot = async () => ({
    project:(await query("SELECT extra FROM hd_master WHERE id='project'")).rows[0].extra,
    roles:(await query("SELECT id,extra FROM hd_master WHERE table_name='hd_project_member_roles' ORDER BY id")).rows,
  });
  const before=await snapshot();
  // Force an actual database failure after the old memberships have been deleted.
  await query(`CREATE FUNCTION reject_dev() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.table_name='hd_project_member_roles' AND NEW.extra::jsonb->>'role_type'='Dev' THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_dev BEFORE INSERT ON hd_master FOR EACH ROW EXECUTE FUNCTION reject_dev();`);
  await assert.rejects(saveProjectRoles(env,actor,'project','PUT',{...cfg,devIds:['account']}));
  assert.deepEqual(await snapshot(),before);
  await assert.rejects(saveProjectRoles(env,actor,'project','PUT',{...cfg,supportIds:['missing']}));
  assert.deepEqual(await snapshot(),before);
  await query('DROP TRIGGER reject_dev ON hd_master');
  await Promise.all([
    saveProjectRoles(env,actor,'project','PATCH',{personId:'account',role:'dev',action:'add'}),
    saveProjectRoles(env,actor,'project','PATCH',{personId:'admin',role:'support',action:'add'}),
  ]);
  let result=JSON.parse((await snapshot()).project);
  assert.deepEqual(result.project_dev_ids,['account']);
  assert.deepEqual(result.project_support_ids.sort(),['account','admin']);
  await saveProjectRoles(env,actor,'project','PATCH',{personId:'account',role:'support',action:'remove'});
  result=JSON.parse((await snapshot()).project);
  assert.deepEqual(result.project_support_ids,['admin']);
  assert.deepEqual(result.project_requester_ids,['account']);
  await expectStatus(()=>saveProjectRoles(env,actor,'project','PUT',{...cfg,expectedUpdatedAt:'2000-01-01'}),409);
  console.log('PASS atomic rollback, concurrency, preserved roles and stale-save rejection');

  const html=fs.readFileSync(process.env.ROLE_TEST_HTML || fileURLToPath(new URL('../../../frontend/pages/role-helpdesk.html',import.meta.url)),'utf8');
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
  const extract=(start,end)=>html.slice(html.indexOf('    function '+start),html.indexOf('    function '+end,html.indexOf('    function '+start)));
  const context={cleanText:v=>String(v??'').trim(),normalizeKey:v=>String(v??'').trim().toLowerCase(),parseExtra:JSON.parse,
    uid:()=> 'fallback',uniq:values=>[...new Set(values.filter(Boolean))],sortPeople:v=>v};
  vm.createContext(context);
  vm.runInContext(extract('normalizeEmployeeRecord(', 'normalizeProjectRecord(')+extract('personIdentityKeys(', 'sortProjects(')+extract('isHelpdeskEligibleEmployee(', 'getHelpdeskEligiblePeople('),context);
  const account=context.normalizeSystemUserRecord({id:'account',full_name:'Person',email:'person@example.test',job_title:'IT Support',role:'staff',is_active:1});
  const profiles=[1,2,3].map(n=>context.normalizeEmployeeRecord({id:'dup'+n,name:'Person',extra:JSON.stringify({email:'PERSON@example.test',source:'manual',position_name:'IT Support',job_title:'Helpdesk'})}));
  const merged=context.mergePeopleSources([account],profiles);
  assert.equal(merged.length,1); assert.equal(merged[0].jobTitle,'IT Support');
  assert.equal(context.isHelpdeskEligibleEmployee(merged[0]),true);
  assert.equal(context.personIdentityKeys(merged[0]).includes('dup3'),true);
  const other=context.normalizeSystemUserRecord({id:'different',full_name:'Person',email:'other@example.test',job_title:'IT Support'});
  assert.equal(context.mergePeopleSources([account,other],profiles).length,2);
  console.log('PASS real frontend: Pirapon-style duplicate precedence, aliases and same-name accounts');
} finally { await client.end(); }
