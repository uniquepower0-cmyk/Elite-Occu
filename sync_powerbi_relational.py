import os
import io
import re
import sys
import uuid
import json
import time
import urllib3
import datetime
import zoneinfo
import requests
import schedule
import pandas as pd
from urllib.parse import urlparse, parse_qs
from requests_ntlm import HttpNtlmAuth

# Suppress insecure HTTPS connection warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CAIRO_TZ = zoneinfo.ZoneInfo("Africa/Cairo")

def get_cairo_now():
    return datetime.datetime.now(CAIRO_TZ)

def is_today_cairo(iso_str, today_cairo_str):
    if not iso_str:
        return False
    try:
        clean = str(iso_str).replace("Z", "+00:00")
        dt = datetime.datetime.fromisoformat(clean)
        dt_cairo = dt.astimezone(CAIRO_TZ)
        return dt_cairo.strftime("%Y-%m-%d") == today_cairo_str
    except:
        return False

def is_date_today_cairo(d_val, today_cairo_str=None):
    if not d_val:
        return False
    if not today_cairo_str:
        today_cairo_str = get_cairo_now().strftime("%Y-%m-%d")
    try:
        parts = today_cairo_str.split("-")
        c_yr = int(parts[0])
        c_mo = int(parts[1])
        c_dy = int(parts[2])
    except:
        return False

    s = str(d_val).strip()
    if not s or s.lower() in ["nan", "none", "null", "nat", "undefined"]:
        return False

    # Check ISO format with time zone
    if "t" in s.lower() or "z" in s.lower() or "+" in s:
        try:
            clean = s.replace("Z", "+00:00")
            dt = datetime.datetime.fromisoformat(clean)
            dt_cairo = dt.astimezone(CAIRO_TZ)
            return dt_cairo.strftime("%Y-%m-%d") == today_cairo_str
        except:
            pass

    date_part = re.split(r"[\sT]", s)[0]
    m = re.match(r"^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$", date_part)
    if m:
        p1, p2, p3 = int(m.group(1)), int(m.group(2)), int(m.group(3))
        # Case A: YYYY-MM-DD or YYYY/MM/DD
        if p1 > 1000:
            return (p1 == c_yr and p2 == c_mo and p3 == c_dy)
        # Case B: DD-MM-YYYY or MM-DD-YYYY or DD-MM-YY
        yr = p3 if p3 > 1000 else (2000 + p3 if p3 < 100 else p3)
        if yr != c_yr:
            return False
        # Disambiguate against Cairo today
        return (p1 == c_dy and p2 == c_mo) or (p1 == c_mo and p2 == c_dy)

    for fmt in ["%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d", "%d-%m-%y", "%d/%m/%y"]:
        try:
            parsed = datetime.datetime.strptime(date_part, fmt)
            if parsed.year == c_yr and parsed.month == c_mo and parsed.day == c_dy:
                return True
        except:
            continue
    return False

# --- CONFIGURATION & CREDENTIALS ---
# Automatically read local .env file if present
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_path):
    with open(_env_path, "r", encoding="utf-8") as _ef:
        for _line in _ef:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip("'\""))

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://uuvomcxbgldgtmuqtymk.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

FORTINET_USER = os.getenv("FORTINET_USER", "")
FORTINET_PASS = os.getenv("FORTINET_PASS", "")

POWERBI_USER = os.getenv("POWERBI_USER", "")
POWERBI_PASS = os.getenv("POWERBI_PASS", "")

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

# --- NAME NORMALIZATION & MANUAL DISCHARGE RESOLUTION ---

def normalize_arabic_name(name):
    if not name:
        return ""
    n = str(name).strip().lower()
    # Remove titles & honorifics
    n = re.sub(r'^(د/|د\.|دكتور/|دكتور|استاذ/|أستاذ/|السيد/|السيد|السيدة/|السيدة|م/|مهندس/|baby\s+of|baby|طفل|طفلة|ابن|ابنة|مولود|مولودة|twin\s*\d*)\s+', '', n, flags=re.IGNORECASE)
    # Remove diacritics
    n = re.sub(r'[\u064B-\u065F\u0670]', '', n)
    # Normalize alef variations
    n = re.sub(r'[أإآٱ]', 'ا', n)
    # Normalize taa marbuta
    n = re.sub(r'ة', 'ه', n)
    # Normalize yaa
    n = re.sub(r'ى', 'ي', n)
    # Normalize compound names
    n = re.sub(r'\bعبد\s+', 'عبد', n)
    n = re.sub(r'\bابو\s+', 'ابو', n)
    n = re.sub(r'\bام\s+', 'ام', n)
    # Normalize alif-lam prefix for common names (e.g. السيد -> سيد)
    n = re.sub(r'\bال([^\s]{3,})', r'\1', n)
    # Remove special characters
    n = re.sub(r'[^a-z0-9\u0600-\u06FF\s]', ' ', n)
    return re.sub(r'\s+', ' ', n).strip()

def is_name_match(name1, name2):
    if not name1 or not name2:
        return False
    n1 = normalize_arabic_name(name1)
    n2 = normalize_arabic_name(name2)
    if not n1 or not n2:
        return False
    if n1 == n2:
        return True
    w1 = [w for w in n1.split() if len(w) > 1]
    w2 = [w for w in n2.split() if len(w) > 1]
    if not w1 or not w2:
        return False
    s1, s2 = set(w1), set(w2)
    common = s1 & s2
    # Match if >= 2 words match and covers the full shorter name
    if len(common) >= 2 and (common == s1 or common == s2):
        return True
    # Match if 3 or more words match
    if len(common) >= 3:
        return True
    return False

def clean_mrn_str(mrn):
    if mrn is None:
        return ""
    s = str(mrn).strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s.lstrip("0")

def is_patient_manually_discharged(name, mrn, manual_names, manual_mrns):
    c_mrn = clean_mrn_str(mrn)
    if c_mrn and c_mrn in manual_mrns:
        return True
    if name and manual_names:
        for m_name in manual_names:
            if is_name_match(name, m_name):
                return True
    return False

# --- SPECIALTY NORMALIZATION ---
SPECIALTY_CANONICAL_MAP = {
    # Internal Medicine rollup
    "internal medicine": "Internal Medicine",
    "internal medicine clinic": "Internal Medicine",
    "internal medicine (im)": "Internal Medicine",
    "internal": "Internal Medicine",
    "im": "Internal Medicine",
    "pulmonology": "Internal Medicine",
    "hematology": "Internal Medicine",
    "haematology": "Internal Medicine",
    "endocrinology": "Internal Medicine",
    "rheumatology": "Internal Medicine",
    "باطنة": "Internal Medicine",
    "الباطنة": "Internal Medicine",

    # General Surgery rollup
    "general surgery": "General Surgery",
    "general surgery (gs)": "General Surgery",
    "git surgery": "General Surgery",
    "bariatric surgery": "General Surgery",
    "pediatric surgery": "General Surgery",
    "surgical": "General Surgery",
    "gs": "General Surgery",

    # Standalone Specialties
    "cardiology": "Cardiology",
    "pediatric cardiology": "Pediatric Cardiology",
    "pediatrics": "Pediatrics",
    "pediatric": "Pediatrics",
    "vascular surgery": "Vascular Surgery",
    "vascular": "Vascular Surgery",
    "cardiothoracic surgery": "Cardiothoracic Surgery",
    "cardiothoracic": "Cardiothoracic Surgery",
    "urology": "Urology",
    "orthopedic surgery": "Orthopedic Surgery",
    "orthopedics": "Orthopedic Surgery",
    "orthopaedics": "Orthopedic Surgery",
    "ortho": "Orthopedic Surgery",
    "neurosurgery": "Neurosurgery",
    "oncology": "Oncology",
    "neurology": "Neurology",
    "ent": "ENT",
    "obstetrics and gynecology": "Obstetrics and gynecology",
    "ob/gyn": "Obstetrics and gynecology",
    "icu": "ICU",
    "icu.": "ICU",
    "critical care": "ICU",
    "anesthesia and pain therapy": "Anesthesia and pain therapy",
    "physiotherapy": "Physiotherapy",
    "physiotherpy": "Physiotherapy",
    "interventional radiology": "Interventional Radiology",
    "intervential radiology": "Interventional Radiology",
    "dental": "Dental",
    "maxillofacial": "Maxillofacial"
}

def normalize_specialty(raw):
    if not raw:
        return "Other / غير محدد"
    clean = str(raw).strip()
    if not clean or clean in ["0", "-", "nan", "None", "null", "undefined"]:
        return "Other / غير محدد"
    stripped = clean.rstrip(".").strip()
    lower = stripped.lower()
    if lower in ["speciality", "specialty", "external laboratory", "physician", "doctor", "other"]:
        return "Other / غير محدد"
    return SPECIALTY_CANONICAL_MAP.get(lower, stripped)

# --- LEGACY STATE (Kept alive to prevent frontend breaking during transition) ---
def fetch_existing_supabase_state(cairo_date_str=None):
    if not cairo_date_str:
        cairo_date_str = get_cairo_now().strftime("%Y-%m-%d")
    # Egress optimization: fetch only relevant state nodes rather than all state/* nodes
    get_url = f"{SUPABASE_REST_URL}?path=in.(state/metadata,state/discharged,state/dialysis,state/transfers,state/occupancy,state/entries)&select=path,data,updated_at"
    state_map = {}
    time_map = {}
    try:
        res = requests.get(get_url, headers=SUPABASE_HEADERS, timeout=15, verify=False)
        if res.status_code == 200:
            for record in res.json():
                p = record.get("path")
                if p:
                    state_map[p] = record.get("data")
                    time_map[p] = record.get("updated_at")
    except Exception as e:
        log(f"Notice: Failed to fetch existing state from Supabase: {e}")
    
    # Extract metadata & manual discharges
    meta = state_map.get("state/metadata") or {}
    last_active = str(meta.get("lastActiveDate") or "").strip()
    is_new_day = bool(last_active and last_active < cairo_date_str)

    occ = state_map.get("state/occupancy") or {}
    occ_current = occ.get("current") or []
    # If occupancy is empty or only has the header row, a system reset has occurred
    is_system_reset = len(occ_current) <= 1

    raw_manual_names = meta.get("manuallyDischargedNames") or []
    if not isinstance(raw_manual_names, list):
        raw_manual_names = []

    disc_node = state_map.get("state/discharged") or {}
    raw_disc_patients = disc_node.get("patients") if isinstance(disc_node, dict) else (disc_node if isinstance(disc_node, list) else [])
    
    # Discharged cases: only keep if matching TODAY in Cairo time AND not a new day / reset
    clean_disc_patients = []
    if not is_new_day and not is_system_reset and isinstance(raw_disc_patients, list):
        for dp in raw_disc_patients:
            if isinstance(dp, dict):
                d_date = dp.get("dischargeDate") or dp.get("date") or dp.get("updatedAt")
                if d_date:
                    if is_date_today_cairo(d_date, cairo_date_str):
                        clean_disc_patients.append(dp)
                else:
                    disc_updated = time_map.get("state/discharged")
                    if is_today_cairo(disc_updated, cairo_date_str):
                        clean_disc_patients.append(dp)
    disc_patients = clean_disc_patients

    # Manual names/MRNs from clean today's discharges
    manual_names_set = set()
    manual_mrns_set = set()
    if not is_new_day and not is_system_reset:
        for dp in disc_patients:
            if isinstance(dp, dict):
                p_name = dp.get("name") or dp.get("colD")
                p_mrn = clean_mrn_str(dp.get("mrn") or dp.get("colC") or dp.get("PatientBarcode") or "")
                is_manual = (dp.get("dischargeType") == "manual") or (p_name and any(is_name_match(p_name, mn) for mn in raw_manual_names))
                if is_manual:
                    if p_name:
                        manual_names_set.add(str(p_name).strip())
                    if p_mrn:
                        manual_mrns_set.add(p_mrn)

    # Minimal fallback mappings
    dataset = state_map.get("state/dataset") or {}

    # Dialysis cases: only keep if individual date matches TODAY in Cairo time AND not a new day / reset
    dial = state_map.get("state/dialysis") or {}
    raw_dial = dial.get("items", []) if isinstance(dial, dict) else (dial if isinstance(dial, list) else [])
    dial_updated = time_map.get("state/dialysis")
    existing_dial = []
    if raw_dial and not is_new_day and not is_system_reset:
        for p in raw_dial:
            if isinstance(p, dict):
                p_date = p.get("date") or p.get("admissionDate")
                if p_date:
                    if is_date_today_cairo(p_date, cairo_date_str):
                        existing_dial.append(p)
                else:
                    if is_today_cairo(dial_updated, cairo_date_str):
                        existing_dial.append(p)

    # Transfers: only keep if updated TODAY in Cairo time AND not a new day / reset
    trans = state_map.get("state/transfers") or {}
    raw_trans = trans.get("items", []) if isinstance(trans, dict) else (trans if isinstance(trans, list) else [])
    trans_updated = time_map.get("state/transfers")
    existing_trans = raw_trans if (raw_trans and is_today_cairo(trans_updated, cairo_date_str) and not is_new_day and not is_system_reset) else []

    # Entries: only keep if matching TODAY in Cairo time AND not a new day / reset
    ent_node = state_map.get("state/entries") or {}
    raw_ent = ent_node.get("items", []) if isinstance(ent_node, dict) else (ent_node if isinstance(ent_node, list) else [])
    existing_entries = []
    if raw_ent and not is_new_day and not is_system_reset:
        for p in raw_ent:
            if isinstance(p, dict):
                e_date = p.get("date") or p.get("rawDate") or p.get("admissionDate")
                if is_date_today_cairo(e_date, cairo_date_str):
                    existing_entries.append(p)

    return {
        "previous": occ.get("previous") or dataset.get("current"),
        "occupancy_current": occ_current,
        "discharged": disc_patients,
        "entries": existing_entries,
        "transfers": existing_trans,
        "orList": (state_map.get("state/or_list") or {}).get("items", []),
        "dialysis": existing_dial,
        "manually_discharged_names": list(manual_names_set),
        "manually_discharged_mrns": list(manual_mrns_set),
        "existing_metadata": meta,
        "is_new_day": is_new_day,
        "is_system_reset": is_system_reset
    }

# --- FETCH & SYNC ---

def fetch_powerbi_and_sync():
    export_url = "http://10.12.0.11/powerbi/api/explore/reports/9a59efe5-2722-460f-a720-a720d8d1c298/export/xlsx"
    
    raw_payload = """
    {"exportDataType":0,"executeSemanticQueryRequest":{"version":"1.0.0","queries":[{"Query":{"Commands":[{"SemanticQueryDataShapeCommand":{"Query":{"Version":2,"From":[{"Name":"b","Entity":"BedOccupancyMedicalDirector_soussi","Type":0}],"Select":[{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"AdmissionDate"},"Name":"BedoCCupancy_Soussi.AdmissionDate"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Bed#"},"Name":"BedoCCupancy_Soussi.BedName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Patient"},"Name":"BedoCCupancy_Soussi.EnglishFullName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Financial Status"},"Name":"BedoCCupancy_Soussi.FinancialStatusGUID"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Floor Name"},"Name":"BedoCCupancy_Soussi.FloorName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Notes"},"Name":"BedoCCupancy_Soussi.Notes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Age"},"Name":"Sum(BedoCCupancy_Soussi.PatientAgeDBComputed)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"MRN"},"Name":"BedoCCupancy_Soussi.PatientBarcode"},{"Measure":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Companions #"},"Name":"BedoCCupancy_Soussi.Count of Companions"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"PaymentBy"},"Name":"BedoCCupancy_Soussi.PaymentBy"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Visit"},"Name":"BedoCCupancy_Soussi.VisitTypeGUID"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"ContractorName"},"Name":"BedoCCupancy_Soussi.ContractorName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"FloorStructureName_EN"},"Name":"BedoCCupancy_Soussi.FloorStructureName_EN"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DRG"},"Name":"BedoCCupancy_Soussi.DRG"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Created by DIG"},"Name":"BedoCCupancy_Soussi.Expr1"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DRG Diagnosis"},"Name":"BedoCCupancy_Soussi.Expr3"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"LOS"},"Name":"Sum(BedoCCupancy_Soussi.LOS)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"GeometricMeanLOS"},"Name":"BedoCCupancy_Soussi.GeometricMeanLOS"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Speciality"},"Name":"BedoCCupancy_Soussi.Speciality"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Date Of Patients"},"Name":"BedoCCupancy_Soussi.NewPatients"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"ALOS"},"Name":"BedoCCupancy_Soussi.ALOS"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"ICD-10 Diagnosis"},"Name":"BedoCCupancy_Soussi.Name"},{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Payments"}},"Function":0},"Name":"Sum(BedoCCupancy_Soussi.Payments)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Weight"},"Name":"BedoCCupancy_Soussi.Weight"},{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Difference"}},"Function":0},"Name":"Sum(BedoCCupancy_Soussi.Difference)"},{"Aggregation":{"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"FTotal"}},"Function":0},"Name":"Sum(BedoCCupancy_Soussi.FTotal)"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"SSO"},"Name":"BedoCCupancy_Soussi.1"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"LTC Weight"},"Name":"BedoCCupancy_Soussi.2"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"LTC GLOS"},"Name":"BedoCCupancy_Soussi.3"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"PrograssNotes"},"Name":"BedoCCupancy_Soussi.PrograssNotes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"OR Notes"},"Name":"BedoCCupancy_Soussi.OR Notes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Operations"},"Name":"BedoCCupancy_Soussi.Operations"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DefaultMobile"},"Name":"BedoCCupancy_Soussi.DefaultMobile"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"TreatingPhysicianName"},"Name":"BedoCCupancy_Soussi.TreatingPhysicianName"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"PrograssNotes Creation Date"},"Name":"BedoCCupancy_Soussi.PrograssNotes Creation Date"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DischargeExpectedDate"},"Name":"BedoCCupancy_Soussi.DischargeExpectedDate","NativeReferenceName":"DischargeExpectedDate"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Hand Over"},"Name":"BedoCCupancy_Soussi.Hand Over","NativeReferenceName":"Prograssnotes"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"EliteALOS"},"Name":"BedoCCupancy_Soussi.EliteALOS","NativeReferenceName":"EliteALOS"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"EliteWeight"},"Name":"BedoCCupancy_Soussi.EliteWeight","NativeReferenceName":"EliteWeight"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"Medication Names"},"Name":"BedOccupancyMedicalDirector_soussi.Medication Names","NativeReferenceName":"Medication Names"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"IntialAssessment"},"Name":"BedOccupancyMedicalDirector_soussi.IntialAssessment","NativeReferenceName":"IntialAssessment"},{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"VTE Summary"},"Name":"BedOccupancyMedicalDirector_soussi.VTE Summary","NativeReferenceName":"VTE Summary"}],"OrderBy":[{"Direction":2,"Expression":{"Column":{"Expression":{"SourceRef":{"Source":"b"}},"Property":"DischargeExpectedDate"}}}]},"Binding":{"Primary":{"Groupings":[{"Projections":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41],"Subtotal":0}]},"DataReduction":{"Primary":{"Top":{"Count":1000000}},"Secondary":{"Top":{"Count":100}}},"Version":1}}},{"ExportDataCommand":{"Columns":[{"QueryName":"BedoCCupancy_Soussi.AdmissionDate","Name":"AdmissionDate"},{"QueryName":"BedoCCupancy_Soussi.BedName_EN","Name":"Bed#"},{"QueryName":"BedoCCupancy_Soussi.EnglishFullName","Name":"Patient"},{"QueryName":"BedoCCupancy_Soussi.FinancialStatusGUID","Name":"Financial Status"},{"QueryName":"BedoCCupancy_Soussi.FloorName_EN","Name":"Floor Name"},{"QueryName":"BedoCCupancy_Soussi.Notes","Name":"Notes"},{"QueryName":"Sum(BedoCCupancy_Soussi.PatientAgeDBComputed)","Name":"Age"},{"QueryName":"BedoCCupancy_Soussi.PatientBarcode","Name":"MRN"},{"QueryName":"BedoCCupancy_Soussi.Count of Companions","Name":"Companions #"},{"QueryName":"BedoCCupancy_Soussi.PaymentBy","Name":"PaymentBy"},{"QueryName":"BedoCCupancy_Soussi.VisitTypeGUID","Name":"Visit"},{"QueryName":"BedoCCupancy_Soussi.ContractorName","Name":"ContractorName"},{"QueryName":"BedoCCupancy_Soussi.FloorStructureName_EN","Name":"FloorStructureName_EN"},{"QueryName":"BedoCCupancy_Soussi.DRG","Name":"DRG"},{"QueryName":"BedoCCupancy_Soussi.Expr1","Name":"Created by DIG"},{"QueryName":"BedoCCupancy_Soussi.Expr3","Name":"DRG Diagnosis"},{"QueryName":"Sum(BedoCCupancy_Soussi.LOS)","Name":"LOS"},{"QueryName":"BedoCCupancy_Soussi.GeometricMeanLOS","Name":"GLOS"},{"QueryName":"BedoCCupancy_Soussi.Speciality","Name":"Speciality"},{"QueryName":"BedoCCupancy_Soussi.NewPatients","Name":"Date Of Patients"},{"QueryName":"BedoCCupancy_Soussi.ALOS","Name":"ALOS"},{"QueryName":"BedoCCupancy_Soussi.Name","Name":"ICD-10 Diagnosis"},{"QueryName":"Sum(BedoCCupancy_Soussi.Payments)","Name":"Sum of Payments"},{"QueryName":"BedoCCupancy_Soussi.Weight","Name":"Weight"},{"QueryName":"Sum(BedoCCupancy_Soussi.Difference)","Name":"Remaining"},{"QueryName":"Sum(BedoCCupancy_Soussi.FTotal)","Name":"Sum of FTotal"},{"QueryName":"BedoCCupancy_Soussi.1","Name":"SSO"},{"QueryName":"BedoCCupancy_Soussi.2","Name":"LTC Weight"},{"QueryName":"BedoCCupancy_Soussi.3","Name":"LTC GLOS"},{"QueryName":"BedoCCupancy_Soussi.PrograssNotes","Name":"Handover"},{"QueryName":"BedoCCupancy_Soussi.OR Notes","Name":"OR Notes"},{"QueryName":"BedoCCupancy_Soussi.Operations","Name":"Operations"},{"QueryName":"BedoCCupancy_Soussi.DefaultMobile","Name":"DefaultMobile"},{"QueryName":"BedoCCupancy_Soussi.TreatingPhysicianName","Name":"TreatingPhysicianName"},{"QueryName":"BedoCCupancy_Soussi.PrograssNotes Creation Date","Name":"PrograssNotes Creation Date"},{"QueryName":"BedoCCupancy_Soussi.DischargeExpectedDate","Name":"DischargeExpectedDate"},{"QueryName":"BedoCCupancy_Soussi.Hand Over","Name":"Prograssnotes"},{"QueryName":"BedoCCupancy_Soussi.EliteALOS","Name":"EliteALOS"},{"QueryName":"BedoCCupancy_Soussi.EliteWeight","Name":"EliteWeight"},{"QueryName":"BedOccupancyMedicalDirector_soussi.Medication Names","Name":"Medication Names"},{"QueryName":"BedOccupancyMedicalDirector_soussi.IntialAssessment","Name":"IntialAssessment"},{"QueryName":"BedOccupancyMedicalDirector_soussi.VTE Summary","Name":"VTE Summary"}],"Ordering":[0,1,7,2,32,3,6,4,5,8,10,9,11,12,21,13,14,15,16,17,20,23,33,18,19,25,22,24,26,27,28,35,34,29,36,30,31,37,38,39,40,41],"FiltersDescription":"No filters applied"}}]}}],"cancelQueries":[],"modelId":"282542116","userPreferredLocale":"en-US"}}
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

            def clean_num(val):
                if val is None or pd.isna(val): return "0.00"
                s = str(val).strip().replace(",", "")
                try:
                    f = float(s)
                    return f"{f:.2f}"
                except:
                    return "0.00"

            def clean_date(val):
                if val is None or pd.isna(val): return None
                if isinstance(val, (datetime.date, datetime.datetime, pd.Timestamp)):
                    return val.strftime("%d-%m-%Y %H:%M")
                s = str(val).strip()
                if not s or s.lower() in ["none", "nan", "null", "nat", "no filters applied", "admissiondate", "admission date"]:
                    return None
                try:
                    dt = pd.to_datetime(s, dayfirst=True)
                    if pd.notna(dt):
                        return dt.strftime("%d-%m-%Y %H:%M")
                except:
                    pass
                return s

            def clean_phone(val):
                if val is None or pd.isna(val): return ""
                s = str(val).strip()
                if s.endswith(".0"):
                    s = s[:-2]
                if s.lower() in ["none", "nan", "null", "undefined", ""]:
                    return ""
                arabic_digits = "٠١٢٣٤٥٦٧٨٩"
                for idx, c in enumerate(arabic_digits):
                    s = s.replace(c, str(idx))
                has_plus = s.startswith("+")
                s = re.sub(r"[^\d]", "", s)
                if not s or len(s) < 5:
                    return ""
                return ("+" + s) if has_plus else s

            raw_records = df.to_dict(orient="records")
            new_occupancy_rows = [{k: clean_val(v) for k, v in row.items()} for row in raw_records]

            # ---------------------------------------------------------
            # 1. PRE-FETCH STATE & ACTIVE MANUAL DISCHARGES GUARD
            # ---------------------------------------------------------
            cairo_now = get_cairo_now()
            cairo_date_str = cairo_now.strftime("%Y-%m-%d")
            cairo_time_str = cairo_now.strftime("%m/%d/%y %H:%M")
            is_1159_pm = (cairo_now.hour == 23 and cairo_now.minute == 59)

            existing = fetch_existing_supabase_state(cairo_date_str)
            manual_names = existing.get("manually_discharged_names", [])
            manual_mrns = set(existing.get("manually_discharged_mrns", []))
            if manual_names or manual_mrns:
                log(f"[Sync Guard] Active manual discharges recognized: {len(manual_names)} names, {len(manual_mrns)} MRNs.")

            # ---------------------------------------------------------
            # 2. NEW RELATIONAL SYNC (The New Formula)
            # ---------------------------------------------------------
            log(f"Syncing {len(new_occupancy_rows)} records to New Relational Schema...")
            rpc_headers = SUPABASE_HEADERS.copy()
            rpc_headers["Prefer"] = "return=minimal"
            
            rpc_payload = []
            for row in new_occupancy_rows:
                # Skip the header row itself during data extraction
                if str(get_val(row, ["Bed#", "BedName_EN"])) == "Bed#":
                    continue
                
                p_name = str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "Unknown Patient")
                raw_mrn = str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip()
                clean_mrn = raw_mrn.lstrip("0") if raw_mrn else ""

                # GUARD: Do not re-admit manually discharged patients
                if is_patient_manually_discharged(p_name, clean_mrn, manual_names, manual_mrns):
                    log(f"[Relational Sync Guard] Skipping manually discharged patient from admissions: {p_name} (MRN: {clean_mrn})")
                    continue
                    
                ad_val = clean_date(get_val(row, [
                    "AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ",
                    "BedoCCupancy_Soussi.AdmissionDate", "No filters applied", "Unnamed: 0"
                ]))
                if not ad_val:
                    first_col_key = list(row.keys())[0] if len(row) > 0 else None
                    if first_col_key and pd.notna(row.get(first_col_key)):
                        candidate = clean_date(row.get(first_col_key))
                        if candidate and str(candidate).lower() != "admissiondate":
                            ad_val = candidate
                
                mob_val = clean_phone(get_val(row, ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4", "Unnamed: 32"]))
                if not mob_val:
                    m4 = clean_phone(row.get("Unnamed: 4"))
                    if len(m4) >= 7:
                        mob_val = m4
                    else:
                        m32 = clean_phone(row.get("Unnamed: 32"))
                        if len(m32) >= 7:
                            mob_val = m32

                rpc_payload.append({
                    "MRN": clean_mrn or raw_mrn or f"UNKNOWN-{uuid.uuid4().hex[:8]}",
                    "Patient": p_name,
                    "Bed#": str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])),
                    "Floor Name": str(get_val(row, ["Floor Name", "FloorName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7", "Unnamed: 4", "Unnamed: 5"])),
                    "TreatingPhysicianName": str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])),
                    "AdmissionDate": str(ad_val) if ad_val else None,
                    "ContractorName": str(get_val(row, ["ContractorName", "Contractor", "Financial Status", "Financial", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])),
                    "Financial Status": str(get_val(row, ["Financial Status", "Financial Class", "PaymentBy", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"])),
                    "Total Invoice": clean_num(get_val(row, ["Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"])),
                    "Remaining Amount": clean_num(get_val(row, ["Remaining", "Sum of Difference", "Remaining Amount", "Difference", "Balance", "المتبقي", "الباقي", "Unnamed: 27"])),
                    "Specialty": normalize_specialty(get_val(row, ["Speciality", "Specialty", "Medical Plan X", "التخصص", "Unnamed: 23"])),
                    "Diagnosis": str(get_val(row, ["ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 14"])),
                    "Mobile": mob_val,
                    "LOS": str(get_val(row, ["LOS", "Sum(LOS)", "Unnamed: 18"])),
                    "EliteALOS": str(get_val(row, ["EliteALOS", "ALOS", "LOS AL", "Target ALOS", "Unnamed: 37"])),
                    "ExpectedDischarge": str(get_val(row, ["DischargeExpectedDate", "Expected Discharge", "Unnamed: 31", "Unnamed: 20"])),
                    "Medication Names": str(get_val(row, ["Medication Names", "Medications", "Medication", "الأدوية", "Unnamed: 39"])),
                    "IntialAssessment": str(get_val(row, ["IntialAssessment", "Initial Assessment", "التقييم الأولي", "Unnamed: 40"])),
                    "VTE Summary": str(get_val(row, ["VTE Summary", "VTE", "جلطات", "Unnamed: 41"])),
                    "Source": "powerbi"
                })
                
            # PostgREST expects the JSON keys to match the SQL function parameter names.
            # Since our SQL function is `sync_powerbi_admissions(payload JSON)`, we must wrap the array in `{"payload": [...]}`
            rpc_res = requests.post(SUPABASE_RPC_URL, headers=rpc_headers, json={"payload": rpc_payload}, verify=False)
            if rpc_res.status_code not in [200, 204]:
                log(f"RPC Relational Sync Failed: {rpc_res.text}")
            else:
                log("Relational Database admissions successfully synchronized via RPC!")

            # Also directly upsert patients to PostgreSQL to guarantee phone numbers and names are updated
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            try:
                pts_with_phone = []
                pts_without_phone = []
                seen_mrns = set()
                for item in rpc_payload:
                    m = item.get("MRN")
                    if not m or m.startswith("UNKNOWN-") or m in seen_mrns:
                        continue
                    seen_mrns.add(m)
                    p_entry = {
                        "mrn": m,
                        "name": item.get("Patient") or "Unknown Patient",
                        "updated_at": now_iso
                    }
                    if item.get("Mobile"):
                        p_entry["phone"] = item["Mobile"]
                        pts_with_phone.append(p_entry)
                    else:
                        pts_without_phone.append(p_entry)

                base_rest = f"{SUPABASE_URL}/rest/v1"
                if pts_with_phone:
                    requests.post(
                        f"{base_rest}/patients?on_conflict=mrn",
                        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"},
                        json=pts_with_phone,
                        verify=False
                    )
                if pts_without_phone:
                    requests.post(
                        f"{base_rest}/patients?on_conflict=mrn",
                        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"},
                        json=pts_without_phone,
                        verify=False
                    )
            except Exception as pt_err:
                log(f"Notice: Direct patient upsert: {pt_err}")

            legacy_occupancy_rows = []
            
            # Fake header row ensures Node.js startIdx parsing works reliably
            fake_header = {
                "No filters applied": "AdmissionDate",
                "Unnamed: 1": "Bed",
                "Unnamed: 2": "MRN",
                "Unnamed: 3": "Patient",
                "Unnamed: 4": "DefaultMobile",
                "Unnamed: 5": "Financial Status",
                "Unnamed: 6": "Age",
                "Unnamed: 7": "Floor Name",
                "Unnamed: 8": "Notes",
                "Unnamed: 9": "Companions #",
                "Unnamed: 10": "Visit",
                "Unnamed: 11": "PaymentBy",
                "Unnamed: 12": "ContractorName",
                "Unnamed: 13": "FloorStructureName_EN",
                "Unnamed: 14": "Diagnosis",
                "Unnamed: 18": "LOS Status",
                "Unnamed: 20": "Expected Discharge",
                "Unnamed: 22": "TreatingPhysicianName",
                "Unnamed: 23": "Speciality",
                "Unnamed: 24": "Transfer History",
                "Unnamed: 25": "Total Invoice",
                "Unnamed: 27": "Remaining Amount",
                "Unnamed: 32": "Creation Date",
                "Unnamed: 33": "Medical Plan AH",
                "Unnamed: 34": "Medical Plan AI",
                "Unnamed: 37": "EliteALOS",
                "Unnamed: 38": "EliteWeight",
                "Unnamed: 39": "Medication Names",
                "Unnamed: 40": "IntialAssessment",
                "Unnamed: 41": "VTE Summary"
            }
            legacy_occupancy_rows.append(fake_header)
            
            for row in raw_records:
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1", ""] or "no filters" in bed_val.lower():
                    continue

                patient_val = str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "").strip()
                mrn_val = str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip()
                clean_m = mrn_val.lstrip("0") if mrn_val else ""

                # GUARD: Do not include manually discharged patients in active occupancy
                if is_patient_manually_discharged(patient_val, clean_m, manual_names, manual_mrns):
                    log(f"[Legacy Occupancy Guard] Skipping manually discharged patient from occupied beds: {patient_val} (MRN: {clean_m})")
                    continue
                    
                # Dynamically construct all columns to support every legacy sheet (Debts, LOS, Medical Plans, etc)
                legacy_row = {}
                
                # We handle the primary known columns with explicit fallbacks
                known_mappings = {
                    0: ["AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ", "No filters applied", "Unnamed: 0"],
                    1: ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"],
                    2: ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"],
                    3: ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"],
                    4: ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4"],
                    5: ["Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"],
                    6: ["Age", "PatientAgeDBComputed", "Unnamed: 6"],
                    7: ["Floor Name", "FloorName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7"],
                    8: ["Notes", "Remarks", "ملاحظات", "Unnamed: 8"],
                    9: ["Companions #", "Count of Companions", "Companion", "مرافق", "Unnamed: 9"],
                    10: ["Visit", "VisitTypeGUID", "Visit Type", "نوع الزيارة", "Unnamed: 10"],
                    11: ["PaymentBy", "Payment By", "طريقة الدفع", "الدفع بواسطة", "الدفع", "Unnamed: 11"],
                    12: ["ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"],
                    14: ["ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 14"],
                    18: ["LOS", "Sum(LOS)", "LOS Status", "Unnamed: 18"],
                    20: ["DischargeExpectedDate", "Expected Discharge", "ALOS", "Unnamed: 20"],
                    22: ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"],
                    23: ["Speciality", "Specialty", "Medical Plan X", "التخصص", "Unnamed: 23"],
                    24: ["Transfer History", "Unnamed: 24"],
                    25: ["Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"],
                    26: ["Sum of Payments", "Payments", "Unnamed: 26"],
                    27: ["Remaining", "Sum of Difference", "Remaining Amount", "Difference", "Balance", "المتبقي", "الباقي", "Unnamed: 27"],
                    28: ["SSO", "Unnamed: 28"],
                    29: ["LTC Weight", "Unnamed: 29"],
                    30: ["LTC GLOS", "Unnamed: 30"],
                    31: ["DischargeExpectedDate", "Expected Discharge", "Unnamed: 31"],
                    32: ["PrograssNotes Creation Date", "Creation Date", "Medical Plan AG", "تاريخ الخطة", "DefaultMobile", "Unnamed: 32"],
                    33: ["Handover", "PrograssNotes", "Medical Plan AH", "الخطة الطبية", "Operations", "Unnamed: 33"],
                    34: ["Prograssnotes", "Hand Over", "Notes", "Medical Plan AI", "Unnamed: 34"],
                    35: ["OR Notes", "Unnamed: 35"],
                    36: ["Operations", "Unnamed: 36"],
                    37: ["EliteALOS", "ALOS", "LOS AL", "Target ALOS", "Unnamed: 37"],
                    38: ["EliteWeight", "Weight", "Unnamed: 38"],
                    39: ["Medication Names", "Medications", "Medication", "الأدوية", "Unnamed: 39"],
                    40: ["IntialAssessment", "Initial Assessment", "التقييم الأولي", "Unnamed: 40"],
                    41: ["VTE Summary", "VTE", "جلطات", "Unnamed: 41"]
                }
                
                total_cols = max(42, len(header_row))
                for i in range(total_cols):
                    col_key = "No filters applied" if i == 0 else f"Unnamed: {i}"
                    if i in known_mappings:
                        val = clean_val(get_val(row, known_mappings[i]))
                        legacy_row[col_key] = val
                    else:
                        # Fallback for all other unmapped legacy columns
                        legacy_row[col_key] = clean_val(get_val(row, [f"Unnamed: {i}"]))
                        
                legacy_occupancy_rows.append(legacy_row)
            
            # ---------------------------------------------------------
            # 3. EXTRACT AND SYNC DEBTS (Cash & Insured)
            # ---------------------------------------------------------
            cash_debts = []
            insured_debts = []
            
            def is_doctor_case_or_physician_payment(fin_status, contractor, payment_by, notes="", name="", physician=""):
                f_low = (fin_status or "").lower().strip()
                m_low = (contractor or "").lower().strip()
                l_low = (payment_by or "").lower().strip()
                n_low = (notes or "").lower().strip()
                d_low = (name or "").lower().strip()
                phys_low = (physician or "").lower().strip()

                # 1. Exclude if payment is by physician
                physician_payment_kws = ["physician", "طبيب", "فيزيشن", "doctor", "دكتور", "other ex"]
                if any(kw in l_low for kw in physician_payment_kws):
                    return True

                if (
                    m_low in ["طبيب", "physician", "doctor", "دكتور"] or
                    m_low.startswith("د/") or m_low.startswith("د.") or m_low.startswith("dr.") or m_low.startswith("dr ") or
                    f_low in ["طبيب", "physician", "doctor", "دكتور"]
                ):
                    return True

                # If PaymentBy is specified and NOT the patient/cash, it indicates payment by physician or external party
                if l_low and l_low not in ["patient", "مريض", "cash", "نقدي", "نقدى", "self"]:
                    if phys_low and l_low == phys_low:
                        return True
                    if l_low != d_low:
                        return True

                # Notes or remarks indicating payment by physician
                notes_phys_kws = ["حساب الطبيب", "حساب الدكتور", "دفع بواسطة الطبيب", "على حساب الطبيب", "payment by physician", "paid by doctor", "physician payment"]
                if any(kw in n_low for kw in notes_phys_kws):
                    return True

                # 2. Exclude if patient is Doctor Case / حالة طبيب
                dc_keywords = [
                    "doctor case", "doctor_case", "doctorcase", "doctor-case",
                    "حالة طبيب", "حاله طبيب", "حالة دكتور", "حاله دكتور",
                    "cash doctor", "كاش طبيب", "كاش دكتور", "doctor case surgery",
                    "طرف دكتور", "طرف د.", "تبع دكتور", "تبع د.",
                    "توصية دكتور", "توصيه دكتور", "مجاملة دكتور", "مجامله دكتور",
                    "خصم دكتور", "خصم طبيب"
                ]
                for kw in dc_keywords:
                    if kw in l_low or kw in f_low or kw in m_low or kw in n_low or kw in d_low:
                        return True

                combined = f" {l_low} {f_low} {m_low} {n_low} "
                if re.search(r"\b(dc|d\.c\.|d\.c)\b", combined):
                    return True

                return False

            for row in raw_records:
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1", ""] or "no filters" in bed_val.lower():
                    continue

                b_low = bed_val.lower()
                if (
                    b_low in ["or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات"] or
                    b_low.startswith("or-") or b_low.startswith("or ") or b_low.startswith("or -")
                ):
                    continue

                patient_name = str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "").strip()
                if not patient_name or patient_name.lower() in ["patient", "المريض", "name", "unknown"]:
                    continue

                raw_debt_mrn = str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip()
                if is_patient_manually_discharged(patient_name, raw_debt_mrn, manual_names, manual_mrns):
                    continue
                
                fin_status = str(get_val(row, ["Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"]) or "").strip()
                contractor = str(get_val(row, ["ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"]) or "").strip()
                pay_by = str(get_val(row, ["PaymentBy", "Payment By", "طريقة الدفع", "الدفع بواسطة", "الدفع", "Unnamed: 11"]) or "").strip()
                notes_val = str(get_val(row, ["Notes", "Remarks", "ملاحظات", "Unnamed: 8"]) or "").strip()
                physician_val = str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])).strip()
                
                f_low = fin_status.lower()
                m_low = contractor.lower()
                
                if "home care" in m_low or "homecare" in m_low or "home care" in f_low or "homecare" in f_low:
                    continue
                    
                # Exclude if patient is Doctor Case or payment is by physician
                if is_doctor_case_or_physician_payment(fin_status, contractor, pay_by, notes_val, patient_name, physician_val):
                    continue

                has_cash_indicator = lambda txt: any(kw in str(txt or "").lower() for kw in ["cash", "كاش", "نقدي", "نقدى"])

                # Per user instruction: Consider ANY patient with the word "Cash" / "كاش" included
                # (like "نقابة اطباء Cash", "نقابة مهندسين Cash", "خصم نادي سبورتنج كاش", "Cash") as cash patients
                if has_cash_indicator(m_low) or has_cash_indicator(f_low):
                    is_cash = True
                elif m_low in ["", "elite", "بدون جهة", "بدون جهه", "عميل", "افراد", "أفراد", "self", "private", "personal"]:
                    is_cash = not any(kw in f_low for kw in ["insured", "تأمين", "تامين", "تعاقد"])
                else:
                    is_cash = False
                
                t_val = clean_num(get_val(row, ["Sum of FTotal", "FTotal", "Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"]))
                r_val = clean_num(get_val(row, ["Remaining", "Sum of Difference", "Remaining Amount", "Difference", "Balance", "المتبقي", "الباقي", "Unnamed: 27"]))
                
                f_tot = float(t_val)
                f_rem = float(r_val)
                
                debt_mob = clean_phone(get_val(row, ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4", "Unnamed: 32"]))
                if not debt_mob:
                    dm4 = clean_phone(row.get("Unnamed: 4"))
                    if len(dm4) >= 7: debt_mob = dm4

                # Admission Date resolution
                adm_date = clean_date(get_val(row, [
                    "AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ",
                    "BedoCCupancy_Soussi.AdmissionDate", "No filters applied", "Unnamed: 0"
                ]))
                if not adm_date:
                    first_col_key = list(row.keys())[0] if len(row) > 0 else None
                    if first_col_key and pd.notna(row.get(first_col_key)):
                        candidate = clean_date(row.get(first_col_key))
                        if candidate and str(candidate).lower() != "admissiondate":
                            adm_date = candidate

                debt_item = {
                    "colA": str(adm_date) if adm_date else "",
                    "date": str(adm_date) if adm_date else "",
                    "admissionDate": str(adm_date) if adm_date else "",
                    "room": bed_val,
                    "mrn": str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip(),
                    "colD": patient_name,
                    "colF": fin_status,
                    "financialStatus": fin_status,
                    "colM": contractor,
                    "contractor": contractor,
                    "colL": pay_by,
                    "paymentBy": pay_by,
                    "notes": notes_val,
                    "physician": physician_val,
                    "colZ": str(f_tot),
                    "colAB": str(f_rem),
                    "valZ": f_tot,
                    "valAB": f_rem,
                    "totalInvoice": f_tot,
                    "remainingAmount": f_rem,
                    "mobile": debt_mob,
                    "phone": debt_mob
                }
                
                if is_cash:
                    cash_debts.append(debt_item)
                else:
                    if f_rem > 0 or f_tot > 0:
                        insured_debts.append(debt_item)

            log(f"Extracted {len(cash_debts)} Cash Debts and {len(insured_debts)} Insured Debts.")

            # ---------------------------------------------------------
            # 4. EXTRACT AND SYNC DIALYSIS CASES
            # ---------------------------------------------------------
            dialysis_cases = []

            def is_dialysis_room(room_str):
                if not room_str:
                    return False
                r = str(room_str).strip().lower()
                room_kws = [
                    "dialysis", "diyalsis", "dialys", "hemodialysis", "haemodialysis",
                    "hemo dialysis", "haemo dialysis", "غسيل", "استصفاء", "ديلزة"
                ]
                if any(kw in r for kw in room_kws):
                    return True
                if re.search(r"\b(hd|hemo|dial)\s*[-#_]?\s*\d*\b", r) and "icu" not in r and "ccu" not in r:
                    return True
                return False

            def is_dialysis_case(row):
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                patient_name = str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "").strip()
                
                if not patient_name or patient_name.lower() in ["patient", "المريض", "name", "unknown"]:
                    return False
                    
                b_low = bed_val.lower()
                if (
                    b_low in ["or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات"] or
                    b_low.startswith("or-") or b_low.startswith("or ") or b_low.startswith("or -")
                ):
                    return False

                # Room 323 is an inpatient room, not a dialysis room
                if "323" in b_low:
                    return False

                floor_val = str(get_val(row, ["Floor Name", "FloorName_EN", "FloorStructureName_EN", "Floor", "الطابق", "الدور", "Unnamed: 7"])).strip().lower()
                fin_status = str(get_val(row, ["Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"]) or "").strip().lower()
                contractor = str(get_val(row, ["ContractorName", "Contractor", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"]) or "").strip().lower()
                visit = str(get_val(row, ["Visit", "VisitTypeGUID", "Visit Type", "نوع الزيارة", "Unnamed: 10"]) or "").strip().lower()
                specialty = str(get_val(row, ["Speciality", "Specialty", "التخصص", "Unnamed: 23"]) or "").strip().lower()
                diag = str(get_val(row, ["ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Name", "التشخيص", "Unnamed: 14"]) or "").strip().lower()
                notes = str(get_val(row, ["Notes", "Remarks", "Handover", "Prograssnotes", "ملاحظات", "الخطة الطبية", "Unnamed: 8", "Unnamed: 33", "Unnamed: 34"]) or "").strip().lower()

                # Home care / Well baby exclusions
                if any(ex in contractor or ex in fin_status or ex in floor_val for ex in ["homecare", "home care", "wellbaby", "well baby"]):
                    return False

                # 1. Room/Bed name match
                if is_dialysis_room(bed_val):
                    return True

                # Inpatient rooms (standard numbered rooms 1xx, 3xx, 4xx, ICU, CCU, SICU, PICU, NICU, suites) cannot be dialysis cases
                is_inpatient = bool(re.search(r"^(room\s*)?(10[1-8]|3[0-3][0-9]|4[0-2][0-9])(\s*[-/]?\s*[ab])?$", b_low, re.I)) or "suite" in b_low or "سويت" in b_low or "icu" in b_low or "ccu" in b_low
                if is_inpatient:
                    return False

                # 2. Floor / Ward / Unit match
                floor_kws = [
                    "dialysis", "diyalsis", "hemodialysis", "haemodialysis", "غسيل كلوي", "غسيل كلى",
                    "وحدة الغسيل", "قسم الغسيل", "استصفاء", "ديلزة", "وحدة غسيل"
                ]
                if any(kw in floor_val for kw in floor_kws):
                    return True

                # 3. Specialty is Nephrology / Dialysis AND bed/room is in daycase / DC / chair / station
                if (
                    any(kw in specialty for kw in ["dialysis", "غسيل", "nephrology", "أمراض كلى", "كلى", "امراض كلى"]) and
                    any(kw in b_low or kw in floor_val for kw in ["dc", "daycase", "day case", "chair", "station", "day"])
                ):
                    return True

                # 4. Visit type or Financial status indicates Dialysis session AND in daycase/chair/station
                if (
                    ("dialysis" in visit or "hemodialysis" in visit or "غسيل" in visit or
                     "جلسة غسيل" in fin_status or "جلسات غسيل" in fin_status or "جلسه غسيل" in fin_status or
                     "dialysis session" in fin_status) and
                    any(kw in b_low or kw in floor_val for kw in ["dc", "daycase", "chair", "station", "dial", "day"])
                ):
                    return True

                return False

            for row in raw_records:
                if not is_dialysis_case(row):
                    continue

                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                patient_name = str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "").strip()
                
                # Admission Date resolution
                adm_date = clean_date(get_val(row, [
                    "AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ",
                    "BedoCCupancy_Soussi.AdmissionDate", "No filters applied", "Unnamed: 0"
                ]))
                if not adm_date:
                    first_col_key = list(row.keys())[0] if len(row) > 0 else None
                    if first_col_key and pd.notna(row.get(first_col_key)):
                        candidate = clean_date(row.get(first_col_key))
                        if candidate and str(candidate).lower() != "admissiondate":
                            adm_date = candidate

                # STRICT CHECK: Dialysis cases must belong to today in Cairo
                if adm_date and not is_date_today_cairo(adm_date, cairo_date_str):
                    continue

                mob = clean_phone(get_val(row, ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4", "Unnamed: 32"]))
                if not mob:
                    dm4 = clean_phone(row.get("Unnamed: 4"))
                    if len(dm4) >= 7: mob = dm4

                dial_item = {
                    "room": bed_val if bed_val else "Dialysis",
                    "name": patient_name,
                    "physician": str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])).strip(),
                    "contractor": str(get_val(row, ["ContractorName", "Contractor", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])).strip(),
                    "date": str(adm_date) if adm_date else "",
                    "mrn": str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip(),
                    "mobile": mob,
                    "floor": str(get_val(row, ["Floor Name", "FloorName_EN", "FloorStructureName_EN", "Unnamed: 7"])).strip(),
                    "diagnosis": str(get_val(row, ["ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Unnamed: 14"])).strip(),
                    "specialty": normalize_specialty(get_val(row, ["Speciality", "Specialty", "Unnamed: 23"]))
                }
                dialysis_cases.append(dial_item)

            # ---------------------------------------------------------
            # 4b. EXTRACT AND SYNC TODAY'S ADMISSIONS / ENTRIES
            # ---------------------------------------------------------
            today_entries = []
            for row in raw_records:
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1", ""] or "no filters" in bed_val.lower():
                    continue

                b_low = bed_val.lower()
                if (
                    b_low in ["or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات"] or
                    b_low.startswith("or-") or b_low.startswith("or ") or b_low.startswith("or -")
                ):
                    continue

                patient_val = str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "").strip()
                if not patient_val or patient_val.lower() in ["patient", "المريض", "name", "unknown"]:
                    continue

                raw_mrn = str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip()
                clean_m = raw_mrn.lstrip("0") if raw_mrn else ""

                if is_patient_manually_discharged(patient_val, clean_m, manual_names, manual_mrns):
                    continue

                adm_date = clean_date(get_val(row, [
                    "AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ",
                    "BedoCCupancy_Soussi.AdmissionDate", "No filters applied", "Unnamed: 0"
                ]))
                if not adm_date:
                    first_col_key = list(row.keys())[0] if len(row) > 0 else None
                    if first_col_key and pd.notna(row.get(first_col_key)):
                        candidate = clean_date(row.get(first_col_key))
                        if candidate and str(candidate).lower() != "admissiondate":
                            adm_date = candidate

                if adm_date and is_date_today_cairo(adm_date, cairo_date_str):
                    mob = clean_phone(get_val(row, ["DefaultMobile", "Mobile", "Phone", "الجوال", "الهاتف", "Unnamed: 4", "Unnamed: 32"]))
                    if not mob:
                        dm4 = clean_phone(row.get("Unnamed: 4"))
                        if len(dm4) >= 7: mob = dm4

                    entry_item = {
                        "room": bed_val,
                        "name": patient_val,
                        "date": str(adm_date),
                        "rawDate": str(adm_date),
                        "mrn": clean_m or raw_mrn,
                        "mobile": mob,
                        "physician": str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])).strip(),
                        "contractor": str(get_val(row, ["ContractorName", "Contractor", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])).strip(),
                        "floor": str(get_val(row, ["Floor Name", "FloorName_EN", "FloorStructureName_EN", "Unnamed: 7"])).strip(),
                        "diagnosis": str(get_val(row, ["ICD-10 Diagnosis", "DRG Diagnosis", "Diagnosis", "Unnamed: 14"])).strip(),
                        "financialStatus": str(get_val(row, ["Financial Status", "Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"])).strip(),
                    }
                    if not any(is_name_match(ex.get("name"), patient_val) or (clean_m and ex.get("mrn") == clean_m) for ex in today_entries):
                        today_entries.append(entry_item)

            cumulative_entries = [
                p for p in (existing.get("entries") or [])
                if is_date_today_cairo(p.get("date") or p.get("rawDate"), cairo_date_str)
            ]
            for p in today_entries:
                p_name = p.get("name", "").strip()
                p_mrn = p.get("mrn", "").strip()
                if not any(is_name_match(ex.get("name"), p_name) or (p_mrn and ex.get("mrn") == p_mrn) for ex in cumulative_entries):
                    cumulative_entries.append(p)

            # ---------------------------------------------------------
            # 5. CUMULATIVE DIALYSIS & TRANSFERS WITH 11:59 PM CAIRO RESET
            # ---------------------------------------------------------
            def is_procedure_or_temporary_room(room_str):
                if not room_str:
                    return True
                r = str(room_str).strip().lower()
                if r in ["or", "o.r", "or1", "or2", "or3", "or4", "or5", "or6", "عمليات", "غرفة عمليات"]:
                    return True
                if r.startswith("or-") or r.startswith("or ") or r.startswith("or -"):
                    return True
                proc_keywords = [
                    "theatre", "cath lab", "dialysis", "diyalsis", "endoscopy", "recovery", "pacu", "holding"
                ]
                return any(kw in r for kw in proc_keywords)

            def extract_patient_rooms(rows):
                res = {}
                if not rows:
                    return res
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    bed = str(get_val(r, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                    mrn = str(get_val(r, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])).strip().lstrip("0")
                    name = str(get_val(r, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "").strip()
                    phys = str(get_val(r, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])).strip()
                    cont = str(get_val(r, ["ContractorName", "Contractor", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])).strip()
                    
                    if not name or name.lower() in ["patient", "المريض", "name", "unknown", "englishfullname"]:
                        continue
                    if not bed or bed.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "unnamed: 1", ""]:
                        continue
                        
                    key = mrn if mrn else name.lower()
                    res[key] = {
                        "mrn": mrn,
                        "name": name,
                        "room": bed,
                        "physician": phys,
                        "contractor": cont
                    }
                return res

            if is_1159_pm or existing.get("is_new_day") or existing.get("is_system_reset"):
                log(f"[Sync Daily Rollover/Reset] Fresh daily counters active for {cairo_date_str} (new_day: {existing.get('is_new_day')}, reset: {existing.get('is_system_reset')}). Resetting daily dialysis & transfer cases...")
                cumulative_dialysis = []
                cumulative_transfers = []
            else:
                # Keep dialysis cumulative throughout the day (filtered strictly to today)
                cumulative_dialysis = [
                    p for p in (existing.get("dialysis") or [])
                    if "323" not in str(p.get("room", "")) and (not p.get("date") or is_date_today_cairo(p.get("date"), cairo_date_str))
                ]
                for p in dialysis_cases:
                    if "323" in str(p.get("room", "")):
                        continue
                    p_name = p.get("name", "").strip().lower()
                    if p_name and not any(ex.get("name", "").strip().lower() == p_name for ex in cumulative_dialysis if ex.get("name")):
                        cumulative_dialysis.append(p)

                # Keep transfers cumulative throughout the day
                prev_rooms = extract_patient_rooms(existing.get("occupancy_current"))
                curr_rooms = extract_patient_rooms(raw_records)
                cumulative_transfers = list(existing.get("transfers") or [])

                for key, curr in curr_rooms.items():
                    if key in prev_rooms:
                        prev = prev_rooms[key]
                        prev_r = prev["room"].strip()
                        curr_r = curr["room"].strip()
                        if (
                            prev_r and curr_r and
                            prev_r.lower() != curr_r.lower() and
                            not is_procedure_or_temporary_room(prev_r) and
                            not is_procedure_or_temporary_room(curr_r)
                        ):
                            # Check if this patient already has a transfer record in cumulative_transfers
                            rec = None
                            for t in cumulative_transfers:
                                t_mrn = str(t.get("mrn", "")).strip().lstrip("0")
                                t_name = str(t.get("name", "")).strip().lower()
                                if curr["mrn"] and t_mrn and curr["mrn"] == t_mrn:
                                    rec = t
                                    break
                                if curr["name"].lower() == t_name:
                                    rec = t
                                    break

                            if not rec:
                                new_rec = {
                                    "id": f"transfer-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}",
                                    "name": curr["name"],
                                    "mrn": curr["mrn"],
                                    "initialRoom": prev_r,
                                    "currentRoom": curr_r,
                                    "journey": [prev_r, curr_r],
                                    "history": [{
                                        "fromRoom": prev_r,
                                        "toRoom": curr_r,
                                        "date": cairo_time_str,
                                        "physician": curr["physician"] or prev.get("physician", ""),
                                        "contractor": curr["contractor"] or prev.get("contractor", "")
                                    }],
                                    "lastTransferDate": cairo_time_str,
                                    "physician": curr["physician"] or prev.get("physician", ""),
                                    "contractor": curr["contractor"] or prev.get("contractor", ""),
                                    "notes": f"Transferred from {prev_r} to {curr_r}"
                                }
                                cumulative_transfers.insert(0, new_rec)
                                log(f"[Patient Transfer] \"{curr['name']}\" moved from \"{prev_r}\" to \"{curr_r}\"")
                            else:
                                journey = rec.get("journey") or [rec.get("initialRoom", prev_r)]
                                history = rec.get("history") or []
                                last_room = journey[-1] if journey else ""
                                if last_room.lower() != curr_r.lower() and rec.get("currentRoom", "").lower() != curr_r.lower():
                                    journey.append(curr_r)
                                    history.append({
                                        "fromRoom": prev_r,
                                        "toRoom": curr_r,
                                        "date": cairo_time_str,
                                        "physician": curr["physician"] or prev.get("physician", ""),
                                        "contractor": curr["contractor"] or prev.get("contractor", "")
                                    })
                                    rec["journey"] = journey
                                    rec["history"] = history
                                    rec["currentRoom"] = curr_r
                                    rec["lastTransferDate"] = cairo_time_str
                                    log(f"[Patient Transfer Journey Extended] \"{curr['name']}\" moved to \"{curr_r}\"")

            log(f"Dialysis cases: {len(dialysis_cases)} current / {len(cumulative_dialysis)} cumulative today.")
            log(f"Transfer cases: {len(cumulative_transfers)} cumulative today.")
            log(f"Entry cases: {len(today_entries)} current / {len(cumulative_entries)} cumulative today.")

            # Send the reconstructed rigid array so legacy backend parses it flawlessly
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": legacy_occupancy_rows, "previous": existing.get("previous")},
                    "updated_at": now_iso
                },
                {
                    "path": "state/debts",
                    "data": {"items": cash_debts},
                    "updated_at": now_iso
                },
                {
                    "path": "state/insured_debts",
                    "data": {"items": insured_debts},
                    "updated_at": now_iso
                },
                {
                    "path": "state/dialysis",
                    "data": {"items": cumulative_dialysis},
                    "updated_at": now_iso
                },
                {
                    "path": "state/transfers",
                    "data": {"items": cumulative_transfers},
                    "updated_at": now_iso
                },
                {
                    "path": "state/entries",
                    "data": {"items": cumulative_entries},
                    "updated_at": now_iso
                },
                {
                    "path": "state/discharged",
                    "data": {"patients": existing.get("discharged", [])},
                    "updated_at": now_iso
                },
                {
                    "path": "state/metadata",
                    "data": {
                        **(existing.get("existing_metadata") or {}),
                        "uploadedAt": now_iso,
                        "lastDatabaseUpdatedAt": now_iso,
                        "lastActiveDate": cairo_date_str,
                        "manuallyDischargedNames": existing.get("manually_discharged_names", []),
                        "counts": {
                            "occupiedBeds": max(0, len(legacy_occupancy_rows) - 1),
                            "debts": len(cash_debts),
                            "insuredDebts": len(insured_debts),
                            "dialysis": len(cumulative_dialysis),
                            "transfers": len(cumulative_transfers),
                            "entries": len(cumulative_entries),
                            "discharged": len(existing.get("discharged", []))
                        }
                    },
                    "updated_at": now_iso
                }
            ]
            sb_response = requests.post(SUPABASE_REST_URL, headers=SUPABASE_HEADERS, json=granular_nodes, verify=False)
            
            if sb_response.status_code in [200, 201]:
                log(f"Legacy JSON state, Debts, Dialysis, Entries, and Discharged successfully updated ({len(cash_debts)} cash, {len(insured_debts)} insured, {len(cumulative_dialysis)} dialysis, {len(cumulative_transfers)} transfers, {len(cumulative_entries)} entries, {len(existing.get('discharged', []))} discharged).")
                return True
            else:
                log(f"Supabase upsert failed with status {sb_response.status_code}: {sb_response.text}")

        except Exception as e:
            log(f"Sync error: {e}")

        failure_countdown(5, "Data Fetch & Sync")

last_cairo_seen_date = ""

def check_cairo_day_rollover():
    global last_cairo_seen_date
    now_cairo = get_cairo_now()
    today_str = now_cairo.strftime("%Y-%m-%d")
    if not last_cairo_seen_date:
        last_cairo_seen_date = today_str
        return

    # Check for calendar day change or 11:59 PM trigger
    if today_str != last_cairo_seen_date:
        log(f"[Scheduled Day Rollover] Cairo calendar date transitioned from {last_cairo_seen_date} to {today_str}. Triggering clean daily sync job...")
        last_cairo_seen_date = today_str
        run_sync_job()
    elif now_cairo.hour == 23 and now_cairo.minute == 59:
        if last_cairo_seen_date == today_str:
            # Stamped to avoid re-triggering multiple times in minute 59
            last_cairo_seen_date = f"{today_str}_1159_done"
            log(f"[Scheduled Reset] 11:59 PM Cairo time reached ({today_str}). Triggering end-of-day rollover...")
            run_sync_job()

def run_sync_job():
    log("=== STARTING SYNC JOB ===")
    fortinet_reconnect()
    fetch_powerbi_and_sync()

if __name__ == "__main__":
    log("Service Online. Initializing first run...")
    run_sync_job()
    schedule.every(30).minutes.do(run_sync_job)

    while True:
        check_cairo_day_rollover()
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
