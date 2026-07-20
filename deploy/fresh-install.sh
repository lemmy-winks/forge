#!/usr/bin/env bash
# Fresh install of Forge on a new server — clean database, no data carried over.
# Run from a clone of the repo on the target machine. Needs Docker + compose v2.
#
# Usage:
#   ./deploy/fresh-install.sh
#   ALLOWED_USERS="you@x.com:You,her@y.com:Her" ./deploy/fresh-install.sh
#
# What it does: writes a .env with freshly generated secrets, builds and starts
# the stack, generates VAPID keys inside the built image, and verifies /healthz.
# It never touches an existing .env or an existing pgdata volume.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "!! Docker is not installed"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "!! docker compose v2 is required"; exit 1; }

if [ -f .env ]; then
  echo "!! .env already exists — this script only does first-time setup."
  echo "   Edit .env by hand, or move it aside to start over."
  exit 1
fi

ALLOWED_USERS="${ALLOWED_USERS:-you@example.com:You,partner@example.com:Partner}"
FORGE_PORT="${FORGE_PORT:-33524}"

echo "== 1/4  Writing .env (secrets generated, everything else at defaults)"
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)

# First user is admin. Replace any placeholder emails before people sign in.
ALLOWED_USERS=$ALLOWED_USERS

# LAN-only until Google OAuth + public ingress are configured (see README).
BASE_URL=http://$(hostname -f 2>/dev/null || hostname):$FORGE_PORT
FORGE_PORT=$FORGE_PORT
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
DEV_AUTH=false

# Coach is idle until an API key from console.anthropic.com is set here.
ANTHROPIC_API_KEY=
COACH_MODEL=claude-sonnet-5
COACH_TZ=Europe/London

# Withings direct OAuth (optional; needs public ingress for webhooks)
WITHINGS_CLIENT_ID=
WITHINGS_CLIENT_SECRET=
EOF
chmod 600 .env

echo "== 2/4  Building and starting the stack"
docker compose up -d --build

echo "== 3/4  Generating Web Push (VAPID) keys"
docker compose run --rm --no-deps api python -m app.vapid >> .env
docker compose up -d api   # restart with the keys loaded

echo "== 4/4  Verifying"
for i in $(seq 1 30); do
  curl -sf "localhost:$FORGE_PORT/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "localhost:$FORGE_PORT/healthz" && echo "  ← healthz OK"

cat <<'EOF'

Done — clean install, empty database (users + exercise library seeded on boot).
Next steps:
  · Open http://<this-host>:<FORGE_PORT>, sign in with a dev button, run onboarding.
  · Fix ALLOWED_USERS in .env if the placeholder email is still there, then
    `docker compose up -d` to apply.
  · Settings → Connections → ROTATE to mint your Health Auto Export token.
  · Add ANTHROPIC_API_KEY to .env to wake the coach.
  · When you have a domain: Google OAuth creds + BASE_URL=https://... (README).
EOF
