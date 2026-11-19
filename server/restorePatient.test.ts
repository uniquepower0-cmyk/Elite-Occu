import { describe, it, expect } from 'vitest';
import {
  findPatientRowInRows,
  upsertRestoredHmisOverride,
  isCompanionDischargedEntry,
} from './restoreHelpers';

describe('Restore Patient Helpers (30-col & 40-col lookup, HMIS overrides, companion guard)', () => {
  it('finds patient in 30-column manual upload rows where row[2] is name and row[3] is age', () => {
    const row30 = Array(30).fill('');
    row30[0] = '11/18/26 18:02';
    row30[1] = 'Bed 409';
    row30[2] = 'محمد عيد نجا نجا';
    row30[3] = '36';
    row30[6] = 'Next Care نكست كير';
    row30[14] = 'Salah   Elgohary';

    const found = findPatientRowInRows([row30], 'محمد عيد نجا نجا', '76914');
    expect(found).not.toBeNull();
    expect(found![1]).toBe('Bed 409');
    expect(found![2]).toBe('محمد عيد نجا نجا');
  });

  it('finds patient in 40-column Power BI rows by name or MRN', () => {
    const row40 = Array(41).fill('');
    row40[0] = '17-11-2026 05:59';
    row40[1] = 'Bed 405 A';
    row40[2] = '0000004447';
    row40[3] = 'سهير ابراهيم مصطفى صيام';
    row40[12] = 'Cash';
    row40[22] = 'Ahmed Moustafa Fouad Mohamed';

    const byName = findPatientRowInRows([row40], 'سهير ابراهيم مصطفى صيام');
    expect(byName).not.toBeNull();
    expect(byName![1]).toBe('Bed 405 A');

    const byMrn = findPatientRowInRows([row40], 'غير مطابق', '4447');
    expect(byMrn).not.toBeNull();
    expect(byMrn![3]).toBe('سهير ابراهيم مصطفى صيام');
  });

  it('deduplicates and persists restoredHmisOverrides by MRN or normalized name', () => {
    const first = upsertRestoredHmisOverride([], {
      name: 'محمد عيد نجا نجا',
      mrn: '0000076914',
      room: 'Bed 409',
      admissionDate: '18-11-2026 18:02',
      restoredAt: '2026-11-19T11:45:00.000Z',
    });
    expect(first.length).toBe(1);
    expect(first[0].mrn).toBe('76914');

    const second = upsertRestoredHmisOverride(first, {
      name: 'محمد عيد نجا نجا',
      mrn: '76914',
      room: 'Bed 409',
      admissionDate: '18-11-2026 18:02',
      restoredAt: '2026-11-19T11:50:00.000Z',
    });
    expect(second.length).toBe(1);
    expect(second[0].restoredAt).toBe('2026-11-19T11:50:00.000Z');
  });

  it('detects companion discharged entries by room or flag', () => {
    expect(isCompanionDischargedEntry({ room: 'Bed 405 C', name: 'باهر محمد منصور مصطفى' })).toBe(true);
    expect(isCompanionDischargedEntry({ room: 'Bed 405 A', name: 'مرافق', isCompanion: true })).toBe(true);
    expect(isCompanionDischargedEntry({ room: 'Bed 405 A', name: 'سهير ابراهيم مصطفى صيام' })).toBe(false);
    expect(isCompanionDischargedEntry({ room: 'Bed 409', name: 'محمد عيد نجا نجا' })).toBe(false);
  });
});
