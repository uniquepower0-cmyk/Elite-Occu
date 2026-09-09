import { createClient } from '@supabase/supabase-js';

// Default Supabase project credentials provided by user
export const SUPABASE_URL = 
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_URL) || 
  'https://uuvomcxbgldgtmuqtymk.supabase.co';

export const SUPABASE_ANON_KEY = 
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_ANON_KEY) || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1dm9tY3hiZ2xkZ3RtdXF0eW1rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODkwNTQ4MSwiZXhwIjoyMTA0NDgxNDgxfQ.qd80QNiyhjO51Ky4zxKmzXtOb-bB4hFvhZ3cYnVoyn0';


export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
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
    // 1. Record in profiles
    await supabase.from('profiles').upsert({
      id: userId,
      email,
      display_name: displayName,
      role: 'user',
      metadata: { lastLogin: timestamp, userAgent: navigator.userAgent },
      updated_at: timestamp,
    });

    // 2. Add to server-side login log via API or rtdb_nodes
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
    console.error('Failed to record Supabase login audit:', err);
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

  return [];
}
