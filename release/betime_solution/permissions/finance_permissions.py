"""Row-level security for Finance DocTypes (OT Claim, Invoice Tracking)."""

import frappe


def get_permission_query_conditions(user: str = None) -> str:
    user = user or frappe.session.user
    if user == "Administrator":
        return ""
    roles = set(frappe.get_roles(user))
    if {"BT CEO", "BT Admin", "BT Finance", "System Manager"} & roles:
        return ""
    if {"BT Manager"} & roles:
        return ""
    return f"`tabOT Claim`.`owner` = '{frappe.db.escape(user)}'"


def has_permission(doc, ptype: str = "read", user: str = None) -> bool:
    user = user or frappe.session.user
    if user == "Administrator":
        return True
    roles = set(frappe.get_roles(user))
    if {"BT CEO", "BT Admin", "BT Finance", "BT Manager", "System Manager"} & roles:
        return True
    return doc.owner == user
