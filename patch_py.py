import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

replacement = """
            # ---------------------------------------------------------
            # 2. LEGACY JSON SYNC (Keeps existing frontend alive)
            # ---------------------------------------------------------
            existing = fetch_existing_supabase_state()
            now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
            
            # Reconstruct the legacy array strictly by mapping the identified columns
            # to the hardcoded keys the Node.js backend expects ("Unnamed: X").
            legacy_occupancy_rows = []
            
            # We must also preserve the 'header' row so Node.js startIdx logic works
            header_legacy = {
                "No filters applied": "AdmissionDate",
                "Unnamed: 1": "Bed#",
                "Unnamed: 2": "MRN",
                "Unnamed: 3": "Patient",
                "Unnamed: 12": "Financial Status",
                "Unnamed: 22": "TreatingPhysicianName"
            }
            legacy_occupancy_rows.append(header_legacy)
            
            for row in new_occupancy_rows:
                # Skip the header row from the original data
                if str(get_val(row, ["Bed#", "BedName_EN"])) == "Bed#":
                    continue
                    
                legacy_row = {
                    "No filters applied": clean_val(get_val(row, ["AdmissionDate"])),
                    "Unnamed: 1": clean_val(get_val(row, ["Bed#", "BedName_EN"])),
                    "Unnamed: 2": clean_val(get_val(row, ["MRN", "PatientBarcode"])),
                    "Unnamed: 3": clean_val(get_val(row, ["Patient", "EnglishFullName"])),
                    "Unnamed: 12": clean_val(get_val(row, ["Financial Status", "ContractorName"])),
                    "Unnamed: 22": clean_val(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN"]))
                }
                legacy_occupancy_rows.append(legacy_row)
            
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": legacy_occupancy_rows, "previous": existing["previous"]},
                    "updated_at": now_iso
                }
            ]
"""

content = re.sub(
    r"# ---------------------------------------------------------\n\s*# 2\. LEGACY JSON SYNC.*?\n\s*\]",
    replacement.strip(),
    content,
    flags=re.DOTALL
)

with open('sync_powerbi_relational.py', 'w') as f:
    f.write(content)
print("Patched Python file!")
