#!/usr/bin/env python3
"""
Import a broader Odoo helpdesk dump into PostgreSQL.

This keeps the existing helpdesk bundle import and adds extra knowledge rows
for related tables and id-to-id relation tables so the knowledge base can be
used to inspect and edit the imported structure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_batch

import migrate_helpdesk_from_odoo as base


EXTRA_TABLES = {
    "case_management_report",
    "case_management_report_tcp_main_area_rel",
    "case_summary_report",
    "case_summary_report_tcp_main_area_rel",
    "flow_to_area_m2m",
    "hr_department",
    "hr_employee",
    "hr_employee_category",
    "hr_job",
    "ir_attachment",
    "mail_followers",
    "mail_followers_mail_message_subtype_rel",
    "mail_mail_res_partner_rel",
    "mail_message",
    "mail_message_mail_channel_rel",
    "mail_message_res_partner_needaction_rel",
    "mail_message_res_partner_needaction_rel_mail_resend_message_rel",
    "mail_message_res_partner_rel",
    "mail_message_res_partner_starred_rel",
    "mail_message_subtype",
    "m2m_team_to_hr_emp_rel",
    "mdm_district",
    "mdm_postcode",
    "mdm_sub_district",
    "res_company_users_rel",
    "res_country",
    "res_country_state",
    "res_groups_implied_rel",
    "res_groups_report_rel",
    "res_groups_users_rel",
    "res_partner",
    "res_partner_bank",
    "res_partner_category",
    "res_partner_industry",
    "res_partner_res_partner_category_rel",
    "res_partner_title",
    "res_users",
    "tcp_main_area",
    "tcp_main_area_sub",
    "tcp_main_news",
    "tcp_main_news_travel",
    "tcp_main_page",
    "tcp_main_product",
    "tcp_main_product_channel",
    "tcp_main_team",
    "tcp_main_team_member",
    "tcp_mdm_case_type",
    "tcp_mdm_channel",
    "tcp_mdm_contact_us",
    "tcp_mdm_eform",
    "tcp_mdm_priority",
    "tcp_mdm_priority_case_type_rel",
    "tcp_mdm_question",
    "tcp_mdm_question_sub",
    "tcp_mdm_service",
    "tcp_mdm_service_dev",
    "tcp_mdm_service_sub",
    "tcp_txn_case",
    "tcp_txn_case_activity",
    "tcp_txn_case_assign",
    "tcp_txn_case_assign_dev",
    "tcp_txn_case_attach",
    "tcp_txn_case_chat",
    "tcp_txn_case_image",
    "tcp_txn_consent",
    "user_menu_rel",
    "user_report_rel",
}

RELATION_TABLES = {
    "case_management_report_tcp_main_area_rel",
    "case_summary_report_tcp_main_area_rel",
    "flow_to_area_m2m",
    "mail_followers_mail_message_subtype_rel",
    "mail_mail_res_partner_rel",
    "mail_message_mail_channel_rel",
    "mail_message_res_partner_needaction_rel",
    "mail_message_res_partner_needaction_rel_mail_resend_message_rel",
    "mail_message_res_partner_rel",
    "mail_message_res_partner_starred_rel",
    "m2m_team_to_hr_emp_rel",
    "res_company_users_rel",
    "res_groups_implied_rel",
    "res_groups_report_rel",
    "res_groups_users_rel",
    "res_partner_res_partner_category_rel",
    "tcp_mdm_priority_case_type_rel",
    "tcp_main_product_channel",
    "user_menu_rel",
    "user_report_rel",
}

LOOKUP_TABLES = {
    "hr_department",
    "hr_employee",
    "hr_employee_category",
    "hr_job",
    "ir_attachment",
    "mail_followers",
    "mail_message",
    "mail_message_subtype",
    "mdm_district",
    "mdm_postcode",
    "mdm_sub_district",
    "res_country",
    "res_country_state",
    "res_partner",
    "res_partner_category",
    "res_partner_industry",
    "res_partner_title",
    "res_users",
    "tcp_main_area",
    "tcp_main_area_sub",
    "tcp_main_news",
    "tcp_main_news_travel",
    "tcp_main_page",
    "tcp_main_product",
    "tcp_main_team",
    "tcp_mdm_case_type",
    "tcp_mdm_channel",
    "tcp_mdm_priority",
    "tcp_mdm_question",
    "tcp_mdm_question_sub",
    "tcp_mdm_service",
    "tcp_mdm_service_sub",
    "tcp_txn_case",
}

FIELD_TARGET_TABLE = {
    "assign_emp_id": "hr_employee",
    "attachment_id": "ir_attachment",
    "area_id": "tcp_main_area",
    "area_sub_id": "tcp_main_area_sub",
    "case_id": "tcp_txn_case",
    "case_type_id": "tcp_mdm_case_type",
    "channel_id": "tcp_mdm_channel",
    "department_id": "hr_department",
    "delegate_officer_id": "hr_employee",
    "delegate_team_id": "tcp_main_team",
    "emp_id": "hr_employee",
    "mail_message_id": "mail_message",
    "message_id": "mail_message",
    "owner_officer_id": "hr_employee",
    "owner_team_id": "tcp_main_team",
    "partner_id": "res_partner",
    "partner_case_id": "res_partner",
    "priority_id": "tcp_mdm_priority",
    "product_id": "tcp_main_product",
    "question_id": "tcp_mdm_question",
    "res_partner_id": "res_partner",
    "service_id": "tcp_mdm_service",
    "service_sub_id": "tcp_mdm_service_sub",
    "subproject_id": "tcp_mdm_service_sub",
    "team_id": "tcp_main_team",
    "user_id": "res_users",
    "uid": "res_users",
    "write_uid": "res_users",
    "create_uid": "res_users",
}

FIELD_TARGET_TABLE_BY_TABLE = {
    ("hr_employee", "parent_id"): "hr_employee",
    ("hr_employee", "coach_id"): "hr_employee",
    ("hr_employee", "user_id"): "res_users",
    ("res_partner", "parent_id"): "res_partner",
    ("res_partner", "commercial_partner_id"): "res_partner",
    ("res_users", "partner_id"): "res_partner",
    ("tcp_main_area", "area_parent_id"): "tcp_main_area",
    ("tcp_main_area", "subproject_id"): "tcp_mdm_service_sub",
    ("tcp_main_area_sub", "area_id"): "tcp_main_area",
    ("tcp_main_product", "owner_team_id"): "tcp_main_team",
    ("tcp_main_product", "owner_officer_id"): "hr_employee",
    ("tcp_main_product", "delegate_team_id"): "tcp_main_team",
    ("tcp_main_product", "delegate_officer_id"): "hr_employee",
    ("tcp_main_product", "product_id"): "tcp_mdm_service",
    ("tcp_main_product", "question_id"): "tcp_mdm_question",
    ("tcp_main_product_channel", "product_id"): "tcp_main_product",
    ("tcp_main_product_channel", "channel_id"): "tcp_mdm_channel",
    ("tcp_main_team_member", "team_id"): "tcp_main_team",
    ("tcp_main_team_member", "emp_id"): "hr_employee",
    ("tcp_mdm_priority", "project_id"): "tcp_mdm_service",
    ("tcp_mdm_priority", "case_type"): "tcp_mdm_case_type",
    ("tcp_mdm_priority_case_type_rel", "priority_id"): "tcp_mdm_priority",
    ("tcp_mdm_priority_case_type_rel", "case_type_id"): "tcp_mdm_case_type",
    ("tcp_mdm_service_dev", "service_id"): "tcp_mdm_service",
    ("tcp_mdm_service_sub", "service_id"): "tcp_mdm_service",
    ("tcp_txn_case", "service_id"): "tcp_mdm_service",
    ("tcp_txn_case", "service_sub_id"): "tcp_mdm_service_sub",
    ("tcp_txn_case", "area_id"): "tcp_main_area",
    ("tcp_txn_case", "area_sub_id"): "tcp_main_area_sub",
    ("tcp_txn_case", "owner_team_id"): "tcp_main_team",
    ("tcp_txn_case", "owner_officer_id"): "hr_employee",
    ("tcp_txn_case", "delegate_team_id"): "tcp_main_team",
    ("tcp_txn_case", "delegate_officer_id"): "hr_employee",
    ("tcp_txn_case", "priority_id"): "tcp_mdm_priority",
    ("tcp_txn_case_activity", "case_id"): "tcp_txn_case",
    ("tcp_txn_case_assign", "case_id"): "tcp_txn_case",
    ("tcp_txn_case_assign", "assign_emp_id"): "hr_employee",
    ("tcp_txn_case_assign_dev", "case_id"): "tcp_txn_case",
    ("tcp_txn_case_assign_dev", "assign_emp_id"): "hr_employee",
    ("tcp_txn_case_attach", "case_id"): "tcp_txn_case",
    ("tcp_txn_case_image", "case_id"): "tcp_txn_case",
    ("tcp_txn_case_chat", "case_id"): "tcp_txn_case",
    ("tcp_txn_case_chat", "employee_id"): "hr_employee",
    ("mail_followers", "partner_id"): "res_partner",
    ("mail_followers", "channel_id"): "mail_message",
    ("mail_message", "parent_id"): "mail_message",
    ("mail_message", "subtype_id"): "mail_message_subtype",
    ("mail_message", "mail_activity_type_id"): "mail_message_subtype",
    ("mail_message", "author_id"): "res_partner",
    ("mail_message", "mail_server_id"): "mail_message",
    ("mail_message_mail_channel_rel", "mail_channel_id"): "mail_message",
    ("mail_message_res_partner_rel", "res_partner_id"): "res_partner",
    ("mail_message_res_partner_starred_rel", "res_partner_id"): "res_partner",
    ("mail_message_subtype", "parent_id"): "mail_message_subtype",
    ("m2m_team_to_hr_emp_rel", "member_list_ids"): "hr_employee",
    ("m2m_team_to_hr_emp_rel", "team_list_ids"): "tcp_main_team",
    ("res_company_users_rel", "user_id"): "res_users",
    ("res_groups_users_rel", "uid"): "res_users",
    ("user_menu_rel", "user_id"): "res_users",
    ("user_report_rel", "user_id"): "res_users",
    ("case_management_report_tcp_main_area_rel", "tcp_main_area_id"): "tcp_main_area",
    ("case_summary_report_tcp_main_area_rel", "tcp_main_area_id"): "tcp_main_area",
    ("flow_to_area_m2m", "area_id"): "tcp_main_area",
    ("flow_to_area_m2m", "flow_id"): "tcp_main_product",
}

SKIP_FIELDS = {
    "password",
    "db_datas",
}

MAX_VALUE_LEN = 240
MAX_FIELDS_PER_DOC = 28


def first_non_empty(row: dict, *keys: str) -> str:
    for key in keys:
        value = base.clean_text(row.get(key))
        if value:
            return value
    return ""


def truncate(value: str, limit: int = MAX_VALUE_LEN) -> str:
    text = base.clean_text(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def stable_doc_id(table: str, row: dict) -> str:
    candidate = base.clean_text(row.get("id"))
    if candidate:
        return f"odoo_{table}_{candidate}"
    digest = hashlib.sha1(
        json.dumps(row, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()[:16]
    return f"odoo_{table}_{digest}"


def table_label(table: str, row: dict) -> str:
    if table == "hr_employee":
        return first_non_empty(row, "name", "work_email", "emp_seq", "id") or table
    if table == "res_users":
        return first_non_empty(row, "login", "id") or table
    if table == "res_partner":
        return first_non_empty(row, "name", "display_name", "email", "id") or table
    if table == "tcp_main_team":
        return " - ".join(
            [part for part in [first_non_empty(row, "team_code"), first_non_empty(row, "team_name_th", "team_name_en")] if part]
        ) or first_non_empty(row, "id") or table
    if table == "tcp_mdm_service":
        return " - ".join(
            [part for part in [first_non_empty(row, "service_code"), first_non_empty(row, "service_name")] if part]
        ) or first_non_empty(row, "id") or table
    if table == "tcp_mdm_service_sub":
        return " - ".join(
            [part for part in [first_non_empty(row, "service_sub_code"), first_non_empty(row, "service_sub_name")] if part]
        ) or first_non_empty(row, "id") or table
    if table == "tcp_txn_case":
        return " - ".join(
            [part for part in [first_non_empty(row, "case_ticket_id"), first_non_empty(row, "case_subject", "case_desc")] if part]
        ) or first_non_empty(row, "id") or table
    if table == "tcp_txn_case_activity":
        return " - ".join([part for part in [first_non_empty(row, "activity_status"), first_non_empty(row, "activity_date"), first_non_empty(row, "case_id")] if part]) or first_non_empty(row, "id") or table
    if table == "tcp_txn_case_attach":
        return first_non_empty(row, "attachment_name", "attachment_file", "case_id", "id") or table
    if table == "mail_message":
        return first_non_empty(row, "subject", "record_name", "id") or table
    if table == "ir_attachment":
        return first_non_empty(row, "name", "datas_fname", "res_name", "id") or table
    return first_non_empty(row, "name", "title", "code", "id") or table


def value_for_display(field: str, value) -> str:
    text = base.clean_text(value)
    if not text:
        return ""
    if field in SKIP_FIELDS:
        return ""
    return truncate(text)


def resolve_lookup(lookups: dict, table: str | None, raw_value: str) -> str:
    if not table:
        return ""
    return lookups.get(table, {}).get(raw_value, "")


def target_table_for_field(table: str, field: str) -> str | None:
    return FIELD_TARGET_TABLE_BY_TABLE.get((table, field)) or FIELD_TARGET_TABLE.get(field)


def build_lookup_maps(parsed: dict) -> dict:
    lookups: dict = {}
    for table in LOOKUP_TABLES:
        rows = parsed.get(table, []) or []
        table_map = {}
        for row in rows:
            row_id = base.clean_text(row.get("id"))
            if row_id:
                table_map[row_id] = table_label(table, row)
        if table_map:
            lookups[table] = table_map
    return lookups


def build_doc_content(table: str, row: dict, lookups: dict) -> str:
    doc_id = base.clean_text(row.get("id")) or stable_doc_id(table, row)
    display = table_label(table, row)

    lines = [
        "Document Type: Odoo Knowledge Record",
        f"Source Table: {table}",
        f"Record ID: {doc_id}",
        f"Display: {display}",
    ]

    linked = []
    for field, value in row.items():
        if field in {"id", "create_uid", "write_uid", "create_date", "write_date"}:
            continue
        raw = base.clean_text(value)
        if not raw:
            continue
        target = target_table_for_field(table, field)
        if field.endswith("_id") or field.endswith("_ids") or target:
            label = resolve_lookup(lookups, target, raw)
            if target:
                linked.append(f"- {field}: {raw}" + (f" -> {target} | {label}" if label else f" -> {target}"))
            else:
                linked.append(f"- {field}: {raw}")

    if linked:
        lines.extend(["", "Linked IDs:"])
        lines.extend(linked[:32])

    field_lines = []
    for field, value in row.items():
        if field in {"id", "create_uid", "write_uid", "create_date", "write_date"}:
            continue
        display_value = value_for_display(field, value)
        if not display_value:
            continue
        field_lines.append(f"- {field}: {display_value}")
        if len(field_lines) >= MAX_FIELDS_PER_DOC:
            break

    if field_lines:
        lines.extend(["", "Fields:"])
        lines.extend(field_lines)

    return "\n".join(lines).strip()


def build_deep_knowledge_rows(parsed: dict) -> list[dict]:
    lookups = build_lookup_maps(parsed)
    rows: list[dict] = []

    for table in sorted(EXTRA_TABLES):
        table_rows = parsed.get(table, []) or []
        if not table_rows:
            continue

        is_relation = table in RELATION_TABLES
        category = "Helpdeck Link" if is_relation else "Helpdeck Raw"

        for row in table_rows:
            doc_id = stable_doc_id(table, row)
            title = f"[{table}] {table_label(table, row)}"
            tags = [
                "source:odoo",
                f"table:{table}",
                f"id:{base.clean_text(row.get('id')) or doc_id}",
            ]
            for field in row.keys():
                if (field.endswith("_id") or field.endswith("_ids")) and field not in {"create_uid", "write_uid"}:
                    tags.append(f"link:{field}")
            rows.append(
                {
                    "id": doc_id,
                    "title": title[:180],
                    "content": build_doc_content(table, row, lookups),
                    "category": category,
                    "tags": ",".join(dict.fromkeys(tags)),
                    "author": resolve_lookup(lookups, "res_users", base.clean_text(row.get("create_uid"))) or "Odoo Import",
                    "created_at": first_non_empty(row, "create_date", "date", "attachment_date") or "2026-05-07 00:00:00",
                    "updated_at": first_non_empty(row, "write_date", "create_date", "date", "attachment_date") or "2026-05-07 00:00:00",
                }
            )

    return rows


def ensure_pg_schema(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS hd_master (
              id TEXT PRIMARY KEY,
              table_name TEXT NOT NULL,
              code TEXT DEFAULT '',
              name TEXT NOT NULL,
              extra TEXT DEFAULT '{}',
              active BOOLEAN DEFAULT TRUE,
              sort_order INTEGER DEFAULT 0,
              created_at TIMESTAMPTZ DEFAULT now(),
              updated_at TIMESTAMPTZ DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_articles (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              content TEXT,
              category TEXT,
              tags TEXT DEFAULT '',
              author TEXT,
              created_at TIMESTAMPTZ DEFAULT now(),
              updated_at TIMESTAMPTZ DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS helpdesk_tickets (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              description TEXT,
              project TEXT,
              bug_type TEXT,
              module TEXT,
              location TEXT,
              status TEXT DEFAULT 'open',
              assigned_dev TEXT,
              created_by TEXT,
              odoo_ticket_id TEXT,
              attachment_key TEXT,
              created_at TIMESTAMPTZ DEFAULT now(),
              updated_at TIMESTAMPTZ DEFAULT now(),
              extra TEXT DEFAULT '{}'
            )
            """
        )
        cur.execute("ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS extra TEXT DEFAULT '{}' ")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_hd_master_table_name ON hd_master(table_name)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_hd_master_lookup ON hd_master(table_name, sort_order, name)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_project ON helpdesk_tickets(project)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_odoo_ticket_id ON helpdesk_tickets(odoo_ticket_id)")
    conn.commit()


def import_bundle_to_pg(bundle: base.ImportBundle, pg_url: str) -> None:
    conn = psycopg2.connect(pg_url)
    try:
        ensure_pg_schema(conn)
        with conn.cursor() as cur:
            for table_name in bundle.hd_rows:
                cur.execute(
                    "DELETE FROM hd_master WHERE table_name=%s AND id LIKE 'odoo_%%'",
                    (table_name,),
                )
            cur.execute("DELETE FROM knowledge_articles WHERE id LIKE 'odoo_%%'")
            cur.execute("DELETE FROM helpdesk_tickets WHERE id LIKE 'odoo_%%'")

            hd_rows = [
                (
                    row["id"],
                    row["table_name"],
                    row["code"],
                    row["name"],
                    row["extra"],
                    bool(row["active"]),
                )
                for rows in bundle.hd_rows.values()
                for row in rows
            ]
            execute_batch(
                cur,
                """
                INSERT INTO hd_master
                (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, 0, now(), now())
                ON CONFLICT (id) DO UPDATE SET
                  table_name = EXCLUDED.table_name,
                  code = EXCLUDED.code,
                  name = EXCLUDED.name,
                  extra = EXCLUDED.extra,
                  active = EXCLUDED.active,
                  updated_at = now()
                """,
                hd_rows,
                page_size=500,
            )

            execute_batch(
                cur,
                """
                INSERT INTO knowledge_articles
                (id, title, content, category, tags, author, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s::timestamptz, %s::timestamptz)
                ON CONFLICT (id) DO UPDATE SET
                  title = EXCLUDED.title,
                  content = EXCLUDED.content,
                  category = EXCLUDED.category,
                  tags = EXCLUDED.tags,
                  author = EXCLUDED.author,
                  updated_at = EXCLUDED.updated_at
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
                page_size=200,
            )

            execute_batch(
                cur,
                """
                INSERT INTO helpdesk_tickets
                (id, title, description, project, bug_type, status, assigned_dev, created_by, odoo_ticket_id, created_at, updated_at, extra)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz, %s::timestamptz, %s)
                ON CONFLICT (id) DO UPDATE SET
                  title = EXCLUDED.title,
                  description = EXCLUDED.description,
                  project = EXCLUDED.project,
                  bug_type = EXCLUDED.bug_type,
                  status = EXCLUDED.status,
                  assigned_dev = EXCLUDED.assigned_dev,
                  created_by = EXCLUDED.created_by,
                  odoo_ticket_id = EXCLUDED.odoo_ticket_id,
                  updated_at = EXCLUDED.updated_at,
                  extra = EXCLUDED.extra
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
                page_size=200,
            )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump-dir", default=str(base.DEFAULT_DUMP_DIR))
    parser.add_argument("--pg-url", default="postgres://postgres:123456@localhost:5432/Betime_DB")
    args = parser.parse_args()

    dump_dir = Path(args.dump_dir)
    dump_sql = dump_dir / "dump.sql"
    if not dump_sql.exists():
        raise SystemExit(f"Dump not found: {dump_sql}")

    print(f"Reading dump from: {dump_sql}")
    sql_text = base.decode_dump(dump_sql)

    target_tables = sorted(set(base.TARGET_TABLES) | EXTRA_TABLES)
    print(f"Parsing {len(target_tables)} tables...")
    parsed = base.parse_copy_rows(sql_text, target_tables)

    bundle = base.build_bundle(parsed)
    extra_rows = build_deep_knowledge_rows(parsed)
    bundle.knowledge_rows.extend(extra_rows)
    bundle.summary["extra_knowledge_articles"] = len(extra_rows)
    bundle.summary["knowledge_articles_total"] = len(bundle.knowledge_rows)

    print("Bundle summary:")
    for key, value in bundle.summary.items():
        print(f"  - {key}: {value}")

    import_bundle_to_pg(bundle, args.pg_url)
    print("Import completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
