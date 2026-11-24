// High-performance memoized Arabic matching, O(1) indexed manual-discharge & VIP lookups,
// and explicit state/settings allowlist to eliminate Vercel Fluid Active CPU bottlenecks.

const MAX_NAME_CACHE_SIZE = 4000;
const normArabicCache = new Map<string, string>();
const normWordsCache = new Map<string, readonly string[]>();

const ARABIC_TITLES = new Set([
  'الافندي', 'افندي', 'الدكتور', 'دكتور', 'الدكتوره', 'دكتوره',
  'الاستاذ', 'استاذ', 'المهندس', 'مهندس', 'الشيخ', 'شيخ',
  'الحاج', 'حاج', 'السيد', 'سيد',
]);

const BABY_PREFIXES = new Set([
  'ابن', 'ابنه', 'طفل', 'طفله', 'مولود', 'مولوده', 'baby', 'twin',
]);

export const STATE_AND_APP_SETTINGS_PATHS: readonly string[] = [
  'state/metadata',
  'state/occupancy',
  'state/discharged',
  'state/entries',
  'state/transfers',
  'state/dialysis',
  'state/debts',
  'state/insured_debts',
  'state/medical_plans',
  'state/companion_status',
  'state/los_data',
  'state/or_list',
  'state/opd_list',
  'state/registry',
  'settings/vip_cases',
  'settings/early_discharge_rooms',
  'settings/pending_discharges',
];

export function clearNameNormalizationCaches(): void {
  normArabicCache.clear();
  normWordsCache.clear();
}

export function normalizeArabicNameCached(name: string): string {
  if (!name) return '';
  const key = String(name);
  const cached = normArabicCache.get(key);
  if (cached !== undefined) return cached;

  let clean = key.toLowerCase().trim();
  clean = clean.replace(/[\u064B-\u065F]/g, '');
  clean = clean.replace(/[^a-zA-Z\u0600-\u06FF\s]/g, ' ');
  clean = clean.replace(/\s+/g, ' ').trim();
  clean = clean.replace(/^(ابن|ابنه|بنت|طفل|طفله|حاله|حالة)\s+/, '');

  const normalized = clean
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىيِ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .replace(/(?:^|\s)عبد\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' عبد' + p1 : 'عبد' + p1))
    .replace(/(?:^|\s)ابو\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' ابو' + p1 : 'ابو' + p1))
    .replace(/(?:^|\s)ام\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' ام' + p1 : 'ام' + p1))
    .replace(/(?:^|\s)ابن\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' ابن' + p1 : 'ابن' + p1))
    .replace(/(?:^|\s)بن\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' بن' + p1 : 'بن' + p1))
    .replace(/(?:^|\s)(\S+)\s+الدين(?=\s|$)/g, (match, p1) => (match.startsWith(' ') ? ' ' + p1 + 'الدين' : p1 + 'الدين'));

  if (normArabicCache.size >= MAX_NAME_CACHE_SIZE) {
    normArabicCache.clear();
  }
  normArabicCache.set(key, normalized);
  return normalized;
}

export function getNormalizedWordsCached(name: string): string[] {
  if (!name) return [];
  const key = String(name);
  const cached = normWordsCache.get(key);
  if (cached !== undefined) return cached as string[];

  const normalized = normalizeArabicNameCached(key);
  const words = normalized.split(' ').filter((w) => w.length >= 2);

  let start = 0;
  while (words.length - start > 1 && ARABIC_TITLES.has(words[start])) {
    start++;
  }
  const trimmed = start > 0 ? words.slice(start) : words;
  const result = trimmed.map((w) => (w.startsWith('ال') && w.length > 3 ? w.substring(2) : w));

  if (normWordsCache.size >= MAX_NAME_CACHE_SIZE) {
    normWordsCache.clear();
  }
  normWordsCache.set(key, result);
  return result;
}

export function getCoreFirstWord(name: string): string {
  const words = getNormalizedWordsCached(name);
  if (words.length === 0) return '';
  if (BABY_PREFIXES.has(words[0])) {
    return words.length > 1 ? words[1] : '';
  }
  return words[0];
}

function isPascalOrJean(raw: string): { isPascal: boolean; isJean: boolean } {
  const low = String(raw || '').toLowerCase().trim();
  return {
    isPascal: low.includes('باسكال') || low.includes('pascal'),
    isJean: low.includes('jeaneldie') || low.includes('nzola') || low.includes('mpaka'),
  };
}

export function isNameMatchFast(nameA: string, nameB: string): boolean {
  if (!nameA || !nameB) return false;
  if (nameA === nameB) return true;

  const pjA = isPascalOrJean(nameA);
  const pjB = isPascalOrJean(nameB);
  if ((pjA.isPascal && pjB.isJean) || (pjA.isJean && pjB.isPascal)) {
    return true;
  }

  const normA = normalizeArabicNameCached(nameA);
  const normB = normalizeArabicNameCached(nameB);
  if (normA === normB) return true;

  const wordsA = getNormalizedWordsCached(nameA);
  const wordsB = getNormalizedWordsCached(nameB);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const offA = BABY_PREFIXES.has(wordsA[0]) ? 1 : 0;
  const offB = BABY_PREFIXES.has(wordsB[0]) ? 1 : 0;
  const lenA = wordsA.length - offA;
  const lenB = wordsB.length - offB;
  if (lenA === 0 || lenB === 0) return false;

  if (wordsA[offA] !== wordsB[offB]) return false;

  const minCoreSize = lenA < lenB ? lenA : lenB;
  if (minCoreSize === 2) {
    return wordsA[offA + 1] === wordsB[offB + 1];
  }

  if (minCoreSize >= 3) {
    const setB = new Set<string>();
    for (let i = offB; i < wordsB.length; i++) setB.add(wordsB[i]);
    const seenA = new Set<string>();
    let commonCount = 0;
    for (let i = offA; i < wordsA.length; i++) {
      const w = wordsA[i];
      if (!seenA.has(w)) {
        seenA.add(w);
        if (setB.has(w)) commonCount++;
      }
    }
    if (wordsA[offA + 1] === wordsB[offB + 1] && commonCount >= 3 && commonCount / minCoreSize >= 0.75) {
      return true;
    }
    if (commonCount >= 3 && commonCount / minCoreSize >= 0.85) {
      return true;
    }
  }

  return false;
}

export interface ManualDischargeIndex {
  isManuallyDischarged(patientName: string, admissionDateVal?: any): boolean;
}

export function createManualDischargeIndex(
  manuallyDischargedNames: string[],
  cumulativeDischarged: any[],
  parseDateToTimestamp: (val: any) => number | null
): ManualDischargeIndex {
  const safeManualNames = Array.isArray(manuallyDischargedNames) ? manuallyDischargedNames.filter(Boolean) : [];
  const safeDischarged = Array.isArray(cumulativeDischarged) ? cumulativeDischarged : [];

  const manualNamesByFirstWord = new Map<string, string[]>();
  const manualExactNorms = new Set<string>();
  const pascalManualNames: string[] = [];

  for (const mName of safeManualNames) {
    const norm = normalizeArabicNameCached(mName);
    if (norm) manualExactNorms.add(norm);
    const fw = getCoreFirstWord(mName);
    if (fw) {
      let arr = manualNamesByFirstWord.get(fw);
      if (!arr) {
        arr = [];
        manualNamesByFirstWord.set(fw, arr);
      }
      arr.push(mName);
    }
    const pj = isPascalOrJean(mName);
    if (pj.isPascal || pj.isJean) {
      pascalManualNames.push(mName);
    }
  }

  const isInManualNames = (name: string): boolean => {
    if (!name || safeManualNames.length === 0) return false;
    const norm = normalizeArabicNameCached(name);
    if (norm && manualExactNorms.has(norm)) return true;
    const pj = isPascalOrJean(name);
    if ((pj.isPascal || pj.isJean) && pascalManualNames.some((m) => isNameMatchFast(m, name))) {
      return true;
    }
    const fw = getCoreFirstWord(name);
    if (!fw) return false;
    const candidates = manualNamesByFirstWord.get(fw);
    if (!candidates) return false;
    for (const m of candidates) {
      if (isNameMatchFast(m, name)) return true;
    }
    return false;
  };

  // Pre-filter manual discharge records ONCE instead of O(P * D * M) on every call
  const manualRecordsByFirstWord = new Map<string, Array<{ name: string; discTs: number | null }>>();
  const pascalManualRecords: Array<{ name: string; discTs: number | null }> = [];
  let hasAnyManualRecords = false;

  for (const p of safeDischarged) {
    if (!p || !p.name) continue;
    const isManualRec = p.dischargeType === 'manual' || isInManualNames(p.name);
    if (!isManualRec) continue;
    hasAnyManualRecords = true;
    const entry = {
      name: String(p.name),
      discTs: parseDateToTimestamp(p.dischargeDate || p.date),
    };
    const fw = getCoreFirstWord(entry.name);
    if (fw) {
      let arr = manualRecordsByFirstWord.get(fw);
      if (!arr) {
        arr = [];
        manualRecordsByFirstWord.set(fw, arr);
      }
      arr.push(entry);
    }
    const pj = isPascalOrJean(entry.name);
    if (pj.isPascal || pj.isJean) {
      pascalManualRecords.push(entry);
    }
  }

  return {
    isManuallyDischarged(patientName: string, admissionDateVal?: any): boolean {
      if (!patientName) return false;
      if (safeManualNames.length === 0 && !hasAnyManualRecords) return false;

      const inNames = isInManualNames(patientName);
      let matchingRecords: Array<{ name: string; discTs: number | null }> | null = null;

      if (hasAnyManualRecords) {
        const fw = getCoreFirstWord(patientName);
        const bucket = fw ? manualRecordsByFirstWord.get(fw) : undefined;
        if (bucket) {
          for (const rec of bucket) {
            if (isNameMatchFast(rec.name, patientName)) {
              if (!matchingRecords) matchingRecords = [];
              matchingRecords.push(rec);
            }
          }
        }
        const pj = isPascalOrJean(patientName);
        if ((pj.isPascal || pj.isJean) && pascalManualRecords.length > 0) {
          for (const rec of pascalManualRecords) {
            if (isNameMatchFast(rec.name, patientName)) {
              if (!matchingRecords) matchingRecords = [];
              if (!matchingRecords.includes(rec)) matchingRecords.push(rec);
            }
          }
        }
      }

      if (!inNames && (!matchingRecords || matchingRecords.length === 0)) {
        return false;
      }

      if (admissionDateVal && matchingRecords && matchingRecords.length > 0) {
        const admTs = parseDateToTimestamp(admissionDateVal);
        if (admTs !== null) {
          let latestDiscTs: number | null = null;
          for (const rec of matchingRecords) {
            if (rec.discTs !== null && (latestDiscTs === null || rec.discTs > latestDiscTs)) {
              latestDiscTs = rec.discTs;
            }
          }
          if (latestDiscTs !== null && admTs > latestDiscTs) {
            return false;
          }
        }
      }

      return true;
    },
  };
}

export function extractVipNamesList(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const names: string[] = [];
  for (let line of lines) {
    line = line.replace(/^\s*\*+.*?\*+\s*$/, '').trim();
    if (!line) continue;
    line = line.replace(/^.*?\]\s*[^:]*:\s*/, '');
    line = line.replace(/^[a-zA-Z\s\d.-]+:\s*/, '');
    line = line.replace(/^(وصول|دخول)?\s*(حاله|حالة)\s*[:\\/\-\s]*/, '');
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
      names.push(line.trim());
    }
  }
  return names;
}

function getLcsLengthFast(words1: string[], words2: string[]): number {
  const m = words1.length;
  const n = words2.length;
  const prev = new Int32Array(n + 1);
  const curr = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const w1 = words1[i - 1];
    for (let j = 1; j <= n; j++) {
      if (w1 === words2[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
      }
    }
    prev.set(curr);
    curr.fill(0);
  }
  return prev[n];
}

export interface VipMatcherIndex {
  isVip(patientName: string): boolean;
}

export function createVipMatcherIndex(vipCasesText: string): VipMatcherIndex {
  if (!vipCasesText || !vipCasesText.trim()) {
    return { isVip: () => false };
  }
  const byFirstWord = new Map<string, string[][]>();
  const rawNames = extractVipNamesList(vipCasesText);
  for (const raw of rawNames) {
    const nWords = getNormalizedWordsCached(raw);
    if (nWords.length < 2) continue;
    const fw = nWords[0];
    let bucket = byFirstWord.get(fw);
    if (!bucket) {
      bucket = [];
      byFirstWord.set(fw, bucket);
    }
    bucket.push(nWords);
  }

  return {
    isVip(patientName: string): boolean {
      if (!patientName) return false;
      const pWords = getNormalizedWordsCached(patientName);
      if (pWords.length < 2) return false;
      const candidates = byFirstWord.get(pWords[0]);
      if (!candidates) return false;
      for (const nWords of candidates) {
        const shorterLen = pWords.length < nWords.length ? pWords.length : nWords.length;
        if (shorterLen >= 2 && getLcsLengthFast(pWords, nWords) === shorterLen) {
          return true;
        }
      }
      return false;
    },
  };
}
