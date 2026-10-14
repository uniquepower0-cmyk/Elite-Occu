export interface DailyBedCensus {
  date: string; // YYYY-MM-DD
  inpatientOccupied: number;
  inpatientCapacity: number;
  totalOccupied: number;
  totalCapacity: number;
  zoneBreakdown?: any[];
  source: 'rollover' | 'backfill' | 'manual' | 'provisional';
  capturedAt?: string;
}

export interface BedMonthAggregation {
  month: string; // YYYY-MM
  daysInMonth: number;
  daysRecorded: number;
  missingDays: string[];
  includesProvisional: boolean;
  inpatient: {
    patientDays: number;
    bedDays: number;
    rate: number; // percentage, e.g. 84.32
  };
  total: {
    patientDays: number;
    bedDays: number;
    rate: number; // percentage
  };
  days: DailyBedCensus[];
}

/**
 * Returns number of days in the specified month 'YYYY-MM'.
 */
export function daysInMonth(monthStr: string): number {
  const [yearStr, mStr] = monthStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(mStr, 10);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Checks if the given ISO date string 'YYYY-MM-DD' is the last calendar day of its month.
 */
export function isLastDayOfMonth(isoDate: string): boolean {
  const [yearStr, mStr, dStr] = isoDate.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(mStr, 10);
  const day = parseInt(dStr, 10);
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === totalDays;
}

/**
 * Returns all ISO dates 'YYYY-MM-DD' in the month.
 */
export function listMonthDates(monthStr: string): string[] {
  const count = daysInMonth(monthStr);
  const dates: string[] = [];
  for (let d = 1; d <= count; d++) {
    const pad = d < 10 ? `0${d}` : `${d}`;
    dates.push(`${monthStr}-${pad}`);
  }
  return dates;
}

/**
 * Aggregates daily bed census records into month-to-date summary.
 * If provisional day is provided and not already in stored days, it is appended.
 */
export function aggregateBedMonth(
  monthStr: string,
  storedDays: DailyBedCensus[],
  provisional?: DailyBedCensus | null,
  upToDateStr?: string
): BedMonthAggregation {
  const totalDaysInMonth = daysInMonth(monthStr);
  
  // Combine stored and provisional without duplicating dates
  const daysMap = new Map<string, DailyBedCensus>();
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
      // Pick peak occupancy between existing provisional and new live provisional
      const peakInpatient = Math.max(existing.inpatientOccupied || 0, provisional.inpatientOccupied || 0);
      const peakTotal = Math.max(existing.totalOccupied || 0, provisional.totalOccupied || 0);
      const useProvisional = (provisional.inpatientOccupied || 0) >= (existing.inpatientOccupied || 0);

      daysMap.set(provisional.date, {
        date: provisional.date,
        inpatientOccupied: peakInpatient,
        inpatientCapacity: useProvisional ? provisional.inpatientCapacity : existing.inpatientCapacity,
        totalOccupied: peakTotal,
        totalCapacity: useProvisional ? provisional.totalCapacity : existing.totalCapacity,
        zoneBreakdown: useProvisional ? provisional.zoneBreakdown : existing.zoneBreakdown,
        source: 'provisional',
      });
      includesProvisional = true;
    }
  }

  const combinedDays = Array.from(daysMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Determine which days should have records up to now
  const allMonthDates = listMonthDates(monthStr);
  const cutoffDate = upToDateStr && upToDateStr.startsWith(monthStr)
    ? upToDateStr
    : (combinedDays.length > 0 ? combinedDays[combinedDays.length - 1].date : `${monthStr}-01`);

  const missingDays = allMonthDates.filter(d => d <= cutoffDate && !daysMap.has(d));

  let inpatientPatientDays = 0;
  let inpatientBedDays = 0;
  let totalPatientDays = 0;
  let totalBedDays = 0;

  for (const d of combinedDays) {
    inpatientPatientDays += (d.inpatientOccupied || 0);
    inpatientBedDays += (d.inpatientCapacity || 0);
    totalPatientDays += (d.totalOccupied || 0);
    totalBedDays += (d.totalCapacity || 0);
  }

  const calcRate = (occupied: number, capacity: number): number => {
    if (capacity <= 0) return 0;
    return Math.round((occupied / capacity) * 10000) / 100;
  };

  return {
    month: monthStr,
    daysInMonth: totalDaysInMonth,
    daysRecorded: combinedDays.length,
    missingDays,
    includesProvisional,
    inpatient: {
      patientDays: inpatientPatientDays,
      bedDays: inpatientBedDays,
      rate: calcRate(inpatientPatientDays, inpatientBedDays),
    },
    total: {
      patientDays: totalPatientDays,
      bedDays: totalBedDays,
      rate: calcRate(totalPatientDays, totalBedDays),
    },
    days: combinedDays,
  };
}
