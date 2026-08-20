import frappe
from frappe.model.document import Document


class EmployeeProfile(Document):

    def validate(self):
        self._sync_email_from_user()

    def _sync_email_from_user(self):
        if self.user and not self.email:
            self.email = frappe.db.get_value("User", self.user, "email")
        if self.user and not self.full_name:
            self.full_name = frappe.db.get_value("User", self.user, "full_name")


@frappe.whitelist()
def get_employee_by_user(user: str = None) -> dict:
    """Return the Employee Profile for a given user (defaults to current user)."""
    user = user or frappe.session.user
    name = frappe.db.get_value("Employee Profile", {"user": user, "is_active": 1}, "name")
    if not name:
        return {}
    return frappe.get_doc("Employee Profile", name).as_dict()


@frappe.whitelist()
def get_workload_summary(employee: str) -> dict:
    """Return open task count and upcoming meetings for an employee."""
    user = frappe.db.get_value("Employee Profile", employee, "user")
    if not user:
        return {}
    open_tasks = frappe.db.count("Smart Task", {"assigned_to": user,
                                                 "status": ["not in", ["Completed", "Cancelled"]]})
    from frappe.utils import now
    upcoming_meetings = frappe.db.count("Smart Calendar", {
        "attendees": ["like", f"%{user}%"],
        "start_datetime": [">=", now()],
        "status": ["!=", "Cancelled"],
    })
    return {"open_tasks": open_tasks, "upcoming_meetings": upcoming_meetings}
