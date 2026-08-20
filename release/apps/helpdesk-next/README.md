# Helpdesk Next (Phase 1)

This app is the first migration slice from `help-desk-v2.html` to Next.js.

## What is implemented

- Saved Ticket table as entry screen (before workspace)
- Workspace form for creating ticket
- Auto-save to localStorage before sending
- Retry create ticket from table rows
- Open/Delete saved rows

## Run

```bash
cd apps/helpdesk-next
npm install
npm run dev
```

Open `http://localhost:3100`

## Required env

Create `.env.local`:

```bash
NEXT_PUBLIC_HELPDESK_API_BASE=http://localhost:8788
```

Use your current API host (Cloudflare Worker / local pages runtime).

## Migration plan

1. Phase 1 (done): queue table + save/retry flow
2. Phase 2: move analysis/chat UI from `help-desk-v2.html` into React components
3. Phase 3: move API access into Next route handlers and remove direct browser coupling
