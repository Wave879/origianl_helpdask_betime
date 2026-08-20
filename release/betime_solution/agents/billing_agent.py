"""
Billing Agent — Finance automation:
  - Detect milestone completion → trigger billing alerts
  - Daily overdue invoice check
"""

import frappe
from frappe.utils import today, date_diff


def check_milestone_billing(doc, method):
    """Hook: triggered on Project Master update. Alerts Finance when progress hits 100%."""
    if doc.progress == 100 and doc.billing_status not in ("Paid", "Invoiced"):
        msg = (
            f"โครงการ {doc.project_name} ความคืบหน้า 100% แล้ว "
            f"กรุณาออกใบแจ้งหนี้"
        )
        _alert_finance_and_ceo(msg)


def check_overdue_invoices():
    """Scheduler: find overdue invoices and alert Finance team."""
    overdue = frappe.get_list(
        "Invoice Tracking",
        filters={
            "status": ["in", ["Sent", "Partial"]],
            "due_date": ["<", today()],
        },
        fields=["name", "invoice_no", "project", "total_amount", "due_date"],
        limit_page_length=50,
    )
    for inv in overdue:
        # Mark as overdue
        frappe.db.set_value("Invoice Tracking", inv.name, "status", "Overdue",
                            update_modified=False)
        days_overdue = date_diff(today(), inv.due_date)
        msg = (
            f"Invoice {inv.invoice_no} โครงการ {inv.project} "
            f"เลยกำหนดชำระ {days_overdue} วัน "
            f"มูลค่า {inv.total_amount:,.0f} บาท"
        )
        _alert_finance_and_ceo(msg)
    if overdue:
        frappe.db.commit()


def _alert_finance_and_ceo(message: str):
    recipients = frappe.db.sql_list(
        """SELECT DISTINCT u.name FROM tabUser u
           JOIN `tabHas Role` r ON r.parent = u.name
           WHERE r.role IN ('BT CEO', 'BT Finance') AND u.enabled = 1"""
    )
    for user in recipients:
        frappe.publish_realtime("betime_billing_alert", {"message": message}, user=user)
