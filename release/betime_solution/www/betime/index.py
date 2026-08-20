import frappe

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime"
        raise frappe.Redirect

    user = frappe.session.user
    roles = set(frappe.get_roles(user))
    context.user_name = frappe.db.get_value("User", user, "full_name") or user
    context.roles = list(roles)
    context.is_ceo   = bool({"BT CEO", "System Manager"} & roles)
    context.is_admin = bool({"BT Admin", "System Manager"} & roles)
    context.title = "Betime Solution Portal"
    context.no_cache = 1
