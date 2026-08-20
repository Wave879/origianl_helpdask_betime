import frappe

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime/stt-tool"
        raise frappe.Redirect
    context.title = "STT Tool BT — ถอดเสียงประชุม AI"
    context.no_cache = 1
    context.mom_name = frappe.form_dict.get("mom", "")
    context.user_name = frappe.db.get_value("User", frappe.session.user, "full_name")
    # Load project list for linking
    context.projects = frappe.get_list("Project Master",
        filters={"status": "Active"},
        fields=["name", "project_name"],
        limit_page_length=100,
    )
