#!/usr/bin/env python3
"""
Import Odoo helpdesk dump into BETIME local D1 for Helpdeck Knowledge + master data.

What this script imports
- hd_master:
  - hd_projects
  - hd_sub_projects
  - hd_teams
  - hd_users
- knowledge_articles (category='Helpdeck'):
  - one article per Odoo case
  - one profile article per project
  - one profile article per team
  - one profile article per user

The goal is not only to keep ticket text searchable, but also to give the AI
structured relationship context such as:
- project -> PM / subprojects / teams / officers
- team -> projects / members / cases
- user -> projects / case ownership / work scope
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple


DEFAULT_DUMP_DIR = Path(r"C:\Users\wave\Downloads\bt-helpdesk_2026-02-20_06-29-35")
DEFAULT_SQLITE = Path(
    r"D:\betime solution\All_in_betime\BETIME\.wrangler\state\v3\d1\miniflare-D1DatabaseObject\b9467e4a305472534c444b3e818705c1b0a4bec7a6756eeee155070e681be8f1.sqlite"
)
DEFAULT_OUTPUT_DIR = Path(r"D:\betime solution\All_in_betime\BETIME\migrations")

TARGET_TABLES = {
    "hr_employee",
    "res_users",
    "res_partner",
    "tcp_main_team_member",
    "tcp_main_team",
    "tcp_mdm_service",
    "tcp_mdm_service_sub",
    "tcp_txn_case",
    "tcp_txn_case_activity",
}


def decode_dump(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8", "cp874", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def clean_text(value: Optional[str]) -> str:
    if value is None:
        return ""
    text = str(value).replace("\\r", "\n").replace("\\n", "\n").replace("\r", "\n")
    text = text.replace("\t", " ").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def clean_code(value: Optional[str], fallback: str) -> str:
    text = clean_text(value)
    return text or fallback


def truthy(value: Optional[str]) -> bool:
    return str(value).lower() in {"1", "t", "true", "y", "yes"}


def split_relation_values(value: Optional[str]) -> List[str]:
    text = clean_text(value)
    if not text:
        return []
    return [part.strip() for part in re.split(r"[,\n;]+", text) if part.strip()]


def parse_copy_header(line: str) -> Optional[Tuple[str, List[str]]]:
    match = re.match(r"^COPY public\.([a-zA-Z0-9_]+) \((.+)\) FROM stdin;$", line.strip())
    if not match:
        return None
    table = match.group(1)
    cols = [c.strip() for c in match.group(2).split(",")]
    return table, cols


def parse_copy_rows(sql_text: str, target_tables: Iterable[str]) -> Dict[str, List[dict]]:
    target = set(target_tables)
    data: Dict[str, List[dict]] = {name: [] for name in target}
    current_table: Optional[str] = None
    columns: List[str] = []

    for line in sql_text.splitlines():
        if current_table is None:
            header = parse_copy_header(line)
            if header and header[0] in target:
                current_table, columns = header
            continue

        if line == r"\.":
            current_table = None
            columns = []
            continue

        parts = line.split("\t")
        values = [None if p == r"\N" else p for p in parts]
        row = dict(zip(columns, values))
        data[current_table].append(row)

    return data


@dataclass
class ImportBundle:
    hd_rows: Dict[str, List[dict]]
    knowledge_rows: List[dict]
    ticket_rows: List[dict]
    summary: Dict[str, int]


def build_bundle(parsed: Dict[str, List[dict]]) -> ImportBundle:
    partners = {str(r["id"]): r for r in parsed["res_partner"]}
    users = {str(r["id"]): r for r in parsed["res_users"]}
    employees = {str(r["id"]): r for r in parsed["hr_employee"]}
    teams = {str(r["id"]): r for r in parsed["tcp_main_team"]}
    team_members = parsed.get("tcp_main_team_member", [])
    projects = {str(r["id"]): r for r in parsed["tcp_mdm_service"]}
    subprojects = {str(r["id"]): r for r in parsed["tcp_mdm_service_sub"]}
    cases = parsed["tcp_txn_case"]
    activities = parsed["tcp_txn_case_activity"]

    employee_profiles = {}
    for emp_id, emp in employees.items():
        user_row = users.get(str(emp.get("user_id"))) if emp.get("user_id") else None
        partner_row = partners.get(str(user_row.get("partner_id"))) if user_row and user_row.get("partner_id") else None
        email = clean_text(emp.get("work_email")) or clean_text(user_row.get("login") if user_row else "") or clean_text(partner_row.get("email") if partner_row else "")
        code = clean_code(email, f"emp_{emp_id}")
        name = clean_text(emp.get("name")) or clean_text(partner_row.get("name") if partner_row else "") or code
        employee_profiles[emp_id] = {
            "id": emp_id,
            "code": code,
            "name": name,
            "email": email,
            "job_title": clean_text(emp.get("job_title")),
            "department_id": clean_text(emp.get("department_id")),
            "manager_employee_id": clean_text(emp.get("parent_id")),
            "work_phone": clean_text(emp.get("work_phone")),
            "mobile_phone": clean_text(emp.get("mobile_phone")),
            "work_location": clean_text(emp.get("work_location")),
            "login": clean_text(user_row.get("login") if user_row else ""),
            "active": truthy(emp.get("active")),
        }

    team_profiles = {}
    team_member_ids_by_team: Dict[str, set] = defaultdict(set)
    for row in team_members:
        team_id = clean_text(row.get("team_id"))
        emp_id = clean_text(row.get("emp_id"))
        if team_id and emp_id:
            team_member_ids_by_team[team_id].add(emp_id)
    for row in parsed.get("m2m_team_to_hr_emp_rel", []):
        for team_id in split_relation_values(row.get("team_list_ids")):
            for emp_id in split_relation_values(row.get("member_list_ids")):
                if team_id and emp_id:
                    team_member_ids_by_team[team_id].add(emp_id)

    for team_id, row in teams.items():
        code = clean_code(row.get("team_code"), f"team_{team_id}")
        name = clean_text(row.get("team_name_th")) or clean_text(row.get("team_name_en")) or code
        member_ids = sorted(
            team_member_ids_by_team.get(team_id, set()),
            key=lambda x: (0, int(x)) if x.isdigit() else (1, x),
        )
        member_names = []
        member_codes = []
        member_emails = []
        member_logs = []
        for member_id in member_ids:
            member_profile = employee_profiles.get(member_id, {})
            member_name = member_profile.get("name", member_id)
            member_code = member_profile.get("code", member_id)
            member_email = member_profile.get("email", "")
            member_names.append(member_name)
            member_codes.append(member_code)
            member_emails.append(member_email)
            member_logs.append(
                " | ".join([part for part in [member_code, member_name, member_email] if part])
            )
        team_profiles[team_id] = {
            "id": team_id,
            "code": code,
            "name": name,
            "team_name_en": clean_text(row.get("team_name_en")),
            "remark": clean_text(row.get("team_remark")),
            "owner_id": clean_text(row.get("team_own_id")),
            "member_ids": member_ids,
            "member_names": member_names,
            "member_codes": member_codes,
            "member_emails": member_emails,
            "member_count": len(member_ids),
            "member_logs": member_logs,
            "active": truthy(row.get("team_active")),
        }

    project_profiles = {}
    for project_id, row in projects.items():
        code = clean_code(row.get("service_code"), f"service_{project_id}")
        project_profiles[project_id] = {
            "id": project_id,
            "code": code,
            "name": clean_text(row.get("service_name")) or code,
            "sync_id": clean_text(row.get("service_sync_id")),
            "pm": clean_text(row.get("service_pm")),
            "description": clean_text(row.get("service_description")),
            "line_token": clean_text(row.get("service_token")),
            "line_channel_secret": clean_text(row.get("line_channel_secret")),
            "line_channel_access_token": clean_text(row.get("line_channel_access_token")),
            "active": truthy(row.get("service_active")),
        }

    subproject_profiles = {}
    for sub_id, row in subprojects.items():
        parent_id = clean_text(row.get("service_id"))
        parent_code = project_profiles.get(parent_id, {}).get("code", parent_id)
        code = clean_code(row.get("service_sub_code"), f"service_sub_{sub_id}")
        subproject_profiles[sub_id] = {
            "id": sub_id,
            "parent_id": parent_id,
            "parent_code": parent_code,
            "code": code,
            "name": clean_text(row.get("service_sub_name")) or code,
            "pm": clean_text(row.get("service_sub_pm")),
            "description": clean_text(row.get("service_sub_description")),
            "active": truthy(row.get("service_sub_active")),
        }

    activities_by_case: Dict[str, List[dict]] = defaultdict(list)
    for row in activities:
        case_id = clean_text(row.get("case_id"))
        if case_id:
            activities_by_case[case_id].append(row)
    for case_id in activities_by_case:
        activities_by_case[case_id].sort(key=lambda x: (clean_text(x.get("activity_date_adjust")), clean_text(x.get("activity_date")), clean_text(x.get("create_date"))))

    project_case_ids: Dict[str, List[str]] = defaultdict(list)
    team_case_ids: Dict[str, List[str]] = defaultdict(list)
    user_case_ids: Dict[str, List[str]] = defaultdict(list)
    project_team_ids: Dict[str, Counter] = defaultdict(Counter)
    project_user_ids: Dict[str, Counter] = defaultdict(Counter)
    project_types: Dict[str, Counter] = defaultdict(Counter)
    user_project_ids: Dict[str, Counter] = defaultdict(Counter)
    team_project_ids: Dict[str, Counter] = defaultdict(Counter)

    hd_rows = {
        "hd_projects": [],
        "hd_sub_projects": [],
        "hd_teams": [],
        "hd_users": [],
    }
    knowledge_rows: List[dict] = []
    ticket_rows: List[dict] = []

    for project_id, profile in project_profiles.items():
        hd_rows["hd_projects"].append(
            {
                "id": f"odoo_hd_project_{project_id}",
                "table_name": "hd_projects",
                "code": profile["code"],
                "name": profile["name"],
                "extra": json.dumps(
                    {
                        "source": "odoo",
                        "source_id": project_id,
                        "project_sync_id": profile["sync_id"],
                        "project_pm": profile["pm"],
                        "project_description": profile["description"],
                        "service_token": profile["line_token"],
                        "line_channel_secret": profile["line_channel_secret"],
                        "line_channel_access_token": profile["line_channel_access_token"],
                    },
                    ensure_ascii=False,
                ),
                "active": 1 if profile["active"] else 0,
            }
        )

    for sub_id, profile in subproject_profiles.items():
        hd_rows["hd_sub_projects"].append(
            {
                "id": f"odoo_hd_sub_project_{sub_id}",
                "table_name": "hd_sub_projects",
                "code": profile["code"],
                "name": profile["name"],
                "extra": json.dumps(
                    {
                        "source": "odoo",
                        "source_id": sub_id,
                        "parent_project": profile["parent_code"],
                        "parent_project_id": profile["parent_id"],
                        "project_pm": profile["pm"],
                        "description": profile["description"],
                    },
                    ensure_ascii=False,
                ),
                "active": 1 if profile["active"] else 0,
            }
        )

    for team_id, profile in team_profiles.items():
        hd_rows["hd_teams"].append(
            {
                "id": f"odoo_hd_team_{team_id}",
                "table_name": "hd_teams",
                "code": profile["code"],
                "name": profile["name"],
                "extra": json.dumps(
                    {
                        "source": "odoo",
                        "source_id": team_id,
                        "team_name_en": profile["team_name_en"],
                        "remark": profile["remark"],
                        "owner_id": profile["owner_id"],
                        "member_ids": profile["member_ids"],
                        "member_names": profile["member_names"],
                        "member_codes": profile["member_codes"],
                        "member_emails": profile["member_emails"],
                        "member_count": profile["member_count"],
                    },
                    ensure_ascii=False,
                ),
                "active": 1 if profile["active"] else 0,
            }
        )

    for user_id, profile in employee_profiles.items():
        hd_rows["hd_users"].append(
            {
                "id": f"odoo_hd_user_{user_id}",
                "table_name": "hd_users",
                "code": profile["code"],
                "name": profile["name"],
                "extra": json.dumps(
                    {
                        "source": "odoo",
                        "source_id": user_id,
                        "email": profile["email"],
                        "login": profile["login"],
                        "job_title": profile["job_title"],
                        "department_id": profile["department_id"],
                        "manager_employee_id": profile["manager_employee_id"],
                        "work_phone": profile["work_phone"],
                        "mobile_phone": profile["mobile_phone"],
                        "work_location": profile["work_location"],
                    },
                    ensure_ascii=False,
                ),
                "active": 1 if profile["active"] else 0,
            }
        )

    def lookup_project(project_id: Optional[str]) -> dict:
        return project_profiles.get(str(project_id or ""), {})

    def lookup_subproject(sub_id: Optional[str]) -> dict:
        return subproject_profiles.get(str(sub_id or ""), {})

    def lookup_team(team_id: Optional[str]) -> dict:
        return team_profiles.get(str(team_id or ""), {})

    def lookup_user(user_id: Optional[str]) -> dict:
        return employee_profiles.get(str(user_id or ""), {})

    for case in cases:
        case_id = clean_text(case.get("id"))
        project = lookup_project(case.get("service_id"))
        subproject = lookup_subproject(case.get("service_sub_id"))
        owner_team = lookup_team(case.get("owner_team_id"))
        owner_user = lookup_user(case.get("owner_officer_id"))
        delegate_team = lookup_team(case.get("delegate_team_id"))
        delegate_user = lookup_user(case.get("delegate_officer_id"))

        case_ticket = clean_text(case.get("case_ticket_id")) or f"CASE-{case_id}"
        subject = clean_text(case.get("case_subject")) or case_ticket
        project_code = project.get("code", "")
        project_name = project.get("name", "")
        sub_code = subproject.get("code", "")
        sub_name = subproject.get("name", "")
        status = clean_text(case.get("case_status"))
        case_type = clean_text(case.get("case_type"))
        customer = clean_text(case.get("customer"))
        created_at = clean_text(case.get("create_date")) or clean_text(case.get("case_date_adjusted")) or clean_text(case.get("case_date"))
        updated_at = clean_text(case.get("write_date")) or created_at
        finished_at = clean_text(case.get("finish_date")) or clean_text(case.get("case_date_finish"))
        note = clean_text(case.get("case_note"))
        desc = clean_text(case.get("case_desc"))

        acts = activities_by_case.get(case_id, [])
        activity_lines = []
        for act in acts[:20]:
            when = clean_text(act.get("activity_date_adjust")) or clean_text(act.get("activity_date"))
            who = clean_text(act.get("activity_contact_name"))
            status_text = clean_text(act.get("activity_status"))
            detail = clean_text(act.get("activity_description"))
            parts = [p for p in [when, who, status_text, detail] if p]
            if parts:
                activity_lines.append("- " + " | ".join(parts))

        content_lines = [
            "Document Type: Odoo Helpdesk Case",
            f"Case ID: {case_id}",
            f"Ticket No: {case_ticket}",
            f"Project: {project_code} - {project_name}" if project_code or project_name else "Project: -",
            f"Sub Project: {sub_code} - {sub_name}" if sub_code or sub_name else "Sub Project: -",
            f"Project PM: {project.get('pm', '-') or '-'}",
            f"Status: {status or '-'}",
            f"Case Type: {case_type or '-'}",
            f"Customer: {customer or '-'}",
            f"Owner Team: {owner_team.get('code', '')} - {owner_team.get('name', '')}".strip(" -") or "-",
            f"Owner Officer: {owner_user.get('name', '-') or '-'}",
            f"Delegate Team: {delegate_team.get('code', '')} - {delegate_team.get('name', '')}".strip(" -") or "-",
            f"Delegate Officer: {delegate_user.get('name', '-') or '-'}",
            f"Created At: {created_at or '-'}",
            f"Updated At: {updated_at or '-'}",
            f"Finished At: {finished_at or '-'}",
            "",
            "Subject:",
            subject or "-",
            "",
            "Description:",
            desc or "-",
            "",
            "Note:",
            note or "-",
            "",
            "Activity Timeline:",
            "\n".join(activity_lines) if activity_lines else "-",
        ]
        content = "\n".join(content_lines).strip()

        tags = [
            "source:odoo",
            "entity:case",
            f"ticket:{case_ticket}",
            f"project:{project_code}" if project_code else "",
            f"subproject:{sub_code}" if sub_code else "",
            f"status:{status}" if status else "",
            f"type:{case_type}" if case_type else "",
            f"owner_team:{owner_team.get('code', '')}" if owner_team.get("code") else "",
            f"owner_officer:{owner_user.get('code', '')}" if owner_user.get("code") else "",
        ]
        tags = ",".join([t for t in tags if t])

        knowledge_rows.append(
            {
                "id": f"odoo_case_{case_id}",
                "title": f"[{case_ticket}] {subject}",
                "content": content,
                "category": "Helpdeck",
                "tags": tags,
                "author": owner_user.get("name") or customer or "Odoo Import",
                "created_at": created_at or updated_at,
                "updated_at": updated_at or created_at,
            }
        )

        ticket_rows.append(
            {
                "id": f"odoo_ticket_{case_id}",
                "title": subject,
                "description": desc or note,
                "project": project_code or project_name,
                "bug_type": case_type or "Ticket",
                "status": status or "open",
                "assigned_dev": owner_user.get("name") or "",
                "created_by": customer or owner_user.get("name") or "Odoo Import",
                "odoo_ticket_id": case_ticket,
                "created_at": created_at or updated_at or "2026-05-07 00:00:00",
                "updated_at": updated_at or created_at or "2026-05-07 00:00:00",
                "extra": json.dumps(
                    {
                        "source": "odoo",
                        "source_id": case_id,
                        "project_code": project_code,
                        "project_name": project_name,
                        "subproject_code": sub_code,
                        "subproject_name": sub_name,
                        "owner_team": owner_team.get("name", ""),
                        "owner_team_code": owner_team.get("code", ""),
                        "owner_officer": owner_user.get("name", ""),
                        "delegate_team": delegate_team.get("name", ""),
                        "delegate_officer": delegate_user.get("name", ""),
                        "customer": customer,
                        "activity_count": len(acts),
                    },
                    ensure_ascii=False,
                ),
            }
        )

        if project.get("id"):
            project_case_ids[project["id"]].append(case_id)
            if owner_team.get("id"):
                project_team_ids[project["id"]][owner_team["id"]] += 1
            if owner_user.get("id"):
                project_user_ids[project["id"]][owner_user["id"]] += 1
            if case_type:
                project_types[project["id"]][case_type] += 1

        if owner_team.get("id"):
            team_case_ids[owner_team["id"]].append(case_id)
            if project.get("id"):
                team_project_ids[owner_team["id"]][project["id"]] += 1

        if owner_user.get("id"):
            user_case_ids[owner_user["id"]].append(case_id)
            if project.get("id"):
                user_project_ids[owner_user["id"]][project["id"]] += 1

    for project_id, project in project_profiles.items():
        related_subs = [s for s in subproject_profiles.values() if s["parent_id"] == project_id]
        common_teams = [team_profiles[t].get("name", t) for t, _ in project_team_ids[project_id].most_common(5) if t in team_profiles]
        common_users = [employee_profiles[u].get("name", u) for u, _ in project_user_ids[project_id].most_common(8) if u in employee_profiles]
        common_types = [name for name, _ in project_types[project_id].most_common(8)]
        subproject_names = ", ".join([f"{x['code']} - {x['name']}" for x in related_subs[:20]]) or "-"
        content = "\n".join(
            [
                "Document Type: Helpdesk Project Profile",
                f"Project Code: {project['code']}",
                f"Project Name: {project['name']}",
                f"Project PM: {project['pm'] or '-'}",
                f"Project Sync ID: {project['sync_id'] or '-'}",
                f"Description: {project['description'] or '-'}",
                f"Total Cases: {len(project_case_ids[project_id])}",
                f"Sub Projects: {subproject_names}",
                f"Teams Handling This Project: {', '.join(common_teams) or '-'}",
                f"Main Officers: {', '.join(common_users) or '-'}",
                f"Common Case Types: {', '.join(common_types) or '-'}",
            ]
        )
        knowledge_rows.append(
            {
                "id": f"odoo_project_profile_{project_id}",
                "title": f"Project Profile: {project['code']} - {project['name']}",
                "content": content,
                "category": "Helpdeck",
                "tags": ",".join(
                    [
                        "source:odoo",
                        "entity:project",
                        f"project:{project['code']}",
                        f"pm:{project['pm']}" if project["pm"] else "",
                    ]
                ).strip(","),
                "author": project["pm"] or "Odoo Import",
                "created_at": "2026-05-07 00:00:00",
                "updated_at": "2026-05-07 00:00:00",
            }
        )

    for team_id, team in team_profiles.items():
        related_projects = [project_profiles[p].get("name", p) for p, _ in team_project_ids[team_id].most_common(10) if p in project_profiles]
        content = "\n".join(
            [
                "Document Type: Helpdesk Team Profile",
                f"Team Code: {team['code']}",
                f"Team Name: {team['name']}",
                f"English Name: {team['team_name_en'] or '-'}",
                f"Remark: {team['remark'] or '-'}",
                f"Owner ID: {team['owner_id'] or '-'}",
                f"Member Count: {team['member_count']}",
                f"Members: {', '.join(team['member_names']) or '-'}",
                f"Total Owned Cases: {len(team_case_ids[team_id])}",
                f"Projects Handled: {', '.join(related_projects) or '-'}",
            ]
        )
        knowledge_rows.append(
            {
                "id": f"odoo_team_profile_{team_id}",
                "title": f"Team Profile: {team['code']} - {team['name']}",
                "content": content,
                "category": "Helpdeck",
                "tags": f"source:odoo,entity:team,team:{team['code']}",
                "author": "Odoo Import",
                "created_at": "2026-05-07 00:00:00",
                "updated_at": "2026-05-07 00:00:00",
            }
        )

    for user_id, user in employee_profiles.items():
        related_projects = [project_profiles[p].get("name", p) for p, _ in user_project_ids[user_id].most_common(10) if p in project_profiles]
        content = "\n".join(
            [
                "Document Type: Helpdesk User Profile",
                f"Name: {user['name']}",
                f"Code: {user['code']}",
                f"Email: {user['email'] or '-'}",
                f"Login: {user['login'] or '-'}",
                f"Job Title: {user['job_title'] or '-'}",
                f"Department ID: {user['department_id'] or '-'}",
                f"Manager Employee ID: {user['manager_employee_id'] or '-'}",
                f"Work Phone: {user['work_phone'] or '-'}",
                f"Mobile Phone: {user['mobile_phone'] or '-'}",
                f"Work Location: {user['work_location'] or '-'}",
                f"Total Owned Cases: {len(user_case_ids[user_id])}",
                f"Projects Touched: {', '.join(related_projects) or '-'}",
            ]
        )
        knowledge_rows.append(
            {
                "id": f"odoo_user_profile_{user_id}",
                "title": f"User Profile: {user['name']}",
                "content": content,
                "category": "Helpdeck",
                "tags": f"source:odoo,entity:user,user:{user['code']}",
                "author": "Odoo Import",
                "created_at": "2026-05-07 00:00:00",
                "updated_at": "2026-05-07 00:00:00",
            }
        )

    summary = {
        "hd_projects": len(hd_rows["hd_projects"]),
        "hd_sub_projects": len(hd_rows["hd_sub_projects"]),
        "hd_teams": len(hd_rows["hd_teams"]),
        "hd_users": len(hd_rows["hd_users"]),
        "knowledge_articles": len(knowledge_rows),
        "helpdesk_tickets": len(ticket_rows),
        "case_articles": len(cases),
        "project_profiles": len(project_profiles),
        "team_profiles": len(team_profiles),
        "user_profiles": len(employee_profiles),
    }

    return ImportBundle(hd_rows=hd_rows, knowledge_rows=knowledge_rows, ticket_rows=ticket_rows, summary=summary)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hd_master (
          id TEXT PRIMARY KEY,
          table_name TEXT NOT NULL,
          code TEXT,
          name TEXT NOT NULL,
          extra TEXT DEFAULT '{}',
          active INTEGER DEFAULT 1,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_articles (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT,
          category TEXT,
          tags TEXT DEFAULT '[]',
          author TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS helpdesk_tickets (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          project TEXT,
          bug_type TEXT DEFAULT 'Ticket',
          status TEXT DEFAULT 'open',
          assigned_dev TEXT,
          created_by TEXT,
          odoo_ticket_id TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          extra TEXT DEFAULT '{}'
        )
        """
    )


def import_sqlite(bundle: ImportBundle, sqlite_path: Path) -> None:
    conn = sqlite3.connect(sqlite_path)
    try:
        ensure_schema(conn)
        conn.execute("BEGIN")

        for table_name in bundle.hd_rows:
            conn.execute("DELETE FROM hd_master WHERE table_name=? AND id LIKE 'odoo_%'", (table_name,))
        conn.execute("DELETE FROM knowledge_articles WHERE id LIKE 'odoo_%'")
        conn.execute("DELETE FROM helpdesk_tickets WHERE id LIKE 'odoo_%'")

        for rows in bundle.hd_rows.values():
            conn.executemany(
                """
                INSERT OR REPLACE INTO hd_master
                (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
                """,
                [
                    (
                        row["id"],
                        row["table_name"],
                        row["code"],
                        row["name"],
                        row["extra"],
                        row["active"],
                    )
                    for row in rows
                ],
            )

        conn.executemany(
            """
            INSERT OR REPLACE INTO knowledge_articles
            (id, title, content, category, tags, author, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row["id"],
                    row["title"],
                    row["content"],
                    row["category"],
                    row["tags"],
                    row["author"],
                    row["created_at"],
                    row["updated_at"],
                )
                for row in bundle.knowledge_rows
            ],
        )
        conn.executemany(
            """
            INSERT OR REPLACE INTO helpdesk_tickets
            (id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row["id"],
                    row["title"],
                    row["description"],
                    row["project"],
                    row["bug_type"],
                    row["status"],
                    row["assigned_dev"],
                    row["created_by"],
                    row["odoo_ticket_id"],
                    row["created_at"],
                    row["updated_at"],
                    row["extra"],
                )
                for row in bundle.ticket_rows
            ],
        )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def write_outputs(bundle: ImportBundle, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "odoo_helpdesk_import_summary.json").write_text(
        json.dumps(bundle.summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "odoo_helpdesk_masterdata.json").write_text(
        json.dumps(bundle.hd_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "odoo_helpdesk_knowledge.json").write_text(
        json.dumps(bundle.knowledge_rows[:200], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump-dir", default=str(DEFAULT_DUMP_DIR))
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--no-import", action="store_true")
    args = parser.parse_args()

    dump_dir = Path(args.dump_dir)
    dump_sql = dump_dir / "dump.sql"
    sqlite_path = Path(args.sqlite)
    output_dir = Path(args.output_dir)

    if not dump_sql.exists():
        raise SystemExit(f"Dump not found: {dump_sql}")
    if not args.no_import and not sqlite_path.exists():
        raise SystemExit(f"SQLite DB not found: {sqlite_path}")

    print(f"[*] Reading dump: {dump_sql}")
    sql_text = decode_dump(dump_sql)
    print("[*] Parsing selected Odoo tables...")
    parsed = parse_copy_rows(sql_text, TARGET_TABLES)
    bundle = build_bundle(parsed)

    print("[*] Summary")
    for key, value in bundle.summary.items():
        print(f"    - {key}: {value}")

    print(f"[*] Writing output snapshots to: {output_dir}")
    write_outputs(bundle, output_dir)

    if not args.no_import:
        print(f"[*] Importing into local D1 sqlite: {sqlite_path}")
        import_sqlite(bundle, sqlite_path)
        print("[+] Import completed")
    else:
        print("[*] Skipped sqlite import (--no-import)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
