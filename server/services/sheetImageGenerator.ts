import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { getResponsibleOfficer, formatDateForSheet, cleanContractorForDisplay } from '../contractorOfficers.js';
import { isNameMatch } from '../nameUtils.js';

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
 * Builds an MRN lookup dictionary and reverse patient lookup from all known sources
 */
export function buildMrnLookup(
  rawRows: any[][] = [],
  otherLists: any[][] = []
): {
  nameToMrn: Map<string, string>;
  mrnToPatient: Map<string, { name: string; physician?: string; contractor?: string; room?: string }>;
} {
  const nameToMrn = new Map<string, string>();
  const mrnToPatient = new Map<string, { name: string; physician?: string; contractor?: string; room?: string }>();

  (rawRows || []).slice(3).forEach((r) => {
    const room = String(r[0] || '').trim();
    const name = String(r[1] || '').trim();
    const physician = String(r[2] || '').trim();
    const contractor = String(r[3] || '').trim();
    const mrn = String(r[5] || '').trim();

    if (name && mrn && !nameToMrn.has(name.toLowerCase())) {
      nameToMrn.set(name.toLowerCase(), mrn);
    }
    if (mrn && !mrnToPatient.has(mrn)) {
      mrnToPatient.set(mrn, { name, physician, contractor, room });
    }
  });

  otherLists.forEach((list) => {
    (list || []).forEach((item: any) => {
      const name = String(item.name || item.patient || '').trim();
      const mrn = String(item.mrn || item.id || '').trim();
      const physician = String(item.physician || item.doctor || '').trim();
      const contractor = String(item.contractor || item.payment || '').trim();
      const room = String(item.room || item.bed || '').trim();

      if (name && mrn && !nameToMrn.has(name.toLowerCase())) {
        nameToMrn.set(name.toLowerCase(), mrn);
      }
      if (mrn && !mrnToPatient.has(mrn)) {
        mrnToPatient.set(mrn, { name, physician, contractor, room });
      }
    });
  });

  return { nameToMrn, mrnToPatient };
}

/**
 * 1. Occupancy Sheet (Colored Structured Grid)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 * STRICTLY EXCLUDES: Dialysis cases (which appear only in Dialysis sheet).
 */
export async function generateOccupancyJpeg(
  rawHospitalData: any[][],
  dateLabel: string,
  isVipFn?: (name: string) => boolean,
  dialysisCases: any[] = []
): Promise<Buffer> {
  const width = 1320;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 36;
  const deptHeaderHeight = 34;

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

  // Process rows and STRICTLY FILTER OUT DIALYSIS CASES
  let processedData = (rawHospitalData || []).slice(3)
    .map((row) => ({
      room: String(row[0] || '').trim(),
      name: String(row[1] || '').trim(),
      physician: String(row[2] || '').trim(),
      contractor: String(row[3] || '').trim(),
      date: String(row[4] || '').trim(),
      mrn: String(row[5] || '').trim(),
    }))
    .filter((p) => {
      if (!p.room || !p.name) return false;
      const rLower = p.room.toLowerCase();
      const nLower = p.name.toLowerCase();
      if (rLower === 'bed' || rLower === 'room' || rLower === 'الغرفة' || nLower === 'patient' || nLower === 'المريض') return false;
      if (/\b(or|or-1|or-2|or-3|or-4|or-5|or-6|or-7|or-8|or-9|or-10|or-11|or-12|or-13|or-14|or-15)\b/i.test(p.room)) return false;

      // STRICT EXCLUSION: Dialysis cases must ONLY be in the Dialysis sheet
      if (isDialysisRoom(p.room)) return false;
      if (dialysisCases && dialysisCases.some((dp) => 
        isNameMatch(dp.name, p.name) ||
        (dp.mrn && p.mrn && dp.mrn === p.mrn) ||
        (/^\d+$/.test(dp.name) && dp.name === p.mrn)
      )) return false;

      return true;
    });

  // Sort by department/room rank
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

  // Group items by floor / clinical unit
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
    else if (roomNum >= 101 && roomNum <= 108) groupName = 'First Floor';
    else if (roomNum >= 301 && roomNum <= 319) groupName = 'Zone A (301-319)';
    else if (roomNum >= 320 && roomNum <= 329) groupName = 'Zone B (320-329)';
    else if (roomNum >= 330 && roomNum <= 332) groupName = 'Zone C (330-332)';
    else if (roomNum >= 401 && roomNum <= 422) groupName = '4th Floor';
    else if (!isNaN(roomNum) && roomNum > 0) groupName = 'Floor ' + Math.floor(roomNum / 100);

    let existing = groupedItems.find((g) => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  let totalTableHeight = tableHeaderHeight;
  groupedItems.forEach((g) => {
    totalTableHeight += deptHeaderHeight + g.items.length * rowHeight;
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

    // Department Separator Row
    tableSvgContent += `
      <rect y="${currentY}" width="${width}" height="${deptHeaderHeight}" fill="${rColors.badge}" stroke="#B2B2B2" stroke-width="0.8"/>
      <text x="${width / 2}" y="${currentY + deptHeaderHeight / 2 + 5}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#FFFFFF" text-anchor="middle">■  ${escapeXml(displayGroupName)}  ■</text>
    `;
    currentY += deptHeaderHeight;

    // Patient rows
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

        tableSvgContent += `
          <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
          <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold || isVipCell ? 'bold' : 'normal'}" fill="${textColor}" text-anchor="middle">${escapeXml(val)}</text>
        `;
        cellX += colDef.width;
      });

      currentY += rowHeight;
    });
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('الإشغال', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 2. Admissions Sheet (Formatted Entry)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 * STRICTLY EXCLUDES: Dialysis cases.
 */
export async function generateEntriesJpeg(
  entryPatients: any[],
  dateLabel: string,
  mrnLookupInput?: Map<string, string> | { nameToMrn: Map<string, string>; mrnToPatient: Map<string, any> },
  dialysisCases: any[] = []
): Promise<Buffer> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const nameToMrn = mrnLookupInput instanceof Map ? mrnLookupInput : (mrnLookupInput?.nameToMrn || new Map<string, string>());

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

  const processedData = (entryPatients || []).filter((p) => {
    const roomStr = p.room || p.colB || '';
    if (/\b(or|or-1|or-2|or-3|or-4|or-5|or-6|or-7|or-8|or-9|or-10|or-11|or-12|or-13|or-14|or-15)\b/i.test(roomStr)) return false;
    // Exclude dialysis cases from Admissions
    if (isDialysisRoom(roomStr)) return false;
    const nameVal = String(p.name || p.colD || '').trim();
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
    const resolvedMrn = p.mrn || p.colC || nameToMrn.get(String(p.name || '').trim().toLowerCase()) || '—';

    const rowValues = [
      String(serial++),
      p.room || p.colB || '',
      resolvedMrn,
      p.name || p.colD || '',
      p.physician || p.colW || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(p.date || p.colA),
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 1 && idx <= 6;
      tableSvgContent += `
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(val)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('دخول', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 3. Dialysis Sheet (Formatted Dialysis)
 * Includes: ALL Dialysis cases ONLY, with MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 */
export async function generateDialysisJpeg(
  dialysisPatients: any[],
  dateLabel: string,
  mrnLookupInput?: Map<string, string> | { nameToMrn: Map<string, string>; mrnToPatient: Map<string, any> }
): Promise<Buffer> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const nameToMrn = mrnLookupInput instanceof Map ? mrnLookupInput : (mrnLookupInput?.nameToMrn || new Map<string, string>());
  const mrnToPatient = !(mrnLookupInput instanceof Map) && mrnLookupInput?.mrnToPatient ? mrnLookupInput.mrnToPatient : new Map<string, any>();

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
    let resolvedMrn = String(p.mrn || p.id || '').trim();

    // If patientName is numeric, it is an MRN
    if (/^\d{4,}$/.test(patientName)) {
      resolvedMrn = patientName;
      const matched = mrnToPatient.get(resolvedMrn);
      if (matched) {
        patientName = matched.name || patientName;
        if (!physicianVal) physicianVal = matched.physician || '';
        if (!contractorVal) contractorVal = matched.contractor || '';
        if (roomVal === 'غسيل كلوي' && matched.room) roomVal = matched.room;
      }
    } else {
      if (!resolvedMrn) {
        resolvedMrn = nameToMrn.get(patientName.toLowerCase()) || '—';
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
      tableSvgContent += `
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(val)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('غسيل كلوى', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 4. Discharges Sheet (Formatted Exit)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 * STRICTLY EXCLUDES: Dialysis cases.
 */
export async function generateExitJpeg(
  dischargedPatients: any[],
  dateLabel: string,
  mrnLookupInput?: Map<string, string> | { nameToMrn: Map<string, string>; mrnToPatient: Map<string, any> },
  dialysisCases: any[] = []
): Promise<Buffer> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const nameToMrn = mrnLookupInput instanceof Map ? mrnLookupInput : (mrnLookupInput?.nameToMrn || new Map<string, string>());

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
    const resolvedMrn = p.mrn || p.id || nameToMrn.get(String(p.name || '').trim().toLowerCase()) || '—';

    const rowValues = [
      String(serial++),
      p.room || p.lastRoom || '',
      resolvedMrn,
      p.name || '',
      p.physician || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(p.dischargeDate || p.date),
    ];

    let cellX = 0;
    rowValues.forEach((val, idx) => {
      const colDef = cols[idx];
      const isBold = idx >= 1 && idx <= 6;
      tableSvgContent += `
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(val)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('خروج', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 5. General Debts Sheet (Cash Debts)
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 */
export async function generateDebtsJpeg(debts: any[], dateLabel: string): Promise<Buffer> {
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
      tableSvgContent += `
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(val)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('مديونيات المرضى (نقدي) / Cash Debts', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 6. Patient Transfers Sheet
 * Includes: MRN, Patient Name, Contractor Officer (مسئول التعاقد).
 */
export async function generateTransfersJpeg(transfers: any[], dateLabel: string): Promise<Buffer> {
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
    const rowValues = [
      String(serial++),
      t.mrn || '',
      t.name || t.patientName || '',
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
      tableSvgContent += `
        <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="#FFFFFF" stroke="#B2B2B2" stroke-width="0.8"/>
        <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold ? 'bold' : 'normal'}" fill="#000000" text-anchor="middle">${escapeXml(val)}</text>
      `;
      cellX += colDef.width;
    });
    currentY += rowHeight;
  });

  const tableSvg = `<svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">${tableSvgContent}</svg>`;
  const headerBuf = await createExcelHeaderBuffer('التحويلات', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}
