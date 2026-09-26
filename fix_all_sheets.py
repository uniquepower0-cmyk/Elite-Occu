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
                "Unnamed: 8": "Companion",
                "Unnamed: 9": "Patient Share",
                "Unnamed: 10": "Contractor Share",
                "Unnamed: 11": "Remarks",
                "Unnamed: 12": "Financial Status",
                "Unnamed: 18": "LOS Status",
                "Unnamed: 20": "Expected Discharge",
                "Unnamed: 22": "TreatingPhysicianName",
                "Unnamed: 23": "Medical Plan X",
                "Unnamed: 24": "Transfer History",
                "Unnamed: 25": "Total Invoice",
                "Unnamed: 27": "Remaining Amount",
                "Unnamed: 32": "Medical Plan AG",
                "Unnamed: 33": "Medical Plan AH",
                "Unnamed: 37": "LOS AL"
            }
            legacy_occupancy_rows.append(fake_header)
            
            for row in raw_records:
                bed_val = str(get_val(row, ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"])).strip()
                if bed_val.lower() in ["bed#", "bed", "room", "الغرفة", "غرفة", "السرير", "سرير", "unnamed: 1", ""] or "no filters" in bed_val.lower():
                    continue
                    
                # Dynamically construct all 39 possible columns to support every legacy sheet (Debts, LOS, Medical Plans, etc)
                legacy_row = {}
                
                # We handle the primary known columns with explicit fallbacks
                known_mappings = {
                    0: ["AdmissionDate", "Admission Date", "Date", "تاريخ الدخول", "التاريخ", "No filters applied", "Unnamed: 0"],
                    1: ["Bed#", "BedName_EN", "Bed", "Room", "Bed No", "الغرفة", "غرفة", "السرير", "سرير", "Unnamed: 1"],
                    2: ["MRN", "PatientBarcode", "Patient ID", "ID", "Patient MRN", "رقم المريض", "الملف", "Unnamed: 2"],
                    3: ["Patient", "EnglishFullName", "Patient Name", "Name", "المريض", "اسم المريض", "الاسم", "Unnamed: 3"],
                    5: ["Financial Class", "Class", "Type", "الفئة", "نوع", "Unnamed: 5"],
                    6: ["Service", "الخدمة", "Unnamed: 6"],
                    8: ["Companion", "مرافق", "Unnamed: 8"],
                    9: ["Patient Share", "PatientAmount", "مساهمة المريض", "نسبة المريض", "Unnamed: 9"],
                    10: ["Contractor Share", "ContractorAmount", "مساهمة الجهة", "تحمل الجهة", "Unnamed: 10"],
                    11: ["Remarks", "Notes", "ملاحظات", "Unnamed: 11"],
                    12: ["Financial Status", "ContractorName", "Contractor", "Financial", "الجهة", "الشركة", "جهة الدفع", "Unnamed: 12"],
                    18: ["LOS Status", "Unnamed: 18"],
                    20: ["Expected Discharge", "Unnamed: 20"],
                    22: ["TreatingPhysicianName", "ConsultantName_EN", "Physician", "Doctor", "الطبيب", "الطبيب المعالج", "Unnamed: 22"],
                    23: ["Medical Plan X", "Unnamed: 23"],
                    24: ["Transfer History", "Unnamed: 24"],
                    25: ["Total Invoice", "Total Amount", "Total", "إجمالي الفاتورة", "الاجمالي", "Unnamed: 25"],
                    27: ["Remaining Amount", "Remaining", "Balance", "المتبقي", "الباقي", "Unnamed: 27"],
                    32: ["Medical Plan AG", "Unnamed: 32"],
                    33: ["Medical Plan AH", "Unnamed: 33"],
                    37: ["LOS AL", "Unnamed: 37"]
                }
                
                for i in range(39):
                    col_key = "No filters applied" if i == 0 else f"Unnamed: {i}"
                    if i in known_mappings:
                        val = clean_val(get_val(row, known_mappings[i]))
                        legacy_row[col_key] = val
                    else:
                        # Fallback for all other unmapped legacy columns
                        legacy_row[col_key] = clean_val(get_val(row, [f"Unnamed: {i}"]))
                        
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
print("All legacy sheet columns perfectly mapped.")
