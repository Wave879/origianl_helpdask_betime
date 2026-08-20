import frappe

no_cache = 1


def get_context(context):
    frappe.local.flags.ignore_permissions = False
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect

    user = frappe.session.user
    my_tickets = frappe.get_all(
        "IT Ticket",
        filters={"raised_by": user},
        fields=["name", "subject", "ticket_type", "priority", "status", "raised_date", "due_datetime"],
        order_by="raised_date desc",
        limit=20,
    )

    my_assets = frappe.get_all(
        "IT Asset",
        filters={"assigned_user": user, "status": "Active"},
        fields=["name", "asset_name", "asset_type", "brand", "model", "warranty_expiry"],
        order_by="asset_name asc",
    )

    open_count = len([t for t in my_tickets if t.status in ("Open", "In Progress", "Pending User")])

    context.update({
        "my_tickets": my_tickets,
        "my_assets": my_assets,
        "open_count": open_count,
        "user": user,
        "title": "IT Self Service",
    })
