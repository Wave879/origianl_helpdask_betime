#!/usr/bin/env python3
"""
Backfill hd_users.extra position fields from team/project relations.

Priority:
  PM > Dev > IT Support

Only fills rows whose current position fields are blank, so existing manual
titles are preserved.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable

import psycopg2
from psycopg2.extras import RealDictCursor


DEFAULT_PG_URL = "postgres://postgres:123456@localhost:5432/Betime_DB"


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


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


def split_people_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [clean_text(item) for item in value if clean_text(item)]
    if isinstance(value, dict):
        return [clean_text(v) for v in value.values() if clean_text(v)]
    text = clean_text(value)
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [clean_text(item) for item in parsed if clean_text(item)]
    except Exception:
        pass
    return [part.strip() for part in re.split(r"[,;\n|]+", text) if part.strip()]


def unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
      value = clean_text(value)
      if not value or value in seen:
        continue
      seen.add(value)
      out.append(value)
    return out


@dataclass
class UserRow:
    id: str
    code: str
    name: str
    email: str
    extra: dict[str, Any]
    raw_extra: str

    @property
    def position_text(self) -> str:
        extra = self.extra
        return clean_text(
            extra.get("position")
            or extra.get("position_name")
            or extra.get("positionName")
            or extra.get("job_title")
            or extra.get("jobTitle")
            or ""
        )

    def key_candidates(self) -> list[str]:
        extra = self.extra
        return unique(
            [
                self.id,
                self.code,
                self.name,
                self.email,
                extra.get("source_id", ""),
                extra.get("email", ""),
                extra.get("login", ""),
            ]
        )


def build_user_index(users: list[UserRow]) -> dict[str, list[UserRow]]:
    index: dict[str, list[UserRow]] = defaultdict(list)
    for user in users:
        for candidate in user.key_candidates():
            index[normalize_key(candidate)].append(user)
    return index


def resolve_user(index: dict[str, list[UserRow]], value: Any) -> UserRow | None:
    token = normalize_key(value)
    if not token:
        return None
    exact = index.get(token, [])
    if len(exact) == 1:
        return exact[0]
    if exact:
        return exact[0]
    matches: list[UserRow] = []
    for key, rows in index.items():
        if key and (token in key or key in token):
            matches.extend(rows)
    matches = unique_user_rows(matches)
    if len(matches) == 1:
        return matches[0]
    return matches[0] if matches else None


def unique_user_rows(rows: Iterable[UserRow]) -> list[UserRow]:
    seen: set[str] = set()
    out: list[UserRow] = []
    for row in rows:
        if row.id in seen:
            continue
        seen.add(row.id)
        out.append(row)
    return out


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


def infer_team_roles(team_rows: list[dict[str, Any]], index: dict[str, list[UserRow]]) -> dict[str, set[str]]:
    roles: dict[str, set[str]] = defaultdict(set)
    for row in team_rows:
        extra = parse_json(row.get("extra"))
        owner = resolve_user(
            index,
            extra.get("owner_id")
            or row.get("owner_id")
            or extra.get("owner_name")
            or row.get("owner_name")
        )
        if owner:
            roles[owner.id].add("PM")

        members = unique(
            split_people_list(extra.get("team_member_ids") or extra.get("member_ids") or row.get("member_ids"))
            + split_people_list(extra.get("team_member_names") or extra.get("member_names") or row.get("member_names"))
            + split_people_list(extra.get("team_member_emails") or extra.get("member_emails") or row.get("member_emails"))
        )
        for value in members:
            member = resolve_user(index, value)
            if member and owner and member.id == owner.id:
                continue
            if member:
                roles[member.id].add("IT Support")
    return roles


def infer_dev_roles(dev_rows: list[dict[str, Any]], index: dict[str, list[UserRow]]) -> dict[str, set[str]]:
    roles: dict[str, set[str]] = defaultdict(set)
    for row in dev_rows:
        extra = parse_json(row.get("extra"))
        candidate = resolve_user(
            index,
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
        if candidate:
            roles[candidate.id].add("Dev")
    return roles


def infer_main_team_roles(main_rows: list[dict[str, Any]], index: dict[str, list[UserRow]]) -> dict[str, set[str]]:
    roles: dict[str, set[str]] = defaultdict(set)
    for row in main_rows:
        if row.get("active") is False:
            continue
        extra = parse_json(row.get("extra"))
        role = normalize_role(
            row.get("role_type")
            or row.get("role")
            or extra.get("role_type")
            or extra.get("role")
        )
        if not role:
            continue
        candidate = resolve_user(
            index,
            row.get("user_id")
            or row.get("person_name")
            or row.get("name")
            or extra.get("matched_value")
            or extra.get("person_name")
            or extra.get("user_id")
        )
        if candidate:
            roles[candidate.id].add(role)
    return roles


def pick_role(role_set: set[str]) -> str:
    priority = ("PM", "Dev", "IT Support")
    for role in priority:
        if role in role_set:
            return role
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill hd_users positions from team/project relations.")
    parser.add_argument("--pg-url", default=os.environ.get("PG_URL", DEFAULT_PG_URL))
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing them.")
    parser.add_argument("--fill-existing", action="store_true", help="Update position fields even if they already have a value.")
    args = parser.parse_args()

    conn = psycopg2.connect(args.pg_url)
    conn.autocommit = False
    updated = 0
    skipped_existing = 0
    skipped_unmatched = 0

    with conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            user_rows_raw = load_rows(cur, "hd_users")
            team_rows = load_rows(cur, "hd_teams")
            dev_rows = load_rows(cur, "hd_projects_dev")
            main_rows = load_rows(cur, "hd_main_team_project")

            users: list[UserRow] = [
                UserRow(
                    id=clean_text(row["id"]),
                    code=clean_text(row["code"]),
                    name=clean_text(row["name"]),
                    email=clean_text(parse_json(row["extra"]).get("email", "")),
                    extra=parse_json(row["extra"]),
                    raw_extra=clean_text(row["extra"]),
                )
                for row in user_rows_raw
            ]
            index = build_user_index(users)

            roles_by_user: dict[str, set[str]] = defaultdict(set)
            for source in (
                infer_team_roles(team_rows, index),
                infer_dev_roles(dev_rows, index),
                infer_main_team_roles(main_rows, index),
            ):
                for user_id, role_set in source.items():
                    roles_by_user[user_id].update(role_set)

            print(f"Loaded users={len(users)} teams={len(team_rows)} dev_rows={len(dev_rows)} main_rows={len(main_rows)}")

            for user in users:
                inferred = pick_role(roles_by_user.get(user.id, set()))
                if not inferred:
                    skipped_unmatched += 1
                    continue

                current_position = user.position_text
                if current_position and not args.fill_existing:
                    skipped_existing += 1
                    continue

                next_extra = dict(user.extra)
                next_extra["position"] = inferred
                next_extra["position_name"] = inferred
                next_extra["positionName"] = inferred
                next_extra["job_title"] = inferred
                next_extra["jobTitle"] = inferred

                if args.dry_run:
                    print(f"DRY {user.id} {user.name} -> {inferred}")
                    updated += 1
                    continue

                cur.execute(
                    """
                    UPDATE hd_master
                    SET extra = %s, updated_at = now()
                    WHERE id = %s AND table_name = 'hd_users'
                    """,
                    (json.dumps(next_extra, ensure_ascii=False), user.id),
                )
                updated += 1

    if args.dry_run:
        conn.rollback()
    else:
        conn.commit()

    print(
        json.dumps(
            {
                "updated": updated,
                "skipped_existing": skipped_existing,
                "skipped_unmatched": skipped_unmatched,
                "dry_run": bool(args.dry_run),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
