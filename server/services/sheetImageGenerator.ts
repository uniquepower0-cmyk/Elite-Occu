import sharp from 'sharp';

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

const WIDTH = 1200;

function renderSvgHeader(titleAr: string, titleEn: string, dateLabel: string, badgeText: string): string {
  return `
    <rect width="${WIDTH}" height="95" fill="#094037"/>
    <rect y="91" width="${WIDTH}" height="4" fill="#14b8a6"/>
    <text x="45" y="44" font-family="'Cairo', Arial, sans-serif" font-size="22" font-weight="bold" fill="#ffffff">${escapeXml(titleAr)} / ${escapeXml(titleEn)}</text>
    <text x="45" y="72" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#a7f3d0">Elite Hospital Occupancy Management System • Mohanad&apos;s Refined Series</text>
    <rect x="${WIDTH - 240}" y="24" width="195" height="48" rx="8" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>
    <text x="${WIDTH - 142}" y="44" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(badgeText)}</text>
    <text x="${WIDTH - 142}" y="62" font-family="'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#ccfbf1" text-anchor="middle">${escapeXml(dateLabel)}</text>
  `;
}

function renderSvgFooter(y: number, count: number, label: string): string {
  return `
    <rect y="${y}" width="${WIDTH}" height="45" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1"/>
    <text x="45" y="${y + 28}" font-family="'Cairo', Arial, sans-serif" font-size="13" font-weight="bold" fill="#094037">إجمالي الحالات: ${count} ${escapeXml(label)}</text>
    <text x="${WIDTH - 45}" y="${y + 28}" font-family="'Cairo', Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="end">Source: Elite Hospital Core Database • Official Census</text>
  `;
}

/**
 * 1. Occupancy Sheet JPEG
 */
export async function generateOccupancyJpeg(occupancyRows: any[][], dateLabel: string): Promise<Buffer> {
  const rowHeight = 34;
  const headerHeight = 110;
  const tableHeaderHeight = 38;
  const footerHeight = 45;

  let validRowsCount = 0;
  (occupancyRows || []).forEach(r => {
    if (r && r.length > 2) validRowsCount++;
  });

  const totalHeight = headerHeight + tableHeaderHeight + (Math.max(validRowsCount, 1) * rowHeight) + footerHeight + 40;

  let rowsSvg = '';
  let currentY = headerHeight + tableHeaderHeight;
  let serial = 1;

  (occupancyRows || []).forEach((row) => {
    const isSectionHeader = row.length > 0 && (String(row[0]).includes('الدور') || String(row[0]).includes('Floor') || String(row[0]).includes('قسم'));
    if (isSectionHeader) {
      rowsSvg += `
        <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="#0f766e"/>
        <text x="50" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="13" font-weight="bold" fill="#ffffff">${escapeXml(row[0])}</text>
      `;
      currentY += rowHeight;
      return;
    }

    if (row.length < 3) return;
    const room = row[1] || row[0] || '';
    const name = row[2] || row[1] || '';
    const mrn = row[3] || '';
    const doctor = row[4] || '';
    const payment = row[5] || '';
    const date = row[6] || '';

    const bg = serial % 2 === 0 ? '#f8fafc' : '#ffffff';

    rowsSvg += `
      <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="${bg}"/>
      <line x1="35" y1="${currentY + rowHeight}" x2="${WIDTH - 35}" y2="${currentY + rowHeight}" stroke="#f1f5f9" stroke-width="1"/>
      <text x="55" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${serial}</text>
      <text x="110" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#0f766e">${escapeXml(room)}</text>
      <text x="210" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(name)}</text>
      <text x="520" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(mrn)}</text>
      <text x="660" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#047857">${escapeXml(doctor ? `د. ${doctor}` : '—')}</text>
      <text x="910" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" fill="#0284c7">${escapeXml(payment || 'تعاقد')}</text>
      <text x="1080" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(date)}</text>
    `;

    currentY += rowHeight;
    serial++;
  });

  const svg = `
    <svg width="${WIDTH}" height="${currentY + footerHeight + 10}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${currentY + footerHeight + 10}" fill="#ffffff"/>
      ${renderSvgHeader('تقرير الإشغال العام', 'Hospital Occupancy Sheet', dateLabel, 'تقرير الإشغال الرسمي')}
      
      <!-- Table Header -->
      <rect x="35" y="${headerHeight}" width="${WIDTH - 70}" height="${tableHeaderHeight}" fill="#0f766e" rx="4"/>
      <text x="55" y="${headerHeight + 24}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">#</text>
      <text x="110" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الغرفة</text>
      <text x="210" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">اسم المريض</text>
      <text x="520" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الرقم الطبي</text>
      <text x="660" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الطبيب المعالج</text>
      <text x="910" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الجهة الضامنة</text>
      <text x="1080" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">تاريخ الدخول</text>

      ${rowsSvg}
      ${renderSvgFooter(currentY + 5, serial - 1, 'مريض بالقسم الداخلي')}
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * 2. Admissions / Entries Sheet JPEG
 */
export async function generateEntriesJpeg(entries: any[], dateLabel: string): Promise<Buffer> {
  const rowHeight = 34;
  const headerHeight = 110;
  const tableHeaderHeight = 38;
  const footerHeight = 45;
  const count = Math.max((entries || []).length, 1);
  const totalHeight = headerHeight + tableHeaderHeight + (count * rowHeight) + footerHeight + 40;

  let rowsSvg = '';
  let currentY = headerHeight + tableHeaderHeight;

  (entries || []).forEach((p, idx) => {
    const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    rowsSvg += `
      <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="${bg}"/>
      <line x1="35" y1="${currentY + rowHeight}" x2="${WIDTH - 35}" y2="${currentY + rowHeight}" stroke="#f1f5f9" stroke-width="1"/>
      <text x="55" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${idx + 1}</text>
      <text x="110" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#0284c7">${escapeXml(p.room || p.colB || '—')}</text>
      <text x="210" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(p.name || p.colD || '—')}</text>
      <text x="560" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#0f766e">${escapeXml(p.doctor ? `د. ${p.doctor}` : '—')}</text>
      <text x="820" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" fill="#475569">${escapeXml(p.contractor || p.colM || '—')}</text>
      <text x="1050" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(p.date || '—')}</text>
    `;
    currentY += rowHeight;
  });

  const svg = `
    <svg width="${WIDTH}" height="${currentY + footerHeight + 10}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${currentY + footerHeight + 10}" fill="#ffffff"/>
      ${renderSvgHeader('حالات الدخول اليومي', 'Daily Admissions Sheet', dateLabel, 'دخول جديد')}
      
      <rect x="35" y="${headerHeight}" width="${WIDTH - 70}" height="${tableHeaderHeight}" fill="#0284c7" rx="4"/>
      <text x="55" y="${headerHeight + 24}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">#</text>
      <text x="110" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الغرفة</text>
      <text x="210" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">اسم المريض</text>
      <text x="560" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الطبيب المعالج</text>
      <text x="820" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">التعاقد</text>
      <text x="1050" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">تاريخ الحجز</text>

      ${rowsSvg}
      ${renderSvgFooter(currentY + 5, entries.length, 'حالة دخول')}
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * 3. Dialysis Sheet JPEG
 */
export async function generateDialysisJpeg(dialysis: any[], dateLabel: string): Promise<Buffer> {
  const rowHeight = 34;
  const headerHeight = 110;
  const tableHeaderHeight = 38;
  const footerHeight = 45;
  const count = Math.max((dialysis || []).length, 1);

  let rowsSvg = '';
  let currentY = headerHeight + tableHeaderHeight;

  (dialysis || []).forEach((p, idx) => {
    const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    rowsSvg += `
      <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="${bg}"/>
      <line x1="35" y1="${currentY + rowHeight}" x2="${WIDTH - 35}" y2="${currentY + rowHeight}" stroke="#f1f5f9" stroke-width="1"/>
      <text x="55" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${idx + 1}</text>
      <text x="110" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#7c3aed">${escapeXml(p.room || 'غسيل')}</text>
      <text x="210" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(p.name || '—')}</text>
      <text x="560" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#0f766e">${escapeXml(p.doctor ? `د. ${p.doctor}` : '—')}</text>
      <text x="820" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" fill="#475569">${escapeXml(p.payment || '—')}</text>
      <text x="1050" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(p.date || '—')}</text>
    `;
    currentY += rowHeight;
  });

  const svg = `
    <svg width="${WIDTH}" height="${currentY + footerHeight + 10}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${currentY + footerHeight + 10}" fill="#ffffff"/>
      ${renderSvgHeader('مرضى الغسيل الكلوي', 'Dialysis Unit Sheet', dateLabel, 'وحدة الغسيل الكلوي')}
      
      <rect x="35" y="${headerHeight}" width="${WIDTH - 70}" height="${tableHeaderHeight}" fill="#7c3aed" rx="4"/>
      <text x="55" y="${headerHeight + 24}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">#</text>
      <text x="110" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الموقع</text>
      <text x="210" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">اسم المريض</text>
      <text x="560" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الطبيب المتابع</text>
      <text x="820" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الجهة الضامنة</text>
      <text x="1050" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">تاريخ الجلسة</text>

      ${rowsSvg}
      ${renderSvgFooter(currentY + 5, dialysis.length, 'جلسة غسيل')}
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * 4. Exit / Discharges Sheet JPEG
 */
export async function generateExitJpeg(discharged: any[], dateLabel: string): Promise<Buffer> {
  const rowHeight = 34;
  const headerHeight = 110;
  const tableHeaderHeight = 38;
  const footerHeight = 45;
  const count = Math.max((discharged || []).length, 1);

  let rowsSvg = '';
  let currentY = headerHeight + tableHeaderHeight;

  (discharged || []).forEach((p, idx) => {
    const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    rowsSvg += `
      <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="${bg}"/>
      <line x1="35" y1="${currentY + rowHeight}" x2="${WIDTH - 35}" y2="${currentY + rowHeight}" stroke="#f1f5f9" stroke-width="1"/>
      <text x="55" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${idx + 1}</text>
      <text x="110" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#e11d48">${escapeXml(p.room || '—')}</text>
      <text x="210" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(p.name || '—')}</text>
      <text x="560" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#0f766e">${escapeXml(p.doctor ? `د. ${p.doctor}` : '—')}</text>
      <text x="820" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" fill="#475569">${escapeXml(p.contractor || p.payment || '—')}</text>
      <text x="1050" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(p.dischargeDate || p.date || '—')}</text>
    `;
    currentY += rowHeight;
  });

  const svg = `
    <svg width="${WIDTH}" height="${currentY + footerHeight + 10}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${currentY + footerHeight + 10}" fill="#ffffff"/>
      ${renderSvgHeader('حالات الخروج الرسمية', 'Discharged Patients Sheet', dateLabel, 'خروج معتمد')}
      
      <rect x="35" y="${headerHeight}" width="${WIDTH - 70}" height="${tableHeaderHeight}" fill="#e11d48" rx="4"/>
      <text x="55" y="${headerHeight + 24}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">#</text>
      <text x="110" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الغرفة</text>
      <text x="210" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">اسم المريض</text>
      <text x="560" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الطبيب المعالج</text>
      <text x="820" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">التعاقد</text>
      <text x="1050" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">تاريخ الخروج</text>

      ${rowsSvg}
      ${renderSvgFooter(currentY + 5, discharged.length, 'حالة خروج')}
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * 5. General Debts Sheet JPEG (Insured debts excluded per user specifications)
 */
export async function generateDebtsJpeg(debts: any[], dateLabel: string): Promise<Buffer> {
  const rowHeight = 34;
  const headerHeight = 110;
  const tableHeaderHeight = 38;
  const footerHeight = 45;

  let rowsSvg = '';
  let currentY = headerHeight + tableHeaderHeight;

  (debts || []).forEach((p, idx) => {
    const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    rowsSvg += `
      <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="${bg}"/>
      <line x1="35" y1="${currentY + rowHeight}" x2="${WIDTH - 35}" y2="${currentY + rowHeight}" stroke="#f1f5f9" stroke-width="1"/>
      <text x="55" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${idx + 1}</text>
      <text x="110" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#b45309">${escapeXml(p.room || '—')}</text>
      <text x="210" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(p.name || '—')}</text>
      <text x="560" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#b45309">${escapeXml(p.amount ? `${p.amount} EGP` : '—')}</text>
      <text x="820" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" fill="#475569">${escapeXml(p.contractor || p.notes || '—')}</text>
    `;
    currentY += rowHeight;
  });

  const svg = `
    <svg width="${WIDTH}" height="${currentY + footerHeight + 10}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${currentY + footerHeight + 10}" fill="#ffffff"/>
      ${renderSvgHeader('تقرير مديونيات المرضى', 'Patient Debts Sheet', dateLabel, 'مديونيات عامة')}
      
      <rect x="35" y="${headerHeight}" width="${WIDTH - 70}" height="${tableHeaderHeight}" fill="#b45309" rx="4"/>
      <text x="55" y="${headerHeight + 24}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">#</text>
      <text x="110" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الغرفة</text>
      <text x="210" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">اسم المريض</text>
      <text x="560" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">المبلغ المستحق</text>
      <text x="820" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">ملاحظات / التعاقد</text>

      ${rowsSvg}
      ${renderSvgFooter(currentY + 5, debts.length, 'سجل مديونية')}
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * 6. Patient Transfers Sheet JPEG
 */
export async function generateTransfersJpeg(transfers: any[], dateLabel: string): Promise<Buffer> {
  const rowHeight = 34;
  const headerHeight = 110;
  const tableHeaderHeight = 38;
  const footerHeight = 45;

  let rowsSvg = '';
  let currentY = headerHeight + tableHeaderHeight;

  (transfers || []).forEach((p, idx) => {
    const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    rowsSvg += `
      <rect x="35" y="${currentY}" width="${WIDTH - 70}" height="${rowHeight}" fill="${bg}"/>
      <line x1="35" y1="${currentY + rowHeight}" x2="${WIDTH - 35}" y2="${currentY + rowHeight}" stroke="#f1f5f9" stroke-width="1"/>
      <text x="55" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${idx + 1}</text>
      <text x="120" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(p.patientName || p.name || '—')}</text>
      <text x="450" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" fill="#64748b">${escapeXml(p.fromRoom || '—')}</text>
      <text x="600" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#0d9488">${escapeXml(p.toRoom || '—')}</text>
      <text x="780" y="${currentY + 22}" font-family="'Cairo', Arial, sans-serif" font-size="11" font-weight="bold" fill="#0f766e">${escapeXml(p.doctor ? `د. ${p.doctor}` : '—')}</text>
      <text x="1030" y="${currentY + 22}" font-family="Arial, sans-serif" font-size="11" fill="#64748b">${escapeXml(p.transferDate || p.date || '—')}</text>
    `;
    currentY += rowHeight;
  });

  const svg = `
    <svg width="${WIDTH}" height="${currentY + footerHeight + 10}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${currentY + footerHeight + 10}" fill="#ffffff"/>
      ${renderSvgHeader('سجل تحويلات المرضى بين الغرف', 'Patient Transfers Log', dateLabel, 'تحويلات داخلية')}
      
      <rect x="35" y="${headerHeight}" width="${WIDTH - 70}" height="${tableHeaderHeight}" fill="#0d9488" rx="4"/>
      <text x="55" y="${headerHeight + 24}" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">#</text>
      <text x="120" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">اسم المريض</text>
      <text x="450" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">من غرفة</text>
      <text x="600" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">إلى غرفة</text>
      <text x="780" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">الطبيب المعالج</text>
      <text x="1030" y="${headerHeight + 24}" font-family="'Cairo', Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff">تاريخ ووقت التحويل</text>

      ${rowsSvg}
      ${renderSvgFooter(currentY + 5, transfers.length, 'حالة تحويل')}
    </svg>
  `;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}
