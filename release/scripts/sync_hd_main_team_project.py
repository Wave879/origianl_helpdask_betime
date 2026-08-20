#!/usr/bin/env python3
"""
Seed/refresh hd_main_team_project rows in hd_master.

The script derives one row per project/service person-role from the existing
helpdesk master tables:
- hd_projects  -> PM
- hd_teams     -> IT Support
- hd_projects_dev -> Dev

It is idempotent for rows it generates because the row ids are deterministic.
Manual rows (if any) are preserved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

import psycopg2
from psycopg2.extras import execute_batch


DEFAULT_PG_URL = "postgres://postgres:123456@localhost:5432/Betime_DB"


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return re.sub(r"\s+", " ", value).strip()
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_key(value: Any) -> str:
    return clean_text(value).lower()


def uniq(values: Iterable[Any]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def parse_extra(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw or {}
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def stable_hash(text: str, length: int = 10) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def stable_id(*parts: Any) -> str:
    key = "::".join(clean_text(part) for part in parts if clean_text(part))
    return f"auto_mainteam_{stable_hash(key or 'empty', 12)}"


def load_rows(cur, table_name: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT id, code, name, extra, active, sort_order
        FROM hd_master
        WHERE table_name=%s
        ORDER BY sort_order ASC, name ASC
        """,
        (table_name,),
    )
    return [
        {
            "id": row[0],
            "code": row[1],
            "name": row[2],
            "extra": row[3],
            "active": row[4],
            "sort_order": row[5],
        }
        for row in cur.fetchall()
    ]


@dataclass
class UserEntry:
    row: dict[str, Any]
    extra: dict[str, Any]
    tokens: list[str]


def build_user_index(rows: list[dict[str, Any]]) -> list[UserEntry]:
    index: list[UserEntry] = []
    for row in rows:
        extra = parse_extra(row.get("extra"))
        tokens = uniq(
            [
                row.get("id"),
                row.get("code"),
                row.get("name"),
                extra.get("source_id"),
                extra.get("employee_id"),
                extra.get("employee_code"),
                extra.get("email"),
                extra.get("login"),
                extra.get("username"),
                extra.get("full_name"),
                extra.get("job_title"),
                extra.get("position_name"),
                extra.get("department_name"),
                extra.get("owner_name"),
            ]
        )
        index.append(UserEntry(row=row, extra=extra, tokens=tokens))
    return index


def find_user(user_index: list[UserEntry], value: Any) -> UserEntry | None:
    token = normalize_key(value)
    if not token:
        return None
    partial: UserEntry | None = None
    for entry in user_index:
        for raw_token in entry.tokens:
            normalized = normalize_key(raw_token)
            if not normalized:
                continue
            if normalized == token:
                return entry
            if partial is None and (normalized in token or token in normalized):
                partial = entry
    return partial


def exact_or_partial_match(project_tokens: Iterable[Any], entity_tokens: Iterable[Any]) -> bool:
    project_norm = [normalize_key(token) for token in project_tokens if normalize_key(token)]
    entity_norm = [normalize_key(token) for token in entity_tokens if normalize_key(token)]
    for pt in project_norm:
        for et in entity_norm:
            if pt == et:
                return True
    for pt in project_norm:
        if len(pt) < 5:
            continue
        for et in entity_norm:
            if pt in et or et in pt:
                return True
    return False


def prefix_fallback(code_tokens: Iterable[Any], entity_tokens: Iterable[Any]) -> bool:
    entity_norm = [normalize_key(token) for token in entity_tokens if normalize_key(token)]
    for token in code_tokens:
        normalized = normalize_key(token)
        if not normalized:
            continue
        if len(normalized) <= 4 and normalized.isalpha():
            for entity in entity_norm:
                if entity.startswith(normalized + "-") or entity.startswith(normalized + " "):
                    return True
    return False


def resolve_person_fields(user_entry: UserEntry | None) -> tuple[str, str, str]:
    if not user_entry:
        return "", "", ""
    extra = user_entry.extra
    position = clean_text(
        extra.get("job_title")
        or extra.get("position_name")
        or extra.get("position")
        or ""
    )
    department = clean_text(
        extra.get("department_name")
        or extra.get("department")
        or extra.get("department_id")
        or ""
    )
    person_name = clean_text(user_entry.row.get("name") or user_entry.row.get("code") or "")
    return person_name, position, department


def build_rows(
    projects: list[dict[str, Any]],
    teams: list[dict[str, Any]],
    devs: list[dict[str, Any]],
    user_index: list[UserEntry],
) -> list[dict[str, Any]]:
    team_entries: list[tuple[dict[str, Any], dict[str, Any], list[str]]] = []
    for row in teams:
        extra = parse_extra(row.get("extra"))
        tokens = uniq(
            [
                row.get("code"),
                row.get("name"),
                extra.get("team_code"),
                extra.get("team_name_th"),
                extra.get("team_name_en"),
                extra.get("team_helpdesk_display_name"),
            ]
        )
        team_entries.append((row, extra, tokens))

    dev_entries: list[tuple[dict[str, Any], dict[str, Any], list[str]]] = []
    for row in devs:
        extra = parse_extra(row.get("extra"))
        tokens = uniq(
            [
                row.get("code"),
                row.get("name"),
                extra.get("parent_project"),
                extra.get("parent_project_ref"),
                extra.get("project_id"),
                extra.get("project_ref"),
                extra.get("external_id"),
                extra.get("employee_id"),
                extra.get("employee_ref"),
            ]
        )
        dev_entries.append((row, extra, tokens))

    generated: list[dict[str, Any]] = []

    for project in projects:
        project_extra = parse_extra(project.get("extra"))
        project_name_tokens = uniq(
            [
                project.get("name"),
                project_extra.get("project_name"),
                project_extra.get("project_code"),
            ]
        )
        project_code_tokens = uniq([project.get("code")])
        dev_exact_tokens = uniq(
            [
                project_extra.get("source_id"),
                project_extra.get("project_sync_id"),
                project.get("id"),
                project.get("code"),
                project.get("name"),
            ]
        )
        service_key = clean_text(project.get("code") or project.get("name") or project.get("id"))
        if not service_key:
            service_key = clean_text(project.get("id") or project.get("name") or "unknown")
        service_name = clean_text(project.get("name") or project.get("code") or project.get("id"))
        base_sort = int(project.get("sort_order") or 0)
        dedupe_keys: set[tuple[str, str, str]] = set()
        rows_for_project: list[dict[str, Any]] = []

        def add_row(
            role_type: str,
            raw_person: str,
            resolved_user: UserEntry | None,
            matched_from: str,
            sort_rank: int,
        ) -> None:
            person_name, position_name, department_name = resolve_person_fields(resolved_user)
            if not person_name:
                person_name = clean_text(raw_person)

            normalized_person = normalize_key(person_name or raw_person or "")
            normalized_uid = normalize_key(resolved_user.row.get("id")) if resolved_user else ""
            dedupe_key = (role_type, normalized_uid or normalized_person, normalized_person or normalized_uid)
            if dedupe_key in dedupe_keys:
                return
            dedupe_keys.add(dedupe_key)

            row_id = stable_id(service_key, role_type, raw_person or person_name or "placeholder")
            sort_order = base_sort * 100 + sort_rank
            generated.append(
                {
                    "id": row_id,
                    "table_name": "hd_main_team_project",
                    "code": clean_text(project.get("code") or service_key),
                    "name": clean_text(person_name or service_name or service_key),
                    "extra": json.dumps(
                        {
                            "source": "derived",
                            "generated_by": "sync_hd_main_team_project",
                            "matched_from": matched_from,
                            "matched_value": clean_text(raw_person),
                            "project_service_id": service_key,
                            "project_service_name": service_name,
                            "project_code": clean_text(project.get("code") or ""),
                            "project_name": clean_text(project.get("name") or ""),
                            "user_id": clean_text(resolved_user.row.get("id")) if resolved_user else "",
                            "person_id": clean_text(resolved_user.row.get("id")) if resolved_user else "",
                            "person_name": clean_text(person_name or raw_person),
                            "role_type": role_type,
                            "role": role_type,
                            "position_name": position_name,
                            "department_name": department_name,
                            "sort_order": sort_order,
                        },
                        ensure_ascii=False,
                    ),
                    "active": True,
                    "sort_order": sort_order,
                }
            )
            rows_for_project.append(generated[-1])

        pm_value = clean_text(project_extra.get("project_pm"))
        if pm_value:
            add_row("pm", pm_value, find_user(user_index, pm_value), "project_pm", 0)

        matched_teams = [
            (team_row, team_extra)
            for team_row, team_extra, tokens in team_entries
            if exact_or_partial_match(project_name_tokens, tokens)
        ]
        if not matched_teams:
            matched_teams = [
                (team_row, team_extra)
                for team_row, team_extra, tokens in team_entries
                if prefix_fallback(project_code_tokens, tokens)
            ]

        for team_row, team_extra in matched_teams:
            support_values: list[str] = []
            for key in (
                "it_support_holder_names",
                "it_support_holder_emails",
                "team_member_names",
                "member_names",
                "team_member_display_names",
                "member_emails",
                "owner_name",
            ):
                value = team_extra.get(key)
                if isinstance(value, list):
                    support_values.extend(value)
                elif value:
                    support_values.append(value)
            for idx, support_value in enumerate(uniq(support_values), start=1):
                add_row(
                    "support",
                    support_value,
                    find_user(user_index, support_value),
                    f"team:{clean_text(team_row.get('code') or team_row.get('name') or 'team')}",
                    10 + idx,
                )

        matched_devs = [
            (dev_row, dev_extra)
            for dev_row, dev_extra, tokens in dev_entries
            if exact_or_partial_match(dev_exact_tokens, tokens)
        ]
        if not matched_devs:
            matched_devs = [
                (dev_row, dev_extra)
                for dev_row, dev_extra, tokens in dev_entries
                if prefix_fallback(project_code_tokens, tokens)
            ]

        for idx, (dev_row, dev_extra) in enumerate(matched_devs, start=1):
            dev_value = clean_text(
                dev_extra.get("employee_name")
                or dev_row.get("name")
                or dev_extra.get("employee_email")
                or dev_row.get("code")
                or dev_extra.get("employee_id")
            )
            if not dev_value:
                continue
            resolved = find_user(user_index, dev_extra.get("employee_id") or dev_value) or find_user(user_index, dev_value)
            add_row(
                "dev",
                dev_value,
                resolved,
                f"dev:{clean_text(dev_row.get('code') or dev_row.get('name') or 'dev')}",
                30 + idx,
            )

        if not rows_for_project:
            add_row("pm", "", None, "placeholder", 0)

    return generated


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pg-url", default=DEFAULT_PG_URL)
    parser.add_argument("--dry-run", action="store_true", help="Print a preview and do not write rows")
    parser.add_argument("--preview", type=int, default=12, help="How many rows to print per project in dry-run")
    args = parser.parse_args()

    conn = psycopg2.connect(args.pg_url)
    try:
        with conn.cursor() as cur:
            projects = load_rows(cur, "hd_projects")
            teams = load_rows(cur, "hd_teams")
            devs = load_rows(cur, "hd_projects_dev")
            users = load_rows(cur, "hd_users")
            user_index = build_user_index(users)
            rows = build_rows(projects, teams, devs, user_index)

            if args.dry_run:
                print(f"projects: {len(projects)}")
                print(f"generated rows: {len(rows)}")
                print(f"projects with rows: {len({row['code'] for row in rows})}")
                print(f"placeholder projects: {sorted({clean_text(parse_extra(row['extra']).get('project_service_id')) for row in rows if parse_extra(row['extra']).get('matched_from') == 'placeholder'})}")
                print("")
                grouped: dict[str, list[dict[str, Any]]] = {}
                for row in rows:
                    extra = parse_extra(row["extra"])
                    key = clean_text(extra.get("project_service_id") or row["code"] or row["name"])
                    grouped.setdefault(key, []).append(row)
                for key in sorted(grouped):
                    sample = grouped[key][: args.preview]
                    first_extra = parse_extra(sample[0]["extra"])
                    print(f"[{key}] {first_extra.get('project_service_name') or sample[0]['name']}")
                    for item in sample:
                        item_extra = parse_extra(item["extra"])
                        print(
                            f"  - {item_extra.get('role_type') or '-'} | "
                            f"{item_extra.get('person_name') or '-'} | "
                            f"{item_extra.get('matched_from') or '-'}"
                        )
                    if len(grouped[key]) > args.preview:
                        print(f"  ... +{len(grouped[key]) - args.preview} more")
                    print("")
                return 0

            cur.execute(
                """
                DELETE FROM hd_master
                WHERE table_name='hd_main_team_project'
                  AND id LIKE 'auto_mainteam_%'
                """
            )

            execute_batch(
                cur,
                """
                INSERT INTO hd_master
                  (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
                VALUES
                  (%s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (id) DO UPDATE SET
                  table_name = EXCLUDED.table_name,
                  code = EXCLUDED.code,
                  name = EXCLUDED.name,
                  extra = EXCLUDED.extra,
                  active = EXCLUDED.active,
                  sort_order = EXCLUDED.sort_order,
                  updated_at = now()
                """,
                [
                    (
                        row["id"],
                        row["table_name"],
                        row["code"],
                        row["name"],
                        row["extra"],
                        row["active"],
                        row["sort_order"],
                    )
                    for row in rows
                ],
                page_size=250,
            )
            conn.commit()

        print(f"Seeded hd_main_team_project with {len(rows)} rows.")
        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
