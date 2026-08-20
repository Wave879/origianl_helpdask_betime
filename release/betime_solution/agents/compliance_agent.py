import json
import re
import frappe
from betime_solution.utils.azure_ai import chat_completion


def run_compliance_check(tor_check_name: str) -> None:
    doc = frappe.get_doc("TOR Check", tor_check_name)
    try:
        doc.status = "Processing"
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        result = _analyse_compliance(doc.tor_text or "", doc.deliverables_submitted or "")

        doc.compliance_score = result.get("score", 0)
        doc.missing_items = result.get("missing_items", "")
        doc.recommendations = result.get("recommendations", "")
        doc.full_analysis = result.get("full_analysis", "")
        doc.status = "Completed"
        doc.ai_processed = 1
        if not doc.check_date:
            from frappe.utils import today
            doc.check_date = today()
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        frappe.publish_realtime(
            "compliance_done",
            {"tor_check_name": tor_check_name, "score": doc.compliance_score},
            user=doc.owner,
        )

    except Exception as exc:
        frappe.log_error(frappe.get_traceback(), "Compliance Agent Error")
        try:
            doc.status = "Failed"
            doc.full_analysis = f"Error: {exc}"
            doc.save(ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            pass


def _analyse_compliance(tor_text: str, deliverables: str) -> dict:
    system_prompt = (
        "You are a compliance analyst. Compare deliverables against TOR requirements. "
        "Return ONLY valid JSON with these keys: "
        "score (0-100 float), missing_items (string, bullet list), "
        "recommendations (string, bullet list), full_analysis (string, markdown). "
        "Score 100 = all requirements met. Be strict and precise."
    )

    user_prompt = f"""TOR / Contract Requirements:
---
{tor_text[:2000]}
---

Submitted Deliverables:
---
{deliverables[:1500]}
---

Analyse compliance and return JSON only."""

    response = chat_completion(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=2000,
        temperature=0.1,
    )

    return _parse_json(response)


def _parse_json(raw: str) -> dict:
    try:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            return json.loads(match.group())
    except Exception:
        pass
    return {
        "score": 0,
        "missing_items": "ไม่สามารถวิเคราะห์ได้",
        "recommendations": "กรุณาตรวจสอบ TOR และผลส่งมอบอีกครั้ง",
        "full_analysis": raw,
    }
