"""
Calendar Agent — Smart Secretary logic:
  - Conflict detection for rooms / vehicles
  - Resource planning (food sets, projectors)
  - Daily reminders
  - Auto-reschedule suggestions
"""

import frappe
from frappe.utils import get_datetime, now_datetime, add_to_date, format_datetime


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------

def check_conflicts(doc, method):
    """Before-save hook: detect room and vehicle conflicts."""
    conflicts = []

    if doc.room:
        room_conflicts = _find_conflicts(
            field="room", value=doc.room,
            start=doc.start_datetime, end=doc.end_datetime,
            exclude=doc.name,
        )
        conflicts.extend(room_conflicts)

    if doc.vehicle:
        vehicle_conflicts = _find_conflicts(
            field="vehicle", value=doc.vehicle,
            start=doc.start_datetime, end=doc.end_datetime,
            exclude=doc.name,
        )
        conflicts.extend(vehicle_conflicts)

    if conflicts:
        doc.conflict_detected = 1
        names = ", ".join(c.event_name for c in conflicts)
        doc.ai_suggestions = (
            f"⚠ พบ Conflict กับกิจกรรม: {names}\n"
            f"กรุณาเลือกห้อง/ยานพาหนะอื่น หรือเปลี่ยนเวลา"
        )
        frappe.msgprint(
            f"พบ Conflict กับกิจกรรม: {names}",
            indicator="orange",
            alert=True,
        )
    else:
        doc.conflict_detected = 0


def plan_resources(doc, method):
    """After-save hook: auto-calculate food sets based on attendee count."""
    if doc.food_required and doc.attendee_count and not doc.food_sets:
        doc.db_set("food_sets", doc.attendee_count, update_modified=False)


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

def send_daily_reminders():
    """Send reminder notifications for tomorrow's events."""
    tomorrow_start = add_to_date(now_datetime(), days=1).replace(hour=0, minute=0, second=0)
    tomorrow_end = tomorrow_start.replace(hour=23, minute=59, second=59)

    events = frappe.get_list(
        "Smart Calendar",
        filters={
            "start_datetime": ["between", [tomorrow_start, tomorrow_end]],
            "status": ["in", ["Scheduled", "Confirmed"]],
        },
        fields=["name", "event_name", "start_datetime", "location", "room",
                "attendees", "project", "owner"],
    )

    for event in events:
        _send_event_reminder(event)


def _send_event_reminder(event):
    """Push in-app notification for an upcoming event."""
    msg = (
        f"📅 พรุ่งนี้: {event.event_name} "
        f"เวลา {format_datetime(event.start_datetime, 'HH:mm')} น. "
        f"{'@ ' + event.location if event.location else ''}"
    )
    # Notify event owner
    frappe.publish_realtime("betime_calendar_reminder", {"message": msg}, user=event.owner)

    # Also notify attendees listed
    if event.attendees:
        for user_email in [a.strip() for a in event.attendees.split(",")]:
            user = frappe.db.get_value("User", {"email": user_email}, "name")
            if user:
                frappe.publish_realtime("betime_calendar_reminder",
                                        {"message": msg}, user=user)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_conflicts(field: str, value: str, start, end, exclude: str = None) -> list:
    """
    Find Smart Calendar events that overlap [start, end] for a given resource.
    Overlap condition: existing.start < new.end AND existing.end > new.start
    """
    filters = {
        field: value,
        "status": ["not in", ["Cancelled"]],
        "start_datetime": ["<", end],
        "end_datetime": [">", start],
    }
    if exclude:
        filters["name"] = ["!=", exclude]

    return frappe.get_list(
        "Smart Calendar",
        filters=filters,
        fields=["name", "event_name", "start_datetime", "end_datetime"],
    )


@frappe.whitelist()
def suggest_reschedule(event_name: str) -> dict:
    """
    Use Azure OpenAI to suggest alternative timeslots for a conflicting event.
    """
    doc = frappe.get_doc("Smart Calendar", event_name)
    if not doc.conflict_detected:
        return {"suggestion": "ไม่มี Conflict"}

    # Find free slots in next 5 business days
    from betime_solution.utils.azure_ai import chat_completion

    # Build context: existing events that day
    day_events = frappe.get_list(
        "Smart Calendar",
        filters={
            "start_datetime": [">=", doc.start_datetime],
            "status": ["!=", "Cancelled"],
            "name": ["!=", event_name],
        },
        fields=["event_name", "start_datetime", "end_datetime", "room"],
        order_by="start_datetime asc",
        limit_page_length=10,
    )
    context = "\n".join(
        f"- {e.event_name}: {e.start_datetime} ถึง {e.end_datetime} (ห้อง: {e.room or '-'})"
        for e in day_events
    )

    prompt = (
        f"กิจกรรม '{doc.event_name}' มี Conflict\n"
        f"ห้องที่ต้องการ: {doc.room or '-'}\n"
        f"กิจกรรมอื่นในวันนั้น:\n{context}\n\n"
        f"แนะนำเวลาที่เหมาะสม 2-3 ตัวเลือก (ตอบสั้นๆ ภาษาไทย)"
    )
    suggestion = chat_completion(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.5,
        max_tokens=300,
    )
    return {"suggestion": suggestion}
