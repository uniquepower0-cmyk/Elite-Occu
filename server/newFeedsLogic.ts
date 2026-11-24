import type {
  InsuranceApprovalItem,
  InsuranceApprovalsPayload,
  OPDLivePayload,
  OPDLivePhysicianStat,
  ProcedureCaseItem,
} from '../src/types';

export function cleanMrnKey(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/[^0-9]/g, '').replace(/^0+/, '');
  return digits || String(raw).trim().toLowerCase();
}

export function normalizeDoctorKey(raw: string | null | undefined): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/^(dr\.?|prof\.?|د\.?|أ\.د\.?)\s+/i, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

export function computeFeedFreshness(
  updatedAt: string | null | undefined,
  staleAfterMinutes: number,
  nowMs: number = Date.now(),
): { isStale: boolean; ageMinutes: number | null } {
  if (!updatedAt) return { isStale: true, ageMinutes: null };
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return { isStale: true, ageMinutes: null };
  const ageMinutes = Math.max(0, Math.round((nowMs - ts) / 60000));
  return { isStale: ageMinutes > staleAfterMinutes, ageMinutes };
}

export function buildApprovalLookupMap(
  payload: InsuranceApprovalsPayload | null | undefined,
): Record<string, InsuranceApprovalItem> {
  const map: Record<string, InsuranceApprovalItem> = {};
  if (!payload?.items) return map;
  for (const item of payload.items) {
    const key = cleanMrnKey(item.mrn);
    if (key) map[key] = item;
  }
  return map;
}

export function matchApprovalForPatient(
  mrn: string | null | undefined,
  room: string | null | undefined,
  payload: InsuranceApprovalsPayload | null | undefined,
): InsuranceApprovalItem | null {
  if (!payload?.items?.length) return null;
  const targetMrn = cleanMrnKey(mrn);
  if (targetMrn) {
    const byMrn = payload.items.find((it) => cleanMrnKey(it.mrn) === targetMrn);
    if (byMrn) return byMrn;
  }
  const targetRoom = String(room || '').trim().toLowerCase();
  if (targetRoom) {
    const byRoom = payload.items.find(
      (it) => String(it.room || '').trim().toLowerCase() === targetRoom,
    );
    if (byRoom) return byRoom;
  }
  return null;
}

export interface ScheduleCapacityItem {
  physicianEn?: string;
  physicianAr?: string;
  specialty?: string;
  maxOccupancy?: number;
}

export function enrichOpdLiveWithScheduleCapacity(
  opdLive: OPDLivePayload | null | undefined,
  scheduleItems: ScheduleCapacityItem[],
): OPDLivePayload | null {
  if (!opdLive) return null;

  // Build normalized lookup of scheduled maxOccupancy by English doctor name
  const capByEn = new Map<string, { maxOccupancy: number; physicianAr: string }>();
  for (const s of scheduleItems || []) {
    const key = normalizeDoctorKey(s.physicianEn);
    if (!key) continue;
    const prev = capByEn.get(key);
    const maxOcc = Number(s.maxOccupancy || 0);
    capByEn.set(key, {
      maxOccupancy: (prev?.maxOccupancy || 0) + (Number.isFinite(maxOcc) ? maxOcc : 0),
      physicianAr: prev?.physicianAr || String(s.physicianAr || ''),
    });
  }

  // Index confirmed queue by normalized Arabic name
  const queueByAr = new Map<string, { waiting: number; inClinic: number; completed: number; pendingTicketRequests: number }>();
  for (const q of opdLive.queueByPhysicianAr || []) {
    const key = normalizeDoctorKey(q.physicianAr);
    if (!key) continue;
    const prev = queueByAr.get(key) || { waiting: 0, inClinic: 0, completed: 0, pendingTicketRequests: 0 };
    queueByAr.set(key, {
      waiting: prev.waiting + (q.waiting || 0),
      inClinic: prev.inClinic + (q.inClinic || 0),
      completed: prev.completed + (q.completed || 0),
      pendingTicketRequests: prev.pendingTicketRequests + (q.pendingTicketRequests || 0),
    });
  }

  const enrichedPhysicians: OPDLivePhysicianStat[] = (opdLive.byPhysician || []).map((doc) => {
    const enKey = normalizeDoctorKey(doc.physicianEn);
    const cap = enKey ? capByEn.get(enKey) : undefined;
    const physicianAr = doc.physicianAr || cap?.physicianAr || '';
    const arKey = normalizeDoctorKey(physicianAr);
    const qMatch = arKey ? queueByAr.get(arKey) : undefined;

    const maxOccupancy = cap && cap.maxOccupancy > 0 ? cap.maxOccupancy : undefined;
    const activeBooked = Math.max(0, (doc.total || 0) - (doc.cancelled || 0));
    const utilizationPct =
      maxOccupancy && maxOccupancy > 0
        ? Math.round((activeBooked / maxOccupancy) * 100)
        : null;

    return {
      ...doc,
      physicianAr,
      maxOccupancy,
      utilizationPct,
      confirmedQueueWaiting: qMatch ? qMatch.waiting : doc.confirmedQueueWaiting,
      confirmedQueueInClinic: qMatch ? qMatch.inClinic : doc.confirmedQueueInClinic,
      confirmedQueueCompleted: qMatch ? qMatch.completed : doc.confirmedQueueCompleted,
      pendingTicketRequests: qMatch ? qMatch.pendingTicketRequests : doc.pendingTicketRequests,
    };
  });

  return {
    ...opdLive,
    byPhysician: enrichedPhysicians,
  };
}

export type ProcedureWindowMode = 'today' | 'upcoming' | 'recent' | 'all';

export function cleanProcedureOpName(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*\/\/\s*s-[^\s/]+\/*\s*/gi, '')
    .replace(/\s*\/\/+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseProcedureTimeMinutes(timeStr: string | null | undefined): number {
  if (!timeStr) return 9999;
  const s = String(timeStr).trim().toLowerCase();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  let h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const isPM = s.includes('pm') || s.includes('م');
  const isAM = s.includes('am') || s.includes('ص');
  if (isPM && h < 12) h += 12;
  else if (isAM && h === 12) h = 0;
  return h * 60 + mins;
}

export function dedupeProcedureCases(items: ProcedureCaseItem[]): ProcedureCaseItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const mergeDistinct = (existing: string, incoming: string, sep = ' / '): string => {
    const cleanIn = String(incoming || '').trim();
    if (!cleanIn) return existing || '';
    const parts = String(existing || '')
      .split(sep.trim())
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.includes(cleanIn)) parts.push(cleanIn);
    return parts.join(sep);
  };

  const map = new Map<string, ProcedureCaseItem>();
  for (const raw of items) {
    const mrnKey = cleanMrnKey(raw.mrn);
    const nameKey = normalizeDoctorKey(raw.patientName);
    const key = `${raw.procedureDate || ''}|${mrnKey || nameKey}|${(raw.startTime || '').trim()}|${(raw.room || '').trim().toLowerCase()}`;
    const cleanedOpEn = cleanProcedureOpName(raw.engOperationName);
    const cleanedOpAr = cleanProcedureOpName(raw.arOperationName);

    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...raw,
        engOperationName: cleanedOpEn,
        arOperationName: cleanedOpAr,
      });
    } else {
      existing.engOperationName = mergeDistinct(existing.engOperationName, cleanedOpEn);
      existing.arOperationName = mergeDistinct(existing.arOperationName, cleanedOpAr);
      existing.surgeonName = mergeDistinct(existing.surgeonName, raw.surgeonName);
      existing.cathlabDose = mergeDistinct(existing.cathlabDose, raw.cathlabDose, ' | ');
      existing.operativeComment = mergeDistinct(existing.operativeComment, raw.operativeComment);
      if (!existing.actualStart && raw.actualStart) existing.actualStart = raw.actualStart;
      if (!existing.actualEnd && raw.actualEnd) existing.actualEnd = raw.actualEnd;
      if (existing.status?.toLowerCase() !== 'completed' && raw.status?.toLowerCase() === 'completed') {
        existing.status = raw.status;
      }
    }
  }

  return Array.from(map.values())
    .sort((a, b) => {
      const dateCmp = String(a.procedureDate || '').localeCompare(String(b.procedureDate || ''));
      if (dateCmp !== 0) return dateCmp;
      const tCmp = parseProcedureTimeMinutes(a.startTime) - parseProcedureTimeMinutes(b.startTime);
      if (tCmp !== 0) return tCmp;
      return String(a.room || '').localeCompare(String(b.room || ''));
    })
    .map((item, idx) => ({ ...item, serial: String(idx + 1) }));
}

export function filterProcedureCases(
  items: ProcedureCaseItem[],
  referenceDate: string,
  mode: ProcedureWindowMode,
  specificDate?: string,
): ProcedureCaseItem[] {
  if (!Array.isArray(items)) return [];
  const deduped = dedupeProcedureCases(items);
  if (specificDate) {
    return deduped.filter((it) => it.procedureDate === specificDate);
  }
  if (mode === 'today') return deduped.filter((it) => it.procedureDate === referenceDate);
  if (mode === 'upcoming') return deduped.filter((it) => it.procedureDate > referenceDate);
  if (mode === 'recent') return deduped.filter((it) => it.procedureDate < referenceDate);
  return deduped;
}
