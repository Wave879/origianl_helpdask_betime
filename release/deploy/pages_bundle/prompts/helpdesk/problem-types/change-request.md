# Change Request

Definition:
The requester wants to add, adjust, or enhance system behavior.

When to use:
- Add field/dropdown/report
- Change workflow
- Add condition or validation
- Enhancement request

Priority guidance:
- High: production impact, many users, urgent business deadline
- Medium: normal business improvement or moderate impact
- Low: cosmetic/minor improvement

How to infer importance:
- High
  - blocks or delays a real business process in production
  - affects many users/teams or executive workflow
  - tied to legal, audit, compliance, or a near-term deadline
  - workaround is missing or very risky
- Medium
  - improves an active business workflow
  - affects a limited group or one team
  - workaround exists but is inconvenient, slow, or error-prone
- Low
  - cosmetic/UI wording/layout request
  - convenience improvement with low operational risk
  - request can wait without harming core process

Priority output guidance:
- When classifying a Change Request, also infer:
  - `priority_level`
  - `impact`
  - `urgency`
  - short `priority_detail`
- If evidence is weak, default to `medium` and say what must be confirmed.

Possible causes to check:
- Existing feature does not support requested process
- Criteria/sub criteria should be mapped
- Impact and urgency need user confirmation
