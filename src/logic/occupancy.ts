/**
 * Business logic migrated from Google Apps Script
 */

export const KEYWORDS_TO_EXCLUDE = ["homecare", "home care", "wellbaby", "well baby", "dialysis", "diyalsis room", "diyalsis", "endoscopy operation theatre", "operation room", "cath lab operation theatre", "day case", "daycase"];

export function isOperatingRoom(roomStr: string): boolean {
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

export interface PatientRow {
  room: string;
  id: string;
  name: string;
  type: string;
  payment: string;
  date: string;
  doctor?: string;
  notes?: string;
}

export function filterPatientData(rawData: any[][]): PatientRow[] {
  // STRICTLY matching Google Apps Script logic:
  // row[0] (Col A) -> Room/Bed
  // row[1] (Col B) -> Patient Name
  // row[2] (Col C) -> Treating Physician
  // row[3] (Col D) -> Contractor
  // row[4] (Col E) -> Admission Date
  
  if (!rawData || rawData.length === 0) return [];
  
  // Apps Script starts at row 4 (index 3)
  const data = rawData.slice(3);
 
  return data
    .map((row): PatientRow | null => {
      if (!row) return null; // Ensure row exists
      
      return {
        room: String(row[0] || "").trim(),
        id: "", // ID removed from source mapping
        name: String(row[1] || "").trim(),
        type: "", 
        doctor: String(row[2] || "").trim(),
        payment: String(row[3] || "").trim(),
        date: String(row[4] || "").trim(),
        notes: "",
      };
    })
    .filter((p): p is PatientRow => {
      if (!p || !p.room || !p.name) return false;
      const rowValues = [p.room, p.name, p.doctor, p.payment, p.date].filter(Boolean);
      const rowAsString = rowValues.join(" ").toLowerCase();
      const isExcluded = KEYWORDS_TO_EXCLUDE.some(kw => rowAsString.includes(kw));
      const isHeader = p.room.toLowerCase() === "bed" || p.room.toLowerCase() === "room" || p.room === "الغرفة" || p.name.toLowerCase() === "patient" || p.name === "المريض";
      const isOR = isOperatingRoom(p.room);
      return !isExcluded && !isHeader && !isOR;
    });
}

export function extractDischargedPatients(oldData: PatientRow[], newData: PatientRow[]): PatientRow[] {
  // Find patients that are in oldData but NOT in newData (matching by exact name and room)
  // Or maybe just exact name is safer, as they might have moved rooms before discharging? Let's use name.
  // We'll normalize names to handle slight spacing issues
  const currentNames = new Set(newData.map(p => p.name.toLowerCase().trim()));
  
  return oldData.filter(oldP => !currentNames.has(oldP.name.toLowerCase().trim()));
}

export function extractEmptyRooms(patients: PatientRow[]): string[] {
  // Generate all possible rooms based on the zone configurations provided previously
  const allRooms: string[] = [
    // 1st Floor (Day Case split beds + Premium South whole rooms)
    "102", "103", "106", "107",
    "101 - 1", "101 - 2",
    "104 - 1", "104 - 2",
    "105 - 1", "105 - 2",
    // Zone A (19 rooms: 301-319)
    ...Array.from({ length: 19 }, (_, i) => `3${String(i + 1).padStart(2, '0')}`),
    // Zone B (10 rooms: 320-329)
    ...Array.from({ length: 10 }, (_, i) => `3${i + 20}`),
    // Zone C (3 rooms: 330-332, with 330-331 having A/B variants)
    "330 A", "330 B", "331 A", "331 B", "332",
    // 4th Floor (22 rooms: 401-422, with 401-405 having A/B variants)
    ...Array.from({ length: 22 }, (_, i) => {
      const n = i + 1;
      const num = 400 + n;
      if (n <= 5) return [`${num} A`, `${num} B`];
      return [`${num}`];
    }).flat(),
    // ICU & VIP (15 ICU + 6 VIP)
    ...Array.from({ length: 15 }, (_, i) => `ICU ${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `VIP ICU ${i + 1}`),
    // NICU (4 beds)
    ...Array.from({ length: 4 }, (_, i) => `NICU ${i + 1}`),
    // PICU (3 beds)
    ...Array.from({ length: 3 }, (_, i) => `PICU ${i + 1}`),
    // SICU (5 beds)
    ...Array.from({ length: 5 }, (_, i) => `SICU ${i + 1}`),
    // CCU (8 beds + 1 VIP CCU)
    ...Array.from({ length: 8 }, (_, i) => `CCU ${i + 1}`),
    "VIP CCU 1"
  ];

  const normalizeRoom = (roomStr: string) => {
    let r = roomStr.toUpperCase().trim();
    const numMatch = r.match(/\d+/);
    const num = numMatch ? numMatch[0] : "";
    
    if (r.includes("VIP CCU")) return `VIP CCU ${num}`;
    if (r.includes("VIP ICU") || r.includes("VIP ISOLATION") || (r.includes("VIP") && r.includes("ICU"))) return `VIP ICU ${num}`;
    if (r.includes("PICU")) return `PICU ${num}`;
    if (r.includes("NICU")) return `NICU ${num}`;
    if (r.includes("SICU")) return `SICU ${num}`;
    if (r.includes("CCU")) return `CCU ${num}`;
    if (r.includes("ICU")) return `ICU ${num}`;
    if (r.includes("VIP")) return `VIP ICU ${num}`; // Fallback for plain "VIP"
    
    // Check for 330-331 and 401-405 A/B variants
    const abMatch = r.match(/(33[01]|40[1-5])\s*[-/]?\s*([AB])/);
    if (abMatch) return `${abMatch[1]} ${abMatch[2]}`;

    // For 101, 104, 105 A/B or -1/-2 variants
    const firstFloorMatch = r.match(/(10[145])\s*[-A-B1-2]?\s*([1-2])/);
    if (firstFloorMatch) {
      return `${firstFloorMatch[1]} - ${firstFloorMatch[2]}`;
    }

    // Strip suffixes completely for 102, 103, 106, 107
    if (["102", "103", "106", "107"].includes(num)) {
      return num;
    }

    return num;
  };

  // Extract the normalized occupied room identifiers from the patient list
  const occupiedIdentifiers = new Set(
    patients.map(p => normalizeRoom(p.room)).filter(Boolean)
  );

  const vacantRoomsRaw: string[] = [];

  allRooms.forEach(room => {
    // Check if the room has an A/B variant (using regex on the room label, e.g. "401 A" or "402 B")
    const match = room.match(/^(33[01]|40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1]; // "330", "331", "401", "402", ...
      const variant = match[2]; // "A" or "B"
      
      const isBaseOccupied = occupiedIdentifiers.has(base);
      const isAOccupied = occupiedIdentifiers.has(`${base} A`);
      const isBOccupied = occupiedIdentifiers.has(`${base} B`);
      
      if (!isBaseOccupied) {
        if (variant === 'A' && !isAOccupied) {
          vacantRoomsRaw.push(room);
        } else if (variant === 'B' && !isBOccupied) {
          vacantRoomsRaw.push(room);
        }
      }
    } else {
      // For any other normal/closed unit room
      const identifier = normalizeRoom(room);
      if (!occupiedIdentifiers.has(identifier)) {
        vacantRoomsRaw.push(room);
      }
    }
  });

  // Group 401-405 A/B rooms if both are empty
  const emptyRoomsSet = new Set(vacantRoomsRaw);
  const finalists: string[] = [];
  const processedBases = new Set<string>();

  vacantRoomsRaw.forEach(room => {
    const match = room.match(/^(33[01]|40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1];
      if (emptyRoomsSet.has(`${base} A`) && emptyRoomsSet.has(`${base} B`)) {
        if (!processedBases.has(base)) {
          finalists.push(base);
          processedBases.add(base);
        }
      } else {
        finalists.push(room);
      }
    } else {
      finalists.push(room);
    }
  });

  return finalists;
}

export function countTodaysEntries(patients: PatientRow[]): number {
  return patients.filter(p => {
    const d = p.date.trim().toLowerCase();
    if (!d) return false;

    if (d.includes('اليوم')) return true;

    const today = new Date();
    const year = today.getFullYear();
    const shortYear = year % 100;
    const month = today.getMonth() + 1;
    const day = today.getDate();
    
    const paddedMonth = month.toString().padStart(2, '0');
    const paddedDay = day.toString().padStart(2, '0');

    const possibleFormats = [
      `${month}/${day}/${year}`,
      `${month}/${day}/${shortYear}`,
      `${paddedMonth}/${paddedDay}/${year}`,
      `${paddedMonth}/${paddedDay}/${shortYear}`,
      `${day}/${month}/${year}`,
      `${day}/${month}/${shortYear}`,
      `${paddedDay}/${paddedMonth}/${year}`,
      `${paddedDay}/${paddedMonth}/${shortYear}`,
      `${year}-${paddedMonth}-${paddedDay}`
    ];

    if (possibleFormats.some(f => d.includes(f))) return true;

    try {
        const parsedTime = Date.parse(d);
        if (!isNaN(parsedTime)) {
          const parsedDate = new Date(parsedTime);
          if (
            parsedDate.getFullYear() === year &&
            parsedDate.getMonth() === today.getMonth() &&
            parsedDate.getDate() === day
          ) {
            return true;
          }
        }
    } catch(e) {}
    
    return false;
  }).length;
}

function getRoomRank(room: string): number {
  const r = room.toUpperCase();
  if (r.includes("PICU")) return 6;
  if (r.includes("NICU")) return 5;
  if (r.includes("CCU")) return 4;
  if (r.includes("SICU")) return 3;
  if (r.includes("VIP") || r.includes("VIP ISOLATION")) return 2;
  if (r.includes("ICU")) return 1;
  return 10;
}

export function sortPatients(patients: PatientRow[]): PatientRow[] {
  return [...patients].sort((a, b) => {
    const rankA = getRoomRank(a.room);
    const rankB = getRoomRank(b.room);
    
    if (rankA !== rankB) return rankA - rankB;

    const numA = parseInt(a.room.match(/\d+/)?.at(0) || "0");
    const numB = parseInt(b.room.match(/\d+/)?.at(0) || "0");
    
    if (numA !== numB) return numA - numB;

    return a.room.localeCompare(b.room);
  });
}

export function getGroup(room: string): string {
  const roomStr = room.trim().toUpperCase();
  const roomNum = parseInt(roomStr.match(/\d+/)?.at(0) || "0");

  if (roomStr.includes("PICU")) return "PEDIATRIC INTENSIVE CARE (PICU)";
  if (roomStr.includes("NICU")) return "NEONATAL INTENSIVE CARE (NICU)";
  if (roomStr.includes("CCU")) return "CORONARY CARE UNIT (CCU)";
  if (roomStr.includes("SICU")) return "SURGICAL INTENSIVE CARE (SICU)";
  if (roomStr.includes("VIP CCU")) return "VIP CCU";
  if (roomStr.includes("VIP") || roomStr.includes("VIP ISOLATION")) return "VIP ICU";
  if (roomStr.includes("ICU")) return "INTENSIVE CARE UNIT (ICU)";
  if (roomNum === 108) return "EXCLUDED UNITS";
  if (roomNum >= 101 && roomNum <= 108) return "STATION 1 (ROOMS 101-108)";
  if (roomNum >= 301 && roomNum <= 319) return "ZONE A (ROOMS 301-319)";
  if (roomNum >= 320 && roomNum <= 329) return "ZONE B (ROOMS 320-329)";
  if (roomNum >= 330 && roomNum <= 332) return "ZONE C (ROOMS 330-332)";
  if (roomNum >= 401 && roomNum <= 422) return "4TH FLOOR (ROOMS 401-422)";
  return "OTHER UNITS";
}

export interface ZoneStats {
  name: string;
  occupied: number;
  total: number;
}

export function calculateStats(patients: PatientRow[]): ZoneStats[] {
  const zones: Record<string, { occupied: number; total: number }> = {
    "1st Floor": { occupied: 0, total: 7 },
    "Zone A": { occupied: 0, total: 19 },
    "Zone B": { occupied: 0, total: 10 },
    "Zone C": { occupied: 0, total: 5 }, // 330 A/B (2) + 331 A/B (2) + 332 (1) = 5 total beds
    "4th Floor": { occupied: 0, total: 27 },
    "ICU & VIP": { occupied: 0, total: 21 }, // 15 ICU + 6 VIP
    "NICU": { occupied: 0, total: 4 },
    "PICU": { occupied: 0, total: 3 },
    "SICU": { occupied: 0, total: 5 },
    "CCU": { occupied: 0, total: 9 }, // 8 CCU + 1 VIP CCU
  };

  patients.forEach(p => {
    const g = getGroup(p.room);
    if (g.includes("101-108")) zones["1st Floor"].occupied++;
    else if (g.includes("301-319")) zones["Zone A"].occupied++;
    else if (g.includes("320-329")) zones["Zone B"].occupied++;
    else if (g.includes("330-332")) zones["Zone C"].occupied++;
    else if (g.includes("401-422")) zones["4th Floor"].occupied++;
    else if (g.includes("INTENSIVE CARE UNIT") || g.includes("VIP ICU")) zones["ICU & VIP"].occupied++;
    else if (g.includes("NEONATAL")) zones["NICU"].occupied++;
    else if (g.includes("PEDIATRIC")) zones["PICU"].occupied++;
    else if (g.includes("SURGICAL")) zones["SICU"].occupied++;
    else if (g.includes("CORONARY") || g === "VIP CCU") zones["CCU"].occupied++;
  });

  return Object.entries(zones).map(([name, stats]) => ({
    name,
    ...stats
  }));
}

export function isCashPayment(payment: string): boolean {
  if (!payment) return false;
  const p = payment.toString().toLowerCase().trim();
  // We can look for keywords like cash, نقد, نقدي, كاش
  return p.includes('cash') || p.includes('كاش') || p.includes('نقد');
}

export function getAccommodationCategory(roomStr: string): string {
  if (!roomStr) return "غير مصنف";
  
  let r = roomStr.toUpperCase()
    .replace(/ROOM/g, "")
    .replace(/BED/g, "")
    .replace(/الغرفة/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // 3rd floor flexible suites (330 to 331)
  // 330 A, 330 B, 331 A, 331 B are "مميز جنوبي"
  if (r.match(/^33[01]\s*[-/]?\s*[AB]$/)) {
    return "مميز جنوبي";
  }
  // 330 and 331 as whole rooms are "امبريال سويت"
  if (r === "330" || r === "331") {
    return "امبريال سويت";
  }
  // 332 is a whole room "رويال سويت"
  if (r === "332") {
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
  if (r.match(/^40[1-5]\s*[-/]?\s*[AB]$/)) {
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

