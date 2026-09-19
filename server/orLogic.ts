import {
  isNameMatch,
  isWholeNameMatch,
  isMRNMatch,
  isPhysicianMatch,
  isPatientFirstNameMatch,
  isOperatingRoom,
  isOrXRoom,
  cleanRoomStr,
  normalizeRoom,
  getAccommodationCategory,
  normalizeArabicName
} from './nameUtils';
import { getOccupancyRows } from './occupancyLogic';

export function classifyInOutFallback(p: any): 'IN' | 'OUT' {
  if (!p) return 'OUT';
  const vt = String(p.vt || "").toUpperCase().trim();
  const column3 = String(p.column3 || "").toUpperCase().trim();
  const flClassName = String(p.flClassName || "").toUpperCase().trim();
  const postC = String(p.postC || "").toUpperCase().trim();
  const orRoom = String(p.orRoom || p.room || "").toUpperCase().trim();

  // Hospital ward accommodation classes (319, 325, 401-B, اولي عاديه, اولي مميزه, جناح, حسب التعاقد, حسب المريض, etc.)
  const isHospitalClass = 
    /\b\d{3}\b/.test(flClassName) || 
    flClassName.includes("اولي") || 
    flClassName.includes("أولي") || 
    flClassName.includes("مميز") || 
    flClassName.includes("جناح") || 
    flClassName.includes("حسب التعاقد") || 
    flClassName.includes("حسب المريض") ||
    flClassName.includes("درجة") ||
    flClassName.includes("درجه") ||
    flClassName.includes("عادية") ||
    flClassName.includes("عاديه") ||
    flClassName.includes("شمالي") ||
    flClassName.includes("جنوبي") ||
    flClassName.includes("HC") ||
    flClassName.includes("IP") ||
    flClassName.includes("IN") ||
    flClassName.includes("PRIVATECREDIT") ||
    flClassName.includes("CREDIT");

  if (isHospitalClass) {
    return 'IN';
  }

  // Scheduled in an Operating Room suite (OR - 1 to OR - 8)
  if (isOperatingRoom(orRoom) || /^OR\s*[-]?\s*\d+/i.test(orRoom) || orRoom.includes("OR")) {
    return 'IN';
  }

  // Explicit Hospital Case/Inpatient checking (HC, Inpatient, PrivateCredit)
  if (vt === "HC" || vt.includes("HOSPITAL") || vt === "INPATIENT" || vt === "PRIVATECREDIT" || column3.includes("INSURED") || column3.includes("HC") || column3.includes("IN")) {
    return 'IN';
  }

  // Check if post-operative care requires critical care (ICU/SICU) overnight stay
  const upperPostC = postC.toUpperCase();
  if (upperPostC.includes("ICU") || upperPostC.includes("SICU") || upperPostC.includes("CCU") || upperPostC.includes("NICU")) {
    return 'IN';
  }

  // Explicit Day Case/Outpatient checking (DC, DayCase, Outpatient, etc.) only if not in OR suite or hospital class
  if (vt === "DC" || vt.includes("DAY") || vt.includes("DAYCASE") || vt.includes("OUT")) {
    return 'OUT';
  }

  return 'IN';
}

export function findOccupancyPatient(
  pName: string,
  occRows: any[][],
  isTaggedOut: boolean = false,
  mrn?: string,
  surgeonName?: string,
  patientRoomRegistry?: Record<string, any>
) {
  const searchName = String(pName || "").trim();
  const searchMRN = String(mrn || "").trim().replace(/^0+/, "");
  const searchSurgeonName = String(surgeonName || "").trim();
  if (!searchName && !searchMRN) return null;

  // 1. First check patientRoomRegistry if available
  if (patientRoomRegistry) {
    if (searchMRN) {
      for (const key in patientRoomRegistry) {
        const item = patientRoomRegistry[key];
        const itemMrn = String(item.mrn || "").trim().replace(/^0+/, "");
        if (itemMrn && isMRNMatch(searchMRN, itemMrn)) {
          if (!isOperatingRoom(item.lastRoom)) {
            return {
              room: item.lastRoom || item.room || '',
              patientName: item.name || searchName,
              physician: item.physician || '',
              contractor: item.contractor || '',
              admissionDate: item.date || '',
              mrn: itemMrn
            };
          }
        }
      }
    }
    if (searchName) {
      for (const key in patientRoomRegistry) {
        const item = patientRoomRegistry[key];
        const itemName = item.name || key;
        if (isNameMatch(searchName, itemName) || isWholeNameMatch(searchName, itemName, isTaggedOut)) {
          if (!isOperatingRoom(item.lastRoom)) {
            return {
              room: item.lastRoom || item.room || '',
              patientName: itemName,
              physician: item.physician || '',
              contractor: item.contractor || '',
              admissionDate: item.date || '',
              mrn: item.mrn || ''
            };
          }
        }
      }
    }
  }

  if (!occRows || occRows.length === 0) return null;
  const rows = occRows.slice(3);
  
  // 2. Check exact/strong whole-name comparison (skipping pure OR rooms)
  if (searchName) {
    for (const row of rows) {
      const roomStr = String(row[0] || "").trim();
      if (isOperatingRoom(roomStr)) continue;
      
      const occName = String(row[1] || "").trim();
      if (isNameMatch(searchName, occName) || isWholeNameMatch(searchName, occName, isTaggedOut)) {
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

  // 3. Try matching by MRN
  if (searchMRN) {
    for (const row of rows) {
      const roomStr = String(row[0] || "").trim();
      if (isOperatingRoom(roomStr)) continue;
      
      const occMRN = String(row[5] || "").trim().replace(/^0+/, "");
      const occName = String(row[1] || "").trim();
      if (isMRNMatch(searchMRN, occMRN)) {
        if (!searchName || isNameMatch(searchName, occName) || isPatientFirstNameMatch(searchName, occName)) {
          return {
            room: roomStr,
            patientName: occName,
            physician: String(row[2] || "").trim(),
            contractor: String(row[3] || "").trim(),
            admissionDate: String(row[4] || "").trim(),
            mrn: occMRN
          };
        }
      }
    }
  }

  // 4. Try matching by Physician + Patient Name Match
  if (searchName && searchSurgeonName) {
    for (const row of rows) {
      const roomStr = String(row[0] || "").trim();
      if (isOperatingRoom(roomStr)) continue;

      const occName = String(row[1] || "").trim();
      const occPhysician = String(row[2] || "").trim();
      if (isPhysicianMatch(searchSurgeonName, occPhysician) && isNameMatch(searchName, occName)) {
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

  return null;
}

export function findAdmittedRoomForInPatient(
  pName: string,
  occRows: any[][],
  mrn?: string,
  surgeonName?: string,
  patientRoomRegistry?: Record<string, any>
): string {
  const occPatient = findOccupancyPatient(pName, occRows, false, mrn, surgeonName, patientRoomRegistry);
  if (occPatient && occPatient.room) {
    return occPatient.room;
  }
  return "Not Found in Occupancy Sheet / غير موجود بشيت الإشغال";
}

export function getEnrichedOrListForStats(
  orList: any[],
  occRows: any[][],
  cumulativeDischarged: any[] = [],
  patientRoomRegistry?: Record<string, any>
): any[] {
  if (!orList || orList.length === 0) return [];

  return orList.map(p => {
    const vt = String(p.vt || "").toUpperCase().trim();
    const column3 = String(p.column3 || "").toUpperCase().trim();
    const flClassName = String(p.flClassName || "").toUpperCase().trim();
    const postC = String(p.postC || "").toUpperCase().trim();

    const isTaggedOut = vt === "DC" || vt.includes("OUT") || vt.includes("DAY") || vt.includes("DAYCASE") ||
                        column3.includes("OUT") || column3.includes("DC") || 
                        flClassName.includes("OUT") || flClassName.includes("DAY") || flClassName.includes("DAYCASE") ||
                        postC.includes("OUT") || postC.includes("DC");

    const occPatient = findOccupancyPatient(p.patientName, occRows, isTaggedOut, p.mrn, p.surgeonName, patientRoomRegistry);
    
    const pMrn = String(p.mrn || "").trim().replace(/^0+/, "");
    const matchingDischargedObj = (cumulativeDischarged || []).find(discPt => {
      const discRoom = String(discPt.room || discPt.colB || "").toLowerCase();
      if (discRoom.includes("dialysis") || discRoom.includes("غسيل") || isOperatingRoom(discRoom)) return false;
      const discMrn = String(discPt.id || discPt.mrn || "").trim().replace(/^0+/, "");
      const matchByMrn = pMrn && discMrn && isMRNMatch(pMrn, discMrn);
      const matchByName = isWholeNameMatch(p.patientName, discPt.name || "");
      return matchByMrn || matchByName;
    });

    const isDischarged = !!matchingDischargedObj;
    const fallbackStatus = classifyInOutFallback(p);
    const isAdmitted = !!occPatient || isDischarged || (fallbackStatus === 'IN');

    const dischargedFromRoom = matchingDischargedObj ? (matchingDischargedObj.room || matchingDischargedObj.lastRoom || '') : '';
    const dischargeStatusText = isDischarged
      ? `Discharged (Room ${dischargedFromRoom}) / تم الخروج (غرفة ${dischargedFromRoom})`
      : 'Discharged / تم الخروج';

    return {
      ...p,
      patientName: p.patientName,
      realStatus: isAdmitted ? 'IN' : 'OUT',
      isDischarged,
      dischargedFromRoom,
      dischargeStatus: isDischarged ? dischargeStatusText : (occPatient ? 'Currently Admitted / منوم حالياً' : 'Not Admitted / غير منوم'),
      listType: 'on-list',
      admissionDate: occPatient ? occPatient.admissionDate : (matchingDischargedObj ? (matchingDischargedObj.date || matchingDischargedObj.admissionDate || '') : '')
    };
  });
}

export function getOverListPatients(data: any[][] | null, orList: any[]): any[] {
  if (!data || !Array.isArray(data)) return [];
  
  let startIdx = 3;
  for (let i = 0; i < Math.min(data.length, 10); i++) {
    const r1 = String(data[i][1] || "").toLowerCase();
    const r3 = String(data[i][3] || "").toLowerCase();
    if (r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r3 === "name" || r1 === "غرفة") {
      startIdx = i + 1;
      break;
    }
  }

  const overListPatients: any[] = [];
  const orListClean = (orList || []).map(p => ({
    name: normalizeArabicName(p.patientName || ""),
    mrn: String(p.mrn || "").trim().replace(/^0+/, "")
  }));

  data.slice(startIdx).forEach((row, idx) => {
    const rawRoom = String(row[1] || "").trim();
    const patientName = String(row[3] || "").trim();
    const mrn = String(row[2] || "").trim().replace(/^0+/, "");
    const physician = String(row[22] || "").trim();
    const contractor = String(row[12] || "").trim();
    const admDate = String(row[0] || "").trim();

    if (isOrXRoom(rawRoom) && patientName) {
      const normName = normalizeArabicName(patientName);
      const isFoundInORList = orListClean.some(orP => {
        if (mrn && orP.mrn && mrn === orP.mrn) return true;
        return isNameMatch(patientName, orP.name) || (normName && normName === orP.name);
      });

      if (!isFoundInORList) {
        overListPatients.push({
          id: `over-list-${idx}-${Date.now()}`,
          patientName,
          mrn,
          room: rawRoom,
          orRoom: rawRoom,
          physician,
          surgeonName: physician,
          contractor,
          contractorName: contractor,
          admissionDate: admDate,
          realStatus: 'IN',
          listType: 'over-list',
          notes: 'Present in OR Room in Occupancy sheet but absent from OR list schedule'
        });
      }
    }
  });

  return overListPatients;
}

export function getAvailableVacantRooms(occRows: any[][]): { [key: string]: string[] } {
  const occupiedRooms = new Set<string>();
  if (occRows && occRows.length > 3) {
    occRows.slice(3).forEach(row => {
      const roomStr = String(row[0] || "").trim();
      const norm = normalizeRoom(roomStr);
      if (norm) {
        occupiedRooms.add(norm);
      }
    });
  }

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
    if (room === "108") return;

    const match = room.match(/^(40[1-5])\s*([AB])$/);
    if (match) {
      const base = match[1];
      const variant = match[2];
      
      const isBaseOccupied = occupiedRooms.has(base);
      const isAOccupied = occupiedRooms.has(`${base}A`);
      const isBOccupied = occupiedRooms.has(`${base}B`);
      
      if (!isBaseOccupied && !isAOccupied) {
        if (!isBOccupied || variant === 'A') {
          vacantRoomsRaw.push(room);
        }
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

  vacantRooms.forEach(r => {
    const cat = getAccommodationCategory(r);
    if (groupedVacant[cat]) {
      groupedVacant[cat].push(r);
    } else {
      if (!groupedVacant["أخرى"]) groupedVacant["أخرى"] = [];
      groupedVacant["أخرى"].push(r);
    }
  });

  return groupedVacant;
}
