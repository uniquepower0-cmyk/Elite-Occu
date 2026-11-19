import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { filterOPDSessions } from './opdFilters.js';
import { OPD_SPECIALTY_ROWS, mapSessionToSpecialtyRows } from './opdSpecialties.js';
import type { OPDClinicSession } from './opdLogic.js';

const fixturePath = path.resolve(__dirname, '__fixtures__/live_opd_2026-11-18.json');
const liveItems: OPDClinicSession[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).items;

describe('opdSpecialties', () => {
  it('defines all 22 Elite Hospital specialty rows in exact order', () => {
    expect(OPD_SPECIALTY_ROWS.length).toBe(22);
    expect(OPD_SPECIALTY_ROWS[0].id).toBe('ent');
    expect(OPD_SPECIALTY_ROWS[21].id).toBe('endo_bari_surg');
  });

  it('maps every filtered live session to at least one hospital row with zero unmapped rows', () => {
    const filtered = filterOPDSessions(liveItems);
    const unmapped = filtered.filter(s => mapSessionToSpecialtyRows(s).length === 0);
    expect(unmapped).toEqual([]);
  });

  it('does NOT map Neurology / Neuropsychiatry doctors into Urology (substring trap)', () => {
    const filtered = filterOPDSessions(liveItems);
    const uroRow = OPD_SPECIALTY_ROWS.find(r => r.id === 'uro')!;
    const uroMatches = filtered.filter(uroRow.match);
    expect(uroMatches.some(s => s.specialty.toLowerCase().includes('neuro'))).toBe(false);
    expect(uroMatches.length).toBe(3); // Ahmed Mousa, Ahmed Fathy, John Naiem
  });

  it('preserves duplicate doctors as-is (Reda Fawzy and Mina Edward)', () => {
    const filtered = filterOPDSessions(liveItems);
    const orthoRow = OPD_SPECIALTY_ROWS.find(r => r.id === 'ortho')!;
    const minaInOrtho = filtered.filter(orthoRow.match).filter(s => s.physicianAr.includes('مينا ادور'));
    expect(minaInOrtho.length).toBe(2);

    const endoBariRow = OPD_SPECIALTY_ROWS.find(r => r.id === 'endo_bari_surg')!;
    const redaInEndoBari = filtered.filter(endoBariRow.match).filter(s => s.physicianAr.trim() === 'رضا فوزي');
    expect(redaInEndoBari.length).toBe(2);
  });
});
