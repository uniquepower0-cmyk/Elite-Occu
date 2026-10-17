import {
  computeOccupancyCensus,
  filterPatientData,
  cleanRoomStr,
  OccupancyCensusResult,
  ZoneStats,
} from '../../src/logic/occupancy.js';
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
  getDailyBedCensus,
  getDailyBedCensusForMonth,
  getDailyORCensus,
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
   * Records peak daily bed census for a hospital date by detecting the maximum admitted patients
   * across active occupants, patients discharged today, and existing daytime database records.
   * Guarantees that evening discharges do not downgrade the true peak of the day at rollover.
   */
  async recordPeakBedCensus(
    dateStr: string,
    rawRows: any[][] | null | undefined,
    dischargedPatients?: any[] | null,
    source: 'rollover' | 'backfill' | 'manual' | 'provisional' = 'rollover'
  ): Promise<DailyBedCensus | null> {
    const hasRawRows = Array.isArray(rawRows) && rawRows.length > 0;
    let activeCensus: OccupancyCensusResult | null = null;
    if (hasRawRows) {
      try {
        activeCensus = computeOccupancyCensus(rawRows!);
      } catch (e) {
        console.warn(`[CumulativeService] Notice computing active census for ${dateStr}:`, e);
      }
    }

    // Build combined rows taking into account patients discharged on this date
    let combinedCensus: OccupancyCensusResult | null = null;
    if (Array.isArray(dischargedPatients) && dischargedPatients.length > 0) {
      try {
        const activeFiltered = hasRawRows ? filterPatientData(rawRows!) : [];
        const occupiedRooms = new Set(activeFiltered.map(p => cleanRoomStr(p.room).toUpperCase()));
        const activeNames = new Set(activeFiltered.map(p => (p.name || '').trim().toLowerCase()));

        const additionalRows: any[][] = [];
        for (const dp of dischargedPatients) {
          const rawRoom = dp.room || dp.lastRoom || dp.colA || '';
          const room = cleanRoomStr(String(rawRoom || '').trim());
          const name = String(dp.name || dp.patientName || dp.colB || dp.colD || '').trim();
          if (!room || !name) continue;

          if (activeNames.has(name.toLowerCase())) continue;
          if (occupiedRooms.has(room.toUpperCase())) continue;

          // Room was occupied earlier today by an inpatient who discharged before rollover
          occupiedRooms.add(room.toUpperCase());
          activeNames.add(name.toLowerCase());
          additionalRows.push([
            room,
            name,
            dp.doctor || dp.physician || '',
            dp.payment || dp.contractor || '',
            dp.date || dp.dischargeDate || '',
          ]);
        }

        if (additionalRows.length > 0 || hasRawRows) {
          const baseRows = hasRawRows ? rawRows! : [];
          combinedCensus = computeOccupancyCensus([...baseRows, ...additionalRows]);
        }
      } catch (e) {
        console.warn(`[CumulativeService] Notice computing combined census for ${dateStr}:`, e);
      }
    }

    let existing: DailyBedCensus | null = null;
    try {
      existing = await getDailyBedCensus(dateStr);
    } catch (err) {
      console.warn(`[CumulativeService] Notice fetching existing bed census for ${dateStr}:`, err);
    }

    // Determine peak counts across active, combined, and existing records
    const activeInpatient = activeCensus?.inpatientOccupied || 0;
    const combinedInpatient = combinedCensus?.inpatientOccupied || 0;
    const existingInpatient = existing?.inpatientOccupied || 0;

    const activeTotal = activeCensus?.totalOccupied || 0;
    const combinedTotal = combinedCensus?.totalOccupied || 0;
    const existingTotal = existing?.totalOccupied || 0;

    const peakInpatient = Math.max(activeInpatient, combinedInpatient, existingInpatient);
    const peakTotal = Math.max(activeTotal, combinedTotal, existingTotal);

    if (peakInpatient === 0 && peakTotal === 0 && !existing) {
      console.warn(`[CumulativeService] recordPeakBedCensus skipped for ${dateStr}: empty counts and no existing record`);
      return null;
    }

    // Choose the breakdown that corresponds to the peak
    let chosenZones: ZoneStats[] = [];
    let chosenInpatientCap = activeCensus?.inpatientCapacity || existing?.inpatientCapacity || 68;
    let chosenTotalCap = activeCensus?.totalCapacity || existing?.totalCapacity || 110;

    if (combinedInpatient === peakInpatient && combinedCensus) {
      chosenZones = combinedCensus.zones;
      chosenInpatientCap = combinedCensus.inpatientCapacity;
      chosenTotalCap = combinedCensus.totalCapacity;
    } else if (activeInpatient === peakInpatient && activeCensus) {
      chosenZones = activeCensus.zones;
      chosenInpatientCap = activeCensus.inpatientCapacity;
      chosenTotalCap = activeCensus.totalCapacity;
    } else if (existing) {
      chosenZones = existing.zoneBreakdown || [];
      chosenInpatientCap = existing.inpatientCapacity;
      chosenTotalCap = existing.totalCapacity;
    }

    const record: DailyBedCensus = {
      date: dateStr,
      inpatientOccupied: peakInpatient,
      inpatientCapacity: chosenInpatientCap,
      totalOccupied: peakTotal,
      totalCapacity: chosenTotalCap,
      zoneBreakdown: chosenZones,
      source: source === 'rollover' ? 'rollover' : (existing?.source === 'rollover' ? 'rollover' : source),
    };

    await upsertDailyBedCensus(record);
    console.log(`[CumulativeService] Peak bed census recorded for ${dateStr} (${record.inpatientOccupied}/${record.inpatientCapacity} inpatient, ${record.totalOccupied}/${record.totalCapacity} total, source: ${record.source})`);
    return record;
  }

  /**
   * Records peak daily OR census for a closing date, preserving maximum booked minutes,
   * rooms used, and total cases across daytime updates and rollover.
   */
  async recordPeakORCensus(
    dateStr: string,
    orList: any[] | null | undefined,
    source: 'rollover' | 'backfill' | 'manual' | 'provisional' = 'rollover'
  ): Promise<DailyORCensus> {
    const candidate = computeORCensus(orList, dateStr);
    candidate.source = source;

    let existing: DailyORCensus | null = null;
    try {
      existing = await getDailyORCensus(dateStr);
    } catch (err) {
      console.warn(`[CumulativeService] Notice checking existing OR census for ${dateStr}:`, err);
    }

    let finalRecord: DailyORCensus;
    if (!existing) {
      finalRecord = candidate;
    } else {
      const candidateHigher =
        (candidate.bookedMinutes > existing.bookedMinutes) ||
        (candidate.bookedMinutes === existing.bookedMinutes && candidate.casesTotal > existing.casesTotal);

      if (candidateHigher) {
        finalRecord = {
          ...candidate,
          roomsUsed: Math.max(candidate.roomsUsed, existing.roomsUsed),
          casesTotal: Math.max(candidate.casesTotal, existing.casesTotal),
          bookedMinutes: Math.max(candidate.bookedMinutes, existing.bookedMinutes),
          dcCount: Math.max(candidate.dcCount, existing.dcCount),
          hcCount: Math.max(candidate.hcCount, existing.hcCount),
          inCount: Math.max(candidate.inCount, existing.inCount),
          outCount: Math.max(candidate.outCount, existing.outCount),
          sicuCount: Math.max(candidate.sicuCount, existing.sicuCount),
          source: source === 'rollover' ? 'rollover' : (existing.source === 'rollover' ? 'rollover' : source),
        };
      } else {
        finalRecord = {
          ...existing,
          roomsUsed: Math.max(candidate.roomsUsed, existing.roomsUsed),
          casesTotal: Math.max(candidate.casesTotal, existing.casesTotal),
          bookedMinutes: Math.max(candidate.bookedMinutes, existing.bookedMinutes),
          dcCount: Math.max(candidate.dcCount, existing.dcCount),
          hcCount: Math.max(candidate.hcCount, existing.hcCount),
          inCount: Math.max(candidate.inCount, existing.inCount),
          outCount: Math.max(candidate.outCount, existing.outCount),
          sicuCount: Math.max(candidate.sicuCount, existing.sicuCount),
          source: source === 'rollover' ? 'rollover' : existing.source,
        };
      }
    }

    await upsertDailyORCensus(finalRecord);
    console.log(`[CumulativeService] Peak OR census recorded for ${dateStr} (${finalRecord.bookedMinutes} booked mins, ${finalRecord.roomsUsed}/${finalRecord.roomsAvailable} rooms, ${finalRecord.casesTotal} cases, source: ${finalRecord.source})`);
    return finalRecord;
  }

  /**
   * Records the official daily bed census for a closing hospital date.
   * Delegates to recordPeakBedCensus to preserve peak occupancy.
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
    return this.recordPeakBedCensus(dateStr, rawRows, null, source);
  }

  /**
   * Records the official daily OR census for a closing date.
   * Delegates to recordPeakORCensus to preserve peak utilization.
   */
  async recordORCensus(
    dateStr: string,
    orList: any[] | null | undefined,
    source: 'rollover' | 'backfill' | 'manual' = 'rollover'
  ): Promise<DailyORCensus> {
    return this.recordPeakORCensus(dateStr, orList, source);
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
   * Safeguard invoked BEFORE a historical date's raw snapshot is evicted by the 30-day
   * retention policy. Ensures that the date's bed occupancy census and OR utilization census
   * are recorded in `occupancy_daily_census` and `or_daily_census` so Month-to-Date and
   * monthly cumulative analytics never lose any historical day's metrics.
   */
  async ensureDateCensusRecorded(dateStr: string): Promise<void> {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

    // 1. Ensure Bed Census is recorded
    try {
      const existingBed = await getDailyBedCensus(dateStr);
      if (!existingBed || (existingBed.totalOccupied > 0 && existingBed.inpatientOccupied === 0)) {
        const snap = await getOccupancySnapshot(dateStr);
        if (snap && snap.hospitalData && snap.hospitalData.length > 3) {
          await this.recordPeakBedCensus(
            dateStr,
            snap.hospitalData,
            snap.cumulativeDischarged || [],
            'backfill'
          );
        }
      }
    } catch (bedErr) {
      console.warn(`[CumulativeService] Pre-eviction bed census safeguard notice for ${dateStr}:`, bedErr);
    }

    // 2. Ensure OR Census is recorded
    try {
      const existingOR = await getDailyORCensus(dateStr);
      if (!existingOR) {
        const orSnap = await getORSnapshot(dateStr);
        if (orSnap && Array.isArray(orSnap.orList) && orSnap.orList.length > 0) {
          await this.recordPeakORCensus(dateStr, orSnap.orList, 'backfill');
        }
      }
    } catch (orErr) {
      console.warn(`[CumulativeService] Pre-eviction OR census safeguard notice for ${dateStr}:`, orErr);
    }
  }

  /**
   * Auto-backfills a month using historical snapshots on disk or Supabase.
   * Preserves existing cumulative daily census records if raw snapshots were already pruned
   * by the 30-day retention policy.
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
      // Valid records that are not corrupted (totalOccupied > 0 while inpatientOccupied == 0)
      const validBedMap = new Map(
        storedBeds
          .filter(b => b.inpatientOccupied > 0 || (b.totalOccupied === 0 && b.inpatientOccupied === 0))
          .map(b => [b.date, b])
      );
      const existingBedDates = force
        ? new Set<string>()
        : new Set(validBedMap.keys());

      const storedOR = await getDailyORCensusForMonth(monthStr);
      const validORMap = new Map(storedOR.map(o => [o.date, o]));
      const existingORDates = force ? new Set<string>() : new Set(validORMap.keys());

      const dates = listMonthDates(monthStr);

      for (const d of dates) {
        // 1. Backfill Beds
        if (!existingBedDates.has(d)) {
          try {
            const snap = await getOccupancySnapshot(d);
            if (snap && snap.hospitalData && snap.hospitalData.length > 3) {
              const rec = await this.recordPeakBedCensus(d, snap.hospitalData, snap.cumulativeDischarged || [], 'backfill');
              if (rec) bedsBackfilled++;
            }
          } catch (snapErr) {
            // Ignore snapshot fetch error for individual day
          }
        }

        // 2. Backfill OR (Never overwrite an already recorded OR census with 0 if raw snapshot was pruned after 30 days)
        if (!existingORDates.has(d)) {
          try {
            const orSnap = await getORSnapshot(d);
            if (orSnap && Array.isArray(orSnap.orList)) {
              await this.recordORCensus(d, orSnap.orList, 'backfill');
              orBackfilled++;
            } else if (!validORMap.has(d)) {
              // Calendar-day rule: only record 0 minutes if no OR census record exists yet for this date
              await this.recordORCensus(d, [], 'backfill');
              orBackfilled++;
            }
          } catch (orSnapErr) {
            if (!validORMap.has(d)) {
              await this.recordORCensus(d, [], 'backfill');
              orBackfilled++;
            }
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
    todayDateStr?: string,
    dischargedPatients?: any[] | null
  ) {
    let storedDays = await getDailyBedCensusForMonth(monthStr);
    const hasCorruptDays = storedDays.some(b => b.totalOccupied > 0 && b.inpatientOccupied === 0);

    // If not yet backfilled in this process or has corrupted 0-inpatient days, run backfill
    if (!backfilledMonths.has(monthStr) || hasCorruptDays) {
      await this.backfillMonth(monthStr, hasCorruptDays);
      storedDays = await getDailyBedCensusForMonth(monthStr);
    }

    let provisional: DailyBedCensus | null = null;
    if (
      todayDateStr &&
      todayDateStr.startsWith(monthStr)
    ) {
      try {
        const hasLiveRows = liveRows && liveRows.length > 3;
        const activeFiltered = hasLiveRows ? filterPatientData(liveRows!) : [];
        const occupiedRooms = new Set(activeFiltered.map(p => cleanRoomStr(p.room).toUpperCase()));
        const activeNames = new Set(activeFiltered.map(p => (p.name || '').trim().toLowerCase()));

        const additionalRows: any[][] = [];
        if (Array.isArray(dischargedPatients)) {
          for (const dp of dischargedPatients) {
            const rawRoom = dp.room || dp.lastRoom || dp.colA || '';
            const room = cleanRoomStr(String(rawRoom || '').trim());
            const name = String(dp.name || dp.patientName || dp.colB || dp.colD || '').trim();
            if (!room || !name) continue;
            if (activeNames.has(name.toLowerCase())) continue;
            if (occupiedRooms.has(room.toUpperCase())) continue;

            occupiedRooms.add(room.toUpperCase());
            activeNames.add(name.toLowerCase());
            additionalRows.push([
              room,
              name,
              dp.doctor || dp.physician || '',
              dp.payment || dp.contractor || '',
              dp.date || dp.dischargeDate || '',
            ]);
          }
        }

        const combinedRows = [...(hasLiveRows ? liveRows! : []), ...additionalRows];
        if (combinedRows.length > 3) {
          const liveCensus = computeOccupancyCensus(combinedRows);
          provisional = {
            date: todayDateStr,
            inpatientOccupied: liveCensus.inpatientOccupied,
            inpatientCapacity: liveCensus.inpatientCapacity,
            totalOccupied: liveCensus.totalOccupied,
            totalCapacity: liveCensus.totalCapacity,
            zoneBreakdown: liveCensus.zones,
            source: 'provisional',
          };
        }
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
