import { getCairoDateTime } from '../historyManager';

export function normalizeRoom(roomStr: string): string {
  if (!roomStr) return "";
  return String(roomStr)
    .toUpperCase()
    .replace(/ROOM/g, "")
    .replace(/BED/g, "")
    .replace(/الغرفة/g, "")
    .replace(/غرفة/g, "")
    .replace(/[\s\-_]+/g, "")
    .trim();
}

export function cleanRoomStr(s: string): string {
  if (!s) return "";
  return String(s)
    .toUpperCase()
    .replace(/ROOM/g, "")
    .replace(/BED/g, "")
    .replace(/الغرفة/g, "")
    .replace(/غرفة/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRoomNumbers(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/،/g, ',').replace(/\n/g, ',');
  return normalized
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
}

export function isOperatingRoom(roomStr: string): boolean {
  if (!roomStr) return false;
  const bLower = String(roomStr).trim().toLowerCase();
  return /\bor\b/i.test(bLower) || 
         /\bor\d+/i.test(bLower) || 
         /\bor\s*-\s*\d+/i.test(bLower) || 
         bLower.startsWith("or-") || 
         bLower.startsWith("or -") ||
         bLower.includes("operating room") ||
         bLower.includes("operation room") ||
         bLower.includes("operating theatre") ||
         bLower.includes("عمليات");
}

export function isDialysisRoom(roomStr: string): boolean {
  if (!roomStr) return false;
  const r = String(roomStr).trim().toLowerCase();
  return (
    r.includes("dialysis") ||
    r.includes("diyalsis") ||
    r.includes("dialys") ||
    r.includes("hemodialysis") ||
    r.includes("غسيل") ||
    r.includes("كلوي") ||
    r.includes("كلى") ||
    r.includes("استصفاء")
  );
}

export function isOrXRoom(roomStr: string): boolean {
  if (!roomStr) return false;
  const bLower = String(roomStr).trim().toLowerCase();
  const clean = bLower.replace(/\s+/g, "");
  
  return /^or-\d+$/.test(clean) ||
         /^or\d+$/.test(clean) ||
         bLower === "or" ||
         bLower.startsWith("or ") ||
         bLower.startsWith("or-") ||
         bLower.startsWith("or -") ||
         bLower.includes("operating room") ||
         bLower.includes("operation room") ||
         bLower.includes("operating theatre") ||
         bLower.includes("recovery room") ||
         bLower.includes("إفاقة") ||
         bLower.includes("افاقة") ||
         bLower.includes("عمليات") ||
         /\bor\b/i.test(bLower) || 
         /\bor\d+/i.test(bLower) || 
         /\bor\s*-\s*\d+/i.test(bLower);
}

export function isProcedureOrTemporaryRoom(room: string): boolean {
  if (!room) return false;
  const low = String(room).toLowerCase();
  return isOperatingRoom(room) ||
         isOrXRoom(room) ||
         isDialysisRoom(room) ||
         low.includes("er") ||
         low.includes("طوارئ") ||
         low.includes("cath") ||
         low.includes("قسطرة") ||
         low.includes("endoscopy") ||
         low.includes("مناظير") ||
         low.includes("or-") ||
         low.includes("recovery");
}

export function formatDateToUserFormat(dateObj: Date): string {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth() + 1;
  const d = dateObj.getDate();
  const h = dateObj.getHours();
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const yy = String(y).slice(-2);
  return `${m}/${d}/${yy} ${h}:${min}`;
}

export function cleanAdmissionDateStr(val: any): string {
  if (val === undefined || val === null) return "";
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    return formatDateToUserFormat(val);
  }
  let str = String(val).trim();
  if (!str) return "";

  // Convert Arabic numerals to Western digits
  str = str.replace(/[٠-٩]/g, d => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);

  // Check if it's a Unix timestamp in milliseconds (typically 13 digits)
  if (/^\d{13}$/.test(str)) {
    const ts = parseInt(str, 10);
    const dateObj = new Date(ts);
    if (!isNaN(dateObj.getTime())) return formatDateToUserFormat(dateObj);
  }

  // Check if it's a Unix timestamp in seconds (10 digits)
  if (/^\d{10}$/.test(str)) {
    const ts = parseInt(str, 10) * 1000;
    const dateObj = new Date(ts);
    if (!isNaN(dateObj.getTime())) return formatDateToUserFormat(dateObj);
  }

  // Check if it's a standard JS serial date (if read from Excel but imported wrong as a raw float/number)
  const num = parseFloat(str);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const dateObj = new Date((num - 25569) * 86400 * 1000);
    if (!isNaN(dateObj.getTime())) return formatDateToUserFormat(dateObj);
  }

  // Try parsing the string to Date with format awareness
  try {
    let cleanStr = str.replace(/\s+/g, ' ');
    const isPM = /pm|م/i.test(cleanStr);
    const isAM = /am|ص/i.test(cleanStr);
    cleanStr = cleanStr.replace(/am|pm|ص|م/gi, '').trim();
    
    // Pattern 1: YYYY-MM-DD HH:mm:ss or YYYY/MM/DD ...
    const matchYMD = cleanStr.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (matchYMD) {
      const y = parseInt(matchYMD[1], 10);
      const m = parseInt(matchYMD[2], 10) - 1;
      const d = parseInt(matchYMD[3], 10);
      let h = parseInt(matchYMD[4] || "0", 10);
      const min = parseInt(matchYMD[5] || "0", 10);
      const sec = parseInt(matchYMD[6] || "0", 10);
      if (isPM && h < 12) h += 12;
      if (isAM && h === 12) h = 0;
      const dateObj = new Date(y, m, d, h, min, sec);
      if (!isNaN(dateObj.getTime()) && dateObj.getDate() === d) {
        return formatDateToUserFormat(dateObj);
      }
    }

    // Pattern 2 & 3: num1/num2/year (where year is 2 or 4 digits, delimiter can be / - or .)
    const matchD1D2Y = cleanStr.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (matchD1D2Y) {
      const n1 = parseInt(matchD1D2Y[1], 10);
      const n2 = parseInt(matchD1D2Y[2], 10);
      let y = parseInt(matchD1D2Y[3], 10);
      if (y < 100) y += 2000;
      let h = parseInt(matchD1D2Y[4] || "0", 10);
      const min = parseInt(matchD1D2Y[5] || "0", 10);
      const sec = parseInt(matchD1D2Y[6] || "0", 10);
      if (isPM && h < 12) h += 12;
      if (isAM && h === 12) h = 0;

      let month = 0, day = 1;
      if (n1 > 12 && n2 <= 12) {
        day = n1;
        month = n2 - 1;
      } else if (n2 > 12 && n1 <= 12) {
        month = n1 - 1;
        day = n2;
      } else {
        const cMonth = new Date().getMonth();
        if (n1 - 1 === cMonth) {
          month = n1 - 1;
          day = n2;
        } else if (n2 - 1 === cMonth) {
          day = n1;
          month = n2 - 1;
        } else {
          month = n1 - 1;
          day = n2;
        }
      }

      const dateObj = new Date(y, month, day, h, min, sec);
      if (!isNaN(dateObj.getTime()) && dateObj.getDate() === day && dateObj.getMonth() === month) {
        return formatDateToUserFormat(dateObj);
      }
    }

    const parsed = new Date(cleanStr);
    if (!isNaN(parsed.getTime())) {
      return formatDateToUserFormat(parsed);
    }
  } catch (err) {}

  return str;
}

export function parseDateComponents(dateStr: any): { y: number; m: number; d: number } | null {
  if (dateStr === undefined || dateStr === null) return null;
  if (dateStr instanceof Date) {
    if (isNaN(dateStr.getTime())) return null;
    return { y: dateStr.getFullYear(), m: dateStr.getMonth() + 1, d: dateStr.getDate() };
  }
  let s = String(dateStr || "").trim();
  if (!s) return null;
  s = s.replace(/[٠-٩]/g, ch => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(ch)]);

  // Handle ISO-like format: 2026-09-13T... or 2026-09-13
  if (s.includes('T')) {
    const datePart = s.split('T')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const d = parseInt(parts[2], 10);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d)) return { y, m, d };
    }
  }

  const numbers = s.match(/\d+/g)?.map(n => parseInt(n, 10)) || [];
  if (numbers.length >= 3) {
    const [n1, n2, n3] = numbers;
    // Format YYYY-MM-DD
    if (n1 >= 2000 && n1 <= 2100 && n2 >= 1 && n2 <= 12 && n3 >= 1 && n3 <= 31) {
      return { y: n1, m: n2, d: n3 };
    }
    // Format MM/DD/YYYY or DD/MM/YYYY
    if (n3 >= 2000 && n3 <= 2100) {
      if (n1 >= 1 && n1 <= 12 && n2 >= 1 && n2 <= 31) {
        return { y: n3, m: n1, d: n2 };
      }
      return { y: n3, m: n2, d: n1 };
    }
    // Format MM/DD/YY or DD/MM/YY
    if (n3 >= 0 && n3 <= 99) {
      const fullYear = 2000 + n3;
      if (n1 >= 1 && n1 <= 12 && n2 >= 1 && n2 <= 31) {
        return { y: fullYear, m: n1, d: n2 };
      }
      return { y: fullYear, m: n2, d: n1 };
    }
  }

  const parsedTime = Date.parse(s);
  if (!isNaN(parsedTime)) {
    const pDate = new Date(parsedTime);
    return { y: pDate.getFullYear(), m: pDate.getMonth() + 1, d: pDate.getDate() };
  }

  return null;
}

export function isToday(dateStr: any, referenceDate?: string | Date | null): boolean {
  if (dateStr === undefined || dateStr === null) return false;
  let d = String(dateStr || "").trim();
  if (!d) return false;
  if (d.includes('اليوم') || d.toLowerCase().includes('today')) return true;

  const inputComp = parseDateComponents(dateStr);
  if (!inputComp) return false;

  // Check against referenceDate if provided
  if (referenceDate) {
    const refComp = parseDateComponents(referenceDate);
    if (refComp) {
      if (inputComp.y === refComp.y && inputComp.m === refComp.m && inputComp.d === refComp.d) {
        return true;
      }
    }
  }

  // Check against today's calendar date in Cairo/Riyadh timezones
  const timezones = ["Africa/Cairo", "Asia/Riyadh"];
  for (const tz of timezones) {
    try {
      const today = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
      const year = today.getFullYear();
      const month = today.getMonth() + 1;
      const day = today.getDate();

      if (inputComp.y === year && inputComp.m === month && inputComp.d === day) {
        return true;
      }
    } catch (e) {}
  }

  return false;
}

export function getTodayRiyadhDateStr(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getTodayRiyadhDateTimeStr(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function isDateStringFromPreviousDay(dateStr: string, cairoTodayStr: string): boolean {
  if (!dateStr || !cairoTodayStr) return false;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return false;
  const itemDate = match[1] + '-' + match[2] + '-' + match[3];
  return itemDate < cairoTodayStr;
}

export function normalizeArabicName(name: string): string {
  if (!name) return "";
  let n = name.trim().toLowerCase();
  
  // Remove titles & honorifics
  n = n.replace(/^(د\/|د\.|دكتور\/|دكتور|استاذ\/|أستاذ\/|السيد\/|السيد|السيدة\/|السيدة|م\/|مهندس\/|baby\s+of|baby|طفل|طفلة|ابن|ابنة|مولود|مولودة|twin\s*\d*)\s+/gi, "");

  // Remove diacritics
  n = n.replace(/[\u064B-\u065F\u0670]/g, "");
  // Normalize alef variations
  n = n.replace(/[أإآٱ]/g, "ا");
  // Normalize taa marbuta
  n = n.replace(/ة/g, "ه");
  // Normalize yaa
  n = n.replace(/ى/g, "ي");
  // Normalize common compound names
  n = n.replace(/\bعبد\s+/g, "عبد");
  n = n.replace(/\bابو\s+/g, "ابو");
  n = n.replace(/\bام\s+/g, "ام");
  // Normalize alif-lam prefix for common names (e.g. السيد -> سيد)
  n = n.replace(/\bال([^\s]{3,})/g, "$1");
  // Remove special characters, symbols, and extra spaces
  n = n.replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ");
  return n.replace(/\s+/g, " ").trim();
}

export function normalizeArabicString(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/^(د\/|د\.|دكتور\/|دكتور|استاذ\/|أستاذ\/|السيد\/|السيد|السيدة\/|السيدة|م\/|مهندس\/|baby\s+of|baby|طفل|طفلة|ابن|ابنة|مولود|مولودة|twin\s*\d*)\s+/gi, "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\bعبد\s+/g, "عبد")
    .replace(/\bابو\s+/g, "ابو")
    .replace(/\bام\s+/g, "ام")
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getNormalizedWords(name: string): string[] {
  const norm = normalizeArabicName(name);
  if (!norm) return [];
  return norm.split(" ").filter(w => w.length > 1);
}

export function getLcsLength(words1: string[], words2: string[]): number {
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

export function isManualEquivalent(n1: string, n2: string): boolean {
  if (!n1 || !n2) return false;
  const norm1 = normalizeArabicName(n1);
  const norm2 = normalizeArabicName(n2);
  
  if (norm1 === norm2) return true;
  
  const low1 = n1.toLowerCase();
  const low2 = n2.toLowerCase();
  
  const isPascal1 = low1.includes("باسكال") || low1.includes("pascal");
  const isJean1 = low1.includes("jeaneldie") || low1.includes("nzola") || low1.includes("mpaka");
  const isPascal2 = low2.includes("باسكال") || low2.includes("pascal");
  const isJean2 = low2.includes("jeaneldie") || low2.includes("nzola") || low2.includes("mpaka");
  if ((isPascal1 && isJean2) || (isJean1 && isPascal2)) return true;

  return false;
}

export function isNameMatch(nameA: string, nameB: string): boolean {
  if (!nameA || !nameB) return false;
  if (isManualEquivalent(nameA, nameB)) return true;
  
  const normA = normalizeArabicName(nameA);
  const normB = normalizeArabicName(nameB);
  if (normA === normB) return true;
  
  const wordsA = getNormalizedWords(nameA);
  const wordsB = getNormalizedWords(nameB);
  
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const babyPrefixes = ["ابن", "ابنه", "طفل", "طفله", "مولود", "مولوده", "baby", "twin"];
  const isBabyA = babyPrefixes.includes(wordsA[0]);
  const isBabyB = babyPrefixes.includes(wordsB[0]);

  const coreWordsA = isBabyA ? wordsA.slice(1) : wordsA;
  const coreWordsB = isBabyB ? wordsB.slice(1) : wordsB;

  if (coreWordsA.length === 0 || coreWordsB.length === 0) return false;

  // First given name MUST match!
  if (coreWordsA[0] !== coreWordsB[0]) {
    return false;
  }

  const minCoreSize = Math.min(coreWordsA.length, coreWordsB.length);
  const setA = new Set(coreWordsA);
  const setB = new Set(coreWordsB);
  const commonWords = [...setA].filter(w => setB.has(w));

  // If both have 2 words or one is 2 words
  if (minCoreSize === 2) {
    if (coreWordsA[0] === coreWordsB[0] && coreWordsA[1] === coreWordsB[1]) {
      return true;
    }
  }

  // 3 or more words:
  if (minCoreSize >= 3) {
    if (coreWordsA[0] === coreWordsB[0] && coreWordsA[1] === coreWordsB[1] && commonWords.length >= 2) {
      return true;
    }
    if (commonWords.length >= 3 && (commonWords.length / minCoreSize) >= 0.7) {
      return true;
    }
  } else if (minCoreSize >= 2) {
    if (commonWords.length >= 2) {
      return true;
    }
  }

  return normA === normB;
}

export function isPatientMatch(
  a: { mrn?: string; name: string },
  b: { mrn?: string; name: string }
): boolean {
  const cleanMrnA = String(a.mrn || "").trim().replace(/^0+/, "");
  const cleanMrnB = String(b.mrn || "").trim().replace(/^0+/, "");
  if (cleanMrnA && cleanMrnB && cleanMrnA.length >= 3 && cleanMrnB.length >= 3) {
    if (cleanMrnA === cleanMrnB) return true;
  }
  return isNameMatch(a.name, b.name);
}

export function isWholeNameMatch(name1: string, name2: string, isTaggedOut: boolean = false): boolean {
  if (isManualEquivalent(name1, name2)) return true;

  const norm1 = normalizeArabicString(name1);
  const norm2 = normalizeArabicString(name2);

  if (!norm1 || !norm2) return false;
  if (norm1 === norm2) return true;

  const words1 = norm1.split(" ").filter(w => w.length > 2);
  const words2 = norm2.split(" ").filter(w => w.length > 2);

  if (words1.length === 0 || words2.length === 0) return false;

  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const uniqueIntersection = [...set1].filter(w => set2.has(w));
  const minUniqueSize = Math.min(set1.size, set2.size);
  const matchRatio = uniqueIntersection.length / Math.max(set1.size, 1);

  if (isTaggedOut) {
    return (uniqueIntersection.length >= 3 && matchRatio >= 0.75) || (norm1 === norm2);
  }

  if (minUniqueSize >= 3) {
    return uniqueIntersection.length >= 2 && words1[0] === words2[0];
  } else if (minUniqueSize >= 2) {
    return (uniqueIntersection.length >= 2 && words1[0] === words2[0]) || (norm1 === norm2);
  } else {
    return norm1 === norm2;
  }
}

export function isPhysicianMatch(p1: string, p2: string): boolean {
  if (!p1 || !p2) return false;
  const clean1 = p1.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ").replace(/\s+/g, " ").trim();
  const clean2 = p2.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ").replace(/\s+/g, " ").trim();
  if (clean1 === clean2) return true;
  
  const norm1 = normalizeArabicName(clean1);
  const norm2 = normalizeArabicName(clean2);
  if (norm1 === norm2) return true;

  const words1 = norm1.split(" ").filter(w => w.length > 2);
  const words2 = norm2.split(" ").filter(w => w.length > 2);
  if (words1.length === 0 || words2.length === 0) return false;

  const common = words1.filter(w => words2.includes(w));
  return common.length >= 1;
}

export function transliterateWord(w: string): string {
  return normalizeArabicString(w);
}

export function getFirstWord(name: string): string {
  const norm = normalizeArabicString(name);
  if (!norm) return "";
  const parts = norm.split(" ").filter(w => w.length > 1);
  return parts[0] || "";
}

export function isPatientFirstNameMatch(name1: string, name2: string): boolean {
  const f1 = getFirstWord(name1);
  const f2 = getFirstWord(name2);
  if (!f1 || !f2) return false;
  return f1 === f2;
}

export function isMRNMatch(mrn1: string, mrn2: string): boolean {
  const c1 = String(mrn1 || "").trim().replace(/^0+/, "");
  const c2 = String(mrn2 || "").trim().replace(/^0+/, "");
  if (!c1 || !c2) return false;
  if (c1.length < 3 || c2.length < 3) return false;
  return c1 === c2;
}

export function normalizeCategoryName(catStr: string): string {
  if (!catStr) return "";
  const s = String(catStr).trim();
  if (s.includes("مميز شمالي") || s.toLowerCase().includes("premium north")) return "مميز شمالي";
  if (s.includes("مميز جنوبي") || s.toLowerCase().includes("premium south")) return "مميز جنوبي";
  if (s.includes("أولي عاديه") || s.includes("أولى عادية") || s.includes("أولى عاديه") || s.includes("اولى عاديه") || s.toLowerCase().includes("first class")) return "أولي عاديه";
  if (s.includes("جونيور سويت") || s.toLowerCase().includes("junior suite")) return "جونيور سويت";
  if (s.includes("رويال سويت") || s.toLowerCase().includes("royal suite")) return "رويال سويت";
  if (s.includes("امبريال سويت") || s.toLowerCase().includes("imperial suite")) return "امبريال سويت";
  if (s.includes("بانوراما") || s.toLowerCase().includes("panorama")) return "بانوراما";
  if (s.includes("Day Case") || s.includes("daycase") || s.includes("يومي")) return "Day Case";
  return s;
}

export function getAccommodationCategory(roomStr: string): string {
  if (!roomStr) return "غير مصنف";
  
  let r = roomStr.toUpperCase()
    .replace(/ROOM/g, "")
    .replace(/BED/g, "")
    .replace(/الغرفة/g, "")
    .replace(/غرفة/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (r.match(/^33[01]\s*[-/]?\s*[AB]$/)) {
    return "مميز جنوبي";
  }
  if (r === "330" || r === "331") {
    return "امبريال سويت";
  }
  if (r === "332") {
    return "رويال سويت";
  }

  const match10 = r.match(/^10([1-7])(?:\s*-\s*([12]))?$/);
  if (match10) {
    const x = match10[1];
    if (x === "1" || x === "4" || x === "5") {
      return "Day Case";
    }
    if (x === "2" || x === "3" || x === "6" || x === "7") {
      return "مميز جنوبي";
    }
  }

  const specMatch = r.match(/\d+/);
  if (specMatch) {
    const num = specMatch[0];
    if (num === "101" || num === "104" || num === "105") {
      return "Day Case";
    }
    if (num === "102" || num === "103" || num === "106" || num === "107") {
      return "مميز جنوبي";
    }
  }

  if (r.match(/^10[1-7]\s*-\s*[12]$/) || r.includes("DAYCASE") || r.includes("DAY CASE")) {
    return "Day Case";
  }

  if (r.match(/^40[1-5]\s*[-/]?\s*[AB]$/)) {
    return "مميز شمالي";
  }
  if (r === "401" || r === "402" || r === "403" || r === "404" || r === "405") {
    return "رويال سويت";
  }

  const premiumNorth = ["301", "302", "303", "304", "305"];
  const premiumSouth = [
    "102", "103", "106", "107",
    "314", "315", "316", "317", "320", "321", "322", "323", "324", "325", "326", "327", 
    "415", "416", "417", "418", "419", "420", "421", "422"
  ];
  const firstClass = ["307 INTERMEDIATE CARE", "307", "308", "318", "319", "328", "329", "406", "407", "409", "410", "411"];
  const juniorSuite = ["309", "310", "311", "312", "313", "412", "413", "414"];
  const royalSuite = ["408"];
  const panorama = ["306"];

  if (premiumNorth.some(x => r === x || r.startsWith(x + " ") || r.endsWith(" " + x))) {
    return "مميز شمالي";
  }
  if (premiumSouth.some(x => r === x || r.startsWith(x + " ") || r.endsWith(" " + x))) {
    return "مميز جنوبي";
  }
  if (firstClass.some(x => r === x || r.includes(x) || r.startsWith(x) || r.startsWith("307"))) {
    return "أولي عاديه";
  }
  if (juniorSuite.some(x => r === x || r.startsWith(x + " ") || r.endsWith(" " + x))) {
    return "جونيور سويت";
  }
  if (royalSuite.some(x => r === x || r.startsWith(x + " ") || r.endsWith(" " + x))) {
    return "رويال سويت";
  }
  if (panorama.some(x => r === x || r.startsWith(x + " ") || r.endsWith(" " + x))) {
    return "بانوراما";
  }

  const numMatch = r.match(/\d+/);
  if (numMatch) {
    const num = numMatch[0];
    if (["101", "104", "105"].includes(num)) return "Day Case";
    if (["102", "103", "106", "107"].includes(num)) return "مميز جنوبي";
    if (["301", "302", "303", "304", "305"].includes(num)) return "مميز شمالي";
    if (["314", "315", "316", "317", "320", "321", "322", "323", "324", "325", "326", "327"].includes(num)) return "مميز جنوبي";
    if (["415", "416", "417", "418", "419", "420", "421", "422"].includes(num)) return "مميز جنوبي";
    if (["307", "308", "318", "319", "328", "329", "406", "407", "409", "410", "411"].includes(num)) return "أولي عاديه";
    if (["309", "310", "311", "312", "313", "412", "413", "414"].includes(num)) return "جونيور سويت";
    if (["401", "402", "403", "404", "405", "408"].includes(num)) return "رويال سويت";
    if (num === "306") return "بانوراما";
  }

  return "غير مصنف";
}

export function getFloorFromRoom(roomStr: string): string {
  const r = String(roomStr || "").toUpperCase();
  if (r.startsWith("10") || r.includes("1ST") || r.includes("FIRST")) return "Floor 1";
  if (r.startsWith("3") || r.includes("3RD") || r.includes("THIRD")) return "Floor 3";
  if (r.startsWith("4") || r.includes("4TH") || r.includes("FOURTH")) return "Floor 4";
  if (r.includes("ICU") || r.includes("CCU") || r.includes("SICU") || r.includes("NICU") || r.includes("PICU") || r.includes("VIP")) return "Critical Care";
  return "Other";
}

export function computeLOSFromDate(admDateStr: string): number | string {
  if (!admDateStr) return "N/A";
  try {
    const cleaned = cleanAdmissionDateStr(admDateStr);
    const datePart = cleaned.split(" ")[0];
    const parsed = new Date(datePart);
    if (isNaN(parsed.getTime())) return "N/A";
    const now = new Date();
    const diffMs = now.getTime() - parsed.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return Math.max(0, days);
  } catch (err) {
    return "N/A";
  }
}

export function isCashPayment(payment: string): boolean {
  if (!payment) return false;
  const p = payment.toString().toLowerCase().trim();
  return p.includes('cash') || p.includes('كاش') || p.includes('نقد') || p.includes('نقدي');
}

export function isPrivateCreditCase(p: any): boolean {
  if (!p) return false;
  const payment = String(p.paidBy || p.payment || "").toLowerCase().trim();
  const contractor = String(p.contractorName || p.contractor || "").toLowerCase().trim();
  const vt = String(p.vt || "").toLowerCase().trim();
  const col3 = String(p.column3 || "").toLowerCase().trim();

  const isCash = isCashPayment(payment) || isCashPayment(contractor);
  const isCredit = contractor.includes("credit") || contractor.includes("اجل") || contractor.includes("آجل") || contractor.includes("شركة") || contractor.includes("شركه") || contractor.includes("insurance") || contractor.includes("تأمين") || contractor.includes("تامين");
  const isPrivate = contractor.includes("private") || contractor.includes("خاص") || payment.includes("private");

  return isCredit && isPrivate;
}
