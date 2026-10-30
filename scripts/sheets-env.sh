#!/usr/bin/env bash
# Sourced by setup.sh, deploy-workflows.sh and test-all.sh after .env: where the platform's data lives.
#   Google   GOOGLE_SA_EMAIL, GOOGLE_SA_KEY and SHEETS_ID are set: the workflow uses the service account credential and
#            the real Sheets and Drive APIs.
#   Local    otherwise: the stand-in (scripts/sheets-emulator.mjs, compose service "sheets") with spreadsheet "local" and
#            the knowledge folder ai/knowledge; the workflow's Sheets and Drive nodes then use no credential (SHEETS_AUTH=none).
if [ -n "${GOOGLE_SA_EMAIL:-}" ] && [ -n "${SHEETS_ID:-}" ] && [ "${SHEETS_ID}" != "local" ]; then
  export SHEETS_MODE=google
  export SHEETS_HOST_URL="https://sheets.googleapis.com"
  # n8n talks to Google directly.
  export SHEETS_API_URL=https://sheets.googleapis.com DRIVE_API_URL=https://www.googleapis.com SHEETS_AUTH=google
  export SHEETS_DESCRIPTION="Google spreadsheet https://docs.google.com/spreadsheets/d/${SHEETS_ID}"
  export WORKFLOW_IMPORT=/workflows/   # the platform and its API (two files)
else
  export SHEETS_MODE=local
  export SHEETS_ID=local
  export SHEETS_HOST_URL="http://localhost:${SHEETS_EMULATOR_PORT:-8090}"
  # n8n talks to the stand-in (compose service "sheets") without Google credentials.
  export SHEETS_API_URL=http://sheets:8090 DRIVE_API_URL=http://sheets:8090 SHEETS_AUTH=none DRIVE_KNOWLEDGE_FOLDER_ID=knowledge
  export SHEETS_DESCRIPTION="local Sheets stand-in ${SHEETS_HOST_URL} (spreadsheet 'local'; knowledge folder ai/knowledge)"
  export WORKFLOW_IMPORT=/workflows-local/
fi
