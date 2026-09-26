import os, json, io
import requests
from requests_ntlm import HttpNtlmAuth
import pandas as pd
from dotenv import load_dotenv

load_dotenv()
POWERBI_USER = os.getenv("POWERBI_USER")
POWERBI_PASS = os.getenv("POWERBI_PASS")

export_url = "http://10.0.17.20/Reports/api/v2.0/ExecutionLog/Export?format=EXCELOPENXML"
raw_payload = r'''{"ReportPath":"/Occupency Sheet","Parameters":[{"Name":"FacilityId","Value":"1"}]}'''

response = requests.post(export_url, json=json.loads(raw_payload), auth=HttpNtlmAuth(POWERBI_USER, POWERBI_PASS), timeout=20)
df = pd.read_excel(io.BytesIO(response.content), dtype=str)
df.fillna("", inplace=True)

raw_records = df.to_dict(orient="records")
print("FIRST 3 ROWS:")
for i in range(min(3, len(raw_records))):
    print(raw_records[i])
