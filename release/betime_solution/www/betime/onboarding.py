import frappe
from frappe.utils import today

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/betime/login"
        raise frappe.Redirect

    user = frappe.session.user
    emp = frappe.get_all("Employee Profile", filters={"user": user}, fields=["name", "department", "position"], limit=1)
    is_complete = bool(emp and emp[0].department and emp[0].position)

    context.update({
        "title": "ยินดีต้อนรับสู่ Betime Solution",
        "user": user,
        "full_name": frappe.db.get_value("User", user, "full_name") or user,
        "is_complete": is_complete,
        "employee": emp[0] if emp else None,
        "user_roles": frappe.get_roles(user),
    })
