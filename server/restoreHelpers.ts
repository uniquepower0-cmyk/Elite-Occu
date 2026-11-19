import { isCompanionBed, isNameMatch } from './nameUtils.js';

export interface RestoredHmisOverride {
  name: string;
  mrn: string;
  room: string;
  admissionDate: string;
  restoredAt: string;
}

export function cleanMrnDigits(mrn?: any): string {
  if (!mrn) return '';
  return String(mrn).trim().replace(/^0+/, '');
}

export function isCompanionDischargedEntry(entry: any): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.isCompanion === true) return true;
  const room = String(entry.room || entry.bed || entry.colB || '').trim();
  return isCompanionBed(room);
}

export function findPatientRowInRows(
  rows: any[][] | null | undefined,
  name: string,
  mrn?: string
): any[] | null {
  if (!rows || !Array.isArray(rows)) return null;
  const cleanMrn = cleanMrnDigits(mrn);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;

    const is30Col = row.length >= 15 && row.length < 35;
    const isUnified =
      row.length >= 35 ||
      (!is30Col &&
        (String(row[0] || '').includes('T') ||
          /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(String(row[0] || ''))));

    const pName = is30Col
      ? String(row[2] || '').trim()
      : isUnified
        ? String(row[3] || '').trim()
        : String(row[1] || '').trim();

    const pMrn = is30Col
      ? cleanMrnDigits(row[30])
      : isUnified
        ? cleanMrnDigits(row[2])
        : cleanMrnDigits(row[5]);

    if ((pName && isNameMatch(pName, name)) || (cleanMrn && pMrn && pMrn === cleanMrn)) {
      return [...row];
    }
  }
  return null;
}

export function upsertRestoredHmisOverride(
  overrides: RestoredHmisOverride[] | null | undefined,
  entry: RestoredHmisOverride
): RestoredHmisOverride[] {
  const list = Array.isArray(overrides) ? [...overrides] : [];
  const normMrn = cleanMrnDigits(entry.mrn);
  const normName = String(entry.name || '').trim();
  const normalized: RestoredHmisOverride = {
    name: normName,
    mrn: normMrn,
    room: String(entry.room || '').trim(),
    admissionDate: String(entry.admissionDate || '').trim(),
    restoredAt: entry.restoredAt || new Date().toISOString(),
  };

  const idx = list.findIndex((ov) => {
    const ovMrn = cleanMrnDigits(ov.mrn);
    return (
      (normMrn && ovMrn && ovMrn === normMrn) ||
      (normName && ov.name && isNameMatch(ov.name, normName))
    );
  });

  if (idx >= 0) {
    list[idx] = normalized;
  } else {
    list.push(normalized);
  }
  return list;
}
