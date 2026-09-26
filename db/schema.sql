-- ==============================================================================
-- HOSPITAL OCCUPANCY MANAGER: RELATIONAL SCHEMA MIGRATION
-- ==============================================================================
-- INSTRUCTIONS: Copy and paste this entire file into the Supabase SQL Editor.
-- ==============================================================================

-- 1. Create Enums for standardized types
CREATE TYPE admission_status AS ENUM ('Admitted', 'Discharged', 'Transferred');
CREATE TYPE payment_type AS ENUM ('Cash', 'Insured', 'Corporate');

-- 2. Patients Table (Core Identity)
CREATE TABLE patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mrn VARCHAR(50) UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Rooms & Wards
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    ward_type VARCHAR(100)
);

-- 4. Staff & Contractors
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL
);

-- 5. Admissions
CREATE TABLE admissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
    physician_id UUID REFERENCES staff(id),
    contractor_id UUID REFERENCES staff(id),
    admission_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    discharge_date TIMESTAMPTZ,
    status admission_status DEFAULT 'Admitted',
    payment payment_type,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast occupancy queries
CREATE INDEX idx_admissions_active ON admissions(status, room_id) WHERE status = 'Admitted';

-- 6. Transfers 
CREATE TABLE transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
    from_room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
    to_room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
    physician_id UUID REFERENCES staff(id),
    transfer_date TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT
);

-- 7. OR Cases
CREATE TABLE or_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
    surgeon_id UUID REFERENCES staff(id),
    procedure_name_ar TEXT,
    procedure_name_en TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    financial_status payment_type,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Create Fast Retrieval View for Frontend
CREATE OR REPLACE VIEW active_occupancy_view AS
SELECT 
  a.id AS admission_id,
  p.id AS patient_id,
  p.name AS patientName,
  p.mrn,
  r.name AS roomName,
  s.name AS treatingPhysician,
  a.admission_date,
  a.payment AS payment_type
FROM admissions a
JOIN patients p ON a.patient_id = p.id
LEFT JOIN rooms r ON a.room_id = r.id
LEFT JOIN staff s ON a.physician_id = s.id
WHERE a.status = 'Admitted';

-- ==============================================================================
-- 9. SECURITY (ROW LEVEL SECURITY - RLS)
-- ==============================================================================
-- By enabling RLS without creating any public policies, we create a "Deny All" 
-- firewall for the public internet (anon keys). 
-- Your Node.js backend uses the Service Role Key, which automatically bypasses RLS.
-- This guarantees maximum security for medical records.

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE or_cases ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 10. REALTIME CONFIGURATION
-- ==============================================================================
-- Enables exact-row web-socket tracking to eliminate polling in server.ts
alter publication supabase_realtime add table patients;
alter publication supabase_realtime add table admissions;
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table transfers;
alter publication supabase_realtime add table or_cases;
