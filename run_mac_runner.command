#!/usr/bin/env zsh
# ============================================================================
# Runner #1 (macOS Standalone): Runs sync_powerbi_relational.py directly!
# Uses local .venv to avoid macOS "externally-managed-environment" error.
# ============================================================================
cd "$(dirname "$0")"

echo "========================================================"
echo " Hospital Occupancy Sync Runner #1 (macOS Standalone)"
echo "========================================================"

if [ ! -d ".venv" ]; then
  echo "[Setup] Creating virtual environment (.venv)..."
  python3 -m venv .venv
fi

VENV_PY="./.venv/bin/python3"
VENV_PIP="./.venv/bin/pip"

if ! $VENV_PY -c "import urllib3, requests, requests_ntlm, pandas, openpyxl, schedule" >/dev/null 2>&1; then
  echo "[Setup] Installing required Python packages into .venv from requirements.txt..."
  $VENV_PIP install -r requirements.txt
fi

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting sync_powerbi_relational.py..."
  $VENV_PY -u sync_powerbi_relational.py
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sync script exited. Restarting in 10 seconds..."
  sleep 10
done
