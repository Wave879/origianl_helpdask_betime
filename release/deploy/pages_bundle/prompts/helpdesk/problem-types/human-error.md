# Human error

Definition:
User action or operational mistake caused the issue.

When to use:
- Wrong receive number
- Wrong document route
- Wrong record selected
- User clicked/confirmed the wrong item

When not to use:
- The user did the correct action but the system logic failed
- Server/API failed

Evidence:
- Mentions of เลขรับ, ทะเบียนรับ, ลงรับ, เส้นทางหนังสือ, กดรับผิดเรื่อง
- Request asks to correct, revert, cancel, or restore a user action

Possible causes to check:
- Wrong item was selected
- Receive number was assigned to the wrong record
- Document route/history needs correction
- Transaction log must be checked before editing data
