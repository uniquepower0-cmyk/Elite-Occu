import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

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
                "Unnamed: 5": "Financial Class",
                "Unnamed: 6": "Service",
                "Unnamed: 9": "Patient Share",
                "Unnamed: 10": "Contractor Share",
                "Unnamed: 11": "Remarks",
                "Unnamed: 12": "Financial Status",
                "Unnamed: 22": "TreatingPhysicianName"
            }
            legacy_occupancy_rows.append(fake_header)
            
            for row in raw_records:
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1", ""] or "no filters" in bed_val.lower():
                    continue
                    
                legacy_row = {
                    "No filters applied": clean_val(get_val(row, ["AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ", "No filters applied", "Unnamed: 0"])),
                    "Unnamed: 1": clean_val(bed_val),
                    "Unnamed: 2": clean_val(get_val(row, ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"])),
                    "Unnamed: 3": clean_val(get_val(row, ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"])),
                    "Unnamed: 5": clean_val(get_val(row, ["Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"])),
                    "Unnamed: 6": clean_val(get_val(row, ["Service", "الخدمة", "Unnamed: 6"])),
                    "Unnamed: 9": clean_val(get_val(row, ["Patient Share", "PatientAmount", "مساهمة المريض", "نسبة المريض", "Unnamed: 9"])),
                    "Unnamed: 10": clean_val(get_val(row, ["Contractor Share", "ContractorAmount", "مساهمة الجهة", "تحمل الجهة", "Unnamed: 10"])),
                    "Unnamed: 11": clean_val(get_val(row, ["Remarks", "Notes", "ملاحظات", "Unnamed: 11"])),
                    "Unnamed: 12": clean_val(get_val(row, ["Financial Status", "ContractorName", "Contractor", "Financial", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"])),
                    "Unnamed: 22": clean_val(get_val(row, ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"]))
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
print("Debts legacy columns added to patch.")
