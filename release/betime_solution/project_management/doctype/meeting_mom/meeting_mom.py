import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class MeetingMOM(Document):

    def before_save(self):
        # Trigger AI processing on first save if audio link provided and not yet processed
        if self.audio_sharepoint_link and not self.ai_processed:
            self.processing_status = "Pending"

    def on_submit(self):
        pass


@frappe.whitelist()
def trigger_ai_processing(mom_name: str):
    """
    Whitelist API — called from the form button to kick off AI pipeline:
    STT → LLM Summary/Extraction → Auto Task creation.
    """
    doc = frappe.get_doc("Meeting MOM", mom_name)
    if doc.ai_processed:
        frappe.throw("MOM นี้ถูกประมวลผลแล้ว")

    doc.processing_status = "Processing"
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    # Enqueue background job so the HTTP response returns immediately
    frappe.enqueue(
        "betime_solution.agents.mom_agent.run_full_pipeline",
        mom_name=mom_name,
        queue="long",
        timeout=600,
    )
    return {"status": "queued", "message": "AI กำลังประมวลผล MOM ในพื้นหลัง"}


@frappe.whitelist()
def get_mom_summary(mom_name: str) -> dict:
    """Return processed MOM data for display."""
    doc = frappe.get_doc("Meeting MOM", mom_name)
    tasks = frappe.get_list(
        "Smart Task",
        filters={"linked_mom": mom_name},
        fields=["name", "task_name", "assigned_to", "deadline", "status"],
    )
    return {
        "summary": doc.summary,
        "decisions": doc.decisions,
        "risks": doc.risks,
        "issues": doc.issues,
        "tasks": tasks,
        "processing_status": doc.processing_status,
    }
