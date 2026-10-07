/**
 * Medical Specialties Normalization Engine
 * Standardizes raw specialties, clinical branches, and typographical variations
 * based on the unified hospital nomenclature design.
 */

export const CANONICAL_SPECIALTIES = [
  "Internal Medicine",
  "General Surgery",
  "Cardiology",
  "Pediatric Cardiology",
  "Pediatrics",
  "Vascular Surgery",
  "Cardiothoracic Surgery",
  "Urology",
  "Orthopedic Surgery",
  "Neurosurgery",
  "Oncology",
  "Neurology",
  "ENT",
  "Obstetrics and gynecology",
  "ICU",
  "Anesthesia and pain therapy",
  "Physiotherapy",
  "Interventional Radiology",
  "Dental",
  "Maxillofacial"
] as const;

export type CanonicalSpecialty = typeof CANONICAL_SPECIALTIES[number] | "Other / غير محدد";

export const SPECIALTY_CANONICAL_MAP: Record<string, string> = {
  // 1. Internal Medicine rollup (excludes Cardiology and Pediatric Cardiology)
  "internal medicine": "Internal Medicine",
  "internal medicine clinic": "Internal Medicine",
  "internal medicine (im)": "Internal Medicine",
  "internal": "Internal Medicine",
  "im": "Internal Medicine",
  "pulmonology": "Internal Medicine",
  "hematology": "Internal Medicine",
  "haematology": "Internal Medicine",
  "endocrinology": "Internal Medicine",
  "rheumatology": "Internal Medicine",
  "باطنة": "Internal Medicine",
  "الباطنة": "Internal Medicine",
  "امراض دم": "Internal Medicine",
  "صدرية": "Internal Medicine",

  // 2. General Surgery rollup (includes GIT, Bariatric, Pediatric surgery)
  "general surgery": "General Surgery",
  "general surgery (gs)": "General Surgery",
  "git surgery": "General Surgery",
  "bariatric surgery": "General Surgery",
  "pediatric surgery": "General Surgery",
  "surgical": "General Surgery",
  "gs": "General Surgery",
  "جراحة عامة": "General Surgery",
  "جراحة سمنة": "General Surgery",
  "جراحة اطفال": "General Surgery",

  // 3. Cardiology (Independent)
  "cardiology": "Cardiology",
  "cardio": "Cardiology",
  "قلب": "Cardiology",
  "امراض قلب": "Cardiology",

  // 4. Pediatric Cardiology (Independent)
  "pediatric cardiology": "Pediatric Cardiology",
  "pediatric cardio": "Pediatric Cardiology",
  "قلب اطفال": "Pediatric Cardiology",

  // 5. Pediatrics (Independent)
  "pediatrics": "Pediatrics",
  "pediatric": "Pediatrics",
  "اطفال": "Pediatrics",

  // 6. Vascular Surgery (Independent)
  "vascular surgery": "Vascular Surgery",
  "vascular": "Vascular Surgery",
  "جراحة اوعية دموية": "Vascular Surgery",

  // 7. Cardiothoracic Surgery (Independent)
  "cardiothoracic surgery": "Cardiothoracic Surgery",
  "cardiothoracic": "Cardiothoracic Surgery",
  "جراحة قلب وصدر": "Cardiothoracic Surgery",

  // 8. Urology (Independent)
  "urology": "Urology",
  "مسالك بولية": "Urology",

  // 9. Orthopedic Surgery (Independent & unified)
  "orthopedic surgery": "Orthopedic Surgery",
  "orthopedics": "Orthopedic Surgery",
  "orthopaedics": "Orthopedic Surgery",
  "orthopaedics (ortho)": "Orthopedic Surgery",
  "ortho": "Orthopedic Surgery",
  "عظام": "Orthopedic Surgery",
  "جراحة عظام": "Orthopedic Surgery",

  // 10. Neurosurgery (Independent)
  "neurosurgery": "Neurosurgery",
  "neuro surgery": "Neurosurgery",
  "جراحة مخ واعصاب": "Neurosurgery",

  // 11. Oncology (Independent)
  "oncology": "Oncology",
  "اورام": "Oncology",

  // 12. Neurology (Independent)
  "neurology": "Neurology",
  "مخ واعصاب": "Neurology",

  // 13. ENT (Independent)
  "ent": "ENT",
  "ear, nose and throat": "ENT",
  "انف واذن وحنجرة": "ENT",

  // 14. Obstetrics and Gynecology (Independent)
  "obstetrics and gynecology": "Obstetrics and gynecology",
  "ob/gyn": "Obstetrics and gynecology",
  "obgyn": "Obstetrics and gynecology",
  "obstetrics": "Obstetrics and gynecology",
  "gynecology": "Obstetrics and gynecology",
  "نساء وتوليد": "Obstetrics and gynecology",

  // 15. ICU (Canonical strictly ICU)
  "icu": "ICU",
  "icu.": "ICU",
  "critical care": "ICU",
  "intensive care unit": "ICU",
  "عناية مركزة": "ICU",

  // 16. Anesthesia & Pain Therapy
  "anesthesia and pain therapy": "Anesthesia and pain therapy",
  "anesthesia": "Anesthesia and pain therapy",
  "pain therapy": "Anesthesia and pain therapy",
  "تخدير وعلاج الام": "Anesthesia and pain therapy",

  // 17. Physiotherapy (Typo fix)
  "physiotherapy": "Physiotherapy",
  "physiotherpy": "Physiotherapy",
  "علاج طبيعي": "Physiotherapy",

  // 18. Interventional Radiology (Typo fix)
  "interventional radiology": "Interventional Radiology",
  "intervential radiology": "Interventional Radiology",
  "اشعة تداخلية": "Interventional Radiology",

  // 19. Dental & Maxillofacial
  "dental": "Dental",
  "dentistry": "Dental",
  "اسنان": "Dental",
  "maxillofacial": "Maxillofacial",
  "جراحة وجه وفكين": "Maxillofacial"
};

/**
 * Normalizes any free-form raw specialty string into the hospital's canonical nomenclature.
 */
export function normalizeSpecialty(raw: string | null | undefined): string {
  if (!raw) return "Other / غير محدد";
  
  // Clean string: trim, remove surrounding quotes and multiple spaces
  let clean = String(raw).trim().replace(/\s+/g, " ");
  if (!clean || clean === "0" || clean === "-" || clean.toLowerCase() === "nan" || clean.toLowerCase() === "null") {
    return "Other / غير محدد";
  }

  // Strip trailing dots (e.g. "ICU." -> "ICU")
  const stripped = clean.replace(/\.+$/, "").trim();
  const lower = stripped.toLowerCase();

  // Exclude non-clinical items and leaked header rows
  if (
    lower === "speciality" || 
    lower === "specialty" || 
    lower === "external laboratory" ||
    lower === "physician" ||
    lower === "doctor" ||
    lower === "other"
  ) {
    return "Other / غير محدد";
  }

  // Check alias dictionary
  if (SPECIALTY_CANONICAL_MAP[lower]) {
    return SPECIALTY_CANONICAL_MAP[lower];
  }

  // Return sanitized string preserving initial title casing
  return stripped;
}
