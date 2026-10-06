# Daily Rollover & History Snapshot Specification

## Purpose
Establish an automated, resilient end-of-day rollover at 11:59 PM (Africa/Cairo time) that preserves active hospital bed occupancy while taking complete historical snapshots and resetting intra-day metrics (discharges, dialysis, transfers, OR schedules, and new admissions).

---

## 1. Understanding Summary
- **Target Event Time**: 11:59 PM (23:59) Cairo Time (`Africa/Cairo`).
- **Snapshots Taken**:
  - Full Occupancy Snapshot (hospital occupancy data, discharged patients, dialysis cases, entry cases, transfers, debts, companion status, LOS, summaries) saved to Supabase (`history/occupancy/{date}/*`) and local cache.
  - Full OR Snapshot (operating room schedules, summaries, procedures) saved to Supabase (`history/or/{date}/*`) and local cache.
  - Final Immutable Change-Log audit entry for the closing day.
- **Data Zeroed / Reset**:
  - Discharged patients (`cumulativeDischarged = []`, `manuallyDischargedNames = []`).
  - Dialysis patients (`cumulativeDialysis = []`).
  - Patient transfers (`cumulativeTransfers = []`).
  - Operating Room schedule (`cumulativeORList = []`).
  - Entry cases (`cumulativeEntries = []`).
  - Transient notes (`pendingDischargePatientsText = ""`, `earlyDischargeRoomsText = ""`).
- **Data Retained**:
  - Inpatients physically in hospital beds (`hospitalData` is **retained**, establishing continuous occupancy).
  - VIP cases (`vipCasesText` is **retained**).
  - `previousHospitalData` is synchronized to `hospitalData` to establish the new day's baseline.
  - `patientRoomRegistry` is pruned to match active bed patients so previous discharges don't ghost-trigger.
- **New Admissions (Entry Cases)**:
  - Strict calendar-day matching against the new Cairo date (`cairo.dateStr`).
  - At 00:00 immediately following rollover, entries count begins at 0 until new patients admitted on the new calendar date arrive.

---

## 2. Trigger Architecture (Triple-Guarantee)
1. **Background 20-Second Interval**:
   - Runs `checkEgyptianDailyReset()` continuously.
   - At 23:59 Cairo time, triggers `performDailyRollover(cairo.dateStr)`.
2. **Request-Time Day-Rollover Guard**:
   - In `GET /api/occupancy/data` and server load paths.
   - If the current Cairo date has advanced past the last active date and no reset occurred for that date, executes `performDailyRollover(previousActiveDate)` before responding to the user.
   - Ensures zero missed snapshots even on cold starts or sleeping serverless containers.
3. **External Cron Webhook**:
   - Endpoint: `POST /api/cron/daily-reset` or `GET /api/cron/daily-reset`.
   - Allows cloud schedulers (Vercel Cron, Render, GitHub Actions) to proactively trigger closing with optional secret key auth.

---

## 3. Decision Log

| Decision | Alternatives Considered | Rationale |
| :--- | :--- | :--- |
| **Idempotent Triple-Trigger Rollover** | Cron-Only, Client-Side Trigger | Guarantees reliability across continuous Node processes, serverless functions, and sleeping containers. |
| **Keep Inpatients in Beds Across Rollover** | Wipe hospital data completely | Inpatients still physically occupying beds must remain visible on the occupancy board going into the new day. |
| **Clear Discharges, Dialysis, Transfers, & OR Data** | Keep cumulative lists indefinitely | Hospital operational reporting requires clean daily tallies starting at 0 each day. |
| **Strict Calendar Date Matching for Admissions** | Fallback to sheet max date (`operationalDateStr`) | Eliminates stale admission counts carried over from yesterday's spreadsheet uploads. |

---

## 4. Implementation Steps
1. Consolidate rollover logic into `performDailyRollover(closingDateStr: string)` in `server.ts`.
2. Update the reset block: preserve `hospitalData`, sync `previousHospitalData`, clear `cumulativeORList`, `cumulativeDischarged`, `cumulativeDialysis`, `cumulativeTransfers`, `cumulativeEntries`.
3. Update `GET /api/occupancy/data` to:
   - Check if a date rollover occurred before serving data.
   - Strictly filter `activeEntries` against today's actual Cairo date (`cairo.dateStr`).
4. Add `/api/cron/daily-reset` route.
5. Verify with automated simulation of 23:59 snapshot, persistence check, and 00:00 new day state.
