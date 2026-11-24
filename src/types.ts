export interface TransferStep {
  fromRoom: string;
  toRoom: string;
  date: string;
  physician?: string;
  contractor?: string;
  notes?: string;
}

export interface PatientTransferRecord {
  id: string;
  name: string;
  mrn?: string;
  initialRoom: string;
  currentRoom: string;
  journey: string[];
  history: TransferStep[];
  lastTransferDate: string;
  physician?: string;
  contractor?: string;
  notes?: string;
}

export type ApprovalSeverity = 'critical' | 'warning' | 'ok';

export interface InsuranceApprovalItem {
  mrn: string;
  patientName: string;
  room: string;
  contractor: string;
  physician: string;
  agentName: string;
  admissionDate: string;
  los: number;
  status: string;
  totalRequests: number;
  pendingRequests: number;
  inProgressRequests: number;
  rejectedRequests: number;
  closedRequests: number;
  uploadedApprovals: number;
  invoiceComment: string;
  severity: ApprovalSeverity;
}

export interface ApprovalGroupStat {
  contractor?: string;
  agent?: string;
  patients: number;
  bottlenecks: number;
  pending: number;
  inProgress: number;
  rejected: number;
  closed: number;
  total: number;
}

export interface InsuranceApprovalsPayload {
  source?: string;
  updatedAt?: string;
  hash?: string;
  isStale?: boolean;
  summary: {
    totalPatients: number;
    patientsWithBottlenecks: number;
    totalPending: number;
    totalInProgress: number;
    totalRejected: number;
    totalClosed: number;
    totalRequests: number;
    needUpdateCount: number;
    byContractor: ApprovalGroupStat[];
    byAgent: ApprovalGroupStat[];
  };
  items: InsuranceApprovalItem[];
}

export interface OPDLiveSpecialtyStat {
  specialty: string;
  total: number;
  reserved: number;
  waiting: number;
  inClinic: number;
  completed: number;
  cancelled: number;
  confirmedQueueWaiting: number;
  pendingTicketRequests: number;
}

export interface OPDLivePhysicianStat {
  physicianEn: string;
  physicianAr: string;
  specialty: string;
  total: number;
  reserved: number;
  waiting: number;
  inClinic: number;
  completed: number;
  cancelled: number;
  confirmedQueueWaiting: number;
  confirmedQueueInClinic: number;
  confirmedQueueCompleted: number;
  pendingTicketRequests: number;
  maxOccupancy?: number;
  utilizationPct?: number | null;
}

export interface OPDLiveQueuePhysicianAr {
  physicianAr: string;
  specialty: string;
  waiting: number;
  inClinic: number;
  completed: number;
  pendingTicketRequests: number;
}

export interface OPDLivePayload {
  opdDate: string;
  source?: string;
  updatedAt?: string;
  hash?: string;
  isStale?: boolean;
  summary: {
    totalBookings: number;
    reserved: number;
    arrivedWaiting: number;
    inClinic: number;
    completed: number;
    cancelled: number;
    showUpRatePct: number;
    confirmedQueueWaiting: number;
    confirmedQueueInClinic: number;
    confirmedQueueCompleted: number;
    pendingTicketRequests: number;
  };
  bySpecialty: OPDLiveSpecialtyStat[];
  byPhysician: OPDLivePhysicianStat[];
  queueByPhysicianAr: OPDLiveQueuePhysicianAr[];
}

export interface ProcedureCaseItem {
  serial: string;
  procedureDate: string;
  room: string;
  startTime: string;
  endTime: string;
  rawStartTime?: string;
  rawEndTime?: string;
  timeNormalized?: boolean;
  actualStart: string;
  actualEnd: string;
  actualStartTime?: string;
  actualEndTime?: string;
  status: string;
  mrn: string;
  patientName: string;
  surgeonName: string;
  engOperationName: string;
  arOperationName: string;
  contractorName: string;
  paidBy: string;
  flClassName: string;
  vt: string;
  postC: string;
  preparationInstructions: string;
  operativeComment: string;
  cathlabDose: string;
}

export interface ProcedureUnitPayload {
  unit: 'cathlab' | 'endoscopy';
  referenceDate: string;
  windowStart?: string;
  windowEnd?: string;
  source?: string;
  updatedAt?: string;
  hash?: string;
  isStale?: boolean;
  summary: {
    todayCount: number;
    upcomingCount: number;
    recentCount: number;
    inProgressCount: number;
    completedTodayCount: number;
    scheduledTodayCount: number;
  };
  items: ProcedureCaseItem[];
}

export interface ProceduresDataResponse {
  cathlab: ProcedureUnitPayload | null;
  endoscopy: ProcedureUnitPayload | null;
}
