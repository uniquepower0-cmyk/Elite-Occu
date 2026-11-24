import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  addRefinedProcedureSheet,
  buildProcedureHeaderTitle,
  formatArabicWeekdayAndDate,
} from './procedureExcelGenerator';
import type { ProcedureCaseItem } from '../src/types';

const makeCase = (overrides: Partial<ProcedureCaseItem> = {}): ProcedureCaseItem => ({
  serial: '1',
  procedureDate: '2026-11-23',
  room: 'Cath Lab Theatre',
  startTime: '10:00 AM',
  endTime: '10:20 AM',
  actualStart: '',
  actualEnd: '',
  status: 'Completed',
  mrn: '275679',
  patientName: 'امل محمد احمد جاب الله',
  surgeonName: 'Ahmed Sultaan',
  engOperationName: 'Diagnostic Cerebral Angiography',
  arOperationName: 'قسطرة تشخيصية على شرايين المخ//s-Major',
  contractorName: 'جامعه دمنهور',
  paidBy: 'مريض',
  flClassName: '',
  vt: 'HC',
  postC: '',
  preparationInstructions: '',
  operativeComment: '',
  cathlabDose: 'radiation dose : 30 gycm2',
  ...overrides,
});

describe('procedureExcelGenerator', () => {
  it('formats Arabic weekday + full Arabic-Indic date headers for Cath Lab and Endoscopy', () => {
    expect(formatArabicWeekdayAndDate('2026-11-23')).toBe('الإثنين ٢٣ نوفمبر ٢٠٢٦');
    expect(buildProcedureHeaderTitle('endoscopy', '2026-11-23')).toBe('ليستة المناظير ليوم الإثنين ٢٣ نوفمبر ٢٠٢٦');
    expect(buildProcedureHeaderTitle('cathlab', '2026-11-23')).toBe('ليستة القسطرة ليوم الإثنين ٢٣ نوفمبر ٢٠٢٦');
  });

  it('generates 9-column refined Cath Lab sheet with deduplicated rows, clean op names, VIP flag, and Excel formula footer', async () => {
    const wb = new ExcelJS.Workbook();
    let capturedHeaderTitle = '';
    const cases: ProcedureCaseItem[] = [
      makeCase({ startTime: '07:55 PM', endTime: '08:15 PM', engOperationName: 'Coiling', cathlabDose: '6515' }),
      makeCase({ startTime: '07:55 PM', endTime: '08:15 PM', engOperationName: 'Coiling', cathlabDose: '30' }), // duplicate fan-out
      makeCase({ startTime: '10:00 AM', endTime: '10:20 AM', cathlabDose: '6515' }),
      makeCase({ startTime: '10:00 AM', endTime: '10:20 AM', cathlabDose: '30' }), // duplicate fan-out
    ];

    const { sheet, headerTitle, rowCount } = await addRefinedProcedureSheet(wb, 'cathlab', cases, '2026-11-23', {
      applyRefinedHeaderFn: async (_wb, _sh, title, cols) => {
        capturedHeaderTitle = `${title} [${cols}]`;
      },
      isVipFn: (name) => name.includes('امل'),
    });

    expect(headerTitle).toBe('ليستة القسطرة ليوم الإثنين ٢٣ نوفمبر ٢٠٢٦');
    expect(capturedHeaderTitle).toBe('ليستة القسطرة ليوم الإثنين ٢٣ نوفمبر ٢٠٢٦ [9]');
    expect(rowCount).toBe(2);
    expect(sheet.columnCount).toBe(9);
    // Row 4 is first patient (10:00 AM chronologically before 07:55 PM)
    expect(sheet.getRow(4).getCell(2).value).toBe('10:00 AM - 10:20 AM');
    expect(String(sheet.getRow(4).getCell(4).value)).not.toContain('//s-');
    expect(sheet.getRow(4).getCell(9).value).toBe('VIP');
    // Footer row uses dynamic Excel formula (no hardcoded totals)
    const footerCell = sheet.getRow(6).getCell(3).value as { formula?: string };
    expect(footerCell?.formula).toBe('COUNTA(C4:C5)');
  });

  it('generates refined Endoscopy sheet cleanly even when date has 0 cases', async () => {
    const wb = new ExcelJS.Workbook();
    const { headerTitle, rowCount } = await addRefinedProcedureSheet(wb, 'endoscopy', [], '2026-11-24');
    expect(headerTitle).toBe('ليستة المناظير ليوم الثلاثاء ٢٤ نوفمبر ٢٠٢٦');
    expect(rowCount).toBe(0);
  });

  it('prevents clipping on long bilingual procedures, deduplicates doubled slash op names, wraps all text columns, and normalizes Endoscopy AM->PM', async () => {
    const wb = new ExcelJS.Workbook();
    const longEndoCase = makeCase({
      procedureDate: '2026-11-24',
      room: 'Endoscopy Operation Theatre',
      startTime: '04:20 AM',
      endTime: '04:40 AM',
      engOperationName: 'Upper GIT endoscopy with biopsy and Lower GIT endoscopy with biopsy/Upper GIT endoscopy with biopsy and Lower GIT endoscopy with biopsy',
      arOperationName: 'منظار جهاز هضمي علوي مع اخذ عينه و منظار جهاز هضمي سفلي مع اخذ عينه',
      contractorName: 'شركة مصر للطيران للشحن الجوي بالاسكندرية',
    });

    const { sheet } = await addRefinedProcedureSheet(wb, 'endoscopy', [longEndoCase], '2026-11-24');
    const row4 = sheet.getRow(4);
    // Timing normalized to PM
    expect(row4.getCell(2).value).toBe('04:20 PM - 04:40 PM');
    // Doubled slash English op name deduplicated
    const procVal = String(row4.getCell(4).value);
    expect(procVal.split('Upper GIT endoscopy').length - 1).toBe(1);
    // All text columns (2..8) have wrapText enabled
    for (let col = 2; col <= 8; col++) {
      expect(row4.getCell(col).alignment?.wrapText).toBe(true);
    }
    // Dynamic row height is tall enough to show all wrapped bilingual lines without clipping
    expect(row4.height).toBeGreaterThanOrEqual(70);
  });
});
