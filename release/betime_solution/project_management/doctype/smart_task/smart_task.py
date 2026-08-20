import frappe
from frappe.model.document import Document
from frappe.utils import today, date_diff


class SmartTask(Document):

    def validate(self):
        self._check_deadline_not_past()

    def on_update(self):
        if self.status == "Completed" and not self.completion_date:
            self.completion_date = today()
            self.db_set("completion_date", self.completion_date, update_modified=False)
        self._update_project_progress()

    # ------------------------------------------------------------------

    def _check_deadline_not_past(self):
        import datetime
        if self.deadline and isinstance(self.deadline, datetime.date):
            days_left = date_diff(self.deadline, today())
            if days_left < 0 and self.status not in ("Completed", "Cancelled"):
                frappe.msgprint(
                    f"งาน '{self.task_name}' เลยกำหนดส่งแล้ว {abs(days_left)} วัน",
                    indicator="red",
                )

    def _update_project_progress(self):
        """Recalculate parent project progress based on completed tasks."""
        if not self.project:
            return
        total = frappe.db.count("Smart Task", {"project": self.project, "status": ["!=", "Cancelled"]})
        done = frappe.db.count("Smart Task", {"project": self.project, "status": "Completed"})
        if total:
            progress = round((done / total) * 100)
            frappe.db.set_value("Project Master", self.project, "progress", progress, update_modified=False)


@frappe.whitelist()
def get_my_tasks(user: str = None) -> list:
    """Return open tasks for the given user (defaults to current user)."""
    user = user or frappe.session.user
    return frappe.get_list(
        "Smart Task",
        filters={"assigned_to": user, "status": ["not in", ["Completed", "Cancelled"]]},
        fields=["name", "task_name", "project", "deadline", "priority", "status", "linked_phase"],
        order_by="deadline asc",
    )


@frappe.whitelist()
def bulk_create_tasks(tasks_json: str) -> list:
    """
    Create multiple Smart Tasks at once from a JSON list.
    Used by MOM Agent to auto-create tasks from decisions.
    tasks_json: JSON array of {task_name, project, assigned_to, deadline, linked_mom, description}
    """
    import json
    tasks_data = json.loads(tasks_json)
    created = []
    for t in tasks_data:
        doc = frappe.new_doc("Smart Task")
        doc.update(t)
        doc.auto_created = 1
        doc.insert(ignore_permissions=True)
        created.append(doc.name)
    frappe.db.commit()
    return created
