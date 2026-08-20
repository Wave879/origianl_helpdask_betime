"""Finance Agent — OT automation and notifications."""

import frappe


def notify_ot_submitted(doc, method):
    """Hook: notify manager when OT Claim is submitted."""
    managers = frappe.db.sql_list(
        """SELECT DISTINCT u.name FROM tabUser u
           JOIN `tabHas Role` r ON r.parent = u.name
           WHERE r.role IN ('BT Manager', 'BT Finance') AND u.enabled = 1"""
    )
    msg = (
        f"OT Claim ใหม่: {doc.employee_name} "
        f"วันที่ {doc.date} จำนวน {doc.ot_hours} ชั่วโมง "
        f"รออนุมัติ"
    )
    for user in managers:
        frappe.publish_realtime("betime_ot_alert", {"message": msg}, user=user)


@frappe.whitelist()
def auto_create_ot_from_calendar(calendar_name: str) -> dict:
    """
    Auto-generate an OT Claim from a Smart Calendar event.
    Calculates OT hours from event duration outside business hours.
    """
    event = frappe.get_doc("Smart Calendar", calendar_name)

    user = frappe.session.user
    roles = set(frappe.get_roles(user))
    privileged_roles = {"BT CEO", "BT Admin", "BT Manager", "BT Finance", "System Manager"}
    if user != event.owner and not roles.intersection(privileged_roles):
        frappe.throw("คุณไม่มีสิทธิ์สร้าง OT จากกิจกรรมนี้", frappe.PermissionError)

    from frappe.utils import get_datetime, time_diff_in_hours

    start = get_datetime(event.start_datetime)
    end = get_datetime(event.end_datetime)
    total_hours = time_diff_in_hours(end, start)

    # Simple rule: hours after 18:00 count as OT
    ot_hours = max(0, min(total_hours, (end.hour + end.minute / 60) - 18))

    if ot_hours <= 0:
        return {"message": "ไม่มี OT (กิจกรรมอยู่ในเวลาทำงานปกติ)"}

    ot = frappe.new_doc("OT Claim")
    ot.employee = frappe.db.get_value("Employee Profile",
                                      {"user": event.owner}, "name")
    if not ot.employee:
        return {"message": "ไม่พบข้อมูลพนักงาน"}

    ot.date = event.start_datetime
    ot.ot_hours = round(ot_hours, 2)
    ot.reason = f"กิจกรรม: {event.event_name}"
    ot.linked_calendar = calendar_name
    ot.project = event.project
    ot.auto_created = 1
    ot.insert(ignore_permissions=True)
    frappe.db.commit()
    return {"ot_claim": ot.name, "ot_hours": ot.ot_hours}
