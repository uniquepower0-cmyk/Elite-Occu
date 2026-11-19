import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import {
  getOPDSpecialtyStats,
  allocateOPDHousingGrid,
  addRefinedOPDScheduleSheet,
  addRefinedOPDTimelineSheet,
  addOPDHousingSheet,
  type OPDClinicSession,
} from './opdLogic.js';

const fixturePath = path.resolve(__dirname, '__fixtures__/live_opd_2026-11-18.json');
const liveFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const liveSessions: OPDClinicSession[] = liveFixture.items;

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

function cellText(val: ExcelJS.CellValue): string {
  if (!val) return '';
  if (typeof val === 'object' && 'richText' in val && Array.isArray(val.richText)) {
    return val.richText.map(r => r.text).join('');
  }
  return String(val);
}

describe('opdLogic', () => {
  it('groups clinic counts by sub-clinic Specialty while filtering placeholders', () => {
    const stats = getOPDSpecialtyStats(buildSampleSessions());
    expect(stats.find(s => s.specialty === 'Audiometry clinic')?.count).toBe(1);
    expect(stats.find(s => s.specialty === 'ENT Clinic')?.count).toBe(1);
    expect(stats.find(s => s.specialty === 'General Surgery Clinic')?.count).toBe(1);

    const liveStats = getOPDSpecialtyStats(liveSessions);
    expect(liveStats.some(s => s.specialty.toLowerCase().includes('physiotherapy sessions'))).toBe(false);
  });

  it('allocates housing grid for all 84 filtered live sessions without overlapping slots', () => {
    const { assignments, unassigned } = allocateOPDHousingGrid(liveSessions);
    expect(unassigned).toHaveLength(0);
    expect(assignments).toHaveLength(84);

    // No physiotherapy technician sessions in assignments
    expect(
      assignments.some(a => a.displayLabel.toLowerCase().includes('physiotherapy session'))
    ).toBe(false);

    // No overlapping slots in the same column
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

  it('generates Refined Arabic OPD Sheet matching Elite PDF layout, colors, and keeping duplicates', async () => {
    const wb = new ExcelJS.Workbook();
    await addRefinedOPDScheduleSheet(wb, liveSessions, '2026-11-18');
    const ws = wb.getWorksheet('عيادات ايليت');
    expect(ws).toBeDefined();

    // Row 1 day banner
    expect(ws!.getCell('D1').value).toBe('الأربعاء');
    expect((ws!.getCell('D1').fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FF00FFCC');

    // Collect all cell text
    const allTexts: string[] = [];
    ws!.eachRow(row => {
      row.eachCell(cell => {
        const txt = cellText(cell.value);
        if (txt) allTexts.push(txt);
      });
    });

    const joined = allTexts.join('\n');
    expect(joined).toContain('أنف و أذن و حنجرة');
    expect(joined).toContain('جراحة عامة');
    expect(joined).toContain('جراحات الغدد الصماء والسمنه');
    expect(joined).toContain('ولاء الامير');
    expect(joined).toContain('(سمعيات)');
    expect(joined).toContain('رسم المخ');
    expect(joined).toContain('عمرو صبري');
    expect(joined).toContain('بيشوي');

    // Zero Physiotherapy Sessions placeholders
    expect(joined.toLowerCase()).not.toContain('physiotherapy session');

    // Verify no stray 2:30 next to Nehad ElMofty
    const nehadCell = allTexts.find(t => t.includes('نهاد المفتي'));
    expect(nehadCell).toBeDefined();
    expect(nehadCell).not.toContain('2:30');

    // Verify duplicates are kept (Mina Edward x2 in Ortho)
    const minaCells = allTexts.filter(t => t.includes('مينا ادوارد'));
    expect(minaCells.length).toBe(2);
  });

  it('generates revised OPD Timeline and OPD Housing sheets cleanly from live data', async () => {
    const noopHeader = async (_wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, title: string) => {
      sheet.getCell('A1').value = title;
    };

    const wb2 = new ExcelJS.Workbook();
    await addRefinedOPDTimelineSheet(wb2, liveSessions, '2026-11-18', noopHeader);
    const timelineWs = wb2.getWorksheet('OPD Timeline');
    expect(timelineWs).toBeDefined();
    expect(timelineWs!.getCell('A1').value).toBe('الجدول الزمني للعيادات الخارجية ليوم 18/11/2026');

    const timelineTexts: string[] = [];
    timelineWs!.eachRow(row => {
      row.eachCell(cell => {
        const txt = cellText(cell.value);
        if (txt) timelineTexts.push(txt);
      });
    });
    expect(timelineTexts.join('\n').toLowerCase()).not.toContain('physiotherapy session');
    expect(timelineTexts.join('\n')).toContain('أنف و أذن و حنجرة');

    const wb3 = new ExcelJS.Workbook();
    addOPDHousingSheet(wb3, liveSessions, '2026-11-18');
    const housingWs = wb3.getWorksheet('OPD Housing');
    expect(housingWs).toBeDefined();
    expect(housingWs!.getCell(1, 1).value).toBe('Wednesday');
    expect(housingWs!.getCell(2, 1).value).toBe('Time');
    expect(housingWs!.getCell(3, 1).value).toBe('9:00 - 9:30 AM');
    expect((housingWs!.getCell(1, 2).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FFA9D08E');
  });
});
