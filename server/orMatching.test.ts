import { describe, it, expect } from 'vitest';
import { isWholeNameMatch } from './nameUtils.js';
import { findOccupancyPatient, getEnrichedOrListForStats } from './orLogic.js';

describe('OR-to-Occupancy Matching & Non-Inpatient Bed Exclusions', () => {
  const headerRows = [
    ['', '', '', '', '', ''],
    ['Room', 'Patient Name', 'Physician', 'Contractor', 'Admission Date', 'MRN'],
    ['', '', '', '', '', ''],
  ];

  const sampleOccRows = [
    ...headerRows,
    ['HomeCare 14', 'حسن احمد عبدالمنعم محمد', 'Other Ex. Physician', 'Home Care - Cash', '14-11-2026 15:58', '0000274246'],
    ['Dialysis Bed 3', 'علي ابراهيم احمد محمد', 'kamel El-batat', 'Cash', '19-11-2026 09:15', '0000209854'],
    ['Bed 308', 'عبدالمنعم احمد عبدالمنعم محمد', 'Yasser Nour', 'Main العامرية لتكرير البترول', '19-11-2026 06:07', '0000185876'],
    ['Bed 418', 'احمد السيد محمد حسن حبيش', 'Amr Elwany', 'Aniat masr عنايه مصر', '19-11-2026 08:37', '0000137452'],
    ['Bed 409', 'احمد ايهاب علي ابراهيم', 'Salah Elgohary', 'شركة ميتلايف اليكو', '19-11-2026 14:14', '0000273596'],
  ];

  it('never matches different first names or unordered bag-of-words in isWholeNameMatch', () => {
    expect(isWholeNameMatch('احمد ايهاب علي ابراهيم', 'علي ابراهيم احمد محمد', true)).toBe(false);
    expect(isWholeNameMatch('عبدالمنعم احمد عبدالمنعم محمد', 'حسن احمد عبدالمنعم محمد', true)).toBe(false);
    expect(isWholeNameMatch('احمد السيد محمد حسن حبيش', 'حسن احمد عبدالمنعم محمد', false)).toBe(false);
    expect(isWholeNameMatch('احمد ايهاب علي ابراهيم', 'احمد ايهاب علي ابراهيم', true)).toBe(true);
  });

  it('matches the three reported OR patients to their real inpatient beds and never Dialysis Bed 3 or HomeCare 14', () => {
    const orList = [
      {
        patientName: 'احمد ايهاب علي ابراهيم',
        mrn: '273596',
        vt: 'HC',
        column3: 'Out',
        surgeonName: 'Salah Elgohary',
        orRoom: 'OR - 6',
      },
      {
        patientName: 'عبدالمنعم احمد عبدالمنعم محمد',
        mrn: '185876',
        vt: 'HC',
        column3: 'Out',
        surgeonName: 'Yasser Nour',
        orRoom: 'OR - 1',
      },
      {
        patientName: 'احمد السيد محمد حسن حبيش',
        mrn: '137452',
        vt: 'PrivateCredit',
        column3: '',
        surgeonName: 'Amr Elwany',
        orRoom: 'OR - 5',
      },
    ];

    const enriched = getEnrichedOrListForStats(orList, sampleOccRows);
    expect(enriched[0].realStatus).toBe('IN');
    expect(enriched[0].dischargeStatus).toBe('Currently Admitted / منوم حالياً');
    expect(findOccupancyPatient(orList[0].patientName, sampleOccRows, true, orList[0].mrn, orList[0].surgeonName)?.room).toBe('Bed 409');

    expect(enriched[1].realStatus).toBe('IN');
    expect(findOccupancyPatient(orList[1].patientName, sampleOccRows, true, orList[1].mrn, orList[1].surgeonName)?.room).toBe('Bed 308');

    expect(enriched[2].realStatus).toBe('IN');
    expect(findOccupancyPatient(orList[2].patientName, sampleOccRows, false, orList[2].mrn, orList[2].surgeonName)?.room).toBe('Bed 418');
  });

  it('returns null (Not Admitted) when the patient is not in any inpatient bed even if a similar name is in Dialysis or HomeCare', () => {
    const occWithoutInpatientMatches = [
      ...headerRows,
      ['HomeCare 14', 'حسن احمد عبدالمنعم محمد', 'Other Ex. Physician', 'Home Care - Cash', '14-11-2026 15:58', '0000274246'],
      ['Dialysis Bed 3', 'علي ابراهيم احمد محمد', 'kamel El-batat', 'Cash', '19-11-2026 09:15', '0000209854'],
    ];

    expect(findOccupancyPatient('احمد ايهاب علي ابراهيم', occWithoutInpatientMatches, true, '273596', 'Salah Elgohary')).toBeNull();
    expect(findOccupancyPatient('عبدالمنعم احمد عبدالمنعم محمد', occWithoutInpatientMatches, true, '185876', 'Yasser Nour')).toBeNull();
    expect(findOccupancyPatient('احمد السيد محمد حسن حبيش', occWithoutInpatientMatches, false, '137452', 'Amr Elwany')).toBeNull();
  });

  it('still blocks cross-patient false match even when OR MRN is missing or placeholder 65765', () => {
    expect(findOccupancyPatient('احمد ايهاب علي ابراهيم', sampleOccRows.slice(0, 5), true, '0000065765', 'Salah Elgohary')).toBeNull();
    expect(findOccupancyPatient('عبدالمنعم احمد عبدالمنعم محمد', sampleOccRows.slice(0, 5), true, '', 'Yasser Nour')).toBeNull();
    expect(findOccupancyPatient('احمد السيد محمد حسن حبيش', sampleOccRows.slice(0, 5), false, '', 'Amr Elwany')).toBeNull();
  });
});
