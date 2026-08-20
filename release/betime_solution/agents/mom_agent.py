"""
MOM Agent — Full pipeline:
  1. Download audio from SharePoint (or local path)
  2. Azure Speech-to-Text transcription
  3. Azure OpenAI analysis: summary, decisions, risks, issues
  4. Auto-create Smart Tasks from decisions
  5. Update Meeting MOM record
"""

import json
import frappe
from frappe.utils import now_datetime, add_days, today


# ---------------------------------------------------------------------------
# Entry points called by hooks / scheduler
# ---------------------------------------------------------------------------

def on_mom_save(doc, method):
    """Hook: triggered after Meeting MOM save. Queues processing if needed."""
    if doc.audio_sharepoint_link and not doc.ai_processed and doc.processing_status == "Pending":
        frappe.enqueue(
            "betime_solution.agents.mom_agent.run_full_pipeline",
            mom_name=doc.name,
            queue="long",
            timeout=600,
        )


def process_pending_moms():
    """Scheduler: retry any MOM stuck in Pending state for > 1 hour."""
    from frappe.utils import add_to_date
    cutoff = add_to_date(now_datetime(), hours=-1)
    pending = frappe.get_list(
        "Meeting MOM",
        filters={"processing_status": "Pending", "audio_sharepoint_link": ["!=", ""],
                 "modified": ["<", cutoff]},
        fields=["name"],
        limit_page_length=10,
    )
    for item in pending:
        frappe.enqueue(
            "betime_solution.agents.mom_agent.run_full_pipeline",
            mom_name=item.name,
            queue="long",
            timeout=600,
        )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_full_pipeline(mom_name: str):
    """Execute the full MOM AI pipeline for a given MOM record."""
    doc = frappe.get_doc("Meeting MOM", mom_name)
    try:
        doc.processing_status = "Processing"
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        # Step 1: Transcription
        transcript = _transcribe(doc)
        doc.transcript = transcript
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        # Step 2: LLM Analysis
        analysis = _analyse_transcript(transcript, doc.meeting_title,
                                       doc.project, doc.meeting_date)

        # Step 3: Write analysis back to MOM
        doc.summary = analysis.get("summary", "")
        doc.decisions = "\n".join(analysis.get("decisions", []))
        doc.risks = "\n".join(analysis.get("risks", []))
        doc.issues = "\n".join(analysis.get("issues", []))

        # Step 4: Auto-create Smart Tasks
        tasks_created = _create_tasks_from_decisions(
            analysis.get("tasks", []), doc.name, doc.project
        )
        doc.tasks_generated = tasks_created
        doc.ai_processed = 1
        doc.ai_processed_at = now_datetime()
        doc.processing_status = "Completed"
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        # Step 5: Index in Knowledge Base
        _index_mom_knowledge(doc)

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), f"MOM Agent Error: {mom_name}")
        doc.processing_status = "Failed"
        doc.save(ignore_permissions=True)
        frappe.db.commit()


# ---------------------------------------------------------------------------
# Step 1: Transcription
# ---------------------------------------------------------------------------

def _transcribe(doc) -> str:
    """
    Get transcript from Azure Speech-to-Text.
    If audio_sharepoint_link is a local file path, use it directly.
    Otherwise, download from SharePoint first.
    """
    import os
    audio_path = doc.audio_sharepoint_link

    # If it's a SharePoint URL, download it first
    if audio_path.startswith("http"):
        audio_path = _download_from_sharepoint(audio_path, doc.name)

    if not os.path.exists(audio_path):
        frappe.throw(f"ไม่พบไฟล์เสียง: {audio_path}")

    from betime_solution.utils.azure_ai import transcribe_audio
    return transcribe_audio(audio_path)


def _download_from_sharepoint(url: str, mom_name: str) -> str:
    """Download a file from SharePoint using Microsoft Graph API."""
    import os, tempfile
    from msgraph import GraphServiceClient
    from azure.identity import ClientSecretCredential

    credential = ClientSecretCredential(
        tenant_id=frappe.conf.get("azure_tenant_id"),
        client_id=frappe.conf.get("azure_client_id"),
        client_secret=frappe.conf.get("azure_client_secret"),
    )
    # Use httpx to download the file directly (simpler than Graph SDK for raw files)
    import httpx
    token = credential.get_token("https://graph.microsoft.com/.default").token
    response = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=120)
    response.raise_for_status()

    tmp_path = os.path.join(tempfile.gettempdir(), f"mom_{mom_name}.wav")
    with open(tmp_path, "wb") as f:
        f.write(response.content)
    return tmp_path


# ---------------------------------------------------------------------------
# Step 2: LLM Analysis
# ---------------------------------------------------------------------------

_ANALYSIS_SYSTEM_PROMPT = """คุณคือ Project Manager / Team Lead ระดับอาวุโส ที่ต้องสรุป Minutes of Meeting จาก transcript การประชุมให้ใช้งานได้จริงในองค์กร

เป้าหมาย:
- สรุปแบบละเอียดพอให้หัวหน้า/PM อ่านแล้วตัดสินใจต่อได้ทันที
- ดึงประเด็นสำคัญให้ครบ: ภาพรวม, มติ, ความเสี่ยง, ปัญหา, งานที่ต้องทำ
- ถ้าข้อมูลไม่ชัดเจน ห้ามเดา ให้เขียนว่า "ยังไม่ชัดเจน" หรือ "ต้องตรวจสอบเพิ่มเติม"
- ถ้า transcript มีข้อมูลเรื่อง owner, deadline, priority, dependency ให้ดึงออกมาให้ครบ
- เขียนภาษาไทย ชัดเจน เป็นทางการ และอ่านง่าย

ต้องตอบกลับเป็น JSON เท่านั้น ตามโครงสร้างนี้:
{
  "summary": "สรุปแบบผู้บริหาร 3-6 ประโยค เน้นภาพรวม, ผลกระทบ, และสิ่งที่ต้องติดตาม",
  "decisions": [
    "มติ/ข้อสรุปที่ 1 พร้อมบริบทสั้นๆ ว่าตกลงอะไร",
    "มติ/ข้อสรุปที่ 2"
  ],
  "risks": [
    "ความเสี่ยงที่ 1 พร้อมผลกระทบหรือเหตุผลที่ควรระวัง"
  ],
  "issues": [
    "ปัญหาหรือประเด็นค้างคา 1 พร้อมสิ่งที่ต้องตรวจสอบต่อ"
  ],
  "dates": [
    {
      "date_range": "12-15",
      "month_hint": "เดือน/ช่วงเดือนที่เกี่ยวข้อง ถ้ามี",
      "context": "เหตุผลหรือบริบทของการนัด/กำหนดการ"
    }
  ],
  "tasks": [
    {
      "task_name": "ชื่อภารกิจแบบสั้นและชัด",
      "assigned_to_hint": "ชื่อผู้รับผิดชอบหรือทีมที่คาดว่าเกี่ยวข้อง ถ้าไม่ระบุให้ใช้ 'ยังไม่ระบุ'",
      "deadline_days": 7,
      "description": "รายละเอียดงานแบบ PM ใช้ติดตามได้",
      "priority_hint": "High / Medium / Low",
      "dependency_hint": "เงื่อนไขหรือสิ่งที่ต้องรอก่อนเริ่มงาน ถ้าไม่มีให้ใช้ 'ไม่มี'"
    }
  ]
}

กติกา:
- summary ต้องมีสาระ ไม่ปล่อยว่าง
- decisions / risks / issues / tasks ต้องพยายามใส่ให้ครบจาก transcript
- dates ต้องดึงคำที่เกี่ยวกับการนัดหมาย การแจ้งวัน การกำหนดช่วงเวลา หรือ timeline ที่พูดในประชุม
- ถ้าพบวันไม่ชัดเจน ให้สรุปเป็นช่วง เช่น "12-15" หรือ "12-15 ของเดือนนั้น" แทนการเดาเป็นวันเดียว
- ถ้ามีข้อมูลเดือน/ช่วงเดือน ให้ใส่ใน month_hint
- ถ้าพบประโยคแนว "เดี๋ยวนัด", "นัดอีกที", "แจ้งวัน", "ภายใน", "ช่วง", "ประมาณ" ให้พิจารณาใส่ใน dates
- ถ้ามีหลายหัวข้อ ให้แยกเป็น bullet ใน JSON array
- ถ้าไม่มีข้อมูลในหัวข้อใด ให้ใส่ข้อความที่เหมาะสมแทนการเว้นว่าง
- ห้ามใส่ markdown, code fence หรือคำอธิบายนอก JSON"""


def _analyse_transcript(transcript: str, meeting_title: str,
                         project: str, meeting_date) -> dict:
    from betime_solution.utils.azure_ai import chat_completion

    user_message = (
        f"ชื่อการประชุม: {meeting_title}\n"
        f"โครงการ: {project}\n"
        f"วันที่: {meeting_date}\n\n"
        f"Transcript:\n{transcript[:4000]}"  # Limit to avoid token overflow
    )
    raw = chat_completion(
        messages=[
            {"role": "system", "content": _ANALYSIS_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        model="gpt-4o",
        temperature=0.2,
        max_tokens=3500,
    )

    try:
        # Strip markdown code fences if present
        clean = raw.strip()
        if clean.startswith("```"):
            clean = clean.split("\n", 1)[1].rsplit("```", 1)[0]
        return json.loads(clean)
    except json.JSONDecodeError:
        frappe.log_error(f"MOM Agent JSON parse failed:\n{raw}", "MOM Agent Parse Error")
        return {"summary": raw, "decisions": [], "risks": [], "issues": [], "dates": [], "tasks": []}


# ---------------------------------------------------------------------------
# Step 3: Auto-create Smart Tasks
# ---------------------------------------------------------------------------

def _create_tasks_from_decisions(tasks_data: list, mom_name: str, project: str) -> int:
    """Create Smart Task records from the LLM-extracted task list."""
    if not tasks_data or not project:
        return 0

    # Get project manager as fallback assignee
    pm = frappe.db.get_value("Project Master", project, "project_manager")
    count = 0

    for t in tasks_data:
        try:
            task = frappe.new_doc("Smart Task")
            task.task_name = t.get("task_name", "งานจาก MOM")
            task.project = project
            task.linked_mom = mom_name
            task.auto_created = 1
            task.status = "Open"
            task.priority = "Medium"
            task.description = t.get("description", "")

            # Assign to PM if no specific assignee found
            task.assigned_to = pm or frappe.session.user

            # Set deadline from days offset
            days = int(t.get("deadline_days") or 7)
            task.deadline = add_days(today(), days)

            task.insert(ignore_permissions=True)
            count += 1
        except Exception:
            frappe.log_error(frappe.get_traceback(), "MOM Task Creation Error")

    frappe.db.commit()
    return count


# ---------------------------------------------------------------------------
# Step 4: Index MOM summary into Knowledge Base
# ---------------------------------------------------------------------------

def _index_mom_knowledge(doc):
    """Create or update an AI Knowledge Base entry from the processed MOM."""
    if not doc.summary:
        return
    content = (
        f"สรุปประชุม: {doc.summary}\n\n"
        f"มติ:\n{doc.decisions or '-'}\n\n"
        f"ความเสี่ยง:\n{doc.risks or '-'}\n\n"
        f"ประเด็น:\n{doc.issues or '-'}"
    )
    existing = frappe.db.get_value("AI Knowledge Base",
                                   {"source_type": "Meeting MOM",
                                    "source_link": doc.name}, "name")
    if existing:
        kb = frappe.get_doc("AI Knowledge Base", existing)
        kb.content = content
        kb.save(ignore_permissions=True)
    else:
        kb = frappe.new_doc("AI Knowledge Base")
        kb.title = f"MOM: {doc.meeting_title} ({doc.meeting_date})"
        kb.category = "Meeting Knowledge"
        kb.source_type = "Meeting MOM"
        kb.source_link = doc.name
        kb.project = doc.project
        kb.content = content
        kb.insert(ignore_permissions=True)
    frappe.db.commit()
