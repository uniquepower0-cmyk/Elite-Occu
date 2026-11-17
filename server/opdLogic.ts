import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

export interface OPDClinicSession {
  serial: string;
  day: number;
  weekName: string;
  startTime: string;
  endTime: string;
  specialty: string;
  specialities: string;
  physicianEn: string;
  physicianAr: string;
  floorName: string;
  supervisoryLevel: string;
  maxOccupancy: number;
  schedules: number;
  opdDate: string;
}

export interface OPDSpecialtyStat {
  specialty: string;
  count: number;
  maxOccupancy: number;
  floor1Count: number;
  floorMCount: number;
}

export interface HousingClinicColumn {
  id: string;
  center: string;
  centerColor: string;
  centerTextColor: string;
  label: string;
}

export interface HousingAssignment {
  session: OPDClinicSession;
  colIndex: number;
  startSlot: number;
  endSlot: number;
  displayLabel: string;
}

export type ApplyRefinedHeaderFn = (
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  title: string,
  numCols?: number
) => Promise<void>;

export function parseTimeToMinutes(timeStr: any): number | null {
  if (timeStr === undefined || timeStr === null) return null;
  if (typeof timeStr === 'number' && !isNaN(timeStr)) {
    // Excel fractional day (0..1)
    if (timeStr >= 0 && timeStr < 1) {
      return Math.round(timeStr * 24 * 60);
    }
  }
  const s = String(timeStr).trim();
  if (!s) return null;

  // ISO datetime or "HH:MM:SS"
  const lower = s.toLowerCase();
  const isPM = lower.includes('pm') || lower.includes('مساء') || lower.includes('م');
  const isAM = lower.includes('am') || lower.includes('صباح') || lower.includes('ص');

  const timePartMatch = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!timePartMatch) return null;
  let h = parseInt(timePartMatch[1], 10);
  const m = parseInt(timePartMatch[2], 10);
  if (isNaN(h) || isNaN(m)) return null;

  if (isPM && h < 12) h += 12;
  else if (isAM && h === 12) h = 0;

  return h * 60 + m;
}

export function formatMinutesTo12h(mins: number): string {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function normalizeOPDTime12h(raw: any): string {
  const mins = parseTimeToMinutes(raw);
  if (mins !== null) return formatMinutesTo12h(mins);
  return String(raw || '').trim();
}

export function formatOPDDisplayDate(dateStr: string): string {
  const m = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(dateStr || '').trim();
}

/**
 * Parses an uploaded "OPD doctors Sheet" (.xlsx/.xls/.csv) into normalized OPDClinicSession records.
 */
export function parseOPDDoctorsExcel(
  buffer: Buffer,
  fallbackDateStr: string = ''
): { items: OPDClinicSession[]; opdDate: string } {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { items: [], opdDate: fallbackDateStr };

  const ws = workbook.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!rows || rows.length === 0) return { items: [], opdDate: fallbackDateStr };

  // Try extracting YYYY-MM-DD or Year+month+day from "Applied filters:" banner row
  let detectedDate = fallbackDateStr;
  for (let i = 0; i < Math.min(4, rows.length); i++) {
    const rowText = rows[i].map(c => String(c || '')).join(' ');
    const ymMatch = rowText.match(/(\d{4})\s*\(Year\)\s*\+\s*(\d{1,2})\s*\(month\)\s*\+\s*(\d{1,2})\s*\(day\)/i);
    if (ymMatch) {
      detectedDate = `${ymMatch[1]}-${String(Number(ymMatch[2])).padStart(2, '0')}-${String(Number(ymMatch[3])).padStart(2, '0')}`;
      break;
    }
  }

  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = rows[i].map(c => String(c || '').toLowerCase().trim()).filter(Boolean);
    if (cells.length >= 4 && cells.some(c => c === 'physicians' || c === 'specialty' || c === 'start time')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { items: [], opdDate: detectedDate };

  const headers = rows[headerIdx].map(c => String(c || '').toLowerCase().trim());
  const findCol = (names: string[], fallback: number): number => {
    for (const n of names) {
      const idx = headers.findIndex(h => h === n.toLowerCase());
      if (idx >= 0) return idx;
    }
    for (const n of names) {
      if (n.length <= 3) continue;
      const idx = headers.findIndex(h => h.includes(n.toLowerCase()));
      if (idx >= 0) return idx;
    }
    return fallback;
  };

  const idxDay = findCol(['day'], 0);
  const idxWeek = findCol(['weekname', 'week name'], 1);
  const idxStart = findCol(['start time', 'starttime'], 2);
  const idxSpecialty = findCol(['specialty'], 3);
  const idxPhysEn = findCol(['physicians', 'englishfullname', 'physician en'], 4);
  const idxFloor = findCol(['floor name', 'floor'], 5);
  const idxLevel = findCol(['flsupervisorylevelname', 'supervisory level', 'level'], 6);
  const idxMaxOcc = findCol(['sum of maxoccupancy', 'maxoccupancy', 'max occupancy'], 7);
  const idxPhysAr = findCol(['physician name'], 8);
  const idxSpecialities = findCol(['specialities'], 9);
  const idxEnd = findCol(['end time', 'endtime'], 10);
  const idxSchedules = findCol(['schedules'], 11);

  const cleanStr = (v: any) =>
    String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  const items: OPDClinicSession[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !Array.isArray(row)) continue;

    const physicianEn = cleanStr(row[idxPhysEn]);
    const physicianAr = cleanStr(row[idxPhysAr]);
    const specialty = cleanStr(row[idxSpecialty]);
    const specialities = cleanStr(row[idxSpecialities]);

    if (!physicianEn && !physicianAr && !specialty) continue;
    if (['physicians', 'total', 'applied filters:'].includes(physicianEn.toLowerCase())) continue;

    const dayNum = parseInt(String(row[idxDay] || '0'), 10) || 0;
    const maxOcc = parseInt(String(row[idxMaxOcc] || '0'), 10) || 0;
    const schedules = parseInt(String(row[idxSchedules] || '1'), 10) || 1;

    items.push({
      serial: String(items.length + 1),
      day: dayNum,
      weekName: cleanStr(row[idxWeek]),
      startTime: normalizeOPDTime12h(row[idxStart]),
      endTime: normalizeOPDTime12h(row[idxEnd]),
      specialty: specialty || specialities,
      specialities: specialities || specialty,
      physicianEn,
      physicianAr,
      floorName: cleanStr(row[idxFloor]),
      supervisoryLevel: cleanStr(row[idxLevel]),
      maxOccupancy: maxOcc,
      schedules,
      opdDate: detectedDate,
    });
  }

  return { items, opdDate: detectedDate };
}

/**
 * Aggregates clinic counts and capacity grouped by sub-clinic `Specialty` (Option B).
 */
export function getOPDSpecialtyStats(items: OPDClinicSession[]): OPDSpecialtyStat[] {
  const map = new Map<string, OPDSpecialtyStat>();
  for (const item of items || []) {
    const key = (item.specialty || item.specialities || 'Other').trim();
    const existing = map.get(key) || {
      specialty: key,
      count: 0,
      maxOccupancy: 0,
      floor1Count: 0,
      floorMCount: 0,
    };
    existing.count += 1;
    existing.maxOccupancy += Number(item.maxOccupancy || 0);
    const fl = String(item.floorName || '').trim().toLowerCase();
    if (fl === '1') existing.floor1Count += 1;
    else if (fl === 'm') existing.floorMCount += 1;
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || a.specialty.localeCompare(b.specialty));
}

// --- OPD HOUSING GRID ALLOCATOR (Matches /Users/mohanad/Downloads/OPD Housing) ---

export const OPD_HOUSING_COLUMNS: HousingClinicColumn[] = [
  // General OPD (6)
  { id: 'gen_peds', center: 'General OPD', centerColor: 'FFA9D08E', centerTextColor: 'FF000000', label: 'Clinic 4 (pediatrics)' },
  { id: 'gen_c5', center: 'General OPD', centerColor: 'FFA9D08E', centerTextColor: 'FF000000', label: 'Clinic 5' },
  { id: 'gen_opth', center: 'General OPD', centerColor: 'FFA9D08E', centerTextColor: 'FF000000', label: 'Clinic 6 (Opth)' },
  { id: 'gen_ent', center: 'General OPD', centerColor: 'FFA9D08E', centerTextColor: 'FF000000', label: 'Clinic 7 (ENT)' },
  { id: 'gen_31', center: 'General OPD', centerColor: 'FFA9D08E', centerTextColor: 'FF000000', label: 'Clinic 31' },
  { id: 'gen_audio', center: 'General OPD', centerColor: 'FFA9D08E', centerTextColor: 'FF000000', label: 'Audiology Clinic' },
  // Woman Health Center (5)
  { id: 'whc_gyna', center: 'Woman Health Center', centerColor: 'FFF8CBAD', centerTextColor: 'FF000000', label: 'Clinic 1 (Gyna)' },
  { id: 'whc_gs', center: 'Woman Health Center', centerColor: 'FFF8CBAD', centerTextColor: 'FF000000', label: 'Clinic 2 (GS)' },
  { id: 'whc_uro', center: 'Woman Health Center', centerColor: 'FFF8CBAD', centerTextColor: 'FF000000', label: 'Clinic 3 (Urology)' },
  { id: 'whc_plast', center: 'Woman Health Center', centerColor: 'FFF8CBAD', centerTextColor: 'FF000000', label: 'Clinic 4 (Plastic and Derma)' },
  { id: 'whc_proc', center: 'Woman Health Center', centerColor: 'FFF8CBAD', centerTextColor: 'FF000000', label: 'Clinic 5 (procedure room)' },
  // Cardiology Center (4)
  { id: 'card_1', center: 'Cardiology Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Clinic 1' },
  { id: 'card_vasc', center: 'Cardiology Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Vascular Clinic' },
  { id: 'card_2', center: 'Cardiology Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Clinic 2' },
  { id: 'card_echo', center: 'Cardiology Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: '(ECHO)' },
  // Neurosurgery Center (4)
  { id: 'neuro_1', center: 'Neurosurgery Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Clinic 1' },
  { id: 'neuro_2', center: 'Neurosurgery Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Clinic 2' },
  { id: 'neuro_3', center: 'Neurosurgery Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Clinic 3' },
  { id: 'neuro_4', center: 'Neurosurgery Center', centerColor: 'FFC00000', centerTextColor: 'FFFFFFFF', label: 'Clinic 4' },
  // ODEC Center (4)
  { id: 'odec_nutr', center: 'ODEC Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 1 (Nutrition)' },
  { id: 'odec_surg', center: 'ODEC Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 2 (Surgery)' },
  { id: 'odec_3', center: 'ODEC Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 3' },
  { id: 'odec_4', center: 'ODEC Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 4' },
  // Orthopedics center (3)
  { id: 'ortho_1', center: 'Orthopedics center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 1' },
  { id: 'ortho_2', center: 'Orthopedics center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 2' },
  { id: 'ortho_3', center: 'Orthopedics center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 3' },
  // GIT Center (1)
  { id: 'git_1', center: 'GIT Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 1' },
  // Dental Center (2)
  { id: 'dent_1', center: 'Dental Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 1' },
  { id: 'dent_2', center: 'Dental Center', centerColor: 'FF70AD47', centerTextColor: 'FFFFFFFF', label: 'Clinic 2' },
  // Physiotherapy Center (1)
  { id: 'phys_1', center: 'Physiotherapy Center', centerColor: 'FF548235', centerTextColor: 'FFFFFFFF', label: 'Clinic 1' },
];

export const OPD_HOUSING_SLOTS: { startMins: number; endMins: number; label: string }[] = Array.from(
  { length: 26 },
  (_, idx) => {
    const startMins = 9 * 60 + idx * 30;
    const endMins = startMins + 30;
    const fmt = (m: number) => {
      const h24 = Math.floor(m / 60);
      const min = m % 60;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${h12}:${String(min).padStart(2, '0')}`;
    };
    const endAmpm = Math.floor(endMins / 60) >= 12 ? 'PM' : 'AM';
    return {
      startMins,
      endMins,
      label: `${fmt(startMins)} - ${fmt(endMins)} ${endAmpm}`,
    };
  }
);

function getCandidateClinicIds(session: OPDClinicSession): string[] {
  const sp = `${session.specialty} ${session.specialities}`.toLowerCase();
  if (sp.includes('audiometry') || sp.includes('speech') || sp.includes('swallowing')) {
    return ['gen_audio', 'gen_ent', 'gen_31'];
  }
  if (sp.includes('pediatric cardiology')) {
    return ['card_1', 'card_2', 'gen_peds'];
  }
  if (sp.includes('pediatric surgery')) {
    return ['whc_gs', 'gen_peds', 'whc_proc'];
  }
  if (sp.includes('pediatric oncology')) {
    return ['odec_3', 'odec_4', 'gen_peds'];
  }
  if (sp.includes('pediatrics')) {
    return ['gen_peds', 'gen_c5', 'gen_31'];
  }
  if (sp.includes('ophthalmology')) {
    return ['gen_opth', 'gen_c5', 'gen_31'];
  }
  if (sp.includes('ent')) {
    return ['gen_ent', 'gen_audio', 'gen_31'];
  }
  if (sp.includes('obstetrics') || sp.includes('gynecology') || sp.includes('gyna')) {
    return ['whc_gyna', 'whc_proc', 'gen_c5'];
  }
  if (sp.includes('urology')) {
    return ['whc_uro', 'whc_proc', 'gen_31'];
  }
  if (sp.includes('plastic') || sp.includes('dermatology')) {
    return ['whc_plast', 'whc_proc', 'gen_c5'];
  }
  if (sp.includes('bariatric') || sp.includes('endocrine surgery') || sp.includes('colorectal') || sp.includes('general surgery')) {
    return ['whc_gs', 'odec_surg', 'whc_proc'];
  }
  if (sp.includes('vascular') || sp.includes('ivein')) {
    return ['card_vasc', 'card_1', 'card_2'];
  }
  if (sp.includes('cardiothoracic') || sp.includes('cardiology')) {
    return ['card_1', 'card_2', 'card_echo', 'card_vasc'];
  }
  if (sp.includes('nerve conduction') || sp.includes('emg') || sp.includes('neurosurgery') || sp.includes('neurology') || sp.includes('neuropsychiatry')) {
    return ['neuro_1', 'neuro_2', 'neuro_3', 'neuro_4'];
  }
  if (sp.includes('nutrition')) {
    return ['odec_nutr', 'odec_3', 'odec_4'];
  }
  if (sp.includes('oncology') || sp.includes('hematology') || sp.includes('internal medicine') || sp.includes('nephrology') || sp.includes('pulmonology')) {
    return ['odec_3', 'odec_4', 'odec_nutr', 'gen_c5', 'gen_31'];
  }
  if (sp.includes('orthopedic') || sp.includes('bone tumor')) {
    return ['ortho_1', 'ortho_2', 'ortho_3'];
  }
  if (sp.includes('git') || sp.includes('hepatology') || sp.includes('gastro')) {
    return ['git_1', 'odec_3', 'gen_31'];
  }
  if (sp.includes('dental')) {
    return ['dent_1', 'dent_2'];
  }
  if (sp.includes('physiother')) {
    return ['phys_1', 'ortho_3'];
  }
  return ['gen_c5', 'gen_31', 'whc_proc', 'odec_3', 'odec_4'];
}

export function allocateOPDHousingGrid(items: OPDClinicSession[]): {
  assignments: HousingAssignment[];
  unassigned: OPDClinicSession[];
} {
  const numCols = OPD_HOUSING_COLUMNS.length;
  const numSlots = OPD_HOUSING_SLOTS.length;
  const occupied: boolean[][] = Array.from({ length: numCols }, () => Array(numSlots).fill(false));
  const colIdxById = new Map<string, number>(OPD_HOUSING_COLUMNS.map((c, idx) => [c.id, idx]));

  const sorted = [...(items || [])].sort((a, b) => {
    const sa = parseTimeToMinutes(a.startTime) ?? 9999;
    const sb = parseTimeToMinutes(b.startTime) ?? 9999;
    return sa - sb;
  });

  const assignments: HousingAssignment[] = [];
  const unassigned: OPDClinicSession[] = [];

  for (const session of sorted) {
    const sMin = parseTimeToMinutes(session.startTime);
    const eMin = parseTimeToMinutes(session.endTime);
    if (sMin === null || eMin === null || eMin <= sMin) {
      unassigned.push(session);
      continue;
    }

    const startSlot = Math.max(0, Math.floor((sMin - 9 * 60) / 30));
    const endSlot = Math.min(numSlots - 1, Math.ceil((eMin - 9 * 60) / 30) - 1);
    if (endSlot < startSlot || startSlot >= numSlots) {
      unassigned.push(session);
      continue;
    }

    const candidates = [
      ...getCandidateClinicIds(session),
      ...OPD_HOUSING_COLUMNS.map(c => c.id),
    ];

    let chosenCol = -1;
    for (const cid of candidates) {
      const idx = colIdxById.get(cid);
      if (idx === undefined) continue;
      let free = true;
      for (let slot = startSlot; slot <= endSlot; slot++) {
        if (occupied[idx][slot]) {
          free = false;
          break;
        }
      }
      if (free) {
        chosenCol = idx;
        break;
      }
    }

    if (chosenCol < 0) {
      unassigned.push(session);
      continue;
    }

    for (let slot = startSlot; slot <= endSlot; slot++) {
      occupied[chosenCol][slot] = true;
    }

    const docLabel = session.physicianEn || session.physicianAr || session.specialty;
    assignments.push({
      session,
      colIndex: chosenCol,
      startSlot,
      endSlot,
      displayLabel: docLabel,
    });
  }

  return { assignments, unassigned };
}

/**
 * Sheet 1: Refined OPD Schedule (same style as Refined Occupancy Sheet)
 */
export async function addRefinedOPDScheduleSheet(
  workbook: ExcelJS.Workbook,
  items: OPDClinicSession[],
  opdDate: string,
  applyRefinedHeaderFn: ApplyRefinedHeaderFn
) {
  const sheet = workbook.addWorksheet('OPD Schedule', {
    views: [{ rightToLeft: false }],
  });

  const displayDate = formatOPDDisplayDate(opdDate);
  const titleText = displayDate
    ? `جدول العيادات الخارجية ليوم ${displayDate}`
    : 'جدول العيادات الخارجية';

  sheet.mergeCells('A1:I1');
  sheet.getCell('A1').value = '';
  sheet.getRow(1).height = 90;
  await applyRefinedHeaderFn(workbook, sheet, titleText, 9);

  const headerRow = sheet.addRow([
    '#',
    'التخصص / Specialty',
    'العيادة / Parent Dept',
    'اسم الطبيب / Physician (AR)',
    'Physician Name (EN)',
    'الدرجة العلمية / Level',
    'الدور / Floor',
    'الموعد / Time',
    'أقصى سعة / Max Cap',
  ]);
  headerRow.height = 24;
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } },
    };
  });

  sheet.autoFilter = 'A2:I2';

  const sorted = [...(items || [])].sort((a, b) => {
    const spCmp = (a.specialty || '').localeCompare(b.specialty || '');
    if (spCmp !== 0) return spCmp;
    return (parseTimeToMinutes(a.startTime) ?? 0) - (parseTimeToMinutes(b.startTime) ?? 0);
  });

  let currentSpec: string | null = null;
  let serial = 1;

  for (const item of sorted) {
    const spec = item.specialty || item.specialities || 'Other';
    if (currentSpec !== null && spec !== currentSpec) {
      const sepRow = sheet.addRow(Array(9).fill(''));
      sepRow.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          right: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        };
      });
    }

    const floorDisplay =
      item.floorName === '1'
        ? '1st Floor'
        : item.floorName.toLowerCase() === 'm'
          ? 'Mezzanine (M)'
          : item.floorName || '—';

    const row = sheet.addRow([
      serial++,
      spec,
      item.specialities || spec,
      item.physicianAr || item.physicianEn,
      item.physicianEn || item.physicianAr,
      item.supervisoryLevel || '—',
      floorDisplay,
      `${item.startTime} - ${item.endTime}`,
      item.maxOccupancy,
    ]);
    row.height = 22;
    row.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11, bold: colNumber >= 2 && colNumber <= 8 };
    });
    currentSpec = spec;
  }

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 32;
  sheet.getColumn(3).width = 26;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 30;
  sheet.getColumn(6).width = 18;
  sheet.getColumn(7).width = 16;
  sheet.getColumn(8).width = 22;
  sheet.getColumn(9).width = 16;
}

/**
 * Sheet 2: OPD Timeline (same format as OR Timeline Sheet)
 */
export async function addRefinedOPDTimelineSheet(
  workbook: ExcelJS.Workbook,
  items: OPDClinicSession[],
  opdDate: string,
  applyRefinedHeaderFn: ApplyRefinedHeaderFn
) {
  const sheet = workbook.addWorksheet('OPD Timeline', {
    views: [{ rightToLeft: false }],
  });

  let minMins = 24 * 60;
  let maxMins = 0;
  let validCount = 0;

  const parsed = (items || []).map(p => {
    const startMins = parseTimeToMinutes(p.startTime);
    const endMins = parseTimeToMinutes(p.endTime);
    if (startMins !== null && endMins !== null && endMins > startMins) {
      if (startMins < minMins) minMins = startMins;
      if (endMins > maxMins) maxMins = endMins;
      validCount++;
      return { ...p, startMins, endMins };
    }
    return { ...p, startMins: null as number | null, endMins: null as number | null };
  });

  if (validCount === 0 || minMins >= maxMins) {
    minMins = 9 * 60;
    maxMins = 22 * 60;
  } else {
    minMins = Math.floor(minMins / 60) * 60;
    maxMins = Math.ceil(maxMins / 60) * 60;
  }

  const slots: { start: number; end: number; label: string }[] = [];
  for (let m = minMins; m < maxMins; m += 30) {
    const fmt = (val: number) => `${String(Math.floor(val / 60)).padStart(2, '0')}:${String(val % 60).padStart(2, '0')}`;
    slots.push({ start: m, end: m + 30, label: `${fmt(m)} - ${fmt(m + 30)}` });
  }

  const numSlots = slots.length;
  sheet.mergeCells(1, 1, 1, numSlots + 1);
  sheet.getCell('A1').value = '';
  sheet.getRow(1).height = 90;

  const displayDate = formatOPDDisplayDate(opdDate);
  const titleText = displayDate
    ? `الجدول الزمني للعيادات الخارجية ليوم ${displayDate}`
    : 'الجدول الزمني للعيادات الخارجية';
  await applyRefinedHeaderFn(workbook, sheet, titleText, numSlots + 1);

  sheet.addRow(Array(numSlots + 1).fill(''));
  sheet.getRow(2).height = 15;

  const headerRow = sheet.addRow(['التخصص / Specialty', ...slots.map(s => s.label)]);
  headerRow.height = 28;
  headerRow.eachCell({ includeEmpty: true }, cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C34' } };
    cell.font = { bold: true, name: 'Calibri', size: 10, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'medium', color: { argb: 'FF000000' } },
      bottom: { style: 'medium', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
      right: { style: 'thin', color: { argb: 'FFFFFFFF' } },
    };
  });

  const writeTimeGuideRow = (rowNum: number) => {
    const gCell = sheet.getCell(rowNum, 1);
    gCell.value = 'Time Guide / دليل الوقت';
    gCell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    gCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C34' } };
    gCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    for (let sIdx = 0; sIdx < numSlots; sIdx++) {
      const c = sheet.getCell(rowNum, sIdx + 2);
      c.value = slots[sIdx].label;
      c.font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF1E293B' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = {
        top: { style: 'medium', color: { argb: 'FF0B3C34' } },
        bottom: { style: 'medium', color: { argb: 'FF0B3C34' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      };
    }
    sheet.getRow(rowNum).height = 28;
  };

  let currentRowNum = 4;
  writeTimeGuideRow(currentRowNum++);

  const specMap = new Map<string, typeof parsed>();
  for (const p of parsed) {
    const sp = p.specialty || p.specialities || 'Other';
    const arr = specMap.get(sp) || [];
    arr.push(p);
    specMap.set(sp, arr);
  }

  for (const specName of Array.from(specMap.keys()).sort()) {
    const valid = (specMap.get(specName) || []).filter(
      (p): p is typeof p & { startMins: number; endMins: number } =>
        p.startMins !== null && p.endMins !== null && p.endMins > p.startMins
    );
    if (valid.length === 0) continue;

    const lanes: (typeof valid)[] = [];
    for (const p of [...valid].sort((a, b) => a.startMins - b.startMins)) {
      let placed = false;
      for (const lane of lanes) {
        if (!lane.some(ex => p.startMins < ex.endMins && p.endMins > ex.startMins)) {
          lane.push(p);
          placed = true;
          break;
        }
      }
      if (!placed) lanes.push([p]);
    }

    const startSpecRow = currentRowNum;
    const endSpecRow = currentRowNum + lanes.length - 1;

    lanes.forEach((laneItems, laneIdx) => {
      const rowNum = currentRowNum + laneIdx;
      const specCell = sheet.getCell(rowNum, 1);
      specCell.value = specName;
      specCell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF0B3C34' } };
      specCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF3F5' } };
      specCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      specCell.border = {
        top: { style: 'thin', color: { argb: 'FFB0BEC5' } },
        bottom: { style: 'thin', color: { argb: 'FFB0BEC5' } },
        left: { style: 'medium', color: { argb: 'FF0B3C34' } },
        right: { style: 'thin', color: { argb: 'FFB0BEC5' } },
      };

      for (let sIdx = 0; sIdx < numSlots; sIdx++) {
        const cell = sheet.getCell(rowNum, sIdx + 2);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        };
      }

      for (const p of laneItems) {
        const startSlotIdx = Math.max(0, Math.floor((p.startMins - minMins) / 30));
        const endSlotIdx = Math.min(numSlots - 1, Math.ceil((p.endMins - minMins) / 30) - 1);
        if (endSlotIdx < startSlotIdx) continue;
        const startCol = startSlotIdx + 2;
        const endCol = endSlotIdx + 2;
        if (endCol > startCol) {
          try {
            sheet.mergeCells(rowNum, startCol, rowNum, endCol);
          } catch (_) {}
        }
        const cell = sheet.getCell(rowNum, startCol);
        const docName = p.physicianAr || p.physicianEn;
        cell.value = `${docName}\n[${p.startTime} - ${p.endTime}]`;
        const isFloorM = String(p.floorName || '').toLowerCase() === 'm';
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isFloorM ? 'FFE8F5E9' : 'FFE3F2FD' } };
        cell.font = { bold: true, size: 9, name: 'Calibri', color: { argb: isFloorM ? 'FF1B5E20' : 'FF0D47A1' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: isFloorM ? 'FFA5D6A7' : 'FF90CAF9' } },
          bottom: { style: 'thin', color: { argb: isFloorM ? 'FFA5D6A7' : 'FF90CAF9' } },
          left: { style: 'thin', color: { argb: isFloorM ? 'FFA5D6A7' : 'FF90CAF9' } },
          right: { style: 'thin', color: { argb: isFloorM ? 'FFA5D6A7' : 'FF90CAF9' } },
        };
      }
      sheet.getRow(rowNum).height = 42;
    });

    if (endSpecRow > startSpecRow) {
      try {
        sheet.mergeCells(startSpecRow, 1, endSpecRow, 1);
      } catch (_) {}
    }
    currentRowNum += lanes.length;
  }

  writeTimeGuideRow(currentRowNum);

  sheet.getColumn(1).width = 28;
  for (let c = 2; c <= numSlots + 1; c++) {
    sheet.getColumn(c).width = 16;
  }
}

/**
 * Sheet 3: OPD Housing Grid (Exact format of /Users/mohanad/Downloads/OPD Housing)
 */
export function addOPDHousingSheet(
  workbook: ExcelJS.Workbook,
  items: OPDClinicSession[],
  opdDate: string
) {
  const sheet = workbook.addWorksheet('OPD Housing', {
    views: [{ rightToLeft: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });

  const weekdayLabel =
    items.find(i => i.weekName)?.weekName ||
    (opdDate
      ? new Date(`${opdDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
      : 'Schedule');

  // Row 1: Weekday + 9 Color-coded Center Banners
  const totalCols = OPD_HOUSING_COLUMNS.length + 1;
  const row1 = sheet.getRow(1);
  row1.height = 24;
  const dayCell = sheet.getCell(1, 1);
  dayCell.value = weekdayLabel;
  dayCell.font = { bold: true, size: 11, name: 'Calibri' };
  dayCell.alignment = { horizontal: 'center', vertical: 'middle' };
  dayCell.border = {
    top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' },
  };

  let colStart = 2;
  while (colStart <= totalCols) {
    const cfg = OPD_HOUSING_COLUMNS[colStart - 2];
    let colEnd = colStart;
    while (colEnd < totalCols && OPD_HOUSING_COLUMNS[colEnd - 1].center === cfg.center) {
      colEnd++;
    }
    if (colEnd > colStart) {
      sheet.mergeCells(1, colStart, 1, colEnd);
    }
    const bannerCell = sheet.getCell(1, colStart);
    bannerCell.value = cfg.center;
    bannerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cfg.centerColor } };
    bannerCell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: cfg.centerTextColor } };
    bannerCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    for (let c = colStart; c <= colEnd; c++) {
      sheet.getCell(1, c).border = {
        top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' },
      };
    }
    colStart = colEnd + 1;
  }

  // Row 2: Time + Sub-Clinic Headers
  const row2 = sheet.getRow(2);
  row2.height = 34;
  const timeHdr = sheet.getCell(2, 1);
  timeHdr.value = 'Time';
  timeHdr.font = { bold: true, size: 10, name: 'Calibri' };
  timeHdr.alignment = { horizontal: 'center', vertical: 'middle' };
  timeHdr.border = {
    top: { style: 'thin' }, bottom: { style: 'medium' }, left: { style: 'thin' }, right: { style: 'thin' },
  };

  OPD_HOUSING_COLUMNS.forEach((colCfg, idx) => {
    const cell = sheet.getCell(2, idx + 2);
    cell.value = colCfg.label;
    cell.font = { bold: true, size: 9, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'medium' }, left: { style: 'thin' }, right: { style: 'thin' },
    };
  });

  // Rows 3..28: 26 half-hour time slots (9:00 AM - 10:00 PM)
  OPD_HOUSING_SLOTS.forEach((slot, sIdx) => {
    const rNum = sIdx + 3;
    sheet.getRow(rNum).height = 20;
    const tCell = sheet.getCell(rNum, 1);
    tCell.value = slot.label;
    tCell.font = { bold: true, size: 9, name: 'Calibri' };
    tCell.alignment = { horizontal: 'center', vertical: 'middle' };
    tCell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' },
    };

    for (let c = 2; c <= totalCols; c++) {
      const cell = sheet.getCell(rNum, c);
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        left: { style: 'thin', color: { argb: 'FF808080' } },
        right: { style: 'thin', color: { argb: 'FF808080' } },
      };
    }
  });

  // Allocate & merge doctor blocks
  const { assignments } = allocateOPDHousingGrid(items);
  for (const a of assignments) {
    const startRow = a.startSlot + 3;
    const endRow = a.endSlot + 3;
    const col = a.colIndex + 2;
    if (endRow > startRow) {
      try {
        sheet.mergeCells(startRow, col, endRow, col);
      } catch (_) {}
    }
    const cell = sheet.getCell(startRow, col);
    cell.value = a.displayLabel;
    cell.font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF000000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    for (let r = startRow; r <= endRow; r++) {
      sheet.getCell(r, col).border = {
        top: { style: r === startRow ? 'medium' : 'thin', color: { argb: 'FF000000' } },
        bottom: { style: r === endRow ? 'medium' : 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } },
      };
    }
  }

  sheet.getColumn(1).width = 18;
  for (let c = 2; c <= totalCols; c++) {
    sheet.getColumn(c).width = 13;
  }
}
