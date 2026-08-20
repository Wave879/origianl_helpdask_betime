# BETIME Architecture — System Boundaries

> อ้างอิงเอกสารนี้ก่อนสร้าง feature ใหม่ เพื่อให้รู้ว่า code ควรอยู่ที่ไหน

---

## ภาพรวม

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser / LINE Bot / External Systems                          │
└────────────────────┬──────────────────┬────────────────────────┘
                     │                  │
          ┌──────────▼──────────┐       │
          │  Cloudflare Pages   │       │
          │  (Static HTML / JS) │       │
          │  + Next.js App      │       │
          └──────────┬──────────┘       │
                     │ /api/*           │ Frappe REST API
          ┌──────────▼──────────┐       │
          │  Cloudflare Worker  │       │  ┌──────────────────┐
          │  (_worker.js / src/)│       └──►  Frappe / ERPNext │
          └──────────┬──────────┘          │  (Python backend) │
                     │                     └────────┬─────────┘
          ┌──────────▼──────────┐                   │
          │   PostgreSQL 16     │         ┌──────────▼──────────┐
          │   (Primary DB)      │         │   AI Agents (6)     │
          └─────────────────────┘         │   Azure OpenAI      │
                                          │   Azure Speech-to-Text│
                                          └─────────────────────┘
```

---

## Cloudflare Worker — รับผิดชอบอะไร

**ทำได้ / ควรทำ:**
- Auth (JWT session, Microsoft Entra OAuth)
- CRUD ทุก table ใน PostgreSQL
- File upload → Cloudflare R2
- Serve static HTML pages (via `env.ASSETS`)
- Odoo integration (helpdesk ticket creation, sync)
- LINE Bot webhook
- AI chat (เรียก Azure OpenAI เป็น proxy)
- การ normalize SQL สำหรับ D1 fallback

**ห้ามทำ / ไม่ควรทำ:**
- ไม่ควร implement business workflow ซับซ้อน (approvals, escalations) ที่ต้องการ state machine
- ไม่ duplicate tables หรือ data ที่มีใน Frappe แล้ว
- ไม่ควรเก็บ business logic ที่ต้องการ Frappe hooks

---

## Frappe / ERPNext — รับผิดชอบอะไร

**ทำได้ / ควรทำ:**
- AI Agent workflows (MOM transcription, calendar conflict, billing)
- ERPNext DocTypes สำหรับ Frappe-native forms
- Background jobs และ scheduled tasks ผ่าน Frappe scheduler
- SharePoint sync (knowledge articles)
- Email notifications ผ่าน Frappe mail queue
- Complex approval workflows ที่ต้องการ hooks

**ห้ามทำ / ไม่ควรทำ:**
- ไม่ duplicate tables ที่มีใน PostgreSQL แล้ว (users, projects, tasks ฯลฯ)
- ไม่สร้าง REST endpoint ที่ Worker ทำอยู่แล้ว
- ไม่ handle session / JWT โดยตรง

---

## Database

| Database | ใช้กับ | Source of Truth |
|----------|--------|-----------------|
| **PostgreSQL 16** | Worker, production | ✅ Primary |
| **SQLite D1** | Cloudflare edge fallback | ❌ Mirror เท่านั้น |
| **Frappe DB (MariaDB)** | Frappe/ERPNext internal | ✅ สำหรับ Frappe DocTypes เท่านั้น |

**กฎ:** ข้อมูลที่ Worker อ่าน/เขียน ต้องอยู่ใน PostgreSQL เท่านั้น อย่าให้ Worker อ่านจาก Frappe DB โดยตรง

---

## Packages

```
BETIME/packages/
├── types/        ← TypeScript interfaces — ใช้ใน Next.js app + scripts
├── constants/    ← Enums, status lists — ใช้ทั้ง frontend และ backend
└── utils/        ← Pure functions (date, currency, string) — ไม่มี side effects
```

**กฎ:** packages ต้องเป็น pure ไม่มี DB calls ไม่มี HTTP calls ไม่มี env vars

---

## Frontend

| Layer | เทคโนโลยี | สถานะ |
|-------|-----------|-------|
| Legacy HTML | Vanilla JS (77 หน้า) | 🔴 Deprecating ทีละหน้า |
| New App | Next.js 14 + TypeScript | 🟢 Active development |

**กลยุทธ์ migration:** Strangler Fig — legacy HTML serve ผ่าน `/legacy/*` ขณะที่ Next.js เข้ามาแทนทีละหน้า

---

## ลำดับการ Deploy

```
1. git push → GitHub Actions
2. wrangler pages deploy → Cloudflare Pages
3. _worker.js (หรือ src/ bundle) + static assets
4. D1 migration (ถ้ามี schema change)
```

สำหรับ local:
```
run-betime-ready.bat → wrangler pages dev + PostgreSQL
```

---

## Environment Variables

| Variable | ใช้ใน | คำอธิบาย |
|----------|-------|---------|
| `PG_URL` | Worker | PostgreSQL connection string |
| `HYPERDRIVE` | Worker | Cloudflare Hyperdrive binding |
| `MS_ENTRA_*` | Worker | Microsoft OAuth config |
| `AZURE_AI_*` | Worker | Azure OpenAI |
| `AZURE_SPEECH_*` | Worker | Azure Speech-to-Text |
| `ODOO_*` | Worker | Odoo integration |
| `ASSETS` | Worker | Cloudflare Pages static files binding |
| `DB` | Worker | D1 SQLite binding |

LINE bot config เก็บใน DB (`hd_master` table) ไม่ใช่ env vars

---

## ข้อห้าม (ห้ามทำโดยเด็ดขาด)

1. อย่าแก้ `_worker.js` โดยตรง — แก้ใน `src/` แล้ว bundle
2. อย่าเพิ่ม schema ใน `schema.sql` หรือ `postgres_bootstrap.sql` — ใช้ `migrations/sql/` เท่านั้น
3. อย่า hardcode credentials ใน code — ใช้ env vars เสมอ
4. อย่า share session token ข้าม domain
5. อย่าลบ `_worker.js` จนกว่า `src/` build จะ stable
