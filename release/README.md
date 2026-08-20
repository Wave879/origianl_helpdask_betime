# BETIME Release Bundle

This folder is the deployable application bundle.

Layout:
- `app` code lives at the release root
- Static pages are in `deploy/pages_bundle`
- Backend routes and services are in `src`
- Database setup and migrations are in `docker`, `migrations`, and `workers`
- Data snapshots are in `data`

Included data sources:
- PostgreSQL dump: `data/postgres/dump.sql`
- D1/SQLite snapshot: `data/d1/helpdeck.sqlite`
- Full backup source: `data/backups/bt-helpdesk_2026-02-20_06-29-35`

Run with Docker:
1. Open this folder in a terminal.
2. Run `docker compose up -d --build`
3. Open `http://localhost:19120/web/`

Notes:
- `docker-compose.yml` starts PostgreSQL, the app, and nginx.
- Nginx listens on `/web/` and proxies to the app container.
- `PUBLIC_BASE_URL` defaults to `https://aidlc-bt.demotoday.net/web`.
- `docker-compose.local.yml` is available if you need the local variant.
- If you need the latest production data, restore a fresh database dump over `data/postgres/dump.sql`.
    