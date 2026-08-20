# Betime Local Run

## Run directly on this PC

Double-click:

- `run-betime-ready.bat`
- `start-betime-local.bat`
- `open-betime-web.bat`

App URL:

- `http://127.0.0.1:<available-port>/login`
- `http://127.0.0.1:<available-port>`
- `http://127.0.0.1:<available-port>/api/health`

The worker will pick an available local port if `8788` is already in use and writes the selected port to `.tmp/betime-local-port.txt`.

`run-betime-ready.bat` will:

- verify PostgreSQL is running on `localhost:5432`
- start the local Pages worker if needed
- wait until the app is ready
- open the login page automatically

Stop:

- `stop-betime-local.bat`

Requirements:

- PostgreSQL in this PC must be running on `localhost:5432`
- Database name: `Betime_DB`
- User: `postgres`
- Password: `123456`
- Odoo submit uses local defaults: `ODOO_URL=http://bt.dev.demotoday.net`, `ODOO_DB=bt-helpdesk`, `ODOO_LOGIN=admin`, `ODOO_PASSWORD=bt@admin`, `ODOO_CHANNEL=Website`, `ODOO_DIRECT_CREATE=1`
- Local mode also binds `ODOO_LOCAL_FALLBACK=1` so a local Worker fetch failure saves the ticket locally instead of blocking the flow.
- If Odoo submit shows `ODOO_URL is not configured`, see `docs/odoo_local_binding_troubleshooting.md`

## Make it available every time you test

Double-click once:

- `install-betime-autostart.bat`

This installs a Windows logon task that starts the local Betime worker automatically after sign-in.

When you want to open and auto-check the app:

- `open-betime-web.bat`

To remove auto-start later:

- `uninstall-betime-autostart.bat`

## Run with Docker

Double-click:

- `start-betime-docker.bat`

App URL:

- `http://127.0.0.1:19120/main/`
- `http://127.0.0.1:19120/main/api/health`

## Nginx reverse proxy

To expose the app as `http://aidlc-bt.demotoday.net/main/`, point Nginx or IIS at the Docker Nginx port:

- `http://127.0.0.1:19120`

The generated host-side file is still available when you run the local worker:

- `deploy/nginx/aidlc-bt.demotoday.net.conf`

Keep the `/main/` location block and the root asset proxy rules.

Stop:

- `stop-betime-docker.bat`

Requirements:

- Docker Desktop must be running
- PostgreSQL เดิมของเครื่องต้องรันอยู่ที่ `localhost:5432`
- Database: `Betime_DB`
- User: `postgres`
- Password: `123456`

Docker mode will use the existing PostgreSQL database on this PC as the primary database.

## Default login

- Username: `admin`
- Password: `admin1234`

Other seeded users:

- `manager` / `admin1234`
- `staff` / `admin1234`
