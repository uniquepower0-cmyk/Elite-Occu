import { describe, it, expect } from 'vitest';
import { extractRawPatientsFromRows } from './occupancyLogic.js';
import { normalizeArabicName, isPatientMatch, cleanRoomStr, normalizeRoom } from './nameUtils.js';

describe('Patient Multi-Transfer Verification Suite', () => {
  it('correctly handles inverted Name/MRN columns from PowerBI 39-column exports', () => {
    // Row layout where Col 2 is Arabic Name and Col 3 is MRN
    const testData = [
      ['AdmissionDate', 'Bed#', 'Patient', 'MRN', 'Floor Name', 'TreatingPhysicianName'],
      ['2026-10-13T10:00:00', 'PICU Room 1', 'مليكه حسام الدين حمدي جابر', '0000284729', 'Elite 2nd Floor', 'Dr. Ahmed Naeem']
    ];

    const patients = extractRawPatientsFromRows(testData);
    expect(patients).toHaveLength(1);
    expect(patients[0].name).toBe('مليكه حسام الدين حمدي جابر');
    expect(patients[0].mrn).toBe('284729');
    expect(patients[0].room).toBe('PICU 1');
  });

  it('matches Arabic patient names across spelling variations (ة vs ه and hamzas)', () => {
    const nameWithHaa = 'مليكه حسام الدين حمدي جابر';
    const nameWithTaa = 'مليكة حسام الدين حمدي جابر';

    expect(normalizeArabicName(nameWithHaa)).toBe(normalizeArabicName(nameWithTaa));
    expect(isPatientMatch({ name: nameWithHaa }, { name: nameWithTaa })).toBe(true);
  });

  it('normalizes PICU, 409, and 308 rooms distinctly without classifying them as procedure suites', () => {
    const r1 = normalizeRoom('PICU Room 1');
    const r2 = normalizeRoom('Room 409');
    const r3 = normalizeRoom('Room 308');

    expect(r1).toBe('PICU1');
    expect(r2).toBe('409');
    expect(r3).toBe('308');

    expect(r1).not.toBe(r2);
    expect(r2).not.toBe(r3);
  });

  it('tracks sequential multi-step journey (PICU -> 409 -> 308)', () => {
    const patientRegistry: Record<string, any> = {};
    const transfers: any[] = [];

    function recordTransferStep(pt: { name: string; mrn: string; room: string }, dateStr: string) {
      const normKey = pt.mrn ? `mrn:${pt.mrn}` : `name:${normalizeArabicName(pt.name)}`;
      const existing = patientRegistry[normKey];

      if (existing) {
        const prevRoom = existing.lastRoom;
        if (normalizeRoom(prevRoom) !== normalizeRoom(pt.room)) {
          let rec = transfers.find(t => t.mrn === pt.mrn || isPatientMatch(t, pt));
          if (!rec) {
            rec = {
              name: pt.name,
              mrn: pt.mrn,
              initialRoom: prevRoom,
              currentRoom: pt.room,
              journey: [prevRoom, pt.room],
              history: [{ fromRoom: prevRoom, toRoom: pt.room, date: dateStr }]
            };
            transfers.push(rec);
          } else {
            rec.journey.push(pt.room);
            rec.history.push({ fromRoom: prevRoom, toRoom: pt.room, date: dateStr });
            rec.currentRoom = pt.room;
          }
          existing.lastRoom = pt.room;
        }
      } else {
        patientRegistry[normKey] = {
          name: pt.name,
          mrn: pt.mrn,
          lastRoom: pt.room
        };
      }
    }

    // Initial admission in PICU
    recordTransferStep({ name: 'مليكه حسام الدين حمدي جابر', mrn: '284729', room: 'PICU Room 1' }, '2026-10-13 08:00');
    expect(transfers).toHaveLength(0);
    expect(patientRegistry['mrn:284729'].lastRoom).toBe('PICU Room 1');

    // First transfer to 409
    recordTransferStep({ name: 'مليكة حسام الدين حمدي جابر', mrn: '284729', room: 'Room 409' }, '2026-10-13 12:00');
    expect(transfers).toHaveLength(1);
    expect(transfers[0].journey).toEqual(['PICU Room 1', 'Room 409']);
    expect(transfers[0].history).toHaveLength(1);

    // Second transfer to 308
    recordTransferStep({ name: 'مليكه حسام الدين حمدي جابر', mrn: '284729', room: 'Room 308' }, '2026-10-13 16:00');
    expect(transfers).toHaveLength(1);
    expect(transfers[0].journey).toEqual(['PICU Room 1', 'Room 409', 'Room 308']);
    expect(transfers[0].history).toHaveLength(2);
    expect(transfers[0].history[0]).toEqual({ fromRoom: 'PICU Room 1', toRoom: 'Room 409', date: '2026-10-13 12:00' });
    expect(transfers[0].history[1]).toEqual({ fromRoom: 'Room 409', toRoom: 'Room 308', date: '2026-10-13 16:00' });
  });
});
