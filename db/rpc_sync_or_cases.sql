-- ==============================================================================
-- RPC: sync_or_cases (Harmonized V2)
-- ==============================================================================
CREATE OR REPLACE FUNCTION sync_or_cases(payload JSON)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  rec JSON;
  p_id UUID;
  r_id UUID;
  s_id UUID;
  v_mrn VARCHAR(50);
  v_date DATE;
  v_start_time TIME;
  v_end_time TIME;
BEGIN
  FOR rec IN SELECT * FROM json_array_elements(payload)
  LOOP
    -- 1. Ensure MRN exists
    v_mrn := NULLIF(REGEXP_REPLACE(TRIM(COALESCE(rec->>'mrn', '')), '^0+', ''), '');
    IF v_mrn IS NULL OR v_mrn = 'None' OR v_mrn = 'nan' THEN
      v_mrn := 'UNKNOWN-' || gen_random_uuid()::text;
    END IF;

    -- Upsert Patient
    INSERT INTO patients (mrn, name, updated_at) 
    VALUES (v_mrn, COALESCE(NULLIF(TRIM(rec->>'patientName'), ''), 'Unknown Patient'), NOW())
    ON CONFLICT (mrn) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
    RETURNING id INTO p_id;

    -- 2. Upsert Room (Operating Theatre)
    IF rec->>'orRoom' IS NOT NULL AND rec->>'orRoom' != '' AND rec->>'orRoom' != 'None' THEN
      INSERT INTO rooms (name, ward_type) 
      VALUES (TRIM(rec->>'orRoom'), 'OR')
      ON CONFLICT (name) DO UPDATE SET ward_type = 'OR'
      RETURNING id INTO r_id;
    ELSE
      r_id := NULL;
    END IF;

    -- 3. Upsert Surgeon (staff table has UNIQUE constraint on name)
    IF rec->>'surgeonName' IS NOT NULL AND rec->>'surgeonName' != '' AND rec->>'surgeonName' != 'None' THEN
      INSERT INTO staff (name, role)
      VALUES (TRIM(rec->>'surgeonName'), 'Surgeon')
      ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role
      RETURNING id INTO s_id;
    ELSE
      s_id := NULL;
    END IF;
    
    -- 4. Parse Dates and Times safely
    BEGIN
      v_date := NULLIF(rec->>'orListDate', '')::DATE;
    EXCEPTION WHEN others THEN
      v_date := CURRENT_DATE;
    END;
    
    BEGIN
      v_start_time := NULLIF(rec->>'startTime', '')::TIME;
    EXCEPTION WHEN others THEN
      v_start_time := NULL;
    END;

    BEGIN
      v_end_time := NULLIF(rec->>'endTime', '')::TIME;
    EXCEPTION WHEN others THEN
      v_end_time := NULL;
    END;

    -- Guard against chk_or_cases_times violation on midnight crossover (e.g. 23:00 to 01:30)
    IF v_start_time IS NOT NULL AND v_end_time IS NOT NULL AND v_end_time < v_start_time THEN
      v_end_time := NULL;
    END IF;

    -- 5. Upsert OR Case
    UPDATE or_cases 
    SET 
       room_id = r_id,
       surgeon_id = s_id,
       operation_name_en = rec->>'engOperationName',
       operation_name_ar = rec->>'arOperationName',
       start_time = v_start_time,
       end_time = v_end_time,
       status = COALESCE(rec->>'status', 'Scheduled'),
       financial_status = rec->>'financialStatus'
    WHERE patient_id = p_id AND scheduled_date = v_date;
    
    IF NOT FOUND THEN
      INSERT INTO or_cases (
        patient_id, 
        room_id, 
        surgeon_id, 
        operation_name_en, 
        operation_name_ar, 
        start_time, 
        end_time, 
        scheduled_date, 
        status, 
        financial_status
      )
      VALUES (
        p_id, 
        r_id, 
        s_id, 
        rec->>'engOperationName', 
        rec->>'arOperationName', 
        v_start_time, 
        v_end_time, 
        COALESCE(v_date, CURRENT_DATE), 
        COALESCE(rec->>'status', 'Scheduled'), 
        rec->>'financialStatus'
      );
    END IF;

  END LOOP;
END;
$$;
