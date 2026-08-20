# Problem Type Use Cases From Historical Tickets

These use cases are derived from historical `tcp.txn.case` records.

Use them as examples of how `สาเหตุของการเกิดปัญหา` maps to `Case Type`.

## Human Error

Typical signal:
- The cause describes a wrong user action, wrong selection, wrong keying, wrong routing, or a correction of a manual action.

Examples:
- Cause: `ตอนสร้าง กดปุ่มสร้างหนังสือภายนอก + ภายใน พอตอนออกเลขเลยได้เลยส่งภายในสารบรรณกลางมาแสดง`
  - Subject: `ลงทะเบียนรับหนังสือ`
  - Expected type: `Human error`
- Cause: `เจ้าหน้าที่คีย์ปีมาผิด`
  - Subject: `แก้ไขวันที่ ออกใบอนุญาตในระบบ / เลขที่ใบอนุญาต`
  - Expected type: `Human error`
- Cause: `พิมพ์เลขหนังสือผิด`
  - Subject: `สารบรรณ`
  - Expected type: `Human error`
- Cause: `เกิดจากเจ้าหน้าที่เลือกประเภทการเบิกจ่ายผิดในขั้นตอนการอนุมัติรายการ`
  - Subject: `ตรวจสอบแก้ไขเอกสาร 1 รายการ`
  - Expected type: `Human error`

## System Bug

Typical signal:
- The user action is valid, but the system logic, preview, generation, mapping, or state transition is wrong.

Examples:
- Cause: `upload ทรัพยากร แล้วไม่ show preview`
  - Subject: `ข้อมูลไม่ขึ้น`
  - Expected type: `System Bug`
- Cause: `สาเหตุที่ข้อมูลไม่ขึ้นเป็นเพราะ import เข้าไปมี _id อยู่ เลข id มันจะสร้างเองอยู่แล้วไม่ต้องใส่ครับ`
  - Subject: `ข้อมูลไม่ขึ้น`
  - Expected type: `System Bug`
- Cause: `connection ของเครื่อง Database โดนตัดไป`
  - Subject: `ไม่พบชื่อผู้นัดหมาย / มอบหมายเคสไม่ได้ / ปรับโอนคดีไม่ได้`
  - Expected type: `System Bug` when the symptom is incorrect application behavior caused by application/runtime logic and not just a transient user mistake
- Cause patterns about wrong generated number, wrong running number, wrong sequence, wrong registration number, or wrong document number
  - Expected type: `System Bug`

## system error

Typical signal:
- The system cannot continue normal operation because a dependency, registry, ETL, import, endpoint, or server-side process failed or is unavailable.

Examples:
- Cause: `ไม่พบสมุดทะเบียนภายนอก`
  - Subject: `สารบรรณ`
  - Expected type: `system error`
- Cause: `ETL ข้อมูลเครื่องหมายไม่ครบถ้วน`
  - Subject: `ค้นหาไม่พบรายการคำขอเครื่องหมายการค้า`
  - Expected type: `system error`
- Cause: `ไฟล์ csv ในโค้ดมีปัญหาครับ`
  - Subject: `ข้อมูลไม่ขึ้น`
  - Expected type: `system error`
- Cause: `เลขสมุดทะเบียนขยับลดลงมาเป็นเลข 2219`
  - Subject: `เมนูรอลงรับหนังสือ`
  - Expected type: `system error`

## Change Request

Typical signal:
- The issue is really a request to support a business process that the current flow does not support yet.

Examples:
- Cause: `ไม่มีปุ่มสำหรับยกเลิกเป็นผู้ทำบัญชี รองรับคนที่ไม่เป็นสมาชิกสภาฯ`
  - Subject: `ผู้ทำบัญชีที่ขาดต่ออายุไม่ประสงค์จะเป็นผู้ทำบัญชี`
  - Expected type: `Change Request`
- Cause: `UI payload ส่งวันเกิด เป็นค่า 0000 ในกรณีที่ผู้ทำ รู้แค่ปีเกิด`
  - Subject: `ผู้ทำรู้แค่ปีเกิด`
  - Expected type: `Change Request`
- Cause: `เนื่องจากผู้ลงนามคนนั้นๆไม่อยู่และหน้าห้องผู้ว่าให้เปลี่ยนผู้ลงนาม`
  - Subject: `หัวข้อ : เปลี่ยนผู้ลงนามในเอกสาร (ส่วนตัว)`
  - Expected type: `Change Request`

Priority hints for Change Request:
- `high` when the requested feature is needed to keep production work moving, affects many users, or must land before a deadline/compliance event
- `medium` when the feature improves an important workflow but a workaround still exists
- `low` when it is cosmetic, wording-only, layout-only, or convenience-only

## Software

Typical signal:
- The cause is about data quality, data mapping, master data, auth/session, or report/export behavior and does not clearly indicate outage or application logic defect.

Examples:
- Cause: `ข้อมูลไม่มีมาให้`
  - Subject: `ไม่มีรอบปีบัญชี`
  - Expected type: `Software` or `Data`, depending on the allowed taxonomy
- Cause: `ข้อมูลที่ต้นทางไม่ครบถ้วน`
  - Subject: `ข้อมูลธุรกิจไม่ครบ`
  - Expected type: `Software`
- Cause: `ADM_USER user_name ขึ้นซ้ำกัน`
  - Subject: `ข้อมูล ขึ้น double`
  - Expected type: `Software`

## network

Typical signal:
- The cause explicitly mentions internet/VPN/LAN/Wi-Fi/network path issues.

Examples:
- Cause: `อินเตอร์เน็ตช้า`
  - Subject: `หัวข้อ : โหลดเอกสารแนบไม่ได้ (ส่วนตัว)`
  - Expected type: `network`

## Notes

- Historical labels include legacy categories such as `Data`, `Other`, and `Application Error`. Use them as evidence only.
- When a legacy label conflicts with the cause text, prefer the failure mechanism described in the cause text.
