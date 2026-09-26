const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function run() {
  const { data: pData } = await supabaseAdmin.from('patients').select('*').limit(5);
  console.log("--- PATIENTS ---");
  console.log(pData);

  const { data: aData } = await supabaseAdmin.from('admissions').select('*').limit(5);
  console.log("--- ADMISSIONS ---");
  console.log(aData);
  
  const { data: orData } = await supabaseAdmin.from('or_cases').select('*').limit(5);
  console.log("--- OR CASES ---");
  console.log(orData);
}
run();
