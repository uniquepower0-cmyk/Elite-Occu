import os, json, requests
from urllib.parse import urlparse, parse_qs

SUPABASE_REST_URL = os.getenv("SUPABASE_URL", "https://uuvomcxbgldgtmuqtymk.supabase.co") + "/rest/v1/rtdb_nodes?path=eq.state/occupancy"
SUPABASE_HEADERS = {
    "apikey": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
    "Authorization": f"Bearer {os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')}",
    "Content-Type": "application/json"
}

with open("sync_powerbi_relational.py", "r") as f:
    for line in f:
        if "os.getenv(\"SUPABASE_SERVICE_ROLE_KEY\"" in line and "eyJ" in line:
            import re
            m = re.search(r'os\.getenv\("SUPABASE_SERVICE_ROLE_KEY", "(.*?)"\)', line)
            if m:
                key = m.group(1)
                SUPABASE_HEADERS["apikey"] = key
                SUPABASE_HEADERS["Authorization"] = f"Bearer {key}"

res = requests.get(SUPABASE_REST_URL, headers=SUPABASE_HEADERS)
if res.status_code == 200:
    data = res.json()
    if data and len(data) > 0:
        occ = data[0].get("data", {})
        curr = occ.get("current", [])
        print("Length:", len(curr))
        print("First:", curr[0] if len(curr)>0 else None)
        print("Second:", curr[1] if len(curr)>1 else None)
    else:
        print("No data found")
else:
    print("Error:", res.text)
