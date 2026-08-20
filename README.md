<<<<<<< HEAD
# BETIME Server Package

This folder contains a server-ready bundle of the BETIME system.

Main deployable package:
- `release/`

What is included:
- Web app source and deploy bundle
- Backend source, routes, scripts, migrations, workers
- Framework/package files needed to rebuild the app
- Database assets:
  - `release/data/postgres/dump.sql`
  - `release/data/d1/helpdeck.sqlite`
  - `release/data/backups/bt-helpdesk_2026-02-20_06-29-35/`

Not included:
- `node_modules`
- volatile log files
- local secret file `.dev.vars`

If you want the package to match a specific production database exactly, replace the included dump with the latest export from that server.

=======
# origianl_helpdask_betime
origianl_helpdask_betime 
>>>>>>> ab7cd81d85c4aa41ce76d227b71812aca6743b35
