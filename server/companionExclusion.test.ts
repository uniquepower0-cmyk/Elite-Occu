import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { isCompanionBed } from './nameUtils';
import { getOccupancyRows } from './occupancyLogic';
import { addOccupancySheet, addRefinedExitSheet } from './excelGenerators';
import { isCompanionBed as isClientCompanionBed, filterPatientData } from '../src/logic/occupancy';

describe('Companion Bed Detection & Exclusion', () => {
  const companionBeds = [
    'Bed 405 C',
    '405 C',
    'Bed 405 D',
    'Bed 421 B',
    'Bed 306 C',
    'Bed 320c',
    'Bed 402A - C ',
    'Bed 408 C I',
    'Bed 408 C II',
    'Bed 308 - 1 c',
    'Bed 102 - C1',
    'Bed 102 - C 2',
    '304 C 2',
    '319 C',
    'Bed 407 c',
    'Bed 407 C2',
    'Bed 409 C',
    'Companion 1',
    'مرافق 405',
  ];

  const realPatientBeds = [
    'Bed 405 A',
    'Bed 405 B',
    '405 A',
    'Bed 407',
    'Bed 409',
    'Bed 421',
    'Bed 421 A',
    'Bed 307 intermediate care',
    'Home Care 32',
    'VIP CCU',
    'CCU Bed 2',
    'ICU Bed 7',
    'Bed 103 - 1',
    'Bed 330 A',
    'Bed 331 B',
  ];

  it('detects all HMIS companion beds on both server and client helpers', () => {
    for (const bed of companionBeds) {
      expect(isCompanionBed(bed), `server isCompanionBed(${bed})`).toBe(true);
      expect(isClientCompanionBed(bed), `client isCompanionBed(${bed})`).toBe(true);
    }
  });

  it('does not flag real inpatient or critical care beds as companions', () => {
    for (const bed of realPatientBeds) {
      expect(isCompanionBed(bed), `server isCompanionBed(${bed})`).toBe(false);
      expect(isClientCompanionBed(bed), `client isCompanionBed(${bed})`).toBe(false);
    }
  });

  it('excludes companion beds from getOccupancyRows and filterPatientData while keeping patient rows with companion notes', () => {
    const header = [
      'AdmissionDate', 'Bed', 'MRN', 'Patient', 'DefaultMobile', 'Financial Status',
      'Age', 'Floor Name', 'Notes', 'VisitType', 'PaymentBy', 'FloorStructureName_EN',
      'ContractorName', ...Array(9).fill(''), 'TreatingPhysicianName', ...Array(17).fill(''),
    ];
    const patientRow = Array(40).fill('');
    patientRow[0] = '17-11-2026 05:59';
    patientRow[1] = 'Bed 405 A';
    patientRow[2] = '0000004447';
    patientRow[3] = 'سهير ابراهيم مصطفى صيام';
    patientRow[8] = 'مرافق باهر محمد منصور مصطفى'; // companion note on real patient row
    patientRow[12] = 'Cash';
    patientRow[22] = 'Ahmed Moustafa Fouad Mohamed';

    const companionRow = Array(40).fill('');
    companionRow[0] = '17-11-2026 05:59';
    companionRow[1] = 'Bed 405 C';
    companionRow[2] = '';
    companionRow[3] = 'باهر محمد منصور مصطفى';
    companionRow[12] = 'Cash';
    companionRow[22] = 'Ahmed Moustafa Fouad Mohamed';

    const data = [Array(40).fill(''), Array(40).fill(''), header, patientRow, companionRow];

    const occRows = getOccupancyRows(data).slice(3);
    expect(occRows.length).toBe(1);
    expect(occRows[0][1]).toBe('سهير ابراهيم مصطفى صيام');

    const clientRows = filterPatientData(data);
    expect(clientRows.length).toBe(1);
    expect(clientRows[0].name).toBe('سهير ابراهيم مصطفى صيام');
  });

  it('excludes companion beds from downloadable Occupancy and Refined Exit Excel sheets', async () => {
    const wb = new ExcelJS.Workbook();
    const occInput = [
      ['', '', '', '', '', ''],
      ['', '', '', '', '', ''],
      ['Room', 'Patient', 'Physician', 'Contractor', 'Date', 'MRN'],
      ['405 A', 'سهير ابراهيم مصطفى صيام', 'Dr. Ahmed', 'Cash', '17-11-2026 05:59', '4447'],
      ['405 C', 'باهر محمد منصور مصطفى', 'Dr. Ahmed', 'Cash', '17-11-2026 05:59', ''],
      ['405 D', 'مرافق ثاني', 'Dr. Ahmed', 'Cash', '17-11-2026 05:59', ''],
      ['421 B', 'مرافق 421', 'Dr. Ahmed', 'Cash', '17-11-2026 05:59', ''],
    ];
    addOccupancySheet(wb, occInput);
    const occSheet = wb.getWorksheet('Formatted Occupancy')!;
    const occText: string[] = [];
    occSheet.eachRow((row) => occText.push(row.values.toString()));
    const joinedOcc = occText.join('\n');
    expect(joinedOcc).toContain('سهير ابراهيم مصطفى صيام');
    expect(joinedOcc).not.toContain('باهر محمد منصور مصطفى');
    expect(joinedOcc).not.toContain('مرافق ثاني');
    expect(joinedOcc).not.toContain('مرافق 421');

    const exitWb = new ExcelJS.Workbook();
    await addRefinedExitSheet(exitWb, [
      { room: 'Bed 409', name: 'محمد عيد نجا نجا', physician: 'Salah Elgohary', contractor: 'Next Care', mrn: '76914' },
      { room: 'Bed 405 C', name: 'باهر محمد منصور مصطفى', physician: '', contractor: '', mrn: '' },
      { room: 'Bed 405 A', name: 'مرافق مؤشر', physician: '', contractor: '', mrn: '', isCompanion: true },
    ]);
    const exitSheet = exitWb.getWorksheet('Formatted Exit')!;
    const exitText: string[] = [];
    exitSheet.eachRow((row) => exitText.push(row.values.toString()));
    const joinedExit = exitText.join('\n');
    expect(joinedExit).toContain('محمد عيد نجا نجا');
    expect(joinedExit).not.toContain('باهر محمد منصور مصطفى');
    expect(joinedExit).not.toContain('مرافق مؤشر');
  });
});
