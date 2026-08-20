import frappe
from frappe.model.document import Document
from frappe.utils import today


class OTClaim(Document):

    def validate(self):
        self._calculate_amount()

    def on_submit(self):
        self.status = "Submitted"
        self.db_set("status", "Submitted")

    def on_cancel(self):
        self.status = "Draft"
        self.db_set("status", "Draft")

    # ------------------------------------------------------------------

    def _calculate_amount(self):
        if self.ot_hours and self.ot_rate:
            self.amount = self.ot_hours * self.ot_rate


@frappe.whitelist()
def approve_ot(claim_name: str) -> dict:
    """Approve an OT Claim. Requires BT Manager or BT Finance role."""
    from betime_solution.utils.security import assert_role
    assert_role("BT Manager", "BT Finance", "BT Admin", "System Manager")

    doc = frappe.get_doc("OT Claim", claim_name)
    if doc.status not in ("Submitted",):
        frappe.throw(f"ไม่สามารถอนุมัติ OT ที่มีสถานะ: {doc.status}")

    doc.status = "Approved"
    doc.approved_by = frappe.session.user
    doc.approval_date = today()
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return {"status": "approved", "name": claim_name}


@frappe.whitelist()
def reject_ot(claim_name: str, reason: str) -> dict:
    """Reject an OT Claim with a reason."""
    from betime_solution.utils.security import assert_role
    assert_role("BT Manager", "BT Finance", "BT Admin", "System Manager")

    doc = frappe.get_doc("OT Claim", claim_name)
    doc.status = "Rejected"
    doc.approved_by = frappe.session.user
    doc.approval_date = today()
    doc.rejection_reason = reason
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return {"status": "rejected", "name": claim_name}


@frappe.whitelist()
def get_ot_summary(month: str, year: str) -> list:
    """Return monthly OT summary per employee for Finance export."""
    from betime_solution.utils.security import assert_role
    assert_role("BT Finance", "BT Manager", "BT CEO", "BT Admin", "System Manager")

    return frappe.db.sql(
        """SELECT employee, employee_name,
                  SUM(ot_hours) AS total_hours,
                  SUM(amount) AS total_amount,
                  COUNT(name) AS claim_count
           FROM `tabOT Claim`
           WHERE MONTH(date) = %s AND YEAR(date) = %s
             AND status = 'Approved'
           GROUP BY employee, employee_name
           ORDER BY total_amount DESC""",
        (month, year),
        as_dict=True,
    )
