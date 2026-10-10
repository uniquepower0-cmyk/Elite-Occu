/**
 * RefinedSheetsVisualRenderer
 * Generates pixel-perfect, high-resolution JPEG images of Mohanad's Refined Combined Sheets
 * and dispatches them sequentially to WhatsApp groups via Green API.
 * 
 * Excludes Insured Debts per user specification (DEC-07).
 */

export interface SheetDefinition {
  id: string;
  name: string;
  titleAr: string;
  titleEn: string;
  caption: string;
  data: any[];
  renderHtml: (dateLabel: string) => string;
}

// Convert an HTML string with styles to a 2x Retina JPEG Blob using SVG foreignObject and Canvas
export async function htmlToJpegBlob(htmlContent: string, width = 1200, minHeight = 800): Promise<Blob> {
  // Create an offscreen sandbox iframe/container to accurately measure layout height
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  container.style.width = `${width}px`;
  container.style.backgroundColor = '#ffffff';
  container.style.zIndex = '-1000';
  container.innerHTML = htmlContent;
  document.body.appendChild(container);

  // Allow styles to compute
  await new Promise((resolve) => setTimeout(resolve, 50));
  const measuredHeight = Math.max(container.scrollHeight || minHeight, minHeight) + 40;
  document.body.removeChild(container);

  // Wrap in well-formed SVG
  const svgString = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${measuredHeight}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="background-color: #ffffff; width: ${width}px; min-height: ${measuredHeight}px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Cairo', sans-serif;">
          ${htmlContent}
        </div>
      </foreignObject>
    </svg>
  `;

  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve(true);
    img.onerror = (err) => reject(new Error('Failed to load SVG into image: ' + String(err)));
    img.src = svgUrl;
  });

  const scale = 2; // 2x Retina resolution
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = measuredHeight * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize Canvas 2D context');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);

  URL.revokeObjectURL(svgUrl);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to convert canvas to JPEG Blob'));
    }, 'image/jpeg', 0.92);
  });
}

function renderHeader(titleAr: string, titleEn: string, dateLabel: string, badgeText: string) {
  return `
    <div style="background: linear-gradient(135deg, #094037 0%, #0d5c50 100%); color: #ffffff; padding: 24px 32px; border-radius: 16px 16px 0 0; display: flex; justify-content: space-between; align-items: center; border-bottom: 4px solid #14b8a6;">
      <div>
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 6px;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${titleAr}</h1>
          <span style="font-size: 14px; opacity: 0.85; font-weight: 500;">/ ${titleEn}</span>
        </div>
        <p style="margin: 0; font-size: 13px; color: #a7f3d0; font-weight: 600;">Elite Hospital Occupancy Management System • Mohanad's Refined Series</p>
      </div>
      <div style="text-align: right;">
        <div style="display: inline-block; background: rgba(255,255,255,0.15); padding: 6px 16px; border-radius: 20px; font-size: 13px; font-weight: 700; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.2);">
          ${badgeText}
        </div>
        <div style="font-size: 12px; color: #ccfbf1; font-weight: 600;">التاريخ: ${dateLabel}</div>
      </div>
    </div>
  `;
}

function renderFooter(recordCount: number, customNote = '') {
  return `
    <div style="background: #f8fafc; padding: 16px 32px; border-radius: 0 0 16px 16px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #64748b; font-weight: 600;">
      <div>إجمالي الحالات المسجلة: <span style="color: #094037; font-weight: 800; font-size: 14px;">${recordCount}</span> ${customNote}</div>
      <div>Source: Elite Hospital Core Database • Official Administrative Census</div>
    </div>
  `;
}

/**
 * Builds HTML for 1. Occupancy Sheet
 */
function buildOccupancyHtml(occupancyRows: any[][], dateLabel: string): string {
  let rowsHtml = '';
  let count = 0;

  (occupancyRows || []).forEach((row) => {
    // Check if group header row
    const isHeaderRow = row.length > 0 && String(row[0]).includes('الدور') || String(row[0]).includes('Floor') || String(row[0]).includes('قسم');
    if (isHeaderRow) {
      rowsHtml += `
        <tr style="background-color: #0f766e; color: #ffffff; font-weight: 800; font-size: 13px;">
          <td colspan="7" style="padding: 10px 16px; text-align: right; letter-spacing: 0.5px;">${row[0]}</td>
        </tr>
      `;
      return;
    }

    if (row.length < 3) return;
    count++;
    const room = row[1] || row[0] || '';
    const name = row[2] || row[1] || '';
    const mrn = row[3] || '';
    const doctor = row[4] || '';
    const payment = row[5] || '';
    const date = row[6] || '';

    const isCash = String(payment).toLowerCase().includes('نقدي') || String(payment).toLowerCase().includes('cash');

    rowsHtml += `
      <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${count % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-size: 12px;">
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 700;">${count}</td>
        <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #0f766e; font-family: monospace; font-size: 13px;">${room}</td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b;">${name}</td>
        <td style="padding: 10px 14px; color: #64748b; font-family: monospace;">${mrn}</td>
        <td style="padding: 10px 16px; color: #047857; font-weight: 600;">${doctor ? `د. ${doctor}` : '—'}</td>
        <td style="padding: 10px 14px; text-align: center;">
          <span style="display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 800; ${isCash ? 'background: #dcfce7; color: #166534; border: 1px solid #bbf7d0;' : 'background: #e0f2fe; color: #075985; border: 1px solid #bae6fd;'}">
            ${payment || 'تعاقد'}
          </span>
        </td>
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-family: monospace;">${date}</td>
      </tr>
    `;
  });

  return `
    <div style="padding: 24px; box-sizing: border-box; direction: rtl;">
      ${renderHeader('تقرير الإشغال العام', 'Hospital Occupancy Sheet', dateLabel, 'تقرير الإشغال الرسمي')}
      <table style="width: 100%; border-collapse: collapse; text-align: right; background: #ffffff; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <thead>
          <tr style="background: #f1f5f9; color: #334155; font-size: 11px; font-weight: 800; text-transform: uppercase; border-bottom: 2px solid #cbd5e1;">
            <th style="padding: 12px 14px; text-align: center;">#</th>
            <th style="padding: 12px 14px; text-align: center;">الغرفة</th>
            <th style="padding: 12px 16px;">اسم المريض</th>
            <th style="padding: 12px 14px;">الرقم الطبي</th>
            <th style="padding: 12px 16px;">الطبيب المعالج</th>
            <th style="padding: 12px 14px; text-align: center;">جهة التحمل</th>
            <th style="padding: 12px 14px; text-align: center;">تاريخ الدخول</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      ${renderFooter(count, 'مريض بالقسم الداخلي')}
    </div>
  `;
}

/**
 * Builds HTML for 2. Daily Admissions Sheet
 */
function buildEntriesHtml(entries: any[], dateLabel: string): string {
  let rowsHtml = '';
  entries.forEach((p, index) => {
    rowsHtml += `
      <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${index % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-size: 12px;">
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 700;">${index + 1}</td>
        <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #0284c7; font-family: monospace;">${p.room || p.colB || '—'}</td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b;">${p.name || p.colD || '—'}</td>
        <td style="padding: 10px 16px; color: #0f766e; font-weight: 600;">${p.doctor ? `د. ${p.doctor}` : '—'}</td>
        <td style="padding: 10px 14px; color: #475569;">${p.contractor || p.colM || '—'}</td>
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-family: monospace;">${p.date || '—'}</td>
      </tr>
    `;
  });

  return `
    <div style="padding: 24px; box-sizing: border-box; direction: rtl;">
      ${renderHeader('حالات الدخول اليومي', 'Daily Admissions Sheet', dateLabel, 'دخول جديد')}
      <table style="width: 100%; border-collapse: collapse; text-align: right; background: #ffffff; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <thead>
          <tr style="background: #e0f2fe; color: #0369a1; font-size: 11px; font-weight: 800; border-bottom: 2px solid #bae6fd;">
            <th style="padding: 12px 14px; text-align: center;">#</th>
            <th style="padding: 12px 14px; text-align: center;">الغرفة</th>
            <th style="padding: 12px 16px;">اسم المريض</th>
            <th style="padding: 12px 16px;">الطبيب المعالج</th>
            <th style="padding: 12px 14px;">التعاقد</th>
            <th style="padding: 12px 14px; text-align: center;">تاريخ ووقت الحجز</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="6" style="padding: 24px; text-align: center; color: #94a3b8;">لا يوجد حالات دخول مسجلة اليوم</td></tr>'}
        </tbody>
      </table>
      ${renderFooter(entries.length, 'حالة دخول')}
    </div>
  `;
}

/**
 * Builds HTML for 3. Dialysis Sheet
 */
function buildDialysisHtml(dialysisRows: any[], dateLabel: string): string {
  let rowsHtml = '';
  dialysisRows.forEach((p, index) => {
    rowsHtml += `
      <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${index % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-size: 12px;">
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 700;">${index + 1}</td>
        <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #7c3aed; font-family: monospace;">${p.room || 'غسيل كلوي'}</td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b;">${p.name || '—'}</td>
        <td style="padding: 10px 16px; color: #0f766e; font-weight: 600;">${p.doctor ? `د. ${p.doctor}` : '—'}</td>
        <td style="padding: 10px 14px; color: #475569;">${p.payment || '—'}</td>
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-family: monospace;">${p.date || '—'}</td>
      </tr>
    `;
  });

  return `
    <div style="padding: 24px; box-sizing: border-box; direction: rtl;">
      ${renderHeader('مرضى الغسيل الكلوي', 'Dialysis Unit Sheet', dateLabel, 'وحدة الغسيل الكلوي')}
      <table style="width: 100%; border-collapse: collapse; text-align: right; background: #ffffff; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <thead>
          <tr style="background: #ede9fe; color: #6d28d9; font-size: 11px; font-weight: 800; border-bottom: 2px solid #ddd6fe;">
            <th style="padding: 12px 14px; text-align: center;">#</th>
            <th style="padding: 12px 14px; text-align: center;">الموقع</th>
            <th style="padding: 12px 16px;">اسم المريض</th>
            <th style="padding: 12px 16px;">الطبيب المتابع</th>
            <th style="padding: 12px 14px;">الجهة الضامنة</th>
            <th style="padding: 12px 14px; text-align: center;">تاريخ الجلسة</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="6" style="padding: 24px; text-align: center; color: #94a3b8;">لا يوجد جلسات غسيل مسجلة اليوم</td></tr>'}
        </tbody>
      </table>
      ${renderFooter(dialysisRows.length, 'جلسة غسيل')}
    </div>
  `;
}

/**
 * Builds HTML for 4. Discharge / Exit Sheet
 */
function buildExitHtml(exits: any[], dateLabel: string): string {
  let rowsHtml = '';
  exits.forEach((p, index) => {
    rowsHtml += `
      <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${index % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-size: 12px;">
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 700;">${index + 1}</td>
        <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #e11d48; font-family: monospace;">${p.room || '—'}</td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b;">${p.name || '—'}</td>
        <td style="padding: 10px 16px; color: #0f766e; font-weight: 600;">${p.doctor ? `د. ${p.doctor}` : '—'}</td>
        <td style="padding: 10px 14px; color: #475569;">${p.contractor || p.payment || '—'}</td>
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-family: monospace;">${p.dischargeDate || p.date || '—'}</td>
      </tr>
    `;
  });

  return `
    <div style="padding: 24px; box-sizing: border-box; direction: rtl;">
      ${renderHeader('حالات الخروج الرسمية', 'Discharged Patients Sheet', dateLabel, 'خروج معتمد')}
      <table style="width: 100%; border-collapse: collapse; text-align: right; background: #ffffff; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <thead>
          <tr style="background: #ffe4e6; color: #be123c; font-size: 11px; font-weight: 800; border-bottom: 2px solid #fecdd3;">
            <th style="padding: 12px 14px; text-align: center;">#</th>
            <th style="padding: 12px 14px; text-align: center;">الغرفة</th>
            <th style="padding: 12px 16px;">اسم المريض</th>
            <th style="padding: 12px 16px;">الطبيب المعالج</th>
            <th style="padding: 12px 14px;">التعاقد</th>
            <th style="padding: 12px 14px; text-align: center;">تاريخ الخروج</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="6" style="padding: 24px; text-align: center; color: #94a3b8;">لا يوجد حالات خروج مسجلة اليوم</td></tr>'}
        </tbody>
      </table>
      ${renderFooter(exits.length, 'حالة خروج')}
    </div>
  `;
}

/**
 * Builds HTML for 5. General Debts Sheet
 */
function buildDebtsHtml(debts: any[], dateLabel: string): string {
  let rowsHtml = '';
  debts.forEach((p, index) => {
    rowsHtml += `
      <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${index % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-size: 12px;">
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 700;">${index + 1}</td>
        <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #b45309; font-family: monospace;">${p.room || '—'}</td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b;">${p.name || '—'}</td>
        <td style="padding: 10px 16px; font-weight: 800; color: #b45309;">${p.amount ? `${p.amount} EGP` : '—'}</td>
        <td style="padding: 10px 14px; color: #475569;">${p.contractor || p.notes || '—'}</td>
      </tr>
    `;
  });

  return `
    <div style="padding: 24px; box-sizing: border-box; direction: rtl;">
      ${renderHeader('تقرير مديونيات المرضى', 'Patient Debts Sheet', dateLabel, 'مديونيات')}
      <table style="width: 100%; border-collapse: collapse; text-align: right; background: #ffffff; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <thead>
          <tr style="background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 800; border-bottom: 2px solid #fde68a;">
            <th style="padding: 12px 14px; text-align: center;">#</th>
            <th style="padding: 12px 14px; text-align: center;">الغرفة</th>
            <th style="padding: 12px 16px;">اسم المريض</th>
            <th style="padding: 12px 16px;">المبلغ المستحق</th>
            <th style="padding: 12px 14px;">ملاحظات / التعاقد</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="5" style="padding: 24px; text-align: center; color: #94a3b8;">لا توجد مديونيات مسجلة</td></tr>'}
        </tbody>
      </table>
      ${renderFooter(debts.length, 'سجل مديونية')}
    </div>
  `;
}

/**
 * Builds HTML for 6. Patient Transfers Sheet
 */
function buildTransfersHtml(transfers: any[], dateLabel: string): string {
  let rowsHtml = '';
  transfers.forEach((p, index) => {
    rowsHtml += `
      <tr style="border-bottom: 1px solid #f1f5f9; background-color: ${index % 2 === 0 ? '#f8fafc' : '#ffffff'}; font-size: 12px;">
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-weight: 700;">${index + 1}</td>
        <td style="padding: 10px 16px; font-weight: 700; color: #1e293b;">${p.patientName || p.name || '—'}</td>
        <td style="padding: 10px 14px; text-align: center; font-family: monospace; color: #64748b;">${p.fromRoom || '—'}</td>
        <td style="padding: 10px 14px; text-align: center; font-weight: 800; color: #0d9488; font-family: monospace;">${p.toRoom || '—'}</td>
        <td style="padding: 10px 16px; color: #0f766e;">${p.doctor ? `د. ${p.doctor}` : '—'}</td>
        <td style="padding: 10px 14px; text-align: center; color: #64748b; font-family: monospace;">${p.transferDate || p.date || '—'}</td>
      </tr>
    `;
  });

  return `
    <div style="padding: 24px; box-sizing: border-box; direction: rtl;">
      ${renderHeader('سجل تحويلات المرضى بين الغرف', 'Patient Transfers Log', dateLabel, 'تحويلات داخلية')}
      <table style="width: 100%; border-collapse: collapse; text-align: right; background: #ffffff; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <thead>
          <tr style="background: #ccfbf1; color: #115e59; font-size: 11px; font-weight: 800; border-bottom: 2px solid #99f6e4;">
            <th style="padding: 12px 14px; text-align: center;">#</th>
            <th style="padding: 12px 16px;">اسم المريض</th>
            <th style="padding: 12px 14px; text-align: center;">من غرفة</th>
            <th style="padding: 12px 14px; text-align: center;">إلى غرفة</th>
            <th style="padding: 12px 16px;">الطبيب المعالج</th>
            <th style="padding: 12px 14px; text-align: center;">تاريخ ووقت التحويل</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="6" style="padding: 24px; text-align: center; color: #94a3b8;">لا توجد تحويلات مسجلة اليوم</td></tr>'}
        </tbody>
      </table>
      ${renderFooter(transfers.length, 'حالة تحويل')}
    </div>
  `;
}

/**
 * Main Orchestration Function:
 * Fetches preview dataset, renders each sheet to JPEG Blob, and uploads to Green API via Vercel-optimized chunked dispatch.
 */
export async function generateAndSendRefinedSheetsToWhatsApp(
  onProgress: (status: string) => void
): Promise<{ success: boolean; sentCount: number; error?: string }> {
  try {
    onProgress('Fetching report data from server...');
    const res = await fetch('/api/reports/refined-combined-preview');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to retrieve report preview dataset.');
    }

    const payload = await res.json();
    const dateLabel = payload.dateLabel || new Date().toISOString().split('T')[0];

    // Build the list of sheets to render and dispatch (Strictly excluding insured debts per DEC-07)
    const sheetsToProcess: SheetDefinition[] = [];

    // 1. Occupancy
    if (payload.occupancy && payload.occupancy.length > 0) {
      sheetsToProcess.push({
        id: '01_Occupancy',
        name: 'Occupancy Sheet',
        titleAr: 'تقرير الإشغال العام',
        titleEn: 'Hospital Occupancy',
        caption: `📊 تقرير الإشغال العام (${dateLabel})\nالمستشفى: Elite Hospital\nإجمالي الحالات: ${payload.activePatients?.length || 0}`,
        data: payload.occupancy,
        renderHtml: (date) => buildOccupancyHtml(payload.occupancy, date),
      });
    }

    // 2. Entries
    if (payload.entries && payload.entries.length > 0) {
      sheetsToProcess.push({
        id: '02_Entries',
        name: 'Admissions Sheet',
        titleAr: 'حالات الدخول اليومي',
        titleEn: 'Daily Admissions',
        caption: `📥 حالات الدخول اليومي (${dateLabel})\nإجمالي الدخول: ${payload.entries.length}`,
        data: payload.entries,
        renderHtml: (date) => buildEntriesHtml(payload.entries, date),
      });
    }

    // 3. Dialysis
    if (payload.dialysis && payload.dialysis.length > 0) {
      sheetsToProcess.push({
        id: '03_Dialysis',
        name: 'Dialysis Sheet',
        titleAr: 'مرضى الغسيل الكلوي',
        titleEn: 'Dialysis Unit',
        caption: `🩺 مرضى الغسيل الكلوي (${dateLabel})\nإجمالي الجلسات: ${payload.dialysis.length}`,
        data: payload.dialysis,
        renderHtml: (date) => buildDialysisHtml(payload.dialysis, date),
      });
    }

    // 4. Exits / Discharges
    if (payload.discharged && payload.discharged.length > 0) {
      sheetsToProcess.push({
        id: '04_Exit',
        name: 'Discharged Sheet',
        titleAr: 'حالات الخروج الرسمية',
        titleEn: 'Discharges',
        caption: `🚪 حالات الخروج الرسمية (${dateLabel})\nإجمالي الخروج: ${payload.discharged.length}`,
        data: payload.discharged,
        renderHtml: (date) => buildExitHtml(payload.discharged, date),
      });
    }

    // 5. Debts (General/Cash Debts only)
    if (payload.debts && payload.debts.length > 0) {
      sheetsToProcess.push({
        id: '05_Debts',
        name: 'Debts Sheet',
        titleAr: 'تقرير مديونيات المرضى',
        titleEn: 'Patient Debts',
        caption: `💰 تقرير مديونيات المرضى (${dateLabel})\nإجمالي الحالات: ${payload.debts.length}`,
        data: payload.debts,
        renderHtml: (date) => buildDebtsHtml(payload.debts, date),
      });
    }

    // 6. Patient Transfers
    if (payload.transfers && payload.transfers.length > 0) {
      sheetsToProcess.push({
        id: '06_Transfers',
        name: 'Transfers Sheet',
        titleAr: 'سجل تحويلات المرضى بين الغرف',
        titleEn: 'Patient Transfers',
        caption: `🔄 سجل تحويلات المرضى (${dateLabel})\nإجمالي التحويلات: ${payload.transfers.length}`,
        data: payload.transfers,
        renderHtml: (date) => buildTransfersHtml(payload.transfers, date),
      });
    }

    if (sheetsToProcess.length === 0) {
      throw new Error('No sheet data available to send for today.');
    }

    let sentCount = 0;

    // Process and send each sheet individually to satisfy Vercel serverless request limits
    for (let i = 0; i < sheetsToProcess.length; i++) {
      const sheet = sheetsToProcess[i];
      onProgress(`Rendering ${sheet.name} (${i + 1}/${sheetsToProcess.length})...`);

      const html = sheet.renderHtml(dateLabel);
      const jpegBlob = await htmlToJpegBlob(html);

      onProgress(`Sending ${sheet.name} to WhatsApp (${i + 1}/${sheetsToProcess.length})...`);

      const formData = new FormData();
      formData.append('file', jpegBlob, `${sheet.id}.jpg`);
      formData.append('fileName', `${sheet.id}.jpg`);
      formData.append('caption', sheet.caption);

      const sendRes = await fetch('/api/whatsapp/send-image', {
        method: 'POST',
        body: formData,
      });

      if (!sendRes.ok) {
        const errJson = await sendRes.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to send ${sheet.name} to WhatsApp.`);
      }

      const resData = await sendRes.json();
      if (!resData.success) {
        throw new Error(resData.error || `Error delivering ${sheet.name} to WhatsApp group.`);
      }

      sentCount++;
    }

    return { success: true, sentCount };
  } catch (error: any) {
    console.error('[WhatsApp Automation Client Error]:', error);
    return { success: false, sentCount: 0, error: error.message || 'Failed to dispatch report to WhatsApp.' };
  }
}
