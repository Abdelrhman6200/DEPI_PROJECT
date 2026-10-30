#!/usr/bin/env bash
# One-command local setup with free tools: env, models, the data spreadsheet (Google Sheets, or the local stand-in),
# n8n credentials and the platform workflow, web app dependencies.
# Usage: bash scripts/setup.sh            (first run, or after changing workflows/src or prompts)
#        bash scripts/setup.sh --reset    (also wipes the n8n volume and the local spreadsheet)
#
# Data: with GOOGLE_SA_EMAIL / GOOGLE_SA_KEY / SHEETS_ID in .env the platform keeps its data in that Google spreadsheet
# (see docs/setup/google-sheets.md); without them it uses the local stand-in at http://localhost:8090.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f infra/docker-compose.yml --env-file .env"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "Environment"
if [ ! -f .env ]; then
  cp .env.example .env
  key=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  sed -i "s/^N8N_ENCRYPTION_KEY=.*/N8N_ENCRYPTION_KEY=${key}/" .env
  # n8n needs an upper-case letter, a digit and a symbol in the owner password.
  owner=$(node -e "console.log(require('crypto').randomBytes(9).toString('hex'))")
  sed -i "s/^N8N_OWNER_PASSWORD=.*/N8N_OWNER_PASSWORD=${owner}Aa1!/" .env
  echo "Created .env. Add your free GEMINI_API_KEY (https://aistudio.google.com/apikey), then run: bash scripts/setup.sh"
fi
# Health data and uploaded documents are encrypted on disk with DATA_ENCRYPTION_KEY. It is created once; without it
# the data cannot be read, so keep a copy of .env (or of this line) somewhere safe, off this computer.
if ! grep -qE '^DATA_ENCRYPTION_KEY=[0-9a-fA-F]{64}$' .env; then
  sed -i '/^DATA_ENCRYPTION_KEY=/d' .env
  printf 'DATA_ENCRYPTION_KEY=%s\n' "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
  echo "Created DATA_ENCRYPTION_KEY in .env. Keep a copy of it somewhere safe: without it the data cannot be read."
fi
set -a; . ./.env; set +a
source scripts/sheets-env.sh

step "Local models (Ollama)"
if command -v ollama >/dev/null; then
  ollama list | grep -q "^${MEDGEMMA_MODEL}" || ollama pull "${MEDGEMMA_MODEL}"
  ollama list | grep -q "^${EMBED_MODEL}" || ollama pull "${EMBED_MODEL}"
else
  echo "Ollama not found. Install it from https://ollama.com, or run: $COMPOSE --profile ollama up -d ollama"
fi

if [ "${1:-}" = "--reset" ]; then
  step "Resetting volumes"
  $COMPOSE down -v
fi

step "Generating the workflow and credentials (data: ${SHEETS_MODE})"
SHEETS_AUTH= node workflows/src/build.mjs | head -2
[ "$SHEETS_MODE" = local ] && SHEETS_AUTH=none node workflows/src/build.mjs | head -1
node scripts/make-credentials.mjs

step "Data spreadsheet"
$COMPOSE up -d sheets
for i in $(seq 1 30); do curl -sf "${SHEETS_HOST_URL}/health" >/dev/null 2>&1 && break; [ "$SHEETS_MODE" = google ] && break; sleep 1; done
# Tabs, headers and rules on every run; the demo or reference data only into empty tabs. Email is switched on only
# when an SMTP server is configured.
email=$([ -n "${SMTP_HOST:-}" ] && [ "${SMTP_HOST:-}" != "smtp.invalid" ] && echo true || echo false)
SHEETS_API_URL="$SHEETS_HOST_URL" node scripts/sheets-setup.mjs --flag "email_delivery=${email}"
# The Sheets cache (n8n reads through it) drops what the setup wrote straight to the spreadsheet.
$COMPOSE up -d sheets-cache >/dev/null 2>&1; curl -s -X POST "http://localhost:${SHEETS_CACHE_PORT:-8094}/invalidate" >/dev/null 2>&1 || true

step "Starting n8n"
[ "${SMTP_HOST:-}" = "mailpit" ] && $COMPOSE up -d mailpit
$COMPOSE up -d n8n
printf 'Waiting for n8n'
# Ready means the database migrations have finished too (the CLI commands below must not run them a second time).
for i in $(seq 1 120); do
  curl -sf "http://localhost:${N8N_PORT}/healthz/readiness" >/dev/null 2>&1 && break
  printf '.'; sleep 2
done
echo

step "n8n owner account"
# Retried: right after a start n8n can refuse it for a while. "already setup" means an earlier run created it.
for i in $(seq 1 20); do
  out=$(curl -s -X POST "http://localhost:${N8N_PORT}/rest/owner/setup" -H 'Content-Type: application/json' -w ' HTTP%{http_code}' \
    -d "{\"email\":\"${N8N_OWNER_EMAIL}\",\"firstName\":\"Platform\",\"lastName\":\"Owner\",\"password\":\"${N8N_OWNER_PASSWORD}\"}" || true)
  case "$out" in *HTTP200) echo "owner created"; break;; *'already setup'*) echo "owner already exists"; break;; esac
  sleep 3
done
case "$out" in *HTTP200|*'already setup'*) ;; *) echo "WARNING: n8n owner setup failed: ${out:0:200}";; esac

step "Importing credentials and the platform workflow"
$COMPOSE exec -T n8n n8n import:credentials --input=/import/credentials.json
# The whole platform is one workflow (workflows/n8n/health-platform.json).
PLATFORM_ID=$(sed -n 's/^ "id": "\([^"]*\)",$/\1/p' workflows/n8n/health-platform.json | head -1)
API_ID=$(sed -n 's/^ "id": "\([^"]*\)",$/\1/p' workflows/n8n/health-platform-api.json | head -1)
$COMPOSE exec -T n8n n8n import:workflow --separate --input="$WORKFLOW_IMPORT"
for id in "$PLATFORM_ID" "$API_ID"; do $COMPOSE exec -T n8n n8n publish:workflow --id="$id" >/dev/null 2>&1 || echo "  publish failed: $id"; done
$COMPOSE restart n8n
# A restart stops running executions: their claimed events go back to the queue so the dispatcher retries them now.
SHEETS_API_URL="$SHEETS_HOST_URL" node scripts/sheets-setup.mjs --release-claims >/dev/null
# The knowledge base is read from the Drive folder right away (the dispatcher starts it within a minute).
SHEETS_API_URL="$SHEETS_HOST_URL" node scripts/sheets-setup.mjs --queue-knowledge-sync >/dev/null
curl -s -X POST "http://localhost:${SHEETS_CACHE_PORT:-8094}/invalidate" >/dev/null 2>&1 || true
for i in $(seq 1 90); do curl -sf "http://localhost:${N8N_PORT}/healthz" >/dev/null 2>&1 && break; sleep 2; done

step "Web app dependencies"
pnpm install --silent
[ -f apps/web/.env.local ] || echo "N8N_URL=${N8N_URL}" > apps/web/.env.local

step "Smoke test"
for i in $(seq 1 60); do
  out=$(curl -s -X POST "http://localhost:${N8N_PORT}/webhook/api/v1/auth" -H 'Content-Type: application/json' \
    -d "{\"action\":\"login\",\"data\":{\"email\":\"p1@demo.health\",\"password\":\"${DEMO_PASSWORD:-Demo@2026}\"}}" || true)
  case "$out" in *'"ok":true'*) echo "login OK"; break;; esac
  sleep 2
done
case "$out" in *'"ok":true'*) ;; *) echo "API not ready: ${out:0:200}";; esac

cat <<EOF

Done.
  n8n editor:   http://localhost:${N8N_PORT}   (${N8N_OWNER_EMAIL} / password: N8N_OWNER_PASSWORD in .env)
  Start web:    pnpm dev        then open http://localhost:3000   (demo password: ${DEMO_PASSWORD:-Demo@2026})
  Data:         ${SHEETS_DESCRIPTION}
EOF
