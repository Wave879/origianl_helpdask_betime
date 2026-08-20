import frappe
from frappe.utils import today, add_months, get_first_day, get_last_day

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/betime/login"
        raise frappe.Redirect

    user = frappe.session.user
    full_name = frappe.db.get_value("User", user, "full_name") or user

    # My tasks
    my_tasks = frappe.get_all(
        "Smart Task", filters={"assigned_to": user, "status": ["!=", "Completed"]},
        fields=["name", "task_name", "deadline", "priority", "status", "project"],
        order_by="deadline asc", limit=20,
    )
    done_tasks = frappe.db.count("Smart Task", {"assigned_to": user, "status": "Completed"})
    overdue = [t for t in my_tasks if t.deadline and t.deadline < today()]

    # OT this month
    first_day = get_first_day(today())
    last_day = get_last_day(today())
    ot_hours = frappe.db.get_value(
        "OT Claim", {"employee": user, "ot_date": ["between", [first_day, last_day]], "docstatus": ["!=", 2]},
        "sum(ot_hours)",
    ) or 0

    # My projects
    my_projects = frappe.get_all(
        "Project Master", filters={"status": "Active"},
        fields=["name", "project_name", "progress", "risk_level", "deadline"],
        limit=10,
    )

    # Task completion trend (last 6 months)
    trend = []
    for i in range(5, -1, -1):
        m_date = add_months(today(), -i)
        m_first = get_first_day(m_date)
        m_last = get_last_day(m_date)
        cnt = frappe.db.count(
            "Smart Task",
            {"assigned_to": user, "status": "Completed", "modified": ["between", [m_first, m_last]]},
        )
        trend.append({"month": frappe.utils.formatdate(m_first, "MMM"), "count": cnt})

    context.update({
        "title": "Personal KPIs",
        "user": user,
        "full_name": full_name,
        "my_tasks": my_tasks,
        "tasks_total": len(my_tasks),
        "tasks_overdue": len(overdue),
        "tasks_done": done_tasks,
        "ot_hours": round(float(ot_hours), 1),
        "my_projects": my_projects,
        "trend": trend,
    })
