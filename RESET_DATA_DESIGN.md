# Unified Reset Data Specification

## Purpose
Define the architectural and user-experience design for the unified **"Reset Data"** button in Hospital Occupancy Manager. This operation completely clears the active operational day across all hospital modules, purges today's historical snapshots from disk and cloud storage, and synchronizes the deletions to Supabase database tables while strictly preserving VIP cases.

---

## 1. Understanding Summary
- **Target Operational Scope**: Only the current active operational date (`cairo.dateStr`, `uploadedAt` date, `lastActiveDate`). Previous days' historical data and archives remain completely untouched.
- **Datasets Purged**:
  - Live Hospital Occupancy Census (`hospitalData = null`, `previousHospitalData = null`, registries wiped).
  - Operating Room (OR) Live Schedule (`cumulativeORList = []`).
  - Intra-Day Metrics: Discharged patients (`cumulativeDischarged = []`, `manuallyDischargedNames = []`), Dialysis patients (`cumulativeDialysis = []`), Patient transfers (`cumulativeTransfers = []`), Today's entry cases (`cumulativeEntries = []`), transient room notes.
  - Historical Snapshots: Today's Occupancy snapshot and today's OR snapshot are deleted from local disk and Supabase cloud storage/`rtdb_nodes` (removed from `occupancy_index.json` and `or_index.json`).
  - Database Relational Deletion: Corresponding active records in Supabase PostgreSQL tables (`admissions`, `or_cases`, `transfers`) for today's active date are deleted or marked discharged/cleared.
- **Datasets Preserved**:
  - Persistent VIP Cases (`vipCasesText` in memory and `settings/vip_cases` in database) remain strictly intact per `VIP_CASES_POLICY.md`.
- **User Interface & Confirmation**:
  - Replaces the requirement to type `"RESET"` with a direct, single-click **"Confirm Reset"** button accompanied by clear, descriptive warnings.

---

## 2. Assumptions & Non-Functional Requirements
- **Performance**: Reset execution across memory, local files, Supabase `rtdb_nodes`, and relational tables executes in `< 2 seconds`.
- **Resiliency**: If Supabase remote table deletion or cloud storage encounters a timeout, local cache and in-memory server state are still cleanly wiped without crashing.
- **Immediate UI Feedback**: A loading spinner is displayed during execution, and all dashboard tabs (Occupancy, OR, Discharges, Dialysis, Transfers) refresh immediately upon completion.

---

## 3. Decision Log

| Decision | Alternatives Considered | Rationale |
| :--- | :--- | :--- |
| **Unified Atomic Backend Route** | Client-orchestrated sequence | Eliminates partial reset risks and client network race conditions; all deletion steps run synchronously on the server. |
| **Scoped Relational Deletion** | Complete table truncate | Protects prior days' clinical and admissions history while cleanly wiping today's records. |
| **Direct Confirmation Button** | Typed "RESET" string requirement | Streamlines operations for hospital staff while retaining a clear, high-visibility warning modal. |
| **Non-blocking DB Resiliency** | Throwing fatal 500 on partial remote error | Guarantees local server operation continues smoothly even if an external cloud request times out. |
| **Strict VIP Preservation** | Wiping VIP text box | Aligns with hospital policy requiring long-term VIP tracking to persist across intra-day resets. |

---

## 4. Technical Architecture & Endpoints

### 4.1 Backend (`server.ts` -> `POST /api/reset`)
1. **Target Date Detection**:
   ```typescript
   const targetDatesToDelete = new Set<string>();
   targetDatesToDelete.add(cairo.dateStr);
   if (uploadedAt) targetDatesToDelete.add(getCairoDateFromTimestamp(uploadedAt));
   if (lastActiveDate) targetDatesToDelete.add(lastActiveDate);
   ```
2. **Audit Logging**: Saves an immutable `manual_reset` entry to `change_log`.
3. **History Snapshot Deletion**:
   - Calls `deleteOccupancySnapshot(d)` for each target date.
   - Calls `deleteORSnapshot(d)` for each target date.
4. **Relational Database Deletion**:
   - `or_cases`: Deletes cases where `scheduled_date` is in `targetDatesToDelete`.
   - `transfers`: Deletes auto-detected transfers recorded for the target date.
   - `admissions`: Deletes or marks `Discharged` any active admissions (`status = 'Admitted'`) from today's upload.
5. **Memory State Reset**:
   - `hospitalData = null`, `previousHospitalData = null`
   - `cumulativeORList = []`
   - `cumulativeDischarged = []`, `manuallyDischargedNames = []`
   - `cumulativeDialysis = []`
   - `cumulativeTransfers = []`
   - `cumulativeEntries = []`
   - `cumulativeDebts = []`, `cumulativeInsuredDebts = []`, etc.
   - **`vipCasesText` preserved**.
6. **State Persistence**:
   - Calls `saveData()` to write clean nodes to `rtdb_nodes` and `data.json`.

### 4.2 Frontend (`src/App.tsx`)
1. **Confirmation Modal Update**:
   - Remove text input requiring `"RESET"`.
   - Modal displays comprehensive list of purged modules with clear visual indicators.
   - Primary action: `<button onClick={handleConfirmReset}>Confirm Reset</button>`.
2. **Post-Reset State Update**:
   - Calls `await fetchData()`.
   - Increments `setOrHistoryRefreshKey(k => k + 1)`.
   - Switches view to `dashboard`.
   - Alerts/notifies user of clean state.

---

## 5. Verification Plan
1. **Upload Phase**: Upload occupancy and OR schedule files, verify active beds, OR procedures, discharges, and snapshots exist.
2. **Execution Phase**: Click "Reset Data" in header, confirm via modal without typing.
3. **Parity Check**:
   - UI reflects 0 active beds, 0 OR cases, 0 discharges, 0 dialysis.
   - Today's date removed from occupancy history and OR history dropdowns.
   - VIP cases box remains intact with existing content.
   - Supabase `admissions`, `or_cases`, and `rtdb_nodes` verified clean for today.
