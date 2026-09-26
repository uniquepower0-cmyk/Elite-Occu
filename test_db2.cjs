const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function run() {
  const { data, error } = await supabaseAdmin.from('rtdb_nodes').select('path, data, updated_at').like('path', 'history/or/2026-09-%/cases').order('updated_at', { ascending: false });
  if (error) console.error(error);
  if (!data) return;
  console.log(data.map(d => `${d.path} : ${d.data.length} cases (updated: ${d.updated_at})`));
}
run();
