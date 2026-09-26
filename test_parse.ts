
const rawData = [
  {
    "No filters applied": "AdmissionDate",
    "Unnamed: 1": "Bed",
    "Unnamed: 2": "MRN",
    "Unnamed: 3": "Patient",
    "Unnamed: 12": "Financial Status",
    "Unnamed: 22": "TreatingPhysicianName"
  },
  {
    "No filters applied": "2026-09-26",
    "Unnamed: 1": "OR-1",
    "Unnamed: 2": "12345",
    "Unnamed: 3": "John Doe",
    "Unnamed: 12": "Cash",
    "Unnamed: 22": "Dr Smith"
  }
];

function parseMaybeJson(val: any) { return val; }

const normalizeRowsArray = (rows: any): any[][] | null => {
  const raw = parseMaybeJson(rows);
  if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
  if (Array.isArray(raw[0])) return raw;
  const keys = [
    "No filters applied", "Unnamed: 1", "Unnamed: 2", "Unnamed: 3", "Unnamed: 4",
    "Unnamed: 5", "Unnamed: 6", "Unnamed: 7", "Unnamed: 8", "Unnamed: 9",
    "Unnamed: 10", "Unnamed: 11", "Unnamed: 12", "Unnamed: 13", "Unnamed: 14",
    "Unnamed: 15", "Unnamed: 16", "Unnamed: 17", "Unnamed: 18", "Unnamed: 19",
    "Unnamed: 20", "Unnamed: 21", "Unnamed: 22", "Unnamed: 23"
  ];
  return raw.map(item => {
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') {
      return keys.map(k => (item[k] !== undefined && item[k] !== null) ? item[k] : "");
    }
    return [];
  });
};

function getOccupancyRowsUnfiltered(data: any[][] | null): any[][] {
  if (!data) return [];
  let startIdx = 3;
  for(let i = 0; i < Math.min(data.length, 10); i++) {
      const r1 = String(data[i][1] || "").toLowerCase();
      const r3 = String(data[i][3] || "").toLowerCase();
      if ((r1.includes("room") || r1.includes("الغرفة") || r3.includes("patient") || r3.includes("المريض") || r1 === "bed" || r1 === "غرفة" || r3 === "name")) {
          startIdx = i + 1;
          break;
      }
  }
  if (data.length <= startIdx) return [];
  let prefix = data.slice(0, startIdx);
  if (prefix.length < 3) {
    const paddingCount = 3 - prefix.length;
    const padding = Array.from({ length: paddingCount }, () => Array(40).fill(""));
    prefix = [...prefix, ...padding];
  }
  const body = data.slice(startIdx).map(row => {
    return [
      String(row[1] || "").trim(),
      String(row[3] || "").trim(),
      String(row[22] || "").trim(),
      String(row[12] || "").trim(),
      String(row[0] || "").trim(),
      String(row[2] || "").trim(),
    ];
  });
  return [...prefix, ...body];
}

const arr = normalizeRowsArray(rawData);
const res = getOccupancyRowsUnfiltered(arr);
console.log(res);

