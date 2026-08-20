/**
 * routes/projects.js
 * CRUD /projects, CRUD /tasks, CRUD /ot-claims
 */

import { pgQuery, pgFirst } from '../db.js';
import { json, err, uid } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

export async function handleProjects(path, method, request, env) {
  const url = new URL(request.url);

  /* ── PROJECTS ─────────────────────────────────────────── */
  if (path === '/projects') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT * FROM projects ORDER BY updated_at DESC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); const id='proj_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO projects (id,project_name,status,progress,risk_level,deadline,owner,description,budget) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,b.project_name,b.status||'Active',b.progress||0,b.risk_level||'Low',b.deadline||null,s.user_id,b.description||'',b.budget||0]); return json({ok:true,id}); }
  }
  if (path.startsWith('/projects/')) {
    const id=path.split('/')[2];
    if (method === 'GET') { await requireAuth(request,env); const r=await pgFirst(env,`SELECT * FROM projects WHERE id=$1`,[id]); return r?json({ok:true,data:r}):err('Not found',404); }
    if (method === 'PUT') { await requireAuth(request,env); const b=await request.json(); await pgQuery(env,`UPDATE projects SET project_name=$1,status=$2,progress=$3,risk_level=$4,deadline=$5,description=$6,budget=$7,updated_at=now() WHERE id=$8`,[b.project_name,b.status,b.progress,b.risk_level,b.deadline,b.description,b.budget,id]); return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM projects WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── TASKS ────────────────────────────────────────────── */
  if (path === '/tasks') {
    if (method === 'GET') { const s=await requireAuth(request,env); const mine=url.searchParams.get('mine'); const r=mine?await pgQuery(env,`SELECT t.*,u.full_name assignee_name FROM tasks t LEFT JOIN users u ON t.assigned_to=u.id WHERE t.assigned_to=$1 ORDER BY t.deadline ASC`,[s.user_id]):await pgQuery(env,`SELECT t.*,u.full_name assignee_name FROM tasks t LEFT JOIN users u ON t.assigned_to=u.id ORDER BY t.updated_at DESC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); const id='task_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO tasks (id,task_name,project,assigned_to,status,priority,deadline,description,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,b.task_name,b.project||null,b.assigned_to||s.user_id,b.status||'Open',b.priority||'Medium',b.deadline||null,b.description||'',s.user_id]); return json({ok:true,id}); }
  }
  if (path.startsWith('/tasks/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { await requireAuth(request,env); const b=await request.json(); await pgQuery(env,`UPDATE tasks SET task_name=$1,status=$2,priority=$3,deadline=$4,description=$5,assigned_to=$6,updated_at=now() WHERE id=$7`,[b.task_name,b.status,b.priority,b.deadline,b.description,b.assigned_to,id]); return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM tasks WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── OT CLAIMS ────────────────────────────────────────── */
  if (path === '/ot-claims') {
    if (method === 'GET') { const s=await requireAuth(request,env); const r=s.role==='staff'?await pgQuery(env,`SELECT * FROM ot_claims WHERE employee=$1 ORDER BY ot_date DESC`,[s.user_id]):await pgQuery(env,`SELECT o.*,u.full_name FROM ot_claims o LEFT JOIN users u ON o.employee=u.id ORDER BY o.ot_date DESC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); const id='ot_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO ot_claims (id,employee,ot_date,ot_hours,reason) VALUES ($1,$2,$3,$4,$5)`,[id,s.user_id,b.ot_date,b.ot_hours,b.reason||'']); return json({ok:true,id}); }
  }
  if (path.startsWith('/ot-claims/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { const s=await requireAuth(request,env); const b=await request.json(); if(b.status&&s.role!=='staff'){await pgQuery(env,`UPDATE ot_claims SET status=$1,approved_by=$2,updated_at=now() WHERE id=$3`,[b.status,s.user_id,id]);}else{await pgQuery(env,`UPDATE ot_claims SET ot_date=$1,ot_hours=$2,reason=$3,updated_at=now() WHERE id=$4`,[b.ot_date,b.ot_hours,b.reason,id]);} return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM ot_claims WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── KPIs (personal) ─────────────────────────────────── */
  if (path === '/kpis' && method === 'GET') {
    const s=await requireAuth(request,env); const u=s.user_id;
    const [op,dn,ov2,ot3]= await Promise.all([
      pgFirst(env,`SELECT COUNT(*)::int n FROM tasks WHERE assigned_to=$1 AND status!='Completed'`,[u]),
      pgFirst(env,`SELECT COUNT(*)::int n FROM tasks WHERE assigned_to=$1 AND status='Completed'`,[u]),
      pgFirst(env,`SELECT COUNT(*)::int n FROM tasks WHERE assigned_to=$1 AND status!='Completed' AND deadline::date<current_date`,[u]),
      pgFirst(env,`SELECT COALESCE(SUM(ot_hours),0) h FROM ot_claims WHERE employee=$1 AND to_char(ot_date::date,'YYYY-MM')=to_char(now(),'YYYY-MM')`,[u]),
    ]);
    const tasks2=await pgQuery(env,`SELECT id,task_name,priority,deadline,status,project FROM tasks WHERE assigned_to=$1 AND status!='Completed' ORDER BY deadline ASC LIMIT 10`,[u]);
    const proj2=await pgQuery(env,`SELECT id,project_name,progress,risk_level,deadline FROM projects WHERE status='Active' ORDER BY deadline ASC LIMIT 6`);
    return json({ok:true,tasks_total:op?.n||0,tasks_done:dn?.n||0,tasks_overdue:ov2?.n||0,ot_hours:ot3?.h||0,my_tasks:tasks2,my_projects:proj2});
  }

  return null;
}
