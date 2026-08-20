import frappe

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime/ocr-lab"
        raise frappe.Redirect
    context.title = "OCR Lab — Betime"
    context.no_cache = 1
    context.user_name = frappe.db.get_value("User", frappe.session.user, "full_name")
