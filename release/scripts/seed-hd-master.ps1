#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Seed hd_master table with initial project and topic data.
.PARAMETER PgUrl
  PostgreSQL connection string. Defaults to local dev DB.
.EXAMPLE
  .\seed-hd-master.ps1
  .\seed-hd-master.ps1 -PgUrl "postgres://user:pass@host:5432/dbname"
#>
param(
  [string]$PgUrl = "postgres://postgres:123456@localhost:5432/Betime_DB"
)

$ErrorActionPreference = "Stop"

# ── Parse connection string ──────────────────────────────────────────
$uri      = [System.Uri]$PgUrl
$PgHost   = $uri.Host
$PgPort   = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
$PgUser   = $uri.UserInfo.Split(':')[0]
$PgPass   = $uri.UserInfo.Split(':')[1]
$PgDb     = $uri.AbsolutePath.TrimStart('/')

# ── Find psql ────────────────────────────────────────────────────────
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  $candidates = @(
    "C:\Program Files\PostgreSQL\16\bin\psql.exe",
    "C:\Program Files\PostgreSQL\15\bin\psql.exe",
    "C:\Program Files\PostgreSQL\14\bin\psql.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $psql = $c; break }
  }
}
if (-not $psql) {
  Write-Host "❌ psql not found. Install PostgreSQL client tools." -ForegroundColor Red
  exit 1
}

$env:PGPASSWORD = $PgPass

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Betime — Seed hd_master               ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host "  Host : $PgHost`:$PgPort" -ForegroundColor Gray
Write-Host "  DB   : $PgDb" -ForegroundColor Gray
Write-Host "  User : $PgUser" -ForegroundColor Gray
Write-Host ""

# ── SQL ──────────────────────────────────────────────────────────────
$sql = @"
-- hd_projects
INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order)
VALUES
  ('hd_projects_001', 'hd_projects', 'ERC', 'ระบบสาระสนเทศ อิเล็กทรอนิกส์', '{}', TRUE, 1),
  ('hd_projects_002', 'hd_projects', 'SRB', 'ระบบรับเรื่องร้องเรียน',         '{}', TRUE, 2),
  ('hd_projects_003', 'hd_projects', 'BT',  'Betime Internal',                '{}', TRUE, 3),
  ('hd_projects_004', 'hd_projects', 'CRM', 'CRM System',                     '{}', TRUE, 4),
  ('hd_projects_005', 'hd_projects', 'HRM', 'HR Management',                  '{}', TRUE, 5)
ON CONFLICT (id) DO NOTHING;

-- hd_topics (bug types)
INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order)
VALUES
  ('hd_topics_001', 'hd_topics', 'BUG', 'Bug / Error',          '{}', TRUE, 1),
  ('hd_topics_002', 'hd_topics', 'NET', 'Network',              '{}', TRUE, 2),
  ('hd_topics_003', 'hd_topics', 'ACC', 'Account / Permission', '{}', TRUE, 3),
  ('hd_topics_004', 'hd_topics', 'CHG', 'Change Request',       '{}', TRUE, 4),
  ('hd_topics_005', 'hd_topics', 'HW',  'Hardware',             '{}', TRUE, 5),
  ('hd_topics_006', 'hd_topics', 'SW',  'Software',             '{}', TRUE, 6),
  ('hd_topics_007', 'hd_topics', 'DAT', 'Data Issue',           '{}', TRUE, 7)
ON CONFLICT (id) DO NOTHING;

-- hd_teams
INSERT INTO hd_master (id, table_name, code, name, extra, active, sort_order)
VALUES
  ('hd_teams_001', 'hd_teams', 'DEV',  'Development Team', '{}', TRUE, 1),
  ('hd_teams_002', 'hd_teams', 'INF',  'Infrastructure',   '{}', TRUE, 2),
  ('hd_teams_003', 'hd_teams', 'SUP',  'Support Team',     '{}', TRUE, 3)
ON CONFLICT (id) DO NOTHING;

SELECT table_name, COUNT(*) rows
FROM hd_master
GROUP BY table_name
ORDER BY table_name;
"@

# ── Run ──────────────────────────────────────────────────────────────
Write-Host "📥 Inserting seed data..." -ForegroundColor Yellow
$result = & $psql -U $PgUser -h $PgHost -p $PgPort -d $PgDb -c $sql 2>&1

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "✅ Seed completed!" -ForegroundColor Green
  Write-Host $result
} else {
  Write-Host "❌ Seed failed:" -ForegroundColor Red
  Write-Host $result
  exit 1
}
