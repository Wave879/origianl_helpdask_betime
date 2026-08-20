import frappe
from betime_solution.utils.security import assert_role

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime/ceo-dashboard"
        raise frappe.Redirect

    assert_role("BT CEO", "BT Admin", "System Manager")

    context.title = "CEO Dashboard — Betime Solution"
    context.no_cache = 1
    context.user_name = frappe.db.get_value("User", frappe.session.user, "full_name")
