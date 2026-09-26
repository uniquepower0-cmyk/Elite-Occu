# VIP Cases Policy & Specification

## 1. Overview & Purpose
The VIP Cases module manages high-priority patient identification, clinical status monitoring, and occupancy labeling across all hospital departments. It allows hospital administration and duty managers to register VIP designations via free-form text or forwarded communication (such as WhatsApp admissions), automatically identifying and tagging corresponding admitted patients throughout the system.

---

## 2. Persistence & Synchronization Policy
1. **Intraday & Daily Persistence (Never Reset Automatically):**
   - Unlike daily operational datasets (Occupancy, Patient Transfers, Dialysis, Discharged Cases) which reset automatically at **11:59 PM Cairo Time**, **VIP Cases are strictly persistent day-by-day**.
   - VIP cases remain active in memory and storage indefinitely across daily resets and date rollovers until explicitly modified or reset by authorized staff.
2. **Updated on Every Cloud Database Update:**
   - On **every** database save or synchronization event (`saveData`), the active VIP cases payload is validated and upserted to the cloud database (Supabase `rtdb_nodes`) at path `settings/vip_cases` as well as within the full dataset state `state/dataset`.
   - Real-time cloud database change listeners (`schema-db-changes`) propagate any updates across all connected client browser tabs and server instances without delay.
3. **Updated on Every Manual Sheet Upload:**
   - Whenever an occupancy spreadsheet is uploaded (`/api/upload`), the current VIP cases registry is evaluated against all incoming admissions, tagging matching patients with VIP status in Refined Occupancy, Companion Status, and Debts reports.
4. **Isolated Manual Reset Only:**
   - The primary system reset button (`/api/reset`) removes only the current day's occupancy snapshot and daily tallies, **explicitly preserving the VIP Cases registry**.
   - VIP cases can only be cleared by triggering the dedicated **"Reset VIP Cases"** endpoint (`POST /api/reset-vip`).

---

## 3. Parsing & Extraction Specification
The extraction pipeline (`extractVipNames`) handles unformatted and semi-structured text inputs:
* **Chat Header & Timestamp Stripping:** Removes bracketed timestamps (e.g., `[7:18 PM, 6/3/2026]`), sender names, and forward prefixes.
* **Admission Keyword Cleaning:** Automatically strips common admission headers such as `وصول حاله /`, `دخول حاله /`, and `New Patient Admission`.
* **List Index & Punctuation Cleanup:** Removes leading numeric counters (`1-`, `2.`, `3)`) and strips trailing descriptive text preceded by multiple dots (`..`).
* **Quotation & Bracket Normalization:** Removes decorative punctuation (`"`, `'`, `«`, `»`, `()`).

---

## 4. Intelligent Arabic Matching Policy
The matching engine (`isPatientVip`) matches patient records against the VIP registry using fuzzy-tolerant rules:
* **Arabic Character Normalization:**
  - Standardizes alef variants: `أ`, `إ`, `آ`, `ٱ` $\rightarrow$ `ا`.
  - Standardizes taa marbuta: `ة` $\rightarrow$ `ه`.
  - Standardizes yaa / alif maqsura: `ى`, `ي`, `ئ` $\rightarrow$ `ي`.
  - Standardizes waw with hamza: `ؤ` $\rightarrow$ `و`.
  - Normalizes compound names: `عبد...`, `ابو...`, `ام...`, `ابن...`, `بن...`.
* **Honorific & Title Stripping:** Ignores professional and social titles (`الدكتور`, `دكتور`, `الشيخ`, `شيخ`, `الحاج`, `حاج`, `المهندس`, `مهندس`, `الافندي`, `افندي`, `السيد`, `سيد`).
* **Definite Article Stripping:** Safely strips leading `ال` (Al-) prefixes from individual words.
* **Sequential Longest Common Subsequence (LCS):**
  - Requires the normalized first name to match strictly.
  - Requires a sequential subsequence match ($\ge 2$ words) preserving name order, preventing single-word false matches.

---

## 5. Daily Rollover & Archival Policy
* **Historical Snapshot Preservation:**
  - On every scheduled daily rollover at 11:59 PM (Cairo Time), the active VIP text is permanently archived inside that day's immutable historical snapshot (`history/occupancy/YYYY-MM-DD.json` and Supabase `history/occupancy/<date>/settings`).
* **Continuous Intraday Availability:**
  - At the start of the next calendar day, the active VIP registry remains loaded in memory and in the cloud database, ready to match new patients admitted on the new day.
* **Audit Trail Tracking:**
  - Every VIP cases modification is recorded in the permanent audit log (`audit_logs`) with timestamp, user session, and change-log details.

---

## 6. Application Scope & System Impact
* **Live Inpatient UI:** Matching patient bed cards are rendered with an amber badge, gold border, and a Crown icon.
* **Exported Excel Reports:** A dedicated `"VIP STATUS"` column is populated across Refined Occupancy, Companion Status, Formatted Companions, and Refined Debts.
* **SBAR Medical Updates Report:** Generates an isolated medical updates report filtered exclusively for currently admitted VIP cases (`/api/reports/vip-cases-medical-updates`).
* **Formatted Copy Tool:** Automatically generates a formatted, unit-ranked broadcast text (`/api/vip-cases/formatted`) sorted by clinical priority (ICU $\rightarrow$ CCU $\rightarrow$ Inpatient).
