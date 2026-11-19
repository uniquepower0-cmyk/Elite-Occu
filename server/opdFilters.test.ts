import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { filterOPDSessions, isPlaceholderOPDSession } from './opdFilters.js';
import type { OPDClinicSession } from './opdLogic.js';

const fixturePath = path.resolve(__dirname, '__fixtures__/live_opd_2026-11-18.json');
const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const liveItems: OPDClinicSession[] = fixtureData.items;

describe('opdFilters', () => {
  it('filters out Physiotherapy Sessions, iVein, External, and generic Specialist placeholders from 103 live rows', () => {
    expect(liveItems.length).toBe(103);
    const filtered = filterOPDSessions(liveItems);

    // Zero physiotherapy technician sessions remain
    expect(
      filtered.some(
        s =>
          s.specialty.toLowerCase().includes('physiotherapy sessions') ||
          s.physicianEn.toLowerCase().includes('physiotherapy session')
      )
    ).toBe(false);

    // Zero iVein or External rows remain
    expect(filtered.some(s => s.specialty.toLowerCase().includes('ivein'))).toBe(false);
    expect(filtered.some(s => s.specialty.toLowerCase().startsWith('external'))).toBe(false);

    // Zero generic unnamed specialist placeholders remain
    expect(filtered.some(s => s.physicianEn.toLowerCase().includes('specialist'))).toBe(false);

    // Real physiotherapy doctors (Physical Medicine) ARE kept
    expect(filtered.some(s => s.physicianEn.includes('Amr Mohamed Sabry'))).toBe(true);
    expect(filtered.some(s => s.physicianEn.includes('Beshoy'))).toBe(true);

    // EEG Clinic IS kept
    expect(filtered.some(s => s.physicianAr.includes('رسم المخ'))).toBe(true);

    // Duplicate doctors ARE kept as-is (Reda Fawzy x2, Mina Edward x2)
    const redaRows = filtered.filter(s => s.physicianAr.trim() === 'رضا فوزي');
    expect(redaRows.length).toBe(2);

    const minaRows = filtered.filter(s => s.physicianAr.includes('مينا ادور'));
    expect(minaRows.length).toBe(2);

    // 103 - 9 Physio Sessions - 2 iVein - 1 External - 7 generic Specialist placeholders = 84
    expect(filtered.length).toBe(84);
  });

  it('keeps named doctors in Neurosurgery and General Surgery clinics', () => {
    const sample: OPDClinicSession = {
      serial: '1',
      day: 18,
      weekName: 'Wednesday',
      startTime: '10:00 AM',
      endTime: '02:00 PM',
      specialty: 'Neurosurgery Clinic',
      specialities: 'Neurosurgery',
      physicianEn: 'Amr Elwany',
      physicianAr: 'عمرو علوانى',
      floorName: 'm',
      supervisoryLevel: 'Professor',
      maxOccupancy: 60,
      schedules: 1,
      opdDate: '2026-11-18',
    };
    expect(isPlaceholderOPDSession(sample)).toBe(false);
  });
});
