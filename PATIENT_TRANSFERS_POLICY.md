# Patient Transfers Policy & Specification

## 1. Overview & Purpose
The Patient Transfers module tracks cumulative inpatient bed movements, room reassignments, and department transfers across the operational day. It maintains sequential patient journeys (e.g., `Room A ➔ Room B ➔ Room C`), capturing initial placement, current placement, transfer timestamps, attending physicians, and contractors.

---

## 2. Persistence & Synchronization Policy
1. **Intraday Persistence Until Daily Reset:**
   - All detected and manually entered transfer records are **persistent throughout the operational day** and remain active in the operational registry until the scheduled daily reset.
2. **Updated on Every Cloud Database Sync:**
   - On every cloud database update (Supabase / Firebase RTDB synchronizations, granular upserts, or realtime triggers), transfer records at `state/transfers` are saved, validated, and kept strictly synchronized with the active server state.
3. **Updated on Every Manual Sheet Upload:**
   - Whenever an occupancy spreadsheet is manually uploaded (`/api/upload` / `handleUnifiedUpload`), the system extracts patient room allocations, runs automated transfer detection (`processPatientTransfers`), deduplicates steps, appends new movements to the cumulative registry, and immediately saves to both local persistence (`DATA_FILE`) and the cloud database.

---

## 3. Transfer Qualification & Scope
* **Genuine Inpatient Moves Only:** A transfer is registered only when an admitted patient moves between distinct inpatient rooms (`fromRoom ≠ toRoom`).
* **Exclusion of Procedure & Temporary Rooms:** Movements into or out of procedural and temporary hospital units do **not** trigger a transfer or discharge event:
  * **Operating Theatre & Recovery:** OR, OR-X, Operating Theatre, Recovery Room (`إفاقة`, `عمليات`).
  * **Emergency Department:** ER (`طوارئ`).
  * **Specialized Procedure Suites:** Cath Lab (`قسطرة`), Endoscopy (`مناظير`).
  * **Dialysis Units:** Hemodialysis / Dialysis units.

---

## 4. Patient Matching & Deduplication
* **Primary Identifier (MRN):** Medical Record Numbers are normalized (stripping leading zeros). If MRNs match, records are consolidated. If two records possess conflicting non-empty MRNs, they are never matched.
* **Secondary Identifier (Normalized Name):** In the absence of an MRN, Arabic names are normalized (standardizing `أ/إ/آ`, `ة/ه`, `ى/ي`, and removing honorific prefixes) with strict first-name consistency.
* **Sequential Journeys & Multi-Transfer Tracking:**
  * Repeated transfers for the same patient append to the single patient record's `journey` array (`[Room A, Room B, Room C]`) and detailed `history` step log.
  * Patients with more than one transfer movement are categorized as **Multi-Transfer**.
* **Anti Ping-Pong Sanitization:**
  * Consecutive identical room steps are automatically collapsed.
  * Oscillating ping-pong artifacts (alternating between only two rooms repeatedly) are flagged and sanitized.

---

## 5. Daily Rollover & Archival Policy
* **Scheduled Daily Reset at 11:59 PM (Cairo Time):**
  1. Active cumulative transfers are automatically archived into historical snapshots (`history/occupancy/YYYY-MM-DD.json` and Supabase `history/occupancy/<date>/transfers`).
  2. The active intraday transfer registry is cleared for the beginning of the next operational day.
* **Exporting & Reporting:**
  * Full transfer timelines can be exported at any time via the formatted Excel generator (`/api/reports/transfers_formatted`).
