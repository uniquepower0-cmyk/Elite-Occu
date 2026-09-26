import { supabaseAdmin } from './src/supabase.js';

async function check() {
  const { data: p } = await supabaseAdmin.from('patients').select('*').limit(5);
  console.log("Patients:", p);
  
  const { data: r } = await supabaseAdmin.from('rooms').select('*').limit(5);
  console.log("Rooms:", r);
}
check();
