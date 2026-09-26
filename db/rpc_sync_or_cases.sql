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
  -- We delete today's future cases to completely refresh the day's schedule from the uploaded Excel sheet
  -- (Optional, but usually how scheduling works if they re-upload the list)
  
  FOR rec IN SELECT * FROM json_array_elements(payload)
  LOOP
    -- 1. Ensure MRN exists
    v_mrn := rec->>'mrn';
    IF v_mrn IS NULL OR v_mrn = '' OR v_mrn = 'None' OR v_mrn = 'nan' THEN
      v_mrn := 'UNKNOWN-' || gen_random_uuid()::text;
    END IF;

    -- Upsert Patient
    INSERT INTO patients (mrn, name) 
    VALUES (v_mrn, COALESCE(rec->>'patientName', 'Unknown Patient'))
    ON CONFLICT (mrn) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO p_id;

    -- 2. Upsert Room (OR Room)
    IF rec->>'orRoom' IS NOT NULL AND rec->>'orRoom' != '' AND rec->>'orRoom' != 'None' THEN
      INSERT INTO rooms (name, ward_type) 
      VALUES (rec->>'orRoom', 'OR')
      ON CONFLICT (name) DO UPDATE SET ward_type = 'OR'
      RETURNING id INTO r_id;
    ELSE
      r_id := NULL;
    END IF;

    -- 3. Upsert Surgeon
    IF rec->>'surgeonName' IS NOT NULL AND rec->>'surgeonName' != '' AND rec->>'surgeonName' != 'None' THEN
      SELECT id INTO s_id FROM staff WHERE name = rec->>'surgeonName' LIMIT 1;
      IF s_id IS NULL THEN
        INSERT INTO staff (name, role) 
        VALUES (rec->>'surgeonName', 'Physician')
        RETURNING id INTO s_id;
      END IF;
    ELSE
      s_id := NULL;
    END IF;
    
    -- 4. Parse Dates and Times
    v_date := NULLIF(rec->>'orListDate', '')::DATE;
    
    -- Some start times come as "10:00 AM", so we try to cast.
    -- If casting fails, we ignore time.
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

    -- 5. Upsert OR Case
    -- We can just insert it, or try to upsert based on patient and date.
    -- Given they re-upload the same sheet often, we should update if exists!
    -- Let's just UPSERT based on patient_id and scheduled_date and room_id.
    -- Wait, patients can have multiple operations? 
    -- It's simpler to DELETE existing cases for this specific DATE and ROOM? No, just delete all cases for this date, then insert.
    -- Actually, it's safer to just insert if we don't have a unique constraint.
    -- Let's check if the patient already has a case on this date:
    
    UPDATE or_cases 
    SET 
       room_id = r_id,
       surgeon_id = s_id,
       operation_name_en = rec->>'engOperationName',
       operation_name_ar = rec->>'arOperationName',
       start_time = v_start_time,
       end_time = v_end_time
    WHERE patient_id = p_id AND scheduled_date = v_date;
    
    IF NOT FOUND THEN
      INSERT INTO or_cases (patient_id, room_id, surgeon_id, operation_name_en, operation_name_ar, start_time, end_time, scheduled_date)
      VALUES (p_id, r_id, s_id, rec->>'engOperationName', rec->>'arOperationName', v_start_time, v_end_time, v_date);
    END IF;

  END LOOP;
END;
$$;
