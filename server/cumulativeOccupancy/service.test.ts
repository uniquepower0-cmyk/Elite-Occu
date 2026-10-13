import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CumulativeOccupancyService } from './service.js';
import * as repo from './repository.js';
import * as hist from '../../historyManager.js';

describe('CumulativeOccupancyService', () => {
  let service: CumulativeOccupancyService;

  beforeEach(() => {
    service = new CumulativeOccupancyService();
    vi.restoreAllMocks();
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

  it('skips recordBedCensus if rawRows is empty', async () => {
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
