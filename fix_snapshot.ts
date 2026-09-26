import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || 'https://uuvomcxbgldgtmuqtymk.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1dm9tY3hiZ2xkZ3RtdXF0eW1rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODkwNTQ4MSwiZXhwIjoyMTA0NDgxNDgxfQ.qd80QNiyhjO51Ky4zxKmzXtOb-bB4hFvhZ3cYnVoyn0',
  { auth: { persistSession: false } }
);

async function run() {
  console.log("Triggering snapshot rebuild from live data...");
  const fetchReq = await fetch('https://hospital-occu.vercel.app/api/history/occupancy/snapshot', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ date: "2026-09-26" })
  });
  console.log(fetchReq.status);
  console.log(await fetchReq.text());
}
run();
