import frappe
from frappe.model.document import Document
from frappe.utils import get_datetime


class SmartCalendar(Document):

    def before_save(self):
        self._validate_datetime_range()
        self._auto_calculate_food_sets()

    def validate(self):
        self._validate_datetime_range()

    # ------------------------------------------------------------------

    def _validate_datetime_range(self):
        if self.start_datetime and self.end_datetime:
            if get_datetime(self.end_datetime) <= get_datetime(self.start_datetime):
                frappe.throw("เวลาสิ้นสุดต้องมากกว่าเวลาเริ่มต้น")

    def _auto_calculate_food_sets(self):
        """Auto-set food_sets = attendee_count when food is required."""
        if self.food_required and self.attendee_count and not self.food_sets:
            self.food_sets = self.attendee_count


@frappe.whitelist()
def check_room_conflict(room: str, start_datetime: str, end_datetime: str,
                        exclude_name: str = None) -> list:
    """
    Check for room booking conflicts.
    Returns list of conflicting events.
    """
    if not room:
        return []
    filters = {
        "room": room,
        "status": ["not in", ["Cancelled"]],
        "start_datetime": ["<", end_datetime],
        "end_datetime": [">", start_datetime],
    }
    if exclude_name:
        filters["name"] = ["!=", exclude_name]
    return frappe.get_list(
        "Smart Calendar",
        filters=filters,
        fields=["name", "event_name", "start_datetime", "end_datetime", "status"],
    )


@frappe.whitelist()
def get_calendar_events(start: str, end: str, project: str = None) -> list:
    """Return events for the calendar view between start and end dates."""
    filters = {
        "start_datetime": [">=", start],
        "end_datetime": ["<=", end],
        "status": ["!=", "Cancelled"],
    }
    if project:
        filters["project"] = project

    from betime_solution.utils.security import get_user_role_level
    if get_user_role_level() == "staff":
        filters["owner"] = frappe.session.user

    return frappe.get_list(
        "Smart Calendar",
        filters=filters,
        fields=["name", "event_name", "event_type", "start_datetime", "end_datetime",
                "status", "location", "project", "conflict_detected"],
        order_by="start_datetime asc",
    )
