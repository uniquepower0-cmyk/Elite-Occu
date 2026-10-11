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
    detectSessionInUrl: true,
    flowType: 'pkce',
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

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: {
        access_type: 'offline',
        prompt: 'select_account',
      },
    },
  });
  if (error) throw error;
  return data;
}

export async function signOutUser() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Client-side debounce and in-flight tracking to prevent repeated API calls
let lastLoggedUser = '';
let lastLoggedTime = 0;
let inFlightLoginPromise: Promise<void> | null = null;

let auditLogsCache: { logs: SupabaseAuditLog[]; fetchedAt: number } | null = null;
let inFlightLogsPromise: Promise<SupabaseAuditLog[]> | null = null;

export async function logUserLogin(user: { uid?: string; email?: string; displayName?: string }) {
  const timestamp = new Date().toISOString();
  const userId = user.uid || `usr_${Date.now()}`;
  const email = user.email || 'user@elite.hospital';
  const displayName = user.displayName || 'Authorized Staff';
  const now = Date.now();

  // Deduplicate client-side: suppress duplicate login audit posts for the same user within 2 minutes
  if (lastLoggedUser === email && (now - lastLoggedTime) < 120000) {
    return;
  }

  // If a login request is already in-flight for this user, reuse that promise
  if (inFlightLoginPromise && lastLoggedUser === email) {
    return inFlightLoginPromise;
  }

  lastLoggedUser = email;
  lastLoggedTime = now;

  inFlightLoginPromise = (async () => {
    try {
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
      // Invalidate audit logs cache so the next view fetch sees the latest entry
      auditLogsCache = null;
    } catch (err) {
      console.error('Failed to record login audit:', err);
    } finally {
      inFlightLoginPromise = null;
    }
  })();

  return inFlightLoginPromise;
}

export async function fetchSupabaseAuditLogs(force = false): Promise<SupabaseAuditLog[]> {
  const now = Date.now();

  // Return cached audit logs if fresh (within 30s) and force refresh was not requested
  if (!force && auditLogsCache && (now - auditLogsCache.fetchedAt < 30000)) {
    return auditLogsCache.logs;
  }

  // Share in-flight request if another caller is already fetching
  if (inFlightLogsPromise) {
    return inFlightLogsPromise;
  }

  inFlightLogsPromise = (async () => {
    try {
      const url = force ? '/api/logins?force=true' : '/api/logins';
      const res = await fetch(url, {
        headers: force ? { 'Cache-Control': 'no-cache' } : {},
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.logs)) {
          auditLogsCache = { logs: data.logs, fetchedAt: Date.now() };
          return data.logs;
        }
      }
    } catch (e) {
      console.warn('Error fetching login logs from API, trying direct Supabase query:', e);
    } finally {
      inFlightLogsPromise = null;
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
          auditLogsCache = { logs: data.data, fetchedAt: Date.now() };
          return data.data;
        }
      } catch (e) {
        console.error('Supabase direct audit log fetch error:', e);
      }
    }

    return auditLogsCache ? auditLogsCache.logs : [];
  })();

  return inFlightLogsPromise;
}
