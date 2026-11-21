import { describe, it, expect } from 'vitest';
import { classifyInOutFallbackSafe } from './orStatusHelpers.js';

describe('orStatusHelpers.classifyInOutFallbackSafe', () => {
  it('returns OUT for OR suite day-cases and HC cases when column3 is Out or blank', () => {
    expect(
      classifyInOutFallbackSafe({
        orRoom: 'OR - 4',
        vt: 'DC',
        column3: 'Out',
        flClassName: 'اولي عاديه',
        postC: '',
      })
    ).toBe('OUT');

    expect(
      classifyInOutFallbackSafe({
        orRoom: 'OR - 6',
        vt: 'HC',
        column3: 'Out',
        flClassName: '',
        postC: '',
      })
    ).toBe('OUT');

    expect(
      classifyInOutFallbackSafe({
        orRoom: 'OR - 5',
        vt: 'PrivateCredit',
        column3: '',
        flClassName: '',
        postC: '',
      })
    ).toBe('OUT');
  });

  it('returns IN only when column3 explicitly indicates IN or INPATIENT', () => {
    expect(
      classifyInOutFallbackSafe({
        orRoom: 'OR - 6',
        vt: 'HC',
        column3: 'In',
        flClassName: '',
      })
    ).toBe('IN');

    expect(
      classifyInOutFallbackSafe({
        orRoom: 'OR - 3',
        vt: 'HC',
        column3: 'INPATIENT',
      })
    ).toBe('IN');
  });

  it('returns OUT for null/undefined inputs', () => {
    expect(classifyInOutFallbackSafe(null)).toBe('OUT');
    expect(classifyInOutFallbackSafe(undefined)).toBe('OUT');
  });
});
