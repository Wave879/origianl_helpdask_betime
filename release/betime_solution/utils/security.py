"""
Row-level security helpers.
ALWAYS use secure_get_list() instead of frappe.get_list() directly.
Enforces owner-based data segregation per role.
"""

import frappe


def get_user_role_level() -> str:
    """Return the effective permission tier for the current user."""
    user = frappe.session.user
    if user == "Administrator":
        return "admin"
    roles = frappe.get_roles(user)
    if "BT CEO" in roles or "BT Admin" in roles:
        return "ceo"
    if "BT Manager" in roles or "BT Finance" in roles or "BT Compliance" in roles or "BT HR" in roles:
        return "manager"
    return "staff"


def get_owner_filter(doctype: str = None) -> dict:
    """
    Return an owner filter dict for the current user.
    CEO / Admin get no restriction. Staff are restricted to owner = current_user.
    """
    level = get_user_role_level()
    if level in ("ceo", "admin"):
        return {}
    if level == "manager":
        # Managers see their department's data — department join handled per doctype
        return {}
    # Staff: own records only
    return {"owner": frappe.session.user}


def secure_get_list(doctype: str, filters: dict = None, fields=None,
                    order_by: str = "modified desc", limit_page_length: int = 20,
                    as_list: bool = False):
    """
    Secure replacement for frappe.get_list().
    Automatically injects row-level security filters.
    """
    filters = filters or {}
    owner_filter = get_owner_filter(doctype)
    filters.update(owner_filter)

    return frappe.get_list(
        doctype,
        filters=filters,
        fields=fields or ["name", "owner", "modified"],
        order_by=order_by,
        limit_page_length=limit_page_length,
        as_list=as_list,
    )


def secure_get_doc(doctype: str, name: str):
    """
    Secure replacement for frappe.get_doc().
    Raises PermissionError if the user does not own the record (staff level).
    """
    doc = frappe.get_doc(doctype, name)
    level = get_user_role_level()
    if level == "staff" and doc.owner != frappe.session.user:
        frappe.throw(
            f"คุณไม่มีสิทธิ์เข้าถึงข้อมูลนี้ (Access denied to {doctype}: {name})",
            frappe.PermissionError,
        )
    return doc


def assert_role(*roles: str):
    """Raise PermissionError if current user does not have any of the given roles."""
    user_roles = set(frappe.get_roles(frappe.session.user))
    if not user_roles.intersection(set(roles)) and "Administrator" not in user_roles:
        frappe.throw("คุณไม่มีสิทธิ์ดำเนินการนี้", frappe.PermissionError)


def is_ceo_or_admin() -> bool:
    return get_user_role_level() in ("ceo", "admin")
