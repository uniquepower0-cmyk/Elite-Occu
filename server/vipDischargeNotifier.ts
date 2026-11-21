import crypto from 'crypto';
import { cleanContractorForDisplay } from './contractorOfficers.js';
import { isCompanionBed, isProcedureOrTemporaryRoom } from './nameUtils.js';
import { greenApiService } from './services/greenApiService.js';

export interface VipDischargeCandidate {
  name?: string | null;
  room?: string | null;
  bed?: string | null;
  mrn?: string | null;
  contractor?: string | null;
  dischargeType?: string | null;
  source?: string | null;
}

export interface VipAdmissionCandidate {
  name?: string | null;
  room?: string | null;
  bed?: string | null;
  mrn?: string | null;
  physician?: string | null;
  contractor?: string | null;
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

export interface NotifyVipAdmissionsParams {
  admissions: VipAdmissionCandidate[];
  isVipFn: (name: string) => boolean;
  notifiedKeys: string[];
  paused: boolean;
  dryRun?: boolean;
  targetGroups?: string[];
  cairoTime?: string;
  sendFn?: (message: string, groupIds: string[]) => Promise<void>;
}

export interface NotifyVipEventsResult {
  notifiedKeys: string[];
  sentCount: number;
  suppressedCount: number;
}

export type NotifyVipDischargesResult = NotifyVipEventsResult;

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
 * Normalizes a contractor string for VIP alerts, stripping numeric
 * prefixes and noise words, and falling back to "Cash / Self-Pay".
 */
export function normalizeContractorForVipAlert(contractor?: string | null): string {
  if (contractor === undefined || contractor === null) return 'Cash / Self-Pay';
  let s = String(contractor).trim();
  s = s.replace(/^\d+\s*[-–—]\s*/, '').trim();
  s = cleanContractorForDisplay(s);
  return s || 'Cash / Self-Pay';
}

function normalizePhysicianForVipAlert(physician?: string | null): string {
  const raw = String(physician || '').trim();
  if (!raw || raw === '-' || raw === 'null' || raw === 'undefined') return '—';
  return /^dr\.?\s/i.test(raw) ? raw : `Dr. ${raw}`;
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
 * Formats the New VIP Patient Admitted WhatsApp notification.
 */
export function formatVipAdmissionMessage(params: {
  patientName: string;
  roomNumber: string;
  physician?: string | null;
  contractor?: string | null;
  cairoTime?: string;
}): string {
  const name = String(params.patientName || '').trim() || 'Unknown';
  const room = String(params.roomNumber || '').trim() || '—';
  const physician = normalizePhysicianForVipAlert(params.physician);
  const contractor = normalizeContractorForVipAlert(params.contractor);
  const timeStr = params.cairoTime || formatCairoDischargeTime();

  return [
    '👑 *New VIP Patient Admitted*',
    '━━━━━━━━━━━━━━━━━━━━',
    `• *Name:* ${name}`,
    `• *Room:* ${room}`,
    `• *Physician:* ${physician}`,
    `• *Contractor:* ${contractor}`,
    '• *Status:* Admitted 🏥',
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
 * Signs a VIP sync event payload with HMAC-SHA256 over `${timestampSec}.${rawBody}`.
 */
export function signVipSyncEventPayload(rawBody: string, timestampSec: number, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`, 'utf8')
    .digest('hex');
}

/**
 * Verifies an incoming VIP sync event request from the hospital runner using constant-time HMAC comparison.
 */
export function verifyVipSyncEventRequest(params: {
  rawBody: string;
  timestampHeader?: string;
  signatureHeader?: string;
  secret: string;
  nowSec?: number;
}): { ok: boolean; error?: string } {
  const { rawBody, timestampHeader, signatureHeader, secret } = params;
  if (!secret) return { ok: false, error: 'Missing server signing secret' };
  const tsNum = Number(timestampHeader);
  if (!timestampHeader || !Number.isFinite(tsNum)) {
    return { ok: false, error: 'Invalid or missing X-VIP-Alert-Timestamp' };
  }
  const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 300) {
    return { ok: false, error: 'Expired VIP sync event timestamp' };
  }
  const sig = String(signatureHeader || '').trim().toLowerCase();
  if (!sig) return { ok: false, error: 'Missing X-VIP-Alert-Signature' };

  const expected = signVipSyncEventPayload(rawBody, Math.trunc(tsNum), secret);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, error: 'Invalid VIP sync event signature' };
  }
  return { ok: true };
}

async function processVipAlertBatch<T extends { name?: string | null; room?: string | null; bed?: string | null; mrn?: string | null }>(params: {
  items: T[];
  isVipFn: (name: string) => boolean;
  notifiedKeys: string[];
  paused: boolean;
  dryRun?: boolean;
  targetGroups?: string[];
  sendFn?: (message: string, groupIds: string[]) => Promise<void>;
  shouldSkipItem?: (item: T) => boolean;
  formatMessage: (item: T) => string;
  label: string;
}): Promise<NotifyVipEventsResult> {
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

  for (const p of params.items || []) {
    if (!p || params.shouldSkipItem?.(p)) continue;

    const name = String(p.name || '').trim();
    const room = String(p.room || '').trim();
    const bed = String(p.bed || room).trim();
    if (!name) continue;

    if (isCompanionBed(bed) || isCompanionBed(room)) continue;
    if (room.includes('323')) continue;

    if (!params.isVipFn(name)) continue;

    const key = buildVipDischargeKey(p);
    if (!key || notifiedSet.has(key)) continue;

    if (params.paused) {
      console.log(`[VIP WhatsApp] Automation is paused; suppressing ${params.label} alert for ${name} (${room || '—'})`);
      addKey(key);
      suppressedCount++;
      continue;
    }

    const message = params.formatMessage(p);

    if (isDryRun) {
      console.log(`[VIP WhatsApp][DRY-RUN] Would send ${params.label}:\n${message}`);
      addKey(key);
      sentCount++;
      continue;
    }

    if (targetGroups.length === 0) {
      console.warn(`[VIP WhatsApp] No target group IDs configured; skipping ${params.label} send for ${name}.`);
      continue;
    }

    try {
      if (params.sendFn) {
        await params.sendFn(message, targetGroups);
      } else {
        const results = await greenApiService.broadcastTextMessage(message, targetGroups);
        const anySuccess = results.some((r) => r.success);
        if (!anySuccess) {
          console.error(`[VIP WhatsApp] All group sends failed (${params.label}):`, results);
          continue;
        }
      }
      addKey(key);
      sentCount++;
      await sleep(300);
    } catch (err: any) {
      console.error(`[VIP WhatsApp] Non-fatal error sending VIP ${params.label} alert for ${name}:`, err?.message || err);
    }
  }

  return {
    notifiedKeys: orderedKeys,
    sentCount,
    suppressedCount,
  };
}

/**
 * Detects Power BI auto-discharged VIP patients and sends WhatsApp alerts (or records
 * dedup keys cleanly when paused so resuming never replays stale historical alerts).
 */
export async function notifyPowerBiVipDischarges(
  params: NotifyVipDischargesParams
): Promise<NotifyVipDischargesResult> {
  return processVipAlertBatch({
    items: params.discharges || [],
    isVipFn: params.isVipFn,
    notifiedKeys: params.notifiedKeys,
    paused: params.paused,
    dryRun: params.dryRun,
    targetGroups: params.targetGroups,
    sendFn: params.sendFn,
    label: 'discharge',
    shouldSkipItem: (p) => p.dischargeType === 'manual' && p.source !== 'hmis_pending_discharge',
    formatMessage: (p) =>
      formatVipDischargeMessage({
        patientName: String(p.name || '').trim(),
        roomNumber: String(p.room || '').trim() || '—',
        contractor: p.contractor,
        cairoTime: params.cairoTime,
      }),
  });
}

/**
 * Detects newly admitted VIP patients (admitted today) and sends WhatsApp alerts.
 */
export async function notifyPowerBiVipAdmissions(
  params: NotifyVipAdmissionsParams
): Promise<NotifyVipEventsResult> {
  return processVipAlertBatch({
    items: params.admissions || [],
    isVipFn: params.isVipFn,
    notifiedKeys: params.notifiedKeys,
    paused: params.paused,
    dryRun: params.dryRun,
    targetGroups: params.targetGroups,
    sendFn: params.sendFn,
    label: 'admission',
    shouldSkipItem: (p) => {
      const room = String(p.room || p.bed || '').trim();
      return Boolean(room && isProcedureOrTemporaryRoom(room));
    },
    formatMessage: (p) =>
      formatVipAdmissionMessage({
        patientName: String(p.name || '').trim(),
        roomNumber: String(p.room || '').trim() || '—',
        physician: p.physician,
        contractor: p.contractor,
        cairoTime: params.cairoTime,
      }),
  });
}
