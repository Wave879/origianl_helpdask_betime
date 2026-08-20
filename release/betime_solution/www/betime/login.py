import frappe

no_cache = 1


def get_context(context):
    # If already logged in, route to appropriate dashboard
    if frappe.session.user != "Guest":
        roles = set(frappe.get_roles(frappe.session.user))
        if "BT CEO" in roles or "Administrator" in roles:
            frappe.local.flags.redirect_location = "/betime/ceo-dashboard"
        elif "BT Manager" in roles:
            frappe.local.flags.redirect_location = "/betime/manager-dashboard"
        else:
            frappe.local.flags.redirect_location = "/betime/staff-dashboard"
        raise frappe.Redirect

    context.update({
        "title": "เข้าสู่ระบบ Betime Solution",
        "microsoft_login_url": _get_microsoft_login_url(),
        "site_name": frappe.local.site,
    })


def _get_microsoft_login_url():
    client_id = frappe.conf.get("microsoft_oauth_client_id", "")
    if not client_id:
        return ""
    tenant = frappe.conf.get("microsoft_tenant_id", "common")
    redirect = frappe.utils.get_url("/api/method/frappe.integrations.oauth2_logins.login_via_microsoft")
    import urllib.parse
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect,
        "scope": "openid email profile User.Read",
        "response_mode": "query",
    }
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?{urllib.parse.urlencode(params)}"
