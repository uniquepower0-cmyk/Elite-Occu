-- Run this in the Supabase SQL Editor to create the RPC function used by the Python script

CREATE OR REPLACE FUNCTION sync_powerbi_admissions(payload JSON)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  rec JSON;
  p_id UUID;
  r_id UUID;
  s_id UUID;
  a_id UUID;
  active_admission_ids UUID[] := '{}';
BEGIN
  -- Loop through the incoming PowerBI JSON payload
  FOR rec IN SELECT * FROM json_array_elements(payload)
  LOOP
    -- 1. Upsert Patient (Using MRN as the unique identifier)
    IF rec->>'MRN' IS NOT NULL AND rec->>'MRN' != '' THEN
      INSERT INTO patients (mrn, name) 
      VALUES (rec->>'MRN', rec->>'Patient')
      ON CONFLICT (mrn) DO UPDATE SET name = EXCLUDED.name
      RETURNING id INTO p_id;
    ELSE
      -- Skip if no MRN is provided (invalid patient record)
      CONTINUE;
    END IF;

    -- 2. Upsert Room
    IF rec->>'Bed#' IS NOT NULL AND rec->>'Bed#' != '' THEN
      INSERT INTO rooms (name, ward_type) 
      VALUES (rec->>'Bed#', rec->>'Floor Name')
      ON CONFLICT (name) DO UPDATE SET ward_type = EXCLUDED.ward_type
      RETURNING id INTO r_id;
    ELSE
      r_id := NULL;
    END IF;

    -- 3. Find or Create Staff (Treating Physician)
    IF rec->>'TreatingPhysicianName' IS NOT NULL AND rec->>'TreatingPhysicianName' != '' THEN
      SELECT id INTO s_id FROM staff WHERE name = rec->>'TreatingPhysicianName' LIMIT 1;
      
      IF s_id IS NULL THEN
        INSERT INTO staff (name, role) 
        VALUES (rec->>'TreatingPhysicianName', 'Physician')
        RETURNING id INTO s_id;
      END IF;
    ELSE
      s_id := NULL;
    END IF;

    -- 4. Check if patient is already admitted
    SELECT id INTO a_id FROM admissions 
    WHERE patient_id = p_id AND status = 'Admitted' LIMIT 1;
    
    IF a_id IS NULL THEN
      -- Create new admission
      INSERT INTO admissions (patient_id, room_id, physician_id, admission_date, status)
      VALUES (p_id, r_id, s_id, COALESCE((rec->>'AdmissionDate')::TIMESTAMPTZ, NOW()), 'Admitted')
      RETURNING id INTO a_id;
    ELSE
      -- Update existing admission's room and physician if they moved
      UPDATE admissions 
      SET room_id = r_id, physician_id = s_id
      WHERE id = a_id;
    END IF;

    -- Track this admission as active
    active_admission_ids := array_append(active_admission_ids, a_id);
  END LOOP;

  -- 5. Auto-Discharge anyone who is no longer in the PowerBI list!
  -- This eliminates the need for downloading "history" in Python.
  UPDATE admissions 
  SET status = 'Discharged', discharge_date = NOW()
  WHERE status = 'Admitted' 
  AND id != ALL(active_admission_ids);
  
END;
$$;
