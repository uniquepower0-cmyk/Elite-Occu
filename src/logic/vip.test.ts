import { describe, it, expect } from 'vitest';
import { extractVipNames, createVipMatcher } from './vip';

describe('src/logic/vip', () => {
  it('extracts VIP names from WhatsApp-formatted and numbered lines', () => {
    const text = [
      '*VIP CASES*',
      '[7:18 PM, 6/3/2026] Mohanad: سهير ابراهيم مصطفى صيام...عنايه',
      '1- د/ محمد عيد نجا نجا ... 409',
      '2. عايده عبدالعاطي عبدالله ابوكليله.....عنايه',
    ].join('\n');

    const names = extractVipNames(text);
    expect(names.some((n) => n.includes('سهير'))).toBe(true);
    expect(names.some((n) => n.includes('محمد عيد'))).toBe(true);
    expect(names.some((n) => n.includes('عايده'))).toBe(true);
  });

  it('matches Arabic variants and compounds accurately via createVipMatcher', () => {
    const text = [
      'سهير ابراهيم مصطفى صيام',
      'عايده عبدالعاطي عبدالله ابوكليله',
      'د/ محمد عيد نجا نجا',
    ].join('\n');

    const isVip = createVipMatcher(text);
    expect(isVip('سهير ابراهيم مصطفى صيام')).toBe(true);
    expect(isVip('عايدة عبد العاطى عبد الله ابو كليلة')).toBe(true);
    expect(isVip('محمد عيد نجا نجا')).toBe(true);
    expect(isVip('مريض عادي غير مدرج')).toBe(false);
    expect(isVip('')).toBe(false);
  });
});
