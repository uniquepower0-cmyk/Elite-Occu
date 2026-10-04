-- ==============================================================================
-- HOSPITAL OCCUPANCY MANAGER: BULLETPROOF RELATIONAL MIGRATION (V2.1)
-- ==============================================================================
-- INSTRUCTIONS: Copy and paste this entire file into the Supabase SQL Editor.
-- Fully idempotent: Works on fresh databases AND databases with existing v1 tables.
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- 13. Ensure rtdb_nodes uses REPLICA IDENTITY DEFAULT to avoid broadcasting unmodified payload columns
DO $$ BEGIN
    ALTER TABLE public.rtdb_nodes REPLICA IDENTITY DEFAULT;
EXCEPTION WHEN others THEN null;
END $$;

