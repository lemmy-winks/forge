---
name: run-forge
description: Run, drive, and screenshot the Forge PWA. Use when asked to start Forge locally, take screenshots of app screens, hunt visual bugs, or verify a UI change in the running app (dark + light, phone viewport, demo data).
---

Forge is a FastAPI server that also serves the built React PWA. Drive it with
`.claude/skills/run-forge/driver.mjs` — a puppeteer-core script that walks every
major screen as the demo user (Bruce, a year of data), screenshots them, and
exits 1 on any page JS error, console error, or unexpected 4xx/5xx. All paths
relative to the repo root.

## Prerequisites

macOS with Google Chrome installed (the driver uses it headless via
`CHROME_BIN`, default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
Python venv at `server/.venv`, frontend deps in `web/`. One-time driver dep:

```bash
cd .claude/skills/run-forge && npm i puppeteer-core@23
```

## Build

The server serves `web/dist` when present — build it first or screens show stale UI:

```bash
cd web && npm run build
```

## Run (agent path)

1. Start the server on a scratch sqlite DB (never the real Postgres):

```bash
DB=/tmp/forge-run.db; rm -f $DB
cd server && DATABASE_URL="sqlite:///$DB" DEV_AUTH=true SESSION_SECRET=dev-secret \
  ALLOWED_USERS="james@test.dev:James,shelby@test.dev:Shelby" \
  .venv/bin/python -m uvicorn app.main:app --port 8600 > /tmp/forge-run.log 2>&1 &
sleep 3 && curl -s localhost:8600/healthz   # {"ok":true,"build":"dev"}
```

2. Seed the demo account (takes ~2 s, builds a year of data):

```bash
curl -s -c /tmp/forge-cj -X POST localhost:8600/auth/dev \
  -H 'Content-Type: application/json' -d '{"email":"james@test.dev"}' > /dev/null
curl -s -b /tmp/forge-cj -X POST localhost:8600/api/admin/demo   # {"exists":true}
```

3. Run the driver:

```bash
node .claude/skills/run-forge/driver.mjs all
```

Screenshots land in `/tmp/forge-shots/` (override with `--out`). Flows can be
run individually: `app` (sign-in → Plan → day → History → run detail → Progress
→ Coach → proposal sheet), `light` (same key screens with the light theme),
`welcome` (landing page, phone + desktop). `--base` overrides the URL
(default `http://localhost:8600`).

**Read the screenshots** with the Read tool — a clean exit only means no JS/HTTP
errors, not that the layout is right.

Stop the server with `kill %1` (or the PID you saved).

## Run (human path)

`cd web && npm run dev` proxies to a server on :8000 for hot-reload work.
Deploys go through docker compose — see CLAUDE.md.

## Test

```bash
cd server && .venv/bin/python -m pytest tests/ -q   # 32 pass, ~1 s
```

## Gotchas

- **`.kick` labels are CSS-uppercased and `innerText` reflects it** — text
  waits/selectors must match case-insensitively (the driver's `waitText`/
  `clickText` already do).
- **Light mode is `data-theme="light"` on `<html>`, NOT `prefers-color-scheme`**
  — emulating the media feature silently tests nothing. The driver sets the
  attribute directly.
- **The demo must exist before the `app` flow** — otherwise there's no
  "Try the demo" button and the driver aborts with a pointed error. Seed it
  (step 2) after every fresh DB.
- **`/auth/me` 401s once on the signed-out boot** — by design; the driver
  whitelists exactly that and reports any other 4xx/5xx.
- **The PWA service worker doesn't interfere headless** (fresh profile each
  launch), but if you reuse a profile, kill it — stale bundles lie.

## Troubleshooting

- **`Unary operator used immediately before exponentiation`** (or any
  `pageerror` in the summary): real page bug — this exact class of error once
  made the welcome-page charts render as empty boxes. Fix the page, not the driver.
- **Driver hangs on `waitText`**: the screen never rendered the expected text —
  check `/tmp/forge-run.log` for a server traceback first.
- **`no button matching "Try the demo"`**: demo not seeded (see step 2), or the
  DB wasn't fresh and dev-auth users changed.
