/**
 * routes/business.js
 * /announcements, /feedback, /room-bookings, /vehicle-bookings,
 * /leave-requests, /checkin, /certifications, /contracts, /kpis (IT)
 */

import { pgQuery, pgFirst } from '../db.js';
import { json, err, uid } from '../utils.js';
import { requireAuth, getSession } from '../middleware/auth.js';

export async function handleBusiness(path, method, request, env) {
  const url = new URL(request.url);

  /* ── ANNOUNCEMENTS ────────────────────────────────────── */
  if (path === '/announcements') {
    if (method === 'GET') {
      await requireAuth(request, env);
      const dept = url.searchParams.get('dept') || '';
      const r = dept
        ? await pgQuery(env,`SELECT a.*,u.full_name author_name FROM announcements a LEFT JOIN users u ON a.created_by=u.id WHERE a.target_dept='all' OR a.target_dept=$1 ORDER BY a.is_pinned DESC, a.created_at DESC`,[dept])
        : await pgQuery(env,`SELECT a.*,u.full_name author_name FROM announcements a LEFT JOIN users u ON a.created_by=u.id ORDER BY a.is_pinned DESC, a.created_at DESC`);
      return json({ ok:true, data:r });
    }
    if (method === 'POST') {
      const s = await requireAuth(request, env);
      if (!['ceo','manager','admin','super_admin','superadmin'].includes(s.role)) return err('Permission denied',403);
      const b = await request.json();
      if (!b.title) return err('title จำเป็น');
      const id = 'ann_' + uid().slice(0,8);
      await pgQuery(env,`INSERT INTO announcements (id,title,content,category,is_pinned,target_dept,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,b.title,b.content||'',b.category||'General',b.is_pinned?1:0,b.target_dept||'all',s.user_id]);
      return json({ ok:true, id });
    }
  }
  if (path.startsWith('/announcements/')) {
    const id = path.split('/')[2];
    if (method === 'PUT') { const s=await requireAuth(request,env); if(!['ceo','manager','admin','super_admin','superadmin'].includes(s.role)) return err('Permission denied',403); const b=await request.json(); await pgQuery(env,`UPDATE announcements SET title=$1,content=$2,category=$3,is_pinned=$4,target_dept=$5,updated_at=now() WHERE id=$6`,[b.title,b.content||'',b.category||'General',b.is_pinned?1:0,b.target_dept||'all',id]); return json({ok:true}); }
    if (method === 'DELETE') { const s=await requireAuth(request,env); if(!['ceo','manager','admin','super_admin','superadmin'].includes(s.role)) return err('Permission denied',403); await pgQuery(env,`DELETE FROM announcements WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── FEEDBACK ─────────────────────────────────────────── */
  if (path === '/feedback') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT f.*,u.full_name submitter_name FROM feedback f LEFT JOIN users u ON f.submitted_by=u.id ORDER BY f.created_at DESC`); return json({ok:true,data:r}); }
    if (method === 'POST') {
      const s = await getSession(request, env);
      const b = await request.json();
      if (!b.subject) return err('subject จำเป็น');
      const id = 'fb_' + uid().slice(0,8);
      await pgQuery(env,`INSERT INTO feedback (id,subject,message,category,rating,submitted_by,is_anonymous) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,b.subject,b.message||'',b.category||'General',b.rating||null,s?.user_id||null,b.is_anonymous?1:0]);
      return json({ ok:true, id });
    }
  }

  /* ── ROOM BOOKINGS ────────────────────────────────────── */
  if (path === '/room-bookings') {
    if (method === 'GET') {
      await requireAuth(request,env);
      const date=url.searchParams.get('date')||'';
      const r = date
        ? await pgQuery(env,`SELECT rb.*,u.full_name booker_name FROM room_bookings rb LEFT JOIN users u ON rb.booked_by=u.id WHERE rb.start_time::date=$1 ORDER BY rb.start_time`,[date])
        : await pgQuery(env,`SELECT rb.*,u.full_name booker_name FROM room_bookings rb LEFT JOIN users u ON rb.booked_by=u.id WHERE rb.start_time::timestamptz >= now() - interval '1 day' ORDER BY rb.start_time LIMIT 30`);
      return json({ok:true,data:r});
    }
    if (method === 'POST') {
      const s=await requireAuth(request,env); const b=await request.json();
      if(!b.room_name||!b.start_time||!b.end_time) return err('room_name, start_time, end_time จำเป็น');
      const conflict=await pgFirst(env,`SELECT id FROM room_bookings WHERE room_name=$1 AND status!='cancelled' AND NOT (end_time<=$2 OR start_time>=$3)`,[b.room_name,b.start_time,b.end_time]);
      if(conflict) return err('ห้องนี้ถูกจองแล้วในช่วงเวลาดังกล่าว',409);
      const id='rb_'+uid().slice(0,8);
      await pgQuery(env,`INSERT INTO room_bookings (id,room_name,booked_by,start_time,end_time,attendees,purpose,meeting_link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,b.room_name,s.user_id,b.start_time,b.end_time,b.attendees||1,b.purpose||'',b.meeting_link||'']);
      return json({ok:true,id});
    }
  }
  if (path.startsWith('/room-bookings/')) {
    const id=path.split('/')[2];
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`UPDATE room_bookings SET status='cancelled' WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── VEHICLE BOOKINGS ─────────────────────────────────── */
  if (path === '/vehicle-bookings') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT vb.*,u.full_name booker_name FROM vehicle_bookings vb LEFT JOIN users u ON vb.booked_by=u.id ORDER BY vb.trip_date DESC LIMIT 30`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); if(!b.vehicle||!b.trip_date) return err('vehicle และ trip_date จำเป็น'); const id='vb_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO vehicle_bookings (id,vehicle,booked_by,trip_date,start_time,end_time,destination,passengers,purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,b.vehicle,s.user_id,b.trip_date,b.start_time||null,b.end_time||null,b.destination||'',b.passengers||1,b.purpose||'']); return json({ok:true,id}); }
  }

  /* ── CERTIFICATIONS ───────────────────────────────────── */
  if (path === '/certifications') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT * FROM certifications ORDER BY expiry_date ASC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); if(!b.cert_name) return err('cert_name จำเป็น'); const id='cert_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO certifications (id,cert_name,cert_type,issued_to,issued_by,issue_date,expiry_date,status,file_key,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,b.cert_name,b.cert_type||'ISO',b.issued_to||'',b.issued_by||'',b.issue_date||null,b.expiry_date||null,'active',b.file_key||null,b.notes||'']); return json({ok:true,id}); }
  }
  if (path.startsWith('/certifications/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { await requireAuth(request,env); const b=await request.json(); await pgQuery(env,`UPDATE certifications SET cert_name=$1,cert_type=$2,issued_to=$3,issued_by=$4,issue_date=$5,expiry_date=$6,status=$7,notes=$8 WHERE id=$9`,[b.cert_name,b.cert_type,b.issued_to,b.issued_by,b.issue_date||null,b.expiry_date||null,b.status,b.notes,id]); return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM certifications WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── CONTRACTS ────────────────────────────────────────── */
  if (path === '/contracts') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT * FROM contracts ORDER BY expiry_date ASC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); if(!b.title) return err('title จำเป็น'); const id='con_'+uid().slice(0,8); const no='CON-'+new Date().getFullYear()+'-'+(Math.floor(Math.random()*9000)+1000); await pgQuery(env,`INSERT INTO contracts (id,contract_no,title,contract_type,party,contract_date,start_date,expiry_date,value,currency,status,file_key,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,no,b.title,b.contract_type||'Service',b.party||'',b.contract_date||null,b.start_date||null,b.expiry_date||null,b.value||0,b.currency||'THB','draft',b.file_key||null,b.notes||'',s.user_id]); return json({ok:true,id,contract_no:no}); }
  }
  if (path.startsWith('/contracts/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { await requireAuth(request,env); const b=await request.json(); await pgQuery(env,`UPDATE contracts SET title=$1,contract_type=$2,party=$3,contract_date=$4,start_date=$5,expiry_date=$6,value=$7,currency=$8,status=$9,notes=$10,updated_at=now() WHERE id=$11`,[b.title,b.contract_type,b.party,b.contract_date||null,b.start_date||null,b.expiry_date||null,b.value||0,b.currency||'THB',b.status,b.notes||'',id]); return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM contracts WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── LEAVE REQUESTS ───────────────────────────────────── */
  if (path === '/leave-requests') {
    if (method === 'GET') { const s=await requireAuth(request,env); const r=s.role==='staff'?await pgQuery(env,`SELECT l.*,u.full_name FROM leave_requests l LEFT JOIN users u ON l.user_id=u.id WHERE l.user_id=$1 ORDER BY l.created_at DESC`,[s.user_id]):await pgQuery(env,`SELECT l.*,u.full_name FROM leave_requests l LEFT JOIN users u ON l.user_id=u.id ORDER BY l.created_at DESC`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); if(!b.start_date||!b.end_date) return err('start_date และ end_date จำเป็น'); const id='lv_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO leave_requests (id,user_id,leave_type,start_date,end_date,days_count,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,s.user_id,b.leave_type||'annual',b.start_date,b.end_date,b.days_count||1,b.reason||'']); return json({ok:true,id}); }
  }
  if (path.startsWith('/leave-requests/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { const s=await requireAuth(request,env); if(s.role==='staff') return err('Permission denied',403); const b=await request.json(); await pgQuery(env,`UPDATE leave_requests SET status=$1,approved_by=$2,approved_at=now(),updated_at=now() WHERE id=$3`,[b.status,s.user_id,id]); return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM leave_requests WHERE id=$1`,[id]); return json({ok:true}); }
  }

  /* ── CHECK-IN / CHECK-OUT ─────────────────────────────── */
  if (path === '/checkin') {
    if (method === 'GET') {
      const s = await requireAuth(request, env);
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0,10);
      const r = await pgFirst(env,`SELECT * FROM check_ins WHERE user_id=$1 AND check_date=$2`,[s.user_id, date]);
      return json({ ok: true, data: r || null });
    }
    if (method === 'POST') {
      const s = await requireAuth(request, env);
      const b = await request.json();
      const today = new Date().toISOString().slice(0,10);
      const nowTime = new Date().toISOString().slice(11,19);
      const existing = await pgFirst(env,`SELECT * FROM check_ins WHERE user_id=$1 AND check_date=$2`,[s.user_id, today]);
      if (!existing) {
        const id = 'ci_' + uid().slice(0,8);
        await pgQuery(env,`INSERT INTO check_ins (id,user_id,check_date,check_in,location) VALUES ($1,$2,$3,$4,$5)`,[id,s.user_id,today,nowTime,b.location||'Office']);
        return json({ ok:true, action:'check_in', time: nowTime });
      } else if (existing.check_in && !existing.check_out) {
        const inTime = existing.check_in;
        const [inH,inM,inS] = inTime.split(':').map(Number);
        const [outH,outM,outS] = nowTime.split(':').map(Number);
        const workHours = Math.max(0, ((outH*3600+outM*60+outS) - (inH*3600+inM*60+inS)) / 3600);
        await pgQuery(env,`UPDATE check_ins SET check_out=$1,work_hours=$2,updated_at=now() WHERE id=$3`,[nowTime, Math.round(workHours*100)/100, existing.id]);
        return json({ ok:true, action:'check_out', time: nowTime, work_hours: Math.round(workHours*100)/100 });
      } else {
        return err('เช็กอินและเช็กเอาต์แล้ววันนี้', 400);
      }
    }
  }
  if (path === '/checkin/history' && method === 'GET') {
    const s = await requireAuth(request, env);
    const from = url.searchParams.get('from') || new Date().toISOString().slice(0,7)+'-01';
    const to = url.searchParams.get('to') || new Date().toISOString().slice(0,10);
    const r = await pgQuery(env,`SELECT c.*,u.full_name FROM check_ins c LEFT JOIN users u ON c.user_id=u.id WHERE c.user_id=$1 AND c.check_date>=$2 AND c.check_date<=$3 ORDER BY c.check_date DESC`,[s.user_id,from,to]);
    return json({ ok:true, data:r });
  }

  /* ── IT KPIs (secondary /kpis handler for IT tables) ─── */
  if (path === '/kpis' && method === 'GET') {
    // Only handle if IT-specific tables exist (otherwise fall through to projects handler)
    try {
      await requireAuth(request, env);
      const [ta,aa,ra,ra2,tr,or2,pr,rr,assets,reqs] = await Promise.all([
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_assets`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_assets WHERE status='active'`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_assets WHERE status='repair'`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_assets WHERE status='retired'`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_requests`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_requests WHERE status='open'`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_requests WHERE status='pending'`),
        pgFirst(env,`SELECT COUNT(*)::int n FROM it_requests WHERE status='resolved'`),
        pgQuery(env,`SELECT id,asset_code,asset_name,asset_type,assigned_to,department,status FROM it_assets ORDER BY updated_at DESC LIMIT 10`),
        pgQuery(env,`SELECT id,ticket_no,title,priority,status,department,created_at FROM it_requests ORDER BY created_at DESC LIMIT 10`),
      ]);
      return json({ ok:true, total_assets:ta?.n||0, active_assets:aa?.n||0, repair_assets:ra?.n||0, retired_assets:ra2?.n||0, total_requests:tr?.n||0, open_requests:or2?.n||0, pending_requests:pr?.n||0, resolved_requests:rr?.n||0, recent_assets:assets, recent_requests:reqs });
    } catch {
      // Fall through - let projects.js handle /kpis
      return null;
    }
  }

  return null;
}
