import { describe, it, expect } from 'vitest';
import fs from 'fs';
import ExcelJS from 'exceljs';
import {
  parseOPDDoctorsExcel,
  getOPDSpecialtyStats,
  allocateOPDHousingGrid,
  addRefinedOPDScheduleSheet,
  addRefinedOPDTimelineSheet,
  addOPDHousingSheet,
  type OPDClinicSession,
} from './opdLogic.js';

const DOWNLOADED_SAMPLE = '/Users/mohanad/Downloads/Elite/data - 2026-11-17T184341.056.xlsx';

function buildSampleSessions(): OPDClinicSession[] {
  return [
    {
      serial: '1',
      day: 18,
      weekName: 'Wednesday',
      startTime: '12:00 PM',
      endTime: '01:00 PM',
      specialty: 'General Surgery Clinic',
      specialities: 'General Surgery',
      physicianEn: 'Mohamed nafaa',
      physicianAr: 'محمد نافع',
      floorName: '1',
      supervisoryLevel: 'Consultant',
      maxOccupancy: 1,
      schedules: 1,
      opdDate: '2026-11-18',
    },
    {
      serial: '2',
      day: 18,
      weekName: 'Wednesday',
      startTime: '11:00 AM',
      endTime: '01:00 PM',
      specialty: 'Audiometry clinic',
      specialities: 'ENT',
      physicianEn: 'Alia Elkaraksy',
      physicianAr: 'عالية القراقصى',
      floorName: '1',
      supervisoryLevel: 'Consultant',
      maxOccupancy: 0,
      schedules: 1,
      opdDate: '2026-11-18',
    },
    {
      serial: '3',
      day: 18,
      weekName: 'Wednesday',
      startTime: '10:00 AM',
      endTime: '01:30 PM',
      specialty: 'ENT Clinic',
      specialities: 'ENT',
      physicianEn: 'Walaa Elamir',
      physicianAr: 'ولاء الامير',
      floorName: '1',
      supervisoryLevel: 'Consultant',
      maxOccupancy: 11,
      schedules: 1,
      opdDate: '2026-11-18',
    },
  ];
}

describe('opdLogic', () => {
  it('groups clinic counts by sub-clinic Specialty (Option B)', () => {
    const stats = getOPDSpecialtyStats(buildSampleSessions());
    expect(stats.find(s => s.specialty === 'Audiometry clinic')?.count).toBe(1);
    expect(stats.find(s => s.specialty === 'ENT Clinic')?.count).toBe(1);
    expect(stats.find(s => s.specialty === 'General Surgery Clinic')?.count).toBe(1);
  });

  it('allocates housing grid without overlapping time slots in the same column', () => {
    const sessions = buildSampleSessions();
    const { assignments } = allocateOPDHousingGrid(sessions);
    expect(assignments).toHaveLength(3);
    for (let i = 0; i < assignments.length; i++) {
      for (let j = i + 1; j < assignments.length; j++) {
        if (assignments[i].colIndex === assignments[j].colIndex) {
          const overlaps =
            assignments[i].startSlot <= assignments[j].endSlot &&
            assignments[j].startSlot <= assignments[i].endSlot;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  it('generates all 3 downloadable Excel sheets cleanly', async () => {
    const sessions = fs.existsSync(DOWNLOADED_SAMPLE)
      ? parseOPDDoctorsExcel(fs.readFileSync(DOWNLOADED_SAMPLE), '2026-11-18').items
      : buildSampleSessions();

    if (fs.existsSync(DOWNLOADED_SAMPLE)) {
      expect(sessions.length).toBe(98);
    }

    const noopHeader = async (_wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, title: string) => {
      sheet.getCell('A1').value = title;
    };

    const wb1 = new ExcelJS.Workbook();
    await addRefinedOPDScheduleSheet(wb1, sessions, '2026-11-18', noopHeader);
    expect(wb1.getWorksheet('OPD Schedule')?.getCell('A1').value).toBe('جدول العيادات الخارجية ليوم 18/11/2026');

    const wb2 = new ExcelJS.Workbook();
    await addRefinedOPDTimelineSheet(wb2, sessions, '2026-11-18', noopHeader);
    expect(wb2.getWorksheet('OPD Timeline')?.getCell('A1').value).toBe('الجدول الزمني للعيادات الخارجية ليوم 18/11/2026');

    const wb3 = new ExcelJS.Workbook();
    addOPDHousingSheet(wb3, sessions, '2026-11-18');
    const housingWs = wb3.getWorksheet('OPD Housing');
    expect(housingWs).toBeDefined();
    expect(housingWs?.getCell(1, 1).value).toBe('Wednesday');
    expect(housingWs?.getCell(2, 1).value).toBe('Time');
    expect(housingWs?.getCell(3, 1).value).toBe('9:00 - 9:30 AM');
  });
});
