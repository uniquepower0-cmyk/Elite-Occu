import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { getResponsibleOfficer, formatDateForSheet, cleanContractorForDisplay } from '../contractorOfficers.js';

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
 * Creates the exact signature Mohanad Excel header banner:
 * Custom background image with transparent glass text box overlay.
 */
async function createExcelHeaderBuffer(title: string, width: number, height = 180): Promise<Buffer> {
  const safeTitle = escapeXml(title);
  const boxWidth = Math.min(480, width - 80);
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
 * Helper to composite the header image buffer above the SVG table into a single JPEG
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
 * 1. Occupancy Sheet (Colored Structured Grid) - 100% Consistent with ExcelJS addGridOccupancySheet
 */
export async function generateOccupancyJpeg(rawHospitalData: any[][], dateLabel: string, isVipFn?: (name: string) => boolean): Promise<Buffer> {
  const width = 1260;
  const headerHeight = 180;
  const rowHeight = 32;
  const tableHeaderHeight = 36;
  const deptHeaderHeight = 34;

  const cols = [
    { label: '# / الرقم', width: 70, align: 'center' },
    { label: 'Room / الغرفة', width: 110, align: 'center' },
    { label: 'Patient / اسم المريض', width: 270, align: 'center' },
    { label: 'Physician / الطبيب المعالج', width: 230, align: 'center' },
    { label: 'Contract / التعاقد', width: 210, align: 'center' },
    { label: 'مسئول التعاقد', width: 140, align: 'center' },
    { label: 'Booking Date / تاريخ الحجز', width: 130, align: 'center' },
    { label: 'VIP STATUS', width: 100, align: 'center' },
  ];

  // Process rows exactly matching addGridOccupancySheet
  let processedData = (rawHospitalData || []).slice(3)
    .map((row) => ({
      room: String(row[0] || '').trim(),
      name: String(row[1] || '').trim(),
      physician: String(row[2] || '').trim(),
      contractor: String(row[3] || '').trim(),
      date: String(row[4] || '').trim(),
    }))
    .filter((p) => {
      if (!p.room || !p.name) return false;
      const rLower = p.room.toLowerCase();
      const nLower = p.name.toLowerCase();
      if (rLower === 'bed' || rLower === 'room' || rLower === 'الغرفة' || nLower === 'patient' || nLower === 'المريض') return false;
      if (/\b(or|or-1|or-2|or-3|or-4|or-5|or-6|or-7|or-8|or-9|or-10|or-11|or-12|or-13|or-14|or-15)\b/i.test(p.room)) return false;
      return true;
    });

  // Sort by room exactly matching addGridOccupancySheet
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

  // Group items
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
  totalTableHeight += 40; // bottom margin

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

    // Patients Rows
    group.items.forEach((p) => {
      const formattedDate = formatDateForSheet(p.date);
      const responsibleOfficer = getResponsibleOfficer(p.contractor);
      const cleanedContractor = cleanContractorForDisplay(p.contractor);
      const isVip = isVipFn ? isVipFn(p.name) : false;

      const rowValues = [
        String(serial++),
        p.room,
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

        tableSvgContent += `
          <rect x="${cellX}" y="${currentY}" width="${colDef.width}" height="${rowHeight}" fill="${rColors.row}" stroke="#D2D7D9" stroke-width="0.8"/>
          <text x="${cellX + colDef.width / 2}" y="${currentY + rowHeight / 2 + 4}" font-family="'Calibri', 'Cairo', Arial, sans-serif" font-size="11" font-weight="${isBold || isVipCell ? 'bold' : 'normal'}" fill="${textColor}" text-anchor="middle">${escapeXml(val)}</text>
        `;
        cellX += colDef.width;
      });

      currentY += rowHeight;
    });
  });

  const tableSvg = `
    <svg width="${width}" height="${totalTableHeight}" xmlns="http://www.w3.org/2000/svg">
      ${tableSvgContent}
    </svg>
  `;

  const headerBuf = await createExcelHeaderBuffer('الإشغال', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 2. Admissions Sheet (Formatted Entry) - 100% Consistent with addRefinedEntrySheet
 */
export async function generateEntriesJpeg(entryPatients: any[], dateLabel: string): Promise<Buffer> {
  const width = 1240;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 70 },
    { label: 'Room / الغرفة', width: 120 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'Physician / الطبيب المعالج', width: 250 },
    { label: 'Contract / التعاقد', width: 220 },
    { label: 'مسئول التعاقد', width: 150 },
    { label: 'Booking Date / تاريخ الحجز', width: 150 },
  ];

  const processedData = (entryPatients || []).filter((p) => {
    const roomStr = p.room || p.colB || '';
    if (/\b(or|or-1|or-2|or-3|or-4|or-5|or-6|or-7|or-8|or-9|or-10|or-11|or-12|or-13|or-14|or-15)\b/i.test(roomStr)) return false;
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
    const rowValues = [
      String(serial++),
      p.room || p.colB || '',
      p.name || p.colD || '',
      p.physician || p.colW || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(p.date || p.colA),
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
  const headerBuf = await createExcelHeaderBuffer('دخول', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 3. Dialysis Sheet (Formatted Dialysis) - 100% Consistent with addRefinedDialysisSheet
 */
export async function generateDialysisJpeg(dialysisPatients: any[], dateLabel: string): Promise<Buffer> {
  const width = 1240;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 70 },
    { label: 'Room / الغرفة', width: 140 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'Physician / الطبيب المعالج', width: 250 },
    { label: 'Contract / التعاقد', width: 220 },
    { label: 'مسئول التعاقد', width: 140 },
    { label: 'Admission Date / تاريخ الدخول', width: 140 },
  ];

  const totalTableHeight = tableHeaderHeight + Math.max((dialysisPatients || []).length, 1) * rowHeight + 30;

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

  (dialysisPatients || []).forEach((p) => {
    const contractorVal = p.contractor || '';
    const cleanedContractor = cleanContractorForDisplay(contractorVal);
    const rowValues = [
      String(serial++),
      p.room || '',
      p.name || '',
      p.physician || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
      formatDateForSheet(p.date),
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
  const headerBuf = await createExcelHeaderBuffer('غسيل كلوى', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 4. Discharges Sheet (Formatted Exit) - 100% Consistent with addRefinedExitSheet
 */
export async function generateExitJpeg(dischargedPatients: any[], dateLabel: string): Promise<Buffer> {
  const width = 1240;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 70 },
    { label: 'Room / الغرفة', width: 140 },
    { label: 'Patient / اسم المريض', width: 320 },
    { label: 'Physician / الطبيب المعالج', width: 280 },
    { label: 'Contract / التعاقد', width: 250 },
    { label: 'مسئول التعاقد', width: 180 },
  ];

  const totalTableHeight = tableHeaderHeight + Math.max((dischargedPatients || []).length, 1) * rowHeight + 30;

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

  (dischargedPatients || []).forEach((p) => {
    const contractorVal = p.contractor || '';
    const cleanedContractor = cleanContractorForDisplay(contractorVal);
    const rowValues = [
      String(serial++),
      p.room || p.lastRoom || '',
      p.name || '',
      p.physician || '',
      cleanedContractor,
      getResponsibleOfficer(contractorVal),
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
  const headerBuf = await createExcelHeaderBuffer('خروج', width, headerHeight);
  return assembleSheetImage(headerBuf, tableSvg, width, headerHeight, totalTableHeight);
}

/**
 * 5. General Debts Sheet (Cash Debts) - 100% Consistent with addRefinedDebtsSheet
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
 * 6. Patient Transfers Sheet - 100% Consistent with addRefinedTransfersSheet
 */
export async function generateTransfersJpeg(transfers: any[], dateLabel: string): Promise<Buffer> {
  const width = 1140;
  const headerHeight = 180;
  const rowHeight = 30;
  const tableHeaderHeight = 36;

  const cols = [
    { label: '# / الرقم', width: 70 },
    { label: 'Patient / اسم المريض', width: 280 },
    { label: 'MRN / الملف', width: 120 },
    { label: 'From / من غرفة', width: 130 },
    { label: 'To / إلى غرفة', width: 130 },
    { label: 'Physician / الطبيب', width: 250 },
    { label: 'Date / التاريخ', width: 160 },
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
    const rowValues = [
      String(serial++),
      t.name || t.patientName || '',
      t.mrn || '',
      t.initialRoom || t.fromRoom || '',
      t.currentRoom || t.toRoom || '',
      t.physician || '',
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
