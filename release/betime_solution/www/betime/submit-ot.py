import frappe

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime/submit-ot"
        raise frappe.Redirect
    context.title = "Submit OT — Betime"
    context.no_cache = 1
    user = frappe.session.user
    context.user_name = frappe.db.get_value("User", user, "full_name") or user
    context.employee = frappe.db.get_value("Employee Profile", {"user": user, "is_active": 1}, "name")
    context.employee_name = frappe.db.get_value("Employee Profile", {"user": user}, "full_name") or context.user_name
    context.projects = frappe.get_list("Project Master",
        filters={"status": "Active"},
        fields=["name", "project_name"],
        limit_page_length=100,
    )
