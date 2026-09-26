import sync_powerbi_relational as sync
import json, os, datetime
import pandas as pd
import io
import requests
from requests_ntlm import HttpNtlmAuth

sync.fortinet_reconnect()

POWERBI_USER = os.getenv("POWERBI_USER", "biviewer")
POWERBI_PASS = os.getenv("POWERBI_PASS", "123456")

export_url = "http://10.0.17.20/Reports/api/v2.0/ExecutionLog/Export?format=EXCELOPENXML"
raw_payload = r'''{"ReportPath":"/Occupency Sheet","Parameters":[{"Name":"FacilityId","Value":"1"}]}'''

try:
    response = requests.post(export_url, json=json.loads(raw_payload), auth=HttpNtlmAuth(POWERBI_USER, POWERBI_PASS), timeout=20)
    df = pd.read_excel(io.BytesIO(response.content), dtype=str)
    df.fillna("", inplace=True)
    raw_records = df.to_dict(orient="records")

    header_row = df.iloc[0].to_dict() if not df.empty else {}
    col_map = {str(v).strip(): k for k, v in header_row.items() if pd.notna(v) and str(v).strip()}
    
    def get_val(row, possible_names):
        for name in possible_names:
            key = col_map.get(name)
            if key and pd.notna(row.get(key)):
                return row.get(key)
            if pd.notna(row.get(name)):
                return row.get(name)
        return ""
        
    debug_out = []
    for i, row in enumerate(raw_records[:5]):
        bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
        debug_out.append({"index": i, "bed_val": bed_val, "row": row})
        
    with open("debug.txt", "w") as f:
        json.dump(debug_out, f, indent=2)

    print("Debug written to debug.txt")
except Exception as e:
    print("Error:", e)
