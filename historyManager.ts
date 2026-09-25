import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uuvomcxbgldgtmuqtymk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1dm9tY3hiZ2xkZ3RtdXF0eW1rIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODkwNTQ4MSwiZXhwIjoyMTA0NDgxNDgxfQ.qd80QNiyhjO51Ky4zxKmzXtOb-bB4hFvhZ3cYnVoyn0';

export const historySupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
    const { error } = await historySupabase
      .from('rtdb_nodes')
      .upsert({ path, data: logEntry, updated_at: nowIso });

    if (error) {
      console.error(`[ChangeLog] Failed to save change log entry (${logEntry.changeType}) for ${dateStr}:`, error);
    } else {
      console.log(`[ChangeLog] Change log entry saved: ${path} (type=${logEntry.changeType})`);
    }
  } catch (err) {
    console.error(`[ChangeLog] Exception saving change log entry:`, err);
  }

  // Also update the changelog index so we know which dates have changelog entries
  await updateChangeLogIndex(dateStr);

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

/**
 * Retrieve all dates that have at least one change-log entry.
 */
export async function getChangeLogDates(): Promise<string[]> {
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', 'history/changelog_index')
      .maybeSingle();

    if (node && Array.isArray(node.data)) {
      return node.data as string[];
    }
  } catch (err) {
    console.error('[ChangeLog] Failed to fetch changelog dates index:', err);
  }
  return [];
}

/**
 * Maintain a small index of all dates that have changelog entries.
 */
async function updateChangeLogIndex(dateStr: string): Promise<void> {
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', 'history/changelog_index')
      .maybeSingle();

    let dates: string[] = (node && Array.isArray(node.data)) ? node.data as string[] : [];
    if (!dates.includes(dateStr)) {
      dates.unshift(dateStr);
      dates.sort((a, b) => b.localeCompare(a));
      await historySupabase.from('rtdb_nodes').upsert({
        path: 'history/changelog_index',
        data: dates,
        updated_at: new Date().toISOString(),
      });
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
    hospitalData: data.hospitalData,
    previousHospitalData: data.previousHospitalData,
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

    const { error: sbErr } = await historySupabase.from('rtdb_nodes').upsert(granularHistoryUpserts);
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
          hospitalData: nodeMap['hospital_data'] || null,
          previousHospitalData: null,
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
  const cleanDate = dateStr.trim();
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

    if (sbErr) {
      console.error(`[OccupancyHistory] Error deleting history nodes from Supabase for ${cleanDate}:`, sbErr);
    } else {
      console.log(`[OccupancyHistory] Successfully deleted history/occupancy/${cleanDate} nodes from Supabase.`);
    }
  } catch (err) {
    console.error(`[OccupancyHistory] Exception deleting snapshot from Supabase:`, err);
  }

  // 3. Remove date from occupancy index
  try {
    const indexPath = path.join(process.cwd(), 'history', `occupancy_index.json`);
    let entries: DateIndexEntry[] = [];
    if (fs.existsSync(indexPath)) {
      try {
        const raw = await fsPromises.readFile(indexPath, 'utf-8');
        entries = JSON.parse(raw) || [];
      } catch (e) {}
    }
    entries = entries.filter(e => e.date !== cleanDate);
    await fsPromises.writeFile(indexPath, JSON.stringify(entries));

    await historySupabase.from('rtdb_nodes').upsert({
      path: `history/occupancy_index`,
      data: entries,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error(`[OccupancyHistory] Error updating occupancy_index on delete:`, e);
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
  const dateStr = data.date || cairo.dateStr;
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

    const { error: sbErr } = await historySupabase.from('rtdb_nodes').upsert(granularORUpserts);
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
  const cleanDate = dateStr.trim();
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
      const snapshot = legacyNode.data as ORSnapshot;
      try {
        await fsPromises.writeFile(filePath, JSON.stringify(snapshot));
      } catch (e) {}
      return snapshot;
    }
  } catch (err) {
    console.error(`[ORHistory] Failed to fetch OR snapshot from Supabase for ${cleanDate}:`, err);
  }

  return null;
}

/**
 * Update the index of available dates
 */
async function updateHistoryIndex(type: 'occupancy' | 'or', entry: DateIndexEntry) {
  const indexPath = path.join(process.cwd(), 'history', `${type}_index.json`);
  let entries: DateIndexEntry[] = [];

  if (fs.existsSync(indexPath)) {
    try {
      const raw = await fsPromises.readFile(indexPath, 'utf-8');
      entries = JSON.parse(raw) || [];
    } catch (e) {}
  }

  // Remove existing entry for same date if any
  entries = entries.filter(e => e.date !== entry.date);
  entries.unshift(entry);
  entries.sort((a, b) => b.date.localeCompare(a.date));

  // Save to disk asynchronously
  try {
    await fsPromises.writeFile(indexPath, JSON.stringify(entries));
  } catch (e) {}

  // Save to Supabase
  try {
    await historySupabase.from('rtdb_nodes').upsert({
      path: `history/${type}_index`,
      data: entries,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error(`[History] Failed to sync ${type}_index to Supabase:`, e);
  }
}

/**
 * Get all available dates for a given history type
 */
export async function getAvailableDates(type: 'occupancy' | 'or'): Promise<DateIndexEntry[]> {
  const dir = type === 'occupancy' ? HISTORY_OCC_DIR : HISTORY_OR_DIR;
  const indexPath = path.join(process.cwd(), 'history', `${type}_index.json`);
  let diskEntries: DateIndexEntry[] = [];

  if (fs.existsSync(indexPath)) {
    try {
      const raw = await fsPromises.readFile(indexPath, 'utf-8');
      diskEntries = JSON.parse(raw) || [];
    } catch (e) {}
  }

  // Also read directory files to ensure no disk files are missed
  try {
    if (fs.existsSync(dir)) {
      const files = await fsPromises.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const date = file.replace('.json', '');
          if (!diskEntries.some(e => e.date === date)) {
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

  // Also query Supabase
  try {
    const { data: node } = await historySupabase
      .from('rtdb_nodes')
      .select('data')
      .eq('path', `history/${type}_index`)
      .maybeSingle();

    if (node && Array.isArray(node.data)) {
      const cloudEntries = node.data as DateIndexEntry[];
      for (const ce of cloudEntries) {
        if (!diskEntries.some(e => e.date === ce.date)) {
          diskEntries.push(ce);
        }
      }
    }
  } catch (e) {}

  diskEntries.sort((a, b) => b.date.localeCompare(a.date));
  return diskEntries;
}
