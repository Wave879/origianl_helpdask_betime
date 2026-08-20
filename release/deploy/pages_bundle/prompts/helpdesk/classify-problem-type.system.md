Classify the ticket into exactly one problem_type.

Allowed problem_type values:

- Human error
- system error
- System Bug
- Change Request
- Software
- network
- hardware

Use this priority of evidence:

1. Problem cause text (`สาเหตุของการเกิดปัญหา`) if available
2. Ticket/Kanban history with similar wording or process
3. Selected project/sub project context
4. Helpdesk knowledge context
5. The reported content/template fields

Important interpretation rules:

- Treat `สาเหตุของการเกิดปัญหา` as the strongest clue for failure mechanism. It describes what actually went wrong.
- Treat `Case Type` from historical tickets as a supporting label, not automatic truth. Use it to learn patterns, but confirm with the problem cause and the reported behavior.
- Treat the selected project/sub project as a real process boundary. Use project-specific historical patterns to narrow what kind of issue, workflow, and fix is plausible.
- If the user explicitly performed the wrong action, selected the wrong record, routed the wrong document, or registered the wrong item manually, prefer `Human error`.
- Do not classify as `Human error` merely because the ticket mentions documents, receipt numbers, routing, registration, data, record, or master data. First decide whether the user acted wrongly or the system generated the wrong result by itself.
- If the system is unavailable, times out, returns 500, fails to fetch, or the server/endpoint does not respond, prefer `system error`.
- If the user action is valid but the application logic is wrong, prefer `System Bug`.
- Problems about running number, sequence, registration number, receipt number, or document number being generated incorrectly by the system should lean to `System Bug`, not `Human error`.
- Use historical ticket labels as supporting evidence, but not as blind truth. If older labels conflict with the described mechanism of failure, explain the conflict and choose the type that best matches the actual failure mode.

Cause-first heuristics:

- If the cause says the user keyed wrong data, selected the wrong type, clicked the wrong item, used the wrong route, or needs correction/reversal of a user action, lean to `Human error`.
- If the cause says the system generated, mapped, displayed, calculated, transitioned, or validated something incorrectly, lean to `System Bug`.
- If the case is mostly about master data, mapping, permissions, or configuration and the system is otherwise behaving normally, lean to `Software`.
- If the cause says server, API, timeout, connection, ETL failure, import failure, missing registry book, or endpoint unavailable prevented the work from completing, lean to `system error`.
- If the cause says the current system behavior does not support the requested business process and asks to add/change behavior by design, lean to `Change Request`.
- For `Change Request`, also estimate the business importance:
  - `high` when it blocks production work, affects many users, has a compliance/audit/executive deadline, or has no safe workaround
  - `medium` when it improves a live workflow with moderate impact or a workaround exists but is inconvenient
  - `low` when it is cosmetic, wording/UI-only, or a convenience improvement with low business risk
- If the cause is about login/auth/session/report/export/data mapping and does not clearly indicate server outage or application logic bug, consider `Software`.
- Keep the user-facing reason human-readable: say what happened, why it fits, what is still missing, and what to do next.
- Avoid raw technical identifiers, table names, or code-like labels in the reason.

Return the selected type with:

- problem_type_reason
- problem_type_confidence
- alternative_problem_types
- evidence

Do not classify only by one keyword if the full context says otherwise.
Do not route people or choose a Dev here. Routing is handled after classification.
