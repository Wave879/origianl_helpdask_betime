#!/usr/bin/env python3
"""
Build hd_project_member_roles as a logical master table inside hd_master.

This table stores project-specific roles for people so the same person can have
different positions across different projects without overwriting hd_users.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections import defaultdict
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor


DEFAULT_PG_URL = "postgres://postgres:123456@localhost:5432/Betime_DB"


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_key(value: Any) -> str:
    text = clean_text(value).lower()
    if not text:
        return ""
    text = text.replace("_", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    text = clean_text(value)
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def uniq(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for value in values:
        text = clean_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def split_people_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return uniq([clean_text(item) for item in value])
    text = clean_text(value)
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return uniq([clean_text(item) for item in parsed])
    except Exception:
        pass
    return uniq([part.strip() for part in re.split(r"[,;\n|]+", text) if part.strip()])


def normalize_role(value: Any) -> str:
    token = normalize_key(value)
    if not token:
        return ""
    if any(term in token for term in ("project manager", "pm", "head", "manager")):
        return "PM"
    if any(term in token for term in ("dev", "developer", "development", "engineering")):
        return "Dev"
    if any(term in token for term in ("support", "it support", "helpdesk", "help desk", "service desk")):
        return "IT Support"
    return ""


def load_rows(cur, table_name: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT id, code, name, extra, active, sort_order
        FROM hd_master
        WHERE table_name = %s
        ORDER BY sort_order ASC, name ASC
        """,
        (table_name,),
    )
    return list(cur.fetchall())


def make_id(*parts: Any) -> str:
    raw = "|".join(clean_text(part) for part in parts if clean_text(part))
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"hd_pmr_{digest}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync project member roles into hd_master.")
    parser.add_argument("--pg-url", default=os.environ.get("PG_URL", DEFAULT_PG_URL))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(args.pg_url)
    conn.autocommit = False

    inserted = 0
    with conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            projects = load_rows(cur, "hd_projects")
            teams = load_rows(cur, "hd_teams")
            users = load_rows(cur, "hd_users")
            main_rows = load_rows(cur, "hd_main_team_project")
            dev_rows = load_rows(cur, "hd_projects_dev")

            project_index = {}
            for project in projects:
                key_bits = uniq([
                    project.get("id"),
                    project.get("code"),
                    project.get("name"),
                ])
                for key in key_bits:
                    project_index[normalize_key(key)] = project

            def find_project(value: Any) -> dict[str, Any] | None:
                token = normalize_key(value)
                if not token:
                    return None
                if token in project_index:
                    return project_index[token]
                for key, row in project_index.items():
                    if token in key or key in token:
                        return row
                return None

            user_index = defaultdict(list)
            for user in users:
                for key in uniq([
                    user.get("id"),
                    user.get("code"),
                    user.get("name"),
                    parse_json(user.get("extra")).get("email", ""),
                    parse_json(user.get("extra")).get("source_id", ""),
                ]):
                    user_index[normalize_key(key)].append(user)

            def find_user(value: Any) -> dict[str, Any] | None:
                token = normalize_key(value)
                if not token:
                    return None
                exact = user_index.get(token, [])
                if exact:
                    return exact[0]
                for key, rows in user_index.items():
                    if token in key or key in token:
                        return rows[0]
                return None

            team_by_project: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for team in teams:
                extra = parse_json(team.get("extra"))
                project = find_project(
                    extra.get("project_code")
                    or extra.get("project_name")
                    or extra.get("parent_project")
                    or team.get("code")
                    or team.get("name")
                )
                if not project:
                    continue
                team_by_project[clean_text(project.get("id") or project.get("code") or project.get("name"))].append(team)

            dev_people_by_project: dict[str, set[str]] = defaultdict(set)
            for row in dev_rows:
                if row.get("active") is False:
                    continue
                extra = parse_json(row.get("extra"))
                project = find_project(
                    extra.get("parent_project")
                    or extra.get("parent_project_ref")
                    or extra.get("project_code")
                    or extra.get("project_id")
                    or row.get("project_code")
                    or row.get("project_id")
                    or row.get("project_ref")
                )
                person = find_user(
                    extra.get("employee_id")
                    or row.get("employee_id")
                    or row.get("user_id")
                    or extra.get("employee_name")
                    or row.get("employee_name")
                    or extra.get("employee_email")
                    or row.get("employee_email")
                    or row.get("code")
                    or row.get("name")
                )
                if project and person:
                    project_key = clean_text(project.get("id") or project.get("code") or project.get("name"))
                    dev_people_by_project[project_key].add(clean_text(person.get("id")))

            payloads: dict[str, dict[str, Any]] = {}

            def add_role(project: dict[str, Any] | None, person: dict[str, Any] | None, role_type: str, position_name: str, source_table: str, source_row_id: str, source_extra: dict[str, Any] | None = None):
                if not project or not person or not role_type:
                    return
                project_id = clean_text(project.get("id") or project.get("code") or project.get("name"))
                project_code = clean_text(project.get("code") or "")
                project_name = clean_text(project.get("name") or project.get("code") or "-")
                person_id = clean_text(person.get("id") or person.get("code") or person.get("name"))
                person_code = clean_text(person.get("code") or person.get("email") or "")
                person_name = clean_text(person.get("name") or person.get("code") or person.get("email") or "-")
                if not project_id or not person_id:
                    return
                key = "|".join([project_id, person_id, role_type, position_name or role_type])
                payloads[key] = {
                    "id": make_id(project_id, person_id, role_type, position_name or role_type),
                    "table_name": "hd_project_member_roles",
                    "code": key,
                    "name": f"{project_name} · {person_name}",
                    "extra": json.dumps({
                        "source": "sync_hd_project_member_roles",
                        "project_id": project_id,
                        "project_code": project_code,
                        "project_name": project_name,
                        "person_id": person_id,
                        "person_code": person_code,
                        "person_name": person_name,
                        "role_type": role_type,
                        "position_name": position_name or role_type,
                        "source_table": source_table,
                        "source_row_id": source_row_id,
                        "source_extra": source_extra or {},
                    }, ensure_ascii=False),
                    "active": True,
                    "sort_order": 0,
                }

            for row in main_rows:
                if row.get("active") is False:
                    continue
                extra = parse_json(row.get("extra"))
                role_type = normalize_role(extra.get("role_type") or extra.get("role") or row.get("role_type") or row.get("role"))
                if not role_type:
                    continue
                project = find_project(row.get("project_service_id") or row.get("project_id") or row.get("project_ref") or row.get("code") or row.get("project_service_name") or row.get("project_name"))
                person = find_user(extra.get("user_id") or extra.get("person_id") or row.get("user_id") or row.get("person_id") or row.get("name") or row.get("person_name"))
                add_role(
                    project,
                    person,
                    role_type,
                    clean_text(extra.get("position_name") or row.get("position_name") or row.get("position") or role_type),
                    "hd_main_team_project",
                    clean_text(row.get("id")),
                    extra,
                )

            for row in dev_rows:
                if row.get("active") is False:
                    continue
                extra = parse_json(row.get("extra"))
                project = find_project(
                    extra.get("parent_project")
                    or extra.get("parent_project_ref")
                    or extra.get("project_code")
                    or extra.get("project_id")
                    or row.get("project_code")
                    or row.get("project_id")
                    or row.get("project_ref")
                )
                person = find_user(
                    extra.get("employee_id")
                    or row.get("employee_id")
                    or row.get("user_id")
                    or extra.get("employee_name")
                    or row.get("employee_name")
                    or extra.get("employee_email")
                    or row.get("employee_email")
                    or row.get("code")
                    or row.get("name")
                )
                add_role(
                    project,
                    person,
                    "Dev",
                    "Dev",
                    "hd_projects_dev",
                    clean_text(row.get("id")),
                    extra,
                )

            for team in teams:
                if team.get("active") is False:
                    continue
                extra = parse_json(team.get("extra"))
                project = find_project(
                    extra.get("project_code")
                    or extra.get("project_name")
                    or extra.get("parent_project")
                    or team.get("code")
                    or team.get("name")
                )
                if not project:
                    continue
                project_key = clean_text(project.get("id") or project.get("code") or project.get("name"))
                owner = find_user(extra.get("owner_id") or team.get("owner_id") or extra.get("owner_name") or team.get("owner_name"))
                owner_name = clean_text(extra.get("owner_name") or team.get("owner_name") or "")
                owner_person = owner or find_user(owner_name)
                if owner_person:
                    add_role(
                        project,
                        owner_person,
                        "PM",
                        "PM",
                        "hd_teams",
                        clean_text(team.get("id")),
                        extra,
                    )

                support_rule = normalize_key(extra.get("it_support_holder_rule") or "")
                support_holders = uniq(
                    split_people_list(extra.get("it_support_holder_ids"))
                    + split_people_list(extra.get("it_support_holder_names"))
                    + split_people_list(extra.get("it_support_holder_emails"))
                )
                members = uniq(
                    split_people_list(extra.get("member_ids"))
                    + split_people_list(extra.get("member_names"))
                    + split_people_list(extra.get("member_emails"))
                )
                dev_people = dev_people_by_project.get(project_key, set())

                support_people: list[dict[str, Any]] = []
                if support_holders:
                    for value in support_holders:
                        person = find_user(value)
                        if person and person.get("id") not in {owner_person.get("id") if owner_person else ""}:
                            support_people.append(person)
                elif "team members minus project dev" in support_rule or "team_members_minus_project_dev" in support_rule:
                    for value in members:
                        person = find_user(value)
                        if not person:
                            continue
                        if owner_person and person.get("id") == owner_person.get("id"):
                            continue
                        if clean_text(person.get("id")) in dev_people:
                            continue
                        support_people.append(person)

                for person in support_people:
                    add_role(
                        project,
                        person,
                        "IT Support",
                        "IT Support",
                        "hd_teams",
                        clean_text(team.get("id")),
                        extra,
                    )

            cur.execute("DELETE FROM hd_master WHERE table_name = 'hd_project_member_roles'")
            for item in payloads.values():
                cur.execute(
                    """
                    INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, now(), now())
                    """,
                    (
                        item["id"],
                        item["table_name"],
                        item["code"],
                        item["name"],
                        item["extra"],
                        item["active"],
                        item["sort_order"],
                    ),
                )
                inserted += 1

    if args.dry_run:
        conn.rollback()
    else:
        conn.commit()

    print(json.dumps({"inserted": inserted, "dry_run": bool(args.dry_run)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
