import os, json, datetime, time, sys, io
from urllib.parse import urlparse, parse_qs
import requests
from requests_ntlm import HttpNtlmAuth
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

POWERBI_USER = os.getenv("POWERBI_USER")
POWERBI_PASS = os.getenv("POWERBI_PASS")
FORTINET_USER = os.getenv("FORTINET_USER")
FORTINET_PASS = os.getenv("FORTINET_PASS")

def run_test():
    export_url = "http://10.0.17.20/Reports/api/v2.0/ExecutionLog/Export?format=EXCELOPENXML"
    raw_payload = r'''{"ReportPath":"/Occupency Sheet","Parameters":[{"Name":"FacilityId","Value":"1"}]}'''
    
    print("Fetching Power BI...")
    response = requests.post(export_url, json=json.loads(raw_payload), auth=HttpNtlmAuth(POWERBI_USER, POWERBI_PASS), timeout=20)
    response.raise_for_status()

    df = pd.read_excel(io.BytesIO(response.content), dtype=str)
    df.fillna("", inplace=True)
    
    header_row = df.iloc[0].to_dict() if not df.empty else {}
    col_map = {str(v).strip(): k for k, v in header_row.items() if pd.notna(v) and str(v).strip()}
    
    def get_val(row, possible_names):
        for name in possible_names:
            key = col_map.get(name)
            if key and pd.notna(row.get(key)) and row.get(key) != "":
                return row.get(key)
            if pd.notna(row.get(name)) and row.get(name) != "":
                return row.get(name)
        return ""
        
    def clean_val(val):
        if pd.isna(val) or val == "": return None
        return str(val).strip()

    raw_records = df.to_dict(orient="records")
    
    # Let's show the user how the legacy row will be constructed
    legacy_occupancy_rows = []
    
    # Fake header for startIdx logic
    fake_header = {
        "No filters applied": "AdmissionDate",
        "Unnamed: 1": "Bed",
        "Unnamed: 2": "MRN",
        "Unnamed: 3": "Patient",
        "Unnamed: 12": "Financial Status",
        "Unnamed: 22": "TreatingPhysicianName"
    }
    legacy_occupancy_rows.append(fake_header)
    
    test_patient = None
    
    for row in raw_records:
        bed_val = str(get_val(row, ["Bed#", "BedName_EN"])).strip()
        if bed_val == "Bed#" or bed_val == "":
            continue
            
        legacy_row = {
            "No filters applied": clean_val(get_val(row, ["AdmissionDate"])),
            "Unnamed: 1": clean_val(bed_val),
            "Unnamed: 2": clean_val(get_val(row, ["MRN", "PatientBarcode"])),
            "Unnamed: 3": clean_val(get_val(row, ["Patient", "EnglishFullName"])),
            "Unnamed: 12": clean_val(get_val(row, ["Financial Status", "ContractorName"])),
            "Unnamed: 22": clean_val(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN"]))
        }
        legacy_occupancy_rows.append(legacy_row)
        
        if not test_patient:
            test_patient = legacy_row
            
    print("\n--- TEST PATIENT EXTRACTION ---")
    print(json.dumps(test_patient, indent=2, ensure_ascii=False))
    print(f"\nTotal rows extracted: {len(legacy_occupancy_rows)}")

run_test()
