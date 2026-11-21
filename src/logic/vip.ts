/**
 * Shared VIP name extraction & normalized Arabic/English matcher for UI surfaces.
 * Mirrors VIP_CASES_POLICY.md and server.ts `isPatientVip`.
 */

const ARABIC_TITLES = [
  'الافندي',
  'افندي',
  'الدكتور',
  'دكتور',
  'الدكتوره',
  'دكتوره',
  'الاستاذ',
  'استاذ',
  'المهندس',
  'مهندس',
  'الشيخ',
  'شيخ',
  'الحاج',
  'حاج',
  'السيد',
  'سيد',
];

export function extractVipNames(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const names: string[] = [];

  for (let line of lines) {
    line = line.replace(/^\s*\*+.*?\*+\s*$/, '').trim();
    if (!line) continue;

    line = line.replace(/^.*?\]\s*[^:]*:\s*/, '');
    line = line.replace(/^[a-zA-Z\s\d.-]+:\s*/, '');
    line = line.replace(/^(وصول|دخول)?\s*(حاله|حالة)\s*(\/|-)?\s*/, '');
    line = line.replace(/^New Patient Admission\s*(-\s*)?/i, '');
    line = line.replace(/^\d+[\s\-.)]*/, '').trim();

    if (line.includes('..')) {
      const parts = line.split(/\.{2,}/);
      if (parts[0] && parts[0].trim()) {
        line = parts[0].trim();
      }
    }

    line = line.replace(/["'»«()]/g, '').trim();
    if (line.length > 2) {
      names.push(line);
    }
  }
  return names;
}

export function normalizeArabicVipName(name: string): string {
  if (!name) return '';
  let clean = name.toLowerCase().trim();
  clean = clean.replace(/[\u064B-\u065F]/g, '');
  clean = clean.replace(/[^a-zA-Z\u0600-\u06FF\s]/g, ' ');
  clean = clean.replace(/\s+/g, ' ').trim();
  clean = clean.replace(/^(ابن|ابنه|بنت|طفل|طفله|حاله|حالة)\s+/, '');

  return clean
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىيِ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .replace(/(?:^|\s)عبد\s+(\S+)/g, (m, p1) => (m.startsWith(' ') ? ' عبد' + p1 : 'عبد' + p1))
    .replace(/(?:^|\s)ابو\s+(\S+)/g, (m, p1) => (m.startsWith(' ') ? ' ابو' + p1 : 'ابو' + p1))
    .replace(/(?:^|\s)ام\s+(\S+)/g, (m, p1) => (m.startsWith(' ') ? ' ام' + p1 : 'ام' + p1))
    .replace(/(?:^|\s)ابن\s+(\S+)/g, (m, p1) => (m.startsWith(' ') ? ' ابن' + p1 : 'ابن' + p1))
    .replace(/(?:^|\s)بن\s+(\S+)/g, (m, p1) => (m.startsWith(' ') ? ' بن' + p1 : 'بن' + p1))
    .replace(/(?:^|\s)(\S+)\s+الدين(?=\s|$)/g, (m, p1) => (m.startsWith(' ') ? ' ' + p1 + 'الدين' : p1 + 'الدين'));
}

export function getNormalizedVipWords(name: string): string[] {
  const normalized = normalizeArabicVipName(name);
  const words = normalized.split(' ').filter((w) => w.length >= 2);
  while (words.length > 1 && ARABIC_TITLES.includes(words[0])) {
    words.shift();
  }
  return words.map((w) => (w.startsWith('ال') && w.length > 3 ? w.substring(2) : w));
}

function getLcsLength(words1: string[], words2: string[]): number {
  const m = words1.length;
  const n = words2.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (words1[i - 1] === words2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Returns a memoized `(patientName?: string | null) => boolean` matcher for a given VIP list string.
 */
export function createVipMatcher(vipCasesText: string): (patientName?: string | null) => boolean {
  const vipWordLists = extractVipNames(vipCasesText)
    .map(getNormalizedVipWords)
    .filter((w) => w.length >= 2);

  if (vipWordLists.length === 0) {
    return () => false;
  }

  const cache = new Map<string, boolean>();
  return (patientName?: string | null): boolean => {
    if (!patientName) return false;
    const key = String(patientName).trim();
    if (!key) return false;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const pWords = getNormalizedVipWords(key);
    let matched = false;
    if (pWords.length >= 2) {
      for (const nWords of vipWordLists) {
        if (pWords[0] !== nWords[0]) continue;
        const shorterLen = Math.min(pWords.length, nWords.length);
        if (getLcsLength(pWords, nWords) === shorterLen && shorterLen >= 2) {
          matched = true;
          break;
        }
      }
    }
    cache.set(key, matched);
    return matched;
  };
}

/**
 * Formats a Date into `YYYY-MM-DD HH:mm` in Africa/Cairo timezone.
 */
export function formatCairoVipTimestampClient(date: Date = new Date()): string {
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
 * Normalizes a contractor string for client-side VIP message previews with Cash / Self-Pay fallback.
 */
export function normalizeContractorForVipAlertClient(contractor?: string | null): string {
  if (contractor === undefined || contractor === null) return 'Cash / Self-Pay';
  let s = String(contractor).trim();
  if (!s || s === '-' || s === 'null' || s === 'undefined') return 'Cash / Self-Pay';
  s = s.replace(/^\d+\s*[-–—]\s*/, '').trim();
  if (!s || /^\d+(\.\d+)?$/.test(s)) return 'Cash / Self-Pay';
  s = s.replace(/\bmain\b/gi, '');
  s = s.replace(/(^|[\s\(\[\-\_\/\.\,\:\*\#])(شركة|شركه)([\s\)\]\-\_\/\.\,\:\*\#]|$)/g, '$1 $3');
  s = s.replace(/(شركة|شركه)/g, '');
  s = s.replace(/\(\s*\)|\[\s*\]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'Cash / Self-Pay';
}

function normalizePhysicianForVipAlertClient(physician?: string | null): string {
  const raw = String(physician || '').trim();
  if (!raw || raw === '-' || raw === 'null' || raw === 'undefined') return '—';
  return /^dr\.?\s/i.test(raw) ? raw : `Dr. ${raw}`;
}

/**
 * Formats the New VIP Patient Admitted WhatsApp message on the client.
 */
export function formatVipAdmissionMessageClient(params: {
  patientName: string;
  roomNumber: string;
  physician?: string | null;
  contractor?: string | null;
  cairoTime?: string;
}): string {
  const name = String(params.patientName || '').trim() || 'Unknown';
  const room = String(params.roomNumber || '').trim() || '—';
  const physician = normalizePhysicianForVipAlertClient(params.physician);
  const contractor = normalizeContractorForVipAlertClient(params.contractor);
  const timeStr = params.cairoTime || formatCairoVipTimestampClient();

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
 * Formats the VIP Patient Discharged WhatsApp message on the client.
 */
export function formatVipDischargeMessageClient(params: {
  patientName: string;
  roomNumber: string;
  contractor?: string | null;
  cairoTime?: string;
}): string {
  const name = String(params.patientName || '').trim() || 'Unknown';
  const room = String(params.roomNumber || '').trim() || '—';
  const contractor = normalizeContractorForVipAlertClient(params.contractor);
  const timeStr = params.cairoTime || formatCairoVipTimestampClient();

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
