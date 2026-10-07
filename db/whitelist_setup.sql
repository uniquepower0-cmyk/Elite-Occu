-- ==============================================================================
-- OPTION 1: DYNAMIC USER WHITELIST & RBAC ACCESS CONTROL
-- ==============================================================================
-- Run this script in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/uuvomcxbgldgtmuqtymk/sql/new
-- ==============================================================================

-- 1. Create Whitelist Table for authorized staff members
CREATE TABLE IF NOT EXISTS public.allowed_users (
    email VARCHAR(255) PRIMARY KEY,
    role VARCHAR(50) DEFAULT 'staff', -- 'admin', 'medical_director', 'staff', 'viewer'
    full_name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safely add columns if table existed
DO $$ BEGIN
    ALTER TABLE public.allowed_users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'staff';
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.allowed_users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.allowed_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
EXCEPTION WHEN others THEN null;
END $$;

-- 2. Seed your initial admin account
INSERT INTO public.allowed_users (email, role, full_name, is_active)
VALUES 
    ('mohanad.md07@gmail.com', 'admin', 'Dr. Mohanad (Admin)', true)
ON CONFLICT (email) DO UPDATE 
SET 
    role = EXCLUDED.role, 
    full_name = EXCLUDED.full_name,
    is_active = true;

-- Enable RLS on allowed_users
ALTER TABLE public.allowed_users ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to check the whitelist
DROP POLICY IF EXISTS "Allow authenticated read allowed_users" ON public.allowed_users;
CREATE POLICY "Allow authenticated read allowed_users" 
    ON public.allowed_users FOR SELECT 
    TO authenticated 
    USING (true);

-- 3. Dynamic Whitelist Enforcement Trigger on auth.users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER 
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    v_allowed RECORD;
    v_name TEXT;
BEGIN
    -- Check if user's email is present in the allowed_users whitelist and is active
    SELECT * INTO v_allowed 
    FROM public.allowed_users 
    WHERE LOWER(TRIM(email)) = LOWER(TRIM(NEW.email)) AND is_active = TRUE;

    IF NOT FOUND THEN
        -- If email is NOT on whitelist, raise exception to deny access
        RAISE EXCEPTION 'Access Denied: % is not authorized to access this hospital dashboard. Please contact Dr. Mohanad.', NEW.email;
    END IF;

    -- Extract display name (prefer whitelist custom name, then Google metadata)
    v_name := COALESCE(
        v_allowed.full_name,
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );

    -- Sync verified profile
    INSERT INTO public.profiles (id, email, display_name, role, updated_at)
    VALUES (NEW.id::text, NEW.email, v_name, v_allowed.role, NOW())
    ON CONFLICT (email) DO UPDATE
    SET 
        id = EXCLUDED.id,
        display_name = v_name,
        role = v_allowed.role,
        updated_at = NOW();

    RETURN NEW;
END;
$$;

-- 4. Re-bind the trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT OR UPDATE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
