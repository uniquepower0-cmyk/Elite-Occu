# Medical Specialties Nomenclature & Optimization Design

## 1. Overview & Understanding Summary
This document specifies the unified clinical specialty taxonomy and high-performance database normalization architecture for the **MedSync Hospital Occupancy Manager**.

- **Goal**: Standardize fragmented medical specialty nomenclature across all data ingest pipelines, relational tables, executive reporting cards, and Excel workbooks.
- **Problem**: 29 raw variations existed in PowerBI feeds and Excel sheets, including typographical errors (`Physiotherpy`, `Intervential Radiology`), trailing punctuation (`ICU.`), header row leaks (`Speciality`), and inconsistent sub-specialty attributions.
- **Solution**: A 2-tier database-optimized taxonomy enforced by a PostgreSQL lookup dictionary with indexed alias resolution on ingest, coupled with a centralized application-level normalizer for zero-latency Excel and dashboard reporting.

---

## 2. Standardized Specialty Taxonomy Map

| Canonical Specialty | Primary Category | Aliases & Raw Variations Consolidated | Exclusions & Special Rules |
| :--- | :--- | :--- | :--- |
| **Internal Medicine** | Medical | `Internal Medicine`, `Internal Medicine Clinic`, `Pulmonology`, `Hematology`, `Haematology`, `Endocrinology`, `Rheumatology` | **Cardiology** and **Pediatric Cardiology** are explicitly separated. |
| **General Surgery** | Surgical | `General Surgery`, `GIT Surgery`, `Bariatric surgery`, `Pediatric surgery`, `Surgical` | **Vascular Surgery**, **Cardiothoracic Surgery**, and **Urology** are explicitly separated. |
| **Cardiology** | Medical | `Cardiology` | Kept independent from Internal Medicine. |
| **Pediatric Cardiology** | Pediatric / Medical | `Pediatric Cardiology` | Kept independent from both Pediatrics and Internal Medicine. |
| **Pediatrics** | Pediatric | `Pediatrics` | Kept independent; Pediatric Surgery rolls into General Surgery. |
| **Vascular Surgery** | Surgical | `Vascular Surgery` | Standalone surgical specialty. |
| **Cardiothoracic Surgery**| Surgical | `Cardiothoracic surgery` | Standalone surgical specialty. |
| **Urology** | Surgical | `Urology` | Standalone surgical specialty. |
| **Orthopedic Surgery** | Surgical | `Orthopedics`, `Orthopedic Surgery`, `Orthopaedic surgery` | Consolidated into `Orthopedic Surgery`. |
| **Neurosurgery** | Surgical | `Neurosurgery` | Standalone surgical specialty. |
| **Oncology** | Medical | `Oncology` | Standalone specialty. |
| **Neurology** | Medical | `Neurology` | Standalone specialty. |
| **ENT** | Surgical | `ENT` | Standalone specialty. |
| **Obstetrics & Gynecology**| Surgical / Ob-Gyn | `Obstetrics and gynecology`, `OB/GYN` | Standalone specialty. |
| **ICU** | Critical Care | `ICU.`, `ICU`, `Critical Care` | Trailing dot stripped; canonical code `ICU`. |
| **Anesthesia & Pain** | Allied / Clinical | `Anesthesia and pain therapy` | Standalone clinical specialty. |
| **Physiotherapy** | Allied Health | `Physiotherapy`, `Physiotherpy` | Typo corrected. |
| **Interventional Radiology**| Diagnostics / IR | `Intervential Radiology`, `Interventional Radiology`| Typo corrected. |
| **Dental & Maxillofacial** | Dental | `Dental`, `Maxillofacial` | Allied clinical service. |
| **Other / غير محدد** | Unassigned | `Speciality` (header leak), `External Laboratory`, `None`, `nan`, `0`, empty | Ignored / unmapped fallback. |

---

## 3. Database Schema & Performance Optimization

### 3.1 Relational Tables
```sql
-- Canonical Reference Table
CREATE TABLE IF NOT EXISTS public.medical_specialties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name_en VARCHAR(100) NOT NULL,
    name_ar VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL, -- 'Medical', 'Surgical', 'Pediatric', 'Critical Care', 'Allied'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Synonym & Alias Mapping Table
CREATE TABLE IF NOT EXISTS public.specialty_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias_raw VARCHAR(100) NOT NULL,
    specialty_id UUID NOT NULL REFERENCES public.medical_specialties(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_specialty_alias_raw UNIQUE (alias_raw)
);

-- Fast Index for Set-Based Sync Matching
CREATE INDEX IF NOT EXISTS idx_specialty_aliases_lookup 
ON public.specialty_aliases (LOWER(TRIM(alias_raw)));
```

### 3.2 High-Performance Set-Based Ingestion (`db/rpc_sync.sql`)
During `sync_powerbi_admissions(payload JSON)`, the staging table resolves canonical specialties via a set-based `LEFT JOIN` on `specialty_aliases`:

```sql
INSERT INTO tmp_sync_admissions_staging (
    ..., specialty, specialty_id
)
SELECT
    ...,
    COALESCE(ms.name_en, 'Other / غير محدد') AS specialty,
    ms.id AS specialty_id
FROM json_array_elements(payload) AS rec
LEFT JOIN public.specialty_aliases sa 
    ON LOWER(TRIM(rec->>'Specialty')) = LOWER(TRIM(sa.alias_raw))
LEFT JOIN public.medical_specialties ms 
    ON ms.id = sa.specialty_id;
```

**Optimization Benefits:**
1. Eliminates repetitive runtime `CASE WHEN` and regex evaluations across thousands of admissions.
2. New spelling variations can be resolved on-the-fly by adding a row to `specialty_aliases` without code deployment.
3. Doctor profiles in `public.staff` are automatically updated with canonical titles rather than dirty spreadsheet values.

---

## 4. Application Layer Architecture (`server.ts` & Excel)

A shared module `server/specialtyNormalizer.ts` (or centralized dictionary in `server.ts`) standardizes all strings before in-memory grouping or Excel output:

```typescript
export const SPECIALTY_CANONICAL_MAP: Record<string, string> = {
  // Internal Medicine
  "internal medicine": "Internal Medicine",
  "internal medicine clinic": "Internal Medicine",
  "pulmonology": "Internal Medicine",
  "hematology": "Internal Medicine",
  "haematology": "Internal Medicine",
  "endocrinology": "Internal Medicine",
  "rheumatology": "Internal Medicine",

  // General Surgery (with Pediatric Surgery)
  "general surgery": "General Surgery",
  "git surgery": "General Surgery",
  "bariatric surgery": "General Surgery",
  "pediatric surgery": "General Surgery",
  "surgical": "General Surgery",

  // ICU
  "icu.": "ICU",
  "icu": "ICU",
  "critical care": "ICU",

  // Typos & Ortho
  "orthopedics": "Orthopedic Surgery",
  "orthopedic surgery": "Orthopedic Surgery",
  "orthopaedics": "Orthopedic Surgery",
  "physiotherapy": "Physiotherapy",
  "physiotherpy": "Physiotherapy",
  "intervential radiology": "Interventional Radiology",
  "interventional radiology": "Interventional Radiology",

  // Standalone Specialties
  "cardiology": "Cardiology",
  "pediatric cardiology": "Pediatric Cardiology",
  "vascular surgery": "Vascular Surgery",
  "cardiothoracic surgery": "Cardiothoracic surgery",
  "urology": "Urology",
  "neurosurgery": "Neurosurgery",
  "oncology": "Oncology",
  "neurology": "Neurology",
  "ent": "ENT",
  "obstetrics and gynecology": "Obstetrics and gynecology",
  "pediatrics": "Pediatrics",
  "anesthesia and pain therapy": "Anesthesia and pain therapy",
  "dental": "Dental",
  "maxillofacial": "Maxillofacial"
};

export function normalizeSpecialty(raw: string | null | undefined): string {
  if (!raw) return "Other / غير محدد";
  const clean = raw.trim().toLowerCase();
  if (clean === "speciality" || clean === "external laboratory" || clean === "0") {
    return "Other / غير محدد";
  }
  return SPECIALTY_CANONICAL_MAP[clean] || raw.trim();
}
```

---

## 5. Decision Log

| ID | Topic | Decision | Rationale |
| :--- | :--- | :--- | :--- |
| **DEC-01** | Internal Medicine | Consolidated Pulmonology, Hematology, Endocrinology, Rheumatology, Internal Medicine Clinic under `Internal Medicine` | Clean clinical department grouping for ward occupancy. |
| **DEC-02** | General Surgery | Consolidated GIT Surgery, Bariatric Surgery, Pediatric Surgery under `General Surgery` | Core surgical bed management aggregation. |
| **DEC-03** | Standalone Surgical | Kept `Vascular Surgery`, `Cardiothoracic surgery`, `Urology`, `Orthopedic Surgery`, `Neurosurgery`, `ENT`, `Ob/Gyn` independent | High-volume surgical specialties with distinct operative suites and consult services. |
| **DEC-04** | Cardiology & Ped. Cardio | Kept `Cardiology` and `Pediatric Cardiology` independent from each other and from Internal Medicine | Distinct clinical sub-specialties requiring separate census monitoring. |
| **DEC-05** | Pediatrics & Ped. Surgery | Kept `Pediatrics` independent; routed `Pediatric surgery` to `General Surgery` | Matches operational hospital ward policy. |
| **DEC-06** | ICU Nomenclature | Strictly named `ICU` (aliases: `ICU.`, `ICU`, `Critical Care`) | Removes trailing punctuation and aligns with intensive care unit labeling. |
| **DEC-07** | Database Architecture | Relational tables (`medical_specialties` + `specialty_aliases`) with indexed set-based lookup in `rpc_sync.sql` | Sub-millisecond ingest performance, eliminates runtime regex overhead, allows dynamic alias addition. |
| **DEC-08** | Ingest Hygiene | Filter out `Speciality` (header row) and `External Laboratory` (diagnostic service) | Prevents phantom beds or skewed clinical counts. |
