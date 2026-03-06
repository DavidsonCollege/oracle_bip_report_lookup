# BIP Report Lookup — CLAUDE.md

## What This App Does

An Electron desktop app that connects to Oracle BI Publisher (BIP) via SOAP and downloads reports as Excel files. The user enters their Oracle URL, credentials, and a report path, then can inspect report parameters and run the report with custom values.

**Main workflow:**
1. User fills in Oracle URL, username, password, and report path
2. "Inspect Parameters" fetches parameter metadata and available layouts from Oracle
3. Report Parameters section renders dynamically from Oracle's metadata (LOV dropdowns, required flags, defaults)
4. User selects a layout, adjusts parameter values, and clicks "Run Report"
5. App downloads the report as `.xlsx` and opens it in Excel

---

## Architecture

- **`main.js`** — Electron main process; all Oracle SOAP calls happen here via `ipcMain.handle`
- **`preload.js`** — exposes `window.hcmAPI` to the renderer via `contextBridge`
- **`index.html`** — single-file renderer (HTML + CSS + JS inline)

**IPC channels:**
- `hcm:saveSettings` — saves `{ baseUrl, username, reportPath }` to electron-store
- `hcm:getReportParams` — fetches param metadata + layouts; returns `{ ok, params, raw, layouts, layoutsRaw }`
- `hcm:budgetReport` — runs the report; returns `{ ok, filePath, soapXml }` or `{ ok: false, error, soapXml }`

---

## Oracle SOAP APIs Used

### v1 — PublicReportService
- **`runReport`** — downloads report as base64-encoded xlsx
- Endpoint: `/xmlpserver/services/PublicReportService`
- Uses `<attributeTemplate>` for layout selection (must come before `<attributeFormat>` in the envelope)

### v2 — SecurityService
- **`login`** — returns `bipSessionToken`
- Endpoint: `/xmlpserver/services/v2/SecurityService`

### v2 — ReportService
- **`getReportParametersInSession`** — returns full parameter metadata including LOV values, defaults, required flags
- **`getReportDefinition`** — returns available layouts (templates)
- Endpoint: `/xmlpserver/services/v2/ReportService`

---

## Key Learnings

### Oracle SOAP Quirks

- **`getReportDefinition` does not use a `reportRequest` wrapper** — pass `userID`, `password`, `reportAbsolutePath` as direct children of the operation element. Using a `reportRequest` wrapper causes "unexpected element" fault.

- **`getReportDefinition` returns valid data even when `soapFaultMessage` fires** — the fault parser triggers on the response, but the layout XML is embedded in the body anyway. Skip the fault check and always parse the raw text.

- **`<attributeTemplate>` must come before `<attributeFormat>`** in the `runReport` envelope — Oracle enforces XSD element ordering. If layout selection appears to have no effect, this is likely the cause.

- **`getReportParametersInSession` requires a `bipSessionToken`** (from `login`), not a username/password directly.

- **Parameter values**: Oracle returns a `defaultValue` per param. The backend merges frontend-supplied values over Oracle defaults — frontend non-empty values win. Empty frontend fields fall back to the Oracle default.

### Parameter Metadata Structure

Oracle's `getReportParametersInSession` response fields (tag names after XML parsing):
- `name` — parameter name (e.g., `P_FUND`)
- `label` — human-readable label (e.g., `Fund`)
- `defaultValue` — Oracle's default value
- `values` — array of valid LOV codes (e.g., `["100000", "100015"]`)
- `lovLabels` — array of human-readable LOV labels aligned by index (e.g., `["100000-Current Fund", ...]`)
- `required` — `"true"` or `"false"`
- `dataType`, `UIType`, `multiValuesAllowed`, etc.

### XML Parsing

- `extractTopLevelItems(xml)` — depth-tracking extractor that finds top-level `<item>` blocks
- `extractAllFields(block)` — extracts `{ tag, value }` pairs from a param block; value is an array when sub-items are found
- **Native `<datalist>` does not scroll reliably in Electron** — replaced with a fully custom dropdown (`div.lov-dd`) with `overflow-y: auto`

### Report Path Format

- Report paths start with `Custom/` (no leading slash) in the UI
- The leading slash is prepended in the backend before sending to Oracle: `/Custom/...`

### Output Files

- Saved to `app.getPath('temp')` with a timestamp suffix to prevent Excel from caching stale files
- Format: `{reportName} {YYYY-MM-DDTHH-MM-SS}.xlsx`

### Electron Patterns

- `contextIsolation: true` — all IPC must go through `contextBridge` in `preload.js`
- `ipcMain.handle` / `ipcRenderer.invoke` for async request/response
- Variables used in `catch` blocks must be declared with `let` before the `try` block (not inside it)
