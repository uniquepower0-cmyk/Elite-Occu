import { describe, it, expect, vi } from 'vitest';
import {
  buildVipDischargeKey,
  formatVipDischargeMessage,
  normalizeContractorForVipAlert,
  notifyPowerBiVipDischarges,
} from './vipDischargeNotifier.js';

describe('vipDischargeNotifier', () => {
  it('formats Option 1 + Contractor WhatsApp message', () => {
    const msg = formatVipDischargeMessage({
      patientName: 'سهير ابراهيم مصطفى صيام',
      roomNumber: '405 A',
      contractor: '001 - شركة Allianz',
      cairoTime: '2026-11-21 15:30',
    });

    expect(msg).toBe(
      [
        '👑 *VIP Patient Discharged*',
        '━━━━━━━━━━━━━━━━━━━━',
        '• *Name:* سهير ابراهيم مصطفى صيام',
        '• *Room:* 405 A',
        '• *Contractor:* Allianz',
        '• *Status:* Discharged ✅',
        '• *Time:* 2026-11-21 15:30',
        '━━━━━━━━━━━━━━━━━━━━',
        '_Elite Hospital Occupancy Manager_',
      ].join('\n')
    );
  });

  it('falls back to Cash / Self-Pay when contractor is blank or numeric noise', () => {
    expect(normalizeContractorForVipAlert('')).toBe('Cash / Self-Pay');
    expect(normalizeContractorForVipAlert('-')).toBe('Cash / Self-Pay');
    expect(normalizeContractorForVipAlert('12.5')).toBe('Cash / Self-Pay');
    expect(normalizeContractorForVipAlert('001 - main')).toBe('Cash / Self-Pay');
  });

  it('builds canonical dedup key from MRN digits or normalized name', () => {
    expect(buildVipDischargeKey({ mrn: 'MRN-001234', name: 'Test' })).toBe('mrn:001234');
    expect(buildVipDischargeKey({ mrn: '', name: '  أحمد   محمد  ' })).toBe('name:أحمد محمد');
  });

  it('sends alert once for auto-discharged VIP and skips companions, manual discharges, room 323, and duplicates', async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const isVipFn = (name: string) => name.includes('سهير') || name.includes('محمد عيد');

    const res1 = await notifyPowerBiVipDischarges({
      discharges: [
        { name: 'سهير ابراهيم مصطفى صيام', room: '405 A', mrn: '1001', contractor: '002 - AXA', dischargeType: 'auto' },
        { name: 'مرافق سهير', room: '405 C', mrn: '1002', contractor: 'AXA', dischargeType: 'auto' },
        { name: 'محمد عيد نجا نجا', room: '409', mrn: '1003', contractor: 'Bupa', dischargeType: 'manual' },
        { name: 'مريض غسيل', room: '323', mrn: '1004', contractor: 'Cash', dischargeType: 'auto' },
        { name: 'غير في اي بي', room: '410', mrn: '1005', contractor: 'Cash', dischargeType: 'auto' },
      ],
      isVipFn,
      notifiedKeys: [],
      paused: false,
      targetGroups: ['1203630@g.us'],
      sendFn,
      cairoTime: '2026-11-21 15:30',
    });

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn.mock.calls[0][0]).toContain('سهير ابراهيم مصطفى صيام');
    expect(sendFn.mock.calls[0][0]).toContain('• *Contractor:* AXA');
    expect(res1.sentCount).toBe(1);
    expect(res1.notifiedKeys).toEqual(['mrn:1001']);

    // Second run with same discharge must be deduplicated
    const res2 = await notifyPowerBiVipDischarges({
      discharges: [
        { name: 'سهير ابراهيم مصطفى صيام', room: '405 A', mrn: '1001', contractor: '002 - AXA', dischargeType: 'auto' },
      ],
      isVipFn,
      notifiedKeys: res1.notifiedKeys,
      paused: false,
      targetGroups: ['1203630@g.us'],
      sendFn,
      cairoTime: '2026-11-21 15:35',
    });

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(res2.sentCount).toBe(0);
  });

  it('suppresses alerts when paused and records dedup keys so resuming does not replay stale alerts', async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const isVipFn = (name: string) => name.includes('سهير') || name.includes('محمد عيد');

    const pausedRes = await notifyPowerBiVipDischarges({
      discharges: [
        { name: 'سهير ابراهيم مصطفى صيام', room: '405 A', mrn: '1001', contractor: 'AXA', dischargeType: 'auto' },
      ],
      isVipFn,
      notifiedKeys: [],
      paused: true,
      targetGroups: ['1203630@g.us'],
      sendFn,
      cairoTime: '2026-11-21 15:30',
    });

    expect(sendFn).not.toHaveBeenCalled();
    expect(pausedRes.sentCount).toBe(0);
    expect(pausedRes.suppressedCount).toBe(1);
    expect(pausedRes.notifiedKeys).toEqual(['mrn:1001']);

    // Resuming later with the same old discharge + a brand new discharge should ONLY send the new one
    const resumedRes = await notifyPowerBiVipDischarges({
      discharges: [
        { name: 'سهير ابراهيم مصطفى صيام', room: '405 A', mrn: '1001', contractor: 'AXA', dischargeType: 'auto' },
        { name: 'محمد عيد نجا نجا', room: '409', mrn: '1003', contractor: 'MetLife', dischargeType: 'auto' },
      ],
      isVipFn,
      notifiedKeys: pausedRes.notifiedKeys,
      paused: false,
      targetGroups: ['1203630@g.us'],
      sendFn,
      cairoTime: '2026-11-21 16:00',
    });

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn.mock.calls[0][0]).toContain('محمد عيد نجا نجا');
    expect(resumedRes.sentCount).toBe(1);
    expect(resumedRes.notifiedKeys).toEqual(['mrn:1001', 'mrn:1003']);
  });

  it('supports dry-run mode without invoking sendFn', async () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const res = await notifyPowerBiVipDischarges({
      discharges: [
        { name: 'سهير ابراهيم مصطفى صيام', room: '405 A', mrn: '1001', contractor: 'AXA', dischargeType: 'auto' },
      ],
      isVipFn: () => true,
      notifiedKeys: [],
      paused: false,
      dryRun: true,
      targetGroups: ['1203630@g.us'],
      sendFn,
    });

    expect(sendFn).not.toHaveBeenCalled();
    expect(res.sentCount).toBe(1);
    expect(res.notifiedKeys).toEqual(['mrn:1001']);
  });
});
