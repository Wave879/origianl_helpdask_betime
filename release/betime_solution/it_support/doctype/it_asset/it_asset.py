import frappe
from frappe.model.document import Document


class ITAsset(Document):

    def validate(self):
        if self.warranty_expiry:
            from frappe.utils import getdate, today
            if getdate(self.warranty_expiry) < getdate(today()):
                self.condition = self.condition or "Fair"


@frappe.whitelist()
def get_assets_expiring_soon(days: int = 30) -> list:
    from frappe.utils import add_days, today
    cutoff = add_days(today(), int(days))
    return frappe.get_all(
        "IT Asset",
        filters={
            "status": "Active",
            "warranty_expiry": ["<=", cutoff],
        },
        fields=["name", "asset_name", "asset_type", "assigned_user", "warranty_expiry"],
        order_by="warranty_expiry asc",
    )
