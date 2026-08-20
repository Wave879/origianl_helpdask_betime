import frappe
from betime_solution.utils.security import assert_role

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/betime/login"
        raise frappe.Redirect

    assert_role("BT Manager", "BT CEO", "BT Admin", "Administrator")

    user = frappe.session.user
    from betime_solution.api.dashboard import get_manager_summary
    data = get_manager_summary()

    context.update({
        "title": "Manager Dashboard",
        "data": data,
        "user": user,
        "full_name": frappe.db.get_value("User", user, "full_name") or user,
    })
