import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

# Update the Legacy JSON Sync block to properly reconstruct the structure using raw_records
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
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", ""] or "no filters" in bed_val.lower():
                    continue
                    
                legacy_row = {
                    "No filters applied": clean_val(get_val(row, ["AdmissionDate", "Admission Date", "Date"])),
                    "Unnamed: 1": clean_val(bed_val),
                    "Unnamed: 2": clean_val(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN"])),
                    "Unnamed: 3": clean_val(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name"])),
                    "Unnamed: 12": clean_val(get_val(row, ["Financial Status", "ContractorName", "Contractor", "Financial"])),
                    "Unnamed: 22": clean_val(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor"]))
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
print("Ultimate resilient alignment patch applied successfully.")
