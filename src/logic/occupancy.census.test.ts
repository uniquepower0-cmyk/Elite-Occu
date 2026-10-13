import { describe, it, expect } from 'vitest';
import {
  computeOccupancyCensus,
  excludeNonStatRooms,
  CLOSED_UNIT_ZONES,
  PatientRow,
} from './occupancy';

describe('computeOccupancyCensus & Bed Census Logic', () => {
  it('excludes room 108 via excludeNonStatRooms', () => {
    const patients: PatientRow[] = [
      { id: '', room: '101', name: 'Patient A', doctor: '', payment: '', date: '', type: '' },
      { id: '', room: '108', name: 'Patient B (Non-stat)', doctor: '', payment: '', date: '', type: '' },
      { id: '', room: '305', name: 'Patient C', doctor: '', payment: '', date: '', type: '' },
    ];

    const filtered = excludeNonStatRooms(patients);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(p => p.room)).toEqual(['101', '305']);
  });

  it('computes inpatient and total occupancy census accurately', () => {
    // Row 0-2 are header lines; patient rows start at index 3
    const raw = [
      ['Sheet Title'],
      ['Subheader'],
      ['Bed#', 'Patient', 'TreatingPhysicianName', 'Financial Status', 'AdmissionDate'],
      // 1st Floor (inpatient)
      ['101', 'Patient 1st Floor', 'Dr. A', 'Cash', '10/01/26'],
      // Zone A (inpatient)
      ['305', 'Patient Zone A', 'Dr. B', 'Insured', '10/01/26'],
      // 4th Floor (inpatient)
      ['410', 'Patient 4th Floor', 'Dr. C', 'Cash', '10/01/26'],
      // ICU (closed unit)
      ['ICU Room 1', 'Patient ICU', 'Dr. D', 'Insured', '10/01/26'],
      // Non-stat room 108 (must be excluded)
      ['108', 'Patient Room 108', 'Dr. E', 'Cash', '10/01/26'],
      // OR Room (must be excluded by filterPatientData)
      ['OR-1', 'Patient OR', 'Dr. F', 'Cash', '10/01/26'],
    ];

    const census = computeOccupancyCensus(raw);

    // Active patients after filtering: 101, 305, 410, ICU Room 1 = 4 total occupied
    expect(census.totalOccupied).toBe(4);
    expect(census.totalCapacity).toBe(110);

    // Inpatient occupied = 101 (1st Floor) + 305 (Zone A) + 410 (4th Floor) = 3
    // (ICU is in CLOSED_UNIT_ZONES and excluded from inpatient)
    expect(census.inpatientOccupied).toBe(3);
    // Inpatient capacity = 7 (1st Fl) + 19 (Zone A) + 10 (Zone B) + 5 (Zone C) + 27 (4th Fl) = 68
    expect(census.inpatientCapacity).toBe(68);

    // Verify all zones are present
    expect(census.zones.length).toBe(10);
    const icuZone = census.zones.find(z => z.name === 'ICU & VIP');
    expect(icuZone?.occupied).toBe(1);
    expect(CLOSED_UNIT_ZONES).toContain('ICU & VIP');
  });
});
