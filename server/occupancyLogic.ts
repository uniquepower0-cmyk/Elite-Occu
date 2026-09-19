import {
  normalizeRoom,
  cleanRoomStr,
  isOperatingRoom,
  isDialysisRoom,
  isProcedureOrTemporaryRoom,
  cleanAdmissionDateStr,
  isToday,
  parseDateComponents,
  isNameMatch,
  isPatientMatch,
  normalizeArabicName,
  getTodayRiyadhDateTimeStr
} from './nameUtils';

export const KEYWORDS_TO_EXCLUDE = [
  "or", "operating", "عمليات",
  "dialysis", "diyalsis", "غسيل",
  "cath", "قسطرة",
  "endoscopy", "مناظير",
  "recovery", "إفاقة"
];

export const GLOBAL_EXCLUSIONS = [
  "المريض", "patient", "اسم المريض", "patient name", "name", "patient_name", "id"
];

export function deduplicateZoneC(body: any[][]): any[][] {
  const normalizedRooms = new Set(body.map(row => normalizeRoom(row[0])));
  const has330Specific = normalizedRooms.has("330A") || normalizedRooms.has("330B");
  const has331Specific = normalizedRooms.has("331A") || normalizedRooms.has("331B");

  return body.filter(row => {
    const room = row[0];
    const name = row[1];
    const norm = normalizeRoom(room);
    
    if (norm === "330" && has330Specific) {
      return false;
    }
    if (norm === "331" && has331Specific) {
      return false;
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

export function getOccupancyRows(
  data: any[][] | null,
  isManuallyDischargedFn: (name: string) => boolean = () => false
): any[][] {
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
  
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }

  const body = data.slice(startIdx).map(row => {
    return [
      String(row[1] || "").trim(),
      String(row[3] || "").trim(),
      String(row[22] || "").trim(),
      String(row[12] || "").trim(),
      cleanAdmissionDateStr(row[0]),
      String(row[2] || "").trim(),
    ];
  }).filter(row => {
    const room = row[0];
    const name = row[1];
    if (isOperatingRoom(room)) return false;
    if (isManuallyDischargedFn(name)) return false;
    return true;
  });
  
  const deduplicatedBody = deduplicateZoneC(body);
  return [...prefix, ...deduplicatedBody];
}

export function getOccupancyRowsUnfiltered(
  data: any[][] | null,
  isManuallyDischargedFn: (name: string) => boolean = () => false
): any[][] {
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
  
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }

  const body = data.slice(startIdx).map(row => {
    return [
      String(row[1] || "").trim(),
      String(row[3] || "").trim(),
      String(row[22] || "").trim(),
      String(row[12] || "").trim(),
      cleanAdmissionDateStr(row[0]),
      String(row[2] || "").trim(),
    ];
  }).filter(row => {
    const name = row[1];
    if (isManuallyDischargedFn(name)) return false;
    return true;
  });
  
  const deduplicatedBody = deduplicateZoneC(body);
  return [...prefix, ...deduplicatedBody];
}

export function extractVipNames(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const names: string[] = [];
  for (let line of lines) {
    line = line.replace(/^\s*\*+.*?\*+\s*$/, '').trim();
    if (!line) continue;
    
    // Remove common prefixes
    line = line.replace(/^\d+[\.\-\)]\s*/, '');
    line = line.replace(/^[-*•]\s*/, '');
    line = line.replace(/^(patient|mrn|name|dr|room|bed)\s*:\s*/i, '');
    
    // Remove room or MRN suffixes in parentheses
    line = line.replace(/\(.*?\)/g, '').trim();
    line = line.replace(/\[.*?\]/g, '').trim();
    
    if (line.length > 2) {
      names.push(line);
    }
  }
  return names;
}

export function getDatasetOperationalDateStr(patients: { date?: string; rawDate?: string }[]): string {
  if (!patients || patients.length === 0) return "";
  let maxDateKey = "";
  patients.forEach(p => {
    const comp = parseDateComponents(p.rawDate || p.date);
    if (comp) {
      const key = `${comp.y}-${String(comp.m).padStart(2, '0')}-${String(comp.d).padStart(2, '0')}`;
      if (!maxDateKey || key > maxDateKey) {
        maxDateKey = key;
      }
    }
  });
  return maxDateKey;
}

export function extractRawPatientsFromRows(
  data: any[][],
  isManuallyDischargedFn: (name: string) => boolean = () => false
): { name: string; mrn: string; room: string; physician?: string; contractor?: string; date?: string; rawDate?: string }[] {
  if (!data || !Array.isArray(data)) return [];
  let startIdx = 0;
  for (let i = 0; i < Math.min(data.length, 10); i++) {
    const r0 = String(data[i][0] || "").toLowerCase();
    const r1 = String(data[i][1] || "").toLowerCase();
    const r3 = String(data[i][3] || "").toLowerCase();
    if (r0.includes("admission") || r0.includes("تاريخ") || r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name") {
      startIdx = i + 1;
      break;
    }
  }

  const patientMap = new Map<string, { name: string; mrn: string; room: string; physician?: string; contractor?: string; date?: string; rawDate?: string }>();

  data.slice(startIdx).forEach(r => {
    let rawRoom = "";
    let rawMrn = "";
    let rawName = "";
    let rawPhysician = "";
    let rawContractor = "";
    let rawDateStr = "";

    // Detect layout: 39-column unified format vs 5/6-column formatted occupancy
    if (r.length >= 10 || (String(r[0] || "").includes("T") || (/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(String(r[0] || ""))))) {
      rawDateStr = String(r[0] || "").trim();
      rawRoom = cleanRoomStr(String(r[1] || "").trim());
      rawMrn = String(r[2] || "").trim().replace(/^0+/, "");
      rawName = String(r[3] || "").trim();
      rawContractor = String(r[12] || "").trim();
      rawPhysician = String(r[22] || "").trim();
    } else {
      rawRoom = cleanRoomStr(String(r[0] || "").trim());
      rawName = String(r[1] || "").trim();
      rawPhysician = String(r[2] || "").trim();
      rawContractor = String(r[3] || "").trim();
      rawDateStr = String(r[4] || "").trim();
      rawMrn = String(r[5] || "").trim().replace(/^0+/, "");
    }

    const cleanDate = cleanAdmissionDateStr(rawDateStr);

    if (!rawName || !rawRoom) return;
    const lowName = rawName.toLowerCase();
    if (lowName === "patient" || lowName === "المريض" || lowName === "name" || lowName === "اسم المريض" || lowName === "patient name") return;
    if (isManuallyDischargedFn(rawName)) return;

    const patientKey = rawMrn ? `mrn:${rawMrn}` : `name:${normalizeArabicName(rawName)}`;
    const isProc = isProcedureOrTemporaryRoom(rawRoom);
    const item = {
      name: rawName,
      mrn: rawMrn,
      room: rawRoom,
      physician: rawPhysician,
      contractor: rawContractor,
      date: cleanDate,
      rawDate: rawDateStr
    };

    if (patientMap.has(patientKey)) {
      const existing = patientMap.get(patientKey)!;
      const existingIsProc = isProcedureOrTemporaryRoom(existing.room);
      if (existingIsProc && !isProc) {
        patientMap.set(patientKey, item);
      }
    } else {
      patientMap.set(patientKey, item);
    }
  });

  return Array.from(patientMap.values());
}

export function getInsuredNonCashOccupancy(data: any[][] | null): any[] {
  if (!data) return [];
  const occRows = getOccupancyRows(data);
  const bodyRows = occRows.slice(3);

  return bodyRows.filter(row => {
    const contractor = String(row[3] || "").trim();
    const contractorLower = contractor.toLowerCase();

    if (!contractor || contractorLower === "cash" || contractorLower === "كاش" || contractorLower === "نقدي") {
      return false;
    }

    const isNonCash = (
      contractorLower.includes("insurance") ||
      contractorLower.includes("تأمين") ||
      contractorLower.includes("تامين") ||
      contractorLower.includes("شركة") ||
      contractorLower.includes("شركه") ||
      contractorLower.includes("credit") ||
      contractorLower.includes("آجل") ||
      contractorLower.includes("اجل") ||
      contractorLower.includes("bupa") ||
      contractorLower.includes("tawuniya") ||
      contractorLower.includes("medgulf") ||
      contractorLower.includes("globemed") ||
      contractorLower.includes("nextcare") ||
      contractorLower.includes("alrajhi") ||
      contractorLower.includes("saico") ||
      contractorLower.includes("malath") ||
      contractorLower.includes("almadallah") ||
      contractorLower.includes("axa") ||
      contractorLower.includes("cigna") ||
      contractorLower.includes("metlife") ||
      contractorLower.includes("allianz") ||
      contractorLower.includes("carecard") ||
      contractorLower.includes("daman") ||
      contractorLower.includes("sukoon") ||
      contractorLower.includes("oman") ||
      contractorLower.includes("wafa") ||
      contractorLower.includes("salama") ||
      contractorLower.includes("tajeer") ||
      contractorLower.includes("aramco") ||
      contractorLower.includes("sabic") ||
      contractorLower.includes("ministry") ||
      contractorLower.includes("وزارة") ||
      contractorLower.includes("وزاره") ||
      contractorLower.includes("military") ||
      contractorLower.includes("عسكري") ||
      contractorLower.includes("police") ||
      contractorLower.includes("شرطة") ||
      contractorLower.includes("شرطه") ||
      contractorLower.includes("embassy") ||
      contractorLower.includes("سفارة") ||
      contractorLower.includes("سفاره")
    );

    return isNonCash;
  }).map(row => ({
    room: row[0],
    name: row[1],
    physician: row[2],
    contractor: row[3],
    admissionDate: row[4],
    mrn: row[5]
  }));
}

export function getNormalizedPatientRows(rows: any[][] | null): string[] {
  if (!rows || rows.length <= 3) return [];
  return rows.slice(3).map(r => {
    const room = cleanRoomStr(String(r[0] || "").trim());
    const name = normalizeArabicName(String(r[1] || "").trim());
    const date = cleanAdmissionDateStr(r[4]);
    const mrn = String(r[5] || "").trim().replace(/^0+/, "");
    return `${room}|${mrn}|${name}|${date}`;
  }).sort();
}

export function areRowsDifferent(rowsA: any[][] | null, rowsB: any[][] | null): boolean {
  if (!rowsA && !rowsB) return false;
  if (!rowsA || !rowsB) return true;
  const listA = getNormalizedPatientRows(rowsA);
  const listB = getNormalizedPatientRows(rowsB);
  if (listA.length !== listB.length) return true;
  for (let i = 0; i < listA.length; i++) {
    if (listA[i] !== listB[i]) return true;
  }
  return false;
}
