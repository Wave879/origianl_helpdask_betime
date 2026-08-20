# Helpdesk Problem Type Test Set Template

ใช้ไฟล์นี้เป็นแม่แบบสำหรับคัดเคสจาก `tcp.txn.case.xls` มาทดสอบว่า prompt แยกประเภทเคสได้ตรงแค่ไหน

## หลักการ

- 1 แถว = 1 เคสทดสอบ
- ใช้ `Case Subject` + `Ticket Ref./Case Description` เป็นข้อความหลักในการตัดสิน
- `Case Type` เดิมจากระบบเก่าใช้เป็น `historical_label`
- อย่าเชื่อ label เดิมทันที ถ้าคำอธิบายเคสจริงขัดกับ label เดิม ให้ review ใหม่
- เป้าหมายคือแยกว่า prompt ตอบตรงกับ `expected_problem_type` หรือไม่

## คอลัมน์ที่แนะนำ

| Column | ใช้ทำอะไร |
|---|---|
| `test_id` | รหัสแถวทดสอบ เช่น `TS-001` |
| `ticket` | เลข ticket เช่น `ERC-SRB_6900718` |
| `historical_case_type` | ประเภทเดิมจากไฟล์ `Case Type` |
| `project_service` | จาก `Project / Service` |
| `area` | จาก `Area` |
| `channel` | จาก `Channel` |
| `case_subject` | จาก `Case Subject` |
| `case_description` | จาก `Ticket Ref./Case Description` |
| `expected_problem_type` | คำตอบที่ทีมต้องการให้ prompt ตอบ |
| `why_expected` | เหตุผลสั้น ๆ ว่าทำไมควรเป็นประเภทนั้น |
| `borderline_with` | ประเภทที่ใกล้เคียงและอาจสับสน |
| `ai_problem_type` | คำตอบที่ AI ตอบจริง |
| `ai_reason` | เหตุผลที่ AI ตอบ |
| `result` | `PASS` / `FAIL` |
| `review_note` | หมายเหตุเพิ่มเติม |

## ค่า `expected_problem_type` ที่ใช้

- `Human error`
- `system error`
- `System Bug`
- `Change Request`
- `Software`
- `network`
- `hardware`

## เกณฑ์ตัดสินเร็ว

### Human error
- ผู้ใช้กดผิด
- เลือกเรื่องผิด
- รับเอกสารผิด
- ส่งเส้นทางผิด
- ลงทะเบียนผิดเอง

### system error
- ระบบล่ม
- timeout
- 500 error
- endpoint ไม่ตอบ
- failed to fetch

### System Bug
- ผู้ใช้ทำถูก แต่ระบบ logic ผิด
- running number / sequence / เลขทะเบียน / เลขรับ ถูก generate ผิดเอง
- สถานะผิด
- mapping ผิด
- คำนวณผิด

### Change Request
- ขอเพิ่ม
- ขอปรับ
- ขอเปลี่ยน behavior โดย design

## Template ตัวอย่าง

```csv
test_id,ticket,historical_case_type,project_service,area,channel,case_subject,case_description,expected_problem_type,why_expected,borderline_with,ai_problem_type,ai_reason,result,review_note
TS-001,ERC-SRB_6900001,Human Error,ERC-SARABUN,สำนักงาน กกพ.(ส่วนกลาง),Line,กดรับเอกสารผิดเรื่อง,"ผู้ใช้กดรับหนังสือผิดเรื่อง ต้องคืนเลขรับและรับใหม่",Human error,"เกิดจากผู้ใช้เลือก/กดผิด ไม่ใช่ระบบล่มหรือ logic ผิด","System Bug",,,, 
TS-002,ERC-SRB_6900002,System Bug,ERC-SARABUN,สำนักงาน กกพ.(ส่วนกลาง),Line,เลขทะเบียนรับขึ้นผิด,"ผู้ใช้ทำขั้นตอนถูก แต่ระบบออกเลขทะเบียนรับผิดเอง",System Bug,"เป็นปัญหา logic ของ running number / sequence","Human error",,,, 
TS-003,ERC-SRB_6900003,System Error,ERC-SARABUN,สำนักงาน กกพ.(ส่วนกลาง),Line,เปิดหน้ารับหนังสือไม่ได้,"ผู้ใช้เข้าเมนูแล้วระบบค้างและ timeout",system error,"ระบบไม่ตอบสนอง เป็น operational/system availability issue","System Bug",,,, 
```

## วิธีใช้กับไฟล์ `tcp.txn.case.xls`

แนะนำให้ดึงคอลัมน์เหล่านี้มาสร้าง test set ก่อน:

- `Ticket`
- `Case Subject`
- `Case Type`
- `Project / Service`
- `Area`
- `Channel`
- `Ticket Ref./Case Description`

## เป้าหมายการวัด

อย่างน้อยควรวัด:

- Accuracy รวม
- Accuracy แยกตามแต่ละ problem type
- False Positive ของ `Human error`
- False Positive ของ `System Bug`
- Borderline cases ที่คนยังเห็นไม่ตรงกัน

## แนวทางคัดเคส

เริ่มจากอย่างน้อย:

- 10 เคส `Human error`
- 10 เคส `System Bug`
- 10 เคส `system error`
- 5 เคส `Change Request`

ถ้าเคสจริงเยอะ ให้คัดเคสที่ภาษาใกล้ของจริงมากที่สุดก่อน โดยเฉพาะกลุ่ม:

- เลขทะเบียน / เลขรับ / sequence
- route หนังสือ
- กดรับผิดเรื่อง
- ระบบค้าง / timeout / 500
- ขอเพิ่ม field / report / dropdown
