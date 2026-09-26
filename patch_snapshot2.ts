import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf-8');

content = content.replace(
`app.post('/api/history/occupancy/snapshot', async (req, res) => {
  try {
    const customDate = req.body?.date ? String(req.body.date).trim() : undefined;`,
`app.post('/api/history/occupancy/snapshot', async (req, res) => {
  try {
    // For manual snapshot triggers, default to today's Cairo date if not explicitly provided
    const customDate = req.body?.date ? String(req.body.date).trim() : getCairoDateTime().dateStr;`);

fs.writeFileSync('server.ts', content, 'utf-8');
console.log("Done patching occupancy.");
