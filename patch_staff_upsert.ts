import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf-8');

const oldSurgeonLogic = `
    const surgeonsToUpsert = Array.from(surgeonMap.values());
    let surgeonNameToId = new Map();
    if (surgeonsToUpsert.length > 0) {
      const { data: sData, error: sErr } = await supabaseAdmin
        .from('staff')
        .upsert(surgeonsToUpsert, { onConflict: 'name' })
        .select('id, name');
      if (sErr) throw new Error(\`Staff Upsert Error: \${sErr.message}\`);
      surgeonNameToId = new Map((sData || []).map((s: any) => [s.name, s.id]));
    }
`;

const newSurgeonLogic = `
    const surgeonsNames = Array.from(surgeonMap.keys());
    let surgeonNameToId = new Map();
    if (surgeonsNames.length > 0) {
      const { data: existingSurgeons, error: sErr } = await supabaseAdmin
        .from('staff')
        .select('id, name')
        .in('name', surgeonsNames);
        
      if (sErr) throw new Error(\`Staff Select Error: \${sErr.message}\`);
      
      const existingNames = new Set((existingSurgeons || []).map((s: any) => s.name));
      (existingSurgeons || []).forEach((s: any) => surgeonNameToId.set(s.name, s.id));
      
      const missingSurgeons = surgeonsNames.filter(n => !existingNames.has(n)).map(n => ({ name: n, role: 'Physician' }));
      
      if (missingSurgeons.length > 0) {
        const { data: newSurgeons, error: insertErr } = await supabaseAdmin
          .from('staff')
          .insert(missingSurgeons)
          .select('id, name');
        if (insertErr) throw new Error(\`Staff Insert Error: \${insertErr.message}\`);
        (newSurgeons || []).forEach((s: any) => surgeonNameToId.set(s.name, s.id));
      }
    }
`;

content = content.replace(oldSurgeonLogic.trim(), newSurgeonLogic.trim());
fs.writeFileSync('server.ts', content, 'utf-8');
console.log("Patched surgeon logic successfully.");
