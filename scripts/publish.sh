#!/usr/bin/env bash
# Gives the running local stack a public https link: builds the web app as a Docker container and starts a free
# Cloudflare quick tunnel to it (no account needed). Only the web app is published; the n8n editor, the data stand-in
# and Mailpit stay on this computer. The link works while this computer and Docker are running, and changes on every start.
#
#   bash scripts/publish.sh          start (or rebuild) and print the link
#   bash scripts/publish.sh --link   print the current link
#   bash scripts/publish.sh --stop   stop the web container and the tunnel (the link stops working)
#
# The rest of the stack (n8n, data) must already be running: bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f infra/docker-compose.yml --env-file .env --profile public"

# Prints the newest link from the tunnel's log, or nothing (never fails: the script runs with set -e).
link() { { $COMPOSE logs tunnel 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1; } || true; }

case "${1:-}" in
  --stop)
    $COMPOSE stop tunnel web >/dev/null 2>&1 || true
    $COMPOSE rm -f tunnel web >/dev/null 2>&1 || true
    echo "Public link stopped."
    exit 0 ;;
  --link)
    l=$(link); [ -n "$l" ] && echo "$l" || { echo "No public link is running. Start one with: bash scripts/publish.sh"; exit 1; }
    exit 0 ;;
esac

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${N8N_PORT:-5678}/webhook/api/v1/auth" \
     -H 'Content-Type: application/json' -d '{"action":"me"}' || true)
if [ "$code" != "401" ]; then   # "sign in required" means the API is up
  echo "The API is not answering on this computer. Start the stack first: bash scripts/setup.sh"
  exit 1
fi

echo "==> Building the web app container (a few minutes the first time)"
# --no-deps: never recreate or restart n8n and the data service, which are already running.
$COMPOSE up -d --no-deps --build web
for i in $(seq 1 60); do
  curl -sf -o /dev/null "http://localhost:${WEB_PORT:-3300}/login" && break
  sleep 2
done

echo "==> Starting the public tunnel"
$COMPOSE up -d --no-deps --force-recreate tunnel
l=""
for i in $(seq 1 60); do l=$(link); [ -n "$l" ] && break; sleep 2; done
[ -n "$l" ] || { echo "The tunnel did not report a link. See: $COMPOSE logs tunnel"; exit 1; }

# A new quick-tunnel name can take a little while to resolve everywhere.
ok=""
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$l/login" || true)
  [ "$code" = "200" ] && { ok=1; break; }
  sleep 4
done
api=$(curl -s -X POST "$l/n8n/api/v1/auth" -H 'Content-Type: application/json' -d '{"action":"me"}' || true)

echo
if [ -n "$ok" ]; then echo "Public link: $l"; else echo "Public link (still starting up, try again in a minute): $l"; fi
case "$api" in *unauthorized*) echo "API through the link: OK" ;; *) echo "API through the link: not answering yet" ;; esac
echo "Stop it with: bash scripts/publish.sh --stop"
