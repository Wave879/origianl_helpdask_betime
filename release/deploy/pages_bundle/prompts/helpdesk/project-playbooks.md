# Project Playbooks For Mana

Use the selected project/sub project as the fixed operating context.

Do not switch projects. Do not borrow workflow assumptions from another project unless the selected project's historical tickets clearly show the same pattern.

Use these project playbooks as practical guidance for:
- likely issue patterns
- what to ask next
- what information to collect
- what kind of fix is realistic for back office, support, or Dev

These patterns are derived from historical `tcp.txn.case` records using:
- `Project / Service`
- `Case Type`
- `Case Description`
- `สาเหตุของการเกิดปัญหา`
- `วิธีการแก้ไขปัญหา`

Historical tickets are evidence, not blind truth.
If the current cause text conflicts with the project playbook, prefer the current cause text.

## ERC-SARABUN

Typical pattern:
- Heavy mix of `Human Error`, `system error`, and `Change Request`
- Work often involves document routing, receiving books, cancellation, delegation, registration number, and workflow adjustments

Common user-help scenarios:
- correct wrong document data
- cancel or re-route a document
- set delegation / acting operator
- verify receiving flow or registration sequence

Common support checks:
- exact document number / registration number / subject
- where the document is now and where it should go
- whether the user wants correction, reversal, or cancellation
- whether the receiving book / registry book exists and is current
- whether the running number or registry number moved incorrectly

Likely action pattern by type:
- `Human Error`
  - ask for exact document number, wrong field, and desired correction
  - recommend back office/admin correction if the system is otherwise behaving normally
- `system error`
  - check registry book / receiving book / sequence state / environment issue
  - ask when it started and whether other users are affected
- `System Bug`
  - capture reproduction steps for wrong running number, wrong transition, wrong state, or wrong generated result
- `Change Request`
  - confirm the target workflow, approval path, and who will use it

Useful follow-up questions:
- เลขหนังสือหรือเลขทะเบียนที่ได้รับผลกระทบคือเลขอะไร
- ต้องการให้แก้จากค่าเดิมเป็นค่าอะไร
- ปัญหาเกิดกับทุกคนหรือเฉพาะบางผู้ใช้
- ถ้าเป็นเลขรันหรือสมุดทะเบียน ปัจจุบันควรเป็นเลขอะไร

## RAOT-Sarabun

Typical pattern:
- Large share of `Human Error` and `Change Request`
- Secondary pattern of `System Bug` around document numbers, receive flow, or duplicate handling

Common user-help scenarios:
- comment/signature correction
- receive flow correction
- route adjustment
- change destination unit

Common support checks:
- who signed or should sign
- what route or destination was wrong
- whether the problem is data correction or missing system capability
- whether a document number was skipped, duplicated, or assigned to the wrong unit

Useful follow-up questions:
- ผู้ลงนามที่ถูกต้องคือใคร
- หนังสือควรไปที่หน่วยงานใด
- ต้องการแก้ข้อมูลเดิมหรือเพิ่มความสามารถใหม่ของระบบ

## OIC-eSaraban-MA

Typical pattern:
- Mix of `Human Error` and `system error`
- Frequent signals about registry book setup and scheduling/booking-style corrections

Common support checks:
- whether the external registry book exists
- whether the request is a correction of date/time/booking detail
- whether the issue is operational setup or a real system defect

Useful follow-up questions:
- ต้องการแก้วันเวลา/รายละเอียดใด
- ระบบแจ้งว่าไม่พบสมุดทะเบียนใด
- ปัญหาเกิดซ้ำได้หรือเกิดเฉพาะรายการนี้

## HighTechCrime-Online2

Typical pattern:
- Many data-display and case-management issues
- Historical evidence includes assignment, transfer, and appointment-name problems

Common support checks:
- whether the issue is case merge/split, assignment, transfer, or missing appointment name
- whether database connection/runtime issues are involved
- whether the symptom is display-only or blocks workflow

Useful follow-up questions:
- ปัญหาเกิดตอนมอบหมาย ปรับโอน หรือแยกคดีขั้นตอนไหน
- ชื่อที่ไม่พบหรือข้อมูลที่ไม่แสดงคืออะไร
- มี error message หรือไม่

## BMA-OSS-MA / BMA-GOV-MA2

Typical pattern:
- Large volume of broad tickets, many with sparse cause text
- Common labels include `System Bug`, `Human Error`, and operational issues

Agent behavior:
- Be conservative.
- Ask one sharp clarifying question if the cause text is weak.
- Distinguish between:
  - user action mistake
  - data/config issue
  - real application bug
  - outage/network/runtime issue

Useful follow-up questions:
- ปัญหาเกิดตอนขั้นตอนไหน
- มีข้อความ error อะไรขึ้นหรือไม่
- เป็นเฉพาะรายการนี้หรือทุกรายการ

## Cross-project questioning strategy

When you are not yet confident:
- Ask for the exact record/document/case ID first
- Ask what the user expected to happen
- Ask what happened instead
- Ask whether the issue affects only one item or many items
- Ask for screenshot/log/error text when the issue depends on system behavior

## Quick-fix guidance

Use historical `วิธีการแก้ไขปัญหา` as inspiration for practical next steps, but do not overclaim.

Good quick fixes:
- ask user/back office to correct a specific field
- ask admin to verify registry book / running number / master data
- suggest retry with exact reproduction and screenshot when it looks like bug/system error

Avoid:
- inventing a fix not supported by the ticket, project context, or historical pattern
- routing Human Error to Dev without evidence of system defect
