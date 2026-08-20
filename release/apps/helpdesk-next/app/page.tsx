'use client';

import { useEffect, useState } from 'react';

type TicketStatus = 'saved' | 'failed' | 'success';
type SavedTicket = {
  id: string;
  status: TicketStatus;
  projectCode: string;
  assignedDev: string;
  summary: string;
  issueText: string;
  createdAt: string;
  updatedAt: string;
  payload?: Record<string, unknown>;
  errorMessage?: string;
};

const STORAGE_KEY = 'bt_helpdesk_v2_saved_tickets';
const API_BASE = process.env.NEXT_PUBLIC_HELPDESK_API_BASE || '';

function nowIso() {
  return new Date().toISOString();
}

export default function Page() {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [rows, setRows] = useState<SavedTicket[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    projectCode: '',
    assignedDev: '',
    summary: '',
    issueText: '',
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      setRows(Array.isArray(raw) ? raw : []);
    } catch {
      setRows([]);
    }
  }, []);

  function persist(nextRows: SavedTicket[]) {
    setRows(nextRows);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRows));
  }

  function upsert(row: SavedTicket) {
    const index = rows.findIndex((r) => r.id === row.id);
    const next = [...rows];
    if (index >= 0) next[index] = row;
    else next.unshift(row);
    persist(next.slice(0, 300));
  }

  function remove(id: string) {
    persist(rows.filter((r) => r.id !== id));
  }

  async function submitFromForm() {
    if (!form.projectCode || !form.summary || !form.issueText) {
      setMessage('กรอก project, summary และ issue detail ให้ครบก่อน');
      return;
    }
    const payload = {
      title: form.summary,
      description: form.issueText,
      project: form.projectCode,
      assigned_dev: form.assignedDev,
      case_subject: form.summary,
      case_desc: form.issueText,
      channel: 'Website',
    };
    const id = `sv_${Date.now()}`;
    const saved: SavedTicket = {
      id,
      status: 'saved',
      projectCode: form.projectCode,
      assignedDev: form.assignedDev,
      summary: form.summary,
      issueText: form.issueText,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      payload,
    };
    upsert(saved);
    await retryCreate(saved);
  }

  async function retryCreate(row: SavedTicket) {
    setSubmitting(true);
    setMessage('');
    try {
      if (!API_BASE) throw new Error('ยังไม่ได้ตั้ง NEXT_PUBLIC_HELPDESK_API_BASE');
      const res = await fetch(`${API_BASE}/api/helpdesk/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row.payload || {}),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'สร้าง ticket ไม่สำเร็จ');
      const success: SavedTicket = { ...row, status: 'success', updatedAt: nowIso(), errorMessage: '' };
      upsert(success);
      setMessage('สร้าง Ticket สำเร็จ');
    } catch (error) {
      const failed: SavedTicket = {
        ...row,
        status: 'failed',
        updatedAt: nowIso(),
        errorMessage: error instanceof Error ? error.message : 'สร้าง ticket ไม่สำเร็จ',
      };
      upsert(failed);
      setMessage(failed.errorMessage || 'สร้าง ticket ไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  }

  function loadToForm(row: SavedTicket) {
    setForm({
      projectCode: row.projectCode || '',
      assignedDev: row.assignedDev || '',
      summary: row.summary || '',
      issueText: row.issueText || '',
    });
    setShowWorkspace(true);
  }

  return (
    <main className="page">
      <section className="card">
        <div className="head">
          <div>
            <h1 className="title">ตาราง Ticket ที่บันทึกไว้</h1>
            <div className="sub">ถ้าสร้างไม่สำเร็จจะค้างไว้ และกดสร้าง Ticket ซ้ำได้</div>
          </div>
          <button className="btn primary" onClick={() => setShowWorkspace(true)}>สร้าง Ticket</button>
        </div>
        <div className="body">
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>สถานะ</th>
                  <th>เวลา</th>
                  <th>Project</th>
                  <th>Dev</th>
                  <th>Summary</th>
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">ยังไม่มีรายการ</td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td><span className={`badge ${row.status}`}>{row.status}</span></td>
                    <td>{row.updatedAt}</td>
                    <td>{row.projectCode || '-'}</td>
                    <td>{row.assignedDev || '-'}</td>
                    <td>{row.summary || '-'}</td>
                    <td className="row">
                      <button className="btn" onClick={() => retryCreate(row)} disabled={submitting}>สร้าง Ticket</button>
                      <button className="btn" onClick={() => loadToForm(row)}>เปิด</button>
                      <button className="btn" onClick={() => remove(row.id)}>ลบ</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {showWorkspace && (
        <section className="card workspace">
          <div className="head">
            <div>
              <h2 className="title">Workspace: สร้าง Ticket</h2>
              <div className="sub">เฟสแรกของการย้าย Chat V2 มา Next.js</div>
            </div>
          </div>
          <div className="body grid">
            <div>
              <label>Project</label>
              <input value={form.projectCode} onChange={(e) => setForm((s) => ({ ...s, projectCode: e.target.value }))} />
            </div>
            <div>
              <label>Dev</label>
              <input value={form.assignedDev} onChange={(e) => setForm((s) => ({ ...s, assignedDev: e.target.value }))} />
            </div>
            <div>
              <label>Summary</label>
              <input value={form.summary} onChange={(e) => setForm((s) => ({ ...s, summary: e.target.value }))} />
            </div>
            <div>
              <label>Issue Detail</label>
              <textarea value={form.issueText} onChange={(e) => setForm((s) => ({ ...s, issueText: e.target.value }))} />
            </div>
            <div className="row">
              <button className="btn primary" onClick={submitFromForm} disabled={submitting}>สร้าง Ticket</button>
              <button className="btn" onClick={() => setShowWorkspace(false)}>กลับไปตาราง</button>
            </div>
            {message && <div className="muted">{message}</div>}
          </div>
        </section>
      )}
    </main>
  );
}
