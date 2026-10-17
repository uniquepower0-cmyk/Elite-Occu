-- ==============================================================================
-- HOSPITAL OCCUPANCY MANAGER: 30-DAY ROLLING DATA RETENTION MIGRATION
-- Audited against /supabase & PostgreSQL Best Practices
-- ==============================================================================
-- Purpose:
--   Enforces a strict 30-day rolling retention window across:
--     1. public.rtdb_nodes (history/occupancy/*, history/or/*, history/changelog/*,
--        and trims history/occupancy_index, history/or_index, history/changelog_index)
--     2. public.or_cases (scheduled_date older than 30 days / evicted dates)
--     3. public.transfers (transfer_date older than 30 days)
--     4. public.admissions (status != 'Admitted' older than 30 days)
--     5. public.patients (orphaned rows older than 30 days with no remaining links)
--
--   PERMANENTLY PRESERVES (Never Deleted):
--     - Cumulative Occupancy & OR Analytics:
--         * public.occupancy_daily_census
--         * public.occupancy_monthly_summary
--         * public.or_daily_census
--         * public.or_monthly_summary
--     - Permanent VIP Cases Textbox & Settings:
--         * public.rtdb_nodes WHERE path = 'settings/vip_cases' (and all settings/*)
--     - Active Inpatients:
--         * public.admissions WHERE status = 'Admitted'
-- ==============================================================================

-- 1. Supporting Partial Index for Fast Discharged Admissions Cleanup
CREATE INDEX IF NOT EXISTS idx_admissions_discharged_cleanup
ON public.admissions (COALESCE(discharge_date, updated_at, admission_date))
WHERE status != 'Admitted';

-- 2. Core 30-Day Rolling Retention Function
CREATE OR REPLACE FUNCTION public.enforce_30_day_retention(
  p_max_days INT DEFAULT 30,
  p_reference_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_effective_max_days INT := GREATEST(1, COALESCE(p_max_days, 30));
  v_ref_date DATE := COALESCE(p_reference_date, CURRENT_DATE);
  v_cutoff_date DATE := v_ref_date - (v_effective_max_days - 1);
  v_cutoff_ts TIMESTAMPTZ := (v_cutoff_date::TEXT || 'T00:00:00Z')::TIMESTAMPTZ;
  v_kept_occ_dates TEXT[];
  v_kept_or_dates TEXT[];
  v_kept_cl_dates TEXT[];
  v_deleted_rtdb INT := 0;
  v_deleted_or_cases INT := 0;
  v_deleted_transfers INT := 0;
  v_deleted_admissions INT := 0;
  v_deleted_patients INT := 0;
  v_cnt INT := 0;
BEGIN
  -- ----------------------------------------------------------------------------
  -- A. Determine Top N (30) Kept Occupancy Dates (>= v_cutoff_date)
  -- ----------------------------------------------------------------------------
  SELECT COALESCE(ARRAY_AGG(d ORDER BY d DESC), ARRAY[]::TEXT[])
  INTO v_kept_occ_dates
  FROM (
    SELECT DISTINCT d
    FROM (
      -- Dates from history/occupancy/{YYYY-MM-DD}% paths
      SELECT (regexp_match(path, '^history/occupancy/(\d{4}-\d{2}-\d{2})'))[1] AS d
      FROM public.rtdb_nodes
      WHERE path LIKE 'history/occupancy/%'
      UNION
      -- Dates from history/occupancy_index JSONB array
      SELECT COALESCE(elem->>'date', TRIM(BOTH '"' FROM elem::TEXT)) AS d
      FROM public.rtdb_nodes n,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(n.data) = 'array' THEN n.data ELSE '[]'::jsonb END
           ) AS elem
      WHERE n.path = 'history/occupancy_index'
    ) raw_dates
    WHERE d IS NOT NULL
      AND d ~ '^\d{4}-\d{2}-\d{2}$'
      AND d::DATE >= v_cutoff_date
    ORDER BY d DESC
    LIMIT v_effective_max_days
  ) kept;

  -- Delete Occupancy RTDB history nodes not in v_kept_occ_dates
  DELETE FROM public.rtdb_nodes
  WHERE path LIKE 'history/occupancy/%'
    AND (
      (regexp_match(path, '^history/occupancy/(\d{4}-\d{2}-\d{2})'))[1] IS NULL
      OR NOT ((regexp_match(path, '^history/occupancy/(\d{4}-\d{2}-\d{2})'))[1] = ANY(v_kept_occ_dates))
    );
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  v_deleted_rtdb := v_deleted_rtdb + v_cnt;

  -- Trim history/occupancy_index to only kept dates (max 30)
  UPDATE public.rtdb_nodes n
  SET data = COALESCE(
    (
      SELECT jsonb_agg(elem)
      FROM (
        SELECT elem
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(n.data) = 'array' THEN n.data ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(elem, ord)
        WHERE COALESCE(elem->>'date', TRIM(BOTH '"' FROM elem::TEXT)) = ANY(v_kept_occ_dates)
        ORDER BY COALESCE(elem->>'date', TRIM(BOTH '"' FROM elem::TEXT)) DESC, ord ASC
        LIMIT v_effective_max_days
      ) sub
    ),
    '[]'::jsonb
  ),
  updated_at = NOW()
  WHERE n.path = 'history/occupancy_index'
    AND jsonb_typeof(n.data) = 'array';

  -- ----------------------------------------------------------------------------
  -- B. Determine Top N (30) Kept OR Dates (>= v_cutoff_date)
  -- ----------------------------------------------------------------------------
  SELECT COALESCE(ARRAY_AGG(d ORDER BY d DESC), ARRAY[]::TEXT[])
  INTO v_kept_or_dates
  FROM (
    SELECT DISTINCT d
    FROM (
      SELECT (regexp_match(path, '^history/or/(\d{4}-\d{2}-\d{2})'))[1] AS d
      FROM public.rtdb_nodes
      WHERE path LIKE 'history/or/%'
      UNION
      SELECT COALESCE(elem->>'date', TRIM(BOTH '"' FROM elem::TEXT)) AS d
      FROM public.rtdb_nodes n,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(n.data) = 'array' THEN n.data ELSE '[]'::jsonb END
           ) AS elem
      WHERE n.path = 'history/or_index'
    ) raw_dates
    WHERE d IS NOT NULL
      AND d ~ '^\d{4}-\d{2}-\d{2}$'
      AND d::DATE >= v_cutoff_date
    ORDER BY d DESC
    LIMIT v_effective_max_days
  ) kept;

  -- Delete OR RTDB history nodes not in v_kept_or_dates
  DELETE FROM public.rtdb_nodes
  WHERE path LIKE 'history/or/%'
    AND (
      (regexp_match(path, '^history/or/(\d{4}-\d{2}-\d{2})'))[1] IS NULL
      OR NOT ((regexp_match(path, '^history/or/(\d{4}-\d{2}-\d{2})'))[1] = ANY(v_kept_or_dates))
    );
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  v_deleted_rtdb := v_deleted_rtdb + v_cnt;

  -- Trim history/or_index to only kept dates (max 30)
  UPDATE public.rtdb_nodes n
  SET data = COALESCE(
    (
      SELECT jsonb_agg(elem)
      FROM (
        SELECT elem
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(n.data) = 'array' THEN n.data ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS t(elem, ord)
        WHERE COALESCE(elem->>'date', TRIM(BOTH '"' FROM elem::TEXT)) = ANY(v_kept_or_dates)
        ORDER BY COALESCE(elem->>'date', TRIM(BOTH '"' FROM elem::TEXT)) DESC, ord ASC
        LIMIT v_effective_max_days
      ) sub
    ),
    '[]'::jsonb
  ),
  updated_at = NOW()
  WHERE n.path = 'history/or_index'
    AND jsonb_typeof(n.data) = 'array';

  -- ----------------------------------------------------------------------------
  -- C. Determine Top N (30) Kept ChangeLog Dates (>= v_cutoff_date)
  -- ----------------------------------------------------------------------------
  SELECT COALESCE(ARRAY_AGG(d ORDER BY d DESC), ARRAY[]::TEXT[])
  INTO v_kept_cl_dates
  FROM (
    SELECT DISTINCT d
    FROM (
      SELECT (regexp_match(path, '^history/changelog/(\d{4}-\d{2}-\d{2})'))[1] AS d
      FROM public.rtdb_nodes
      WHERE path LIKE 'history/changelog/%'
      UNION
      SELECT TRIM(BOTH '"' FROM elem::TEXT) AS d
      FROM public.rtdb_nodes n,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(n.data) = 'array' THEN n.data ELSE '[]'::jsonb END
           ) AS elem
      WHERE n.path = 'history/changelog_index'
    ) raw_dates
    WHERE d IS NOT NULL
      AND d ~ '^\d{4}-\d{2}-\d{2}$'
      AND d::DATE >= v_cutoff_date
    ORDER BY d DESC
    LIMIT v_effective_max_days
  ) kept;

  -- Delete ChangeLog RTDB nodes not in v_kept_cl_dates
  DELETE FROM public.rtdb_nodes
  WHERE path LIKE 'history/changelog/%'
    AND (
      (regexp_match(path, '^history/changelog/(\d{4}-\d{2}-\d{2})'))[1] IS NULL
      OR NOT ((regexp_match(path, '^history/changelog/(\d{4}-\d{2}-\d{2})'))[1] = ANY(v_kept_cl_dates))
    );
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  v_deleted_rtdb := v_deleted_rtdb + v_cnt;

  -- Trim history/changelog_index to only kept dates (max 30)
  UPDATE public.rtdb_nodes n
  SET data = COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(d))
      FROM unnest(v_kept_cl_dates) AS d
    ),
    '[]'::jsonb
  ),
  updated_at = NOW()
  WHERE n.path = 'history/changelog_index';

  -- ----------------------------------------------------------------------------
  -- D. Prune Relational Tables (> 30 days)
  --    NOTE: occupancy_daily_census, occupancy_monthly_summary,
  --          or_daily_census, or_monthly_summary, and settings/vip_cases
  --          are NEVER touched.
  -- ----------------------------------------------------------------------------

  -- 1. Delete OR cases older than cutoff date (or evicted from OR history)
  DELETE FROM public.or_cases
  WHERE scheduled_date < v_cutoff_date
     OR (
       CARDINALITY(v_kept_or_dates) >= v_effective_max_days
       AND NOT (scheduled_date::TEXT = ANY(v_kept_or_dates))
     );
  GET DIAGNOSTICS v_deleted_or_cases = ROW_COUNT;

  -- 2. Delete transfers older than cutoff timestamp
  DELETE FROM public.transfers
  WHERE transfer_date < v_cutoff_ts;
  GET DIAGNOSTICS v_deleted_transfers = ROW_COUNT;

  -- 3. Delete historical non-active admissions older than cutoff timestamp
  --    (Active inpatients with status = 'Admitted' are strictly preserved!)
  DELETE FROM public.admissions
  WHERE status != 'Admitted'
    AND COALESCE(discharge_date, updated_at, admission_date) < v_cutoff_ts;
  GET DIAGNOSTICS v_deleted_admissions = ROW_COUNT;

  -- 4. Clean up orphaned patient records older than cutoff timestamp
  DELETE FROM public.patients p
  WHERE p.updated_at < v_cutoff_ts
    AND NOT EXISTS (SELECT 1 FROM public.admissions a WHERE a.patient_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.transfers t WHERE t.patient_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.or_cases o WHERE o.patient_id = p.id);
  GET DIAGNOSTICS v_deleted_patients = ROW_COUNT;

  RETURN jsonb_build_object(
    'maxDays', v_effective_max_days,
    'referenceDate', v_ref_date,
    'cutoffDate', v_cutoff_date,
    'keptOccupancyDatesCount', CARDINALITY(v_kept_occ_dates),
    'keptOrDatesCount', CARDINALITY(v_kept_or_dates),
    'deletedRtdbNodes', v_deleted_rtdb,
    'deletedOrCases', v_deleted_or_cases,
    'deletedTransfers', v_deleted_transfers,
    'deletedDischargedAdmissions', v_deleted_admissions,
    'deletedOrphanedPatients', v_deleted_patients
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.enforce_30_day_retention(INT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_30_day_retention(INT, DATE) TO service_role;

-- 3. Optional pg_cron daily schedule (runs safely if pg_cron extension is enabled)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'hospital-30-day-retention',
      '5 22 * * *', -- 00:05 Cairo time daily
      $cron$SELECT public.enforce_30_day_retention(30, CURRENT_DATE);$cron$
    );
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_cron not enabled or schedule skipped; application-level retention will enforce the 30-day policy automatically.';
END $$;
