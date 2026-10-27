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
} from './nameUtils.js';
import {
  buildColumnIndexResolver,
  buildDeterministicUnknownMrn
} from './columnResolver.js';

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
  if (!data || !Array.isArray(data) || data.length === 0) return [];
  
  const { headerRowIdx, findCol } = buildColumnIndexResolver(data);
  let startIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : 3;
  if (headerRowIdx === -1) {
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const r0 = String(data[i]?.[0] || "").toLowerCase();
      const r1 = String(data[i]?.[1] || "").toLowerCase();
      const r3 = String(data[i]?.[3] || "").toLowerCase();
      if (r0.includes("admission") || r0.includes("تاريخ") || r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name") {
        startIdx = i + 1;
        break;
      }
    }
  }
  
  if (data.length <= startIdx) return [];
  
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }

  const sampleRow = data.slice(startIdx).find((r: any) => Array.isArray(r) && r.length > 5) || data[0] || [];
  const is30ColLayout = sampleRow.length < 35 && sampleRow.length >= 15;

  const defaultBedCol = 1;
  const defaultMrnCol = is30ColLayout ? -1 : 2;
  const defaultNameCol = is30ColLayout ? 2 : 3;
  const defaultDateCol = 0;
  const defaultPhysCol = is30ColLayout ? 14 : 22;
  const defaultContCol = is30ColLayout ? 6 : 12;

  const colRoomIdx = findCol(["bed#", "bedname_en", "bed", "room", "bed no", "الغرفة", "غرفة", "السرير", "سرير"], defaultBedCol, 'room');
  const colNameIdx = findCol(["patient name", "patient", "englishfullname", "name", "المريض", "اسم المريض", "الاسم", "اسم الحالة", "الاسم بالكامل"], defaultNameCol, 'name');
  const colPhysIdx = findCol(["treatingphysicianname", "consultantname_en", "physician", "doctor", "الطبيب", "الطبيب المعالج", "طبيب"], defaultPhysCol, 'name');
  const colContractorIdx = findCol(["contractor name", "contractorname", "contractor", "contract", "التعاقد", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع"], defaultContCol, 'text');
  const colAdmIdx = findCol(["admission date", "admissiondate", "date", "تاريخ الدخول", "التاريخ", "تاريخ", "admission", "no filters applied"], defaultDateCol, 'date');
  const colMrnIdx = findCol(["mrn", "patientbarcode", "patient id", "patient mrn", "رقم المريض", "الملف", "رقم الملف", "كود المريض"], defaultMrnCol, 'id');

  const body = data.slice(startIdx).map(row => {
    if (Array.isArray(row) && row.length === 6 && row[22] === undefined) {
      return [
        String(row[0] || "").trim(),
        String(row[1] || "").trim(),
        String(row[2] || "").trim(),
        String(row[3] || "").trim(),
        String(row[4] || "").trim(),
        String(row[5] || "").trim(),
      ];
    }
    const roomStr = colRoomIdx >= 0 ? cleanRoomStr(String(row[colRoomIdx] || "").trim()) : "";
    let nameStr = colNameIdx >= 0 ? String(row[colNameIdx] || "").trim() : "";
    let physStr = colPhysIdx >= 0 ? String(row[colPhysIdx] || "").trim() : "";
    let contStr = colContractorIdx >= 0 ? String(row[colContractorIdx] || "").trim() : "";
    const admStr = colAdmIdx >= 0 ? cleanAdmissionDateStr(row[colAdmIdx]) : "";
    let mrnStr = colMrnIdx >= 0 ? String(row[colMrnIdx] || "").trim() : "";

    // Safeguard numeric contractor (ALOS/LOS float leak)
    if (/^\d+(\.\d+)?$/.test(contStr)) {
      if (row.length < 35 && row[6] && !/^\d+(\.\d+)?$/.test(String(row[6]).trim())) {
        contStr = String(row[6]).trim();
      } else if (row.length >= 35 && row[12] && !/^\d+(\.\d+)?$/.test(String(row[12]).trim())) {
        contStr = String(row[12]).trim();
      } else {
        contStr = "";
      }
    }

    // Safeguard numeric name (Age leak)
    if (/^\d+$/.test(nameStr)) {
      if (mrnStr && !/^\d+$/.test(mrnStr)) {
        nameStr = mrnStr;
        mrnStr = "";
      } else if (row[2] && !/^\d+$/.test(String(row[2]).trim()) && !cleanRoomStr(String(row[2])).includes(roomStr)) {
        nameStr = String(row[2]).trim();
      }
    }

    // Safeguard surgical procedure in physician
    if (/closure|wounds|drainage|exploration|appendectomy|biopsy|laparoscopic|debridement|excision|fixation|amputation|استئصال|منظار|تفريغ|جراحة/i.test(physStr)) {
      if (row.length < 35 && row[14] && !/closure|wounds|drainage|exploration|appendectomy|biopsy/i.test(String(row[14]))) {
        physStr = String(row[14]).trim();
      } else if (row.length >= 35 && row[22] && !/closure|wounds|drainage|exploration|appendectomy|biopsy/i.test(String(row[22]))) {
        physStr = String(row[22]).trim();
      }
    }

    if (!mrnStr && nameStr) {
      mrnStr = buildDeterministicUnknownMrn(nameStr, roomStr);
    }
    return [
      roomStr,
      nameStr,
      physStr,
      contStr,
      admStr,
      mrnStr,
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
  if (!data || !Array.isArray(data) || data.length === 0) return [];
  
  const { headerRowIdx, findCol } = buildColumnIndexResolver(data);
  let startIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : 3;
  if (headerRowIdx === -1) {
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const r0 = String(data[i]?.[0] || "").toLowerCase();
      const r1 = String(data[i]?.[1] || "").toLowerCase();
      const r3 = String(data[i]?.[3] || "").toLowerCase();
      if (r0.includes("admission") || r0.includes("تاريخ") || r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name") {
        startIdx = i + 1;
        break;
      }
    }
  }
  
  if (data.length <= startIdx) return [];
  
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }

  const sampleRow = data.slice(startIdx).find((r: any) => Array.isArray(r) && r.length > 5) || data[0] || [];
  const is30ColLayout = sampleRow.length < 35 && sampleRow.length >= 15;

  const defaultBedCol = 1;
  const defaultMrnCol = is30ColLayout ? -1 : 2;
  const defaultNameCol = is30ColLayout ? 2 : 3;
  const defaultDateCol = 0;
  const defaultPhysCol = is30ColLayout ? 14 : 22;
  const defaultContCol = is30ColLayout ? 6 : 12;

  const colRoomIdx = findCol(["bed#", "bedname_en", "bed", "room", "bed no", "الغرفة", "غرفة", "السرير", "سرير"], defaultBedCol, 'room');
  const colNameIdx = findCol(["patient name", "patient", "englishfullname", "name", "المريض", "اسم المريض", "الاسم", "اسم الحالة", "الاسم بالكامل"], defaultNameCol, 'name');
  const colPhysIdx = findCol(["treatingphysicianname", "consultantname_en", "physician", "doctor", "الطبيب", "الطبيب المعالج", "طبيب"], defaultPhysCol, 'name');
  const colContractorIdx = findCol(["contractor name", "contractorname", "contractor", "contract", "التعاقد", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع"], defaultContCol, 'text');
  const colAdmIdx = findCol(["admission date", "admissiondate", "date", "تاريخ الدخول", "التاريخ", "تاريخ", "admission", "no filters applied"], defaultDateCol, 'date');
  const colMrnIdx = findCol(["mrn", "patientbarcode", "patient id", "patient mrn", "رقم المريض", "الملف", "رقم الملف", "كود المريض"], defaultMrnCol, 'id');

  const body = data.slice(startIdx).map(row => {
    if (Array.isArray(row) && row.length === 6 && row[22] === undefined) {
      return [
        String(row[0] || "").trim(),
        String(row[1] || "").trim(),
        String(row[2] || "").trim(),
        String(row[3] || "").trim(),
        String(row[4] || "").trim(),
        String(row[5] || "").trim(),
      ];
    }
    const roomStr = colRoomIdx >= 0 ? cleanRoomStr(String(row[colRoomIdx] || "").trim()) : "";
    let nameStr = colNameIdx >= 0 ? String(row[colNameIdx] || "").trim() : "";
    let physStr = colPhysIdx >= 0 ? String(row[colPhysIdx] || "").trim() : "";
    let contStr = colContractorIdx >= 0 ? String(row[colContractorIdx] || "").trim() : "";
    const admStr = colAdmIdx >= 0 ? cleanAdmissionDateStr(row[colAdmIdx]) : "";
    let mrnStr = colMrnIdx >= 0 ? String(row[colMrnIdx] || "").trim() : "";

    // Safeguard numeric contractor (ALOS/LOS float leak)
    if (/^\d+(\.\d+)?$/.test(contStr)) {
      if (row.length < 35 && row[6] && !/^\d+(\.\d+)?$/.test(String(row[6]).trim())) {
        contStr = String(row[6]).trim();
      } else if (row.length >= 35 && row[12] && !/^\d+(\.\d+)?$/.test(String(row[12]).trim())) {
        contStr = String(row[12]).trim();
      } else {
        contStr = "";
      }
    }

    // Safeguard numeric name (Age leak)
    if (/^\d+$/.test(nameStr)) {
      if (mrnStr && !/^\d+$/.test(mrnStr)) {
        nameStr = mrnStr;
        mrnStr = "";
      } else if (row[2] && !/^\d+$/.test(String(row[2]).trim()) && !cleanRoomStr(String(row[2])).includes(roomStr)) {
        nameStr = String(row[2]).trim();
      }
    }

    // Safeguard surgical procedure in physician
    if (/closure|wounds|drainage|exploration|appendectomy|biopsy|laparoscopic|debridement|excision|fixation|amputation|استئصال|منظار|تفريغ|جراحة/i.test(physStr)) {
      if (row.length < 35 && row[14] && !/closure|wounds|drainage/i.test(String(row[14]))) {
        physStr = String(row[14]).trim();
      } else if (row.length >= 35 && row[22] && !/closure|wounds|drainage/i.test(String(row[22]))) {
        physStr = String(row[22]).trim();
      }
    }

    if (!mrnStr && nameStr) {
      mrnStr = buildDeterministicUnknownMrn(nameStr, roomStr);
    }
    return [
      roomStr,
      nameStr,
      physStr,
      contStr,
      admStr,
      mrnStr,
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
): { name: string; mrn: string; room: string; physician?: string; contractor?: string; date?: string; rawDate?: string; rawRow?: any[] }[] {
  if (!data || !Array.isArray(data) || data.length === 0) return [];

  const { headerRowIdx, findCol } = buildColumnIndexResolver(data);

  let startIdx = 0;
  if (headerRowIdx >= 0) {
    startIdx = headerRowIdx + 1;
  } else {
    for (let i = 0; i < Math.min(data.length, 10); i++) {
      const r0 = String(data[i][0] || "").toLowerCase();
      const r1 = String(data[i][1] || "").toLowerCase();
      const r3 = String(data[i][3] || "").toLowerCase();
      if (r0.includes("admission") || r0.includes("تاريخ") || r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name") {
        startIdx = i + 1;
        break;
      }
    }
  }

  const patientMap = new Map<string, { name: string; mrn: string; room: string; physician?: string; contractor?: string; date?: string; rawDate?: string; rawRow?: any[] }>();

  // Determine detected column indices or layout-aware defaults
  const sampleRow = data.slice(startIdx).find((r: any) => Array.isArray(r) && r.length > 5) || data[0] || [];
  const is30ColLayout = sampleRow.length < 35 && sampleRow.length >= 15;

  const defaultBedCol = 1;
  const defaultMrnCol = is30ColLayout ? -1 : 2;
  const defaultNameCol = is30ColLayout ? 2 : 3;
  const defaultDateCol = 0;
  const defaultPhysCol = is30ColLayout ? 14 : 22;
  const defaultContCol = is30ColLayout ? 6 : 12;

  const bedCol = findCol(["bed#", "bedname_en", "bed", "room", "bed no", "الغرفة", "غرفة", "السرير", "سرير"], defaultBedCol, 'room');
  const mrnCol = findCol(["mrn", "patientbarcode", "patient id", "patient mrn", "رقم المريض", "الملف", "رقم الملف", "كود المريض"], defaultMrnCol, 'id');
  const nameCol = findCol(["patient name", "patient", "englishfullname", "name", "المريض", "اسم المريض", "الاسم", "اسم الحالة"], defaultNameCol, 'name');
  const dateCol = findCol(["admission date", "admissiondate", "date", "تاريخ الدخول", "التاريخ", "تاريخ", "admission", "no filters applied"], defaultDateCol, 'date');
  const physCol = findCol(["treatingphysicianname", "consultantname_en", "physician", "doctor", "الطبيب", "الطبيب المعالج", "طبيب"], defaultPhysCol, 'name');
  const contCol = findCol(["contractor name", "contractorname", "contractor", "contract", "التعاقد", "جهة التعاقد", "اسم الجهة", "الجهة والتعاقد", "الجهة", "الشركة", "جهة الدفع"], defaultContCol, 'text');

  data.slice(startIdx).forEach((r: any[]) => {
    if (!Array.isArray(r) || r.length === 0) return;

    let rawRoom = "";
    let rawMrn = "";
    let rawName = "";
    let rawPhysician = "";
    let rawContractor = "";
    let rawDateStr = "";

    // Detect layout: 30+ column unified format vs 5/6-column formatted occupancy
    if (r.length >= 10 || (String(r[0] || "").includes("T") || (/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(String(r[0] || ""))))) {
      rawDateStr = dateCol >= 0 ? String(r[dateCol] || "").trim() : "";
      rawRoom = bedCol >= 0 ? cleanRoomStr(String(r[bedCol] || "").trim()) : "";
      rawMrn = mrnCol >= 0 ? String(r[mrnCol] || "").trim().replace(/^0+/, "") : "";
      rawName = nameCol >= 0 ? String(r[nameCol] || "").trim() : "";
      rawContractor = contCol >= 0 ? String(r[contCol] || "").trim() : "";
      rawPhysician = physCol >= 0 ? String(r[physCol] || "").trim() : "";
    } else {
      rawRoom = cleanRoomStr(String(r[0] || "").trim());
      rawName = String(r[1] || "").trim();
      rawPhysician = String(r[2] || "").trim();
      rawContractor = String(r[3] || "").trim();
      rawDateStr = String(r[4] || "").trim();
      rawMrn = String(r[5] || "").trim().replace(/^0+/, "");
    }

    // Guard 1: Contractor must not be a numeric ALOS/LOS number (e.g. 5.909090909 or 1)
    if (/^\d+(\.\d+)?$/.test(rawContractor)) {
      if (r.length < 35 && r[6] && !/^\d+(\.\d+)?$/.test(String(r[6]).trim())) {
        rawContractor = String(r[6]).trim();
      } else if (r.length >= 35 && r[12] && !/^\d+(\.\d+)?$/.test(String(r[12]).trim())) {
        rawContractor = String(r[12]).trim();
      } else {
        rawContractor = "";
      }
    }

    // Guard 2: Patient Name must not be a pure number (e.g. "39" which is age)
    if (/^\d+$/.test(rawName)) {
      if (rawMrn && !/^\d+$/.test(rawMrn)) {
        rawName = rawMrn;
        rawMrn = "";
      } else if (r[2] && !/^\d+$/.test(String(r[2]).trim()) && !cleanRoomStr(String(r[2])).includes(rawRoom)) {
        rawName = String(r[2]).trim();
      }
    }

    // Guard 3: Heuristic inversion safeguard between MRN and Name
    if (/[\u0600-\u06FF]/.test(rawMrn) && (/^\d+$/.test(rawName.replace(/^0+/, '')) || !rawName)) {
      const temp = rawMrn;
      rawMrn = rawName.replace(/^0+/, '');
      rawName = temp;
    }

    // Guard 4: Physician must not be an operative note / diagnosis (e.g. "Layer Closure...")
    if (/closure|wounds|drainage|exploration|appendectomy|biopsy|laparoscopic|debridement|excision|fixation|amputation|استئصال|منظار|تفريغ|جراحة/i.test(rawPhysician)) {
      if (r.length < 35 && r[14] && !/closure|wounds|drainage|exploration|appendectomy|biopsy/i.test(String(r[14]))) {
        rawPhysician = String(r[14]).trim();
      } else if (r.length >= 35 && r[22] && !/closure|wounds|drainage|exploration|appendectomy|biopsy/i.test(String(r[22]))) {
        rawPhysician = String(r[22]).trim();
      }
    }

    // Ensure deterministic surrogate MRN if missing
    if (!rawMrn && rawName) {
      rawMrn = buildDeterministicUnknownMrn(rawName, rawRoom);
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
      rawDate: rawDateStr,
      rawRow: [...r]
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
