import type { OPDClinicSession } from './opdLogic.js';

/**
 * Identifies non-doctor technician sessions, external clinics, iVein placeholders,
 * and unnamed generic "Specialist" clinic placeholders that should be excluded
 * from all three downloadable OPD sheets.
 *
 * Keeps:
 * - Named specialist clinics (Neurosurgery, General Surgery, etc.)
 * - Real Physiotherapy (Physical Medicine) doctors
 * - EEG Clinic (عياده رسم المخ)
 * - Duplicate doctor sessions (no deduplication is performed)
 */
export function isPlaceholderOPDSession(item: OPDClinicSession, keepEEG: boolean = true): boolean {
  const en = String(item.physicianEn || '').toLowerCase().trim();
  const ar = String(item.physicianAr || '').trim();
  const sp = String(item.specialty || '').toLowerCase().trim();

  // 1. Remove Physiotherapy Session technician rooms (keep real Physical Medicine doctors)
  if (
    sp.includes('physiotherapy sessions') ||
    en.includes('physiotherapy session') ||
    ar.includes('جلسه علاج طبيعى') ||
    ar.includes('جلسة علاج طبيعي')
  ) {
    return true;
  }

  // 2. Remove iVein placeholder clinics
  if (sp.includes('ivein') || en.includes('ivein') || en.includes('i vein') || ar.includes('اي فين')) {
    return true;
  }

  // 3. Remove External clinics
  if (sp.startsWith('external')) {
    return true;
  }

  // 4. Keep EEG clinic (عياده رسم المخ)
  if (keepEEG && (ar.includes('رسم المخ') || en.includes('eeg') || sp.includes('eeg'))) {
    return false;
  }

  // 5. Remove generic unnamed specialist/clinic placeholders
  if (
    ar.startsWith('اخصائي') ||
    ar.startsWith('أخصائي') ||
    en.includes('specialist') ||
    ar === 'امراض الباطنه' ||
    ar.startsWith('عياده ') ||
    ar.startsWith('عيادة ')
  ) {
    return true;
  }

  return false;
}

/**
 * Returns valid OPD clinic sessions after removing non-doctor placeholders.
 * Intentionally preserves all duplicate doctor entries as-is.
 */
export function filterOPDSessions(items: OPDClinicSession[]): OPDClinicSession[] {
  return (items || []).filter(item => !isPlaceholderOPDSession(item, true));
}

/**
 * Identifies diagnostic/procedural sessions that do not occupy standard OPD Housing rooms
 * (U/S, 4D Clinic, Check Up Program, Prp Injection, Hepatica Consulto).
 * Applied ONLY to OPD Housing so OPD Schedule logic remains untouched.
 */
export function isNonHousingOPDSession(item: OPDClinicSession): boolean {
  const sp = String(item.specialty || '').toLowerCase().trim();
  const en = String(item.physicianEn || '').toLowerCase().trim();

  if (sp === 'u/s' || sp.startsWith('u/s ') || en.startsWith('sms ')) return true;
  if (sp.includes('4d clinic') || sp === '4d') return true;
  if (sp.includes('check up') || sp.includes('checkup')) return true;
  if (sp.includes('prp injection') || en.includes('prp injection')) return true;
  if (sp.includes('hepatica consult') || en.includes('hepatica consol')) return true;

  return false;
}

/**
 * Returns valid OPD clinic sessions for OPD Housing allocation.
 */
export function filterOPDSessionsForHousing(items: OPDClinicSession[]): OPDClinicSession[] {
  return filterOPDSessions(items).filter(item => !isNonHousingOPDSession(item));
}
