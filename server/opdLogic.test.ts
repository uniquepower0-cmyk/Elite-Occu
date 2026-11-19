import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import {
  getOPDSpecialtyStats,
  allocateOPDHousingGrid,
  getHousingColumnsForDay,
  formatArabicOPDFullDateTitle,
  addRefinedOPDScheduleSheet,
  addRefinedOPDTimelineSheet,
  addOPDHousingSheet,
  type OPDClinicSession,
} from './opdLogic.js';

const wedFixturePath = path.resolve(__dirname, '__fixtures__/live_opd_2026-11-18.json');
const wedSessions: OPDClinicSession[] = JSON.parse(fs.readFileSync(wedFixturePath, 'utf8')).items;

const thuFixturePath = path.resolve(__dirname, '__fixtures__/live_opd_2026-11-19.json');
const thuSessions: OPDClinicSession[] = JSON.parse(fs.readFileSync(thuFixturePath, 'utf8')).items;

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
  it('formats Arabic OPD full date title with Arabic-Indic digits', () => {
    expect(formatArabicOPDFullDateTitle('2026-11-19', thuSessions)).toBe(
      'جدول العيادات الخارجية ليوم الخميس ١٩ نوفمبر ٢٠٢٦'
    );
    expect(formatArabicOPDFullDateTitle('2026-11-18', wedSessions)).toBe(
      'جدول العيادات الخارجية ليوم الأربعاء ١٨ نوفمبر ٢٠٢٦'
    );
  });

  it('groups clinic counts by sub-clinic Specialty while filtering placeholders', () => {
    const stats = getOPDSpecialtyStats(buildSampleSessions());
    expect(stats.find(s => s.specialty === 'Audiometry clinic')?.count).toBe(1);
    expect(stats.find(s => s.specialty === 'ENT Clinic')?.count).toBe(1);
    expect(stats.find(s => s.specialty === 'General Surgery Clinic')?.count).toBe(1);

    const liveStats = getOPDSpecialtyStats(wedSessions);
    expect(liveStats.some(s => s.specialty.toLowerCase().includes('physiotherapy sessions'))).toBe(false);
  });

  it('allocates Wednesday housing grid (31 cols) without overlapping slots', () => {
    const wedCols = getHousingColumnsForDay('Wednesday');
    expect(wedCols).toHaveLength(30); // + Time col = 31
    const { assignments, unassigned } = allocateOPDHousingGrid(wedSessions, wedCols);
    expect(unassigned).toHaveLength(0);
    expect(assignments).toHaveLength(84);

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

  it('reproduces Human Thursday Housing format, exact durations, routing, borders, and 30 columns', () => {
    const thuCols = getHousingColumnsForDay('Thursday');
    expect(thuCols).toHaveLength(29); // + Time col = 30 (3 Neurosurgery clinics on Thu)
    expect(thuCols[4].label).toBe('Audiology Clinic');
    expect(thuCols[5].label).toBe('Clinic 31');

    const { assignments, unassigned } = allocateOPDHousingGrid(thuSessions, thuCols);
    expect(unassigned).toHaveLength(0);

    // Non-housing diagnostic clinics (U/S, 4D, Check Up, Prp, Hepatica) excluded from Housing
    const labels = assignments.map(a => a.displayLabel);
    expect(labels.some(l => l.includes('SMS Karem'))).toBe(false);
    expect(labels.some(l => l.includes('Prp Injection'))).toBe(false);
    expect(labels.some(l => l.includes('Hepatica'))).toBe(false);
    expect(labels.some(l => l === 'Mohamed .')).toBe(false);

    // Clinical routing checks
    const byName = (sub: string) => assignments.find(a => a.displayLabel.toLowerCase().includes(sub.toLowerCase()));
    expect(thuCols[byName('Hossam AboElKher')!.colIndex].center).toBe('GIT Center');
    expect(thuCols[byName('Manar Ezzat')!.colIndex].center).toBe('GIT Center');
    expect(thuCols[byName('Passant Samir')!.colIndex].id).toBe('gen_peds');
    expect(thuCols[byName('Wissam ElAmrawy')!.colIndex].center).toBe('Neurosurgery Center');
    expect(thuCols[byName('Mayada El Sheref')!.colIndex].id).toBe('gen_audio');
    expect(thuCols[byName('Sally Adel')!.colIndex].id).toBe('gen_31');
    expect(thuCols[byName('Bassem Hassan')!.colIndex].id).toBe('whc_plast');
    expect(byName('Shimaa Mohammed')?.displayLabel).toBe('Shimaa Mohammed\n(Nutrition)');

    // Exact fetched duration preserved (Mohamed Abdelmoneim 9:00 AM - 2:00 PM = 10 half-hour slots, slots 0..9)
    const abdelMoneim = byName('Moh. AbdElMoneim')!;
    expect(abdelMoneim.startSlot).toBe(0);
    expect(abdelMoneim.endSlot).toBe(9);

    // Verify workbook styling, spacing, colors, and TOP borders
    const wb = new ExcelJS.Workbook();
    addOPDHousingSheet(wb, thuSessions, '2026-11-19');
    const ws = wb.getWorksheet('OPD Housing')!;
    expect(ws.columnCount).toBe(30);
    expect(ws.getColumn(1).width).toBeCloseTo(37.57, 2);
    expect(ws.getColumn(2).width).toBeCloseTo(20.71, 2);
    expect(ws.getRow(1).height).toBeCloseTo(80.1, 1);
    expect(ws.getRow(3).height).toBeCloseTo(80.1, 1);
    expect(ws.getCell(1, 1).font?.size).toBe(18);
    expect(ws.getCell(2, 2).font?.size).toBe(18);
    expect(ws.getCell(3, 1).font?.size).toBe(18);
    expect((ws.getCell(1, 2).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FFA9D18E');
    expect((ws.getCell(1, 8).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe('FFF4B183');

    // Every doctor master cell MUST have top, bottom, left, right thin borders (no missing top border!)
    for (const a of assignments) {
      const cell = ws.getCell(a.startSlot + 3, a.colIndex + 2);
      expect(cell.font?.size).toBe(18);
      expect(cell.border?.top?.style).toBe('thin');
      expect(cell.border?.bottom?.style).toBe('thin');
      expect(cell.border?.left?.style).toBe('thin');
      expect(cell.border?.right?.style).toBe('thin');
    }
  });

  it('generates Refined Arabic OPD Sheet with SVG header callback and preserved matrix logic', async () => {
    const wb = new ExcelJS.Workbook();
    let capturedTitle = '';
    let capturedCols = 0;
    const captureHeader = async (_wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, title: string, numCols = 8) => {
      capturedTitle = title;
      capturedCols = numCols;
      sheet.getCell('A1').value = title;
    };

    await addRefinedOPDScheduleSheet(wb, wedSessions, '2026-11-18', captureHeader);
    const ws = wb.getWorksheet('عيادات ايليت');
    expect(ws).toBeDefined();
    expect(capturedTitle).toBe('جدول العيادات الخارجية ليوم الأربعاء ١٨ نوفمبر ٢٠٢٦');
    expect(capturedCols).toBe(8);
    expect(ws!.getRow(1).height).toBe(90);

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
    expect(joined).toContain('ولاء الامير');
    expect(joined).toContain('(سمعيات)');
    expect(joined).toContain('رسم المخ');
    expect(joined.toLowerCase()).not.toContain('physiotherapy session');
    expect(allTexts.filter(t => t.includes('مينا ادوارد')).length).toBe(2);
  });

  it('generates revised OPD Timeline cleanly from live data', async () => {
    const noopHeader = async (_wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, title: string) => {
      sheet.getCell('A1').value = title;
    };
    const wb2 = new ExcelJS.Workbook();
    await addRefinedOPDTimelineSheet(wb2, wedSessions, '2026-11-18', noopHeader);
    const timelineWs = wb2.getWorksheet('OPD Timeline');
    expect(timelineWs).toBeDefined();
    expect(timelineWs!.getCell('A1').value).toBe('الجدول الزمني للعيادات الخارجية ليوم 18/11/2026');
  });
});
