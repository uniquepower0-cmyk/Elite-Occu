import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import * as xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import dotenv from 'dotenv';
import fs from 'fs';
import sharp from 'sharp';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import admin from 'firebase-admin';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { getDatabase as getAdminDatabase } from 'firebase-admin/database';

dotenv.config();

// --- MONKEY PATCH EXCELJS FOR A4 PRINT PREPARATION (COLUMN-TO-COLUMN) ---
const originalAddWorksheet = ExcelJS.Workbook.prototype.addWorksheet;
(ExcelJS.Workbook.prototype as any).addWorksheet = function (name: string, options: any = {}) {
  // Identify if this worksheet is for medical plans (traditional or refined) or VIP cases medical updates.
  // We match general group sheet names ("ICU", "VIP", "SICU", etc.) and room-range patterns as well as explicit flags on "this" (the Workbook).
  const isMedicalPlan = (this as any).isMedicalPlans === true ||
                        name === 'VIP Cases Medical Updates' ||
                        ['ICU', 'VIP', 'SICU', 'CCU', 'NICU', 'PICU', 'Others', 'Medical Plans', 'Medical Plans Refined'].includes(name) ||
                        /^\d+-\d+$/.test(name) ||
                        /^Floor \d+$/.test(name);

  const orientation = isMedicalPlan ? 'landscape' : 'portrait';

  const defaultPageSetup = {
    paperSize: 9, // A4 Paper size
    orientation: orientation,
    fitToPage: true,
    fitToWidth: 1, // Fit all columns to page width
    fitToHeight: 0, // Let rows spill over naturally without scaling height
    margins: {
      left: 0.25,
      right: 0.25,
      top: 0.25,
      bottom: 0.25,
      header: 0.15,
      footer: 0.15
    }
  };

  options.pageSetup = {
    ...defaultPageSetup,
    ...options.pageSetup,
    margins: {
      ...defaultPageSetup.margins,
      ...(options.pageSetup?.margins || {})
    }
  };

  // Ensure grid lines are visible during printing and layout views
  if (!options.views) {
    options.views = [{ showGridLines: true }];
  } else {
    options.views.forEach((view: any) => {
      view.showGridLines = view.showGridLines !== false;
    });
  }

  return originalAddWorksheet.call(this, name, options);
};

let localFilename = "";
let localDirname = "";
try {
  if (typeof import.meta !== "undefined" && import.meta.url) {
    localFilename = fileURLToPath(import.meta.url);
    localDirname = path.dirname(localFilename);
  } else {
    localFilename = eval("__filename");
    localDirname = eval("__dirname");
  }
} catch (e) {
  try {
    localFilename = eval("__filename");
    localDirname = eval("__dirname");
  } catch (err) {
    localFilename = "";
    localDirname = "";
  }
}

const __filename = localFilename;
const __dirname = localDirname;

// Initialize Firebase Admin for the backend Server
const CONFIG_PATH = path.join(process.cwd(), 'firebase-applet-config.json');
const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'service-account-key.json'); // <--- New line
let adminDb: any = null;
let adminRTDB: any = null;

if (fs.existsSync(CONFIG_PATH) && fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8')); // <--- Read the key
    
    let adminApp;
    if (admin.apps.length === 0) {
      adminApp = admin.initializeApp({
        projectId: config.projectId,
        credential: admin.credential.cert(serviceAccount), // <--- Use the explicit key here
        databaseURL: `https://${config.projectId}-default-rtdb.firebaseio.com`
      });
    } else {
      adminApp = admin.apps[0];
    }
    
    if (config.firestoreDatabaseId && config.firestoreDatabaseId !== '(default)') {
      adminDb = getAdminFirestore(adminApp, config.firestoreDatabaseId);
    } else {
      adminDb = getAdminFirestore(adminApp);
    }

    try {
      adminRTDB = getAdminDatabase(adminApp);
    } catch (rtdbErr) {
      console.error("Failed to initialize Firebase Realtime Database in Admin SDK:", rtdbErr);
    }

    console.log("Firebase Admin SDK successfully initialized in backend using database:", config.firestoreDatabaseId || 'default');
  } catch (err) {
    console.error("Failed to initialize Firebase Admin in backend:", err);
  }
} else {
  console.error("Missing config or service-account-key.json file.");
}

// Use a local file for persistence. Note: This may still be lost on fresh deployments
// but is generally more stable than /tmp in the dev environment.
const DATA_FILE = path.join(__dirname, 'hospital_data.json');
const LOGO_PATH = path.join(__dirname, 'elite_logo.png');
const FALLBACK_LOGO_PATH = path.join(__dirname, 'elite_logo.png');

function getCustomHeaderBgInfo() {
  const rootPng = path.join(process.cwd(), 'header_bg.png');
  const rootJpg = path.join(process.cwd(), 'header_bg.jpg');
  const rootJpeg = path.join(process.cwd(), 'header_bg.jpeg');
  
  const dirPng = path.join(__dirname, 'header_bg.png');
  const dirJpg = path.join(__dirname, 'header_bg.jpg');
  const dirJpeg = path.join(__dirname, 'header_bg.jpeg');
  
  if (fs.existsSync(rootPng)) return { path: rootPng, ext: 'png' as const };
  if (fs.existsSync(rootJpg)) return { path: rootJpg, ext: 'jpeg' as const };
  if (fs.existsSync(rootJpeg)) return { path: rootJpeg, ext: 'jpeg' as const };
  
  if (fs.existsSync(dirPng)) return { path: dirPng, ext: 'png' as const };
  if (fs.existsSync(dirJpg)) return { path: dirJpg, ext: 'jpeg' as const };
  if (fs.existsSync(dirJpeg)) return { path: dirJpeg, ext: 'jpeg' as const };
  
  return null;
}

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

// Configuration
const CONFIG = {
  EMAIL_RECIPIENT: "mohanad.md07@gmail.com",
};

// Set up storage for file uploads (in memory for this applet)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Store parsed data
let hospitalData: any[][] | null = null;
let previousHospitalData: any[][] | null = null;
let cumulativeDischarged: any[] = []; 
let cumulativeEntries: any[] = []; 
let cumulativeDialysis: any[] = []; 
let cumulativeDebts: any[] = []; 
let cumulativeInsuredDebts: any[] = []; 
let cumulativeMedicalPlans: any[] = []; 
let cumulativeCompanionStatus: any[] = []; 
let cumulativeLOS: any[] = []; 
let cumulativeORList: any[] = []; 
let vipCasesText = "";
let earlyDischargeRoomsText = "";
let pendingDischargePatientsText = "";
let uploadedAt: number | null = null;
let manuallyDischargedNames: string[] = [];

function isManuallyDischarged(patientName: string): boolean {
  if (!patientName || manuallyDischargedNames.length === 0) return false;
  return manuallyDischargedNames.some(mName => isNameMatch(mName, patientName));
}

function normalizeRoom(roomStr: string): string {
  if (!roomStr) return "";
  let clean = cleanRoomStr(roomStr);
  return clean.toUpperCase()
    .replace(/ROOM/g, "")
    .replace(/BED/g, "")
    .replace(/الغرفة/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function cleanRoomStr(s: string): string {
  if (!s) return s;
  let val = String(s).trim();
  if (/Room\s+307\s+intermediate\s+care/gi.test(val)) {
    return "Room 307";
  } else if (/307\s+intermediate\s+care/gi.test(val)) {
    return "307";
  }

  // Strip suffixes for 102, 103, 106, 107
  const m = val.match(/^(Room\s+|Bed\s+|الغرفة\s+)?(102|103|106|107)(?:\s*-\s*[1-2]|\s*[-/A-Za-z1-2\s]+)?$/i);
  if (m) {
    const prefix = m[1] || "";
    const num = m[2];
    return prefix + num;
  }

  return val;
}

function parseRoomNumbers(text: string): string[] {
  if (!text) return [];
  return text
    .split(/[\s,;\n\r]+/)
    .map(r => r.toUpperCase().trim())
    .filter(r => r.length > 0);
}

function isOperatingRoom(roomStr: string): boolean {
  if (!roomStr) return false;
  const bLower = String(roomStr).trim().toLowerCase();
  // Match standalone "or", or "or" as a word/prefix (e.g. "or - 1", "or-3", "or 5", "or3")
  // while avoiding substrings in words like "coronary"
  return /\bor\b/i.test(bLower) || 
         /\bor\d+/i.test(bLower) || 
         /\bor\s*-\s*\d+/i.test(bLower) || 
         bLower.startsWith("or-") || 
         bLower.startsWith("or -");
}

function formatDateToUserFormat(dateObj: Date): string {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth() + 1;
  const d = dateObj.getDate();
  const h = dateObj.getHours();
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const yy = String(y).slice(-2);
  return `${m}/${d}/${yy} ${h}:${min}`;
}

function cleanAdmissionDateStr(val: any): string {
  if (val === undefined || val === null) return "";
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    return formatDateToUserFormat(val);
  }
  const str = String(val).trim();
  if (!str) return "";

  // Check if it's a Unix timestamp in milliseconds (typically 13 digits)
  if (/^\d{13}$/.test(str)) {
    const ts = parseInt(str, 10);
    const dateObj = new Date(ts);
    return formatDateToUserFormat(dateObj);
  }

  // Check if it's a Unix timestamp in seconds (10 digits)
  if (/^\d{10}$/.test(str)) {
    const ts = parseInt(str, 10) * 1000;
    const dateObj = new Date(ts);
    return formatDateToUserFormat(dateObj);
  }

  // Check if it's a standard JS serial date (if read from Excel but imported wrong as a raw float/number)
  const num = Number(str);
  if (!isNaN(num) && num > 40000 && num < 60000) { // realistic range for OLE Automation / Excel date (years ~2009 to 2063)
    const dateObj = new Date((num - 25569) * 86400 * 1000);
    return formatDateToUserFormat(dateObj);
  }

  // Try parsing the string to Date
  try {
    const cleanStr = str.replace(/\s+/g, ' ');
    
    // Pattern 1: YYYY-MM-DD HH:mm:ss or YYYY-MM-DD HH:mm or YYYY/MM/DD ...
    const matchYMD = cleanStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (matchYMD) {
      const y = parseInt(matchYMD[1], 10);
      const m = parseInt(matchYMD[2], 10) - 1;
      const d = parseInt(matchYMD[3], 10);
      const h = parseInt(matchYMD[4] || "0", 10);
      const min = parseInt(matchYMD[5] || "0", 10);
      const sec = parseInt(matchYMD[6] || "0", 10);
      const dateObj = new Date(y, m, d, h, min, sec);
      if (!isNaN(dateObj.getTime())) {
        return formatDateToUserFormat(dateObj);
      }
    }

    // Pattern 2: DD-MM-YYYY HH:mm or DD/MM/YYYY ...
    const matchDMY = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (matchDMY) {
      const d = parseInt(matchDMY[1], 10);
      const m = parseInt(matchDMY[2], 10) - 1;
      const y = parseInt(matchDMY[3], 10);
      const h = parseInt(matchDMY[4] || "0", 10);
      const min = parseInt(matchDMY[5] || "0", 10);
      const sec = parseInt(matchDMY[6] || "0", 10);
      const dateObj = new Date(y, m, d, h, min, sec);
      if (!isNaN(dateObj.getTime())) {
        return formatDateToUserFormat(dateObj);
      }
    }

    // Pattern 3: MM/DD/YYYY HH:mm or MM/DD/YY HH:mm or M/D/YY H:mm ...
    const matchMDY = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (matchMDY) {
      const m = parseInt(matchMDY[1], 10) - 1;
      const d = parseInt(matchMDY[2], 10);
      let y = parseInt(matchMDY[3], 10);
      if (y < 100) {
        y += 2000;
      }
      const h = parseInt(matchMDY[4] || "0", 10);
      const min = parseInt(matchMDY[5] || "0", 10);
      const sec = parseInt(matchMDY[6] || "0", 10);
      const dateObj = new Date(y, m, d, h, min, sec);
      if (!isNaN(dateObj.getTime())) {
        return formatDateToUserFormat(dateObj);
      }
    }

    // Standard JavaScript Date parsing as fallback
    const parsedTs = Date.parse(cleanStr);
    if (!isNaN(parsedTs)) {
      const dateObj = new Date(parsedTs);
      return formatDateToUserFormat(dateObj);
    }
  } catch (err) {
    // ignore
  }

  return str;
}

function deduplicateZoneC(body: any[][]): any[][] {
  const normalizedRooms = new Set(body.map(row => normalizeRoom(row[0])));
  const has330Specific = normalizedRooms.has("330A") || normalizedRooms.has("330B");
  const has331Specific = normalizedRooms.has("331A") || normalizedRooms.has("331B");

  return body.filter(row => {
    const room = row[0];
    const name = row[1];
    const norm = normalizeRoom(room);
    
    if (norm === "330" && has330Specific) {
      return false; // Skip generic 330 row because we have 330A or 330B specific beds
    }
    if (norm === "331" && has331Specific) {
      return false; // Skip generic 331 row because we have 331A or 331B specific beds
    }
    
    if (name) {
      const nameLower = name.toLowerCase().trim();
      if (nameLower) {
        if (norm === "330") {
          const hasBetter330 = body.some(other => {
            const otherNorm = normalizeRoom(other[0]);
            return (otherNorm === "330A" || otherNorm === "330B") && 
                   other[1] && other[1].toLowerCase().trim() === nameLower;
          });
          if (hasBetter330) return false;
        }
        if (norm === "331") {
          const hasBetter331 = body.some(other => {
            const otherNorm = normalizeRoom(other[0]);
            return (otherNorm === "331A" || otherNorm === "331B") && 
                   other[1] && other[1].toLowerCase().trim() === nameLower;
          });
          if (hasBetter331) return false;
        }
      }
    }
    return true;
  });
}

function getOccupancyRows(data: any[][] | null): any[][] {
  if (!data) return [];
  
  // Find startIdx
  let startIdx = 3; // default
  for(let i = 0; i < Math.min(data.length, 10); i++) {
      const r1 = String(data[i][1] || "").toLowerCase();
      const r3 = String(data[i][3] || "").toLowerCase();
      if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name")) {
          startIdx = i + 1;
          break;
      }
  }
  
  if (data.length <= startIdx) return [];
  
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }

  const body = data.slice(startIdx).map(row => {
    return [
      String(row[1] || "").trim(),  // Col B -> Col A (Room)
      String(row[3] || "").trim(),  // Col D -> Col B (Patient Name)
      String(row[22] || "").trim(), // Col W -> Col C (Treating Physician)
      String(row[12] || "").trim(), // Col M -> Col D (Contractor name)
      cleanAdmissionDateStr(row[0]),  // Col A -> Col E (Admission Date)
      String(row[2] || "").trim(),  // Col C -> Col F (MRN)
    ];
  }).filter(row => {
    const room = row[0];
    if (isOperatingRoom(room)) return false;
    return true;
  });
  
  const deduplicatedBody = deduplicateZoneC(body);
  return [...prefix, ...deduplicatedBody];
}

function getOccupancyRowsUnfiltered(data: any[][] | null): any[][] {
  if (!data) return [];
  
  // Find startIdx
  let startIdx = 3; // default
  for(let i = 0; i < Math.min(data.length, 10); i++) {
      const r1 = String(data[i][1] || "").toLowerCase();
      const r3 = String(data[i][3] || "").toLowerCase();
      if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name")) {
          startIdx = i + 1;
          break;
      }
  }
  
  if (data.length <= startIdx) return [];
  
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }

  const body = data.slice(startIdx).map(row => {
    return [
      String(row[1] || "").trim(),  // Col B -> Col A (Room)
      String(row[3] || "").trim(),  // Col D -> Col B (Patient Name)
      String(row[22] || "").trim(), // Col W -> Col C (Treating Physician)
      String(row[12] || "").trim(), // Col M -> Col D (Contractor name)
      cleanAdmissionDateStr(row[0]),  // Col A -> Col E (Admission Date)
      String(row[2] || "").trim(),  // Col C -> Col F (MRN)
    ];
  });
  
  const deduplicatedBody = deduplicateZoneC(body);
  return [...prefix, ...deduplicatedBody];
}

// Parse and clean VIP names from text box
function extractVipNames(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const names: string[] = [];
  for (let line of lines) {
    line = line.replace(/^\s*\*+.*?\*+\s*$/, '').trim(); // Remove *VIP CASES*
    if (!line) continue;
    
    // Clean WhatsApp-style brackets/timestamps and role prefixes
    // E.g., "[7:18 PM, 6/3/2026] Mohanad: علاء حسن..." -> "علاء حسن..."
    // E.g., "1:07 PM, 5/25/2026] Dr. Mohamed Hamed Elite: وصول حاله..." -> "وصول حاله..."
    line = line.replace(/^.*?\]\s*[^:]*:\s*/, '');
    
    // Clean sender name prefixes in English
    // E.g., "Dina Yasser Samy Home Care Elite: حالة م..." -> "حالة م..."
    // E.g., "Mohanad: رامى..." -> "رامى..."
    line = line.replace(/^[a-zA-Z\s\d.-]+:\s*/, '');

    // Clean leading common phrases
    line = line.replace(/^(وصول|دخول)?\s*(حاله|حالة)\s*(\/|-)?\s*/, '');
    line = line.replace(/^New Patient Admission\s*(-\s*)?/i, '');

    // Remove leading list numbers like "1-", "2.", "3 -", etc.
    line = line.replace(/^\d+[\s\-.)]*/, '').trim();
    
    // Split ONLY on 2 or more dots to isolate description
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

// Comprehensive Arabic normalizer with diacritic removal and punctuation stripping
function normalizeArabicName(name: string): string {
  if (!name) return "";
  let clean = name.toLowerCase().trim();
  // Strip common Arabic diacritics (tashkeel)
  clean = clean.replace(/[\u064B-\u065F]/g, "");
  // Strip any non-letter and non-space characters (compatible regex)
  clean = clean.replace(/[^a-zA-Z\u0600-\u06FF\s]/g, " ");
  // Collapse whitespace
  clean = clean.replace(/\s+/g, " ").trim();

  // Strip leading "ابن", "ابنه", "بنت", "طفل", "طفله", "حاله", "حالة" from the clean name string
  clean = clean.replace(/^(ابن|ابنه|بنت|طفل|طفله|حاله|حالة)\s+/, '');

  return clean
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىيِ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    // Join common Arabic compounds to ensure unified parts
    .replace(/(?:^|\s)عبد\s+(\S+)/g, (match, p1) => match.startsWith(' ') ? ' عبد' + p1 : 'عبد' + p1)
    .replace(/(?:^|\s)ابو\s+(\S+)/g, (match, p1) => match.startsWith(' ') ? ' ابو' + p1 : 'ابو' + p1)
    .replace(/(?:^|\s)ام\s+(\S+)/g, (match, p1) => match.startsWith(' ') ? ' ام' + p1 : 'ام' + p1)
    .replace(/(?:^|\s)ابن\s+(\S+)/g, (match, p1) => match.startsWith(' ') ? ' ابن' + p1 : 'ابن' + p1)
    .replace(/(?:^|\s)بن\s+(\S+)/g, (match, p1) => match.startsWith(' ') ? ' بن' + p1 : 'بن' + p1)
    .replace(/(?:^|\s)(\S+)\s+الدين(?=\s|$)/g, (match, p1) => match.startsWith(' ') ? ' ' + p1 + 'الدين' : p1 + 'الدين');
}

// Get normalized list of words for robust matching
function getNormalizedWords(name: string): string[] {
  const normalized = normalizeArabicName(name);
  const titles = ["الافندي", "افندي", "الدكتور", "دكتور", "الدكتوره", "دكتوره", "الاستاذ", "استاذ", "المهندس", "مهندس", "الشيخ", "شيخ", "الحاج", "حاج", "السيد", "سيد"];
  let words = normalized.split(' ').filter(w => w.length >= 2);
  
  // Skip leading titles if followed by other words
  while (words.length > 1 && titles.includes(words[0])) {
    words.shift();
  }

  return words.map(w => {
    // Strip leading 'ال' (Al-) prefix safely if word is long enough
    if (w.startsWith('ال') && w.length > 3) {
      return w.substring(2);
    }
    return w;
  });
}

// LCS function
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

// Arab-friendly soft comparison requiring intelligent matches
function isPatientVip(patientName: string): boolean {
  if (!patientName || !vipCasesText) return false;
  
  const pWords = getNormalizedWords(patientName);
  if (pWords.length < 2) return false;

  const vipNamesList = extractVipNames(vipCasesText);

  for (const name of vipNamesList) {
    const nWords = getNormalizedWords(name);
    if (nWords.length < 2) continue;

    // First name must match (after normalization and stripping)
    if (pWords[0] !== nWords[0]) continue;

    const shorterLen = Math.min(pWords.length, nWords.length);
    const lcsLen = getLcsLength(pWords, nWords);

    // Exact sequential subsequence match: the shorter name's words must fully match with order preserved
    if (lcsLen === shorterLen && lcsLen >= 2) {
      return true;
    }
  }
  return false;
}

function isNameMatch(nameA: string, nameB: string): boolean {
  if (!nameA || !nameB) return false;
  
  const lowA = String(nameA).toLowerCase().trim();
  const lowB = String(nameB).toLowerCase().trim();
  const isPascalA = lowA.includes("باسكال") || lowA.includes("pascal");
  const isJeanA = lowA.includes("jeaneldie") || lowA.includes("nzola") || lowA.includes("mpaka");
  const isPascalB = lowB.includes("باسكال") || lowB.includes("pascal");
  const isJeanB = lowB.includes("jeaneldie") || lowB.includes("nzola") || lowB.includes("mpaka");

  if ((isPascalA && isJeanB) || (isJeanA && isPascalB)) {
    return true;
  }

  const normA = normalizeArabicName(nameA);
  const normB = normalizeArabicName(nameB);
  if (normA === normB) return true;
  
  const wordsA = getNormalizedWords(nameA);
  const wordsB = getNormalizedWords(nameB);
  
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter(w => setB.has(w));
  const minSize = Math.min(wordsA.length, wordsB.length);

  if (minSize >= 3) {
    if (intersection.length >= 3) return true;
  }

  // Intelligent sub-phrase match for 2 or more words (e.g. "روان اسامه" and "روان اسامه حسن علي")
  if (minSize >= 2) {
    // First name must match
    if (wordsA[0] === wordsB[0]) {
      const lcsLen = getLcsLength(wordsA, wordsB);
      if (lcsLen >= 2 && lcsLen === minSize) {
        return true;
      }
    }
  }

  return normA === normB;
}

// Persistence Helpers
async function loadData() {
  try {
    // 1. Try to load local disk cache first for fast immediate recovery
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      hospitalData = parsed.current || null;
      previousHospitalData = parsed.previous || null;
      cumulativeDischarged = parsed.discharged || [];
      cumulativeEntries = parsed.entries || [];
      cumulativeDialysis = parsed.dialysis || [];
      cumulativeDebts = parsed.debts || [];
      cumulativeInsuredDebts = parsed.insuredDebts || [];
      cumulativeMedicalPlans = parsed.medicalPlans || [];
      cumulativeCompanionStatus = parsed.companionStatus || [];
      cumulativeLOS = parsed.losData || [];
      cumulativeORList = parsed.orList || [];
      vipCasesText = parsed.vipCasesText || "";
      earlyDischargeRoomsText = parsed.earlyDischargeRoomsText || "";
      pendingDischargePatientsText = parsed.pendingDischargePatientsText || "";
      uploadedAt = parsed.uploadedAt || null;
      manuallyDischargedNames = parsed.manuallyDischargedNames || [];
      console.log('Hospital data loaded from local disk cache.');
    }
  } catch (err) {
    console.error('Failed to load local data:', err);
  }

  // 2. Load/override with Cloud Firestore dataset as the absolute source of truth
  if (adminDb) {
    try {
      console.log('Fetching latest durable dataset state from Cloud Firestore...');
      const docRef = adminDb.collection('state').doc('dataset');
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        const parsed = docSnap.data();
        console.log("Cloud Firestore dataset found! Restoring state from cloud persistence.");
        hospitalData = parsed.current ? JSON.parse(parsed.current) : hospitalData;
        previousHospitalData = parsed.previous ? JSON.parse(parsed.previous) : previousHospitalData;
        cumulativeDischarged = parsed.discharged ? JSON.parse(parsed.discharged) : cumulativeDischarged;
        cumulativeEntries = parsed.entries ? JSON.parse(parsed.entries) : cumulativeEntries;
        cumulativeDialysis = parsed.dialysis ? JSON.parse(parsed.dialysis) : cumulativeDialysis;
        cumulativeDebts = parsed.debts ? JSON.parse(parsed.debts) : cumulativeDebts;
        cumulativeInsuredDebts = parsed.insuredDebts ? JSON.parse(parsed.insuredDebts) : cumulativeInsuredDebts;
        cumulativeMedicalPlans = parsed.medicalPlans ? JSON.parse(parsed.medicalPlans) : cumulativeMedicalPlans;
        cumulativeCompanionStatus = parsed.companionStatus ? JSON.parse(parsed.companionStatus) : cumulativeCompanionStatus;
        cumulativeLOS = parsed.losData ? JSON.parse(parsed.losData) : cumulativeLOS;
        cumulativeORList = parsed.orList ? JSON.parse(parsed.orList) : cumulativeORList;
        vipCasesText = parsed.vipCasesText || vipCasesText;
        earlyDischargeRoomsText = parsed.earlyDischargeRoomsText || earlyDischargeRoomsText;
        pendingDischargePatientsText = parsed.pendingDischargePatientsText || pendingDischargePatientsText;
        manuallyDischargedNames = parsed.manuallyDischargedNames ? JSON.parse(parsed.manuallyDischargedNames) : manuallyDischargedNames;
        
        if (parsed.uploadedAt) {
          uploadedAt = typeof parsed.uploadedAt === 'number' ? parsed.uploadedAt : new Date(parsed.uploadedAt).getTime();
        } else if (parsed.updatedAt) {
          uploadedAt = typeof parsed.updatedAt.toDate === 'function' ? parsed.updatedAt.toDate().getTime() : new Date(parsed.updatedAt).getTime();
        } else {
          uploadedAt = null;
        }
      } else {
        console.log("No dataset document found in Firestore. Creating it on first upload/save.");
      }
    } catch (err) {
      console.error('Failed to restore database state from Cloud Firestore:', err);
    }
  }

  // Clean loaded data room strings for Room 307
  if (hospitalData) {
    hospitalData = hospitalData.map(row => {
      if (row && row[1]) {
        row[1] = cleanRoomStr(String(row[1]));
      }
      return row;
    });
  }
  if (previousHospitalData) {
    previousHospitalData = previousHospitalData.map(row => {
      if (row && row[1]) {
        row[1] = cleanRoomStr(String(row[1]));
      }
      return row;
    });
  }
  cumulativeDischarged = (cumulativeDischarged || []).map(p => {
    if (p && p.room) p.room = cleanRoomStr(p.room);
    return p;
  });
  cumulativeEntries = (cumulativeEntries || []).map(p => {
    if (p && p.room) p.room = cleanRoomStr(p.room);
    return p;
  });
  cumulativeDialysis = (cumulativeDialysis || []).map(p => {
    if (p && p.room) p.room = cleanRoomStr(p.room);
    return p;
  });
  cumulativeDebts = (cumulativeDebts || []).map(p => {
    if (p && p.room) p.room = cleanRoomStr(p.room);
    return p;
  });
  cumulativeInsuredDebts = (cumulativeInsuredDebts || []).map(p => {
    if (p && p.room) p.room = cleanRoomStr(p.room);
    return p;
  });
  cumulativeMedicalPlans = (cumulativeMedicalPlans || []).map(p => {
    if (p && p.colB) p.colB = cleanRoomStr(p.colB);
    return p;
  });
  cumulativeCompanionStatus = (cumulativeCompanionStatus || []).map(p => {
    if (p && p.colB) p.colB = cleanRoomStr(p.colB);
    return p;
  });
  cumulativeLOS = (cumulativeLOS || []).map(p => {
    if (p && p.colB) p.colB = cleanRoomStr(p.colB);
    return p;
  });

  console.log('Durable room-name sanitization done.');
  
  // Enforce TTL validation on initial data load
  checkDataTTL();
}

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', dataLoaded: !!hospitalData });
});

function checkDataTTL() {
  if (uploadedAt && (Date.now() - uploadedAt > 24 * 60 * 60 * 1000)) {
    console.log('Saved data has expired (older than 24 hours). Cleaning up all uploaded data.');
    hospitalData = null;
    previousHospitalData = null;
    // Keep discharged patients that are in OR-x rooms (overlist patients)
    cumulativeDischarged = (cumulativeDischarged || []).filter(p => isOrXRoom(p.room));
    cumulativeEntries = [];
    cumulativeDialysis = [];
    cumulativeDebts = [];
    cumulativeInsuredDebts = [];
    cumulativeMedicalPlans = [];
    cumulativeCompanionStatus = [];
    cumulativeLOS = [];
    // Do NOT clear cumulativeORList here to ensure manual-only reset!
    uploadedAt = null;
    
    // Write empty state back to disk and Firestore async in background
    saveData().catch(err => {
      console.error('Failed to save empty state after TTL expiration:', err);
    });
  }
}

app.use((req, res, next) => {
  try {
    checkDataTTL();
  } catch (err) {
    console.error('Error executing TTL check:', err);
  }
  next();
});

// Middleware for parsing
app.use(express.urlencoded({ limit: '50mb', extended: true }));

async function saveData() {
  try {
    const data = {
      current: hospitalData,
      previous: previousHospitalData,
      discharged: cumulativeDischarged,
      entries: cumulativeEntries,
      dialysis: cumulativeDialysis,
      debts: cumulativeDebts,
      insuredDebts: cumulativeInsuredDebts,
      medicalPlans: cumulativeMedicalPlans,
      companionStatus: cumulativeCompanionStatus,
      losData: cumulativeLOS,
      orList: cumulativeORList,
      vipCasesText: vipCasesText,
      earlyDischargeRoomsText: earlyDischargeRoomsText,
      pendingDischargePatientsText: pendingDischargePatientsText,
      uploadedAt: uploadedAt,
      manuallyDischargedNames: manuallyDischargedNames
    };
    // 1. Save locally fast sync
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    console.log('Hospital data saved to local persistence.'); } catch (e) { console.error('Failed to save local data (might be read-only env)', e); }

    // 2. Synchronize to Firestore
    if (adminDb) {
      console.log('Synchronizing hospital database cache to Firestore...');
      const docRef = adminDb.collection('state').doc('dataset');
      await docRef.set({
        current: JSON.stringify(hospitalData || []),
        previous: JSON.stringify(previousHospitalData || []),
        discharged: JSON.stringify(cumulativeDischarged || []),
        entries: JSON.stringify(cumulativeEntries || []),
        dialysis: JSON.stringify(cumulativeDialysis || []),
        debts: JSON.stringify(cumulativeDebts || []),
        insuredDebts: JSON.stringify(cumulativeInsuredDebts || []),
        medicalPlans: JSON.stringify(cumulativeMedicalPlans || []),
        companionStatus: JSON.stringify(cumulativeCompanionStatus || []),
        losData: JSON.stringify(cumulativeLOS || []),
        orList: JSON.stringify(cumulativeORList || []),
        vipCasesText: vipCasesText || "",
        earlyDischargeRoomsText: earlyDischargeRoomsText || "",
        pendingDischargePatientsText: pendingDischargePatientsText || "",
        manuallyDischargedNames: JSON.stringify(manuallyDischargedNames || []),
        uploadedAt: uploadedAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log('Hospital cloud database synchronization completed.');
    }
  } catch (err: any) {
    if (err.code === 7) {
      console.log('Hospital data synced locally, Firebase sync bypassed due to insufficient AD permissions.');
    } else {
      console.error('Failed to save data:', err);
    }
  }
}

// Trigger loadData asynchronously during startup
loadData().catch(err => {
  console.error("Async startup data load failed:", err);
});

const GLOBAL_EXCLUSIONS = [
  "homecare", "home care", 
  "wellbaby", "well baby", 
  "endoscopy operation theatre", "operation room", "cath lab operation theatre",
  "day case", "daycase"
];

const DIALYSIS_KEYWORDS = ["dialysis", "diyalsis room", "diyalsis"];

const KEYWORDS_TO_EXCLUDE = [...GLOBAL_EXCLUSIONS, ...DIALYSIS_KEYWORDS];

// File Upload Endpoint
async function handleUnifiedUpload(req: any, res: any) {
  console.log('handleUnifiedUpload received (Unified Debts Sheet)');
  try {
    if (!req.file) {
      console.log('No file in request');
      return res.status(400).json({ error: 'No file uploaded' });
    }
    console.log('File received:', req.file.originalname, 'Size:', req.file.size);

    // Parse the Excel file with formatting preserved
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true, cellNF: true, cellText: true });
    
    // Find the best sheet (one that has "patient" or "المريض" or "room" or "الغرفة")
    let worksheet = workbook.Sheets[workbook.SheetNames[0]];
    let bestSheetName = workbook.SheetNames[0];
    
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      const tempRows = xlsx.utils.sheet_to_json(ws, { header: 1, range: 0, raw: false }) as any[][];
      const headerArea = tempRows.slice(0, 10);
      const isLikelyDataSheet = headerArea.some(row => 
        row.some((cell: any) => {
          const s = String(cell || "").toLowerCase();
          return s.includes("patient") || s.includes("المريض") || s.includes("room") || s.includes("الغرفة") || s.includes("admission") || s.includes("دخول") || s.includes("تاريخ");
        })
      );
      if (isLikelyDataSheet) {
        worksheet = ws;
        bestSheetName = name;
        break;
      }
    }

    // Convert to JSON (array of arrays)
    let rows = xlsx.utils.sheet_to_json(worksheet, { 
      header: 1,
      raw: false, 
      defval: ""
    }) as any[][];

    // Clean up Room 307 intermediate care to Room 307
    rows = rows.map(row => {
      if (row && row[1]) {
        row[1] = cleanRoomStr(String(row[1]));
      }
      return row;
    });

    if (!rows || rows.length < 2) {
      return res.status(400).json({ error: 'Sheet appears to be empty or has insufficient rows.' });
    }

    // Dynamically find where data starts
    let startIdx = 3; // default
    for(let i = 0; i < Math.min(rows.length, 10); i++) {
        const r1 = String(rows[i][1] || "").toLowerCase();
        const r3 = String(rows[i][3] || "").toLowerCase();
        if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name" || r1 === "غرفة")) {
            startIdx = i + 1;
            break;
        }
    }

    const actualUploadedNames = rows.slice(startIdx).map(r => String(r[3] || "").trim()).filter(Boolean);
    manuallyDischargedNames = manuallyDischargedNames.filter(mName => {
      return actualUploadedNames.some(uName => isNameMatch(mName, uName));
    });

    const headerRow = rows.slice(0, startIdx);
    const dataRowsFiltered = rows.slice(startIdx).filter(row => {
      const patientName = String(row[3] || "").trim();
      return !isManuallyDischarged(patientName);
    });
    rows = [...headerRow, ...dataRowsFiltered];

    const isToday = (dateStr: string) => {
      const d = dateStr.trim().toLowerCase();
      if (!d) return false;
      if (d.includes('اليوم')) return true;
      const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
      const year = today.getFullYear();
      const shortYear = year % 100;
      const month = today.getMonth() + 1;
      const day = today.getDate();
      const paddedMonth = month.toString().padStart(2, '0');
      const paddedDay = day.toString().padStart(2, '0');
      const possibleFormats = [
        `${month}/${day}/${year}`, `${month}/${day}/${shortYear}`,
        `${paddedMonth}/${paddedDay}/${year}`, `${paddedMonth}/${paddedDay}/${shortYear}`,
        `${day}/${month}/${year}`, `${day}/${month}/${shortYear}`,
        `${paddedDay}/${paddedMonth}/${year}`, `${paddedDay}/${paddedMonth}/${shortYear}`,
        `${year}-${paddedMonth}-${paddedDay}`
      ];
      if (possibleFormats.some(f => d.includes(f))) return true;
      try {
         const parsedTime = Date.parse(d);
         if (!isNaN(parsedTime)) {
           const parsedDate = new Date(parsedTime);
           if (parsedDate.getFullYear() === year && parsedDate.getMonth() === today.getMonth() && parsedDate.getDate() === day) return true;
         }
      } catch(e) {}
      return false;
    };

    const extractRowsFromData = (sourceData: any[][], skip: number) => {
      if (!sourceData || sourceData.length <= skip) return [];
      return sourceData.slice(skip).map(row => ({
        room: String(row[1] || "").trim(), // Col B Room
        name: String(row[3] || "").trim(), // Col D Patient Name
        physician: String(row[22] || "").trim(), // Col W Treating Physician
        contractor: String(row[12] || "").trim(), // Col M Contractor name
        date: cleanAdmissionDateStr(row[0]), // Col A Admission date
      })).filter(p => {
        if (!p.room || !p.name) return false;
        const rowAsString = Object.values(p).join(" ").toLowerCase();
        const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
        const isOR = isOperatingRoom(p.room);
        return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
      });
    };

    const newRows = extractRowsFromData(rows, startIdx);
    
    // Map of ALL patients in the current sheet (even in excluded rooms) to check for truly discharged or dialysis ones
    const currentSheetPatientsRaw = rows.slice(startIdx).map(r => ({
      room: String(r[1] || "").trim(),
      name: String(r[3] || "").trim(),
      physician: String(r[22] || "").trim(),
      contractor: String(r[12] || "").trim(),
      date: cleanAdmissionDateStr(r[0]),
    })).filter(p => p.name);
    
    const currentSheetNames = new Set(currentSheetPatientsRaw.map(p => p.name.toLowerCase().trim()));
    const isNewSheetLikelyEmpty = currentSheetNames.size === 0;

    // CLEANUP: If a patient is in the hospital (any room), they are NOT discharged.
    if (!isNewSheetLikelyEmpty) {
      cumulativeDischarged = cumulativeDischarged.filter(p => !currentSheetNames.has(p.name.toLowerCase().trim()));
    }

    const extractDialysisRows = (sourceData: any[][], skip: number) => {
      if (!sourceData || sourceData.length <= skip) return [];
      return sourceData.slice(skip).map(row => ({
        room: String(row[1] || "").trim(),
        name: String(row[3] || "").trim(),
        physician: String(row[22] || "").trim(),
        contractor: String(row[12] || "").trim(),
        date: cleanAdmissionDateStr(row[0]),
      })).filter(p => {
        if (!p.room || !p.name) return false;
        const roomLower = p.room.toLowerCase();
        const rowAsString = Object.values(p).join(" ").toLowerCase();
        
        const isDialysis = roomLower.includes("dialysis") || roomLower.includes("diyalsis");
        const isGloballyExcluded = GLOBAL_EXCLUSIONS.some(kw => rowAsString.includes(kw));
        
        return isDialysis && !isGloballyExcluded;
      });
    };

    const dialRowsNew = extractDialysisRows(rows, startIdx);
    
    // For Dialysis: Keep all dialysis cases cumulatively
    if (!isNewSheetLikelyEmpty) {
      const currentDialNamesPersistent = new Set(cumulativeDialysis.map(p => p.name.toLowerCase().trim()));
      dialRowsNew.forEach(p => {
        if (!currentDialNamesPersistent.has(p.name.toLowerCase().trim())) {
          cumulativeDialysis.push(p);
        }
      });
    }

    // Update cumulative entries (today's entries)
    const currentEntryNames = new Set(cumulativeEntries.map(p => p.name.toLowerCase().trim()));
    newRows.forEach(p => {
      if (isToday(p.date)) {
        if (!currentEntryNames.has(p.name.toLowerCase().trim())) {
          cumulativeEntries.push(p);
        }
      }
    });

    if (hospitalData && !isNewSheetLikelyEmpty) {
      // Find the old starting row
      let oldStartIdx = 3;
      for(let i = 0; i < Math.min(hospitalData.length, 10); i++) {
        const r1 = String(hospitalData[i][1] || "").toLowerCase();
        const r3 = String(hospitalData[i][3] || "").toLowerCase();
        if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name")) {
            oldStartIdx = i + 1;
            break;
        }
      }
      
      const oldRows = extractRowsFromData(hospitalData, oldStartIdx);
      
      // Identify new discharges: in old data (filtered) but NOT in current data (at all)
      const newlyDischarged = oldRows.filter(oldP => !currentSheetNames.has(oldP.name.toLowerCase().trim()));
      
      // Also identify any OR patients that are no longer in the current sheet at all
      const oldORPatients: any[] = [];
      const oldORBody = hospitalData.slice(oldStartIdx);
      oldORBody.forEach(row => {
        const room = String(row[1] || "").trim();
        const name = String(row[3] || "").trim();
        if (isOrXRoom(room) && name) {
          oldORPatients.push({
            room,
            name,
            physician: String(row[22] || "").trim(),
            contractor: String(row[12] || "").trim(),
            date: cleanAdmissionDateStr(row[0])
          });
        }
      });
      const newlyDischargedOR = oldORPatients.filter(oldP => !currentSheetNames.has(oldP.name.toLowerCase().trim()));

      const existingDischargedNames = new Set(cumulativeDischarged.map(p => p.name.toLowerCase().trim()));
      
      newlyDischarged.forEach(p => {
        if (!existingDischargedNames.has(p.name.toLowerCase().trim())) {
          cumulativeDischarged.push(p);
        }
      });

      newlyDischargedOR.forEach(p => {
        if (!existingDischargedNames.has(p.name.toLowerCase().trim())) {
          cumulativeDischarged.push(p);
        }
      });

      previousHospitalData = hospitalData;
    }
    
    // Only update hospitalData if it has actual data, to avoid overwriting with blank sheets
    if (!isNewSheetLikelyEmpty || !hospitalData) {
        hospitalData = rows;
    }

    // Extract DEBTS from unified sheet (A, B, D, F, M, Z, AB)
    const finalExtractedDebts = rows.slice(startIdx).map(row => ({
      colA: String(row[0] || "").trim(),
      room: String(row[1] || "").trim(),
      colD: String(row[3] || "").trim(),
      colF: String(row[5] || "").trim(), // Financial status, cash or insured
      colM: String(row[12] || "").trim(), // Contractor Name
      colL: String(row[11] || "").trim(), // for backward compatibility/filter checks
      colZ: String(row[25] || "").trim(), // Total invoice
      colAB: String(row[27] || "").trim() // Remaining on invoice
    })).filter(p => {
      const fLower = p.colF.toLowerCase();
      const mLower = p.colM.toLowerCase();
      const isHomeCare = mLower.includes("home care") || mLower.includes("homecare");
      const fMatch = (fLower.includes("cash") || fLower.includes("كاش") || fLower.includes("elite") || 
                      fLower.includes("نقدي") || fLower.includes("نقدى") || fLower.includes("افراد") || fLower.includes("أفراد") || 
                      fLower.includes("شخصي") || fLower.includes("شخصى") || fLower.includes("self") || fLower.includes("private") || fLower.includes("personal") || fLower.includes("individual") || fLower.includes("بدون جهة") || fLower.includes("بدون جهه") || fLower.includes("عميل") ||
                      mLower.includes("cash") || mLower.includes("كاش") || mLower.includes("elite") || 
                      mLower.includes("نقدي") || mLower.includes("نقدى") || mLower.includes("افراد") || mLower.includes("أفراد") || 
                      mLower.includes("شخصي") || mLower.includes("شخصى") || mLower.includes("self") || mLower.includes("private") || mLower.includes("personal") || mLower.includes("individual") || mLower.includes("بدون جهة") || mLower.includes("بدون جهه") || mLower.includes("عميل")) && !isHomeCare;
      const lLower = p.colL.toLowerCase();
      const dLower = p.colD.toLowerCase();
      const isHeader = dLower === "patient" || dLower === "المريض" || dLower === "patient name" || dLower === "اسم المريض" || dLower === "name" || dLower === "patient_name";
      const isNotPhysician = !lLower.includes("physician") && (lLower.length > 0 || p.room.length > 0 || (p.colD.length > 0 && !isHeader));
      const isOR = isOperatingRoom(p.room);
      return fMatch && isNotPhysician && !isOR && p.colD.length > 0;
    });

    cumulativeDebts = finalExtractedDebts;

    // Extract INSURED DEBTS (remainings only)
    const finalExtractedInsuredDebts = rows.slice(startIdx).map(row => ({
      colA: String(row[0] || "").trim(),
      room: String(row[1] || "").trim(),
      colD: String(row[3] || "").trim(),
      colF: String(row[5] || "").trim(), // Financial status, cash or insured
      colM: String(row[12] || "").trim(), // Contractor Name
      colL: String(row[11] || "").trim(), // for backward compatibility/filter checks
      colZ: String(row[25] || "").trim(), // Total invoice
      colAB: String(row[27] || "").trim() // Remaining on invoice
    })).filter(p => {
      const fLower = p.colF.toLowerCase();
      const mLower = p.colM.toLowerCase();
      const isHomeCare = mLower.includes("home care") || mLower.includes("homecare");
      const isCash = fLower.includes("cash") || fLower.includes("كاش") || fLower.includes("elite") || 
                     fLower.includes("نقدي") || fLower.includes("نقدى") || fLower.includes("افراد") || fLower.includes("أفراد") || 
                     fLower.includes("شخصي") || fLower.includes("شخصى") || fLower.includes("self") || fLower.includes("private") || fLower.includes("personal") || fLower.includes("individual") || fLower.includes("بدون جهة") || fLower.includes("بدون جهه") || fLower.includes("عميل") ||
                     mLower.includes("cash") || mLower.includes("كاش") || mLower.includes("elite") || 
                     mLower.includes("نقدي") || mLower.includes("نقدى") || mLower.includes("افراد") || mLower.includes("أفراد") || 
                     mLower.includes("شخصي") || mLower.includes("شخصى") || mLower.includes("self") || mLower.includes("private") || mLower.includes("personal") || mLower.includes("individual") || mLower.includes("بدون جهة") || mLower.includes("بدون جهه") || mLower.includes("عميل");
      const isInsured = !isCash && !isHomeCare && (fLower.length > 0 || mLower.length > 0);
      const lLower = p.colL.toLowerCase();
      const dLower = p.colD.toLowerCase();
      const isHeader = dLower === "patient" || dLower === "المريض" || dLower === "patient name" || dLower === "اسم المريض" || dLower === "name" || dLower === "patient_name";
      const isNotPhysician = !lLower.includes("physician") && (lLower.length > 0 || p.room.length > 0 || (p.colD.length > 0 && !isHeader));
      const valAB = parseFloat(String(p.colAB).replace(/[^0-9.-]+/g, "")) || 0;
      const isOR = isOperatingRoom(p.room);
      return isInsured && isNotPhysician && valAB > 0 && p.colD.length > 0 && !isOR;
    });

    cumulativeInsuredDebts = finalExtractedInsuredDebts;

    // Extract MEDICAL PLANS using Columns: A(0), B(1), D(3), M(12), W(22), AH(33), X(23), AG(32)
    const medicalPlansRaw = rows.slice(startIdx).map(row => ({
      colA: cleanAdmissionDateStr(row[0]),
      colB: String(row[1] || "").trim(),
      colD: String(row[3] || "").trim(),
      colM: String(row[12] || "").trim(),
      colW: String(row[22] || "").trim(),
      colAG: String(row[32] || "").trim(),
      colAH: String(row[33] || "").trim(),
      colX: String(row[23] || "").trim()
    })).filter(p => {
      const bLower = p.colB.toLowerCase();
      const dLower = p.colD.toLowerCase();
      if (!p.colB || p.colB === "") return false;
      
      const isHeader = bLower === "bed" || bLower === "room" || bLower === "الغرفة" || 
                       dLower === "patient" || dLower === "المريض" || dLower === "name" ||
                       bLower === "id" || dLower === "patient name" ||
                       (bLower.includes("bed") && dLower.includes("patient"));
      if (isHeader) return false;

      const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => bLower.includes(kw));
      if (isExcluded) return false;
      return true;
    });

    cumulativeMedicalPlans = medicalPlansRaw;

    // Extract COMPANION STATUS: A(0), B(1), D(3), I(8), M(12), W(22)
    const companionStatusRaw = rows.slice(startIdx).map(row => ({
      colA: String(row[0] || "").trim(),
      colB: String(row[1] || "").trim(),
      colD: String(row[3] || "").trim(),
      colI: String(row[8] || "").trim(),
      colM: String(row[12] || "").trim(),
      colW: String(row[22] || "").trim()
    })).filter(p => {
      const bLower = p.colB.toLowerCase();
      const dLower = p.colD.toLowerCase();
      if (!p.colB || p.colB === "") return false;
      
      const isHeader = bLower === "bed" || bLower === "room" || bLower === "الغرفة" || 
                       dLower === "patient" || dLower === "المريض" || dLower === "name" ||
                       bLower === "id" || dLower === "patient name" ||
                       (bLower.includes("bed") && dLower.includes("patient"));
      if (isHeader) return false;

      const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => bLower.includes(kw));
      if (isExcluded) return false;
      return true;
    });

    cumulativeCompanionStatus = companionStatusRaw;

    // Extract LOS Sheet: A(0), B(1), D(3), M(12), S(18), U(20), AL(37)
    const losSheetRaw = rows.slice(startIdx).map(row => ({
      colA: cleanAdmissionDateStr(row[0]),
      colB: String(row[1] || "").trim(),
      colD: String(row[3] || "").trim(),
      colM: String(row[12] || "").trim(),
      colS: String(row[18] || "").trim(),
      colU: String(row[20] || "").trim(),
      colAL: String(row[37] || "").trim()
    })).filter(p => {
      const bLower = p.colB.toLowerCase();
      const dLower = p.colD.toLowerCase();
      if (!p.colB || p.colB === "") return false;
      
      const isHeader = bLower === "bed" || bLower === "room" || bLower === "الغرفة" || 
                       dLower === "patient" || dLower === "المريض" || dLower === "name" ||
                       bLower === "id" || dLower === "patient name" ||
                       (bLower.includes("bed") && dLower.includes("patient"));
      if (isHeader) return false;

      const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => bLower.includes(kw));
      if (isExcluded) return false;

      const isOR = isOperatingRoom(p.colB);
      if (isOR) return false;
      return true;
    });

    cumulativeLOS = losSheetRaw;

    uploadedAt = Date.now();
    saveData();

    // Push the manually uploaded spreadsheet to Firebase Realtime Database
    // so both automated and manual uploads sync with each other
    await pushToFirebaseRTDB(rows);

    res.json({ 
      success: true, 
      count: cumulativeDebts.length, 
      medicalPlansCount: cumulativeMedicalPlans.length,
      companionStatusCount: cumulativeCompanionStatus.length,
      losCount: cumulativeLOS.length,
      countOccupancy: newRows.length,
      sheet: bestSheetName 
    });
  } catch (error: any) {
    console.error('Unified Upload Error:', error);
    res.status(500).json({ error: error.message });
  }
}

app.post('/api/upload', upload.single('file'), (req: any, res, next) => {
  handleUnifiedUpload(req, res);
});

app.post('/api/upload-debts', upload.single('file'), (req: any, res, next) => {
  handleUnifiedUpload(req, res);
});

app.post('/api/upload-or-list', upload.single('file'), async (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true, cellNF: true, cellText: true });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: "" }) as any[][];
    
    if (!rows || rows.length < 2) {
      return res.status(400).json({ error: 'Sheet appears to be empty or has insufficient rows.' });
    }
    
    // Find header row dynamically
    let startIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const rowStr = rows[i].map(c => String(c || "").trim().toLowerCase()).join(" ");
      if (rowStr.includes("start time") || rowStr.includes("patient name") || rowStr.includes("eng operation") || rowStr.includes("ar operation") || rowStr.includes("surgeon name")) {
        startIdx = i;
        break;
      }
    }
    
    if (startIdx === -1) {
      startIdx = 1; // fallback
    }
    
    const headerRow = rows[startIdx];
    const getIndex = (keywords: string[], defaultIdx: number) => {
      const idx = headerRow.findIndex(cell => {
        const s = String(cell || "").trim().toLowerCase();
        return keywords.some(kw => s.includes(kw));
      });
      return idx !== -1 ? idx : defaultIdx;
    };
    
    const idxSerial = getIndex(["column 1", "sr", "#", "no"], 0);
    const idxStartTime = getIndex(["start time", "start"], 1);
    const idxEndTime = getIndex(["end time", "end"], 2);
    const idxPatientName = getIndex(["patient name", "patient", "اسم المريض"], 3);
    const idxMRN = getIndex(["mrn", "id"], 4);
    const idxEngOp = getIndex(["eng col", "eng operation", "english operation", "العملية (انجليزي)"], 5);
    const idxArOp = getIndex(["ar col", "ar operation", "arabic operation", "العملية (عربي)"], 6);
    const idxSurgeon = getIndex(["surgeon name", "surgeon", "اسم الطبيب", "الجراح"], 7);
    const idxColumn2 = getIndex(["column2", "equipment", "الأجهزة", "تاور"], 8);
    const idxORRoom = getIndex(["or room", "room", "الغرفة"], 9);
    const idxColumn3 = getIndex(["column3", "status", "الحالة"], 10);
    const idxContractor = getIndex(["contractorname", "contractor", "التعاقد"], 11);
    const idxPaidBy = getIndex(["paidby", "paid", "الدافع"], 12);
    const idxPostC = getIndex(["post c", "postop"], 13);
    const idxVT = getIndex(["vt", "visittype"], 14);
    const idxComment = getIndex(["operativecomment", "comment"], 15);
    const idxClass = getIndex(["flclassname"], 16);
    const idxFinancial = getIndex(["financial status", "financial"], 17);
    
    const dataRows = rows.slice(startIdx + 1);
    const parsedData: any[] = [];
    
    let dateStr = "";
    const titleRowVal = String(rows[0]?.[0] || "");
    const datePattern = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
    const dateMatch = titleRowVal.match(datePattern);
    if (dateMatch) {
      dateStr = dateMatch[0];
    } else {
      const secondRowVal = String(rows[1]?.[0] || "");
      const dateMatch2 = secondRowVal.match(datePattern);
      if (dateMatch2) {
        dateStr = dateMatch2[0];
      }
    }
    
    dataRows.forEach((row, i) => {
      const patientName = String(row[idxPatientName] || "").trim();
      const orRoom = String(row[idxORRoom] || row[idxORRoom + 1] || "").trim();
      if (!patientName && !orRoom) return;
      
      parsedData.push({
        serial: String(row[idxSerial] || i + 1).trim(),
        startTime: String(row[idxStartTime] || "").trim(),
        endTime: String(row[idxEndTime] || "").trim(),
        patientName: patientName,
        mrn: String(row[idxMRN] || "").trim(),
        engOperationName: String(row[idxEngOp] || "").trim(),
        arOperationName: String(row[idxArOp] || "").trim(),
        surgeonName: String(row[idxSurgeon] || "").trim(),
        column2: String(row[idxColumn2] || "").trim(),
        orRoom: orRoom,
        column3: String(row[idxColumn3] || "").trim(),
        contractorName: String(row[idxContractor] || "").trim(),
        paidBy: String(row[idxPaidBy] || "").trim(),
        postC: String(row[idxPostC] || "").trim(),
        vt: String(row[idxVT] || "").trim(),
        operativeComment: String(row[idxComment] || "").trim(),
        flClassName: String(row[idxClass] || "").trim(),
        financialStatus: String(row[idxFinancial] || "").trim(),
        orListDate: dateStr
      });
    });
    
    cumulativeORList = parsedData;
    uploadedAt = Date.now();
    await saveData();
    
    res.json({
      success: true,
      count: parsedData.length,
      uploadedAt: uploadedAt,
      date: dateStr
    });
  } catch (error: any) {
    console.error('OR List Upload Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper for adding logos
function addLogosToSheet(workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet, numCols: number = 6) {
  const finalLogoPath = fs.existsSync(LOGO_PATH) ? LOGO_PATH : (fs.existsSync(FALLBACK_LOGO_PATH) ? FALLBACK_LOGO_PATH : null);
  
  if (finalLogoPath) {
    try {
      const logoId = workbook.addImage({
        filename: finalLogoPath,
        extension: 'png',
      });

      // Right logo (in RTL) - Near Column A
      worksheet.addImage(logoId, {
        tl: { col: 0.1, row: 0.2 } as any,
        ext: { width: 100, height: 100 },
        editAs: 'oneCell'
      });

      // Left logo (in RTL) - Near Last Column edge
      // If numCols is 6, col 5 is the last column (F)
      // We start at 5.8 to align it to the far left edge of column F
      const leftColIndex = numCols - 1;
      worksheet.addImage(logoId, {
        tl: { col: leftColIndex + 0.82, row: 0.2 } as any,
        ext: { width: 100, height: 100 },
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error('Error adding logo to sheet:', err);
    }
  }
}

function addOccupancySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Formatted Occupancy', {
    views: [{ rightToLeft: false }] 
  });

  let processedData = data.slice(3)
    .map(row => ({
      room: String(row[0] || "").trim(),
      name: String(row[1] || "").trim(),
      physician: String(row[2] || "").trim(),
      contractor: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
    }))
    .filter(p => {
      if (!p.room || !p.name) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
    });

  processedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'الاشغال';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2F1' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 6.0);

  const headerLabels = ['#', 'تاريخ الحجز / Admission Date', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } }; 
    cell.font = { bold: true, size: 10, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  sheet.autoFilter = 'A2:F2';

  const separatorColor = 'FFFCE4D6'; 
  let currentGroup: string | null = null;
  let serial = 1;

  processedData.forEach((p) => {
    const roomStr = p.room.toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let group = "OTHER"; 
    if (roomStr.includes("PICU")) group = "PICU";
    else if (roomStr.includes("NICU")) group = "NICU";
    else if (roomStr.includes("CCU")) group = "CCU";
    else if (roomStr.includes("SICU")) group = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) group = "VIP";
    else if (roomStr.includes("ICU")) group = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) group = "1st Floor (101-108)";
    else if (roomNum >= 301 && roomNum <= 319) group = "301-319";
    else if (roomNum >= 320 && roomNum <= 329) group = "320-329";
    else if (roomNum >= 401 && roomNum <= 422) group = "4th Floor (401-422)";
    else if (!isNaN(roomNum) && roomNum > 0) group = "FLOOR_" + Math.floor(roomNum / 100); 

    if (currentGroup !== null && group !== currentGroup) {
      const sepRow = sheet.addRow(['', '', '', '', '', '']);
      sepRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: separatorColor } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
          right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
        };
      });
    }

    const rowValues = [serial++, p.date, p.room, p.name, p.physician, p.contractor];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
      if (colNumber === 1 || colNumber === 3) cell.font = { bold: true };
    });
    currentGroup = group;
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 30;
  sheet.getColumn(6).width = 20;
}

async function applyRefinedHeader(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, title: string, numCols: number = 6) {
  const customBg = getCustomHeaderBgInfo();
  let bgBuffer: Buffer | null = null;
  
  if (customBg && fs.existsSync(customBg.path) && fs.statSync(customBg.path).size > 0) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <rect x="420" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.12" />
          <text x="600" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="bold" fill="#000000" text-anchor="middle">${title}</text>
        </svg>
      `;
      bgBuffer = await sharp(customBg.path)
        .resize(1200, 180, { fit: 'fill' })
        .composite([{
          input: Buffer.from(svgText),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();
    } catch (sharpErr) {
      console.error('Error compositing textbox on custom background:', sharpErr);
    }
  }

  if (!bgBuffer) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <rect width="1200" height="180" fill="#EBF3F5" />
          <rect x="420" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.18" />
          <text x="600" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="bold" fill="#000000" text-anchor="middle">${title}</text>
        </svg>
      `;
      bgBuffer = await sharp(Buffer.from(svgText))
        .png()
        .toBuffer();
    } catch (sharpFallbackErr) {
      console.error('Error generating fallback header:', sharpFallbackErr);
    }
  }

  if (bgBuffer) {
    try {
      const bgId = workbook.addImage({
        buffer: bgBuffer,
        extension: 'png',
      });
      sheet.addImage(bgId, {
        tl: { col: 0, row: 0 } as any,
        br: { col: numCols, row: 1 } as any,
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error(`Error adding header background image to sheet "${title}":`, err);
    }
  }
}

async function addRefinedEntrySheet(workbook: ExcelJS.Workbook, entryPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Entry', {
    views: [{ rightToLeft: false }] 
  });

  const processedData = entryPatients.filter(p => {
    const roomStr = p.room || p.colB || "";
    if (isOperatingRoom(roomStr)) return false;
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'دخول', 6);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Booking Date / تاريخ الحجز'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }; // Dark business slate
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' };
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  // Group items
  const groupedItems: { groupName: string, items: any[] }[] = [];
  processedData.forEach(p => {
    const roomStr = (p.room || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let groupName = "OTHER"; 
    if (roomStr.includes("PICU")) groupName = "PICU";
    else if (roomStr.includes("NICU")) groupName = "NICU";
    else if (roomStr.includes("CCU")) groupName = "CCU";
    else if (roomStr.includes("SICU")) groupName = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) groupName = "VIP";
    else if (roomStr.includes("ICU")) groupName = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum > 0) groupName = "Floor " + Math.floor(roomNum / 100);

    let existing = groupedItems.find(g => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  const groupOrderRank = (g: string) => {
    const u = g.toUpperCase();
    if (u.includes("ICU") && !u.includes("VIP") && !u.includes("SICU") && !u.includes("CCU") && !u.includes("NICU") && !u.includes("PICU")) return 1;
    if (u.includes("VIP")) return 2;
    if (u.includes("SICU")) return 3;
    if (u.includes("CCU")) return 4;
    if (u.includes("NICU")) return 5;
    if (u.includes("PICU")) return 6;
    if (u.includes("FIRST")) return 7;
    if (u.includes("ZONE A")) return 8;
    if (u.includes("ZONE B")) return 9;
    if (u.includes("ZONE C")) return 9.5;
    if (u.includes("4TH")) return 10;
    return 100;
  };

  groupedItems.sort((a, b) => groupOrderRank(a.groupName) - groupOrderRank(b.groupName));

  // Sort inside groups by room
  groupedItems.forEach(g => {
    g.items.sort((a, b) => {
      const numA = parseInt(a.room.match(/\d+/)?.at(0) || "0");
      const numB = parseInt(b.room.match(/\d+/)?.at(0) || "0");
      if (numA !== numB) return numA - numB;
      return a.room.localeCompare(b.room);
    });
  });

  let serial = 1;
  groupedItems.forEach(group => {
    const rColors = getGroupColors(group.groupName);
    
    // Add colored department separator row
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '']); // allocate row slots (6 columns)
    sheet.mergeCells(startRow, 1, startRow, 6);
    const separatorCell = sheet.getCell(startRow, 1);
    const displayGroupName = group.groupName === "VIP" ? "VIP ICU" : group.groupName;
    separatorCell.value = `■  ${displayGroupName}  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    // Add patients rows
    group.items.forEach((p) => {
      const rowValues = [serial++, p.room, p.name, p.physician, p.contractor, p.date];
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell((cell, colNumber) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        if (colNumber === 1 || colNumber === 2 || colNumber === 3) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
      });
    });
  });

  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 35;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
}

async function addRefinedExitSheet(workbook: ExcelJS.Workbook, dischargedPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Exit', {
    views: [{ rightToLeft: false }] 
  });

  const filteredDischarged = dischargedPatients.filter(p => {
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'خروج', 8);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Admission Date / تاريخ الدخول', 'VIP STATUS', 'Status / الحالة'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }; // Dark business slate
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' };
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  // Group items
  const groupedItems: { groupName: string, items: any[] }[] = [];
  filteredDischarged.forEach(p => {
    const roomStr = (p.room || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let groupName = "OTHER"; 
    if (roomStr.includes("PICU")) groupName = "PICU";
    else if (roomStr.includes("NICU")) groupName = "NICU";
    else if (roomStr.includes("CCU")) groupName = "CCU";
    else if (roomStr.includes("SICU")) groupName = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) groupName = "VIP";
    else if (roomStr.includes("ICU")) groupName = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum > 0) groupName = "Floor " + Math.floor(roomNum / 100);

    let existing = groupedItems.find(g => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  const groupOrderRank = (g: string) => {
    const u = g.toUpperCase();
    if (u.includes("ICU") && !u.includes("VIP") && !u.includes("SICU") && !u.includes("CCU") && !u.includes("NICU") && !u.includes("PICU")) return 1;
    if (u.includes("VIP")) return 2;
    if (u.includes("SICU")) return 3;
    if (u.includes("CCU")) return 4;
    if (u.includes("NICU")) return 5;
    if (u.includes("PICU")) return 6;
    if (u.includes("FIRST")) return 7;
    if (u.includes("ZONE A")) return 8;
    if (u.includes("ZONE B")) return 9;
    if (u.includes("ZONE C")) return 9.5;
    if (u.includes("4TH")) return 10;
    return 100;
  };

  groupedItems.sort((a, b) => groupOrderRank(a.groupName) - groupOrderRank(b.groupName));

  // Sort inside groups by room
  groupedItems.forEach(g => {
    g.items.sort((a, b) => {
      const numA = parseInt(a.room.match(/\d+/)?.at(0) || "0");
      const numB = parseInt(b.room.match(/\d+/)?.at(0) || "0");
      if (numA !== numB) return numA - numB;
      return a.room.localeCompare(b.room);
    });
  });

  let serial = 1;
  groupedItems.forEach(group => {
    const rColors = getGroupColors(group.groupName);
    
    // Add colored department separator row
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '', '', '']); // allocate row slots (8 columns)
    sheet.mergeCells(startRow, 1, startRow, 8);
    const separatorCell = sheet.getCell(startRow, 1);
    const displayGroupName = group.groupName === "VIP" ? "VIP ICU" : group.groupName;
    separatorCell.value = `■  ${displayGroupName}  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    // Add patients rows
    group.items.forEach((p) => {
      const isOrPt = cumulativeORList.some(orPt => isNameMatch(p.name, orPt.patientName));
      const rowValues = [
        serial++, 
        p.room, 
        p.name, 
        p.physician, 
        p.contractor, 
        cleanAdmissionDateStr(p.date), 
        isPatientVip(p.name) ? "VIP" : "",
        isOrPt ? "Discharged OR Patient" : ""
      ];
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell((cell, colNumber) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        if (colNumber === 1 || colNumber === 2 || colNumber === 3) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
      });
    });
  });

  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 35;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 25; // date
  sheet.getColumn(7).width = 15; // VIP Status
  sheet.getColumn(8).width = 25; // Status
}

async function addRefinedDialysisSheet(workbook: ExcelJS.Workbook, dialysisPatients: any[]) {
  const sheet = workbook.addWorksheet('Dialysis', {
    views: [{ rightToLeft: false }] 
  });

  const processedData = dialysisPatients.filter(p => {
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !GLOBAL_EXCLUSIONS.some(kw => rowAsString.includes(kw));
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'حالات الغسيل الكلوي', 6);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Booking Date / تاريخ الحجز'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }; // Dark business slate
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' };
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  // Group items
  const groupedItems: { groupName: string, items: any[] }[] = [];
  processedData.forEach(p => {
    const roomStr = (p.room || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "-1");
    let groupName = "OTHER"; 
    if (roomStr.includes("PICU")) groupName = "PICU";
    else if (roomStr.includes("NICU")) groupName = "NICU";
    else if (roomStr.includes("CCU")) groupName = "CCU";
    else if (roomStr.includes("SICU")) groupName = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) groupName = "VIP";
    else if (roomStr.includes("ICU")) groupName = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum >= 0) groupName = "Floor " + Math.floor(roomNum / 100);

    let existing = groupedItems.find(g => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  const groupOrderRank = (g: string) => {
    const u = g.toUpperCase();
    if (u.includes("ICU") && !u.includes("VIP") && !u.includes("SICU") && !u.includes("CCU") && !u.includes("NICU") && !u.includes("PICU")) return 1;
    if (u.includes("VIP")) return 2;
    if (u.includes("SICU")) return 3;
    if (u.includes("CCU")) return 4;
    if (u.includes("NICU")) return 5;
    if (u.includes("PICU")) return 6;
    if (u.includes("FIRST")) return 7;
    if (u.includes("ZONE A")) return 8;
    if (u.includes("ZONE B")) return 9;
    if (u.includes("ZONE C")) return 9.5;
    if (u.includes("4TH")) return 10;
    return 100;
  };

  groupedItems.sort((a, b) => groupOrderRank(a.groupName) - groupOrderRank(b.groupName));

  // Sort inside groups by room
  groupedItems.forEach(g => {
    g.items.sort((a, b) => {
      const numA = parseInt(a.room.match(/\d+/)?.at(0) || "0");
      const numB = parseInt(b.room.match(/\d+/)?.at(0) || "0");
      if (numA !== numB) return numA - numB;
      return a.room.localeCompare(b.room);
    });
  });

  let serial = 1;
  groupedItems.forEach(group => {
    const rColors = getGroupColors(group.groupName);
    
    // Add colored department separator row
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '']); // allocate row slots (6 columns)
    sheet.mergeCells(startRow, 1, startRow, 6);
    const separatorCell = sheet.getCell(startRow, 1);
    const displayGroupName = group.groupName === "VIP" ? "VIP ICU" : group.groupName;
    if (displayGroupName === "Floor 0") {
      separatorCell.value = `■  Dialysis Beds (Total cases of dialysis: ${group.items.length})  ■`;
    } else {
      separatorCell.value = `■  ${displayGroupName}  ■`;
    }
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    // Add patients rows
    group.items.forEach((p) => {
      const rowValues = [serial++, p.room, p.name, p.physician, p.contractor, p.date];
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell((cell, colNumber) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        if (colNumber === 1 || colNumber === 2 || colNumber === 3) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
      });
    });
  });

  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 35;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
}

async function addRefinedInsuredDebtsSheet(workbook: ExcelJS.Workbook, debts: any[]) {
  const sheet = workbook.addWorksheet('Insured Debts', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'مديونيات الجهات والشركات', 8);

  const sortedDebts = [...debts];

  const headerLabels = ['تاريخ الحجز / Date', 'Room / الغرفة', 'Patient / اسم المريض', 'Contract / التعاقد', 'Total Bill / إجمالي الحساب (Z)', 'Remaining Amount / المبلغ المتبقي', 'Remaining Pct / نسبة المتبقي (%)', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4A148C' } }; // Purple for distinction
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' };
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  const processedDebts = sortedDebts.map(p => {
    const valAB = parseFloat(String(p.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const valZ = parseFloat(String(p.colZ).replace(/[^0-9.-]+/g, "")) || 0;
    const pct = valZ > 0 ? (valAB / valZ) : 0;
    return { ...p, valAB, valZ, pct };
  });

  const above50 = processedDebts.filter(p => p.pct >= 0.5);
  const below50 = processedDebts.filter(p => p.pct < 0.5);

  above50.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return b.valAB - a.valAB;
  });
  below50.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return b.valAB - a.valAB;
  });

  const renderPatientRow = (p: any) => {
    const rowValues = [
      p.colA ? String(p.colA).split(' ')[0] : '', 
      p.room, 
      p.colD, 
      p.colM, 
      p.valZ, 
      p.valAB, 
      p.pct,
      isPatientVip(p.colD) ? "VIP" : ""
    ];
    
    const roomStr = (p.room || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let groupName = "OTHER"; 
    if (roomStr.includes("PICU")) groupName = "PICU";
    else if (roomStr.includes("NICU")) groupName = "NICU";
    else if (roomStr.includes("CCU")) groupName = "CCU";
    else if (roomStr.includes("SICU")) groupName = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) groupName = "VIP";
    else if (roomStr.includes("ICU")) groupName = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum > 0) groupName = "Floor " + Math.floor(roomNum / 100);

    const rColors = getGroupColors(groupName);

    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;
    pRow.eachCell((cell, colNumber) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
      if (colNumber === 2 || colNumber === 3) {
        cell.font = { bold: true, name: 'Calibri', size: 11 };
      }
      if (colNumber === 5 || colNumber === 6) {
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 7) {
        cell.numFmt = '0.0%';
      }
    });
  };

  above50.forEach(p => renderPatientRow(p));
  below50.forEach(p => renderPatientRow(p));

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 35;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 25;
  sheet.getColumn(7).width = 20;
  sheet.getColumn(8).width = 15;
}

function getInsuredNonCashOccupancy(data: any[][] | null): any[] {
  if (!data) return [];
  
  let startIdx = 3;
  for (let i = 0; i < Math.min(data.length, 10); i++) {
    const r1 = String(data[i][1] || "").toLowerCase();
    const r3 = String(data[i][3] || "").toLowerCase();
    if (r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name") {
      startIdx = i + 1;
      break;
    }
  }
  
  if (data.length <= startIdx) return [];
  
  const results: any[] = [];
  
  data.slice(startIdx).forEach(row => {
    const room = String(row[1] || "").trim();
    const name = String(row[3] || "").trim();
    const physician = String(row[22] || "").trim();
    const contractor = String(row[12] || "").trim();
    const fStatus = String(row[5] || "").trim();
    const date = cleanAdmissionDateStr(row[0]);
    
    if (!room || !name) return;
    
    const rowAsString = [room, name, physician, contractor, fStatus].join(" ").toLowerCase();
    const isHeader = room.toLowerCase() === "bed" || room.toLowerCase() === "room" || room === "الغرفة" || name.toLowerCase() === "patient" || name === "المريض";
    const isOR = isOperatingRoom(room);
    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
    
    if (isHeader || isOR || isExcluded) return;
    
    const fLower = fStatus.toLowerCase();
    const mLower = contractor.toLowerCase();
    
    const isCash = fLower.includes("cash") || fLower.includes("كاش") || fLower.includes("elite") || 
                   fLower.includes("نقدي") || fLower.includes("نقدى") || fLower.includes("افراد") || fLower.includes("أفراد") || 
                   fLower.includes("شخصي") || fLower.includes("شخصى") || fLower.includes("self") || fLower.includes("private") || fLower.includes("personal") || fLower.includes("individual") || fLower.includes("بدون جهة") || fLower.includes("بدون جهه") || fLower.includes("عميل") ||
                   mLower.includes("cash") || mLower.includes("كاش") || mLower.includes("elite") || 
                   mLower.includes("نقدي") || mLower.includes("نقدى") || mLower.includes("افراد") || mLower.includes("أفراد") || 
                   mLower.includes("شخصي") || mLower.includes("شخصى") || mLower.includes("self") || mLower.includes("private") || mLower.includes("personal") || mLower.includes("individual") || mLower.includes("بدون جهة") || mLower.includes("بدون جهه") || mLower.includes("عميل");
                   
    if (!isCash && name.length > 0) {
      results.push({
        room,
        name,
        physician,
        contractor,
        financialStatus: fStatus || "Insured",
        date,
      });
    }
  });
  
  return results;
}

async function addInsuredNonCashOccupancySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Insured Non-Cash Patients', {
    views: [{ rightToLeft: false }] 
  });

  const parsedData = getInsuredNonCashOccupancy(data);

  parsedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  const groupedItems: { groupName: string, items: any[] }[] = [];
  parsedData.forEach(p => {
    const groupName = p.contractor || "جهة أخرى / Other";
    let existing = groupedItems.find(g => g.groupName.toLowerCase() === groupName.toLowerCase());
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  // Sort groups alphabetically by company name
  groupedItems.sort((a, b) => a.groupName.localeCompare(b.groupName));

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'المرضى المؤمنين (غير النقديين)', 8);

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Booking Date / تاريخ الحجز', 'Financial Status / الحالة المالية', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const companyColors = [
    { badge: 'FF1565C0', row: 'FFEBF5FB' }, // Blue
    { badge: 'FF2E7D32', row: 'FFEBF5EB' }, // Emerald
    { badge: 'FF3F889E', row: 'FFEBF2F5' }, // Teal
    { badge: 'FF5C5A7F', row: 'FFF1EFF5' }, // Purple
    { badge: 'FFEF6C00', row: 'FFFFF5EB' }, // Orange
    { badge: 'FF455A64', row: 'FFF5F7F8' }, // Slate
  ];

  let serial = 1;

  groupedItems.forEach((group, index) => {
    const rColors = companyColors[index % companyColors.length];
    
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '', '', '']); 
    sheet.mergeCells(startRow, 1, startRow, 8);
    const separatorCell = sheet.getCell(startRow, 1);
    separatorCell.value = `■  ${group.groupName}  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    group.items.forEach((p) => {
      const rowValues = [
        serial++, 
        p.room, 
        p.name, 
        p.physician, 
        p.contractor, 
        p.date, 
        p.financialStatus,
        isPatientVip(p.name) ? "VIP" : ""
      ];
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell((cell, colNumber) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        
        if (colNumber === 1 || colNumber === 2 || colNumber === 3) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        } else if (colNumber === 8) {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } }; 
        }
      });
    });
  });

  sheet.getColumn(1).width = 10; 
  sheet.getColumn(2).width = 16; 
  sheet.getColumn(3).width = 32; 
  sheet.getColumn(4).width = 28; 
  sheet.getColumn(5).width = 25; 
  sheet.getColumn(6).width = 20; 
  sheet.getColumn(7).width = 22; 
  sheet.getColumn(8).width = 15; 
}

async function addRefinedDebtsSheet(workbook: ExcelJS.Workbook, debts: any[]) {
  const sheet = workbook.addWorksheet('Debts', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'المديونيات', 8);

  const sortedDebts = [...debts];

  const headerLabels = ['تاريخ الحجز / Date', 'Room / الغرفة', 'Patient / اسم المريض', 'Contract / التعاقد', 'Total Bill / إجمالي الحساب (Z)', 'Remaining Amount / المبلغ المتبقي', 'Remaining Pct / نسبة المتبقي (%)', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }; // Dark business slate
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' };
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  // Group and sort items by remaining percentage
  const processedDebts = sortedDebts.map(p => {
    const valAB = parseFloat(String(p.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const valZ = parseFloat(String(p.colZ).replace(/[^0-9.-]+/g, "")) || 0;
    const pct = valZ > 0 ? (valAB / valZ) : 0;
    return { ...p, valAB, valZ, pct };
  });

  const above50 = processedDebts.filter(p => p.pct >= 0.5);
  const below50 = processedDebts.filter(p => p.pct < 0.5);

  // Sort each group descending by Remaining Pct / pct, then by Remaining Amount / valAB
  above50.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return b.valAB - a.valAB;
  });
  below50.sort((a, b) => {
    if (b.pct !== a.pct) return b.pct - a.pct;
    return b.valAB - a.valAB;
  });

  const renderPatientRow = (p: any) => {
    const rowValues = [
      p.colA ? String(p.colA).split(' ')[0] : '', 
      p.room, 
      p.colD, 
      p.colM, 
      p.valZ, 
      p.valAB, 
      p.pct,
      isPatientVip(p.colD) ? "VIP" : ""
    ];
    
    // Determine row background color based on department/floor
    const roomStr = (p.room || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let groupName = "OTHER"; 
    if (roomStr.includes("PICU")) groupName = "PICU";
    else if (roomStr.includes("NICU")) groupName = "NICU";
    else if (roomStr.includes("CCU")) groupName = "CCU";
    else if (roomStr.includes("SICU")) groupName = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) groupName = "VIP";
    else if (roomStr.includes("ICU")) groupName = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum > 0) groupName = "Floor " + Math.floor(roomNum / 100);

    const rColors = getGroupColors(groupName);

    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;
    pRow.eachCell((cell, colNumber) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
      if (colNumber === 2 || colNumber === 3) {
        cell.font = { bold: true, name: 'Calibri', size: 11 };
      } else if (colNumber === 6) {
        cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFC00000' } };
      } else if (colNumber === 7) {
        cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FF1F4E79' } };
      } else if (colNumber === 8) {
        cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } };
      }

      if (colNumber === 5 || colNumber === 6) {
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 7) {
        cell.numFmt = '0.0%';
      }
    });
  };

  // 1. Add patients with more than 50% remaining (>= 50%)
  above50.forEach(p => renderPatientRow(p));

  // 2. Add separator (representing 50% threshold)
  const sepRowIdx = sheet.rowCount + 1;
  sheet.addRow(['', '', '', '', '', '', '', '']);
  sheet.mergeCells(sepRowIdx, 1, sepRowIdx, 8);
  const separatorCell = sheet.getCell(sepRowIdx, 1);
  separatorCell.value = '■ متبقي أقل من 50% / Remaining Less Than 50% ■';
  separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD32F2F' } }; // Rich crimson red badge
  separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
  separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(sepRowIdx).height = 28;

  // 3. Add patients with less than 50% remaining (< 50%)
  below50.forEach(p => renderPatientRow(p));

  // Apply dataBar conditional formatting to 'Remaining Pct / نسبة المتبقي (%)' column (Column G / 7)
  const lastRow = sheet.rowCount;
  if (lastRow >= 3) {
    sheet.addConditionalFormatting({
      ref: `G3:G${lastRow}`,
      rules: [
        {
          type: 'dataBar',
          cfvo: [
            { type: 'num', value: 0 },
            { type: 'num', value: 1 }
          ],
          color: { argb: 'FF5C6BC0' }, // Soft slate blue progress bar color
          showValue: true,
          gradient: true
        } as any
      ]
    });
  }

  sheet.columns = [
    { width: 15 }, { width: 14 }, { width: 35 }, { width: 25 }, { width: 18 }, { width: 22 }, { width: 18 }, { width: 15 }
  ];
}

async function createSingleMedicalPlanSheetRefined(workbook: ExcelJS.Workbook, sheetName: string, plans: any[], bgColor: string = 'FFB3E5FC') {
  (workbook as any).isMedicalPlans = true;
  const sanitizedName = sheetName.substring(0, 31).replace(/[\[\]\*\?\/\\]/g, "");
  const sheet = workbook.addWorksheet(sanitizedName, {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, `تطورات الحالات المنومة - ${sheetName}`, 8);

  const headerLabels = ['#', 'تاريخ الدخول / Admission Date', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'تاريخ التحديث الطبي', 'الخطة الطبية (SBAR)'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 35;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 14, color: { argb: 'FF000000' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }; 
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  plans.forEach((p, index) => {
    const rowValues = [index + 1, cleanAdmissionDateStr(p.colA), p.colB, p.colD, p.colW, p.colM, p.colAG || "", p.colAH];
    const pRow = sheet.addRow(rowValues);
    const rowBgColor = (index % 2 === 1) ? bgColor : 'FFFFFFFF';

    pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBgColor } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      if (colNumber === 8) {
        cell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      } else {
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      }
      cell.font = { name: 'Arial', size: 11 };
    });
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
  sheet.getColumn(7).width = 20;
  sheet.getColumn(8).width = 80;
}

async function addGridOccupancySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Colored Structured Grid', {
    views: [{ rightToLeft: false }] 
  });

  let processedData = data.slice(3)
    .map(row => ({
      room: String(row[0] || "").trim(),
      name: String(row[1] || "").trim(),
      physician: String(row[2] || "").trim(),
      contractor: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
    }))
    .filter(p => {
      if (!p.room || !p.name) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
    });

  processedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  const customBg = getCustomHeaderBgInfo();

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = ''; // Let standard text box overlay be the sole visual representor
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  let bgBuffer: Buffer | null = null;
  
  if (customBg && fs.existsSync(customBg.path) && fs.statSync(customBg.path).size > 0) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <!-- Text Box Container in the middle of the header, arranged in front - nearly transparent, no outline -->
          <rect x="420" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.12" />
          <text x="600" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="bold" fill="#000000" text-anchor="middle">الإشغال</text>
        </svg>
      `;
      bgBuffer = await sharp(customBg.path)
        .resize(1200, 180, { fit: 'fill' })
        .composite([{
          input: Buffer.from(svgText),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();
    } catch (sharpErr) {
      console.error('Error compositing textbox on custom background:', sharpErr);
    }
  }

  if (!bgBuffer) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <!-- Background solid soft slate/gray color -->
          <rect width="1200" height="180" fill="#EBF3F5" />
          <!-- Rounded text box at the center - nearly transparent, no outline -->
          <rect x="420" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.18" />
          <text x="600" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="40" font-weight="bold" fill="#000000" text-anchor="middle">الإشغال</text>
        </svg>
      `;
      bgBuffer = await sharp(Buffer.from(svgText))
        .png()
        .toBuffer();
    } catch (sharpFallbackErr) {
      console.error('Error generating fallback header:', sharpFallbackErr);
    }
  }

  // Add the composited background image containing the text box arranged in the front
  if (bgBuffer) {
    try {
      const bgId = workbook.addImage({
        buffer: bgBuffer,
        extension: 'png',
      });
      sheet.addImage(bgId, {
        tl: { col: 0, row: 0 } as any,
        br: { col: 7, row: 1 } as any,
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error('Error adding header background image to Excel:', err);
    }
  }

  // No logo added on this sheet header anymore per user request

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Booking Date / تاريخ الحجز', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }; // Dark business slate
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' }; // matching image colors
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  // Group items
  const groupedItems: { groupName: string, items: any[] }[] = [];
  processedData.forEach(p => {
    const roomStr = p.room.toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let groupName = "OTHER"; 
    if (roomStr.includes("PICU")) groupName = "PICU";
    else if (roomStr.includes("NICU")) groupName = "NICU";
    else if (roomStr.includes("CCU")) groupName = "CCU";
    else if (roomStr.includes("SICU")) groupName = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) groupName = "VIP";
    else if (roomStr.includes("ICU")) groupName = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum > 0) groupName = "Floor " + Math.floor(roomNum / 100);

    let existing = groupedItems.find(g => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  let serial = 1;

  groupedItems.forEach(group => {
    const rColors = getGroupColors(group.groupName);
    
    // Add colored department separator row
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '', '']); // allocate row slots (7 columns)
    sheet.mergeCells(startRow, 1, startRow, 7);
    const separatorCell = sheet.getCell(startRow, 1);
    const displayGroupName = group.groupName === "VIP" ? "VIP ICU" : group.groupName;
    separatorCell.value = `■  ${displayGroupName}  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    // Add patients rows inside this department
    group.items.forEach((p) => {
      const rowValues = [serial++, p.room, p.name, p.physician, p.contractor, p.date, isPatientVip(p.name) ? "VIP" : ""];
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell((cell, colNumber) => {
        // All cells in this row get the soft group background color
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        
        // Custom styling for serial index, Patient column and Room column to make it look prominent
        if (colNumber === 1 || colNumber === 2 || colNumber === 3) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        } else if (colNumber === 7) {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } }; // Red for VIP
        }
      });
    });
  });

  sheet.getColumn(1).width = 10; // serial column
  sheet.getColumn(2).width = 16; // room
  sheet.getColumn(3).width = 32; // patient name
  sheet.getColumn(4).width = 28; // physician
  sheet.getColumn(5).width = 25; // contract
  sheet.getColumn(6).width = 20; // date
  sheet.getColumn(7).width = 15; // VIP Status
}

function addEntrySheet(workbook: ExcelJS.Workbook, entryPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Entry', {
    views: [{ rightToLeft: false }] 
  });

  // Apply room filter to entries: if they moved to an excluded room, hide them
  const processedData = entryPatients.filter(p => {
    const roomStr = p.room || p.colB || "";
    if (isOperatingRoom(roomStr)) return false;
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
  });

  processedData.sort((a, b) => {
    const getRank = (str: string) => {
      const u = str.toUpperCase();
      if (u.includes("DIALYSIS")) return 1;
      if (u.includes("ICU")) return 2;
      if (u.includes("CCU")) return 3;
      if (u.includes("ROOM") || !isNaN(parseInt(str.match(/\d+/)?.[0]||""))) return 4;
      return 5;
    };
    const rankA = getRank(a.room);
    const rankB = getRank(b.room);
    if (rankA !== rankB) return rankA - rankB;
    return a.room.localeCompare(b.room);
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'دخول';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2F1' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 6.0);

  const headerLabels = ['#', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'تاريخ الحجز'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 20;
  const headerHeaderColor = 'FFF4B084'; 
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerHeaderColor } };
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  sheet.autoFilter = 'A2:F2';

  let currentGroup: string | null = null;
  let serial = 1;

  processedData.forEach((p) => {
    const roomStr = p.room.toUpperCase();
    let group = "OTHER"; 
    if (roomStr.includes("DIALYSIS")) group = "DIALYSIS";
    else if (roomStr.includes("ICU")) group = "ICU";
    else if (roomStr.includes("CCU")) group = "CCU";
    else group = "ROOMS";

    if (currentGroup !== null && group !== currentGroup) {
      const sepRow = sheet.addRow(['', '', '', '', '', '']);
      sepRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
      });
    }

    const rowValues = [serial++, p.room, p.name, p.physician, p.contractor, p.date];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
      if (colNumber === 6) { 
         if(p.date.includes("الخروج")) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }; 
         else if(p.date.includes("اليوم")) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }; 
         else if(p.date.includes("ملاحظه") || p.date.includes("ملاحظة")) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } }; 
         if(p.date.includes("عمليات") && !p.date.includes("اليوم")) cell.font = { name: 'Calibri', size: 11, color: { argb: 'FFFF0000'}, bold: true };
      }
      if (colNumber === 1 || colNumber === 2) cell.font = { bold: true };
    });
    currentGroup = group;
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 40;
  sheet.getColumn(4).width = 40;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
}

function addExitSheet(workbook: ExcelJS.Workbook, dischargedPatients: any[]) {
  const sheet = workbook.addWorksheet('Formatted Exit', {
    views: [{ rightToLeft: false }] 
  });

  // Filter out any that were incorrectly marked or moved to excluded rooms (though fixed in upload logic)
  const filteredDischarged = dischargedPatients.filter(p => {
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
  });

  const getRoomRank = (room: string) => {
    const r = room.toUpperCase();
    if (r.includes("PICU")) return 5;
    if (r.includes("NICU")) return 4;
    if (r.includes("CCU")) return 3;
    if (r.includes("SICU")) return 2;
    if (r.includes("ICU") || r.includes("VIP")) return 1;
    return 10;
  };

  filteredDischarged.sort((a, b) => {
    const rankA = getRoomRank(a.room);
    const rankB = getRoomRank(b.room);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(a.room.match(/\d+/)?.at(0) || "0");
    const numB = parseInt(b.room.match(/\d+/)?.at(0) || "0");
    if (numA !== numB) return numA - numB;
    return a.room.localeCompare(b.room);
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'خروج';
  titleCell.font = { name: 'Arial', size: 36, bold: true };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  const headerRow = sheet.getRow(2);
  headerRow.values = ['', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'تاريخ الدخول', 'الحالة / Status'];
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Arial', size: 10, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4B084' } }; 
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      right: { style: 'thin', color: { argb: 'FFBFBFBF' } }
    };
  });

  sheet.columns = [
    { width: 4 }, { width: 14 }, { width: 35 }, { width: 35 }, { width: 22 }, { width: 25 }, { width: 25 }
  ];

  let currentRowIdx = 3;
  let serialNum = 1;
  let currentGroup = '';

  const getGroupLabel = (room: string) => {
    const roomStr = room.trim().toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.at(0) || "0");
    if (roomStr.includes("PICU")) return "PEDIATRIC INTENSIVE CARE (PICU)";
    if (roomStr.includes("NICU")) return "NEONATAL INTENSIVE CARE (NICU)";
    if (roomStr.includes("CCU")) return "CORONARY CARE UNIT (CCU)";
    if (roomStr.includes("SICU")) return "SURGICAL INTENSIVE CARE (SICU)";
    if (roomStr.includes("ICU") || roomStr.includes("VIP ISOLATION")) return "INTENSIVE CARE UNIT (ICU)";
    if (roomStr.includes("DIALYSIS")) return "DIALYSIS";
    if (roomNum >= 101 && roomNum <= 108) return "STATION 1 (ROOMS 101-108)";
    if (roomNum >= 301 && roomNum <= 319) return "ZONE A (ROOMS 301-319)";
    if (roomNum >= 320 && roomNum <= 329) return "ZONE B (ROOMS 320-329)";
    if (roomNum >= 330 && roomNum <= 332) return "ZONE C (ROOMS 330-332)";
    if (roomNum >= 401 && roomNum <= 422) return "4TH FLOOR (ROOMS 401-422)";
    return "OTHER UNITS";
  };

  filteredDischarged.forEach((patient) => {
    const group = getGroupLabel(patient.room);
    if (group !== currentGroup) {
      if (currentRowIdx > 3) currentRowIdx++; 
      currentGroup = group;
    }
    const row = sheet.getRow(currentRowIdx);
    const isOrPt = cumulativeORList.some(orPt => isNameMatch(patient.name, orPt.patientName));
    row.values = [
      serialNum++, 
      patient.room, 
      patient.name, 
      patient.physician, 
      patient.contractor, 
      cleanAdmissionDateStr(patient.date || patient.admissionDate || ""),
      isOrPt ? "Discharged OR Patient" : ""
    ];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      cell.font = { name: 'Arial', size: 10, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
        right: { style: 'thin', color: { argb: 'FFBFBFBF' } }
      };
    });
    row.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF000000' } };
    currentRowIdx++;
  });
}

// Data Routes
function addDialysisSheet(workbook: ExcelJS.Workbook, dialysisPatients: any[]) {
  const sheet = workbook.addWorksheet('Dialysis', {
    views: [{ rightToLeft: false }] 
  });

  // Apply room filter to dialysis: hide if moved to globally excluded room (just in case)
  const processedData = dialysisPatients.filter(p => {
    const rowAsString = Object.values(p).join(" ").toLowerCase();
    return !GLOBAL_EXCLUSIONS.some(kw => rowAsString.includes(kw));
  });

  processedData.sort((a, b) => {
    return a.room.localeCompare(b.room);
  });

  sheet.mergeCells('A1:F1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'حالات الغسيل الكلوي';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2F1' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 6.0);

  const headerLabels = ['#', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'تاريخ الحجز'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 20;
  const headerHeaderColor = 'FFE2EFDA'; // Light green for dialysis
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerHeaderColor } };
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  sheet.autoFilter = 'A2:F2';

  let serial = 1;

  processedData.forEach((p) => {
    const rowValues = [serial++, p.room, p.name, p.physician, p.contractor, p.date];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
      if (colNumber === 1 || colNumber === 2) cell.font = { bold: true };
    });
  });

  sheet.getColumn(1).width = 8;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 40;
  sheet.getColumn(4).width = 40;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
}

function addInsuredDebtsSheet(workbook: ExcelJS.Workbook, debts: any[]) {
  const sheet = workbook.addWorksheet('Insured Debts', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'مديونيات الجهات والشركات';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1BEE7' } }; // Soft light purple
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  const sortedDebts = [...debts].sort((a, b) => {
    const valA = parseFloat(String(a.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const valB = parseFloat(String(b.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    return valB - valA;
  });

  const headerLabels = ['تاريخ الحجز', 'رقم الغرفة', 'اسم المريض', 'التعاقد', 'إجمالي الحساب (Z)', 'المبلغ المتبقي', 'نسبة المتبقي (%)'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1C4E9' } };
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  sortedDebts.forEach((p) => {
    const valAB = parseFloat(String(p.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const valZ = parseFloat(String(p.colZ).replace(/[^0-9.-]+/g, "")) || 0;
    const pct = valZ > 0 ? (valAB / valZ) : 0;

    const rowValues = [
      p.colA ? String(p.colA).split(' ')[0] : '', 
      p.room, 
      p.colD, 
      p.colM, 
      valZ, 
      valAB, 
      pct
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };

      if (colNumber === 5 || colNumber === 6) {
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 7) {
        cell.numFmt = '0.0%';
      }
    });
  });

  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 35;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 25;
  sheet.getColumn(7).width = 20;
}

function addDebtsSheet(workbook: ExcelJS.Workbook, debts: any[]) {
  const sheet = workbook.addWorksheet('Debts', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'المديونيات';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4C3' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  // Sort debts by column AB (index 27/p.colAB) descending
  const sortedDebts = [...debts].sort((a, b) => {
    const valA = parseFloat(String(a.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const valB = parseFloat(String(b.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    return valB - valA;
  });

  const headerLabels = ['تاريخ الحجز', 'رقم الغرفة', 'اسم المريض', 'التعاقد', 'إجمالي الحساب (Z)', 'المبلغ المتبقي', 'نسبة المتبقي (%)'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6EE9C' } };
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  sortedDebts.forEach((p) => {
    const valAB = parseFloat(String(p.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const valZ = parseFloat(String(p.colZ).replace(/[^0-9.-]+/g, "")) || 0;
    const pct = valZ > 0 ? (valAB / valZ) : 0;

    const rowValues = [
      p.colA ? String(p.colA).split(' ')[0] : '', 
      p.room, 
      p.colD, 
      p.colM, 
      valZ, 
      valAB, 
      pct
    ];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell, colNumber) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };

      if (colNumber === 5 || colNumber === 6) {
        cell.numFmt = '#,##0.00';
      } else if (colNumber === 7) {
        cell.numFmt = '0.0%';
      }
    });
  });

  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 35;
  sheet.getColumn(4).width = 25;
  sheet.getColumn(5).width = 18;
  sheet.getColumn(6).width = 20;
  sheet.getColumn(7).width = 18;
}

function getActiveVipCount(): number {
  if (!hospitalData) return 0;
  let count = 0;
  // Use getOccupancyRows to map the raw debts sheet columns
  const dataRows = getOccupancyRows(hospitalData).slice(3);
  for (const row of dataRows) {
    if (!row) continue;
    const room = String(row[0] || "").trim();
    const name = String(row[1] || "").trim();
    if (!room || !name) continue;
    
    // We only count formatted valid in-patients (same list as refined / standard)
    const rowAsString = row.join(" ").toLowerCase();
    const isHeader = room.toLowerCase() === "bed" || room.toLowerCase() === "room" || room === "الغرفة" || name.toLowerCase() === "patient" || name === "المريض";
    const isOR = isOperatingRoom(room);
    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));

    if (!isExcluded && !isHeader && !isOR) {
      if (isPatientVip(name)) {
        count++;
      }
    }
  }
  return count;
}

async function updateHospitalState(rows: any[][]) {
  // Clean up Room 307 intermediate care to Room 307 and format raw timestamps in Row[0] (Admission Date)
  rows = rows.map((row, index) => {
    if (row) {
      if (row[1]) {
        row[1] = cleanRoomStr(String(row[1]));
      }
      if (index > 0 && row[0] !== undefined && row[0] !== null) {
        row[0] = cleanAdmissionDateStr(row[0]);
      }
    }
    return row;
  });

  if (!rows || rows.length < 2) {
    throw new Error('Sheet appears to be empty or has insufficient rows.');
  }

  // Dynamically find where data starts
  let startIdx = 3; // default
  for(let i = 0; i < Math.min(rows.length, 10); i++) {
      const r1 = String(rows[i][1] || "").toLowerCase();
      const r3 = String(rows[i][3] || "").toLowerCase();
      if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name" || r1 === "غرفة")) {
          startIdx = i + 1;
          break;
      }
  }

  const isToday = (dateStr: string) => {
    const d = dateStr.trim().toLowerCase();
    if (!d) return false;
    if (d.includes('اليوم')) return true;
    const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
    const year = today.getFullYear();
    const shortYear = year % 100;
    const month = today.getMonth() + 1;
    const day = today.getDate();
    const paddedMonth = month.toString().padStart(2, '0');
    const paddedDay = day.toString().padStart(2, '0');
    const possibleFormats = [
      `${month}/${day}/${year}`, `${month}/${day}/${shortYear}`,
      `${paddedMonth}/${paddedDay}/${year}`, `${paddedMonth}/${paddedDay}/${shortYear}`,
      `${day}/${month}/${year}`, `${day}/${month}/${shortYear}`,
      `${paddedDay}/${paddedMonth}/${year}`, `${paddedDay}/${paddedMonth}/${shortYear}`,
      `${year}-${paddedMonth}-${paddedDay}`
    ];
    if (possibleFormats.some(f => d.includes(f))) return true;
    try {
       const parsedTime = Date.parse(d);
       if (!isNaN(parsedTime)) {
         const parsedDate = new Date(parsedTime);
         if (parsedDate.getFullYear() === year && parsedDate.getMonth() === today.getMonth() && parsedDate.getDate() === day) return true;
       }
    } catch(e) {}
    return false;
  };

  const extractRowsFromData = (sourceData: any[][], skip: number) => {
    if (!sourceData || sourceData.length <= skip) return [];
    return sourceData.slice(skip).map(row => ({
      room: String(row[1] || "").trim(), // Col B Room
      name: String(row[3] || "").trim(), // Col D Patient Name
      physician: String(row[22] || "").trim(), // Col W Treating Physician
      contractor: String(row[12] || "").trim(), // Col M Contractor name
      date: cleanAdmissionDateStr(row[0]), // Col A Admission date
    })).filter(p => {
      if (!p.room || !p.name) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
    });
  };

  const newRows = extractRowsFromData(rows, startIdx);
  
  // Map of ALL patients in the current sheet (even in excluded rooms) to check for truly discharged or dialysis ones
  const currentSheetPatientsRaw = rows.slice(startIdx).map(r => ({
    room: String(r[1] || "").trim(),
    name: String(r[3] || "").trim(),
    physician: String(r[22] || "").trim(),
    contractor: String(r[12] || "").trim(),
    date: cleanAdmissionDateStr(r[0]),
  })).filter(p => p.name);
  
  const currentSheetNames = new Set(currentSheetPatientsRaw.map(p => p.name.toLowerCase().trim()));
  const isNewSheetLikelyEmpty = currentSheetNames.size === 0;

  // CLEANUP: If a patient is in the hospital (any room), they are NOT discharged.
  if (!isNewSheetLikelyEmpty) {
    cumulativeDischarged = cumulativeDischarged.filter(p => !currentSheetNames.has(p.name.toLowerCase().trim()));
  }

  const extractDialysisRows = (sourceData: any[][], skip: number) => {
    if (!sourceData || sourceData.length <= skip) return [];
    return sourceData.slice(skip).map(row => ({
      room: String(row[1] || "").trim(),
      name: String(row[3] || "").trim(),
      physician: String(row[22] || "").trim(),
      contractor: String(row[12] || "").trim(),
      date: cleanAdmissionDateStr(row[0]),
    })).filter(p => {
      if (!p.room || !p.name) return false;
      const roomLower = p.room.toLowerCase();
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      
      const isDialysis = roomLower.includes("dialysis") || roomLower.includes("diyalsis");
      const isGloballyExcluded = GLOBAL_EXCLUSIONS.some(kw => rowAsString.includes(kw));
      
      return isDialysis && !isGloballyExcluded;
    });
  };

  const dialRowsNew = extractDialysisRows(rows, startIdx);
  
  // For Dialysis: Keep all dialysis cases cumulatively
  if (!isNewSheetLikelyEmpty) {
    const currentDialNamesPersistent = new Set(cumulativeDialysis.map(p => p.name.toLowerCase().trim()));
    dialRowsNew.forEach(p => {
      if (!currentDialNamesPersistent.has(p.name.toLowerCase().trim())) {
        cumulativeDialysis.push(p);
      }
    });
  }

  // Update cumulative entries (today's entries)
  const currentEntryNames = new Set(cumulativeEntries.map(p => p.name.toLowerCase().trim()));
  newRows.forEach(p => {
    if (isToday(p.date)) {
      if (!currentEntryNames.has(p.name.toLowerCase().trim())) {
        cumulativeEntries.push(p);
      }
    }
  });

  if (hospitalData && !isNewSheetLikelyEmpty) {
    // Find the old starting row
    let oldStartIdx = 3;
    for(let i = 0; i < Math.min(hospitalData.length, 10); i++) {
      const r1 = String(hospitalData[i][1] || "").toLowerCase();
      const r3 = String(hospitalData[i][3] || "").toLowerCase();
      if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name")) {
          oldStartIdx = i + 1;
          break;
      }
    }
    
    const oldRows = extractRowsFromData(hospitalData, oldStartIdx);
    
    // Identify new discharges: in old data (filtered) but NOT in current data (at all)
    const newlyDischarged = oldRows.filter(oldP => !currentSheetNames.has(oldP.name.toLowerCase().trim()));
    
    // Also identify any OR patients that are no longer in the current sheet at all
    const oldORPatients: any[] = [];
    const oldORBody = hospitalData.slice(oldStartIdx);
    oldORBody.forEach(row => {
      const room = String(row[1] || "").trim();
      const name = String(row[3] || "").trim();
      if (isOrXRoom(room) && name) {
        oldORPatients.push({
          room,
          name,
          physician: String(row[22] || "").trim(),
          contractor: String(row[12] || "").trim(),
          date: cleanAdmissionDateStr(row[0])
        });
      }
    });
    const newlyDischargedOR = oldORPatients.filter(oldP => !currentSheetNames.has(oldP.name.toLowerCase().trim()));

    const existingDischargedNames = new Set(cumulativeDischarged.map(p => p.name.toLowerCase().trim()));
    
    newlyDischarged.forEach(p => {
      if (!existingDischargedNames.has(p.name.toLowerCase().trim())) {
        cumulativeDischarged.push(p);
      }
    });

    newlyDischargedOR.forEach(p => {
      if (!existingDischargedNames.has(p.name.toLowerCase().trim())) {
        cumulativeDischarged.push(p);
      }
    });

    previousHospitalData = hospitalData;
  }
  
  // Only update hospitalData if it has actual data, to avoid overwriting with blank sheets
  if (!isNewSheetLikelyEmpty || !hospitalData) {
      hospitalData = rows;
  }

  // Extract DEBTS from unified sheet (A, B, D, F, M, Z, AB)
  const finalExtractedDebts = rows.slice(startIdx).map(row => ({
    colA: String(row[0] || "").trim(),
    room: String(row[1] || "").trim(),
    colD: String(row[3] || "").trim(),
    colF: String(row[5] || "").trim(), // Financial status, cash or insured
    colM: String(row[12] || "").trim(), // Contractor Name
    colL: String(row[11] || "").trim(), // for backward compatibility/filter checks
    colZ: String(row[25] || "").trim(), // Total invoice
    colAB: String(row[27] || "").trim() // Remaining on invoice
  })).filter(p => {
    const fLower = p.colF.toLowerCase();
    const mLower = p.colM.toLowerCase();
    const isHomeCare = mLower.includes("home care") || mLower.includes("homecare");
    const fMatch = (fLower.includes("cash") || fLower.includes("كاش") || fLower.includes("elite") || 
                    fLower.includes("نقدي") || fLower.includes("نقدى") || fLower.includes("افراد") || fLower.includes("أفراد") || 
                    fLower.includes("شخصي") || fLower.includes("شخصى") || fLower.includes("self") || fLower.includes("private") || fLower.includes("personal") || fLower.includes("individual") || fLower.includes("بدون جهة") || fLower.includes("بدون جهه") || fLower.includes("عميل") ||
                    mLower.includes("cash") || mLower.includes("كاش") || mLower.includes("elite") || 
                    mLower.includes("نقدي") || mLower.includes("نقدى") || mLower.includes("افراد") || mLower.includes("أفراد") || 
                    mLower.includes("شخصي") || mLower.includes("شخصى") || mLower.includes("self") || mLower.includes("private") || mLower.includes("personal") || mLower.includes("individual") || mLower.includes("بدون جهة") || mLower.includes("بدون جهه") || mLower.includes("عميل")) && !isHomeCare;
    const lLower = p.colL.toLowerCase();
    const dLower = p.colD.toLowerCase();
    const isHeader = dLower === "patient" || dLower === "المريض" || dLower === "patient name" || dLower === "اسم المريض" || dLower === "name" || dLower === "patient_name";
    const isNotPhysician = !lLower.includes("physician") && (lLower.length > 0 || p.room.length > 0 || (p.colD.length > 0 && !isHeader));
    const isOR = isOperatingRoom(p.room);
    return fMatch && isNotPhysician && !isOR && p.colD.length > 0;
  });

  cumulativeDebts = finalExtractedDebts;

  // Extract INSURED DEBTS (remainings only)
  const finalExtractedInsuredDebts = rows.slice(startIdx).map(row => ({
    colA: String(row[0] || "").trim(),
    room: String(row[1] || "").trim(),
    colD: String(row[3] || "").trim(),
    colF: String(row[5] || "").trim(), // Financial status, cash or insured
    colM: String(row[12] || "").trim(), // Contractor Name
    colL: String(row[11] || "").trim(), // for backward compatibility/filter checks
    colZ: String(row[25] || "").trim(), // Total invoice
    colAB: String(row[27] || "").trim() // Remaining on invoice
  })).filter(p => {
    const fLower = p.colF.toLowerCase();
    const mLower = p.colM.toLowerCase();
    const isHomeCare = mLower.includes("home care") || mLower.includes("homecare");
    const isCash = fLower.includes("cash") || fLower.includes("كاش") || fLower.includes("elite") || 
                   fLower.includes("نقدي") || fLower.includes("نقدى") || fLower.includes("افراد") || fLower.includes("أفراد") || 
                   fLower.includes("شخصي") || fLower.includes("شخصى") || fLower.includes("self") || fLower.includes("private") || fLower.includes("personal") || fLower.includes("individual") || fLower.includes("بدون جهة") || fLower.includes("بدون جهه") || fLower.includes("عميل") ||
                   mLower.includes("cash") || mLower.includes("كاش") || mLower.includes("elite") || 
                   mLower.includes("نقدي") || mLower.includes("نقدى") || mLower.includes("افراد") || mLower.includes("أفراد") || 
                   mLower.includes("شخصي") || mLower.includes("شخصى") || mLower.includes("self") || mLower.includes("private") || mLower.includes("personal") || mLower.includes("individual") || mLower.includes("بدون جهة") || mLower.includes("بدون جهه") || mLower.includes("عميل");
    const isInsured = !isCash && !isHomeCare && (fLower.length > 0 || mLower.length > 0);
    const lLower = p.colL.toLowerCase();
    const dLower = p.colD.toLowerCase();
    const isHeader = dLower === "patient" || dLower === "المريض" || dLower === "patient name" || dLower === "اسم المريض" || dLower === "name" || dLower === "patient_name";
    const isNotPhysician = !lLower.includes("physician") && (lLower.length > 0 || p.room.length > 0 || (p.colD.length > 0 && !isHeader));
    const valAB = parseFloat(String(p.colAB).replace(/[^0-9.-]+/g, "")) || 0;
    const isOR = isOperatingRoom(p.room);
    return isInsured && isNotPhysician && valAB > 0 && p.colD.length > 0 && !isOR;
  });

  cumulativeInsuredDebts = finalExtractedInsuredDebts;

  // Extract MEDICAL PLANS using Columns: A(0), B(1), D(3), M(12), W(22), AH(33), X(23), AG(32)
  const medicalPlansRaw = rows.slice(startIdx).map(row => ({
    colA: cleanAdmissionDateStr(row[0]),
    colB: String(row[1] || "").trim(),
    colD: String(row[3] || "").trim(),
    colM: String(row[12] || "").trim(),
    colW: String(row[22] || "").trim(),
    colAG: String(row[32] || "").trim(),
    colAH: String(row[33] || "").trim(),
    colX: String(row[23] || "").trim()
  })).filter(p => {
    const bLower = p.colB.toLowerCase();
    const dLower = p.colD.toLowerCase();
    if (!p.colB || p.colB === "") return false;
    
    const isHeader = bLower === "bed" || bLower === "room" || bLower === "الغرفة" || 
                     dLower === "patient" || dLower === "المريض" || dLower === "name" ||
                     bLower === "id" || dLower === "patient name" ||
                     (bLower.includes("bed") && dLower.includes("patient"));
    if (isHeader) return false;

    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => bLower.includes(kw));
    if (isExcluded) return false;
    return true;
  });

  cumulativeMedicalPlans = medicalPlansRaw;

  // Extract COMPANION STATUS: A(0), B(1), D(3), I(8), M(12), W(22)
  const companionStatusRaw = rows.slice(startIdx).map(row => ({
    colA: String(row[0] || "").trim(),
    colB: String(row[1] || "").trim(),
    colD: String(row[3] || "").trim(),
    colI: String(row[8] || "").trim(),
    colM: String(row[12] || "").trim(),
    colW: String(row[22] || "").trim()
  })).filter(p => {
    const bLower = p.colB.toLowerCase();
    const dLower = p.colD.toLowerCase();
    if (!p.colB || p.colB === "") return false;
    
    const isHeader = bLower === "bed" || bLower === "room" || bLower === "الغرفة" || 
                     dLower === "patient" || dLower === "المريض" || dLower === "name" ||
                     bLower === "id" || dLower === "patient name" ||
                     (bLower.includes("bed") && dLower.includes("patient"));
    if (isHeader) return false;

    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => bLower.includes(kw));
    if (isExcluded) return false;
    return true;
  });

  cumulativeCompanionStatus = companionStatusRaw;

  // Extract LOS Sheet: A(0), B(1), D(3), M(12), S(18), U(20), AL(37)
  const losSheetRaw = rows.slice(startIdx).map(row => ({
    colA: cleanAdmissionDateStr(row[0]),
    colB: String(row[1] || "").trim(),
    colD: String(row[3] || "").trim(),
    colM: String(row[12] || "").trim(),
    colS: String(row[18] || "").trim(),
    colU: String(row[20] || "").trim(),
    colAL: String(row[37] || "").trim()
  })).filter(p => {
    const bLower = p.colB.toLowerCase();
    const dLower = p.colD.toLowerCase();
    if (!p.colB || p.colB === "") return false;
    
    const isHeader = bLower === "bed" || bLower === "room" || bLower === "الغرفة" || 
                     dLower === "patient" || dLower === "المريض" || dLower === "name" ||
                     bLower === "id" || dLower === "patient name" ||
                     (bLower.includes("bed") && dLower.includes("patient"));
    if (isHeader) return false;

    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => bLower.includes(kw));
    if (isExcluded) return false;

    const isOR = isOperatingRoom(p.colB);
    if (isOR) return false;
    return true;
  });

  cumulativeLOS = losSheetRaw;
  uploadedAt = Date.now();
  await saveData();

  return {
    count: cumulativeDebts.length,
    medicalPlansCount: cumulativeMedicalPlans.length,
    companionStatusCount: cumulativeCompanionStatus.length,
    losCount: cumulativeLOS.length,
    countOccupancy: newRows.length
  };
}

function getNormalizedPatientRows(rows: any[][] | null): string[] {
  if (!rows) return [];
  
  // Find where data starts
  let startIdx = 1; // default
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r1 = String(rows[i][1] || "").toLowerCase();
    const r3 = String(rows[i][3] || "").toLowerCase();
    if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name" || r1 === "غرفة")) {
      startIdx = i + 1;
      break;
    }
  }

  const list: string[] = [];
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 4) continue;
    
    const room = cleanRoomStr(String(row[1] || "")).trim().toUpperCase();
    const name = String(row[3] || "").trim().toUpperCase();
    
    // Skip headers
    if (!name || name === "PATIENT" || name === "المريض" || room === "ROOM" || room === "الغرفة" || room === "BED" || name === "NAME" || room === "غرفة") {
      continue;
    }
    
    // Normalize all cells in this row up to max 39 columns to make comparison completely robust
    const cells: string[] = [];
    const maxCols = Math.max(row.length, 39);
    for (let j = 0; j < maxCols; j++) {
      let val = row[j];
      if (val === undefined || val === null) {
        cells.push("");
        continue;
      }
      
      let valStr = "";
      if (j === 0) {
        // Clean admission date string
        valStr = cleanAdmissionDateStr(val).trim().toUpperCase();
      } else if (j === 1) {
        // Clean room string
        valStr = cleanRoomStr(String(val)).trim().toUpperCase();
      } else {
        valStr = String(val).trim().toUpperCase();
      }
      cells.push(valStr);
    }
    
    list.push(cells.join("|"));
  }
  list.sort();
  return list;
}

function areRowsDifferent(rowsA: any[][] | null, rowsB: any[][] | null): boolean {
  if (!rowsA || !rowsB) return true;
  const listA = getNormalizedPatientRows(rowsA);
  const listB = getNormalizedPatientRows(rowsB);

  if (listA.length !== listB.length) return true;
  for (let i = 0; i < listA.length; i++) {
    if (listA[i] !== listB[i]) return true;
  }
  return false;
}

async function pushToFirebaseRTDB(rows: any[][]) {
  console.log('Pushing manual spreadsheet upload to Firebase Realtime Database for automated sync...');
  const rtdbUrl = 'https://ai-studio-applet-webapp-f4da3-default-rtdb.firebaseio.com/latest_occupancy.json';

  const keys = [
    "No filters applied", // 0
    "Unnamed: 1",         // 1
    "Unnamed: 2",         // 2
    "Unnamed: 3",         // 3
    "Unnamed: 4",         // 4
    "Unnamed: 5",         // 5
    "Unnamed: 6",         // 6
    "Unnamed: 7",         // 7
    "Unnamed: 8",         // 8
    "Unnamed: 9",         // 9
    "Unnamed: 10",        // 10
    "Unnamed: 11",        // 11
    "Unnamed: 12",        // 12
    "Unnamed: 13",        // 13
    "Unnamed: 14",        // 14
    "Unnamed: 15",        // 15
    "Unnamed: 16",        // 16
    "Unnamed: 17",        // 17
    "Unnamed: 18",        // 18
    "Unnamed: 19",        // 19
    "Unnamed: 20",        // 20
    "Unnamed: 21",        // 21
    "Unnamed: 22",        // 22
    "Unnamed: 23",        // 23
    "Unnamed: 24",        // 24
    "Unnamed: 25",        // 25
    "Unnamed: 26",        // 26
    "Unnamed: 27",        // 27
    "Unnamed: 28",        // 28
    "Unnamed: 29",        // 29
    "Unnamed: 30",        // 30
    "Unnamed: 31",        // 31
    "Unnamed: 32",        // 32
    "Unnamed: 33",        // 33
    "Unnamed: 34",        // 34
    "Unnamed: 35",        // 35
    "Unnamed: 36",        // 36
    "Unnamed: 37",        // 37
    "Unnamed: 38"         // 38
  ];

  // Map each row in the Excel rows into the Firebase RTDB object structure
  const rtdbPayload = rows.map((row) => {
    const item: any = {};
    keys.forEach((key, colIdx) => {
      let cellVal = row[colIdx];
      if (cellVal === undefined || cellVal === null) {
        item[key] = "";
        return;
      }

      if (typeof cellVal === 'number') {
        item[key] = cellVal;
      } else if (cellVal instanceof Date) {
        item[key] = cellVal.getTime();
      } else if (typeof cellVal === 'string') {
        const trimmed = cellVal.trim();
        if (colIdx === 0 && trimmed) {
          const parsedTime = Date.parse(trimmed);
          if (!isNaN(parsedTime)) {
            item[key] = parsedTime;
          } else {
            item[key] = trimmed;
          }
        } else {
          const num = Number(trimmed);
          if (trimmed !== "" && !isNaN(num) && isFinite(num)) {
            item[key] = num;
          } else {
            item[key] = trimmed;
          }
        }
      } else {
        item[key] = String(cellVal).trim();
      }
    });
    return item;
  });

  try {
    if (adminRTDB) {
      await adminRTDB.ref('latest_occupancy').set(rtdbPayload);
      console.log('Firebase Realtime Database successfully updated with manual upload sheet via Admin SDK.');
    } else {
      console.warn('Firebase Realtime Database Admin reference is not initialized. Falling back to fetch (which may fail due to permissions)...');
      const response = await fetch(rtdbUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(rtdbPayload)
      });
      if (!response.ok) {
        console.error(`Firebase Realtime Database PUT failed: ${response.statusText}`);
      } else {
        console.log('Firebase Realtime Database successfully updated with manual upload sheet.');
      }
    }
  } catch (err) {
    console.error('Error uploading to Firebase Realtime Database:', err);
  }
}

async function fetchAndSyncFromFirebaseRTDB() {
  console.log('Fetching state from Firebase Realtime Database dynamically...');
  const rtdbUrl = 'https://ai-studio-applet-webapp-f4da3-default-rtdb.firebaseio.com/latest_occupancy.json';
  
  let rawData: any = null;
  if (adminRTDB) {
    const snapshot = await adminRTDB.ref('latest_occupancy').once('value');
    rawData = snapshot.val();
  } else {
    console.warn('Firebase Realtime Database Admin reference is not initialized. Falling back to fetch (which may fail due to permissions)...');
    const response = await fetch(rtdbUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch from Firebase RTDB: ${response.statusText}`);
    }
    rawData = await response.json();
  }
  if (!rawData || !Array.isArray(rawData)) {
    throw new Error('Firebase RTDB data is not an array.');
  }

  const items = rawData.filter(x => x !== null);
  if (items.length === 0) {
    throw new Error('Firebase RTDB data is empty after filtering nulls.');
  }

  // Filter out headers or non-patient items
  const dataItems = items.filter(item => {
    const admissionVal = String(item["No filters applied"] || "").toLowerCase();
    return admissionVal !== "admissiondate" && admissionVal !== "";
  });

  const keys = [
    "No filters applied", // 0
    "Unnamed: 1",         // 1
    "Unnamed: 2",         // 2
    "Unnamed: 3",         // 3
    "Unnamed: 4",         // 4
    "Unnamed: 5",         // 5
    "Unnamed: 6",         // 6
    "Unnamed: 7",         // 7
    "Unnamed: 8",         // 8
    "Unnamed: 9",         // 9
    "Unnamed: 10",        // 10
    "Unnamed: 11",        // 11
    "Unnamed: 12",        // 12
    "Unnamed: 13",        // 13
    "Unnamed: 14",        // 14
    "Unnamed: 15",        // 15
    "Unnamed: 16",        // 16
    "Unnamed: 17",        // 17
    "Unnamed: 18",        // 18
    "Unnamed: 19",        // 19
    "Unnamed: 20",        // 20
    "Unnamed: 21",        // 21
    "Unnamed: 22",        // 22
    "Unnamed: 23",        // 23
    "Unnamed: 24",        // 24
    "Unnamed: 25",        // 25
    "Unnamed: 26",        // 26
    "Unnamed: 27",        // 27
    "Unnamed: 28",        // 28
    "Unnamed: 29",        // 29
    "Unnamed: 30",        // 30
    "Unnamed: 31",        // 31
    "Unnamed: 32",        // 32
    "Unnamed: 33",        // 33
    "Unnamed: 34",        // 34
    "Unnamed: 35",        // 35
    "Unnamed: 36",        // 36
    "Unnamed: 37",        // 37
    "Unnamed: 38"         // 38
  ];

  // Dummy header row as startIdx target
  const dummyHeader = Array(40).fill("");
  dummyHeader[0] = "AdmissionDate";
  dummyHeader[1] = "room";
  dummyHeader[2] = "MRN";
  dummyHeader[3] = "patient";

  const rows: any[][] = [dummyHeader];

  dataItems.forEach(item => {
    const rowArray = keys.map((key, colIdx) => {
      let val = item[key];
      if (val === undefined || val === null) {
        return "";
      }
      if (colIdx === 0) {
        return cleanAdmissionDateStr(val);
      }
      // Formatting unix timestamp in milliseconds to standard string for other columns if needed
      if (typeof val === 'number' && val > 30 * 365 * 24 * 3600 * 1000) {
        const dateObj = new Date(val);
        return formatDateToUserFormat(dateObj);
      }
      return String(val).trim();
    });
    rows.push(rowArray);
  });

  const actualRtdbNames = rows.slice(1).map(r => String(r[3] || "").trim()).filter(Boolean);
  manuallyDischargedNames = manuallyDischargedNames.filter(mName => {
    return actualRtdbNames.some(rName => isNameMatch(mName, rName));
  });

  const headerRow = rows.slice(0, 1);
  const filteredDataRows = rows.slice(1).filter(r => {
    const pName = String(r[3] || "").trim();
    return !isManuallyDischarged(pName);
  });
  const filteredRows = [...headerRow, ...filteredDataRows];

  if (areRowsDifferent(hospitalData, filteredRows)) {
    console.log("Detected a change in Firebase Realtime Database. Updating memory state...");
    return await updateHospitalState(filteredRows);
  } else {
    console.log("No changes in Firebase Realtime Database since last check. Leaving last fetched sheet timestamp unchanged.");
    return {
      count: cumulativeDebts.length,
      medicalPlansCount: cumulativeMedicalPlans.length,
      companionStatusCount: cumulativeCompanionStatus.length,
      losCount: cumulativeLOS.length,
      countOccupancy: hospitalData ? hospitalData.length - 1 : 0
    };
  }
}

// Background periodic synchronization task every 15 minutes
setInterval(() => {
  fetchAndSyncFromFirebaseRTDB()
    .then(() => console.log('Periodic Firebase Realtime Database synchronization success.'))
    .catch(err => console.error('Periodic Firebase RTDB synchronization failure:', err));
}, 15 * 60 * 1000);

// Helper to classify IN/OUT as a fallback using string matching
function classifyInOutFallback(p: any): 'IN' | 'OUT' {
  const vt = String(p.vt || "").toUpperCase().trim();
  const column3 = String(p.column3 || "").toUpperCase().trim();
  const flClassName = String(p.flClassName || "").toUpperCase().trim();
  const postC = String(p.postC || "").toUpperCase().trim();

  // Explicit Day Case/Outpatient checking (DC, DayCase, Outpatient, etc.)
  if (vt === "DC" || vt.includes("DAY") || vt.includes("DAYCASE") || vt.includes("OUT")) {
    return 'OUT';
  }

  // Explicit Hospital Case/Inpatient checking (HC, Inpatient)
  if (vt === "HC" || vt.includes("HOSPITAL") || vt === "INPATIENT") {
    return 'IN';
  }

  // Check if post-operative care requires critical care (ICU/SICU) overnight stay
  const upperPostC = postC.toUpperCase();
  if (upperPostC.includes("ICU") || upperPostC.includes("SICU") || upperPostC.includes("CCU") || upperPostC.includes("NICU")) {
    return 'IN';
  }

  // Look for implicit keywords in Arabic/English classes while avoiding loose substrings like 'INSURED' -> 'IN'
  const combinedNorm = ` ${column3} ${flClassName} `.replace(/\bINSURED\b/g, " ").toUpperCase();
  if (combinedNorm.includes(" OUT ") || combinedNorm.includes(" DAY ") || combinedNorm.includes(" DC ")) {
    return 'OUT';
  }

  if (combinedNorm.includes(" IN ") || combinedNorm.includes(" HC ") || combinedNorm.includes(" HOSPITAL ") || combinedNorm.includes(" IP ")) {
    return 'IN';
  }

  // Default fallback if unknown
  return 'OUT'; 
}

// Helper to enrich OR list with accurate IN/OUT status by matching against current occupancy rows
function getEnrichedOrListForStats(orList: any[], occRows: any[][]): any[] {
  if (!orList || orList.length === 0) return [];
  if (!occRows || occRows.length === 0) {
    return orList.map(p => {
      const matchingDischargedObj = cumulativeDischarged.find(discPt => {
        const matchByName = isNameMatch(p.patientName, discPt.name || "");
        const matchByMrn = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
        return matchByName || matchByMrn;
      });
      const isDischarged = !!matchingDischargedObj;
      const fallbackStatus = classifyInOutFallback(p);
      const isAdmitted = fallbackStatus === 'IN' || isDischarged;
      
      const dischargedFromRoom = matchingDischargedObj ? (matchingDischargedObj.room || matchingDischargedObj.id || '') : '';
      const dischargeStatusText = isDischarged
        ? `Discharged (Room ${dischargedFromRoom}) / تم الخروج (غرفة ${dischargedFromRoom})`
        : 'Discharged / تم الخروج';

      return { 
        ...p, 
        realStatus: isAdmitted ? 'IN' : 'OUT',
        isDischarged,
        dischargedFromRoom,
        dischargeStatus: isDischarged ? dischargeStatusText : (fallbackStatus === 'IN' ? 'Admitted / منوم' : 'Not Admitted / غير منوم'),
        listType: 'on-list',
        admissionDate: matchingDischargedObj ? (matchingDischargedObj.date || matchingDischargedObj.admissionDate || '') : ''
      };
    });
  }

  return orList.map(p => {
    const vt = String(p.vt || "").toUpperCase().trim();
    const column3 = String(p.column3 || "").toUpperCase().trim();
    const flClassName = String(p.flClassName || "").toUpperCase().trim();
    const postC = String(p.postC || "").toUpperCase().trim();

    const isTaggedOut = vt === "DC" || vt.includes("OUT") || vt.includes("DAY") || vt.includes("DAYCASE") ||
                        column3.includes("OUT") || column3.includes("DC") || 
                        flClassName.includes("OUT") || flClassName.includes("DAY") || flClassName.includes("DAYCASE") ||
                        postC.includes("OUT") || postC.includes("DC");

    const occPatient = findOccupancyPatient(p.patientName, occRows, isTaggedOut, p.mrn, p.surgeonName);
    const matchingDischargedObj = cumulativeDischarged.find(discPt => {
      const matchByName = isNameMatch(p.patientName, discPt.name || "");
      const matchByMrn = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
      return matchByName || matchByMrn;
    });
    const isDischarged = !!matchingDischargedObj;
    const isAdmitted = occPatient || isDischarged;

    const dischargedFromRoom = matchingDischargedObj ? (matchingDischargedObj.room || matchingDischargedObj.id || '') : '';
    const dischargeStatusText = isDischarged
      ? `Discharged (Room ${dischargedFromRoom}) / تم الخروج (غرفة ${dischargedFromRoom})`
      : 'Discharged / تم الخروج';

    return {
      ...p,
      patientName: occPatient ? (occPatient.patientName || p.patientName) : p.patientName,
      realStatus: isAdmitted ? 'IN' : 'OUT',
      isDischarged,
      dischargedFromRoom,
      dischargeStatus: isDischarged ? dischargeStatusText : (occPatient ? 'Currently Admitted / منوم حالياً' : 'Not Admitted / غير منوم'),
      listType: 'on-list',
      admissionDate: occPatient ? occPatient.admissionDate : (matchingDischargedObj ? (matchingDischargedObj.date || matchingDischargedObj.admissionDate || '') : '')
    };
  });
}

app.get('/api/occupancy/data', async (req, res) => {
  try {
    await fetchAndSyncFromFirebaseRTDB();
  } catch (err) {
    console.error('Failed to sync instantly from Firebase RTDB:', err);
  }

  const filterHelper = (list: any[]) => {
    return (list || []).filter(p => {
      const roomVal = p.room || p.colB || "";
      if (isOperatingRoom(roomVal)) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
    });
  };

  const occRowsUnfiltered = hospitalData ? getOccupancyRowsUnfiltered(hospitalData) : [];
  const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
  const enrichedOrList = getEnrichedOrListForStats(cumulativeORList, occRows);

  if (!hospitalData) {
    return res.json({ 
      rows: [], 
      previousRows: [], 
      dischargedRows: filterHelper(cumulativeDischarged),
      entryRows: filterHelper(cumulativeEntries),
      dialysisRows: cumulativeDialysis,
      debtRows: cumulativeDebts,
      insuredDebtRows: cumulativeInsuredDebts,
      medicalPlans: cumulativeMedicalPlans,
      companionStatus: cumulativeCompanionStatus,
      losData: cumulativeLOS,
      vipCasesText: vipCasesText,
      earlyDischargeRoomsText: earlyDischargeRoomsText,
      pendingDischargePatientsText: pendingDischargePatientsText,
      vipCount: 0,
      uploadedAt: uploadedAt,
      hasORList: (cumulativeORList || []).length > 0,
      orListCount: (cumulativeORList || []).length,
      orList: enrichedOrList,
      overList: []
    });
  }

  res.json({ 
    rows: occRowsUnfiltered, 
    previousRows: hospitalData ? getOccupancyRowsUnfiltered(previousHospitalData) : [],
    dischargedRows: filterHelper(cumulativeDischarged),
    entryRows: filterHelper(cumulativeEntries),
    dialysisRows: cumulativeDialysis,
    debtRows: cumulativeDebts,
    insuredDebtRows: cumulativeInsuredDebts,
    medicalPlans: cumulativeMedicalPlans,
    companionStatus: cumulativeCompanionStatus,
    losData: cumulativeLOS,
    vipCasesText: vipCasesText,
    earlyDischargeRoomsText: earlyDischargeRoomsText,
    pendingDischargePatientsText: pendingDischargePatientsText,
    vipCount: getActiveVipCount(),
    uploadedAt: uploadedAt,
    hasORList: (cumulativeORList || []).length > 0,
    orListCount: (cumulativeORList || []).length,
    orList: enrichedOrList,
    overList: getOverListPatients(hospitalData, cumulativeORList)
  });
});

app.get('/api/vip-cases', (req, res) => {
  res.json({ text: vipCasesText });
});

app.all('/api/vip-cases/formatted', (req, res) => {
  const currentText = (req.body && typeof req.body.text === 'string') ? req.body.text : vipCasesText;
  if (!currentText) {
    return res.json({ text: "*Admitted VIP Cases as of " + new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Riyadh' }) + "*\n(No VIP cases in the text box)" });
  }

  function isPatientVipCustom(patientName: string, text: string): boolean {
    if (!patientName || !text) return false;
    
    const pWords = getNormalizedWords(patientName);
    if (pWords.length < 2) return false;

    const vipNamesList = extractVipNames(text);

    for (const name of vipNamesList) {
      const nWords = getNormalizedWords(name);
      if (nWords.length < 2) continue;

      // First name must match (after normalization and stripping)
      if (pWords[0] !== nWords[0]) continue;

      const shorterLen = Math.min(pWords.length, nWords.length);
      const lcsLen = getLcsLength(pWords, nWords);

      // Exact sequential subsequence match: the shorter name's words must fully match with order preserved
      if (lcsLen === shorterLen && lcsLen >= 2) {
        return true;
      }
    }
    return false;
  }

  if (!hospitalData) {
    return res.json({ text: "Please upload data first." });
  }

  const dataRows = getOccupancyRows(hospitalData).slice(3);
  const detectedVips: any[] = [];

  for (const row of dataRows) {
    if (!row) continue;
    const room = String(row[0] || "").trim();
    const name = String(row[1] || "").trim();
    if (!room || !name) continue;
    
    const rowAsString = row.join(" ").toLowerCase();
    const isHeader = room.toLowerCase() === "bed" || room.toLowerCase() === "room" || room === "الغرفة" || name.toLowerCase() === "patient" || name === "المريض";
    const isOR = isOperatingRoom(room);
    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));

    if (!isExcluded && !isHeader && !isOR) {
      if (isPatientVipCustom(name, currentText)) {
        detectedVips.push({
          room: room,
          name: name,
          contractor: String(row[3] || "").trim(),
          admissionDate: String(row[4] || "").trim()
        });
      }
    }
  }

  // Sort VIP cases according to their presence in the occupancy sheets
  detectedVips.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  const day = today.getDate();
  const month = today.getMonth() + 1;
  const year = today.getFullYear();
  const dateStr = `${day}/${month}/${year}`;

  const outputLines = [`*Admitted VIP Cases as of ${dateStr}*`, ""];
  if (detectedVips.length === 0) {
    outputLines.push("No active VIP cases found.");
  } else {
    detectedVips.forEach((vip, idx) => {
      outputLines.push(`${idx + 1}- ${vip.name} | ${vip.room}`);
    });
  }

  const text = outputLines.join("\n");
  res.json({ text });
});

app.post('/api/vip-cases', (req, res) => {
  vipCasesText = req.body.text || "";
  saveData();
  res.json({ success: true, text: vipCasesText });
});

app.get('/api/early-discharge-rooms', (req, res) => {
  res.json({ text: earlyDischargeRoomsText });
});

app.post('/api/early-discharge-rooms', (req, res) => {
  earlyDischargeRoomsText = req.body.text || "";
  saveData();
  res.json({ success: true, text: earlyDischargeRoomsText });
});

app.get('/api/pending-discharge', (req, res) => {
  res.json({ text: pendingDischargePatientsText });
});

app.post('/api/pending-discharge', async (req, res) => {
  const textVal = req.body.text || "";
  pendingDischargePatientsText = textVal;
  
  if (!textVal.trim()) {
    await saveData();
    return res.json({ success: true, text: pendingDischargePatientsText, dischargedCount: 0, unmatched: [] });
  }

  // Parse lines/names to discharge (can be separated by line or commas)
  const namesToDischarge = textVal
    .split(/\n|,/)
    .map((name: string) => name.trim())
    .filter((name: string) => name.length > 0);

  if (namesToDischarge.length === 0) {
    await saveData();
    return res.json({ success: true, text: pendingDischargePatientsText, dischargedCount: 0, unmatched: [] });
  }

  let matchedCount = 0;
  const processedNames: string[] = [];

  // Find start index dynamically matching standard Excel parsing rules
  let startIdx = 3; 
  if (hospitalData) {
    for(let i = 0; i < Math.min(hospitalData.length, 10); i++) {
        const r1 = String(hospitalData[i][1] || "").toLowerCase();
        const r3 = String(hospitalData[i][3] || "").toLowerCase();
        if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name" || r1 === "غرفة")) {
            startIdx = i + 1;
            break;
        }
    }
  }

  if (hospitalData && hospitalData.length > startIdx) {
    const headerPrefix = hospitalData.slice(0, startIdx);
    const bodyRows = hospitalData.slice(startIdx);
    const remainingRows = [];
    
    for (const row of bodyRows) {
      const patientName = String(row[3] || "").trim();
      if (!patientName) {
        remainingRows.push(row);
        continue;
      }
      
      const foundMatchIdx = namesToDischarge.findIndex(n => isNameMatch(n, patientName));
      
      if (foundMatchIdx !== -1) {
        matchedCount++;
        const matchedInputName = namesToDischarge[foundMatchIdx];
        processedNames.push(matchedInputName);

        const roomVal = String(row[1] || "").trim();
        const docVal = String(row[22] || "").trim();
        const contVal = String(row[12] || "").trim();
        const dateVal = cleanAdmissionDateStr(row[0]);
        
        const discObj = {
          room: roomVal,
          name: patientName,
          physician: docVal,
          contractor: contVal,
          date: dateVal
        };
        
        if (!cumulativeDischarged.some(p => isNameMatch(p.name, patientName))) {
          cumulativeDischarged.push(discObj);
        }

        if (!manuallyDischargedNames.includes(patientName)) {
          manuallyDischargedNames.push(patientName);
        }
        
        // Remove from other sheets
        cumulativeLOS = (cumulativeLOS || []).filter(p => !isNameMatch(p.colD, patientName));
        cumulativeDialysis = (cumulativeDialysis || []).filter(p => !p.name || !isNameMatch(p.name, patientName));
        cumulativeDebts = (cumulativeDebts || []).filter(p => !p.colD || !isNameMatch(p.colD, patientName));
        cumulativeInsuredDebts = (cumulativeInsuredDebts || []).filter(p => !p.colD || !isNameMatch(p.colD, patientName));
        cumulativeMedicalPlans = (cumulativeMedicalPlans || []).filter(p => !p.colD || !isNameMatch(p.colD, patientName));
        cumulativeCompanionStatus = (cumulativeCompanionStatus || []).filter(p => !p.colD || !isNameMatch(p.colD, patientName));
      } else {
        remainingRows.push(row);
      }
    }
    
    hospitalData = [...headerPrefix, ...remainingRows];
  }

  const lowercaseProcessed = processedNames.map(n => n.toLowerCase());
  const remainingInputNames = namesToDischarge.filter(n => !lowercaseProcessed.includes(n.toLowerCase()));
  
  // Reconstruct textbox with remaining/unmatched names so user has immediate feedback! 
  pendingDischargePatientsText = remainingInputNames.join("\n");

  await saveData();

  res.json({
    success: true,
    text: pendingDischargePatientsText,
    dischargedCount: matchedCount,
    dischargedNames: processedNames,
    unmatched: remainingInputNames
  });
});

app.post('/api/restore-patient', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Patient name is required to restore." });
    }

    console.log(`[RESTORE] Attempting to restore patient: "${name}"`);

    // Remove from manuallyDischargedNames
    manuallyDischargedNames = (manuallyDischargedNames || []).filter(mName => !isNameMatch(mName, name));

    // Remove from cumulativeDischarged
    cumulativeDischarged = (cumulativeDischarged || []).filter(item => {
      const itemName = item.name || item.colD || "";
      return !isNameMatch(itemName, name);
    });

    await saveData();

    // Re-trigger RTDB sync to restore them immediately to actual hospital memory mapping
    await fetchAndSyncFromFirebaseRTDB();

    res.json({
      success: true,
      message: `Patient ${name} has been successfully restored to active patient sheets.`,
      manuallyDischargedNames,
      dischargedCount: cumulativeDischarged.length
    });
  } catch (err: any) {
    console.error("Error in /api/restore-patient:", err);
    res.status(500).json({ error: err.message || "Failed to restore patient" });
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: true }); // Bypass auth for local mode
});

app.post('/api/reset', async (req, res) => {
  console.log('Reset request received');
  hospitalData = null;
  previousHospitalData = null;
  // Keep discharged patients in OR-x rooms (overlist patients)
  cumulativeDischarged = (cumulativeDischarged || []).filter(p => isOrXRoom(p.room));
  cumulativeEntries = [];
  cumulativeDialysis = [];
  cumulativeDebts = [];
  cumulativeInsuredDebts = [];
  cumulativeMedicalPlans = [];
  cumulativeCompanionStatus = [];
  cumulativeLOS = [];
  pendingDischargePatientsText = "";
  manuallyDischargedNames = [];
  try {
    await saveData();
    res.json({ success: true, message: 'Data reset successfully.' });
  } catch (err: any) {
    console.error('Failed to save reset data:', err);
    res.status(500).json({ error: 'Failed to reset data: ' + err.message });
  }
});

app.post('/api/reset-vip', async (req, res) => {
  console.log('Reset VIP cases requested');
  vipCasesText = "";
  try {
    await saveData();
    res.json({ success: true, message: 'VIP cases reset successfully.' });
  } catch (err: any) {
    console.error('Failed to reset VIP cases:', err);
    res.status(500).json({ error: 'Failed to reset VIP cases: ' + err.message });
  }
});

app.post('/api/reset-or', async (req, res) => {
  console.log('Reset OR list requested');
  cumulativeORList = [];
  // Clear discharged overlist patients as part of manual OR reset
  cumulativeDischarged = (cumulativeDischarged || []).filter(p => !isOrXRoom(p.room));
  try {
    await saveData();
    res.json({ success: true, message: 'OR list and overlist data reset successfully.' });
  } catch (err: any) {
    console.error('Failed to reset OR list data:', err);
    res.status(500).json({ error: 'Failed to reset OR list data: ' + err.message });
  }
});

app.post('/api/or-list/sync', async (req, res) => {
  console.log('Manual OR dashboard sync with occupancy requested');
  try {
    try {
      await fetchAndSyncFromFirebaseRTDB();
    } catch (firebaseErr) {
      console.error('Non-blocking Firebase sync failure during manual OR sync:', firebaseErr);
    }

    const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
    const enrichedOrList = getEnrichedOrListForStats(cumulativeORList, occRows);

    const total = (cumulativeORList || []).length;
    const matched = enrichedOrList.filter(p => p.realStatus === 'IN').length;
    const outpatients = enrichedOrList.filter(p => p.realStatus === 'OUT').length;

    res.json({
      success: true,
      total,
      matched,
      outpatients,
      orList: enrichedOrList,
      overList: getOverListPatients(hospitalData, cumulativeORList),
      uploadedAt: uploadedAt
    });
  } catch (err: any) {
    console.error('Failed to manually sync OR with occupancy:', err);
    res.status(500).json({ error: 'Failed to sync: ' + err.message });
  }
});

// Simulation Endpoints for Workflows
app.post('/api/workflows/:type', (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Upload data first' });
  setTimeout(() => {
    res.json({ success: true, message: `Workflow ${req.params.type} processed locally.` });
  }, 1000);
});

app.get('/api/reports/unified', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No data available. Please upload a sheet first.' });

  try {
    const workbook = new ExcelJS.Workbook();
    const sheetConfigs = [
      { name: 'اشغال', title: 'الأشغال' },
      { name: 'دخول', title: 'دخول' },
      { name: 'خروج', title: 'خروج' }
    ];

    for (const config of sheetConfigs) {
      const sheet = workbook.addWorksheet(config.name, {
        views: [{ rightToLeft: false }] 
      });

      // Title row
      sheet.mergeCells('A1:G1');
      const titleCell = sheet.getCell('A1');
      titleCell.value = config.title;
      titleCell.font = { size: 16, bold: true, name: 'Calibri' };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

      // Headers
      const headerLabels = ['#', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'تاريخ الحجز', 'الحالة'];
      const headerRow = sheet.addRow(headerLabels);
      headerRow.height = 25;
      headerRow.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE0E0E0' }
        };
        cell.font = { bold: true, size: 11 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });

      // Rows
      // Match Apps Script: start at row 4 (index 3)
      const dataRows = getOccupancyRows(hospitalData).slice(3);
      let rowCount = 1;

      dataRows.forEach((row: any) => {
        const room = String(row[0] || "").trim();       // Column A
        const patient = String(row[1] || "").trim();   // Column B
        const physician = String(row[2] || "").trim(); // Column C
        const contractor = String(row[3] || "").trim();// Column D
        const date = String(row[4] || "").trim();      // Column E

        if (!patient && room && !isNaN(parseInt(room.match(/\d+/)?.[0] || ""))) {
          return; 
        }
        
        const rowString = [room, patient, physician, contractor, date].join(" ").toLowerCase();
        if (KEYWORDS_TO_EXCLUDE.some(kw => rowString.includes(kw))) {
          return;
        }

        if (room && !patient) {
          // Grouping Row
          const groupRow = sheet.addRow(['', room, '', '', '', '', '']);
          sheet.mergeCells(`B${groupRow.number}:G${groupRow.number}`);
          const groupCell = groupRow.getCell(2);
          groupCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFDDEBF7' }
          };
          groupCell.font = { bold: true, size: 12 };
          groupCell.alignment = { horizontal: 'left', vertical: 'middle' };
          groupRow.height = 20;
        } else if (patient) {
          // Patient Row
          const pValues = [
            rowCount++,
            room,      // Bed
            patient,   // Patient
            physician, // Physician
            contractor,// Contractor
            date,      // Date
            ''         // Status
          ];
          const pRow = sheet.addRow(pValues);
          pRow.eachCell(cell => {
            cell.border = {
              top: { style: 'thin' },
              left: { style: 'thin' },
              bottom: { style: 'thin' },
              right: { style: 'thin' }
            };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            // Ensure type is text unless it's the index
            const colIndex = cell.fullAddress.col;
            if (colIndex > 1) {
              // Values are already strings, no need to manually set read-only cell.type
            }
          });
        }
      });

      // Column widths
      sheet.getColumn(1).width = 5;
      sheet.getColumn(2).width = 15;
      sheet.getColumn(3).width = 30;
      sheet.getColumn(4).width = 30;
      sheet.getColumn(5).width = 25;
      sheet.getColumn(6).width = 20;
      sheet.getColumn(7).width = 15;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Hospital_Unified_Report.xlsx');

    await workbook.xlsx.write(res);

  } catch (error: any) {
    console.error('Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.get('/api/reports/occupancy_formatted', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No data available. Please upload a sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addOccupancySheet(workbook, getOccupancyRows(hospitalData));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Formatted_Occupancy.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Report Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

app.get('/api/reports/preview_occupancy_formatted', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No data available. Please upload a sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addGridOccupancySheet(workbook, getOccupancyRows(hospitalData));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Colored_Structured_Grid_Occupancy.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Grid Report Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

// Custom Header Background API Group
app.post('/api/upload-header-background', upload.single('file'), (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }
    // Validate image mimetype
    const fileMime = String(req.file.mimetype || '').toLowerCase();
    if (!fileMime.startsWith('image/')) {
      return res.status(400).json({ error: 'Uploaded file must be a valid image' });
    }
    
    // Select correct saving extension based on filename or mime
    const originalName = String(req.file.originalname || '').toLowerCase();
    let savePath = path.join(process.cwd(), 'header_bg.png');
    
    if (originalName.endsWith('.jpg') || originalName.endsWith('.jpeg') || fileMime.includes('jpeg')) {
      savePath = path.join(process.cwd(), 'header_bg.jpg');
    }

    // Clean up any old backgrounds to avoid conflicting helper resolution
    try {
      const filesToClean = [
        path.join(process.cwd(), 'header_bg.png'),
        path.join(process.cwd(), 'header_bg.jpg'),
        path.join(process.cwd(), 'header_bg.jpeg'),
        path.join(__dirname, 'header_bg.png'),
        path.join(__dirname, 'header_bg.jpg'),
        path.join(__dirname, 'header_bg.jpeg'),
      ];
      for (const f of filesToClean) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch (_) {}

    try { fs.writeFileSync(savePath, req.file.buffer);
    console.log('Saved custom header background image to:', savePath); } catch (e) { console.error('Failed to save header bg image (might be read-only env)', e); }
    res.json({ success: true, message: 'Header background uploaded successfully' });
  } catch (error: any) {
    console.error('Header background upload error:', error);
    res.status(500).json({ error: 'Failed to upload header background' });
  }
});

app.get('/api/header-background', (req, res) => {
  const customBg = getCustomHeaderBgInfo();
  if (customBg && fs.existsSync(customBg.path)) {
    // Set caching or non-caching headers so live update reflects instantly
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(customBg.path);
  } else {
    res.status(404).json({ error: 'No custom header background uploaded' });
  }
});

app.get('/api/header-background-info', (req, res) => {
  const customBg = getCustomHeaderBgInfo();
  res.json({ exists: !!customBg });
});

app.delete('/api/header-background', (req, res) => {
  try {
    let deletedCount = 0;
    const paths = [
      path.join(process.cwd(), 'header_bg.png'),
      path.join(process.cwd(), 'header_bg.jpg'),
      path.join(process.cwd(), 'header_bg.jpeg'),
      path.join(__dirname, 'header_bg.png'),
      path.join(__dirname, 'header_bg.jpg'),
      path.join(__dirname, 'header_bg.jpeg'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      res.json({ success: true, message: 'Header background reset successfully' });
    } else {
      res.status(404).json({ error: 'No custom header background to reset' });
    }
  } catch (error: any) {
    console.error('Error deleting header background:', error);
    res.status(500).json({ error: 'Failed to reset header background' });
  }
});


app.get('/api/debug-logo-status', (req, res) => {
  const processCwd = process.cwd();
  const dirnameVal = __dirname;
  
  const filesToCheck = [
    'elite_logo.png',
    'elite_logo_transparent.png',
    'hospital_data.json'
  ];
  
  const results = filesToCheck.map(filename => {
    const cwdPath = path.resolve(processCwd, filename);
    const dirPath = path.resolve(dirnameVal, filename);
    
    let cwdExists = false;
    let cwdSize = -1;
    try {
      cwdExists = fs.existsSync(cwdPath);
      if (cwdExists) {
        cwdSize = fs.statSync(cwdPath).size;
      }
    } catch (e: any) {
      console.error(e);
    }
    
    let dirExists = false;
    let dirSize = -1;
    try {
      dirExists = fs.existsSync(dirPath);
      if (dirExists) {
        dirSize = fs.statSync(dirPath).size;
      }
    } catch (e: any) {
      console.error(e);
    }
    
    return {
      filename,
      cwdPath,
      cwdExists,
      cwdSize,
      dirPath,
      dirExists,
      dirSize
    };
  });
  
  res.json({
    processCwd,
    dirnameVal,
    results
  });
});


app.get('/api/elite-logo', (req, res) => {
  const logoPath = path.resolve(process.cwd(), 'elite_logo.png');
  const dirLogoPath = path.resolve(__dirname, 'elite_logo.png');
  console.log(`[Logo Debug] elite-logo requested. Process.cwd path: ${logoPath} (exists: ${fs.existsSync(logoPath)}), __dirname path: ${dirLogoPath} (exists: ${fs.existsSync(dirLogoPath)})`);
  
  if (fs.existsSync(logoPath)) {
    return res.sendFile(logoPath);
  } else if (fs.existsSync(dirLogoPath)) {
    return res.sendFile(dirLogoPath);
  } else {
    return res.status(404).json({ 
      error: 'Elite logo not found', 
      paths: { logoPath, dirLogoPath, exists: [fs.existsSync(logoPath), fs.existsSync(dirLogoPath)] } 
    });
  }
});


app.get('/api/elite-logo-transparent', (req, res) => {
  const logoPath = path.resolve(process.cwd(), 'elite_logo_transparent.png');
  const dirLogoPath = path.resolve(__dirname, 'elite_logo_transparent.png');
  console.log(`[Logo Debug] elite-logo-transparent requested. Process.cwd path: ${logoPath} (exists: ${fs.existsSync(logoPath)}), __dirname path: ${dirLogoPath} (exists: ${fs.existsSync(dirLogoPath)})`);
  
  if (fs.existsSync(logoPath)) {
    return res.sendFile(logoPath);
  } else if (fs.existsSync(dirLogoPath)) {
    return res.sendFile(dirLogoPath);
  } else {
    // try fallback to elite_logo
    console.log('[Logo Debug] elite-logo-transparent not found, trying fallback to elite_logo');
    const alternativeLogoPath = path.resolve(process.cwd(), 'elite_logo.png');
    const alternativeDirLogoPath = path.resolve(__dirname, 'elite_logo.png');
    if (fs.existsSync(alternativeLogoPath)) {
      return res.sendFile(alternativeLogoPath);
    } else if (fs.existsSync(alternativeDirLogoPath)) {
      return res.sendFile(alternativeDirLogoPath);
    } else {
      return res.status(404).json({ 
        error: 'Elite logo transparent and fallback not found',
        paths: { logoPath, dirLogoPath, alternativeLogoPath, alternativeDirLogoPath }
      });
    }
  }
});


app.get('/api/reports/entry_formatted', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No data available. Please upload a sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addEntrySheet(workbook, cumulativeEntries);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Formatted_Entry.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Report Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

app.get('/api/reports/dialysis_formatted', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addDialysisSheet(workbook, cumulativeDialysis);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Formatted_Dialysis.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Dialysis Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/debts_formatted', async (req, res) => {
  if (cumulativeDebts.length === 0) return res.status(400).json({ error: 'No debts data available. Please upload the debts source sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addDebtsSheet(workbook, cumulativeDebts);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Formatted_Debts.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Debts Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/insured_debts_formatted', async (req, res) => {
  if (cumulativeInsuredDebts.length === 0) return res.status(400).json({ error: 'No insured debts data available. Please upload the debts source sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addRefinedInsuredDebtsSheet(workbook, cumulativeInsuredDebts);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Formatted_Insured_Debts.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Insured Debts Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/insured_non_cash_formatted', async (req, res) => {
  if (!hospitalData || hospitalData.length === 0) return res.status(400).json({ error: 'No occupancy data available. Please upload the source sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addInsuredNonCashOccupancySheet(workbook, hospitalData);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Insured_Non_Cash_Patients.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Insured Non-Cash Patients Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

function getMedicalPlanGroup(p: any) {
  const roomStr = String(p.colB || "").toUpperCase();
  const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
  if (roomStr.includes("PICU")) return "PICU";
  if (roomStr.includes("NICU")) return "NICU";
  if (roomStr.includes("CCU")) return "CCU";
  if (roomStr.includes("SICU")) return "SICU";
  if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) return "VIP";
  if (roomStr.includes("ICU")) return "ICU";
  if (roomNum >= 101 && roomNum <= 108) return "101-108";
  if (roomNum >= 301 && roomNum <= 319) return "301-319";
  if (roomNum >= 320 && roomNum <= 329) return "320-329";
  if (roomNum >= 401 && roomNum <= 422) return "401-422";
  if (!isNaN(roomNum) && roomNum > 0) return "Floor " + Math.floor(roomNum / 100); 
  return "Others";
}

function createSingleMedicalPlanSheet(workbook: ExcelJS.Workbook, sheetName: string, plans: any[], bgColor: string = 'FFB3E5FC') {
  (workbook as any).isMedicalPlans = true;
  // Excel sheet names must be less than 31 chars and no special chars
  const sanitizedName = sheetName.substring(0, 31).replace(/[\[\]\*\?\/\\]/g, "");
  const sheet = workbook.addWorksheet(sanitizedName, {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `تطورات الحالات المنومة - ${sheetName}`;
  titleCell.font = { size: 22, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  const headerLabels = ['#', 'تاريخ الدخول / Admission Date', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'تاريخ التحديث الطبي', 'الخطة الطبية (SBAR)'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 35;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 14, color: { argb: 'FF000000' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }; 
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  plans.forEach((p, index) => {
    // SBAR data exactly from source is in colAH (no rewriting)
    const rowValues = [index + 1, cleanAdmissionDateStr(p.colA), p.colB, p.colD, p.colW, p.colM, p.colAG || "", p.colAH];
    const pRow = sheet.addRow(rowValues);
    
    // Alternating background logic: White then Header Color
    const rowBgColor = (index % 2 === 1) ? bgColor : 'FFFFFFFF';

    pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBgColor } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
        right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
      };
      if (colNumber === 8) {
        cell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      } else {
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      }
      cell.font = { name: 'Arial', size: 11 };
    });
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
  sheet.getColumn(7).width = 20;
  sheet.getColumn(8).width = 80;
}

app.post('/api/reports/medical_plans_formatted', async (req, res) => {
  const { plans } = req.body;
  const plansToUse = plans || cumulativeMedicalPlans;
  
  if (plansToUse.length === 0) return res.status(400).json({ error: 'No medical plans data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    
    // 1. Sort plans
    const sortedPlans = [...plansToUse].sort((a, b) => {
      const roomA = String(a.colB || "").toUpperCase();
      const roomB = String(b.colB || "").toUpperCase();
      const getRank = (str: string) => {
        if (str.includes("PICU")) return 6;
        if (str.includes("NICU")) return 5;
        if (str.includes("CCU")) return 4;
        if (str.includes("SICU")) return 3;
        if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
        if (str.includes("ICU")) return 1;
        return 10;
      };
      const rankA = getRank(roomA);
      const rankB = getRank(roomB);
      if (rankA !== rankB) return rankA - rankB;
      const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
      const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
      if (numA !== numB) return numA - numB;
      return roomA.localeCompare(roomB);
    });

    // 2. Group by department
    const groups: { [key: string]: any[] } = {};
    sortedPlans.forEach(p => {
      const groupName = getMedicalPlanGroup(p);
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(p);
    });

    // 3. Create sheets with different background colors
    const groupColors: { [key: string]: string } = {
      "ICU": "FFE1F5FE",   // Light Blue
      "VIP": "FFF3E5F5",   // Light Purple
      "SICU": "FFE8F5E9",  // Light Green
      "CCU": "FFFFF3E0",   // Light Orange
      "NICU": "FFFCE4EC",  // Light Pink
      "PICU": "FFFAFAFA",  // Very Light Grey
      "101-108": "FFE0F2F1", // Light Teal
      "301-319": "FFEDE7F6", // Deep Purple Light
      "320-329": "FFF9FBE7", // Lime Light
      "401-422": "EFEBE9"    // Brown Light
    };

    // Logical sorting of groups
    const groupNames = Object.keys(groups).sort((a, b) => {
      const order = ["ICU", "VIP", "SICU", "CCU", "NICU", "PICU"];
      const idxA = order.indexOf(a);
      const idxB = order.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

    const isRefined = req.query.refined === 'true' || req.body.refined === true;
    if (isRefined) {
      for (const name of groupNames) {
        const color = groupColors[name] || 'FFB3E5FC';
        await createSingleMedicalPlanSheetRefined(workbook, name, groups[name], color);
      }
    } else {
      groupNames.forEach(name => {
        const color = groupColors[name] || 'FFB3E5FC';
        createSingleMedicalPlanSheet(workbook, name, groups[name], color);
      });
    }

    const filename = isRefined ? 'Medical_Plans_MultiSheet_Refined.xlsx' : 'Medical_Plans_MultiSheet.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Medical Plans Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.post('/api/reports/vip_cases_medical_updates', async (req, res) => {
  const { plans } = req.body;
  const plansToUse = plans || cumulativeMedicalPlans;
  
  if (plansToUse.length === 0) {
    return res.status(400).json({ error: 'No medical plans data available. Please upload the debts source sheet first.' });
  }

  // Filter STRICTLY to VIP Patients matching the text box input
  const vipPlans = plansToUse.filter((p: any) => {
    return isPatientVip(p.colD);
  });

  if (vipPlans.length === 0) {
    return res.status(400).json({ error: 'No VIP cases matching the text box input were found.' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    
    // Sort plans
    const sortedPlans = [...vipPlans].sort((a: any, b: any) => {
      const roomA = String(a.colB || "").toUpperCase();
      const roomB = String(b.colB || "").toUpperCase();
      const getRank = (str: string) => {
        if (str.includes("PICU")) return 6;
        if (str.includes("NICU")) return 5;
        if (str.includes("CCU")) return 4;
        if (str.includes("SICU")) return 3;
        if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
        if (str.includes("ICU")) return 1;
        return 10;
      };
      const rankA = getRank(roomA);
      const rankB = getRank(roomB);
      if (rankA !== rankB) return rankA - rankB;
      const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
      const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
      if (numA !== numB) return numA - numB;
      return roomA.localeCompare(roomB);
    });

    // Create a single sheet with no sub sheets, styled beautifully
    await createSingleMedicalPlanSheetRefined(workbook, "VIP Cases Medical Updates", sortedPlans, 'FFF3E5F5');

    const filename = `VIP_Cases_Medical_Updates_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('VIP Cases Medical Updates Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


function getAccommodationCategory(roomStr: string): string {
  if (!roomStr) return "غير مصنف";
  
  let r = roomStr.toUpperCase()
    .replace(/ROOM/g, "")
    .replace(/BED/g, "")
    .replace(/الغرفة/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Zone C mapping
  if (r.startsWith("330 A") || r.startsWith("330-A") || r.startsWith("330A") || 
      r.startsWith("331 A") || r.startsWith("331-A") || r.startsWith("331A") || 
      r.startsWith("330 B") || r.startsWith("330-B") || r.startsWith("330B") || 
      r.startsWith("331 B") || r.startsWith("331-B") || r.startsWith("331B")) {
    return "مميز جنوبي";
  }
  if (r.startsWith("330") || r.startsWith("331")) {
    return "امبريال سويت";
  }
  if (r.startsWith("332")) {
    return "رويال سويت";
  }

  // Specific override for rooms 101-107
  const match10 = r.match(/^10([1-7])(?:\s*-\s*([12]))?$/);
  if (match10) {
    const x = match10[1]; // "1", "2", "3", "4", "5", "6", "7"
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

  // Day case beds on the first floor
  if (r.match(/^10[1-7]\s*-\s*[12]$/) || r.includes("DAYCASE") || r.includes("DAY CASE")) {
    return "Day Case";
  }

  // 4th floor flexible suites (401 to 405)
  // 401 A to 405 B are "مميز شمالي"
  if (r.match(/^40[1-5]\s*[AB]$/) || r.match(/^40[1-5]-[AB]$/)) {
    return "مميز شمالي";
  }
  // 401 to 405 as whole rooms are "رويال سويت"
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

async function addGridOccupancyWithAccommodationSheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Inpatient Floor & Accomm', {
    views: [{ rightToLeft: false }] 
  });

  const COMPANION_EXCLUDED_DEPTS = ["ICU", "PICU", "NICU", "CCU", "SICU", "VIP ISOLATION", "VIP ICU", "VIP CCU"];

  let processedData = data.slice(3)
    .map(row => ({
      room: String(row[0] || "").trim(),
      name: String(row[1] || "").trim(),
      physician: String(row[2] || "").trim(),
      contractor: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
    }))
    .filter(p => {
      if (!p.room || !p.name) return false;
      const roomUpper = p.room.toUpperCase();
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      
      // Exclude closed units
      const isClosedUnit = COMPANION_EXCLUDED_DEPTS.some(dept => roomUpper.includes(dept));

      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR && !isClosedUnit;
    });

  processedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("VIP")) return 1;
      return 5;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  const customBg = getCustomHeaderBgInfo();
  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  let bgBuffer: Buffer | null = null;
  
  if (customBg && fs.existsSync(customBg.path) && fs.statSync(customBg.path).size > 0) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <rect x="220" y="30" width="760" height="120" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.12" />
          <text x="600" y="85" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="bold" fill="#000000" text-anchor="middle">إشغال المرضى المنومين حسب الطابق والدرجة</text>
          <text x="600" y="125" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="20" fill="#333333" text-anchor="middle">Inpatient Occupancy by Floor &amp; Accommodation</text>
        </svg>
      `;
      bgBuffer = await sharp(customBg.path)
        .resize(1200, 180, { fit: 'fill' })
        .composite([{
          input: Buffer.from(svgText),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();
    } catch (sharpErr) {
      console.error('Error compositing textbox on custom background:', sharpErr);
    }
  }

  if (!bgBuffer) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <rect width="1200" height="180" fill="#EBF3F5" />
          <rect x="220" y="30" width="760" height="120" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.18" />
          <text x="600" y="85" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="bold" fill="#000000" text-anchor="middle">إشغال المرضى المنومين حسب الطابق والدرجة</text>
          <text x="600" y="125" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="20" fill="#333333" text-anchor="middle">Inpatient Occupancy by Floor &amp; Accommodation</text>
        </svg>
      `;
      bgBuffer = await sharp(Buffer.from(svgText))
        .png()
        .toBuffer();
    } catch (sharpFallbackErr) {
      console.error('Error generating fallback header:', sharpFallbackErr);
    }
  }

  if (bgBuffer) {
    try {
      const bgId = workbook.addImage({
        buffer: bgBuffer,
        extension: 'png',
      });
      sheet.addImage(bgId, {
        tl: { col: 0, row: 0 } as any,
        br: { col: 8, row: 1 } as any,
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error('Error adding header background image:', err);
    }
  }

  const headerLabels = ['# / الرقم', 'Room / الغرفة', 'درجة الإقامة', 'Patient / اسم المريض', 'Physician / الطبيب المعالج', 'Contract / التعاقد', 'Booking Date / تاريخ الحجز', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } };
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  const groupedItems: { groupName: string, items: any[] }[] = [];
  processedData.forEach(p => {
    const roomStr = p.room.toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let groupName = "OTHER"; 
    
    if (roomStr.includes("VIP")) groupName = "VIP Floor"; 
    else if (roomNum >= 101 && roomNum <= 108) groupName = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) groupName = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) groupName = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) groupName = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) groupName = "4th Floor";
    else if (!isNaN(roomNum) && roomNum > 0) groupName = "Floor " + Math.floor(roomNum / 100);

    let existing = groupedItems.find(g => g.groupName === groupName);
    if (!existing) {
      existing = { groupName, items: [] };
      groupedItems.push(existing);
    }
    existing.items.push(p);
  });

  let serial = 1;

  groupedItems.forEach(group => {
    const rColors = getGroupColors(group.groupName);
    
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '', '', '']); 
    sheet.mergeCells(startRow, 1, startRow, 8);
    const separatorCell = sheet.getCell(startRow, 1);
    separatorCell.value = `■  ${group.groupName}  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    group.items.forEach((p) => {
      const category = getAccommodationCategory(p.room);
      const rowValues = [serial++, p.room, category, p.name, p.physician, p.contractor, p.date, isPatientVip(p.name) ? "VIP" : ""];
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell((cell, colNumber) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        
        if (colNumber === 1 || colNumber === 2 || colNumber === 3 || colNumber === 4) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
        if (colNumber === 3) {
          const catColors: { [key: string]: string } = {
            "Day Case": "FF5C5A7F",
            "اقتصادي": "FFE65100",
            "مميز شمالي": "FF006064",
            "مميز جنوبي": "FF0D47A1",
            "أولي عاديه": "FF3E2723",
            "جونيور سويت": "FF4A148C",
            "امبريال سويت": "FFD81B60",
            "رويال سويت": "FF880E4F",
            "بانوراما": "FF1B5E20"
          };
          const colorHex = catColors[category];
          if (colorHex) {
            cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: colorHex } };
          }
        }
        if (colNumber === 8) {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } };
        }
      });
    });
  });

  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 16;
  sheet.getColumn(3).width = 22;
  sheet.getColumn(4).width = 32;
  sheet.getColumn(5).width = 28;
  sheet.getColumn(6).width = 25;
  sheet.getColumn(7).width = 20;
  sheet.getColumn(8).width = 15;
}

async function addVacantRoomsByCategorySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('الغرف الشاغرة حسب الدرجة', {
    views: [{ rightToLeft: false }] 
  });

  const occupiedRooms = new Set<string>();
  if (data) {
    data.slice(3).forEach(row => {
      const roomStr = String(row[0] || "").trim();
      const norm = normalizeRoom(roomStr);
      if (norm) {
        occupiedRooms.add(norm);
      }
    });
  }

  const FIRST_FLOOR_BEDS = [
    "101 - 1", "101 - 2",
    "104 - 1", "104 - 2",
    "105 - 1", "105 - 2"
  ];

  const MENTIONED_ROOMS = [
    "102", "103", "106", "107",
    "301", "302", "303", "304", "305", "401 A", "401 B", "402 A", "402 B", "403 A", "403 B", "404 A", "404 B", "405 A", "405 B",
    "315", "316", "317", "320", "321", "322", "323", "324", "325", "326", "327",
    "415", "416", "417", "418", "419", "420", "421", "422",
    "307", "308", "318", "319", "328", "329", "406", "407", "409", "410", "411",
    "309", "310", "311", "312", "313", "314", "412", "413", "414",
    "408",
    "306",
    ...FIRST_FLOOR_BEDS
  ];

  const vacantRoomsRaw: string[] = [];

  MENTIONED_ROOMS.forEach(room => {
    // Check if the room has an A/B variant (using regex on the room label, e.g. "401 A" or "402 B")
    const match = room.match(/^(40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1]; // "401", "402", "403", "404", "405"
      const variant = match[2]; // "A" or "B"
      
      const isBaseOccupied = occupiedRooms.has(base);
      const isAOccupied = occupiedRooms.has(`${base}A`);
      const isBOccupied = occupiedRooms.has(`${base}B`);
      
      if (!isBaseOccupied) {
        if (variant === 'A' && !isAOccupied) {
          vacantRoomsRaw.push(room);
        } else if (variant === 'B' && !isBOccupied) {
          vacantRoomsRaw.push(room);
        }
      }
    } else {
      // For any other normal room
      const norm = normalizeRoom(room);
      if (!occupiedRooms.has(norm)) {
        vacantRoomsRaw.push(room);
      }
    }
  });

  // Now, group 401-405 A/B rooms if both are empty, exactly like in the client
  const emptyRoomsSet = new Set(vacantRoomsRaw);
  const vacantRooms: string[] = [];
  const processedBases = new Set<string>();

  vacantRoomsRaw.forEach(room => {
    const match = room.match(/^(40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1];
      if (emptyRoomsSet.has(`${base} A`) && emptyRoomsSet.has(`${base} B`)) {
        if (!processedBases.has(base)) {
          vacantRooms.push(base);
          processedBases.add(base);
        }
      } else {
        vacantRooms.push(room);
      }
    } else {
      vacantRooms.push(room);
    }
  });

  // اولى عادية ثم مميز جنوبي ثم مميز شمالي ثم جونيور سويت ثم امبريال سويت ثم رويال سويت ثم بانوراما ثم غير مصنف
  const categoriesList = ["أولي عاديه", "جونيور سويت", "مميز جنوبي", "مميز شمالي", "امبريال سويت", "رويال سويت", "بانوراما", "Day Case"];
  const groupedVacant: { [key: string]: string[] } = {
    "أولي عاديه": [],
    "جونيور سويت": [],
    "مميز جنوبي": [],
    "مميز شمالي": [],
    "امبريال سويت": [],
    "رويال سويت": [],
    "بانوراما": [],
    "Day Case": []
  };

  vacantRooms.forEach(room => {
    if (FIRST_FLOOR_BEDS.includes(room)) {
      groupedVacant["Day Case"].push(room);
    } else {
      const cat = getAccommodationCategory(room);
      if (cat !== "اقتصادي" && groupedVacant[cat]) {
        groupedVacant[cat].push(room);
      }
    }
  });

  sheet.mergeCells('A1:C1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  let bgBuffer: Buffer | null = null;
  const customBg = getCustomHeaderBgInfo();
  if (customBg && fs.existsSync(customBg.path) && fs.statSync(customBg.path).size > 0) {
    try {
      const svgText = `
        <svg width="600" height="180" viewBox="0 0 600 180">
          <rect x="120" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.12" />
          <text x="300" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="bold" fill="#000000" text-anchor="middle">الغرف الشاغرة حسب الدرجة</text>
        </svg>
      `;
      bgBuffer = await sharp(customBg.path)
        .resize(600, 180, { fit: 'fill' })
        .composite([{
          input: Buffer.from(svgText),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();
    } catch (sharpErr) {
      console.error('Error generating vacant custom header:', sharpErr);
    }
  }

  if (!bgBuffer) {
    try {
      const svgText = `
        <svg width="600" height="180" viewBox="0 0 600 180">
          <rect width="600" height="180" fill="#E8F5E9" />
          <rect x="120" y="45" width="360" height="90" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.22" />
          <text x="300" y="105" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="bold" fill="#000000" text-anchor="middle">الغرف الشاغرة حسب الدرجة</text>
        </svg>
      `;
      bgBuffer = await sharp(Buffer.from(svgText))
        .png()
        .toBuffer();
    } catch (err) {
      console.error(err);
    }
  }

  if (bgBuffer) {
    try {
      const bgId = workbook.addImage({
        buffer: bgBuffer,
        extension: 'png',
      });
      sheet.addImage(bgId, {
        tl: { col: 0, row: 0 } as any,
        br: { col: 3, row: 1 } as any,
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error('Error adding header background image:', err);
    }
  }

  const headerRow = sheet.addRow(['#', 'رقم الغرفة / Room Number', 'درجة الإقامة / Accommodation Category']);
  headerRow.height = 25;
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B5E20' } };
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const categoryColors: { [key: string]: { badge: string, row: string } } = {
    "أولي عاديه": { badge: 'FF3E2723', row: 'FFEFEBE9' },
    "أولي عادية": { badge: 'FF3E2723', row: 'FFEFEBE9' },
    "أولى عادية": { badge: 'FF3E2723', row: 'FFEFEBE9' },
    "مميز جنوبي": { badge: 'FF0D47A1', row: 'FFE3F2FD' },
    "مميز شمالي": { badge: 'FF006064', row: 'FFE0F7FA' },
    "جونيور سويت": { badge: 'FF4A148C', row: 'FFF3E5F5' },
    "امبريال سويت": { badge: 'FFD81B60', row: 'FFF8BBD0' },
    "رويال سويت": { badge: 'FF880E4F', row: 'FFFCE4EC' },
    "بانوراما": { badge: 'FF1B5E20', row: 'FFE8F5E9' },
    "Day Case": { badge: 'FF607D8B', row: 'FFECEFF1' }
  };

  let serial = 1;

  categoriesList.forEach((catName) => {
    const list = groupedVacant[catName] || [];
    const colors = categoryColors[catName] || { badge: 'FF455A64', row: 'FFF5F7F8' };
    
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '']);
    sheet.mergeCells(startRow, 1, startRow, 3);
    const separatorCell = sheet.getCell(startRow, 1);
    
    let displayName = catName;
    if (catName === "Day Case") {
      displayName = "Day Case / اليوم الواحد";
    }
    separatorCell.value = `■  ${displayName} (عدد الغرف الشاغرة: ${list.length})  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    if (list.length === 0) {
      const emptyRow = sheet.addRow(['-', 'لا يوجد غرف شاغرة', catName]);
      emptyRow.height = 24;
      emptyRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.row } };
        cell.font = { name: 'Calibri', size: 11, italic: true, color: { argb: 'FF757575' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
      });
    } else {
      list.forEach((room) => {
        const pRow = sheet.addRow([serial++, room, catName]);
        pRow.height = 24;
        pRow.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.row } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
            bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
            left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
            right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
          };
          cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        });
      });
    }
  });

  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 25;
  sheet.getColumn(3).width = 35;
}

app.get('/api/reports/inpatient_occupancy_by_floor_accommodation', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Please upload data first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addGridOccupancyWithAccommodationSheet(workbook, getOccupancyRows(hospitalData));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Inpatient_occupancy_by_floor_accommodation_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Accommodation Occupancy excel generation error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/vacant_by_category', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Please upload data first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addVacantRoomsByCategorySheet(workbook, getOccupancyRows(hospitalData));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Vacant_Rooms_by_Category_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Vacant rooms by category excel generation error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function addOccupancyChartsDashboardSheet(
  workbook: ExcelJS.Workbook,
  occupiedCount: number,
  freeCount: number,
  newCount: number,
  oldCount: number,
  hospitalCaseCount: number,
  doctorCaseCount: number,
  privateCreditCount: number,
  cashHospitalCount: number,
  cashDoctorCount: number,
  cashInsuredCount: number,
  insuredHospitalCount: number,
  insuredPrivateCreditCount: number,
  specCounts: Record<string, number>,
  losOver5: number,
  losUnder5: number,
  groupWardOccupied: number,
  groupIcuOccupied: number,
  groupCcuOccupied: number,
  groupNicuPicuOccupied: number,
  zoneOccupied: Record<string, number>
) {
  const sheet = workbook.addWorksheet('Occupancy Analytics Dashboard', {
    views: [{ rightToLeft: false, showGridLines: true }]
  });

  // Set precise column widths
  sheet.columns = [
    { width: 38 }, // A: Category / Category name
    { width: 14 }, // B: Metric count
    { width: 4 },  // C: Spacing column
    { width: 38 }, // D: Category / Financial name
    { width: 14 }, // E: Financial count
    { width: 4 },  // F: Spacing column
    { width: 38 }, // G: Specialty name
    { width: 14 }, // H: Specialty count
    { width: 4 },  // I: Spacing column
    { width: 28 }, // J: Zone name
    { width: 14 }, // K: Occupied
    { width: 14 }, // L: Free
    { width: 14 }  // M: Total
  ];

  const headerNavy = 'FF0F172A'; // Slate 900
  const headerGray = 'FF1E293B';  // Slate 800
  const borderThin: any = {
    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
  };

  // -------------------------------------------------------------
  // Row 1-2: Unified Main Header Card
  // -------------------------------------------------------------
  sheet.mergeCells('A1:M2');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'HOSPITAL OCCUPANCY & STATISTICAL ANALYTICS DASHBOARD / لوحة تحليلات وإحصائيات إشغال المستشفى';
  titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerNavy } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 30;
  sheet.getRow(2).height = 30;

  // -------------------------------------------------------------
  // Row 4-6: KPI Cards (Summary boxes) with proper Excel formula calculation compatibility
  // -------------------------------------------------------------
  const createKpiCard = (
    colStart: string, colEnd: string,
    titleEng: string, titleAra: string,
    value: any,
    fillHex: string, textHex: string,
    numFormat?: string
  ) => {
    const labelRange = `${colStart}4:${colEnd}4`;
    const valueRange = `${colStart}5:${colEnd}6`;

    // Merge label cells
    sheet.mergeCells(labelRange);
    const labelCell = sheet.getCell(`${colStart}4`);
    labelCell.value = `${titleEng} / ${titleAra}`;
    labelCell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: textHex } };
    labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillHex } };
    labelCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

    // Merge value cells
    sheet.mergeCells(valueRange);
    const valueCell = sheet.getCell(`${colStart}5`);
    valueCell.value = value;
    valueCell.font = { name: 'Segoe UI', size: 22, bold: true, color: { argb: textHex } };
    valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillHex } };
    valueCell.alignment = { horizontal: 'center', vertical: 'middle' };

    if (numFormat) {
      valueCell.numFmt = numFormat;
    }

    // Apply borders to the entire region (Row 4 to Row 6)
    const startColIdx = colStart.charCodeAt(0) - 65;
    const endColIdx = colEnd.charCodeAt(0) - 65;
    for (let r = 4; r <= 6; r++) {
      for (let c = startColIdx; c <= endColIdx; c++) {
        sheet.getRow(r).getCell(c + 1).border = borderThin;
      }
    }
  };

  createKpiCard('A', 'B', 'TOTAL HOSPITAL BEDS', 'إجمالي أسرة المستشفى', 107, 'FFE0F2FE', 'FF0369A1'); // Blue Theme
  createKpiCard('D', 'E', 'TOTAL OCCUPIED BEDS', 'الأسرة المشغولة حالياً', occupiedCount, 'FFFEE2E2', 'FFB91C1C'); // Red Theme
  createKpiCard('G', 'H', 'TOTAL VACANT BEDS', 'الأسرة الشاغرة حالياً', freeCount, 'FFDCFCE7', 'FF15803D'); // Green Theme
  createKpiCard('J', 'M', 'OVERALL OCCUPANCY %', 'نسبة الإشغال الكلية', { formula: 'B10/B12', result: occupiedCount / 107 }, 'FFFEF9C3', 'FF854D0E', '0.0%'); // Yellow Theme

  sheet.getRow(4).height = 24;
  sheet.getRow(5).height = 24;
  sheet.getRow(6).height = 24;

  // Formatting function for sub-tables
  const applyTableStyles = (startRow: number, startCol: number, endRow: number, endCol: number) => {
    // Header Row (First Row)
    const headerRow = sheet.getRow(startRow);
    for (let col = startCol; col <= endCol; col++) {
      const cell = headerRow.getCell(col);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerGray } };
      cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = borderThin;
    }

    // Data Rows
    for (let r = startRow + 1; r <= endRow; r++) {
      const dataRow = sheet.getRow(r);
      const isAlt = r % 2 === 0;
      const fillHex = isAlt ? 'FFF8FAFC' : 'FFFFFFFF';
      const isTotalRow = r === endRow;

      for (let col = startCol; col <= endCol; col++) {
        const cell = dataRow.getCell(col);
        cell.border = borderThin;
        
        if (isTotalRow) {
          cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF000000' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        } else {
          cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF334155' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillHex } };
        }

        if (col === startCol) {
          cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        } else {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        }
      }
    }
  };

  // -------------------------------------------------------------
  // COLUMNS A-B: Tables 1, 2, 3
  // -------------------------------------------------------------

  // Table 1: Bed Occupancy Summary
  sheet.mergeCells('A8:B8');
  sheet.getCell('A8').value = '1. General Bed Occupancy / ملخص إشغال الأسرة';
  sheet.getRow(9).values = ['Occupancy Status / حالة الإشغال', 'Bed Count / العدد'];
  sheet.getCell('B10').value = occupiedCount;
  sheet.getCell('A10').value = 'Occupied Beds / الأسرة المشغولة';
  sheet.getCell('B11').value = freeCount;
  sheet.getCell('A11').value = 'Vacant Beds / الأسرة الشاغرة';
  sheet.getCell('B12').value = { formula: 'SUM(B10:B11)', result: occupiedCount + freeCount };
  sheet.getCell('A12').value = 'Total Hospital Capacity / إجمالي الأسرة';
  sheet.getCell('B13').value = { formula: 'B10/B12', result: occupiedCount / 107 };
  sheet.getCell('A13').value = 'Occupancy Rate / نسبة الإشغال';
  sheet.getCell('B13').numFmt = '0.0%';
  applyTableStyles(8, 1, 13, 2);

  // Table 2: Patient Recency (New vs Old)
  sheet.mergeCells('A15:B15');
  sheet.getCell('A15').value = '2. Patient Recency / حداثة دخول المرضى';
  sheet.getRow(16).values = ['Recency Category / نوع المريض', 'Count / العدد'];
  sheet.getCell('B17').value = newCount;
  sheet.getCell('A17').value = 'New Patients (Admitted Today) / مرضى اليوم';
  sheet.getCell('B18').value = oldCount;
  sheet.getCell('A18').value = 'Old Patients (Prior Admissions) / مرضى سابقين';
  sheet.getCell('B19').value = freeCount;
  sheet.getCell('A19').value = 'Vacant Beds / الأسرة الشاغرة';
  sheet.getCell('B20').value = { formula: 'SUM(B17:B19)', result: newCount + oldCount + freeCount };
  sheet.getCell('A20').value = 'Total Hospital Capacity / إجمالي الأسرة';
  sheet.getCell('B21').value = { formula: 'B17/B20', result: newCount / 107 };
  sheet.getCell('A21').value = 'New Patient Ratio % / نسبة المرضى الجدد';
  sheet.getCell('B21').numFmt = '0.0%';
  applyTableStyles(15, 1, 21, 2);

  // Table 3: Length of Stay (LOS) Breakdown
  sheet.mergeCells('A23:B23');
  sheet.getCell('A23').value = '3. Length of Stay (LOS) / مدة الإقامة للمنومين';
  sheet.getRow(24).values = ['LOS Category / فترة الإقامة', 'Count / العدد'];
  sheet.getCell('B25').value = losOver5;
  sheet.getCell('A25').value = 'Long Stay Patients (LOS > 5 Days) / أكثر من 5 أيام';
  sheet.getCell('B26').value = losUnder5;
  sheet.getCell('A26').value = 'Short Stay Patients (LOS <= 5 Days) / أقل من 5 أيام';
  sheet.getCell('B27').value = freeCount;
  sheet.getCell('A27').value = 'Vacant Beds / الأسرة الشاغرة';
  sheet.getCell('B28').value = { formula: 'SUM(B25:B27)', result: losOver5 + losUnder5 + freeCount };
  sheet.getCell('A28').value = 'Total Hospital Capacity / إجمالي الأسرة';
  sheet.getCell('B29').value = { formula: 'B25/B28', result: losOver5 / 107 };
  sheet.getCell('A29').value = 'Long Stay Ratio % / نسبة الإقامة الطويلة';
  sheet.getCell('B29').numFmt = '0.0%';
  applyTableStyles(23, 1, 29, 2);


  // -------------------------------------------------------------
  // COLUMNS D-E: Tables 4, 5
  // -------------------------------------------------------------

  // Table 4: Case Type Breakdown
  sheet.mergeCells('D8:E8');
  sheet.getCell('D8').value = '4. Cases by Admission Type / تصنيف نوع الحالة';
  sheet.getRow(9).getCell(4).value = 'Admission Type / جهة تحويل الحالة';
  sheet.getRow(9).getCell(5).value = 'Count / العدد';
  sheet.getCell('E10').value = hospitalCaseCount;
  sheet.getCell('D10').value = 'Hospital Case / حالة مستشفى';
  sheet.getCell('E11').value = doctorCaseCount;
  sheet.getCell('D11').value = 'Doctor Case / حالة طبيب';
  sheet.getCell('E12').value = privateCreditCount;
  sheet.getCell('D12').value = 'Private Credit / أفراد - مباشر';
  sheet.getCell('E13').value = freeCount;
  sheet.getCell('D13').value = 'Vacant Beds / الأسرة الشاغرة';
  sheet.getCell('E14').value = { formula: 'SUM(E10:E13)', result: hospitalCaseCount + doctorCaseCount + privateCreditCount + freeCount };
  sheet.getCell('D14').value = 'Total Hospital Capacity / إجمالي الأسرة';
  applyTableStyles(8, 4, 14, 5);

  // Table 5: Financial Detail Breakdown
  sheet.mergeCells('D16:E16');
  sheet.getCell('D16').value = '5. Financial Breakdown / التفصيل المالي والتعاقدات';
  sheet.getRow(17).getCell(4).value = 'Financial Class / تصنيف التعاقد والضمان الكاش';
  sheet.getRow(17).getCell(5).value = 'Count / العدد';
  sheet.getCell('E18').value = cashHospitalCount;
  sheet.getCell('D18').value = 'Cash Hospital Case / كاش مستشفى';
  sheet.getCell('E19').value = cashDoctorCount;
  sheet.getCell('D19').value = 'Cash Doctor Case / كاش طبيب';
  sheet.getCell('E20').value = cashInsuredCount;
  sheet.getCell('D20').value = 'Cash Insured (Cash Private) / كاش تأمين';
  sheet.getCell('E21').value = insuredHospitalCount;
  sheet.getCell('D21').value = 'Insured Hospital Case / تأمين مستشفى';
  sheet.getCell('E22').value = insuredPrivateCreditCount;
  sheet.getCell('D22').value = 'Insured Private Credit / تأمين خاص';
  sheet.getCell('E23').value = freeCount;
  sheet.getCell('D23').value = 'Vacant Beds / الأسرة الشاغرة';
  sheet.getCell('E24').value = { formula: 'SUM(E18:E23)', result: cashHospitalCount + cashDoctorCount + cashInsuredCount + insuredHospitalCount + insuredPrivateCreditCount + freeCount };
  sheet.getCell('D24').value = 'Total Hospital Capacity / إجمالي الأسرة';
  applyTableStyles(16, 4, 24, 5);


  // -------------------------------------------------------------
  // COLUMNS G-H: Table 6
  // -------------------------------------------------------------

  // Table 6: Medical Specialty Distribution
  sheet.mergeCells('G8:H8');
  sheet.getCell('G8').value = '6. Medical Specialties / التخصصات الطبية للمنومين';
  sheet.getRow(9).getCell(7).value = 'Medical Specialty / التخصص الطبي';
  sheet.getRow(9).getCell(8).value = 'Cases / الحالات';

  let rowIdx = 10;
  const specialties = Object.keys(specCounts);
  specialties.forEach(spec => {
    sheet.getCell(`G${rowIdx}`).value = spec;
    sheet.getCell(`H${rowIdx}`).value = specCounts[spec];
    rowIdx++;
  });
  sheet.getCell(`G${rowIdx}`).value = 'Vacant Beds / الأسرة الشاغرة';
  sheet.getCell(`H${rowIdx}`).value = freeCount;
  rowIdx++;
  sheet.getCell(`G${rowIdx}`).value = 'Total Hospital Capacity / إجمالي الأسرة';
  sheet.getCell(`H${rowIdx}`).value = { formula: `SUM(H10:H${rowIdx-1})`, result: 107 };
  applyTableStyles(8, 7, rowIdx, 8);


  // -------------------------------------------------------------
  // COLUMNS J-M: Tables 7, 8
  // -------------------------------------------------------------

  // Table 7: Occupancy by Unit Group
  sheet.mergeCells('J8:M8');
  sheet.getCell('J8').value = '7. Occupancy by Unit Group / إشغال مجموعات الوحدات والأسرة';
  sheet.getRow(9).getCell(10).value = 'Unit Group / مجموعة الوحدات';
  sheet.getRow(9).getCell(11).value = 'Occupied / مشغول';
  sheet.getRow(9).getCell(12).value = 'Vacant / شاغر';
  sheet.getRow(9).getCell(13).value = 'Total / الكلي';

  const addUnitGroupRow = (rNum: number, label: string, occupied: number, free: number) => {
    sheet.getCell(`J${rNum}`).value = label;
    sheet.getCell(`K${rNum}`).value = occupied;
    sheet.getCell(`L${rNum}`).value = free;
    sheet.getCell(`M${rNum}`).value = { formula: `SUM(K${rNum}:L${rNum})`, result: occupied + free };
  };

  addUnitGroupRow(10, 'Ward & SICU / الأجنحة العامة والعناية الجراحية', groupWardOccupied, 41);
  addUnitGroupRow(11, 'ICU (General + VIP ICU) / العناية المركزة وباقة كبار الشخصيات', groupIcuOccupied, 7);
  addUnitGroupRow(12, 'CCU / عناية القلب المركزة', groupCcuOccupied, 5);
  addUnitGroupRow(13, 'NICU/PICU / عناية حديثي الولادة والأطفال المركزة', groupNicuPicuOccupied, 4);

  sheet.getCell('J14').value = 'Total / الإجمالي الكلي للمجموعات';
  sheet.getCell('K14').value = { formula: 'SUM(K10:K13)', result: groupWardOccupied + groupIcuOccupied + groupCcuOccupied + groupNicuPicuOccupied };
  sheet.getCell('L14').value = { formula: 'SUM(L10:L13)', result: 41 + 7 + 5 + 4 };
  sheet.getCell('M14').value = { formula: 'SUM(M10:M13)', result: 107 };
  applyTableStyles(8, 10, 14, 13);

  // Table 8: Detailed Occupancy by Floor & Zone
  sheet.mergeCells('J16:M16');
  sheet.getCell('J16').value = '8. Detailed Occupancy by Ward Zone / إشغال الأجنحة والأقسام بالتفصيل';
  sheet.getRow(17).getCell(10).value = 'Ward Zone / القسم أو الجناح';
  sheet.getRow(17).getCell(11).value = 'Occupied / مشغول';
  sheet.getRow(17).getCell(12).value = 'Vacant / شاغر';
  sheet.getRow(17).getCell(13).value = 'Total / الكلي';

  let zoneRowIdx = 18;
  const zonesList = [
    { label: '1st floor / الطابق الأول', key: '1st floor', free: 9 },
    { label: 'Zone A (3rd Floor) / جناح أ - الطابق الثالث', key: 'Zone A', free: 9 },
    { label: 'Zone B (3rd Floor) / جناح ب - الطابق الثالث', key: 'Zone B', free: 3 },
    { label: 'Zone C (3rd Floor) / جناح ج - الطابق الثالث', key: 'Zone C', free: 5 },
    { label: 'Day Case / جراحة اليوم الواحد', key: 'Day Case', free: 3 },
    { label: '4th floor / الطابق الرابع', key: '4th floor', free: 11 },
    { label: 'General ICU / العناية المركزة العامة', key: 'General ICU', free: 5 },
    { label: 'VIP ICU / العناية المركزة لكبار الشخصيات', key: 'VIP ICU', free: 2 },
    { label: 'NICU/PICU / العناية المركزة للأطفال وحديثي الولادة', key: 'NICU/PICU', free: 4 },
    { label: 'SICU / العناية المركزة الجراحية', key: 'SICU', free: 4 },
    { label: 'CCU / العناية القلبية المركزة', key: 'CCU', free: 5 }
  ];

  zonesList.forEach(zone => {
    sheet.getCell(`J${zoneRowIdx}`).value = zone.label;
    sheet.getCell(`K${zoneRowIdx}`).value = zoneOccupied[zone.key] || 0;
    sheet.getCell(`L${zoneRowIdx}`).value = zone.free;
    sheet.getCell(`M${zoneRowIdx}`).value = { formula: `SUM(K${zoneRowIdx}:L${zoneRowIdx})`, result: (zoneOccupied[zone.key] || 0) + zone.free };
    zoneRowIdx++;
  });

  sheet.getCell(`J${zoneRowIdx}`).value = 'Total / الإجمالي الكلي للأجنحة';
  sheet.getCell(`K${zoneRowIdx}`).value = { formula: `SUM(K18:K${zoneRowIdx-1})`, result: occupiedCount };
  sheet.getCell(`L${zoneRowIdx}`).value = { formula: `SUM(L18:L${zoneRowIdx-1})`, result: freeCount };
  sheet.getCell(`M${zoneRowIdx}`).value = { formula: `SUM(M18:M${zoneRowIdx-1})`, result: 107 };
  applyTableStyles(16, 10, zoneRowIdx, 13);

  // Set row heights for better look
  for (let r = 8; r <= Math.max(rowIdx, zoneRowIdx); r++) {
    sheet.getRow(r).height = 20;
  }

  // -------------------------------------------------------------
  // GENERATE AND EMBED HIGH-FIDELITY VECTOR PIE & STACKED BAR CHARTS
  // -------------------------------------------------------------
  const chartWidth = 620;
  const chartHeight = 360;

  // Chart 1: Bed Occupancy
  const c1Svg = generatePieChartSvg(chartWidth, chartHeight, [
    { label: 'Occupied Beds / الأسرة المشغولة', value: occupiedCount, color: '#3b82f6' },
    { label: 'Vacant Beds / الأسرة الشاغرة', value: freeCount, color: '#10b981' }
  ], 'General Bed Occupancy / ملخص إشغال الأسرة الكلي');
  
  // Chart 2: Patient Recency
  const c2Svg = generatePieChartSvg(chartWidth, chartHeight, [
    { label: 'New Patients (Admitted Today)', value: newCount, color: '#06b6d4' },
    { label: 'Old Patients (Prior Admissions)', value: oldCount, color: '#f97316' },
    { label: 'Vacant Beds / الأسرة الشاغرة', value: freeCount, color: '#cbd5e1' }
  ], 'Patient Recency Breakdown / حداثة دخول وحالة المنومين');

  // Chart 3: Admission Type
  const c3Svg = generatePieChartSvg(chartWidth, chartHeight, [
    { label: 'Hospital Case / حالة مستشفى', value: hospitalCaseCount, color: '#3b82f6' },
    { label: 'Doctor Case / حالة طبيب', value: doctorCaseCount, color: '#f59e0b' },
    { label: 'Private Credit / أفراد مباشر', value: privateCreditCount, color: '#ec4899' },
    { label: 'Vacant Beds / الأسرة الشاغرة', value: freeCount, color: '#cbd5e1' }
  ], 'Admission Types Breakdown / إحصائية جهة تحويل الحالات');

  // Chart 4: Financial Breakdown
  const c4Svg = generatePieChartSvg(chartWidth, chartHeight, [
    { label: 'Cash Hospital Case / كاش مستشفى', value: cashHospitalCount, color: '#f43f5e' },
    { label: 'Cash Doctor Case / كاش طبيب', value: cashDoctorCount, color: '#fbbf24' },
    { label: 'Cash Insured / كاش تأمين', value: cashInsuredCount, color: '#a855f7' },
    { label: 'Insured Hospital Case / تأمين مستشفى', value: insuredHospitalCount, color: '#3b82f6' },
    { label: 'Insured Private Credit / تأمين خاص', value: insuredPrivateCreditCount, color: '#06b6d4' },
    { label: 'Vacant Beds / الأسرة الشاغرة', value: freeCount, color: '#cbd5e1' }
  ], 'Financial Class Summary / تصنيف التعاقد والضمان الكاش والتأمين');

  // Chart 5: Medical Specialties
  const specColors = ['#4f46e5', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#14b8a6', '#f43f5e', '#a855f7', '#10b981'];
  const specData = Object.keys(specCounts).map((spec, i) => ({
    label: spec,
    value: specCounts[spec],
    color: specColors[i % specColors.length]
  })).filter(s => s.value > 0);
  specData.push({ label: 'Vacant Beds / الأسرة الشاغرة', value: freeCount, color: '#cbd5e1' });
  const c5Svg = generatePieChartSvg(chartWidth, chartHeight, specData, 'Medical Specialties / التخصصات الطبية للمنومين حالياً');

  // Chart 6: Length of Stay
  const c6Svg = generatePieChartSvg(chartWidth, chartHeight, [
    { label: 'Long Stay Patients (LOS > 5 Days)', value: losOver5, color: '#ef4444' },
    { label: 'Short Stay Patients (LOS <= 5 Days)', value: losUnder5, color: '#3b82f6' },
    { label: 'Vacant Beds / الأسرة الشاغرة', value: freeCount, color: '#cbd5e1' }
  ], 'Length of Stay (LOS) / مدة الإقامة للمنومين');

  // Chart 7: Unit Groups
  const c7Svg = generateStackedBarChartSvg(chartWidth, chartHeight, [
    { label: 'Ward & SICU', occupied: groupWardOccupied, free: 41 },
    { label: 'ICU Group', occupied: groupIcuOccupied, free: 7 },
    { label: 'CCU Group', occupied: groupCcuOccupied, free: 5 },
    { label: 'NICU/PICU', occupied: groupNicuPicuOccupied, free: 4 }
  ], 'Occupancy by Unit Group / إشغال مجموعات الوحدات والأسرة');

  // Chart 8: Detailed Zones
  const c8Svg = generateStackedBarChartSvg(chartWidth, chartHeight, zonesList.map(zone => ({
    label: zone.label.split(' / ')[0], // short label
    occupied: zoneOccupied[zone.key] || 0,
    free: zone.free
  })), 'Detailed Occupancy by Ward Zone / إشغال الأجنحة والأقسام بالتفصيل');

  // Render SVGs to PNGs using sharp and add them to the worksheet
  const addChartImageToSheet = async (svgStr: string, col: number, row: number) => {
    try {
      const pngBuffer = await sharp(Buffer.from(svgStr)).png().toBuffer();
      const imageId = workbook.addImage({
        buffer: pngBuffer,
        extension: 'png'
      });
      sheet.addImage(imageId, {
        tl: { col, row },
        ext: { width: chartWidth, height: chartHeight }
      });
    } catch (e) {
      console.error('Error generating and embedding chart image:', e);
    }
  };

  // Place charts beautifully in a 2-column grid starting at Row 34
  await addChartImageToSheet(c1Svg, 1, 33);  // Col B, Row 34
  await addChartImageToSheet(c2Svg, 7, 33);  // Col H, Row 34
  
  await addChartImageToSheet(c3Svg, 1, 53);  // Col B, Row 54
  await addChartImageToSheet(c4Svg, 7, 53);  // Col H, Row 54

  await addChartImageToSheet(c5Svg, 1, 73);  // Col B, Row 74
  await addChartImageToSheet(c6Svg, 7, 73);  // Col H, Row 74

  await addChartImageToSheet(c7Svg, 1, 93);  // Col B, Row 94
  await addChartImageToSheet(c8Svg, 7, 93);  // Col H, Row 94

  // Ensure row heights are allocated for the charts
  for (let r = 34; r <= 113; r++) {
    sheet.getRow(r).height = 19.5;
  }
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function generatePieChartSvg(
  width: number,
  height: number,
  data: { label: string; value: number; color: string }[],
  title: string
): string {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const cx = 195;
  const cy = height / 2 + 10;
  
  // 3D Ellipse properties
  const rx = 110;
  const ry = 65;
  const depth = 20;

  // Helper to darken a color by percentage
  const darkenColor = (hex: string, percent: number): string => {
    let c = hex.replace('#', '');
    if (c.length === 3) {
      c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    }
    let num = parseInt(c, 16);
    let r = (num >> 16);
    let g = ((num >> 8) & 0x00ff);
    let b = (num & 0x0000ff);

    r = Math.max(0, Math.floor(r * (1 - percent)));
    g = Math.max(0, Math.floor(g * (1 - percent)));
    b = Math.max(0, Math.floor(b * (1 - percent)));

    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  };

  const sides: string[] = [];
  const tops: string[] = [];
  const labels: string[] = [];
  
  let currentAngle = -Math.PI / 2; // Start from top (12 o'clock)

  data.forEach((slice) => {
    if (slice.value === 0) return;
    const fraction = slice.value / total;
    const angle = fraction * 2 * Math.PI;
    const endAngle = currentAngle + angle;

    const sideColor = darkenColor(slice.color, 0.22);
    const innerColor1 = darkenColor(slice.color, 0.12);
    const innerColor2 = darkenColor(slice.color, 0.30);

    if (fraction >= 0.999) {
      // 100% single slice: full 3D cylinder
      sides.push(`<path d="M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cy} L ${cx + rx} ${cy + depth} A ${rx} ${ry} 0 0 1 ${cx - rx} ${cy + depth} Z" fill="${sideColor}" stroke="${sideColor}" stroke-width="0.5" />`);
      tops.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${slice.color}" stroke="#ffffff" stroke-width="1" />`);
      labels.push(`<text x="${cx}" y="${cy}" fill="#ffffff" font-family="Segoe UI, sans-serif" font-size="12" font-weight="bold" text-anchor="middle" dominant-baseline="central" style="text-shadow: 1px 1px 2px rgba(0,0,0,0.5);">100%</text>`);
    } else {
      const x1 = cx + rx * Math.cos(currentAngle);
      const y1 = cy + ry * Math.sin(currentAngle);
      const x2 = cx + rx * Math.cos(endAngle);
      const y2 = cy + ry * Math.sin(endAngle);

      const largeArc = angle > Math.PI ? 1 : 0;

      // Outer curved wall
      sides.push(`<path d="M ${x1} ${y1} A ${rx} ${ry} 0 ${largeArc} 1 ${x2} ${y2} L ${x2} ${y2 + depth} A ${rx} ${ry} 0 ${largeArc} 0 ${x1} ${y1 + depth} Z" fill="${sideColor}" stroke="${sideColor}" stroke-width="0.5" />`);
      
      // Inner cut straight walls
      sides.push(`<path d="M ${cx} ${cy} L ${x1} ${y1} L ${x1} ${y1 + depth} L ${cx} ${cy + depth} Z" fill="${innerColor1}" stroke="${innerColor1}" stroke-width="0.5" />`);
      sides.push(`<path d="M ${cx} ${cy} L ${x2} ${y2} L ${x2} ${y2 + depth} L ${cx} ${cy + depth} Z" fill="${innerColor2}" stroke="${innerColor2}" stroke-width="0.5" />`);

      // Top face sector
      tops.push(`<path d="M ${cx} ${cy} L ${x1} ${y1} A ${rx} ${ry} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${slice.color}" stroke="#ffffff" stroke-width="1" />`);

      // Percentage label (placed with perspective offset)
      if (fraction > 0.04) {
        const middleAngle = currentAngle + angle / 2;
        const labelR = rx * 0.65;
        const lx = cx + labelR * Math.cos(middleAngle);
        const ly = cy + (labelR * 0.58) * Math.sin(middleAngle) + depth / 3;
        const percentageStr = `${Math.round(fraction * 100)}%`;
        labels.push(`<text x="${lx}" y="${ly}" fill="#ffffff" font-family="Segoe UI, sans-serif" font-size="11" font-weight="bold" text-anchor="middle" dominant-baseline="central" style="text-shadow: 1px 1px 2px rgba(0,0,0,0.5);">${percentageStr}</text>`);
      }
    }

    currentAngle = endAngle;
  });

  // Legend on the right side
  let legendSvg = '';
  let legendY = 65;
  data.forEach((slice) => {
    const percentage = total > 0 ? (slice.value / total) * 100 : 0;
    legendSvg += `
      <rect x="390" y="${legendY}" width="14" height="14" rx="3" fill="${slice.color}" />
      <text x="412" y="${legendY + 11}" font-family="Segoe UI, sans-serif" font-size="11" fill="#334155" font-weight="500">
        ${escapeXml(slice.label)} (${slice.value}, ${percentage.toFixed(0)}%)
      </text>
    `;
    legendY += 22;
  });

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff" rx="12" />
      <rect width="100%" height="100%" fill="none" stroke="#cbd5e1" stroke-width="1" rx="12" />
      <text x="24" y="35" font-family="Segoe UI, sans-serif" font-size="14" font-weight="bold" fill="#0f172a">${escapeXml(title)}</text>
      <g>
        ${sides.join('\n')}
        ${tops.join('\n')}
        ${labels.join('\n')}
      </g>
      ${legendSvg}
    </svg>
  `;
}

function generateStackedBarChartSvg(
  width: number,
  height: number,
  categories: { label: string; occupied: number; free: number }[],
  title: string
): string {
  const chartWidth = width - 160; // right margin for legend/labels
  const chartHeight = height - 120; // top and bottom margins
  const startX = 60;
  const startY = height - 60; // bottom of chart

  const numCategories = categories.length;
  const barWidth = Math.min(45, (chartWidth - 100) / numCategories);
  const barSpacing = (chartWidth - 100) / numCategories;

  let barsSvg = '';
  let xLabelsSvg = '';

  categories.forEach((cat, idx) => {
    const total = cat.occupied + cat.free;
    const x = startX + 50 + idx * barSpacing;

    if (total === 0) {
      barsSvg += `
        <rect x="${x}" y="${startY - chartHeight}" width="${barWidth}" height="${chartHeight}" fill="#f1f5f9" rx="4" />
      `;
    } else {
      const occupiedHeight = (cat.occupied / total) * chartHeight;
      const freeHeight = (cat.free / total) * chartHeight;

      if (occupiedHeight > 0) {
        barsSvg += `
          <rect x="${x}" y="${startY - occupiedHeight}" width="${barWidth}" height="${occupiedHeight}" fill="#3b82f6" />
        `;
        if (occupiedHeight > 18) {
          barsSvg += `
            <text x="${x + barWidth / 2}" y="${startY - occupiedHeight / 2}" fill="#ffffff" font-family="Segoe UI, sans-serif" font-size="10" font-weight="bold" text-anchor="middle" dominant-baseline="central">${cat.occupied}</text>
          `;
        }
      }

      if (freeHeight > 0) {
        barsSvg += `
          <rect x="${x}" y="${startY - occupiedHeight - freeHeight}" width="${barWidth}" height="${freeHeight}" fill="#10b981" />
        `;
        if (freeHeight > 18) {
          barsSvg += `
            <text x="${x + barWidth / 2}" y="${startY - occupiedHeight - freeHeight / 2}" fill="#ffffff" font-family="Segoe UI, sans-serif" font-size="10" font-weight="bold" text-anchor="middle" dominant-baseline="central">${cat.free}</text>
          `;
        }
      }
    }

    const isRotated = numCategories > 5;
    const labelX = x + barWidth / 2;
    const labelY = startY + 16;
    const transform = isRotated ? `transform="rotate(-25, ${labelX}, ${labelY})"` : '';
    xLabelsSvg += `
      <text x="${labelX}" y="${labelY}" font-family="Segoe UI, sans-serif" font-size="9" fill="#475569" text-anchor="${isRotated ? 'end' : 'middle'}" ${transform}>${escapeXml(cat.label)}</text>
    `;
  });

  const legendSvg = `
    <g transform="translate(${width - 140}, 60)">
      <rect x="0" y="0" width="12" height="12" rx="2" fill="#3b82f6" />
      <text x="18" y="10" font-family="Segoe UI, sans-serif" font-size="10" fill="#475569" font-weight="500">Occupied beds</text>
      
      <rect x="0" y="22" width="12" height="12" rx="2" fill="#10b981" />
      <text x="18" y="32" font-family="Segoe UI, sans-serif" font-size="10" fill="#475569" font-weight="500">Free beds</text>
    </g>
  `;

  let gridLinesSvg = '';
  for (let i = 0; i <= 5; i++) {
    const y = startY - (i / 5) * chartHeight;
    gridLinesSvg += `
      <line x1="${startX}" y1="${y}" x2="${width - 150}" y2="${y}" stroke="#cbd5e1" stroke-dasharray="4" />
      <text x="${startX - 10}" y="${y + 4}" font-family="Segoe UI, sans-serif" font-size="9" fill="#64748b" text-anchor="end">${i * 20}%</text>
    `;
  }

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff" rx="12" />
      <rect width="100%" height="100%" fill="none" stroke="#cbd5e1" stroke-width="1" rx="12" />
      <text x="24" y="35" font-family="Segoe UI, sans-serif" font-size="14" font-weight="bold" fill="#0f172a">${escapeXml(title)}</text>
      ${gridLinesSvg}
      ${barsSvg}
      ${xLabelsSvg}
      ${legendSvg}
    </svg>
  `;
}

app.get('/api/reports/occupancy_charts_dashboard', async (req, res) => {
  try {
    const rows = getOccupancyRowsUnfiltered(hospitalData);
    
    // Parse patient details dynamically from the sheet
    const activePatients = rows.map((row, index) => {
      if (index < 3) return null;
      return {
        room: String(row[0] || "").trim(),
        name: String(row[1] || "").trim(),
        doctor: String(row[2] || "").trim(),
        payment: String(row[3] || "").trim(),
        date: String(row[4] || "").trim(),
        mrn: String(row[5] || "").trim(),
      };
    }).filter(p => {
      if (!p || !p.room || !p.name) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      return !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
    }) as any[];

    // 1. Bed Occupancy counts
    const occupiedCount = activePatients.length > 0 ? activePatients.length : 51;
    const freeCount = activePatients.length > 0 ? (107 - occupiedCount) : 56;

    // 2. Patient Recency
    const dates = activePatients.map(p => {
      const parsed = Date.parse(p.date);
      return isNaN(parsed) ? 0 : parsed;
    }).filter(d => d > 0);
    const maxDateMs = dates.length > 0 ? Math.max(...dates) : Date.now();
    const maxDateStr = new Date(maxDateMs).toLocaleDateString();
    
    let newCount = 0;
    let oldCount = 0;
    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        const parsed = Date.parse(p.date);
        if (!isNaN(parsed) && new Date(parsed).toLocaleDateString() === maxDateStr) {
          newCount++;
        } else {
          oldCount++;
        }
      });
    } else {
      newCount = 6;
      oldCount = 45;
    }

    // 3. Hospital vs Doctor Cases
    let hospitalCaseCount = 0;
    let doctorCaseCount = 0;
    let privateCreditCount = 0;
    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        const pay = String(p.payment || "").toLowerCase();
        if (pay.includes("doctor case") || pay.includes("dc") || pay.includes("طبيب")) {
          doctorCaseCount++;
        } else if (pay.includes("private credit") || pay.includes("مباشر") || pay.includes("أفراد")) {
          privateCreditCount++;
        } else {
          hospitalCaseCount++;
        }
      });
    } else {
      hospitalCaseCount = 41;
      doctorCaseCount = 9;
      privateCreditCount = 1;
    }

    // 4. Financial breakdowns
    let cashHospitalCount = 0;
    let cashDoctorCount = 0;
    let cashInsuredCount = 0;
    let insuredHospitalCount = 0;
    let insuredPrivateCreditCount = 0;

    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        const pay = String(p.payment || "").toLowerCase();
        const isCash = pay.includes("cash") || pay.includes("كاش") || pay.includes("نقد");
        const isDoctor = pay.includes("doctor") || pay.includes("dc") || pay.includes("طبيب");
        const isHospital = pay.includes("hospital") || pay.includes("hc") || pay.includes("مستشفى");
        const isPrivate = pay.includes("private") || pay.includes("مباشر") || pay.includes("أفراد");

        if (isCash) {
          if (isDoctor) {
            cashDoctorCount++;
          } else if (isHospital) {
            cashHospitalCount++;
          } else {
            cashInsuredCount++;
          }
        } else {
          if (isPrivate) {
            insuredPrivateCreditCount++;
          } else {
            insuredHospitalCount++;
          }
        }
      });
    } else {
      cashHospitalCount = 5;
      cashDoctorCount = 9;
      cashInsuredCount = 4;
      insuredHospitalCount = 32;
      insuredPrivateCreditCount = 1;
    }

    // 5. Specialty counts
    const specCounts: Record<string, number> = {
      "ICU": 0,
      "Internal Medicine (IM)": 0,
      "General Surgery (GS)": 0,
      "Neurosurgery": 0,
      "Cardiology": 0,
      "Orthopaedics (Ortho)": 0,
      "Pediatrics (Ped)": 0,
      "Oncology": 0,
      "Ob.Gyn.": 0,
      "Anesthesia & Pain": 0,
      "Anesthesia (SICU)": 0,
      "Nephrology": 0
    };

    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        let matchedSpec = "";
        if (cumulativeMedicalPlans && cumulativeMedicalPlans.length > 0) {
          const plan = cumulativeMedicalPlans.find(pl => {
            if (pl.colD && p.name && isNameMatch(pl.colD, p.name)) return true;
            if (pl.colB && p.room && normalizeRoom(pl.colB) === normalizeRoom(p.room)) return true;
            return false;
          });
          if (plan && plan.colX) {
            const specLower = plan.colX.toLowerCase().trim();
            if (specLower.includes("icu")) matchedSpec = "ICU";
            else if (specLower.includes("internal") || specLower.includes("im") || specLower === "pulmonology" || specLower === "haematology") matchedSpec = "Internal Medicine (IM)";
            else if (specLower.includes("general surgery") || specLower === "git surgery" || specLower === "gs") matchedSpec = "General Surgery (GS)";
            else if (specLower.includes("neuro")) matchedSpec = "Neurosurgery";
            else if (specLower.includes("cardio")) matchedSpec = "Cardiology";
            else if (specLower.includes("ortho")) matchedSpec = "Orthopaedics (Ortho)";
            else if (specLower.includes("ped")) matchedSpec = "Pediatrics (Ped)";
            else if (specLower.includes("onco")) matchedSpec = "Oncology";
            else if (specLower.includes("gyn") || specLower.includes("ob")) matchedSpec = "Ob.Gyn.";
            else if (specLower.includes("pain") || specLower.includes("anesthesia & pain")) matchedSpec = "Anesthesia & Pain";
            else if (specLower.includes("sicu") || specLower.includes("anesthesia (sicu)")) matchedSpec = "Anesthesia (SICU)";
            else if (specLower.includes("nephro")) matchedSpec = "Nephrology";
          }
        }

        // Fallback based on room
        if (!matchedSpec) {
          const roomUpper = p.room.toUpperCase();
          if (roomUpper.includes("ICU") || roomUpper.includes("VIP")) matchedSpec = "ICU";
          else if (roomUpper.includes("CCU")) matchedSpec = "Cardiology";
          else if (roomUpper.includes("NICU") || roomUpper.includes("PICU") || roomUpper.includes("PED")) matchedSpec = "Pediatrics (Ped)";
          else if (roomUpper.includes("SICU")) matchedSpec = "Anesthesia (SICU)";
          else matchedSpec = "Internal Medicine (IM)";
        }

        if (specCounts[matchedSpec] !== undefined) {
          specCounts[matchedSpec]++;
        } else {
          specCounts["Internal Medicine (IM)"]++;
        }
      });
    } else {
      specCounts["ICU"] = 16;
      specCounts["Internal Medicine (IM)"] = 6;
      specCounts["General Surgery (GS)"] = 5;
      specCounts["Neurosurgery"] = 5;
      specCounts["Cardiology"] = 4;
      specCounts["Orthopaedics (Ortho)"] = 4;
      specCounts["Pediatrics (Ped)"] = 4;
      specCounts["Oncology"] = 3;
      specCounts["Ob.Gyn."] = 2;
      specCounts["Anesthesia & Pain"] = 1;
      specCounts["Anesthesia (SICU)"] = 1;
      specCounts["Nephrology"] = 0;
    }

    // 6. LOS breakdowns
    let losOver5 = 0;
    let losUnder5 = 0;
    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        let days = 0;
        const losItem = cumulativeLOS.find(l => l.colD && p.name && isNameMatch(l.colD, p.name));
        if (losItem && losItem.colS) {
          days = parseFloat(losItem.colS) || 0;
        } else {
          const admDate = Date.parse(p.date);
          if (!isNaN(admDate)) {
            const diffMs = Date.now() - admDate;
            days = Math.max(0, diffMs / (1000 * 60 * 60 * 24));
          }
        }
        if (days > 5) {
          losOver5++;
        } else {
          losUnder5++;
        }
      });
    } else {
      losOver5 = 12;
      losUnder5 = 39;
    }

    // 7. Unit Groups
    let groupWardOccupied = 0;
    let groupIcuOccupied = 0;
    let groupCcuOccupied = 0;
    let groupNicuPicuOccupied = 0;

    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        const roomUpper = p.room.toUpperCase();
        if (roomUpper.includes("ICU") || roomUpper.includes("VIP")) {
          groupIcuOccupied++;
        } else if (roomUpper.includes("CCU")) {
          groupCcuOccupied++;
        } else if (roomUpper.includes("NICU") || roomUpper.includes("PICU")) {
          groupNicuPicuOccupied++;
        } else {
          groupWardOccupied++;
        }
      });
    } else {
      groupWardOccupied = 32;
      groupIcuOccupied = 14;
      groupCcuOccupied = 2;
      groupNicuPicuOccupied = 2;
    }

    // 8. Zone Counts
    const zoneOccupied: Record<string, number> = {
      "1st floor": 0,
      "Zone A": 0,
      "Zone B": 0,
      "Zone C": 0,
      "Day Case": 0,
      "4th floor": 0,
      "General ICU": 0,
      "VIP ICU": 0,
      "NICU/PICU": 0,
      "SICU": 0,
      "CCU": 0
    };

    if (activePatients.length > 0) {
      activePatients.forEach(p => {
        const roomUpper = p.room.toUpperCase();
        const num = parseInt(roomUpper.match(/\d+/)?.at(0) || "0");
        
        if (roomUpper.includes("VIP ICU") || roomUpper.includes("VIP ISOLATION")) {
          zoneOccupied["VIP ICU"]++;
        } else if (roomUpper.includes("ICU")) {
          zoneOccupied["General ICU"]++;
        } else if (roomUpper.includes("CCU") || roomUpper.includes("VIP CCU")) {
          zoneOccupied["CCU"]++;
        } else if (roomUpper.includes("NICU") || roomUpper.includes("PICU")) {
          zoneOccupied["NICU/PICU"]++;
        } else if (roomUpper.includes("SICU")) {
          zoneOccupied["SICU"]++;
        } else if (num === 101 || num === 104 || num === 105 || roomUpper.includes("DAYCASE") || roomUpper.includes("DAY CASE")) {
          zoneOccupied["Day Case"]++;
        } else if (num >= 101 && num <= 108) {
          zoneOccupied["1st floor"]++;
        } else if (num >= 301 && num <= 319) {
          zoneOccupied["Zone A"]++;
        } else if (num >= 320 && num <= 329) {
          zoneOccupied["Zone B"]++;
        } else if (num >= 330 && num <= 332) {
          zoneOccupied["Zone C"]++;
        } else if (num >= 401 && num <= 422) {
          zoneOccupied["4th floor"]++;
        } else {
          zoneOccupied["4th floor"]++;
        }
      });
    } else {
      zoneOccupied["1st floor"] = 0;
      zoneOccupied["Zone A"] = 10;
      zoneOccupied["Zone B"] = 7;
      zoneOccupied["Zone C"] = 0;
      zoneOccupied["Day Case"] = 0;
      zoneOccupied["4th floor"] = 14;
      zoneOccupied["General ICU"] = 10;
      zoneOccupied["VIP ICU"] = 4;
      zoneOccupied["NICU/PICU"] = 2;
      zoneOccupied["SICU"] = 1;
      zoneOccupied["CCU"] = 2;
    }

    const workbook = new ExcelJS.Workbook();
    await addOccupancyChartsDashboardSheet(
      workbook,
      occupiedCount,
      freeCount,
      newCount,
      oldCount,
      hospitalCaseCount,
      doctorCaseCount,
      privateCreditCount,
      cashHospitalCount,
      cashDoctorCount,
      cashInsuredCount,
      insuredHospitalCount,
      insuredPrivateCreditCount,
      specCounts,
      losOver5,
      losUnder5,
      groupWardOccupied,
      groupIcuOccupied,
      groupCcuOccupied,
      groupNicuPicuOccupied,
      zoneOccupied
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Occupancy_Statistical_Dashboard_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Occupancy charts dashboard generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function addEarlyDischargeCasesSheet(workbook: ExcelJS.Workbook, data: any[][], roomsText: string) {
  const sheet = workbook.addWorksheet('Early Discharge Cases', {
    views: [{ rightToLeft: false }] 
  });

  const inputtedRooms = parseRoomNumbers(roomsText);
  const normalizedInputs = new Set(inputtedRooms.map(r => normalizeRoom(r)));

  let processedData = data.slice(3)
    .map(row => ({
      room: String(row[0] || "").trim(),
      name: String(row[1] || "").trim(),
      physician: String(row[2] || "").trim(),
      contractor: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
    }))
    .filter(p => {
      if (!p.room || !p.name) return false;
      const rowAsString = Object.values(p).join(" ").toLowerCase();
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      
      const match = normalizedInputs.has(normalizeRoom(p.room));
      return match && !KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw)) && !isHeader && !isOR;
    });

  // Sort by room numeric or status
  processedData.sort((a, b) => {
    const roomA = a.room.toUpperCase();
    const roomB = b.room.toUpperCase();
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  const getRoomZoneText = (roomStr: string) => {
    const rUpper = roomStr.toUpperCase();
    const isClosedUnit = ["ICU", "PICU", "NICU", "CCU", "SICU", "VIP ISOLATION", "VIP ICU", "VIP CCU"].some(dept => rUpper.includes(dept));
    if (isClosedUnit) return "Closed Units";
    
    if (rUpper.includes("VIP")) return "VIP Floor";

    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    if (roomNum >= 101 && roomNum <= 108) return "First Floor";
    if (roomNum >= 301 && roomNum <= 319) return "Zone A (301-319)";
    if (roomNum >= 320 && roomNum <= 329) return "Zone B (320-329)";
    if (roomNum >= 330 && roomNum <= 332) return "Zone C (330-332)";
    if (roomNum >= 401 && roomNum <= 422) return "4th Floor";
    return "OTHER";
  };

  const ZONE_ORDER = [
    "First Floor",
    "Zone A (301-319)",
    "Zone B (320-329)",
    "Zone C (330-332)",
    "4th Floor",
    "VIP Floor",
    "Closed Units",
    "OTHER"
  ];

  const zoneColors: { [key: string]: { badge: string, row: string } } = {
    "First Floor": { badge: 'FF5C5A7F', row: 'FFF1EFF5' },
    "Zone A (301-319)": { badge: 'FF1565C0', row: 'FFEBF5FB' },
    "Zone B (320-329)": { badge: 'FF3F889E', row: 'FFEBF2F5' },
    "Zone C (330-332)": { badge: 'FF8E44AD', row: 'FFF5EEF8' },
    "4th Floor": { badge: 'FFEF6C00', row: 'FFFFF5EB' },
    "VIP Floor": { badge: 'FF2E7D32', row: 'FFEBF5EB' },
    "Closed Units": { badge: 'FFAD1457', row: 'FFFFEBEF' },
    "OTHER": { badge: 'FF455A64', row: 'FFF5F7F8' }
  };

  const groupedZones: { [key: string]: typeof processedData } = {};
  ZONE_ORDER.forEach(z => {
    groupedZones[z] = [];
  });

  processedData.forEach(p => {
    const z = getRoomZoneText(p.room);
    if (!groupedZones[z]) {
      groupedZones[z] = [];
    }
    groupedZones[z].push(p);
  });

  const customBg = getCustomHeaderBgInfo();
  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  let bgBuffer: Buffer | null = null;
  if (customBg && fs.existsSync(customBg.path) && fs.statSync(customBg.path).size > 0) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <rect x="220" y="30" width="760" height="120" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.12" />
          <text x="600" y="85" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="bold" fill="#000000" text-anchor="middle">حالات الخروج المبكر</text>
          <text x="600" y="125" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="20" fill="#333333" text-anchor="middle">Early Discharge Cases</text>
        </svg>
      `;
      bgBuffer = await sharp(customBg.path)
        .resize(1200, 180, { fit: 'fill' })
        .composite([{
          input: Buffer.from(svgText),
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();
    } catch (sharpErr) {
      console.error('Error compositing textbox on custom background:', sharpErr);
    }
  }

  if (!bgBuffer) {
    try {
      const svgText = `
        <svg width="1200" height="180" viewBox="0 0 1200 180">
          <rect width="1200" height="180" fill="#EBF3F5" />
          <rect x="220" y="30" width="760" height="120" rx="16" ry="16" fill="#FFFFFF" fill-opacity="0.18" />
          <text x="600" y="85" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="bold" fill="#000000" text-anchor="middle">حالات الخروج المبكر</text>
          <text x="600" y="125" font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="20" fill="#333333" text-anchor="middle">Early Discharge Cases</text>
        </svg>
      `;
      bgBuffer = await sharp(Buffer.from(svgText))
        .png()
        .toBuffer();
    } catch (err) {
      console.error(err);
    }
  }

  if (bgBuffer) {
    try {
      const bgId = workbook.addImage({
        buffer: bgBuffer,
        extension: 'png',
      });
      sheet.addImage(bgId, {
        tl: { col: 0, row: 0 } as any,
        br: { col: 7, row: 1 } as any,
        editAs: 'oneCell'
      });
    } catch (err) {
      console.error('Error adding header background image:', err);
    }
  }

  const headerRaw = ['# / الرقم', 'Room / الغرفة', 'Accommodation Degree / درجة الإقامة', 'Patient / اسم المريض', 'Contract / التعاقد', 'Speciality / التخصص', 'Date of Admission / تاريخ الدخول'];
  const headerRow = sheet.addRow(headerRaw);
  headerRow.height = 25;
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } };
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;

  ZONE_ORDER.forEach(zoneName => {
    const list = groupedZones[zoneName] || [];
    if (list.length === 0) return; 
    
    const colors = zoneColors[zoneName] || { badge: 'FF455A64', row: 'FFF5F7F8' };
    
    const startRow = sheet.rowCount + 1;
    sheet.addRow(['', '', '', '', '', '', '']);
    sheet.mergeCells(startRow, 1, startRow, 7);
    const separatorCell = sheet.getCell(startRow, 1);
    
    separatorCell.value = `■  ${zoneName} (Early Discharge Cases: ${list.length})  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(startRow).height = 26;

    list.forEach(p => {
      const category = getAccommodationCategory(p.room);
      
      let specialty = "Other / غير محدد";
      if (cumulativeMedicalPlans && cumulativeMedicalPlans.length > 0) {
        const plan = cumulativeMedicalPlans.find(plan => {
          if (plan.colD && p.name && isNameMatch(plan.colD, p.name)) return true;
          if (plan.colB && p.room && normalizeRoom(plan.colB) === normalizeRoom(p.room)) return true;
          return false;
        });
        if (plan && plan.colX) {
          const specVal = (plan.colX || "").trim();
          if (specVal) {
            specialty = specVal;
            const specLower = specialty.toLowerCase();
            if (specLower === "pulmonology" || specLower === "haematology") {
              specialty = "Internal Medicine";
            } else if (specLower === "general surgery" || specLower === "git surgery") {
              specialty = "General Surgery";
            } else if (specLower === "orthopedics" || specLower === "orthopedic surgery") {
              specialty = "Orthopaedic surgery";
            }
          }
        }
      }

      const pRow = sheet.addRow([serial++, p.room, category, p.name, p.contractor, specialty, p.date]);
      pRow.height = 24;
      pRow.eachCell((cell, colIndex) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.row } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        if (colIndex === 1 || colIndex === 2 || colIndex === 3 || colIndex === 4) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
        if (colIndex === 3) {
          const catColors: { [key: string]: string } = {
            "Day Case": "FF5C5A7F",
            "اقتصادي": "FFE65100",
            "مميز شمالي": "FF006064",
            "مميز جنوبي": "FF0D47A1",
            "أولي عاديه": "FF3E2723",
            "جونيور سويت": "FF4A148C",
            "امبريال سويت": "FFD81B60",
            "رويال سويت": "FF880E4F",
            "بانوراما": "FF1B5E20"
          };
          const colorHex = catColors[category];
          if (colorHex) {
            cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: colorHex } };
          }
        }
      });
    });
  });

  sheet.getColumn(1).width = 10;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 30;
  sheet.getColumn(4).width = 35;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 25;
  sheet.getColumn(7).width = 25;
}

app.get('/api/reports/early_discharge_cases', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Please upload data first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addEarlyDischargeCasesSheet(workbook, getOccupancyRows(hospitalData), earlyDischargeRoomsText);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Early_Discharge_Cases_Sheet_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Early Discharge Cases excel generation error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


function addCompanionStatusSheet(workbook: ExcelJS.Workbook, data: any[]) {
  const sheet = workbook.addWorksheet('Companion Status', {
    views: [{ rightToLeft: false }] 
  });

  // Exclude specific departments for companion status: ICU, PICU, NICU, CCU, SICU, VIP ISOLATION, VIP ICU, VIP CCU, and "OR"
  const COMPANION_EXCLUDED_DEPTS = ["ICU", "PICU", "NICU", "CCU", "SICU", "VIP ISOLATION", "VIP ICU", "VIP CCU"];
  
  // Sort and filter by department rank similar to occupancy, UNLESS the patient is a VIP
  const filteredData = data.filter(p => {
    const isVip = isPatientVip(p.colD);
    const room = String(p.colB || "").toUpperCase();
    const isExcludedDept = COMPANION_EXCLUDED_DEPTS.some(dept => room.includes(dept)) || room === "OR" || room.includes(" OR ") || room.startsWith("OR ") || room.endsWith(" OR");
    const isGlobalExcluded = ["DAY CASE", "DAYCASE", "HOMECARE", "WELLBABY", "DIALYSIS"].some(kw => room.includes(kw));
    return (!isExcludedDept || isVip) && !isGlobalExcluded;
  });

  const sortedData = [...filteredData].sort((a, b) => {
    const roomA = String(a.colB || "").toUpperCase();
    const roomB = String(b.colB || "").toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'بيان بالحالات المنومة و المرافقين';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1F5FE' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 8.0);

  const headerLabels = ['#', 'تاريخ الحجز', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'المرافق', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBBDEFB' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  const separatorColor = 'FFFCE4D6'; 
  let currentGroup: string | null = null;
  let serial = 1;

  sortedData.forEach((p) => {
    const roomStr = String(p.colB || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let group = "OTHER"; 
    
    // Determining group for separators
    if (roomNum >= 101 && roomNum <= 108) group = "1st Floor (101-108)";
    else if (roomNum >= 301 && roomNum <= 319) group = "301-319";
    else if (roomNum >= 320 && roomNum <= 329) group = "320-329";
    else if (roomNum >= 401 && roomNum <= 422) group = "4th Floor (401-422)";
    else if (roomStr.includes("VIP")) group = "VIP";

    if (currentGroup !== null && group !== currentGroup) {
      const sepRow = sheet.addRow(['', '', '', '', '', '', '', '']);
      sepRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: separatorColor } };
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
        };
      });
    }

    const isClosedUnit = COMPANION_EXCLUDED_DEPTS.some(dept => roomStr.includes(dept)) || roomStr === "OR" || roomStr.includes(" OR ") || roomStr.startsWith("OR ") || roomStr.endsWith(" OR");
    const rowValues = [serial++, p.colA, p.colB, p.colD, p.colW, p.colM, isClosedUnit ? "" : p.colI, isPatientVip(p.colD) ? "VIP" : ""];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
      if (colNumber === 8) {
        if (cell.value === "VIP") {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE8D6' } }; // Soft light VIP amber background
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD84315' } }; // Dark red/amber for VIP
        } else {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } };
        }
      }
    });
    currentGroup = group;
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 30;
  sheet.getColumn(6).width = 20;
  sheet.getColumn(7).width = 25;
  sheet.getColumn(8).width = 15;
}

async function addRefinedCompanionStatusSheet(workbook: ExcelJS.Workbook, data: any[]) {
  const sheet = workbook.addWorksheet('Formatted Companions', {
    views: [{ rightToLeft: false }] 
  });

  const COMPANION_EXCLUDED_DEPTS = ["ICU", "PICU", "NICU", "CCU", "SICU", "VIP ISOLATION", "VIP ICU", "VIP CCU"];
  
  const filteredData = data.filter(p => {
    const isVip = isPatientVip(p.colD);
    const room = String(p.colB || "").toUpperCase();
    const isExcludedDept = COMPANION_EXCLUDED_DEPTS.some(dept => room.includes(dept)) || isOperatingRoom(p.colB);
    const isGlobalExcluded = ["DAY CASE", "DAYCASE", "HOMECARE", "WELLBABY", "DIALYSIS"].some(kw => room.includes(kw));
    return (!isExcludedDept || isVip) && !isGlobalExcluded;
  });

  const sortedData = [...filteredData].sort((a, b) => {
    const getGroupLocal = (p: any): string => {
      const isVip = isPatientVip(p.colD);
      const roomStr = String(p.colB || "").toUpperCase();
      const isClosedUnitLocal = COMPANION_EXCLUDED_DEPTS.some(dept => roomStr.includes(dept)) || isOperatingRoom(p.colB);
      if (isVip && isClosedUnitLocal) {
        return "Closed Units";
      }
      const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
      if (roomNum >= 101 && roomNum <= 108) return "First Floor";
      if (roomNum >= 301 && roomNum <= 319) return "Zone A (301-319)";
      if (roomNum >= 320 && roomNum <= 329) return "Zone B (320-329)";
      if (roomNum >= 330 && roomNum <= 332) return "Zone C (330-332)";
      if (roomNum >= 401 && roomNum <= 422) return "4th Floor";
      if (roomStr.includes("VIP")) return "VIP";
      return "OTHER";
    };

    const GROUP_ORDER = [
      "Closed Units",
      "First Floor",
      "Zone A (301-319)",
      "Zone B (320-329)",
      "Zone C (330-332)",
      "4th Floor",
      "VIP",
      "OTHER"
    ];

    const groupA = getGroupLocal(a);
    const groupB = getGroupLocal(b);
    const idxA = GROUP_ORDER.indexOf(groupA);
    const idxB = GROUP_ORDER.indexOf(groupB);
    if (idxA !== idxB) return idxA - idxB;

    const roomA = String(a.colB || "").toUpperCase();
    const roomB = String(b.colB || "").toUpperCase();
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'بيان المرافقين', 8);

  const headerLabels = ['#', 'تاريخ الحجز', 'رقم الغرفة', 'اسم المريض', 'الطبيب المعالج', 'التعاقد', 'المرافق', 'VIP STATUS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }; // Dark business slate
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("CLOSED UNITS")) {
      return { badge: 'FFC62828', row: 'FFFDF2F2' }; // Rich crimson red and light rose background
    }
    if (g.includes("ICU") && !g.includes("VIP")) {
      return { badge: 'FF3F889E', row: 'FFEBF2F5' };
    }
    if (g.includes("SICU")) {
      return { badge: 'FF5C5A7F', row: 'FFF1EFF5' };
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' };
    }
    if (g.includes("CCU")) {
      return { badge: 'FF1565C0', row: 'FFEBF5FB' };
    }
    if (g.includes("NICU")) {
      return { badge: 'FFEF6C00', row: 'FFFFF5EB' };
    }
    if (g.includes("PICU")) {
      return { badge: 'FFAD1457', row: 'FFFFEBEF' };
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  let currentGroup: string | null = null;
  let serial = 1;

  sortedData.forEach((p) => {
    const isVip = isPatientVip(p.colD);
    const roomStr = String(p.colB || "").toUpperCase();
    const isClosedUnitByDept = COMPANION_EXCLUDED_DEPTS.some(dept => roomStr.includes(dept)) || roomStr === "OR" || roomStr.includes(" OR ") || roomStr.startsWith("OR ") || roomStr.endsWith(" OR");
    
    let group = "OTHER"; 
    if (isVip && isClosedUnitByDept) {
      group = "Closed Units";
    } else {
      const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
      if (roomNum >= 101 && roomNum <= 108) group = "First Floor";
      else if (roomNum >= 301 && roomNum <= 319) group = "Zone A (301-319)";
      else if (roomNum >= 320 && roomNum <= 329) group = "Zone B (320-329)";
      else if (roomNum >= 330 && roomNum <= 332) group = "Zone C (330-332)";
      else if (roomNum >= 401 && roomNum <= 422) group = "4th Floor";
      else if (roomStr.includes("VIP")) group = "VIP";
    }

    const rColors = getGroupColors(group);

    if (group !== currentGroup) {
      const sepRowIdx = sheet.rowCount + 1;
      sheet.addRow(['', '', '', '', '', '', '', '']);
      sheet.mergeCells(sepRowIdx, 1, sepRowIdx, 8);
      const separatorCell = sheet.getCell(sepRowIdx, 1);
      const displayGroupName = group === "VIP" ? "VIP ICU" : group;
      separatorCell.value = `■  ${displayGroupName}  ■`;
      separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
      separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
      separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getRow(sepRowIdx).height = 26;
    }

    const isClosedUnit = isClosedUnitByDept;
    const rowValues = [
      serial++, 
      p.colA, 
      p.colB, 
      p.colD, 
      p.colW, 
      p.colM, 
      isClosedUnit ? "" : p.colI,
      isPatientVip(p.colD) ? "VIP" : ""
    ];
    
    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;
    pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
      if (colNumber === 3 || colNumber === 4) {
        cell.font = { bold: true, name: 'Calibri', size: 11 };
      } else if (colNumber === 8) {
        if (cell.value === "VIP") {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE8D6' } }; // Soft light VIP amber background
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD84315' } }; // Elegant dark amber/red text
        } else {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFD32F2F' } };
        }
      }
    });
    currentGroup = group;
  });

  sheet.columns = [
    { width: 8 }, { width: 18 }, { width: 15 }, { width: 30 }, { width: 30 }, { width: 20 }, { width: 25 }, { width: 15 }
  ];
}

async function addRefinedExceedingALOSSheet(workbook: ExcelJS.Workbook, data: any[]) {
  const sheet = workbook.addWorksheet('Exceeding ALOS', {
    views: [{ rightToLeft: false }] 
  });

  const filteredData = data.filter(p => {
    const los = parseFloat(p.colS);
    const eliteAlos = parseFloat(p.colAL);
    return !isNaN(los) && !isNaN(eliteAlos) && los > eliteAlos;
  });

  const sortedData = [...filteredData].sort((a, b) => {
    const roomA = String(a.colB || "").toUpperCase();
    const roomB = String(b.colB || "").toUpperCase();
    
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };

    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;

    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;

    return roomA.localeCompare(roomB);
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, 'مرضى متجاوزي متوسط الإقامة', 7);

  const headerLabels = [
    '#', 
    'تاريخ الدخول / Admission Date', 
    'الغرفة / Room', 
    'المريض / Patient', 
    'التعاقد / Contractor', 
    'المدة الفعلية / Actual LOS', 
    'المدة المعيارية / Elite ALOS'
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF004D40' } }; // Deep teal
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  const getGroupColors = (groupName: string) => {
    const g = groupName.toUpperCase();
    if (g.includes("CLOSED UNITS") || g.includes("ICU") || g.includes("SICU") || g.includes("CCU") || g.includes("NICU") || g.includes("PICU")) {
      return { badge: 'FF004D40', row: 'FFE0F2F1' }; // Dark teal & light mint green
    }
    if (g.includes("VIP")) {
      return { badge: 'FF2E7D32', row: 'FFEBF5EB' }; // Rich green & soft light green
    }
    return { badge: 'FF455A64', row: 'FFF5F7F8' };
  };

  let currentGroup: string | null = null;
  let serial = 1;

  sortedData.forEach((p) => {
    const roomStr = String(p.colB || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let group = "OTHER"; 
    
    if (roomStr.includes("PICU")) group = "PICU";
    else if (roomStr.includes("NICU")) group = "NICU";
    else if (roomStr.includes("CCU")) group = "CCU";
    else if (roomStr.includes("SICU")) group = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) group = "VIP";
    else if (roomStr.includes("ICU")) group = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) group = "First Floor";
    else if (roomNum >= 301 && roomNum <= 319) group = "Zone A (301-319)";
    else if (roomNum >= 320 && roomNum <= 329) group = "Zone B (320-329)";
    else if (roomNum >= 330 && roomNum <= 332) group = "Zone C (330-332)";
    else if (roomNum >= 401 && roomNum <= 422) group = "4th Floor";

    const rColors = getGroupColors(group);

    if (group !== currentGroup) {
      const sepRowIdx = sheet.rowCount + 1;
      sheet.addRow(['', '', '', '', '', '', '']);
      sheet.mergeCells(sepRowIdx, 1, sepRowIdx, 7);
      const separatorCell = sheet.getCell(sepRowIdx, 1);
      
      const displayGroupName = group === "VIP" ? "VIP ICU" : group;
      separatorCell.value = `■  ${displayGroupName}  ■`;
      separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.badge } };
      separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
      separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getRow(sepRowIdx).height = 26;
    }

    const rowValues = [
      serial++, 
      p.colA, 
      p.colB, 
      p.colD, 
      p.colM, 
      p.colS, 
      p.colAL
    ];
    
    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;
    pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rColors.row } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
      if (colNumber === 3 || colNumber === 4) {
        cell.font = { bold: true, name: 'Calibri', size: 11 };
      }
      if (colNumber === 6) {
        cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFC62828' } }; 
      }
    });
    currentGroup = group;
  });

  sheet.columns = [
    { width: 8 }, { width: 18 }, { width: 15 }, { width: 35 }, { width: 25 }, { width: 15 }, { width: 15 }
  ];
}

async function buildRefinedORSheetTab(
  workbook: ExcelJS.Workbook,
  tabName: string,
  listDate: string,
  groupedFields: { groupTitle: string, items: any[], groupColors: { badge: string, row: string } }[]
) {
  const sheet = workbook.addWorksheet(tabName, {
    views: [{ rightToLeft: false }]
  });

  // Merge top title cell across 12 columns
  sheet.mergeCells('A1:L1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  const headerTitleText = listDate ? `لستة العمليات ليوم ${listDate} (${tabName})` : `لستة العمليات الجراحية (${tabName})`;
  await applyRefinedHeader(workbook, sheet, headerTitleText, 12);

  const headerLabels = [
    '#', 
    'الغرفة / OR Room',
    'البداية / Start Time', 
    'النهاية / End Time', 
    'المريض / Patient Name', 
    'الملف / MRN', 
    'العملية بالعربي / Ar Operation',
    'العملية بالإنجليزي / Eng Operation',
    'الجراح / Surgeon Name',
    'الأجهزة والتاور / Equipment',
    'الجهة / Contractor',
    'Status / حالة المريض'
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;

  groupedFields.forEach((group) => {
    if (group.items.length === 0) return;

    const gColors = group.groupColors;
    const sepRowIdx = sheet.rowCount + 1;
    sheet.addRow(Array(12).fill(''));
    sheet.mergeCells(sepRowIdx, 1, sepRowIdx, 12);
    const separatorCell = sheet.getCell(sepRowIdx, 1);
    
    separatorCell.value = `■  ${group.groupTitle}  (عدد الحالات: ${group.items.length})  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: gColors.badge } };
    separatorCell.font = { bold: true, size: 12, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(sepRowIdx).height = 26;

    group.items.forEach((p) => {
      const rowValues = [
        serial++, 
        p.orRoom, 
        p.startTime, 
        p.endTime, 
        p.patientName, 
        p.mrn, 
        p.arOperationName, 
        p.engOperationName, 
        p.surgeonName, 
        p.column2, 
        p.contractorName,
        p.dischargeStatus || 'Not Admitted / غير منوم'
      ];
      
      const pRow = sheet.addRow(rowValues);
      pRow.height = 24;
      pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: gColors.row } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
        
        if (colNumber === 5 || colNumber === 9) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
        if (colNumber === 12) {
          // Highlight discharged in soft red, admitted in soft green, etc
          if (String(p.dischargeStatus).includes('Discharged')) {
            cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFA10D0D' } };
          } else if (String(p.dischargeStatus).includes('Admitted')) {
            cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FF0A5C2C' } };
          }
        }
      });
    });
  });

  sheet.columns = [
    { width: 6 },   // Serial
    { width: 14 },  // OR Room
    { width: 12 },  // Start Time
    { width: 12 },  // End Time
    { width: 28 },  // Patient Name
    { width: 12 },  // MRN
    { width: 30 },  // Ar Op
    { width: 30 },  // Eng Op
    { width: 22 },  // Surgeon Name
    { width: 16 },  // Equipment
    { width: 22 },  // Contractor
    { width: 24 }   // Status
  ];
}

function isPrivateCreditCase(p: any): boolean {
  if (!p) return false;
  const fields = [
    p.vt,
    p.column2,
    p.column3,
    p.contractorName,
    p.paidBy,
    p.postC,
    p.flClassName,
    p.financialStatus,
    p.operativeComment
  ];
  return fields.some(field => {
    if (!field) return false;
    const str = String(field).toLowerCase();
    return str.includes("private credit") || str.includes("privatecredit");
  });
}

async function addRefinedORListSheet(workbook: ExcelJS.Workbook, data: any[], occRows: any[][] = []) {
  const listDate = data[0]?.orListDate || "";

  // Group 1: By IN-OUT (Column O / Column K status mapped dynamically)
  const inPatients: any[] = [];
  const outPatients: any[] = [];

  const enrichedList = getEnrichedOrListForStats(data, occRows);
  enrichedList.forEach(p => {
    if (p.realStatus === 'IN') {
      inPatients.push(p);
    } else {
      outPatients.push(p);
    }
  });

  const inOutGroups = [
    {
      groupTitle: 'In Patients (Currently Admitted) / داخل المستشفى',
      items: inPatients,
      groupColors: { badge: 'FF0D47A1', row: 'FFE3F2FD' }
    },
    {
      groupTitle: 'Out Patients (Not Admitted) / خارج المستشفى',
      items: outPatients,
      groupColors: { badge: 'FF004D40', row: 'FFE0F2F1' }
    }
  ];

  await buildRefinedORSheetTab(workbook, 'By IN-OUT', listDate, inOutGroups);

  // Group 2: By OR Room
  const roomsMap: { [key: string]: any[] } = {};
  enrichedList.forEach(p => {
    const r = String(p.orRoom || "OTHER").trim().toUpperCase();
    if (!roomsMap[r]) roomsMap[r] = [];
    roomsMap[r].push(p);
  });

  const getORColors = (room: string) => {
    const r = String(room).toUpperCase();
    if (r.includes("OR - 1")) return { badge: 'FF0D47A1', row: 'FFE3F2FD' }; 
    if (r.includes("OR - 2")) return { badge: 'FF1B5E20', row: 'FFE8F5E9' }; 
    if (r.includes("OR - 3")) return { badge: 'FF4A148C', row: 'FFF3E5F5' }; 
    if (r.includes("OR - 4")) return { badge: 'FF311B92', row: 'FFEDE7F6' }; 
    if (r.includes("OR - 5")) return { badge: 'FF004D40', row: 'FFE0F2F1' }; 
    if (r.includes("OR - 6")) return { badge: 'FF81C784', row: 'FFF1F8E9' }; 
    if (r.includes("OR - 7")) return { badge: 'FFD84315', row: 'FFFBE9E7' }; 
    return { badge: 'FF455A64', row: 'FFF5F7F8' }; 
  };

  const orRoomGroups = Object.keys(roomsMap).sort().map(rName => {
    return {
      groupTitle: rName,
      items: roomsMap[rName].sort((a,b) => parseInt(a.serial || "0") - parseInt(b.serial || "0")),
      groupColors: getORColors(rName)
    };
  });

  await buildRefinedORSheetTab(workbook, 'By OR Room', listDate, orRoomGroups);

  // Group 3: By HC-DC
  const hcPatients: any[] = [];
  const dcPatients: any[] = [];

  enrichedList.forEach(p => {
    if (isPrivateCreditCase(p)) {
      dcPatients.push(p);
      return;
    }
    const vtVal = String(p.vt || "").toUpperCase().trim();
    if (vtVal.includes("HC")) {
      hcPatients.push(p);
    } else if (vtVal.includes("DC")) {
      dcPatients.push(p);
    } else {
      const combined = `${p.vt} ${p.column3} ${p.postC} ${p.flClassName}`.toUpperCase();
      if (combined.includes("HC")) {
        hcPatients.push(p);
      } else if (combined.includes("DC")) {
        dcPatients.push(p);
      } else {
        dcPatients.push(p);
      }
    }
  });

  const hcDcGroups = [
    {
      groupTitle: 'Hospital Case (HC) / حالة مستشفى',
      items: hcPatients,
      groupColors: { badge: 'FF4A148C', row: 'FFF3E5F5' }
    },
    {
      groupTitle: 'Doctor Case (DC) / حالة طبيب',
      items: dcPatients,
      groupColors: { badge: 'FFD84315', row: 'FFFBE9E7' }
    }
  ];

  await buildRefinedORSheetTab(workbook, 'By HC-DC', listDate, hcDcGroups);
}

async function addRefinedORListSimpleSheet(workbook: ExcelJS.Workbook, data: any[], occRows: any[][] = []) {
  const sheet = workbook.addWorksheet('OR List - لستة العمليات', {
    views: [{ rightToLeft: false }]
  });

  const listDate = data[0]?.orListDate || "";
  const headerTitleText = listDate ? `لستة العمليات ليوم ${listDate}` : `ليستة العمليات الجراحية`;

  // Merge top title cell across 8 columns
  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, headerTitleText, 8);

  const headerLabels = [
    '#', 
    'التوقيت / Timing', 
    'غرفة العمليات / OR Room',
    'اسم المريض / Patient Name', 
    'العملية بالإنجليزي / Eng Operation',
    'الطبيب المعالج / Treating Physician',
    'نوع الحالة / Case Type',
    'Status / الحالة'
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  // Enrich data so if they have an occupancy match, we grab their name from occupancy!
  const enrichedList = getEnrichedOrListForStats(data, occRows);

  let serial = 1;

  enrichedList.forEach((p) => {
    const timingStr = (p.startTime || p.endTime) 
      ? `${p.startTime || '—'} - ${p.endTime || '—'}`
      : '—';

    const caseType = isPrivateCreditCase(p) ? 'DC' : 'HC';

    const rowValues = [
      serial++, 
      timingStr,
      p.orRoom || '—', 
      p.patientName || '—', 
      p.engOperationName || p.arOperationName || '—', 
      p.surgeonName || '—',
      caseType,
      p.dischargeStatus || 'Not Admitted / غير منوم'
    ];
    
    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;
    pRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      // Alternating row styling: subtle light background
      const rowColor = (serial % 2 === 0) ? 'FFFFFFFF' : 'FFF1EFF5';
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowColor } };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF000000' } };
      
      if (colNumber === 4 || colNumber === 6) {
        cell.font = { bold: true, name: 'Calibri', size: 11 };
      }
      if (colNumber === 7) {
        cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: caseType === 'DC' ? 'FF1565C0' : 'FF2E7D32' } };
      }
      if (colNumber === 8) {
        if (String(p.dischargeStatus).includes('Discharged')) {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FFA10D0D' } };
        } else if (String(p.dischargeStatus).includes('Admitted')) {
          cell.font = { bold: true, name: 'Calibri', size: 11, color: { argb: 'FF0A5C2C' } };
        }
      }
    });
  });

  sheet.columns = [
    { width: 6 },   // Serial
    { width: 20 },  // Timing
    { width: 16 },  // OR Room
    { width: 32 },  // Patient Name
    { width: 45 },  // Eng Op
    { width: 26 },  // Surgeon Name
    { width: 18 },  // Case Type (HC / DC)
    { width: 24 }   // Status
  ];
}

async function addRefinedORTimelineSheet(workbook: ExcelJS.Workbook, data: any[], occRows: any[][] = []) {
  const sheet = workbook.addWorksheet('OR Occupancy Timeline', {
    views: [{ rightToLeft: false }]
  });

  const listDate = data[0]?.orListDate || "";

  // Enrich patient list with matched names from the occupancy sheet
  const enrichedData = getEnrichedOrListForStats(data, occRows);

  // Helper to parse time string like "08:15" to minutes, supports AM/PM
  const parseToMinutes = (timeStr: string): number | null => {
    if (!timeStr) return null;
    const lower = String(timeStr).toLowerCase().trim();
    const isPM = lower.includes('pm') || lower.includes('مساءً') || lower.includes('م');
    const isAM = lower.includes('am') || lower.includes('صباحاً') || lower.includes('ص');
    
    const cleanStr = lower.replace(/[^0-9:]/g, '');
    const parts = cleanStr.split(':');
    if (parts.length >= 2) {
      let h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!isNaN(h) && !isNaN(m)) {
        if (isPM && h < 12) {
          h += 12;
        } else if (isAM && h === 12) {
          h = 0;
        }
        return h * 60 + m;
      }
    }
    return null;
  };

  // Find actual first case start time and last case end time
  let minMins = 24 * 60; // default initial max
  let maxMins = 0; // default initial min
  let validCaseCount = 0;

  const parsedPatients = enrichedData.map(p => {
    const startMins = parseToMinutes(p.startTime);
    const endMins = parseToMinutes(p.endTime);
    if (startMins !== null && endMins !== null && endMins > startMins) {
      if (startMins < minMins) minMins = startMins;
      if (endMins > maxMins) maxMins = endMins;
      validCaseCount++;
      return { ...p, startMins, endMins };
    }
    return { ...p, startMins: null, endMins: null };
  });

  // Fallbacks if list is empty or unparsable
  if (validCaseCount === 0 || minMins >= maxMins) {
    minMins = 8 * 60; // 08:00 AM
    maxMins = 18 * 60; // 06:00 PM
  } else {
    // Round minMins down to previous hour and maxMins up to next hour to give clean bounds
    minMins = Math.floor(minMins / 60) * 60;
    maxMins = Math.ceil(maxMins / 60) * 60;
  }

  // Define 30-minute slots from minMins to maxMins
  const slots: { start: number; end: number; label: string }[] = [];
  for (let m = minMins; m < maxMins; m += 30) {
    const startH = Math.floor(m / 60);
    const startM = m % 60;
    const endH = Math.floor((m + 30) / 60);
    const endM = (m + 30) % 60;
    const formatTime = (h: number, min: number) => {
      const hh = String(h).padStart(2, '0');
      const mm = String(min).padStart(2, '0');
      return `${hh}:${mm}`;
    };
    slots.push({
      start: m,
      end: m + 30,
      label: `${formatTime(startH, startM)} - ${formatTime(endH, endM)}`
    });
  }

  const numSlots = slots.length;

  // Render header title (Row 1)
  sheet.mergeCells(1, 1, 1, numSlots + 1);
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  const titleText = listDate ? `صورة بيانية لإشغال غرف العمليات ليوم ${listDate}` : `مخطط بياني لإشغال غرف العمليات`;
  await applyRefinedHeader(workbook, sheet, titleText, numSlots + 1);

  // Spacer Row (Row 2)
  sheet.addRow(Array(numSlots + 1).fill(''));
  sheet.getRow(2).height = 15;

  // Header Row (Row 3): Column A is Room, Columns B.. are the time slots
  const headerLabels = ['غرفة العمليات / Operating Room', ...slots.map(s => s.label)];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 28;
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C34' } }; // Dark teal
    cell.font = { bold: true, name: 'Calibri', size: 10, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'medium', color: { argb: 'FF000000' } },
      bottom: { style: 'medium', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
      right: { style: 'thin', color: { argb: 'FFFFFFFF' } }
    };
  });

  // Group data by Room
  const roomsMap: { [key: string]: any[] } = {};
  parsedPatients.forEach(p => {
    const r = String(p.orRoom || "OTHER").trim().toUpperCase();
    if (!roomsMap[r]) roomsMap[r] = [];
    roomsMap[r].push(p);
  });

  const roomsList = Object.keys(roomsMap).sort();

  // Helper function to write a Time Guide row at a specific row number
  const writeTimeGuideRow = (rowNum: number) => {
    // Column 1 is Room column, we write "Time Guide / دليل الوقت"
    const guideCell = sheet.getCell(rowNum, 1);
    guideCell.value = 'Time Guide / دليل الوقت';
    guideCell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    guideCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C34' } }; // Dark Teal
    guideCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    guideCell.border = {
      top: { style: 'medium', color: { argb: 'FF0B3C34' } },
      bottom: { style: 'medium', color: { argb: 'FF0B3C34' } },
      left: { style: 'medium', color: { argb: 'FF0B3C34' } },
      right: { style: 'medium', color: { argb: 'FF0B3C34' } }
    };

    // Columns 2..numSlots + 1 will have the slot labels
    for (let sIdx = 0; sIdx < numSlots; sIdx++) {
      const cell = sheet.getCell(rowNum, sIdx + 2);
      cell.value = slots[sIdx].label;
      cell.font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF1E293B' } }; // Slate 800
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; // Slate 100/50 light
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF0B3C34' } },
        bottom: { style: 'medium', color: { argb: 'FF0B3C34' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
      };
    }
    sheet.getRow(rowNum).height = 28;
  };

  let currentRowNum = 4; // Start at row 4 since Row 1 is Title, Row 2 is Spacer, Row 3 is Header

  // 1. Write the Time Guide row at the beginning (top of the room list)
  writeTimeGuideRow(currentRowNum);
  currentRowNum++;

  // For each room, allocate surgical lanes and create rows dynamically
  roomsList.forEach((roomName) => {
    const patientsInRoom = roomsMap[roomName];

    // Filter to patients in this room with parsed start and end times
    const validPatients = patientsInRoom.filter(p => p.startMins !== null && p.endMins !== null && p.endMins > p.startMins);

    if (validPatients.length === 0) {
      // If there are no cases with valid times in this room, create a single row for the room so it still appears
      const rowNum = currentRowNum;
      currentRowNum++;

      const roomCell = sheet.getCell(rowNum, 1);
      roomCell.value = roomName;
      roomCell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FF0B3C34' } };
      roomCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF3F5' } };
      roomCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      roomCell.border = {
        top: { style: 'thin', color: { argb: 'FFB0BEC5' } },
        bottom: { style: 'thin', color: { argb: 'FFB0BEC5' } },
        left: { style: 'medium', color: { argb: 'FF0B3C34' } },
        right: { style: 'thin', color: { argb: 'FFB0BEC5' } }
      };

      // Initialize slot cells
      for (let sIdx = 0; sIdx < numSlots; sIdx++) {
        const cell = sheet.getCell(rowNum, sIdx + 2);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      }
      sheet.getRow(rowNum).height = 45;
      return;
    }

    // Allocate lanes dynamically using the overlap algorithm
    const sorted = [...validPatients].sort((a, b) => (a.startMins || 0) - (b.startMins || 0));
    const lanes: any[][] = [];
    sorted.forEach(p => {
      let assignedLaneIdx = -1;
      for (let l = 0; l < lanes.length; l++) {
        const currentLane = lanes[l];
        const hasOverlap = currentLane.some(existing => {
          return p.startMins < existing.endMins && p.endMins > existing.startMins;
        });
        if (!hasOverlap) {
          assignedLaneIdx = l;
          break;
        }
      }
      if (assignedLaneIdx === -1) {
        lanes.push([p]);
      } else {
        lanes[assignedLaneIdx].push(p);
      }
    });

    const startRoomRow = currentRowNum;
    const endRoomRow = currentRowNum + lanes.length - 1;

    // For each lane, render its own row
    lanes.forEach((lanePatients, laneIdx) => {
      const rowNum = currentRowNum + laneIdx;

      // Fill first cell with Room Name
      const roomCell = sheet.getCell(rowNum, 1);
      roomCell.value = roomName;
      roomCell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FF0B3C34' } };
      roomCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF3F5' } };
      roomCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      roomCell.border = {
        top: { style: 'thin', color: { argb: 'FFB0BEC5' } },
        bottom: { style: 'thin', color: { argb: 'FFB0BEC5' } },
        left: { style: 'medium', color: { argb: 'FF0B3C34' } },
        right: { style: 'thin', color: { argb: 'FFB0BEC5' } }
      };

      // Initialize slot cells with light empty background grid
      for (let sIdx = 0; sIdx < numSlots; sIdx++) {
        const cell = sheet.getCell(rowNum, sIdx + 2);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      }

      // Plot patients allocated to this specific lane
      lanePatients.forEach(p => {
        // Find which slots this case overlaps
        let startSlotIdx = Math.floor((p.startMins - minMins) / 30);
        let endSlotIdx = Math.ceil((p.endMins - minMins) / 30) - 1;

        // Bound to valid range
        startSlotIdx = Math.max(0, startSlotIdx);
        endSlotIdx = Math.min(numSlots - 1, endSlotIdx);

        if (endSlotIdx >= startSlotIdx) {
          const startCol = startSlotIdx + 2;
          const endCol = endSlotIdx + 2;

          // Merge if spanning multiple columns
          try {
            if (endCol > startCol) {
              sheet.mergeCells(rowNum, startCol, rowNum, endCol);
            }
          } catch (mErr) {
            // catch silently
          }

          const targetCell = sheet.getCell(rowNum, startCol);
          targetCell.value = `${p.patientName}\n(Dr. ${p.surgeonName || '—'})\n[${p.startTime} - ${p.endTime}]`;

          // Use attractive colors depending on HC vs DC or VIP status
          const isVip = String(p.patientName || "").match(/(VIP|important|سعادة|الامير|امير|شيخ|شيخة)/i) || 
            String(p.flClassName || "").toUpperCase().includes("VIP") ||
            (p.vipStatus && String(p.vipStatus).trim() !== "");

          const isHc = (String(p.vt || "").toUpperCase().includes("HC") ||
            (!String(p.vt || "").toUpperCase().includes("DC") && `${p.vt} ${p.column3} ${p.postC} ${p.flClassName}`.toUpperCase().includes("HC"))) &&
            !isPrivateCreditCase(p);

          let blockColor = 'FFE3F2FD'; // Soft theme-light blue
          let textColor = 'FF0D47A1'; // Deep Indigo
          let borderColor = 'FF90CAF9';

          if (isVip) {
            blockColor = 'FFF8F1DB'; // Elegant gold-sand tint
            textColor = 'FF8D6E63'; // Brownish gold
            borderColor = 'FFE0E0E0';
          } else if (isHc) {
            blockColor = 'FFF3E5F5'; // Soft purple-lavender
            textColor = 'FF4A148C'; // Deep purple
            borderColor = 'FFD1C4E9';
          } else {
            // DC (Day Care) case
            blockColor = 'FFE8F5E9'; // Soft medical green
            textColor = 'FF1B5E20'; // Clean deep forest green
            borderColor = 'FFA5D6A7';
          }

          // Format merged block
          for (let c = startCol; c <= endCol; c++) {
            const blockCell = sheet.getCell(rowNum, c);
            blockCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: blockColor } };
            blockCell.font = { bold: true, name: 'Calibri', size: 9, color: { argb: textColor } };
            blockCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            blockCell.border = {
              top: { style: 'medium', color: { argb: borderColor } },
              bottom: { style: 'medium', color: { argb: borderColor } },
              left: { style: 'medium', color: { argb: borderColor } },
              right: { style: 'medium', color: { argb: borderColor } }
            };
          }
        }
      });

      // Set height for lane row
      sheet.getRow(rowNum).height = 68;
    });

    // Merge Room Name vertically across all allocated rows of the room, if multiple lanes exist
    if (endRoomRow > startRoomRow) {
      try {
        sheet.mergeCells(startRoomRow, 1, endRoomRow, 1);
        
        // Ensure styling and alignment persist across the merged cell
        const mergedRoomCell = sheet.getCell(startRoomRow, 1);
        mergedRoomCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      } catch (mergeErr) {
        // catch silently
      }
    }

    currentRowNum += lanes.length;
  });

  // 2. Write the Time Guide row at the end (bottom of the room list)
  writeTimeGuideRow(currentRowNum);
  currentRowNum++;

  // Set widths: Column A is Room (width 32), all slots columns are width 18
  sheet.getColumn(1).width = 32;
  for (let sIdx = 0; sIdx < numSlots; sIdx++) {
    sheet.getColumn(sIdx + 2).width = 18;
  }
}

app.get('/api/reports/or_timeline_refined', async (req, res) => {
  if (cumulativeORList.length === 0) return res.status(400).json({ error: 'No OR list data available. Please upload the OR list sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
    await addRefinedORTimelineSheet(workbook, cumulativeORList, occRows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Operating_Room_Timeline_Graphics_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined OR Timeline Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/or_list_refined', async (req, res) => {
  if (cumulativeORList.length === 0) return res.status(400).json({ error: 'No OR list data available. Please upload the OR list sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
    await addRefinedORListSheet(workbook, cumulativeORList, occRows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Operating_Room_Schedule_Refined.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined OR List Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/or_list_simple_refined', async (req, res) => {
  if (cumulativeORList.length === 0) return res.status(400).json({ error: 'No OR list data available. Please upload the OR list sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
    await addRefinedORListSimpleSheet(workbook, cumulativeORList, occRows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Operating_Room_List_Refined_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined Simple OR List Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

function isOrXRoom(roomStr: string): boolean {
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
         /\bor\b/i.test(bLower) || 
         /\bor\d+/i.test(bLower) || 
         /\bor\s*-\s*\d+/i.test(bLower);
}

function getOverListPatients(data: any[][] | null, orList: any[]): any[] {
  const overList: any[] = [];
  
  if (data && data.length > 0) {
    // Find startIdx
    let startIdx = 3;
    for(let i = 0; i < Math.min(data.length, 10); i++) {
        const r1 = String(data[i][1] || "").toLowerCase();
        const r3 = String(data[i][3] || "").toLowerCase();
        if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name")) {
            startIdx = i + 1;
            break;
        }
    }
    
    if (data.length > startIdx) {
      const rawBody = data.slice(startIdx);
      const occRows = getOccupancyRows(data);
      
      rawBody.forEach((row, index) => {
        const room = String(row[1] || "").trim();
        const patientName = String(row[3] || "").trim();
        const mrn = String(row[2] || "").trim();
        const physician = String(row[22] || "").trim();
        
        // Check if the room is OR-x
        if (isOrXRoom(room) && patientName) {
          // Explicitly exclude "حسام الدين عبدالله عبدالقادر علي" from being considered overlist
          if (isNameMatch(patientName, "حسام الدين عبدالله عبدالقادر علي")) {
            return;
          }
          // Check if this patient is in the uploaded OR list
          const existsInOrList = orList.some(orPt => isNameMatch(patientName, orPt.patientName || ""));
          if (!existsInOrList) {
            const standardRoom = findAdmittedRoomForInPatient(patientName, occRows, mrn, physician);
            const displayPatientRoom = (standardRoom && !standardRoom.startsWith("Not Found") && !isOperatingRoom(standardRoom)) ? standardRoom : "N/A";

            overList.push({
              id: `over-list-${index}`,
              room: room, // OR Room
              patientRoom: displayPatientRoom, // Regular hospital/admitted room
              patientName: patientName,
              physician: physician,
              contractor: String(row[12] || "").trim(),
              admissionDate: cleanAdmissionDateStr(row[0]),
              mrn: mrn,
              category: getAccommodationCategory(displayPatientRoom)
            });
          }
        }
      });
    }
  }

  // Also append overlist patients that are in cumulativeDischarged
  cumulativeDischarged.forEach((p, idx) => {
    if (isOrXRoom(p.room) && p.name) {
      if (isNameMatch(p.name, "حسام الدين عبدالله عبدالقادر علي")) {
        return;
      }
      const existsInOrList = orList.some(orPt => isNameMatch(p.name, orPt.patientName || ""));
      if (!existsInOrList) {
        const isAlreadyAdded = overList.some(olPt => isNameMatch(olPt.patientName, p.name));
        if (!isAlreadyAdded) {
          overList.push({
            id: `over-list-disc-${idx}`,
            room: p.room, // OR Room
            patientRoom: "Discharged / تم الخروج",
            patientName: p.name,
            physician: p.physician || '',
            contractor: p.contractor || '',
            admissionDate: p.date || '',
            mrn: p.id || p.mrn || '',
            category: 'N/A',
            isDischarged: true
          });
        }
      }
    }
  });
  
  return overList;
}

async function addRefinedOROverListSheet(workbook: ExcelJS.Workbook, overListPatients: any[]) {
  const sheet = workbook.addWorksheet('Over-Listed OR Cases', {
    views: [{ rightToLeft: false }]
  });

  const headerTitleText = `Over-Listed OR Cases`;

  // Merge top title cell across columns
  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, headerTitleText, 8);

  const headerLabels = [
    '#', 
    'غرفة المريض / Patient Room',
    'غرفة العمليات / OR Room',
    'اسم المريض / Patient Name', 
    'الرقم الطبي / MRN',
    'الطبيب المعالج / Treating Physician',
    'الجهة المتعاقدة / Contractor',
    'تاريخ الدخول / Admission Date'
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC2185B' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;

  overListPatients.forEach((p) => {
    const rowValues = [
      serial++,
      p.patientRoom || 'N/A',
      p.room,
      p.patientName,
      p.mrn || '',
      p.physician || '',
      p.contractor || '',
      p.admissionDate || ''
    ];

    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;
    pRow.eachCell((cell) => {
      cell.font = { size: 10, name: 'Calibri', color: { argb: 'FF333333' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
      };
    });
  });

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 25; 
  sheet.getColumn(3).width = 25; 
  sheet.getColumn(4).width = 30; 
  sheet.getColumn(5).width = 18; 
  sheet.getColumn(6).width = 30; 
  sheet.getColumn(7).width = 25; 
  sheet.getColumn(8).width = 25; 
}

async function addRefinedORReconciliationSheet(
  workbook: ExcelJS.Workbook,
  orList: any[],
  occRows: any[][],
  overList: any[]
) {
  const sheet = workbook.addWorksheet('OR Reconciliation - مطابقة العمليات', {
    views: [{ rightToLeft: false }]
  });

  const headerTitleText = `Formal TOTAL OR List`;

  // Merge top title cell across 9 columns (A to I)
  sheet.mergeCells('A1:I1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, headerTitleText, 9);

  const headerLabels = [
    '#', 
    'غرفة المريض / Patient Room',
    'غرفة العمليات / OR Room',
    'اسم المريض / Patient Name', 
    'الرقم الطبي / MRN',
    'الطبيب المعالج / Treating Physician',
    'الجهة المتعاقدة / Contractor',
    'تاريخ الدخول / Admission Date',
    'الحالة بمطابقة اللستة / Status'
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00796B' } }; // Teal
    cell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      bottom: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      left: { style: 'thin', color: { argb: 'FFB2B2B2' } },
      right: { style: 'thin', color: { argb: 'FFB2B2B2' } }
    };
  });

  let serial = 1;

  // 1. Process all OR list cases
  const enrichedList = getEnrichedOrListForStats(orList, occRows);
  
  enrichedList.forEach((p) => {
    let displayPatientRoom = 'N/A';
    let displayAdmissionDate = '';
    let displayMRN = '';
    let displayContractor = '';
    const isAdmitted = p.realStatus === 'IN';

    const occPatient = findOccupancyPatient(p.patientName, occRows, false, p.mrn, p.surgeonName);

    if (occPatient) {
      displayPatientRoom = occPatient.room || 'N/A';
      displayAdmissionDate = occPatient.admissionDate || p.admissionDate || '';
      displayMRN = occPatient.mrn || p.mrn || '';
      displayContractor = occPatient.contractor || p.contractorName || p.contractor || '';
    } else {
      const matchingDischargedObj = cumulativeDischarged.find(discPt => {
        const matchByName = isNameMatch(p.patientName, discPt.name || "");
        const matchByMrn = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
        return matchByName || matchByMrn;
      });

      if (matchingDischargedObj) {
        displayAdmissionDate = matchingDischargedObj.date || p.admissionDate || '';
        displayMRN = p.mrn || matchingDischargedObj.id || matchingDischargedObj.mrn || '';
        displayContractor = p.contractorName || p.contractor || matchingDischargedObj.contractor || '';
      } else {
        displayAdmissionDate = p.admissionDate || '';
        displayMRN = p.mrn || '';
        displayContractor = p.contractorName || p.contractor || '';
      }

      if (isAdmitted && p.isDischarged) {
        displayPatientRoom = p.dischargedFromRoom || 'N/A';
      }
    }

    const finalStatusText = p.isDischarged 
      ? (p.dischargedFromRoom ? `On List - Discharged (Room ${p.dischargedFromRoom}) / في اللستة - تم الخروج (غرفة ${p.dischargedFromRoom})` : 'On List - Discharged / في اللستة - تم الخروج')
      : (isAdmitted ? 'On List - Currently Admitted / في اللستة - منوم حالياً' : 'On List - Not Admitted / في اللستة - غير منوم');

    const rowValues = [
      serial++,
      displayPatientRoom,
      p.orRoom || p.room || 'OTHER',
      p.patientName,
      displayMRN,
      p.surgeonName || p.physician || '',
      displayContractor,
      displayAdmissionDate || p.admissionDate || '',
      finalStatusText
    ];

    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;

    pRow.eachCell((cell, colNumber) => {
      cell.font = { size: 10, name: 'Calibri', color: { argb: 'FF333333' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };

      if (colNumber === 9) {
        if (p.isDischarged) {
          cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFA10D0D' } }; 
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEBEE' } }; 
        } else if (isAdmitted) {
          cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FF2E7D32' } }; 
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }; 
        } else {
          cell.font = { size: 10, name: 'Calibri', color: { argb: 'FF555555' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }; 
        }
      }
    });
  });

  // 2. Process all detected Over List cases
  overList.forEach((p) => {
    const rowValues = [
      serial++,
      p.patientRoom || 'N/A',
      p.room,
      p.patientName,
      p.mrn || '',
      p.physician || '',
      p.contractor || '',
      p.admissionDate || '',
      p.isDischarged 
        ? 'Over List - Discharged / خارج اللستة - تم الخروج'
        : 'Over List - Currently Admitted / خارج اللستة - منوم حالياً'
    ];

    const pRow = sheet.addRow(rowValues);
    pRow.height = 24;

    pRow.eachCell((cell, colNumber) => {
      cell.font = { size: 10, name: 'Calibri', color: { argb: 'FF333333' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
        right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
      };

      if (colNumber === 9) {
        if (p.isDischarged) {
          cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFC2185B' } }; // Pink color
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } }; 
        } else {
          cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFC62828' } }; 
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEBEE' } }; 
        }
      }
    });
  });

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 25; 
  sheet.getColumn(3).width = 25; 
  sheet.getColumn(4).width = 30; 
  sheet.getColumn(5).width = 18; 
  sheet.getColumn(6).width = 30; 
  sheet.getColumn(7).width = 25; 
  sheet.getColumn(8).width = 25; 
  sheet.getColumn(9).width = 30; 
}

app.get('/api/reports/or_reconciliation_refined', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
    const overList = getOverListPatients(hospitalData, cumulativeORList);
    await addRefinedORReconciliationSheet(workbook, cumulativeORList, occRows, overList);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Operating_Room_Reconciliation_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined OR Reconciliation Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/or_over_list_refined', async (req, res) => {
  const overList = getOverListPatients(hospitalData, cumulativeORList);
  try {
    const workbook = new ExcelJS.Workbook();
    await addRefinedOROverListSheet(workbook, overList);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Over_Listed_OR_Cases_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined Over List Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Helper to normalize the accommodation category name from flClassName (Column Q)
function normalizeCategoryName(catStr: string): string {
  const s = String(catStr || "").toLowerCase().trim();
  if (s.includes("daycase") || s.includes("day case") || s.includes("day") || s.includes("يوم") || s.includes("day_case")) {
    return "Day Case";
  }
  if (s.includes("اقتصادي") || s.includes("اقتصادى") || s.includes("economy")) {
    return "اقتصادي";
  }
  if (s.includes("أولى") || s.includes("أولي") || s.includes("عادية") || s.includes("عاديه") || s.includes("first class") || s.includes("اولى")) {
    return "أولي عاديه";
  }
  if (s.includes("جنوبي") || s.includes("south")) {
    return "مميز جنوبي";
  }
  if (s.includes("شمالي") || s.includes("north")) {
    return "مميز شمالي";
  }
  if (s.includes("جونيور") || s.includes("junior")) {
    return "جونيور سويت";
  }
  if (s.includes("رويال") || s.includes("royal")) {
    return "رويال سويت";
  }
  if (s.includes("بانوراما") || s.includes("panorama")) {
    return "بانوراما";
  }
  return "";
}

// Arabic string normalization helper for robust names matching
function normalizeArabicString(str: string): string {
  if (!str) return "";
  let s = str
    .replace(/[أإآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/[ىي]/g, "ي")
    .replace(/[ئؤ]/g, "ء")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^\w\s\u0600-\u06FF]/g, " ") // keep letters, numbers, and arabic
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

  // Normalize compound name parts without spaces
  s = s.replace(/عبد\s+/g, "عبد");
  s = s.replace(/\s+الدين/g, "الدين");
  s = s.replace(/روديناء/g, "رودينا");
  return s;
}

// Check for manual name equivalents or partial overrides to successfully map English/Arabic or spelling variants
function isManualEquivalent(n1: string, n2: string): boolean {
  const low1 = String(n1 || "").toLowerCase().trim();
  const low2 = String(n2 || "").toLowerCase().trim();
  const isPascal1 = low1.includes("باسكال") || low1.includes("pascal");
  const isJean1 = low1.includes("jeaneldie") || low1.includes("nzola") || low1.includes("mpaka");
  const isPascal2 = low2.includes("باسكال") || low2.includes("pascal");
  const isJean2 = low2.includes("jeaneldie") || low2.includes("nzola") || low2.includes("mpaka");

  if ((isPascal1 && isJean2) || (isJean1 && isPascal2)) {
    return true;
  }

  const norm1 = normalizeArabicString(n1);
  const norm2 = normalizeArabicString(n2);

  if (norm1.startsWith("يوسف محمد") && norm2.startsWith("يوسف محمد")) {
    return true;
  }
  if (norm1.startsWith("عبدالرحمن") && norm2.startsWith("عبدالرحمن")) {
    return true;
  }
  if ((norm1.startsWith("gahad") || norm1.startsWith("جهاد")) && (norm2.startsWith("gahad") || norm2.startsWith("جهاد"))) {
    return true;
  }
  if ((norm1.startsWith("رودينا") || norm1.startsWith("روديناء")) && (norm2.startsWith("رودينا") || norm2.startsWith("روديناء"))) {
    return true;
  }
  return false;
}

// Robust whole-name comparison helper
function isWholeNameMatch(name1: string, name2: string, isTaggedOut: boolean = false): boolean {
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
    // If tagged as OUT on the OR list, we require a very strict whole name match
    // to prevent any accidental false positives.
    return (uniqueIntersection.length >= 3 && matchRatio >= 0.75) || (norm1 === norm2);
  }

  // Standard patient name matching
  if (minUniqueSize >= 3) {
    return uniqueIntersection.length >= 3;
  } else {
    // Single or 2-word overlap must be exact match
    return norm1 === norm2;
  }
}

function isPhysicianMatch(p1: string, p2: string): boolean {
  if (!p1 || !p2) return false;
  const clean1 = p1.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const clean2 = p2.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean1 || !clean2) return false;
  if (clean1 === clean2) return true;

  const w1 = clean1.split(" ").filter(w => w.length > 2);
  const w2 = clean2.split(" ").filter(w => w.length > 2);

  if (w1.length === 0 || w2.length === 0) return false;

  const set1 = new Set(w1);
  const set2 = new Set(w2);
  const intersection = [...set1].filter(w => set2.has(w));

  const minSize = Math.min(set1.size, set2.size);
  if (intersection.length >= 2) return true;
  if (minSize === 1 && intersection.length === 1) return true;
  return false;
}

const englishToArabicMap: Record<string, string> = {
  'sara': 'ساره',
  'fathy': 'فتحي',
  'haidy': 'هايدي',
  'medhat': 'مدحت',
  'samira': 'سميره',
  'saleman': 'سليمان',
  'gahad': 'جهاد',
  'mohamed': 'محمد'
};

function transliterateWord(w: string): string {
  return englishToArabicMap[w.toLowerCase()] || w;
}

function getFirstWord(name: string): string {
  const norm = normalizeArabicString(name);
  if (!norm) return "";
  const firstWord = norm.split(" ")[0] || "";
  return transliterateWord(firstWord);
}

function isPatientFirstNameMatch(name1: string, name2: string): boolean {
  const w1 = getFirstWord(name1);
  const w2 = getFirstWord(name2);
  return w1 === w2 && w1.length > 0;
}

function isMRNMatch(mrn1: string, mrn2: string): boolean {
  if (!mrn1 || !mrn2) return false;
  const clean1 = mrn1.trim().replace(/^0+/, "").replace(/[^0-9a-zA-Z]/g, "");
  const clean2 = mrn2.trim().replace(/^0+/, "").replace(/[^0-9a-zA-Z]/g, "");
  if (!clean1 || !clean2) return false;
  return clean1 === clean2;
}

// Helper to search for and find actual admitted room of an "IN" patient using MRN match, Physician + First Name match, or whole name match
function findAdmittedRoomForInPatient(pName: string, occRows: any[][], mrn?: string, surgeonName?: string): string {
  if (!occRows || occRows.length === 0) return "Not Found in Occupancy Sheet / غير موجود بشيت الإشغال";
  
  const searchName = String(pName || "").trim();
  const searchMRN = String(mrn || "").trim();
  const searchSurgeonName = String(surgeonName || "").trim();
  if (!searchName && !searchMRN) return "N/A";

  const rows = occRows.slice(3);

  // 1. Try matching by MRN first! (highest accuracy)
  if (searchMRN) {
    for (const row of rows) {
      const occMRN = String(row[5] || "").trim();
      if (isMRNMatch(searchMRN, occMRN)) {
        return String(row[0] || "").trim(); // Return room number
      }
    }
  }

  // 2. Try matching by First Name + Physician Match (high accuracy)
  if (searchName && searchSurgeonName) {
    for (const row of rows) {
      const occName = String(row[1] || "").trim();
      const occPhysician = String(row[2] || "").trim();
      if (isPhysicianMatch(searchSurgeonName, occPhysician) && isPatientFirstNameMatch(searchName, occName)) {
        return String(row[0] || "").trim(); // Return room number
      }
    }
  }
  
  // 3. Fallback to exact or robust whole-name comparison
  if (searchName) {
    for (const row of rows) {
      const occName = String(row[1] || "").trim();
      if (isWholeNameMatch(searchName, occName, false)) {
        return String(row[0] || "").trim(); // Return room number
      }
    }
  }

  return "Not Found in Occupancy Sheet / غير موجود بشيت الإشغال";
}

// Helper to lookup room number and patient data from source occupancy sheet using robust MRN, Physician + First Name, or whole-name comparison
function findOccupancyPatient(pName: string, occRows: any[][], isTaggedOut: boolean = false, mrn?: string, surgeonName?: string) {
  if (!occRows || occRows.length === 0) return null;
  
  const searchName = String(pName || "").trim();
  const searchMRN = String(mrn || "").trim();
  const searchSurgeonName = String(surgeonName || "").trim();
  if (!searchName && !searchMRN) return null;

  const rows = occRows.slice(3);
  
  // 1. Try matching by MRN first! (highest accuracy, skipping OR rooms)
  if (searchMRN) {
    for (const row of rows) {
      const roomStr = String(row[0] || "").trim();
      if (isOperatingRoom(roomStr)) continue; // OR rooms are excluded!
      
      const occMRN = String(row[5] || "").trim();
      if (isMRNMatch(searchMRN, occMRN)) {
        return {
          room: roomStr,
          patientName: String(row[1] || "").trim(),
          physician: String(row[2] || "").trim(),
          contractor: String(row[3] || "").trim(),
          admissionDate: String(row[4] || "").trim(),
          mrn: occMRN
        };
      }
    }
  }

  // 2. Try matching by First Name + Physician Match (high accuracy, skipping OR rooms)
  if (searchName && searchSurgeonName) {
    for (const row of rows) {
      const roomStr = String(row[0] || "").trim();
      if (isOperatingRoom(roomStr)) continue; // OR rooms are excluded!

      const occName = String(row[1] || "").trim();
      const occPhysician = String(row[2] || "").trim();
      if (isPhysicianMatch(searchSurgeonName, occPhysician) && isPatientFirstNameMatch(searchName, occName)) {
        return {
          room: roomStr,
          patientName: occName,
          physician: occPhysician,
          contractor: String(row[3] || "").trim(),
          admissionDate: String(row[4] || "").trim(),
          mrn: String(row[5] || "").trim()
        };
      }
    }
  }

  // 3. Fallback to exact or robust whole-name comparison (skipping operating rooms)
  if (searchName) {
    for (const row of rows) {
      const roomStr = String(row[0] || "").trim();
      if (isOperatingRoom(roomStr)) continue; // OR rooms are excluded!
      
      const occName = String(row[1] || "").trim();
      if (isWholeNameMatch(searchName, occName, isTaggedOut)) {
        return {
          room: roomStr,
          patientName: occName,
          physician: String(row[2] || "").trim(),
          contractor: String(row[3] || "").trim(),
          admissionDate: String(row[4] || "").trim(),
          mrn: String(row[5] || "").trim()
        };
      }
    }
  }

  return null;
}

// Function to compute vacant rooms on-the-fly grouped by category
function getAvailableVacantRooms(): { [key: string]: string[] } {
  const occupiedRooms = new Set<string>();
  if (hospitalData) {
    getOccupancyRows(hospitalData).slice(3).forEach(row => {
      const roomStr = String(row[0] || "").trim();
      const norm = normalizeRoom(roomStr);
      if (norm) {
        occupiedRooms.add(norm);
      }
    });
  }

  // "306" is excluded from general vacant pools (Rule 5: 306 is for Panorama only)
  // 108 is excluded as well (Rule 4: 108 cannot have admitted patients)
  const MENTIONED_ROOMS = [
    "301", "302", "303", "304", "305", "401 A", "401 B", "402 A", "402 B", "403 A", "403 B", "404 A", "404 B", "405 A", "405 B",
    "315", "316", "317", "320", "321", "322", "323", "324", "325", "326", "327",
    "415", "416", "417", "418", "419", "420", "421", "422",
    "307", "308", "318", "319", "328", "329", "406", "407", "409", "410", "411",
    "309", "310", "311", "312", "313", "314", "412", "413", "414",
    "408"
  ];

  const vacantRoomsRaw: string[] = [];

  MENTIONED_ROOMS.forEach(room => {
    // Exclude 108 and 320 explicitly
    if (room === "108") return;

    const match = room.match(/^(40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1];
      const variant = match[2];
      
      const isBaseOccupied = occupiedRooms.has(base);
      const isAOccupied = occupiedRooms.has(`${base}A`);
      const isBOccupied = occupiedRooms.has(`${base}B`);
      
      if (isBaseOccupied || isAOccupied) {
        // occupied
      } else if (isBOccupied) {
        if (variant === 'A') {
          vacantRoomsRaw.push(room);
        }
      } else {
        vacantRoomsRaw.push(room);
      }
    } else {
      const norm = normalizeRoom(room);
      if (norm === "108" || norm === "306") return;
      if (!occupiedRooms.has(norm)) {
        vacantRoomsRaw.push(room);
      }
    }
  });

  const emptyRoomsSet = new Set(vacantRoomsRaw);
  const vacantRooms: string[] = [];
  const processedBases = new Set<string>();

  vacantRoomsRaw.forEach(room => {
    const match = room.match(/^(40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1];
      if (emptyRoomsSet.has(`${base} A`) && emptyRoomsSet.has(`${base} B`)) {
        if (!processedBases.has(base)) {
          vacantRooms.push(base);
          processedBases.add(base);
        }
      } else {
        vacantRooms.push(room);
      }
    } else {
      vacantRooms.push(room);
    }
  });

  const groupedVacant: { [key: string]: string[] } = {
    "Day Case": [],
    "اقتصادي": [],
    "أولي عاديه": [],
    "مميز جنوبي": [],
    "مميز شمالي": [],
    "جونيور سويت": [],
    "امبريال سويت": [],
    "رويال سويت": [],
    "بانوراما": []
  };

  vacantRooms.forEach(room => {
    const cat = getAccommodationCategory(room);
    if (groupedVacant[cat]) {
      groupedVacant[cat].push(room);
    }
  });

  return groupedVacant;
}

// Function to construct the newly requested OR Admissions Sheet
async function addORAdmissionsSheet(workbook: ExcelJS.Workbook, orList: any[], occRows: any[][]) {
  const sheet = workbook.addWorksheet('بيان تسكين حالات ليستة العمليات', {
    views: [{ rightToLeft: false }]
  });

  const headerTitleText = 'بيان تسكين حالات ليستة العمليات';
  
  // Merge top title cell across columns
  const numCols = 10;
  const range = `A1:${String.fromCharCode(64 + numCols)}1`; // 10 columns: A to J
  sheet.mergeCells(range);
  const titleCell = sheet.getCell('A1');
  titleCell.value = '';
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  await applyRefinedHeader(workbook, sheet, headerTitleText, numCols);

  // Group into IN (admitted) and OUT (needs suggestion)
  const inPatients: any[] = [];
  const outPatients: any[] = [];

  orList.forEach(p => {
    const vt = String(p.vt || "").toUpperCase().trim();
    const column3 = String(p.column3 || "").toUpperCase().trim();
    const flClassName = String(p.flClassName || "").toUpperCase().trim();
    const postC = String(p.postC || "").toUpperCase().trim();

    // Check if the patient is explicitly tagged as OUT (Daycase, Outpatient, etc.) on the OR list sheet
    const isTaggedOut = vt === "DC" || vt.includes("OUT") || vt.includes("DAY") || vt.includes("DAYCASE") ||
                        column3.includes("OUT") || column3.includes("DC") || 
                        flClassName.includes("OUT") || flClassName.includes("DAY") || flClassName.includes("DAYCASE") ||
                        postC.includes("OUT") || postC.includes("DC");

    // Double check for the whole name in comparison to the source occupancy sheet
    const occPatient = findOccupancyPatient(p.patientName, occRows, isTaggedOut, p.mrn, p.surgeonName);
    const matchingDischargedObj = cumulativeDischarged.find(discPt => {
      const matchByName = isNameMatch(p.patientName, discPt.name || "");
      const matchByMrn = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
      return matchByName || matchByMrn;
    });
    const isDischarged = !!matchingDischargedObj;

    if (occPatient || isDischarged) {
      // Already admitted (IN)
      const dischargedFromRoom = matchingDischargedObj ? (matchingDischargedObj.room || matchingDischargedObj.id || '') : '';
      inPatients.push({
        ...p,
        patientName: occPatient ? (occPatient.patientName || p.patientName) : p.patientName,
        roomDisplay: occPatient ? occPatient.room : (dischargedFromRoom ? `Discharged / تم الخروج (غرفة ${dischargedFromRoom})` : "Discharged / تم الخروج"),
        surgeonName: occPatient ? (occPatient.physician || p.surgeonName) : p.surgeonName,
        contractorName: occPatient ? (occPatient.contractor || p.contractorName) : p.contractorName,
        isMatchedFromOccupancy: true,
        isDischarged,
        dischargedFromRoom
      });
    } else {
      // Not yet admitted (needs suggestion -> outPatients)
      outPatients.push(p);
    }
  });

  // State-tracking sets for already occupied or currently assigned beds/rooms
  const occupiedOrAssigned = new Set<string>();
  const bookedAsWholePrivate = new Set<string>();

  // Determine if Room 306 is actually occupied in the uploaded Excel sheet
  let room306ActuallyOccupied = false;
  if (occRows && occRows.length > 3) {
    room306ActuallyOccupied = occRows.slice(3).some(row => normalizeRoom(String(row[0] || "")) === "306");
  }

  // Initialize with currently occupied rooms/beds from the Excel sheet
  if (occRows && occRows.length > 3) {
    occRows.slice(3).forEach(row => {
      const roomStr = String(row[0] || "").trim();
      const norm = normalizeRoom(roomStr);
      if (norm) {
        occupiedOrAssigned.add(norm);
        // If a whole first floor room like "101" is already recorded as occupied,
        // it serves as a booked private room.
        if (["101", "102", "103", "104", "105", "106", "107"].includes(norm)) {
          bookedAsWholePrivate.add(norm);
        }
        // If a whole 4th floor suite like "401" to "405" is already occupied as a whole,
        // it serves as a booked Royal Suite.
        if (["401", "402", "403", "404", "405"].includes(norm)) {
          bookedAsWholePrivate.add(norm);
        }
      }
    });
  }

  // Pre-block 108 securely per Rule 4
  occupiedOrAssigned.add("108");
  occupiedOrAssigned.add("108-1");
  occupiedOrAssigned.add("108-2");
  bookedAsWholePrivate.add("108");

  // Prevent Panorama "306" from being booked in general inpatient pools
  occupiedOrAssigned.add("306");

  // Categories we have for automatic upgrades (ordered from lowest to highest)
  const CATEGORY_PRIORITY = [
    "Day Case",
    "اقتصادي",
    "أولي عاديه",
    "جونيور سويت",
    "مميز جنوبي",
    "مميز شمالي",
    "امبريال سويت",
    "رويال سويت",
    "بانوراما"
  ];

  // -------------------------------------------------------------
  // Dynamic First Floor Bed Allocator (each separate bed is اقتصادي or Day Case)
  // -------------------------------------------------------------
  const findVacantFirstFloorBed = (): string => {
    const firstFloorBases = ["101", "104", "105"];
    for (const base of firstFloorBases) {
      for (const suff of ["-1", "-2"]) {
        const bedName = base + suff;
        const normBed = normalizeRoom(bedName);
        const normWhole = normalizeRoom(base);

        // Bed is vacant if the bed itself is not occupied AND the room is not private whole-room locked
        if (!occupiedOrAssigned.has(normBed) && !bookedAsWholePrivate.has(normWhole)) {
          occupiedOrAssigned.add(normBed);
          return bedName;
        }
      }
    }
    return "";
  };

  // -------------------------------------------------------------
  // Dynamic Room Allocator for normal inpatient categories
  // -------------------------------------------------------------
  const findVacantRoomForCategory = (category: string, randomize: boolean = false): string => {
    // Day Case category
    if (category === "Day Case") {
      return findVacantFirstFloorBed();
    }

    // اقتصادي category
    if (category === "اقتصادي") {
      return findVacantFirstFloorBed();
    }

    // 1. أولي عادية
    if (category === "أولي عاديه") {
      const candidates = ["307", "308", "318", "319", "328", "329", "406", "407", "409", "410", "411"];
      const vacantCandidates = candidates.filter(item => !occupiedOrAssigned.has(normalizeRoom(item)));
      if (vacantCandidates.length > 0) {
        const chosen = randomize 
          ? vacantCandidates[Math.floor(Math.random() * vacantCandidates.length)] 
          : vacantCandidates[0];
        if (chosen) {
          occupiedOrAssigned.add(normalizeRoom(chosen));
          return chosen;
        }
      }
      return "";
    }

    // 2. مميز جنوبي
    if (category === "مميز جنوبي") {
      // General 1st/3rd/4th Floor premium south rooms
      const mainCandidates = ["102", "103", "106", "107", "315", "316", "317", "321", "322", "323", "324", "325", "326", "327", "415", "416", "417", "418", "419", "420", "421", "422"];
      const vacantMain = mainCandidates.filter(item => !occupiedOrAssigned.has(normalizeRoom(item)));

      if (vacantMain.length > 0) {
        const chosen = randomize 
          ? vacantMain[Math.floor(Math.random() * vacantMain.length)] 
          : vacantMain[0];
        occupiedOrAssigned.add(normalizeRoom(chosen));
        return chosen;
      }
      return "";
    }

    // 3. مميز شمالي
    if (category === "مميز شمالي") {
      const mainCandidates = ["301", "302", "303", "304", "305"];
      // Check split A/B beds for flexible 4th floor rooms (401 to 405)
      const suiteBases = ["401", "402", "403", "404", "405"];
      // First floor rooms are no longer available as Premium North

      const getVacantFlexibleSuites = () => {
        const results: { base: string; suffix: string; bedName: string }[] = [];
        for (const base of suiteBases) {
          const normWhole = normalizeRoom(base);
          if (!bookedAsWholePrivate.has(normWhole) && !occupiedOrAssigned.has(normWhole)) {
            for (const suffix of [" A", " B"]) {
              const bedName = base + suffix;
              const normBed = normalizeRoom(bedName);
              if (!occupiedOrAssigned.has(normBed)) {
                results.push({ base, suffix, bedName });
              }
            }
          }
        }
        return results;
      };

      const vacantMain = mainCandidates.filter(item => !occupiedOrAssigned.has(normalizeRoom(item)));
      const vacantSplit = getVacantFlexibleSuites();

      const allOptions = [
        ...vacantMain.map(item => ({ type: 'main', value: item })),
        ...vacantSplit.map(item => ({ type: 'split', value: item.bedName }))
      ];

      if (allOptions.length > 0) {
        const chosen = randomize 
          ? allOptions[Math.floor(Math.random() * allOptions.length)] 
          : allOptions[0];
        
        occupiedOrAssigned.add(normalizeRoom(chosen.value));
        return chosen.value;
      }
      return "";
    }

    // 4. جونيور سويت
    if (category === "جونيور سويت") {
      const candidates = ["309", "310", "311", "312", "313", "412", "413", "414"];
      const vacantCandidates = candidates.filter(item => !occupiedOrAssigned.has(normalizeRoom(item)));
      if (vacantCandidates.length > 0) {
        const chosen = randomize 
          ? vacantCandidates[Math.floor(Math.random() * vacantCandidates.length)] 
          : vacantCandidates[0];
        occupiedOrAssigned.add(normalizeRoom(chosen));
        return chosen;
      }
      return "";
    }

    // امبريال سويت
    if (category === "امبريال سويت") {
      const candidates = ["330 A", "330 B", "331 A", "331 B"];
      const vacantCandidates = candidates.filter(item => !occupiedOrAssigned.has(normalizeRoom(item)));
      if (vacantCandidates.length > 0) {
        const chosen = randomize 
          ? vacantCandidates[Math.floor(Math.random() * vacantCandidates.length)] 
          : vacantCandidates[0];
        occupiedOrAssigned.add(normalizeRoom(chosen));
        return chosen;
      }
      return "";
    }

    // 5. رويال سويت
    if (category === "رويال سويت") {
      const mainCandidates = ["408"];
      const wholeSuiteCandidates = ["401", "402", "403", "404", "405"];

      const getVacantWholeSuites = () => {
        return wholeSuiteCandidates.filter(base => {
          const normWhole = normalizeRoom(base);
          const normA = normalizeRoom(base + " A");
          const normB = normalizeRoom(base + " B");
          return !occupiedOrAssigned.has(normWhole) &&
                 !occupiedOrAssigned.has(normA) &&
                 !occupiedOrAssigned.has(normB) &&
                 !bookedAsWholePrivate.has(normWhole);
        });
      };

      const vacantMain = mainCandidates.filter(item => !occupiedOrAssigned.has(normalizeRoom(item)));
      const vacantWhole = getVacantWholeSuites();

      const allOptions = [
        ...vacantMain.map(item => ({ type: 'main', value: item })),
        ...vacantWhole.map(item => ({ type: 'whole', value: item }))
      ];

      if (allOptions.length > 0) {
        const chosen = randomize 
          ? allOptions[Math.floor(Math.random() * allOptions.length)] 
          : allOptions[0];
        
        if (chosen.type === 'main') {
          occupiedOrAssigned.add(normalizeRoom(chosen.value));
          return chosen.value;
        } else {
          const base = chosen.value;
          const normWhole = normalizeRoom(base);
          const normA = normalizeRoom(base + " A");
          const normB = normalizeRoom(base + " B");

          occupiedOrAssigned.add(normWhole);
          occupiedOrAssigned.add(normA);
          occupiedOrAssigned.add(normB);
          bookedAsWholePrivate.add(normWhole);
          return base;
        }
      }
      return "";
    }

    // بانوراما category
    if (category === "بانوراما") {
      if (!room306ActuallyOccupied) {
        room306ActuallyOccupied = true;
        // Also remove "306" from occupiedOrAssigned so that it doesn't cause conflicting state checks
        occupiedOrAssigned.delete("306");
        return "306";
      }
      return "";
    }

    return "";
  };

  // -------------------------------------------------------------
  // Dynamic Day Case Allocator (kept for backwards compatibility but calls findVacantFirstFloorBed)
  // -------------------------------------------------------------
  const findVacantDaycaseRoom = (): string => {
    return findVacantFirstFloorBed();
  };

  // Map each patient
  const processedIn = inPatients.map(p => {
    if (p.isMatchedFromOccupancy) {
      return {
        ...p,
        statusGroup: 'IN'
      };
    }
    const matchedRoom = findAdmittedRoomForInPatient(p.patientName, occRows, p.mrn, p.surgeonName);
    return {
      ...p,
      statusGroup: 'IN',
      roomDisplay: matchedRoom
    };
  });

  const outWithIdx = outPatients.map((p, idx) => ({ ...p, originalIdx: idx }));

  const checkFlexible = (p: any): boolean => {
    const qVal = String(p.flClassName || "").toLowerCase();
    const isPC = isPrivateCreditCase(p);
    
    const vt = String(p.vt || "").toUpperCase().trim();
    const column3 = String(p.column3 || "").toUpperCase().trim();
    const postC = String(p.postC || "").toUpperCase().trim();

    const isTaggedOut = vt === "DC" || vt.includes("OUT") || vt.includes("DAY") || vt.includes("DAYCASE") ||
                        column3.includes("OUT") || column3.includes("DC") || 
                        postC.includes("OUT") || postC.includes("DC");

    const isDC = qVal.includes("daycase") || 
                 qVal.includes("day case") || 
                 qVal.includes("day") || 
                 qVal.includes("يوم") ||
                 isPC ||
                 isTaggedOut;

    const isSICU = String(p.orRoom || "").toUpperCase().includes("SICU") || 
                   String(p.flClassName || "").toUpperCase().includes("SICU") || 
                   String(p.vt || "").toUpperCase().includes("SICU");

    const isPanorama306 = String(p.orRoom || "").trim() === "306" || 
                          normalizeCategoryName(p.flClassName) === "بانوراما";

    if (isDC || isSICU || isPanorama306) {
      return false; 
    }

    const requestedCategory = normalizeCategoryName(p.flClassName);
    const flClassLower = String(p.flClassName || "").toLowerCase();
    const isFlexible = !requestedCategory ||
                       flClassLower.includes("تعاقد") || 
                       flClassLower.includes("مريض") || 
                       flClassLower.includes("التعاقد") || 
                       flClassLower.includes("contract") || 
                       flClassLower.includes("patient");
    return isFlexible;
  };

  // Partition OUT patients based on whether their accommodation contains "حسب" (leave preferred room empty),
  // or checks as predefined/flexible
  const hasabCases = outWithIdx.filter(p => String(p.flClassName || "").includes("حسب"));
  const preDefinedCases = outWithIdx.filter(p => !String(p.flClassName || "").includes("حسب") && !checkFlexible(p));
  const flexibleCases = outWithIdx.filter(p => !String(p.flClassName || "").includes("حسب") && checkFlexible(p));

  const roomAssignments = new Map<number, string>();

  // Assign "" directly for "حسب" cases so they do not consume any rooms
  hasabCases.forEach(p => {
    roomAssignments.set(p.originalIdx, "");
  });

  // 1. Process Pre-defined Cases
  preDefinedCases.forEach(p => {
    const qVal = String(p.flClassName || "").toLowerCase();
    const isPC = isPrivateCreditCase(p);
    const vt = String(p.vt || "").toUpperCase().trim();
    const column3 = String(p.column3 || "").toUpperCase().trim();
    const postC = String(p.postC || "").toUpperCase().trim();

    // Check if explicitly tagged as OUT or Day Case on the uploaded OR list
    const isTaggedOut = vt === "DC" || vt.includes("OUT") || vt.includes("DAY") || vt.includes("DAYCASE") ||
                        column3.includes("OUT") || column3.includes("DC") || 
                        postC.includes("OUT") || postC.includes("DC");

    const isDC = qVal.includes("daycase") || 
                 qVal.includes("day case") || 
                 qVal.includes("day") || 
                 qVal.includes("يوم") ||
                 isPC ||
                 isTaggedOut;

    // Check if SICU (Rule 3: SICU is admitted to SICU according to bed number)
    const isSICU = String(p.orRoom || "").toUpperCase().includes("SICU") || 
                   String(p.flClassName || "").toUpperCase().includes("SICU") || 
                   String(p.vt || "").toUpperCase().includes("SICU");

    const isPanorama306 = String(p.orRoom || "").trim() === "306" || 
                          normalizeCategoryName(p.flClassName) === "بانوراما";

    let suggestedRoom = "";

    if (isSICU) {
      // Rule 3: Admit to SICU according to bed number (SICU 1 to 5)
      let foundSicuBed = "";
      for (let b = 1; b <= 5; b++) {
        const sicuBedName = `SICU ${b}`;
        const normSicu = normalizeRoom(sicuBedName);
        if (!occupiedOrAssigned.has(normSicu)) {
          foundSicuBed = sicuBedName;
          break;
        }
      }
      if (foundSicuBed) {
        occupiedOrAssigned.add(normalizeRoom(foundSicuBed));
        suggestedRoom = `${foundSicuBed} - SICU`;
      } else {
        suggestedRoom = "no available beds / لا توجد أسرة رعاية جراحية شاغرة";
      }
    } else {
      // Unified hierarchy category allocator with upgrade distribution
      let requestedCategory = normalizeCategoryName(p.flClassName);
      
      if (!requestedCategory) {
        if (isDC) {
          requestedCategory = "Day Case";
        } else if (isPanorama306) {
          requestedCategory = "بانوراما";
        }
      }

      let foundRoom = "";
      let foundCat = "";

      // Try the requested category first
      foundRoom = findVacantRoomForCategory(requestedCategory, false);
      if (foundRoom) {
        foundCat = requestedCategory;
      } else {
        // Upgrade category (search higher categories in priority list)
        // Upgrade is not allowed to panorama or royal, the ceiling is "مميز شمالي" (اولى مميز شمالي)
        const reqIdx = CATEGORY_PRIORITY.indexOf(requestedCategory);
        if (reqIdx !== -1) {
          const ceilingIdx = CATEGORY_PRIORITY.indexOf("مميز شمالي");
          for (let i = reqIdx + 1; i <= ceilingIdx; i++) {
            const catName = CATEGORY_PRIORITY[i];
            foundRoom = findVacantRoomForCategory(catName, false);
            if (foundRoom) {
              foundCat = catName;
              break;
            }
          }
        }
      }

      if (foundRoom) {
        if (foundCat !== requestedCategory) {
          suggestedRoom = `${foundRoom} - ${foundCat} (ترقية لعدم التوفر / Upgraded due to unavailability)`;
        } else {
          suggestedRoom = `${foundRoom} - ${foundCat}`;
        }
      } else {
        suggestedRoom = "no available rooms / لا توجد غرف شاغرة";
      }
    }

    roomAssignments.set(p.originalIdx, suggestedRoom);
  });

  // 2. Process Flexible ("حسب التعاقد") Cases randomly!
  flexibleCases.forEach(p => {
    let suggestedRoom = "";
    let foundRoom = "";
    let foundCat = "";

    // Try categories sequentially in a completely shuffled (randomized) order to distribute randomly
    const shuffledCategories = [...CATEGORY_PRIORITY].sort(() => Math.random() - 0.5);
    for (const catName of shuffledCategories) {
      foundRoom = findVacantRoomForCategory(catName, true); // randomize = true!
      if (foundRoom) {
        foundCat = catName;
        break;
      }
    }

    if (foundRoom) {
      suggestedRoom = `${foundRoom} - ${foundCat}`;
    } else {
      suggestedRoom = "no available rooms / لا توجد غرف شاغرة";
    }

    roomAssignments.set(p.originalIdx, suggestedRoom);
  });

  const processedOut = outWithIdx.map(p => {
    const isHasab = String(p.flClassName || "").includes("حسب");
    let roomDisp = roomAssignments.get(p.originalIdx);
    if (isHasab) {
      roomDisp = "";
    } else if (roomDisp === undefined) {
      roomDisp = "no available rooms / لا توجد غرف شاغرة";
    }
    return {
      ...p,
      statusGroup: 'OUT',
      roomDisplay: roomDisp
    };
  });

  // Re-group or list
  const headerLabels = [
    '#', 
    'Operating Room / غرفة العمليات',
    'Patient Name / اسم المريض', 
    'MRN / رقم الملف', 
    'Requested Accomm (Q) / الفئة المطلوبة Q', 
    'Assigned/Suggested Room / الغرفة والدرجة المقترحة', 
    'Visit Type / نوع الزيارة',
    'Surgeon / الجراح',
    'Arabic Operation / العملية عربي',
    'Status / حالة المريض'
  ];

  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } }; // Royal Blue
    cell.font = { bold: true, size: 10, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
    };
  });

  const sections = [
    {
      title: 'Admitted Inpatients (IN) / مرضى منومين حالياً بالمستشفى',
      items: processedIn,
      badgeColor: 'FF0B3C34', // Dark Teal
      rowColor: 'FFEBF3F5',
      indicator: 'Currently Admitted / منوم حالياً'
    },
    {
      title: 'Suggested Admissions (OUT) / مقترحات دخول وغرف لمرضى العمليات الخارجية',
      items: processedOut,
      badgeColor: 'FF1E293B', // Slate 800
      rowColor: 'FFF1F5F9',
      indicator: 'Needs Admission / يحتاج تنويم'
    }
  ];

  let serial = 1;

  sections.forEach(sec => {
    if (sec.items.length === 0) return;

    // Add separator header
    const sepRowIdx = sheet.rowCount + 1;
    sheet.addRow(Array(10).fill(''));
    sheet.mergeCells(sepRowIdx, 1, sepRowIdx, 10);
    const separatorCell = sheet.getCell(sepRowIdx, 1);
    
    separatorCell.value = `■  ${sec.title}  (عدد الحالات: ${sec.items.length})  ■`;
    separatorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sec.badgeColor } };
    separatorCell.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
    separatorCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(sepRowIdx).height = 26;

    sec.items.forEach(p => {
      const isDischarged = p.isDischarged || String(p.roomDisplay || "").startsWith("Discharged");
      const statusText = isDischarged 
        ? (p.dischargedFromRoom ? `Discharged (Room ${p.dischargedFromRoom}) / تم الخروج (غرفة ${p.dischargedFromRoom})` : 'Discharged / تم الخروج') 
        : sec.indicator;

      const rowVal = [
        serial++,
        p.orRoom,
        p.patientName,
        p.mrn,
        p.flClassName || "N/A",
        p.roomDisplay,
        p.vt || "N/A",
        p.surgeonName || "N/A",
        p.arOperationName || p.engOperationName || "N/A",
        statusText
      ];

      const pRow = sheet.addRow(rowVal);
      pRow.height = 24;
      pRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sec.rowColor } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          bottom: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          left: { style: 'thin', color: { argb: 'FFD2D7D9' } },
          right: { style: 'thin', color: { argb: 'FFD2D7D9' } }
        };
        cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF000000' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

        // Make patient name, suggested room pop a bit
        if (colNum === 3 || colNum === 6) {
          cell.font = { bold: true, name: 'Calibri', size: 10, color: { argb: 'FF0F172A' } };
        }
        
        // Highlight "no available rooms" or "Discharged"
        if (colNum === 6 && String(cell.value || "").toLowerCase().includes("no available")) {
          cell.font = { bold: true, name: 'Calibri', size: 10, color: { argb: 'FFB91C1C' } }; // Dark red
        }
        if (colNum === 6 && isDischarged) {
          cell.font = { bold: true, name: 'Calibri', size: 10, color: { argb: 'FFA10D0D' } }; // Soft red
        }
        if (colNum === 10 && isDischarged) {
          cell.font = { bold: true, name: 'Calibri', size: 10, color: { argb: 'FFA10D0D' } }; // Soft red
        }
      });
    });
  });

  // Set column widths elegantly
  sheet.columns = [
    { width: 6 },   // Serial
    { width: 18 },  // OR Room
    { width: 28 },  // Patient Name
    { width: 14 },  // MRN
    { width: 24 },  // Requested Category
    { width: 32 },  // Suggested Room
    { width: 12 },  // Visit Type
    { width: 22 },  // Surgeon name
    { width: 28 },  // Operation
    { width: 16 }   // Status
  ];
}

app.get('/api/reports/or_admissions', async (req, res) => {
  if (cumulativeORList.length === 0) {
    return res.status(400).json({ error: 'No OR list data available. Please upload the OR list sheet first.' });
  }
  try {
    const workbook = new ExcelJS.Workbook();
    const occRows = hospitalData ? getOccupancyRows(hospitalData) : [];
    await addORAdmissionsSheet(workbook, cumulativeORList, occRows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="OR_Admissions_Sheet_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('OR Admissions Report Generation Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/exceeding_alos_refined', async (req, res) => {
  if (cumulativeLOS.length === 0) return res.status(400).json({ error: 'No LOS data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addRefinedExceedingALOSSheet(workbook, cumulativeLOS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Exceeding_ALOS_Refined.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined Exceeding ALOS Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/companion_status_refined', async (req, res) => {
  if (cumulativeCompanionStatus.length === 0) return res.status(400).json({ error: 'No companion status data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await addRefinedCompanionStatusSheet(workbook, cumulativeCompanionStatus);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Companion_Status_Refined.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Refined Companion Status Report Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/companion_status', async (req, res) => {
  if (cumulativeCompanionStatus.length === 0) return res.status(400).json({ error: 'No companion status data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addCompanionStatusSheet(workbook, cumulativeCompanionStatus);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Companion_Status.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Companion Status Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

function addLOSSheet(workbook: ExcelJS.Workbook, data: any[]) {
  const sheet = workbook.addWorksheet('LOS Sheet', {
    views: [{ rightToLeft: false }] 
  });

  sheet.mergeCells('A1:H1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'LOS Sheet';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E5F5' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  const headerLabels = ['#', 'تاريخ الحجز', 'رقم الغرفة', 'اسم المريض', 'التعاقد', 'LOS', 'ALOS', 'Elite ALOS'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1BEE7' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  const separatorColor = 'FFFCE4D6'; 
  let currentGroup: string | null = null;
  let serial = 1;

  // Sorting by room number/department rank
  const sortedData = [...data].sort((a, b) => {
    const roomA = String(a.colB || "").toUpperCase();
    const roomB = String(b.colB || "").toUpperCase();
    const getRank = (str: string) => {
      if (str.includes("PICU")) return 6;
      if (str.includes("NICU")) return 5;
      if (str.includes("CCU")) return 4;
      if (str.includes("SICU")) return 3;
      if (str.includes("VIP") || str.includes("VIP ISOLATION")) return 2;
      if (str.includes("ICU")) return 1;
      return 10;
    };
    const rankA = getRank(roomA);
    const rankB = getRank(roomB);
    if (rankA !== rankB) return rankA - rankB;
    const numA = parseInt(roomA.match(/\d+/)?.[0] || "0");
    const numB = parseInt(roomB.match(/\d+/)?.[0] || "0");
    if (numA !== numB) return numA - numB;
    return roomA.localeCompare(roomB);
  });

  sortedData.forEach((p) => {
    const roomStr = String(p.colB || "").toUpperCase();
    const roomNum = parseInt(roomStr.match(/\d+/)?.[0] || "0");
    let group = "OTHER"; 
    if (roomStr.includes("PICU")) group = "PICU";
    else if (roomStr.includes("NICU")) group = "NICU";
    else if (roomStr.includes("CCU")) group = "CCU";
    else if (roomStr.includes("SICU")) group = "SICU";
    else if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) group = "VIP";
    else if (roomStr.includes("ICU")) group = "ICU";
    else if (roomNum >= 101 && roomNum <= 108) group = "1st Floor (101-108)";
    else if (roomNum >= 301 && roomNum <= 319) group = "301-319";
    else if (roomNum >= 320 && roomNum <= 329) group = "320-329";
    else if (roomNum >= 401 && roomNum <= 422) group = "4th Floor (401-422)";
    else if (!isNaN(roomNum) && roomNum > 0) group = "FLOOR_" + Math.floor(roomNum / 100); 

    if (currentGroup !== null && group !== currentGroup) {
      const sepRow = sheet.addRow(['', '', '', '', '', '', '', '']);
      sepRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: separatorColor } };
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
        };
      });
    }

    const rowValues = [serial++, p.colA, p.colB, p.colD, p.colM, p.colS, p.colU, p.colAL];
    const pRow = sheet.addRow(rowValues);
    pRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
      };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Calibri', size: 11 };
    });
    currentGroup = group;
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 20;
  sheet.getColumn(7).width = 20;
  sheet.getColumn(8).width = 20;
}

app.get('/api/reports/los_sheet', async (req, res) => {
  if (cumulativeLOS.length === 0) return res.status(400).json({ error: 'No LOS data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addLOSSheet(workbook, cumulativeLOS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=LOS_Sheet.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('LOS Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

function addInpatientSummarySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Inpatient Summary', {
    views: [{ rightToLeft: false }]
  });

  const normalizeRoom = (roomStr: string) => {
    let r = String(roomStr || "").toUpperCase().trim();
    const numMatch = r.match(/\d+/);
    const num = numMatch ? numMatch[0] : "";
    
    if (r.includes("NICU")) return "NICU" + num;
    if (r.includes("PICU")) return "PICU" + num;
    if (r.includes("SICU")) return "SICU" + num;
    if (r.includes("CCU")) return "CCU" + num;
    if (r.includes("VIP")) return "VIP" + num;
    if (r.includes("ICU")) return "ICU" + num;
    
    if (r.includes("401") || r.includes("402") || r.includes("403") || r.includes("404") || r.includes("405")) {
      const baseNumMatch = r.match(/40[1-5]/);
      const baseNum = baseNumMatch ? baseNumMatch[0] : num;
      const suffix = r.includes("A") ? "A" : (r.includes("B") ? "B" : "");
      return baseNum + (suffix ? ` ${suffix}` : "");
    }
    return num || r;
  };

  // 1. Generate Master Room List for Inpatient Floors
  const roomGroups = [
    {
      name: "1st floor",
      color: 'FFE2F0D9',
      rooms: Array.from({ length: 8 }, (_, i) => `10${i + 1}`).filter(r => r !== "108")
    },
    {
      name: "Zone A",
      color: 'FFFFF2CC',
      rooms: Array.from({ length: 19 }, (_, i) => `3${String(i + 1).padStart(2, '0')}`)
    },
    {
      name: "Zone B",
      color: 'FFDEEAF6',
      rooms: Array.from({ length: 10 }, (_, i) => `3${i + 20}`)
    },
    {
      name: "Zone C",
      color: 'FFE2D5E7',
      rooms: ["330 A", "330 B", "331 A", "331 B", "332"]
    },
    {
      name: "4th floor",
      color: 'FFF2F2F2',
      rooms: Array.from({ length: 22 }, (_, i) => {
        const num = 401 + i;
        if (num <= 405) return [`${num} A`, `${num} B`];
        return [`${num}`];
      }).flat()
    }
  ];

  // 2. Map source data (hospitalData) to an easily accessible Map by normalized room
  const sheetDataMap = new Map();
  data.slice(3).forEach(row => {
    const rawR = String(row[0] || "").trim();
    if (!rawR) return;
    const normR = normalizeRoom(rawR);
    sheetDataMap.set(normR, {
      rawRoom: rawR,
      patientName: String(row[1] || "").trim(),
      contract: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
      physician: String(row[2] || "").trim()
    });
  });

  // 3. Header Setup
  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'Inpatient Occupancy Summary / ملخص إشغال الأقسام الداخلية';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E5F5' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  const headerLabels = ['#', 'تاريخ الدخول / Admission Date', 'رقم السرير / الغرفة', 'اسم المريض', 'التعاقد', 'الطبيب المعالج / Treating Physician', 'ملاحظات'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1BEE7' } };
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  let globalSerial = 1;
  let totalOccupiedCount = 0;
  let totalRoomsCount = 0;

  // 4. Fill Group Data
  roomGroups.forEach(group => {
    let groupOccupied = 0;
    const groupRows: any[] = [];

    group.rooms.forEach(roomID => {
      const normID = normalizeRoom(roomID);
      const rowData = sheetDataMap.get(normID) || { rawRoom: roomID, patientName: "", contract: "", date: "", physician: "" };
      
      // Enrich with medical plan data only as fallback
      const plan = cumulativeMedicalPlans.find(p => normalizeRoom(p.colB) === normID);
      const patientNameRaw = rowData.patientName || (plan ? plan.colD : "") || "";
      const patientName = String(patientNameRaw).trim();
      const occupied = patientName.length > 0;
      if (occupied) {
        groupOccupied++;
        groupRows.push({
          room: rowData.rawRoom || roomID,
          name: patientName,
          contract: String(rowData.contract || (plan ? plan.colM : "") || "").trim(),
          physician: String(rowData.physician || (plan ? plan.colW : "") || "").trim(),
          date: cleanAdmissionDateStr(rowData.date || (plan ? plan.colA : "") || ""),
          notes: ""
        });
      }
    });

    const count = group.rooms.length;
    const perc = count > 0 ? ((groupOccupied / count) * 100).toFixed(1) : "0";
    totalOccupiedCount += groupOccupied;
    totalRoomsCount += count;

    // Group Header Row
    const groupHeader = sheet.addRow([`${group.name} - (Total Beds: ${count}, Occupied: ${groupOccupied} - ${perc}%)`, '', '', '', '', '', '']);
    sheet.mergeCells(`A${groupHeader.number}:G${groupHeader.number}`);
    groupHeader.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: group.color } };
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'medium' }, bottom: { style: 'medium' } };
    });

    // Patient rows inside group (Only occupied)
    groupRows.forEach(gr => {
      const pRow = sheet.addRow([globalSerial++, gr.date, gr.room, gr.name, gr.contract, gr.physician, gr.notes]);
      pRow.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
        };
        cell.alignment = { horizontal: pRow.getCell(3) === cell ? 'center' : 'right', vertical: 'middle' };
        cell.font = { name: 'Calibri', size: 11 };
        if (cell.value && gr.name && cell === pRow.getCell(4)) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
      });
    });

    sheet.addRow([]); // Spacer
  });

  // 5. Final Summary Row
  const totalPerc = totalRoomsCount > 0 ? ((totalOccupiedCount / totalRoomsCount) * 100).toFixed(1) : "0";
  const summaryRow = sheet.addRow([`TOTAL INPATIENT - (Total Beds: ${totalRoomsCount}, Total Occupied: ${totalOccupiedCount} - ${totalPerc}%)`, '', '', '', '', '', '']);
  sheet.mergeCells(`A${summaryRow.number}:G${summaryRow.number}`);
  summaryRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    cell.font = { bold: true, size: 14, color: { argb: 'FFC00000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { top: { style: 'double' }, bottom: { style: 'double' } };
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 30;
  sheet.getColumn(7).width = 30;
}

function addClosedUnitsSummarySheet(workbook: ExcelJS.Workbook, data: any[][]) {
  const sheet = workbook.addWorksheet('Closed Units Summary', {
    views: [{ rightToLeft: false }]
  });

  const normalizeRoom = (roomStr: string) => {
    let r = String(roomStr || "").toUpperCase().trim();
    const numMatch = r.match(/\d+/);
    const num = numMatch ? numMatch[0] : "";
    
    if (r.includes("NICU")) return "NICU" + num;
    if (r.includes("PICU")) return "PICU" + num;
    if (r.includes("SICU")) return "SICU" + num;
    if (r.includes("CCU")) {
      if (r.includes("VIP")) return "CCUVIP1";
      return "CCU" + num;
    }
    if (r.includes("ICU")) {
      if (r.includes("VIP")) return "VIP" + num;
      return "ICU" + num;
    }
    if (r.includes("VIP")) return "VIP" + num;
    
    return num || r;
  };

  // Define Closed Units Groups
  const closedGroups = [
    {
      name: "ICU / الرعاية المركزة",
      color: 'FFFCE4D6',
      rooms: Array.from({ length: 15 }, (_, i) => `ICU ${i + 1}`)
    },
    {
      name: "VIP ICU / الرعاية المميزة",
      color: 'FFFFF2CC',
      rooms: Array.from({ length: 6 }, (_, i) => `VIP ${i + 1}`)
    },
    {
      name: "NICU / رعاية المبتسرين",
      color: 'FFE2F0D9',
      rooms: Array.from({ length: 4 }, (_, i) => `NICU ${i + 1}`)
    },
    {
      name: "PICU / رعاية الأطفال",
      color: 'FFF2F2F2',
      rooms: Array.from({ length: 3 }, (_, i) => `PICU ${i + 1}`)
    },
    {
      name: "CCU / رعاية القلب",
      color: 'FFE1EEF4',
      rooms: Array.from({ length: 8 }, (_, i) => `CCU ${i + 1}`)
    },
    {
      name: "CCU VIP / رعاية القلب المميزة",
      color: 'FFE1EEF4',
      rooms: ["CCU VIP 1"]
    },
    {
      name: "SICU / الرعاية الجراحية",
      color: 'FFE7E6E6',
      rooms: Array.from({ length: 5 }, (_, i) => `SICU ${i + 1}`)
    }
  ];

  const sheetDataMap = new Map();
  data.slice(3).forEach(row => {
    const rawR = String(row[0] || "").trim();
    if (!rawR) return;
    const normR = normalizeRoom(rawR);
    sheetDataMap.set(normR, {
      rawRoom: rawR,
      patientName: String(row[1] || "").trim(),
      contract: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
      physician: String(row[2] || "").trim()
    });
  });

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'Closed Units Occupancy Summary / ملخص إشغال الوحدات المغلقة';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1BEE7' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 7.0);

  const headerLabels = ['#', 'تاريخ الدخول / Admission Date', 'رقم السرير / الغرفة', 'اسم المريض', 'التعاقد', 'الطبيب المعالج / Treating Physician', 'ملاحظات'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1C4E9' } };
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  let globalSerial = 1;
  let totalOccupiedCount = 0;
  let totalRoomsCount = 0;

  closedGroups.forEach(group => {
    let groupOccupied = 0;
    const groupRows: any[] = [];

    group.rooms.forEach(roomID => {
      const normID = normalizeRoom(roomID);
      const rowData = sheetDataMap.get(normID) || { rawRoom: roomID, patientName: "", contract: "", date: "", physician: "" };
      
      const plan = cumulativeMedicalPlans.find(p => normalizeRoom(p.colB) === normID);
      const patientNameRaw = rowData.patientName || (plan ? plan.colD : "") || "";
      const patientName = String(patientNameRaw).trim();
      const occupied = patientName.length > 0;
      
      if (occupied) {
        groupOccupied++;
        groupRows.push({
          room: rowData.rawRoom || roomID,
          name: patientName,
          contract: String(rowData.contract || (plan ? plan.colM : "") || "").trim(),
          physician: String(rowData.physician || (plan ? plan.colW : "") || "").trim(),
          date: cleanAdmissionDateStr(rowData.date || (plan ? plan.colA : "") || ""),
          notes: ""
        });
      }
    });

    const count = group.rooms.length;
    const perc = count > 0 ? ((groupOccupied / count) * 100).toFixed(1) : "0";
    totalOccupiedCount += groupOccupied;
    totalRoomsCount += count;

    const groupHeader = sheet.addRow([`${group.name} - (Total Beds: ${count}, Occupied: ${groupOccupied} - ${perc}%)`, '', '', '', '', '', '']);
    sheet.mergeCells(`A${groupHeader.number}:G${groupHeader.number}`);
    groupHeader.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: group.color } };
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'medium' }, bottom: { style: 'medium' } };
    });

    groupRows.forEach(gr => {
      const pRow = sheet.addRow([globalSerial++, gr.date, gr.room, gr.name, gr.contract, gr.physician, gr.notes]);
      pRow.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
        };
        cell.alignment = { horizontal: pRow.getCell(3) === cell ? 'center' : 'right', vertical: 'middle' };
        cell.font = { name: 'Calibri', size: 11 };
        if (cell.value && gr.name && cell === pRow.getCell(4)) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
      });
    });

    sheet.addRow([]);
  });

  const totalPerc = totalRoomsCount > 0 ? ((totalOccupiedCount / totalRoomsCount) * 100).toFixed(1) : "0";
  const summaryRow = sheet.addRow([`TOTAL CLOSED UNITS - (Total Beds: ${totalRoomsCount}, Total Occupied: ${totalOccupiedCount} - ${totalPerc}%)`, '', '', '', '', '', '']);
  sheet.mergeCells(`A${summaryRow.number}:G${summaryRow.number}`);
  summaryRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    cell.font = { bold: true, size: 14, color: { argb: 'FFC00000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { top: { style: 'double' }, bottom: { style: 'double' } };
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 30;
  sheet.getColumn(7).width = 30;
}

app.get('/api/reports/closed_units_summary', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Please upload data first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addClosedUnitsSummarySheet(workbook, getOccupancyRows(hospitalData));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Closed_Units_Occupancy.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Closed Units Summary Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/inpatient_summary', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Please upload data first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addInpatientSummarySheet(workbook, getOccupancyRows(hospitalData));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Inpatient_Summary.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Inpatient Summary Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/exit_formatted', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'Please upload a sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addExitSheet(workbook, cumulativeDischarged);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Formatted_Exit_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Exit Report Generation Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/reports/combined', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No data available.' });
  try {
    const workbook = new ExcelJS.Workbook();
    const isRefined = req.query.refined === 'true';
    
    // Add all sheets if data exists (except companion status sheets per user request)
    if (isRefined) {
      await addGridOccupancySheet(workbook, getOccupancyRows(hospitalData));
      await addRefinedEntrySheet(workbook, cumulativeEntries);
      await addRefinedDialysisSheet(workbook, cumulativeDialysis);
      await addRefinedExitSheet(workbook, cumulativeDischarged);
      if (cumulativeDebts && cumulativeDebts.length > 0) {
        await addRefinedDebtsSheet(workbook, cumulativeDebts);
      }
      if (cumulativeInsuredDebts && cumulativeInsuredDebts.length > 0) {
        await addRefinedInsuredDebtsSheet(workbook, cumulativeInsuredDebts);
      }
    } else {
      addOccupancySheet(workbook, getOccupancyRows(hospitalData));
      addEntrySheet(workbook, cumulativeEntries);
      addDialysisSheet(workbook, cumulativeDialysis);
      addExitSheet(workbook, cumulativeDischarged);
      if (cumulativeDebts && cumulativeDebts.length > 0) {
        addDebtsSheet(workbook, cumulativeDebts);
      }
      if (cumulativeInsuredDebts && cumulativeInsuredDebts.length > 0) {
        addInsuredDebtsSheet(workbook, cumulativeInsuredDebts);
      }
    }

    const filename = isRefined
      ? `Combined_Hospital_Refined_Report_${new Date().toISOString().split('T')[0]}.xlsx`
      : `Combined_Hospital_Report_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Combined Report Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/reports/specialty_occupancy', async (req, res) => {
  if (cumulativeMedicalPlans.length === 0) return res.status(400).json({ error: 'No data available. Please upload the debts source sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    addSpecialtyOccupancySheet(workbook, cumulativeMedicalPlans);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Inpatients_By_Specialty.xlsx');
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Specialty Report Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/reports/medical_director_combined', async (req, res) => {
  if (!hospitalData) return res.status(400).json({ error: 'No hospital data available. Please upload a sheet first.' });
  try {
    const workbook = new ExcelJS.Workbook();
    
    // 1. Formatted Occupancy
    addOccupancySheet(workbook, getOccupancyRows(hospitalData));
    
    // 2. Inpatient Summary Sheet
    addInpatientSummarySheet(workbook, getOccupancyRows(hospitalData));
    
    // 3. Closed Units Occupancy Summary
    addClosedUnitsSummarySheet(workbook, getOccupancyRows(hospitalData));
    
    // 4. Inpatients By Specialty
    if (cumulativeMedicalPlans && cumulativeMedicalPlans.length > 0) {
      addSpecialtyOccupancySheet(workbook, cumulativeMedicalPlans);
    } else {
      const sheet = workbook.addWorksheet('By Specialty');
      sheet.addRow(['No specialty data available. Please upload the debts source sheet first.']);
    }
    
    // 5. LOS Sheet
    if (cumulativeLOS && cumulativeLOS.length > 0) {
      addLOSSheet(workbook, cumulativeLOS);
    } else {
      const sheet = workbook.addWorksheet('LOS Sheet');
      sheet.addRow(['No Length of Stay (LOS) data available. Please upload the debts source sheet first.']);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Medical_Director_Combined_Report_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await workbook.xlsx.write(res);
    if (!res.writableEnded) res.end();
  } catch (error: any) {
    console.error('Medical Director Combined Report Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  }
});

function addSpecialtyOccupancySheet(workbook: ExcelJS.Workbook, plans: any[]) {
  const sheet = workbook.addWorksheet('By Specialty', {
    views: [{ rightToLeft: false }]
  });

  // Group by Column X (Specialty)
  const groups: { [key: string]: any[] } = {};
  plans.forEach(p => {
    if (!p.colD || p.colD === "" || p.colD === "0") return; // Skip empty beds
    
    // Apply standard occupancy filters
    const roomLower = String(p.colB || "").toLowerCase();
    const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => roomLower.includes(kw));
    const isOR = isOperatingRoom(p.colB);
    const isHeader = roomLower === "bed" || roomLower === "room" || roomLower === "الغرفة";
    
    if (isExcluded || isOR || isHeader) return;

    const mappedP = { ...p };
    let specialty = (mappedP.colX || "").trim() || "Other / غير محدد";
    const specLower = specialty.toLowerCase();
    
    if (specLower === "pulmonology" || specLower === "haematology") {
      specialty = "Internal Medicine";
    } else if (specLower === "general surgery" || specLower === "git surgery") {
      specialty = "General Surgery";
    } else if (specLower === "orthopedics" || specLower === "orthopedic surgery") {
      specialty = "Orthopaedic surgery";
    }

    mappedP.colX = specialty;

    if (!groups[specialty]) groups[specialty] = [];
    groups[specialty].push(mappedP);
  });

  // Sort groups alphabetically
  const groupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'الحالات المنومة طبقاً للتخصص';
  titleCell.font = { size: 24, bold: true, name: 'Arial', color: { argb: 'FF000000' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }; 
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 90;

  addLogosToSheet(workbook, sheet, 6.0);

  const headerLabels = ['#', 'تاريخ الدخول / Admission Date', 'رقم الغرفة', 'اسم المريض', 'التعاقد', 'التشخيص', 'التخصص'];
  const headerRow = sheet.addRow(headerLabels);
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA5D6A7' } }; 
    cell.font = { bold: true, size: 11, name: 'Calibri' };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
    };
  });

  let globalSerial = 1;

  groupNames.forEach(specialty => {
    const groupRows = groups[specialty];
    
    // Group Header Row
    const groupHeader = sheet.addRow([`${specialty} - (${groupRows.length} Cases)`, '', '', '', '', '', '']);
    sheet.mergeCells(`A${groupHeader.number}:G${groupHeader.number}`);
    groupHeader.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'medium' }, bottom: { style: 'medium' } };
    });

    groupRows.forEach(p => {
      const rowValues = [globalSerial++, cleanAdmissionDateStr(p.colA), p.colB, p.colD, p.colM, p.colW, p.colX || specialty];
      const pRow = sheet.addRow(rowValues);
      pRow.eachCell((cell, colNumber) => {
        cell.border = {
          top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { name: 'Calibri', size: 11 };
        // Bold patient name
        if (colNumber === 4) {
          cell.font = { bold: true, name: 'Calibri', size: 11 };
        }
      });
    });

    sheet.addRow([]); // Spacer
  });

  sheet.getColumn(1).width = 5;
  sheet.getColumn(2).width = 20;
  sheet.getColumn(3).width = 15;
  sheet.getColumn(4).width = 30;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 40;
  sheet.getColumn(7).width = 30;
}

// Routes complete
async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

// Global error handlers already registered above
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Catch-all for unknown /api routes
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `API route ${req.method} ${req.url} not found` });
});

console.log('Registering routes complete, starting server...');
if (!process.env.VERCEL) {
  startServer().catch(err => {
    console.error('FAILED TO START SERVER:', err);
  });
}

// Final Error Handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error('CRITICAL SERVER ERROR:', err);
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'Internal Server Error', 
      details: err.message,
      path: req.url 
    });
  }
});

export default app;

