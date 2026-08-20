# Helpdesk Migration Guide: Odoo to Betime

บทนี้อธิบายวิธี migrate ข้อมูล tickets จาก Odoo dump ไปยัง Betime Helpdeck

## Quick Start

### 1. Extract Data from Odoo Dump

```bash
cd D:\betime solution\All_in_betime\BETIME
python scripts\migrate_helpdesk_from_odoo.py
```

ผลลัพธ์:
- `migrations/migrated_tickets.json` - Tickets ที่เตรียมพร้อม
- `migrations/migrated_attachments.json` - Attachment metadata (reference only)
- `migrations/filestore_migrated/` - ไฟล์แนบทั้งหมด (copy สำหรับ reference)

### 2. Add Database Tables (verify exist)

ตรวจสอบว่า `helpdesk_tickets` table มีอยู่แล้ว (ควรมีจาก schema.sql):

```sql
CREATE TABLE IF NOT EXISTS helpdesk_tickets (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT,
  project        TEXT,
  bug_type       TEXT,
  module         TEXT,
  location       TEXT,
  status         TEXT DEFAULT 'open',
  assigned_dev   TEXT,
  created_by     TEXT,
  odoo_ticket_id TEXT,
  attachment_key TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);
```

### 3. Add API Endpoint

เพิ่ม code จาก `IMPORT_API_ENDPOINT.js` เข้า `deploy/pages_bundle/_worker.js` ที่ส่วน "// ── HELPDESK KNOWLEDGE CRUD" (ก่อนหรือหลัง)

ตำแหน่ง: หาบรรทัด `if (path === '/helpdeck-knowledge')` แล้วเพิ่มก่อนหน้า

### 4. Copy Attachments to Filestore (optional)

```bash
# Copy files from migration folder to your server filestore
# Windows:
xcopy D:\betime solution\All_in_betime\BETIME\migrations\filestore_migrated\* D:\betime solution\All_in_betime\BETIME\deploy\pages_bundle\filestore\ /E /Y
```

### 5. Import Data via API

```javascript
// In browser console at https://localhost:8787/ (or your Betime URL)

const token = localStorage.getItem('bt_token');

// Load migrated tickets JSON
fetch('file:///D:/betime%20solution/All_in_betime/BETIME/migrations/migrated_tickets.json')
  .then(r => r.json())
  .then(TICKETS_DATA => {
    // Import tickets
    return fetch('/api/helpdesk/migrate-import', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'tickets',
        data: TICKETS_DATA
      })
    });
  })
  .then(r => r.json())
  .then(result => {
    console.log('Import result:', result);
    // Shows { ok: true, imported: X, failed: Y, errors: [...] }
  });
```

### 6. Verify Migration

```javascript
// Check migration status
fetch('/api/helpdesk/migrate-status', {
  headers: {
    'Authorization': 'Bearer ' + token,
  }
}).then(r => r.json()).then(console.log);
```

## File Structure

```
migrations/
├── migrate_helpdesk_from_odoo.py      # Main migration script
├── IMPORT_API_ENDPOINT.js              # API handlers (add to _worker.js)
├── README.md                           # This file
├── migrated_tickets.json               # Output: ticket data
├── migrated_attachments.json           # Output: attachment metadata
└── filestore_migrated/                 # Output: actual files
    ├── 00/
    ├── 01/
    └── ...
```

## Data Mapping (Odoo → Helpdeck)

### Tickets

| Odoo Column | Helpdeck Column | Notes |
|-------------|-----------------|-------|
| `id` | `odoo_ticket_id` | Original Odoo ID for reference |
| `subject` or `name` | `title` | Issue title (required) |
| `description` | `description` | Full description |
| `category_id` | `project` | Map to project/category |
| `state` | `status` | new→open, done→resolved, etc. |
| `user_id` | `assigned_dev` | Assigned developer |
| `create_uid` | `created_by` | Creator user ID |
| `create_date` | `created_at` | Creation timestamp |
| `write_date` | `updated_at` | Last update timestamp |

### API Schema

**POST /api/helpdesk/migrate-import**

```json
{
  "type": "tickets",
  "data": [
    {
      "id": "migrated_ticket_12345",
      "title": "System error in module X",
      "description": "Detailed description...",
      "project": "ERC",
      "bug_type": "Ticket",
      "status": "open",
      "assigned_dev": "user123",
      "created_by": "user456",
      "odoo_ticket_id": "12345",
      "created_at": "2026-02-20T10:30:00",
      "updated_at": "2026-02-20T10:30:00"
    }
  ]
}
```

**Response**

```json
{
  "ok": true,
  "imported": 150,
  "failed": 2,
  "errors": ["error1", "error2"]
}
```

## Troubleshooting

**Q: Script doesn't find dump.sql**
- ตรวจสอบ path: `c:\Users\wave\Downloads\bt-helpdesk_2026-02-20_06-29-35\dump.sql`
- ตรวจสอบว่า dump file มีขนาด > 50MB

**Q: Import returns 401 Unauthorized**
- ตรวจสอบ `bt_token` ใน localStorage
- ตรวจสอบว่า token ยังไม่หมดอายุ
- ลองเข้า app ใหม่ เพื่อเรียก login API

**Q: Tickets ไม่ปรากฏใน UI**
- ตรวจสอบ browser console สำหรับ errors
- ตรวจสอบว่า API endpoint ถูก add เข้า `_worker.js` หรือไม่
- ใช้ `/api/helpdesk/migrate-status` เพื่อเช็ค count

**Q: Duplicate tickets or update existing**
- Script ใช้ `ON CONFLICT(id) DO UPDATE` ถ้า ID ซ้ำ จะ update แทน insert
- ถ้าต้องลบก่อน: `DELETE FROM helpdesk_tickets WHERE odoo_ticket_id IS NOT NULL`

---

**Last Updated:** 2026-04-28

