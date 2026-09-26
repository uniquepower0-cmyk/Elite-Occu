-- 1. Create the RPC Function
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
BEGIN
  FOR rec IN SELECT * FROM json_array_elements(payload)
  LOOP
    -- 1. Ensure MRN exists (fallback to generating one if PowerBI missing)
    v_mrn := rec->>'MRN';
    IF v_mrn IS NULL OR v_mrn = '' OR v_mrn = 'None' OR v_mrn = 'nan' THEN
      v_mrn := 'UNKNOWN-' || gen_random_uuid()::text;
    END IF;

    -- Upsert Patient with demographic data
    INSERT INTO patients (mrn, name, gender, mobile, financial_status, blood_type) 
    VALUES (
      v_mrn, 
      COALESCE(rec->>'Patient', 'Unknown Patient'),
      NULLIF(rec->>'Gender', 'None'),
      NULLIF(rec->>'DefaultMobile', 'None'),
      NULLIF(rec->>'Financial Status', 'None'),
      NULLIF(rec->>'Blood Type', 'None')
    )
    ON CONFLICT (mrn) DO UPDATE SET 
      name = EXCLUDED.name,
      gender = COALESCE(EXCLUDED.gender, patients.gender),
      mobile = COALESCE(EXCLUDED.mobile, patients.mobile),
      financial_status = COALESCE(EXCLUDED.financial_status, patients.financial_status),
      blood_type = COALESCE(EXCLUDED.blood_type, patients.blood_type)
    RETURNING id INTO p_id;

    -- Update birth date separately due to type casting
    IF rec->>'BirthDate' IS NOT NULL AND rec->>'BirthDate' != 'None' AND rec->>'BirthDate' != 'nan' THEN
      BEGIN
        UPDATE patients SET birth_date = (rec->>'BirthDate')::DATE WHERE id = p_id;
      EXCEPTION WHEN OTHERS THEN
      END;
    END IF;

    -- 2. Upsert Room
    IF rec->>'Bed#' IS NOT NULL AND rec->>'Bed#' != '' AND rec->>'Bed#' != 'None' AND rec->>'Bed#' != 'nan' THEN
      INSERT INTO rooms (name, ward_type) 
      VALUES (rec->>'Bed#', rec->>'Floor Name')
      ON CONFLICT (name) DO UPDATE SET ward_type = EXCLUDED.ward_type
      RETURNING id INTO r_id;
    ELSE
      r_id := NULL;
    END IF;

    -- 3. Upsert Physician
    IF rec->>'TreatingPhysicianName' IS NOT NULL AND rec->>'TreatingPhysicianName' != '' AND rec->>'TreatingPhysicianName' != 'None' AND rec->>'TreatingPhysicianName' != 'nan' THEN
      SELECT id INTO s_id FROM staff WHERE name = rec->>'TreatingPhysicianName' LIMIT 1;
      IF s_id IS NULL THEN
        INSERT INTO staff (name, role) 
        VALUES (rec->>'TreatingPhysicianName', 'Physician')
        RETURNING id INTO s_id;
      END IF;
    ELSE
      s_id := NULL;
    END IF;

    -- 4. Upsert Admission
    SELECT id INTO a_id FROM admissions 
    WHERE patient_id = p_id AND status = 'Admitted' LIMIT 1;
    
    IF a_id IS NULL THEN
      INSERT INTO admissions (patient_id, room_id, physician_id, admission_date, status, icd10_code)
      VALUES (p_id, r_id, s_id, COALESCE((rec->>'AdmissionDate')::TIMESTAMPTZ, NOW()), 'Admitted', NULLIF(rec->>'ICD-10 Diagnosis', 'None'))
      RETURNING id INTO a_id;
    ELSE
      UPDATE admissions SET 
        room_id = r_id, 
        physician_id = s_id,
        icd10_code = COALESCE(NULLIF(rec->>'ICD-10 Diagnosis', 'None'), admissions.icd10_code)
      WHERE id = a_id;
    END IF;

    active_admission_ids := array_append(active_admission_ids, a_id);
  END LOOP;

  -- 5. Auto-Discharge
  UPDATE admissions 
  SET status = 'Discharged', discharge_date = NOW()
  WHERE status = 'Admitted' AND id != ALL(active_admission_ids);
END;
$$;
