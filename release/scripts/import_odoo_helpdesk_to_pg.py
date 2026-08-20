"""
Import Odoo helpdesk dump directly into the main PostgreSQL database.

This reuses the parsing/build logic from migrate_helpdesk_from_odoo.py and
loads:
- hd_master rows for hd_projects / hd_sub_projects / hd_teams / hd_users
- knowledge_articles for project/team/user profiles and case knowledge
- helpdesk_tickets for recent/similar ticket lookup in Chat V2
"""

from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import urlparse

import psycopg2
from psycopg2.extras import execute_batch

import migrate_helpdesk_from_odoo as odoo_migrate


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
              updated_at TIMESTAMPTZ DEFAULT now()
            )
            """
        )
        cur.execute("ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS extra TEXT DEFAULT '{}'")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_hd_master_table_name ON hd_master(table_name)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_hd_master_lookup ON hd_master(table_name, sort_order, name)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_project ON helpdesk_tickets(project)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_odoo_ticket_id ON helpdesk_tickets(odoo_ticket_id)")
    conn.commit()


def import_bundle_to_pg(bundle: odoo_migrate.ImportBundle, pg_url: str) -> None:
    conn = psycopg2.connect(pg_url)
    try:
        ensure_pg_schema(conn)
        with conn.cursor() as cur:
            for table_name in bundle.hd_rows:
                cur.execute(
                    "DELETE FROM hd_master WHERE table_name=%s AND id LIKE 'odoo_%%'",
                    (table_name,),
                )
            cur.execute("DELETE FROM knowledge_articles WHERE id LIKE 'odoo_%'")
            cur.execute("DELETE FROM helpdesk_tickets WHERE id LIKE 'odoo_%'")

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
    parser.add_argument("--dump-dir", default=str(odoo_migrate.DEFAULT_DUMP_DIR))
    parser.add_argument("--pg-url", default="postgres://postgres:123456@localhost:5432/Betime_DB")
    args = parser.parse_args()

    dump_dir = Path(args.dump_dir)
    dump_sql = dump_dir / "dump.sql"
    if not dump_sql.exists():
        raise SystemExit(f"Dump not found: {dump_sql}")

    parsed_url = urlparse(args.pg_url)
    print(f"Reading dump from: {dump_sql}")
    print(f"Importing into   : {parsed_url.hostname}:{parsed_url.port or 5432}/{parsed_url.path.lstrip('/')}")

    sql_text = odoo_migrate.decode_dump(dump_sql)
    parsed = odoo_migrate.parse_copy_rows(sql_text, odoo_migrate.TARGET_TABLES)
    bundle = odoo_migrate.build_bundle(parsed)

    print("Bundle summary:")
    for key, value in bundle.summary.items():
        print(f"  - {key}: {value}")

    import_bundle_to_pg(bundle, args.pg_url)
    print("Import completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
