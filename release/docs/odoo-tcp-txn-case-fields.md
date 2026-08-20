# Odoo `tcp.txn.case` Field Reference

เอกสารนี้สรุปข้อมูลจากหน้า Odoo URL:

`https://bt.dev.demotoday.net/web#id=&action=172&model=tcp.txn.case&view_type=form&menu_id=144`

ตรวจสอบเมื่อ: 2026-06-08  
ระบบปลายทาง: Odoo 12  
Database: `bt-helpdesk`  
Action: `172` / `Case`  
Model: `tcp.txn.case`  
Form view: `view.tcp.txn.case.form`  
Form view ID: `481`

## สรุปภาพรวม

หน้า form นี้เป็นหน้า Case ของระบบ Help Desk บน Odoo ใช้สำหรับสร้าง ดู แก้ไข และติดตามเคส โดยมีข้อมูลหลักเกี่ยวกับช่องทางรับเรื่อง บริการที่เกี่ยวข้อง หัวข้อเคส รายละเอียด สถานะ SLA ผู้รับผิดชอบ ไฟล์แนบ รูปภาพ แชท กิจกรรม และข้อมูลการอนุมัติ

จาก form view ที่ดึงได้ มี field ทั้งหมด 61 fields และมี required fields 4 fields:

| Field | Label | Type | หมายเหตุ |
| --- | --- | --- | --- |
| `channel_id` | Channel | many2one | ต้องเลือกช่องทางรับเรื่อง |
| `service_id` | Project / Service | many2one | ต้องเลือกบริการ/โครงการ |
| `case_subject` | Case Subject | char | หัวข้อเคส |
| `case_status` | Status | selection | สถานะเคส |

## ข้อมูลการเชื่อมต่อ Odoo

ระบบปลายทางเป็น Odoo 12 และใช้งานผ่าน web session/JSON-RPC endpoint ของ Odoo

| รายการ | ค่า |
| --- | --- |
| Base URL | `https://bt.dev.demotoday.net` |
| Login page | `/web/login` |
| Session info endpoint | `/web/session/get_session_info` |
| Action load endpoint | `/web/action/load` |
| Dataset call endpoint | `/web/dataset/call_kw` |
| Database ที่ตรวจพบ | `bt-helpdesk` |
| Odoo server version | `12.0` |
| Target model | `tcp.txn.case` |
| Target action | `172` |
| Target form view ID | `481` |

### วิธี login

Odoo login page ต้องใช้ `csrf_token` จาก HTML form ก่อน POST login

ขั้นตอน:

1. `GET /web/login`
2. อ่านค่า hidden input `csrf_token`
3. `POST /web/login` พร้อม `csrf_token`, `login`, `password`, `redirect`
4. เก็บ cookie `session_id`
5. ตรวจ session ด้วย `POST /web/session/get_session_info`

ตัวอย่าง form body:

```txt
csrf_token=<token-from-login-page>
login=<username>
password=<password>
redirect=
```

หลัง login สำเร็จ endpoint `/web/session/get_session_info` จะคืนข้อมูลประมาณนี้:

```json
{
  "uid": 2,
  "is_system": true,
  "is_admin": true,
  "db": "bt-helpdesk",
  "server_version": "12.0",
  "name": "Administrator",
  "username": "admin"
}
```

หมายเหตุด้านความปลอดภัย:

- ไม่ควร hardcode username/password ใน frontend
- ควรเก็บ credential ที่ backend หรือ secret manager เท่านั้น
- ถ้าทำ integration จริง ควรใช้ service account แยกจาก user admin
- ควรตั้ง timeout และ retry เฉพาะ error ที่ retry ได้ เช่น network timeout

### วิธีโหลด action

ใช้ endpoint:

`POST /web/action/load`

Payload:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "action_id": 172
  },
  "id": 1
}
```

ผลที่ตรวจพบ:

```json
{
  "name": "Case",
  "res_model": "tcp.txn.case",
  "view_mode": "kanban,list,form",
  "views": [
    [480, "kanban"],
    [482, "list"],
    [481, "form"]
  ]
}
```

### วิธีโหลด form metadata

ใช้ endpoint:

`POST /web/dataset/call_kw`

Payload:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "tcp.txn.case",
    "method": "fields_view_get",
    "args": [481, "form"],
    "kwargs": {}
  },
  "id": 2
}
```

ใช้ response จาก `fields_view_get` เพื่ออ่าน:

- รายชื่อ fields
- label
- type
- required
- readonly
- relation model
- selection values
- XML arch ของ form view

### วิธีเรียก model method ทั่วไป

Odoo 12 ใช้ JSON-RPC ผ่าน `/web/dataset/call_kw` โดยรูปแบบหลักคือ:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "<model-name>",
    "method": "<method-name>",
    "args": [],
    "kwargs": {}
  },
  "id": 1
}
```

ตัวอย่างนับจำนวน case:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "tcp.txn.case",
    "method": "search_count",
    "args": [[]],
    "kwargs": {}
  },
  "id": 3
}
```

ตัวอย่างค้นหาและอ่าน case:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "tcp.txn.case",
    "method": "search_read",
    "args": [
      [["case_status", "=", "open"]]
    ],
    "kwargs": {
      "fields": ["case_ticket_id", "case_subject", "case_status", "write_date"],
      "limit": 20,
      "order": "write_date desc"
    }
  },
  "id": 4
}
```

### วิธีสร้าง case

ใช้ method `create` บน model `tcp.txn.case`

ตัวอย่าง payload:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "tcp.txn.case",
    "method": "create",
    "args": [
      {
        "channel_id": 1,
        "service_id": 10,
        "case_subject": "Login เข้าใช้งานไม่ได้",
        "case_desc": "ผู้ใช้แจ้งว่า login แล้วระบบขึ้น error",
        "case_status": "open",
        "case_type": "human_error",
        "customer": "noo88",
        "case_ticket_id": "BT-2026-0001",
        "priority_id": 3,
        "impact_level": "yes"
      }
    ],
    "kwargs": {}
  },
  "id": 5
}
```

ข้อสำคัญ:

- `many2one` ต้องส่งเป็น numeric Odoo record id เช่น `channel_id: 1`
- `selection` ต้องส่งเป็น value เช่น `case_type: "human_error"` ไม่ใช่ label `Human Error`
- `one2many` ต้องส่งด้วย Odoo command format เช่น `[[0, 0, {...}]]`
- readonly fields ไม่ควรส่งใน payload

### วิธีแก้ไข case

ใช้ method `write`

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "tcp.txn.case",
    "method": "write",
    "args": [
      [123],
      {
        "case_status": "process",
        "case_note": "รับเรื่องและกำลังตรวจสอบ"
      }
    ],
    "kwargs": {}
  },
  "id": 6
}
```

`123` คือ Odoo record id ของ case

### วิธีหา master data สำหรับ many2one

ก่อนสร้าง case ต้องหา id ของ master data เช่น channel, service, priority

ตัวอย่างหา channel:

```json
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": {
    "model": "tcp.mdm.channel",
    "method": "search_read",
    "args": [[]],
    "kwargs": {
      "fields": ["id", "name"],
      "limit": 100
    }
  },
  "id": 7
}
```

model master data ที่เกี่ยวข้อง:

| Field | Master model |
| --- | --- |
| `channel_id` | `tcp.mdm.channel` |
| `service_id` | `tcp.mdm.service` |
| `service_sub_id` | `tcp.mdm.service.sub` |
| `priority_id` | `tcp.mdm.priority` |
| `agency_id` | `mdm.agency` |
| `district_id` | `mdm.district` |
| `faction_id` | `mdm.faction` |
| `request_type_id` | `tcp.request.type` |
| `complaint_topic_id` | `tcp.complaint.topic` |
| `report_topic_id` | `tcp.report.topic` |
| `owner_team_id` | `tcp.main.team` |
| `owner_officer_id` | `hr.employee` |

### Flow ที่แนะนำสำหรับ BETIME Integration

1. Backend BETIME รับ ticket จาก frontend
2. Backend login Odoo หรือ reuse session ที่ยังไม่หมดอายุ
3. Resolve master data จาก label/code เป็น Odoo id
4. Validate required fields: `channel_id`, `service_id`, `case_subject`, `case_status`
5. Create `tcp.txn.case`
6. ถ้ามีไฟล์/รูป/แชท ให้สร้าง child records ต่อหลังจากได้ case id
7. เก็บ Odoo case id กลับมาใน BETIME เพื่อใช้ sync รอบถัดไป
8. แสดงสถานะ sync ให้ผู้ใช้เห็น เช่น pending, synced, failed

### Error Handling ที่ควรทำ

| กรณี | วิธีจัดการ |
| --- | --- |
| session หมดอายุ | login ใหม่แล้ว retry 1 ครั้ง |
| master data ไม่เจอ | แจ้ง mapping error และไม่สร้าง case |
| required field ไม่ครบ | reject ตั้งแต่ฝั่ง BETIME ก่อนเรียก Odoo |
| Odoo validation error | เก็บ raw error ไว้ใน log backend และแสดงข้อความอ่านง่ายให้ผู้ใช้ |
| network timeout | retry แบบจำกัดจำนวน |
| create สำเร็จแต่ attach file ล้มเหลว | อย่าลบ case ทันที ให้ mark partial sync แล้ว retry attachment |

## Required Fields

### `channel_id`

- Label: `Channel`
- Type: `many2one`
- Relation: `tcp.mdm.channel`
- Required: yes
- ใช้เก็บช่องทางรับแจ้ง เช่น web, phone, chat, walk-in หรือ channel อื่นที่ master data กำหนดไว้
- เวลา integrate จากระบบ BETIME ควร map จากช่องทางที่ผู้ใช้สร้าง ticket เข้ามา

### `service_id`

- Label: `Project / Service`
- Type: `many2one`
- Relation: `tcp.mdm.service`
- Required: yes
- ใช้เก็บ project/service หลักของเคส
- เป็น field สำคัญมาก เพราะน่าจะมีผลต่อ request type, topic, SLA, owner team หรือ workflow ต่อเนื่อง

### `case_subject`

- Label: `Case Subject`
- Type: `char`
- Required: yes
- ใช้เก็บหัวข้อเคสแบบสั้น
- จาก BETIME ควร map จากชื่อเรื่อง ticket หรือสรุปปัญหา

### `case_status`

- Label: `Status`
- Type: `selection`
- Required: yes
- Allowed values:

| Value | Label |
| --- | --- |
| `open` | Open |
| `process` | In Process |
| `finish` | Finish |
| `closed` | Closed |
| `cancel` | Cancel |

ค่าเริ่มต้นที่เหมาะสำหรับการสร้าง case ใหม่จาก BETIME คือ `open` เว้นแต่ workflow ฝั่ง Odoo มี default ของตัวเองอยู่แล้ว

## Field Groups

## 1. ข้อมูลระบุเคส

| Field | Label | Type | Required | Readonly | Relation / Values |
| --- | --- | --- | --- | --- | --- |
| `case_ticket_id` | Ticket | char | no | no | - |
| `case_ref_code` | เลขที่อ้างอิง | char | no | no | - |
| `case_ref_code_type` | Case Ref Code Type | selection | no | yes | `1=เลขที่คำขอ`, `2=เลขที่คดี` |
| `uuid` | UUID | char | no | no | - |
| `case_private` | Case Private | boolean | no | no | - |

คำแนะนำการใช้งาน:

- `case_ticket_id` เหมาะสำหรับเก็บ ticket id จากระบบ BETIME
- `case_ref_code` เหมาะสำหรับเก็บเลขอ้างอิงภายนอก เช่น เลขคำขอหรือเลขเคสเดิม
- `uuid` อาจใช้เป็น external id สำหรับกันการสร้างซ้ำ ถ้าฝั่ง Odoo ใช้งาน field นี้ใน logic อยู่แล้ว
- `case_private` ใช้ระบุเคสส่วนตัวหรือเคสที่จำกัดการมองเห็น

## 2. หัวข้อและรายละเอียดเคส

| Field | Label | Type | Required | Readonly | Relation / Values |
| --- | --- | --- | --- | --- | --- |
| `case_subject` | Case Subject | char | yes | no | - |
| `case_desc` | Case Description | text | no | no | - |
| `case_note` | Note | text | no | no | - |
| `case_type` | Case Type | selection | no | no | ดูตารางด้านล่าง |
| `customer` | ชื่อลูกค้า | char | no | no | - |

Allowed values ของ `case_type`:

| Value | Label |
| --- | --- |
| `system_error` | System Error |
| `system_bug` | System Bug |
| `human_error` | Human Error |
| `hardware` | Hardware |
| `software` | Software |
| `network` | Network |
| `change_request` | Change Request |
| `power_outage` | Power Outage |
| `network_issue` | Network Issue |
| `server_failure` | Server Failure |
| `application_error` | Application Error |
| `security_incident` | Security Incident |
| `hardware_failure` | Hardware Failure |
| `software_bug` | Software Bug |
| `performance_issue` | Performance Issue |
| `backup_failure` | Backup Failure |
| `other` | Other |
| `data` | Data |

คำแนะนำการใช้งาน:

- ปุ่ม/ช่อง "ประเภทปัญหา" ใน BETIME ควร map ไปที่ `case_type`
- ตัวอย่างจากหน้าที่ผู้ใช้เคยให้ดู `Human error` ควรส่งค่าเป็น `human_error`
- รายละเอียดปัญหาหลักควร map ไป `case_desc`
- หมายเหตุภายในหรือข้อมูลเสริมควร map ไป `case_note`

## 3. ช่องทาง บริการ และพื้นที่

| Field | Label | Type | Required | Readonly | Relation |
| --- | --- | --- | --- | --- | --- |
| `channel_id` | Channel | many2one | yes | no | `tcp.mdm.channel` |
| `service_id` | Project / Service | many2one | yes | no | `tcp.mdm.service` |
| `service_sub_id` | Project / Service Sub | many2one | no | no | `tcp.mdm.service.sub` |
| `area_id` | Area | many2one | no | no | `tcp.main.area` |
| `agency_id` | Agency | many2one | no | no | `mdm.agency` |
| `faction_id` | Faction | many2one | no | no | `mdm.faction` |
| `district_id` | สำนักงานเขต | many2one | no | no | `mdm.district` |

คำแนะนำการใช้งาน:

- `service_id` เป็น master สำคัญ ต้อง resolve เป็น Odoo id ก่อนสร้าง case
- `service_sub_id` ควรใช้เมื่อ BETIME มีหมวดย่อยของบริการ
- `agency_id`, `faction_id`, `district_id` ใช้ map หน่วยงาน/สำนักงานจาก BETIME
- ถ้าระบบ BETIME เก็บเป็นข้อความ ต้องทำ lookup ไปยัง Odoo master ก่อนส่งค่า many2one

## 4. ประเภทคำขอและหัวข้อการแจ้ง

| Field | Label | Type | Required | Readonly | Relation |
| --- | --- | --- | --- | --- | --- |
| `request_type_id` | ประเภทใบคำขอ | many2one | no | no | `tcp.request.type` |
| `domain_request_type_ids` | Domain Request Type | many2many | no | yes | `tcp.request.type` |
| `complaint_topic_id` | หัวข้อการแจ้ง | many2one | no | no | `tcp.complaint.topic` |
| `report_topic_id` | รายงานหัวข้อการแจ้ง | many2one | no | no | `tcp.report.topic` |
| `criteria_id` | Criteria | many2one | no | no | `mdm.criteria` |

คำแนะนำการใช้งาน:

- `request_type_id` คือประเภทใบคำขอ
- `complaint_topic_id` คือหัวข้อการแจ้งทั่วไป
- `report_topic_id` คือหัวข้อสำหรับรายงาน/สรุปผล
- `domain_request_type_ids` เป็น readonly จึงไม่ควรส่งตอน create/update โดยตรง
- ถ้าหน้า BETIME มีช่อง "หัวข้ออันที่ 4 / ประเภทปัญหา" ต้องแยกให้ชัดว่าเป็น `case_type` หรือ `request_type_id`

## 5. วันเวลาและ SLA

| Field | Label | Type | Required | Readonly |
| --- | --- | --- | --- | --- |
| `case_date` | Case Date | datetime | no | no |
| `case_date_process` | Case Date Process | datetime | no | no |
| `case_date_finish` | Case Date Finish | datetime | no | no |
| `active_date` | วันเวลาที่ตอบตามจริง | datetime | no | no |
| `finish_date` | วันเวลาที่เสร็จสิ้นตามจริง | datetime | no | no |
| `priority_active_date` | วันเวลาที่ตอบตาม SLA | datetime | no | yes |
| `priority_finish_date` | วันเวลาที่เสร็จสิ้นตาม SLA | datetime | no | yes |
| `write_date` | Last Updated on | datetime | no | yes |

คำแนะนำการใช้งาน:

- `case_date` เหมาะสำหรับวันที่สร้าง/วันที่รับเรื่อง
- `case_date_process` เหมาะสำหรับเวลาที่เริ่มดำเนินการ
- `case_date_finish` หรือ `finish_date` เหมาะสำหรับเวลาปิดงานจริง ต้องตรวจ business rule ก่อนเลือกใช้
- `priority_active_date` และ `priority_finish_date` เป็น readonly น่าจะคำนวณจาก priority/SLA ฝั่ง Odoo
- ไม่ควรส่งค่า readonly fields ตอน create/update

## 6. Priority, Impact และ SLA Status

| Field | Label | Type | Required | Readonly | Relation / Values |
| --- | --- | --- | --- | --- | --- |
| `priority_id` | Priority | many2one | no | no | `tcp.mdm.priority` |
| `impact_level` | ระดับผลกระทบ | selection | no | no | `yes=กระทบ`, `no=ไม่กระทบ` |
| `priority_late_flag` | ประเภทเกินกำหนด | selection | no | yes | `N=ไม่เกิน SLA`, `NR=ไม่ตอบเกิน SLA`, `NF=ไม่เสร็จเกิน SLA` |

คำแนะนำการใช้งาน:

- ถ้า BETIME มี SLA card เช่น `Res 0, Sol 3 h` ควร map ผ่าน `priority_id`
- `impact_level` ใช้ระบุว่าปัญหากระทบงานหรือไม่
- `priority_late_flag` เป็น readonly และควรปล่อยให้ Odoo คำนวณ

## 7. ผู้รับผิดชอบและการมอบหมายงาน

| Field | Label | Type | Required | Readonly | Relation |
| --- | --- | --- | --- | --- | --- |
| `owner_team_id` | Owner Team | many2one | no | no | `tcp.main.team` |
| `owner_officer_id` | Owner Officer | many2one | no | no | `hr.employee` |
| `delegate_team_id` | Delegate Team | many2one | no | no | `tcp.main.team` |
| `delegate_officer_id` | Delegate Officer | many2one | no | no | `hr.employee` |
| `assign_ids` | Assign | one2many | no | no | `tcp.txn.case.assign` |
| `assign_dev_ids` | Assign Dev | one2many | no | no | `tcp.txn.case.assign.dev` |
| `is_os` | กรณี Assign Out Source | boolean | no | no | - |
| `os_name` | ชื่อ - สกุล Out Source | char | no | no | - |

คำแนะนำการใช้งาน:

- การสร้างเคสครั้งแรกอาจส่งแค่ `owner_team_id` หรือปล่อยให้ Odoo route งานเอง
- `assign_ids` และ `assign_dev_ids` เป็น one2many ต้องส่งด้วย Odoo command format ถ้าต้องการสร้าง child records พร้อม case
- `is_os` และ `os_name` ใช้กรณีมอบหมายงานให้ outsource

## 8. การแก้ไขปัญหาและ RCA

| Field | Label | Type | Required | Readonly |
| --- | --- | --- | --- | --- |
| `problem_cause_remark` | สาเหตุของการเกิดปัญหา | text | no | no |
| `problem_solution_remark` | วิธีการแก้ไขปัญหา | text | no | no |
| `problem_solution_remark_detail` | รายละเอียดการแก้ไขปัญหา | text | no | no |
| `change_detail` | รายละเอียดการเปลี่ยนแปลง | text | no | no |

คำแนะนำการใช้งาน:

- ใช้กลุ่มนี้ตอนวิเคราะห์/ปิดเคส
- หน้า `help-desk-v3-analysis` ของ BETIME สามารถ map ข้อมูล MANA/AI analysis หรือ RCA ไปยังกลุ่มนี้ได้
- ถ้ามีคำตอบจาก AI ควรแยก "สาเหตุ", "วิธีแก้", "รายละเอียด" ให้ลง field ถูกตัว

## 9. Attachment, Image, Chat, Activity และ Approval

| Field | Label | Type | Required | Readonly | Relation |
| --- | --- | --- | --- | --- | --- |
| `image_ids` | Case Image | one2many | no | no | `tcp.txn.case.image` |
| `attach_ids` | Attachment | one2many | no | no | `tcp.txn.case.attach` |
| `chat_ids` | Chat | one2many | no | no | `tcp.txn.case.chat` |
| `activity_ids` | Activity | one2many | no | no | `tcp.txn.case.activity` |
| `approval_ids` | Approval | one2many | no | no | `tcp.txn.case.approval` |
| `approval_status` | สถานะการอนุมัติ | selection | no | no | ดูตารางด้านล่าง |
| `tm_synced` | Closed in TM | boolean | no | yes | - |

Allowed values ของ `approval_status`:

| Value | Label |
| --- | --- |
| `waiting_approval` | รออนุมัติ |
| `approved` | อนุมัติ |
| `rejected` | ไม่อนุมัติ |

คำแนะนำการใช้งาน:

- รูปและไฟล์แนบควรสร้างผ่าน child model หรือ endpoint upload ที่ Odoo รองรับ ไม่ควรยัด binary ลง field หลักของ case
- `chat_ids` เหมาะสำหรับเก็บประวัติแชทหรือข้อความสนทนา
- `activity_ids` เหมาะสำหรับ timeline/action log
- `tm_synced` เป็น readonly ไม่ควรส่งค่า

## 10. Field ควบคุมการแสดงผล

กลุ่มนี้เป็น boolean readonly ใช้ให้ Odoo ซ่อน/แสดงช่องใน form ตาม service, request type หรือ rule ภายใน:

| Field | Label | Type | Readonly |
| --- | --- | --- | --- |
| `is_show_case_ref_code` | Show Case Ref Code | boolean | yes |
| `is_show_district` | Show สำนักงานเขต | boolean | yes |
| `is_show_request_type` | Show ประเภทใบคำขอ | boolean | yes |
| `is_show_report_topic` | Show รายงานหัวข้อการแจ้ง | boolean | yes |
| `is_show_last_updated` | Show วันที่อัปเดตล่าสุด | boolean | yes |
| `is_show_complaint_topic` | Show หัวข้อการแจ้ง | boolean | yes |
| `is_show_agency` | Show หน่วยงาน | boolean | yes |
| `is_show_faction` | Show ฝ่าย | boolean | yes |

คำแนะนำการใช้งาน:

- ไม่ควรส่งค่ากลุ่มนี้จาก BETIME
- ควรให้ Odoo compute หรือ onchange เอง
- ถ้า BETIME ต้อง mirror UI แบบ Odoo อาจต้องเรียก onchange/metadata เพื่อดูว่า field ไหนควรแสดง

## Full Field List

| Field | Label | Type | Required | Readonly | Relation / Values |
| --- | --- | --- | --- | --- | --- |
| `active_date` | วันเวลาที่ตอบตามจริง | datetime | no | no | - |
| `activity_ids` | Activity | one2many | no | no | `tcp.txn.case.activity` |
| `agency_id` | Agency | many2one | no | no | `mdm.agency` |
| `approval_ids` | Approval | one2many | no | no | `tcp.txn.case.approval` |
| `approval_status` | สถานะการอนุมัติ | selection | no | no | `waiting_approval`, `approved`, `rejected` |
| `area_id` | Area | many2one | no | no | `tcp.main.area` |
| `assign_dev_ids` | Assign Dev | one2many | no | no | `tcp.txn.case.assign.dev` |
| `assign_ids` | Assign | one2many | no | no | `tcp.txn.case.assign` |
| `attach_ids` | Attachment | one2many | no | no | `tcp.txn.case.attach` |
| `case_date` | Case Date | datetime | no | no | - |
| `case_date_finish` | Case Date Finish | datetime | no | no | - |
| `case_date_process` | Case Date Process | datetime | no | no | - |
| `case_desc` | Case Description | text | no | no | - |
| `case_note` | Note | text | no | no | - |
| `case_private` | Case Private | boolean | no | no | - |
| `case_ref_code` | เลขที่อ้างอิง | char | no | no | - |
| `case_ref_code_type` | Case Ref Code Type | selection | no | yes | `1`, `2` |
| `case_status` | Status | selection | yes | no | `open`, `process`, `finish`, `closed`, `cancel` |
| `case_subject` | Case Subject | char | yes | no | - |
| `case_ticket_id` | Ticket | char | no | no | - |
| `case_type` | Case Type | selection | no | no | `system_error`, `system_bug`, `human_error`, `hardware`, `software`, `network`, `change_request`, `power_outage`, `network_issue`, `server_failure`, `application_error`, `security_incident`, `hardware_failure`, `software_bug`, `performance_issue`, `backup_failure`, `other`, `data` |
| `change_detail` | รายละเอียดการเปลี่ยนแปลง | text | no | no | - |
| `channel_id` | Channel | many2one | yes | no | `tcp.mdm.channel` |
| `chat_ids` | Chat | one2many | no | no | `tcp.txn.case.chat` |
| `complaint_topic_id` | หัวข้อการแจ้ง | many2one | no | no | `tcp.complaint.topic` |
| `criteria_id` | Criteria | many2one | no | no | `mdm.criteria` |
| `customer` | ชื่อลูกค้า | char | no | no | - |
| `delegate_officer_id` | Delegate Officer | many2one | no | no | `hr.employee` |
| `delegate_team_id` | Delegate Team | many2one | no | no | `tcp.main.team` |
| `district_id` | สำนักงานเขต | many2one | no | no | `mdm.district` |
| `domain_request_type_ids` | Domain Request Type | many2many | no | yes | `tcp.request.type` |
| `faction_id` | Faction | many2one | no | no | `mdm.faction` |
| `finish_date` | วันเวลาที่เสร็จสิ้นตามจริง | datetime | no | no | - |
| `image_ids` | Case Image | one2many | no | no | `tcp.txn.case.image` |
| `impact_level` | ระดับผลกระทบ | selection | no | no | `yes`, `no` |
| `is_os` | กรณี Assign Out Source | boolean | no | no | - |
| `is_show_agency` | Show หน่วยงาน | boolean | no | yes | - |
| `is_show_case_ref_code` | Show Case Ref Code | boolean | no | yes | - |
| `is_show_complaint_topic` | Show หัวข้อการแจ้ง | boolean | no | yes | - |
| `is_show_district` | Show สำนักงานเขต | boolean | no | yes | - |
| `is_show_faction` | Show ฝ่าย | boolean | no | yes | - |
| `is_show_last_updated` | Show วันที่อัปเดตล่าสุด | boolean | no | yes | - |
| `is_show_report_topic` | Show รายงานหัวข้อการแจ้ง | boolean | no | yes | - |
| `is_show_request_type` | Show ประเภทใบคำขอ | boolean | no | yes | - |
| `os_name` | ชื่อ - สกุล Out Source | char | no | no | - |
| `owner_officer_id` | Owner Officer | many2one | no | no | `hr.employee` |
| `owner_team_id` | Owner Team | many2one | no | no | `tcp.main.team` |
| `priority_active_date` | วันเวลาที่ตอบตาม SLA | datetime | no | yes | - |
| `priority_finish_date` | วันเวลาที่เสร็จสิ้นตาม SLA | datetime | no | yes | - |
| `priority_id` | Priority | many2one | no | no | `tcp.mdm.priority` |
| `priority_late_flag` | ประเภทเกินกำหนด | selection | no | yes | `N`, `NR`, `NF` |
| `problem_cause_remark` | สาเหตุของการเกิดปัญหา | text | no | no | - |
| `problem_solution_remark` | วิธีการแก้ไขปัญหา | text | no | no | - |
| `problem_solution_remark_detail` | รายละเอียดการแก้ไขปัญหา | text | no | no | - |
| `report_topic_id` | รายงานหัวข้อการแจ้ง | many2one | no | no | `tcp.report.topic` |
| `request_type_id` | ประเภทใบคำขอ | many2one | no | no | `tcp.request.type` |
| `service_id` | Project / Service | many2one | yes | no | `tcp.mdm.service` |
| `service_sub_id` | Project / Service Sub | many2one | no | no | `tcp.mdm.service.sub` |
| `tm_synced` | Closed in TM | boolean | no | yes | - |
| `uuid` | UUID | char | no | no | - |
| `write_date` | Last Updated on | datetime | no | yes | - |

## Proposed BETIME Mapping

ตารางนี้เป็น mapping เบื้องต้นสำหรับเชื่อมหน้า BETIME Help Desk กับ Odoo `tcp.txn.case`

| BETIME concept | Odoo field | หมายเหตุ |
| --- | --- | --- |
| Ticket ID ของ BETIME | `case_ticket_id` | ใช้เก็บเลข ticket จากระบบเรา |
| เลขอ้างอิงภายนอก | `case_ref_code` | ถ้ามีเลขคำขอ/เลขคดี |
| ผู้แจ้ง / ชื่อลูกค้า | `customer` | ถ้า BETIME มี user/customer name |
| หัวข้อ ticket | `case_subject` | required |
| รายละเอียดปัญหา | `case_desc` | รายละเอียดหลัก |
| หมายเหตุเพิ่มเติม | `case_note` | note ภายใน |
| ช่องทางแจ้ง | `channel_id` | ต้อง lookup `tcp.mdm.channel` |
| Project / Service | `service_id` | required, ต้อง lookup `tcp.mdm.service` |
| Service ย่อย | `service_sub_id` | ต้อง lookup `tcp.mdm.service.sub` |
| หน่วยงาน/สำนักงาน | `agency_id`, `district_id`, `faction_id` | เลือก field ตาม master ที่ตรงจริง |
| ประเภทปัญหา เช่น Human error | `case_type` | selection value เช่น `human_error` |
| ประเภทใบคำขอ | `request_type_id` | many2one ไป `tcp.request.type` |
| หัวข้อการแจ้ง | `complaint_topic_id` | many2one ไป `tcp.complaint.topic` |
| Priority/SLA | `priority_id` | ต้อง lookup `tcp.mdm.priority` |
| ผลกระทบ | `impact_level` | `yes` หรือ `no` |
| สถานะเริ่มต้น | `case_status` | แนะนำ `open` |
| ทีมเจ้าของงาน | `owner_team_id` | optional |
| เจ้าหน้าที่เจ้าของงาน | `owner_officer_id` | optional |
| รูปภาพ | `image_ids` | one2many child records |
| ไฟล์แนบ | `attach_ids` | one2many child records |
| แชท | `chat_ids` | one2many child records |
| ผลวิเคราะห์สาเหตุ | `problem_cause_remark` | เหมาะกับหน้า analysis |
| วิธีแก้ปัญหา | `problem_solution_remark` | เหมาะกับหน้า analysis |
| รายละเอียดการแก้ไข | `problem_solution_remark_detail` | เหมาะกับหน้า analysis |

## Create Case Payload แนวทาง

เวลาสร้าง case ผ่าน Odoo JSON-RPC ต้องส่ง field หลักเป็น object ของ `vals` โดย many2one ต้องเป็น numeric Odoo record id ไม่ใช่ข้อความ label

ตัวอย่างเชิงโครงสร้าง:

```json
{
  "channel_id": 1,
  "service_id": 10,
  "case_subject": "Login เข้าใช้งานไม่ได้",
  "case_desc": "ผู้ใช้แจ้งว่า login แล้วระบบขึ้น error",
  "case_status": "open",
  "case_type": "human_error",
  "customer": "noo88",
  "case_ticket_id": "BT-2026-0001",
  "priority_id": 3,
  "impact_level": "yes"
}
```

Field ที่ควรหลีกเลี่ยงตอน create/update:

- readonly fields เช่น `priority_active_date`, `priority_finish_date`, `priority_late_flag`, `write_date`
- field กลุ่ม `is_show_*`
- `domain_request_type_ids` เพราะเป็น readonly
- one2many fields ถ้ายังไม่ได้ออกแบบ child record format ให้ชัด

## สิ่งที่ต้องตรวจเพิ่มก่อนทำ Integration จริง

1. ค่า master data จริงของ `channel_id`, `service_id`, `priority_id`, `request_type_id`, `complaint_topic_id`
2. ค่า default/onchange ของ Odoo เมื่อเลือก `service_id`
3. format ที่ Odoo ต้องการสำหรับ `image_ids`, `attach_ids`, `chat_ids`
4. business rule ของ `case_date`, `case_date_process`, `active_date`, `finish_date`
5. mapping ระหว่าง label ภาษาไทยใน BETIME กับ Odoo selection/many2one id
6. สิทธิ์ของ user/API account ที่จะใช้สร้างเคสจริง

## ผลตรวจจากประวัติ Ticket จริง

ส่วนนี้ตรวจจาก `tcp.txn.case` records ล่าสุด 500 records โดยอ่าน field ทั้งหมดจาก form metadata แล้วนับว่า field ไหนมีค่าจริงในประวัติ ticket

วันที่ตรวจ: 2026-06-08  
จำนวน records ที่ตรวจ: 500 ล่าสุด  
เกณฑ์การนับ: field ถือว่า "ถูกใช้งาน" เมื่อค่าไม่ว่าง, boolean เป็น `true`, หรือ relation/one2many มี id อยู่

### Fields ที่ถูกใช้ 100%

กลุ่มนี้มีค่าครบทุก record ที่ตรวจ แปลว่าเป็น field หลักที่ BETIME ควรส่งหรือรองรับแน่นอน

| Field | Usage | ตัวอย่างค่า |
| --- | ---: | --- |
| `case_ticket_id` | 500/500 | `BMA-2_6905169`, `ERC-SRB_6900756` |
| `case_subject` | 500/500 | `รายงานแสดงข้อมูลไม่ถูกต้อง`, `สำรองเลขที่หนังสือ` |
| `case_desc` | 500/500 | รายละเอียดปัญหาจากผู้แจ้ง |
| `case_status` | 500/500 | `open`, `process`, `closed` |
| `case_type` | 500/500 | `system_bug`, `human_error`, `change_request` |
| `case_date` | 500/500 | วันที่รับเรื่อง |
| `active_date` | 500/500 | วันที่ตอบตามจริง |
| `channel_id` | 500/500 | `[3, Line]` |
| `service_id` | 500/500 | `[145, BMA-OSS-MA]`, `[589, ERC-SARABUN]` |
| `owner_team_id` | 500/500 | ทีมเจ้าของงาน |
| `owner_officer_id` | 500/500 | เจ้าหน้าที่เจ้าของงาน |
| `write_date` | 500/500 | วันที่แก้ไขล่าสุด |

สรุปจากประวัติจริง:

- Ticket เกือบทั้งหมดมาจาก channel `Line`
- `case_ticket_id`, `case_subject`, `case_desc`, `case_type`, `case_status`, `service_id` เป็นแกนหลักของข้อมูล
- `owner_team_id` และ `owner_officer_id` ถูกใส่ครบ 100% จึงควรตรวจว่า Odoo auto assign หรือผู้ใช้เลือกเอง

### Fields ที่ถูกใช้บ่อยมาก

กลุ่มนี้ใช้ใน records ส่วนใหญ่ ควรรองรับตั้งแต่ integration รุ่นแรก

| Field | Usage | หมายเหตุ |
| --- | ---: | --- |
| `customer` | 492/500 (98.4%) | ชื่อผู้แจ้ง/ลูกค้า |
| `priority_id` | 479/500 (95.8%) | SLA/Priority เช่น `Res 30 min, Sol 8 h` |
| `priority_active_date` | 479/500 (95.8%) | readonly, คำนวณจาก priority/SLA |
| `priority_finish_date` | 479/500 (95.8%) | readonly, คำนวณจาก priority/SLA |
| `case_date_finish` | 465/500 (93.0%) | วันที่จบเคส |
| `finish_date` | 465/500 (93.0%) | วันที่เสร็จสิ้นจริง |
| `priority_late_flag` | 462/500 (92.4%) | readonly, ส่วนใหญ่เป็น `N` |
| `area_id` | 430/500 (86.0%) | พื้นที่/หน่วยงานย่อย |
| `assign_dev_ids` | 428/500 (85.6%) | มี child record ฝั่ง assign dev |
| `service_sub_id` | 407/500 (81.4%) | service ย่อย |

สรุปจากประวัติจริง:

- `priority_id` สำคัญมาก เพราะมีใช้เกือบทุกเคส
- `priority_active_date`, `priority_finish_date`, `priority_late_flag` มีค่าบ่อย แต่เป็น readonly จึงควรปล่อยให้ Odoo คำนวณ
- `area_id` และ `service_sub_id` มีใช้เยอะ แปลว่า integration ควรเตรียม master mapping สองตัวนี้ด้วย
- `assign_dev_ids` ใช้เยอะ แต่เป็น one2many ต้องไปแตก child model ก่อนส่งจริง

### Fields ที่ใช้ตามเงื่อนไข

กลุ่มนี้ไม่ได้ใช้ทุก ticket แต่มีความหมายในบาง workflow

| Field | Usage | หมายเหตุ |
| --- | ---: | --- |
| `case_ref_code_type` | 367/500 (73.4%) | ประเภทเลขอ้างอิง เช่น เลขคำขอ/เลขคดี |
| `is_show_case_ref_code` | 367/500 (73.4%) | readonly UI control |
| `is_show_last_updated` | 367/500 (73.4%) | readonly UI control |
| `is_show_complaint_topic` | 360/500 (72.0%) | readonly UI control |
| `is_show_report_topic` | 360/500 (72.0%) | readonly UI control |
| `is_show_request_type` | 350/500 (70.0%) | readonly UI control |
| `problem_solution_remark` | 61/500 (12.2%) | วิธีแก้ปัญหา |
| `problem_cause_remark` | 45/500 (9.0%) | สาเหตุปัญหา |
| `case_ref_code` | 38/500 (7.6%) | เลขอ้างอิงจริง |
| `delegate_team_id` | 31/500 (6.2%) | ทีมที่ delegate |
| `delegate_officer_id` | 31/500 (6.2%) | เจ้าหน้าที่ที่ delegate |
| `approval_ids` | 14/500 (2.8%) | child approval |
| `approval_status` | 14/500 (2.8%) | พบ `waiting_approval` |
| `criteria_id` | 10/500 (2.0%) | เช่น `High`, `Medium` |
| `is_show_district` | 10/500 (2.0%) | readonly UI control |
| `case_date_process` | 8/500 (1.6%) | วันที่เริ่ม process |
| `impact_level` | 8/500 (1.6%) | พบค่า `no` |
| `problem_solution_remark_detail` | 8/500 (1.6%) | รายละเอียดการแก้ไข |
| `case_note` | 6/500 (1.2%) | note เพิ่มเติม |
| `image_ids` | 3/500 (0.6%) | child image |

สรุปจากประวัติจริง:

- field กลุ่ม `is_show_*` มีค่าในประวัติ แต่เป็น field ควบคุม UI/read-only ไม่ควรส่งจาก BETIME
- ข้อมูล RCA/solution มีใช้จริง แต่ใช้ไม่เยอะ เหมาะกับขั้นตอนปิดเคสหรือหน้า analysis มากกว่าขั้นตอนสร้างเคส
- `approval_*` มีใช้น้อย แต่ต้องรองรับถ้า workflow บาง service ต้องอนุมัติ
- `image_ids` พบใช้น้อยมากใน 500 records ล่าสุด แต่ควรตรวจ child model ถ้าต้องรองรับแนบรูปจริง

### Fields ที่ไม่พบการใช้งานใน 500 records ล่าสุด

กลุ่มนี้อยู่ใน form metadata แต่ไม่พบว่ามีค่าใน records ล่าสุดที่ตรวจ

| Field | หมายเหตุ |
| --- | --- |
| `activity_ids` | ไม่พบ activity child ใน sample |
| `agency_id` | ไม่พบค่า |
| `assign_ids` | ไม่พบค่า แต่ `assign_dev_ids` ใช้เยอะ |
| `attach_ids` | ไม่พบไฟล์แนบใน sample |
| `case_private` | ไม่พบ case private |
| `change_detail` | ไม่พบรายละเอียดการเปลี่ยนแปลง |
| `chat_ids` | ไม่พบ chat child ใน sample |
| `complaint_topic_id` | ไม่พบค่า แม้มี `is_show_complaint_topic` |
| `district_id` | ไม่พบค่า |
| `domain_request_type_ids` | readonly และไม่พบค่า |
| `faction_id` | ไม่พบค่า |
| `is_os` | ไม่พบ outsource flag |
| `is_show_agency` | ไม่พบค่า true |
| `is_show_faction` | ไม่พบค่า true |
| `os_name` | ไม่พบ outsource name |
| `report_topic_id` | ไม่พบค่า |
| `request_type_id` | ไม่พบค่า แม้มี `is_show_request_type` |
| `tm_synced` | readonly และไม่พบค่า |
| `uuid` | ไม่พบค่า |

### สิ่งที่ประวัติ Ticket บอกเรา

ถ้าจะทำ integration รุ่นแรกให้ใช้งานได้ใกล้เคียงเคสจริง ควรเริ่มจาก payload นี้:

```json
{
  "case_ticket_id": "<BETIME ticket id>",
  "customer": "<ชื่อผู้แจ้ง>",
  "case_subject": "<หัวข้อ>",
  "case_desc": "<รายละเอียด>",
  "case_type": "human_error",
  "case_status": "open",
  "case_date": "<วันที่รับเรื่อง>",
  "active_date": "<วันที่ตอบตามจริงหรือวันที่รับเข้า>",
  "channel_id": 3,
  "service_id": 145,
  "service_sub_id": 35,
  "area_id": 223,
  "priority_id": 196,
  "owner_team_id": 40,
  "owner_officer_id": 210
}
```

แต่ก่อนส่งจริงต้อง resolve id เหล่านี้จาก master data:

- `channel_id`
- `service_id`
- `service_sub_id`
- `area_id`
- `priority_id`
- `owner_team_id`
- `owner_officer_id`

สำหรับ field ต่อไปนี้ควรเป็น phase 2:

- `assign_dev_ids`
- `image_ids`
- `approval_ids`
- `problem_cause_remark`
- `problem_solution_remark`
- `problem_solution_remark_detail`

เหตุผลคือ field เหล่านี้มี workflow/child model เพิ่มเติม ต้องแตก relation และรูปแบบ payload ให้ชัดก่อน

## หมายเหตุ

- ข้อมูลในเอกสารนี้อ้างอิงจาก form metadata ของ Odoo ณ วันที่ตรวจสอบ
- Relation field แบบ many2one/many2many/one2many ต้องใช้ record id หรือ Odoo command format ไม่ใช่ label text
- ถ้าฝั่ง Odoo มีการแก้ module หรือ view ภายหลัง field list อาจเปลี่ยนได้ ควรดึง metadata ใหม่ก่อนเริ่ม integration รอบใหญ่
