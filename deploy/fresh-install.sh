#!/usr/bin/env bash
# Fresh install of Forge on a new server — clean database, no data carried over.
# Run from a clone of the repo on the target machine. Needs Docker + compose v2.
#
# Usage:
#   ./deploy/fresh-install.sh
#   ALLOWED_USERS="you@x.com:You,her@y.com:Her" ./deploy/fresh-install.sh
#
# The tracked docker-compose.yml carries placeholder values only. This script
# writes the real secrets into docker-compose.override.yml (gitignored), which
# compose merges automatically. It never touches an existing override or the
# pgdata volume. (Deploying via Portainer instead? Skip this script — paste
# docker-compose.yml into the stack editor and edit the values there.)
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "!! Docker is not installed"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "!! docker compose v2 is required"; exit 1; }

if [ -f docker-compose.override.yml ]; then
  echo "!! docker-compose.override.yml already exists — this script only does first-time setup."
  echo "   Edit it by hand, or move it aside to start over."
  exit 1
fi

ALLOWED_USERS="${ALLOWED_USERS:-you@example.com:You,partner@example.com:Partner}"
PORT="$(sed -n 's/.*"\([0-9]*\):8000".*/\1/p' docker-compose.yml)"
PG_PASSWORD="$(openssl rand -hex 32)"

echo "== 1/4  Writing docker-compose.override.yml (generated secrets)"
cat > docker-compose.override.yml <<EOF
services:
  db:
    environment:
      - POSTGRES_PASSWORD=$PG_PASSWORD
  api:
    environment:
      - DATABASE_URL=postgresql+psycopg://forge:$PG_PASSWORD@db:5432/forge
      - SESSION_SECRET=$(openssl rand -hex 32)
      - ALLOWED_USERS=$ALLOWED_USERS
      - BASE_URL=http://$(hostname -f 2>/dev/null || hostname):$PORT
EOF
chmod 600 docker-compose.override.yml

echo "== 2/4  Building and starting the stack"
docker compose up -d --build

echo "== 3/4  Generating Web Push (VAPID) keys"
docker compose run --rm --no-deps api python -m app.vapid | sed 's/^/      - /' >> docker-compose.override.yml
docker compose up -d api   # restart with the keys loaded

echo "== 4/4  Verifying"
for i in $(seq 1 30); do
  curl -sf "localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "localhost:$PORT/healthz" && echo "  ← healthz OK"

cat <<EOF

Done — clean install, empty database (users + exercise library seeded on boot).
Next steps:
  · Open http://<this-host>:$PORT, sign in with a dev button, run onboarding.
  · Fix ALLOWED_USERS in docker-compose.override.yml if the placeholder email
    is still there, then: docker compose up -d
  · Settings → Connections → ROTATE to mint your Health Auto Export token.
  · Add ANTHROPIC_API_KEY to the override file to wake the coach.
  · When you have a domain: Google OAuth creds + BASE_URL=https://... (README).
EOF
