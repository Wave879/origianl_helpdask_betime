import frappe

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/betime/login"
        raise frappe.Redirect

    user = frappe.session.user
    from betime_solution.api.dashboard import get_staff_summary
    data = get_staff_summary()

    context.update({
        "title": "Staff Dashboard",
        "data": data,
        "user": user,
        "full_name": frappe.db.get_value("User", user, "full_name") or user,
    })
