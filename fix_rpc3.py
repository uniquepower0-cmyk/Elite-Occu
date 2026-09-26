import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

rpc_replacement = """
                rpc_payload.append({
                    "MRN": str(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])),
                    "Patient": str(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"]) or "Unknown"),
                    "Bed#": str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])),
                    "Floor Name": str(get_val(row, ["Floor Name", "FloorName_EN", "Floor", "الطابق", "الدور", "Unnamed: 5"])),
                    "TreatingPhysicianName": str(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"])),
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
print("RPC payload unnamed fallbacks fixed.")
