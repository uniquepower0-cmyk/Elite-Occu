import os
import io
import sys
import json
import time
import urllib3
import datetime
import requests
import schedule
import pandas as pd
from urllib.parse import urlparse, parse_qs
from requests_ntlm import HttpNtlmAuth

# Suppress insecure HTTPS connection warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# --- CONFIGURATION & CREDENTIALS ---
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://uuvomcxbgldgtmuqtymk.supabase.co")
SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1dm9tY3hiZ2xkZ3RtdXF0eW1rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODkwNTQ4MSwiZXhwIjoyMTA0NDgxNDgxfQ.qd80QNiyhjO51Ky4zxKmzXtOb-bB4hFvhZ3cYnVoyn0"
)

FORTINET_USER = os.getenv("FORTINET_USER", "mohanad.elmaamoun")
FORTINET_PASS = os.getenv("FORTINET_PASS", "Me@111222")

POWERBI_USER = os.getenv("POWERBI_USER", "biviewer")
POWERBI_PASS = os.getenv("POWERBI_PASS", "123456")

# Endpoints
SUPABASE_REST_URL = f"{SUPABASE_URL}/rest/v1/rtdb_nodes"
SUPABASE_RPC_URL = f"{SUPABASE_URL}/rest/v1/rpc/sync_powerbi_admissions"

SUPABASE_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=representation"
}

# --- LOGGING & CONSOLE HELPERS ---

def log(msg):
    timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    sys.stdout.write("\r" + " " * 90 + "\r")
    print(f"[{timestamp}] {msg}")

def failure_countdown(seconds, task_name):
    for i in range(seconds, 0, -1):
        timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        sys.stdout.write(f"\r[{timestamp}] {task_name} failed. Retrying in {i}s... ")
        sys.stdout.flush()
        time.sleep(1)
    sys.stdout.write("\r" + " " * 90 + "\r")

# --- AUTHENTICATION ---

def fortinet_reconnect():
    login_url = "http://10.0.17.4:1000/login"
    logout_url = "http://10.0.17.4:1000/logout"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

    while True:
        with requests.Session() as session:
            session.headers.update(headers)
            log("Initiating Fortinet session reset...")
            try:
                try:
                    session.get(logout_url, timeout=10)
                except:
                    pass
                time.sleep(3)
                credentials = {"username": FORTINET_USER, "password": FORTINET_PASS}
                login_page = session.get(login_url, timeout=10)
                parsed_url = urlparse(login_page.url)
                magic_token = parse_qs(parsed_url.query).get('magic', [None])[0]
                if magic_token:
                    credentials['magic'] = magic_token
                response = session.post(login_page.url, data=credentials, timeout=15)
                if response.status_code in [200, 302, 303]:
                    log("Successfully authenticated with Fortinet Firewall.")
                    return True
            except requests.exceptions.ConnectionError:
                return True
            except Exception as e:
                log(f"Fortinet error: {e}")
        failure_countdown(5, "Fortinet Authentication")

# --- LEGACY STATE (Kept alive to prevent frontend breaking during transition) ---
def fetch_existing_supabase_state():
    get_url = f"{SUPABASE_REST_URL}?or=(path.like.state/*,path.like.settings/*)&select=path,data"
    state_map = {}
    try:
        res = requests.get(get_url, headers=SUPABASE_HEADERS, timeout=15, verify=False)
        if res.status_code == 200:
            for record in res.json():
                state_map[record["path"]] = record["data"]
    except:
        pass
    
    # Minimal fallback mappings
    dataset = state_map.get("state/dataset") or {}
    occ = state_map.get("state/occupancy") or {}
    return {
        "previous": occ.get("previous") or dataset.get("current"),
        "discharged": (state_map.get("state/discharged") or {}).get("patients", []),
        "entries": (state_map.get("state/entries") or {}).get("items", []),
        "transfers": (state_map.get("state/transfers") or {}).get("items", []),
        "orList": (state_map.get("state/or_list") or {}).get("items", [])
    }

# --- FETCH & SYNC ---

def fetch_powerbi_and_sync():
    export_url = "http://10.12.0.11/powerbi/api/explore/reports/ca9cb448-faa1-41d0-ad8e-f4af14ec7bbd/export/xlsx"
    
    # Note: Shortened payload string for script brevity (matches your original)
    raw_payload = """{"exportDataType":0,"executeSemanticQueryRequest":{"version":"1.0.0","queries":[{"Query":{"Commands":[{"SemanticQueryDataShapeCommand":{"Query":{"Version":2,"From":[{"Name":"b","Entity":"BedoCCupancy_Soussi","Type":0}],"Select":[{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"AdmissionDate"},"Name":"BedoCCupancy_Soussi.AdmissionDate"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Bed#"},"Name":"BedoCCupancy_Soussi.BedName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Patient"},"Name":"BedoCCupancy_Soussi.EnglishFullName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"MRN"},"Name":"BedoCCupancy_Soussi.PatientBarcode"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Floor Name"},"Name":"BedoCCupancy_Soussi.FloorName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"TreatingPhysicianName"},"Name":"BedoCCupancy_Soussi.TreatingPhysicianName"}],"OrderBy":[{"Direction":2,"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DischargeExpectedDate"}}}]},"Binding":{"Primary":{"Groupings":[{"Projections":[0,1,2,3,4,5],"Subtotal":0}]},"DataReduction":{"Primary":{"Top":{"Count":100000}},"Secondary":{"Top":{"Count":100}}},"Version":1}}},{"ExportDataCommand":{"Columns":[{"QueryName":"BedoCCupancy_Soussi.AdmissionDate","Name":"AdmissionDate"},{"QueryName":"BedoCCupancy_Soussi.BedName_EN","Name":"Bed#"},{"QueryName":"BedoCCupancy_Soussi.EnglishFullName","Name":"Patient"},{"QueryName":"BedoCCupancy_Soussi.PatientBarcode","Name":"MRN"},{"QueryName":"BedoCCupancy_Soussi.FloorName_EN","Name":"Floor Name"},{"QueryName":"BedoCCupancy_Soussi.TreatingPhysicianName","Name":"TreatingPhysicianName"}],"Ordering":[0,1,2,3,4,5],"FiltersDescription":"No filters applied"}}]}}],"cancelQueries":[],"modelId":"477100070","userPreferredLocale":"en-US"}}"""
    
    while True:
        try:
            log("Fetching live data from Power BI...")
            response = requests.post(export_url, json=json.loads(raw_payload), auth=HttpNtlmAuth(POWERBI_USER, POWERBI_PASS), timeout=20)
            response.raise_for_status()

            df = pd.read_excel(io.BytesIO(response.content))
            
            def clean_val(val):
                if pd.isna(val): return None
                if isinstance(val, (datetime.date, datetime.datetime, pd.Timestamp)): return val.isoformat()
                return val

            raw_records = df.to_dict(orient="records")
            new_occupancy_rows = [{k: clean_val(v) for k, v in row.items()} for row in raw_records]

            # ---------------------------------------------------------
            # 1. NEW RELATIONAL SYNC (The New Formula)
            # Sends the flat array to PostgreSQL, which handles Upserts and Auto-Discharges instantly.
            # ---------------------------------------------------------
            log(f"Syncing {len(new_occupancy_rows)} records to New Relational Schema...")
            rpc_headers = SUPABASE_HEADERS.copy()
            rpc_headers["Prefer"] = "return=minimal"
            
            # Format payload for the RPC function (ensuring MRN is string)
            rpc_payload = []
            for row in new_occupancy_rows:
                rpc_payload.append({
                    "MRN": str(row.get("MRN", "")),
                    "Patient": row.get("Patient"),
                    "Bed#": row.get("Bed#"),
                    "Floor Name": row.get("Floor Name"),
                    "TreatingPhysicianName": row.get("TreatingPhysicianName"),
                    "AdmissionDate": row.get("AdmissionDate")
                })
                
            # PostgREST expects the JSON keys to match the SQL function parameter names.
            # Since our SQL function is `sync_powerbi_admissions(payload JSON)`, we must wrap the array in `{"payload": [...]}`
            rpc_res = requests.post(SUPABASE_RPC_URL, headers=rpc_headers, json={"payload": rpc_payload}, verify=False)
            if rpc_res.status_code not in [200, 204]:
                log(f"RPC Relational Sync Failed: {rpc_res.text}")
            else:
                log("Relational Database successfully synchronized!")

            # ---------------------------------------------------------
            # 2. LEGACY JSON SYNC (Keeps existing frontend alive)
            # ---------------------------------------------------------
            existing = fetch_existing_supabase_state()
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": new_occupancy_rows, "previous": existing["previous"]},
                    "updated_at": now_iso
                }
            ]
            sb_response = requests.post(SUPABASE_REST_URL, headers=SUPABASE_HEADERS, json=granular_nodes, verify=False)
            
            if sb_response.status_code in [200, 201]:
                log("Legacy JSON state updated.")
                return True

        except Exception as e:
            log(f"Sync error: {e}")

        failure_countdown(5, "Data Fetch & Sync")

def run_sync_job():
    log("=== STARTING SYNC JOB ===")
    fortinet_reconnect()
    fetch_powerbi_and_sync()

if __name__ == "__main__":
    log("Service Online. Initializing first run...")
    run_sync_job()
    schedule.every(5).minutes.do(run_sync_job)

    while True:
        schedule.run_pending()
        next_run = schedule.next_run()
        if next_run:
            now = datetime.datetime.now()
            time_remaining = (next_run - now).total_seconds()
            if time_remaining > 0:
                mins, secs = divmod(int(time_remaining), 60)
                sys.stdout.write(f"\r[{now.strftime('%Y-%m-%d %H:%M:%S')}] Next job in: {mins:02d}:{secs:02d}   ")
                sys.stdout.flush()
        time.sleep(1)
