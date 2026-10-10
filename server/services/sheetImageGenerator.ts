import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { getResponsibleOfficer, formatDateForSheet, cleanContractorForDisplay } from '../contractorOfficers.js';
import { isNameMatch, normalizeArabicName, isOperatingRoom, isOrXRoom, cleanRoomStr } from '../nameUtils.js';

export { getResponsibleOfficer, formatDateForSheet, cleanContractorForDisplay };

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
 * Creates the signature Mohanad Excel header banner:
 * Header background image with centered frosted glass text box overlay.
 */
async function createExcelHeaderBuffer(title: string, width: number, height = 180): Promise<Buffer> {
  const safeTitle = escapeXml(title);
  const boxWidth = Math.min(500, width - 80);
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
 */
export class MrnResolver {
  public exactMap = new Map<string, string>();
  public normMap = new Map<string, string>();
  public mrnToPatient = new Map<string, { name: string; physician?: string; contractor?: string; room?: string }>();
  public allPairs: Array<{ name: string; normName: string; mrn: string }> = [];

  public add(name: string, mrn: string, details?: { physician?: string; contractor?: string; room?: string }) {
    const rawName = String(name || '').trim();
    const cleanMrn = String(mrn || '').trim();
    if (
      !cleanMrn ||
      cleanMrn === '—' ||
      cleanMrn === '-' ||
      cleanMrn.toLowerCase() === 'undefined' ||
      cleanMrn.toLowerCase() === 'null' ||
      cleanMrn.startsWith('transfer-') ||
      cleanMrn.toLowerCase().includes('transfer') ||
      cleanMrn.length > 20
    ) {
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
    if (
      direct &&
      direct !== '—' &&
      direct !== '-' &&
      direct.toLowerCase() !== 'undefined' &&
      direct.toLowerCase() !== 'null' &&
      !direct.startsWith('transfer-') &&
      !direct.toLowerCase().includes('transfer')
    ) {
      return direct;
    }
    const rawName = String(patientName || '').trim();
    if (!rawName) return '—';

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

    return '—';
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
    const isUnified = r.length >= 10 || (String(r[0] || "").includes("T") || (/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(String(r[0] || ""))));
    let room = "";
    let name = "";
    let physician = "";
    let contractor = "";
    let mrn = "";

    if (isUnified) {
      room = String(r[1] || "").trim();
      mrn = String(r[2] || "").trim();
      name = String(r[3] || "").trim();
      contractor = String(r[12] || "").trim();
      physician = String(r[22] || "").trim();
    } else {
      room = String(r[0] || "").trim();
      name = String(r[1] || "").trim();
      physician = String(r[2] || "").trim();
      contractor = String(r[3] || "").trim();
      mrn = String(r[5] || "").trim();
    }

    // Skip table headers and empty rows
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
      mrn.startsWith('transfer-')
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
      const rawCandidate = String(item.mrn || item.patientId || item.barcode || item.colC || item.code || (item.id && !String(item.id).startsWith('transfer-') ? item.id : '') || '').trim();
      const physician = String(item.physician || item.doctor || item.colW || '').trim();
      const contractor = String(item.contractor || item.payment || item.colM || '').trim();
      const room = String(item.room || item.bed || item.colB || '').trim();

      if (name && rawCandidate && !rawCandidate.startsWith('transfer-') && !rawCandidate.toLowerCase().includes('transfer')) {
        resolver.add(name, rawCandidate, { room, physician, contractor });
      }
    });
  });

  return resolver;
}

/**
 * 1. Occupancy Sheet (Colored Structured Grid)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 * STRICTLY EXCLUDES: OR, Home Care, Dialysis, Well Baby.
 */
export async function generateOccupancyJpeg(
  rawHospitalData: any[][],
  dateLabel: string,
  isVipFn?: (name: string) => boolean,
  dialysisCases: any[] = []
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1320;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 36;
  const separatorHeight = 24;

  const cols = [
    { label: '# / الرقم', width: 60 },
    { label: 'Room / الغرفة', width: 110 },
    { label: 'MRN / الملف', width: 110 },
    { label: 'Patient / اسم المريض', width: 270 },
    { label: 'Physician / الطبيب المعالج', width: 230 },
    { label: 'Contract / التعاقد', width: 210 },
    { label: 'مسئول التعاقد', width: 140 },
    { label: 'Booking Date / تاريخ الحجز', width: 120 },
    { label: 'VIP STATUS', width: 70 },
  ];

  // 1. Universal row parser: supports 39-col unified raw, 6-col formatted, and object lists
  const rawList: any[] = [];
  (rawHospitalData || []).forEach((row) => {
    if (!row) return;

    if (!Array.isArray(row) && typeof row === 'object') {
      const room = cleanRoomStr(String(row.room || row.bed || row.colB || '').trim());
      const name = String(row.name || row.patient || row.colD || '').trim();
      const physician = String(row.physician || row.doctor || row.colW || '').trim();
      const contractor = String(row.contractor || row.payment || row.colM || '').trim();
      const date = String(row.date || row.bookingDate || row.colA || '').trim();
      const mrn = String(row.mrn || row.id || row.colC || row.colF || '').trim();
      if (room && name && name.toLowerCase() !== 'patient' && name !== 'المريض') {
        rawList.push({ room, name, physician, contractor, date, mrn });
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

    // Skip table headers and empty/metadata rows
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
      (!row[0] && !row[1] && !row[2] && !row[3])
    ) {
      return;
    }

    // Unified raw table (>=10 cols) vs Formatted table (6 cols)
    const isUnified = row.length >= 10 || (str0Low.includes('t') || (/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(str0)));

    let room = '';
    let name = '';
    let physician = '';
    let contractor = '';
    let date = '';
    let mrn = '';

    if (isUnified) {
      date = str0;
      room = cleanRoomStr(String(row[1] || '').trim());
      mrn = String(row[2] || '').trim();
      name = String(row[3] || '').trim();
      contractor = String(row[12] || '').trim();
      physician = String(row[22] || '').trim();
    } else {
      room = cleanRoomStr(String(row[0] || '').trim());
      name = String(row[1] || '').trim();
      physician = String(row[2] || '').trim();
      contractor = String(row[3] || '').trim();
      date = String(row[4] || '').trim();
      mrn = String(row[5] || '').trim();
    }

    if (room && name && name.toLowerCase() !== 'patient' && name !== 'المريض') {
      rawList.push({ room, name, physician, contractor, date, mrn });
    }
  });

  // 2. Strict Inpatient Exclusion Filter:
  // Strictly excludes: OR, Home Care, Dialysis, Well Baby, Day Case
  const processedData = rawList.filter(
    (p) => !isOccupancyExcluded(p.room, p.name, p.contractor, p.physician, dialysisCases)
  );

  // 3. Sort identically to Excel coloured structured grid sheet
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

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes('ICU') && !g.includes('VIP')) return { badge: '#3F889E', row: '#EBF2F5' };
    if (g.includes('SICU')) return { badge: '#5C5A7F', row: '#F1EFF5' };
    if (g.includes('VIP')) return { badge: '#2E7D32', row: '#EBF5EB' };
    if (g.includes('CCU')) return { badge: '#1565C0', row: '#EBF5FB' };
    if (g.includes('NICU')) return { badge: '#EF6C00', row: '#FFF5EB' };
    if (g.includes('PICU')) return { badge: '#AD1457', row: '#FFEBEF' };
    return { badge: '#455A64', row: '#F5F7F8' };
  };

  // 4. Group items by clinical department and floor zones
  const groupedItems: { groupName: string; items: any[] }[] = [];
  processedData.forEach((p) => {
    const roomStr = p.room.toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || '0');
    let groupName = 'OTHER';
    if (roomStr.includes('PICU')) groupName = 'PICU';
    else if (roomStr.includes('NICU')) groupName = 'NICU';
    else if (roomStr.includes('CCU')) groupName = 'CCU';
    else if (roomStr.includes('SICU')) groupName = 'SICU';
    else if (roomStr.includes('VIP') || roomStr.includes('VIP ISOLATION')) groupName = 'VIP';
    else if (roomStr.includes('ICU')) groupName = 'ICU';
    else if (roomNum >= 101 && roomNum <= 108) groupName = '1st Floor (101-108)';
    else if (roomNum >= 301 && roomNum <= 319) groupName = '301-319';
    else if (roomNum >= 320 && roomNum <= 329) groupName = '320-329';
    else if (roomNum >= 330 && roomNum <= 332) groupName = '330-332';
    else if (roomNum >= 401 && roomNum <= 422) groupName = '4th Floor (401-422)';
    else if (!isNaN(roomNum) && roomNum > 0) groupName = 'Floor ' + Math.floor(roomNum / 100);

    let existing = groupedItems.find((g) => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  // Calculate table height including #FCE4D6 separator rows between groups
  let totalTableHeight = tableHeaderHeight;
  groupedItems.forEach((g) => {
    totalTableHeight += separatorHeight + g.items.length * rowHeight;
  });
  totalTableHeight += 40;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <!-- Table Header Row (Dark Slate #37474F) -->
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col) => {
    tableSvgContent += `
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  groupedItems.forEach((group) => {
    const rColors = getGroupColors(group.groupName);
    const displayGroupName = group.groupName === 'VIP' ? 'VIP ICU' : group.groupName;

    // Coloured Structured Grid Separator Row:
    // Rendered in exact Excel separator color #FCE4D6 with cell borders #B2B2B2
    let sepX = 0;
    cols.forEach((col) => {
      tableSvgContent += `
        <rect x="${sepX}" y="${currentY}" width="${col.width}" height="${separatorHeight}" fill="#FCE4D6" stroke="#B2B2B2" stroke-width="0.8"/>
      `;
      sepX += col.width;
    });

    tableSvgContent += `
      <text x="${width / 2}" y="${currentY + separatorHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#7C3B14" text-anchor="middle">■  ${escapeXml(displayGroupName)}  ■</text>
    `;
    currentY += separatorHeight;

    // Patient rows for this group
    group.items.forEach((p) => {
      const formattedDate = formatDateForSheet(p.date);
      const responsibleOfficer = getResponsibleOfficer(p.contractor);
      const cleanedContractor = cleanContractorForDisplay(p.contractor);
      const isVip = isVipFn ? isVipFn(p.name) : false;

      const rowValues = [
        String(serial++),
        p.room,
        p.mrn || '—',
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
        const isVipCell = idx === 8 && Boolean(val);
        const textColor = isVipCell ? '#D32F2F' : '#000000';
        const isBold = idx >= 1 && idx <= 6;
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
 * 2. Admissions Sheet (Formatted Entry)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 * STRICTLY EXCLUDES: Dialysis cases.
 */
export async function generateEntriesJpeg(
  entryPatients: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any,
  dialysisCases: any[] = []
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 60 },
    { label: 'Room / الغرفة', width: 110 },
    { label: 'MRN / الملف', width: 110 },
    { label: 'Patient / اسم المريض', width: 270 },
    { label: 'Physician / الطبيب المعالج', width: 230 },
    { label: 'Contract / التعاقد', width: 210 },
    { label: 'مسئول التعاقد', width: 140 },
    { label: 'Booking Date / تاريخ الحجز', width: 130 },
  ];

  // Strictly exclude non-inpatient admissions: OR/Cath Lab, HomeCare, Dialysis, Well Baby
  const processedData = (entryPatients || []).filter((p) => {
    const roomStr = String(p.room || p.colB || '').trim();
    const nameStr = String(p.name || p.colD || '').trim();
    const contractorStr = String(p.contractor || p.colM || '').trim();
    const physicianStr = String(p.physician || p.colW || '').trim();
    return !isOccupancyExcluded(roomStr, nameStr, contractorStr, physicianStr, dialysisCases);
  });

  const totalTableHeight = tableHeaderHeight + Math.max(processedData.length, 1) * rowHeight + 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <!-- Table Header Row (Soft Light Blue #DDEBF7) -->
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#DDEBF7"/>
  `;

  let colX = 0;
  cols.forEach((col) => {
    tableSvgContent += `
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#DDEBF7" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="10" font-weight="bold" fill="#000000" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  processedData.forEach((p) => {
    const contractorVal = p.contractor || p.colM || '';
    const cleanedContractor = cleanContractorForDisplay(contractorVal);
    const patientName = String(p.name || p.colD || '').trim();
    const directMrn = String(p.mrn || p.colC || p.id || p.patientId || '').trim();

    let resolvedMrn = directMrn;
    if (!resolvedMrn || resolvedMrn === '—' || resolvedMrn === '-') {
      if (mrnLookupInput?.resolve) {
        resolvedMrn = mrnLookupInput.resolve(patientName, directMrn);
      } else if (mrnLookupInput instanceof Map) {
        resolvedMrn = mrnLookupInput.get(patientName.toLowerCase()) || '—';
      } else if (mrnLookupInput?.nameToMrn) {
        resolvedMrn = mrnLookupInput.nameToMrn.get(patientName.toLowerCase()) || '—';
      } else {
        resolvedMrn = '—';
      }
    }

    const rowValues = [
      String(serial++),
      p.room || p.colB || '',
      resolvedMrn || '—',
      patientName,
      p.physician || p.colW || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(p.date || p.colA),
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 1 && idx <= 6;
      const cellId = `cp_ent_${serial}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('دخول', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: processedData.length };
}

/**
 * 3. Dialysis Sheet (Formatted Dialysis)
 * Includes: ALL Dialysis cases ONLY, with MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 */
export async function generateDialysisJpeg(
  dialysisPatients: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 60 },
    { label: 'Room / الغرفة', width: 140 },
    { label: 'MRN / الملف', width: 110 },
    { label: 'Patient / اسم المريض', width: 270 },
    { label: 'Physician / الطبيب المعالج', width: 230 },
    { label: 'Contract / التعاقد', width: 210 },
    { label: 'مسئول التعاقد', width: 140 },
    { label: 'Admission Date / تاريخ الدخول', width: 100 },
  ];

  // Deduplicate dialysis patients while resolving any MRN-only entries
  const resolvedList: any[] = [];
  (dialysisPatients || []).forEach((p) => {
    let patientName = String(p.name || '').trim();
    let physicianVal = String(p.physician || '').trim();
    let contractorVal = String(p.contractor || p.payment || '').trim();
    let roomVal = String(p.room || 'غسيل كلوي').trim();
    let directMrn = String(p.mrn || p.id || '').trim();

    let resolvedMrn = directMrn;
    if (/^\d{4,}$/.test(patientName)) {
      resolvedMrn = patientName;
      const matched = mrnLookupInput?.getPatientByMrn ? mrnLookupInput.getPatientByMrn(resolvedMrn) : mrnLookupInput?.mrnToPatient?.get(resolvedMrn);
      if (matched) {
        patientName = matched.name || patientName;
        if (!physicianVal) physicianVal = matched.physician || '';
        if (!contractorVal) contractorVal = matched.contractor || '';
        if (roomVal === 'غسيل كلوي' && matched.room) roomVal = matched.room;
      }
    } else {
      if (!resolvedMrn || resolvedMrn === '—' || resolvedMrn === '-') {
        if (mrnLookupInput?.resolve) {
          resolvedMrn = mrnLookupInput.resolve(patientName, directMrn);
        } else if (mrnLookupInput instanceof Map) {
          resolvedMrn = mrnLookupInput.get(patientName.toLowerCase()) || '—';
        } else if (mrnLookupInput?.nameToMrn) {
          resolvedMrn = mrnLookupInput.nameToMrn.get(patientName.toLowerCase()) || '—';
        } else {
          resolvedMrn = '—';
        }
      }
    }

    // Check duplicate by MRN or Name
    const isDup = resolvedList.some((existing) => {
      if (resolvedMrn !== '—' && existing.mrn === resolvedMrn) return true;
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

  const totalTableHeight = tableHeaderHeight + Math.max(resolvedList.length, 1) * rowHeight + 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#DDEBF7"/>
  `;

  let colX = 0;
  cols.forEach((col) => {
    tableSvgContent += `
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#DDEBF7" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="10" font-weight="bold" fill="#000000" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  resolvedList.forEach((p) => {
    const cleanedContractor = cleanContractorForDisplay(p.contractor);

    const rowValues = [
      String(serial++),
      p.room,
      p.mrn,
      p.name,
      p.physician,
      cleanedContractor,
      getResponsibleOfficer(p.contractor),
      formatDateForSheet(p.date),
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 1 && idx <= 6;
      const cellId = `cp_dia_${serial}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('غسيل كلوى', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: resolvedList.length };
}

/**
 * 4. Discharges Sheet (Formatted Exit)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 * STRICTLY EXCLUDES: Dialysis cases.
 */
export async function generateExitJpeg(
  dischargedPatients: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any,
  dialysisCases: any[] = []
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 60 },
    { label: 'Room / الغرفة', width: 110 },
    { label: 'MRN / الملف', width: 110 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'Physician / الطبيب المعالج', width: 240 },
    { label: 'Contract / التعاقد', width: 220 },
    { label: 'مسئول التعاقد', width: 140 },
    { label: 'Discharge Date / تاريخ الخروج', width: 100 },
  ];

  const processedData = (dischargedPatients || []).filter((p) => {
    const roomStr = p.room || p.lastRoom || '';
    if (isDialysisRoom(roomStr)) return false;
    const nameVal = String(p.name || '').trim();
    if (dialysisCases && dialysisCases.some((dp) => 
      isNameMatch(dp.name, nameVal) ||
      (dp.mrn && p.mrn && dp.mrn === p.mrn) ||
      (/^\d+$/.test(dp.name) && dp.name === p.mrn)
    )) return false;
    return true;
  });

  const totalTableHeight = tableHeaderHeight + Math.max(processedData.length, 1) * rowHeight + 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#DDEBF7"/>
  `;

  let colX = 0;
  cols.forEach((col) => {
    tableSvgContent += `
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#DDEBF7" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="10" font-weight="bold" fill="#000000" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  processedData.forEach((p) => {
    const contractorVal = p.contractor || '';
    const cleanedContractor = cleanContractorForDisplay(contractorVal);
    const patientName = String(p.name || '').trim();
    const directMrn = String(p.mrn || p.id || '').trim();

    let resolvedMrn = directMrn;
    if (!resolvedMrn || resolvedMrn === '—' || resolvedMrn === '-') {
      if (mrnLookupInput?.resolve) {
        resolvedMrn = mrnLookupInput.resolve(patientName, directMrn);
      } else if (mrnLookupInput instanceof Map) {
        resolvedMrn = mrnLookupInput.get(patientName.toLowerCase()) || '—';
      } else if (mrnLookupInput?.nameToMrn) {
        resolvedMrn = mrnLookupInput.nameToMrn.get(patientName.toLowerCase()) || '—';
      } else {
        resolvedMrn = '—';
      }
    }

    const rowValues = [
      String(serial++),
      p.room || p.lastRoom || '',
      resolvedMrn || '—',
      patientName,
      p.physician || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(p.dischargeDate || p.date),
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 1 && idx <= 6;
      const cellId = `cp_exit_${serial}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('خروج', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: processedData.length };
}

/**
 * 5. General Debts Sheet (Cash Debts)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 */
export async function generateDebtsJpeg(debts: any[], dateLabel: string): Promise<{ buffer: Buffer; count: number }> {
  const width = 1380;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 38;

  const cols = [
    { label: '# / م', width: 50 },
    { label: 'تاريخ الدخول / Admission Date', width: 120 },
    { label: 'الغرفة / Room', width: 90 },
    { label: 'كود المريض / MRN', width: 100 },
    { label: 'اسم المريض / Patient Name', width: 230 },
    { label: 'الطبيب المعالج / Physician', width: 190 },
    { label: 'الجهة والتعاقد / Contractor', width: 170 },
    { label: 'مسئول التعاقد', width: 120 },
    { label: 'إجمالي الحساب / Total Bill (Z)', width: 110 },
    { label: 'المبلغ المتبقي / Remaining Amount', width: 110 },
    { label: 'نسبة المتبقي / Remaining Pct (%)', width: 90 },
  ];

  const totalTableHeight = tableHeaderHeight + Math.max((debts || []).length, 1) * rowHeight + 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#37474F"/>
  `;

  let colX = 0;
  cols.forEach((col) => {
    tableSvgContent += `
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#37474F" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  (debts || []).forEach((p) => {
    const contractorVal = p.contractor || p.colM || '';
    const cleanedContractor = cleanContractorForDisplay(contractorVal);
    const rowValues = [
      String(serial++),
      formatDateForSheet(p.date || p.admissionDate || ''),
      p.room || '',
      p.mrn || p.id || '',
      p.name || '',
      p.physician || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      String(p.totalBill || p.total || '0'),
      String(p.remainingAmount || p.amount || '0'),
      p.remainingPct ? `${p.remainingPct}%` : '0%',
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 2 && idx <= 6;
      const cellId = `cp_debt_${serial}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('مديونيات المرضى (نقدي) / Cash Debts', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: (debts || []).length };
}

/**
 * 6. Patient Transfers Sheet
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 */
export async function generateTransfersJpeg(
  transfers: any[],
  dateLabel: string,
  mrnLookupInput?: MrnResolver | Map<string, string> | any
): Promise<{ buffer: Buffer; count: number }> {
  const width = 1240;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 60 },
    { label: 'MRN / الملف', width: 110 },
    { label: 'Patient / اسم المريض', width: 270 },
    { label: 'From / من غرفة', width: 120 },
    { label: 'To / إلى غرفة', width: 120 },
    { label: 'Physician / الطبيب', width: 230 },
    { label: 'مسئول التعاقد', width: 140 },
    { label: 'Date / التاريخ', width: 150 },
  ];

  const totalTableHeight = tableHeaderHeight + Math.max((transfers || []).length, 1) * rowHeight + 30;

  let tableSvgContent = `
    <rect width="${width}" height="${totalTableHeight}" fill="#FFFFFF"/>
    <rect y="0" width="${width}" height="${tableHeaderHeight}" fill="#DDEBF7"/>
  `;

  let colX = 0;
  cols.forEach((col) => {
    tableSvgContent += `
      <rect x="${colX}" y="0" width="${col.width}" height="${tableHeaderHeight}" fill="#DDEBF7" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${colX + col.width / 2}" y="${tableHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="10" font-weight="bold" fill="#000000" text-anchor="middle">${escapeXml(col.label)}</text>
    `;
    colX += col.width;
  });

  let currentY = tableHeaderHeight;
  let serial = 1;

  (transfers || []).forEach((t) => {
    const contractorVal = t.contractor || '';
    const patientName = String(t.name || t.patientName || '').trim();

    // Sanitize candidate MRN: Never use transfer UUID / internal ID as MRN
    let directMrn = '';
    const cand = String(t.mrn || t.patientId || t.barcode || '').trim();
    if (cand && !cand.startsWith('transfer-') && !cand.toLowerCase().includes('transfer') && !cand.includes('-') && cand !== '—' && cand !== '-') {
      directMrn = cand;
    }

    let resolvedMrn = directMrn;
    if (!resolvedMrn || resolvedMrn === '—' || resolvedMrn === '-') {
      if (mrnLookupInput?.resolve) {
        resolvedMrn = mrnLookupInput.resolve(patientName, directMrn);
      } else if (mrnLookupInput instanceof Map) {
        resolvedMrn = mrnLookupInput.get(patientName.toLowerCase()) || '—';
      } else if (mrnLookupInput?.nameToMrn) {
        resolvedMrn = mrnLookupInput.nameToMrn.get(patientName.toLowerCase()) || '—';
      } else {
        resolvedMrn = '—';
      }
    }
    if (resolvedMrn.startsWith('transfer-') || resolvedMrn.toLowerCase().includes('transfer')) {
      resolvedMrn = '—';
    }

    const rowValues = [
      String(serial++),
      resolvedMrn || '—',
      patientName,
      t.initialRoom || t.fromRoom || '',
      t.currentRoom || t.toRoom || '',
      t.physician || '',
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(t.lastTransferDate || t.date || (t.history && t.history.length > 0 ? t.history[t.history.length - 1].date : '')),
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 1 && idx <= 5;
      const cellId = `cp_trans_${serial}_${idx}`;
      const maxChars = Math.max(Math.floor(colDef.width / 6.8), 5);
      const displayVal = truncateText(val, maxChars);

      tableSvgContent += `
        <clipPath id="${cellId}"><rect x="${cellX + 2}" y="${currentY}" width="${colDef.width - 4}" height="${rowHeight}"/></clipPath>
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text clip-path="url(#${cellId})" x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(displayVal)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('التحويلات', width, headerHeight);
  const buffer = await assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
  return { buffer, count: (transfers || []).length };
}
