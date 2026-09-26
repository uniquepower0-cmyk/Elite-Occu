import { createClient } from '@supabase/supabase-js';

// Default Supabase project credentials provided by user
export const SUPABASE_URL = 
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_URL) || 
  'https://uuvomcxbgldgtmuqtymk.supabase.co';

export const SUPABASE_ANON_KEY = 
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_ANON_KEY) || 
  '';

if (!SUPABASE_ANON_KEY) {
  console.warn('[Security] VITE_SUPABASE_ANON_KEY is not defined in environment variables. Please configure it in .env');
}

// When no anon key is set, point to a placeholder URL so the Supabase client is
// effectively inert and cannot emit authenticated (or unauthenticated) requests
// against the real project — preventing 401 errors in the browser console.
const _supabaseUrl = SUPABASE_ANON_KEY ? SUPABASE_URL : 'https://placeholder.invalid';
const _supabaseKey = SUPABASE_ANON_KEY || 'placeholder-key-not-configured';

export const supabase = createClient(_supabaseUrl, _supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

export interface SupabaseAuditLog {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  timestamp: string;
}

export async function logUserLogin(user: { uid?: string; email?: string; displayName?: string }) {
  const timestamp = new Date().toISOString();
  const userId = user.uid || `usr_${Date.now()}`;
  const email = user.email || 'user@elite.hospital';
  const displayName = user.displayName || 'Authorized Staff';

  try {
    // Delegate all profile writes to the server-side API which uses the service-role
    // key (bypasses RLS) and handles upsert conflict resolution correctly.
    // Never write to 'profiles' directly from the browser with the anon key —
    // that triggers RLS violations (42501) and duplicate email errors (23505).
    await fetch('/api/logins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        email,
        displayName,
        timestamp,
      }),
    });
  } catch (err) {
    console.error('Failed to record login audit:', err);
  }
}

export async function fetchSupabaseAuditLogs(): Promise<SupabaseAuditLog[]> {
  try {
    const res = await fetch('/api/logins');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.logs)) {
        return data.logs;
      }
    }
  } catch (e) {
    console.warn('Error fetching login logs from API, trying direct Supabase query:', e);
  }

  // Only attempt a direct Supabase query when a valid anon key is available;
  // without it the request would return 401 and pollute the browser console.
  if (SUPABASE_ANON_KEY) {
    try {
      const { data, error } = await supabase
        .from('rtdb_nodes')
        .select('data')
        .eq('path', 'audit_logs')
        .single();

      if (!error && data && Array.isArray(data.data)) {
        return data.data;
      }
    } catch (e) {
      console.error('Supabase direct audit log fetch error:', e);
    }
  }

  return [];
}
