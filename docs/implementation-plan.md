# Forge — Implementation Plan

Stack (decided): **FastAPI + Postgres 16 (Alembic migrations, RLS)** · **Vite + React + TS PWA** (Tailwind, TanStack Query, Dexie offline queue, vite-plugin-pwa) · **MCP server** in-process with forge-api · **Claude API** for coach loops (chat + scheduled reviews) · **Docker Compose** on a home server · ingress **Cloudflare → VPS Nginx → Tailscale** · media via **ffmpeg** sidecar · design system **Void × Volt** (tokens in memory/spec).

> **As built (Jul 2026)** — where reality diverged from the line above: SQLAlchemy `create_all` (new tables only), no Alembic/RLS yet (RLS still slated for Phase 5); hand-written `styles.css` instead of Tailwind; raw IndexedDB queue instead of Dexie; coach tools call route handlers directly in-process — no MCP server; ffmpeg sidecar gone with the media descope (Phase 5). Public ingress is live (Cloudflare → forge domain), Google OAuth active.

Principles: walking skeleton first; every phase ends usable; the riskiest integration (Apple Health export path) is proven in week one; agent features land only after the data they read is real.

---

## Phase 1 — Walking skeleton (the risky plumbing)
**Goal: real data arrives from the real world into a real database through the real ingress.**
Stories: E1.1–E1.3, E2.1, E2.3 (ingest token), E15.2 (health endpoint)

- Repo scaffold: compose (forge-api, postgres), Alembic, settings via env, `justfile`/make targets.
- Core schema: `users`, `ingest_tokens`, `metrics`, auth sessions.
- Google OIDC (Authlib) + two-account allowlist + session cookies.
- `POST /ingest` (HAE format), idempotent metric writes; Connections status endpoint.
- Ingress: `forge.<domain>` through Cloudflare → VPS Nginx → Tailscale → mini; TLS end-to-end.
- Point Health Auto Export + phone at it; soak for a few days.

**Exit:** James signs in with Google; weight/sleep/VO2max from the phone appear in Postgres via the public URL; wrong Google account is refused; token rotation works.

## Phase 2 — Training core (plan → log loop, no agent yet)
**Goal: usable gym app with a hand-written plan.**
Stories: E3.1, E3.3, E3.4, E4.1–E4.7, E6.3, E10.1, E10.2 (read side), E11.1 (profiles + plate data)

- Schema: exercises, equipment_profiles, plans/plan_revisions, workout_sessions, logged_sets, substitutions, records (write-on-log), niggles (table only).
- Library seed import (free-exercise-db) + media serving; library browse API.
- Session engine: `GET /today` (last-time context, time-budget fitting server-side), warm-up ramp + plate math from profile inventory, cool-down block.
- PWA scaffold with Void×Volt tokens; screens: Today (slider), Learn, Log (steppers, RPE, rest ring, swap, cooldown), Summary, History (+detail), Settings shell, Equipment.
- Offline: Dexie set queue + SW app-shell/media caching; airplane-mode test.
- Seed one hand-written Lower/Upper/cardio week as the active revision.

**Exit:** a full real gym session logged on the phone offline-tolerantly, with plate math, swap, cool-down, and summary; history and records populate.

## Phase 3 — The coach (agent loop + proposals)
**Goal: the plan writes itself, with approval.**
Stories: E3.2, E7.1–E7.3, E9.1, E12.1 (proposal-ready only)

- MCP server (per-user credentials): `get_today`, `get_recent_metrics`, `get_workout_history`, `get_active_plan`, `propose_revision`, `log_niggle`, `update_constraints`, `labs_log_result` (stub).
- Coach system prompt: goals, standing constraints, niggle rules, progression style, hard boundaries (no medication advice).
- Chat endpoint: server-side Claude agent loop with MCP tools; confirmation-card pattern for writes; per-user chat history.
- Weekly review job (scheduler): review → proposal revision + summary message; approve/changes flow in PWA.
- Niggle lifecycle wired into proposals/swaps/cool-downs.
- Web push plumbing + proposal-ready notification.

**Exit:** Sunday produces a data-grounded proposal James approves on his phone; chat answers from live data; the knee niggle visibly shapes the next proposal.

## Phase 4 — Cardio, trends & the dashboard
**Goal: both halves of fitness visible and coached.**
Stories: E5.1–E5.3, E6.1–E6.2 (charts), E14.1, E12.1 (reminder), E2.2 (Withings)

- Withings OAuth + webhooks (per user).
- Workout ingest mapping (runs: distance, pace, HR samples, zone time) + reconciliation against prescriptions; unplanned-session handling.
- e1RM/tonnage/zone-minute aggregations; Progress screens; Records screen; desktop `/dashboard` (small multiples, bodyweight vs goal, VO2max raw+smoothed, Zone 2 vs target, consistency heatmap).
- Planned-day reminder notification (quiet hours).

**Exit:** Watch run auto-appears matched to Wednesday's prescription; dashboard renders every panel from live data; coach references cardio + recovery in the weekly review. **Done.**

## Phase 4.5 — Shipped between phases (Jul 2026, unplanned)

Work that landed after the Phase 4 exit, before Phase 5 proper:

- **Onboarding wizard** + **demo account** (E5.4-adjacent): Bruce Willis, `role='demo'`, a year of believable data, live coach, admin-managed via `/api/admin/demo`; excluded from the seat cap, user list, and Sunday scheduler; segregation test covers the demo on every surface (API, chat context, coach tools, admin).
- **Rich run detail** (E5.4): HR + GPS series stored per cardio session (`workout_series`, downsampled at ingest), five-zone breakdown from `prefs.hr_max` (or estimated), tile-free SVG route trace, HR chart with the prescribed band shaded. Re-sent HAE days backfill series onto already-ingested runs. Demo runs carry generated Cherry Orchard (Dublin) loops.
- **Coach prompt caching** + chat feedback speedup; plan rationales restyled to lead with what the week achieves rather than the edit log.
- **Ops**: build stamps (image build date in `/healthz`, bundle build date compiled into the JS) surfaced on Settings → Server for stale-deploy RCA; Withings link flow made a server-side 302 so the iOS Withings app's universal link can't hijack OAuth.

## Phase 5 — Labs, household & media pipeline
**Goal: everything in the spec, for both users.**
Stories: E8.1, E13.1–E13.2, E10.3, E12.1 (filming), E1 (Shelby), E11.1 (household Home profile)

- Labs schema + chat parse→confirm→write; lipid dashboard panel; next-draw reminders.
- Postgres RLS enabled + cross-user access tests; second-user onboarding polish; Shelby live with her own coach credential and Withings link.
- ~~Media pipeline: upload (PWA/chat) → ffmpeg transcode → poster → tier upgrade; wanted-list + filming notification.~~ **Descoped (Jul 2026, James's call): no self-filmed form videos.** Curated existing media instead — public-domain start/end photos from free-exercise-db, self-hosted per exercise (done); optional later: linked reputable demo videos per exercise (`media_tier: linked`). The filming notification kind is retired; push is two kinds (proposal, reminder).
- Household screen semantics (shared Home profile, shared library).

**Exit:** Shelby trains with her own coach; James's lab letter round-trips chat→database→dashboard; every prescribed exercise shows curated form media in the library (shared by both).

## Phase 6 — Hardening & v1 close-out
Stories: E15.1–E15.3, remaining E12 enforcement

- Backup/restore drill (Postgres + media, to backup storage); documented runbook.
- Ingest-freshness alerting; structured logs; agent cost visibility.
- Security pass: rate limits at Nginx, security headers, dependency audit, secrets review. Rate-limit the demo seat's coach runs specifically — it runs on the real API key and is open to anyone who can reach the app.
- JSON export endpoint; "two notification kinds only" enforcement test (filming kind retired with the media pipeline).
- v1.5 backlog groomed: readiness-aware adjustments, RPE autoregulation, chart revision-markers, GP report PDF.

**Exit:** v1 declared done: restore tested, both users live, docs current.

---

## Cross-cutting definition of done
Every story: typed API schema, migration, tests for the server logic (auth/scoping always), PWA state handled offline where relevant, Void×Volt tokens only (no ad-hoc colors), and user-visible copy matching the spec's voice.

## Sequencing rationale & risks
- **HAE path first** (Phase 1) because it's the least controllable dependency; if its format/cadence disappoints, fallback is the HealthKit companion-app route — better to know in week one.
- **App before agent** (Phase 2 before 3) so the coach reads real logged data on day one of its existence; hand-written plan proves the schema the agent will write into.
- **iOS Web Push** is the flakiest platform surface — it gets a fallback (email digest) if reliability disappoints.
- **Claude API cost**: weekly reviews are single scheduled runs; chat is on-demand; both log token spend per run (E15.2) so cost is a dashboard number, not a surprise.
- **ffmpeg/HEVC quirks**: pipeline normalizes to H.264 + AAC-stripped MP4; test matrix includes iPhone HEVC captures.
