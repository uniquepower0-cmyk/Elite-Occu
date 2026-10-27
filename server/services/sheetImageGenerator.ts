import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { getResponsibleOfficer, formatDateForSheet, cleanContractorForDisplay } from '../contractorOfficers.js';
import { isNameMatch, normalizeArabicName, isOperatingRoom, isOrXRoom, cleanRoomStr } from '../nameUtils.js';
import { formatRoomForSheet, formatMrnForSheet } from '../columnResolver.js';

export { getResponsibleOfficer, formatDateForSheet, cleanContractorForDisplay };

const DIALYSIS_EXCLUSIONS = [
  'homecare', 'home care', 'رعاية منزلية',
  'wellbaby', 'well baby', 'حضانة طبيعية',
  'endoscopy operation theatre', 'operation room', 'cath lab operation theatre', 'غرفة عمليات',
];

function escapeXml(unsafe: any): string {
  return String(unsafe || '').replace(/[<>&"'\\]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      case '\\': return '';
      default: return c;
    }
  });
}

function truncateText(str: any, maxChars: number): string {
  if (!str) return '';
  const s = String(str).trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trim() + '…';
}

/**
 * Validates that a candidate MRN string is an actual MRN code (contains digits,
 * no Arabic characters, no spaces, and not a synthetic placeholder).
 */
export function isRealMrnCode(val: any): boolean {
  const s = String(val ?? '').trim();
  if (!s || s === '—' || s === '-' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') {
    return false;
  }
  if (s.startsWith('UNKNOWN-') || s.startsWith('transfer-') || s.toLowerCase().includes('transfer')) {
    return false;
  }
  if (/[\u0600-\u06FF]/.test(s) || /\s/.test(s)) {
    return false;
  }
  if (!/\d/.test(s)) {
    return false;
  }
  return true;
}

function getHeaderBgPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'header_bg.webp'),
    path.resolve(process.cwd(), 'header_bg.png'),
    path.resolve(process.cwd(), 'public', 'header_bg.webp'),
    path.resolve(process.cwd(), 'public', 'header_bg.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
      return p;
    }
  }
  return null;
}

/**
 * Shared Refined Combined Sheet Department/Floor Grouping & Palette
 */
function getDepartmentGroup(roomRaw: string, defaultRoomNum = 0): string {
  const roomStr = String(roomRaw || '').toUpperCase();
  const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || String(defaultRoomNum));
  if (roomStr.includes('PICU')) return 'PICU';
  if (roomStr.includes('NICU')) return 'NICU';
  if (roomStr.includes('CCU')) return 'CCU';
  if (roomStr.includes('SICU')) return 'SICU';
  if (roomStr.includes('VIP') || roomStr.includes('VIP ISOLATION')) return 'VIP';
  if (roomStr.includes('ICU')) return 'ICU';
  if (roomNum >= 101 && roomNum <= 108) return 'First Floor';
  if (roomNum >= 301 && roomNum <= 319) return 'Zone A (301-319)';
  if (roomNum >= 320 && roomNum <= 329) return 'Zone B (320-329)';
  if (roomNum >= 330 && roomNum <= 332) return 'Zone C (330-332)';
  if (roomNum >= 401 && roomNum <= 422) return '4th Floor';
  if (!isNaN(roomNum) && roomNum > 0) return 'Floor ' + Math.floor(roomNum / 100);
  if (defaultRoomNum === -1 && !isNaN(roomNum) && roomNum === 0) return 'Floor 0';
  return 'OTHER';
}

function groupOrderRank(g: string): number {
  const u = g.toUpperCase();
  if (
    u.includes('ICU') &&
    !u.includes('VIP') &&
    !u.includes('SICU') &&
    !u.includes('CCU') &&
    !u.includes('NICU') &&
    !u.includes('PICU')
  ) {
    return 1;
  }
  if (u.includes('VIP')) return 2;
  if (u.includes('SICU')) return 3;
  if (u.includes('CCU')) return 4;
  if (u.includes('NICU')) return 5;
  if (u.includes('PICU')) return 6;
  if (u.includes('FIRST')) return 7;
  if (u.includes('ZONE A')) return 8;
  if (u.includes('ZONE B')) return 9;
  if (u.includes('ZONE C')) return 9.5;
  if (u.includes('4TH')) return 10;
  return 100;
}

function getGroupColors(groupName: string): { badge: string; row: string } {
  const g = groupName.toUpperCase();
  if (g.includes('ICU') && !g.includes('VIP')) return { badge: '#3F889E', row: '#EBF2F5' };
  if (g.includes('SICU')) return { badge: '#5C5A7F', row: '#F1EFF5' };
  if (g.includes('VIP')) return { badge: '#2E7D32', row: '#EBF5EB' };
  if (g.includes('CCU')) return { badge: '#1565C0', row: '#EBF5FB' };
  if (g.includes('NICU')) return { badge: '#EF6C00', row: '#FFF5EB' };
  if (g.includes('PICU')) return { badge: '#AD1457', row: '#FFEBEF' };
  return { badge: '#455A64', row: '#F5F7F8' };
}

/**
 * Creates the signature Mohanad Excel header banner:
 * Header background image with centered frosted glass text box overlay.
 */
async function createExcelHeaderBuffer(title: string, width: number, height = 180): Promise<Buffer> {
  const safeTitle = escapeXml(title);
  const boxWidth = Math.min(540, width - 80);
  const boxX = (width - boxWidth) / 2;

  const overlaySvg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${boxX}" y="45" width="${boxWidth}" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.18" stroke="#FFFFFF" stroke-opacity="0.4" stroke-width="1.5" />
      <text x="${width / 2}" y="105" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="38" font-weight="bold" fill="#000000" text-anchor="middle">${safeTitle}</text>
    </svg>
  `;

  const bgPath = getHeaderBgPath();
  if (bgPath) {
    try {
      return await sharp(bgPath)
        .resize(width, height, { fit: 'fill' })
        .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
        .png()
        .toBuffer();
    } catch (err) {
      console.error('[SheetImageGen] Error compositing header background:', err);
    }
  }

  // Fallback if background image file is missing
  const fallbackSvg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#EBF3F5"/>
      <rect x="${boxX}" y="45" width="${boxWidth}" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.9" stroke="#CBD5E1" stroke-width="1.5"/>
      <text x="${width / 2}" y="105" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="38" font-weight="bold" fill="#094037" text-anchor="middle">${safeTitle}</text>
    </svg>
  `;
  return sharp(Buffer.from(fallbackSvg)).png().toBuffer();
}

/**
 * Composite header banner above the table into a single high-res JPEG
 */
async function assembleSheetImage(headerBuf: Buffer, tableSvg: string, width: number, headerHeight: number, tableHeight: number): Promise<Buffer> {
  const tableBuf = await sharp(Buffer.from(tableSvg)).png().toBuffer();
  const totalHeight = headerHeight + tableHeight;

  return sharp({
    create: {
      width,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      { input: headerBuf, top: 0, left: 0 },
      { input: tableBuf, top: headerHeight, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Helper to identify dialysis rooms/cases
 */
export function isDialysisRoom(roomStr: string): boolean {
  if (!roomStr) return false;
  const r = String(roomStr).trim().toLowerCase();
  const keywords = [
    'dialysis', 'diyalsis', 'dialys', 'hemodialysis', 'haemodialysis',
    'hemo dialysis', 'haemo dialysis', 'غسيل', 'استصفاء', 'ديلزة'
  ];
  if (keywords.some(kw => r.includes(kw))) return true;
  if (/\b(hd|hemo|dial)\s*[-#_]?\s*\d*\b/i.test(r) && !r.includes('icu') && !r.includes('ccu')) return true;
  return false;
}

/**
 * Robust Occupancy Exclusion Filter:
 * Strictly excludes:
 * 1. OR (Operating Rooms, Cath Lab, Endoscopy, Recovery, الإفاقة)
 * 2. Home Care (HomeCare 1..30, الرعاية المنزلية)
 * 3. Dialysis (Dialysis Rooms, Hemodialysis, الغسيل الكلوي)
 * 4. Well Baby (Well Baby Room 1..3, الحضانة الطبيعية)
 */
export function isOccupancyExcluded(
  room: string,
  name?: string,
  contractor?: string,
  physician?: string,
  dialysisCases: any[] = []
): boolean {
  const rLower = String(room || '').trim().toLowerCase();
  const nLower = String(name || '').trim().toLowerCase();
  const cLower = String(contractor || '').trim().toLowerCase();
  const pLower = String(physician || '').trim().toLowerCase();
  const allText = `${rLower} ${nLower} ${cLower} ${pLower}`;

  if (!rLower || !nLower) return true;
  if (rLower === 'bed' || rLower === 'room' || rLower === 'الغرفة' || nLower === 'patient' || nLower === 'المريض') return true;

  // 1. Operating Room (OR) / Cath Lab / Endoscopy / Recovery
  if (
    isOperatingRoom(rLower) ||
    isOrXRoom(rLower) ||
    /\b(or|or-?\d+|orx)\b/i.test(rLower) ||
    /\bor\s*[-#_]?\s*\d+\b/i.test(rLower) ||
    rLower.startsWith('or ') ||
    rLower.startsWith('or-') ||
    rLower === 'or' ||
    rLower.includes('operating') ||
    rLower.includes('operation') ||
    rLower.includes('theatre') ||
    rLower.includes('عمليات') ||
    rLower.includes('عملية') ||
    rLower.includes('عمليه') ||
    rLower.includes('cath lab') ||
    rLower.includes('cathlab') ||
    rLower.includes('قسطرة') ||
    rLower.includes('قسطره') ||
    rLower.includes('endoscopy') ||
    rLower.includes('مناظير') ||
    rLower.includes('منظار') ||
    rLower.includes('recovery') ||
    rLower.includes('إفاقة') ||
    rLower.includes('افاقة')
  ) {
    return true;
  }

  // 2. Home Care
  if (
    rLower.includes('homecare') ||
    rLower.includes('home care') ||
    rLower.includes('home-care') ||
    rLower.includes('منزلية') ||
    rLower.includes('منزليه') ||
    rLower.includes('رعاية منزلية') ||
    rLower.includes('رعايه منزليه') ||
    cLower.includes('homecare') ||
    cLower.includes('home care') ||
    cLower.includes('home-care') ||
    cLower.includes('home sampling') ||
    cLower.includes('رعاية منزلية') ||
    cLower.includes('رعايه منزليه') ||
    allText.includes('homecare') ||
    allText.includes('home care') ||
    allText.includes('رعاية منزلية') ||
    allText.includes('رعايه منزليه')
  ) {
    return true;
  }

  // 3. Dialysis
  if (
    isDialysisRoom(rLower) ||
    allText.includes('dialysis') ||
    allText.includes('diyalsis') ||
    allText.includes('dialys') ||
    allText.includes('hemodialysis') ||
    allText.includes('haemodialysis') ||
    allText.includes('hemo dialysis') ||
    allText.includes('haemo dialysis') ||
    allText.includes('غسيل') ||
    allText.includes('استصفاء') ||
    allText.includes('ديلزة') ||
    allText.includes('ديلزه') ||
    /\b(hd|hemo|dial)\s*[-#_]?\s*\d*\b/i.test(rLower)
  ) {
    return true;
  }
  if (dialysisCases && dialysisCases.some((dp) =>
    isNameMatch(dp.name, nLower) ||
    (dp.mrn && dp.mrn === nLower) ||
    (/^\d+$/.test(dp.name) && dp.name === nLower)
  )) {
    return true;
  }

  // 4. Well Baby
  if (
    rLower.includes('wellbaby') ||
    rLower.includes('well baby') ||
    rLower.includes('well-baby') ||
    rLower.includes('حضانة طبيعية') ||
    rLower.includes('حضانه طبيعيه') ||
    rLower.includes('حضانة أطفال طبيعية') ||
    (rLower.includes('حضان') && (rLower.includes('طبيعي') || rLower.includes('طبيعيه'))) ||
    rLower.includes('well baby room') ||
    allText.includes('wellbaby') ||
    allText.includes('well baby') ||
    allText.includes('حضانة طبيعية')
  ) {
    return true;
  }

  // 5. Day Case / Day Surgery
  if (
    rLower.includes('day case') ||
    rLower.includes('daycase') ||
    rLower.includes('day surgery') ||
    rLower.includes('جراحة اليوم الواحد')
  ) {
    return true;
  }

  return false;
}

/**
 * Universal Intelligent MRN Resolver
 * Solves MRN across exact match, normalized Arabic, and fuzzy patient names.
 * Strictly rejects any non-code value (such as patient names or Arabic text).
 */
export class MrnResolver {
  public exactMap = new Map<string, string>();
  public normMap = new Map<string, string>();
  public mrnToPatient = new Map<string, { name: string; physician?: string; contractor?: string; room?: string }>();
  public allPairs: Array<{ name: string; normName: string; mrn: string }> = [];

  public add(name: string, mrn: string, details?: { physician?: string; contractor?: string; room?: string }) {
    const rawName = String(name || '').trim();
    const cleanMrn = String(mrn || '').trim();
    if (!isRealMrnCode(cleanMrn) || cleanMrn.length > 20) {
      return;
    }
    if (!rawName) return;

    const lower = rawName.toLowerCase();
    const norm = normalizeArabicName(rawName);

    if (!this.exactMap.has(lower)) {
      this.exactMap.set(lower, cleanMrn);
    }
    if (norm && !this.normMap.has(norm)) {
      this.normMap.set(norm, cleanMrn);
    }
    if (!this.mrnToPatient.has(cleanMrn)) {
      this.mrnToPatient.set(cleanMrn, { name: rawName, ...details });
    }
    const stripped = cleanMrn.replace(/^0+/, '');
    if (stripped && !this.mrnToPatient.has(stripped)) {
      this.mrnToPatient.set(stripped, { name: rawName, ...details });
    }
    this.allPairs.push({ name: rawName, normName: norm, mrn: cleanMrn });
  }

  public resolve(patientName: string, directMrn?: string): string {
    const direct = String(directMrn || '').trim();
    if (isRealMrnCode(direct)) {
      return direct;
    }
    const rawName = String(patientName || '').trim();
    if (!rawName) return 'N/A';

    // 1. Direct lowercase match
    const lower = rawName.toLowerCase();
    if (this.exactMap.has(lower)) return this.exactMap.get(lower)!;

    // 2. Normalized Arabic match
    const norm = normalizeArabicName(rawName);
    if (norm && this.normMap.has(norm)) return this.normMap.get(norm)!;

    // 3. Fuzzy match using isNameMatch
    for (const pair of this.allPairs) {
      if (isNameMatch(pair.name, rawName) || (norm && pair.normName && (pair.normName.includes(norm) || norm.includes(pair.normName)))) {
        return pair.mrn;
      }
    }

    return 'N/A';
  }

  public getPatientByMrn(mrn: string) {
    const cleanMrn = String(mrn || '').trim();
    const stripped = cleanMrn.replace(/^0+/, '');
    return this.mrnToPatient.get(cleanMrn) || (stripped ? this.mrnToPatient.get(stripped) : undefined);
  }

  public get nameToMrn(): Map<string, string> {
    return this.exactMap;
  }
}

function resolvePatientMrn(
  patientName: string,
  directMrn: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any
): string {
  const cleanDirect = String(directMrn || '').trim();
  if (isRealMrnCode(cleanDirect)) {
    return cleanDirect;
  }
  if (mrnLookupInput?.resolve) {
    const r = mrnLookupInput.resolve(patientName, cleanDirect);
    return isRealMrnCode(r) ? r : 'N/A';
  }
  if (mrnLookupInput instanceof Map) {
    const r = mrnLookupInput.get(patientName.toLowerCase());
    return isRealMrnCode(r) ? r! : 'N/A';
  }
  if (mrnLookupInput?.nameToMrn) {
    const r = mrnLookupInput.nameToMrn.get(patientName.toLowerCase());
    return isRealMrnCode(r) ? r : 'N/A';
  }
  return 'N/A';
}

/**
 * Builds a comprehensive MRN resolver from all known sources (39-col raw, formatted, object arrays).
 */
export function buildMrnLookup(
  rawRows: any[][] = [],
  otherLists: any[][] = []
): MrnResolver {
  const resolver = new MrnResolver();

  // 1. Index rawRows (handles both raw uploads with headers and pre-filtered arrays)
  (rawRows || []).forEach((r) => {
    if (!Array.isArray(r) || r.length === 0) return;
    const isUnified = r.length >= 10;
    let room = '';
    let name = '';
    let physician = '';
    let contractor = '';
    let mrn = '';

    if (isUnified) {
      room = String(r[1] || '').trim();
      mrn = String(r[2] || '').trim();
      name = String(r[3] || '').trim();
      contractor = String(r[12] || '').trim();
      physician = String(r[22] || '').trim();
    } else {
      room = String(r[0] || '').trim();
      name = String(r[1] || '').trim();
      physician = String(r[2] || '').trim();
      contractor = String(r[3] || '').trim();
      mrn = String(r[5] || '').trim();
    }

    const nameLower = name.toLowerCase();
    const mrnLower = mrn.toLowerCase();
    if (
      !name ||
      !mrn ||
      nameLower === 'patient' ||
      nameLower === 'المريض' ||
      mrnLower === 'mrn' ||
      nameLower.includes('patient') ||
      room.toLowerCase().includes('bed#') ||
      !isRealMrnCode(mrn)
    ) {
      return;
    }

    resolver.add(name, mrn, { room, physician, contractor });
  });

  // 2. Index otherLists (entries, discharged, dialysis, debts, transfers, registry)
  otherLists.forEach((list) => {
    (list || []).forEach((item: any) => {
      if (!item) return;
      const name = String(item.name || item.patient || item.patientName || item.colD || '').trim();
      const rawCandidate = String(
        item.mrn ||
        item.patientId ||
        item.barcode ||
        item.colC ||
        item.code ||
        (item.id && !String(item.id).startsWith('transfer-') && !String(item.id).startsWith('UNKNOWN-') ? item.id : '') ||
        ''
      ).trim();
      const physician = String(item.physician || item.doctor || item.colW || '').trim();
      const contractor = String(item.contractor || item.payment || item.colM || '').trim();
      const room = String(item.room || item.bed || item.colB || '').trim();

      if (name && isRealMrnCode(rawCandidate)) {
        resolver.add(name, rawCandidate, { room, physician, contractor });
      }
    });
  });

  return resolver;
}

/**
 * 1. Occupancy Sheet (Colored Structured Grid - 100% identical to addGridOccupancySheet)
 * Columns (8): ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'مسئول التعاقد', 'Booking Date / تاريخ الحجز', 'VIP STATUS']
 * STRICTLY EXCLUDES: OR, Home Care, Dialysis, Well Baby.
 */
export async function generateOccupancyJpeg(
  rawHospitalData: any[][],
  dateLabel: string,
  isVipFn?: (name: string) => boolean,
  dialysisCases: any[] = [],
  mrnLookupInput?: MrnResolver | Map<string, string> | any
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1240;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 36;
  const separatorHeight = 28;

  const cols = [
    { label: '# / الرقم', width: 65 },
    { label: 'Room / الغرفة', width: 115 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'Physician / الطبيب المعالج', width: 235 },
    { label: 'Contract / التعاقد', width: 210 },
    { label: 'مسئول التعاقد', width: 135 },
    { label: 'Booking Date / تاريخ الحجز', width: 130 },
    { label: 'VIP STATUS', width: 70 },
  ];

  // 1. Universal row parser: supports getOccupancyRows output, 39-col unified raw, 6-col formatted, and object lists
  const rawList: any[] = [];
  (rawHospitalData || []).forEach((row: any) => {
    if (!row) return;

    if (!Array.isArray(row) && typeof row === 'object') {
      const room = cleanRoomStr(String(row.room || row.bed || row.colB || '').trim());
      const name = String(row.name || row.patient || row.colD || '').trim();
      const physician = String(row.physician || row.doctor || row.colW || '').trim();
      const contractor = String(row.contractor || row.payment || row.colM || '').trim();
      const date = String(row.date || row.bookingDate || row.colA || '').trim();
      if (room && name && name.toLowerCase() !== 'patient' && name !== 'المريض') {
        rawList.push({ room, name, physician, contractor, date });
      }
      return;
    }

    if (!Array.isArray(row) || row.length === 0) return;

    const str0 = String(row[0] || '').trim();
    const str1 = String(row[1] || '').trim();
    const str2 = String(row[2] || '').trim();
    const str3 = String(row[3] || '').trim();
    const str0Low = str0.toLowerCase();
    const str1Low = str1.toLowerCase();
    const str2Low = str2.toLowerCase();
    const str3Low = str3.toLowerCase();

    // Skip table headers and empty/metadata rows (such as getOccupancyRows 3-row header)
    if (
      str0Low.includes('admissiondate') ||
      str0Low.includes('bed#') ||
      str1Low.includes('bed#') ||
      str2Low.includes('mrn') ||
      str3Low.includes('patient') ||
      str0 === 'رقم الغرفة' ||
      str1 === 'اسم المريض' ||
      str1Low === 'patient' ||
      str1 === 'المريض' ||
      str0Low.includes('إشغال المستشفى') ||
      (!row[0] && !row[1] && !row[2] && !row[3])
    ) {
      return;
    }

    const isUnified = row.length >= 10;

    let room = '';
    let name = '';
    let physician = '';
    let contractor = '';
    let date = '';

    if (isUnified) {
      date = str0;
      room = cleanRoomStr(String(row[1] || '').trim());
      name = String(row[3] || '').trim();
      contractor = String(row[12] || '').trim();
      physician = String(row[22] || '').trim();
    } else {
      room = cleanRoomStr(String(row[0] || '').trim());
      name = String(row[1] || '').trim();
      physician = String(row[2] || '').trim();
      contractor = String(row[3] || '').trim();
      date = String(row[4] || '').trim();
    }

    if (room && name && name.toLowerCase() !== 'patient' && name !== 'المريض') {
      rawList.push({ room, name, physician, contractor, date });
    }
  });

  // 2. Strict Inpatient Exclusion Filter (OR, Home Care, Dialysis, Well Baby, Day Case)
  const processedData = rawList.filter(
    (p) => !isOccupancyExcluded(p.room, p.name, p.contractor, p.physician, dialysisCases)
  );

  // 3. Sort identically to addGridOccupancySheet
  processedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes('PICU')) return 6;
      if (str.includes('NICU')) return 5;
      if (str.includes('CCU')) return 4;
      if (str.includes('SICU')) return 3;
      if (str.includes('VIP') || str.includes('VIP ISOLATION')) return 2;
      if (str.includes('ICU')) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || '0');
    const numB = parseInt(roomB.match(/\d+/)?.[0] || '0');
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  // 4. Group items identically to addGridOccupancySheet
  const groupedItems: { groupName: string; items: any[] }[] = [];
  processedData.forEach((p) => {
    const groupName = getDepartmentGroup(p.room, 0);
    let existing = groupedItems.find((g) => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  let totalTableHeight = tableHeaderHeight;
  groupedItems.forEach((g) => {
    totalTableHeight += separatorHeight + g.items.length * rowHeight;
  });
  totalTableHeight += 40;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col, idx) => {
    const hdrId = `cp_occhdr_${idx}`;
    tableSvgContent += `
      <clipPath id="${hdrId}"><rect x="${colX + 2}" y="0" width="${col.width - 4}" height="${tableHeaderHeight}"/></clipPath>
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text clip-path="url(#${hdrId})" x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  groupedItems.forEach((group) => {
    const rColors = getGroupColors(group.groupName);
    const displayGroupName = group.groupName === 'VIP' ? 'VIP ICU' : group.groupName;

    tableSvgContent += `
      <rect x="0" y="${currentY}" width="${width}" height="${separatorHeight}" fill="${rColors.badge}" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${width / 2}" y="${currentY + separatorHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">—  ${escapeXml(displayGroupName)}  —</text>
    `;
    currentY += separatorHeight;

    group.items.forEach((p) => {
      const formattedDate = formatDateForSheet(p.date);
      const responsibleOfficer = getResponsibleOfficer(p.contractor);
      const cleanedContractor = cleanContractorForDisplay(p.contractor);
      const isVip = isVipFn ? isVipFn(p.name) : false;

      const rowValues = [
        String(serial++),
        formatRoomForSheet(p.room),
        p.name,
        p.physician,
        cleanedContractor,
        responsibleOfficer,
        formattedDate,
        isVip ? 'VIP' : '',
      ];

      let cellX = 0;
      rowValues.forEach((val, idx) => {
        const colDef = cols[idx];
        const isVipCell = idx === 7 && Boolean(val);
        const textColor = isVipCell ? '#D32F2F' : '#000000';
        const isBold = idx >= 1 && idx <= 5;
        const cellId = `cp_occ_${serial}_${idx}`;
        const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
        const displayVal = truncateText(val, maxChars);

        tableSvgContent += `
          <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
          <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
          <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold || isVipCell ? 'bold' : 'normal'}" fill="${textColor}" text-anchor="middle">${escapeXml(displayVal)}</text>
        `;
        cellX += colDef.width;
      });

      currentY += rowHeight;
    });
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('الإشغال', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: processedData.length };
}

/**
 * 2. Admissions Sheet (Formatted Entry - 100% identical to addRefinedEntrySheet)
 * Columns (7): ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'مسئول التعاقد', 'Booking Date / تاريخ الحجز']
 * STRICTLY EXCLUDES: OR, Home Care, Dialysis, Well Baby.
 */
export async function generateEntriesJpeg(
  entryPatients: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any,
  dialysisCases: any[] = []
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1170;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;
  const separatorHeight = 28;

  const cols = [
    { label: '# / الرقم', width: 65 },
    { label: 'Room / الغرفة', width: 115 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'Physician / الطبيب المعالج', width: 235 },
    { label: 'Contract / التعاقد', width: 205 },
    { label: 'مسئول التعاقد', width: 135 },
    { label: 'Booking Date / تاريخ الحجز', width: 135 },
  ];

  // Strictly exclude non-inpatient admissions: OR/Cath Lab, HomeCare, Dialysis, Well Baby
  const processedData = (entryPatients || []).filter((p) => {
    if (!p) return false;
    const roomStr = String(p.room || p.colB || '').trim();
    const nameStr = String(p.name || p.colD || '').trim();
    const contractorStr = String(p.contractor || p.colM || '').trim();
    const physicianStr = String(p.physician || p.colW || '').trim();
    return !isOccupancyExcluded(roomStr, nameStr, contractorStr, physicianStr, dialysisCases);
  });

  // Group and sort identically to addRefinedEntrySheet
  const groupedItems: { groupName: string; items: any[] }[] = [];
  processedData.forEach((p) => {
    const roomStr = String(p.room || p.colB || '');
    const groupName = getDepartmentGroup(roomStr, 0);
    let existing = groupedItems.find((g) => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  groupedItems.sort((a, b) => groupOrderRank(a.groupName) - groupOrderRank(b.groupName));
  groupedItems.forEach((g) => {
    g.items.sort((a, b) => {
      const rA = String(a.room || a.colB || '');
      const rB = String(b.room || b.colB || '');
      const numA = parseInt(rA.match(/\d+/)?.[0] || '0');
      const numB = parseInt(rB.match(/\d+/)?.[0] || '0');
      if (numA !== numB) return numA - numB;
      return rA.localeCompare(rB);
    });
  });

  let totalTableHeight = tableHeaderHeight;
  groupedItems.forEach((g) => {
    totalTableHeight += separatorHeight + g.items.length * rowHeight;
  });
  totalTableHeight += 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col, idx) => {
    const hdrId = `cp_enthdr_${idx}`;
    tableSvgContent += `
      <clipPath id="${hdrId}"><rect x="${colX + 2}" y="0" width="${col.width - 4}" height="${tableHeaderHeight}"/></clipPath>
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text clip-path="url(#${hdrId})" x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  groupedItems.forEach((group) => {
    const rColors = getGroupColors(group.groupName);
    const displayGroupName = group.groupName === 'VIP' ? 'VIP ICU' : group.groupName;

    tableSvgContent += `
      <rect x="0" y="${currentY}" width="${width}" height="${separatorHeight}" fill="${rColors.badge}" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${width / 2}" y="${currentY + separatorHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">—  ${escapeXml(displayGroupName)}  —</text>
    `;
    currentY += separatorHeight;

    group.items.forEach((p) => {
      const contractorVal = p.contractor || p.colM || '';
      const cleanedContractor = cleanContractorForDisplay(contractorVal);
      const patientName = String(p.name || p.colD || '').trim();

      const rowValues = [
        String(serial++),
        formatRoomForSheet(p.room || p.colB || ''),
        patientName,
        p.physician || p.colW || '',
        cleanedContractor,
        getResponsibleOfficer(contractorVal),
        formatDateForSheet(p.date || p.colA),
      ];

      let cellX = 0;
      rowValues.forEach((val, idx) => {
        const colDef = cols[idx];
        const isBold = idx >= 1 && idx <= 5;
        const cellId = `cp_ent_${serial}_${idx}`;
        const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
        const displayVal = truncateText(val, maxChars);

        tableSvgContent += `
          <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
          <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
          <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
        `;
        cellX += colDef.width;
      });
      currentY += rowHeight;
    });
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('دخول', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: processedData.length };
}

/**
 * 3. Dialysis Sheet (100% identical to addRefinedDialysisSheet)
 * Columns (7): ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'مسئول التعاقد', 'Booking Date / تاريخ الحجز']
 */
export async function generateDialysisJpeg(
  dialysisPatients: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1200;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;
  const separatorHeight = 28;

  const cols = [
    { label: '# / الرقم', width: 65 },
    { label: 'Room / الغرفة', width: 145 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'Physician / الطبيب المعالج', width: 235 },
    { label: 'Contract / التعاقد', width: 205 },
    { label: 'مسئول التعاقد', width: 135 },
    { label: 'Booking Date / تاريخ الحجز', width: 135 },
  ];

  // Filter identically to addRefinedDialysisSheet and deduplicate
  const filteredRaw = (dialysisPatients || []).filter((p) => {
    if (!p) return false;
    const room = String(p.room || '').trim();
    if (isOperatingRoom(room) || room.includes('323')) return false;
    const rowAsString = Object.values(p).join(' ').toLowerCase();
    return !DIALYSIS_EXCLUSIONS.some((kw) => rowAsString.includes(kw));
  });

  const resolvedList: any[] = [];
  filteredRaw.forEach((p) => {
    let patientName = String(p.name || '').trim();
    let physicianVal = String(p.physician || '').trim();
    let contractorVal = String(p.contractor || p.payment || '').trim();
    let roomVal = String(p.room || 'Dialysis').trim();
    const directMrn = String(p.mrn || p.id || '').trim();

    let resolvedMrn = directMrn;
    if (/^\d{4,}$/.test(patientName)) {
      resolvedMrn = patientName;
      const matched = mrnLookupInput?.getPatientByMrn
        ? mrnLookupInput.getPatientByMrn(resolvedMrn)
        : mrnLookupInput?.mrnToPatient?.get(resolvedMrn);
      if (matched) {
        patientName = matched.name || patientName;
        if (!physicianVal) physicianVal = matched.physician || '';
        if (!contractorVal) contractorVal = matched.contractor || '';
        if ((roomVal === 'غسيل كلوي' || roomVal === 'Dialysis') && matched.room) roomVal = matched.room;
      }
    } else {
      resolvedMrn = resolvePatientMrn(patientName, directMrn, mrnLookupInput);
    }

    const isDup = resolvedList.some((existing) => {
      if (isRealMrnCode(resolvedMrn) && existing.mrn === resolvedMrn) return true;
      if (patientName && existing.name && isNameMatch(patientName, existing.name)) return true;
      return false;
    });

    if (!isDup) {
      resolvedList.push({
        room: roomVal,
        mrn: resolvedMrn,
        name: patientName,
        physician: physicianVal,
        contractor: contractorVal,
        date: p.date,
      });
    }
  });

  // Group and sort identically to addRefinedDialysisSheet
  const groupedItems: { groupName: string; items: any[] }[] = [];
  resolvedList.forEach((p) => {
    const roomStr = String(p.room || '').toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || '-1');
    let groupName = 'OTHER';
    if (roomStr.includes('PICU')) groupName = 'PICU';
    else if (roomStr.includes('NICU')) groupName = 'NICU';
    else if (roomStr.includes('CCU')) groupName = 'CCU';
    else if (roomStr.includes('SICU')) groupName = 'SICU';
    else if (roomStr.includes('VIP') || roomStr.includes('VIP ISOLATION')) groupName = 'VIP';
    else if (roomStr.includes('ICU')) groupName = 'ICU';
    else if (roomNum >= 101 && roomNum <= 108) groupName = 'First Floor';
    else if (roomNum >= 301 && roomNum <= 319) groupName = 'Zone A (301-319)';
    else if (roomNum >= 320 && roomNum <= 329) groupName = 'Zone B (320-329)';
    else if (roomNum >= 330 && roomNum <= 332) groupName = 'Zone C (330-332)';
    else if (roomNum >= 401 && roomNum <= 422) groupName = '4th Floor';
    else if (!isNaN(roomNum) && roomNum >= 0) groupName = 'Floor ' + Math.floor(roomNum / 100);

    let existing = groupedItems.find((g) => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  groupedItems.sort((a, b) => groupOrderRank(a.groupName) - groupOrderRank(b.groupName));
  groupedItems.forEach((g) => {
    g.items.sort((a, b) => {
      const numA = parseInt(String(a.room || '').match(/\d+/)?.[0] || '0');
      const numB = parseInt(String(b.room || '').match(/\d+/)?.[0] || '0');
      if (numA !== numB) return numA - numB;
      return String(a.room || '').localeCompare(String(b.room || ''));
    });
  });

  let totalTableHeight = tableHeaderHeight;
  groupedItems.forEach((g) => {
    totalTableHeight += separatorHeight + g.items.length * rowHeight;
  });
  totalTableHeight += 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col, idx) => {
    const hdrId = `cp_diahdr_${idx}`;
    tableSvgContent += `
      <clipPath id="${hdrId}"><rect x="${colX + 2}" y="0" width="${col.width - 4}" height="${tableHeaderHeight}"/></clipPath>
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text clip-path="url(#${hdrId})" x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  groupedItems.forEach((group) => {
    const rColors = getGroupColors(group.groupName);
    const displayGroupName = group.groupName === 'VIP' ? 'VIP ICU' : group.groupName;
    const sepText =
      displayGroupName === 'Floor 0' || displayGroupName === 'OTHER'
        ? `—  Dialysis Beds (Total cases of dialysis: ${group.items.length})  —`
        : `—  ${displayGroupName}  —`;

    tableSvgContent += `
      <rect x="0" y="${currentY}" width="${width}" height="${separatorHeight}" fill="${rColors.badge}" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${width / 2}" y="${currentY + separatorHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(sepText)}</text>
    `;
    currentY += separatorHeight;

    group.items.forEach((p) => {
      const cleanedContractor = cleanContractorForDisplay(p.contractor);

      const rowValues = [
        String(serial++),
        formatRoomForSheet(p.room),
        p.name,
        p.physician,
        cleanedContractor,
        getResponsibleOfficer(p.contractor),
        formatDateForSheet(p.date),
      ];

      let cellX = 0;
      rowValues.forEach((val, idx) => {
        const colDef = cols[idx];
        const isBold = idx >= 1 && idx <= 5;
        const cellId = `cp_dia_${serial}_${idx}`;
        const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
        const displayVal = truncateText(val, maxChars);

        tableSvgContent += `
          <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
          <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
          <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
        `;
        cellX += colDef.width;
      });
      currentY += rowHeight;
    });
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('حالات الغسيل الكلوي', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: resolvedList.length };
}

/**
 * 4. Discharges Sheet (Formatted Exit - 100% identical to addRefinedExitSheet)
 * Columns (8): ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'مسئول التعاقد', 'Admission Date / تاريخ الدخول', 'VIP STATUS']
 * STRICTLY EXCLUDES: OR, Home Care, Dialysis, Well Baby.
 */
export async function generateExitJpeg(
  dischargedPatients: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any,
  dialysisCases: any[] = [],
  isVipFn?: (name: string) => boolean
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1250;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;
  const separatorHeight = 28;

  const cols = [
    { label: '# / الرقم', width: 65 },
    { label: 'Room / الغرفة', width: 115 },
    { label: 'Patient / اسم المريض', width: 275 },
    { label: 'Physician / الطبيب المعالج', width: 235 },
    { label: 'Contract / التعاقد', width: 205 },
    { label: 'مسئول التعاقد', width: 130 },
    { label: 'Admission Date / تاريخ الدخول', width: 155 },
    { label: 'VIP STATUS', width: 70 },
  ];

  // Filter identically to addRefinedExitSheet + exclude dialysis cases
  const processedData = (dischargedPatients || []).filter((p) => {
    if (!p) return false;
    const roomStr = String(p.room || p.lastRoom || '').trim();
    const nameStr = String(p.name || '').trim();
    const contractorStr = String(p.contractor || '').trim();
    const physicianStr = String(p.physician || '').trim();
    return !isOccupancyExcluded(roomStr, nameStr, contractorStr, physicianStr, dialysisCases);
  });

  // Group and sort identically to addRefinedExitSheet
  const groupedItems: { groupName: string; items: any[] }[] = [];
  processedData.forEach((p) => {
    const roomStr = String(p.room || p.lastRoom || '');
    const groupName = getDepartmentGroup(roomStr, 0);
    let existing = groupedItems.find((g) => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  groupedItems.sort((a, b) => groupOrderRank(a.groupName) - groupOrderRank(b.groupName));
  groupedItems.forEach((g) => {
    g.items.sort((a, b) => {
      const rA = String(a.room || a.lastRoom || '');
      const rB = String(b.room || b.lastRoom || '');
      const numA = parseInt(rA.match(/\d+/)?.[0] || '0');
      const numB = parseInt(rB.match(/\d+/)?.[0] || '0');
      if (numA !== numB) return numA - numB;
      return rA.localeCompare(rB);
    });
  });

  let totalTableHeight = tableHeaderHeight;
  groupedItems.forEach((g) => {
    totalTableHeight += separatorHeight + g.items.length * rowHeight;
  });
  totalTableHeight += 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col, idx) => {
    const hdrId = `cp_exithdr_${idx}`;
    tableSvgContent += `
      <clipPath id="${hdrId}"><rect x="${colX + 2}" y="0" width="${col.width - 4}" height="${tableHeaderHeight}"/></clipPath>
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text clip-path="url(#${hdrId})" x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  groupedItems.forEach((group) => {
    const rColors = getGroupColors(group.groupName);
    const displayGroupName = group.groupName === 'VIP' ? 'VIP ICU' : group.groupName;

    tableSvgContent += `
      <rect x="0" y="${currentY}" width="${width}" height="${separatorHeight}" fill="${rColors.badge}" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${width / 2}" y="${currentY + separatorHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">—  ${escapeXml(displayGroupName)}  —</text>
    `;
    currentY += separatorHeight;

    group.items.forEach((p) => {
      const contractorVal = p.contractor || '';
      const cleanedContractor = cleanContractorForDisplay(contractorVal);
      const patientName = String(p.name || '').trim();
      const isVip = isVipFn ? isVipFn(patientName) : false;

      const rowValues = [
        String(serial++),
        formatRoomForSheet(p.room || p.lastRoom || ''),
        patientName,
        p.physician || '',
        cleanedContractor,
        getResponsibleOfficer(contractorVal),
        formatDateForSheet(p.date || p.admissionDate || p.dischargeDate),
        isVip ? 'VIP' : '',
      ];

      let cellX = 0;
      rowValues.forEach((val, idx) => {
        const colDef = cols[idx];
        const isVipCell = idx === 7 && Boolean(val);
        const textColor = isVipCell ? '#D32F2F' : '#000000';
        const isBold = idx >= 1 && idx <= 5;
        const cellId = `cp_exit_${serial}_${idx}`;
        const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
        const displayVal = truncateText(val, maxChars);

        tableSvgContent += `
          <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
          <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
          <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold || isVipCell ? 'bold' : 'normal'}" fill="${textColor}" text-anchor="middle">${escapeXml(displayVal)}</text>
        `;
        cellX += colDef.width;
      });
      currentY += rowHeight;
    });
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('خروج', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: processedData.length };
}

/**
 * 5. General Debts Sheet (Cash Debts - 100% identical to addRefinedDebtsSheet)
 * Columns (11): ['تاريخ الدخول / Date', 'Room / الغرفة', 'MRN / كود المريض', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'مسئول التعاقد', 'Total Bill / إجمالي الحساب (Z)', 'Remaining Amount / المبلغ المتبقي', 'Remaining Pct / نسبة المتبقي (%)', 'VIP STATUS']
 */
export async function generateDebtsJpeg(
  debts: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any,
  isVipFn?: (name: string) => boolean
): Promise<{ buffer: Buffer; count: number; positiveRemaining: number }> {
  const width = 1695;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 38;
  const separatorHeight = 30;

  const cols = [
    { label: 'تاريخ الدخول / Date', width: 130 },
    { label: 'Room / الغرفة', width: 120 },
    { label: 'MRN / كود المريض', width: 125 },
    { label: 'Patient / اسم المريض', width: 240 },
    { label: 'Physician / الطبيب المعالج', width: 200 },
    { label: 'Contract / التعاقد', width: 180 },
    { label: 'مسئول التعاقد', width: 130 },
    { label: 'Total Bill / إجمالي الحساب (Z)', width: 170 },
    { label: 'Remaining Amount / المبلغ المتبقي', width: 180 },
    { label: 'Remaining Pct / نسبة المتبقي (%)', width: 145 },
    { label: 'VIP STATUS', width: 75 },
  ];

  // Process, compute pct, and split into above50 (>= 50%) and below50 (< 50%) identically to addRefinedDebtsSheet
  let totalPositiveRemaining = 0;
  const processedDebts = (debts || []).map((p) => {
    let valAB =
      typeof p.valAB === 'number'
        ? p.valAB
        : parseFloat(
            String(
              p.valAB !== undefined
                ? p.valAB
                : p.remainingAmount !== undefined
                ? p.remainingAmount
                : p.remaining !== undefined
                ? p.remaining
                : p.colAB || ''
            ).replace(/[^0-9.-]+/g, '')
          ) || 0;
    let valZ =
      typeof p.valZ === 'number'
        ? p.valZ
        : parseFloat(
            String(
              p.valZ !== undefined
                ? p.valZ
                : p.totalInvoice !== undefined
                ? p.totalInvoice
                : p.total !== undefined
                ? p.total
                : p.colZ || ''
            ).replace(/[^0-9.-]+/g, '')
          ) || 0;
    if (valZ === 0 && valAB > 0) valZ = valAB;
    const pct = valZ > 0 ? valAB / valZ : valAB > 0 ? 1 : 0;
    if (valAB > 0) {
      totalPositiveRemaining += valAB;
    }
    return { ...p, valAB, valZ, pct };
  });

  const above50 = processedDebts.filter((p) => p.pct >= 0.5);
  const below50 = processedDebts.filter((p) => p.pct < 0.5);

  above50.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return b.valAB - a.valAB;
  });
  below50.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return b.valAB - a.valAB;
  });

  const hasSeparator = above50.length > 0 && below50.length > 0;
  const totalTableHeight =
    tableHeaderHeight +
    Math.max(processedDebts.length, 1) * rowHeight +
    (hasSeparator ? separatorHeight : 0) +
    30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col, idx) => {
    const hdrCellId = `cp_debthdr_${idx}`;
    tableSvgContent += `
      <clipPath id="${hdrCellId}"><rect x="${colX + 2}" y="0" width="${col.width - 4}" height="${tableHeaderHeight}"/></clipPath>
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text clip-path="url(#${hdrCellId})" x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="10.5" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let rowCounter = 1;

  const renderDebtRow = (p: any) => {
    rowCounter++;
    const rawContract =
      p.contractor && String(p.contractor).trim() !== ''
        ? String(p.contractor).trim()
        : p.colM && String(p.colM).trim() !== ''
        ? String(p.colM).trim()
        : 'Cash';
    const cleanedContractor = cleanContractorForDisplay(rawContract);

    let patientName = String(p.colD || p.name || p.patientName || p.patient || '').trim();
    const mrnVal = String(p.mrn || p.id || p.colC || '').trim();
    if (!patientName && isRealMrnCode(mrnVal) && mrnLookupInput?.getPatientByMrn) {
      const fromMrn = mrnLookupInput.getPatientByMrn(mrnVal);
      if (fromMrn?.name) patientName = fromMrn.name;
    }
    const resolvedMrn = resolvePatientMrn(patientName, mrnVal, mrnLookupInput);

    let physicianVal = String(p.physician || p.doctor || p.colW || '').trim();
    if (!physicianVal && isRealMrnCode(resolvedMrn) && mrnLookupInput?.getPatientByMrn) {
      const fromMrn = mrnLookupInput.getPatientByMrn(resolvedMrn);
      if (fromMrn?.physician) physicianVal = fromMrn.physician;
    }

    const roomRaw = String(p.room || p.bed || p.colB || '');
    const groupName = getDepartmentGroup(roomRaw, 0);
    const rColors = getGroupColors(groupName);
    const isVip = isVipFn ? isVipFn(patientName) : false;

    const valZFormatted = p.valZ.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const valABFormatted = p.valAB.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pctFormatted = `${(p.pct * 100).toFixed(1)}%`;

    const rowValues = [
      formatDateForSheet(p.colA || p.date || p.admissionDate || ''),
      formatRoomForSheet(roomRaw),
      isRealMrnCode(resolvedMrn) ? formatMrnForSheet(resolvedMrn) : 'N/A',
      patientName,
      physicianVal,
      cleanedContractor,
      getResponsibleOfficer(rawContract),
      valZFormatted,
      valABFormatted,
      pctFormatted,
      isVip ? 'VIP' : '',
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const cellId = `cp_debt_${rowCounter}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      let textColor = '#000000';
      let isBold = false;
      if (idx === 1 || idx === 3 || idx === 4 || idx === 5 || idx === 6) {
        isBold = true;
      } else if (idx === 8) {
        isBold = true;
        textColor = '#C00000';
      } else if (idx === 9) {
        isBold = true;
        textColor = '#1F4E79';
      } else if (idx === 10 && Boolean(val)) {
        isBold = true;
        textColor = '#D32F2F';
      }

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
      `;

      // Subtle dataBar on Remaining Pct column (idx === 9) matching addRefinedDebtsSheet
      if (idx === 9 && p.pct > 0) {
        const clampedPct = Math.min(Math.max(p.pct, 0), 1);
        const barW = Math.max(Math.floor((colDef.width - 6) * clampedPct), 2);
        tableSvgContent += `
          <rect x="${cellX + 3}" y="${currentY + 4}" width="${barW}" height="${rowHeight - 8}" rx="2" ry="2" fill="#638EC6" fill-opacity="0.28"/>
        `;
      }

      tableSvgContent += `
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="${textColor}" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });

    currentY += rowHeight;
  };

  // 1. Patients with >= 50% remaining
  above50.forEach((p) => renderDebtRow(p));

  // 2. 50% threshold crimson separator row matching addRefinedDebtsSheet
  if (hasSeparator) {
    tableSvgContent += `
      <rect x="0" y="${currentY}" width="${width}" height="${separatorHeight}" fill="#D32F2F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${width / 2}" y="${currentY + separatorHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">— متبقي أقل من 50% / Remaining Less Than 50% —</text>
    `;
    currentY += separatorHeight;
  }

  // 3. Patients with < 50% remaining
  below50.forEach((p) => renderDebtRow(p));

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('مديونيات المرضى (نقدي) / Cash Debts', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: processedDebts.length, positiveRemaining: totalPositiveRemaining };
}

/**
 * 6. Patient Transfers Sheet (100% identical to addRefinedTransfersSheet)
 * Columns (9): ['# / م', 'اسم المريض / Patient Name', 'مسار التحويلات / Transfer Journey', 'الغرفة السابقة / From Room', 'الغرفة الحالية / Current Room', 'تاريخ التحويل / Transfer Date', 'الطبيب المعالج / Physician', 'الجهة والتعاقد / Contractor', 'مسئول التعاقد']
 */
export async function generateTransfersJpeg(
  transfers: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1540;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 38;

  const cols = [
    { label: '# / م', width: 50 },
    { label: 'اسم المريض / Patient Name', width: 240 },
    { label: 'مسار التحويلات / Transfer Journey', width: 295 },
    { label: 'الغرفة السابقة / From Room', width: 155 },
    { label: 'الغرفة الحالية / Current Room', width: 165 },
    { label: 'تاريخ التحويل / Transfer Date', width: 160 },
    { label: 'الطبيب المعالج / Physician', width: 190 },
    { label: 'الجهة والتعاقد / Contractor', width: 165 },
    { label: 'مسئول التعاقد', width: 120 },
  ];

  const list = transfers || [];
  const totalTableHeight = tableHeaderHeight + Math.max(list.length, 1) * rowHeight + 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#0B3C34"/>
  `;

  let colX = 0;
  cols.forEach((col, idx) => {
    const hdrCellId = `cp_trhdr_${idx}`;
    tableSvgContent += `
      <clipPath id="${hdrCellId}"><rect x="${colX + 2}" y="0" width="${col.width - 4}" height="${tableHeaderHeight}"/></clipPath>
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#0B3C34" stroke="#B2B2B2" stroke-width="0.8"/>
      <text clip-path="url(#${hdrCellId})" x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="10.5" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  list.forEach((t, rowIdx) => {
    const contractorVal = t.contractor || '';
    const cleanedContractor = cleanContractorForDisplay(contractorVal) || '-';
    const responsibleOfficer = getResponsibleOfficer(contractorVal);
    const patientName = String(t.name || t.patientName || '').trim() || '-';

    const journeyStr =
      Array.isArray(t.journey) && t.journey.length > 0
        ? t.journey.map((r: any) => formatRoomForSheet(r)).join('  ->  ')
        : `${formatRoomForSheet(t.initialRoom || t.fromRoom || '')}  ->  ${formatRoomForSheet(t.currentRoom || t.toRoom || '')}`;

    const prevRoom =
      formatRoomForSheet(
        t.history && t.history.length > 0
          ? t.history[t.history.length - 1].fromRoom
          : t.initialRoom || t.fromRoom || '-'
      ) || '-';

    const currRoom = formatRoomForSheet(t.currentRoom || t.toRoom || '-') || '-';
    const rawDate =
      t.lastTransferDate ||
      t.date ||
      (t.history && t.history.length > 0 ? t.history[t.history.length - 1].date : '') ||
      '';
    const formattedDate = formatDateForSheet(rawDate) || '-';

    const rowValues = [
      String(serial++),
      patientName,
      journeyStr,
      prevRoom,
      currRoom,
      formattedDate,
      t.physician || '-',
      cleanedContractor,
      responsibleOfficer,
    ];

    const rowBg = rowIdx % 2 === 0 ? '#FFFFFF' : '#F4F9F8';

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const cellId = `cp_trans_${serial}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      let textColor = '#000000';
      let isBold = false;
      if (idx === 1) {
        isBold = true;
        textColor = '#0B3C34';
      } else if (idx === 2) {
        isBold = true;
        textColor = '#0070BA';
      } else if (idx === 3) {
        isBold = true;
        textColor = '#555555';
      } else if (idx === 4) {
        isBold = true;
        textColor = '#2E7D32';
      } else if (idx === 6 || idx === 7 || idx === 8) {
        isBold = true;
      }

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rowBg}" stroke="#D2D7D9" stroke-width="0.8"/>
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="${textColor}" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('سجل تحويلات المرضى بين الغرف', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: list.length };
}
