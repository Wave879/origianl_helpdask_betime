# MANA Knowledge Scope

MANA uses two knowledge layers:

1. `global`
   - Shared knowledge usable by every project.
   - Examples: general troubleshooting rules, helpdesk SOP, common escalation policy, common browser/network checks.

2. `project`
   - Knowledge usable only when the ticket/chat belongs to that project.
   - Requires `project_code`.
   - Example: ERC-Sarabun manuals are `knowledge_scope='project'` and `project_code='ERC'`.

3. `sub_project`
   - Knowledge usable only for a specific project and sub-project.
   - Requires `project_code` and `sub_project_code`.

## Tables

`knowledge_articles` stores the readable source:

- `knowledge_scope`: `global`, `project`, or `sub_project`
- `project_code`: project code such as `ERC`, `SRB`, `BT`
- `sub_project_code`: optional sub-project code
- `source_type`: optional source type such as `pdf`, `manual`, `sop`
- `source_ref`: optional source filename, URL, or external id

`knowledge_embeddings` stores the semantic-search vector:

- `article_id`: points to `knowledge_articles.id`
- `knowledge_scope`, `project_code`, `sub_project_code`: copied from the article for filtering
- `embedding`: `double precision[]`

## Search Behavior

MANA searches:

- `global` knowledge for every request
- `project` knowledge only when the detected project matches
- `sub_project` knowledge only when the detected project and sub-project match

For ERC-Sarabun, MANA infers `project_code='ERC'` when the chat/ticket mentions `ERC`, `Sarabun`, or `สารบรรณ`.

## Adding Knowledge Later

Use `/api/helpdeck-knowledge` with these fields:

```json
{
  "title": "Common login troubleshooting",
  "content": "Steps that apply to all projects...",
  "tags": "login,common,sop",
  "knowledge_scope": "global"
}
```

Project-specific example:

```json
{
  "title": "ERC-Sarabun user manual",
  "content": "Project-specific instructions...",
  "tags": "ERC-Sarabun,sarabun,manual",
  "knowledge_scope": "project",
  "project_code": "ERC",
  "source_type": "pdf",
  "source_ref": "ERC-Sarabun_คู่มือการใช้งานระบบสารบรรณฯ_V1.pdf"
}
```

The API stores the article first, then tries to generate/update its embedding. If embedding fails, the article still works through keyword search and can be backfilled later:

```powershell
python scripts/backfill_knowledge_embeddings.py --where "ka.id='ARTICLE_ID'"
```

