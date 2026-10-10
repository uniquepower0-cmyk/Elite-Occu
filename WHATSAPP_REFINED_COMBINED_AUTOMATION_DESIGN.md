# Refined Combined Sheet to WhatsApp Automation Design Specification

## 1. Overview & Purpose
This document outlines the architecture and technical design for adding a one-click automation in **Mohanad's Sheets** to render and dispatch the **Refined Combined Sheet** as high-fidelity JPEG images directly to pre-configured WhatsApp group(s) using **Green API** and a **Node.js/Express** backend.

---

## 2. Understanding Summary
* **What is being built**: An automated pipeline with a `"Send to WhatsApp"` action button in the Refined Combined Sheet card inside the Mohanad's Sheets view. It renders included worksheets into crisp $2\times$ resolution JPEG images via client-side canvas capture and dispatches them sequentially to WhatsApp group(s).
* **Included Sheets**:
  1. Occupancy Sheet (*الإشغال العام*)
  2. Daily Admissions Sheet (*حالات الدخول*)
  3. Dialysis Sheet (*الغسيل الكلوي*)
  4. Discharge / Exit Sheet (*حالات الخروج*)
  5. General Debts Sheet (*الديون*) (if records exist)
  6. Patient Transfers Sheet (*تحويلات المرضى*) (if records exist)
* **Explicit Exclusions**:
  * **Insured Debts Sheet** (*الديون التأمينية*) is strictly excluded from image generation and sending.
* **Target Audience**: Dr. Mohanad (Admin) and authorized medical leadership.
* **Non-Goals**: No interactive recipient modal (one-click direct send); no server-side LibreOffice or Chromium daemon dependencies.

---

## 3. Assumptions & Non-Functional Requirements
* **Performance**: Generation of 4–6 sheet images completes in ~1–3s on client; Node.js sequential upload with ~500ms pacing finishes in ~5–8s total.
* **Security & Auth**: Green API credentials (`GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`) and target group ID (`GREEN_API_GROUP_IDS`) live only in server `.env`. Endpoint verifies admin role/email (`mohanad.md07@gmail.com`).
* **Resilience**: In-memory buffer streaming via `multer` (capped at 10MB/image). Pacing guarantees message order on WhatsApp. Graceful error toast on failure.

---

## 4. Decision Log

| Decision # | What Was Decided | Alternatives Considered | Rationale |
| :--- | :--- | :--- | :--- |
| **DEC-01** | Multi-image sequence (separate JPEG per worksheet) | Single Occupancy JPEG; Long vertical infographic | Preserves full visual clarity and high readability across all individual hospital sections on mobile devices. |
| **DEC-02** | Green API as WhatsApp provider | Baileys/WhatsApp-Web.js; Official Meta Cloud API | Highly stable REST gateway; no local session dropouts or complex Meta template approvals. |
| **DEC-03** | Pre-configured target group(s) in server `.env` | Confirmation modal; Dynamic dropdown selector | Provides instant, zero-friction, one-click execution during busy daily hospital handovers. |
| **DEC-04** | Client-side Canvas/DOM capture (`html-to-image`) | Headless Puppeteer; LibreOffice CLI conversion | Uses the browser's native Arabic font rendering and existing visual design tokens; zero server OS dependencies. |
| **DEC-05** | Approach 1: `multipart/form-data` + dedicated Node.js service | Base64 JSON payload; BullMQ async worker | Standard production Node.js file streaming pattern; avoids base64 memory bloat; keeps server lightweight. |
| **DEC-06** | Action button labeled strictly `"Send to WhatsApp"` | Arabic translation or bilingual label | Clean, uncluttered UI button explicitly matching Dr. Mohanad's preference. |
| **DEC-07** | Exclude Insured Debts Sheet from image generation | Include all sheets | Explicit operational directive from Dr. Mohanad. |

---

## 5. System Architecture & Component Design

### 5.1 Frontend Architecture (`src/App.tsx` & Helper Components)
1. **Workflow Card Enhancement**:
   * In `mohanadSubTab === 'downloads'`, the **Refined Combined Sheet** card receives a secondary action button or dedicated action:
     * Label: `"Send to WhatsApp"`
     * Icon: `Send` or `MessageSquareShare` (Lucide)
     * Disabled while `processing` is active.
2. **Hidden Staging Container**:
   * Off-screen DOM container mounts the styled HTML components corresponding to the active hospital data:
     * Occupancy Table
     * Today Entries Table
     * Dialysis Patients Table
     * Exits Table
     * General Debts Table (omitted if empty)
     * Transfers Table (omitted if empty)
   * *Note: Insured Debts table is never rendered in this pipeline.*
3. **Capture & FormData Bundling**:
   * Generates $2\times$ DPI JPEG Blobs using `html-to-image`.
   * Appends blobs into `FormData`:
     ```typescript
     const formData = new FormData();
     formData.append('date', cairoDateStr);
     images.forEach((img, idx) => {
       formData.append('files', img.blob, `${idx + 1}_${img.name}.jpg`);
       formData.append('captions', img.caption);
     });
     ```
   * Sends `POST /api/whatsapp/send-refined-combined`.

---

### 5.2 Backend Architecture (Node.js & Express)

#### 1. Environment Variables (`.env`)
```env
GREEN_API_INSTANCE_ID="your_instance_id"
GREEN_API_TOKEN="your_api_token"
GREEN_API_GROUP_IDS="1203630xxxxxxxx@g.us"
```

#### 2. Service Layer: `services/greenApiService.ts`
* Method `sendImage({ chatId, buffer, fileName, caption })`:
  * Prepares `FormData` with native Node.js `Blob` / buffer.
  * Calls Green API:
    `POST https://api.green-api.com/waInstance${INSTANCE_ID}/sendFileByUpload/${API_TOKEN}`
  * Returns Green API response (`idMessage`).
* Method `sendImagesBatch({ chatId, items })`:
  * Iterates items sequentially.
  * Inserts `await sleep(500)` between calls to ensure strict in-order WhatsApp arrival.

#### 3. Controller & Route: `server.ts` / `routes/whatsappRoutes.ts`
* Endpoint: `POST /api/whatsapp/send-refined-combined`
* Multer memory storage parses up to 10 image files.
* Authorization middleware enforces admin access.
* Dispatches images to each group specified in `GREEN_API_GROUP_IDS`.
* Returns structured JSON:
  ```json
  {
    "success": true,
    "sentCount": 5,
    "messageIds": ["BAE5XXXX", "BAE5YYYY"]
  }
  ```

---

## 6. Implementation Checklist
1. [ ] Install `html-to-image` in `package.json` for client-side rendering.
2. [ ] Add `GREEN_API_INSTANCE_ID`, `GREEN_API_TOKEN`, and `GREEN_API_GROUP_IDS` to `.env` and `.env.example`.
3. [ ] Create `server/services/greenApiService.ts` with retry logic and sequential pacing.
4. [ ] Implement `POST /api/whatsapp/send-refined-combined` endpoint in `server.ts` with Multer.
5. [ ] Build off-screen sheet visual preview templates in React excluding insured debts.
6. [ ] Add `"Send to WhatsApp"` button to the Refined Combined Sheet card in Mohanad's Sheets.
7. [ ] Validate end-to-end with live Green API credentials and test in WhatsApp group.
