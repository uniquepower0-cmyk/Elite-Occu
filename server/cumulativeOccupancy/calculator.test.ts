import { describe, it, expect } from 'vitest';
import {
  daysInMonth,
  isLastDayOfMonth,
  listMonthDates,
  aggregateBedMonth,
  DailyBedCensus
} from './calculator.js';

describe('Cumulative Occupancy - Bed & Calendar Calculator', () => {
  it('correctly calculates days in month including leap years', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29); // Leap year
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-10')).toBe(31);
    expect(daysInMonth('2026-12')).toBe(31);
  });

  it('correctly detects if a date is the last calendar day of its month', () => {
    expect(isLastDayOfMonth('2026-02-28')).toBe(true);
    expect(isLastDayOfMonth('2026-02-27')).toBe(false);
    expect(isLastDayOfMonth('2028-02-28')).toBe(false);
    expect(isLastDayOfMonth('2028-02-29')).toBe(true);
    expect(isLastDayOfMonth('2026-04-30')).toBe(true);
    expect(isLastDayOfMonth('2026-10-31')).toBe(true);
    expect(isLastDayOfMonth('2026-10-30')).toBe(false);
    expect(isLastDayOfMonth('2026-12-31')).toBe(true);
  });

  it('lists all dates of a month', () => {
    const feb = listMonthDates('2026-02');
    expect(feb.length).toBe(28);
    expect(feb[0]).toBe('2026-02-01');
    expect(feb[27]).toBe('2026-02-28');
  });

  it('aggregates daily bed census into patient-days and weighted rate', () => {
    const days: DailyBedCensus[] = [
      {
        date: '2026-10-01',
        inpatientOccupied: 50,
        inpatientCapacity: 68,
        totalOccupied: 80,
        totalCapacity: 110,
        source: 'rollover',
      },
      {
        date: '2026-10-02',
        inpatientOccupied: 60,
        inpatientCapacity: 68,
        totalOccupied: 90,
        totalCapacity: 110,
        source: 'rollover',
      },
    ];

    const agg = aggregateBedMonth('2026-10', days, null, '2026-10-02');

    expect(agg.daysRecorded).toBe(2);
    expect(agg.inpatient.patientDays).toBe(110);
    expect(agg.inpatient.bedDays).toBe(136);
    // Rate: (110 / 136) * 100 = 80.88%
    expect(agg.inpatient.rate).toBe(80.88);

    expect(agg.total.patientDays).toBe(170);
    expect(agg.total.bedDays).toBe(220);
    // Total rate: (170 / 220) * 100 = 77.27%
    expect(agg.total.rate).toBe(77.27);
    expect(agg.includesProvisional).toBe(false);
  });

  it('includes provisional today without duplicating if already recorded', () => {
    const stored: DailyBedCensus[] = [
      {
        date: '2026-10-01',
        inpatientOccupied: 50,
        inpatientCapacity: 68,
        totalOccupied: 80,
        totalCapacity: 110,
        source: 'rollover',
      },
    ];

    const provisional: DailyBedCensus = {
      date: '2026-10-02',
      inpatientOccupied: 55,
      inpatientCapacity: 68,
      totalOccupied: 85,
      totalCapacity: 110,
      source: 'provisional',
    };

    const agg1 = aggregateBedMonth('2026-10', stored, provisional, '2026-10-02');
    expect(agg1.daysRecorded).toBe(2);
    expect(agg1.includesProvisional).toBe(true);
    expect(agg1.inpatient.patientDays).toBe(105);

    // If provisional has same date as stored, it must NOT duplicate
    const agg2 = aggregateBedMonth('2026-10', stored, { ...stored[0], inpatientOccupied: 99 }, '2026-10-01');
    expect(agg2.daysRecorded).toBe(1);
    expect(agg2.includesProvisional).toBe(false);
    expect(agg2.inpatient.patientDays).toBe(50);
  });

  it('identifies missing calendar days correctly', () => {
    const stored: DailyBedCensus[] = [
      {
        date: '2026-10-01',
        inpatientOccupied: 50,
        inpatientCapacity: 68,
        totalOccupied: 80,
        totalCapacity: 110,
        source: 'rollover',
      },
      // Day 02 missing
      {
        date: '2026-10-03',
        inpatientOccupied: 55,
        inpatientCapacity: 68,
        totalOccupied: 85,
        totalCapacity: 110,
        source: 'rollover',
      },
    ];

    const agg = aggregateBedMonth('2026-10', stored, null, '2026-10-03');
    expect(agg.missingDays).toEqual(['2026-10-02']);
  });
});
