import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
export function normalizeRowsArray(rows: any): any[][] {
  if (!rows) return [];
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch (_) {
      return [];
    }
  }
  if (!Array.isArray(rows)) {
    if (rows && typeof rows === 'object') {
      if (Array.isArray(rows.rows)) rows = rows.rows;
      else if (Array.isArray(rows.data)) rows = rows.data;
      else if (Array.isArray(rows.current)) rows = rows.current;
      else if (Array.isArray(rows.beds)) rows = rows.beds;
      else return [];
    } else {
      return [];
    }
  }
  if (rows.length === 0) return [];

  // If already a 2D array of arrays, return as is
  if (Array.isArray(rows[0])) {
    return rows;
  }

  // Determine max column index across items
  let maxCol = 41;
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const item = rows[i];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item)) {
        const m = k.match(/^Unnamed:\s*(\d+)$/i);
        if (m) {
          const idx = parseInt(m[1], 10);
          if (idx > maxCol) maxCol = idx;
        }
      }
    }
  }

  return rows.map((item: any) => {
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') {
      const arr: any[] = new Array(maxCol + 1).fill('');

      // 1. Check Unnamed / RTDB keys
      if (item['No filters applied'] !== undefined && item['No filters applied'] !== null) {
        arr[0] = item['No filters applied'];
      }
      for (const [k, v] of Object.entries(item)) {
        const m = k.match(/^Unnamed:\s*(\d+)$/i);
        if (m) {
          const idx = parseInt(m[1], 10);
          arr[idx] = (v !== undefined && v !== null) ? v : '';
        }
      }

      // 2. Map standard named keys if positional keys were missing
      if (!arr[1] && (item.room || item.bed || item.Bed || item.Room)) {
        arr[1] = item.room || item.bed || item.Bed || item.Room || '';
      }
      if (!arr[2] && (item.mrn || item.MRN || item.id || item.patientBarcode)) {
        arr[2] = item.mrn || item.MRN || item.id || item.patientBarcode || '';
      }
      if (!arr[3] && (item.name || item.patient || item.Patient || item.englishFullName)) {
        arr[3] = item.name || item.patient || item.Patient || item.englishFullName || '';
      }
      if (!arr[0] && (item.date || item.admissionDate || item.AdmissionDate)) {
        arr[0] = item.date || item.admissionDate || item.AdmissionDate || '';
      }
      if (!arr[12] && (item.contractor || item.contractorName || item.ContractorName)) {
        arr[12] = item.contractor || item.contractorName || item.ContractorName || '';
      }
      if (!arr[22] && (item.doctor || item.physician || item.treatingPhysicianName || item.TreatingPhysicianName)) {
        arr[22] = item.doctor || item.physician || item.treatingPhysicianName || item.TreatingPhysicianName || '';
      }

      return arr;
    }
    return [];
  });
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uuvomcxbgldgtmuqtymk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[Security Warning] SUPABASE_SERVICE_ROLE_KEY is not defined in process.env. Database operations may fail.');
}

export const historySupabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY || 'missing-service-key-placeholder',
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

// On Vercel (and other read-only serverless environments), /var/task is read-only.
// Use /tmp for ephemeral disk history; on Railway/local process.cwd() is writable.
const WRITABLE_BASE = process.env.VERCEL ? '/tmp' : process.cwd();
export const HISTORY_OCC_DIR = path.join(WRITABLE_BASE, 'history', 'occupancy');
export const HISTORY_OR_DIR = path.join(WRITABLE_BASE, 'history', 'or');

try {
  if (!fs.existsSync(HISTORY_OCC_DIR)) fs.mkdirSync(HISTORY_OCC_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_OR_DIR)) fs.mkdirSync(HISTORY_OR_DIR, { recursive: true });
} catch (mkdirErr) {
  console.warn('[historyManager] Could not create history dirs (read-only fs?):', (mkdirErr as any)?.message);
}


export interface OccupancySnapshotSummary {
  totalOccupancy: number;
  entriesCount: number;
  dischargesCount: number;
  autoDischargesCount?: number;
  manualDischargesCount?: number;
  dialysisCount: number;
  debtsCount: number;
  insuredDebtsCount: number;
  transfersCount: number;
}

export interface OccupancySnapshot {
  date: string; // YYYY-MM-DD
  timestamp: number;
  cairoTime: string;
  hospitalData: any[][] | null;
  previousHospitalData: any[][] | null;
  cumulativeEntries: any[];
  cumulativeDialysis: any[];
  cumulativeDebts: any[];
  cumulativeInsuredDebts: any[];
  cumulativeMedicalPlans: any[];
  cumulativeCompanionStatus: any[];
  cumulativeLOS: any[];
  cumulativeDischarged: any[];
  automaticallyDischarged?: any[];
  manuallyDischarged?: any[];
  manuallyDischargedNames?: string[];
  cumulativeTransfers: any[];
  vipCasesText: string;
  earlyDischargeRoomsText: string;
  summary: OccupancySnapshotSummary;
}

export interface ORSnapshotSummary {
  totalCases: number;
  matched: number;
  outpatients: number;
}

export interface ORSnapshot {
  date: string; // YYYY-MM-DD
  timestamp: number;
  cairoTime: string;
  orList: any[];
  summary: ORSnapshotSummary;
}

export interface DateIndexEntry {
  date: string;
  timestamp: number;
  cairoTime: string;
  summary: any;
}

// ─── Change Log (immutable per-change timestamped snapshots) ──────────────────

export type ChangeType =
  | 'upload'
  | 'transfer'
  | 'discharge'
  | 'restore'
  | 'setting'
  | 'daily_final'
  | 'manual_reset'
  | 'general';

export interface ChangeLogEntry {
  date: string;          // YYYY-MM-DD Cairo
  timestamp: number;     // epoch ms — unique identifier within a day
  cairoTime: string;     // human-readable Cairo timestamp
  changeType: ChangeType;
  summary: OccupancySnapshotSummary;
  // Lightweight cumulative arrays (full hospitalData omitted to avoid bloat)
  cumulativeEntries: any[];
  cumulativeDischarged: any[];
  cumulativeDialysis: any[];
  cumulativeTransfers: any[];
  vipCasesText: string;
}

/**
 * Append an immutable timestamped change-log entry for a given date.
 * Stored as a separate Supabase row per change:
 *   history/changelog/{date}/{timestamp}
 * These rows are never overwritten — each change event creates its own row.
 */
export async function saveChangeLogEntry(
  entry: Omit<ChangeLogEntry, 'date' | 'timestamp' | 'cairoTime'> & { date?: string; timestamp?: number }
): Promise<ChangeLogEntry> {
  const cairo = getCairoDateTime();
  const dateStr = entry.date || cairo.dateStr;
  const timestamp = entry.timestamp || Date.now();
  const cairoTime = cairo.fullStr;

  const logEntry: ChangeLogEntry = {
    date: dateStr,
    timestamp,
    cairoTime,
    changeType: entry.changeType,
    summary: entry.summary,
    cumulativeEntries: entry.cumulativeEntries || [],
    cumulativeDischarged: entry.cumulativeDischarged || [],
    cumulativeDialysis: entry.cumulativeDialysis || [],
    cumulativeTransfers: entry.cumulativeTransfers || [],
    vipCasesText: entry.vipCasesText || '',
  };

  const path = `history/changelog/${dateStr}/${timestamp}`;

  try {
    const nowIso = new Date(timestamp).toISOString();
    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await historySupabase
        .from('rtdb_nodes')
        .upsert({ path, data: logEntry, updated_at: nowIso });

      if (!error) {
        lastError = null;
        console.log(`[ChangeLog] Change log entry saved: ${path} (type=${logEntry.changeType})`);
        break;
      }
      lastError = error;
      const errMsg = String(error.message || error.details || error);
      const isRetryable = errMsg.includes('ECONNRESET') || errMsg.includes('fetch failed') || errMsg.includes('ETIMEDOUT');
      if (isRetryable && attempt < 3) {
        await new Promise(res => setTimeout(res, attempt * 150));
      } else {
        break;
      }
    }

    if (lastError) {
      console.warn(`[ChangeLog] Notice saving change log entry (${logEntry.changeType}) for ${dateStr}:`, lastError.message || lastError);
    }
  } catch (err: any) {
    console.warn(`[ChangeLog] Notice saving change log entry:`, err?.message || err);
  }

  // Also update the changelog index so we know which dates have changelog entries
  try {
    await updateChangeLogIndex(dateStr);
  } catch (_) {}

  return logEntry;
}

/**
 * Retrieve all change-log entries for a specific date, sorted oldest → newest.
 */
export async function getChangeLogForDate(dateStr: string): Promise<ChangeLogEntry[]> {
  const cleanDate = dateStr.trim();
  try {
    const { data: nodes, error } = await historySupabase
      .from('rtdb_nodes')
      .select('path, data, updated_at')
      .like('path', `history/changelog/${cleanDate}/%`);

    if (error) {
      console.error(`[ChangeLog] Failed to fetch changelog for ${cleanDate}:`, error);
      return [];
    }

    if (!nodes || nodes.length === 0) return [];

    const entries: ChangeLogEntry[] = nodes
      .map(n => n.data as ChangeLogEntry)
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);

    return entries;
  } catch (err) {
    console.error(`[ChangeLog] Exception fetching changelog for ${cleanDate}:`, err);
    return [];
  }
}

export const MAX_HISTORY_RETENTION_DAYS = 30;

export interface RetentionHooks {
  onBeforeDeleteDate?: (dateStr: string) => Promise<void>;
  externalRtdbPrune?: (dateStr: string) => Promise<void>;
}

let retentionHooks: RetentionHooks = {};

export function registerRetentionHooks(hooks: RetentionHooks): void {
  retentionHooks = { ...retentionHooks, ...hooks };
}

/**
 * Computes the earliest YYYY-MM-DD date to retain for a rolling window of `maxDays`
 * inclusive of `referenceDateStr` (e.g. if referenceDateStr is Day 31 and maxDays is 30,
 * Day 2 .. Day 31 are >= cutoffDate, while Day 1 is < cutoffDate).
 */
export function getRetentionCutoffDate(
  referenceDateStr?: string,
  maxDays: number = MAX_HISTORY_RETENTION_DAYS
): string {
  const effectiveMax = Math.max(1, maxDays);
  const baseStr =
    (referenceDateStr && normalizeToISODate(referenceDateStr)) ||
    getCairoDateTime().dateStr;
  const [y, m, d] = baseStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - (effectiveMax - 1));
  const yStr = dt.getUTCFullYear();
  const mStr = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dStr = String(dt.getUTCDate()).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Delete all change-log entries for a specific date from Supabase rtdb_nodes and index.
 */
export async function deleteChangeLogForDate(dateStr: string): Promise<boolean> {
  const norm = normalizeToISODate(dateStr);
  const cleanDate = norm || dateStr.trim();
  try {
    await historySupabase
      .from('rtdb_nodes')
      .delete()
      .like('path', `history/changelog/${cleanDate}%`);

    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', 'history/changelog_index')
      .maybeSingle();

    if (node && Array.isArray(node.data)) {
      const filtered = (node.data as string[]).filter(
        d => (normalizeToISODate(d) || d) !== cleanDate && d !== dateStr
      );
      await historySupabase.from('rtdb_nodes').upsert({
        path: 'history/changelog_index',
        data: filtered,
        updated_at: new Date().toISOString(),
      });
    }
    return true;
  } catch (err) {
    console.error(`[ChangeLog] Failed to delete changelog for ${cleanDate}:`, err);
    return false;
  }
}

/**
 * Retrieve all dates that have at least one change-log entry (capped at 30 days).
 */
export async function getChangeLogDates(): Promise<string[]> {
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', 'history/changelog_index')
      .maybeSingle();

    if (node && Array.isArray(node.data)) {
      const normalized = Array.from(
        new Set(
          (node.data as string[])
            .map(d => normalizeToISODate(d) || d)
            .filter(Boolean)
        )
      ).sort((a, b) => b.localeCompare(a));
      const refDate = normalized[0] || getCairoDateTime().dateStr;
      const cutoffDate = getRetentionCutoffDate(refDate, MAX_HISTORY_RETENTION_DAYS);
      return normalized.filter((d, idx) => idx < MAX_HISTORY_RETENTION_DAYS && d >= cutoffDate);
    }
  } catch (err) {
    console.error('[ChangeLog] Failed to fetch changelog dates index:', err);
  }
  return [];
}

/**
 * Maintain a bounded 30-day index of dates that have changelog entries.
 * Evicts any dates beyond 30 days from rtdb_nodes.
 */
async function updateChangeLogIndex(dateStr: string): Promise<void> {
  const normDate = normalizeToISODate(dateStr) || dateStr;
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', 'history/changelog_index')
      .maybeSingle();

    let dates: string[] = (node && Array.isArray(node.data)) ? (node.data as string[]) : [];
    dates = Array.from(
      new Set([normDate, ...dates.map(d => normalizeToISODate(d) || d).filter(Boolean)])
    ).sort((a, b) => b.localeCompare(a));

    const refDate = dates[0] || normDate;
    const cutoffDate = getRetentionCutoffDate(refDate, MAX_HISTORY_RETENTION_DAYS);
    const keptDates = dates.filter((d, idx) => idx < MAX_HISTORY_RETENTION_DAYS && d >= cutoffDate);
    const evictedDates = dates.filter((d, idx) => idx >= MAX_HISTORY_RETENTION_DAYS || d < cutoffDate);

    await historySupabase.from('rtdb_nodes').upsert({
      path: 'history/changelog_index',
      data: keptDates,
      updated_at: new Date().toISOString(),
    });

    for (const oldDate of evictedDates) {
      await historySupabase
        .from('rtdb_nodes')
        .delete()
        .like('path', `history/changelog/${oldDate}%`);
    }
  } catch (err) {
    console.error('[ChangeLog] Failed to update changelog index:', err);
  }
}

/**
 * Returns current date and time formatted in Egypt / Cairo timezone (Africa/Cairo)
 */
export function getCairoDateTime(): { dateStr: string; timeStr: string; hours: number; minutes: number; fullStr: string } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '00';
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = parseInt(getPart('hour'), 10);
  const minute = parseInt(getPart('minute'), 10);
  const second = parseInt(getPart('second'), 10);
  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  return {
    dateStr,
    timeStr,
    hours: hour,
    minutes: minute,
    fullStr: `${dateStr} ${timeStr}`
  };
}

/**
 * Returns a date string formatted as YYYY-MM-DD in Egypt / Cairo timezone for a given epoch timestamp
 */
export function getCairoDateFromTimestamp(ts: number): string {
  try {
    const d = new Date(ts);
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(d);
  } catch (e) {
    return getCairoDateTime().dateStr;
  }
}

/**
 * Normalizes any date string (e.g. "16/9/2026", "2026/09/16", "2026-09-16") to canonical YYYY-MM-DD
 */
export function normalizeToISODate(rawDate: any): string | null {
  if (!rawDate) return null;
  const s = String(rawDate).trim();
  if (!s) return null;

  // 1. Check if already YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (isoMatch) {
    const yr = isoMatch[1];
    const mo = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
    const dy = String(parseInt(isoMatch[3], 10)).padStart(2, '0');
    return `${yr}-${mo}-${dy}`;
  }

  // 2. Check DD/MM/YYYY or DD-MM-YYYY (primary format: day first, month second)
  const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const n1 = parseInt(dmyMatch[1], 10);
    const n2 = parseInt(dmyMatch[2], 10);
    const yr = dmyMatch[3];

    let day = n1;
    let month = n2;

    if (n2 > 12 && n1 <= 12) {
      // e.g. 10/25/2026 -> month=10, day=25
      day = n2;
      month = n1;
    } else if (n1 > 12 && n2 <= 12) {
      // e.g. 25/10/2026 -> day=25, month=10
      day = n1;
      month = n2;
    } else {
      // Both n1 and n2 <= 12: Disambiguate using Cairo context
      const cairo = getCairoDateTime();
      const [cairoYr, cairoMo, cairoDy] = cairo.dateStr.split('-').map(x => parseInt(x, 10));
      if (parseInt(yr, 10) === cairoYr && n1 === cairoMo && n2 === cairoDy) {
        // e.g. 10/06/2026 on Oct 6th: n1 is month 10, n2 is day 6
        month = cairoMo;
        day = cairoDy;
      } else if (parseInt(yr, 10) === cairoYr && n1 === cairoDy && n2 === cairoMo) {
        // e.g. 06/10/2026 on Oct 6th: n1 is day 6, n2 is month 10
        month = cairoMo;
        day = cairoDy;
      } else {
        // Standard DD-MM-YYYY
        day = n1;
        month = n2;
      }
    }

    return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // 3. Fallback to Date parsing
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const yr = d.getFullYear();
      if (yr >= 2020 && yr <= 2040) {
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const dy = String(d.getDate()).padStart(2, '0');
        return `${yr}-${mo}-${dy}`;
      }
    }
  } catch (e) {}

  return null;
}

/**
 * Formats any date string (ISO YYYY-MM-DD or other) to standard DD-MM-YYYY
 */
export function formatDateToDDMMYYYY(dateStr: any): string {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  if (!s) return '';
  const iso = normalizeToISODate(s);
  if (iso) {
    const [yr, mo, dy] = iso.split('-');
    return `${dy}-${mo}-${yr}`;
  }
  return s;
}

const fsPromises = fs.promises;

function partitionDischargedPatients(
  rawDischarged: any[],
  manualNames: string[] = []
): { autoList: any[]; manualList: any[] } {
  const manualNamesNormalized = manualNames
    .map(m => String(m || '').toLowerCase().trim())
    .filter(Boolean);

  const autoList: any[] = [];
  const manualList: any[] = [];

  for (const p of rawDischarged) {
    if (!p) continue;
    const pName = String(p.name || '').toLowerCase().trim();
    const isManual =
      p.dischargeType === 'manual' ||
      (pName.length > 0 &&
        manualNamesNormalized.some(m => m === pName || m.includes(pName) || pName.includes(m)));

    if (isManual) {
      manualList.push(p);
    } else {
      autoList.push(p);
    }
  }

  return { autoList, manualList };
}

/**
 * Save an Occupancy snapshot to both disk and Supabase cloud database
 */
export async function saveOccupancySnapshot(
  data: Omit<OccupancySnapshot, 'date' | 'timestamp' | 'cairoTime'> & { date?: string }
): Promise<OccupancySnapshot> {
  const cairo = getCairoDateTime();
  const dateStr = data.date || cairo.dateStr;

  const rawDischarged = data.cumulativeDischarged || [];
  const manualNames = data.manuallyDischargedNames || [];

  let autoList: any[];
  let manualList: any[];

  if (Array.isArray(data.automaticallyDischarged) && Array.isArray(data.manuallyDischarged)) {
    autoList = data.automaticallyDischarged;
    manualList = data.manuallyDischarged;
  } else {
    const partitioned = partitionDischargedPatients(rawDischarged, manualNames);
    autoList = partitioned.autoList;
    manualList = partitioned.manualList;
  }

  const summary: OccupancySnapshotSummary = {
    ...data.summary,
    dischargesCount: rawDischarged.length,
    autoDischargesCount: autoList.length,
    manualDischargesCount: manualList.length
  };

  const snapshot: OccupancySnapshot = {
    date: dateStr,
    timestamp: Date.now(),
    cairoTime: cairo.fullStr,
    hospitalData: data.hospitalData ? normalizeRowsArray(data.hospitalData) : null,
    previousHospitalData: data.previousHospitalData ? normalizeRowsArray(data.previousHospitalData) : null,
    cumulativeEntries: data.cumulativeEntries || [],
    cumulativeDialysis: data.cumulativeDialysis || [],
    cumulativeDebts: data.cumulativeDebts || [],
    cumulativeInsuredDebts: data.cumulativeInsuredDebts || [],
    cumulativeMedicalPlans: data.cumulativeMedicalPlans || [],
    cumulativeCompanionStatus: data.cumulativeCompanionStatus || [],
    cumulativeLOS: data.cumulativeLOS || [],
    cumulativeDischarged: rawDischarged,
    automaticallyDischarged: autoList,
    manuallyDischarged: manualList,
    manuallyDischargedNames: manualNames,
    cumulativeTransfers: data.cumulativeTransfers || [],
    vipCasesText: data.vipCasesText || "",
    earlyDischargeRoomsText: data.earlyDischargeRoomsText || "",
    summary
  };

  // 1. Write to local disk cache asynchronously (compact JSON to save disk space and I/O time)
  try {
    const filePath = path.join(HISTORY_OCC_DIR, `${dateStr}.json`);
    await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
    console.log(`[OccupancyHistory] Snapshot saved to local disk asynchronously: ${filePath} (Auto: ${autoList.length}, Manual: ${manualList.length})`);
  } catch (err) {
    console.error('[OccupancyHistory] Failed to write local snapshot:', err);
  }

  // 2. Write to Supabase rtdb_nodes table as granular structured nodes (not all in one row)
  try {
    const nowIso = new Date().toISOString();
    const granularHistoryUpserts = [
      { path: `history/occupancy/${dateStr}/summary`, data: snapshot.summary, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/hospital_data`, data: snapshot.hospitalData, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/discharged`, data: snapshot.cumulativeDischarged, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/transfers`, data: snapshot.cumulativeTransfers, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/entries`, data: snapshot.cumulativeEntries, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/dialysis`, data: snapshot.cumulativeDialysis, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/debts`, data: snapshot.cumulativeDebts, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/insured_debts`, data: snapshot.cumulativeInsuredDebts, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/medical_plans`, data: snapshot.cumulativeMedicalPlans, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/companion_status`, data: snapshot.cumulativeCompanionStatus, updated_at: nowIso },
      { path: `history/occupancy/${dateStr}/los`, data: snapshot.cumulativeLOS, updated_at: nowIso },
      {
        path: `history/occupancy/${dateStr}/settings`,
        data: {
          vipCasesText: snapshot.vipCasesText,
          earlyDischargeRoomsText: snapshot.earlyDischargeRoomsText,
          manuallyDischargedNames: snapshot.manuallyDischargedNames,
          timestamp: snapshot.timestamp,
          cairoTime: snapshot.cairoTime
        },
        updated_at: nowIso
      }
    ];

    let sbErr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await historySupabase.from('rtdb_nodes').upsert(granularHistoryUpserts);
      if (!error) {
        sbErr = null;
        break;
      }
      sbErr = error;
      const errMsg = String(error.message || error.details || error);
      const isNetworkErr = errMsg.includes('ECONNRESET') || errMsg.includes('fetch failed') || errMsg.includes('ETIMEDOUT');
      if (isNetworkErr && attempt < 3) {
        await new Promise(res => setTimeout(res, attempt * 300));
      } else {
        break;
      }
    }

    if (sbErr) {
      console.error('[OccupancyHistory] Supabase granular history upsert error:', sbErr);
    } else {
      console.log(`[OccupancyHistory] Granular history snapshots saved to Supabase (history/occupancy/${dateStr}/* across 12 distinct rows)`);
    }
  } catch (err) {
    console.error('[OccupancyHistory] Supabase error:', err);
  }

  // 3. Update Occupancy Index
  await updateHistoryIndex('occupancy', {
    date: dateStr,
    timestamp: snapshot.timestamp,
    cairoTime: snapshot.cairoTime,
    summary: snapshot.summary
  });

  return snapshot;
}

/**
 * Retrieve Occupancy Snapshot for a specific date
 */
export async function getOccupancySnapshot(dateStr: string): Promise<OccupancySnapshot | null> {
  const cleanDate = dateStr.trim();
  let snapshot: OccupancySnapshot | null = null;

  // 1. Try local disk
  const filePath = path.join(HISTORY_OCC_DIR, `${cleanDate}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      snapshot = JSON.parse(raw) as OccupancySnapshot;
      if (snapshot) {
        if (snapshot.hospitalData) snapshot.hospitalData = normalizeRowsArray(snapshot.hospitalData);
        if (snapshot.previousHospitalData) snapshot.previousHospitalData = normalizeRowsArray(snapshot.previousHospitalData);
      }
    } catch (err) {
      console.error(`[OccupancyHistory] Failed to parse local snapshot for ${cleanDate}:`, err);
    }
  }

  // 2. Try Supabase cloud database if not found on disk or if needing live cloud state
  if (!snapshot) {
    try {
      // Query granular nodes under history/occupancy/${cleanDate}/%
      const { data: nodes, error: sbErr } = await historySupabase
        .from('rtdb_nodes')
        .select('path, data')
        .like('path', `history/occupancy/${cleanDate}/%`);

      if (!sbErr && nodes && nodes.length > 0) {
        const nodeMap: Record<string, any> = {};
        for (const n of nodes) {
          const subPath = n.path.replace(`history/occupancy/${cleanDate}/`, '');
          nodeMap[subPath] = n.data;
        }

        const settings = nodeMap['settings'] || {};
        const summary = nodeMap['summary'] || {};

        snapshot = {
          date: cleanDate,
          timestamp: settings.timestamp || Date.now(),
          cairoTime: settings.cairoTime || `${cleanDate} 00:00:00`,
          hospitalData: nodeMap['hospital_data'] ? normalizeRowsArray(nodeMap['hospital_data']) : null,
          previousHospitalData: nodeMap['previous_hospital_data'] ? normalizeRowsArray(nodeMap['previous_hospital_data']) : null,
          cumulativeEntries: Array.isArray(nodeMap['entries']) ? nodeMap['entries'] : [],
          cumulativeDialysis: Array.isArray(nodeMap['dialysis']) ? nodeMap['dialysis'] : [],
          cumulativeDebts: Array.isArray(nodeMap['debts']) ? nodeMap['debts'] : [],
          cumulativeInsuredDebts: Array.isArray(nodeMap['insured_debts']) ? nodeMap['insured_debts'] : [],
          cumulativeMedicalPlans: Array.isArray(nodeMap['medical_plans']) ? nodeMap['medical_plans'] : [],
          cumulativeCompanionStatus: Array.isArray(nodeMap['companion_status']) ? nodeMap['companion_status'] : [],
          cumulativeLOS: Array.isArray(nodeMap['los']) ? nodeMap['los'] : [],
          cumulativeDischarged: Array.isArray(nodeMap['discharged']) ? nodeMap['discharged'] : [],
          automaticallyDischarged: undefined,
          manuallyDischarged: undefined,
          manuallyDischargedNames: Array.isArray(settings.manuallyDischargedNames) ? settings.manuallyDischargedNames : [],
          cumulativeTransfers: Array.isArray(nodeMap['transfers']) ? nodeMap['transfers'] : [],
          vipCasesText: typeof settings.vipCasesText === 'string' ? settings.vipCasesText : '',
          earlyDischargeRoomsText: typeof settings.earlyDischargeRoomsText === 'string' ? settings.earlyDischargeRoomsText : '',
          summary: summary as OccupancySnapshotSummary
        };

        // Cache locally
        try {
          await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
        } catch (e) {}
      } else {
        // Fallback check for legacy monolithic node
        const { data: legacyNode } = await historySupabase
          .from('rtdb_nodes')
          .select('data')
          .eq('path', `history/occupancy/${cleanDate}`)
          .maybeSingle();

        if (legacyNode && legacyNode.data) {
          snapshot = legacyNode.data as OccupancySnapshot;
          if (snapshot) {
            if (snapshot.hospitalData) snapshot.hospitalData = normalizeRowsArray(snapshot.hospitalData);
            if (snapshot.previousHospitalData) snapshot.previousHospitalData = normalizeRowsArray(snapshot.previousHospitalData);
          }
          try {
            await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error(`[OccupancyHistory] Failed to fetch snapshot from Supabase for ${cleanDate}:`, err);
    }
  }

  if (snapshot) {
    if (snapshot.hospitalData) {
      snapshot.hospitalData = normalizeRowsArray(snapshot.hospitalData);
    }
    if (snapshot.previousHospitalData) {
      snapshot.previousHospitalData = normalizeRowsArray(snapshot.previousHospitalData);
    }
    // Ensure automatic and manual discharged breakdown lists exist
    const rawDischarged = snapshot.cumulativeDischarged || [];
    const manualNames = snapshot.manuallyDischargedNames || [];

    if (!snapshot.automaticallyDischarged || !snapshot.manuallyDischarged) {
      const partitioned = partitionDischargedPatients(rawDischarged, manualNames);
      snapshot.automaticallyDischarged = partitioned.autoList;
      snapshot.manuallyDischarged = partitioned.manualList;
    }

    if (snapshot.summary) {
      snapshot.summary.dischargesCount = rawDischarged.length;
      snapshot.summary.autoDischargesCount = snapshot.automaticallyDischarged.length;
      snapshot.summary.manualDischargesCount = snapshot.manuallyDischarged.length;
    }
  }

  return snapshot;
}

/**
 * Delete an Occupancy snapshot from disk, Supabase cloud database, and date index
 */
export async function deleteOccupancySnapshot(dateStr: string): Promise<boolean> {
  const norm = normalizeToISODate(dateStr);
  const cleanDate = norm || dateStr.trim();
  console.log(`[OccupancyHistory] Deleting occupancy snapshot for date: ${cleanDate}`);

  // 1. Delete from local disk
  try {
    const filePath = path.join(HISTORY_OCC_DIR, `${cleanDate}.json`);
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
      console.log(`[OccupancyHistory] Deleted local snapshot file asynchronously: ${filePath}`);
    }
  } catch (err) {
    console.error(`[OccupancyHistory] Error deleting local snapshot file for ${cleanDate}:`, err);
  }

  // 2. Delete granular history nodes and legacy node from Supabase
  try {
    const { error: sbErr } = await historySupabase
      .from('rtdb_nodes')
      .delete()
      .like('path', `history/occupancy/${cleanDate}%`);

    if (dateStr.includes('/')) {
      await historySupabase
        .from('rtdb_nodes')
        .delete()
        .like('path', `history/occupancy/${dateStr}%`);
    }

    if (sbErr) {
      console.error(`[OccupancyHistory] Error deleting history nodes from Supabase for ${cleanDate}:`, sbErr);
    } else {
      console.log(`[OccupancyHistory] Successfully deleted history/occupancy/${cleanDate} nodes from Supabase.`);
    }
  } catch (err) {
    console.error(`[OccupancyHistory] Exception deleting snapshot from Supabase:`, err);
  }

  // 3. Remove date from cloud occupancy index (Supabase rtdb_nodes) & local disk
  try {
    const indexPath = path.join(WRITABLE_BASE, 'history', `occupancy_index.json`);
    let entries: DateIndexEntry[] = [];
    if (fs.existsSync(indexPath)) {
      try {
        const raw = await fsPromises.readFile(indexPath, 'utf-8');
        entries = JSON.parse(raw) || [];
      } catch (e) {}
    } else if (fs.existsSync(path.join(process.cwd(), 'history', `occupancy_index.json`))) {
      try {
        const raw = await fsPromises.readFile(path.join(process.cwd(), 'history', `occupancy_index.json`), 'utf-8');
        entries = JSON.parse(raw) || [];
      } catch (e) {}
    }
    entries = entries.filter(e => (normalizeToISODate(e.date) || e.date) !== cleanDate && e.date !== dateStr);
    try {
      await fsPromises.writeFile(indexPath, JSON.stringify(entries));
    } catch (e) {}

    // Query live Supabase index directly and prune
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', `history/occupancy_index`)
      .maybeSingle();

    let cloudEntries: DateIndexEntry[] = (node && Array.isArray(node.data)) ? node.data : [];
    cloudEntries = cloudEntries.filter(e => (normalizeToISODate(e.date) || e.date) !== cleanDate && e.date !== dateStr);

    await historySupabase.from('rtdb_nodes').upsert({
      path: `history/occupancy_index`,
      data: cloudEntries,
      updated_at: new Date().toISOString()
    });
    console.log(`[OccupancyHistory] Successfully pruned ${cleanDate} from Supabase history/occupancy_index.`);
  } catch (e) {
    console.error(`[OccupancyHistory] Error updating occupancy_index on delete:`, e);
  }

  return true;
}

/**
 * Delete an OR snapshot from disk, Supabase cloud database, and date index
 */
export async function deleteORSnapshot(dateStr: string): Promise<boolean> {
  const norm = normalizeToISODate(dateStr);
  const cleanDate = norm || dateStr.trim();
  console.log(`[ORHistory] Deleting OR snapshot for date: ${cleanDate}`);

  // 1. Delete from local disk
  try {
    const filePath = path.join(HISTORY_OR_DIR, `${cleanDate}.json`);
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
      console.log(`[ORHistory] Deleted local snapshot file: ${filePath}`);
    }
  } catch (err) {
    console.error(`[ORHistory] Error deleting local snapshot file for ${cleanDate}:`, err);
  }

  // 2. Delete granular history nodes and legacy node from Supabase
  try {
    await historySupabase
      .from('rtdb_nodes')
      .delete()
      .like('path', `history/or/${cleanDate}%`);

    if (dateStr.includes('/')) {
      await historySupabase
        .from('rtdb_nodes')
        .delete()
        .like('path', `history/or/${dateStr}%`);
    }
    console.log(`[ORHistory] Successfully deleted history/or/${cleanDate} nodes from Supabase.`);
  } catch (err) {
    console.error(`[ORHistory] Exception deleting snapshot from Supabase:`, err);
  }

  // 3. Remove date from OR index (both disk and cloud)
  try {
    const indexPath = path.join(WRITABLE_BASE, 'history', `or_index.json`);
    let entries: DateIndexEntry[] = [];
    if (fs.existsSync(indexPath)) {
      try {
        const raw = await fsPromises.readFile(indexPath, 'utf-8');
        entries = JSON.parse(raw) || [];
      } catch (e) {}
    } else if (fs.existsSync(path.join(process.cwd(), 'history', `or_index.json`))) {
      try {
        const raw = await fsPromises.readFile(path.join(process.cwd(), 'history', `or_index.json`), 'utf-8');
        entries = JSON.parse(raw) || [];
      } catch (e) {}
    }

    entries = entries.filter(e => (normalizeToISODate(e.date) || e.date) !== cleanDate && e.date !== dateStr);
    try {
      await fsPromises.writeFile(indexPath, JSON.stringify(entries));
    } catch (e) {}

    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', `history/or_index`)
      .maybeSingle();

    let cloudEntries: DateIndexEntry[] = (node && Array.isArray(node.data)) ? node.data : [];
    cloudEntries = cloudEntries.filter(e => (normalizeToISODate(e.date) || e.date) !== cleanDate && e.date !== dateStr);

    await historySupabase.from('rtdb_nodes').upsert({
      path: `history/or_index`,
      data: cloudEntries,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error(`[ORHistory] Error updating or_index on delete:`, e);
  }

  return true;
}

/**
 * Save an OR snapshot to both disk and Supabase cloud database across granular nodes
 */
export async function saveORSnapshot(
  data: Omit<ORSnapshot, 'date' | 'timestamp' | 'cairoTime'> & { date?: string }
): Promise<ORSnapshot> {
  const cairo = getCairoDateTime();
  const rawDate = data.date || cairo.dateStr;
  const dateStr = normalizeToISODate(rawDate) || rawDate;

  const snapshot: ORSnapshot = {
    date: dateStr,
    timestamp: Date.now(),
    cairoTime: cairo.fullStr,
    orList: data.orList || [],
    summary: data.summary
  };

  // 1. Local disk
  try {
    const filePath = path.join(HISTORY_OR_DIR, `${dateStr}.json`);
    await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
    console.log(`[ORHistory] Snapshot saved to local disk asynchronously: ${filePath}`);
  } catch (err) {
    console.error('[ORHistory] Failed to write local snapshot:', err);
  }

  // 2. Supabase granular nodes (not all in one row)
  try {
    const nowIso = new Date().toISOString();
    const granularORUpserts = [
      {
        path: `history/or/${dateStr}/summary`,
        data: {
          ...snapshot.summary,
          timestamp: snapshot.timestamp,
          cairoTime: snapshot.cairoTime
        },
        updated_at: nowIso
      },
      {
        path: `history/or/${dateStr}/cases`,
        data: snapshot.orList,
        updated_at: nowIso
      }
    ];

    let sbErr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await historySupabase.from('rtdb_nodes').upsert(granularORUpserts);
      if (!error) {
        sbErr = null;
        break;
      }
      sbErr = error;
      const errMsg = String(error.message || error.details || error);
      const isNetworkErr = errMsg.includes('ECONNRESET') || errMsg.includes('fetch failed') || errMsg.includes('ETIMEDOUT');
      if (isNetworkErr && attempt < 3) {
        await new Promise(res => setTimeout(res, attempt * 300));
      } else {
        break;
      }
    }

    if (sbErr) {
      console.error('[ORHistory] Supabase granular OR upsert error:', sbErr);
    } else {
      console.log(`[ORHistory] Granular OR snapshots saved to Supabase (history/or/${dateStr}/summary & cases across 2 distinct rows)`);
    }
  } catch (err) {
    console.error('[ORHistory] Supabase error:', err);
  }

  // 3. Update OR Index
  await updateHistoryIndex('or', {
    date: dateStr,
    timestamp: snapshot.timestamp,
    cairoTime: snapshot.cairoTime,
    summary: snapshot.summary
  });

  return snapshot;
}

/**
 * Retrieve OR Snapshot for a specific date
 */
export async function getORSnapshot(dateStr: string): Promise<ORSnapshot | null> {
  const norm = normalizeToISODate(dateStr);
  const cleanDate = norm || dateStr.trim();
  const filePath = path.join(HISTORY_OR_DIR, `${cleanDate}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as ORSnapshot;
    } catch (err) {
      console.error(`[ORHistory] Failed to parse local snapshot for ${cleanDate}:`, err);
    }
  }

  try {
    // 1. Try granular nodes first: history/or/${cleanDate}/%
    const { data: nodes, error: sbErr } = await historySupabase
      .from('rtdb_nodes')
      .select('path, data')
      .like('path', `history/or/${cleanDate}/%`);

    if (!sbErr && nodes && nodes.length > 0) {
      const nodeMap: Record<string, any> = {};
      for (const n of nodes) {
        const subPath = n.path.replace(`history/or/${cleanDate}/`, '');
        nodeMap[subPath] = n.data;
      }
      const summaryData = nodeMap['summary'] || {};
      const casesData = Array.isArray(nodeMap['cases']) ? nodeMap['cases'] : [];

      const snapshot: ORSnapshot = {
        date: cleanDate,
        timestamp: summaryData.timestamp || Date.now(),
        cairoTime: summaryData.cairoTime || `${cleanDate} 00:00:00`,
        orList: casesData,
        summary: {
          totalCases: summaryData.totalCases || casesData.length,
          matched: summaryData.matched || 0,
          outpatients: summaryData.outpatients || 0
        }
      };

      try {
        await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
      } catch (e) {}

      return snapshot;
    }

    // 2. Fallback check for legacy monolithic node
    const { data: legacyNode } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', `history/or/${cleanDate}`)
      .maybeSingle();

    if (legacyNode && legacyNode.data) {
      const parsedData = legacyNode.data;
      const casesData = Array.isArray(parsedData.orList)
        ? parsedData.orList
        : (Array.isArray(parsedData.items) ? parsedData.items : (Array.isArray(parsedData) ? parsedData : []));

      const snapshot: ORSnapshot = {
        date: cleanDate,
        timestamp: parsedData.timestamp || Date.now(),
        cairoTime: parsedData.cairoTime || `${cleanDate} 00:00:00`,
        orList: casesData,
        summary: parsedData.summary || {
          totalCases: casesData.length,
          matched: 0,
          outpatients: 0
        }
      };

      try {
        await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
      } catch (e) {}
      return snapshot;
    }

    // 3. Fallback check for potential slash format in Supabase (e.g. 20/9/2026 or 20/09/2026)
    if (cleanDate.includes('-')) {
      const [yr, mo, dy] = cleanDate.split('-');
      const dSlash1 = `${parseInt(dy, 10)}/${parseInt(mo, 10)}/${yr}`;
      const dSlash2 = `${dy}/${mo}/${yr}`;
      for (const slashVariant of [dSlash1, dSlash2]) {
        const { data: slashNodes } = await historySupabase
          .from('rtdb_nodes')
          .select('path, data')
          .like('path', `history/or/${slashVariant}/%`);

        if (slashNodes && slashNodes.length > 0) {
          const nodeMap: Record<string, any> = {};
          for (const n of slashNodes) {
            const subPath = n.path.replace(`history/or/${slashVariant}/`, '');
            nodeMap[subPath] = n.data;
          }
          const summaryData = nodeMap['summary'] || {};
          const casesData = Array.isArray(nodeMap['cases']) ? nodeMap['cases'] : [];

          const snapshot: ORSnapshot = {
            date: cleanDate,
            timestamp: summaryData.timestamp || Date.now(),
            cairoTime: summaryData.cairoTime || `${cleanDate} 00:00:00`,
            orList: casesData,
            summary: {
              totalCases: summaryData.totalCases || casesData.length,
              matched: summaryData.matched || 0,
              outpatients: summaryData.outpatients || 0
            }
          };

          // Re-save normalized under cleanDate for future queries
          saveORSnapshot(snapshot).catch(() => {});
          return snapshot;
        }
      }
    }
    // 4. Inversion fallback: if cleanDate is e.g. 2026-10-06, also check if it was inadvertently saved under inverted month/day (2026-06-10)
    if (cleanDate.includes('-')) {
      const [yr, mo, dy] = cleanDate.split('-');
      const invertedIso = `${yr}-${dy}-${mo}`;
      if (invertedIso !== cleanDate) {
        // Query directly to avoid infinite recursion
        const { data: invertedNode } = await historySupabase
          .from('rtdb_nodes')
          .select('data')
          .like('path', `history/or/${invertedIso}/%`);

        if (invertedNode && invertedNode.length > 0) {
          const invSnap = await getORSnapshot(invertedIso);
          if (invSnap && Math.abs(Date.now() - invSnap.timestamp) < 7 * 86400 * 1000) {
            const corrected: ORSnapshot = {
              ...invSnap,
              date: cleanDate,
              cairoTime: invSnap.cairoTime.replace(invertedIso, cleanDate)
            };
            saveORSnapshot(corrected).catch(() => {});
            return corrected;
          }
        }
      }
    }
  } catch (err) {
    console.error(`[ORHistory] Failed to fetch OR snapshot from Supabase for ${cleanDate}:`, err);
  }

  return null;
}

/**
 * Prunes relational tables (`or_cases`, `transfers`, non-active `admissions`, and orphaned `patients`)
 * for dates older than `cutoffDateStr` or explicitly in `evictedDates`.
 * Strictly preserves:
 *   - `occupancy_daily_census` & `occupancy_monthly_summary`
 *   - `or_daily_census` & `or_monthly_summary`
 *   - `rtdb_nodes` `settings/vip_cases`
 *   - Active inpatients (`admissions.status = 'Admitted'`)
 */
export async function pruneRelationalTablesForCutoff(
  cutoffDateStr: string,
  evictedDates: string[] = [],
  referenceDateStr?: string,
  maxDays: number = MAX_HISTORY_RETENTION_DAYS
): Promise<void> {
  const cleanCutoff = normalizeToISODate(cutoffDateStr) || cutoffDateStr;
  const cleanRef =
    (referenceDateStr && normalizeToISODate(referenceDateStr)) ||
    getCairoDateTime().dateStr;
  const cutoffIso = `${cleanCutoff}T00:00:00Z`;

  // 1. Attempt PostgreSQL stored procedure enforce_30_day_retention if deployed
  try {
    await historySupabase.rpc('enforce_30_day_retention', {
      p_max_days: maxDays,
      p_reference_date: cleanRef,
    });
  } catch (_) {
    // Non-fatal if RPC is not yet deployed in SQL editor; direct fallback below handles cleanup
  }

  // 2. Direct fallback pruning on relational tables
  try {
    await historySupabase
      .from('or_cases')
      .delete()
      .lt('scheduled_date', cleanCutoff);

    if (evictedDates.length > 0) {
      await historySupabase
        .from('or_cases')
        .delete()
        .in('scheduled_date', evictedDates);
    }
  } catch (orErr) {
    console.warn('[Retention] Notice pruning expired or_cases:', orErr);
  }

  try {
    await historySupabase
      .from('transfers')
      .delete()
      .lt('transfer_date', cutoffIso);
  } catch (trErr) {
    console.warn('[Retention] Notice pruning expired transfers:', trErr);
  }

  try {
    // Only delete historical non-active admissions (Discharged / Transferred) older than cutoff.
    // Active inpatients (status = 'Admitted') are NEVER deleted.
    await historySupabase
      .from('admissions')
      .delete()
      .neq('status', 'Admitted')
      .lt('updated_at', cutoffIso);
  } catch (admErr) {
    console.warn('[Retention] Notice pruning expired discharged admissions:', admErr);
  }

  try {
    // Prune orphaned patient rows older than cutoff that have no remaining admission records
    const [{ data: oldPts }, { data: activeAdms }] = await Promise.all([
      historySupabase.from('patients').select('id').lt('updated_at', cutoffIso).limit(1000),
      historySupabase.from('admissions').select('patient_id').limit(5000),
    ]);
    if (Array.isArray(oldPts) && oldPts.length > 0) {
      const referencedIds = new Set(
        (activeAdms || []).map((a: any) => a?.patient_id).filter(Boolean)
      );
      const orphanIds = oldPts
        .map((p: any) => p?.id)
        .filter((id: any) => id && !referencedIds.has(id));
      if (orphanIds.length > 0) {
        await historySupabase.from('patients').delete().in('id', orphanIds);
      }
    }
  } catch (ptErr) {
    console.warn('[Retention] Notice pruning orphaned patients:', ptErr);
  }
}

/**
 * Evicts a single date across occupancy, OR, changelog, disk, external RTDB,
 * after running the pre-eviction cumulative analytics safeguard.
 */
async function evictSingleDateEverywhere(dateStr: string): Promise<void> {
  const cleanDate = normalizeToISODate(dateStr) || dateStr.trim();
  if (!cleanDate) return;

  // 1. Pre-eviction safeguard: ensure cumulative daily bed & OR census are recorded first
  try {
    if (retentionHooks.onBeforeDeleteDate) {
      await retentionHooks.onBeforeDeleteDate(cleanDate);
    }
  } catch (hookErr) {
    console.warn(`[Retention] Pre-delete safeguard notice for ${cleanDate}:`, hookErr);
  }

  // 2. Remove from local disk & Supabase rtdb_nodes
  await deleteOccupancySnapshot(cleanDate);
  await deleteORSnapshot(cleanDate);
  await deleteChangeLogForDate(cleanDate);

  // 3. Remove from external Firebase RTDB / Firestore if configured
  try {
    if (retentionHooks.externalRtdbPrune) {
      await retentionHooks.externalRtdbPrune(cleanDate);
    }
  } catch (extErr) {
    console.warn(`[Retention] External RTDB prune notice for ${cleanDate}:`, extErr);
  }
}

/**
 * Update the index of available dates and enforce the 30-day rolling retention cap.
 * When a 31st day is saved (or any date falls older than 30 days), the oldest day
 * is automatically removed from disk, Supabase rtdb_nodes, external RTDB, and relational tables,
 * after ensuring its cumulative analytics census is recorded.
 */
async function updateHistoryIndex(type: 'occupancy' | 'or', entry: DateIndexEntry) {
  const normDate = normalizeToISODate(entry.date) || entry.date;
  entry.date = normDate;

  const indexPath = path.join(WRITABLE_BASE, 'history', `${type}_index.json`);
  let entries: DateIndexEntry[] = [];

  // Read disk index
  if (fs.existsSync(indexPath)) {
    try {
      const raw = await fsPromises.readFile(indexPath, 'utf-8');
      entries = JSON.parse(raw) || [];
    } catch (e) {}
  } else if (fs.existsSync(path.join(process.cwd(), 'history', `${type}_index.json`))) {
    try {
      const raw = await fsPromises.readFile(path.join(process.cwd(), 'history', `${type}_index.json`), 'utf-8');
      entries = JSON.parse(raw) || [];
    } catch (e) {}
  }

  // Merge with existing Supabase index
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', `history/${type}_index`)
      .maybeSingle();

    if (node && Array.isArray(node.data)) {
      const cloudEntries = node.data as DateIndexEntry[];
      for (const ce of cloudEntries) {
        const cDate = normalizeToISODate(ce.date) || ce.date;
        if (!entries.some(e => (normalizeToISODate(e.date) || e.date) === cDate)) {
          entries.push({ ...ce, date: cDate });
        }
      }
    }
  } catch (e) {}

  // Deduplicate and insert latest
  entries = entries.filter(e => (normalizeToISODate(e.date) || e.date) !== normDate);
  entries.unshift(entry);
  entries.sort((a, b) => (normalizeToISODate(b.date) || b.date).localeCompare(normalizeToISODate(a.date) || a.date));

  // Enforce 30-day rolling retention cap (both max 30 dates and 30-day calendar window)
  const newestDate = normalizeToISODate(entries[0]?.date) || normDate;
  const cutoffDate = getRetentionCutoffDate(newestDate, MAX_HISTORY_RETENTION_DAYS);

  const keptEntries: DateIndexEntry[] = [];
  const evictedDates: string[] = [];

  entries.forEach((item, idx) => {
    const itemDate = normalizeToISODate(item.date) || item.date;
    if (idx < MAX_HISTORY_RETENTION_DAYS && itemDate >= cutoffDate) {
      keptEntries.push({ ...item, date: itemDate });
    } else {
      evictedDates.push(itemDate);
    }
  });

  // Save trimmed 30-day index to disk asynchronously
  try {
    await fsPromises.writeFile(indexPath, JSON.stringify(keptEntries));
  } catch (e) {}

  // Save trimmed 30-day index to Supabase
  try {
    await historySupabase.from('rtdb_nodes').upsert({
      path: `history/${type}_index`,
      data: keptEntries,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error(`[History] Failed to sync ${type}_index to Supabase:`, e);
  }

  // Evict overflow / expired dates (> 30 days) from disk, rtdb_nodes, external RTDB, and relational tables
  if (evictedDates.length > 0) {
    console.log(`[Retention] Evicting ${evictedDates.length} expired ${type} date(s) beyond ${MAX_HISTORY_RETENTION_DAYS}-day limit: ${evictedDates.join(', ')}`);
    for (const oldDate of evictedDates) {
      await evictSingleDateEverywhere(oldDate);
    }
    await pruneRelationalTablesForCutoff(cutoffDate, evictedDates, newestDate, MAX_HISTORY_RETENTION_DAYS);
  }
}

/**
 * Scans all occupancy, OR, and changelog history across local disk and Supabase rtdb_nodes,
 * evicting any dates beyond `maxDays` (default 30) or older than the 30-day cutoff date,
 * while safeguarding cumulative Month-to-Date analytics and permanent VIP cases.
 */
export async function pruneExpiredHistory(options?: {
  referenceDate?: string;
  maxDays?: number;
}): Promise<{
  evictedDates: string[];
  prunedOccupancyDates: string[];
  prunedOrDates: string[];
  prunedChangelogDates: string[];
  cutoffDate: string;
}> {
  const maxDays = Math.max(1, options?.maxDays ?? MAX_HISTORY_RETENTION_DAYS);
  const prunedOccupancyDates: string[] = [];
  const prunedOrDates: string[] = [];
  const prunedChangelogDates: string[] = [];

  // Helper to collect all known dates for a given type ('occupancy' | 'or')
  const collectAllDatesForType = async (type: 'occupancy' | 'or'): Promise<DateIndexEntry[]> => {
    const dir = type === 'occupancy' ? HISTORY_OCC_DIR : HISTORY_OR_DIR;
    const indexPath = path.join(WRITABLE_BASE, 'history', `${type}_index.json`);
    const collected: DateIndexEntry[] = [];

    if (fs.existsSync(indexPath)) {
      try {
        const raw = await fsPromises.readFile(indexPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) collected.push(...parsed);
      } catch (_) {}
    }

    try {
      if (fs.existsSync(dir)) {
        const files = await fsPromises.readdir(dir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const d = normalizeToISODate(file.replace('.json', ''));
            if (d && !collected.some(e => (normalizeToISODate(e.date) || e.date) === d)) {
              collected.push({ date: d, timestamp: Date.now(), cairoTime: `${d} 00:00:00`, summary: {} });
            }
          }
        }
      }
    } catch (_) {}

    try {
      const { data: node } = await historySupabase
        .from('rtdb_nodes')
        .select('data')
        .eq('path', `history/${type}_index`)
        .maybeSingle();
      if (node && Array.isArray(node.data)) {
        for (const ce of node.data as DateIndexEntry[]) {
          const d = normalizeToISODate(ce.date) || ce.date;
          if (d && !collected.some(e => (normalizeToISODate(e.date) || e.date) === d)) {
            collected.push({ ...ce, date: d });
          }
        }
      }
    } catch (_) {}

    try {
      const { data: nodes } = await historySupabase
        .from('rtdb_nodes')
        .select('path, updated_at')
        .like('path', `history/${type}/%`);
      if (nodes && Array.isArray(nodes)) {
        for (const n of nodes) {
          const rel = n.path.replace(`history/${type}/`, '');
          const datePart = rel.split('/')[0];
          const d = normalizeToISODate(datePart);
          if (d && !collected.some(e => (normalizeToISODate(e.date) || e.date) === d)) {
            collected.push({
              date: d,
              timestamp: new Date(n.updated_at || Date.now()).getTime(),
              cairoTime: `${d} 00:00:00`,
              summary: {},
            });
          }
        }
      }
    } catch (_) {}

    const dedup = new Map<string, DateIndexEntry>();
    for (const item of collected) {
      const norm = normalizeToISODate(item.date) || item.date;
      if (norm && !dedup.has(norm)) {
        dedup.set(norm, { ...item, date: norm });
      }
    }
    return Array.from(dedup.values()).sort((a, b) => b.date.localeCompare(a.date));
  };

  const occEntries = await collectAllDatesForType('occupancy');
  const orEntries = await collectAllDatesForType('or');

  const candidateRefDates = [
    options?.referenceDate,
    occEntries[0]?.date,
    orEntries[0]?.date,
    getCairoDateTime().dateStr,
  ]
    .map(d => (d ? normalizeToISODate(d) || d : null))
    .filter(Boolean) as string[];
  candidateRefDates.sort((a, b) => b.localeCompare(a));

  const referenceDate = options?.referenceDate
    ? normalizeToISODate(options.referenceDate) || options.referenceDate
    : candidateRefDates[0] || getCairoDateTime().dateStr;
  const cutoffDate = getRetentionCutoffDate(referenceDate, maxDays);

  // 1. Prune Occupancy Dates
  const keptOcc: DateIndexEntry[] = [];
  for (let i = 0; i < occEntries.length; i++) {
    const entry = occEntries[i];
    if (i < maxDays && entry.date >= cutoffDate) {
      keptOcc.push(entry);
    } else {
      prunedOccupancyDates.push(entry.date);
    }
  }

  for (const oldDate of prunedOccupancyDates) {
    try {
      await retentionHooks.onBeforeDeleteDate?.(oldDate);
    } catch (_) {}
    await deleteOccupancySnapshot(oldDate);
    try {
      await retentionHooks.externalRtdbPrune?.(oldDate);
    } catch (_) {}
  }

  if (prunedOccupancyDates.length > 0) {
    const occIndexPath = path.join(WRITABLE_BASE, 'history', 'occupancy_index.json');
    try {
      await fsPromises.writeFile(occIndexPath, JSON.stringify(keptOcc));
    } catch (_) {}
    try {
      await historySupabase.from('rtdb_nodes').upsert({
        path: 'history/occupancy_index',
        data: keptOcc,
        updated_at: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // 2. Prune OR Dates
  const keptOr: DateIndexEntry[] = [];
  for (let i = 0; i < orEntries.length; i++) {
    const entry = orEntries[i];
    if (i < maxDays && entry.date >= cutoffDate) {
      keptOr.push(entry);
    } else {
      prunedOrDates.push(entry.date);
    }
  }

  for (const oldDate of prunedOrDates) {
    try {
      await retentionHooks.onBeforeDeleteDate?.(oldDate);
    } catch (_) {}
    await deleteORSnapshot(oldDate);
    try {
      await retentionHooks.externalRtdbPrune?.(oldDate);
    } catch (_) {}
  }

  if (prunedOrDates.length > 0) {
    const orIndexPath = path.join(WRITABLE_BASE, 'history', 'or_index.json');
    try {
      await fsPromises.writeFile(orIndexPath, JSON.stringify(keptOr));
    } catch (_) {}
    try {
      await historySupabase.from('rtdb_nodes').upsert({
        path: 'history/or_index',
        data: keptOr,
        updated_at: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // 3. Prune ChangeLog Dates
  try {
    const clSet = new Set<string>();
    const { data: clIdxNode } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', 'history/changelog_index')
      .maybeSingle();
    if (clIdxNode && Array.isArray(clIdxNode.data)) {
      for (const d of clIdxNode.data as string[]) {
        const norm = normalizeToISODate(d) || d;
        if (norm) clSet.add(norm);
      }
    }
    const { data: clNodes } = await historySupabase
      .from('rtdb_nodes')
      .select('path')
      .like('path', 'history/changelog/%');
    if (clNodes && Array.isArray(clNodes)) {
      for (const n of clNodes) {
        const datePart = n.path.replace('history/changelog/', '').split('/')[0];
        const norm = normalizeToISODate(datePart);
        if (norm) clSet.add(norm);
      }
    }

    const sortedCl = Array.from(clSet).sort((a, b) => b.localeCompare(a));
    const keptCl: string[] = [];
    for (let i = 0; i < sortedCl.length; i++) {
      const d = sortedCl[i];
      if (i < maxDays && d >= cutoffDate) {
        keptCl.push(d);
      } else {
        prunedChangelogDates.push(d);
      }
    }

    for (const oldDate of prunedChangelogDates) {
      await deleteChangeLogForDate(oldDate);
    }

    if (prunedChangelogDates.length > 0) {
      await historySupabase.from('rtdb_nodes').upsert({
        path: 'history/changelog_index',
        data: keptCl,
        updated_at: new Date().toISOString(),
      });
    }
  } catch (clErr) {
    console.warn('[Retention] Notice pruning changelog history:', clErr);
  }

  // 4. Prune Relational Tables (or_cases, transfers, discharged admissions, orphaned patients)
  const allEvicted = Array.from(new Set([...prunedOccupancyDates, ...prunedOrDates, ...prunedChangelogDates]));
  await pruneRelationalTablesForCutoff(cutoffDate, allEvicted, referenceDate, maxDays);

  return {
    evictedDates: allEvicted,
    prunedOccupancyDates,
    prunedOrDates,
    prunedChangelogDates,
    cutoffDate,
  };
}

/**
 * Get all available dates for a given history type (bounded to the 30-day retention window).
 * If any dates beyond 30 days are discovered on disk or in rtdb_nodes, triggers background eviction.
 */
export async function getAvailableDates(type: 'occupancy' | 'or'): Promise<DateIndexEntry[]> {
  const dir = type === 'occupancy' ? HISTORY_OCC_DIR : HISTORY_OR_DIR;
  const indexPath = path.join(WRITABLE_BASE, 'history', `${type}_index.json`);
  let diskEntries: DateIndexEntry[] = [];

  if (fs.existsSync(indexPath)) {
    try {
      const raw = await fsPromises.readFile(indexPath, 'utf-8');
      diskEntries = JSON.parse(raw) || [];
    } catch (e) {}
  } else if (fs.existsSync(path.join(process.cwd(), 'history', `${type}_index.json`))) {
    try {
      const raw = await fsPromises.readFile(path.join(process.cwd(), 'history', `${type}_index.json`), 'utf-8');
      diskEntries = JSON.parse(raw) || [];
    } catch (e) {}
  }

  // Also read directory files to ensure no disk files are missed
  try {
    if (fs.existsSync(dir)) {
      const files = await fsPromises.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const rawDate = file.replace('.json', '');
          const date = normalizeToISODate(rawDate) || rawDate;
          if (!diskEntries.some(e => (normalizeToISODate(e.date) || e.date) === date)) {
            try {
              const raw = await fsPromises.readFile(path.join(dir, file), 'utf-8');
              const content = JSON.parse(raw);
              diskEntries.push({
                date,
                timestamp: content.timestamp || Date.now(),
                cairoTime: content.cairoTime || `${date} 00:00:00`,
                summary: content.summary || {}
              });
            } catch (e) {}
          }
        }
      }
    }
  } catch (e) {}

  // Also query Supabase index
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', `history/${type}_index`)
      .maybeSingle();

    if (node && Array.isArray(node.data)) {
      const cloudEntries = node.data as DateIndexEntry[];
      for (const ce of cloudEntries) {
        const cDate = normalizeToISODate(ce.date) || ce.date;
        if (!diskEntries.some(e => (normalizeToISODate(e.date) || e.date) === cDate)) {
          diskEntries.push({ ...ce, date: cDate });
        }
      }
    }
  } catch (e) {}

  // Also scan all nodes in Supabase under history/{type}/% to discover any unindexed snapshots
  try {
    const { data: nodes } = await historySupabase
      .from('rtdb_nodes')
      .select('path, updated_at')
      .like('path', `history/${type}/%`);

    if (nodes && Array.isArray(nodes)) {
      for (const n of nodes) {
        const rel = n.path.replace(`history/${type}/`, '');
        const datePart = rel.split('/summary')[0].split('/cases')[0].split('/')[0];
        const norm = normalizeToISODate(datePart);
        if (norm && !diskEntries.some(e => (normalizeToISODate(e.date) || e.date) === norm)) {
          diskEntries.push({
            date: norm,
            timestamp: new Date(n.updated_at || Date.now()).getTime(),
            cairoTime: `${norm} 00:00:00`,
            summary: {}
          });
        }
      }
    }
  } catch (e) {}

  // Deduplicate by normalized date
  const map = new Map<string, DateIndexEntry>();
  const cairo = getCairoDateTime();
  for (const entry of diskEntries) {
    let norm = normalizeToISODate(entry.date) || entry.date;
    // If an entry is 2026-06-10 but was created recently (within last 7 days), it belongs to 2026-10-06
    if (norm === '2026-06-10' && Math.abs(Date.now() - (entry.timestamp || 0)) < 7 * 86400 * 1000) {
      norm = cairo.dateStr;
    }
    if (!map.has(norm)) {
      map.set(norm, { ...entry, date: norm });
    }
  }

  const allSorted = Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  const refDate = allSorted[0]?.date || cairo.dateStr;
  const cutoffDate = getRetentionCutoffDate(refDate, MAX_HISTORY_RETENTION_DAYS);

  const kept: DateIndexEntry[] = [];
  const expired: string[] = [];
  allSorted.forEach((item, idx) => {
    if (idx < MAX_HISTORY_RETENTION_DAYS && item.date >= cutoffDate) {
      kept.push(item);
    } else {
      expired.push(item.date);
    }
  });

  if (expired.length > 0) {
    // Asynchronously evict expired dates discovered during listing
    (async () => {
      for (const oldDate of expired) {
        await evictSingleDateEverywhere(oldDate);
      }
      await pruneRelationalTablesForCutoff(cutoffDate, expired, refDate, MAX_HISTORY_RETENTION_DAYS);
    })().catch(err => console.warn('[Retention] Async cleanup notice:', err));
  }

  return kept;
}


