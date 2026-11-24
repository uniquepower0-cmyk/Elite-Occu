import { describe, it, expect } from 'vitest';
import {
  normalizeArabicNameCached,
  getNormalizedWordsCached,
  isNameMatchFast,
  createManualDischargeIndex,
  createVipMatcherIndex,
  STATE_AND_APP_SETTINGS_PATHS,
  clearNameNormalizationCaches,
} from './cpuOptimizationHelpers';

// Reference legacy implementations copied verbatim from server.ts for strict equivalence testing
function legacyNormalizeArabicName(name: string): string {
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
    .replace(/(?:^|\s)عبد\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' عبد' + p1 : 'عبد' + p1))
    .replace(/(?:^|\s)ابو\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' ابو' + p1 : 'ابو' + p1))
    .replace(/(?:^|\s)ام\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' ام' + p1 : 'ام' + p1))
    .replace(/(?:^|\s)ابن\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' ابن' + p1 : 'ابن' + p1))
    .replace(/(?:^|\s)بن\s+(\S+)/g, (match, p1) => (match.startsWith(' ') ? ' بن' + p1 : 'بن' + p1))
    .replace(/(?:^|\s)(\S+)\s+الدين(?=\s|$)/g, (match, p1) => (match.startsWith(' ') ? ' ' + p1 + 'الدين' : p1 + 'الدين'));
}

function legacyGetNormalizedWords(name: string): string[] {
  const normalized = legacyNormalizeArabicName(name);
  const titles = ['الافندي', 'افندي', 'الدكتور', 'دكتور', 'الدكتوره', 'دكتوره', 'الاستاذ', 'استاذ', 'المهندس', 'مهندس', 'الشيخ', 'شيخ', 'الحاج', 'حاج', 'السيد', 'سيد'];
  const words = normalized.split(' ').filter((w) => w.length >= 2);
  while (words.length > 1 && titles.includes(words[0])) {
    words.shift();
  }
  return words.map((w) => (w.startsWith('ال') && w.length > 3 ? w.substring(2) : w));
}

function legacyIsNameMatch(nameA: string, nameB: string): boolean {
  if (!nameA || !nameB) return false;
  const lowA = String(nameA).toLowerCase().trim();
  const lowB = String(nameB).toLowerCase().trim();
  const isPascalA = lowA.includes('باسكال') || lowA.includes('pascal');
  const isJeanA = lowA.includes('jeaneldie') || lowA.includes('nzola') || lowA.includes('mpaka');
  const isPascalB = lowB.includes('باسكال') || lowB.includes('pascal');
  const isJeanB = lowB.includes('jeaneldie') || lowB.includes('nzola') || lowB.includes('mpaka');
  if ((isPascalA && isJeanB) || (isJeanA && isPascalB)) return true;

  const normA = legacyNormalizeArabicName(nameA);
  const normB = legacyNormalizeArabicName(nameB);
  if (normA === normB) return true;

  const wordsA = legacyGetNormalizedWords(nameA);
  const wordsB = legacyGetNormalizedWords(nameB);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const babyPrefixes = ['ابن', 'ابنه', 'طفل', 'طفله', 'مولود', 'مولوده', 'baby', 'twin'];
  const coreWordsA = babyPrefixes.includes(wordsA[0]) ? wordsA.slice(1) : wordsA;
  const coreWordsB = babyPrefixes.includes(wordsB[0]) ? wordsB.slice(1) : wordsB;
  if (coreWordsA.length === 0 || coreWordsB.length === 0) return false;
  if (coreWordsA[0] !== coreWordsB[0]) return false;

  const minCoreSize = Math.min(coreWordsA.length, coreWordsB.length);
  const setA = new Set(coreWordsA);
  const setB = new Set(coreWordsB);
  const commonWords = [...setA].filter((w) => setB.has(w));

  if (minCoreSize === 2) {
    if (coreWordsA[0] === coreWordsB[0] && coreWordsA[1] === coreWordsB[1]) return true;
  }
  if (minCoreSize >= 3) {
    if (coreWordsA[0] === coreWordsB[0] && coreWordsA[1] === coreWordsB[1] && commonWords.length >= 3 && commonWords.length / minCoreSize >= 0.75) {
      return true;
    }
    if (coreWordsA[0] === coreWordsB[0] && commonWords.length >= 3 && commonWords.length / minCoreSize >= 0.85) {
      return true;
    }
  }
  return normA === normB;
}

describe('cpuOptimizationHelpers', () => {
  it('normalizeArabicNameCached & getNormalizedWordsCached match legacy behavior exactly', () => {
    clearNameNormalizationCaches();
    const samples = [
      'أحمد عبد الله محمد حسام الدين',
      'احمد عبدالله محمد حسامالدين',
      'الدكتور محمد ابو بكر الصديق',
      'حالة مريض عبد الرحمن بن علي',
      'طفل روان أسامة حسن علي',
      'باسكال نزولا',
      'Jeaneldie Mpaka',
      'مُحَمَّدُ إِبْرَاهِيمَ الشَّافِعِيّ',
      '',
    ];
    for (const s of samples) {
      expect(normalizeArabicNameCached(s)).toBe(legacyNormalizeArabicName(s));
      expect(getNormalizedWordsCached(s)).toEqual(legacyGetNormalizedWords(s));
      // Second call hits cache and must still be identical (and not mutated)
      expect(normalizeArabicNameCached(s)).toBe(legacyNormalizeArabicName(s));
      expect(getNormalizedWordsCached(s)).toEqual(legacyGetNormalizedWords(s));
    }
  });

  it('isNameMatchFast matches legacyIsNameMatch across all pairs including Pascal alias and Arabic variants', () => {
    const names = [
      'أحمد عبد الله محمد علي',
      'احمد عبدالله محمد علي',
      'احمد عبدالله ابراهيم',
      'روان اسامه',
      'روان اسامه حسن علي',
      'طفل روان اسامه حسن علي',
      'باسكال مريض',
      'Jeaneldie Nzola',
      'محمد علي حسن محمود',
      'محمد حسن محمود علي',
      'سارة فتحي محمود',
    ];
    for (const a of names) {
      for (const b of names) {
        expect(isNameMatchFast(a, b)).toBe(legacyIsNameMatch(a, b));
      }
    }
  });

  it('createManualDischargeIndex preserves exact manual/auto/re-admission semantics in O(1) lookup', () => {
    const parseDateToTs = (v: any) => {
      if (!v) return null;
      const t = Date.parse(String(v));
      return Number.isNaN(t) ? null : t;
    };

    const manualNames = [
      'أحمد عبد الله محمد علي',
      'باسكال مريض',
      'روان اسامه حسن',
    ];
    const discharged = [
      { name: 'أحمد عبدالله محمد علي', dischargeType: 'manual', dischargeDate: '2026-11-24T10:00:00Z' },
      { name: 'خالد ابراهيم محمود', dischargeType: 'auto', dischargeDate: '2026-11-24T09:00:00Z' },
      { name: 'سارة فتحي احمد', dischargeType: 'manual', dischargeDate: '2026-11-24T08:00:00Z' },
      { name: 'روان اسامه حسن علي', dischargeType: 'auto', dischargeDate: '2026-11-24T11:00:00Z' },
    ];

    const idx = createManualDischargeIndex(manualNames, discharged, parseDateToTs);

    // Direct manual name match
    expect(idx.isManuallyDischarged('احمد عبدالله محمد علي')).toBe(true);
    // Re-admission AFTER latest manual discharge timestamp overrides exclusion
    expect(idx.isManuallyDischarged('احمد عبدالله محمد علي', '2026-11-24T12:00:00Z')).toBe(false);
    // Admission BEFORE manual discharge remains excluded
    expect(idx.isManuallyDischarged('احمد عبدالله محمد علي', '2026-11-24T09:00:00Z')).toBe(true);
    // Manual discharge record even if not in manuallyDischargedNames
    expect(idx.isManuallyDischarged('ساره فتحي احمد')).toBe(true);
    // Auto discharge whose name is NOT in manuallyDischargedNames must return false
    expect(idx.isManuallyDischarged('خالد ابراهيم محمود')).toBe(false);
    // Auto discharge whose name IS in manuallyDischargedNames counts as manual and respects timestamp
    expect(idx.isManuallyDischarged('روان اسامه حسن علي', '2026-11-24T10:00:00Z')).toBe(true);
    expect(idx.isManuallyDischarged('روان اسامه حسن علي', '2026-11-24T13:00:00Z')).toBe(false);
    // Special Pascal <-> Jeaneldie cross-script alias
    expect(idx.isManuallyDischarged('Jeaneldie Nzola')).toBe(true);
    // Unrelated patient
    expect(idx.isManuallyDischarged('محمود سعيد كامل')).toBe(false);
  });

  it('createVipMatcherIndex matches multi-word VIP names accurately and rejects single-word/unrelated names', () => {
    const vipText = [
      '*VIP CASES*',
      '[7:18 PM, 6/3/2026] Mohanad: علاء حسن محمود.. room 301',
      '1- حالة: أحمد عبد الله السيد علي',
      'New Patient Admission - Dr. Mohamed Hamed: ساره فتحي ابراهيم',
      'وحيد',
    ].join('\n');

    const matcher = createVipMatcherIndex(vipText);
    expect(matcher.isVip('علاء حسن محمود')).toBe(true);
    expect(matcher.isVip('علاء محمد حسن محمود')).toBe(true);
    expect(matcher.isVip('احمد عبدالله السيد علي')).toBe(true);
    expect(matcher.isVip('سارة فتحي إبراهيم كامل')).toBe(true);
    expect(matcher.isVip('محمد علاء حسن')).toBe(false); // first name differs
    expect(matcher.isVip('وحيد')).toBe(false); // single word
    expect(matcher.isVip('خالد سمير علي')).toBe(false);
  });

  it('STATE_AND_APP_SETTINGS_PATHS includes all app state/settings nodes and strictly excludes sync_runners and sync_control', () => {
    expect(STATE_AND_APP_SETTINGS_PATHS).toContain('state/occupancy');
    expect(STATE_AND_APP_SETTINGS_PATHS).toContain('state/metadata');
    expect(STATE_AND_APP_SETTINGS_PATHS).toContain('state/opd_list');
    expect(STATE_AND_APP_SETTINGS_PATHS).toContain('settings/vip_cases');
    expect(STATE_AND_APP_SETTINGS_PATHS).toContain('settings/early_discharge_rooms');
    expect(STATE_AND_APP_SETTINGS_PATHS).toContain('settings/pending_discharges');
    expect(STATE_AND_APP_SETTINGS_PATHS).not.toContain('settings/sync_runners');
    expect(STATE_AND_APP_SETTINGS_PATHS).not.toContain('settings/sync_control');
  });
});
