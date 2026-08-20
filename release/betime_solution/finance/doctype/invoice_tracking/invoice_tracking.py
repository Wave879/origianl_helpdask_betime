import frappe
from frappe.model.document import Document
from frappe.utils import today, date_diff


class InvoiceTracking(Document):

    def before_save(self):
        self._calculate_total()
        self._check_overdue()

    # ------------------------------------------------------------------

    def _calculate_total(self):
        self.total_amount = (self.amount or 0) + (self.vat_amount or 0)

    def _check_overdue(self):
        import datetime
        if self.due_date and self.status not in ("Paid", "Cancelled"):
            if isinstance(self.due_date, datetime.date) and self.due_date < datetime.date.today():
                self.status = "Overdue"


@frappe.whitelist()
def send_billing_alert(invoice_name: str) -> dict:
    """Send a billing alert notification for an invoice."""
    from betime_solution.utils.security import assert_role
    assert_role("BT Finance", "BT Admin", "System Manager")

    doc = frappe.get_doc("Invoice Tracking", invoice_name)
    project_name = frappe.db.get_value("Project Master", doc.project, "project_name") or doc.project
    message = (
        f"แจ้งเตือนการวางบิล: โครงการ {project_name} | "
        f"Invoice {doc.invoice_no} | Milestone: {doc.milestone} | "
        f"มูลค่า: {doc.total_amount:,.2f} บาท | ครบกำหนด: {doc.due_date}"
    )
    # Notify Finance + CEO
    recipients = frappe.db.sql_list(
        """SELECT DISTINCT u.name FROM tabUser u
           JOIN `tabHas Role` r ON r.parent = u.name
           WHERE r.role IN ('BT CEO', 'BT Finance') AND u.enabled = 1"""
    )
    for user in recipients:
        frappe.publish_realtime("betime_billing_alert", {"message": message}, user=user)

    doc.billing_alert_sent = 1
    doc.save(ignore_permissions=True)
    return {"status": "sent", "recipients": len(recipients)}


@frappe.whitelist()
def get_outstanding_invoices() -> list:
    """Return all non-paid invoices for Finance dashboard."""
    from betime_solution.utils.security import assert_role
    assert_role("BT Finance", "BT CEO", "BT Admin", "System Manager")

    return frappe.get_list(
        "Invoice Tracking",
        filters={"status": ["in", ["Draft", "Sent", "Partial", "Overdue"]]},
        fields=["name", "invoice_no", "project", "milestone", "amount",
                "total_amount", "due_date", "status"],
        order_by="due_date asc",
        limit_page_length=100,
    )
