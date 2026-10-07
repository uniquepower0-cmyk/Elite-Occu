-- ==============================================================================
-- BULLETPROOF SUPABASE AUTH INTEGRATION & PROFILE SYNC (SAFE & TYPE-CASTED)
-- ==============================================================================
-- Paste this script into your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/uuvomcxbgldgtmuqtymk/sql/new
-- ==============================================================================

-- 1. Ensure profiles table exists
CREATE TABLE IF NOT EXISTS public.profiles (
    id TEXT PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'staff',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safely add missing columns to profiles if the table already existed
DO $$ BEGIN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'staff';
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
EXCEPTION WHEN others THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
EXCEPTION WHEN others THEN null;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to view profiles
DROP POLICY IF EXISTS "Allow authenticated users to read profiles" ON public.profiles;
CREATE POLICY "Allow authenticated users to read profiles"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (true);

-- Allow users to update their own profile (casts auth.uid()::text = id::text)
DROP POLICY IF EXISTS "Allow users to update their own profile" ON public.profiles;
CREATE POLICY "Allow users to update their own profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (auth.uid()::text = id::text);

-- 2. Trigger Function: Automatically sync newly authenticated Supabase users into profiles
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER 
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    v_name TEXT;
    v_role TEXT;
BEGIN
    v_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );

    IF NEW.email = 'mohanad.md07@gmail.com' THEN
        v_role := 'admin';
    ELSE
        v_role := 'staff';
    END IF;

    INSERT INTO public.profiles (id, email, display_name, role, updated_at)
    VALUES (NEW.id::text, NEW.email, v_name, v_role, NOW())
    ON CONFLICT (email) DO UPDATE
    SET 
        id = EXCLUDED.id,
        display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        updated_at = NOW();

    RETURN NEW;
END;
$$;

-- 3. Register the trigger on auth.users (Safely dropped first)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT OR UPDATE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 4. Dedicated Relational Login Audit Trail Table
CREATE TABLE IF NOT EXISTS public.auth_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT,
    email VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    ip_address TEXT,
    user_agent TEXT,
    logged_in_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_timestamp 
ON public.auth_audit_logs(logged_in_at DESC);

ALTER TABLE public.auth_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read access to auth logs for authenticated users" ON public.auth_audit_logs;
CREATE POLICY "Allow read access to auth logs for authenticated users"
    ON public.auth_audit_logs FOR SELECT
    TO authenticated
    USING (true);
