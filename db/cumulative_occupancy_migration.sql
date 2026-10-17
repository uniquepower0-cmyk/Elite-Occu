-- ==============================================================================
-- CUMULATIVE OCCUPANCY & OR UTILIZATION RELATIONAL TABLES & RLS
-- ==============================================================================
-- Idempotent migration script for Supabase.
-- Creates daily census and write-once monthly summaries for:
-- 1. Hospital Bed Occupancy (Inpatient & Total)
-- 2. Operating Rooms (Time Utilization & Room Utilization)
-- ==============================================================================

-- 1. Hospital Daily Census
CREATE TABLE IF NOT EXISTS public.occupancy_daily_census (
  census_date        DATE PRIMARY KEY,
  inpatient_occupied INT  NOT NULL CHECK (inpatient_occupied >= 0),
  inpatient_capacity INT  NOT NULL CHECK (inpatient_capacity > 0),
  total_occupied     INT  NOT NULL CHECK (total_occupied >= 0),
  total_capacity     INT  NOT NULL CHECK (total_capacity > 0),
  zone_breakdown     JSONB NOT NULL DEFAULT '[]'::jsonb,
  source             TEXT NOT NULL DEFAULT 'rollover'
                     CHECK (source IN ('rollover', 'backfill', 'manual')),
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Hospital Monthly Summary (Locked & Finalized)
CREATE TABLE IF NOT EXISTS public.occupancy_monthly_summary (
  month                  DATE PRIMARY KEY CHECK (EXTRACT(DAY FROM month) = 1),
  days_in_month          INT NOT NULL,
  days_recorded          INT NOT NULL,
  missing_days           DATE[] NOT NULL DEFAULT '{}',
  inpatient_patient_days INT NOT NULL,
  inpatient_bed_days     INT NOT NULL,
  inpatient_rate         NUMERIC(5,2) NOT NULL,
  total_patient_days     INT NOT NULL,
  total_bed_days         INT NOT NULL,
  total_rate             NUMERIC(5,2) NOT NULL,
  finalized_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Operating Room Daily Census
CREATE TABLE IF NOT EXISTS public.or_daily_census (
  census_date        DATE PRIMARY KEY,
  rooms_available    INT NOT NULL DEFAULT 7    CHECK (rooms_available > 0),
  minutes_per_room   INT NOT NULL DEFAULT 1440 CHECK (minutes_per_room BETWEEN 1 AND 1440),
  booked_minutes     INT NOT NULL CHECK (booked_minutes >= 0),
  rooms_used         INT NOT NULL CHECK (rooms_used >= 0),
  cases_total        INT NOT NULL DEFAULT 0,
  dc_count           INT NOT NULL DEFAULT 0,
  hc_count           INT NOT NULL DEFAULT 0,
  in_count           INT NOT NULL DEFAULT 0,
  out_count          INT NOT NULL DEFAULT 0,
  sicu_count         INT NOT NULL DEFAULT 0,
  excluded_cases     INT NOT NULL DEFAULT 0,
  room_breakdown     JSONB NOT NULL DEFAULT '{}'::jsonb,
  source             TEXT NOT NULL DEFAULT 'rollover'
                     CHECK (source IN ('rollover', 'backfill', 'manual')),
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_or_booked_minutes_cap CHECK (booked_minutes <= rooms_available * minutes_per_room),
  CONSTRAINT chk_or_rooms_used_cap CHECK (rooms_used <= rooms_available)
);

-- 4. Operating Room Monthly Summary (Locked & Finalized)
CREATE TABLE IF NOT EXISTS public.or_monthly_summary (
  month               DATE PRIMARY KEY CHECK (EXTRACT(DAY FROM month) = 1),
  days_in_month       INT NOT NULL,
  days_recorded       INT NOT NULL,
  booked_minutes      BIGINT NOT NULL,
  available_minutes   BIGINT NOT NULL,
  time_utilization    NUMERIC(5,2) NOT NULL,
  room_days_used      INT NOT NULL,
  room_days_available INT NOT NULL,
  room_utilization    NUMERIC(5,2) NOT NULL,
  cases_total         INT NOT NULL,
  dc_count            INT NOT NULL,
  hc_count            INT NOT NULL,
  in_count            INT NOT NULL,
  out_count           INT NOT NULL,
  sicu_count          INT NOT NULL,
  finalized_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- 5. Indexes for fast analytics and time-series ordering
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_occupancy_daily_census_date ON public.occupancy_daily_census(census_date DESC);
CREATE INDEX IF NOT EXISTS idx_or_daily_census_date ON public.or_daily_census(census_date DESC);

-- ==============================================================================
-- 6. Row Level Security (RLS) & Permissions
-- ==============================================================================
ALTER TABLE public.occupancy_daily_census    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.occupancy_monthly_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.or_daily_census           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.or_monthly_summary        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.occupancy_daily_census FROM anon;
REVOKE ALL ON public.occupancy_monthly_summary FROM anon;
REVOKE ALL ON public.or_daily_census FROM anon;
REVOKE ALL ON public.or_monthly_summary FROM anon;

GRANT SELECT ON public.occupancy_daily_census TO authenticated;
GRANT SELECT ON public.occupancy_monthly_summary TO authenticated;
GRANT SELECT ON public.or_daily_census TO authenticated;
GRANT SELECT ON public.or_monthly_summary TO authenticated;

-- Policies for Authenticated Clinical / Management Users
DROP POLICY IF EXISTS "Allow authenticated read occupancy_daily_census" ON public.occupancy_daily_census;
CREATE POLICY "Allow authenticated read occupancy_daily_census" 
ON public.occupancy_daily_census FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated read occupancy_monthly_summary" ON public.occupancy_monthly_summary;
CREATE POLICY "Allow authenticated read occupancy_monthly_summary" 
ON public.occupancy_monthly_summary FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated read or_daily_census" ON public.or_daily_census;
CREATE POLICY "Allow authenticated read or_daily_census" 
ON public.or_daily_census FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated read or_monthly_summary" ON public.or_monthly_summary;
CREATE POLICY "Allow authenticated read or_monthly_summary" 
ON public.or_monthly_summary FOR SELECT TO authenticated USING (true);

-- Ensure daily census tables are not in supabase_realtime to avoid WAL broadcast overhead
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.occupancy_daily_census;
EXCEPTION WHEN others THEN null;
END $$;
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.or_daily_census;
EXCEPTION WHEN others THEN null;
END $$;
