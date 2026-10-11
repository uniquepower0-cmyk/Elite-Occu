import { describe, it, expect } from 'vitest';
import {
  isOperatingRoom,
  filterPatientData,
  extractDischargedPatients,
  isCashPayment,
  getGroup,
  calculateStats,
  normalizeArabicName,
  isClientNameMatch,
  getAccommodationCategory,
  PatientRow,
} from './occupancy';

describe('Hospital Occupancy Business Logic', () => {
  describe('isOperatingRoom', () => {
    it('identifies standard OR rooms and codes', () => {
      expect(isOperatingRoom('OR-1')).toBe(true);
      expect(isOperatingRoom('OR 2')).toBe(true);
      expect(isOperatingRoom('OR3')).toBe(true);
      expect(isOperatingRoom('or-12')).toBe(true);
      expect(isOperatingRoom('operating room')).toBe(true);
      expect(isOperatingRoom('operation room 4')).toBe(true);
      expect(isOperatingRoom('operating theatre')).toBe(true);
      expect(isOperatingRoom('recovery room')).toBe(true);
      expect(isOperatingRoom('OR')).toBe(true);
    });

    it('rejects general ward and inpatient rooms', () => {
      expect(isOperatingRoom('301')).toBe(false);
      expect(isOperatingRoom('402 A')).toBe(false);
      expect(isOperatingRoom('ICU 1')).toBe(false);
      expect(isOperatingRoom('CCU 2')).toBe(false);
      expect(isOperatingRoom('105 - 1')).toBe(false);
      expect(isOperatingRoom('')).toBe(false);
    });
  });

  describe('filterPatientData', () => {
    it('returns empty array when rawData is empty or short', () => {
      expect(filterPatientData([])).toEqual([]);
      expect(filterPatientData([['header'], ['sub'], ['title']])).toEqual([]);
    });

    it('parses valid spreadsheet rows starting from row 4 (index 3)', () => {
      const raw = [
        ['Sheet Title'],
        ['Hospital Name'],
        ['Bed', 'Patient Name', 'Doctor', 'Contractor', 'Admission Date'],
        ['301', 'John Doe', 'Dr. Smith', 'Cash', '2026-10-10'],
        ['302', 'Jane Smith', 'Dr. Adams', 'Bupa', '2026-10-11'],
        ['OR-1', 'Should Be Excluded', 'Dr. Surgeon', 'Cash', '2026-10-11'],
        ['Daycase Room', 'Excluded Name', 'Dr. X', 'Cash', '2026-10-11'],
        ['Bed', 'Patient', 'Header', 'Repeat', 'Date'], // Header repeat
      ];

      const result = filterPatientData(raw);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        room: '301',
        id: '',
        name: 'John Doe',
        type: '',
        doctor: 'Dr. Smith',
        payment: 'Cash',
        date: '2026-10-10',
        notes: '',
      });
      expect(result[1].name).toBe('Jane Smith');
    });

    it('filters out excluded keywords such as dialysis and homecare', () => {
      const raw = [
        ['H1'], ['H2'], ['H3'],
        ['305', 'Dialysis Patient', 'Dr. Nephro', 'Cash', '2026-10-10'],
        ['306', 'Home Care Visit', 'Dr. Home', 'Cash', '2026-10-10'],
        ['307', 'Valid Inpatient', 'Dr. General', 'Insurance', '2026-10-10'],
      ];

      const result = filterPatientData(raw);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Valid Inpatient');
    });
  });

  describe('extractDischargedPatients', () => {
    it('identifies discharged patients that were present yesterday but missing today', () => {
      const yesterday: PatientRow[] = [
        { room: '301', id: '', name: 'Ahmed Ali', type: '', payment: 'Cash', date: '2026-10-09' },
        { room: '302', id: '', name: 'Sara Mohamed', type: '', payment: 'Bupa', date: '2026-10-09' },
        { room: 'ICU 1', id: '', name: 'Omar Khaled', type: '', payment: 'Cash', date: '2026-10-08' },
      ];

      const today: PatientRow[] = [
        { room: '301', id: '', name: 'Ahmed Ali', type: '', payment: 'Cash', date: '2026-10-09' },
        { room: 'ICU 1', id: '', name: 'Omar Khaled', type: '', payment: 'Cash', date: '2026-10-08' },
      ];

      const discharged = extractDischargedPatients(yesterday, today);
      expect(discharged).toHaveLength(1);
      expect(discharged[0].name).toBe('Sara Mohamed');
      expect(discharged[0].room).toBe('302');
    });

    it('handles spacing and casing when matching patient names', () => {
      const yesterday: PatientRow[] = [
        { room: '301', id: '', name: '  Ahmed Ali  ', type: '', payment: 'Cash', date: '2026-10-09' },
      ];
      const today: PatientRow[] = [
        { room: '301', id: '', name: 'ahmed ali', type: '', payment: 'Cash', date: '2026-10-09' },
      ];

      expect(extractDischargedPatients(yesterday, today)).toHaveLength(0);
    });
  });

  describe('isCashPayment', () => {
    it('identifies cash and self-pay variants in English and Arabic', () => {
      expect(isCashPayment('Cash')).toBe(true);
      expect(isCashPayment('CASH')).toBe(true);
      expect(isCashPayment('نقدي')).toBe(true);
      expect(isCashPayment('نقدى')).toBe(true);
      expect(isCashPayment('كاش')).toBe(true);
    });

    it('rejects insurance and corporate contracts', () => {
      expect(isCashPayment('Bupa')).toBe(false);
      expect(isCashPayment('Tawuniya')).toBe(false);
      expect(isCashPayment('GlobeMed')).toBe(false);
      expect(isCashPayment('')).toBe(false);
    });
  });

  describe('getGroup', () => {
    it('correctly maps room numbers to zones and critical care units', () => {
      expect(getGroup('305')).toBe('ZONE A (ROOMS 301-319)');
      expect(getGroup('319')).toBe('ZONE A (ROOMS 301-319)');
      expect(getGroup('325')).toBe('ZONE B (ROOMS 320-329)');
      expect(getGroup('331 A')).toBe('ZONE C (ROOMS 330-332)');
      expect(getGroup('405 B')).toBe('4TH FLOOR (ROOMS 401-422)');
      expect(getGroup('ICU 3')).toBe('INTENSIVE CARE UNIT (ICU)');
      expect(getGroup('VIP ICU 1')).toBe('VIP ICU');
      expect(getGroup('CCU 4')).toBe('CORONARY CARE UNIT (CCU)');
      expect(getGroup('PICU 2')).toBe('PEDIATRIC INTENSIVE CARE (PICU)');
      expect(getGroup('NICU 1')).toBe('NEONATAL INTENSIVE CARE (NICU)');
    });
  });

  describe('calculateStats', () => {
    it('aggregates zone totals and calculates occupancy', () => {
      const patients: PatientRow[] = [
        { room: '301', id: '', name: 'Patient 1', type: '', payment: 'Cash', date: '2026-10-10' },
        { room: '302', id: '', name: 'Patient 2', type: '', payment: 'Bupa', date: '2026-10-10' },
        { room: 'ICU 1', id: '', name: 'Patient 3', type: '', payment: 'Cash', date: '2026-10-10' },
      ];

      const stats = calculateStats(patients);
      expect(stats.length).toBeGreaterThan(0);

      const zoneA = stats.find(s => s.name === 'Zone A');
      expect(zoneA).toBeDefined();
      expect(zoneA?.occupied).toBe(2);
      expect(zoneA?.total).toBe(19);

      const icuAndVip = stats.find(s => s.name === 'ICU & VIP');
      expect(icuAndVip).toBeDefined();
      expect(icuAndVip?.occupied).toBe(1);
      expect(icuAndVip?.total).toBe(21);
    });
  });

  describe('normalizeArabicName & isClientNameMatch', () => {
    it('normalizes alef variants and yaa in Arabic names', () => {
      expect(normalizeArabicName('أحمد')).toBe('احمد');
      expect(normalizeArabicName('إبراهيم')).toBe('ابراهيم');
      expect(normalizeArabicName('مروة')).toBe('مروه');
      expect(normalizeArabicName('على')).toBe('علي');
    });

    it('matches patient names across orthographic variations', () => {
      expect(isClientNameMatch('أحمد محمد علي', 'احمد محمد على')).toBe(true);
      expect(isClientNameMatch('د. خالد إبراهيم', 'خالد ابراهيم')).toBe(true);
      expect(isClientNameMatch('John Doe', 'John Doe')).toBe(true);
      expect(isClientNameMatch('John Doe', 'Jane Smith')).toBe(false);
    });
  });

  describe('getAccommodationCategory', () => {
    it('identifies VIP, Suite, Daycase, and Special room categories', () => {
      expect(getAccommodationCategory('330')).toBe('امبريال سويت');
      expect(getAccommodationCategory('331')).toBe('امبريال سويت');
      expect(getAccommodationCategory('332')).toBe('رويال سويت');
      expect(getAccommodationCategory('330 A')).toBe('مميز جنوبي');
      expect(getAccommodationCategory('101 - 1')).toBe('Day Case');
      expect(getAccommodationCategory('102')).toBe('مميز جنوبي');
    });
  });
});
