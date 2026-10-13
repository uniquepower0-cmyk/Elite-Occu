import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';
import { DailyBedCensus } from './calculator.js';
import { DailyORCensus } from './orCalculator.js';

export class CumulativeOccupancyError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CumulativeOccupancyError';
  }
}

// Default service-role Supabase client
let defaultClient: SupabaseClient | null = null;

function getSupabaseClient(injectedClient?: SupabaseClient): SupabaseClient {
  if (injectedClient) return injectedClient;
  if (!defaultClient) {
    defaultClient = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey || 'missing-service-key-placeholder',
      {
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
  }
  return defaultClient;
}

// ==============================================================================
// BED CENSUS REPOSITORY
// ==============================================================================

export async function upsertDailyBedCensus(
  record: DailyBedCensus,
  client?: SupabaseClient
): Promise<void> {
  const sb = getSupabaseClient(client);
  const payload = {
    census_date: record.date,
    inpatient_occupied: record.inpatientOccupied,
    inpatient_capacity: record.inpatientCapacity,
    total_occupied: record.totalOccupied,
    total_capacity: record.totalCapacity,
    zone_breakdown: record.zoneBreakdown || [],
    source: record.source,
    captured_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('occupancy_daily_census')
    .upsert(payload, { onConflict: 'census_date' });

  if (error) {
    throw new CumulativeOccupancyError(`Failed to upsert daily bed census for ${record.date}`, error);
  }
}

export async function getDailyBedCensusForMonth(
  monthStr: string, // YYYY-MM
  client?: SupabaseClient
): Promise<DailyBedCensus[]> {
  const sb = getSupabaseClient(client);
  const startDate = `${monthStr}-01`;
  const endDate = `${monthStr}-31`;

  const { data, error } = await sb
    .from('occupancy_daily_census')
    .select('*')
    .gte('census_date', startDate)
    .lte('census_date', endDate)
    .order('census_date', { ascending: true });

  if (error) {
    throw new CumulativeOccupancyError(`Failed to query daily bed census for ${monthStr}`, error);
  }

  return (data || []).map((row: any) => ({
    date: row.census_date,
    inpatientOccupied: row.inpatient_occupied,
    inpatientCapacity: row.inpatient_capacity,
    totalOccupied: row.total_occupied,
    totalCapacity: row.total_capacity,
    zoneBreakdown: row.zone_breakdown,
    source: row.source,
    capturedAt: row.captured_at,
  }));
}

export async function insertMonthlyBedSummaryIfAbsent(
  summary: {
    month: string; // YYYY-MM
    daysInMonth: number;
    daysRecorded: number;
    missingDays: string[];
    inpatientPatientDays: number;
    inpatientBedDays: number;
    inpatientRate: number;
    totalPatientDays: number;
    totalBedDays: number;
    totalRate: number;
  },
  client?: SupabaseClient
): Promise<boolean> {
  const sb = getSupabaseClient(client);
  const monthDate = `${summary.month}-01`;
  const payload = {
    month: monthDate,
    days_in_month: summary.daysInMonth,
    days_recorded: summary.daysRecorded,
    missing_days: summary.missingDays,
    inpatient_patient_days: summary.inpatientPatientDays,
    inpatient_bed_days: summary.inpatientBedDays,
    inpatient_rate: summary.inpatientRate,
    total_patient_days: summary.totalPatientDays,
    total_bed_days: summary.totalBedDays,
    total_rate: summary.totalRate,
    finalized_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('occupancy_monthly_summary')
    .insert(payload)
    .select()
    .maybeSingle();

  if (error) {
    // If unique constraint violation, it was already finalized (write-once)
    if (error.code === '23505') {
      return false;
    }
    throw new CumulativeOccupancyError(`Failed to insert monthly bed summary for ${summary.month}`, error);
  }

  return true;
}

export async function getMonthlyBedSummaries(
  limit = 12,
  client?: SupabaseClient
): Promise<any[]> {
  const sb = getSupabaseClient(client);
  const { data, error } = await sb
    .from('occupancy_monthly_summary')
    .select('*')
    .order('month', { ascending: false })
    .limit(limit);

  if (error) {
    throw new CumulativeOccupancyError('Failed to fetch monthly bed summaries', error);
  }

  return data || [];
}

export async function getMonthlyBedSummary(
  monthStr: string,
  client?: SupabaseClient
): Promise<any | null> {
  const sb = getSupabaseClient(client);
  const monthDate = `${monthStr}-01`;
  const { data, error } = await sb
    .from('occupancy_monthly_summary')
    .select('*')
    .eq('month', monthDate)
    .maybeSingle();

  if (error) {
    throw new CumulativeOccupancyError(`Failed to fetch monthly bed summary for ${monthStr}`, error);
  }

  return data;
}

// ==============================================================================
// OR CENSUS REPOSITORY
// ==============================================================================

export async function upsertDailyORCensus(
  record: DailyORCensus,
  client?: SupabaseClient
): Promise<void> {
  const sb = getSupabaseClient(client);
  const payload = {
    census_date: record.date,
    rooms_available: record.roomsAvailable,
    minutes_per_room: record.minutesPerRoom,
    booked_minutes: record.bookedMinutes,
    rooms_used: record.roomsUsed,
    cases_total: record.casesTotal,
    dc_count: record.dcCount,
    hc_count: record.hcCount,
    in_count: record.inCount,
    out_count: record.outCount,
    sicu_count: record.sicuCount,
    excluded_cases: record.excludedCases,
    room_breakdown: record.roomBreakdown || {},
    source: record.source,
    captured_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('or_daily_census')
    .upsert(payload, { onConflict: 'census_date' });

  if (error) {
    throw new CumulativeOccupancyError(`Failed to upsert daily OR census for ${record.date}`, error);
  }
}

export async function getDailyORCensusForMonth(
  monthStr: string, // YYYY-MM
  client?: SupabaseClient
): Promise<DailyORCensus[]> {
  const sb = getSupabaseClient(client);
  const startDate = `${monthStr}-01`;
  const endDate = `${monthStr}-31`;

  const { data, error } = await sb
    .from('or_daily_census')
    .select('*')
    .gte('census_date', startDate)
    .lte('census_date', endDate)
    .order('census_date', { ascending: true });

  if (error) {
    throw new CumulativeOccupancyError(`Failed to query daily OR census for ${monthStr}`, error);
  }

  return (data || []).map((row: any) => ({
    date: row.census_date,
    roomsAvailable: row.rooms_available,
    minutesPerRoom: row.minutes_per_room,
    bookedMinutes: row.booked_minutes,
    roomsUsed: row.rooms_used,
    casesTotal: row.cases_total,
    dcCount: row.dc_count,
    hcCount: row.hc_count,
    inCount: row.in_count,
    outCount: row.out_count,
    sicuCount: row.sicu_count,
    excludedCases: row.excluded_cases,
    roomBreakdown: row.room_breakdown || {},
    source: row.source,
    capturedAt: row.captured_at,
  }));
}

export async function insertMonthlyORSummaryIfAbsent(
  summary: {
    month: string; // YYYY-MM
    daysInMonth: number;
    daysRecorded: number;
    bookedMinutes: number;
    availableMinutes: number;
    timeUtilization: number;
    roomDaysUsed: number;
    roomDaysAvailable: number;
    roomUtilization: number;
    casesTotal: number;
    dcCount: number;
    hcCount: number;
    inCount: number;
    outCount: number;
    sicuCount: number;
  },
  client?: SupabaseClient
): Promise<boolean> {
  const sb = getSupabaseClient(client);
  const monthDate = `${summary.month}-01`;
  const payload = {
    month: monthDate,
    days_in_month: summary.daysInMonth,
    days_recorded: summary.daysRecorded,
    booked_minutes: summary.bookedMinutes,
    available_minutes: summary.availableMinutes,
    time_utilization: summary.timeUtilization,
    room_days_used: summary.roomDaysUsed,
    room_days_available: summary.roomDaysAvailable,
    room_utilization: summary.roomUtilization,
    cases_total: summary.casesTotal,
    dc_count: summary.dcCount,
    hc_count: summary.hcCount,
    in_count: summary.inCount,
    out_count: summary.outCount,
    sicu_count: summary.sicuCount,
    finalized_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('or_monthly_summary')
    .insert(payload)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      return false; // already finalized
    }
    throw new CumulativeOccupancyError(`Failed to insert monthly OR summary for ${summary.month}`, error);
  }

  return true;
}

export async function getMonthlyORSummaries(
  limit = 12,
  client?: SupabaseClient
): Promise<any[]> {
  const sb = getSupabaseClient(client);
  const { data, error } = await sb
    .from('or_monthly_summary')
    .select('*')
    .order('month', { ascending: false })
    .limit(limit);

  if (error) {
    throw new CumulativeOccupancyError('Failed to fetch monthly OR summaries', error);
  }

  return data || [];
}

export async function getMonthlyORSummary(
  monthStr: string,
  client?: SupabaseClient
): Promise<any | null> {
  const sb = getSupabaseClient(client);
  const monthDate = `${monthStr}-01`;
  const { data, error } = await sb
    .from('or_monthly_summary')
    .select('*')
    .eq('month', monthDate)
    .maybeSingle();

  if (error) {
    throw new CumulativeOccupancyError(`Failed to fetch monthly OR summary for ${monthStr}`, error);
  }

  return data;
}
