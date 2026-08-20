import frappe

def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login?redirect-to=/betime/help-desk"
        raise frappe.Redirect
    context.title = "Help Desk AI — Betime"
    context.no_cache = 1
    context.user_name = frappe.db.get_value("User", frappe.session.user, "full_name")
    context.suggested_questions = [
        "TOR โครงการ A ขาดเอกสารอะไรบ้าง?",
        "วิธีแก้ปัญหา Subcontractor ส่งงานล่าช้า",
        "ขั้นตอนการวางบิล Milestone คืออะไร?",
        "Lesson Learned เรื่อง Safety มีอะไรบ้าง?",
        "สรุปมติประชุมสัปดาห์ที่แล้ว",
    ]
