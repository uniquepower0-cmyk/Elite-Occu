import os, json, io, sys
import urllib.request

SUPABASE_REST_URL = os.getenv("SUPABASE_URL", "https://uuvomcxbgldgtmuqtymk.supabase.co") + "/rest/v1/rtdb_nodes?path=eq.state/occupancy"
SUPABASE_HEADERS = {
    "apikey": os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
    "Authorization": f"Bearer {os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')}",
    "Content-Type": "application/json"
}

try:
    with open("sync_powerbi_relational.py", "r") as f:
        content = f.read()
        import re
        m = re.search(r'os\.getenv\("SUPABASE_SERVICE_ROLE_KEY", "(.*?)"\)', content)
        if m:
            key = m.group(1)
            SUPABASE_HEADERS["apikey"] = key
            SUPABASE_HEADERS["Authorization"] = f"Bearer {key}"
            
    req = urllib.request.Request(SUPABASE_REST_URL, headers=SUPABASE_HEADERS)
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode())
        if data and len(data) > 0:
            occ = data[0].get("data", {})
            curr = occ.get("current", [])
            print("Successfully fetched Supabase state!")
            print("First 3 rows:")
            print(json.dumps(curr[:3], indent=2))
        else:
            print("No data in Supabase.")
except Exception as e:
    print("Error:", e)
