import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

# Revert RPC payload back to the core 6 columns so Postgres doesn't crash!
rpc_replacement = """
                rpc_payload.append({
                    "MRN": str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN"])),
                    "Patient": str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name"]) or "Unknown"),
                    "Bed#": str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No"])),
                    "Floor Name": str(get_val(row, ["Floor Name", "FloorName_EN", "Floor"])),
                    "TreatingPhysicianName": str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor"])),
                    "AdmissionDate": str(ad_val) if ad_val else None
                })
"""
content = re.sub(
    r"rpc_payload\.append\(\{.*?\n\s*\}\)",
    rpc_replacement.strip(),
    content,
    flags=re.DOTALL
)

with open('sync_powerbi_relational.py', 'w') as f:
    f.write(content)
print("RPC payload fixed to prevent Postgres crashes.")
