#!/usr/bin/env bash
# Migrate Forge from this Mac to the home server (Docker over SSH).
# Prereq: key-based SSH to the server works (ssh user@host true).
# Usage: ./deploy/migrate-to-server.sh user@host
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -ge 1 ] || { echo "Usage: $0 user@host"; exit 1; }
TARGET="$1"
HOST="${TARGET#*@}"
PORT="$(sed -n 's/.*"\([0-9]*\):8000".*/\1/p' docker-compose.yml)"; PORT="${PORT:-33524}"
CTX=forge-server

echo "== 1/6  Docker context → $TARGET"
docker context inspect $CTX >/dev/null 2>&1 || docker context create $CTX --docker "host=ssh://$TARGET"
docker --context $CTX info --format '{{.ServerVersion}} ({{.OSType}}/{{.Architecture}})' \
  || { echo "!! Docker daemon not reachable on $TARGET — is Docker installed there?"; exit 1; }

echo "== 2/6  Snapshot local database"
docker compose exec -T db pg_dump -U forge -d forge --clean --if-exists > /tmp/forge-migrate.sql
echo "   $(wc -l < /tmp/forge-migrate.sql) lines dumped"

echo "== 3/6  Point BASE_URL at the server"
sed -i '' "s|- BASE_URL=.*|- BASE_URL=http://$HOST:$PORT|" docker-compose.override.yml 2>/dev/null \
  || sed -i '' "s|- BASE_URL=.*|- BASE_URL=http://$HOST:$PORT|" docker-compose.yml

echo "== 4/6  Build + start on the server (compose + override values from this Mac)"
docker --context $CTX compose -p forge -f docker-compose.yml -f docker-compose.override.yml \
       -f docker-compose.build.yml up -d --build
echo "   waiting for Postgres…"
for i in $(seq 1 30); do
  docker --context $CTX compose -p forge exec -T db pg_isready -U forge -d forge >/dev/null 2>&1 && break
  sleep 2
done

echo "== 5/6  Restore data into the server's Postgres"
docker --context $CTX compose -p forge exec -T db psql -U forge -d forge -q < /tmp/forge-migrate.sql
docker --context $CTX compose -p forge restart api >/dev/null

echo "== 6/6  Verify"
sleep 4
curl -sf "http://$HOST:$PORT/healthz" && echo "  ← healthz OK on $HOST"
rm -f /tmp/forge-migrate.sql

cat <<EOF

Done. Forge now runs on $HOST:$PORT with your full data.
Manual follow-ups:
  · iPhone (you + Shelby): Health Auto Export → change the REST API URL to
    http://$HOST:$PORT/ingest?token=<same token>  (tokens migrated with the DB)
  · Reinstall the PWA from http://$HOST:$PORT (Add to Home Screen) — it's a new origin,
    so the home-screen app, push subscription and offline queue start fresh there.
  · Stop the old stack on this Mac once you're happy:  docker compose down
    (data stays in the local volume as a fallback until you remove it)
  · Future deploys from this Mac:
      docker --context $CTX compose -p forge -f docker-compose.yml \
        -f docker-compose.override.yml -f docker-compose.build.yml up -d --build
EOF
