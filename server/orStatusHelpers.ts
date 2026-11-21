/**
 * Safe IN/OUT classification fallback when no occupancy snapshot is available.
 * Only treats an OR case as 'IN' when Power BI's explicit admission status column (`column3`)
 * states 'IN' or 'INPATIENT' — never from OR room labels, planned accommodation class, or billing type.
 */
export function classifyInOutFallbackSafe(p: any): 'IN' | 'OUT' {
  if (!p) return 'OUT';
  const column3 = String(p.column3 || '').toUpperCase().trim();
  if (column3 === 'IN' || column3 === 'INPATIENT') {
    return 'IN';
  }
  return 'OUT';
}

/**
 * Classifies a normalized ISO date string (`YYYY-MM-DD`) relative to today's Cairo date.
 */
export function getORDateContextMode(
  normalizedIsoDate: string | null | undefined,
  cairoToday: string
): 'future' | 'today' | 'past' {
  const clean = String(normalizedIsoDate || '').trim();
  if (!clean || clean === 'current' || clean === 'today' || clean === cairoToday) {
    return 'today';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    if (clean > cairoToday) return 'future';
    if (clean < cairoToday) return 'past';
  }
  return 'today';
}
