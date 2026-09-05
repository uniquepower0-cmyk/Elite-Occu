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
