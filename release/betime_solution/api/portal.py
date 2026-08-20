"""
Portal API — endpoints used by web portal pages (STT, OCR, Help Desk, OT submit).
All require logged-in user (not Guest).
"""

import frappe
from frappe.utils import today
from betime_solution.utils.security import assert_role


def _loads_json(value, default):
    import json
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default
    return value if value is not None else default


def _parse_json_reply(reply: str, default: dict) -> dict:
    import json
    import re

    if not reply:
        return default
    text = reply.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else default
    except Exception:
        return default


def _require_login():
    if frappe.session.user == "Guest":
        frappe.throw("กรุณาเข้าสู่ระบบ", frappe.PermissionError)


def _is_privileged_user() -> bool:
    roles = set(frappe.get_roles(frappe.session.user))
    return bool(roles.intersection({"BT CEO", "BT Admin", "BT Manager", "BT Finance", "System Manager"}))


def _resolve_uploaded_file_path(file_path: str) -> str:
    """Allow STT only for files stored under the site's /files or /private/files paths."""
    import os

    if not isinstance(file_path, str) or not file_path.strip():
        frappe.throw("เส้นทางไฟล์ไม่ถูกต้อง", frappe.ValidationError)

    site_path = frappe.get_site_path()
    if file_path.startswith("/files/"):
        base_dir = os.path.abspath(os.path.join(site_path, "public", "files"))
        abs_path = os.path.abspath(os.path.join(site_path, "public", file_path.lstrip("/")))
    elif file_path.startswith("/private/files/"):
        base_dir = os.path.abspath(os.path.join(site_path, "private", "files"))
        abs_path = os.path.abspath(os.path.join(site_path, "private", file_path.lstrip("/")))
    else:
        frappe.throw("อนุญาตเฉพาะไฟล์ใน /files หรือ /private/files", frappe.PermissionError)

    norm_base = os.path.normcase(base_dir)
    norm_target = os.path.normcase(abs_path)
    if not (norm_target == norm_base or norm_target.startswith(norm_base + os.sep)):
        frappe.throw("ไม่อนุญาตให้เข้าถึงไฟล์นี้", frappe.PermissionError)

    return abs_path


# ---------------------------------------------------------------------------
# STT Tool
# ---------------------------------------------------------------------------

@frappe.whitelist()
def process_audio_stt(file_path: str, meeting_title: str = "",
                      meeting_date: str = "", project: str = "") -> dict:
    """
    Step 1: Transcribe audio file.
    Step 2: Run LLM analysis on transcript.
    Returns transcript + full analysis dict.
    """
    _require_login()

    abs_path = _resolve_uploaded_file_path(file_path)

    from betime_solution.utils.azure_ai import transcribe_audio
    transcript = transcribe_audio(abs_path)

    from betime_solution.agents.mom_agent import _analyse_transcript
    analysis = _analyse_transcript(transcript, meeting_title, project, meeting_date)
    analysis["transcript"] = transcript
    return analysis


@frappe.whitelist()
def save_mom_from_stt(transcript: str = "", summary: str = "", decisions=None,
                      risks=None, issues=None, tasks=None, meeting_title: str = "",
                      meeting_date: str = "", project: str = "") -> dict:
    """Create a Meeting MOM record from STT analysis result."""
    _require_login()

    import json
    decisions = json.loads(decisions) if isinstance(decisions, str) else decisions or []
    risks     = json.loads(risks)     if isinstance(risks, str)     else risks     or []
    issues    = json.loads(issues)    if isinstance(issues, str)    else issues    or []
    tasks     = json.loads(tasks)     if isinstance(tasks, str)     else tasks     or []

    mom = frappe.new_doc("Meeting MOM")
    mom.meeting_title    = meeting_title or "การประชุม"
    mom.meeting_date     = meeting_date  or today()
    mom.project          = project
    mom.transcript       = transcript
    mom.summary          = summary
    mom.decisions        = "\n".join(decisions) if isinstance(decisions, list) else decisions
    mom.risks            = "\n".join(risks)     if isinstance(risks, list)     else risks
    mom.issues           = "\n".join(issues)    if isinstance(issues, list)    else issues
    mom.ai_processed     = 1
    mom.processing_status = "Completed"
    mom.insert()

    # Auto-create tasks
    from betime_solution.agents.mom_agent import _create_tasks_from_decisions
    task_count = _create_tasks_from_decisions(tasks, mom.name, project)
    mom.db_set("tasks_generated", task_count, update_modified=False)
    frappe.db.commit()
    return {"mom_name": mom.name, "tasks_created": task_count}


# ---------------------------------------------------------------------------
# OCR Lab
# ---------------------------------------------------------------------------

@frappe.whitelist()
def run_ocr(file_url: str, model_type: str = "prebuilt-layout") -> dict:
    """Run Azure Document Intelligence OCR on an uploaded file."""
    _require_login()

    # Build full URL for Azure (use site URL)
    site_url = frappe.utils.get_url()
    full_url = file_url if file_url.startswith("http") else site_url + file_url

    from betime_solution.utils.azure_ai import ocr_document
    return ocr_document(full_url)


@frappe.whitelist()
def save_ocr_to_knowledge(title: str, content: str, source: str = "") -> dict:
    """Save OCR result as an AI Knowledge Base entry."""
    _require_login()
    assert_role("BT CEO", "BT Admin", "BT Manager", "BT Compliance", "System Manager")

    kb = frappe.new_doc("AI Knowledge Base")
    kb.title       = title
    kb.category    = "Other"
    kb.source_type = "OCR Document"
    kb.source_link = source
    kb.content     = content
    kb.insert()
    frappe.db.commit()
    return {"name": kb.name}


# ---------------------------------------------------------------------------
# Help Desk Chat (RAG)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def help_desk_chat(message: str, history=None, category: str = "") -> dict:
    """
    RAG-powered chat endpoint.
    1. Search Azure AI Search for relevant knowledge chunks.
    2. Build context + chat history.
    3. Call Azure OpenAI for the answer.
    """
    _require_login()
    import json
    history = json.loads(history) if isinstance(history, str) else history or []

    # Step 1: Retrieve relevant knowledge
    from betime_solution.utils.azure_ai import search_knowledge
    try:
        results = search_knowledge(message, top=5)
        if category:
            results = [r for r in results if r.get("category") == category]
    except Exception:
        results = []

    # Step 2: Build system prompt with retrieved context
    context_text = "\n\n".join(
        f"[{r.get('category','')}] {r.get('title','')}\n{r.get('content','')[:400]}"
        for r in results
    ) if results else "ไม่พบข้อมูลที่เกี่ยวข้องใน Knowledge Base"

    system_prompt = f"""คุณเป็น Help Desk AI ของ Betime Solution
ตอบคำถามเกี่ยวกับโครงการ, TOR, สัญญา, กระบวนการทำงาน และ Lesson Learned
ใช้ข้อมูลต่อไปนี้เป็นหลัก:

{context_text}

ถ้าไม่มีข้อมูลตอบได้ ให้แจ้งว่าไม่มีข้อมูลในระบบ อย่าสุ่มตอบ
ตอบภาษาไทย กระชับ ชัดเจน"""

    messages = [{"role": "system", "content": system_prompt}]
    # Add recent history
    for h in history[-4:]:
        if isinstance(h, dict) and h.get("role") and h.get("content"):
            messages.append(h)
    messages.append({"role": "user", "content": message})

    # Step 3: Call LLM
    from betime_solution.utils.azure_ai import chat_completion
    try:
        answer = chat_completion(messages, temperature=0.3, max_tokens=800)
    except Exception as e:
        answer = f"ไม่สามารถเชื่อมต่อ AI ได้: {e}"

    return {
        "answer":  answer,
        "sources": [{"title": r.get("title",""), "category": r.get("category","")} for r in results],
    }


@frappe.whitelist()
def help_desk_ai_support(ticket=None, history=None) -> dict:
    """Generate analysis + 3 troubleshooting steps for a help desk ticket."""
    _require_login()

    ticket = _loads_json(ticket, {})
    history = _loads_json(history, [])

    project_code = ticket.get("project_code", "")
    project_name = ticket.get("project_name", "")
    subsystem = ticket.get("subsystem", "")
    bug_type = ticket.get("bug_type", "")
    location = ticket.get("location", "")
    description = ticket.get("description", "")
    attachment_name = ticket.get("attachment_name", "")

    conversation = "\n".join(
        f"{item.get('role', 'user')}: {item.get('content', '')}"
        for item in history[-8:]
        if isinstance(item, dict)
    ) or "ไม่มีประวัติการสนทนาก่อนหน้า"

    system_prompt = """คุณคือ AI IT Help Desk ของ Betime Solution
วิเคราะห์อาการปัญหาและเสนอวิธีแก้ไขเบื้องต้นแบบปฏิบัติได้จริง
ตอบเป็น JSON เท่านั้นในรูปแบบนี้:
{
  \"analysis\": \"...\",
  \"steps\": [\"ข้อ 1\", \"ข้อ 2\", \"ข้อ 3\"],
  \"follow_up\": \"คำถามติดตามผล\",
  \"quick_replies\": [\"สำเร็จ\", \"ไม่สำเร็จ\", \"ขออธิบายเพิ่มเติม\"]
}
กฎ:
- steps ต้องมี 3 ข้อเสมอ
- ตอบภาษาไทย กระชับ ชัดเจน
- ถ้าข้อมูลไม่พอ ให้ตั้งคำถามติดตามใน follow_up
- ห้ามใส่ markdown หรือ code fence"""

    user_prompt = f"""Project Code: {project_code}
Project Name: {project_name}
Subsystem: {subsystem}
Bug Type: {bug_type}
Location: {location}
Attachment: {attachment_name or '-'}
Issue Description: {description}

Conversation:
{conversation}
"""

    from betime_solution.utils.azure_ai import chat_completion
    fallback = {
        "analysis": "AI รับทราบปัญหาแล้วและกำลังช่วยวิเคราะห์อาการเบื้องต้น",
        "steps": [
            "ตรวจสอบหน้าจอ error หรือข้อความแจ้งเตือนล่าสุด",
            "ลอง refresh หรือเข้าใช้งานใหม่อีกครั้งพร้อมบันทึกเวลาที่พบปัญหา",
            "ถ้ายังไม่หาย ให้แจ้งขั้นตอนที่ทำก่อนเกิดปัญหาเพิ่มเติม",
        ],
        "follow_up": "หลังจากลองครบทั้ง 3 ขั้นตอนแล้ว ผลเป็นอย่างไรบ้างครับ",
        "quick_replies": ["สำเร็จ", "ไม่สำเร็จ", "ขออธิบายเพิ่มเติม"],
    }
    try:
        reply = chat_completion(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.2, max_tokens=700)
        parsed = _parse_json_reply(reply, fallback)
    except Exception:
        parsed = fallback

    steps = parsed.get("steps") if isinstance(parsed.get("steps"), list) else fallback["steps"]
    while len(steps) < 3:
        steps.append(fallback["steps"][len(steps)])

    return {
        "analysis": parsed.get("analysis") or fallback["analysis"],
        "steps": steps[:3],
        "follow_up": parsed.get("follow_up") or fallback["follow_up"],
        "quick_replies": parsed.get("quick_replies") or fallback["quick_replies"],
    }


@frappe.whitelist()
def help_desk_case_summary(ticket=None, history=None, assignee: str = "") -> dict:
    """Generate a structured case summary for escalation/review."""
    _require_login()

    ticket = _loads_json(ticket, {})
    history = _loads_json(history, [])
    now_dt = frappe.utils.now_datetime()
    now_text = now_dt.strftime("%d %B %Y %H:%M:%S")

    transcript = "\n".join(
        f"{item.get('role', 'user')}: {item.get('content', '')}"
        for item in history[-12:]
        if isinstance(item, dict)
    ) or "ไม่มีประวัติการสนทนา"

    system_prompt = """คุณคือ AI Service Desk Analyst
ให้สรุปเคสเป็น JSON เท่านั้น โดยสร้างค่าทุกช่องให้มากที่สุดจากข้อมูลที่มี
รูปแบบ:
{
  \"case_subject\": \"...\",
  \"case_description\": \"...\",
  \"root_cause\": \"...\",
  \"solution_method\": \"...\",
  \"solution_detail\": \"...\",
  \"impact_level\": \"กระทบ|ไม่กระทบ\",
  \"change_detail\": \"...\",
  \"criteria\": \"...\",
  \"area\": \"...\",
  \"case_type\": \"...\",
  \"project_service_sub\": \"...\",
  \"priority\": \"Low|Medium|High|Critical\"
}
กฎ:
- ตอบภาษาไทย
- ถ้าไม่ทราบแน่ชัด ให้คาดการณ์เชิงช่วยงานอย่างระมัดระวัง
- ห้ามใส่ markdown หรือ code fence"""

    user_prompt = f"""Ticket:
{ticket}

Conversation:
{transcript}

Escalate To: {assignee or '-'}
"""

    from betime_solution.utils.azure_ai import chat_completion
    fallback = {
        "case_subject": ticket.get("description") or ticket.get("bug_type") or "แจ้งปัญหาระบบ",
        "case_description": ticket.get("description") or "ผู้ใช้แจ้งปัญหาการใช้งานระบบ ต้องการให้ตรวจสอบเพิ่มเติม",
        "root_cause": "อยู่ระหว่างตรวจสอบสาเหตุเชิงลึกโดยทีมพัฒนา",
        "solution_method": "AI แนะนำการตรวจสอบเบื้องต้นและส่งต่อทีมที่เกี่ยวข้อง",
        "solution_detail": "เก็บรายละเอียดอาการปัญหา, ข้อมูลโครงการ, subsystem, bug type และภาพประกอบเพื่อส่งต่อ",
        "impact_level": "กระทบ",
        "change_detail": "ยังไม่มีการเปลี่ยนแปลงใน production ณ เวลาสรุปเคส",
        "criteria": ticket.get("bug_type") or "Incident",
        "area": ticket.get("location") or "N/A",
        "case_type": ticket.get("bug_type") or "Application Bug",
        "project_service_sub": ticket.get("subsystem") or "N/A",
        "priority": ticket.get("priority") or "Medium",
    }

    try:
        reply = chat_completion(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.2, max_tokens=1000)
        parsed = _parse_json_reply(reply, fallback)
    except Exception:
        parsed = fallback

    user_name = frappe.session.user_fullname or frappe.session.user
    return {
        "ticket": ticket.get("id", "AUTO"),
        "priority": parsed.get("priority") or fallback["priority"],
        "overdue_type": "ประเภทเกินกำหนด",
        "sla_response_due": now_text,
        "sla_finish_due": now_text,
        "response_time": now_text,
        "actual_finish_time": "",
        "channel": "Call Center",
        "project_service": ticket.get("project_name") or ticket.get("project_code") or "N/A",
        "project_service_sub": parsed.get("project_service_sub") or fallback["project_service_sub"],
        "area": parsed.get("area") or fallback["area"],
        "case_type": parsed.get("case_type") or fallback["case_type"],
        "criteria": parsed.get("criteria") or fallback["criteria"],
        "case_subject": parsed.get("case_subject") or fallback["case_subject"],
        "case_date": now_text,
        "case_date_finish": "",
        "case_date_process": now_text,
        "case_private": "",
        "closed_in_tm": "",
        "customer_name": user_name,
        "case_description": parsed.get("case_description") or fallback["case_description"],
        "root_cause": parsed.get("root_cause") or fallback["root_cause"],
        "solution_method": parsed.get("solution_method") or fallback["solution_method"],
        "solution_detail": parsed.get("solution_detail") or fallback["solution_detail"],
        "impact_level": parsed.get("impact_level") or fallback["impact_level"],
        "change_detail": parsed.get("change_detail") or fallback["change_detail"],
        "case_image": ticket.get("attachment_name", ""),
        "attachment": ticket.get("attachment_name", ""),
        "assignee": assignee,
        "chat_summary": transcript,
    }


# ---------------------------------------------------------------------------
# OT Self-Service
# ---------------------------------------------------------------------------

@frappe.whitelist()
def submit_ot_claim(employee: str, date: str, ot_hours, ot_rate="",
                    reason: str = "", project: str = "", notes: str = "") -> dict:
    """Create and submit an OT Claim from the self-service portal."""
    _require_login()
    employee = (employee or "").strip()
    if not employee and _is_privileged_user():
        frappe.throw("ไม่พบข้อมูลพนักงาน")

    if not _is_privileged_user():
        employee_from_user = frappe.db.get_value(
            "Employee Profile", {"user": frappe.session.user, "is_active": 1}, "name"
        )
        if not employee_from_user:
            frappe.throw("ไม่พบข้อมูลพนักงานของผู้ใช้งานปัจจุบัน", frappe.PermissionError)
        if employee and employee != employee_from_user:
            frappe.throw("ไม่สามารถยื่น OT แทนพนักงานคนอื่นได้", frappe.PermissionError)
        employee = employee_from_user

    if not employee:
        frappe.throw("ไม่พบข้อมูลพนักงาน")

    ot = frappe.new_doc("OT Claim")
    ot.employee = employee
    ot.date      = date
    ot.ot_hours  = float(ot_hours)
    ot.ot_rate   = float(ot_rate) if ot_rate else 0
    ot.reason    = reason
    ot.project   = project
    ot.notes     = notes
    ot.insert(ignore_permissions=True)
    ot.submit()
    frappe.db.commit()
    return {"name": ot.name, "status": ot.status}
