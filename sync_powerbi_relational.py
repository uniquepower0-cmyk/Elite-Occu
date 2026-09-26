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
    
    raw_payload = """
    {"exportDataType":0,"executeSemanticQueryRequest":{"version":"1.0.0","queries":[{"Query":{"Commands":[{"SemanticQueryDataShapeCommand":{"Query":{"Version":2,"From":[{"Name":"b","Entity":"BedoCCupancy_Soussi","Type":0}],"Select":[{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"AdmissionDate"},"Name":"BedoCCupancy_Soussi.AdmissionDate"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Bed#"},"Name":"BedoCCupancy_Soussi.BedName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Patient"},"Name":"BedoCCupancy_Soussi.EnglishFullName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Financial Status"},"Name":"BedoCCupancy_Soussi.FinancialStatusGUID"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Floor Name"},"Name":"BedoCCupancy_Soussi.FloorName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Notes"},"Name":"BedoCCupancy_Soussi.Notes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Age"},"Name":"Sum(BedoCCupancy_Soussi.PatientAgeDBComputed)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"MRN"},"Name":"BedoCCupancy_Soussi.PatientBarcode"},{"Measure":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Companions #"},"Name":"BedoCCupancy_Soussi.Count of Companions"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"PaymentBy"},"Name":"BedoCCupancy_Soussi.PaymentBy"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Visit"},"Name":"BedoCCupancy_Soussi.VisitTypeGUID"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"ContractorName"},"Name":"BedoCCupancy_Soussi.ContractorName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"FloorStructureName_EN"},"Name":"BedoCCupancy_Soussi.FloorStructureName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DRG"},"Name":"BedoCCupancy_Soussi.DRG"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Created by DIG"},"Name":"BedoCCupancy_Soussi.Expr1"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DRG Diagnosis"},"Name":"BedoCCupancy_Soussi.Expr3"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"LOS"},"Name":"Sum(BedoCCupancy_Soussi.LOS)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"GeometricMeanLOS"},"Name":"BedoCCupancy_Soussi.GeometricMeanLOS"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Speciality"},"Name":"BedoCCupancy_Soussi.Speciality"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Date Of Patients"},"Name":"BedoCCupancy_Soussi.NewPatients"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"ALOS"},"Name":"BedoCCupancy_Soussi.ALOS"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"ICD-10 Diagnosis"},"Name":"BedoCCupancy_Soussi.Name"},{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Payments"}},"Function":0},"Name":"Sum(BedoCCupancy_Soussi.Payments)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Weight"},"Name":"BedoCCupancy_Soussi.Weight"},{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Difference"}},"Function":0},"Name":"Sum(BedoCCupancy_Soussi.Difference)"},{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"FTotal"}},"Function":0},"Name":"Sum(BedoCCupancy_Soussi.FTotal)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"SSO"},"Name":"BedoCCupancy_Soussi.1"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"LTC Weight"},"Name":"BedoCCupancy_Soussi.2"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"LTC GLOS"},"Name":"BedoCCupancy_Soussi.3"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"PrograssNotes"},"Name":"BedoCCupancy_Soussi.PrograssNotes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"OR Notes"},"Name":"BedoCCupancy_Soussi.OR Notes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Operations"},"Name":"BedoCCupancy_Soussi.Operations"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DefaultMobile"},"Name":"BedoCCupancy_Soussi.DefaultMobile"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"TreatingPhysicianName"},"Name":"BedoCCupancy_Soussi.TreatingPhysicianName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"PrograssNotes Creation Date"},"Name":"BedoCCupancy_Soussi.PrograssNotes Creation Date"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DischargeExpectedDate"},"Name":"BedoCCupancy_Soussi.DischargeExpectedDate"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Hand Over"},"Name":"BedoCCupancy_Soussi.Hand Over"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"EliteALOS"},"Name":"BedoCCupancy_Soussi.EliteALOS"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"EliteWeight"},"Name":"BedoCCupancy_Soussi.EliteWeight"}],"OrderBy":[{"Direction":2,"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DischargeExpectedDate"}}}]},"Binding":{"Primary":{"Groupings":[{"Projections":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38],"Subtotal":0}]},"DataReduction":{"Primary":{"Top":{"Count":1000000}},"Secondary":{"Top":{"Count":100}}},"Version":1}}},{"ExportDataCommand":{"Columns":[{"QueryName":"BedoCCupancy_Soussi.AdmissionDate","Name":"AdmissionDate"},{"QueryName":"BedoCCupancy_Soussi.BedName_EN","Name":"Bed#"},{"QueryName":"BedoCCupancy_Soussi.EnglishFullName","Name":"Patient"},{"QueryName":"BedoCCupancy_Soussi.FinancialStatusGUID","Name":"Financial Status"},{"QueryName":"BedoCCupancy_Soussi.FloorName_EN","Name":"Floor Name"},{"QueryName":"BedoCCupancy_Soussi.Notes","Name":"Notes"},{"QueryName":"Sum(BedoCCupancy_Soussi.PatientAgeDBComputed)","Name":"Age"},{"QueryName":"BedoCCupancy_Soussi.PatientBarcode","Name":"MRN"},{"QueryName":"BedoCCupancy_Soussi.Count of Companions","Name":"Companions #"},{"QueryName":"BedoCCupancy_Soussi.PaymentBy","Name":"PaymentBy"},{"QueryName":"BedoCCupancy_Soussi.VisitTypeGUID","Name":"Visit"},{"QueryName":"BedoCCupancy_Soussi.ContractorName","Name":"ContractorName"},{"QueryName":"BedoCCupancy_Soussi.FloorStructureName_EN","Name":"FloorStructureName_EN"},{"QueryName":"BedoCCupancy_Soussi.DRG","Name":"DRG"},{"QueryName":"BedoCCupancy_Soussi.Expr1","Name":"Created by DIG"},{"QueryName":"BedoCCupancy_Soussi.Expr3","Name":"DRG Diagnosis"},{"QueryName":"Sum(BedoCCupancy_Soussi.LOS)","Name":"LOS"},{"QueryName":"BedoCCupancy_Soussi.GeometricMeanLOS","Name":"GLOS"},{"QueryName":"BedoCCupancy_Soussi.Speciality","Name":"Speciality"},{"QueryName":"BedoCCupancy_Soussi.NewPatients","Name":"Date Of Patients"},{"QueryName":"BedoCCupancy_Soussi.ALOS","Name":"ALOS"},{"QueryName":"BedoCCupancy_Soussi.Name","Name":"ICD-10 Diagnosis"},{"QueryName":"Sum(BedoCCupancy_Soussi.Payments)","Name":"Sum of Payments"},{"QueryName":"BedoCCupancy_Soussi.Weight","Name":"Weight"},{"QueryName":"Sum(BedoCCupancy_Soussi.Difference)","Name":"Remaining"},{"QueryName":"Sum(BedoCCupancy_Soussi.FTotal)","Name":"Sum of FTotal"},{"QueryName":"BedoCCupancy_Soussi.1","Name":"SSO"},{"QueryName":"BedoCCupancy_Soussi.2","Name":"LTC Weight"},{"QueryName":"BedoCCupancy_Soussi.3","Name":"LTC GLOS"},{"QueryName":"BedoCCupancy_Soussi.PrograssNotes","Name":"Handover"},{"QueryName":"BedoCCupancy_Soussi.OR Notes","Name":"OR Notes"},{"QueryName":"BedoCCupancy_Soussi.Operations","Name":"Operations"},{"QueryName":"BedoCCupancy_Soussi.DefaultMobile","Name":"DefaultMobile"},{"QueryName":"BedoCCupancy_Soussi.TreatingPhysicianName","Name":"TreatingPhysicianName"},{"QueryName":"BedoCCupancy_Soussi.PrograssNotes Creation Date","Name":"PrograssNotes Creation Date"},{"QueryName":"BedoCCupancy_Soussi.DischargeExpectedDate","Name":"DischargeExpectedDate"},{"QueryName":"BedoCCupancy_Soussi.Hand Over","Name":"Prograssnotes"},{"QueryName":"BedoCCupancy_Soussi.EliteALOS","Name":"EliteALOS"},{"QueryName":"BedoCCupancy_Soussi.EliteWeight","Name":"EliteWeight"}],"Ordering":[0,1,7,2,32,3,6,4,5,8,10,9,11,12,21,13,14,15,16,17,20,23,33,18,19,25,22,24,26,27,28,35,34,29,36,30,31,37,38],"FiltersDescription":"No filters applied"}}]}}],"cancelQueries":[],"modelId":"477100070","userPreferredLocale":"en-US"}}
    """
    
    while True:
        try:
            log("Fetching live data from Power BI...")
            response = requests.post(export_url, json=json.loads(raw_payload), auth=HttpNtlmAuth(POWERBI_USER, POWERBI_PASS), timeout=20)
            response.raise_for_status()

            df = pd.read_excel(io.BytesIO(response.content))
            
            # Build dynamic column map because PowerBI Excel exports have headers on row 1, 
            # causing pandas to name columns "Unnamed: 1", "Unnamed: 2", etc.
            # The first row in the dataframe contains the actual column names.
            header_row = df.iloc[0].to_dict() if not df.empty else {}
            col_map = {str(v).strip(): k for k, v in header_row.items() if pd.notna(v)}
            
            def get_val(row, possible_names):
                for name in possible_names:
                    key = col_map.get(name)
                    if key and pd.notna(row.get(key)):
                        return row.get(key)
                    # Fallback in case pandas DID read headers correctly
                    if pd.notna(row.get(name)):
                        return row.get(name)
                return ""
            
            def clean_val(val):
                if pd.isna(val): return None
                if isinstance(val, (datetime.date, datetime.datetime, pd.Timestamp)): return val.isoformat()
                return val

            raw_records = df.to_dict(orient="records")
            new_occupancy_rows = [{k: clean_val(v) for k, v in row.items()} for row in raw_records]

            # ---------------------------------------------------------
            # 1. NEW RELATIONAL SYNC (The New Formula)
            # ---------------------------------------------------------
            log(f"Syncing {len(new_occupancy_rows)} records to New Relational Schema...")
            rpc_headers = SUPABASE_HEADERS.copy()
            rpc_headers["Prefer"] = "return=minimal"
            
            rpc_payload = []
            for row in new_occupancy_rows:
                # Skip the header row itself during data extraction
                if str(get_val(row, ["Bed#", "BedName_EN"])) == "Bed#":
                    continue
                    
                ad_val = get_val(row, ["AdmissionDate"])
                
                rpc_payload.append({
                    "MRN": str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف"])),
                    "Patient": str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم"]) or "Unknown"),
                    "Bed#": str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير"])),
                    "Floor Name": str(get_val(row, ["Floor Name", "FloorName_EN", "Floor", "الطابق", "الدور"])),
                    "TreatingPhysicianName": str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج"])),
                    "AdmissionDate": str(ad_val) if ad_val else None
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
            
            legacy_occupancy_rows = []
            
            # Fake header row ensures Node.js startIdx parsing works reliably
            fake_header = {
                "No filters applied": "AdmissionDate",
                "Unnamed: 1": "Bed",
                "Unnamed: 2": "MRN",
                "Unnamed: 3": "Patient",
                "Unnamed: 12": "Financial Status",
                "Unnamed: 22": "TreatingPhysicianName"
            }
            legacy_occupancy_rows.append(fake_header)
            
            for row in raw_records:
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", ""] or "no filters" in bed_val.lower():
                    continue
                    
                legacy_row = {
                    "No filters applied": clean_val(get_val(row, ["AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ"])),
                    "Unnamed: 1": clean_val(bed_val),
                    "Unnamed: 2": clean_val(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف"])),
                    "Unnamed: 3": clean_val(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم"])),
                    "Unnamed: 12": clean_val(get_val(row, ["Financial Status", "ContractorName", "Contractor", "Financial", "الجهة", "الشركة", "جهة الدفع"])),
                    "Unnamed: 22": clean_val(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج"]))
                }
                legacy_occupancy_rows.append(legacy_row)
            
            # Send the reconstructed rigid array so legacy backend parses it flawlessly
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": legacy_occupancy_rows, "previous": existing.get("previous")},
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
