"""
Sync Odoo employee ids to a local lookup table for fast name resolution.

Usage:
  python scripts/sync_odoo_employee_map_to_pg.py --pg-url "postgres://postgres:123456@localhost:5432/Betime_DB"
"""

from __future__ import annotations

import argparse

import psycopg2


def run(pg_url: str) -> None:
    conn = psycopg2.connect(pg_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS odoo_employee_map (
                  odoo_employee_id TEXT PRIMARY KEY,
                  employee_name TEXT NOT NULL,
                  employee_ref TEXT DEFAULT '',
                  source_user_id TEXT DEFAULT '',
                  email TEXT DEFAULT '',
                  updated_at TIMESTAMPTZ DEFAULT now()
                )
                """
            )
            cur.execute(
                """
                INSERT INTO odoo_employee_map (odoo_employee_id, employee_name, employee_ref, source_user_id, email, updated_at)
                SELECT
                  extra::jsonb->>'source_id' AS odoo_employee_id,
                  name AS employee_name,
                  '' AS employee_ref,
                  id AS source_user_id,
                  COALESCE(extra::jsonb->>'email', '') AS email,
                  now() AS updated_at
                FROM hd_master
                WHERE table_name='hd_users'
                  AND extra LIKE '{%%'
                  AND COALESCE(extra::jsonb->>'source_id', '') <> ''
                ON CONFLICT (odoo_employee_id) DO UPDATE SET
                  employee_name = EXCLUDED.employee_name,
                  source_user_id = EXCLUDED.source_user_id,
                  email = EXCLUDED.email,
                  updated_at = now()
                """
            )
            cur.execute("SELECT COUNT(*) FROM odoo_employee_map")
            total = cur.fetchone()[0]
        conn.commit()
        print(f"ok: synced odoo_employee_map rows={total}")
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pg-url",
        default="postgres://postgres:123456@localhost:5432/Betime_DB",
        help="PostgreSQL connection URL",
    )
    args = parser.parse_args()
    run(args.pg_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
