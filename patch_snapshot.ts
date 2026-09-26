import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf-8');

content = content.replace(
`// Helper to snapshot OR List
async function takeORSnapshotHelper(customDate?: string) {
  if (!cumulativeORList || cumulativeORList.length === 0) return null;
  const cairo = getCairoDateTime();

  // 1. Prefer the embedded orListDate from the OR items themselves
  let resolvedDate: string | null = null;
  const rawListDate = cumulativeORList[0]?.orListDate || '';
  if (rawListDate) {
    resolvedDate = normalizeToISODate(rawListDate);
  }

  // 2. If no valid embedded date, use customDate if provided
  if (!resolvedDate && customDate) {
    resolvedDate = normalizeToISODate(customDate) || customDate;
  }`,
`// Helper to snapshot OR List
async function takeORSnapshotHelper(customDate?: string) {
  if (!cumulativeORList || cumulativeORList.length === 0) return null;
  const cairo = getCairoDateTime();

  let resolvedDate: string | null = null;

  // 1. Prefer customDate if explicitly provided (e.g., manual snapshot force or explicit upload date)
  if (customDate) {
    resolvedDate = normalizeToISODate(customDate) || customDate;
  }

  // 2. Fallback to embedded orListDate
  if (!resolvedDate) {
    const rawListDate = cumulativeORList[0]?.orListDate || '';
    if (rawListDate) {
      resolvedDate = normalizeToISODate(rawListDate);
    }
  }`);

content = content.replace(
`app.post('/api/history/or/snapshot', async (req, res) => {
  try {
    const customDate = req.body?.date ? String(req.body.date).trim() : undefined;`,
`app.post('/api/history/or/snapshot', async (req, res) => {
  try {
    // For manual snapshot triggers, default to today's Cairo date if not explicitly provided
    const customDate = req.body?.date ? String(req.body.date).trim() : getCairoDateTime().dateStr;`);

fs.writeFileSync('server.ts', content, 'utf-8');
console.log("Done patching.");
