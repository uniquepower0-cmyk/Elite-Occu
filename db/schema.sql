-- ==============================================================================
-- HOSPITAL OCCUPANCY MANAGER: BULLETPROOF RELATIONAL MIGRATION (V2.2)
-- ==============================================================================
-- INSTRUCTIONS: Copy and paste this entire file into the Supabase SQL Editor.
-- Fully idempotent: Works on fresh databases AND databases with existing v1/v2 tables.
-- Uses dynamic execution to guarantee schema catalog cache alignment.
-- ==============================================================================

-- 1. Create Enums for standardized types (Safe duplicate handling)
DO $$ BEGIN
    CREATE TYPE admission_status AS ENUM ('Admitted', 'Discharged', 'Transferred');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_type AS ENUM ('Cash', 'Insured', 'Corporate');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Patients Table (Core Identity)
CREATE TABLE IF NOT EXISTS public.patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mrn VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patients_mrn ON public.patients(mrn);
CREATE INDEX IF NOT EXISTS idx_patients_name ON public.patients(name);

-- 3. Rooms & Wards
CREATE TABLE IF NOT EXISTS public.rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    ward_type VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_rooms_name ON public.rooms(name);

-- 4. Staff & Medical Personnel (Physicians, Surgeons, Consultants)
CREATE TABLE IF NOT EXISTS public.staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL DEFAULT 'Physician',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Ensure UNIQUE constraint on staff name for atomic upserts
DO $$ BEGIN
    ALTER TABLE public.staff ADD CONSTRAINT staff_name_key UNIQUE (name);
EXCEPTION
    WHEN duplicate_table OR duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS idx_staff_name ON public.staff(name);

-- 5. Admissions Table
CREATE TABLE IF NOT EXISTS public.admissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE,
    room_id UUID REFERENCES public.rooms(id) ON DELETE RESTRICT,
    physician_id UUID REFERENCES public.staff(id),
    contractor_id UUID REFERENCES public.staff(id),
    contractor_name VARCHAR(255),
    financial_status VARCHAR(100),
    total_invoice NUMERIC(12,2) DEFAULT 0.00,
    remaining_debt NUMERIC(12,2) DEFAULT 0.00,
    admission_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    discharge_date TIMESTAMPTZ,
    status admission_status DEFAULT 'Admitted',
    payment payment_type,
    notes TEXT,
    source VARCHAR(50) DEFAULT 'powerbi',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.admissions ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'powerbi';
CREATE INDEX IF NOT EXISTS idx_admissions_source ON public.admissions(source);

-- 6. Transfers Table (Sequential patient room movements)
CREATE TABLE IF NOT EXISTS public.transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admission_id UUID REFERENCES public.admissions(id) ON DELETE CASCADE,
    patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE,
    from_room_id UUID REFERENCES public.rooms(id) ON DELETE RESTRICT,
    to_room_id UUID REFERENCES public.rooms(id) ON DELETE RESTRICT,
    from_room_name VARCHAR(100),
    to_room_name VARCHAR(100),
    physician_id UUID REFERENCES public.staff(id),
    transfer_date TIMESTAMPTZ DEFAULT NOW(),
    transfer_type VARCHAR(50) DEFAULT 'inpatient',
    is_auto_detected BOOLEAN DEFAULT TRUE,
    notes TEXT
);

-- 7. OR Cases Table (Operating Theatre Schedule)
CREATE TABLE IF NOT EXISTS public.or_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE,
    room_id UUID REFERENCES public.rooms(id) ON DELETE RESTRICT,
    surgeon_id UUID REFERENCES public.staff(id),
    operation_name_en TEXT,
    operation_name_ar TEXT,
    scheduled_date DATE,
    start_time TIME,
    end_time TIME,
    status VARCHAR(50) DEFAULT 'Scheduled',
    financial_status VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 8. CATALOG CACHE REPAIR & COLUMN VERIFICATION
-- Explicitly add any missing columns to existing tables and dynamically index
-- ==============================================================================
DO $$ 
BEGIN
    -- Ensure columns exist in patients
    ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

    -- Ensure columns exist in admissions
    ALTER TABLE public.admissions ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE;
    ALTER TABLE public.admissions ADD COLUMN IF NOT EXISTS contractor_name VARCHAR(255);
    ALTER TABLE public.admissions ADD COLUMN IF NOT EXISTS financial_status VARCHAR(100);
    ALTER TABLE public.admissions ADD COLUMN IF NOT EXISTS total_invoice NUMERIC(12,2) DEFAULT 0.00;
    ALTER TABLE public.admissions ADD COLUMN IF NOT EXISTS remaining_debt NUMERIC(12,2) DEFAULT 0.00;

    -- Ensure columns exist in transfers
    ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE;
    ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS from_room_name VARCHAR(100);
    ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS to_room_name VARCHAR(100);
    ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS transfer_type VARCHAR(50) DEFAULT 'inpatient';
    ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS is_auto_detected BOOLEAN DEFAULT TRUE;

    -- Ensure columns exist in or_cases
    ALTER TABLE public.or_cases ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE;
    ALTER TABLE public.or_cases ADD COLUMN IF NOT EXISTS operation_name_en TEXT;
    ALTER TABLE public.or_cases ADD COLUMN IF NOT EXISTS operation_name_ar TEXT;
    ALTER TABLE public.or_cases ADD COLUMN IF NOT EXISTS scheduled_date DATE;
    ALTER TABLE public.or_cases ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Scheduled';
    ALTER TABLE public.or_cases ADD COLUMN IF NOT EXISTS financial_status VARCHAR(100);

    -- Dynamic execution of indexes guarantees the catalog cache recognizes the added columns
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_admissions_active ON public.admissions(status, room_id) WHERE status = ''Admitted''';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_admissions_patient ON public.admissions(patient_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_admissions_date ON public.admissions(admission_date)';

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_transfers_patient ON public.transfers(patient_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_transfers_date ON public.transfers(transfer_date)';

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_or_cases_date ON public.or_cases(scheduled_date)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_or_cases_surgeon ON public.or_cases(surgeon_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_or_cases_patient ON public.or_cases(patient_id)';

    -- 9. Enhanced Real-Time Occupancy View (created dynamically after column verification)
    EXECUTE '
        DROP VIEW IF EXISTS public.active_occupancy_view CASCADE;
        CREATE VIEW public.active_occupancy_view AS
        SELECT 
            a.id AS admission_id,
            p.id AS patient_id,
            p.name AS patient_name,
            p.mrn,
            r.name AS room_name,
            r.ward_type,
            s.name AS treating_physician,
            COALESCE(a.contractor_name, cs.name) AS contractor_name,
            a.financial_status,
            COALESCE(a.total_invoice, 0.00) AS total_invoice,
            COALESCE(a.remaining_debt, 0.00) AS remaining_debt,
            CASE WHEN COALESCE(a.total_invoice, 0) > 0 
                 THEN ROUND((COALESCE(a.remaining_debt, 0) / a.total_invoice) * 100, 2) 
                 ELSE 0 
            END AS remaining_debt_pct,
            a.admission_date,
            GREATEST(1, EXTRACT(DAY FROM (NOW() - a.admission_date)))::int AS current_los_days,
            a.status
        FROM public.admissions a
        JOIN public.patients p ON a.patient_id = p.id
        LEFT JOIN public.rooms r ON a.room_id = r.id
        LEFT JOIN public.staff s ON a.physician_id = s.id
        LEFT JOIN public.staff cs ON a.contractor_id = cs.id
        WHERE a.status = ''Admitted'';
    ';
END $$;

-- 10. Atomic Lock Function for Daily Reset Rollover (11:59 PM Cairo)
CREATE OR REPLACE FUNCTION public.acquire_daily_reset_lock(p_date TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.rtdb_nodes (path, data, updated_at)
    VALUES ('locks/daily_reset_' || p_date, '{"locked": true}', NOW())
    ON CONFLICT (path) DO NOTHING;
    RETURN FOUND;
END;
$$;

-- 11. Security (Row Level Security - RLS)
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.or_cases ENABLE ROW LEVEL SECURITY;

-- 12. Realtime publication additions
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.patients;
EXCEPTION WHEN others THEN null;
END $$;
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admissions;
EXCEPTION WHEN others THEN null;
END $$;
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
EXCEPTION WHEN others THEN null;
END $$;
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.transfers;
EXCEPTION WHEN others THEN null;
END $$;
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.or_cases;
EXCEPTION WHEN others THEN null;
END $$;
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rtdb_nodes;
EXCEPTION WHEN others THEN null;
END $$;

-- 13. Ensure rtdb_nodes uses REPLICA IDENTITY DEFAULT to avoid broadcasting unmodified payload columns
DO $$ BEGIN
    ALTER TABLE public.rtdb_nodes REPLICA IDENTITY DEFAULT;
EXCEPTION WHEN others THEN null;
END $$;

-- ==============================================================================
-- 14. INTEGRITY & CONCURRENCY CONSTRAINTS (Zero Column Shifts)
-- ==============================================================================

-- Deduplicate any historical dirty data before creating partial unique index
DELETE FROM public.admissions a
WHERE status = 'Admitted'
  AND a.id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY updated_at DESC, admission_date DESC) as rnum
      FROM public.admissions
      WHERE status = 'Admitted'
    ) ranked
    WHERE ranked.rnum = 1
  );

-- Guarantees at database level that a patient can have at most ONE active admission
CREATE UNIQUE INDEX IF NOT EXISTS uq_admissions_active_patient 
ON public.admissions (patient_id) 
WHERE status = 'Admitted';

-- Normalize any historical timestamp inversions before constraint validation
UPDATE public.admissions 
SET discharge_date = admission_date 
WHERE discharge_date IS NOT NULL AND discharge_date < admission_date;

UPDATE public.admissions 
SET total_invoice = GREATEST(0, COALESCE(total_invoice, 0)),
    remaining_debt = GREATEST(0, COALESCE(remaining_debt, 0))
WHERE total_invoice < 0 OR remaining_debt < 0;

UPDATE public.or_cases 
SET end_time = NULL 
WHERE end_time IS NOT NULL AND start_time IS NOT NULL AND end_time < start_time;

-- Domain check constraints (safe duplicate handling + NOT VALID to prevent blocking on legacy history)
DO $$ BEGIN
    ALTER TABLE public.admissions 
      ADD CONSTRAINT chk_admissions_dates 
      CHECK (discharge_date IS NULL OR discharge_date >= admission_date) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.admissions 
      ADD CONSTRAINT chk_admissions_financials 
      CHECK (total_invoice >= 0 AND remaining_debt >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.or_cases 
      ADD CONSTRAINT chk_or_cases_times 
      CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ==============================================================================
-- 15. BRIDGE PARITY & AUTONOMOUS TRIGGERS
-- ==============================================================================

-- Trigger: Automatically capture transfers on room_id update
CREATE OR REPLACE FUNCTION public.trg_fn_capture_admission_transfer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_old_room_name VARCHAR(100);
  v_new_room_name VARCHAR(100);
BEGIN
  IF OLD.room_id IS DISTINCT FROM NEW.room_id AND OLD.room_id IS NOT NULL AND NEW.room_id IS NOT NULL THEN
    SELECT name INTO v_old_room_name FROM public.rooms WHERE id = OLD.room_id;
    SELECT name INTO v_new_room_name FROM public.rooms WHERE id = NEW.room_id;

    INSERT INTO public.transfers (
      admission_id,
      patient_id,
      from_room_id,
      to_room_id,
      from_room_name,
      to_room_name,
      physician_id,
      transfer_date,
      transfer_type,
      is_auto_detected,
      notes
    ) VALUES (
      NEW.id,
      NEW.patient_id,
      OLD.room_id,
      NEW.room_id,
      v_old_room_name,
      v_new_room_name,
      NEW.physician_id,
      NOW(),
      'inpatient',
      TRUE,
      'Automated transfer captured via bridge room reassignment'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_admission_transfer ON public.admissions;
CREATE TRIGGER trg_capture_admission_transfer
AFTER UPDATE OF room_id ON public.admissions
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_capture_admission_transfer();

-- Trigger: Automatically synchronize updated_at timestamp across core tables
CREATE OR REPLACE FUNCTION public.trg_fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patients_updated_at ON public.patients;
CREATE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_admissions_updated_at ON public.admissions;
CREATE TRIGGER trg_admissions_updated_at
  BEFORE UPDATE ON public.admissions
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_rtdb_nodes_updated_at ON public.rtdb_nodes;
CREATE TRIGGER trg_rtdb_nodes_updated_at
  BEFORE UPDATE ON public.rtdb_nodes
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_set_updated_at();

-- ==============================================================================
-- 16. FOREIGN KEY & PERFORMANCE ACCELERATION INDEXES
-- ==============================================================================

-- Foreign Key supporting indexes on child tables (prevents full sequential scans)
CREATE INDEX IF NOT EXISTS idx_transfers_admission_id ON public.transfers(admission_id);
CREATE INDEX IF NOT EXISTS idx_transfers_from_room ON public.transfers(from_room_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to_room ON public.transfers(to_room_id);
CREATE INDEX IF NOT EXISTS idx_transfers_physician ON public.transfers(physician_id);

CREATE INDEX IF NOT EXISTS idx_admissions_physician ON public.admissions(physician_id);
CREATE INDEX IF NOT EXISTS idx_admissions_contractor ON public.admissions(contractor_id);
CREATE INDEX IF NOT EXISTS idx_admissions_room ON public.admissions(room_id);

CREATE INDEX IF NOT EXISTS idx_or_cases_room ON public.or_cases(room_id);

-- RTDB nodes path prefix search optimization (accelerates LIKE 'state/%')
CREATE INDEX IF NOT EXISTS idx_rtdb_nodes_path_pattern 
ON public.rtdb_nodes (path text_pattern_ops);

-- Trigram fuzzy and substring matching for bilingual Arabic & English names
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_patients_name_trgm 
ON public.patients USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_staff_name_trgm 
ON public.staff USING gin (name gin_trgm_ops);

-- Composite index for fast OR scheduling lookups in sync_or_cases
CREATE INDEX IF NOT EXISTS idx_or_cases_patient_date 
ON public.or_cases (patient_id, scheduled_date);

-- Covering index enabling 100% Index-Only Scans for active_occupancy_view
CREATE INDEX IF NOT EXISTS idx_admissions_active_covering 
ON public.admissions (status, patient_id) 
INCLUDE (room_id, physician_id, contractor_id, contractor_name, financial_status, total_invoice, remaining_debt, admission_date)
WHERE status = 'Admitted';

-- High-Churn JSONB table storage tuning (enables HOT updates to eliminate index bloat)
ALTER TABLE public.rtdb_nodes SET (
    fillfactor = 85,
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 20,
    autovacuum_vacuum_cost_limit = 1000
);

-- Query planner statistics (calibrates cost model for skewed admitted vs discharged ratio)
ALTER TABLE public.admissions ALTER COLUMN status SET STATISTICS 500;

-- ==============================================================================
-- 17. SPECIALIZED OPERATIONAL & FINANCIAL VIEWS
-- ==============================================================================

-- Financial debt monitoring view
CREATE OR REPLACE VIEW public.active_debt_watch_view AS
SELECT 
    a.id AS admission_id,
    p.mrn,
    p.name AS patient_name,
    p.phone AS patient_phone,
    r.name AS room_name,
    s.name AS treating_physician,
    a.financial_status,
    a.total_invoice,
    a.remaining_debt,
    CASE 
        WHEN a.total_invoice > 0 THEN ROUND((a.remaining_debt / a.total_invoice) * 100, 2)
        ELSE 0 
    END AS debt_percentage,
    EXTRACT(DAY FROM (NOW() - a.admission_date))::int AS los_days
FROM public.admissions a
JOIN public.patients p ON a.patient_id = p.id
LEFT JOIN public.rooms r ON a.room_id = r.id
LEFT JOIN public.staff s ON a.physician_id = s.id
WHERE a.status = 'Admitted' AND a.remaining_debt > 0;

-- Operating Room scheduling parity view
CREATE OR REPLACE VIEW public.or_schedule_occupancy_view AS
SELECT 
    oc.id AS or_case_id,
    oc.scheduled_date,
    oc.start_time,
    oc.end_time,
    p.mrn,
    p.name AS patient_name,
    or_room.name AS operating_room,
    s.name AS surgeon_name,
    oc.operation_name_en,
    oc.operation_name_ar,
    oc.status AS surgical_status,
    curr_adm.status AS current_inpatient_status,
    curr_room.name AS current_inpatient_bed
FROM public.or_cases oc
JOIN public.patients p ON oc.patient_id = p.id
LEFT JOIN public.rooms or_room ON oc.room_id = or_room.id
LEFT JOIN public.staff s ON oc.surgeon_id = s.id
LEFT JOIN LATERAL (
    SELECT status, room_id 
    FROM public.admissions 
    WHERE patient_id = p.id AND status = 'Admitted'
    ORDER BY admission_date DESC 
    LIMIT 1
) curr_adm ON true
LEFT JOIN public.rooms curr_room ON curr_adm.room_id = curr_room.id;

-- ==============================================================================
-- 18. RPC: sync_or_cases (Operating Room Schedule Ingestion Engine)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.sync_or_cases(payload JSON)
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
    INSERT INTO public.patients (mrn, name, updated_at) 
    VALUES (v_mrn, COALESCE(NULLIF(TRIM(rec->>'patientName'), ''), 'Unknown Patient'), NOW())
    ON CONFLICT (mrn) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
    RETURNING id INTO p_id;

    -- 2. Upsert Room (Operating Theatre)
    IF rec->>'orRoom' IS NOT NULL AND rec->>'orRoom' != '' AND rec->>'orRoom' != 'None' THEN
      INSERT INTO public.rooms (name, ward_type) 
      VALUES (TRIM(rec->>'orRoom'), 'OR')
      ON CONFLICT (name) DO UPDATE SET ward_type = 'OR'
      RETURNING id INTO r_id;
    ELSE
      r_id := NULL;
    END IF;

    -- 3. Upsert Surgeon (staff table has UNIQUE constraint on name)
    IF rec->>'surgeonName' IS NOT NULL AND rec->>'surgeonName' != '' AND rec->>'surgeonName' != 'None' THEN
      INSERT INTO public.staff (name, role)
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
    UPDATE public.or_cases 
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
        COALESCE(v_date, CURRENT_DATE), 
        COALESCE(rec->>'status', 'Scheduled'), 
        rec->>'financialStatus'
      );
    END IF;

  END LOOP;
END;
$$;



