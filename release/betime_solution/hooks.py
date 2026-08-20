app_name = "betime_solution"
app_title = "Betime Solution"
app_publisher = "Betime Solution Co., Ltd."
app_description = "Enterprise PMO + AI Secretary + Finance + Compliance + Knowledge Platform"
app_email = "admin@betime.co.th"
app_license = "MIT"
app_version = "1.0.0"

# Assets
app_include_css = "/assets/betime_solution/css/betime.css"
app_include_js = "/assets/betime_solution/js/betime.js"

# Fixtures — roles and workflows exported/imported with the app
fixtures = [
    {
        "dt": "Role",
        "filters": [["name", "in", [
            "BT CEO", "BT Manager", "BT Staff",
            "BT Finance", "BT Compliance", "BT HR", "BT Admin"
        ]]]
    },
]

# Document event hooks
doc_events = {
    "Meeting MOM": {
        "after_save": "betime_solution.agents.mom_agent.on_mom_save",
    },
    "Smart Calendar": {
        "before_save": "betime_solution.agents.calendar_agent.check_conflicts",
        "after_save": "betime_solution.agents.calendar_agent.plan_resources",
    },
    "Project Master": {
        "on_update": "betime_solution.agents.billing_agent.check_milestone_billing",
    },
    "OT Claim": {
        "on_submit": "betime_solution.agents.finance_agent.notify_ot_submitted",
    },
}

# Scheduled background jobs
scheduler_events = {
    "daily": [
        "betime_solution.agents.billing_agent.check_overdue_invoices",
        "betime_solution.agents.calendar_agent.send_daily_reminders",
    ],
    "hourly": [
        "betime_solution.agents.mom_agent.process_pending_moms",
    ],
    "weekly": [
        "betime_solution.agents.knowledge_agent.sync_sharepoint_knowledge",
    ],
}

# Row-level security — applied to every get_list / get_doc call
permission_query_conditions = {
    "Project Master":    "betime_solution.permissions.project_permissions.get_permission_query_conditions",
    "Meeting MOM":       "betime_solution.permissions.project_permissions.get_permission_query_conditions",
    "Smart Task":        "betime_solution.permissions.project_permissions.get_permission_query_conditions",
    "OT Claim":          "betime_solution.permissions.finance_permissions.get_permission_query_conditions",
    "Invoice Tracking":  "betime_solution.permissions.finance_permissions.get_permission_query_conditions",
    "Employee Profile":  "betime_solution.permissions.hr_permissions.get_permission_query_conditions",
}

has_permission = {
    "Project Master":   "betime_solution.permissions.project_permissions.has_permission",
    "Meeting MOM":      "betime_solution.permissions.project_permissions.has_permission",
    "Smart Task":       "betime_solution.permissions.project_permissions.has_permission",
    "OT Claim":         "betime_solution.permissions.finance_permissions.has_permission",
    "Invoice Tracking": "betime_solution.permissions.finance_permissions.has_permission",
    "Employee Profile": "betime_solution.permissions.hr_permissions.has_permission",
}

# Override standard list queries (never use frappe.get_list directly)
override_whitelisted_methods = {}

# Website route rules
website_route_rules = [
    {"from_route": "/betime/<path:app_path>", "to_route": "betime"},
]
