#!/usr/bin/env python3
"""
Import Odoo-exported Excel master data into the local BETIME D1 sqlite.

This script is intentionally conservative:
- it keeps the existing Odoo dump import intact;
- it imports the provided Excel files into hd_master;
- it adds lightweight placeholder criteria rows so sub-criteria can resolve.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import subprocess
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import psycopg2
from psycopg2.extras import execute_values


ROOT = Path(r"D:\betime solution\All_in_betime\BETIME")
DEFAULT_SQLITE = ROOT / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject" / "b9467e4a305472534c444b3e818705c1b0a4bec7a6756eeee155070e681be8f1.sqlite"
DEFAULT_FILE_CANDIDATES = [
    [Path(r"C:\Users\wave\Downloads\hr.employee.xls"), Path(r"C:\Users\wave\Downloads\hr.employee.xlsx")],
    [Path(r"C:\Users\wave\Downloads\tcp.main.team.xls"), Path(r"C:\Users\wave\Downloads\tcp.main.team.xlsx")],
    [Path(r"C:\Users\wave\Downloads\db import\mdm.criteria.xls"), Path(r"C:\Users\wave\Downloads\mdm.criteria.xlsx")],
    [Path(r"C:\Users\wave\Downloads\mdm.postcode.csv"), Path(r"C:\Users\wave\Downloads\db import\mdm.postcode.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\tcp.main.product.xls"), Path(r"C:\Users\wave\Downloads\tcp.main.product.xlsx")],
    [Path(r"C:\Users\wave\Downloads\db import\tcp.main.area.xls"), Path(r"C:\Users\wave\Downloads\tcp.main.area.xlsx")],
    [Path(r"C:\Users\wave\Downloads\db import\tcp.main.area.sub.xls"), Path(r"C:\Users\wave\Downloads\tcp.main.area.sub.xlsx")],
    [Path(r"C:\Users\wave\Downloads\db import\tcp.mdm.channel.xls"), Path(r"C:\Users\wave\Downloads\tcp.mdm.channel.csv")],
    [Path(r"C:\Users\wave\Downloads\db import\tcp.mdm.service.dev.xls"), Path(r"C:\Users\wave\Downloads\tcp.mdm.service.dev.csv")],
    [Path(r"C:\Users\wave\Downloads\db import\res.partner.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\config.generate.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\tcp.mdm.priority.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\mdm.sub.criteria.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\mdm.province.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\mdm.district.xls")],
    [Path(r"C:\Users\wave\Downloads\db import\mdm.sub.district.xls")],
]


def choose_existing_path(candidates: List[Path]) -> Path | None:
    for path in candidates:
        if path.exists():
            return path
    return None


DEFAULT_FILES = [path for path in (choose_existing_path(group) for group in DEFAULT_FILE_CANDIDATES) if path]

TARGETS = {
    "tcp.mdm.channel.xls": "hd_channels",
    "tcp.mdm.channel.xlsx": "hd_channels",
    "tcp.mdm.channel.csv": "hd_channels",
    "tcp.main.team.xls": "hd_teams",
    "tcp.main.team.xlsx": "hd_teams",
    "tcp.main.team (2).xls": "hd_teams",
    "tcp.main.team (2).xlsx": "hd_teams",
    "tcp.main.product.xls": "hd_flow_products",
    "tcp.main.product.xlsx": "hd_flow_products",
    "tcp.main.product.csv": "hd_flow_products",
    "tcp.main.area.xls": "hd_flow_areas",
    "tcp.main.area.xlsx": "hd_flow_areas",
    "tcp.main.area.csv": "hd_flow_areas",
    "tcp.main.area.sub.xls": "hd_flow_case_types",
    "tcp.main.area.sub.xlsx": "hd_flow_case_types",
    "tcp.main.area.sub.csv": "hd_flow_case_types",
    "tcp.mdm.service.dev.xls": "hd_projects_dev",
    "tcp.mdm.service.dev.xlsx": "hd_projects_dev",
    "tcp.mdm.service.dev.csv": "hd_projects_dev",
    "hr.employee.xls": "hd_users",
    "hr.employee.xlsx": "hd_users",
    "res.partner.xls": "hd_contacts",
    "res.partner.xlsx": "hd_contacts",
    "config.generate.xls": "hd_configs",
    "config.generate.xlsx": "hd_configs",
    "tcp.mdm.priority.xls": "hd_sla",
    "tcp.mdm.priority.xlsx": "hd_sla",
    "mdm.criteria.xls": "hd_criteria",
    "mdm.criteria.xlsx": "hd_criteria",
    "mdm.sub.criteria.xls": "hd_sub_criteria",
    "mdm.sub.criteria.xlsx": "hd_sub_criteria",
    "mdm.province.xls": "hd_provinces",
    "mdm.province.xlsx": "hd_provinces",
    "mdm.district.xls": "hd_districts",
    "mdm.district.xlsx": "hd_districts",
    "mdm.sub.district.xls": "hd_subdistricts",
    "mdm.sub.district.xlsx": "hd_subdistricts",
    "mdm.postcode.xls": "hd_postcodes",
    "mdm.postcode.xlsx": "hd_postcodes",
    "mdm.postcode.csv": "hd_postcodes",
}


def clean_text(value) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r", "\n").replace("\t", " ").strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def slugify(value: str) -> str:
    text = clean_text(value)
    text = re.sub(r"[^A-Za-z0-9ก-๙]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "row"


def extract_ref_id(value: str) -> str:
    text = clean_text(value)
    if not text:
        return ""
    for pattern in (
        r"hr_employee_(\d+)_",
        r"tcp_mdm_service_(\d+)_",
        r"tcp_mdm_service_sub_(\d+)_",
        r"mdm_province_(\d+)_",
        r"mdm_district_(\d+)_",
        r"mdm_sub_district_(\d+)_",
        r"mdm_postcode_(\d+)_",
        r"mdm_criteria_(\d+)_",
    ):
        m = re.search(pattern, text)
        if m:
            return m.group(1)
    return text


def parse_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    text = clean_text(value).lower()
    return text in {"1", "true", "t", "yes", "y", "active"}


def row_value(row: Dict, *names: str) -> str:
    lookup = {str(k).strip().lower(): v for k, v in row.items()}
    for name in names:
        key = str(name).strip().lower()
        if key in lookup and clean_text(lookup[key]):
            return clean_text(lookup[key])
    return ""


def row_json(base: Dict) -> str:
    return json.dumps(base, ensure_ascii=False)


def run_xlsx_reader(file_path: Path) -> List[Dict]:
    js = r"""
const xlsx = require('xlsx');
const file = process.argv[1];
const wb = xlsx.readFile(file);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
process.stdout.write(JSON.stringify(rows));
"""
    proc = subprocess.run(
        ["node", "-e", js, str(file_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(ROOT),
        check=True,
    )
    return json.loads(proc.stdout or "[]")


def read_csv_rows(file_path: Path) -> List[Dict]:
    encodings = ("utf-8-sig", "utf-8", "cp874")
    last_error = None
    for encoding in encodings:
        try:
            with file_path.open("r", encoding=encoding, newline="") as fh:
                sample = fh.read(4096)
                fh.seek(0)
                delimiter = ","
                if ";" in sample and sample.count(";") > sample.count(","):
                    delimiter = ";"
                reader = csv.DictReader(fh, delimiter=delimiter)
                rows = []
                for row in reader:
                    if not row:
                        continue
                    cleaned = {str(k).strip(): v for k, v in row.items() if k is not None}
                    rows.append(cleaned)
                return rows
        except UnicodeDecodeError as err:
            last_error = err
            continue
    if last_error:
        raise last_error
    return []


def read_tabular_rows(file_path: Path) -> List[Dict]:
    suffix = file_path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        return read_csv_rows(file_path)
    return run_xlsx_reader(file_path)


def normalize_channels(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        code = row_value(row, "Channel Code", "channel code", "code")
        name = row_value(row, "Channel Name", "channel name", "name") or code
        out.append({
            "id": f"odoo_excel_hd_channels_{slugify(ext_id or code or idx)}",
            "table_name": "hd_channels",
            "code": code or ext_id,
            "name": name or code or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "channel_code": code,
                "channel_name": name,
                "channel_description": row_value(row, "Channel Description", "channel description"),
            }),
            "active": 1 if parse_bool(row_value(row, "Active", "active")) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_flow_products(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        active = row_value(row, "Active", "active")
        area_ref = row_value(row, "Area", "area")
        flow_code = row_value(row, "Flow Code", "flow code", "code")
        flow_name = row_value(row, "Flow Name", "flow name", "name") or flow_code
        out.append({
            "id": f"odoo_excel_hd_flow_products_{slugify(ext_id or flow_code or idx)}",
            "table_name": "hd_flow_products",
            "code": flow_code or ext_id,
            "name": flow_name or flow_code or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "area_id": area_ref,
                "area_ref": area_ref,
                "flow_code": flow_code,
                "flow_name": flow_name,
            }),
            "active": 1 if parse_bool(active) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_flow_areas(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        active = row_value(row, "Area Active", "active")
        area_name = row_value(row, "Area Name", "area name", "title")
        area_navigate_page = row_value(row, "Area Navigate Page", "area navigate page", "navigate page")
        project_ref = row_value(row, "Project / Service", "project / service", "project", "service")
        sequence = row_value(row, "Sequence", "sequence")
        title = row_value(row, "Title", "title")
        title_sub = row_value(row, "Title Sub", "title sub")
        version = row_value(row, "Version", "version")
        out.append({
            "id": f"odoo_excel_hd_flow_areas_{slugify(ext_id or area_name or idx)}",
            "table_name": "hd_flow_areas",
            "code": area_name or title or ext_id,
            "name": title_sub or title or area_name or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "area_name": area_name,
                "area_navigate_page": area_navigate_page,
                "project_id": extract_ref_id(project_ref),
                "project_ref": project_ref,
                "sequence": sequence,
                "title": title,
                "title_sub": title_sub,
                "version": version,
            }),
            "active": 1 if parse_bool(active) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_flow_case_types(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        active = row_value(row, "Case Type Active", "active")
        area_ref = row_value(row, "Area", "area")
        detail = row_value(row, "Case Type Detail", "case type detail", "detail")
        name = row_value(row, "Case Type Name", "case type name", "name")
        sequence = row_value(row, "Case Type Sequence", "case type sequence", "sequence")
        project_ref = row_value(row, "Project / Service", "project / service", "project", "service")
        version = row_value(row, "Version", "version")
        out.append({
            "id": f"odoo_excel_hd_flow_case_types_{slugify(ext_id or name or idx)}",
            "table_name": "hd_flow_case_types",
            "code": name or ext_id,
            "name": detail or name or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "area_id": area_ref,
                "area_ref": area_ref,
                "project_id": extract_ref_id(project_ref),
                "project_ref": project_ref,
                "case_type_name": name,
                "case_type_detail": detail,
                "case_type_sequence": sequence,
                "version": version,
            }),
            "active": 1 if parse_bool(active) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_teams(rows: List[Dict]) -> List[Dict]:
    def optional(row: Dict, *names: str) -> str:
        value = row_value(row, *names)
        if value in {"0", "0.0", "-", "none", "null"}:
            return ""
        return value

    def add_unique(values: List[str], value: str) -> None:
        text = clean_text(value)
        if not text or text in values:
            return
        values.append(text)

    groups: Dict[str, Dict] = {}
    order: List[str] = []

    for idx, row in enumerate(rows, start=1):
        # Each row can represent one member of the same team.
        ext_id = optional(row, "รหัสจากภายนอก", "external id", "external code", "id")
        team_code = optional(row, "Team Code", "team code", "code")
        team_name_th = optional(row, "Team Name TH", "team name th", "team name")
        team_name_en = optional(row, "Team Name EN", "team name en")
        owner_id = optional(row, "Owner Team", "owner team")
        owner_name = optional(row, "Owner Team/ชื่อที่ใช้แสดง", "owner team/ชื่อที่ใช้แสดง") or owner_id
        remark = optional(row, "Remark", "remark")
        active = optional(row, "Active", "active")
        is_active = not active or active.lower() not in {"0", "false", "inactive", "no"}
        member_ref = optional(row, "Team Member", "team member")
        member_name = optional(row, "Team Member/ชื่อ", "team member/ชื่อ")
        member_display_name = optional(row, "Team Member/ชื่อที่ใช้แสดง", "team member/ชื่อที่ใช้แสดง")
        member_helpdesk_ref = optional(row, "Team Member/Team HelpDesk", "team member/team helpdesk")
        member_helpdesk_display_name = optional(row, "Team Member/Team HelpDesk/Display Name", "team member/team helpdesk/display name")
        member_helpdesk_id = optional(row, "Team Member/Team HelpDesk/ID", "team member/team helpdesk/id")
        key = member_helpdesk_id or member_helpdesk_display_name or team_code or ext_id or team_name_th or team_name_en or f"row_{idx}"

        if key not in groups:
            groups[key] = {
                "id": f"odoo_excel_hd_teams_{slugify(key)}",
                "table_name": "hd_teams",
                "code": team_code or member_helpdesk_display_name or member_helpdesk_id or ext_id or key,
                "name": team_name_th or team_name_en or team_code or member_helpdesk_display_name or member_helpdesk_id or ext_id or key,
                "extra": {
                    "source": "odoo",
                    "source_id": ext_id,
                    "external_id": ext_id,
                    "team_helpdesk_id": member_helpdesk_id,
                    "team_helpdesk_display_name": member_helpdesk_display_name,
                    "team_code": team_code,
                    "team_name_th": team_name_th,
                    "team_name_en": team_name_en,
                    "owner_id": owner_id,
                    "owner_name": owner_name,
                    "remark": remark,
                    "member_count": 0,
                    "team_member_refs": [],
                    "team_member_names": [],
                    "team_member_display_names": [],
                    "team_member_team_helpdesk_refs": [],
                    "team_member_team_helpdesk_display_names": [],
                    "team_member_team_helpdesk_ids": [],
                    "member_ids": [],
                    "member_names": [],
                    "member_codes": [],
                    "member_emails": [],
                },
                "active": 1 if is_active else 0,
                "sort_order": idx,
            }
            order.append(key)

        entry = groups[key]
        extra = entry["extra"]
        if team_name_th:
            extra["team_name_th"] = team_name_th
        if team_name_en:
            extra["team_name_en"] = team_name_en
        if team_code:
            extra["team_code"] = team_code
        if member_helpdesk_id:
            extra["team_helpdesk_id"] = member_helpdesk_id
        if member_helpdesk_display_name:
            extra["team_helpdesk_display_name"] = member_helpdesk_display_name
        if owner_id:
            extra["owner_id"] = owner_id
        if owner_name:
            extra["owner_name"] = owner_name
        if remark:
            extra["remark"] = remark
        entry["active"] = 1 if is_active else 0

        add_unique(extra["team_member_refs"], member_ref)
        add_unique(extra["team_member_names"], member_name)
        add_unique(extra["team_member_display_names"], member_display_name)
        add_unique(extra["team_member_team_helpdesk_refs"], member_helpdesk_ref)
        add_unique(extra["team_member_team_helpdesk_display_names"], member_helpdesk_display_name)
        add_unique(extra["team_member_team_helpdesk_ids"], member_helpdesk_id)
        add_unique(extra["member_ids"], member_ref)
        add_unique(extra["member_names"], member_name or member_display_name or member_ref)
        add_unique(extra["member_codes"], member_ref)
        if member_ref and "@" in member_ref:
            add_unique(extra["member_emails"], member_ref)
        elif member_display_name and "@" in member_display_name:
            add_unique(extra["member_emails"], member_display_name)
        extra["member_count"] = len(extra["team_member_refs"])

    return [
        {
            "id": entry["id"],
            "table_name": entry["table_name"],
            "code": entry["code"],
            "name": entry["name"],
            "extra": row_json(entry["extra"]),
            "active": entry["active"],
            "sort_order": entry["sort_order"],
        }
        for key in order
        for entry in [groups[key]]
        if entry["code"] or entry["name"]
    ]


def normalize_projects_dev(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        dev_ref = row_value(row, "Project Dev", "project dev", "dev", "employee", "รหัสพนักงาน")
        proj_ref = row_value(row, "Project", "project", "โปรเจกต์")
        emp_num = re.search(r"hr_employee_(\d+)_", dev_ref)
        employee_id = emp_num.group(1) if emp_num else clean_text(dev_ref)
        project_ref = extract_ref_id(proj_ref)
        out.append({
            "id": f"odoo_excel_hd_projects_dev_{slugify(ext_id or employee_id or idx)}",
            "table_name": "hd_projects_dev",
            "code": employee_id,
            "name": dev_ref or employee_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "employee_ref": dev_ref,
                "employee_id": employee_id,
                "parent_project": project_ref,
                "parent_project_ref": proj_ref,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_users(rows: List[Dict]) -> List[Dict]:
    def optional(row: Dict, *names: str) -> str:
        value = row_value(row, *names)
        if value in {"0", "0.0", "-", "none", "null"}:
            return ""
        return value

    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = optional(row, "รหัสจากภายนอก", "external id", "external code", "id")
        name = optional(row, "ชื่อ", "full name", "name", "user name")
        email = optional(row, "อีเมลที่ทำงาน", "work email", "email", "อีเมล")
        login = optional(row, "login", "username", "user login") or email
        position = optional(row, "ตำแหน่ง")
        job_title = optional(row, "ตำแหน่งงาน", "job title", "position")
        department_id = optional(row, "แผนก", "department", "department id")
        manager_employee_id = optional(row, "ผู้จัดการ", "manager_employee_id", "manager id", "หัวหน้า")
        work_phone = optional(row, "โทรศัพท์ที่ทำงาน", "work phone", "phone")
        mobile_phone = optional(row, "มือถือ", "mobile phone", "mobile")
        work_location = optional(row, "สถานที่ทำงาน", "work location", "location")
        team_helpdesk_ref = optional(row, "Team HelpDesk", "team helpdesk")
        team_helpdesk_display_name = optional(row, "Team HelpDesk/Display Name", "team helpdesk/display name")
        team_helpdesk_id = optional(row, "Team HelpDesk/ID", "team helpdesk/id")
        employee_documents = optional(row, "Employee Documents", "employee documents")
        code = email or ext_id or name
        out.append({
            "id": f"odoo_excel_hd_users_{slugify(ext_id or email or name or idx)}",
            "table_name": "hd_users",
            "code": code,
            "name": name or email or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "email": email,
                "login": login,
                "position": position,
                "job_title": job_title,
                "department_id": department_id,
                "manager_employee_id": manager_employee_id,
                "work_phone": work_phone,
                "mobile_phone": mobile_phone,
                "work_location": work_location,
                "team_helpdesk_ref": team_helpdesk_ref,
                "team_helpdesk_display_name": team_helpdesk_display_name,
                "team_helpdesk_id": team_helpdesk_id,
                "employee_documents": employee_documents,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_contacts(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        name = row_value(row, "ชื่อที่ใช้แสดง", "display name", "name")
        email = row_value(row, "อีเมล", "email", "e-mail")
        phone = row_value(row, "โทรศัพท์", "phone")
        mobile = row_value(row, "มือถือ", "mobile")
        out.append({
            "id": f"odoo_excel_hd_contacts_{slugify(ext_id or email or name or idx)}",
            "table_name": "hd_contacts",
            "code": ext_id or email or name,
            "name": name or email or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "display_name": name,
                "email": email,
                "phone": phone,
                "mobile": mobile,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_configs(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        app_name = row_value(row, "App Name", "app name", "ชื่อแอป", "name")
        out.append({
            "id": f"odoo_excel_hd_configs_{slugify(ext_id or app_name or idx)}",
            "table_name": "hd_configs",
            "code": app_name or ext_id,
            "name": app_name or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "app_name": app_name,
                "remark": row_value(row, "Remark", "remark", "remarks", "หมายเหตุ"),
                "running_number": row_value(row, "Running Number", "running number"),
            }),
            "active": 1 if parse_bool(row_value(row, "Active", "active")) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_sla(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        priority = row_value(row, "Priority", "priority", "priority level", "ระดับความสำคัญ")
        name = row_value(row, "Priority Name", "priority name", "sla name", "name") or priority
        project_ref = row_value(row, "Project", "project", "โปรเจกต์")
        out.append({
            "id": f"odoo_excel_hd_sla_{slugify(ext_id or priority or idx)}",
            "table_name": "hd_sla",
            "code": priority or ext_id,
            "name": name or priority or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "project_id": extract_ref_id(project_ref),
                "project_ref": project_ref,
                "priority_level": priority,
                "priority_name": name or priority,
                "priority_detail": row_value(row, "Priority Detail", "priority detail", "detail", "รายละเอียด"),
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_sub_criteria(rows: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
    out = []
    criteria_refs: List[str] = []
    seen = set()
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        name = row_value(row, "Sub Criteria Name", "sub criteria name", "name")
        criteria_ref = row_value(row, "Criteria", "criteria")
        if criteria_ref and criteria_ref not in seen:
            seen.add(criteria_ref)
            criteria_refs.append(criteria_ref)
        out.append({
            "id": f"odoo_excel_hd_sub_criteria_{slugify(ext_id or name or idx)}",
            "table_name": "hd_sub_criteria",
            "code": name or ext_id,
            "name": name or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "criteria_id": criteria_ref,
                "sub_criteria_name": name,
                "sequence": row_value(row, "Sequence", "sequence"),
            }),
            "active": 1 if parse_bool(row_value(row, "Active", "active")) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]], criteria_refs


def normalize_criteria(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        name = row_value(row, "Criteria Name", "criteria name", "name")
        out.append({
            "id": f"odoo_excel_hd_criteria_{slugify(ext_id or name or idx)}",
            "table_name": "hd_criteria",
            "code": name or ext_id,
            "name": name or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "criteria_name": name,
                "sequence": row_value(row, "Sequence", "sequence"),
            }),
            "active": 1 if parse_bool(row_value(row, "Active", "active")) else 0,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_provinces(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        code = row_value(row, "รหัสจังหวัด", "province code", "code")
        name_th = row_value(row, "ชื่อจังหวัดภาษาไทย", "province name thai", "name")
        name_en = row_value(row, "ชื่อจังหวัดภาษาอังกฤษ", "province name english", "en name")
        out.append({
            "id": f"odoo_excel_hd_provinces_{slugify(ext_id or code or idx)}",
            "table_name": "hd_provinces",
            "code": code or ext_id,
            "name": name_th or name_en or code or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "province_code": code,
                "province_name_th": name_th,
                "province_name_en": name_en,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_districts(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        code = row_value(row, "รหัสอำเภอ", "district code", "code")
        province_ref = row_value(row, "จังหวัด", "province")
        name_th = row_value(row, "ชื่ออำเภอภาษาไทย", "district name thai", "name")
        name_en = row_value(row, "ชื่ออำเภอภาษาอังกฤษ", "district name english", "en name")
        out.append({
            "id": f"odoo_excel_hd_districts_{slugify(ext_id or code or idx)}",
            "table_name": "hd_districts",
            "code": code or ext_id,
            "name": name_th or name_en or code or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "province_id": province_ref,
                "district_code": code,
                "district_name_th": name_th,
                "district_name_en": name_en,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_subdistricts(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        code = row_value(row, "รหัสตำบล", "sub district code", "code")
        province_ref = row_value(row, "จังหวัด", "province")
        district_ref = row_value(row, "อำเภอ", "district")
        name_th = row_value(row, "ชื่อตำบลภาษาไทย", "subdistrict name thai", "name")
        name_en = row_value(row, "ชื่อตำบลภาษาอังกฤษ", "subdistrict name english", "en name")
        out.append({
            "id": f"odoo_excel_hd_subdistricts_{slugify(ext_id or code or idx)}",
            "table_name": "hd_subdistricts",
            "code": code or ext_id,
            "name": name_th or name_en or code or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "province_id": province_ref,
                "district_id": district_ref,
                "subdistrict_code": code,
                "subdistrict_name_th": name_th,
                "subdistrict_name_en": name_en,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def normalize_postcodes(rows: List[Dict]) -> List[Dict]:
    out = []
    for idx, row in enumerate(rows, start=1):
        ext_id = row_value(row, "รหัสจากภายนอก", "external id", "external code", "id")
        code = row_value(row, "รหัสไปรษณีย์", "postcode", "code")
        province_ref = row_value(row, "จังหวัด", "province")
        district_ref = row_value(row, "อำเภอ", "district")
        subdistrict_ref = row_value(row, "ตำบล", "subdistrict")
        out.append({
            "id": f"odoo_excel_hd_postcodes_{slugify(ext_id or code or idx)}",
            "table_name": "hd_postcodes",
            "code": code or ext_id,
            "name": code or ext_id,
            "extra": row_json({
                "source": "odoo",
                "source_id": ext_id,
                "external_id": ext_id,
                "province_id": province_ref,
                "district_id": district_ref,
                "subdistrict_id": subdistrict_ref,
                "postcode": code,
            }),
            "active": 1,
            "sort_order": idx,
        })
    return [r for r in out if r["code"] or r["name"]]


def load_all_rows(files: Iterable[Path]) -> Dict[str, List[Dict]]:
    grouped: Dict[str, List[Dict]] = {}
    for file_path in files:
        key = file_path.name.lower()
        target = TARGETS.get(key)
        if not target:
            raise SystemExit(f"Unsupported file: {file_path}")
        rows = read_tabular_rows(file_path)
        grouped.setdefault(target, []).extend(rows)
    return grouped


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


def import_rows(conn: sqlite3.Connection, rows_by_table: Dict[str, List[Dict]]) -> None:
    ensure_schema(conn)
    conn.execute("BEGIN")
    try:
        for tbl in rows_by_table:
            conn.execute("DELETE FROM hd_master WHERE table_name=? AND id LIKE 'odoo_excel_%'", (tbl,))
        for tbl, rows in rows_by_table.items():
            conn.executemany(
                """
                INSERT OR REPLACE INTO hd_master
                (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                """,
                [
                    (
                        row["id"],
                        row["table_name"],
                        row.get("code", ""),
                        row.get("name", ""),
                        row.get("extra", "{}"),
                        int(row.get("active", 1)),
                        int(row.get("sort_order", 0)),
                    )
                    for row in rows
                ],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def ensure_schema_pg(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS hd_master (
              id TEXT PRIMARY KEY,
              table_name TEXT NOT NULL,
              code TEXT,
              name TEXT NOT NULL,
              extra TEXT DEFAULT '{}',
              active INTEGER DEFAULT 1,
              sort_order INTEGER DEFAULT 0,
              created_at TIMESTAMPTZ DEFAULT now(),
              updated_at TIMESTAMPTZ DEFAULT now()
            )
            """
        )


def import_rows_pg(conn, rows_by_table: Dict[str, List[Dict]]) -> None:
    ensure_schema_pg(conn)
    with conn.cursor() as cur:
        try:
            for tbl in rows_by_table:
                cur.execute("DELETE FROM hd_master WHERE table_name=%s AND id LIKE 'odoo_excel_%%'", (tbl,))
            for tbl, rows in rows_by_table.items():
                payload = [
                    (
                        row["id"],
                        row["table_name"],
                        row.get("code", ""),
                        row.get("name", ""),
                        row.get("extra", "{}"),
                        bool(row.get("active", 1)),
                        int(row.get("sort_order", 0)),
                    )
                    for row in rows
                ]
                if not payload:
                    continue
                execute_values(
                    cur,
                    """
                    INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order, created_at, updated_at)
                    VALUES %s
                    ON CONFLICT (id) DO UPDATE
                    SET table_name = EXCLUDED.table_name,
                        code = EXCLUDED.code,
                        name = EXCLUDED.name,
                        extra = EXCLUDED.extra,
                        active = EXCLUDED.active,
                        sort_order = EXCLUDED.sort_order,
                        updated_at = now()
                    """,
                    payload,
                    template="(%s, %s, %s, %s, %s, %s, %s, now(), now())",
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE))
    parser.add_argument("--pg-url", default="")
    parser.add_argument("--file", action="append", dest="files", help="Excel file to import", default=[])
    args = parser.parse_args()

    files = [Path(f) for f in args.files] if args.files else DEFAULT_FILES
    for file_path in files:
        if not file_path.exists():
            raise SystemExit(f"File not found: {file_path}")

    grouped = load_all_rows(files)

    normalized: Dict[str, List[Dict]] = {}
    criteria_placeholders: List[Dict] = []
    for tbl, rows in grouped.items():
        if tbl == "hd_channels":
            normalized[tbl] = normalize_channels(rows)
        elif tbl == "hd_teams":
            normalized[tbl] = normalize_teams(rows)
        elif tbl == "hd_users":
            normalized[tbl] = normalize_users(rows)
        elif tbl == "hd_flow_products":
            normalized[tbl] = normalize_flow_products(rows)
        elif tbl == "hd_flow_areas":
            normalized[tbl] = normalize_flow_areas(rows)
        elif tbl == "hd_flow_case_types":
            normalized[tbl] = normalize_flow_case_types(rows)
        elif tbl == "hd_projects_dev":
            normalized[tbl] = normalize_projects_dev(rows)
        elif tbl == "hd_contacts":
            normalized[tbl] = normalize_contacts(rows)
        elif tbl == "hd_configs":
            normalized[tbl] = normalize_configs(rows)
        elif tbl == "hd_sla":
            normalized[tbl] = normalize_sla(rows)
        elif tbl == "hd_sub_criteria":
            normalized[tbl], criteria_placeholders = normalize_sub_criteria(rows)
        elif tbl == "hd_criteria":
            normalized[tbl] = normalize_criteria(rows)
        elif tbl == "hd_provinces":
            normalized[tbl] = normalize_provinces(rows)
        elif tbl == "hd_districts":
            normalized[tbl] = normalize_districts(rows)
        elif tbl == "hd_subdistricts":
            normalized[tbl] = normalize_subdistricts(rows)
        elif tbl == "hd_postcodes":
            normalized[tbl] = normalize_postcodes(rows)
        else:
            raise SystemExit(f"No normalizer for table: {tbl}")

    if criteria_placeholders and "hd_criteria" not in normalized:
        normalized["hd_criteria"] = [
            {
                "id": f"odoo_excel_hd_criteria_{slugify(ref)}",
                "table_name": "hd_criteria",
                "code": ref,
                "name": ref,
                "extra": row_json({"source": "odoo", "source_id": ref, "external_id": ref, "placeholder": True}),
                "active": 1,
                "sort_order": idx,
            }
            for idx, ref in enumerate(criteria_placeholders, start=1)
        ]

    if args.pg_url:
        conn = psycopg2.connect(args.pg_url)
        try:
            import_rows_pg(conn, normalized)
        finally:
            conn.close()
        print("[+] Imported Excel files into postgres")
    else:
        sqlite_path = Path(args.sqlite)
        if not sqlite_path.exists():
            raise SystemExit(f"SQLite DB not found: {sqlite_path}")

        conn = sqlite3.connect(sqlite_path)
        try:
            import_rows(conn, normalized)
        finally:
            conn.close()

        print("[+] Imported Excel files into sqlite")
    for tbl, rows in normalized.items():
        print(f"    - {tbl}: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
