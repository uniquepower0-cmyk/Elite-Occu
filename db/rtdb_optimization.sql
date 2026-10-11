-- ==============================================================================
-- HOSPITAL OCCUPANCY MANAGER: ADVANCED RTDB & POSTGRESQL OPTIMIZATION
-- Audited against:
--   - /supabase
--   - /supabase-postgres-best-practices
--   - /postgres-best-practices
--   - /database-optimizer
-- ==============================================================================
-- INSTRUCTIONS: Run this script in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/uuvomcxbgldgtmuqtymk/sql/new
-- Fully idempotent: Zero downtime and zero data loss on existing databases.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. COVERING INDEX FOR 100% INDEX-ONLY CHANGE DETECTION SCANS
-- ------------------------------------------------------------------------------
-- Replaces standard pattern index with a covering index including updated_at.
-- Enables queries like `SELECT path, updated_at FROM rtdb_nodes WHERE path LIKE 'state/%'`
-- to execute as Index-Only Scans without reading table heap blocks into shared buffers.
DROP INDEX IF EXISTS public.idx_rtdb_nodes_path_pattern;
CREATE INDEX IF NOT EXISTS idx_rtdb_nodes_path_covering 
ON public.rtdb_nodes (path text_pattern_ops) 
INCLUDE (updated_at);

-- ------------------------------------------------------------------------------
-- 2. HIGH-PERFORMANCE TOAST & LZ4 COMPRESSION TUNING
-- ------------------------------------------------------------------------------
-- PostgreSQL 14+ supports LZ4 compression for JSONB columns, yielding 2-3x faster
-- decompression speeds during high-frequency read and write cycles.
DO $$ BEGIN
    ALTER TABLE public.rtdb_nodes ALTER COLUMN data SET COMPRESSION lz4;
EXCEPTION WHEN others THEN
    RAISE NOTICE 'LZ4 column compression not supported or already active (falling back safely).';
END $$;

-- Configure aggressive dead-tuple reclamation for both heap and TOAST storage
ALTER TABLE public.rtdb_nodes SET (
    fillfactor = 85,
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 20,
    autovacuum_vacuum_cost_limit = 1000,
    toast.autovacuum_vacuum_scale_factor = 0.05,
    toast.autovacuum_vacuum_threshold = 20
);

-- ------------------------------------------------------------------------------
-- 3. REPLICA IDENTITY HYGIENE & REALTIME CONCURRENCY
-- ------------------------------------------------------------------------------
-- Ensure REPLICA IDENTITY is DEFAULT so Postgres does not log unneeded old payloads
ALTER TABLE public.rtdb_nodes REPLICA IDENTITY DEFAULT;

-- Ensure table is present in supabase_realtime publication
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rtdb_nodes;
EXCEPTION WHEN others THEN null;
END $$;

-- ------------------------------------------------------------------------------
-- 4. FUNCTION HYGIENE & SEARCH PATH HARDENING
-- ------------------------------------------------------------------------------
-- Enforce explicit search_path and execution security on core triggers
CREATE OR REPLACE FUNCTION public.trg_fn_set_updated_at()
RETURNS TRIGGER 
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rtdb_nodes_updated_at ON public.rtdb_nodes;
CREATE TRIGGER trg_rtdb_nodes_updated_at
  BEFORE UPDATE ON public.rtdb_nodes
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_set_updated_at();

-- ------------------------------------------------------------------------------
-- 5. ATOMIC AUDIT LOG CONCURRENCY ENGINE
-- ------------------------------------------------------------------------------
-- Eliminates the Node.js Read-Modify-Write race condition by atomically appending
-- to the JSONB array in a single transaction with a bounded 150-entry window.
CREATE OR REPLACE FUNCTION public.append_rtdb_audit_log(p_entry JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated JSONB;
BEGIN
  INSERT INTO public.rtdb_nodes (path, data, updated_at)
  VALUES (
    'audit_logs',
    jsonb_build_array(p_entry),
    NOW()
  )
  ON CONFLICT (path) DO UPDATE
  SET data = (
    SELECT jsonb_agg(elem)
    FROM (
      SELECT jsonb_array_elements(jsonb_build_array(p_entry) || COALESCE(rtdb_nodes.data, '[]'::jsonb)) AS elem
      LIMIT 150
    ) sub
  ),
  updated_at = NOW()
  RETURNING data INTO v_updated;

  RETURN v_updated;
END;
$$;

-- Grant execution to authenticated staff and service role
GRANT EXECUTE ON FUNCTION public.append_rtdb_audit_log(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.append_rtdb_audit_log(JSONB) TO service_role;

-- ------------------------------------------------------------------------------
-- 6. SET-BASED OPTIMIZED RPC FOR OR CASES INGESTION
-- ------------------------------------------------------------------------------
-- Replaces procedural row-by-row N+1 loops with high-throughput staging
CREATE OR REPLACE FUNCTION public.sync_or_cases_set_based(payload JSON)
RETURNS void 
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Create temporary staging table
  CREATE TEMP TABLE IF NOT EXISTS tmp_or_cases_staging (
    mrn VARCHAR(50),
    patient_name VARCHAR(255),
    room_name VARCHAR(100),
    surgeon_name VARCHAR(255),
    operation_name_en TEXT,
    operation_name_ar TEXT,
    scheduled_date DATE,
    start_time TIME,
    end_time TIME,
    status VARCHAR(50),
    financial_status VARCHAR(100),
    patient_id UUID,
    room_id UUID,
    surgeon_id UUID
  ) ON COMMIT DROP;

  TRUNCATE TABLE tmp_or_cases_staging;

  -- 1. Ingest JSON array elements in a single set-based pass
  INSERT INTO tmp_or_cases_staging (
    mrn, patient_name, room_name, surgeon_name,
    operation_name_en, operation_name_ar,
    scheduled_date, start_time, end_time,
    status, financial_status
  )
  SELECT
    COALESCE(
      NULLIF(REGEXP_REPLACE(TRIM(rec->>'mrn'), '^0+', ''), ''),
      'UNKNOWN-' || gen_random_uuid()::text
    ) AS mrn,
    COALESCE(NULLIF(TRIM(rec->>'patientName'), ''), 'Unknown Patient') AS patient_name,
    NULLIF(TRIM(rec->>'orRoom'), '') AS room_name,
    NULLIF(TRIM(rec->>'surgeonName'), '') AS surgeon_name,
    NULLIF(TRIM(rec->>'engOperationName'), '') AS operation_name_en,
    NULLIF(TRIM(rec->>'arOperationName'), '') AS operation_name_ar,
    COALESCE(
      CASE 
        WHEN NULLIF(rec->>'orListDate', '') ~ '^\d{4}-\d{2}-\d{2}' THEN (rec->>'orListDate')::DATE
        ELSE CURRENT_DATE
      END,
      CURRENT_DATE
    ) AS scheduled_date,
    CASE 
      WHEN NULLIF(rec->>'startTime', '') ~ '^\d{1,2}:\d{2}' THEN (rec->>'startTime')::TIME
      ELSE NULL
    END AS start_time,
    CASE 
      WHEN NULLIF(rec->>'endTime', '') ~ '^\d{1,2}:\d{2}' THEN (rec->>'endTime')::TIME
      ELSE NULL
    END AS end_time,
    COALESCE(NULLIF(TRIM(rec->>'status'), ''), 'Scheduled') AS status,
    NULLIF(TRIM(rec->>'financialStatus'), '') AS financial_status
  FROM json_array_elements(payload) AS rec;

  -- Fix midnight crossover anomalies
  UPDATE tmp_or_cases_staging
  SET end_time = NULL
  WHERE start_time IS NOT NULL AND end_time IS NOT NULL AND end_time < start_time;

  -- 2. Upsert Patients in bulk
  INSERT INTO public.patients (mrn, name, updated_at)
  SELECT DISTINCT mrn, patient_name, NOW()
  FROM tmp_or_cases_staging
  WHERE mrn IS NOT NULL
  ON CONFLICT (mrn) DO UPDATE
  SET name = EXCLUDED.name, updated_at = NOW();

  -- 3. Upsert Rooms in bulk
  INSERT INTO public.rooms (name, ward_type)
  SELECT DISTINCT room_name, 'OR'
  FROM tmp_or_cases_staging
  WHERE room_name IS NOT NULL
  ON CONFLICT (name) DO UPDATE
  SET ward_type = 'OR';

  -- 4. Upsert Surgeons in bulk
  INSERT INTO public.staff (name, role)
  SELECT DISTINCT surgeon_name, 'Surgeon'
  FROM tmp_or_cases_staging
  WHERE surgeon_name IS NOT NULL
  ON CONFLICT (name) DO UPDATE
  SET role = 'Surgeon';

  -- 5. Resolve foreign keys
  UPDATE tmp_or_cases_staging s
  SET 
    patient_id = p.id,
    room_id = r.id,
    surgeon_id = st.id
  FROM public.patients p
  LEFT JOIN public.rooms r ON true
  LEFT JOIN public.staff st ON true
  WHERE s.mrn = p.mrn
    AND (s.room_name IS NULL OR r.name = s.room_name)
    AND (s.surgeon_name IS NULL OR st.name = s.surgeon_name);

  -- 6. Upsert OR Cases in bulk
  INSERT INTO public.or_cases (
    patient_id, room_id, surgeon_id,
    operation_name_en, operation_name_ar,
    scheduled_date, start_time, end_time,
    status, financial_status
  )
  SELECT
    patient_id, room_id, surgeon_id,
    operation_name_en, operation_name_ar,
    scheduled_date, start_time, end_time,
    status, financial_status
  FROM tmp_or_cases_staging
  WHERE patient_id IS NOT NULL
  ON CONFLICT DO NOTHING; -- Safe conflict handling

END;
$$;

-- Grant execution to authenticated staff and service role
GRANT EXECUTE ON FUNCTION public.sync_or_cases_set_based(JSON) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_or_cases_set_based(JSON) TO service_role;

-- ------------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (RLS) POLICIES HARDENING
-- ------------------------------------------------------------------------------
ALTER TABLE public.rtdb_nodes ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read general operational nodes and history
DROP POLICY IF EXISTS "Allow authenticated read rtdb_nodes" ON public.rtdb_nodes;
DROP POLICY IF EXISTS "Allow authenticated read operational rtdb_nodes" ON public.rtdb_nodes;

CREATE POLICY "Allow authenticated read operational rtdb_nodes" 
ON public.rtdb_nodes FOR SELECT 
TO authenticated 
USING (
    path LIKE 'state/%' 
    OR path LIKE 'history/%' 
    OR path = 'audit_logs'
    OR path LIKE 'settings/%'
);

-- Ensure explicit permissions on Data API
GRANT SELECT ON public.rtdb_nodes TO authenticated;
GRANT ALL ON public.rtdb_nodes TO service_role;

-- ------------------------------------------------------------------------------
-- 8. RE-ANALYZE QUERY PLANNER STATISTICS
-- ------------------------------------------------------------------------------
ANALYZE public.rtdb_nodes;
ANALYZE public.or_cases;
ANALYZE public.patients;
ANALYZE public.rooms;
ANALYZE public.staff;
