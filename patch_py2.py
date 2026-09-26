import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

replacement = """
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
    replacement.strip(),
    content,
    flags=re.DOTALL
)

with open('sync_powerbi_relational.py', 'w') as f:
    f.write(content)
print("Patched Python file again!")
