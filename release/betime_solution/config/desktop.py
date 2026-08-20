"""
Frappe Workspace / Desktop configuration for Betime Solution.
Defines module cards visible in the Frappe desk.
"""

from frappe import _


def get_data():
    return [
        {
            "module_name": "Project Management",
            "color": "#1E88E5",
            "icon": "octicon octicon-project",
            "type": "module",
            "label": _("Project Management"),
            "description": _("Projects, Meetings, Tasks"),
            "category": "Modules",
        },
        {
            "module_name": "Smart Secretary",
            "color": "#43A047",
            "icon": "octicon octicon-calendar",
            "type": "module",
            "label": _("Smart Secretary"),
            "description": _("Calendar, Resources, Scheduling"),
            "category": "Modules",
        },
        {
            "module_name": "Finance",
            "color": "#FB8C00",
            "icon": "octicon octicon-credit-card",
            "type": "module",
            "label": _("Finance"),
            "description": _("OT Claims, Invoices, Budget"),
            "category": "Modules",
        },
        {
            "module_name": "AI Knowledge",
            "color": "#8E24AA",
            "icon": "octicon octicon-book",
            "type": "module",
            "label": _("AI Knowledge"),
            "description": _("Knowledge Base, RAG, Lessons Learned"),
            "category": "Modules",
        },
        {
            "module_name": "HR",
            "color": "#E53935",
            "icon": "octicon octicon-person",
            "type": "module",
            "label": _("HR"),
            "description": _("Employee Profiles, Skills"),
            "category": "Modules",
        },
        {
            "module_name": "Compliance",
            "color": "#00897B",
            "icon": "octicon octicon-shield",
            "type": "module",
            "label": _("Compliance"),
            "description": _("TOR Checking, Contract Compliance"),
            "category": "Modules",
        },
    ]
