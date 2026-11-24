import { describe, expect, it } from 'vitest';
import {
  cleanMrnKey,
  computeFeedFreshness,
  enrichOpdLiveWithScheduleCapacity,
  filterProcedureCases,
  matchApprovalForPatient,
} from './newFeedsLogic';
import type { InsuranceApprovalsPayload, OPDLivePayload, ProcedureCaseItem } from '../src/types';

describe('newFeedsLogic', () => {
  it('matches approvals by cleaned MRN first, then room fallback', () => {
    const payload: InsuranceApprovalsPayload = {
      summary: {
        totalPatients: 2,
        patientsWithBottlenecks: 1,
        totalPending: 0,
        totalInProgress: 1,
        totalRejected: 2,
        totalClosed: 1,
        totalRequests: 4,
        needUpdateCount: 0,
        byContractor: [],
        byAgent: [],
      },
      items: [
        {
          mrn: '12345',
          patientName: 'Patient A',
          room: 'Room 301',
          contractor: 'Next Care',
          physician: 'Dr. Ali',
          agentName: 'Agent 1',
          admissionDate: '2026-11-20',
          los: 4,
          status: 'ApprovalsForEverything',
          totalRequests: 3,
          pendingRequests: 0,
          inProgressRequests: 1,
          rejectedRequests: 2,
          closedRequests: 0,
          uploadedApprovals: 1,
          invoiceComment: 'CT pending',
          severity: 'critical',
        },
      ],
    };

    expect(cleanMrnKey('00012345')).toBe('12345');
    expect(matchApprovalForPatient('0012345', 'Room 999', payload)?.contractor).toBe('Next Care');
    expect(matchApprovalForPatient('', 'room 301', payload)?.mrn).toBe('12345');
    expect(matchApprovalForPatient('99999', 'Room 999', payload)).toBeNull();
  });

  it('enriches OPD live physicians with maxOccupancy utilization and Arabic queue counts', () => {
    const opdLive: OPDLivePayload = {
      opdDate: '2026-11-24',
      summary: {
        totalBookings: 20,
        reserved: 5,
        arrivedWaiting: 6,
        inClinic: 2,
        completed: 5,
        cancelled: 2,
        showUpRatePct: 72.2,
        confirmedQueueWaiting: 6,
        confirmedQueueInClinic: 2,
        confirmedQueueCompleted: 5,
        pendingTicketRequests: 1,
      },
      bySpecialty: [],
      byPhysician: [
        {
          physicianEn: 'Dr. Tarek Hassan',
          physicianAr: '',
          specialty: 'Orthopedic Surgery',
          total: 20,
          reserved: 5,
          waiting: 6,
          inClinic: 2,
          completed: 5,
          cancelled: 2,
          confirmedQueueWaiting: 0,
          confirmedQueueInClinic: 0,
          confirmedQueueCompleted: 0,
          pendingTicketRequests: 0,
        },
      ],
      queueByPhysicianAr: [
        {
          physicianAr: 'طارق حسن',
          specialty: 'Orthopedic Surgery',
          waiting: 6,
          inClinic: 2,
          completed: 5,
          pendingTicketRequests: 1,
        },
      ],
    };

    const enriched = enrichOpdLiveWithScheduleCapacity(opdLive, [
      { physicianEn: 'Tarek Hassan', physicianAr: 'د. طارق حسن', maxOccupancy: 20 },
    ]);

    expect(enriched?.byPhysician[0].maxOccupancy).toBe(20);
    expect(enriched?.byPhysician[0].utilizationPct).toBe(90); // (20 - 2) / 20 = 90%
    expect(enriched?.byPhysician[0].confirmedQueueWaiting).toBe(6);
    expect(enriched?.byPhysician[0].pendingTicketRequests).toBe(1);
  });

  it('filters procedure cases into today, upcoming, recent, and specific date buckets', () => {
    const mk = (date: string): ProcedureCaseItem => ({
      serial: '1',
      procedureDate: date,
      room: 'Cath Lab Theatre',
      startTime: '10:00 AM',
      endTime: '11:00 AM',
      actualStart: '',
      actualEnd: '',
      status: 'Scheduled',
      mrn: '100',
      patientName: 'Test',
      surgeonName: 'Dr. X',
      engOperationName: 'PCI',
      arOperationName: 'قسطرة',
      contractorName: 'Cash',
      paidBy: 'Cash',
      flClassName: '',
      vt: '',
      postC: '',
      preparationInstructions: '',
      operativeComment: '',
      cathlabDose: '',
    });
    const cases = [mk('2026-11-22'), mk('2026-11-24'), mk('2026-11-26')];

    expect(filterProcedureCases(cases, '2026-11-24', 'today')).toHaveLength(1);
    expect(filterProcedureCases(cases, '2026-11-24', 'upcoming')).toHaveLength(1);
    expect(filterProcedureCases(cases, '2026-11-24', 'recent')).toHaveLength(1);
    expect(filterProcedureCases(cases, '2026-11-24', 'all')).toHaveLength(3);
    expect(filterProcedureCases(cases, '2026-11-24', 'today', '2026-11-26')).toHaveLength(1);
  });

  it('computes freshness accurately', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    expect(computeFeedFreshness('2026-11-24T11:30:00Z', 90, now)).toEqual({ isStale: false, ageMinutes: 30 });
    expect(computeFeedFreshness('2026-11-24T09:00:00Z', 90, now)).toEqual({ isStale: true, ageMinutes: 180 });
    expect(computeFeedFreshness(null, 90, now)).toEqual({ isStale: true, ageMinutes: null });
  });
});
