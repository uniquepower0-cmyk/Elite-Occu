export interface PatientRow {
  room: string;
  name: string;
  physician?: string;
  contractor?: string;
  date?: string;
  mrn?: string;
  rawDate?: string;
}

export interface PatientTransfer {
  id?: string;
  patientName: string;
  mrn: string;
  previousRoom: string;
  newRoom: string;
  physician?: string;
  contractor?: string;
  date: string;
  timestamp: number;
  transferType?: 'inpatient' | 'procedure_transfer' | 'direct_admission' | 'return_from_procedure';
  isAutoDetected?: boolean;
}

export interface ORItem {
  id?: string;
  serial?: number | string;
  startTime?: string;
  endTime?: string;
  patientName: string;
  mrn?: string;
  engOperation?: string;
  arabicOperation?: string;
  surgeonName?: string;
  column2?: string;
  orRoom?: string;
  room?: string;
  column3?: string;
  contractorName?: string;
  contractor?: string;
  paidBy?: string;
  postC?: string;
  vt?: string;
  flClassName?: string;
  admissionDate?: string;
  rawDate?: string;
  realStatus?: 'IN' | 'OUT';
  isDischarged?: boolean;
  dischargedFromRoom?: string;
  dischargeStatus?: string;
  listType?: 'on-list' | 'over-list';
  roomDisplay?: string;
  isMatchedFromOccupancy?: boolean;
}

export interface DischargedPatient {
  id?: string;
  mrn?: string;
  name: string;
  room?: string;
  lastRoom?: string;
  physician?: string;
  contractor?: string;
  date?: string;
  admissionDate?: string;
  dischargeDate?: string;
  dischargeType?: 'manual' | 'auto';
  restored?: boolean;
}

export interface AccommodationStat {
  category: string;
  count: number;
}

export interface FloorStats {
  floor: string;
  occupied: number;
  total: number;
  accommodations: AccommodationStat[];
}
