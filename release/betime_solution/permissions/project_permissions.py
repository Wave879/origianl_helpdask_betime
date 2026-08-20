"""
Row-level security for Project Management DocTypes.
Enforced via hooks.py permission_query_conditions + has_permission.
"""

import frappe
from betime_solution.utils.security import get_user_role_level


def get_permission_query_conditions(user: str = None) -> str:
    """
    Return a SQL WHERE clause fragment injected into every get_list query.
    CEO/Admin: no restriction.
    Manager: see all (managers coordinate across projects).
    Staff: only records they own.
    """
    user = user or frappe.session.user
    if user == "Administrator":
        return ""

    roles = set(frappe.get_roles(user))
    if {"BT CEO", "BT Admin", "System Manager"} & roles:
        return ""
    if {"BT Manager", "BT Finance", "BT Compliance", "BT HR"} & roles:
        return ""
    # Staff: only own records
    return f"`tabProject Master`.`owner` = '{frappe.db.escape(user)}'"


def has_permission(doc, ptype: str = "read", user: str = None) -> bool:
    """
    Fine-grained document-level permission check.
    Called for individual document access.
    """
    user = user or frappe.session.user
    if user == "Administrator":
        return True
    roles = set(frappe.get_roles(user))
    if {"BT CEO", "BT Admin", "System Manager"} & roles:
        return True
    if {"BT Manager"} & roles:
        return True
    # Staff can only access their own records
    return doc.owner == user
