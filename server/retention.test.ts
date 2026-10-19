import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Ensure historyManager uses /tmp during tests so it never mutates project working directory files
vi.hoisted(() => {
  process.env.VERCEL = '1';
});

// In-memory mock store for Supabase rtdb_nodes, cumulative analytics tables, and relational tables
const mockRtdbNodes = new Map<string, { path: string; data: any; updated_at: string }>();
const mockOccupancyDailyCensus = new Map<string, any>();
const mockOrDailyCensus = new Map<string, any>();
const mockOrCases: Array<{ id: string; procedure_date: string }> = [];
const mockTransfers: Array<{ id: string; transfer_date: string }> = [];
const mockAdmissions: Array<{ id: string; patient_id: string; status: string; discharge_date: string | null }> = [];
const mockPatients: Array<{ id: string; updated_at: string }> = [];
const mockRpcCalls: Array<{ fn: string; args: any }> = [];

function matchesLike(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: () => ({
      rpc: async (fn: string, args: any) => {
        mockRpcCalls.push({ fn, args });
        // Return error so historyManager also exercises its direct table query fallback
        return { data: null, error: { message: 'mock fallback to direct queries' } };
      },
      from: (table: string) => {
        if (table === 'rtdb_nodes') {
          return {
            upsert: async (payload: any) => {
              const items = Array.isArray(payload) ? payload : [payload];
              for (const item of items) {
                mockRtdbNodes.set(item.path, {
                  path: item.path,
                  data: item.data,
                  updated_at: item.updated_at || new Date().toISOString(),
                });
              }
              return { data: items, error: null };
            },
            select: (_cols?: string) => ({
              eq: (col: string, val: string) => ({
                maybeSingle: async () => {
                  if (col === 'path') {
                    const row = mockRtdbNodes.get(val) || null;
                    return { data: row, error: null };
                  }
                  return { data: null, error: null };
                },
              }),
              like: (col: string, pattern: string) => {
                const getRows = () => {
                  if (col === 'path') {
                    return Array.from(mockRtdbNodes.values()).filter((r) =>
                      matchesLike(r.path, pattern)
                    );
                  }
                  return [];
                };
                const res = { data: getRows(), error: null };
                const promise = Promise.resolve(res);
                return Object.assign(promise, {
                  limit: async (num: number) => ({ data: getRows().slice(0, num), error: null })
                });
              },
            }),
            delete: () => ({
              like: async (col: string, pattern: string) => {
                if (col === 'path') {
                  for (const key of Array.from(mockRtdbNodes.keys())) {
                    if (matchesLike(key, pattern)) {
                      mockRtdbNodes.delete(key);
                    }
                  }
                }
                return { error: null };
              },
              eq: async (col: string, val: string) => {
                if (col === 'path') {
                  mockRtdbNodes.delete(val);
                }
                return { error: null };
              },
            }),
          };
        }

        if (table === 'occupancy_daily_census') {
          return {
            upsert: async (payload: any) => {
              const items = Array.isArray(payload) ? payload : [payload];
              for (const item of items) {
                mockOccupancyDailyCensus.set(item.census_date, { ...item });
              }
              return { data: items, error: null };
            },
            select: (_cols?: string) => ({
              eq: (col: string, val: string) => ({
                maybeSingle: async () => {
                  if (col === 'census_date') {
                    return { data: mockOccupancyDailyCensus.get(val) || null, error: null };
                  }
                  return { data: null, error: null };
                },
              }),
              gte: (_col: string, start: string) => ({
                lte: (_col2: string, end: string) => ({
                  order: async () => {
                    const rows = Array.from(mockOccupancyDailyCensus.values())
                      .filter((r) => r.census_date >= start && r.census_date <= end)
                      .sort((a, b) => a.census_date.localeCompare(b.census_date));
                    return { data: rows, error: null };
                  },
                }),
              }),
            }),
          };
        }

        if (table === 'or_daily_census') {
          return {
            upsert: async (payload: any) => {
              const items = Array.isArray(payload) ? payload : [payload];
              for (const item of items) {
                mockOrDailyCensus.set(item.census_date, { ...item });
              }
              return { data: items, error: null };
            },
            select: (_cols?: string) => ({
              eq: (col: string, val: string) => ({
                maybeSingle: async () => {
                  if (col === 'census_date') {
                    return { data: mockOrDailyCensus.get(val) || null, error: null };
                  }
                  return { data: null, error: null };
                },
              }),
              gte: (_col: string, start: string) => ({
                lte: (_col2: string, end: string) => ({
                  order: async () => {
                    const rows = Array.from(mockOrDailyCensus.values())
                      .filter((r) => r.census_date >= start && r.census_date <= end)
                      .sort((a, b) => a.census_date.localeCompare(b.census_date));
                    return { data: rows, error: null };
                  },
                }),
              }),
            }),
          };
        }

        if (table === 'or_cases') {
          return {
            delete: () => ({
              lt: async (_col: string, cutoff: string) => {
                for (let i = mockOrCases.length - 1; i >= 0; i--) {
                  if (mockOrCases[i].procedure_date < cutoff) {
                    mockOrCases.splice(i, 1);
                  }
                }
                return { error: null };
              },
              in: async (_col: string, dates: string[]) => {
                for (let i = mockOrCases.length - 1; i >= 0; i--) {
                  if (dates.includes(mockOrCases[i].procedure_date)) {
                    mockOrCases.splice(i, 1);
                  }
                }
                return { error: null };
              },
            }),
          };
        }

        if (table === 'transfers') {
          return {
            delete: () => ({
              lt: async (_col: string, cutoffIso: string) => {
                for (let i = mockTransfers.length - 1; i >= 0; i--) {
                  if (mockTransfers[i].transfer_date < cutoffIso) {
                    mockTransfers.splice(i, 1);
                  }
                }
                return { error: null };
              },
            }),
          };
        }

        if (table === 'admissions') {
          return {
            delete: () => ({
              neq: (_col: string, statusVal: string) => ({
                lt: async (_col2: string, cutoffIso: string) => {
                  for (let i = mockAdmissions.length - 1; i >= 0; i--) {
                    const a = mockAdmissions[i];
                    if (a.status !== statusVal && a.discharge_date && a.discharge_date < cutoffIso) {
                      mockAdmissions.splice(i, 1);
                    }
                  }
                  return { error: null };
                },
              }),
            }),
            select: () => ({
              limit: async () => ({
                data: mockAdmissions.map((a) => ({ patient_id: a.patient_id })),
                error: null,
              }),
            }),
          };
        }

        if (table === 'patients') {
          return {
            select: () => ({
              lt: (_col: string, cutoffIso: string) => ({
                limit: async () => ({
                  data: mockPatients
                    .filter((p) => p.updated_at < cutoffIso)
                    .map((p) => ({ id: p.id })),
                  error: null,
                }),
              }),
            }),
            delete: () => ({
              in: async (_col: string, ids: string[]) => {
                for (let i = mockPatients.length - 1; i >= 0; i--) {
                  if (ids.includes(mockPatients[i].id)) {
                    mockPatients.splice(i, 1);
                  }
                }
                return { error: null };
              },
            }),
          };
        }

        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          upsert: async () => ({ error: null }),
          delete: () => ({ eq: async () => ({ error: null }), like: async () => ({ error: null }) }),
        };
      },
    }),
  };
});

import {
  MAX_HISTORY_RETENTION_DAYS,
  getRetentionCutoffDate,
  registerRetentionHooks,
  saveOccupancySnapshot,
  getOccupancySnapshot,
  saveORSnapshot,
  getORSnapshot,
  saveChangeLogEntry,
  getChangeLogDates,
} from '../historyManager.js';
import { CumulativeOccupancyService } from './cumulativeOccupancy/service.js';
import {
  getDailyBedCensus,
  getDailyORCensus,
  upsertDailyBedCensus,
  upsertDailyORCensus,
} from './cumulativeOccupancy/repository.js';

describe('30-Day Rolling Data Retention & Permanent Cumulative Analytics / VIP Preservation', () => {
  const testDates: string[] = [];
  for (let d = 1; d <= 31; d++) {
    testDates.push(`2026-05-${String(d).padStart(2, '0')}`);
  }

  beforeEach(() => {
    mockRtdbNodes.clear();
    mockOccupancyDailyCensus.clear();
    mockOrDailyCensus.clear();
    mockOrCases.length = 0;
    mockTransfers.length = 0;
    mockAdmissions.length = 0;
    mockPatients.length = 0;
    mockRpcCalls.length = 0;
    registerRetentionHooks({});

    const tmpHistory = path.join('/tmp', 'history');
    if (fs.existsSync(tmpHistory)) {
      fs.rmSync(tmpHistory, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(tmpHistory, 'occupancy'), { recursive: true });
    fs.mkdirSync(path.join(tmpHistory, 'or'), { recursive: true });
    fs.writeFileSync(path.join(tmpHistory, 'occupancy_index.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(tmpHistory, 'or_index.json'), '[]', 'utf-8');
  });

  afterEach(() => {
    registerRetentionHooks({});
    const tmpHistory = path.join('/tmp', 'history');
    if (fs.existsSync(tmpHistory)) {
      fs.rmSync(tmpHistory, { recursive: true, force: true });
    }
  });

  it('calculates the 30-day rolling cutoff date accurately across month boundaries', () => {
    expect(MAX_HISTORY_RETENTION_DAYS).toBe(30);
    // Reference date 2026-05-31 -> 30 days inclusive is 2026-05-02..2026-05-31
    expect(getRetentionCutoffDate('2026-05-31', 30)).toBe('2026-05-02');
    // Reference date 2026-04-17 -> 30 days inclusive is 2026-03-19..2026-04-17
    expect(getRetentionCutoffDate('2026-04-17', 30)).toBe('2026-03-19');
  });

  it('evicts the oldest (31st) day from RTDB, relational tables, and local disk when saving 31 days while preserving MTD analytics & VIP cases', async () => {
    const service = new CumulativeOccupancyService();
    const beforeDeleteDates: string[] = [];
    const externalRtdbPrunedDates: string[] = [];

    // Seed permanent VIP cases in rtdb_nodes
    mockRtdbNodes.set('settings/vip_cases', {
      path: 'settings/vip_cases',
      data: { text: '1. HRH Prince Sultan - VIP Suite 401\n2. Ambassador Kareem - Room 305' },
      updated_at: new Date().toISOString(),
    });

    // Seed relational rows for 2026-05-01 (oldest day, should be pruned) and 2026-05-15 (within 30 days, should be kept)
    mockOrCases.push(
      { id: 'or-old', procedure_date: '2026-05-01' },
      { id: 'or-recent', procedure_date: '2026-05-15' }
    );
    mockTransfers.push(
      { id: 'tr-old', transfer_date: '2026-05-01T10:00:00.000Z' },
      { id: 'tr-recent', transfer_date: '2026-05-15T10:00:00.000Z' }
    );
    mockAdmissions.push(
      { id: 'adm-discharged-old', patient_id: 'pt-orphan', status: 'Discharged', discharge_date: '2026-05-01T18:00:00.000Z' },
      { id: 'adm-active-old', patient_id: 'pt-active', status: 'Admitted', discharge_date: null }
    );
    mockPatients.push(
      { id: 'pt-orphan', updated_at: '2026-05-01T18:00:00.000Z' },
      { id: 'pt-active', updated_at: '2026-04-10T10:00:00.000Z' }
    );

    registerRetentionHooks({
      onBeforeDeleteDate: async (dateStr: string) => {
        beforeDeleteDates.push(dateStr);
        await service.ensureDateCensusRecorded(dateStr);
      },
      externalRtdbPrune: async (dateStr: string) => {
        externalRtdbPrunedDates.push(dateStr);
      },
    });

    // Save 31 days of occupancy, OR, and changelog snapshots sequentially (2026-05-01 .. 2026-05-31)
    for (let i = 0; i < testDates.length; i++) {
      const d = testDates[i];
      await saveOccupancySnapshot({
        date: d,
        hospitalData: [
          ['Room', 'Patient Name', 'Physician', 'Contractor', 'Admission Date', 'MRN'],
          ['', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['301', `Patient ${i + 1}`, 'Dr. Test', 'Cash', d, `MRN-${i + 1}`],
          ['ICU-1', `Critical ${i + 1}`, 'Dr. ICU', 'Bupa', d, `MRN-C-${i + 1}`],
        ],
        previousHospitalData: null,
        cumulativeEntries: [],
        cumulativeDialysis: [],
        cumulativeDebts: [],
        cumulativeInsuredDebts: [],
        cumulativeMedicalPlans: [],
        cumulativeCompanionStatus: [],
        cumulativeLOS: [],
        cumulativeDischarged: [{ room: '302', name: `Discharged ${i + 1}` }],
        manuallyDischargedNames: [],
        cumulativeTransfers: [],
        vipCasesText: '1. HRH Prince Sultan - VIP Suite 401\n2. Ambassador Kareem - Room 305',
        earlyDischargeRoomsText: '',
        summary: {
          totalOccupancy: 2,
          dischargesCount: 1,
          autoDischargesCount: 1,
          manualDischargesCount: 0,
          entriesCount: 0,
          dialysisCount: 0,
          debtsCount: 0,
          insuredDebtsCount: 0,
          transfersCount: 0,
        },
      });

      await saveORSnapshot({
        date: d,
        orList: [
          {
            patientName: `Surgical Pt ${i + 1}`,
            orRoom: 'OR-1',
            operation: 'Laparoscopic Cholecystectomy',
            surgeon: 'Dr. Surgeon',
            startTime: '09:00',
            endTime: '11:00',
          },
        ],
        summary: {
          totalCases: 1,
          matched: 1,
          outpatients: 0,
        },
      });

      await saveChangeLogEntry({
        date: d,
        changeType: 'upload',
        summary: {
          totalOccupancy: 2,
          dischargesCount: 1,
          autoDischargesCount: 1,
          manualDischargesCount: 0,
          entriesCount: 0,
          dialysisCount: 0,
          debtsCount: 0,
          insuredDebtsCount: 0,
          transfersCount: 0,
        },
        cumulativeEntries: [],
        cumulativeDischarged: [],
        cumulativeDialysis: [],
        cumulativeTransfers: [],
        vipCasesText: '1. HRH Prince Sultan - VIP Suite 401\n2. Ambassador Kareem - Room 305',
      });
    }

    // Saving the 31st day (2026-05-31) should have immediately evicted the 1st day (2026-05-01)!
    const evictedOcc = await getOccupancySnapshot('2026-05-01');
    const evictedOr = await getORSnapshot('2026-05-01');
    expect(evictedOcc).toBeNull();
    expect(evictedOr).toBeNull();

    // Verify RTDB nodes for 2026-05-01 were deleted from rtdb_nodes
    const remaining2026May01Nodes = Array.from(mockRtdbNodes.keys()).filter((k) =>
      k.includes('2026-05-01')
    );
    expect(remaining2026May01Nodes).toEqual([]);

    // Verify 2026-05-02 through 2026-05-31 (exactly 30 days) remain intact
    const occIndex = mockRtdbNodes.get('history/occupancy_index')?.data as Array<{ date: string }>;
    const orIndex = mockRtdbNodes.get('history/or_index')?.data as Array<{ date: string }>;
    const clIndex = await getChangeLogDates();

    expect(occIndex.length).toBe(30);
    expect(occIndex.map((x) => x.date)).not.toContain('2026-05-01');
    expect(occIndex[0].date).toBe('2026-05-31');
    expect(occIndex[29].date).toBe('2026-05-02');

    expect(orIndex.length).toBe(30);
    expect(orIndex.map((x) => x.date)).not.toContain('2026-05-01');

    expect(clIndex.length).toBe(30);
    expect(clIndex).not.toContain('2026-05-01');

    // Verify pre-eviction hook saved 2026-05-01 into permanent MTD cumulative analytics BEFORE deleting raw snapshot
    expect(beforeDeleteDates).toContain('2026-05-01');
    expect(externalRtdbPrunedDates).toContain('2026-05-01');

    const preservedBedCensus = await getDailyBedCensus('2026-05-01');
    const preservedOrCensus = await getDailyORCensus('2026-05-01');
    expect(preservedBedCensus).not.toBeNull();
    expect(preservedBedCensus?.totalOccupied).toBeGreaterThan(0);
    expect(preservedOrCensus).not.toBeNull();
    expect(preservedOrCensus?.casesTotal).toBe(1);

    // Verify relational tables were pruned for 2026-05-01 while active admissions & recent rows were kept
    expect(mockOrCases.map((r) => r.id)).toEqual(['or-recent']);
    expect(mockTransfers.map((r) => r.id)).toEqual(['tr-recent']);
    expect(mockAdmissions.map((r) => r.id)).toEqual(['adm-active-old']);
    expect(mockPatients.map((r) => r.id)).toEqual(['pt-active']);

    // Verify settings/vip_cases is permanently preserved in rtdb_nodes
    const vipNode = mockRtdbNodes.get('settings/vip_cases');
    expect(vipNode).toBeDefined();
    expect(vipNode?.data?.text).toBe(
      '1. HRH Prince Sultan - VIP Suite 401\n2. Ambassador Kareem - Room 305'
    );
  });

  it('never overwrites preserved MTD/monthly cumulative analytics with 0 when raw snapshots older than 30 days are pruned', async () => {
    const service = new CumulativeOccupancyService();

    // Pre-populate cumulative daily census for an older date whose raw snapshot was already pruned (2025-11-01)
    await upsertDailyBedCensus({
      date: '2025-11-01',
      inpatientOccupied: 38,
      inpatientCapacity: 68,
      totalOccupied: 42,
      totalCapacity: 110,
      zoneBreakdown: [],
      source: 'rollover',
    });

    await upsertDailyORCensus({
      date: '2025-11-01',
      roomsAvailable: 7,
      minutesPerRoom: 720,
      bookedMinutes: 640,
      roomsUsed: 5,
      casesTotal: 9,
      dcCount: 2,
      hcCount: 1,
      inCount: 4,
      outCount: 2,
      sicuCount: 0,
      excludedCases: 0,
      roomBreakdown: {},
      source: 'rollover',
    });

    // Run backfillMonth with both force=false and force=true when no raw snapshot exists for 2025-11-01
    await service.backfillMonth('2025-11', false);
    await service.backfillMonth('2025-11', true);

    const bedAfterBackfill = await getDailyBedCensus('2025-11-01');
    const orAfterBackfill = await getDailyORCensus('2025-11-01');

    expect(bedAfterBackfill?.inpatientOccupied).toBe(38);
    expect(bedAfterBackfill?.totalOccupied).toBe(42);
    expect(bedAfterBackfill?.source).toBe('rollover');
    expect(orAfterBackfill?.bookedMinutes).toBe(640);
    expect(orAfterBackfill?.casesTotal).toBe(9);
    expect(orAfterBackfill?.source).toBe('rollover');
  });

  it('verifies SQL migration & schema preserve cumulative analytics and settings/vip_cases forever', () => {
    const migrationSql = fs.readFileSync(
      path.join(process.cwd(), 'db/retention_30_days_migration.sql'),
      'utf-8'
    );
    const schemaSql = fs.readFileSync(path.join(process.cwd(), 'db/schema.sql'), 'utf-8');

    for (const sql of [migrationSql, schemaSql]) {
      expect(sql).toContain('CREATE OR REPLACE FUNCTION public.enforce_30_day_retention');
      // Deletes only history/occupancy/*, history/or/*, history/changelog/*
      expect(sql).toContain("path LIKE 'history/occupancy/%'");
      expect(sql).toContain("path LIKE 'history/or/%'");
      expect(sql).toContain("path LIKE 'history/changelog/%'");
      // Never deletes cumulative analytics tables or settings/vip_cases
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.occupancy_daily_census/i);
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.occupancy_monthly_summary/i);
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.or_daily_census/i);
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.or_monthly_summary/i);
      expect(sql).not.toMatch(/settings\/vip_cases'\s*;\s*DELETE/i);
    }
  });
});
