#!/usr/bin/env bash
# Stores your free Google AI Studio key in .env and updates the n8n credential. Usage: bash scripts/set-gemini-key.sh <API_KEY> [model]
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
[ -n "${1:-}" ] || { echo "usage: bash scripts/set-gemini-key.sh <API_KEY> [model]"; exit 1; }
sed -i "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$1|" .env
[ -n "${2:-}" ] && sed -i "s|^GEMINI_MODEL=.*|GEMINI_MODEL=$2|" .env
set -a; . ./.env; set +a
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}?key=$1" || true)
case "${code:-000}" in
  200) echo "Gemini model check (${GEMINI_MODEL}): OK" ;;
  000) echo "Gemini could not be reached (network or DNS problem). The key was saved; the check will work once you are online." ;;
  *)   echo "Gemini model check (${GEMINI_MODEL}): HTTP ${code} - check the key, or pick another model with: bash scripts/set-gemini-key.sh <KEY> <model>" ;;
esac
node scripts/make-credentials.mjs
COMPOSE="docker compose -f infra/docker-compose.yml --env-file .env"
$COMPOSE exec -T n8n n8n import:credentials --input=/import/credentials.json 2>&1 | grep -i "imported"
$COMPOSE up -d n8n >/dev/null   # picks up GEMINI_MODEL changes from .env
echo "Done. AI workflows now use Gemini."
