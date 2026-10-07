# Design Specification: Power BI Sync, Daily Rollover, & Sheet Date Parity

## 1. Problem Statement
1. **Fallback to Yesterday's Date**: When the reset button is clicked, today's snapshot (`2026-10-07`) was deleted. As a result, the history index and sheet generators fell back to the latest surviving snapshot (`2026-10-06`).
2. **Data Divergence between Sync & Dashboard**: The background Python sync daemon (`sync_powerbi_relational.py`) fetched 85 live beds from Power BI and synced them to the relational database and `rtdb_nodes`, but did not create an entry in `history/occupancy_index`. Consequently, downloaded sheets and the UI history view displayed yesterday's data while the sync script logged today's live beds.
3. **Stale Intraday Counters**: The sync script's 11:59 PM reset relied on an exact single-minute check (`hour == 23 and minute == 59`). Because the job runs every 30 minutes, it frequently missed this minute, causing 4 dialysis cases and 3 manual discharges from yesterday to be retained and re-saved into today's state.
4. **UTC Midnight Drift**: Downloaded sheet filenames used `new Date().toISOString().split('T')[0]`. Between midnight and 03:00 AM Cairo time, UTC is still yesterday, stamping files with `2026-10-06`.

---

## 2. Decision Log
| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| 1 | **Adopt Approach 1 (Synchronized Snapshot Engine & Robust Day Rollover)** | Approach 2 (Node webhook), Approach 3 (Full relational rewrite) | Fixes the date fallback and counter desync without introducing new network dependencies or rewriting 25+ Excel generators. |
| 2 | **Date-Boundary Check in Python Sync** | Exact 23:59 minute check | Prevents missed rollovers when the 30-minute sync loop does not execute at exactly 23:59:00. |
| 3 | **Auto-Snapshot on Sync Ingestion** | Manual snapshot creation only | Guarantees today's date (`2026-10-07`) exists in the snapshot index as soon as beds are synced, preventing UI fallback to `2026-10-06`. |
| 4 | **Client & Server Cairo Date Helpers** | Relying on `toISOString()` UTC | Guarantees all downloaded files and report headers always reflect hospital local time (`Africa/Cairo`). |

---

## 3. Architecture & Data Flow

### 3.1 Python Sync Script (`sync_powerbi_relational.py`)
1. **Calendar Date Comparison**:
   - Compares current Cairo date `get_cairo_now().strftime("%Y-%m-%d")` against `last_seen_cairo_date`.
   - When the date changes (crossing midnight into a new day), it immediately zeros:
     - `cumulative_dialysis = []`
     - `cumulative_transfers = []`
     - Resets manual discharges if cleared.
2. **Reset Detection**:
   - If `state/occupancy` has `0` rows or `manuallyDischargedNames` in `state/metadata` is empty, it resets its local cached dialysis and manual discharge tracking.
3. **Clean Bed Sync**:
   - Continues syncing active occupied beds (85 records) and debts to both the relational database RPC and `rtdb_nodes`.

### 3.2 Express Backend (`server.ts`)
1. **Realtime Auto-Snapshot**:
   - When `loadData()` is triggered via realtime push from `sync_powerbi_relational.py` and `hospitalData` contains active patients for today (`2026-10-07`), automatically take an occupancy snapshot for today.
   - Registers `2026-10-07` in `history/occupancy_index`.
2. **Backend Timezone Standardization**:
   - All Excel report filenames and Content-Disposition headers use `getCairoDateTime().dateStr` instead of `new Date().toISOString()`.

### 3.3 React Frontend (`src/App.tsx`)
1. **Frontend Timezone Helper**:
   - Create `getCairoDateString()` using `Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' })`.
   - Update all report download `a.download` attributes across all 25+ buttons to use `getCairoDateString()`.

---

## 4. Verification & Testing Strategy
1. **Sync Execution Test**: Run a sync cycle in `sync_powerbi_relational.py` and verify:
   - Dialysis count is 0.
   - Discharges count is 0.
   - Occupied beds is 85.
   - Today's date is `2026-10-07`.
2. **Snapshot Index Test**: Query `history/occupancy_index` in Supabase to ensure `2026-10-07` is present and active.
3. **Download Filename Test**: Verify all downloaded Excel files from both backend endpoints and frontend buttons use `2026-10-07`.
4. **Reset Parity Test**: Test `/api/reset` to ensure it wipes state and VIP cases remain 100% intact.
