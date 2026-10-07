-- ==============================================================================
-- Migration: Medical Specialties Nomenclature & Optimization
-- Canonical reference tables, indexed alias lookup, and database-level normalizer
-- ==============================================================================

-- 1. Create Canonical Reference Table
CREATE TABLE IF NOT EXISTS public.medical_specialties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name_en VARCHAR(100) NOT NULL,
    name_ar VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL, -- 'Medical', 'Surgical', 'Pediatric', 'Critical Care', 'Allied'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Synonym & Alias Mapping Table
CREATE TABLE IF NOT EXISTS public.specialty_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias_raw VARCHAR(100) NOT NULL,
    specialty_id UUID NOT NULL REFERENCES public.medical_specialties(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_specialty_alias_raw UNIQUE (alias_raw)
);

-- 3. Optimization: Fast B-Tree index on lowercase trimmed alias for set-based joins
CREATE INDEX IF NOT EXISTS idx_specialty_aliases_lookup 
ON public.specialty_aliases (LOWER(TRIM(alias_raw)));

-- 4. Seed Canonical Specialties
INSERT INTO public.medical_specialties (code, name_en, name_ar, category) VALUES
  ('INTERNAL_MEDICINE', 'Internal Medicine', 'الباطنة العامة', 'Medical'),
  ('GENERAL_SURGERY', 'General Surgery', 'الجراحة العامة', 'Surgical'),
  ('CARDIOLOGY', 'Cardiology', 'أمراض القلب', 'Medical'),
  ('PEDIATRIC_CARDIOLOGY', 'Pediatric Cardiology', 'قلب أطفال', 'Pediatric'),
  ('PEDIATRICS', 'Pediatrics', 'طب الأطفال', 'Pediatric'),
  ('VASCULAR_SURGERY', 'Vascular Surgery', 'جراحة الأوعية الدموية', 'Surgical'),
  ('CARDIOTHORACIC_SURGERY', 'Cardiothoracic Surgery', 'جراحة القلب والصدر', 'Surgical'),
  ('UROLOGY', 'Urology', 'جراحة المسالك البولية', 'Surgical'),
  ('ORTHOPEDIC_SURGERY', 'Orthopedic Surgery', 'جراحة العظام', 'Surgical'),
  ('NEUROSURGERY', 'Neurosurgery', 'جراحة المخ والأعصاب', 'Surgical'),
  ('ONCOLOGY', 'Oncology', 'علاج الأورام', 'Medical'),
  ('NEUROLOGY', 'Neurology', 'الأمراض العصبية', 'Medical'),
  ('ENT', 'ENT', 'الأنف والأذن والحنجرة', 'Surgical'),
  ('OB_GYN', 'Obstetrics and gynecology', 'النساء والتوليد', 'Surgical'),
  ('ICU', 'ICU', 'العناية المركزة', 'Critical Care'),
  ('ANESTHESIA', 'Anesthesia and pain therapy', 'التخدير وعلاج الآلام', 'Allied'),
  ('PHYSIOTHERAPY', 'Physiotherapy', 'العلاج الطبيعي', 'Allied'),
  ('INTERVENTIONAL_RAD', 'Interventional Radiology', 'الأشعة التداخلية', 'Allied'),
  ('DENTAL', 'Dental', 'طب الأسنان', 'Allied'),
  ('MAXILLOFACIAL', 'Maxillofacial', 'جراحة الوجه والفكين', 'Surgical')
ON CONFLICT (code) DO UPDATE 
SET name_en = EXCLUDED.name_en,
    name_ar = EXCLUDED.name_ar,
    category = EXCLUDED.category;

-- 5. Seed Synonyms and Aliases
WITH spec_map AS (
  SELECT code, id FROM public.medical_specialties
)
INSERT INTO public.specialty_aliases (alias_raw, specialty_id)
SELECT v.alias, s.id
FROM (VALUES
  -- Internal Medicine rollup
  ('internal medicine', 'INTERNAL_MEDICINE'),
  ('internal medicine clinic', 'INTERNAL_MEDICINE'),
  ('internal medicine (im)', 'INTERNAL_MEDICINE'),
  ('internal', 'INTERNAL_MEDICINE'),
  ('im', 'INTERNAL_MEDICINE'),
  ('pulmonology', 'INTERNAL_MEDICINE'),
  ('hematology', 'INTERNAL_MEDICINE'),
  ('haematology', 'INTERNAL_MEDICINE'),
  ('endocrinology', 'INTERNAL_MEDICINE'),
  ('rheumatology', 'INTERNAL_MEDICINE'),

  -- General Surgery rollup (including pediatric surgery, git, bariatric)
  ('general surgery', 'GENERAL_SURGERY'),
  ('general surgery (gs)', 'GENERAL_SURGERY'),
  ('git surgery', 'GENERAL_SURGERY'),
  ('bariatric surgery', 'GENERAL_SURGERY'),
  ('pediatric surgery', 'GENERAL_SURGERY'),
  ('surgical', 'GENERAL_SURGERY'),
  ('gs', 'GENERAL_SURGERY'),

  -- Cardiology
  ('cardiology', 'CARDIOLOGY'),

  -- Pediatric Cardiology
  ('pediatric cardiology', 'PEDIATRIC_CARDIOLOGY'),

  -- Pediatrics
  ('pediatrics', 'PEDIATRICS'),
  ('pediatric', 'PEDIATRICS'),

  -- Vascular Surgery
  ('vascular surgery', 'VASCULAR_SURGERY'),
  ('vascular', 'VASCULAR_SURGERY'),

  -- Cardiothoracic Surgery
  ('cardiothoracic surgery', 'CARDIOTHORACIC_SURGERY'),
  ('cardiothoracic', 'CARDIOTHORACIC_SURGERY'),

  -- Urology
  ('urology', 'UROLOGY'),

  -- Orthopedic Surgery
  ('orthopedic surgery', 'ORTHOPEDIC_SURGERY'),
  ('orthopedics', 'ORTHOPEDIC_SURGERY'),
  ('orthopaedics', 'ORTHOPEDIC_SURGERY'),
  ('orthopaedics (ortho)', 'ORTHOPEDIC_SURGERY'),
  ('ortho', 'ORTHOPEDIC_SURGERY'),

  -- Neurosurgery
  ('neurosurgery', 'NEUROSURGERY'),
  ('neuro surgery', 'NEUROSURGERY'),

  -- Oncology
  ('oncology', 'ONCOLOGY'),

  -- Neurology
  ('neurology', 'NEUROLOGY'),

  -- ENT
  ('ent', 'ENT'),

  -- Obstetrics and gynecology
  ('obstetrics and gynecology', 'OB_GYN'),
  ('ob/gyn', 'OB_GYN'),
  ('obgyn', 'OB_GYN'),

  -- ICU (trailing dot cleanup)
  ('icu.', 'ICU'),
  ('icu', 'ICU'),
  ('critical care', 'ICU'),

  -- Anesthesia
  ('anesthesia and pain therapy', 'ANESTHESIA'),
  ('anesthesia', 'ANESTHESIA'),

  -- Physiotherapy (typo fix)
  ('physiotherapy', 'PHYSIOTHERAPY'),
  ('physiotherpy', 'PHYSIOTHERAPY'),

  -- Interventional Radiology (typo fix)
  ('interventional radiology', 'INTERVENTIONAL_RAD'),
  ('intervential radiology', 'INTERVENTIONAL_RAD'),

  -- Dental & Maxillofacial
  ('dental', 'DENTAL'),
  ('maxillofacial', 'MAXILLOFACIAL')
) AS v(alias, spec_code)
JOIN spec_map s ON s.code = v.spec_code
ON CONFLICT (alias_raw) DO UPDATE 
SET specialty_id = EXCLUDED.specialty_id;

-- 6. Helper Function: Fast Single-Specialty Resolution
CREATE OR REPLACE FUNCTION public.normalize_specialty_name(raw_specialty TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (
      SELECT ms.name_en
      FROM public.specialty_aliases sa
      JOIN public.medical_specialties ms ON ms.id = sa.specialty_id
      WHERE LOWER(TRIM(sa.alias_raw)) = LOWER(TRIM(raw_specialty))
      LIMIT 1
    ),
    CASE 
      WHEN NULLIF(TRIM(raw_specialty), '') IS NULL OR LOWER(TRIM(raw_specialty)) IN ('speciality', 'specialty', 'external laboratory', '0', 'physician') 
        THEN 'Other / غير محدد'
      ELSE TRIM(raw_specialty)
    END
  );
$$;

-- 7. Normalize existing records in public.staff
UPDATE public.staff 
SET role = public.normalize_specialty_name(role)
WHERE role IS NOT NULL 
  AND role != 'Physician'
  AND role != public.normalize_specialty_name(role);
