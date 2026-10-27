@echo off
REM Runner #2 (Windows): Starts the Hospital Occupancy Manager & Auto-Sync Supervisor on Windows
cd /d "%~dp0"

echo ========================================================
echo  Starting Hospital Occupancy Sync Runner #2 (Windows)
echo ========================================================

python -c "import requests, requests_ntlm, pandas, openpyxl, schedule" >nul 2>&1
if %errorlevel% neq 0 (
    echo [Setup] Installing required Python packages from requirements.txt...
    python -m pip install -r requirements.txt
)

set MAX_SYNC_RUNNERS=2
call npm run dev
pause
