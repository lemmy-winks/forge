# Forge

Self-hosted, agent-coached fitness tracker for two. FastAPI + Postgres + a vanilla-JS PWA,
one Docker Compose stack. Design docs: [docs/](docs/) · visual spec, clickable demo and build
docs are linked from `docs/implementation-plan.md`.

**Status: Phase 4 of the [implementation plan](docs/implementation-plan.md) complete.**
Working now: Google/dev sign-in with allowlist, Health Auto Export ingest, plans with
time-budget fitting, full logging flow (warm-ups, plate math, rest timer, swaps, cool-down),
records, history, progress, equipment profiles, niggles, labs, export, offline set queue,
Claude coach agent with weekly review proposals, Withings OAuth + cardio reconciliation,
desktop dashboard, web push (proposals + workout reminders), exercise form photos.

## Fresh install on a new server

```bash
git clone <this repo> forge && cd forge
ALLOWED_USERS="you@example.com:You,her@example.com:Her" ./deploy/fresh-install.sh
```

The script writes a `.env` with generated secrets, builds and starts the stack, generates
VAPID push keys, and health-checks it. Clean database — users, exercise library, starter
plans and equipment profiles are seeded on first boot; do onboarding in the app.

To set up by hand instead:

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, SESSION_SECRET, your ALLOWED_USERS emails
docker compose up -d --build
open http://localhost:33524
```

With no Google credentials configured, the sign-in page shows **dev sign-in buttons** for the
allowlisted users — fine on your LAN, do not expose publicly like that. The database schema
and seed data (exercise library, starter plan per user, equipment profiles) are created on
first boot; everything persists in the `pgdata` volume.

### Google sign-in (when you're ready)

1. Google Cloud Console → OAuth consent screen (External, add both emails as test users).
2. Create OAuth client (Web application), authorized redirect URI: `https://your-domain/auth/callback`.
3. Put the client ID/secret + your public `BASE_URL` in `.env`, `docker compose up -d`.

### Apple Health in (Health Auto Export)

1. In the app: Settings → Connections → **ROTATE** to mint your token, copy it.
2. Health Auto Export → Automations → REST API:
   - URL: `https://your-domain/ingest` (or `http://<host-ip>:33524/ingest` on the LAN)
   - Header: `Authorization: Bearer <token>`
   - Format JSON; select weight, sleep, resting HR, VO2 max, workouts.
3. Run it once manually — Connections should show "Live · n samples" within a minute.

Withings: link Withings → Apple Health sync in the Withings app for now; direct OAuth comes in Phase 4.

### Ingress (your existing chain)

Cloudflare DNS → VPS Nginx → Tailscale → this box. Nginx site:

```nginx
server {
  listen 443 ssl http2;
  server_name forge.yourdomain.com;
  # ... your existing TLS config ...
  location / {
    proxy_pass http://<tailscale-ip-of-host>:33524;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

Set `BASE_URL=https://forge.yourdomain.com` so session cookies are marked Secure and the
OAuth redirect matches.

## Development

Backend:

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
DATABASE_URL=sqlite:///./dev.db .venv/bin/uvicorn app.main:app --reload   # http://localhost:8000
.venv/bin/python -m pytest tests/ -q                                      # smoke tests
```

Frontend (React + Vite + TS in `web/`):

```bash
cd web
npm install
npm run dev     # hot-reload dev server on :5173, proxies /api /auth /ingest to :8000
npm run build   # type-checks + builds web/dist
```

The server serves `web/dist` when it exists (after `npm run build`), otherwise falls back to
the legacy buildless client in `server/static/`. The Docker image always builds and ships the
React app — Node exists only in the build stage, never in the runtime image.

## Layout

```
docker-compose.yml        # postgres + api
server/
  app/                    # FastAPI: config, models, fitting engine, routers/
  static/                 # legacy buildless client (fallback only)
  tests/                  # API smoke tests (sqlite)
web/                      # React + Vite + TypeScript PWA (the frontend)
  src/screens/            # one module per screen cluster
  src/styles.css          # Void×Volt design system tokens
docs/                     # user stories, implementation plan
```

## Backups

Postgres lives in the `pgdata` volume. Nightly dump to wherever you keep backups:

```bash
docker compose exec -T db pg_dump -U forge forge | gzip > /path/to/backups/forge-$(date +%F).sql.gz
```
