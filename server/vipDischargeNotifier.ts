import { cleanContractorForDisplay } from './contractorOfficers.js';
import { isCompanionBed } from './nameUtils.js';
import { greenApiService } from './services/greenApiService.js';

export interface VipDischargeCandidate {
  name?: string | null;
  room?: string | null;
  bed?: string | null;
  mrn?: string | null;
  contractor?: string | null;
  dischargeType?: string | null;
}

export interface NotifyVipDischargesParams {
  discharges: VipDischargeCandidate[];
  isVipFn: (name: string) => boolean;
  notifiedKeys: string[];
  paused: boolean;
  dryRun?: boolean;
  targetGroups?: string[];
  cairoTime?: string;
  sendFn?: (message: string, groupIds: string[]) => Promise<void>;
}

export interface NotifyVipDischargesResult {
  notifiedKeys: string[];
  sentCount: number;
  suppressedCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formats the current Cairo timestamp as `YYYY-MM-DD HH:mm`.
 */
export function formatCairoDischargeTime(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : (map.hour || '00');
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}`;
}

/**
 * Normalizes a contractor string for VIP discharge alerts, stripping numeric
 * prefixes and noise words, and falling back to "Cash / Self-Pay".
 */
export function normalizeContractorForVipAlert(contractor?: string | null): string {
  if (contractor === undefined || contractor === null) return 'Cash / Self-Pay';
  let s = String(contractor).trim();
  // Strip leading numeric codes like "001 - Allianz"
  s = s.replace(/^\d+\s*[-–—]\s*/, '').trim();
  s = cleanContractorForDisplay(s);
  return s || 'Cash / Self-Pay';
}

/**
 * Formats the Option 1 + Contractor VIP discharge WhatsApp notification.
 */
export function formatVipDischargeMessage(params: {
  patientName: string;
  roomNumber: string;
  contractor?: string | null;
  cairoTime?: string;
}): string {
  const name = String(params.patientName || '').trim() || 'Unknown';
  const room = String(params.roomNumber || '').trim() || '—';
  const contractor = normalizeContractorForVipAlert(params.contractor);
  const timeStr = params.cairoTime || formatCairoDischargeTime();

  return [
    '👑 *VIP Patient Discharged*',
    '━━━━━━━━━━━━━━━━━━━━',
    `• *Name:* ${name}`,
    `• *Room:* ${room}`,
    `• *Contractor:* ${contractor}`,
    '• *Status:* Discharged ✅',
    `• *Time:* ${timeStr}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '_Elite Hospital Occupancy Manager_',
  ].join('\n');
}

/**
 * Builds a canonical deduplication key from MRN digits or collapsed name.
 */
export function buildVipDischargeKey(patient: { mrn?: string | null; name?: string | null }): string {
  const rawMrn = String(patient?.mrn || '').trim();
  const mrnDigits = rawMrn.replace(/\D+/g, '');
  if (mrnDigits.length > 0 && !/^0+$/.test(mrnDigits)) {
    return `mrn:${mrnDigits}`;
  }
  const normName = String(patient?.name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return normName ? `name:${normName}` : '';
}

/**
 * Resolves target WhatsApp groups from GREEN_API_VIP_DISCHARGE_GROUP_IDS or GREEN_API_GROUP_IDS.
 */
export function getVipDischargeTargetGroups(): string[] {
  const override = (process.env.GREEN_API_VIP_DISCHARGE_GROUP_IDS || '').trim();
  const raw = override || (process.env.GREEN_API_GROUP_IDS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((g) => g.trim()).filter(Boolean);
}

/**
 * Detects Power BI auto-discharged VIP patients and sends WhatsApp alerts (or records
 * dedup keys cleanly when paused so resuming never replays stale historical alerts).
 */
export async function notifyPowerBiVipDischarges(
  params: NotifyVipDischargesParams
): Promise<NotifyVipDischargesResult> {
  const notifiedSet = new Set<string>(Array.isArray(params.notifiedKeys) ? params.notifiedKeys : []);
  const orderedKeys: string[] = Array.isArray(params.notifiedKeys) ? [...params.notifiedKeys] : [];
  const addKey = (k: string) => {
    if (!notifiedSet.has(k)) {
      notifiedSet.add(k);
      orderedKeys.push(k);
    }
  };

  const targetGroups = params.targetGroups ?? getVipDischargeTargetGroups();
  const isDryRun = Boolean(params.dryRun) || process.env.VIP_DISCHARGE_WHATSAPP_DRY_RUN === '1';

  let sentCount = 0;
  let suppressedCount = 0;

  for (const p of params.discharges || []) {
    if (!p) continue;
    // Only auto (Power BI-based) discharges
    if (p.dischargeType === 'manual') continue;

    const name = String(p.name || '').trim();
    const room = String(p.room || '').trim();
    const bed = String(p.bed || room).trim();
    if (!name) continue;

    // Skip companion beds & dialysis room 323
    if (isCompanionBed(bed) || isCompanionBed(room)) continue;
    if (room.includes('323')) continue;

    if (!params.isVipFn(name)) continue;

    const key = buildVipDischargeKey(p);
    if (!key || notifiedSet.has(key)) continue;

    if (params.paused) {
      console.log(`[VIP WhatsApp] Automation is paused; suppressing alert for ${name} (${room || '—'})`);
      addKey(key);
      suppressedCount++;
      continue;
    }

    const message = formatVipDischargeMessage({
      patientName: name,
      roomNumber: room || '—',
      contractor: p.contractor,
      cairoTime: params.cairoTime,
    });

    if (isDryRun) {
      console.log(`[VIP WhatsApp][DRY-RUN] Would send:\n${message}`);
      addKey(key);
      sentCount++;
      continue;
    }

    if (targetGroups.length === 0) {
      console.warn('[VIP WhatsApp] No target group IDs configured; skipping WhatsApp send.');
      continue;
    }

    try {
      if (params.sendFn) {
        await params.sendFn(message, targetGroups);
      } else {
        const results = await greenApiService.broadcastTextMessage(message, targetGroups);
        const anySuccess = results.some((r) => r.success);
        if (!anySuccess) {
          console.error('[VIP WhatsApp] All group sends failed:', results);
          continue;
        }
      }
      addKey(key);
      sentCount++;
      await sleep(300);
    } catch (err: any) {
      console.error(`[VIP WhatsApp] Non-fatal error sending VIP discharge alert for ${name}:`, err?.message || err);
    }
  }

  return {
    notifiedKeys: orderedKeys,
    sentCount,
    suppressedCount,
  };
}
