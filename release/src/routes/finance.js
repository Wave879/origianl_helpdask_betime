/**
 * routes/finance.js
 * CRUD /invoices, CRUD /budget
 */

import { pgQuery, pgFirst } from '../db.js';
import { json, err, uid } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

export async function handleFinance(path, method, request, env) {
  const url = new URL(request.url);

  /* ── INVOICES ─────────────────────────────────────────── */
  if (path === '/invoices') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT * FROM invoices ORDER BY due_date ASC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); const id='inv_'+uid().slice(0,8); const no='INV-'+new Date().getFullYear()+'-'+(Math.floor(Math.random()*9000)+1000); await pgQuery(env,`INSERT INTO invoices (id,invoice_no,vendor,amount,due_date,status,description,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,no,b.vendor,b.amount||0,b.due_date||null,'Unpaid',b.description||'',s.user_id]); return json({ok:true,id,invoice_no:no}); }
  }

  /* ── BUDGET ───────────────────────────────────────────── */
  if (path === '/budget') {
    if (method === 'GET') { await requireAuth(request,env); const year=url.searchParams.get('year')||'2026'; const r=await pgQuery(env,`SELECT * FROM budget_items WHERE fiscal_year=$1 ORDER BY department,category`,[year]); const totals=await pgFirst(env,`SELECT SUM(planned) total_planned, SUM(actual) total_actual FROM budget_items WHERE fiscal_year=$1`,[year]); return json({ok:true,data:r,totals}); }
    if (method === 'POST') { const s=await requireAuth(request,env); if(!['ceo','manager'].includes(s.role)) return err('Permission denied',403); const b=await request.json(); if(!b.department||!b.item_name) return err('department และ item_name จำเป็น'); const id='bgt_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO budget_items (id,fiscal_year,department,category,item_name,planned,actual,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,b.fiscal_year||'2026',b.department,b.category||'Operations',b.item_name,b.planned||0,b.actual||0,s.user_id]); return json({ok:true,id}); }
  }
  if (path.startsWith('/budget/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { await requireAuth(request,env); const b=await request.json(); await pgQuery(env,`UPDATE budget_items SET planned=$1,actual=$2,item_name=$3,category=$4,updated_at=now() WHERE id=$5`,[b.planned||0,b.actual||0,b.item_name,b.category,id]); return json({ok:true}); }
    if (method === 'DELETE') { const s=await requireAuth(request,env); if(!['ceo','manager'].includes(s.role)) return err('Permission denied',403); await pgQuery(env,`DELETE FROM budget_items WHERE id=$1`,[id]); return json({ok:true}); }
  }

  return null;
}
