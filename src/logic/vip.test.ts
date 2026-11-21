import { describe, it, expect } from 'vitest';
import {
  extractVipNames,
  createVipMatcher,
  normalizeContractorForVipAlertClient,
  formatVipAdmissionMessageClient,
  formatVipDischargeMessageClient,
} from './vip';

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
      '[8:11 AM, 11/9/2026] Ethar Elmalah ER Alamein: حالة: عمر مصطفى مجدى مصطفى',
      '[10:19 AM, 11/9/2026] Osama Reception Elite: وصول حاله \\عمر مصطفى مجدى مصطفى ',
    ].join('\n');

    const isVip = createVipMatcher(text);
    expect(isVip('سهير ابراهيم مصطفى صيام')).toBe(true);
    expect(isVip('عايدة عبد العاطى عبد الله ابو كليلة')).toBe(true);
    expect(isVip('محمد عيد نجا نجا')).toBe(true);
    expect(isVip('عمر مصطفى مجدى مصطفى')).toBe(true);
    expect(isVip('مريض عادي غير مدرج')).toBe(false);
    expect(isVip('')).toBe(false);
  });

  it('normalizes contractor names and formats admission & discharge WhatsApp messages identically to server', () => {
    expect(normalizeContractorForVipAlertClient('001 - شركة Allianz')).toBe('Allianz');
    expect(normalizeContractorForVipAlertClient('002 - main')).toBe('Cash / Self-Pay');
    expect(normalizeContractorForVipAlertClient('')).toBe('Cash / Self-Pay');
    expect(normalizeContractorForVipAlertClient('15.5')).toBe('Cash / Self-Pay');

    const admMsg = formatVipAdmissionMessageClient({
      patientName: 'سهير ابراهيم مصطفى صيام',
      roomNumber: '405 A',
      physician: 'أحمد محمود علي',
      contractor: '001 - شركة Allianz',
      cairoTime: '2026-11-21 18:15',
    });
    expect(admMsg).toBe(
      [
        '👑 *New VIP Patient Admitted*',
        '━━━━━━━━━━━━━━━━━━━━',
        '• *Name:* سهير ابراهيم مصطفى صيام',
        '• *Room:* 405 A',
        '• *Physician:* Dr. أحمد محمود علي',
        '• *Contractor:* Allianz',
        '• *Status:* Admitted 🏥',
        '• *Time:* 2026-11-21 18:15',
        '━━━━━━━━━━━━━━━━━━━━',
        '_Elite Hospital Occupancy Manager_',
      ].join('\n')
    );

    const discMsg = formatVipDischargeMessageClient({
      patientName: 'سهير ابراهيم مصطفى صيام',
      roomNumber: '405 A',
      contractor: '002 - AXA',
      cairoTime: '2026-11-21 18:15',
    });
    expect(discMsg).toBe(
      [
        '👑 *VIP Patient Discharged*',
        '━━━━━━━━━━━━━━━━━━━━',
        '• *Name:* سهير ابراهيم مصطفى صيام',
        '• *Room:* 405 A',
        '• *Contractor:* AXA',
        '• *Status:* Discharged ✅',
        '• *Time:* 2026-11-21 18:15',
        '━━━━━━━━━━━━━━━━━━━━',
        '_Elite Hospital Occupancy Manager_',
      ].join('\n')
    );
  });
});
