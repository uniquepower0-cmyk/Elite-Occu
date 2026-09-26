import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

# 1. Update the RPC payload to include the demographic columns
rpc_replacement = """
                rpc_payload.append({
                    "MRN": str(get_val(row, ["MRN", "PatientBarcode"])),
                    "Patient": str(get_val(row, ["Patient", "EnglishFullName"]) or "Unknown"),
                    "Bed#": str(get_val(row, ["Bed#", "BedName_EN"])),
                    "Floor Name": str(get_val(row, ["Floor Name", "FloorName_EN"])),
                    "TreatingPhysicianName": str(get_val(row, ["TreatingPhysicianName"])),
                    "AdmissionDate": str(ad_val) if ad_val else None,
                    "Age": str(get_val(row, ["Age"])),
                    "DefaultMobile": str(get_val(row, ["DefaultMobile", "Mobile"])),
                    "Financial Status": str(get_val(row, ["Financial Status", "ContractorName"])),
                    "ICD-10 Diagnosis": str(get_val(row, ["ICD-10 Diagnosis"])),
                    "Gender": str(get_val(row, ["Gender"])),
                    "BirthDate": str(get_val(row, ["BirthDate", "DOB"])),
                    "Blood Type": str(get_val(row, ["Blood Type"]))
                })
"""
content = re.sub(
    r"rpc_payload\.append\(\{.*?\n\s*\}\)",
    rpc_replacement.strip(),
    content,
    flags=re.DOTALL
)

# 2. Update the Legacy JSON Sync block to properly reconstruct the structure using raw_records
legacy_replacement = """
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
            
            # Send the reconstructed rigid array so legacy backend parses it flawlessly
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": legacy_occupancy_rows, "previous": existing.get("previous")},
                    "updated_at": now_iso
                }
            ]
"""
content = re.sub(
    r"# ---------------------------------------------------------\n\s*# 2\. LEGACY JSON SYNC.*?\n\s*\]",
    legacy_replacement.strip(),
    content,
    flags=re.DOTALL
)

with open('sync_powerbi_relational.py', 'w') as f:
    f.write(content)
print("Script updated securely.")
