"""
CEO Dashboard API — aggregate data for the executive view.
All endpoints require BT CEO / BT Admin / System Manager role.
"""

import frappe
from frappe.utils import today, get_first_day, get_last_day, date_diff
from betime_solution.utils.security import assert_role


@frappe.whitelist()
def get_ceo_summary() -> dict:
    """Return all KPIs and table data for the CEO Dashboard in one call."""
    assert_role("BT CEO", "BT Admin", "System Manager")

    today_str = today()
    month_start = str(get_first_day(today_str))
    month_end   = str(get_last_day(today_str))

    # --- Projects ---
    total_projects = frappe.db.count("Project Master")
    active_projects = frappe.db.count("Project Master", {"status": "Active"})
    project_status_counts = _count_by_field("Project Master", "status")

    active_project_list = frappe.get_list(
        "Project Master",
        filters={"status": "Active"},
        fields=["name", "project_name", "status", "current_phase",
                "progress", "risk_level", "billing_status", "end_date"],
        order_by="end_date asc",
        limit_page_length=20,
    )

    # --- Tasks ---
    open_tasks = frappe.db.count("Smart Task", {"status": ["not in", ["Completed", "Cancelled"]]})
    overdue_list = frappe.get_list(
        "Smart Task",
        filters={"deadline": ["<", today_str], "status": ["not in", ["Completed", "Cancelled"]]},
        fields=["name", "task_name", "project", "assigned_to", "deadline", "priority"],
        order_by="deadline asc",
        limit_page_length=20,
    )
    task_priority_counts = _count_by_field(
        "Smart Task", "priority",
        {"status": ["not in", ["Completed", "Cancelled"]]}
    )

    # --- Invoices ---
    outstanding = frappe.get_list(
        "Invoice Tracking",
        filters={"status": ["in", ["Draft", "Sent", "Partial", "Overdue"]]},
        fields=["name", "invoice_no", "project", "milestone", "total_amount", "due_date", "status"],
        order_by="due_date asc",
        limit_page_length=20,
    )
    pending_invoice_amount = frappe.db.sql(
        "SELECT COALESCE(SUM(total_amount),0) FROM `tabInvoice Tracking` "
        "WHERE status IN ('Sent','Partial','Overdue')"
    )[0][0] or 0

    # --- OT ---
    pending_ot = frappe.db.count("OT Claim", {"status": "Submitted"})
    pending_ot_hours = frappe.db.sql(
        "SELECT COALESCE(SUM(ot_hours),0) FROM `tabOT Claim` WHERE status='Submitted'"
    )[0][0] or 0

    # --- MOMs ---
    moms_this_month = frappe.db.count(
        "Meeting MOM", {"meeting_date": ["between", [month_start, month_end]]}
    )
    pending_moms = frappe.db.count("Meeting MOM", {"processing_status": "Pending"})

    # --- Knowledge ---
    knowledge_count = frappe.db.count("AI Knowledge Base", {"is_active": 1})

    return {
        "total_projects":          total_projects,
        "active_projects_count":   active_projects,
        "project_status_counts":   project_status_counts,
        "active_projects":         active_project_list,
        "open_tasks":              open_tasks,
        "overdue_tasks_count":     len(overdue_list),
        "overdue_tasks":           overdue_list,
        "task_priority_counts":    task_priority_counts,
        "pending_invoices":        len(outstanding),
        "pending_invoice_amount":  float(pending_invoice_amount),
        "outstanding_invoices":    outstanding,
        "pending_ot":              pending_ot,
        "pending_ot_hours":        float(pending_ot_hours),
        "moms_this_month":         moms_this_month,
        "pending_moms":            pending_moms,
        "knowledge_count":         knowledge_count,
    }


def _count_by_field(doctype: str, field: str, extra_filters: dict = None) -> dict:
    """Count records grouped by a field value."""
    filters = extra_filters or {}
    rows = frappe.get_all(
        doctype,
        filters=filters,
        fields=[f"`{field}` as value", "count(name) as cnt"],
        group_by=f"`{field}`",
        limit_page_length=0,
    )
    return {r.value: r.cnt for r in rows if r.value}
