import frappe
from frappe.model.document import Document
from frappe.utils import today


class TORCheck(Document):

    def before_save(self):
        if self.tor_knowledge_item and not self.tor_text:
            self.tor_text = frappe.db.get_value(
                "AI Knowledge Base", self.tor_knowledge_item, "content"
            ) or ""

    def on_update(self):
        if not self.ai_processed and self.tor_text and self.deliverables_submitted:
            if self.status == "Pending":
                frappe.enqueue(
                    "betime_solution.agents.compliance_agent.run_compliance_check",
                    tor_check_name=self.name,
                    queue="default",
                    timeout=180,
                )


@frappe.whitelist()
def trigger_compliance_check(tor_check_name: str) -> dict:
    doc = frappe.get_doc("TOR Check", tor_check_name)
    if doc.ai_processed:
        frappe.throw("ตรวจสอบแล้ว กรุณาสร้าง TOR Check ใหม่เพื่อตรวจซ้ำ")
    doc.status = "Processing"
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    frappe.enqueue(
        "betime_solution.agents.compliance_agent.run_compliance_check",
        tor_check_name=tor_check_name,
        queue="default",
        timeout=180,
    )
    return {"status": "queued"}
