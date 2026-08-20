# BETIME System Overview

เอกสารนี้อธิบายระบบ BETIME แบบภาพรวมตั้งแต่หน้าเว็บ, API, งานฝั่ง Frappe, ฐานข้อมูล, การใช้งาน local, ไปจนถึงสิ่งที่ต้องระวังเวลาจะแก้ระบบต่อ

เป้าหมายของเอกสารนี้คือให้คนอ่านเข้าใจได้ว่า:

- ระบบนี้ประกอบด้วยอะไรบ้าง
- แต่ละส่วนทำหน้าที่อะไร
- ข้อมูลไหลจากจุดไหนไปจุดไหน
- จุดไหนคือ source of truth
- ถ้าจะแก้อะไร ควรเริ่มจากตรงไหน

---

## 1. BETIME คืออะไร

BETIME เป็นระบบงานภายในที่รวมหลายความสามารถไว้ด้วยกัน เช่น:

- งาน helpdesk
- งาน dashboard สำหรับพนักงาน, manager, CEO
- งาน knowledge / AI search
- งาน finance / OT / invoice tracking
- งาน compliance
- งาน booking / calendar / task / project
- งาน admin และ user management

ระบบนี้ไม่ได้เป็นแอปเดียวชิ้นเดียว แต่เป็นหลายชั้นที่ทำงานร่วมกัน:

- หน้าเว็บ static ที่เสิร์ฟผ่าน Cloudflare Pages
- Worker ที่ทำหน้าที่เป็น API gateway และ backend bridge
- ฐานข้อมูล PostgreSQL สำหรับข้อมูลหลัก
- Frappe / ERPNext สำหรับ DocType, workflow, และบาง business process
- AI services เช่น Azure OpenAI และ Speech-to-Text
- integration ภายนอก เช่น Odoo และ LINE Bot

---

## 2. สถาปัตยกรรมภาพรวม

### 2.1 ชั้นหน้าเว็บ

โฟลเดอร์หลักที่เกี่ยวข้อง:

- `deploy/pages_bundle/`
- `betime_solution/www/betime/`
- `apps/helpdesk-next/`

บทบาทของชั้นนี้:

- แสดงหน้าให้ผู้ใช้
- รับ input จากผู้ใช้
- ส่ง request ไปที่ `/api/*`
- แสดงผลลัพธ์จาก backend

หน้าเว็บจำนวนมากเป็น HTML + Vanilla JS ที่ build ออกมาเป็น bundle พร้อมใช้

### 2.2 ชั้น API / Worker

ไฟล์หลัก:

- `src/index.js`
- `src/routes/*.js`
- `src/utils.js`
- `src/db.js`
- `src/middleware/auth.js`

บทบาท:

- รับ request ที่ขึ้นต้นด้วย `/api/`
- dispatch ไปยัง route ที่เหมาะสม
- ตรวจ auth
- คุยกับ PostgreSQL
- เชื่อมต่อกับ AI / file storage / external services

### 2.3 ชั้น Frappe / ERPNext

โฟลเดอร์หลัก:

- `betime_solution/`

บทบาท:

- เก็บ DocType, Python hooks, permissions, and workflows
- รองรับงานที่เป็น core ERP / approval / agent process
- เป็นอีก ecosystem ที่ใช้ร่วมกับระบบหลัก

### 2.4 ชั้นฐานข้อมูล

ฐานข้อมูลหลักที่เห็นในโปรเจกต์นี้มี 3 แบบ:

- PostgreSQL 16
- Frappe DB (MariaDB ของฝั่ง Frappe)
- D1 SQLite fallback หรือ edge mirror ในบาง flow

แนวคิดสำคัญคือ:

- ข้อมูลที่ worker อ่าน/เขียนหลัก ๆ ควรอยู่ใน PostgreSQL
- ข้อมูลที่เป็น native ของ Frappe อยู่ใน DB ของ Frappe เอง
- D1 ใช้ในบางกรณีเพื่อรองรับ edge หรือ fallback

---

## 3. ภาพรวมการไหลของ request

เวลาผู้ใช้เปิดเว็บ ระบบจะทำงานประมาณนี้:

1. Browser เปิดหน้า HTML จาก Pages
2. หน้าเว็บโหลด `shared.js`, `betime.js`, และ assets อื่น
3. ถ้าหน้าเว็บต้องเรียกข้อมูล จะยิงไปที่ `/api/...`
4. `src/index.js` รับ request แล้วส่งต่อไป handler ที่เหมาะสม
5. handler นั้นคุยกับ PostgreSQL หรือ service ภายนอก
6. ผลลัพธ์ถูกส่งกลับเป็น JSON
7. หน้าเว็บนำข้อมูลไป render ใหม่

ถ้าเป็น flow ของ Frappe:

1. Frappe เป็น backend ของบาง business workflow
2. Worker หรือหน้าเว็บอาจเรียก Frappe REST API
3. Frappe ประมวลผล DocType / workflow / permission
4. ผลลัพธ์ถูกส่งกลับไปยังหน้าหรือ worker

---

## 4. บทบาทของแต่ละโฟลเดอร์

### 4.1 `src/`

เป็น backend หลักของฝั่ง Worker

สิ่งที่อยู่ในนี้:

- routing หลัก
- auth
- database helper
- user/project/helpdesk/calendar/finance routes
- line bot
- knowledge
- ai chat
- file handling

ไฟล์สำคัญ:

- `src/index.js`
- `src/routes/users.js`
- `src/routes/helpdesk.js`
- `src/routes/auth.js`
- `src/routes/finance.js`
- `src/routes/calendar.js`
- `src/routes/projects.js`
- `src/routes/knowledge.js`
- `src/routes/line-bot.js`
- `src/routes/ai-chat.js`

### 4.2 `deploy/pages_bundle/`

เป็น bundle ของหน้าเว็บ static ที่พร้อม deploy

ตัวอย่างหน้า:

- `admin.html`
- `login.html`
- `home.html`
- `dashboard.html`
- `help-desk.html`
- `help-desk-v3.html`
- `staff-dashboard.html`
- `manager-dashboard.html`
- `ceo-dashboard.html`
- `project-co.html`
- `finance-dashboard.html`
- `knowledge-dashboard.html`
- `it-dashboard.html`
- `hr-dashboard.html`
- `notifications.html`

ส่วนนี้คือสิ่งที่ผู้ใช้เปิดผ่าน browser โดยตรง

### 4.3 `betime_solution/`

เป็นฝั่ง Frappe app

มี:

- `doctype`
- `permissions`
- `agents`
- `api`
- `templates`
- `workspace`
- `public`

สิ่งนี้ใช้กับ Frappe ecosystem โดยตรง เช่น:

- Smart Secretary
- Finance
- Compliance
- AI Knowledge
- Project management
- IT support

### 4.4 `apps/helpdesk-next/`

เป็น Next.js app อีกชุดหนึ่งที่ดูเหมือนใช้สำหรับ helpdesk UI หรือแอปใหม่

บทบาท:

- เป็น front-end อีกสายที่อาจกำลัง migrate หรือใช้กับ use case เฉพาะ

### 4.5 `packages/`

เป็น shared packages

มีพวก:

- types
- constants
- utils

ใช้เพื่อให้ frontend และ backend แชร์แนวคิดเดียวกัน

### 4.6 `docs/`

เป็นเอกสารอธิบาย flow และ domain knowledge

ตัวอย่าง:

- helpdesk ticket creation flow
- knowledge scope
- master data map
- troubleshooting
- test set template

---

## 5. API ชั้นหลัก

ไฟล์ `src/index.js` เป็น entry point ของ Worker

หลักการทำงาน:

- ถ้า request ไม่ใช่ `/api/*` จะส่งให้ static assets
- ถ้าเป็น `/api/*` จะ strip prefix แล้วส่งไปแต่ละ handler
- มี CORS รองรับ
- มี catch error กลางเพื่อกัน backend ล้มทั้งก้อน

route handlers ที่เห็นในระบบ:

- health
- auth
- dashboards
- projects
- finance
- calendar
- users
- helpdesk
- helpdesk chat
- ai chat
- knowledge
- master data
- line bot
- files
- business

นี่หมายความว่า worker ตัวเดียวเป็นศูนย์กลางของหลาย domain

---

## 6. Users / Admin / Auth

### 6.1 สิ่งที่ users route ทำ

ไฟล์หลัก:

- `src/routes/users.js`

หน้าที่:

- ดึงรายชื่อผู้ใช้
- สร้างผู้ใช้ใหม่
- แก้ user profile บาง field
- reset password
- set password
- logout sessions
- ดู sessions
- ดู audit ของ user
- ดู notifications

### 6.2 สิ่งที่สำคัญที่เพิ่งแก้

ตอนนี้มี route สำหรับ:

- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id`

สิ่งที่ `PUT` ทำได้:

- เปลี่ยน role
- เปลี่ยนชื่อ
- เปลี่ยนแผนก
- เปลี่ยนสถานะ active/inactive
- เปลี่ยน flag บังคับเปลี่ยนรหัสผ่าน

### 6.3 สิ่งที่ frontend ต้องสอดคล้อง

หน้า `admin.html` ต้องส่ง request ไปตามนี้:

- `fetch('/api/users')`
- `fetch('/api/users/:id', { method: 'PUT' })`

ถ้าฝั่งหน้าเว็บไม่มี UI ให้แก้ ข้อมูลก็จะไม่ถูกเปลี่ยนแม้ backend พร้อมแล้ว

---

## 7. Admin Console

ไฟล์:

- `deploy/pages_bundle/admin.html`

แท็บหลัก:

- Users
- Permissions
- AI Config
- API
- Audit

### 7.1 Users tab

สิ่งที่ Users tab ควรมี:

- รายชื่อผู้ใช้
- search box
- role selector
- save button
- badge สถานะ user
- แสดง warning ถ้าต้องเปลี่ยนรหัสผ่าน

### 7.2 Permissions tab

ใช้แสดงภาพรวมสิทธิ์ของ role ต่าง ๆ

แนวคิด:

- บอกว่า role ไหนเข้าถึงอะไรได้
- ใช้อ้างอิงระดับ policy มากกว่าการแก้ตรงจากหน้า

### 7.3 AI Config tab

ใช้ตรวจสถานะ config ของ AI services เช่น:

- OpenAI
- Speech-to-text
- Document intelligence
- Search

### 7.4 API tab

ใช้ตั้งค่า backend URL หรือ integration config

### 7.5 Audit tab

ใช้ดู log การกระทำสำคัญ

สิ่งที่สำคัญมากคือ admin actions ควรมี trail เสมอ เช่น:

- user created
- user updated
- password reset
- access update

---

## 8. Dashboard และหน้าใช้งานประจำวัน

ระบบนี้มีหลาย dashboard ตามบทบาท

ตัวอย่างหน้า:

- staff dashboard
- manager dashboard
- CEO dashboard
- finance dashboard
- helpdesk dashboard
- project dashboard
- IT dashboard
- HR dashboard

แนวคิด:

- คนละ role เห็นคนละข้อมูล
- หน้าเหล่านี้เป็น entry point ของงานประจำวัน
- backend ต้องคุมสิทธิ์ให้ตรงกับ role

---

## 9. Helpdesk และ ticket flow

ระบบ helpdesk เป็นหนึ่งใน domain ที่ใหญ่

สิ่งที่เกี่ยวข้อง:

- ticket creation
- chat / analysis / confirm / create flow
- classification ของประเภทปัญหา
- knowledge linkage
- possible cause
- project playbook

เอกสารใน `docs/` ที่เกี่ยวข้องกับ helpdesk ช่วยอธิบายว่า:

- ticket มาจากไหน
- แยกประเภทปัญหาอย่างไร
- ข้อมูล master data มีอะไรบ้าง
- flow การสร้าง ticket เป็นอย่างไร

หน้าเว็บที่เกี่ยวข้องมีหลายแบบ เช่น:

- `help-desk.html`
- `help-desk-v2.html`
- `help-desk-v3.html`
- `help-desk-v3-analysis.html`
- `help-desk-v3-confirm.html`
- `help-desk-v3-create.html`

หมายความว่าระบบ helpdesk นี้มีวิวัฒนาการหลายเวอร์ชัน

---

## 10. Knowledge / AI

ระบบ knowledge มีความสำคัญ เพราะใช้ค้นหาและช่วยตัดสินใจ

สิ่งที่เกี่ยวข้อง:

- `betime_solution/ai_knowledge`
- `deploy/pages_bundle/knowledge.html`
- `deploy/pages_bundle/knowledge-dashboard.html`
- `deploy/pages_bundle/rag-search.html`

บทบาท:

- เก็บบทความ / lesson learned
- ทำ semantic search หรือ retrieval
- เชื่อมกับ AI assistant

### 10.1 AI agents

ใน `betime_solution/agents/` มี agent หลายตัว เช่น:

- mom agent
- knowledge agent
- finance agent
- compliance agent
- calendar agent
- billing agent

แนวคิดคือให้แต่ละ agent รับผิดชอบโดเมนของตัวเอง

### 10.2 AI endpoints

ฝั่ง worker มี route สำหรับ AI chat และ knowledge search

ซึ่งมักใช้:

- Azure OpenAI
- search backend
- embeddings / vector matching

---

## 11. Finance / OT / Invoice

ส่วน finance มีหลาย component:

- OT claim
- invoice tracking
- finance dashboard
- billing alerts

ไฟล์ที่เกี่ยวข้อง:

- `betime_solution/finance/doctype/...`
- `deploy/pages_bundle/financial-reports.html`
- `deploy/pages_bundle/finance-dashboard.html`
- `deploy/pages_bundle/ot-claims.html`

บทบาท:

- เก็บงานที่เกี่ยวกับเงิน
- track รายการค่าใช้จ่าย / OT / invoice
- เชื่อมกับ workflow approval

---

## 12. Project / Task / Meeting

ส่วน project management และ collaboration มีหลายหน้า เช่น:

- projects
- project-co
- team-tasks
- my-tasks
- meeting-mom
- task-line-group

สิ่งที่ระบบนี้ต้องการ:

- งานมี owner
- มี status
- มี dependency
- มี note / MOM / decision log

ในฝั่ง Frappe มี DocType และ workspace ที่ช่วยจัดการข้อมูลเหล่านี้

---

## 13. Calendar / Booking / Resource

ระบบนี้มีงานที่เกี่ยวกับ calendar และ booking ด้วย

ตัวอย่างหน้า:

- `calendar.html`
- `room-booking.html`
- `resource-booking.html`
- `vehicle-booking.html`
- `reschedule.html`

บทบาท:

- จองทรัพยากร
- ตรวจชนกันของเวลา
- ใช้กับ workflow ขององค์กร

---

## 14. IT / HR / Compliance

ระบบมีหลาย domain ภายในองค์กร

### IT

ตัวอย่าง:

- `it-dashboard.html`
- `it-assets.html`
- `it-requests.html`
- Frappe Doctype ที่เกี่ยวกับ IT ticket

### HR

ตัวอย่าง:

- `hr.html`
- `hr-dashboard.html`
- onboarding
- check in/out

### Compliance

ตัวอย่าง:

- `compliance.html`
- document / check / audit oriented flow

---

## 15. Frontend ที่มีอยู่สองสาย

ในโปรเจกต์นี้ดูเหมือนมี frontend หลัก 2 สาย:

### 15.1 Static / Pages bundle

เป็นหน้า HTML/JS ที่ build ไว้แล้ว

ข้อดี:

- deploy ง่าย
- ทำงานกับ Cloudflare Pages ได้ตรง ๆ

ข้อเสีย:

- maintain ยากขึ้นถ้าหน้าหลายสิบหน้า
- อาจเกิดข้อความเพี้ยนหรือ script ซ้ำได้ง่าย

### 15.2 Next.js app

อยู่ที่ `apps/helpdesk-next`

ข้อดี:

- modern dev experience
- component-based
- เหมาะกับหน้าที่ซับซ้อน

ข้อสังเกต:

- ควรชัดเจนว่าหน้าไหนเป็นของ bundle เดิม และหน้าไหนเป็นของ Next app
- ถ้าไม่แยกให้ดีจะทำให้คนแก้สับสน

---

## 16. Environment / Config

ค่าคอนฟิกสำคัญมักอยู่ใน environment variables

ตัวอย่าง:

- `PG_URL`
- `HYPERDRIVE`
- `MS_ENTRA_*`
- `AZURE_AI_*`
- `AZURE_SPEECH_*`
- `ODOO_*`
- `ASSETS`
- `DB`

แนวคิดสำคัญ:

- credentials ไม่ควร hardcode
- integration config ควรอยู่ใน env หรือ table config ที่กำหนดชัด

---

## 17. Local run

เอกสาร `LOCAL-RUN.md` บอกว่าเครื่องนี้รันได้ทั้ง local worker และ docker mode

คำสั่ง/ทางลัดที่เห็น:

- `run-betime-ready.bat`
- `start-betime-local.bat`
- `open-betime-web.bat`
- `stop-betime-local.bat`
- `start-betime-docker.bat`
- `stop-betime-docker.bat`

จุดประสงค์:

- เปิดระบบให้เร็ว
- เช็ก backend และ database พร้อมใช้งาน
- ทดสอบหน้าเว็บในเครื่องตัวเอง

---

## 18. Build และ deploy

จาก `package.json` มี script หลัก เช่น:

- `build`
- `build:watch`
- `local:pages`
- `docker:up`
- `docker:down`
- `db:migrate`

กระบวนการคิดทั่วไปคือ:

1. แก้ source ใน `src/` หรือหน้าเว็บ
2. bundle ออกไปเป็น worker/pages bundle
3. deploy ไปยัง Cloudflare Pages / Worker
4. ถ้า schema เปลี่ยนต้อง run migration

---

## 19. สิ่งที่ต้องระวังเวลาแก้ระบบนี้

### 19.1 ตัวอักษรเพี้ยน

บางไฟล์มี encoding หรือ text เพี้ยนอยู่แล้ว

ผลเสีย:

- patch ยาก
- อ่าน code ยาก
- เสี่ยงแก้ผิดบรรทัด

### 19.2 โค้ดเดิมมีหลายรุ่น

หน้าเดียวกันอาจมี logic เก่าและใหม่ปนกัน

ผลเสีย:

- function ชื่อซ้ำ
- render ซ้ำ
- event handler ซ้ำ

### 19.3 สิทธิ์และ audit

งาน admin ที่แก้ข้อมูล user ต้องมี:

- permission check
- audit log
- validation ของค่าที่รับเข้า

### 19.4 อย่าแก้คนละชั้นโดยไม่รู้ผลกระทบ

ถ้าแก้หน้าเว็บอย่างเดียว แต่ backend ยังไม่รองรับ หรือถ้าแก้ backend อย่างเดียวแต่หน้าเว็บไม่ยิง request ใหม่ งานจะดูเหมือน “ยังไม่หาย”

---

## 20. สรุปสิ่งสำคัญที่สุด

ถ้าจะเข้าใจ BETIME แบบเร็วที่สุด ให้จำ 5 ข้อนี้:

1. ระบบนี้มีหลายชั้น ทั้ง static pages, worker API, Frappe, และ database
2. `src/index.js` คือประตูหลักของ `/api/*`
3. `deploy/pages_bundle/` คือหน้าที่ผู้ใช้เห็นจริง
4. `betime_solution/` คือโลกของ Frappe / DocType / workflow
5. ถ้าจะแก้อะไร ต้องดูทั้ง frontend และ backend ให้ตรงกัน

---

## 21. จุดที่ผมแก้ไปล่าสุดในงานนี้

เพื่อให้เอกสารนี้โยงกับของจริงใน repo:

- หน้า `admin.html` มี search box แล้ว
- Users tab มี control สำหรับเปลี่ยน `role`
- backend มี `PUT /api/users/:id`
- role update ถูกบันทึกเข้า audit log

ดังนั้น state ปัจจุบันของระบบคือ:

- ปัญหาหลักเรื่อง “แก้ role ไม่ได้” ถูกปิดที่ backend และ frontend แล้ว
- งานถัดไปคือไล่แก้อักษรเพี้ยนที่ยังเหลือในหน้าอื่น ๆ และเก็บความเรียบร้อยของระบบทั้งชุด

