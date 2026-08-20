# Odoo to BETIME Field Mapping

เอกสารนี้สรุปว่า "ข้อมูลจาก Odoo" ในระบบ BETIME มาจาก model / field ไหนบ้าง และถูกเก็บหรือแปลงไปอยู่ที่ไหนในฝั่ง BETIME

ขอบเขตที่ตรวจแล้วตอนนี้:
- โครงการ `ERC-SARABUN`
- โครงการ `BMA-ROD`

> หมายเหตุ: บางส่วนเป็น "ข้อมูลดิบจาก Odoo" และบางส่วนเป็น "ข้อมูลที่ BETIME derive เพิ่ม" จาก relation หลายตาราง

## ภาพรวมการไหลของข้อมูล

1. Odoo เป็นแหล่งต้นทางของ master data
2. BETIME sync ข้อมูลมาเก็บใน `hd_master`
3. หน้าเว็บใช้ `hd_master` หรือ context กลาง `/hd-context`
4. ตอนส่ง ticket ไป Odoo จะ map กลับเป็น Odoo id อีกที

## Project master

| Odoo model | Odoo field | BETIME storage | หมายเหตุ |
|---|---|---|---|
| `tcp.mdm.service` | `id` | `hd_projects.id` / `hd_projects.extra.source_service_id` | id หลักของ project ใน Odoo |
| `tcp.mdm.service` | `service_code` | `hd_projects.code` / `hd_projects.extra.project_code` | code หลักของ project |
| `tcp.mdm.service` | `service_name` | `hd_projects.name` / `hd_projects.extra.project_name` | ชื่อ project |
| `tcp.mdm.service` | `service_pm` | `hd_projects.extra.project_pm` / `hd_main_team_project` | PM ของ project |
| `tcp.mdm.service` | `service_description` | `hd_projects.extra.project_description` | รายละเอียด project |
| `tcp.mdm.service` | `service_active` | `hd_projects.active` | สถานะ active/inactive |
| `tcp.mdm.service` | `service_sync_id` | `hd_projects.extra.service_sync_id` | รหัส sync จาก Odoo |
| `tcp.mdm.service` | `service_dev_ids` | `hd_projects_dev`, `hd_project_member_roles` | รายชื่อ dev ที่ผูกกับ project |
| `tcp.mdm.service` | `pm_employee_ids` | `hd_project_member_roles` / `hd_main_team_project` | รายชื่อ PM ที่ผูกกับ project |

### ตัวอย่างที่ยืนยันจาก Odoo

- `service_code = ERC`
- `service_name = ERC-SARABUN`
- `service_dev_ids = [102, 103, 104, 105, 106, 110, 114, 160]`
- `pm_employee_ids = [12, 10, 171]`

## Sub Project master

| Odoo model | Odoo field | BETIME storage | หมายเหตุ |
|---|---|---|---|
| `tcp.mdm.service_sub` | `id` | `hd_sub_projects.id` / `hd_sub_projects.extra.source_id` | id หลักของ sub project |
| `tcp.mdm.service_sub` | `service_id` | `hd_sub_projects.extra.parent_project` / `parent_project_ref` | project แม่ |
| `tcp.mdm.service_sub` | `service_sub_code` | `hd_sub_projects.code` / `hd_sub_projects.extra.sub_project_code` | code ของ sub project |
| `tcp.mdm.service_sub` | `service_sub_name` | `hd_sub_projects.name` / `hd_sub_projects.extra.sub_project_name` | ชื่อ sub project |
| `tcp.mdm.service_sub` | `service_sub_pm` | `hd_sub_projects.extra.sub_project_pm` | PM ของ sub project |
| `tcp.mdm.service_sub` | `service_sub_description` | `hd_sub_projects.extra.sub_project_description` | รายละเอียด sub project |
| `tcp.mdm.service_sub` | `service_sub_active` | `hd_sub_projects.active` | สถานะ active/inactive |

## Dev master

| Odoo model | Odoo field | BETIME storage | หมายเหตุ |
|---|---|---|---|
| `tcp.mdm.service.dev` | `id` | `hd_projects_dev.id` / `hd_projects_dev.extra.source_row_id` | id ของ record dev ใน Odoo |
| `tcp.mdm.service.dev` | `service_id` | `hd_projects_dev.extra.parent_project` / `parent_project_ref` | project ที่ dev คนนี้สังกัด |
| `tcp.mdm.service.dev` | `name` | `hd_projects_dev.name` / `hd_projects_dev.extra.employee_name` | ชื่อ dev |
| `tcp.mdm.service.dev` | `display_name` | `hd_projects_dev.extra.employee_name` | ใช้แสดงชื่ออ่านง่าย |
| `tcp.mdm.service.dev` | `employee_id` | `hd_projects_dev.code` / `hd_projects_dev.extra.employee_id` | รหัสพนักงานหรือรหัสอ้างอิง |
| `tcp.mdm.service.dev` | `employee_email` | `hd_projects_dev.extra.employee_email` | อีเมลของ dev ถ้ามี |

## User / employee master

| Odoo model | Odoo field | BETIME storage | หมายเหตุ |
|---|---|---|---|
| `hr.employee` | `id` | `hd_users.id` / `hd_users.extra.source_id` | employee id จาก Odoo |
| `hr.employee` | `name` | `hd_users.name` | ชื่อพนักงาน |
| `hr.employee` | `work_email` | `hd_users.code` / `hd_users.extra.email` | ใช้เป็น code/lookup หลักในหลายจุด |
| `hr.employee` | `work_phone` | `hd_users.extra.work_phone` | เบอร์งาน |
| `hr.employee` | `mobile_phone` | `hd_users.extra.mobile_phone` | เบอร์มือถือ |
| `hr.employee` | `job_title` | `hd_users.extra.job_title` / `position_name` | ตำแหน่ง |
| `hr.employee` | `department_id` | `hd_users.extra.department_id` / `department_name` | แผนก |
| `hr.employee` | `user_id` | link ไป `res.users` | ใช้ผูก employee กับ user login |
| `hr.employee` | `parent_id` | relation ไป `hr.employee` | หัวหน้าหรือสายบังคับบัญชา |
| `hr.employee` | `coach_id` | relation ไป `hr.employee` | coach / mentor |

### `res.users`

| Odoo model | Odoo field | BETIME storage | หมายเหตุ |
|---|---|---|---|
| `res.users` | `id` | `users.id` | user ของระบบเว็บเรา |
| `res.users` | `login` | `hd_users.extra.login` / ใช้ lookup | username สำหรับ login |
| `res.users` | `name` | `hd_users.extra.user_name` / display helper | ชื่อแสดงผล |
| `res.users` | `partner_id` | relation ไป `res.partner` | ใช้ช่วย resolve ชื่อ/อีเมล |
| `res.users` | `active` | `users.is_active` | สถานะใช้งาน |

## Team / role mapping

| Odoo model / source | Odoo field | BETIME storage | หมายเหตุ |
|---|---|---|---|
| `tcp.main.team` / team source | `team_code` | `hd_teams.code` | code ทีม |
| `tcp.main.team` / team source | `team_name_th`, `team_name_en` | `hd_teams.name` | ชื่อทีม |
| `tcp.main.team` / team source | `team_own_id` | `hd_teams.extra.owner_id` | owner ทีม |
| `tcp.main.team_member` / relation | `member_list_ids` | `hd_teams.extra.member_ids` | รายชื่อสมาชิกทีม |
| `hd_project_member_roles` (logical table) | project + person + role | `hd_project_member_roles` | ตาราง logical ที่ BETIME สร้างเองเพื่อเก็บ role รายละเอียดต่อ project |

### role ที่ใช้จริงใน BETIME

- `PM`
- `Dev`
- `IT Support`

## ฟิลด์สำคัญที่หน้า ticket ใช้

| BETIME field | มาจาก Odoo field | ใช้ทำอะไร |
|---|---|---|
| `projectCode` / `project_name` | `tcp.mdm.service.service_code` / `service_name` | เลือก project |
| `subprojectCode` / `subproject_name` | `tcp.mdm.service_sub.service_sub_code` / `service_sub_name` | เลือก sub project |
| `assigned_dev` / `delegate_officer_id` | `tcp.mdm.service.dev` / `hr.employee` | คนรับต่อหรือ dev ที่เกี่ยวข้อง |
| `owner_officer_id` | `hr.employee` | owner ของงาน |
| `owner_team_id` | `tcp.main.team` | ทีมเจ้าของงาน |
| `priority_id` | `tcp.mdm.priority` | priority / SLA |
| `area_id` | `tcp.main.area` | area ที่เกี่ยวข้อง |
| `case_type_id` / `case_type` | `tcp.mdm.case_type` | ประเภทปัญหา |

## จุดที่เป็น derived data ไม่ใช่ Odoo ตรง ๆ

- `hd_project_member_roles`
  - เป็น logical table ที่ BETIME สร้างเองจาก role ของ project
  - ใช้เก็บ `PM`, `Dev`, `IT Support` แยกตาม project
- `hd_main_team_project`
  - เป็นภาพรวม role ต่อ project ที่ BETIME สรุปขึ้นมา
- `odoo_employee_map`
  - เป็น mapping ชั้นกลางระหว่าง `hd_users` กับ `hr.employee`
  - ใช้ช่วย resolve employee id, email และชื่อคน

## หมายเหตุสำคัญ

- ข้อมูลฝั่ง Odoo ที่ยืนยันแล้วจาก live check ตอนนี้คือ `ERC-SARABUN`
- ใน Odoo โครงการนี้เก็บ dev ผ่าน `service_dev_ids`
- ฝั่ง BETIME ถ้าข้อมูลยังว่าง มักแปลว่ายัง sync ไม่ครบ ไม่ใช่ว่า Odoo ไม่มีข้อมูล
- ถ้า Odoo เปลี่ยน module / field หลังจากนี้ mapping ในเอกสารควรทวนใหม่อีกครั้ง

