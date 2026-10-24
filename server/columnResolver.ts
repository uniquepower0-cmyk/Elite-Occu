export type ExpectedColumnType = 'room' | 'name' | 'id' | 'number' | 'date' | 'phone' | 'text';

export interface ColumnResolver {
  headerRowIdx: number;
  findCol: (
    candidates: string[],
    defaultIdx: number,
    expectedType?: ExpectedColumnType
  ) => number;
}

/**
 * Builds a dynamic column index resolver from raw 2D sheet rows.
 * Detects the header row dynamically (Arabic and English keywords),
 * and safely maps candidate column names to indices using exact matching,
 * normalized alphanumeric matching, bounded substring matching, and semantic content validation.
 */
export function buildColumnIndexResolver(
  rows: any[][],
  maxHeaderRows = 10
): ColumnResolver {
  const colMap = new Map<string, number>();
  let headerRowIdx = -1;

  for (let r = 0; r < Math.min(rows.length, maxHeaderRows); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    let matchCount = 0;
    row.forEach((cell) => {
      const s = String(cell || "").toLowerCase().trim();
      if (
        s.includes("bed") || s.includes("room") || s.includes("غرفة") || s.includes("سرير") ||
        s.includes("patient") || s.includes("مريض") || s.includes("اسم") || s.includes("mrn") || 
        s.includes("admission") || s.includes("تاريخ") || s.includes("دخول") ||
        s.includes("invoice") || s.includes("remaining") || s.includes("ftotal") ||
        s.includes("إجمالي") || s.includes("اجمالي") || s.includes("متبقي") || s.includes("مديونية") ||
        s.includes("handover") || s.includes("alos") || s.includes("los") || s.includes("notes") ||
        s.includes("physician") || s.includes("doctor") || s.includes("طبيب") ||
        s.includes("mobile") || s.includes("phone") || s.includes("جوال") || s.includes("هاتف")
      ) {
        matchCount++;
      }
    });
    if (matchCount >= 2) {
      headerRowIdx = r;
      row.forEach((cell, idx) => {
        const s = String(cell || "").toLowerCase().trim();
        if (s) {
          colMap.set(s, idx);
        }
      });
      break;
    }
  }

  // Content validation helper to verify if a column matches expected semantic type
  const isContentValid = (
    colIdx: number,
    expectedType?: ExpectedColumnType
  ): boolean => {
    if (!expectedType || expectedType === 'text') return true;
    if (colIdx < 0 || !Array.isArray(rows) || headerRowIdx === -1) return true;

    // Sample up to 15 non-empty rows below the header
    const samples: string[] = [];
    for (let r = headerRowIdx + 1; r < Math.min(rows.length, headerRowIdx + 30); r++) {
      const val = String(rows[r]?.[colIdx] ?? "").trim();
      if (val && val !== "-" && val.toLowerCase() !== "null" && val.toLowerCase() !== "none") {
        samples.push(val);
      }
      if (samples.length >= 15) break;
    }
    if (samples.length === 0) return true; // Can't invalidate empty data

    if (expectedType === 'id') {
      // MRN/ID check: Must NOT be multi-word human names without digits!
      const multiWordAlphaCount = samples.filter(s => {
        const words = s.split(/\s+/).filter(Boolean);
        return words.length >= 2 && !/\d/.test(s) && s.length > 5;
      }).length;
      if (multiWordAlphaCount / samples.length > 0.5) {
        return false; // This is a person's name, not an MRN!
      }
      return true;
    }

    if (expectedType === 'name') {
      // Patient / Physician Name: Should not be pure numbers or dates
      const pureNumberCount = samples.filter(s => /^-?\d+(\.\d+)?$/.test(s.replace(/,/g, ""))).length;
      if (pureNumberCount / samples.length > 0.6) return false;
      const dateCount = samples.filter(s => /\d{4}[-/]\d{1,2}[-/]\d{1,2}|T\d{2}:\d{2}/.test(s)).length;
      if (dateCount / samples.length > 0.6) return false;
      return true;
    }

    if (expectedType === 'number') {
      // Numeric / Debt / LOS / ALOS: Must parse as numeric
      const numericCount = samples.filter(s => {
        const cleaned = s.replace(/[^0-9.-]/g, "");
        return cleaned !== "" && !isNaN(Number(cleaned));
      }).length;
      if (numericCount / samples.length < 0.5) return false;
      return true;
    }

    if (expectedType === 'room') {
      const isLongText = samples.filter(s => s.length > 30).length;
      if (isLongText / samples.length > 0.5) return false;
      return true;
    }

    if (expectedType === 'date') {
      const dateLikeCount = samples.filter(s => /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|T\d{2}:\d{2}/.test(s)).length;
      if (dateLikeCount / samples.length < 0.4) return false;
      return true;
    }

    return true;
  };

  const findCol = (
    candidates: string[],
    defaultIdx: number,
    expectedType?: ExpectedColumnType
  ): number => {
    if (colMap.size === 0) return defaultIdx;

    let matchedIdx = -1;

    // 1. Exact match
    for (const c of candidates) {
      const norm = c.toLowerCase().trim();
      if (colMap.has(norm)) {
        const idx = colMap.get(norm)!;
        if (isContentValid(idx, expectedType)) {
          matchedIdx = idx;
          break;
        }
      }
    }

    // 2. Exact match ignoring spaces, underscores, dashes
    if (matchedIdx === -1) {
      for (const c of candidates) {
        const cleanC = c.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, "");
        if (!cleanC) continue;
        for (const [key, idx] of colMap.entries()) {
          const cleanKey = key.replace(/[^a-z0-9\u0600-\u06FF]/g, "");
          if (cleanKey === cleanC) {
            if (isContentValid(idx, expectedType)) {
              matchedIdx = idx;
              break;
            }
          }
        }
        if (matchedIdx !== -1) break;
      }
    }

    // 3. Substring match with exclusion guards (key.includes(norm) ONLY, never norm.includes(key))
    if (matchedIdx === -1) {
      for (const c of candidates) {
        const norm = c.toLowerCase().trim();
        if (norm.length <= 2) continue; // Don't do substring match for very short tokens like "id"

        for (const [key, idx] of colMap.entries()) {
          // If searching for contractor name, DO NOT match share, percentage, or amount columns
          if (norm.includes("contract") || norm.includes("جهة") || norm.includes("شرك")) {
            if (
              key.includes("share") || key.includes("مساهمة") || key.includes("تحمل") ||
              key.includes("نسبة") || key.includes("amount") || key.includes("مبلغ")
            ) {
              continue;
            }
          }
          // If searching for financial status, DO NOT match payment by
          if (norm.includes("financial") || norm.includes("فئة") || norm.includes("حالة")) {
            if (key.includes("payment") || key.includes("دفع") || key.includes("سداد")) {
              continue;
            }
          }
          // If searching for total invoice, DO NOT match remaining or payment
          if (norm.includes("total") || norm.includes("ftotal") || norm.includes("إجمالي") || norm.includes("اجمالي")) {
            if (key.includes("remaining") || key.includes("difference") || key.includes("payment") || key.includes("متبقي") || key.includes("باقي") || key.includes("سداد") || key.includes("مسدد")) {
              continue;
            }
          }
          // If searching for remaining debt, DO NOT match total or invoice
          if (norm.includes("remaining") || norm.includes("difference") || norm.includes("متبقي") || norm.includes("باقي")) {
            if (key.includes("total") || key.includes("invoice") || key.includes("ftotal") || key.includes("إجمالي") || key.includes("اجمالي")) {
              continue;
            }
          }
          // If searching for MRN, DO NOT match patient name or diagnosis
          if (norm.includes("mrn") || norm.includes("barcode") || norm.includes("ملف")) {
            if (key.includes("name") || key.includes("اسم") || key.includes("diagnosis") || key.includes("تشخيص")) {
              continue;
            }
          }

          if (key.includes(norm)) {
            if (isContentValid(idx, expectedType)) {
              matchedIdx = idx;
              break;
            }
          }
        }
        if (matchedIdx !== -1) break;
      }
    }

    if (matchedIdx !== -1) return matchedIdx;

    if (defaultIdx >= 0 && isContentValid(defaultIdx, expectedType)) {
      return defaultIdx;
    }

    return -1;
  };

  return { headerRowIdx, findCol };
}

/**
 * Builds a deterministic surrogate MRN when MRN column is omitted or empty.
 * Format: UNKNOWN-<HASH>
 */
export function buildDeterministicUnknownMrn(name: string, fallbackRoom = ''): string {
  const clean = String(name || fallbackRoom || 'patient')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  let hash = 5381;
  for (let i = 0; i < clean.length; i++) {
    hash = ((hash << 5) + hash) ^ clean.charCodeAt(i);
  }
  return `UNKNOWN-${(hash >>> 0).toString(36).toUpperCase()}`;
}

/**
 * Formats MRN for user-facing Excel sheet exports.
 * If MRN was omitted, empty, or assigned a synthetic/surrogate ID (e.g. UNKNOWN-XXXX),
 * displays "N/A" in the downloadable sheet cell.
 */
export function formatMrnForSheet(mrn: any): string {
  const s = String(mrn ?? '').trim();
  if (
    !s ||
    s.startsWith('UNKNOWN-') ||
    s.startsWith('transfer-') ||
    s === '—' ||
    s === '-' ||
    s.toLowerCase() === 'null' ||
    s.toLowerCase() === 'undefined' ||
    s.toLowerCase() === 'n/a'
  ) {
    return 'N/A';
  }
  return s;
}
