import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf-8');

const helperFunc = `
async function syncORCasesToRelationalSchema(parsedData: any[], dateStr: string) {
  try {
    if (!parsedData || parsedData.length === 0) return;
    console.log(\`[Relational Sync] Syncing \${parsedData.length} OR cases for \${dateStr}...\`);

    // 1. Prepare unique patients
    const patientMap = new Map();
    for (const row of parsedData) {
      let mrn = row.mrn;
      if (!mrn) mrn = \`UNKNOWN-\${Math.random().toString(36).substring(7)}\`; 
      patientMap.set(mrn, { mrn: mrn, name: row.patientName || 'Unknown Patient' });
      row._computedMrn = mrn;
    }
    const patientsToUpsert = Array.from(patientMap.values());
    const { data: pData, error: pErr } = await supabaseAdmin
      .from('patients')
      .upsert(patientsToUpsert, { onConflict: 'mrn' })
      .select('id, mrn');
      
    if (pErr) throw new Error(\`Patient Upsert Error: \${pErr.message}\`);
    const mrnToId = new Map((pData || []).map((p: any) => [p.mrn, p.id]));

    // 2. Prepare unique rooms
    const roomMap = new Map();
    for (const row of parsedData) {
      if (row.orRoom) {
        roomMap.set(row.orRoom, { name: row.orRoom, ward_type: 'OR' });
      }
    }
    const roomsToUpsert = Array.from(roomMap.values());
    let roomNameToId = new Map();
    if (roomsToUpsert.length > 0) {
      const { data: rData, error: rErr } = await supabaseAdmin
        .from('rooms')
        .upsert(roomsToUpsert, { onConflict: 'name' })
        .select('id, name');
      if (rErr) throw new Error(\`Room Upsert Error: \${rErr.message}\`);
      roomNameToId = new Map((rData || []).map((r: any) => [r.name, r.id]));
    }

    // 3. Prepare unique surgeons
    const surgeonMap = new Map();
    for (const row of parsedData) {
      if (row.surgeonName) {
        surgeonMap.set(row.surgeonName, { name: row.surgeonName, role: 'Physician' });
      }
    }
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

    // 4. Delete existing cases for this date to prevent duplicates upon re-upload
    await supabaseAdmin.from('or_cases').delete().eq('scheduled_date', dateStr);

    // 5. Insert new OR Cases
    const formatTime = (tStr: string) => {
       if (!tStr) return null;
       const t = tStr.trim();
       if (/^\\d{1,2}:\\d{2}/.test(t)) return t;
       return null;
    };

    const casesToInsert = parsedData.map(row => ({
      patient_id: mrnToId.get(row._computedMrn),
      room_id: roomNameToId.get(row.orRoom) || null,
      surgeon_id: surgeonNameToId.get(row.surgeonName) || null,
      operation_name_en: row.engOperationName,
      operation_name_ar: row.arOperationName,
      start_time: formatTime(row.startTime),
      end_time: formatTime(row.endTime),
      scheduled_date: dateStr,
      status: 'Scheduled'
    }));

    if (casesToInsert.length > 0) {
      const { error: cErr } = await supabaseAdmin.from('or_cases').insert(casesToInsert);
      if (cErr) throw new Error(\`OR Cases Insert Error: \${cErr.message}\`);
    }

    console.log(\`[Relational Sync] Successfully synced OR cases to database.\`);
  } catch (err) {
    console.error(\`[Relational Sync] Error:\`, err);
  }
}
`;

if (!content.includes('syncORCasesToRelationalSchema')) {
  content = content.replace(
    "app.post('/api/upload-or-list', handleUploadSingle, async (req: any, res) => {",
    helperFunc + "\\n\\napp.post('/api/upload-or-list', handleUploadSingle, async (req: any, res) => {"
  );
  
  content = content.replace(
    "cumulativeORList = parsedData;",
    "cumulativeORList = parsedData;\\n    // Push to relational database\\n    syncORCasesToRelationalSchema(parsedData, dateStr).catch(e => console.error(e));"
  );
  
  fs.writeFileSync('server.ts', content, 'utf-8');
  console.log("Patched server.ts successfully");
} else {
  console.log("Already patched");
}
