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

  it('computes inpatient and total occupancy from raw 42-column hospital data (PowerBI/snapshot format)', () => {
    const rawMultiCol = [
      ['No filters applied'],
      [''],
      ['AdmissionDate', 'Bed#', 'MRN', 'Patient', 'DefaultMobile', 'Financial Status', 'Age', 'Floor Name', 'Notes', 'Companions #', 'Visit', 'PaymentBy', 'ContractorName', 'FloorStructureName_EN', 'ICD-10 Diagnosis', 'DRG', 'Created by DIG', 'DRG Diagnosis', 'LOS', 'GLOS', 'ALOS', 'Weight', 'TreatingPhysicianName'],
      // 1st Floor (Room 102)
      ['10/01/26 10:00', 'Room 102', '123', 'Patient 1', '', 'Cash', '30', '1st Floor', '', '0', '', '', 'Cash', '1st Fl', '', '', '', '', '1', '1', '1', '1', 'Dr. Alpha'],
      // Zone A (Room 305)
      ['10/01/26 10:00', 'Room 305', '124', 'Patient 2', '', 'Insured', '45', '3rd Floor', '', '0', '', '', 'Bupa', 'Zone A', '', '', '', '', '1', '1', '1', '1', 'Dr. Beta'],
      // Zone B (Room 325)
      ['10/01/26 10:00', 'Room 325', '125', 'Patient 3', '', 'Cash', '50', '3rd Floor', '', '0', '', '', 'Cash', 'Zone B', '', '', '', '', '1', '1', '1', '1', 'Dr. Gamma'],
      // 4th Floor (Room 415)
      ['10/01/26 10:00', 'Room 415', '126', 'Patient 4', '', 'Cash', '60', '4th Floor', '', '0', '', '', 'Cash', '4th Fl', '', '', '', '', '1', '1', '1', '1', 'Dr. Delta'],
      // ICU Room 6 (closed unit)
      ['10/01/26 10:00', 'ICU Room 6', '127', 'Patient 5', '', 'Insured', '70', '2nd Floor', '', '0', '', '', 'GlobeMed', 'ICU', '', '', '', '', '1', '1', '1', '1', 'Dr. Epsilon'],
    ];

    const census = computeOccupancyCensus(rawMultiCol);

    // Total occupied: 5 patients
    expect(census.totalOccupied).toBe(5);
    expect(census.totalCapacity).toBe(110);

    // Inpatient: Room 102 (1st Fl) + Room 305 (Zone A) + Room 325 (Zone B) + Room 415 (4th Fl) = 4
    expect(census.inpatientOccupied).toBe(4);
    expect(census.inpatientCapacity).toBe(68);

    // Verify zone counts
    const zoneA = census.zones.find(z => z.name === 'Zone A');
    expect(zoneA?.occupied).toBe(1);
    const icu = census.zones.find(z => z.name === 'ICU & VIP');
    expect(icu?.occupied).toBe(1);
  });
});
