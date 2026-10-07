-- ==============================================================================
-- RPC: sync_powerbi_admissions (High-Performance Set-Based Architecture V3.0)
-- Synchronizes live occupancy from PowerBI / Web Uploads to Relational Tables
-- Uses set-based staging to eliminate N+1 procedural execution loops
-- ==============================================================================
CREATE OR REPLACE FUNCTION sync_powerbi_admissions(payload JSON)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_active_admission_ids UUID[];
BEGIN
  -- Prevent concurrent sync execution via transactional advisory lock
  IF NOT pg_try_advisory_xact_lock(hashtext('powerbi_sync_lock')) THEN
    RAISE NOTICE 'Concurrent sync cycle in progress. Skipping redundant run.';
    RETURN;
  END IF;

  -- 1. Create temporary staging table with parsed, normalized fields
  CREATE TEMP TABLE IF NOT EXISTS tmp_sync_admissions_staging (
    mrn VARCHAR(50),
    patient_name VARCHAR(255),
    phone VARCHAR(50),
    bed VARCHAR(100),
    ward_type VARCHAR(100),
    physician_name VARCHAR(255),
    specialty VARCHAR(100),
    admission_date TIMESTAMPTZ,
    contractor_name VARCHAR(255),
    financial_status VARCHAR(100),
    total_invoice NUMERIC(12,2),
    remaining_debt NUMERIC(12,2),
    notes TEXT,
    source VARCHAR(50),
    patient_id UUID,
    room_id UUID,
    physician_id UUID
  ) ON COMMIT DROP;

  TRUNCATE TABLE tmp_sync_admissions_staging;

  INSERT INTO tmp_sync_admissions_staging (
    mrn, patient_name, phone, bed, ward_type, physician_name, specialty,
    admission_date, contractor_name, financial_status, total_invoice,
    remaining_debt, notes, source
  )
  SELECT
    COALESCE(
      NULLIF(TRIM(rec->>'MRN'), ''),
      'UNKNOWN-' || gen_random_uuid()::text
    ) AS mrn,
    COALESCE(NULLIF(TRIM(rec->>'Patient'), ''), 'Unknown Patient') AS patient_name,
    CASE 
      WHEN NULLIF(TRIM(rec->>'Mobile'), '') IN ('None', 'nan', 'null', 'undefined') THEN NULL
      ELSE NULLIF(TRIM(rec->>'Mobile'), '')
    END AS phone,
    CASE 
      WHEN NULLIF(TRIM(rec->>'Bed#'), '') IN ('None', 'nan') THEN NULL
      ELSE NULLIF(TRIM(rec->>'Bed#'), '')
    END AS bed,
    NULLIF(TRIM(rec->>'Floor Name'), '') AS ward_type,
    CASE 
      WHEN NULLIF(TRIM(rec->>'TreatingPhysicianName'), '') IN ('None', 'nan') THEN NULL
      ELSE NULLIF(TRIM(rec->>'TreatingPhysicianName'), '')
    END AS physician_name,
    COALESCE(NULLIF(TRIM(rec->>'Specialty'), ''), 'Physician') AS specialty,
    COALESCE(
      CASE 
        WHEN NULLIF(rec->>'AdmissionDate', '') IS NOT NULL THEN
          CASE
            -- Standard ISO: YYYY-MM-DD...
            WHEN (rec->>'AdmissionDate') ~ '^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}' 
              THEN (rec->>'AdmissionDate')::TIMESTAMPTZ
            -- European/Middle-Eastern format: DD-MM-YYYY HH24:MI(:SS)
            WHEN (rec->>'AdmissionDate') ~ '^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}' 
              THEN to_timestamp(rec->>'AdmissionDate', 'DD-MM-YYYY HH24:MI:SS')
            ELSE (rec->>'AdmissionDate')::TIMESTAMPTZ
          END
        ELSE NULL 
      END,
      NOW()
    ) AS admission_date,
    CASE 
      WHEN NULLIF(TRIM(rec->>'ContractorName'), '') IN ('None', 'nan') THEN NULL
      ELSE NULLIF(TRIM(rec->>'ContractorName'), '')
    END AS contractor_name,
    CASE 
      WHEN NULLIF(TRIM(rec->>'Financial Status'), '') IN ('None', 'nan') THEN NULL
      ELSE NULLIF(TRIM(rec->>'Financial Status'), '')
    END AS financial_status,
    COALESCE(NULLIF(regexp_replace(TRIM(COALESCE(rec->>'Total Invoice', '')), '[^0-9.-]', '', 'g'), '')::NUMERIC, 0.00) AS total_invoice,
    COALESCE(NULLIF(regexp_replace(TRIM(COALESCE(rec->>'Remaining Amount', '')), '[^0-9.-]', '', 'g'), '')::NUMERIC, 0.00) AS remaining_debt,
    CASE 
      WHEN NULLIF(TRIM(rec->>'Diagnosis'), '') IN ('None', 'nan') THEN NULL
      ELSE NULLIF(TRIM(rec->>'Diagnosis'), '')
    END AS notes,
    COALESCE(NULLIF(TRIM(rec->>'Source'), ''), 'powerbi') AS source
  FROM json_array_elements(payload) AS rec;

  -- Normalize fallback MRNs for 'None' / 'nan'
  UPDATE tmp_sync_admissions_staging 
  SET mrn = 'UNKNOWN-' || gen_random_uuid()::text
  WHERE mrn IN ('None', 'nan');

  -- 2. Batch Upsert Patients
  INSERT INTO public.patients (mrn, name, phone, updated_at)
  SELECT DISTINCT ON (s.mrn) s.mrn, s.patient_name, s.phone, NOW()
  FROM tmp_sync_admissions_staging s
  WHERE s.mrn IS NOT NULL
  ON CONFLICT (mrn) DO UPDATE 
  SET name = EXCLUDED.name, 
      phone = CASE 
        WHEN EXCLUDED.phone IS NOT NULL AND TRIM(EXCLUDED.phone) NOT IN ('', 'None', 'nan', 'null', 'undefined') 
        THEN EXCLUDED.phone 
        ELSE patients.phone 
      END,
      updated_at = NOW();

  -- Resolve Patient IDs
  UPDATE tmp_sync_admissions_staging s
  SET patient_id = p.id
  FROM public.patients p
  WHERE p.mrn = s.mrn;

  -- 3. Batch Upsert Rooms
  INSERT INTO public.rooms (name, ward_type)
  SELECT DISTINCT ON (s.bed) s.bed, s.ward_type
  FROM tmp_sync_admissions_staging s
  WHERE s.bed IS NOT NULL
  ON CONFLICT (name) DO UPDATE 
  SET ward_type = COALESCE(EXCLUDED.ward_type, rooms.ward_type);

  -- Resolve Room IDs
  UPDATE tmp_sync_admissions_staging s
  SET room_id = r.id
  FROM public.rooms r
  WHERE r.name = s.bed;

  -- 4. Batch Upsert Staff
  INSERT INTO public.staff (name, role)
  SELECT DISTINCT ON (s.physician_name) s.physician_name, s.specialty
  FROM tmp_sync_admissions_staging s
  WHERE s.physician_name IS NOT NULL
  ON CONFLICT (name) DO UPDATE 
  SET role = CASE WHEN EXCLUDED.role != 'Physician' THEN EXCLUDED.role ELSE staff.role END;

  -- Resolve Staff IDs
  UPDATE tmp_sync_admissions_staging s
  SET physician_id = st.id
  FROM public.staff st
  WHERE st.name = s.physician_name;

  -- 5. Atomic Upsert Admissions using uq_admissions_active_patient partial unique index
  INSERT INTO public.admissions (
    patient_id, room_id, physician_id, contractor_name, financial_status,
    total_invoice, remaining_debt, admission_date, notes, status, source, updated_at
  )
  SELECT DISTINCT ON (s.patient_id)
    s.patient_id, s.room_id, s.physician_id, s.contractor_name, s.financial_status,
    s.total_invoice, s.remaining_debt, s.admission_date, s.notes, 'Admitted', s.source, NOW()
  FROM tmp_sync_admissions_staging s
  WHERE s.patient_id IS NOT NULL
  ON CONFLICT (patient_id) WHERE status = 'Admitted'
  DO UPDATE SET
    room_id = EXCLUDED.room_id,
    physician_id = COALESCE(EXCLUDED.physician_id, admissions.physician_id),
    contractor_name = COALESCE(EXCLUDED.contractor_name, admissions.contractor_name),
    financial_status = COALESCE(EXCLUDED.financial_status, admissions.financial_status),
    source = EXCLUDED.source,
    total_invoice = CASE WHEN EXCLUDED.total_invoice > 0 THEN EXCLUDED.total_invoice ELSE admissions.total_invoice END,
    remaining_debt = CASE WHEN EXCLUDED.remaining_debt > 0 THEN EXCLUDED.remaining_debt ELSE admissions.remaining_debt END,
    notes = COALESCE(EXCLUDED.notes, admissions.notes),
    updated_at = NOW();

  -- 6. Auto-Discharge: Only active PowerBI-sourced admissions not in this sync are marked Discharged
  -- Manual uploads (source = 'manual') are preserved from auto-discharge
  SELECT array_agg(a.id) INTO v_active_admission_ids
  FROM public.admissions a
  JOIN tmp_sync_admissions_staging s ON s.patient_id = a.patient_id
  WHERE a.status = 'Admitted';

  IF v_active_admission_ids IS NOT NULL AND array_length(v_active_admission_ids, 1) > 0 THEN
    UPDATE public.admissions 
    SET status = 'Discharged', discharge_date = NOW(), updated_at = NOW()
    WHERE status = 'Admitted' 
      AND (source IS NULL OR source = 'powerbi')
      AND NOT (id = ANY(v_active_admission_ids));
  END IF;
END;
$$;
