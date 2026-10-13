import { computeOccupancyCensus } from '../../src/logic/occupancy.js';
import {
  aggregateBedMonth,
  DailyBedCensus,
  isLastDayOfMonth,
  listMonthDates,
} from './calculator.js';
import {
  aggregateORMonth,
  computeORCensus,
  DailyORCensus,
} from './orCalculator.js';
import {
  getDailyBedCensusForMonth,
  getDailyORCensusForMonth,
  getMonthlyBedSummaries,
  getMonthlyBedSummary,
  getMonthlyORSummaries,
  getMonthlyORSummary,
  insertMonthlyBedSummaryIfAbsent,
  insertMonthlyORSummaryIfAbsent,
  upsertDailyBedCensus,
  upsertDailyORCensus,
} from './repository.js';
import { getOccupancySnapshot, getORSnapshot } from '../../historyManager.js';

// Cache track of months that were already backfilled during current process lifetime
const backfilledMonths = new Set<string>();

export class CumulativeOccupancyService {
  /**
   * Records the official daily bed census for a closing hospital date.
   */
  async recordBedCensus(
    dateStr: string,
    rawRows: any[][],
    source: 'rollover' | 'backfill' | 'manual' = 'rollover'
  ): Promise<DailyBedCensus | null> {
    if (!rawRows || rawRows.length === 0) {
      console.warn(`[CumulativeService] recordBedCensus skipped for ${dateStr}: empty rawRows`);
      return null;
    }

    const census = computeOccupancyCensus(rawRows);
    const record: DailyBedCensus = {
      date: dateStr,
      inpatientOccupied: census.inpatientOccupied,
      inpatientCapacity: census.inpatientCapacity,
      totalOccupied: census.totalOccupied,
      totalCapacity: census.totalCapacity,
      zoneBreakdown: census.zones,
      source,
    };

    await upsertDailyBedCensus(record);
    console.log(`[CumulativeService] Bed census recorded for ${dateStr} (${record.inpatientOccupied}/${record.inpatientCapacity} inpatient, ${record.totalOccupied}/${record.totalCapacity} total, source: ${source})`);
    return record;
  }

  /**
   * Records the official daily OR census for a closing date.
   */
  async recordORCensus(
    dateStr: string,
    orList: any[] | null | undefined,
    source: 'rollover' | 'backfill' | 'manual' = 'rollover'
  ): Promise<DailyORCensus> {
    const record = computeORCensus(orList, dateStr);
    record.source = source;

    await upsertDailyORCensus(record);
    console.log(`[CumulativeService] OR census recorded for ${dateStr} (${record.bookedMinutes} booked mins, ${record.roomsUsed}/${record.roomsAvailable} rooms, ${record.casesTotal} cases, source: ${source})`);
    return record;
  }

  /**
   * Locks and finalizes both bed and OR monthly summaries for the specified month (YYYY-MM).
   * Write-once: if already finalized, ignores duplicates.
   */
  async finalizeMonth(monthStr: string): Promise<{ bedsFinalized: boolean; orFinalized: boolean }> {
    console.log(`[CumulativeService] Finalizing month ${monthStr}...`);

    // 1. Finalize Beds
    let bedsFinalized = false;
    try {
      const storedDays = await getDailyBedCensusForMonth(monthStr);
      if (storedDays.length > 0) {
        const agg = aggregateBedMonth(monthStr, storedDays, null);
        bedsFinalized = await insertMonthlyBedSummaryIfAbsent({
          month: monthStr,
          daysInMonth: agg.daysInMonth,
          daysRecorded: agg.daysRecorded,
          missingDays: agg.missingDays,
          inpatientPatientDays: agg.inpatient.patientDays,
          inpatientBedDays: agg.inpatient.bedDays,
          inpatientRate: agg.inpatient.rate,
          totalPatientDays: agg.total.patientDays,
          totalBedDays: agg.total.bedDays,
          totalRate: agg.total.rate,
        });
        console.log(`[CumulativeService] Beds finalized for ${monthStr}: inpatient ${agg.inpatient.rate}%, total ${agg.total.rate}% (inserted: ${bedsFinalized})`);
      } else {
        console.warn(`[CumulativeService] No bed records to finalize for month ${monthStr}`);
      }
    } catch (bErr) {
      console.error(`[CumulativeService] Error finalizing beds for ${monthStr}:`, bErr);
    }

    // 2. Finalize OR
    let orFinalized = false;
    try {
      const storedORDays = await getDailyORCensusForMonth(monthStr);
      if (storedORDays.length > 0) {
        const orAgg = aggregateORMonth(monthStr, storedORDays, null);
        orFinalized = await insertMonthlyORSummaryIfAbsent({
          month: monthStr,
          daysInMonth: orAgg.daysInMonth,
          daysRecorded: orAgg.daysRecorded,
          bookedMinutes: orAgg.bookedMinutes,
          availableMinutes: orAgg.availableMinutes,
          timeUtilization: orAgg.timeUtilization,
          roomDaysUsed: orAgg.roomDaysUsed,
          roomDaysAvailable: orAgg.roomDaysAvailable,
          roomUtilization: orAgg.roomUtilization,
          casesTotal: orAgg.casesTotal,
          dcCount: orAgg.dcCount,
          hcCount: orAgg.hcCount,
          inCount: orAgg.inCount,
          outCount: orAgg.outCount,
          sicuCount: orAgg.sicuCount,
        });
        console.log(`[CumulativeService] OR finalized for ${monthStr}: time util ${orAgg.timeUtilization}%, room util ${orAgg.roomUtilization}%, cases ${orAgg.casesTotal} (inserted: ${orFinalized})`);
      } else {
        console.warn(`[CumulativeService] No OR records to finalize for month ${monthStr}`);
      }
    } catch (orErr) {
      console.error(`[CumulativeService] Error finalizing OR for ${monthStr}:`, orErr);
    }

    return { bedsFinalized, orFinalized };
  }

  /**
   * Catch-up safety: checks earlier months in the same year that have elapsed and locks them if unfinalized.
   */
  async finalizeOverdueMonths(todayDateStr: string): Promise<void> {
    try {
      const [yearStr, monthStr] = todayDateStr.split('-');
      const currentYear = parseInt(yearStr, 10);
      const currentMonthNum = parseInt(monthStr, 10);

      // Check all months prior to currentMonthNum in currentYear
      for (let m = 1; m < currentMonthNum; m++) {
        const padM = m < 10 ? `0${m}` : `${m}`;
        const prevMonthStr = `${currentYear}-${padM}`;
        const bedSummary = await getMonthlyBedSummary(prevMonthStr);
        const orSummary = await getMonthlyORSummary(prevMonthStr);

        if (!bedSummary || !orSummary) {
          console.log(`[CumulativeService] Found overdue unfinalized month ${prevMonthStr}. Finalizing...`);
          await this.finalizeMonth(prevMonthStr);
        }
      }
    } catch (err) {
      console.error('[CumulativeService] Error checking overdue months:', err);
    }
  }

  /**
   * Auto-backfills a month using historical snapshots on disk or Supabase.
   */
  async backfillMonth(monthStr: string, force = false): Promise<{ bedsBackfilled: number; orBackfilled: number }> {
    if (!force && backfilledMonths.has(monthStr)) {
      return { bedsBackfilled: 0, orBackfilled: 0 };
    }
    backfilledMonths.add(monthStr);

    console.log(`[CumulativeService] Checking backfill for month ${monthStr}...`);
    let bedsBackfilled = 0;
    let orBackfilled = 0;

    try {
      const storedBeds = await getDailyBedCensusForMonth(monthStr);
      const existingBedDates = new Set(storedBeds.map(b => b.date));

      const storedOR = await getDailyORCensusForMonth(monthStr);
      const existingORDates = new Set(storedOR.map(o => o.date));

      const dates = listMonthDates(monthStr);

      for (const d of dates) {
        // 1. Backfill Beds
        if (!existingBedDates.has(d)) {
          try {
            const snap = await getOccupancySnapshot(d);
            if (snap && snap.hospitalData && snap.hospitalData.length > 3) {
              const rec = await this.recordBedCensus(d, snap.hospitalData, 'backfill');
              if (rec) bedsBackfilled++;
            }
          } catch (snapErr) {
            // Ignore snapshot fetch error for individual day
          }
        }

        // 2. Backfill OR
        if (!existingORDates.has(d)) {
          try {
            const orSnap = await getORSnapshot(d);
            if (orSnap && Array.isArray(orSnap.orList)) {
              await this.recordORCensus(d, orSnap.orList, 'backfill');
              orBackfilled++;
            } else {
              // Calendar-day rule: days with no OR list are recorded with 0 minutes
              await this.recordORCensus(d, [], 'backfill');
              orBackfilled++;
            }
          } catch (orSnapErr) {
            // Record empty day
            await this.recordORCensus(d, [], 'backfill');
            orBackfilled++;
          }
        }
      }

      console.log(`[CumulativeService] Backfill finished for ${monthStr}: ${bedsBackfilled} beds, ${orBackfilled} OR days recorded.`);
    } catch (err) {
      console.error(`[CumulativeService] Error backfilling month ${monthStr}:`, err);
    }

    return { bedsBackfilled, orBackfilled };
  }

  /**
   * Retrieves Month-To-Date bed occupancy aggregation, including live provisional today if requested.
   */
  async getBedMonthToDate(
    monthStr: string,
    liveRows?: any[][] | null,
    todayDateStr?: string
  ) {
    // If not yet backfilled in this process, trigger backfill in background
    if (!backfilledMonths.has(monthStr)) {
      this.backfillMonth(monthStr).catch(() => {});
    }

    const storedDays = await getDailyBedCensusForMonth(monthStr);

    let provisional: DailyBedCensus | null = null;
    if (
      todayDateStr &&
      todayDateStr.startsWith(monthStr) &&
      liveRows &&
      liveRows.length > 3
    ) {
      try {
        const liveCensus = computeOccupancyCensus(liveRows);
        provisional = {
          date: todayDateStr,
          inpatientOccupied: liveCensus.inpatientOccupied,
          inpatientCapacity: liveCensus.inpatientCapacity,
          totalOccupied: liveCensus.totalOccupied,
          totalCapacity: liveCensus.totalCapacity,
          zoneBreakdown: liveCensus.zones,
          source: 'provisional',
        };
      } catch (err) {
        console.warn('[CumulativeService] Failed to compute live provisional bed census:', err);
      }
    }

    const agg = aggregateBedMonth(monthStr, storedDays, provisional, todayDateStr);
    const finalizedSummary = await getMonthlyBedSummary(monthStr);

    return {
      ...agg,
      isFinalized: !!finalizedSummary,
      finalizedAt: finalizedSummary?.finalized_at || null,
    };
  }

  /**
   * Retrieves Month-To-Date OR utilization aggregation, including live provisional today if requested.
   */
  async getORMonthToDate(
    monthStr: string,
    liveOrList?: any[] | null,
    todayDateStr?: string
  ) {
    if (!backfilledMonths.has(monthStr)) {
      this.backfillMonth(monthStr).catch(() => {});
    }

    const storedDays = await getDailyORCensusForMonth(monthStr);

    let provisional: DailyORCensus | null = null;
    if (
      todayDateStr &&
      todayDateStr.startsWith(monthStr) &&
      liveOrList
    ) {
      try {
        provisional = computeORCensus(liveOrList, todayDateStr);
        provisional.source = 'provisional';
      } catch (err) {
        console.warn('[CumulativeService] Failed to compute live provisional OR census:', err);
      }
    }

    const agg = aggregateORMonth(monthStr, storedDays, provisional);
    const finalizedSummary = await getMonthlyORSummary(monthStr);

    return {
      ...agg,
      isFinalized: !!finalizedSummary,
      finalizedAt: finalizedSummary?.finalized_at || null,
    };
  }

  /**
   * Retrieves historical finalized bed monthly summaries.
   */
  async getBedHistory(limit = 12) {
    return await getMonthlyBedSummaries(limit);
  }

  /**
   * Retrieves historical finalized OR monthly summaries.
   */
  async getORHistory(limit = 12) {
    return await getMonthlyORSummaries(limit);
  }
}

export const cumulativeOccupancy = new CumulativeOccupancyService();
