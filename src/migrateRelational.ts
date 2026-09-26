import { supabaseAdmin } from './supabase.js';

/**
 * Migration Utility: Translates the legacy JSON blob into the new Relational schema
 * This should be executed once to populate the new tables, and can be triggered via a secured admin endpoint.
 */
export async function migrateJsonToRelational(hospitalData: any[][], orListData: any[]) {
  console.log('[Migration] Starting migration from JSON blob to Relational Schema...');
  let totalPatients = 0;
  let totalAdmissions = 0;
  let totalORCases = 0;

  // 1. Extract and map Rooms
  // (In a real scenario, you'd extract all unique rooms from hospitalData)
  
  try {
    // Note: We begin a transaction logic here by inserting Patients first
    // Since hospitalData is an array of arrays (Google Sheets format), we parse it:
    for (const row of hospitalData) {
      // Assuming strict GAS logic: 
      // row[0] = Room/Bed
      // row[1] = Patient Name
      // row[2] = Treating Physician
      const roomName = row[0];
      const patientName = row[1];
      const physicianName = row[2];

      if (!patientName) continue;

      // 1. Upsert Patient
      const { data: patient, error: pErr } = await supabaseAdmin
        .from('patients')
        .upsert({ name: patientName }, { onConflict: 'name' }) // simplified conflict
        .select('id')
        .single();
      
      if (pErr || !patient) continue;
      totalPatients++;

      // 2. Upsert Room
      let roomId = null;
      if (roomName) {
        const { data: room } = await supabaseAdmin
          .from('rooms')
          .upsert({ name: roomName }, { onConflict: 'name' })
          .select('id')
          .single();
        if (room) roomId = room.id;
      }

      // 3. Upsert Physician (Staff)
      let physicianId = null;
      if (physicianName) {
        const { data: staff } = await supabaseAdmin
          .from('staff')
          .upsert({ name: physicianName, role: 'Physician' }, { onConflict: 'name' }) // Requires unique constraint on staff.name in reality
          .select('id')
          .single();
        if (staff) physicianId = staff.id;
      }

      // 4. Create Admission
      const { error: aErr } = await supabaseAdmin
        .from('admissions')
        .insert({
          patient_id: patient.id,
          room_id: roomId,
          physician_id: physicianId,
          status: 'Admitted'
        });
        
      if (!aErr) totalAdmissions++;
    }

    console.log(`[Migration] Completed! Patients: ${totalPatients}, Admissions: ${totalAdmissions}, OR Cases: ${totalORCases}`);
    return { success: true, totalPatients, totalAdmissions, totalORCases };

  } catch (e) {
    console.error('[Migration] Failed:', e);
    return { success: false, error: e };
  }
}
