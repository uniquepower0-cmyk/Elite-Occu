import { describe, it, expect } from 'vitest';
import { getResponsibleOfficer, isCashContractor, CASH_OFFICER_NAME } from './contractorOfficers.js';
import { getOverListPatients } from './orLogic.js';

describe('contractorOfficers', () => {
  it('maps عقد الرياض El Rayad to السياحة العلاجية instead of حسابات المرضى', () => {
    expect(isCashContractor('عقد الرياض El Rayad')).toBe(false);
    expect(getResponsibleOfficer('عقد الرياض El Rayad')).toBe('السياحة العلاجية');
    expect(getResponsibleOfficer('عقد الرياض')).toBe('السياحة العلاجية');
    expect(getResponsibleOfficer('El Rayad')).toBe('السياحة العلاجية');
  });

  it('still maps cash contractors to حسابات المرضى', () => {
    expect(isCashContractor('Cash')).toBe(true);
    expect(getResponsibleOfficer('Cash')).toBe(CASH_OFFICER_NAME);
  });
});

describe('getOverListPatients (30-column layout)', () => {
  it('extracts patient name, contractor, physician, and admission date without age/LOS column shifts', () => {
    const headerRow = new Array(30).fill('');
    headerRow[0] = 'AdmissionDate';
    headerRow[1] = 'Bed#';
    headerRow[2] = 'Patient Name';
    headerRow[3] = 'Age';
    headerRow[6] = 'Contractor Name';
    headerRow[12] = 'LOS';
    headerRow[14] = 'TreatingPhysicianName';

    const row30 = new Array(30).fill('');
    row30[0] = '17-11-2026 06:24';
    row30[1] = 'OR - 3';
    row30[2] = 'اسماء رشاد عثمان محمد';
    row30[3] = '46';
    row30[6] = 'عقد الرياض El Rayad';
    row30[12] = '1.008333333';
    row30[14] = 'د. احمد علي';

    const data = [new Array(30).fill(''), new Array(30).fill(''), headerRow, row30];
    const overList = getOverListPatients(data, []);

    expect(overList).toHaveLength(1);
    expect(overList[0].room).toBe('OR - 3');
    expect(overList[0].patientName).toBe('اسماء رشاد عثمان محمد');
    expect(overList[0].contractor).toBe('عقد الرياض El Rayad');
    expect(overList[0].physician).toBe('د. احمد علي');
  });
});
