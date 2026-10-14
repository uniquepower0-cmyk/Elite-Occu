import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CumulativeOccupancyService } from './service.js';
import * as repo from './repository.js';
import * as hist from '../../historyManager.js';

describe('CumulativeOccupancyService', () => {
  let service: CumulativeOccupancyService;

  beforeEach(() => {
    service = new CumulativeOccupancyService();
    vi.restoreAllMocks();
    vi.spyOn(repo, 'getDailyBedCensus').mockResolvedValue(null);
    vi.spyOn(repo, 'getDailyORCensus').mockResolvedValue(null);
  });

  it('records bed census and calls repository upsert', async () => {
    const upsertSpy = vi.spyOn(repo, 'upsertDailyBedCensus').mockResolvedValue();

    const rawRows = [
      ['Title'], ['Sub'], ['Headers'],
      ['101', 'Patient A', 'Doctor', 'Cash', '10/01/26'],
      ['301', 'Patient B', 'Doctor', 'Insured', '10/01/26'],
    ];

    const result = await service.recordBedCensus('2026-10-13', rawRows, 'rollover');
    expect(result).not.toBeNull();
    expect(result?.date).toBe('2026-10-13');
    expect(result?.source).toBe('rollover');
    expect(result?.inpatientOccupied).toBe(2);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves higher daytime peak during rollover instead of lower midnight count', async () => {
    const upsertSpy = vi.spyOn(repo, 'upsertDailyBedCensus').mockResolvedValue();
    // Simulate daytime peak already recorded with 85 inpatients
    vi.spyOn(repo, 'getDailyBedCensus').mockResolvedValue({
      date: '2026-10-13',
      inpatientOccupied: 85,
      inpatientCapacity: 68,
      totalOccupied: 100,
      totalCapacity: 110,
      zoneBreakdown: [],
      source: 'provisional',
    });

    // At rollover (midnight), only 40 patients remain active
    const rawRows = [
      ['Title'], ['Sub'], ['Headers'],
      ['101', 'Patient A', 'Doctor', 'Cash', '10/01/26'],
    ];

    const result = await service.recordPeakBedCensus('2026-10-13', rawRows, [], 'rollover');
    expect(result).not.toBeNull();
    // The peak of 85 must be preserved!
    expect(result?.inpatientOccupied).toBe(85);
    expect(result?.totalOccupied).toBe(100);
    expect(result?.source).toBe('rollover');
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
      inpatientOccupied: 85,
      totalOccupied: 100,
      source: 'rollover',
    }));
  });

  it('combines active patients with discharged patients from today to capture peak', async () => {
    const upsertSpy = vi.spyOn(repo, 'upsertDailyBedCensus').mockResolvedValue();
    vi.spyOn(repo, 'getDailyBedCensus').mockResolvedValue(null);

    // Active row has 1 patient in room 101
    const rawRows = [
      ['Title'], ['Sub'], ['Headers'],
      ['101', 'Active Patient', 'Doctor', 'Cash', '10/13/26'],
    ];

    // Discharged patients from today occupied room 301 and 302
    const discharged = [
      { room: '301', name: 'Discharged Patient 1', doctor: 'Dr X', dischargeDate: '2026-10-13' },
      { room: '302', name: 'Discharged Patient 2', doctor: 'Dr Y', dischargeDate: '2026-10-13' },
    ];

    const result = await service.recordPeakBedCensus('2026-10-13', rawRows, discharged, 'rollover');
    expect(result).not.toBeNull();
    // 1 active + 2 discharged = 3 inpatient occupied
    expect(result?.inpatientOccupied).toBe(3);
    expect(result?.totalOccupied).toBe(3);
  });

  it('skips recordBedCensus if rawRows is empty and no prior record', async () => {
    const upsertSpy = vi.spyOn(repo, 'upsertDailyBedCensus').mockResolvedValue();
    const result = await service.recordBedCensus('2026-10-13', [], 'rollover');
    expect(result).toBeNull();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('records OR census and calls repository upsert', async () => {
    const upsertSpy = vi.spyOn(repo, 'upsertDailyORCensus').mockResolvedValue();

    const orList = [
      { vt: 'DC', orRoom: 'OR-1', startTime: '08:00 AM', endTime: '10:00 AM', realStatus: 'IN' },
    ];

    const result = await service.recordORCensus('2026-10-13', orList, 'rollover');
    expect(result.date).toBe('2026-10-13');
    expect(result.casesTotal).toBe(1);
    expect(result.bookedMinutes).toBe(120);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves higher daytime OR booked minutes during rollover', async () => {
    const upsertSpy = vi.spyOn(repo, 'upsertDailyORCensus').mockResolvedValue();
    // Daytime had 360 booked minutes and 4 cases recorded
    vi.spyOn(repo, 'getDailyORCensus').mockResolvedValue({
      date: '2026-10-13',
      roomsAvailable: 7,
      minutesPerRoom: 1440,
      bookedMinutes: 360,
      roomsUsed: 3,
      casesTotal: 4,
      dcCount: 2,
      hcCount: 2,
      inCount: 3,
      outCount: 1,
      sicuCount: 0,
      excludedCases: 0,
      roomBreakdown: {},
      source: 'provisional',
    });

    // At rollover, orList is empty or has fewer cases
    const result = await service.recordPeakORCensus('2026-10-13', [], 'rollover');
    expect(result.bookedMinutes).toBe(360);
    expect(result.casesTotal).toBe(4);
    expect(result.source).toBe('rollover');
    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({
      bookedMinutes: 360,
      casesTotal: 4,
      source: 'rollover',
    }));
  });

  it('finalizes month for beds and OR write-once', async () => {
    vi.spyOn(repo, 'getDailyBedCensusForMonth').mockResolvedValue([
      { date: '2026-10-01', inpatientOccupied: 50, inpatientCapacity: 68, totalOccupied: 80, totalCapacity: 110, source: 'rollover' },
    ]);
    vi.spyOn(repo, 'getDailyORCensusForMonth').mockResolvedValue([
      { date: '2026-10-01', roomsAvailable: 7, minutesPerRoom: 1440, bookedMinutes: 300, roomsUsed: 2, casesTotal: 3, dcCount: 2, hcCount: 1, inCount: 2, outCount: 1, sicuCount: 0, excludedCases: 0, roomBreakdown: {}, source: 'rollover' },
    ]);

    const bedInsertSpy = vi.spyOn(repo, 'insertMonthlyBedSummaryIfAbsent').mockResolvedValue(true);
    const orInsertSpy = vi.spyOn(repo, 'insertMonthlyORSummaryIfAbsent').mockResolvedValue(true);

    const res = await service.finalizeMonth('2026-10');
    expect(res.bedsFinalized).toBe(true);
    expect(res.orFinalized).toBe(true);
    expect(bedInsertSpy).toHaveBeenCalledTimes(1);
    expect(orInsertSpy).toHaveBeenCalledTimes(1);
  });
});
