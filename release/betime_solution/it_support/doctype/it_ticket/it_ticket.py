import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime, add_to_date


class ITTicket(Document):

    def before_insert(self):
        self.raised_by = self.raised_by or frappe.session.user
        self.raised_date = self.raised_date or now_datetime()
        self._apply_sla()

    def before_save(self):
        if self.status in ("Resolved", "Closed") and not self.resolved_datetime:
            self.resolved_datetime = now_datetime()

    def _apply_sla(self):
        sla = self._get_sla()
        if not sla:
            return
        base = self.raised_date or now_datetime()
        self.due_datetime = add_to_date(base, hours=sla.resolution_time_hours)

    def _get_sla(self):
        filters = {"is_active": 1}
        if self.ticket_type:
            filters["ticket_type"] = self.ticket_type
        if self.priority:
            filters["priority"] = self.priority
        results = frappe.get_all("IT SLA Policy", filters=filters, limit=1)
        if results:
            return frappe.get_doc("IT SLA Policy", results[0].name)
        results = frappe.get_all(
            "IT SLA Policy",
            filters={"is_active": 1, "ticket_type": self.ticket_type or ""},
            limit=1,
        )
        if results:
            return frappe.get_doc("IT SLA Policy", results[0].name)
        return None


@frappe.whitelist()
def update_ticket_status(ticket_name: str, new_status: str, note: str = "") -> dict:
    doc = frappe.get_doc("IT Ticket", ticket_name)
    allowed_transitions = {
        "Open": ["In Progress", "Closed"],
        "In Progress": ["Pending User", "Resolved", "Closed"],
        "Pending User": ["In Progress", "Resolved", "Closed"],
        "Resolved": ["Closed", "Open"],
        "Closed": [],
    }
    if new_status not in allowed_transitions.get(doc.status, []):
        frappe.throw(f"ไม่สามารถเปลี่ยนสถานะจาก {doc.status} เป็น {new_status} ได้")

    doc.status = new_status
    if note:
        doc.resolution_note = (doc.resolution_note or "") + f"\n\n[{now_datetime()}] {note}"
    if new_status in ("Resolved", "Closed"):
        doc.resolved_datetime = now_datetime()
    if new_status == "In Progress" and not doc.response_datetime:
        doc.response_datetime = now_datetime()
    doc.save(ignore_permissions=True)
    return {"status": new_status}


@frappe.whitelist()
def get_my_tickets() -> list:
    user = frappe.session.user
    return frappe.get_all(
        "IT Ticket",
        filters={"raised_by": user},
        fields=["name", "subject", "ticket_type", "priority", "status", "raised_date", "due_datetime"],
        order_by="raised_date desc",
        limit=50,
    )
