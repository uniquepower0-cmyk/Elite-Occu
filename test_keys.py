import sync_powerbi_relational as sync
import os, json, requests
import pandas as pd
import io
from requests_ntlm import HttpNtlmAuth

sync.fortinet_reconnect()

POWERBI_USER = os.getenv("POWERBI_USER", "biviewer")
POWERBI_PASS = os.getenv("POWERBI_PASS", "123456")
export_url = "http://10.0.17.20/Reports/api/v2.0/ExecutionLog/Export?format=EXCELOPENXML"
raw_payload = r'''{"ReportPath":"/Occupency Sheet","Parameters":[{"Name":"FacilityId","Value":"1"}]}'''

try:
    response = requests.post(export_url, json=json.loads(raw_payload), auth=HttpNtlmAuth(POWERBI_USER, POWERBI_PASS), timeout=20)
    df = pd.read_excel(io.BytesIO(response.content), dtype=str)
    
    print("DATAFRAME COLUMNS:")
    print(df.columns.tolist())
    
    print("\nFIRST ROW (TO_DICT):")
    if not df.empty:
        print(df.iloc[0].to_dict())
            
except Exception as e:
    print("Error:", e)
