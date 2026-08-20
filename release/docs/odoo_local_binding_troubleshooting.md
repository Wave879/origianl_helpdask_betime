# Odoo Local Binding Troubleshooting

## Error: `ODOO_URL is not configured`

This error happens when the Pages Worker handles `POST /helpdesk/ticket` but the worker environment does not include `ODOO_URL`.

## Root Cause

`deploy/pages_bundle/_worker.js` reads Odoo config from Cloudflare Worker bindings:

```txt
env.ODOO_URL
env.ODOO_DB
env.ODOO_CHANNEL
```

In local development, environment variables are not available to the worker unless they are passed to `wrangler pages dev` with `-b`.

If local scripts start Wrangler without:

```txt
-b "ODOO_URL=..."
```

then `env.ODOO_URL` is empty and the worker returns:

```txt
ODOO_URL is not configured
```

## Required Local Defaults

Current local defaults:

```txt
ODOO_URL=http://bt.dev.demotoday.net
ODOO_DB=bt-helpdesk
ODOO_CHANNEL=Website
ODOO_LOCAL_FALLBACK=1
```

## Scripts That Must Keep These Bindings

- `scripts/start-local-pages-detached.js`
- `scripts/run-local-pages.ps1`
- `stop-betime-local.ps1`
- `LOCAL-RUN.md`

## Fix Pattern

1. Add `ODOO_URL`, `ODOO_DB`, `ODOO_CHANNEL`, and `ODOO_LOCAL_FALLBACK` to the local binding list.
2. Provide safe local defaults if the OS environment does not define them.
3. Restart the local Pages Worker after changing bindings.
4. Stop old `wrangler pages dev deploy/pages_bundle` processes if port `8788` is still serving stale config.
5. Also stop stale `workerd.exe` processes with `socket-addr=entry=127.0.0.1:<port>`; otherwise the browser may still hit an old worker even after Wrangler is restarted.

## Verify

```powershell
curl.exe -sS -o NUL -w "%{http_code}" http://127.0.0.1:8788/api/health

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like '*wrangler pages dev deploy/pages_bundle*' -and
    $_.CommandLine -like '*ODOO_URL=http://bt.dev.demotoday.net*' -and
    $_.CommandLine -like '*ODOO_LOCAL_FALLBACK=1*'
  } |
  Select-Object ProcessId,CommandLine

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like '*workerd.exe*serve*' -and
    $_.CommandLine -like '*socket-addr=entry=127.0.0.1:*'
  } |
  Select-Object ProcessId,CommandLine
```

Expected:

- `/api/health` returns `200`
- The Wrangler process command line contains `ODOO_URL=http://bt.dev.demotoday.net`
- The Wrangler process command line contains `ODOO_LOCAL_FALLBACK=1`
- There should be only one active `workerd.exe` serving `127.0.0.1:8788`
