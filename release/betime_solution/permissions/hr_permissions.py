"""Row-level security for HR DocTypes (Employee Profile)."""

import frappe


def get_permission_query_conditions(user: str = None) -> str:
    user = user or frappe.session.user
    if user == "Administrator":
        return ""
    roles = set(frappe.get_roles(user))
    if {"BT CEO", "BT Admin", "BT HR", "BT Manager", "System Manager"} & roles:
        return ""
    # Staff see only their own profile
    return f"`tabEmployee Profile`.`user` = '{frappe.db.escape(user)}'"


def has_permission(doc, ptype: str = "read", user: str = None) -> bool:
    user = user or frappe.session.user
    if user == "Administrator":
        return True
    roles = set(frappe.get_roles(user))
    if {"BT CEO", "BT Admin", "BT HR", "BT Manager", "System Manager"} & roles:
        return True
    # Staff can only see their own Employee Profile
    return doc.user == user
