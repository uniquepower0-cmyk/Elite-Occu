import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function test() {
    const { data: stateNodes, error: sbErr } = await supabaseAdmin
      .from('rtdb_nodes')
      .select('*')
      .like('path', 'state/%');
      
    if (sbErr) {
        console.error("Supabase Error:", sbErr);
        return;
    }
    
    let occData;
    for (const node of stateNodes) {
        if (node.path === 'state/occupancy') {
            occData = typeof node.data === 'string' ? JSON.parse(node.data) : node.data;
        }
    }
    
    if (occData) {
        const current = occData.current || occData.beds;
        console.log("Current Length:", current?.length);
        if (current?.length > 0) {
            console.log("First item:", current[0]);
            console.log("Second item:", current[1]);
        }
    }
}

test();
