#!/usr/bin/env zsh
# Runner #1 (macOS): Starts the Hospital Occupancy Manager & Auto-Sync Supervisor on macOS
set -e
cd "$(dirname "$0")"

echo "========================================================"
echo " Starting Hospital Occupancy Sync Runner #1 (macOS)"
echo "========================================================"

if ! python3 -c "import requests, requests_ntlm, pandas, openpyxl, schedule" >/dev/null 2>&1; then
  echo "[Setup] Installing required Python packages from requirements.txt..."
  python3 -m pip install -r requirements.txt
fi

export MAX_SYNC_RUNNERS=2
npm run dev
