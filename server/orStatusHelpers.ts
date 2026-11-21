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
