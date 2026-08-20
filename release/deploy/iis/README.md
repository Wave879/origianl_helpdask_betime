# IIS Setup for `aidlc-bt.demotoday.net`

Use this when the site is hosted behind IIS/ARR.

Files:
- `web.config` handles `/web/` without changing `/tool/` or the domain root
- `/web/*` proxies to Nginx on `192.168.100.12:19120`
- Nginx proxies the request to the BETIME app on local port `8788`

If the Nginx host changes, update `192.168.100.12` in `web.config`.

Required IIS features:
- URL Rewrite
- Application Request Routing
- Proxy enabled in ARR

Run on `192.168.0.227` from an elevated PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-arr-web-route.ps1
```

Or run remotely from `192.168.100.12` in an elevated PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-arr-web-route-remote.ps1
```

The remote installer asks for an administrator account for `192.168.0.227`,
temporarily adds the server to WinRM TrustedHosts, installs the route, and then
restores the previous TrustedHosts value.

The installer:
- verifies `http://192.168.100.12:19120/web/api/health`
- finds the IIS site bound to `aidlc-bt.demotoday.net`
- backs up IIS configuration
- installs `/web` reverse-proxy rules without replacing `/tool` rules
- enables the ARR proxy

Expected result:
- `https://aidlc-bt.demotoday.net/web/` opens the BETIME app
