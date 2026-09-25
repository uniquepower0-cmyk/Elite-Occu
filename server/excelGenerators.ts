import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  cleanRoomStr,
  normalizeRoom,
  isOperatingRoom,
  isDialysisRoom,
  isOrXRoom,
  cleanAdmissionDateStr,
  getAccommodationCategory,
  isNameMatch,
  isWholeNameMatch,
  isPrivateCreditCase
} from './nameUtils';
import { KEYWORDS_TO_EXCLUDE, GLOBAL_EXCLUSIONS } from './occupancyLogic';
import {
  findOccupancyPatient,
  findAdmittedRoomForInPatient,
  classifyInOutFallback,
  getEnrichedOrListForStats,
  getOverListPatients,
  getAvailableVacantRooms
} from './orLogic';

export const LOGO_PATH = path.join(process.cwd(), 'elite_logo.png');
export const FALLBACK_LOGO_PATH = path.join(process.cwd(), 'elite_logo.png');

export function getCustomHeaderBgInfo() {
  const rootPng = path.join(process.cwd(), 'header_bg.png');
  const rootJpg = path.join(process.cwd(), 'header_bg.jpg');
  const rootJpeg = path.join(process.cwd(), 'header_bg.jpeg');
  
  if (fs.existsSync(rootPng)) return { path: rootPng, ext: 'png' as const };
  if (fs.existsSync(rootJpg)) return { path: rootJpg, ext: 'jpeg' as const };
  if (fs.existsSync(rootJpeg)) return { path: rootJpeg, ext: 'jpeg' as const };
  
  return null;
}

export function addLogosToSheet(workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet, numCols: number = 6) {
  const finalLogoPath = fs.existsSync(LOGO_PATH) ? LOGO_PATH : (fs.existsSync(FALLBACK_LOGO_PATH) ? FALLBACK_LOGO_PATH : null);
  
  if (finalLogoPath) {
    try {
      const logoId = workbook.addImage({
        filename: finalLogoPath,
        extension: 'png',
      });

      // Right logo
      worksheet.addImage(logoId, {
        tl: { col: 0.1, row: 0.2 } as any,
        ext: { width: 100, height: 100 },
        editAs: 'oneCell'
      });

      // Left logo
      const leftColIndex = numCols - 1;
      worksheet.addImage(logoId, {
        tl: { col: leftColIndex + 0.82, row: 0.2 } as any,
        ext: { width: 100, height: 100 },
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error('Error adding logo to sheet:', err);
    }
  }
}

const headerBufferCache = new Map<string, Buffer>();

export function clearHeaderBufferCache() {
  headerBufferCache.clear();
}

export async function applyRefinedHeader(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, title: string, numCols: number = 6) {
  const safeTitle = escapeXml(title);
  const customBg = getCustomHeaderBgInfo();
  const bgKey = customBg?.path || 'fallback';
  const cacheKey = `${safeTitle}__${bgKey}`;

  let bgBuffer = headerBufferCache.get(cacheKey) || null;
  
  if (!bgBuffer) {
    if (customBg && fs.existsSync(customBg.path) && fs.statSync(customBg.path).size > 0) {
      try {
        const svgText = `
          <svg width="1200" height="180" viewBox="0 0 1200 180">
            <rect x="420" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.12" />
            <text x="600" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="bold" fill="#000000" text-anchor="middle">${safeTitle}</text>
          </svg>
        `;
        bgBuffer = await sharp(customBg.path)
          .resize(1200, 180, { fit: 'fill' })
          .composite([{
            input: Buffer.from(svgText),
            top: 0,
            left: 0
          }])
          .png()
          .toBuffer();
      } catch (sharpErr) {
        console.error('Error compositing textbox on custom background:', sharpErr);
      }
    }

    if (!bgBuffer) {
      try {
        const svgText = `
          <svg width="1200" height="180" viewBox="0 0 1200 180">
            <rect width="1200" height="180" fill="#EBF3F5" />
            <rect x="420" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.18" />
            <text x="600" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="bold" fill="#000000" text-anchor="middle">${safeTitle}</text>
          </svg>
        `;
        bgBuffer = await sharp(Buffer.from(svgText))
          .png()
          .toBuffer();
      } catch (sharpFallbackErr) {
        console.error('Error generating fallback header:', sharpFallbackErr);
      }
    }

    if (bgBuffer) {
      headerBufferCache.set(cacheKey, bgBuffer);
    }
  }

  if (bgBuffer) {
    try {
      const bgId = workbook.addImage({
        buffer: bgBuffer,
        extension: 'png',
      });
      sheet.addImage(bgId, {
        tl: { col: 0, row: 0 } as any,
        br: { col: numCols, row: 1 } as any,
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error(`Error adding header background image to sheet "${title}":`, err);
    }
  }
}

export function escapeXml(unsafe: string): string {
  return (unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export function generatePieChartSvg(
  title: string,
  data: { label: string; value: number; color: string }[],
  width: number = 600,
  height: number = 400
): string {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" rx="12" stroke="#E2E8F0" stroke-width="1.5"/>
      <text x="${width/2}" y="${height/2}" font-family="'Segoe UI', Arial" font-size="16" fill="#64748B" text-anchor="middle">No data available</text>
    </svg>`;
  }

  const cx = 220;
  const cy = height / 2 + 15;
  const radius = 130;
  let startAngle = 0;

  let slicesSvg = "";
  data.forEach(item => {
    if (item.value === 0) return;
    const sliceAngle = (item.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;

    const x1 = cx + radius * Math.sin(startAngle);
    const y1 = cy - radius * Math.cos(startAngle);
    const x2 = cx + radius * Math.sin(endAngle);
    const y2 = cy - radius * Math.cos(endAngle);

    const largeArcFlag = sliceAngle > Math.PI ? 1 : 0;
    const pathData = (item.value === total)
      ? `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

    slicesSvg += `<path d="${pathData}" fill="${item.color}" stroke="#FFFFFF" stroke-width="2"/>`;
    startAngle = endAngle;
  });

  let legendSvg = "";
  let legendY = 80;
  data.forEach(item => {
    const pct = ((item.value / total) * 100).toFixed(1);
    legendSvg += `
      <rect x="420" y="${legendY}" width="16" height="16" rx="4" fill="${item.color}"/>
      <text x="445" y="${legendY + 13}" font-family="'Segoe UI', Arial" font-size="13" font-weight="600" fill="#1E293B">${escapeXml(item.label)}</text>
      <text x="560" y="${legendY + 13}" font-family="'Segoe UI', Arial" font-size="13" fill="#64748B" text-anchor="end">${item.value} (${pct}%)</text>
    `;
    legendY += 28;
  });

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" rx="12" stroke="#E2E8F0" stroke-width="1.5"/>
      <text x="${width/2}" y="36" font-family="'Segoe UI', Arial" font-size="18" font-weight="bold" fill="#0F172A" text-anchor="middle">${escapeXml(title)}</text>
      ${slicesSvg}
      ${legendSvg}
    </svg>
  `;
}

export function generateStackedBarChartSvg(
  title: string,
  categories: { label: string; values: { name: string; value: number; color: string }[] }[],
  width: number = 700,
  height: number = 400
): string {
  const chartLeft = 140;
  const chartRight = width - 40;
  const chartWidth = chartRight - chartLeft;
  const chartTop = 60;
  const chartBottom = height - 60;
  const chartHeight = chartBottom - chartTop;

  let maxTotal = 1;
  categories.forEach(cat => {
    const sum = cat.values.reduce((s, v) => s + v.value, 0);
    if (sum > maxTotal) maxTotal = sum;
  });
  maxTotal = Math.ceil(maxTotal * 1.15) || 10;

  const barHeight = Math.min(32, Math.max(16, (chartHeight / categories.length) * 0.55));
  const rowHeight = chartHeight / categories.length;

  let barsSvg = "";
  categories.forEach((cat, idx) => {
    const y = chartTop + idx * rowHeight + (rowHeight - barHeight) / 2;
    let currentX = chartLeft;

    let catBars = "";
    cat.values.forEach(v => {
      if (v.value <= 0) return;
      const w = (v.value / maxTotal) * chartWidth;
      catBars += `<rect x="${currentX}" y="${y}" width="${w}" height="${barHeight}" fill="${v.color}" rx="2"/>`;
      if (w > 20) {
        catBars += `<text x="${currentX + w/2}" y="${y + barHeight/2 + 4}" font-family="'Segoe UI', Arial" font-size="11" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${v.value}</text>`;
      }
      currentX += w;
    });

    barsSvg += `
      <text x="${chartLeft - 10}" y="${y + barHeight/2 + 4}" font-family="'Segoe UI', Arial" font-size="12" font-weight="600" fill="#334155" text-anchor="end">${escapeXml(cat.label)}</text>
      ${catBars}
    `;
  });

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#FFFFFF" rx="12" stroke="#E2E8F0" stroke-width="1.5"/>
      <text x="${width/2}" y="34" font-family="'Segoe UI', Arial" font-size="18" font-weight="bold" fill="#0F172A" text-anchor="middle">${escapeXml(title)}</text>
      <line x1="${chartLeft}" y1="${chartTop}" x2="${chartLeft}" y2="${chartBottom}" stroke="#CBD5E1" stroke-width="1.5"/>
      <line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}" stroke="#CBD5E1" stroke-width="1.5"/>
      ${barsSvg}
    </svg>
  `;
}

export function addOccupancySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Formatted Occupancy', {
    views: [{ rightToLeft: false }] 
  });

  let processedData = data.slice(3)
    .map(row => ({
      room: String(row[0] || "").trim(),
      name: String(row[1] || "").trim(),
      physician: String(row[2] || "").trim(),
      contractor: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
    }))
    .filter(p => {
      if (!p.room || !p.name) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
    });

  processedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'الاشغال';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2F1' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 6.0);

  const headerLabels = ['#', 'تاريخ الحجز / Admission Date', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } }; 
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  sheet.autoFilter = 'A2:F2';

  const separatorColor = 'FFFCE4D6'; 
  let currentGroup: string | null = null;
  let serial = 1;

  processedData.forEach((p) => {
    const roomStr = p.room.toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let group = "OTHER"; 
    if (roomStr.includes("PICU")) group = "PICU";
    else if (roomStr.includes("NICU")) group = "NICU";
    else if (roomStr.includes("CCU")) group = "CCU";
    else if (roomStr.includes("SICU")) group = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) group = "VIP";
    else if (roomStr.includes("ICU")) group = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) group = "1st Floor (101-108)";
    else if (roomNum >= 301 && roomNum <= 319) group = "301-319";
    else if (roomNum >= 320 && roomNum <= 329) group = "320-329";
    else if (roomNum >= 401 && roomNum <= 422) group = "4th Floor (401-422)";
    else if (!isNaN(roomNum) && roomNum > 0) group = "FLOOR_" + Math.floor(roomNum / 100); 

    if (currentGroup !== null && group !== currentGroup) {
      const sepRow = sheet.addRow(['', '', '', '', '', '']);
      sepRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: separatorColor } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
        };
      });
    }

    const rowValues = [serial++, p.date, p.room, p.name, p.physician, p.contractor];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
      if (colNumber === 1 || colNumber === 3) cell.font = { bold: true };
    });
    currentGroup = group;
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 30;
  sheet.getColumn(6).width = 20;
}

export async function addRefinedEntrySheet(workbook: ExcelJS.Workbook, entryPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Entry', {
    views: [{ rightToLeft: false }] 
  });

  const processedData = entryPatients.filter(p => {
    const roomStr = p.room || p.colB || "";
    if (isOperatingRoom(roomStr)) return false;
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'دخول', 6);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Booking Date / تاريخ الحجز'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  processedData.forEach((p) => {
    const rowValues = [
      serial++,
      p.room || p.colB || '',
      p.name || p.colD || '',
      p.physician || p.colW || '',
      p.contractor || p.colM || '',
      p.date || p.colA || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 15;
  sheet.getColumn(3).width = 30;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 22;
}

export async function addRefinedExitSheet(workbook: ExcelJS.Workbook, dischargedPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Exit', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:E1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'خروج', 5);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  (dischargedPatients || []).forEach((p) => {
    const rowValues = [
      serial++,
      p.room || p.lastRoom || '',
      p.name || '',
      p.physician || '',
      p.contractor || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 15;
  sheet.getColumn(3).width = 32;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
}

export async function addRefinedDialysisSheet(workbook: ExcelJS.Workbook, dialysisPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Dialysis', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'غسيل كلوى', 6);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Admission Date / تاريخ الدخول'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  (dialysisPatients || []).forEach((p) => {
    const rowValues = [
      serial++,
      p.room || '',
      p.name || '',
      p.physician || '',
      p.contractor || '',
      p.date || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 30;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 22;
}

export async function addRefinedDebtsSheet(workbook: ExcelJS.Workbook, debts: any[]) {
  const sheet = workbook.addWorksheet('Formatted Debts', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'مديونيات كاش', 7);

  const headerLabels = ['# / الرقم', 'Admission Date / تاريخ الدخول', 'Room / الغرفة', 'Patient / اسم المريض', 'Payment / نوع الدفع', 'Debts / المديونية', 'Remaining / المتبقي'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  (debts || []).forEach((p) => {
    const rowValues = [
      serial++,
      p.colA || '',
      p.room || '',
      p.colD || '',
      p.colF || p.colM || '',
      p.colZ || '',
      p.colAB || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 18;
  sheet.getColumn(7).width = 18;
}

export async function addRefinedInsuredDebtsSheet(workbook: ExcelJS.Workbook, debts: any[]) {
  const sheet = workbook.addWorksheet('Formatted Insured Debts', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'مديونيات شركات', 7);

  const headerLabels = ['# / الرقم', 'Admission Date / تاريخ الدخول', 'Room / الغرفة', 'Patient / اسم المريض', 'Company / الشركة', 'Debts / المديونية', 'Remaining / المتبقي'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  (debts || []).forEach((p) => {
    const rowValues = [
      serial++,
      p.colA || '',
      p.room || '',
      p.colD || '',
      p.colM || p.colF || '',
      p.colZ || '',
      p.colAB || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 28;
  sheet.getColumn(6).width = 18;
  sheet.getColumn(7).width = 18;
}

export async function addRefinedTransfersSheet(workbook: ExcelJS.Workbook, transfers: any[]) {
  const sheet = workbook.addWorksheet('Formatted Transfers', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'التحويلات', 7);

  const headerLabels = ['# / الرقم', 'Patient / اسم المريض', 'MRN / الملف', 'From / من غرفة', 'To / إلى غرفة', 'Physician / الطبيب', 'Date / التاريخ'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  (transfers || []).forEach((t) => {
    const rowValues = [
      serial++,
      t.name || '',
      t.mrn || '',
      t.initialRoom || t.fromRoom || '',
      t.currentRoom || t.toRoom || '',
      t.physician || '',
      t.lastTransferDate || t.date || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 30;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 16;
  sheet.getColumn(5).width = 16;
  sheet.getColumn(6).width = 25;
  sheet.getColumn(7).width = 22;
}

export async function addRefinedORListSheet(workbook: ExcelJS.Workbook, data: any[], occRows: any[][] = []) {
  const sheet = workbook.addWorksheet('OR List Refined', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:L1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'قائمة العمليات الجراحية', 12);

  const headerLabels = [
    '#', 'Admitted Room / غرفة التنويم', 'OR Room / غرفة العمليات', 'Patient / اسم المريض', 'MRN / الملف',
    'Surgeon / الجراح', 'Operation / العملية', 'Contract / التعاقد', 'Payment / طريقة الدفع', 'Status / الحالة', 'Start / البدء', 'End / الانتهاء'
  ];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  (data || []).forEach(p => {
    const admittedRoom = findAdmittedRoomForInPatient(p.patientName, occRows, p.mrn, p.surgeonName);
    const rowValues = [
      serial++,
      admittedRoom !== "Not Found in Occupancy Sheet / غير موجود بشيت الإشغال" ? admittedRoom : (p.realStatus === 'IN' ? 'منوم' : 'خارجي'),
      p.orRoom || p.room || 'OR',
      p.patientName,
      p.mrn || '',
      p.surgeonName || '',
      p.arabicOperation || p.engOperation || '',
      p.contractorName || p.contractor || '',
      p.paidBy || '',
      p.realStatus === 'IN' ? 'منوم (IN)' : 'خارجي (OUT)',
      p.startTime || '',
      p.endTime || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 10 };
      if (colNumber === 10) {
        if (p.realStatus === 'IN') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
          cell.font = { color: { argb: 'FF2E7D32' }, bold: true };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBE9E7' } };
          cell.font = { color: { argb: 'FFD84315' }, bold: true };
        }
      }
    });
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 16;
  sheet.getColumn(4).width = 28;
  sheet.getColumn(5).width = 12;
  sheet.getColumn(6).width = 22;
  sheet.getColumn(7).width = 28;
  sheet.getColumn(8).width = 20;
  sheet.getColumn(9).width = 15;
  sheet.getColumn(10).width = 16;
  sheet.getColumn(11).width = 12;
  sheet.getColumn(12).width = 12;
}

export async function addRefinedORReconciliationSheet(
  workbook: ExcelJS.Workbook,
  orList: any[],
  occRows: any[][],
  cumulativeDischarged: any[] = []
) {
  const sheet = workbook.addWorksheet('OR Reconciliation', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:J1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'مطابقة لستة العمليات مع شيت الإشغال', 10);

  const headerLabels = [
    '#', 'Admitted Room / غرفة التنويم', 'OR Room / غرفة العمليات', 'Patient / اسم المريض', 'MRN / الملف',
    'Surgeon / الجراح', 'Contract / التعاقد', 'Admission Date / تاريخ الدخول', 'Reconciled Status / حالة المطابقة', 'Notes / ملاحظات'
  ];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;
  const enriched = getEnrichedOrListForStats(orList, occRows, cumulativeDischarged);
  enriched.forEach(p => {
    const occPatient = findOccupancyPatient(p.patientName, occRows, false, p.mrn, p.surgeonName);
    const roomVal = occPatient ? occPatient.room : (p.isDischarged ? p.dischargedFromRoom : 'N/A');
    const statusText = p.isDischarged
      ? 'تم الخروج (Discharged)'
      : (occPatient ? 'منوم حالياً (Admitted)' : 'غير منوم / خارجي (Outpatient)');

    const rowValues = [
      serial++,
      roomVal || 'N/A',
      p.orRoom || p.room || 'OR',
      p.patientName,
      p.mrn || (occPatient ? occPatient.mrn : ''),
      p.surgeonName || (occPatient ? occPatient.physician : ''),
      p.contractorName || p.contractor || (occPatient ? occPatient.contractor : ''),
      p.admissionDate || '',
      statusText,
      p.dischargeStatus || ''
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 10 };
      if (colNumber === 9) {
        if (p.isDischarged) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
          cell.font = { color: { argb: 'FFE65100' }, bold: true };
        } else if (occPatient) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
          cell.font = { color: { argb: 'FF2E7D32' }, bold: true };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
          cell.font = { color: { argb: 'FF616161' }, bold: true };
        }
      }
    });
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 16;
  sheet.getColumn(4).width = 28;
  sheet.getColumn(5).width = 14;
  sheet.getColumn(6).width = 22;
  sheet.getColumn(7).width = 20;
  sheet.getColumn(8).width = 18;
  sheet.getColumn(9).width = 22;
  sheet.getColumn(10).width = 30;
}
