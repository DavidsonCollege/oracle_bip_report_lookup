const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 600,
    height: 420,
    resizable: true,
    title: 'DAV Control Budget Report',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Settings persistence ──────────────────────────────────────────────────────

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

ipcMain.handle('shell:openExternal', (_event, url) => shell.openExternal(url));

ipcMain.handle('hcm:getSettings', () => {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('hcm:saveSettings', (_event, { baseUrl, username }) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ baseUrl, username }), 'utf8');
  } catch {
    // Non-fatal — ignore write errors.
  }
});

// ── IPC: hcm:budgetReport ─────────────────────────────────────────────────────
//
// Downloads the Control Budget SOAP report as an xlsx file and opens it
// in the system default application (Excel).
// Returns { ok: true } | { ok: false, error: '...' }

ipcMain.handle('hcm:budgetReport', async (_event, { baseUrl, username, password }) => {
  try {
    const buffer   = await runSoapReportBuffer(
      baseUrl, username, password,
      '/Custom/Financials/Campus Reports/DAV - Control Budget Report.xdo'
    );
    const filePath = path.join(app.getPath('temp'), 'DAV - Control Budget Report.xlsx');
    fs.writeFileSync(filePath, buffer);
    await shell.openPath(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Shared: fetch with timeout ────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${ms / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Shared: SOAP report buffer ────────────────────────────────────────────────
//
// Handles the SOAP envelope, network call, fault detection, and base64 decode.
// Returns the raw xlsx Buffer.

async function runSoapReportBuffer(baseUrl, username, password, reportPath) {
  const SOAP_ENDPOINT = `${baseUrl.replace(/\/$/, '')}/xmlpserver/services/PublicReportService`;

  function extractElement(xml, localName) {
    const re = new RegExp(
      `<[^\\s>/]*:?${localName}[^>]*>([\\s\\S]*?)<\\/[^\\s>/]*:?${localName}>`, 'i'
    );
    return (xml.match(re) ?? [])[1]?.trim() ?? null;
  }

  function soapFaultMessage(xml) {
    const fault = extractElement(xml, 'Fault');
    if (!fault) return null;
    return extractElement(fault, 'faultstring')
      ?? extractElement(fault, 'Text')
      ?? extractElement(fault, 'message')
      ?? `(raw fault) ${fault.replace(/\s+/g, ' ').slice(0, 400)}`;
  }

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<runReport xmlns="http://xmlns.oracle.com/oxp/service/PublicReportService">
<reportRequest>
<reportAbsolutePath>${reportPath}</reportAbsolutePath>
<attributeFormat>xlsx</attributeFormat>
<sizeOfDataChunkDownload>-1</sizeOfDataChunkDownload>
</reportRequest>
<userID>${username}</userID>
<password>${password}</password>
</runReport>
</soap:Body>
</soap:Envelope>`;

  const response = await fetchWithTimeout(SOAP_ENDPOINT, {
    method : 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction'  : '"runReport"',
    },
    body: envelope,
  });

  const responseText = await response.text();

  const fault = soapFaultMessage(responseText);
  if (fault) throw new Error(`SOAP fault: ${fault}`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  const b64 = extractElement(responseText, 'reportBytes');
  if (!b64) {
    throw new Error(`No reportBytes in SOAP response.\nSnippet: ${responseText.slice(0, 300)}`);
  }

  return Buffer.from(b64, 'base64');
}
