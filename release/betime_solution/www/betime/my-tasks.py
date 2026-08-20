import frappe

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime/my-tasks"
        raise frappe.Redirect

    user = frappe.session.user
    context.title = "My Workspace — Betime"
    context.no_cache = 1
    context.user_name = frappe.db.get_value("User", user, "full_name") or user

    # My open tasks
    context.my_tasks = frappe.get_list(
        "Smart Task",
        filters={"assigned_to": user, "status": ["not in", ["Completed", "Cancelled"]]},
        fields=["name", "task_name", "project", "deadline", "priority", "status", "linked_phase"],
        order_by="deadline asc",
        limit_page_length=50,
    )

    # Today's calendar events
    from frappe.utils import today, add_days
    tomorrow = add_days(today(), 1)
    context.today_events = frappe.get_list(
        "Smart Calendar",
        filters={
            "start_datetime": ["between", [today() + " 00:00:00", today() + " 23:59:59"]],
            "status": ["!=", "Cancelled"],
        },
        fields=["name", "event_name", "start_datetime", "end_datetime", "location", "room"],
        order_by="start_datetime asc",
        limit_page_length=10,
    )

    # My OT pending
    employee_name = frappe.db.get_value("Employee Profile", {"user": user}, "name")
    context.my_ot = frappe.get_list(
        "OT Claim",
        filters={"employee": employee_name or "", "status": ["in", ["Draft", "Submitted"]]},
        fields=["name", "date", "ot_hours", "status", "reason"],
        order_by="date desc",
        limit_page_length=10,
    ) if employee_name else []

    context.priority_color = {"Low": "green", "Medium": "orange", "High": "red", "Urgent": "red"}
    context.status_color = {"Open": "orange", "In Progress": "blue", "Blocked": "red"}
