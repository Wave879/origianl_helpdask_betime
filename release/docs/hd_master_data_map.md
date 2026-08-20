# HD Master Data Map

เอกสารนี้สรุปว่าแต่ละตารางในชุด `hd_*` เก็บข้อมูลอะไร และใช้ทำอะไรในระบบ Betime Helpdesk / Role Management

## แนวคิดหลัก

- ข้อมูล master ส่วนใหญ่เก็บอยู่ในตารางเดียวคือ `hd_master`
- แยกชนิดข้อมูลด้วย `table_name`
- ตารางบางตัวเป็น "logical table" เช่น `hd_project_member_roles` ที่เก็บอยู่ใน `hd_master` แต่ใช้งานเหมือนตารางแยก

## ตารางหลัก

| ตาราง | ข้อมูลที่เก็บ | ใช้ทำอะไร |
|---|---|---|
| `hd_master` | ตารางแม่สำหรับเก็บ master data ทุกชนิด | ใช้เป็นที่เก็บข้อมูลหลักของ helpdesk master data ทั้งหมด |
| `hd_users` | รายชื่อพนักงาน / user ในระบบ | ใช้แสดงคน, เปิด popup รายละเอียดพนักงาน, ใช้เป็นฐานสำหรับ mapping คนกับโครงการ |
| `hd_projects` | รายชื่อโครงการ | ใช้แสดงโครงการ, ตั้ง PM, และอ้างอิง project หลัก |
| `hd_teams` | รายชื่อทีม / team master | ใช้แสดงทีม IT Support, สมาชิกทีม, และรายละเอียดทีมใน popup |
| `hd_positions` | รายชื่อตำแหน่ง | ใช้เป็น master lookup ของตำแหน่งงาน |
| `hd_projects_dev` | ความสัมพันธ์ Dev กับโครงการ | ใช้บอกว่าในแต่ละโครงการมี Dev คนไหนบ้าง |
| `hd_main_team_project` | ความสัมพันธ์คนกับโครงการแบบสรุป role | ใช้สร้างภาพรวม PM / IT Support / Dev ของแต่ละโปรเจกต์ |
| `hd_project_member_roles` | ความสัมพันธ์คนกับโครงการแบบ role รายละเอียด | ใช้เก็บ role ที่ต่างกันตามโครงการ เช่น คนเดียวกันเป็น PM ในโปรเจกต์หนึ่ง แต่เป็น Dev ในอีกโปรเจกต์หนึ่ง |

## ตารางความสัมพันธ์ที่สำคัญ

| ตาราง | ความหมาย |
|---|---|
| `hd_main_team_project` | ตารางสรุปความสัมพันธ์หลักของคนกับโปรเจกต์ แยก role เป็น `pm`, `support`, `dev` |
| `hd_projects_dev` | ใช้เก็บ Dev ของโปรเจกต์โดยตรง |
| `hd_project_member_roles` | ใช้เก็บ role ต่อโปรเจกต์แบบละเอียดกว่า `hd_main_team_project` รองรับคนเดียวหลาย role หลายโปรเจกต์ |

## ตารางที่ใช้ในหน้า role-helpdesk

| ส่วนในหน้า | ตารางที่อ้างอิง |
|---|---|
| รายชื่อพนักงานทั้งหมด | `hd_users` |
| รายชื่อทีมทั้งหมด | `hd_teams` |
| รายชื่อโครงการ | `hd_projects` |
| Dev ของโครงการ | `hd_projects_dev` |
| สรุป role ของโครงการ | `hd_main_team_project` |
| ตำแหน่งในโครงการแบบละเอียด | `hd_project_member_roles` |

## หมายเหตุการตีความข้อมูล

- `hd_users.positionName` หรือ `hd_users.jobTitle` คือ "ตำแหน่งรวม" ของคนคนนั้น
- `hd_project_member_roles.position_name` คือ "ตำแหน่งในโครงการนั้น ๆ"
- ถ้าคนเดียวกันมี role ต่างกันหลายโปรเจกต์ ให้ดูจาก `hd_project_member_roles` เป็นหลัก
- ถ้าเป็นภาพรวมทั้งระบบ ให้ดู `hd_users`

## ค่าที่ sync / derived

ตารางเหล่านี้ไม่ได้เป็นข้อมูลต้นทางทั้งหมด แต่สร้างหรือเติมจากกฎ sync:

- `hd_main_team_project`
- `hd_project_member_roles`
- บางกรณี `hd_users.extra.position*` ถูก backfill จาก relation เดิม เพื่อให้หน้าจออ่านง่ายขึ้น

## ไฟล์ที่เกี่ยวข้อง

- `deploy/pages_bundle/role-helpdesk.html`
- `scripts/sync_hd_main_team_project.py`
- `scripts/sync_hd_project_member_roles.py`
- `scripts/sync_hd_users_positions.py`
- `scripts/import_helpdeck_excel_to_sqlite.py`

## สรุปสั้นที่สุด

- `hd_users` = คน
- `hd_projects` = โครงการ
- `hd_teams` = ทีม
- `hd_projects_dev` = Dev ต่อโครงการ
- `hd_main_team_project` = role สรุปต่อโครงการ
- `hd_project_member_roles` = role รายละเอียดต่อโครงการ

