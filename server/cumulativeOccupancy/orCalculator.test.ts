import { describe, it, expect } from 'vitest';
import {
  normalizeOrRoom,
  parseClockToMinutes,
  mergeIntervals,
  computeORCensus,
  aggregateORMonth,
} from './orCalculator.js';

describe('Cumulative OR Utilization Calculator', () => {
  describe('normalizeOrRoom', () => {
    it('normalizes various OR room string patterns', () => {
      expect(normalizeOrRoom('OR - 1')).toBe('OR-1');
      expect(normalizeOrRoom('OR -7')).toBe('OR-7');
      expect(normalizeOrRoom('OR 3')).toBe('OR-3');
      expect(normalizeOrRoom('OR-4')).toBe('OR-4');
      expect(normalizeOrRoom('or 5')).toBe('OR-5');
      expect(normalizeOrRoom('OR 6')).toBe('OR-6');
    });

    it('rejects non-OR procedural suites', () => {
      expect(normalizeOrRoom('Cath Lab')).toBeNull();
      expect(normalizeOrRoom('Endoscopy Room')).toBeNull();
      expect(normalizeOrRoom('Dialysis')).toBeNull();
      expect(normalizeOrRoom('')).toBeNull();
      expect(normalizeOrRoom(null)).toBeNull();
    });
  });

  describe('parseClockToMinutes', () => {
    it('parses 12-hour AM/PM formats', () => {
      expect(parseClockToMinutes('12:00 AM')).toBe(0);
      expect(parseClockToMinutes('12:30 AM')).toBe(30);
      expect(parseClockToMinutes('6:30AM')).toBe(390); // 6*60 + 30
      expect(parseClockToMinutes('9:30AM')).toBe(570);
      expect(parseClockToMinutes('12:00 PM')).toBe(720);
      expect(parseClockToMinutes('1:00 PM')).toBe(780);
      expect(parseClockToMinutes('6:30 PM')).toBe(1110);
      expect(parseClockToMinutes('11:59 PM')).toBe(1439);
    });

    it('parses 24-hour formats', () => {
      expect(parseClockToMinutes('00:00')).toBe(0);
      expect(parseClockToMinutes('08:15')).toBe(495);
      expect(parseClockToMinutes('14:30')).toBe(870);
    });

    it('returns null for invalid clock strings', () => {
      expect(parseClockToMinutes('invalid')).toBeNull();
      expect(parseClockToMinutes('25:00')).toBeNull();
      expect(parseClockToMinutes('12:65 AM')).toBeNull();
      expect(parseClockToMinutes('')).toBeNull();
    });
  });

  describe('mergeIntervals', () => {
    it('returns 0 for empty intervals', () => {
      expect(mergeIntervals([])).toBe(0);
    });

    it('handles single interval', () => {
      expect(mergeIntervals([[60, 120]])).toBe(60);
    });

    it('merges overlapping intervals in same room', () => {
      // 08:00 (480) to 10:00 (600), and 09:30 (570) to 11:00 (660) -> 480 to 660 = 180 min
      expect(mergeIntervals([[480, 600], [570, 660]])).toBe(180);
    });

    it('sums disjoint intervals', () => {
      expect(mergeIntervals([[60, 120], [200, 260]])).toBe(120);
    });

    it('merges contained intervals', () => {
      expect(mergeIntervals([[100, 300], [120, 200]])).toBe(200);
    });
  });

  describe('computeORCensus', () => {
    it('computes daily census for an OR list with multiple cases', () => {
      const orList = [
        {
          vt: 'DC',
          orRoom: 'OR - 1',
          startTime: '08:00 AM',
          endTime: '10:00 AM', // 120 mins
          postC: 'SICU',
          realStatus: 'IN',
        },
        {
          vt: 'HC',
          orRoom: 'OR - 1',
          startTime: '10:00 AM',
          endTime: '11:30 AM', // 90 mins (touches previous interval: 480-600 & 600-690 -> 210 mins total)
          realStatus: 'OUT',
        },
        {
          vt: 'DC',
          orRoom: 'OR - 3',
          startTime: '09:00 AM',
          endTime: '11:00 AM', // 120 mins
          realStatus: 'IN',
        },
        {
          vt: 'HC',
          orRoom: 'Cath Lab', // Excluded room
          startTime: '09:00 AM',
          endTime: '10:00 AM',
        },
      ];

      const census = computeORCensus(orList, '2026-10-13');

      expect(census.casesTotal).toBe(4);
      expect(census.dcCount).toBe(2);
      expect(census.hcCount).toBe(2);
      expect(census.sicuCount).toBe(1);
      expect(census.excludedCases).toBe(1); // Cath Lab
      expect(census.roomsUsed).toBe(2); // OR-1 and OR-3

      // OR-1: 120 + 90 = 210 mins
      // OR-3: 120 mins
      // Total booked = 330 mins
      expect(census.bookedMinutes).toBe(330);
      expect(census.roomBreakdown['OR-1'].minutes).toBe(210);
      expect(census.roomBreakdown['OR-1'].cases).toBe(2);
      expect(census.roomBreakdown['OR-3'].minutes).toBe(120);
      expect(census.roomBreakdown['OR-2'].minutes).toBe(0);
    });

    it('handles days with zero cases correctly', () => {
      const census = computeORCensus([], '2026-10-13');
      expect(census.casesTotal).toBe(0);
      expect(census.bookedMinutes).toBe(0);
      expect(census.roomsUsed).toBe(0);
      expect(census.roomsAvailable).toBe(7);
      expect(census.minutesPerRoom).toBe(1440);
    });
  });

  describe('aggregateORMonth', () => {
    it('calculates monthly time utilization and room utilization over 7 rooms x 24h', () => {
      const storedDays = [
        computeORCensus(
          [
            { vt: 'DC', orRoom: 'OR-1', startTime: '08:00 AM', endTime: '12:00 PM', realStatus: 'IN' }, // 240 mins
            { vt: 'HC', orRoom: 'OR-3', startTime: '10:00 AM', endTime: '02:00 PM', realStatus: 'OUT' }, // 240 mins
          ],
          '2026-10-01'
        ),
      ];

      const agg = aggregateORMonth('2026-10', storedDays, null);

      expect(agg.daysRecorded).toBe(1);
      // Available minutes for 1 day = 7 * 1440 = 10,080 mins
      expect(agg.availableMinutes).toBe(10080);
      expect(agg.bookedMinutes).toBe(480);
      // Time utilization: (480 / 10080) * 100 = 4.76%
      expect(agg.timeUtilization).toBe(4.76);

      // Room utilization: 2 rooms used out of 7 = (2 / 7) * 100 = 28.57%
      expect(agg.roomDaysUsed).toBe(2);
      expect(agg.roomDaysAvailable).toBe(7);
      expect(agg.roomUtilization).toBe(28.57);
    });
  });
});
