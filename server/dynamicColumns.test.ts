import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { buildColumnIndexResolver, buildDeterministicUnknownMrn, formatMrnForSheet, formatRoomForSheet } from './columnResolver.js';
import { getOccupancyRows, getOccupancyRowsUnfiltered } from './occupancyLogic.js';
import { addRefinedDebtsSheet } from './excelGenerators.js';

// Load test_occupancy.xlsx data via python exporter or json
function loadTestOccupancyRows(): any[][] {
  const xlsxPath = path.resolve(process.cwd(), 'test_occupancy.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    throw new Error('test_occupancy.xlsx not found in root');
  }
  const cmd = `python3 -c "import openpyxl, json; wb=openpyxl.load_workbook('${xlsxPath}', data_only=True); s=wb.active; r=[[cell.isoformat() if hasattr(cell, 'isoformat') else ('' if cell is None else str(cell).strip()) for cell in row] for row in s.iter_rows(values_only=True)]; print(json.dumps(r))"`;
  const output = require('child_process').execSync(cmd).toString();
  return JSON.parse(output);
}

describe('Dynamic Column Detection on Occupancy Sheets', () => {
  it('correctly detects shifted columns in test_occupancy.xlsx without MRN collision', () => {
    const rawRows = loadTestOccupancyRows();
    expect(rawRows.length).toBeGreaterThan(10);

    const { headerRowIdx, findCol } = buildColumnIndexResolver(rawRows);
    expect(headerRowIdx).toBe(2); // Row 3 in Excel (0-indexed 2)

    // In test_occupancy.xlsx:
    // Col 0: Admission Date (Date)
    // Col 1: Bed# (Room)
    // Col 2: Patient Name (Shifted to Col 2 where MRN was previously)
    // Col 10: LOS
    // Col 12: Elite ALOS
    // Col 13: Contractor Name
    // Col 14: TreatingPhysicianName
    // Col 15: Specialty
    // Col 16: Invoice Total
    // Col 17: Payments
    // Col 18: Remaining
    // MRN: Not present at all!

    const colAdm = findCol(["admission date", "admissiondate", "date", "تاريخ الدخول"], 0, 'date');
    const colBed = findCol(["bed#", "bedname_en", "bed", "room", "الغرفة", "سرير"], 1, 'room');
    const colName = findCol(["patient name", "patient", "englishfullname", "name", "المريض"], 3, 'name');
    const colMrn = findCol(["mrn", "patientbarcode", "patient id", "patient mrn", "رقم المريض"], 2, 'id');
    const colContractor = findCol(["contractor name", "contractorname", "contractor", "التعاقد", "جهة التعاقد"], 12, 'text');
    const colPhysician = findCol(["treatingphysicianname", "consultantname_en", "physician", "doctor", "الطبيب"], 22, 'name');
    const colSpecialty = findCol(["specialty", "speciality", "التخصص"], 23, 'text');
    const colTotal = findCol(["invoice total", "total invoice", "ftotal", "total", "إجمالي الفاتورة"], 25, 'number');
    const colRemaining = findCol(["remaining", "difference", "المتبقي", "مديونية"], 27, 'number');
    const colLos = findCol(["los", "length of stay", "مدة الإقامة"], 9, 'number');
    const colAlos = findCol(["elite alos", "benchmark alos", "alos"], 11, 'number');

    expect(colAdm).toBe(0);
    expect(colBed).toBe(1);
    expect(colName).toBe(2); // Name is in Column 2!
    
    // Crucial check: MRN column was omitted in test_occupancy.xlsx.
    // The candidate search must NOT pick up Column 2 (Patient Name) as MRN,
    // and defaultIdx 2 must be rejected by isContentValid because Column 2 contains human names.
    expect(colMrn).toBe(-1);

    expect(colContractor).toBe(6);
    expect(colPhysician).toBe(14);
    expect(colSpecialty).toBe(15);
    expect(colTotal).toBe(16);
    expect(colRemaining).toBe(18);
    expect(colLos).toBe(10);
    expect(colAlos).toBe(12);

    // Verify first data row values with resolved indices
    const firstDataRow = rawRows[3];
    expect(firstDataRow[colBed]).toBe('Bed 304');
    expect(firstDataRow[colName]).toBe('Fatima Mahhate Eldahshan .');
    expect(firstDataRow[colContractor]).toBe('Elite Tours - ايليت للسياحة');
    expect(firstDataRow[colPhysician]).toBe('Mohamed Sabry Hassan El Tarhony');
    expect(firstDataRow[colSpecialty]).toBe('Pulmonology');
    expect(parseFloat(firstDataRow[colTotal])).toBe(0);
    expect(parseFloat(firstDataRow[colRemaining])).toBe(0);
  });

  it('correctly maps standard legacy occ.json layout', () => {
    const occJsonPath = path.resolve(process.cwd(), 'occ.json');
    if (!fs.existsSync(occJsonPath)) return;

    const occData = JSON.parse(fs.readFileSync(occJsonPath, 'utf-8'));
    const rows = occData.data || occData;
    if (!Array.isArray(rows) || rows.length < 5) return;

    const { headerRowIdx, findCol } = buildColumnIndexResolver(rows);
    expect(headerRowIdx).toBeGreaterThanOrEqual(0);

    const colBed = findCol(["bed#", "bedname_en", "bed", "room", "الغرفة"], 1, 'room');
    const colMrn = findCol(["mrn", "patientbarcode", "patient id", "رقم المريض"], 2, 'id');
    const colName = findCol(["patient name", "patient", "englishfullname", "name", "المريض"], 3, 'name');

    expect(colBed).toBe(1);
    expect(colMrn).toBe(2);
    expect(colName).toBe(3);
  });

  it('correctly identifies scrambled Arabic headers and distinguishes total vs remaining debts', () => {
    const scrambledRows = [
      ["تقرير الإشغال اليومي للمستشفى", "", "", "", "", "", ""],
      [
        "صافي المتبقي للتحصيل",     // Col 0: Remaining
        "اسم الحالة بالكامل",      // Col 1: Name
        "تاريخ الدخول الفعلي",     // Col 2: Adm Date
        "رقم السرير / الغرفة",     // Col 3: Room/Bed
        "إجمالي قيمة الفاتورة",    // Col 4: Total
        "طبيب الحالة المعالج",     // Col 5: Physician
        "كود المريض الطبي"         // Col 6: MRN
      ],
      [
        "1250.50",
        "محمود إبراهيم أحمد سالم",
        "2026-10-24T12:00:00",
        "Room 302 B",
        "5000.00",
        "د. حسام غالي",
        "0000987654"
      ]
    ];

    const { headerRowIdx, findCol } = buildColumnIndexResolver(scrambledRows);
    expect(headerRowIdx).toBe(1);

    expect(findCol(["remaining", "المتبقي", "صافي المتبقي", "صافي المديونية"], 27, 'number')).toBe(0);
    expect(findCol(["patient name", "اسم المريض", "اسم الحالة بالكامل"], 3, 'name')).toBe(1);
    expect(findCol(["admission date", "تاريخ الدخول", "تاريخ الدخول الفعلي"], 0, 'date')).toBe(2);
    expect(findCol(["room", "bed", "رقم السرير", "رقم السرير / الغرفة"], 1, 'room')).toBe(3);
    expect(findCol(["total", "إجمالي الحساب", "إجمالي الفاتورة", "إجمالي قيمة الفاتورة"], 25, 'number')).toBe(4);
    expect(findCol(["physician", "doctor", "طبيب الحالة المعالج"], 22, 'name')).toBe(5);
    expect(findCol(["mrn", "كود المريض الطبي", "الملف"], 2, 'id')).toBe(6);
  });

  it('getOccupancyRows in occupancyLogic extracts correctly from test_occupancy.xlsx', () => {
    const rawRows = loadTestOccupancyRows();
    const processed = getOccupancyRows(rawRows);
    
    // Header padding creates 3 prefix rows, followed by deduplicated body
    expect(processed.length).toBeGreaterThan(3);

    // Check first body row
    const firstBodyRow = processed[3];
    // Expected tuple: [room, name, physician, contractor, admissionDate, mrn]
    expect(firstBodyRow[0]).toBe('304'); // Room
    expect(firstBodyRow[1]).toBe('Fatima Mahhate Eldahshan .'); // Patient Name (NOT corrupted)
    expect(firstBodyRow[2]).toBe('Mohamed Sabry Hassan El Tarhony'); // Physician
    expect(firstBodyRow[3]).toBe('Elite Tours - ايليت للسياحة'); // Contractor
    expect(firstBodyRow[4]).toMatch(/22-10-2026|2026-10-22/); // Admission Date
    // MRN must be a deterministic hash starting with UNKNOWN-, NOT the patient name!
    expect(firstBodyRow[5]).toMatch(/^UNKNOWN-[A-Z0-9]+$/);
    expect(firstBodyRow[5]).not.toContain('Fatima');
  });

  it('getOccupancyRowsUnfiltered preserves all patients including discharged ones', () => {
    const rawRows = loadTestOccupancyRows();
    const unfiltered = getOccupancyRowsUnfiltered(rawRows);
    expect(unfiltered.length).toBeGreaterThan(3);
    const row = unfiltered[3];
    expect(row[0]).toBe('304');
    expect(row[1]).toBe('Fatima Mahhate Eldahshan .');
    expect(row[5]).toMatch(/^UNKNOWN-[A-Z0-9]+$/);
  });

  describe('MRN Formatting in Downloadable Excel Sheets', () => {
    it('formatMrnForSheet formats real MRNs and converts missing / surrogate MRNs to N/A', () => {
      // Real MRNs must be preserved
      expect(formatMrnForSheet('104829')).toBe('104829');
      expect(formatMrnForSheet('MRN-999')).toBe('MRN-999');
      expect(formatMrnForSheet(12345)).toBe('12345');

      // Missing / empty / undefined / null values must return "N/A"
      expect(formatMrnForSheet('')).toBe('N/A');
      expect(formatMrnForSheet('   ')).toBe('N/A');
      expect(formatMrnForSheet(null)).toBe('N/A');
      expect(formatMrnForSheet(undefined)).toBe('N/A');
      expect(formatMrnForSheet('-')).toBe('N/A');
      expect(formatMrnForSheet('—')).toBe('N/A');
      expect(formatMrnForSheet('null')).toBe('N/A');
      expect(formatMrnForSheet('undefined')).toBe('N/A');

      // Internal surrogate MRNs (UNKNOWN-*) must return "N/A"
      expect(formatMrnForSheet('UNKNOWN-2C23D144')).toBe('N/A');
      expect(formatMrnForSheet('UNKNOWN-71AE1778')).toBe('N/A');
      expect(formatMrnForSheet('transfer-uuid-1234')).toBe('N/A');
    });

    it('addRefinedDebtsSheet writes N/A into MRN cell when MRN is missing or surrogate', async () => {
      const workbook = new ExcelJS.Workbook();
      const mockDebts = [
        {
          colA: '2026-10-24',
          room: '304',
          mrn: 'UNKNOWN-2C23D144', // Missing in sheet -> synthetic surrogate
          colD: 'Fatima Mahhate Eldahshan .',
          physician: 'Mohamed Sabry Hassan El Tarhony',
          colM: 'Cash',
          colZ: 1500,
          colAB: 1500
        },
        {
          colA: '2026-10-24',
          room: '102',
          mrn: '987654', // Real MRN
          colD: 'Ahmed Mohamed Ali',
          physician: 'Dr. Hassan',
          colM: 'Cash',
          colZ: 2000,
          colAB: 1000
        }
      ];

      await addRefinedDebtsSheet(workbook, mockDebts);
      const sheet = workbook.getWorksheet('Formatted Debts');
      expect(sheet).toBeDefined();

      // Find the header row (has 'كود المريض / MRN')
      let mrnColIdx = -1;
      let headerRowNum = -1;
      sheet!.eachRow((row, rowNumber) => {
        row.eachCell((cell, colNumber) => {
          if (String(cell.value || '').includes('MRN')) {
            mrnColIdx = colNumber;
            headerRowNum = rowNumber;
          }
        });
      });

      expect(mrnColIdx).toBeGreaterThan(0);
      expect(headerRowNum).toBeGreaterThan(0);

      // Verify the data rows below the header
      const dataRows: any[] = [];
      sheet!.eachRow((row, rowNumber) => {
        if (rowNumber > headerRowNum) {
          dataRows.push(row);
        }
      });

      expect(dataRows.length).toBe(2);

      // One row had UNKNOWN-2C23D144 -> must be formatted as "N/A"
      // One row had 987654 -> must be preserved as "987654"
      const cellValues = dataRows.map(r => r.getCell(mrnColIdx).value);
      expect(cellValues).toContain('N/A');
      expect(cellValues).toContain('987654');
      expect(cellValues).not.toContain('UNKNOWN-2C23D144');
    });

    it('formatRoomForSheet strips the word Bed and cleans up separators correctly', () => {
      expect(formatRoomForSheet('Bed 304')).toBe('304');
      expect(formatRoomForSheet('bed 102 - 1')).toBe('102 - 1');
      expect(formatRoomForSheet('BED 505')).toBe('505');
      expect(formatRoomForSheet('ICU Bed 9')).toBe('ICU 9');
      expect(formatRoomForSheet('Well Baby bed 2')).toBe('Well Baby 2');
      expect(formatRoomForSheet('Bed 304 ➔ Bed 102')).toBe('304 ➔ 102');
      expect(formatRoomForSheet('Bed 304 -> Bed 102')).toBe('304 -> 102');
      expect(formatRoomForSheet('سرير 205')).toBe('205');
      expect(formatRoomForSheet('غرفة 401')).toBe('401');
      expect(formatRoomForSheet('Bed')).toBe('');
      expect(formatRoomForSheet('Room')).toBe('');
      expect(formatRoomForSheet('HomeCare 35')).toBe('HomeCare 35');
      expect(formatRoomForSheet('')).toBe('');
      expect(formatRoomForSheet(null)).toBe('');
      expect(formatRoomForSheet(undefined)).toBe('');
    });

    it('addRefinedDebtsSheet writes stripped room numbers into room column', async () => {
      const workbook = new ExcelJS.Workbook();
      const mockDebts = [
        {
          colA: '2026-10-24',
          room: 'Bed 304',
          mrn: '12345',
          colD: 'Fatima Mahhate Eldahshan .',
          physician: 'Mohamed Sabry Hassan El Tarhony',
          colM: 'Cash',
          colZ: 1500,
          colAB: 1500
        },
        {
          colA: '2026-10-24',
          room: 'ICU Bed 4',
          mrn: '67890',
          colD: 'Omar Khaled',
          physician: 'Dr. Hassan',
          colM: 'Cash',
          colZ: 2000,
          colAB: 1000
        }
      ];

      await addRefinedDebtsSheet(workbook, mockDebts);
      const sheet = workbook.getWorksheet('Formatted Debts');
      expect(sheet).toBeDefined();

      let roomColIdx = -1;
      let headerRowNum = -1;
      sheet!.eachRow((row, rowNumber) => {
        row.eachCell((cell, colNumber) => {
          if (String(cell.value || '').includes('الغرفة')) {
            roomColIdx = colNumber;
            headerRowNum = rowNumber;
          }
        });
      });

      expect(roomColIdx).toBeGreaterThan(0);
      expect(headerRowNum).toBeGreaterThan(0);

      const dataRows: any[] = [];
      sheet!.eachRow((row, rowNumber) => {
        if (rowNumber > headerRowNum) {
          dataRows.push(row);
        }
      });

      expect(dataRows.length).toBe(2);
      const roomValues = dataRows.map(r => r.getCell(roomColIdx).value);
      expect(roomValues).toContain('304');
      expect(roomValues).toContain('ICU 4');
      expect(roomValues).not.toContain('Bed 304');
      expect(roomValues).not.toContain('ICU Bed 4');
    });
  });
});
