import { OR_CAPACITY } from './config.js';
import { daysInMonth, listMonthDates } from './calculator.js';

export interface DailyORCensus {
  date: string; // YYYY-MM-DD
  roomsAvailable: number;
  minutesPerRoom: number;
  bookedMinutes: number;
  roomsUsed: number;
  casesTotal: number;
  dcCount: number;
  hcCount: number;
  inCount: number;
  outCount: number;
  sicuCount: number;
  excludedCases: number;
  roomBreakdown: Record<string, { minutes: number; cases: number }>;
  source: 'rollover' | 'backfill' | 'manual' | 'provisional';
  capturedAt?: string;
}

export interface ORMonthAggregation {
  month: string; // YYYY-MM
  daysInMonth: number;
  daysRecorded: number;
  includesProvisional: boolean;
  bookedMinutes: number;
  availableMinutes: number;
  timeUtilization: number; // percentage
  roomDaysUsed: number;
  roomDaysAvailable: number;
  roomUtilization: number; // percentage
  casesTotal: number;
  dcCount: number;
  hcCount: number;
  inCount: number;
  outCount: number;
  sicuCount: number;
  roomBreakdown: Record<string, { minutes: number; cases: number }>;
  days: DailyORCensus[];
}

/**
 * Normalizes an OR room name to standard 'OR-1' ... 'OR-7'.
 * Returns null if not a recognized OR room.
 */
export function normalizeOrRoom(rawRoom: string | null | undefined): string | null {
  if (!rawRoom) return null;
  const s = String(rawRoom).trim().toUpperCase();
  // Match patterns like "OR - 1", "OR -1", "OR 1", "OR-1", "OR1"
  const match = s.match(/\bOR\s*[-–—]?\s*([1-7])\b/i);
  if (match) {
    return `OR-${match[1]}`;
  }
  return null;
}

/**
 * Parses a clock string (e.g. '9:30AM', '06:30 PM', '14:20', '7:00') into minute of day (0..1439).
 */
export function parseClockToMinutes(clockStr: string | null | undefined): number | null {
  if (!clockStr) return null;
  const s = String(clockStr).trim();
  const match = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3]?.toUpperCase();

  if (minutes < 0 || minutes >= 60) return null;

  if (ampm) {
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
  }

  if (hours < 0 || hours >= 24) return null;
  return hours * 60 + minutes;
}

/**
 * Merges overlapping and adjacent intervals [start, end] and returns total minutes.
 * Expects intervals where end > start.
 */
export function mergeIntervals(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;

  // Sort intervals by start time, then end time
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let totalMinutes = 0;
  let curStart = sorted[0][0];
  let curEnd = sorted[0][1];

  for (let i = 1; i < sorted.length; i++) {
    const [nextStart, nextEnd] = sorted[i];
    if (nextStart <= curEnd) {
      // Overlap or touch: extend current interval
      if (nextEnd > curEnd) {
        curEnd = nextEnd;
      }
    } else {
      // Disjoint: commit current interval and start new
      totalMinutes += (curEnd - curStart);
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  totalMinutes += (curEnd - curStart);
  return totalMinutes;
}

/**
 * Checks if a patient record is a Doctor Case (DC).
 */
export function isDoctorCase(caseItem: any): boolean {
  if (!caseItem) return false;
  const vt = String(caseItem.vt || caseItem.type || '').toUpperCase().trim();
  if (vt === 'DC' || vt === 'DOCTOR CASE') return true;
  const combined = `${caseItem.financialStatus || ''} ${caseItem.column3 || ''} ${caseItem.paidBy || ''}`.toUpperCase();
  if (combined.includes('DOCTOR CASE')) return true;
  return false;
}

/**
 * Computes the daily OR census for a single day given its OR list cases and occupancy context.
 */
export function computeORCensus(
  orList: any[] | null | undefined,
  dateStr: string,
  capacity = OR_CAPACITY
): DailyORCensus {
  const list = Array.isArray(orList) ? orList : [];
  const roomsAvailable = capacity.rooms.length;
  const minutesPerRoom = capacity.minutesPerRoomPerDay;

  // Initialize room records
  const roomIntervals: Record<string, [number, number][]> = {};
  const roomBreakdown: Record<string, { minutes: number; cases: number }> = {};
  for (const r of capacity.rooms) {
    roomIntervals[r] = [];
    roomBreakdown[r] = { minutes: 0, cases: 0 };
  }

  let dcCount = 0;
  let hcCount = 0;
  let inCount = 0;
  let outCount = 0;
  let sicuCount = 0;
  let excludedCases = 0;

  for (const c of list) {
    // 1. Case Type (DC vs HC)
    if (isDoctorCase(c)) {
      dcCount++;
    } else {
      hcCount++;
    }

    // 2. Admission Status (IN vs OUT)
    const statusVal = String(c.realStatus || c.column3 || c.vt || '').toUpperCase().trim();
    const combinedStatus = `${c.column3 || ''} ${c.vt || ''} ${c.postC || ''} ${c.flClassName || ''}`.toUpperCase();
    if (statusVal.includes('IN') || (combinedStatus.includes('IN') && !combinedStatus.includes('OUT'))) {
      inCount++;
    } else {
      outCount++;
    }

    // 3. SICU status
    const postC = String(c.postC || c.postOp || '').toUpperCase();
    if (postC.includes('SICU')) {
      sicuCount++;
    }

    // 4. Room & Time Calculation
    const roomKey = normalizeOrRoom(c.orRoom);
    if (!roomKey || !roomIntervals[roomKey]) {
      excludedCases++;
      continue;
    }

    roomBreakdown[roomKey].cases++;

    const startMin = parseClockToMinutes(c.startTime);
    const endMin = parseClockToMinutes(c.endTime);

    if (startMin === null || endMin === null) {
      excludedCases++;
      continue;
    }

    // Handle crossover past midnight (e.g. 23:00 -> 01:30)
    let effEnd = endMin;
    if (effEnd < startMin) {
      effEnd += 1440;
    } else if (effEnd === startMin) {
      // 0 duration
      continue;
    }

    roomIntervals[roomKey].push([startMin, effEnd]);
  }

  // Calculate booked minutes per room by merging intervals
  let totalBookedMinutes = 0;
  let roomsUsedCount = 0;

  for (const r of capacity.rooms) {
    const rawMinutes = mergeIntervals(roomIntervals[r]);
    // Cap at the maximum minutes allowed per room (1440 for 24h)
    const cappedMinutes = Math.min(rawMinutes, minutesPerRoom);
    roomBreakdown[r].minutes = cappedMinutes;
    totalBookedMinutes += cappedMinutes;

    if (cappedMinutes > 0 || roomBreakdown[r].cases > 0) {
      roomsUsedCount++;
    }
  }

  return {
    date: dateStr,
    roomsAvailable,
    minutesPerRoom,
    bookedMinutes: totalBookedMinutes,
    roomsUsed: roomsUsedCount,
    casesTotal: list.length,
    dcCount,
    hcCount,
    inCount,
    outCount,
    sicuCount,
    excludedCases,
    roomBreakdown,
    source: 'rollover',
  };
}

/**
 * Aggregates daily OR census records into a month-to-date summary.
 */
export function aggregateORMonth(
  monthStr: string,
  storedDays: DailyORCensus[],
  provisional?: DailyORCensus | null,
  capacity = OR_CAPACITY
): ORMonthAggregation {
  const totalDaysInMonth = daysInMonth(monthStr);

  const daysMap = new Map<string, DailyORCensus>();
  for (const day of storedDays) {
    if (day.date.startsWith(monthStr)) {
      daysMap.set(day.date, day);
    }
  }

  let includesProvisional = false;
  if (provisional && provisional.date.startsWith(monthStr)) {
    const existing = daysMap.get(provisional.date);
    if (!existing) {
      daysMap.set(provisional.date, { ...provisional, source: 'provisional' });
      includesProvisional = true;
    } else if (existing.source === 'provisional') {
      // Pick peak OR utilization between existing provisional and new live provisional
      const peakBookedMinutes = Math.max(existing.bookedMinutes || 0, provisional.bookedMinutes || 0);
      const peakCases = Math.max(existing.casesTotal || 0, provisional.casesTotal || 0);
      const peakRooms = Math.max(existing.roomsUsed || 0, provisional.roomsUsed || 0);
      const useProvisional = (provisional.bookedMinutes || 0) >= (existing.bookedMinutes || 0);

      daysMap.set(provisional.date, {
        ...(useProvisional ? provisional : existing),
        bookedMinutes: peakBookedMinutes,
        casesTotal: peakCases,
        roomsUsed: peakRooms,
        dcCount: Math.max(existing.dcCount || 0, provisional.dcCount || 0),
        hcCount: Math.max(existing.hcCount || 0, provisional.hcCount || 0),
        inCount: Math.max(existing.inCount || 0, provisional.inCount || 0),
        outCount: Math.max(existing.outCount || 0, provisional.outCount || 0),
        sicuCount: Math.max(existing.sicuCount || 0, provisional.sicuCount || 0),
        source: 'provisional',
      });
      includesProvisional = true;
    }
  }

  const combinedDays = Array.from(daysMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  let bookedMinutes = 0;
  let availableMinutes = 0;
  let roomDaysUsed = 0;
  let roomDaysAvailable = 0;
  let casesTotal = 0;
  let dcCount = 0;
  let hcCount = 0;
  let inCount = 0;
  let outCount = 0;
  let sicuCount = 0;

  const roomTotals: Record<string, { minutes: number; cases: number }> = {};
  for (const r of capacity.rooms) {
    roomTotals[r] = { minutes: 0, cases: 0 };
  }

  for (const d of combinedDays) {
    const roomsAvail = d.roomsAvailable || capacity.rooms.length;
    const minPerRoom = d.minutesPerRoom || capacity.minutesPerRoomPerDay;

    bookedMinutes += (d.bookedMinutes || 0);
    availableMinutes += (roomsAvail * minPerRoom);
    roomDaysUsed += (d.roomsUsed || 0);
    roomDaysAvailable += roomsAvail;

    casesTotal += (d.casesTotal || 0);
    dcCount += (d.dcCount || 0);
    hcCount += (d.hcCount || 0);
    inCount += (d.inCount || 0);
    outCount += (d.outCount || 0);
    sicuCount += (d.sicuCount || 0);

    if (d.roomBreakdown) {
      for (const [r, stat] of Object.entries(d.roomBreakdown)) {
        if (!roomTotals[r]) roomTotals[r] = { minutes: 0, cases: 0 };
        roomTotals[r].minutes += (stat.minutes || 0);
        roomTotals[r].cases += (stat.cases || 0);
      }
    }
  }

  const timeUtilization = availableMinutes > 0
    ? Math.round((bookedMinutes / availableMinutes) * 10000) / 100
    : 0;

  const roomUtilization = roomDaysAvailable > 0
    ? Math.round((roomDaysUsed / roomDaysAvailable) * 10000) / 100
    : 0;

  return {
    month: monthStr,
    daysInMonth: totalDaysInMonth,
    daysRecorded: combinedDays.length,
    includesProvisional,
    bookedMinutes,
    availableMinutes,
    timeUtilization,
    roomDaysUsed,
    roomDaysAvailable,
    roomUtilization,
    casesTotal,
    dcCount,
    hcCount,
    inCount,
    outCount,
    sicuCount,
    roomBreakdown: roomTotals,
    days: combinedDays,
  };
}
