-- ==============================================================================
-- RPC: sync_or_cases_for_date (V3 - Replace-per-date Reconciliation)
-- ==============================================================================
-- Reconciles a single scheduled_date in public.or_cases:
--   1. Upserts active/present cases (using deterministic MD5 MRN when missing)
--   2. Matches by (patient_id, scheduled_date, start_time)
--   3. Deletes any existing or_cases rows for p_date absent from payload
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.sync_or_cases_for_date(
  p_date DATE,
  payload JSON
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  rec JSON;
  p_id UUID;
  r_id UUID;
  s_id UUID;
  v_case_id UUID;
  v_mrn VARCHAR(50);
  v_clean_name TEXT;
  v_date DATE := COALESCE(p_date, CURRENT_DATE);
  v_start_time TIME;
  v_end_time TIME;
  v_seen_ids UUID[] := ARRAY[]::UUID[];
  v_deleted_count INT := 0;
BEGIN
  IF payload IS NOT NULL AND json_typeof(payload) = 'array' THEN
    FOR rec IN SELECT * FROM json_array_elements(payload)
    LOOP
      v_clean_name := COALESCE(NULLIF(regexp_replace(TRIM(COALESCE(rec->>'patientName', '')), '\s+', ' ', 'g'), ''), 'Unknown Patient');

      -- 1. Deterministic MRN (prevents duplicate patients & or_cases rows on re-sync)
      v_mrn := NULLIF(REGEXP_REPLACE(TRIM(COALESCE(rec->>'mrn', '')), '^0+', ''), '');
      IF v_mrn IS NULL OR LOWER(v_mrn) IN ('none', 'nan', 'null') THEN
        v_mrn := 'UNKNOWN-' || SUBSTRING(MD5(LOWER(v_clean_name)) FOR 16);
      END IF;

      -- Upsert Patient
      INSERT INTO public.patients (mrn, name, updated_at)
      VALUES (v_mrn, v_clean_name, NOW())
      ON CONFLICT (mrn) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
      RETURNING id INTO p_id;

      -- 2. Upsert Room (Operating Theatre)
      IF rec->>'orRoom' IS NOT NULL AND TRIM(rec->>'orRoom') != '' AND LOWER(TRIM(rec->>'orRoom')) != 'none' THEN
        INSERT INTO public.rooms (name, ward_type)
        VALUES (TRIM(rec->>'orRoom'), 'OR')
        ON CONFLICT (name) DO UPDATE SET ward_type = 'OR'
        RETURNING id INTO r_id;
      ELSE
        r_id := NULL;
      END IF;

      -- 3. Upsert Surgeon
      IF rec->>'surgeonName' IS NOT NULL AND TRIM(rec->>'surgeonName') != '' AND LOWER(TRIM(rec->>'surgeonName')) != 'none' THEN
        INSERT INTO public.staff (name, role)
        VALUES (TRIM(rec->>'surgeonName'), 'Surgeon')
        ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role
        RETURNING id INTO s_id;
      ELSE
        s_id := NULL;
      END IF;

      -- 4. Parse Times safely
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

      IF v_start_time IS NOT NULL AND v_end_time IS NOT NULL AND v_end_time < v_start_time THEN
        v_end_time := NULL;
      END IF;

      -- 5. Upsert OR Case matched on (patient_id, scheduled_date, start_time)
      UPDATE public.or_cases
      SET
        room_id = r_id,
        surgeon_id = s_id,
        operation_name_en = rec->>'engOperationName',
        operation_name_ar = rec->>'arOperationName',
        start_time = v_start_time,
        end_time = v_end_time,
        status = COALESCE(NULLIF(rec->>'status', ''), 'Scheduled'),
        financial_status = rec->>'financialStatus'
      WHERE patient_id = p_id
        AND scheduled_date = v_date
        AND start_time IS NOT DISTINCT FROM v_start_time
      RETURNING id INTO v_case_id;

      IF v_case_id IS NULL THEN
        INSERT INTO public.or_cases (
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
          v_date,
          COALESCE(NULLIF(rec->>'status', ''), 'Scheduled'),
          rec->>'financialStatus'
        )
        RETURNING id INTO v_case_id;
      END IF;

      v_seen_ids := ARRAY_APPEND(v_seen_ids, v_case_id);
    END LOOP;
  END IF;

  -- 6. Remove cancelled/deleted cases for v_date that were absent from this sync batch
  DELETE FROM public.or_cases
  WHERE scheduled_date = v_date
    AND NOT (id = ANY(v_seen_ids));
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'date', v_date,
    'upsertedCount', CARDINALITY(v_seen_ids),
    'deletedCount', v_deleted_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_or_cases_for_date(DATE, JSON) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_or_cases_for_date(DATE, JSON) TO service_role;
