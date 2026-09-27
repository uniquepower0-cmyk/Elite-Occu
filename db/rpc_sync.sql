-- ==============================================================================
-- RPC: sync_powerbi_admissions (Harmonized V2)
-- ==============================================================================
CREATE OR REPLACE FUNCTION sync_powerbi_admissions(payload JSON)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  rec JSON;
  p_id UUID;
  r_id UUID;
  s_id UUID;
  a_id UUID;
  active_admission_ids UUID[] := '{}';
  v_mrn VARCHAR(50);
  v_admission_date TIMESTAMPTZ;
  v_contractor VARCHAR(255);
  v_financial VARCHAR(100);
BEGIN
  FOR rec IN SELECT * FROM json_array_elements(payload)
  LOOP
    -- 1. Ensure MRN exists (fallback to generating deterministic or random MRN)
    v_mrn := NULLIF(TRIM(rec->>'MRN'), '');
    IF v_mrn IS NULL OR v_mrn = 'None' OR v_mrn = 'nan' THEN
      v_mrn := 'UNKNOWN-' || gen_random_uuid()::text;
    END IF;

    -- Upsert Patient
    INSERT INTO patients (mrn, name, updated_at) 
    VALUES (v_mrn, COALESCE(NULLIF(TRIM(rec->>'Patient'), ''), 'Unknown Patient'), NOW())
    ON CONFLICT (mrn) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
    RETURNING id INTO p_id;

    -- 2. Upsert Room
    IF rec->>'Bed#' IS NOT NULL AND rec->>'Bed#' != '' AND rec->>'Bed#' != 'None' AND rec->>'Bed#' != 'nan' THEN
      INSERT INTO rooms (name, ward_type) 
      VALUES (TRIM(rec->>'Bed#'), NULLIF(TRIM(rec->>'Floor Name'), ''))
      ON CONFLICT (name) DO UPDATE SET ward_type = COALESCE(EXCLUDED.ward_type, rooms.ward_type)
      RETURNING id INTO r_id;
    ELSE
      r_id := NULL;
    END IF;

    -- 3. Upsert Physician (staff table has UNIQUE constraint on name)
    IF rec->>'TreatingPhysicianName' IS NOT NULL AND rec->>'TreatingPhysicianName' != '' AND rec->>'TreatingPhysicianName' != 'None' AND rec->>'TreatingPhysicianName' != 'nan' THEN
      INSERT INTO staff (name, role)
      VALUES (TRIM(rec->>'TreatingPhysicianName'), 'Physician')
      ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role
      RETURNING id INTO s_id;
    ELSE
      s_id := NULL;
    END IF;

    -- 4. Parse Dates & Attributes
    BEGIN
      v_admission_date := NULLIF(rec->>'AdmissionDate', '')::TIMESTAMPTZ;
    EXCEPTION WHEN others THEN
      v_admission_date := NOW();
    END;

    v_contractor := NULLIF(TRIM(rec->>'ContractorName'), '');
    v_financial := NULLIF(TRIM(rec->>'Financial Status'), '');

    -- 5. Upsert Admission
    SELECT id INTO a_id FROM admissions 
    WHERE patient_id = p_id AND status = 'Admitted' LIMIT 1;
    
    IF a_id IS NULL THEN
      INSERT INTO admissions (patient_id, room_id, physician_id, contractor_name, financial_status, admission_date, status)
      VALUES (p_id, r_id, s_id, v_contractor, v_financial, COALESCE(v_admission_date, NOW()), 'Admitted')
      RETURNING id INTO a_id;
    ELSE
      UPDATE admissions 
      SET 
        room_id = r_id, 
        physician_id = COALESCE(s_id, physician_id),
        contractor_name = COALESCE(v_contractor, contractor_name),
        financial_status = COALESCE(v_financial, financial_status),
        updated_at = NOW()
      WHERE id = a_id;
    END IF;

    active_admission_ids := array_append(active_admission_ids, a_id);
  END LOOP;

  -- 6. Auto-Discharge: Any active admission not in this sync is marked Discharged
  IF array_length(active_admission_ids, 1) > 0 THEN
    UPDATE admissions 
    SET status = 'Discharged', discharge_date = NOW(), updated_at = NOW()
    WHERE status = 'Admitted' AND id != ALL(active_admission_ids);
  END IF;
END;
$$;
