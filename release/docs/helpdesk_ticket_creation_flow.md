# Helpdesk Ticket Creation Flow

เอกสารนี้สรุป flow การสร้าง Ticket ของ Helpdesk V3 เพื่อใช้วางแผนใหม่และตรวจว่าแต่ละหน้าควรรับผิดชอบอะไร

## เป้าหมายของ Flow

- ให้ผู้ใช้สร้าง Ticket จากหน้าเดียวที่เข้าใจง่าย
- ให้ระบบวิเคราะห์ประเภทปัญหาและความเร่งด่วนอัตโนมัติ
- ให้การส่งต่อ  Dev อิงจากข้อมูล role ต่อโครงการ
- ลดการเลือกข้อมูลซ้ำ เช่น เลือกโครงการที่หน้าแรกแล้ว ไม่ต้องเลือกซ้ำในหน้าวิเคราะห์
- เก็บข้อมูล Ticket ที่สร้างแล้วไว้เป็น history เพื่อช่วยวิเคราะห์เคสต่อไป

## Flow ปัจจุบัน

```txt
หน้า Create Ticket
  -> เลือก Project / Sup Project
  -> กรอกรายละเอียดปัญหา
  -> เรียก /api/helpdesk/analyze
  -> Worker วิเคราะห์ด้วย AI
  -> ถ้า AI fail ใช้ fallback rule ทำไมถึงมี fail อะ
  -> เก็บ draft
  -> ไปหน้า Analysis
  -> เลือก action / route target![1779855804120](image/helpdesk_ticket_creation_flow/1779855804120.png)![1779855862654](image/helpdesk_ticket_creation_flow/1779855862654.png)![1779855896040](image/helpdesk_ticket_creation_flow/1779855896040.png)![1779855898032](image/helpdesk_ticket_creation_flow/1779855898032.png)![1779856399797](image/helpdesk_ticket_creation_flow/1779856399797.png)![1779856401180](image/helpdesk_ticket_creation_flow/1779856401180.png)![1779856463790](image/helpdesk_ticket_creation_flow/1779856463790.png)![1779856475822](image/helpdesk_ticket_creation_flow/1779856475822.png)![1779856773629](image/helpdesk_ticket_creation_flow/1779856773629.png)![1779857480304](image/helpdesk_ticket_creation_flow/1779857480304.png)![1779857902742](image/helpdesk_ticket_creation_flow/1779857902742.png)![1779859303820](image/helpdesk_ticket_creation_flow/1779859303820.png)![1779859420794](image/helpdesk_ticket_creation_flow/1779859420794.png)![1779859442292](image/helpdesk_ticket_creation_flow/1779859442292.png)![1779860256763](image/helpdesk_ticket_creation_flow/1779860256763.png)![1779860436376](image/helpdesk_ticket_creation_flow/1779860436376.png)![1779860454755](image/helpdesk_ticket_creation_flow/1779860454755.png)![1779860773236](image/helpdesk_ticket_creation_flow/1779860773236.png)![1779860807705](image/helpdesk_ticket_creation_flow/1779860807705.png)![1779860820558](image/helpdesk_ticket_creation_flow/1779860820558.png)![1779862016952](image/helpdesk_ticket_creation_flow/1779862016952.png)![1779862019361](image/helpdesk_ticket_creation_flow/1779862019361.png)![1779862093161](image/helpdesk_ticket_creation_flow/1779862093161.png)![1779863399143](image/helpdesk_ticket_creation_flow/1779863399143.png)![1779863577102](image/helpdesk_ticket_creation_flow/1779863577102.png)![1779863613693](image/helpdesk_ticket_creation_flow/1779863613693.png)![1779863639207](image/helpdesk_ticket_creation_flow/1779863639207.png)![1779864204300](image/helpdesk_ticket_creation_flow/1779864204300.png)![1779864274299](image/helpdesk_ticket_creation_flow/1779864274299.png)![1779864388403](image/helpdesk_ticket_creation_flow/1779864388403.png)![1779864821906](image/helpdesk_ticket_creation_flow/1779864821906.png)![1779865527658](image/helpdesk_ticket_creation_flow/1779865527658.png)![1779865557007](image/helpdesk_ticket_creation_flow/1779865557007.png)![1779867355277](image/helpdesk_ticket_creation_flow/1779867355277.png)![1779869952722](image/helpdesk_ticket_creation_flow/1779869952722.png)![1779870499179](image/helpdesk_ticket_creation_flow/1779870499179.png)![1779872844659](image/helpdesk_ticket_creation_flow/1779872844659.png)![1779872845642](image/helpdesk_ticket_creation_flow/1779872845642.png)![1779873585894](image/helpdesk_ticket_creation_flow/1779873585894.png)![1779873633703](image/helpdesk_ticket_creation_flow/1779873633703.png)![1779875149796](image/helpdesk_ticket_creation_flow/1779875149796.png)\
  -> ไปหน้า Confirm
  -> Submit Ticket
  -> ส่งเข้า Odoo หรือระบบปลายทาง![1779940929745](image/helpdesk_ticket_creation_flow/1779940929745.png)![1779941293798](image/helpdesk_ticket_creation_flow/1779941293798.png)![1779941738133](image/helpdesk_ticket_creation_flow/1779941738133.png)![1779948389223](image/helpdesk_ticket_creation_flow/1779948389223.png)![1779948390316](image/helpdesk_ticket_creation_flow/1779948390316.png)![1779949298091](image/helpdesk_ticket_creation_flow/1779949298091.png)
```

## ไฟล์หลัก

| ไฟล์ | หน้าที่ |
|---|---|
| `deploy/pages_bundle/help-desk-v3-create.html` | หน้าเริ่มสร้าง Ticket, เลือก Project/Sup Project, กรอกรายละเอียด, เรียก API วิเคราะห์ |
| `deploy/pages_bundle/_worker.js` | Backend API, prompt วิเคราะห์, fallback rule, query master data, submit ticket |
| `deploy/pages_bundle/help-desk-v3-analysis.html` | หน้าแสดงผลวิเคราะห์, เลือก action, เลือกผู้รับผิดชอบตาม role ของโครงการ |
| `deploy/pages_bundle/help-desk-v3-confirm.html` | หน้าสรุปก่อนส่งจริง |
| `deploy/pages_bundle/role-helpdesk.html` | หน้าจัดการ role ของคนในแต่ละโครงการ |
| `docs/hd_master_data_map.md` | เอกสารอธิบายตาราง master data ของ Helpdesk |

## ตารางข้อมูลที่เกี่ยวข้อง

| ตาราง | หน้าที่ |
|---|---|
| `hd_users` | เก็บข้อมูลคนกลาง เช่น ชื่อ, email, phone, department, ข้อมูลทั่วไป |
| `hd_projects` | เก็บข้อมูลโครงการ |
| `hd_sub_projects` | เก็บข้อมูลโครงการย่อย |
| `hd_teams` | เก็บข้อมูลทีมและสมาชิกจาก master เดิม |
| `hd_main_team_project` | ความสัมพันธ์ทีม/คนกับโครงการจากข้อมูล import เดิม |
| `hd_project_member_roles` | ตารางหลักสำหรับบอกว่าในโครงการนี้ คนนี้เป็น PM, IT Support หรือ Dev |
| ticket history/local tickets | เก็บ Ticket ที่สร้างแล้ว เพื่อใช้เป็นประวัติและช่วยวิเคราะห์เคสใหม่ |

## Flow ที่ควรเป็น

### 1. Create

หน้า: `help-desk-v3-create.html`

ผู้ใช้ทำแค่:

- เลือก Project
- เลือก Sup Project ถ้ามี
- ใส่รายละเอียดปัญหา
- แนบข้อมูลหรือข้อความจากผู้แจ้ง

หน้านี้ไม่ควรให้เลือก Dev/PM/IT Support เพราะยังไม่ได้วิเคราะห์ปัญหา

Output ที่ควรส่งต่อ:

```txt
projectCode
projectName
subprojectCode
subprojectName
issueTitle
requester
reportedAt
department
contentText
contentLines
urls
```

### 2. Analyze

API: `/api/helpdesk/analyze`

ไฟล์: `_worker.js`

Worker ทำหน้าที่:

- รับข้อมูลจากหน้า Create
- หา Helpdeck Knowledge ที่เกี่ยวข้อง
- หา Ticket เก่าที่คล้าย
- สร้าง `systemPrompt`
- สร้าง `userPrompt`
- ส่งให้ Azure/OpenAI วิเคราะห์
- คืนผลเป็น JSON

ผลลัพธ์หลัก:

```txt
problem_type
severity
priority_level
priority_detail
module_or_area
summary
likely_cause
quick_fixes
clarifying_questions
when_to_escalate
keywords
linked_knowledge
linked_tickets
```

ถ้า AI ใช้ไม่ได้:

- ใช้ fallback rule ใน `_worker.js`
- ไม่ควรปล่อยให้หน้าเว็บค้าง
- ต้องคืนผล local fallback กลับมาเสมอ

### 3. Analysis

หน้า: `help-desk-v3-analysis.html`

หน้านี้ควรใช้ Project จากหน้า Create เท่านั้น

ไม่ควรมีการเลือก Project ใหม่ในหน้านี้ เพราะจะทำให้ flow สับสนและ route ผิดโครงการ

หน้าที่ของหน้า Analysis:

- แสดงผลวิเคราะห์
- ให้แก้ประเภทปัญหาได้ถ้า AI วิเคราะห์ผิด
- ให้เลือก action ที่ต้องการ
- เลือกผู้รับผิดชอบตาม role ในโครงการนั้น

Action ที่ควรมี:

| Action | แหล่งข้อมูลผู้รับผิดชอบ |
|---|---|
| ส่งต่อ PM | `hd_project_member_roles` role = `PM` ของ project นั้น |
| ส่งต่อ IT Support | `hd_project_member_roles` role = `IT Support` ของ project นั้น |
| ส่งต่อ Dev | `hd_project_member_roles` role = `Dev` ของ project นั้น |
| ยังไม่ส่งต่อ | ไม่ต้องเลือกคน |

หลักสำคัญ:

```txt
Dev dropdown ต้องแสดงเฉพาะ Dev ของ projectCode ที่ติดมากับ Ticket
PM dropdown ต้องแสดงเฉพาะ PM ของ projectCode ที่ติดมากับ Ticket
IT Support dropdown ต้องแสดงเฉพาะ IT Support ของ projectCode ที่ติดมากับ Ticket
```

### 4. Confirm

หน้า: `help-desk-v3-confirm.html`

หน้านี้ควรเป็นหน้าตรวจสอบก่อนส่งจริง

ข้อมูลที่ต้องแสดง:

- Project
- Sup Project
- ประเภทปัญหา
- ความเร่งด่วน
- สรุปปัญหา
- ผู้รับผิดชอบหรือทีมที่ส่งต่อ
- รายละเอียดปัญหา
- ผลวิเคราะห์สำคัญ

ข้อมูลที่ต้องส่งต่อ:

```txt
projectCode
subprojectCode
problem_type
severity
summary
description
routeMode
routeTarget
assignedUser
analysis
```

### 5. Submit

ไฟล์: `_worker.js`

Worker ทำหน้าที่:

- รับ payload จากหน้า Confirm
- ตรวจข้อมูลที่จำเป็น
- ส่ง Ticket เข้า Odoo หรือระบบปลายทาง
- บันทึก local ticket/audit trail
- คืนผลการสร้าง ticket ให้หน้าเว็บ

### 6. Learn

หลังสร้าง Ticket แล้ว ระบบควรเก็บข้อมูลเพื่อใช้วิเคราะห์ครั้งถัดไป

ข้อมูลที่ควรเก็บ:

- ประเภทปัญหาที่สุดท้ายใช้จริง
- Project/Sup Project
- ผู้รับผิดชอบ
- summary
- description
- route/action
- ticket id จากระบบปลายทาง
- วันที่สร้าง

## หลักการออกแบบ Role

อย่าใช้ `hd_users.position` เป็นตัวตัดสินว่าใครเป็น PM/Dev/IT Support ในทุกโครงการ

เหตุผล:

- คนเดียวกันอาจเป็น Dev ในโครงการหนึ่ง
- แต่เป็น IT Support ในอีกโครงการหนึ่ง
- หรือเป็น PM เฉพาะบางโครงการ

ดังนั้นควรยึดแบบนี้:

```txt
hd_users = คนนี้คือใคร
hd_projects = โครงการอะไร
hd_project_member_roles = ในโครงการนี้ คนนี้เป็น role อะไร
```

## Decision ที่ต้องล็อกก่อนแก้ Flow

- หน้า Create เลือกเฉพาะ Project/Sup Project และรายละเอียดปัญหา
- หน้า Analysis ห้ามเลือก Project ใหม่
- การเลือก PM/IT Support/Dev ต้องอิงจาก `hd_project_member_roles`
- `hd_users.position` ใช้แสดงข้อมูลทั่วไปเท่านั้น ไม่ใช้ route งาน
- ถ้าไม่มีคนใน role ของ project นั้น ต้องแสดง empty state ชัดเจน ไม่ดึงคนทั้งระบบมาแทน

## จุดเสี่ยงที่ต้องเช็ค

- localStorage/sessionStorage อาจมีข้อมูลเก่าค้าง ทำให้ analysis ใช้ project ผิด
- fallback rule ในหน้า create และ worker อาจให้ problem type ไม่ตรงกัน
- Dev dropdown ต้องไม่ fallback ไปดึง Dev ทั้งระบบ
- ถ้า projectCode สะกดไม่ตรงกันระหว่าง master tables จะทำให้หา role ไม่เจอ
- ถ้า AI timeout ต้องไม่ทำให้หน้า create หรือ analysis ค้าง

## Flow เป้าหมายแบบสั้น

```txt
Create
  -> เลือก Project/Sup Project
  -> กรอกปัญหา

Analyze
  -> AI วิเคราะห์ problem_type/severity/summary
  -> fallback ถ้า AI fail

Analysis
  -> ใช้ Project เดิม
  -> เลือก action
  -> เลือก PM/IT Support/Dev จาก hd_project_member_roles ของ Project นั้น

Confirm
  -> ตรวจข้อมูล
  -> Submit

Submit
  -> ส่งเข้า Odoo/ระบบปลายทาง
  -> บันทึก history
```
