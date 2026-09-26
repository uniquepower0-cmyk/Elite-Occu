import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log("URL exists:", !!url, "Key exists:", !!key);

const supabaseAdmin = createClient(url!, key!, { auth: { persistSession: false } });

async function run() {
  const { data, error } = await supabaseAdmin.from('rtdb_nodes').select('path').like('path', 'state/%');
  if (error) console.error(error);
  console.log(data);
}
run();
