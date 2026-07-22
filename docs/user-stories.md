# Forge — User Stories & Acceptance Criteria

Personas: **James** (owner/admin), **Shelby** (second user), **the Coach** (per-user Claude agent), **the System** (server jobs).
Stories are grouped by epic; IDs are referenced by the implementation plan.

---

## E1 · Identity & access

**E1.1 — Sign in with Google**
As James, I want to sign in with my Google account so that I never manage a password.
- AC1: The signed-out page offers exactly one action: "Continue with Google" (OIDC authorization-code flow).
- AC2: A successful Google login for an allowlisted email creates a server session (secure, HttpOnly cookie) and lands on Today.
- AC3: Sessions survive PWA restarts; an expired session redirects to sign-in, never to an error page.

**E1.2 — Allowlist rejection**
As James, I want non-allowlisted Google accounts refused so that the instance stays private.
- AC1: A verified Google identity not on the allowlist sees the "Not on the list" screen; no API data is returned (401 on every data route).
- AC2: The allowlist lives in server config/DB and changing it requires admin action; no self-signup path exists.
- AC3: Rejected attempts are logged with email + timestamp.

**E1.3 — Sign out**
- AC1: Sign-out destroys the server session and returns to the signed-out page.
- AC2: Back-navigation after sign-out shows no cached personal data.

## E2 · Data ingest

**E2.1 — Apple Health via Health Auto Export**
As James, I want my Apple Health data pushed to the server automatically so that metrics flow without manual entry.
- AC1: `POST /ingest` authenticates by per-user bearer token; an unknown token → 401, and the payload is not stored.
- AC2: Accepted payloads (weight, sleep, resting HR, VO2max, workouts) are parsed into `metrics`/`workout_sessions` rows stamped with the token's `user_id`.
- AC3: Duplicate samples (same user, type, timestamp, source) are idempotently ignored.
- AC4: Connections screen shows last push time and sample count within 1 minute of arrival.

**E2.2 — Withings link**
As James, I want to link my own Withings account so that weigh-ins sync without the phone in the loop.
- AC1: OAuth link flow started from a signed-in session stores tokens against that user only.
- AC2: Webhook notifications fetch new measurements and store them under the linked user; unlinked webhooks are ignored and logged.
- AC3: Token refresh is automatic; a failed refresh surfaces as a warning on Connections, not silent data loss.

**E2.3 — Rotate credentials**
As James, I want to rotate any credential independently so that a lost phone doesn't mean re-wiring everything.
- AC1: Rotating the ingest token invalidates the old one immediately; the UI shows the new token exactly once.
- AC2: Withings unlink revokes stored tokens; MCP credential rotation cuts agent access on next request.
- AC3: Rotation of one credential never affects the others or the other user.

## E3 · Planning & proposals

**E3.1 — Versioned plans**
As the Coach, I want plans stored as immutable revisions so that every change has a why and a when.
- AC1: `plans` + `plan_revisions` (status: proposed / active / superseded); revision content is JSONB (days → exercises → targets, cooldown block), rationale text required.
- AC2: Activating a revision supersedes the previous one atomically; history is queryable.
- AC3: Only exercises with complete library entries (≥ images tier + cues + muscles + equipment tags) can appear in a revision (server-side validation).

**E3.2 — Weekly proposal**
As James, I want next week proposed on Sunday evening so that I start Monday knowing the plan.
- AC1: A scheduled per-user job runs the coach loop; output is a revision with `status=proposed`, per-day focus tags derived from library muscle maps, and one-line rationale per session.
- AC2: The proposal renders in the Coach tab with Approve and "ask for changes"; nothing changes the active plan until approved.
- AC3: Approving flips the revision to active and (if enabled) confirms via notification; requesting changes routes into chat with proposal context attached.
- AC4: Proposals respect: active equipment profile, standing constraints, active niggles, cardio placement rules (hard days not adjacent to heavy lower days).

**E3.3 — Today view**
As James, I want today's session with context so that I never guess targets.
- AC1: `GET /today` returns the active revision's session for the date plus, per exercise, the most recent comparable performance ("last time").
- AC2: Coach-chip explains any change vs last week, sourced from revision rationale.
- AC3: Rest days render recovery data (sleep, resting HR, weigh-in, yesterday's result, tomorrow preview) — never an empty screen.

**E3.4 — Time budget**
As James, I want to state today's available time and get a fitted session so that short days still count.
- AC1: A 25–75 min slider re-fits the session live: accessories lose sets first (respecting per-exercise minimums), the main lift is never trimmed, the cool-down shortens 5→2 min but is never dropped.
- AC2: The fitted estimate (warm-ups + sets + rests + cool-down) is shown and the trim note states exactly what changed.
- AC3: The chosen budget and fitted plan are stored with the session; repeated short budgets are visible to the weekly review.

## E4 · Session execution (strength)

**E4.1 — Warm-up ramp**
- AC1: Barbell exercises ≥ 50 kg show a ramp (bar → ~50% → ~70% → ~85%, rounded to plate resolution) before set 1.
- AC2: Ramp time is included in the session estimate; "warm-ups done" is one tap and recorded.

**E4.2 — Plate math**
- AC1: For barbell exercises, the active weight shows per-side plate breakdown computed from the active profile's plate inventory.
- AC2: Unloadable targets (e.g. no 1.25s at Home) are flagged and rounded to the nearest loadable weight at plan time, not discovered at the bar.
- AC3: Dumbbell exercises show pair weight; machines/bodyweight show nothing.

**E4.3 — Log sets**
As James, I want one-thumb set logging so that logging never interrupts training.
- AC1: Steppers pre-fill from target (weight step = exercise increment); RPE optional 6–10; "Log set" appends an immutable `logged_sets` row.
- AC2: Every set is written to IndexedDB first and synced when online; airplane-mode logging loses nothing (verified by test).
- AC3: Completed sets collapse to ticked rows; targets vs actuals both stored.

**E4.4 — Rest timer & pace**
- AC1: Logging a set auto-starts a countdown with per-exercise rest target, shown as a draining ring; zero state prompts the next set.
- AC2: Skip is one tap; elapsed session time and remaining estimate are always visible while logging.

**E4.5 — Substitution**
As James, I want an instant alternative when equipment is taken so that the session never stalls.
- AC1: Swap lists library exercises sharing the primary muscle group, filtered by active equipment profile, ordered by closeness; active niggles exclude matching movement patterns and say why.
- AC2: Swapping re-targets steppers sensibly and records the substitution (original ↔ actual) on the session.
- AC3: Swap-back is available; the weekly review sees substitution frequency per exercise.

**E4.6 — Cool-down**
- AC1: After the last work set, the cool-down list (from the plan's mobility block) renders with hold durations; items tied to niggles are labelled.
- AC2: Each item is tickable; finishing records done / partial / skipped (+ configured length).
- AC3: Skipping is allowed, logged, and surfaced by the weekly review when it becomes a pattern.

**E4.7 — Session summary**
- AC1: Finishing shows duration vs estimate, tonnage, sets done/planned, average RPE, cool-down status, per-exercise plan-vs-actual, and a note field.
- AC2: New records detected during the session render exactly one PB banner here.
- AC3: The summary is reachable later from Today and History.

## E5 · Cardio

**E5.1 — Prescribed cardio**
- AC1: Cardio prescriptions (type, duration, HR zone) render on Today with "starts on your Watch" — the PWA has no start/stop controls.
- AC2: Zone targets come from the plan; weekly Zone-2 minute targets are visible on Progress.

**E5.2 — Watch reconciliation**
As the System, I want incoming Watch workouts matched to prescriptions so that cardio is auto-logged.
- AC1: An ingested workout matches an open prescription by date + type (± tolerance); matched sessions show target vs actual (time, distance, pace, avg HR, % in zone).
- AC2: Unmatched workouts are kept as unplanned sessions, visible in History.
- AC3: The user can confirm and annotate a synced session; confirmation is optional (auto-confirm after 24 h).

**E5.3 — VO2max & aerobic trend**
- AC1: Watch VO2max estimates store as raw metrics; UI shows raw dots + smoothed trend, never single-reading deltas.
- AC2: Progress shows weekly Zone-2 minutes vs target and resting HR trend.
- AC3: The coach reports VO2max movement on a quarterly cadence, coaching the inputs weekly.

**E5.4 — Rich run detail** *(added Jul 2026, shipped)*
As James, I want a run's detail screen to show what actually happened — zones, the route, the HR curve — so that a synced run is worth opening.
- AC1: HR and GPS series from HAE are stored per cardio session (downsampled), not discarded after aggregation; sessions ingested before series capture gain traces when HAE re-sends the day.
- AC2: Detail shows the route on a street basemap (MapLibre GL + hosted MapTiler vector tiles, styled from the app's design tokens in both themes and all accent palettes; key admin-managed, lazy-loaded) with the self-contained SVG trace as the instant first paint and the fallback whenever tiles can't render (no key, offline, tile errors); plus the HR curve with the prescribed band shaded and time-in-zone bars for five HR-max zones. *(Amended Jul 2026: originally "no external map tiles"; revisited once the app went public-ingress — hosted tiles keep map data current with nothing to maintain on-box.)*
- AC3: Zone boundaries come from `prefs.hr_max` when set; otherwise estimated and labeled as such, with a nudge to tell the coach a tested max.

## E6 · Progress & records

**E6.1 — Strength trends**
- AC1: Per-lift estimated 1RM series computed server-side from top sets; segmented chart per lift (no shared axes).
- AC2: Bodyweight (Withings), sessions/week, sleep average render alongside.

**E6.2 — PR ledger**
- AC1: `records` stores e1RM, best set, and rep PRs per exercise with achieved dates and the source set.
- AC2: A new record is written at set-log time, celebrated once (summary), and listed on Records with next-milestone targets.
- AC3: Records never regress; a deload doesn't erase a PB.

**E6.3 — History**
- AC1: One stream of all sessions (strength + cardio) with key stats; missed planned sessions remain visible and marked.
- AC2: Detail view shows prescribed vs performed per exercise, notes, and substitutions.

## E7 · Coach & chat

**E7.1 — Coach chat**
As James, I want to chat with my coach anytime so that questions and data entry are conversational.
- AC1: Chat runs the coach agent loop server-side with the user's MCP toolset; the agent reads live data before answering.
- AC2: Every chat-initiated write (labs, niggles, plan edits) shows a structured confirmation card before committing.
- AC3: Chat history persists per user.

**E7.2 — Weekly review**
- AC1: Sunday job reviews adherence, logged sets/RPE, cardio, recovery metrics, niggles, cool-down skips, substitution patterns; writes the Week N+1 proposal (E3.2) and a readable summary message.
- AC2: The review references concrete data ("bench 8/8/8 twice") — verifiable against the DB.
- AC3: Configured boundaries hold: no medication advice; lab discussion always includes "discuss with your GP" framing.

**E7.3 — Coach settings**
- AC1: Review day/time, propose-vs-auto-apply, progression style, and standing constraints are editable and injected into the agent's instructions verbatim.
- AC2: Auto-apply mode still writes revisions with rationale and notifies; propose mode never activates without approval.

## E8 · Labs

**E8.1 — Log a lipid panel via chat**
- AC1: Pasted results (or a photo of the letter) are parsed to a structured panel (marker, value, unit, ref range) and echoed for confirmation before `labs_log_result` writes.
- AC2: Panels are sparse point-in-time records; dashboard renders reference-band tracks with per-date dots — no interpolation.
- AC3: On a new panel, the coach's interpretation references training/weight changes since the previous panel and suggests next-draw timing; a "next panel due" reminder is set.

## E9 · Niggles

**E9.1 — Niggle lifecycle**
- AC1: A niggle has body part, severity, status (active / watch / cleared), notes, and timestamps; creatable from Settings or via chat ("my knee grumbled").
- AC2: Active niggles constrain exercise selection everywhere (proposals, swaps) by movement-pattern tags, and inject targeted mobility into cool-downs.
- AC3: The weekly review asks about each active niggle until cleared; clearing requires explicit confirmation.

## E10 · Exercise library & media

**E10.1 — Seeded library**
- AC1: Import from an open dataset creates entries with images, instructions, muscle map, and equipment tags; ≥ 400 exercises post-import.
- AC2: Library search + filters (media tier) work; every entry shows muscles, cues, one "don't", equipment.

**E10.2 — Form demos**
- AC1: Tapping an exercise anywhere opens its detail: media (video loop / images / external link per tier), muscle emphasis, cues.
- AC2: Media for today's session is pre-cached by the service worker when on Wi-Fi.

**E10.3 — Owned footage pipeline**
- AC1: The coach maintains a wanted list; requests appear in the library and (if enabled) as filming-request notifications.
- AC2: Uploading a clip (PWA or chat) transcodes via ffmpeg to muted H.264 720p loop + poster; entry upgrades to "owned".
- AC3: Failed transcodes report an actionable error; originals are retained until success.

## E11 · Equipment

**E11.1 — Profiles**
- AC1: Profiles (Gym / Home / Travel) list items including plate inventory and dumbbell range; Home is shareable household-wide, others per-user.
- AC2: The active profile is a hard constraint on proposals and swaps; switching profiles re-validates today's plan and flags unloadable/unavailable items.
- AC3: "I'm at home this week" in chat switches the profile and triggers substitutions, not a broken plan.

## E12 · Notifications

**E12.1 — Exactly three kinds**
- AC1: Web push (installed PWA) supports only: proposal-ready, planned-day reminder, filming request — each independently toggleable, all default sensible.
- AC2: No other server event may send a push (enforced in code, not convention).
- AC3: Reminders respect quiet hours and fire at most once per planned day.

## E13 · Household & privacy

**E13.1 — Hard segregation**
- AC1: Every domain row carries `user_id`; API queries are session-scoped; Postgres RLS enforces the same as a backstop (tested: user A's session cannot read user B's rows even with a crafted request).
- AC2: Each user has their own coach credential; MCP tools take no user parameter — scope comes from the credential.
- AC3: Shared on purpose and nothing else: exercise library, media, and the Home equipment profile.

**E13.2 — Second user onboarding**
- AC1: Shelby's first sign-in walks the same first-run wiring (token, Withings, intake) producing her own credentials and plan.
- AC2: Her coach's intake and proposals are independent of James's data in every respect.

## E14 · Dashboard (desktop)

**E14.1 — Trends at width**
- AC1: `/dashboard` (auth'd) renders block stats, per-lift small multiples, bodyweight vs goal, weekly tonnage, VO2max trend, Zone-2 minutes, lipid tracks, consistency heatmap — from the same queries the agent uses.
- AC2: Responsive from tablet up; charts follow the Void×Volt system (one hue, one axis, direct labels).

## E15 · Operations

**E15.1 — Backups**
- AC1: Nightly `pg_dump` + media rsync to backup storage; restore procedure documented and tested once end-to-end.

**E15.2 — Observability**
- AC1: Health endpoint; ingest-freshness check (no HAE push in 24 h → warning on Connections + optional owner email).
- AC2: Structured logs for auth events, ingest, agent runs; agent token spend visible per run.

**E15.3 — Export**
- AC1: Authenticated JSON export of all of a user's own data (and only theirs).
