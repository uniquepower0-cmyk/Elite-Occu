@echo off
REM ============================================================================
REM Runner #2 (Windows Standalone): Runs sync_powerbi_relational.py directly!
REM Only requires Python (no Node.js or full project folder needed).
REM ============================================================================
cd /d "%~dp0"

echo ========================================================
echo  Hospital Occupancy Sync Runner #2 (Windows Standalone)
echo ========================================================

python -c "import urllib3, requests, requests_ntlm, pandas, openpyxl, schedule" >nul 2>&1
if %errorlevel% neq 0 (
    echo [Setup] Installing required Python packages from requirements.txt...
    python -m pip install -r requirements.txt
)

:loop
echo [%date% %time%] Starting sync_powerbi_relational.py...
python -u sync_powerbi_relational.py
echo [%date% %time%] Sync script exited. Restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop
