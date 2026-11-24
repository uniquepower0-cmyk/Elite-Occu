import ExcelJS from 'exceljs';
import type { ProcedureCaseItem } from '../src/types';
import { cleanContractorForDisplay, getResponsibleOfficer } from './contractorOfficers.js';
import { cleanProcedureOpName, dedupeProcedureCases, parseProcedureTimeMinutes } from './newFeedsLogic.js';

const ARABIC_WEEKDAYS = [
  'الأحد',
  'الإثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
];

const ARABIC_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

export type ApplyRefinedHeaderFn = (
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  title: string,
  numCols?: number,
) => Promise<void>;

export function toArabicIndicDigits(input: string | number): string {
  const digits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return String(input).replace(/\d/g, (d) => digits[Number(d)]);
}

/**
 * Formats an ISO date YYYY-MM-DD into Arabic weekday + full Arabic-Indic date:
 * e.g. "الإثنين ٢٣ نوفمبر ٢٠٢٦"
 */
export function formatArabicWeekdayAndDate(isoDate: string): string {
  const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const yr = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const dy = parseInt(m[3], 10);
  // Use UTC noon to avoid timezone day-shift
  const d = new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0));
  const weekday = ARABIC_WEEKDAYS[d.getUTCDay()] || '';
  const monthName = ARABIC_MONTHS[mo - 1] || toArabicIndicDigits(mo);
  return `${weekday} ${toArabicIndicDigits(dy)} ${monthName} ${toArabicIndicDigits(yr)}`.trim();
}

export function buildProcedureHeaderTitle(unit: 'cathlab' | 'endoscopy', isoDate: string): string {
  const prefix = unit === 'endoscopy' ? 'ليستة المناظير' : 'ليستة القسطرة';
  const arabicDate = formatArabicWeekdayAndDate(isoDate);
  return arabicDate ? `${prefix} ليوم ${arabicDate}` : prefix;
}

function getUnitTheme(unit: 'cathlab' | 'endoscopy'): { badge: string; row: string; sheetName: string } {
  if (unit === 'endoscopy') {
    return {
      badge: 'FF1565C0',
      row: 'FFEBF5FB',
      sheetName: 'Endoscopy List - ليستة المناظير',
    };
  }
  return {
    badge: 'FFAD1457',
    row: 'FFFFEBEF',
    sheetName: 'Cath Lab List - ليستة القسطرة',
  };
}

export function computeWrappedRowHeight(values: Array<string | number>, colWidths: number[]): number {
  let maxLines = 1;
  for (let i = 0; i < values.length; i++) {
    const text = String(values[i] ?? '').trim();
    if (!text) continue;
    const width = colWidths[i] || 18;
    // Bold Calibri 11 Arabic/Latin glyphs take ~1.3x width; use conservative 0.72 effective chars per column unit
    const effectiveCharsPerLine = Math.max(8, Math.floor(width * 0.72));
    const paragraphs = text.split(/\r?\n/);
    let totalLines = 0;
    for (const para of paragraphs) {
      const len = para.trim().length;
      totalLines += Math.max(1, Math.ceil(len / effectiveCharsPerLine));
    }
    if (totalLines > maxLines) maxLines = totalLines;
  }
  return Math.max(28, Math.round(maxLines * 18.5 + 14));
}

/**
 * Generates a refined 9-column Excel sheet matching addRefinedOccupancySheet's exact aesthetic:
 * - Row 1: Composited SVG header banner on Mohanad's header_bg.png
 * - Row 2: Dark slate (#37474F) bilingual column headers
 * - Room separator bands + soft pastel tinted patient rows + red bold VIP status
 * - Full-visibility cell wrapping across all text columns + dynamic column widths & row heights
 * - Dynamic Excel formula footer (=COUNTA(...)) with zero hardcoded totals
 */
export async function addRefinedProcedureSheet(
  workbook: ExcelJS.Workbook,
  unit: 'cathlab' | 'endoscopy',
  cases: ProcedureCaseItem[],
  targetDate: string,
  options: {
    applyRefinedHeaderFn?: ApplyRefinedHeaderFn;
    isVipFn?: (name: string) => boolean;
  } = {},
): Promise<{ sheet: ExcelJS.Worksheet; headerTitle: string; rowCount: number }> {
  const theme = getUnitTheme(unit);
  const sheet = workbook.addWorksheet(theme.sheetName, {
    views: [{ rightToLeft: false }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25, header: 0.1, footer: 0.1 },
    },
  });

  const numCols = 9;
  const headerTitle = buildProcedureHeaderTitle(unit, targetDate);

  // Row 1: Refined SVG Header Banner (generous 96pt height for long Arabic titles)
  sheet.mergeCells('A1:I1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 96;

  if (options.applyRefinedHeaderFn) {
    await options.applyRefinedHeaderFn(workbook, sheet, headerTitle, numCols);
  } else {
    titleCell.value = headerTitle;
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF3F5' } };
    titleCell.font = { bold: true, size: 20, name: 'Calibri', color: { argb: 'FF000000' } };
  }

  // Row 2: 9 Occupancy-style bilingual columns
  const headerLabels = [
    '# / الرقم',
    'التوقيت / Timing',
    'اسم المريض / Patient Name',
    'الإجراء / Procedure',
    'الطبيب المعالج / Physician',
    'التعاقد / Contract',
    'مسئول التعاقد',
    'نوع الحالة / Case Type',
    'VIP STATUS',
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } };
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } },
    };
  });

  const cleanCases = dedupeProcedureCases(cases || [], unit).sort(
    (a, b) => parseProcedureTimeMinutes(a.startTime) - parseProcedureTimeMinutes(b.startTime),
  );

  // Pre-compute dynamic column widths from content within balanced landscape A4 bounds
  const colWidths = [8, 22, 30, 50, 26, 28, 18, 15, 13];
  for (const c of cleanCases) {
    const nameLen = String(c.patientName || '').length;
    const opMaxLine = Math.max(
      cleanProcedureOpName(c.engOperationName).length,
      cleanProcedureOpName(c.arOperationName).length,
    );
    const physLen = String(c.surgeonName || '').length;
    const rawC = c.contractorName || c.paidBy || '';
    const contractLen = (cleanContractorForDisplay(rawC) || rawC).length;
    const officerLen = (getResponsibleOfficer(rawC) || '').length;

    colWidths[2] = Math.min(38, Math.max(colWidths[2], nameLen + 4));
    colWidths[3] = Math.min(60, Math.max(colWidths[3], Math.min(60, opMaxLine + 4)));
    colWidths[4] = Math.min(34, Math.max(colWidths[4], physLen + 4));
    colWidths[5] = Math.min(38, Math.max(colWidths[5], contractLen + 4));
    colWidths[6] = Math.min(24, Math.max(colWidths[6], officerLen + 4));
  }

  // Group by room
  const groupedByRoom: { roomName: string; items: ProcedureCaseItem[] }[] = [];
  for (const c of cleanCases) {
    const rName = c.room || (unit === 'endoscopy' ? 'Endoscopy Operation Theatre' : 'Cath Lab Theatre');
    let grp = groupedByRoom.find((g) => g.roomName === rName);
    if (!grp) {
      grp = { roomName: rName, items: [] };
      groupedByRoom.push(grp);
    }
    grp.items.push(c);
  }

  let serial = 1;
  const dataRowIndices: number[] = [];

  if (groupedByRoom.length === 0) {
    const emptyRowIdx = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '', '', '', '']);
    sheet.mergeCells(emptyRowIdx, 1, emptyRowIdx, numCols);
    const cell = sheet.getCell(emptyRowIdx, 1);
    cell.value =
      unit === 'endoscopy'
        ? 'لا توجد حالات مناظير مجدولة لهذا اليوم / No Endoscopy cases scheduled for this date'
        : 'لا توجد حالات قسطرة مجدولة لهذا اليوم / No Cath Lab cases scheduled for this date';
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.font = { italic: true, size: 11, name: 'Calibri', color: { argb: 'FF64748B' } };
    sheet.getRow(emptyRowIdx).height = 30;
  } else {
    for (const grp of groupedByRoom) {
      const sepRowIdx = sheet.rowCount + 1;
      sheet.addRow(['', '', '', '', '', '', '', '', '']);
      sheet.mergeCells(sepRowIdx, 1, sepRowIdx, numCols);
      const sepCell = sheet.getCell(sepRowIdx, 1);
      sepCell.value = `■  ${grp.roomName}  ■`;
      sepCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.badge } };
      sepCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
      sepCell.alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getRow(sepRowIdx).height = 26;

      for (const c of grp.items) {
        const timingStr = c.startTime || c.endTime ? `${c.startTime || '—'} - ${c.endTime || '—'}` : '—';
        const opEn = cleanProcedureOpName(c.engOperationName);
        const opAr = cleanProcedureOpName(c.arOperationName);
        const procText = opEn && opAr ? `${opEn}\n${opAr}` : opEn || opAr || '—';
        const rawContractor = c.contractorName || c.paidBy || '';
        const cleanedContractor = cleanContractorForDisplay(rawContractor) || rawContractor || '—';
        const officer = getResponsibleOfficer(rawContractor) || '';
        const caseType = c.vt || '—';
        const isVip = options.isVipFn ? options.isVipFn(c.patientName || '') : false;

        const rowValues = [
          serial++,
          timingStr,
          c.patientName || '—',
          procText,
          c.surgeonName || '—',
          cleanedContractor,
          officer,
          caseType,
          isVip ? 'VIP' : '',
        ];

        const pRow = sheet.addRow(rowValues);
        dataRowIndices.push(pRow.number);
        pRow.height = computeWrappedRowHeight(rowValues, colWidths);
        pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.row } };
          cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: colNumber >= 2 && colNumber <= 8 };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
            bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
            left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
            right: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          };
          const isBold = colNumber >= 2 && colNumber <= 6;
          cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' }, bold: isBold };
          if (colNumber === 8 && caseType !== '—') {
            cell.font = {
              bold: true,
              name: 'Calibri',
              size: 11,
              color: { argb: caseType.toUpperCase() === 'DC' ? 'FF1565C0' : 'FF2E7D32' },
            };
          }
          if (colNumber === 9) {
            cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } };
          }
        });
      }
    }

    // Dynamic Excel formula summary footer (zero hardcoded totals)
    const firstRow = dataRowIndices[0];
    const lastRow = dataRowIndices[dataRowIndices.length - 1];
    const footerRow = sheet.addRow([
      '',
      'إجمالي الحالات / Total',
      { formula: `COUNTA(C${firstRow}:C${lastRow})-${groupedByRoom.length - 1}` },
      '',
      '',
      '',
      '',
      '',
      { formula: `COUNTIF(I${firstRow}:I${lastRow},"VIP")` },
    ]);
    if (groupedByRoom.length === 1) {
      footerRow.getCell(3).value = { formula: `COUNTA(C${firstRow}:C${lastRow})` };
    }
    footerRow.height = 26;
    footerRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEFF1' } };
      cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FF1E293B' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF37474F' } },
        bottom: { style: 'medium', color: { argb: 'FF37474F' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      };
    });
  }

  sheet.columns = colWidths.map((w) => ({ width: w }));

  return { sheet, headerTitle, rowCount: cleanCases.length };
}
