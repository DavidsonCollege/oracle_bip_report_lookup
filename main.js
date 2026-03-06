const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 950,
    resizable: true,
    title: 'BIP Report Lookup',
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

ipcMain.handle('bip:getSettings', () => {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('bip:saveSettings', (_event, { baseUrl, username, reportPath }) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ baseUrl, username, reportPath }), 'utf8');
  } catch {
    // Non-fatal — ignore write errors.
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

// ── Shared: XML helpers ───────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

// Depth-tracking extractor — returns only top-level <item> blocks.
function extractTopLevelItems(xml) {
  const tags = [];
  const openRe  = /<[a-z0-9]*:?item[\s>]/gi;
  const closeRe = /<\/[a-z0-9]*:?item>/gi;
  let m;
  while ((m = openRe.exec(xml))  !== null) tags.push({ pos: m.index, open: true,  end: m.index + m[0].length });
  while ((m = closeRe.exec(xml)) !== null) tags.push({ pos: m.index, open: false, end: m.index + m[0].length });
  tags.sort((a, b) => a.pos - b.pos);
  const items = [];
  let depth = 0, start = -1;
  for (const tag of tags) {
    if (tag.open) { if (depth++ === 0) start = tag.pos; }
    else if (--depth === 0 && start !== -1) { items.push(xml.slice(start, tag.end)); start = -1; }
  }
  return items;
}

// Extract all direct child elements as { tag, value } pairs.
// Array-valued for elements that contain sub-items (e.g. lovValues).
function extractAllFields(block) {
  const fields = [];
  const childRe = /<([a-z0-9_-]+:)?([a-z0-9_-]+)(\s[^>]*)?>(?!.*<\/\1?\2>.*<\/\1?\2>)([\s\S]*?)<\/\1?\2>/gi;
  let m;
  while ((m = childRe.exec(block)) !== null) {
    const tag = m[2];
    const inner = m[4].trim();
    const subItems = extractTopLevelItems(inner);
    if (subItems.length) {
      fields.push({ tag, value: subItems.map(s => s.replace(/<[^>]+>/g, '').trim()).filter(Boolean) });
    } else {
      fields.push({ tag, value: inner });
    }
  }
  return fields;
}

// ── Shared: v2 login → bipSessionToken ───────────────────────────────────────

async function bipLogin(base, username, password) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<ns2:login xmlns:ns2="http://xmlns.oracle.com/oxp/service/v2">
<ns2:userID>${xmlEscape(username)}</ns2:userID>
<ns2:password>${xmlEscape(password)}</ns2:password>
</ns2:login>
</soap:Body>
</soap:Envelope>`;

  const resp = await fetchWithTimeout(`${base}/xmlpserver/services/v2/SecurityService`, {
    method : 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"login"' },
    body   : envelope,
  });
  const text = await resp.text();
  const fault = soapFaultMessage(text);
  if (fault) throw new Error(`Login SOAP fault: ${fault}`);

  const token = extractElement(text, 'bipSessionToken')
    ?? extractElement(text, 'loginReturn')
    ?? extractElement(text, 'return');
  if (!token) throw new Error(`Could not extract session token.\nResponse: ${text.slice(0, 400)}`);
  return token;
}

// ── Shared: fetch all report parameters with their default values ─────────────
// Returns { params: [{name, fields}], raw, defaultValues: {name: value} }

async function fetchReportParamData(base, sessionToken, reportPath) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<ns2:getReportParametersInSession xmlns:ns2="http://xmlns.oracle.com/oxp/service/v2">
<ns2:reportRequest>
<ns2:reportAbsolutePath>${xmlEscape(reportPath)}</ns2:reportAbsolutePath>
<ns2:sizeOfDataChunkDownload>-1</ns2:sizeOfDataChunkDownload>
</ns2:reportRequest>
<ns2:bipSessionToken>${xmlEscape(sessionToken)}</ns2:bipSessionToken>
</ns2:getReportParametersInSession>
</soap:Body>
</soap:Envelope>`;

  const resp = await fetchWithTimeout(`${base}/xmlpserver/services/v2/ReportService`, {
    method : 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"getReportParametersInSession"' },
    body   : envelope,
  }, 60000);
  const text = await resp.text();
  const fault = soapFaultMessage(text);
  if (fault) throw new Error(`getReportParametersInSession SOAP fault: ${fault}`);

  const params = extractTopLevelItems(text).map(block => {
    const fields = extractAllFields(block);
    const name = (fields.find(f => f.tag === 'name') ?? {}).value ?? '';
    return { name, fields };
  }).filter(p => p.name);

  // Build name → defaultValue map (empty string if no default)
  const defaultValues = {};
  for (const p of params) {
    const def = (p.fields.find(f => f.tag === 'defaultValue') ?? {}).value ?? '';
    defaultValues[p.name] = Array.isArray(def) ? def[0] ?? '' : def;
  }

  return { params, raw: text, defaultValues };
}

// ── Shared: fetch available report layouts ────────────────────────────────────

async function fetchReportLayouts(base, username, password, reportPath) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<ns2:getReportDefinition xmlns:ns2="http://xmlns.oracle.com/oxp/service/v2">
<ns2:userID>${xmlEscape(username)}</ns2:userID>
<ns2:password>${xmlEscape(password)}</ns2:password>
<ns2:reportAbsolutePath>${xmlEscape(reportPath)}</ns2:reportAbsolutePath>
</ns2:getReportDefinition>
</soap:Body>
</soap:Envelope>`;

  const resp = await fetchWithTimeout(`${base}/xmlpserver/services/v2/ReportService`, {
    method : 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"getReportDefinition"' },
    body   : envelope,
  }, 60000);
  // Oracle returns layout data even when soapFaultMessage fires — skip fault check,
  // just return the raw text and let the caller parse what it needs.
  return await resp.text();
}

// ── IPC: bip:getReportParams ──────────────────────────────────────────────────

ipcMain.handle('bip:getReportParams', async (_event, { baseUrl, username, password, reportPath }) => {
  const base = baseUrl.replace(/\/$/, '');
  try {
    const token = await bipLogin(base, username, password);
    const { params, raw } = await fetchReportParamData(base, token, reportPath);

    // Also fetch layout names — non-fatal if it fails.
    let layoutsRaw = null;
    let layouts = [];
    try {
      layoutsRaw = await fetchReportLayouts(base, username, password, reportPath);
      // Extract defaultTemplateId (the report's default layout).
      const defaultId = extractElement(layoutsRaw, 'defaultTemplateId');
      // Extract all templateId values from listOfTemplateFormatsLabelValues items.
      const lovSection = (layoutsRaw.match(/<[^>]*listOfTemplateFormatsLabelValues[^>]*>([\s\S]*?)<\/[^>]*listOfTemplateFormatsLabelValues[^>]*>/i) ?? [])[1] ?? '';
      const idRe = /<[^>]*:?templateId[^>]*>([^<]+)<\/[^>]*:?templateId[^>]*>/gi;
      const seen = new Set();
      let m;
      while ((m = idRe.exec(lovSection)) !== null) {
        const val = m[1].trim();
        if (!seen.has(val)) { seen.add(val); layouts.push(val); }
      }
      // If we got no templateId entries, fall back to defaultTemplateId alone.
      if (!layouts.length && defaultId) layouts.push(defaultId);
    } catch (layoutErr) {
      layouts = [`(layout fetch failed: ${layoutErr.message})`];
    }

    return { ok: true, params, raw, layouts, layoutsRaw };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: bip:runReport ────────────────────────────────────────────────────────
//
// If cachedDefaults is provided (from a previous Inspect Parameters call),
// skips login + param fetch entirely — saving 2 round trips to Oracle.
// Otherwise logs in and fetches parameter defaults fresh.
// Returns { ok: true, soapXml } | { ok: false, error, sentParams, soapXml }

ipcMain.handle('bip:runReport', async (_event, { baseUrl, username, password, reportPath, paramValues, layoutName, cachedDefaults }) => {
  const base = baseUrl.replace(/\/$/, '');

  let defaultValues = {};
  try {
    if (cachedDefaults) {
      // Use defaults from the last Inspect Parameters call — skip login + param fetch.
      defaultValues = { ...cachedDefaults };
    } else {
      // No cache — fetch fresh defaults from Oracle.
      const token = await bipLogin(base, username, password);
      ({ defaultValues } = await fetchReportParamData(base, token, reportPath));
    }

    // Apply non-empty values from the UI — they override Oracle defaults.
    for (const [k, v] of Object.entries(paramValues || {})) {
      if (v != null && v !== '') defaultValues[k] = v;
    }

    // Run the report.
    const resolvedLayout = layoutName || '';
    const sentParams = Object.entries(defaultValues).filter(([, v]) => v != null && v !== '');
    console.log(`[runReport] Layout: ${JSON.stringify(resolvedLayout)}`);
    console.log(`[runReport] Sending ${sentParams.length} parameters:`);
    for (const [k, v] of sentParams) console.log(`  ${k} = ${JSON.stringify(v)}`);

    const { buffer, soapXml } = await runSoapReportBuffer(base, username, password, reportPath, defaultValues, resolvedLayout);
    const reportName = path.basename(reportPath, path.extname(reportPath));
    // Use a timestamp suffix so Excel never serves a stale cached file.
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath   = path.join(app.getPath('temp'), `${reportName} ${timestamp}.xlsx`);
    fs.writeFileSync(filePath, buffer);
    await shell.openPath(filePath);
    return { ok: true, soapXml };
  } catch (err) {
    const sentSummary = Object.entries(defaultValues ?? {})
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return { ok: false, error: err.message, sentParams: sentSummary, soapXml: err.soapXml };
  }
});

// ── Shared: SOAP report buffer ────────────────────────────────────────────────
//
// Builds parameterNameValues from the provided name→value map, then
// calls PublicReportService::runReport and returns the raw xlsx Buffer.

async function runSoapReportBuffer(baseUrl, username, password, reportPath, paramValues = {}, templateName = '') {
  const SOAP_ENDPOINT = `${baseUrl.replace(/\/$/, '')}/xmlpserver/services/PublicReportService`;

  // Only send parameters with a non-empty value.
  // Sending empty strings for LOV-constrained parameters causes "Invalid parameters" errors;
  // omitting them entirely lets BIP use its server-side default.
  const paramXml = Object.entries(paramValues)
    .filter(([, v]) => v != null && v !== '')
    .map(([name, value]) =>
      `<item>\n<name>${xmlEscape(name)}</name>\n<values><item>${xmlEscape(value)}</item></values>\n</item>`
    ).join('\n');

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<runReport xmlns="http://xmlns.oracle.com/oxp/service/PublicReportService">
<reportRequest>
<reportAbsolutePath>${xmlEscape(reportPath)}</reportAbsolutePath>${templateName ? `\n<attributeTemplate>${xmlEscape(templateName)}</attributeTemplate>` : ''}
<attributeFormat>xlsx</attributeFormat>
<sizeOfDataChunkDownload>-1</sizeOfDataChunkDownload>
<parameterNameValues>
${paramXml}
</parameterNameValues>
</reportRequest>
<userID>${xmlEscape(username)}</userID>
<password>${xmlEscape(password)}</password>
</runReport>
</soap:Body>
</soap:Envelope>`;

  // Log the exact XML being sent (password redacted).
  const redacted = envelope.replace(/<password>[^<]*<\/password>/, '<password>***</password>');
  console.log('[runSoapReportBuffer] Sending SOAP envelope:\n' + redacted);

  const response = await fetchWithTimeout(SOAP_ENDPOINT, {
    method : 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction'  : '"runReport"',
    },
    body: envelope,
  }, 120000);

  const responseText = await response.text();

  const fault = soapFaultMessage(responseText);
  if (fault) {
    const e = new Error(`SOAP fault: ${fault}`);
    e.soapXml = redacted;
    throw e;
  }

  if (!response.ok) {
    const e = new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    e.soapXml = redacted;
    throw e;
  }

  const b64 = extractElement(responseText, 'reportBytes');
  if (!b64) {
    throw new Error(`No reportBytes in SOAP response.\nSnippet: ${responseText.slice(0, 300)}`);
  }

  return { buffer: Buffer.from(b64, 'base64'), soapXml: redacted };
}
