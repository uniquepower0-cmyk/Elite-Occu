# Unified Reset Data Specification & Snapshot Purge Fix

## Purpose
Define the architectural and user-experience design for the unified **"Reset Data"** button in Hospital Occupancy Manager. This operation completely clears the active operational day across all hospital modules, purges today's historical snapshots from disk and cloud storage, and synchronizes the deletions to Supabase database tables while strictly preserving VIP cases and preventing zombie auto-recovery loops.

---

## 1. Understanding Summary
- **Target Operational Scope**: Only the current active operational date (`cairo.dateStr`, `uploadedAt` date, `lastActiveDate`). Previous days' historical data and archives remain completely untouched.
- **Root Cause of Previous Desync**:
  1. `deleteOccupancySnapshot` modified only local disk index files, leaving `history/occupancy_index` in Supabase unpruned.
  2. `loadData()` interpreted an empty hospital as accidental data loss and restored data from existing snapshots.
  3. `executeLoadData` did not treat `state/occupancy` with `current: []` as an intentional zero state.
- **Datasets Purged**:
  - Live Hospital Occupancy Census (`hospitalData = null`, `previousHospitalData = null`, registries wiped).
  - Operating Room (OR) Live Schedule (`cumulativeORList = []`).
  - Intra-Day Metrics: Discharged patients, Dialysis patients, Patient transfers, Today's entry cases, transient room notes.
  - Historical Snapshots: Today's Occupancy snapshot and today's OR snapshot are deleted from local disk and Supabase cloud storage (`rtdb_nodes`), and removed from both `occupancy_index` and `or_index` in Supabase.
  - Database Relational Deletion: Corresponding active records in Supabase PostgreSQL tables (`admissions`, `or_cases`, `transfers`) for today's active date are deleted or marked discharged/cleared.
- **Datasets Preserved**:
  - Persistent VIP Cases (`vipCasesText` in memory and `settings/vip_cases` in database) remain strictly intact per `VIP_CASES_POLICY.md`.
- **User Interface & Confirmation**:
  - Direct, single-click **"Confirm Reset"** button accompanied by clear, descriptive warnings.
  - Occupancy History dropdown refreshes immediately and omits today's date (`2026-10-07`).

---

## 2. Assumptions & Non-Functional Requirements
- **Performance**: Reset execution across memory, local files, Supabase `rtdb_nodes`, and relational tables executes in `< 2 seconds`.
- **Resiliency**: If Supabase remote table deletion or cloud storage encounters a timeout, local cache and in-memory server state are still cleanly wiped without crashing.
- **Zero-State Integrity**: When `hospitalData` is cleared by an intentional reset, the server will not attempt auto-recovery from snapshots.

---

## 3. Decision Log

| Decision | Alternatives Considered | Rationale |
| :--- | :--- | :--- |
| **Direct Cloud Index Pruning in `deleteOccupancySnapshot`** | Pruning only local disk index file | Fixes the root desync where Supabase retained `2026-10-07` in `history/occupancy_index`. |
| **Normalized Date Comparison on Index Filter** | Literal string matching | Prevents mismatches between `YYYY-MM-DD`, `DD-MM-YYYY`, and delimited dates. |
| **Explicit Zero-State Recognition in `executeLoadData`** | Treating empty arrays as null | Ensures `current: []` from cloud storage sets `hospitalData = null` instead of remaining untouched. |
| **Guard Snapshot Fallbacks in Server** | Deleting all fallbacks | Preserves cold-start disaster recovery for valid days while preventing intentional reset resurrection. |
| **Client Force Fetch & Dropdown Key** | Stale local cache fetch | Ensures browser cache doesn't serve a 304 Not Modified after reset. |

---

## 4. Technical Architecture & Implementation Details

### 4.1 `historyManager.ts` -> `deleteOccupancySnapshot`
```typescript
export async function deleteOccupancySnapshot(dateStr: string): Promise<boolean> {
  const norm = normalizeToISODate(dateStr);
  const cleanDate = norm || dateStr.trim();

  // 1. Delete from local disk
  const filePath = path.join(HISTORY_OCC_DIR, `${cleanDate}.json`);
  if (fs.existsSync(filePath)) await fsPromises.unlink(filePath);

  // 2. Delete granular history nodes and legacy node from Supabase
  await historySupabase
    .from('rtdb_nodes')
    .delete()
    .like('path', `history/occupancy/${cleanDate}%`);

  // 3. Remove date from cloud occupancy index (Supabase rtdb_nodes)
  const { data: node } = await historySupabase
    .from('rtdb_nodes')
    .select('data')
    .eq('path', 'history/occupancy_index')
    .maybeSingle();

  let cloudEntries: DateIndexEntry[] = (node && Array.isArray(node.data)) ? node.data : [];
  cloudEntries = cloudEntries.filter(e => (normalizeToISODate(e.date) || e.date) !== cleanDate);

  await historySupabase.from('rtdb_nodes').upsert({
    path: 'history/occupancy_index',
    data: cloudEntries,
    updated_at: new Date().toISOString()
  });

  // 4. Also update local disk index if present
  const indexPath = path.join(WRITABLE_BASE, 'history', 'occupancy_index.json');
  if (fs.existsSync(indexPath)) {
    try { await fsPromises.writeFile(indexPath, JSON.stringify(cloudEntries)); } catch (e) {}
  }

  return true;
}
```

### 4.2 `server.ts` -> `executeLoadData` & `GET /api/occupancy/data`
1. **Explicit Zero-State Recognition**:
   ```typescript
   if (stateMap['state/occupancy']) {
     const occData = stateMap['state/occupancy'];
     if (Array.isArray(occData.current) && occData.current.length === 0) {
       hospitalData = null;
     } else {
       const cloudCurrent = normalizeRowsArray(occData.current || occData.beds);
       if (cloudCurrent && cloudCurrent.length > 0) hospitalData = cloudCurrent;
     }
   }
   ```
2. **Prevent Auto-Recovery on Deliberate Empty Census**:
   In `GET /api/occupancy/data`, do not execute `loadData(force)` simply because `hospitalData === null` if cloud storage has already recorded an empty census state.

### 4.3 `src/App.tsx` -> `executeOccupancyReset`
- Call `await fetchData({ force: true })`.
- Increment `occupancyHistoryRefreshKey` to force the Occupancy History dropdown to reload dates.

---

## 5. Verification Plan
1. Click **Reset Data** -> Confirm Reset.
2. Verify in Supabase database:
   - `history/occupancy_index` contains past dates only (no `2026-10-07`).
   - `history/occupancy/2026-10-07/*` nodes are deleted.
   - `state/occupancy` has `current: []`.
3. Verify in UI:
   - Dashboard shows 0 beds / empty state.
   - History dropdown shows `2026-10-06` as the latest date and omits `2026-10-07`.
