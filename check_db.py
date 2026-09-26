import os
import requests

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://uuvomcxbgldgtmuqtymk.supabase.co")
SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1dm9tY3hiZ2xkZ3RtdXF0eW1rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODkwNTQ4MSwiZXhwIjoyMTA0NDgxNDgxfQ.qd80QNiyhjO51Ky4zxKmzXtOb-bB4hFvhZ3cYnVoyn0"
)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json"
}

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

res = requests.get(f"{SUPABASE_URL}/rest/v1/patients", headers=HEADERS, verify=False)
print("Patients count:", len(res.json()) if isinstance(res.json(), list) else res.json())
res = requests.get(f"{SUPABASE_URL}/rest/v1/rooms", headers=HEADERS, verify=False)
print("Rooms count:", len(res.json()) if isinstance(res.json(), list) else res.json())
res = requests.get(f"{SUPABASE_URL}/rest/v1/admissions", headers=HEADERS, verify=False)
print("Admissions count:", len(res.json()) if isinstance(res.json(), list) else res.json())

