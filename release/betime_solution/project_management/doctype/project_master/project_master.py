import frappe
from frappe.model.document import Document
from betime_solution.utils.security import secure_get_list, get_user_role_level


class ProjectMaster(Document):

    def before_save(self):
        self._calculate_budget_used()
        self._auto_update_status()

    def on_update(self):
        if self.progress == 100 and self.status != "Completed":
            self._notify_project_complete()

    # ------------------------------------------------------------------

    def _calculate_budget_used(self):
        result = frappe.db.sql(
            """SELECT COALESCE(SUM(amount), 0) FROM `tabInvoice Tracking`
               WHERE project = %s AND docstatus < 2""",
            self.name,
        )
        self.budget_used = result[0][0] if result else 0

    def _auto_update_status(self):
        import datetime
        if self.end_date and isinstance(self.end_date, datetime.date):
            if self.end_date < datetime.date.today() and self.status == "Active":
                # Progress-based: if still active past end date flag it
                pass  # Let PM decide — do not auto-close

    def _notify_project_complete(self):
        message = f"โครงการ {self.project_name} ความคืบหน้าครบ 100% แล้ว"
        _notify_ceo_and_finance(self.name, message)


@frappe.whitelist()
def get_project_dashboard(project: str) -> dict:
    """Return summary data for the CEO/PM dashboard card."""
    from betime_solution.utils.security import secure_get_doc
    doc = secure_get_doc("Project Master", project)

    tasks = frappe.db.count("Smart Task", {"project": project, "status": ["!=", "Cancelled"]})
    open_tasks = frappe.db.count("Smart Task", {"project": project, "status": "Open"})
    moms = frappe.db.count("Meeting MOM", {"project": project})

    return {
        "project_name": doc.project_name,
        "status": doc.status,
        "progress": doc.progress,
        "current_phase": doc.current_phase,
        "risk_level": doc.risk_level,
        "budget": doc.budget,
        "budget_used": doc.budget_used,
        "total_tasks": tasks,
        "open_tasks": open_tasks,
        "total_moms": moms,
        "billing_status": doc.billing_status,
    }


def _notify_ceo_and_finance(project: str, message: str):
    """Send in-app notification to CEO and Finance roles."""
    recipients = frappe.db.sql_list(
        """SELECT DISTINCT u.name FROM tabUser u
           JOIN `tabHas Role` r ON r.parent = u.name
           WHERE r.role IN ('BT CEO', 'BT Finance') AND u.enabled = 1"""
    )
    for user in recipients:
        frappe.publish_realtime("betime_alert", {"message": message}, user=user)
