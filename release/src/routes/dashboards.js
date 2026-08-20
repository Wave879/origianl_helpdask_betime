/**
 * routes/dashboards.js
 * GET /dashboard/staff, /manager, /ceo, /projects, /secretary, /finance, /docs, /knowledge, /hr
 */

import { pgQuery, pgFirst } from '../db.js';
import { json } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

function parseEmployeeKnowledgeMeta(row) {
  const content = String(row?.content || '');
  const pickContentLineValue = (text, label) => {
    const prefix = `${label}:`;
    for (const line of String(text || '').split(/\r?\n/)) {
      const trimmed = String(line || '').trim();
      if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
    }
    return '';
  };
  const COMPANY_LABEL = 'บริษัท';
  const DEPARTMENT_LABEL = 'ฝ่าย';
  const POSITION_LABEL = 'ตำแหน่ง';
  const LEVEL_LABEL = 'ระดับ';
  const AFFILIATION_LABEL = 'สังกัด';
  const MANAGER_LABEL = 'หัวหน้า';
  const GENDER_LABEL = 'เพศ';
  const NICKNAME_LABEL = 'ชื่อเล่น';
  const FULLNAME_LABEL = 'ชื่อเต็ม';
  const EMAIL1_LABEL = 'อีเมลบริษัท';
  const EMAIL2_LABEL = 'อีเมลบริษัท2';
  const UNKNOWN = 'ไม่ระบุ';
  return {
    company: pickContentLineValue(content, COMPANY_LABEL) || UNKNOWN,
    department: pickContentLineValue(content, DEPARTMENT_LABEL) || UNKNOWN,
    position: pickContentLineValue(content, POSITION_LABEL) || UNKNOWN,
    level: pickContentLineValue(content, LEVEL_LABEL) || UNKNOWN,
    affiliation: pickContentLineValue(content, AFFILIATION_LABEL) || UNKNOWN,
    manager: pickContentLineValue(content, MANAGER_LABEL) || UNKNOWN,
    gender: pickContentLineValue(content, GENDER_LABEL) || UNKNOWN,
    nickname: pickContentLineValue(content, NICKNAME_LABEL) || '',
    full_name: pickContentLineValue(content, FULLNAME_LABEL) || '',
    email1: pickContentLineValue(content, EMAIL1_LABEL) || '',
    email2: pickContentLineValue(content, EMAIL2_LABEL) || '',
  };
}

function uniqueFacetCount(rows, key) {
  const values = new Set();
  for (const row of rows) {
    const value = String(row?.[key] || '').trim();
    if (value && value !== 'ไม่ระบุ' && value !== '-') values.add(value);
  }
  return values.size;
}

export async function handleDashboards(path, method, request, env) {
  if (method !== 'GET') return null;

  if (path === '/dashboard/staff') {
    const s = await requireAuth(request, env);
    const u = s.user_id;
    const [tot, done, ov, ot, tasks, evts] = await Promise.all([
      pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE assigned_to=$1 AND status!='Completed'`, [u]),
      pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE assigned_to=$1 AND status='Completed'`, [u]),
      pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE assigned_to=$1 AND status!='Completed' AND deadline::date<current_date`, [u]),
      pgFirst(env, `SELECT COALESCE(SUM(ot_hours),0) h FROM ot_claims WHERE employee=$1 AND to_char(ot_date::date,'YYYY-MM')=to_char(now(),'YYYY-MM')`, [u]),
      pgQuery(env, `SELECT id,task_name,priority,deadline,status FROM tasks WHERE assigned_to=$1 AND status!='Completed' ORDER BY deadline ASC LIMIT 5`, [u]),
      pgQuery(env, `SELECT id,title,start_datetime FROM calendar_events WHERE start_datetime::date=current_date ORDER BY start_datetime`),
    ]);
    return json({ ok:true, my_tasks_total:tot?.n||0, my_tasks_done:done?.n||0, my_tasks_overdue:ov?.n||0, my_ot_hours:ot?.h||0, recent_tasks:tasks, today_events:evts.length, events:evts, full_name:s.full_name });
  }

  if (path === '/dashboard/manager') {
    const s = await requireAuth(request, env);
    const [proj, tasks, ot, members] = await Promise.all([
      pgQuery(env, `SELECT id,project_name,progress,risk_level,deadline FROM projects WHERE status='Active' ORDER BY deadline ASC LIMIT 8`),
      pgQuery(env, `SELECT t.id,t.task_name,t.priority,t.deadline,t.status,u.full_name assignee FROM tasks t LEFT JOIN users u ON t.assigned_to=u.id WHERE t.status!='Completed' ORDER BY t.deadline ASC LIMIT 10`),
      pgQuery(env, `SELECT o.*,u.full_name FROM ot_claims o LEFT JOIN users u ON o.employee=u.id WHERE o.status='Draft' ORDER BY o.created_at DESC LIMIT 5`),
      pgQuery(env, `SELECT u.id,u.full_name,u.department,COUNT(t.id)::int task_count FROM users u LEFT JOIN tasks t ON t.assigned_to=u.id AND t.status!='Completed' WHERE u.role='staff' GROUP BY u.id LIMIT 10`),
    ]);
    return json({ ok:true, projects:proj, tasks, pending_ot:ot, team_members:members });
  }

  if (path === '/dashboard/ceo') {
    const s = await requireAuth(request, env);
    const [ap, ot2, uu, inv] = await Promise.all([
      pgFirst(env, `SELECT COUNT(*)::int n FROM projects WHERE status='Active'`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed'`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM users WHERE is_active=1`),
      pgFirst(env, `SELECT COALESCE(SUM(amount),0) total FROM invoices WHERE status='Unpaid'`),
    ]);
    const projList = await pgQuery(env, `SELECT id,project_name,progress,risk_level,deadline FROM projects ORDER BY created_at DESC LIMIT 6`);
    return json({ ok:true, active_projects:ap?.n||0, open_tasks:ot2?.n||0, total_users:uu?.n||0, outstanding_invoices:inv?.total||0, projects:projList });
  }

  if (path === '/dashboard/projects') {
    await requireAuth(request, env);
    const [ap, ot, ov, mt, projs, tasks] = await Promise.all([
      pgFirst(env, `SELECT COUNT(*)::int n FROM projects WHERE status='Active'`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed'`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed' AND deadline::date<current_date`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM calendar_events WHERE to_char(start_datetime::date,'YYYY-MM')=to_char(now(),'YYYY-MM') AND event_type='Meeting'`),
      pgQuery(env, `SELECT id,project_name,progress,risk_level,deadline FROM projects WHERE status='Active' ORDER BY deadline ASC LIMIT 6`),
      pgQuery(env, `SELECT id,task_name,priority,deadline FROM tasks WHERE status!='Completed' AND priority IN ('Critical','High') ORDER BY deadline ASC LIMIT 8`),
    ]);
    return json({ ok:true, active_projects:ap?.n||0, open_tasks:ot?.n||0, overdue_tasks:ov?.n||0, meetings_this_month:mt?.n||0, projects:projs, urgent_tasks:tasks });
  }

  if (path === '/dashboard/secretary') {
    await requireAuth(request, env);
    const today = new Date().toISOString().slice(0,10);
    const weekEnd = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const monthStart = today.slice(0,7)+'-01';
    const [td, wk, mo, todayEvts, weekEvts] = await Promise.all([
      pgFirst(env, `SELECT COUNT(*)::int n FROM calendar_events WHERE start_datetime::date=$1`, [today]),
      pgFirst(env, `SELECT COUNT(*)::int n FROM calendar_events WHERE start_datetime::date>$1 AND start_datetime::date<=$2`, [today,weekEnd]),
      pgFirst(env, `SELECT COUNT(*)::int n FROM calendar_events WHERE start_datetime>=$1`, [monthStart]),
      pgQuery(env, `SELECT id,title,start_datetime,end_datetime,location FROM calendar_events WHERE start_datetime::date=$1 ORDER BY start_datetime`, [today]),
      pgQuery(env, `SELECT id,title,start_datetime,location FROM calendar_events WHERE start_datetime::date>$1 AND start_datetime::date<=$2 ORDER BY start_datetime LIMIT 10`, [today,weekEnd]),
    ]);
    return json({ ok:true, today_count:td?.n||0, week_count:wk?.n||0, month_count:mo?.n||0, pending_bookings:0, today_events:todayEvts, week_events:weekEvts });
  }

  if (path === '/dashboard/finance') {
    await requireAuth(request, env);
    const [ua, ti, po, ohm, unpaidList, otList] = await Promise.all([
      pgFirst(env, `SELECT COALESCE(SUM(amount),0) total FROM invoices WHERE status='Unpaid'`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM invoices`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM ot_claims WHERE status='Draft'`),
      pgFirst(env, `SELECT COALESCE(SUM(ot_hours),0) h FROM ot_claims WHERE to_char(ot_date::date,'YYYY-MM')=to_char(now(),'YYYY-MM')`),
      pgQuery(env, `SELECT id,invoice_no,vendor,amount,due_date FROM invoices WHERE status='Unpaid' ORDER BY due_date ASC LIMIT 8`),
      pgQuery(env, `SELECT o.*,u.full_name FROM ot_claims o LEFT JOIN users u ON o.employee=u.id WHERE o.status='Draft' ORDER BY o.created_at DESC LIMIT 8`),
    ]);
    return json({ ok:true, unpaid_amount:ua?.total||0, total_invoices:ti?.n||0, pending_ot:po?.n||0, ot_hours_month:ohm?.h||0, unpaid_invoices:unpaidList, pending_ot_list:otList });
  }

  if (path === '/dashboard/docs') {
    await requireAuth(request, env);
    return json({ ok:true, ocr_count:0, draft_count:0, contract_count:0, avg_compliance:null });
  }

  if (path === '/dashboard/knowledge') {
    await requireAuth(request, env);
    const [ac, lc, ec, arts, employeeRows] = await Promise.all([
      pgFirst(env, `SELECT COUNT(*)::int n FROM knowledge_articles`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM knowledge_articles WHERE category='Lesson Learned'`),
      pgQuery(env, `SELECT id,title,category,created_at FROM knowledge_articles ORDER BY created_at DESC LIMIT 8`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM knowledge_articles WHERE category='Employee Knowledge'`),
      pgQuery(env, `SELECT id,title,content,category,tags,created_at FROM knowledge_articles WHERE category='Employee Knowledge' ORDER BY created_at DESC`),
    ]);
    const employeeArticles = employeeRows.map((row) => {
      const meta = parseEmployeeKnowledgeMeta(row);
      return {
        id: row.id,
        title: row.title,
        category: row.category,
        created_at: row.created_at,
        tags: row.tags || '',
        company: meta.company,
        department: meta.department,
        position: meta.position,
        level: meta.level,
        affiliation: meta.affiliation,
        manager: meta.manager,
        gender: meta.gender,
        nickname: meta.nickname,
        full_name: meta.full_name,
        email1: meta.email1,
        email2: meta.email2,
      };
    });
    const employeeStats = {
      companies: uniqueFacetCount(employeeArticles, 'company'),
      departments: uniqueFacetCount(employeeArticles, 'department'),
      positions: uniqueFacetCount(employeeArticles, 'position'),
    };
    return json({
      ok:true,
      article_count:ac?.n||0,
      lesson_count:lc?.n||0,
      employee_count:ec?.n||0,
      search_today:0,
      chat_count:0,
      recent_articles:arts,
      employee_articles:employeeArticles,
      employee_stats: employeeStats,
    });
  }

  if (path === '/dashboard/hr') {
    await requireAuth(request, env);
    const [tu, au, users, wl] = await Promise.all([
      pgFirst(env, `SELECT COUNT(*)::int n FROM users`),
      pgFirst(env, `SELECT COUNT(*)::int n FROM users WHERE is_active=1`),
      pgQuery(env, `SELECT id,full_name,department,role,is_active FROM users WHERE is_active=1 ORDER BY full_name LIMIT 20`),
      pgQuery(env, `SELECT u.id,u.full_name,COUNT(t.id)::int task_count FROM users u LEFT JOIN tasks t ON t.assigned_to=u.id AND t.status!='Completed' WHERE u.is_active=1 GROUP BY u.id ORDER BY task_count DESC LIMIT 10`),
    ]);
    const depts = await pgFirst(env, `SELECT COUNT(DISTINCT department)::int n FROM users WHERE department!='' AND department IS NOT NULL`);
    const totalTasks = await pgFirst(env, `SELECT COUNT(*)::int n FROM tasks WHERE status!='Completed'`);
    return json({ ok:true, total_users:tu?.n||0, active_users:au?.n||0, dept_count:depts?.n||0, total_open_tasks:totalTasks?.n||0, users, workload:wl });
  }

  return null;
}
