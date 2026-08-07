'use strict'

// Active Leave Tracker — FMLA/STD/Workman's Comp/LOA tracking (Maria/Amy),
// per Dan/Tim's 2026-08-07 HR call. Same Graph API auth pattern as
// sharepoint-recruiting.cjs / sharepoint-30-60-90.cjs.
//
// Source workbook has 7 sheets with genuinely different schemas — not a
// case of one format with facility variation. Confirmed live 2026-08-07
// via Microsoft 365 connector before writing any parsing logic.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET
const SHARE_URL     = process.env.SHAREPOINT_ACTIVE_LEAVE_URL || null

const SHEETS = {
  fmla:        'FMLA - 2026',
  fmlaHours:   'FMLA Estimated Time Off',
  std:         'STD -Leave 202',
  wc:          'WC - Leave 2026',
  loa:         'LOA',
  nonFmla:     'Leaves - NON-FMLA-STD Related',
  closedFmla:  'Closed FMLA cases', // NO header row in source — raw passthrough
}

const FALLBACK_RANGE = 'A1:O100'

// ---- Graph API plumbing (same pattern as sharepoint-dvr.cjs) ----------
let _token = null, _tokenExpiry = 0
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  })
  const d = await res.json()
  if (!res.ok) throw new Error(`Auth failed: ${d.error_description || JSON.stringify(d)}`)
  _token = d.access_token
  _tokenExpiry = Date.now() + (d.expires_in - 120) * 1000
  return _token
}

async function graph(path, token, method = 'GET', body = null) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 204) return null
  const text = await res.text()
  if (!res.ok) throw new Error(`Graph ${method} ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text)
}

let _driveRef = null
async function getDriveRef(token) {
  if (_driveRef) return _driveRef
  if (!SHARE_URL) throw new Error('SHAREPOINT_ACTIVE_LEAVE_URL not set — add the share link in Netlify env vars')
  const encoded = Buffer.from(SHARE_URL).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const item = await graph(`/shares/u!${encoded}/driveItem`, token)
  _driveRef = { driveId: item.parentReference.driveId, itemId: item.id }
  return _driveRef
}

async function fetchSheetValues(sheetBase, token) {
  try {
    const r = await graph(`${sheetBase}/usedRange`, token)
    if (r.values && r.values.length > 0) return r.values
  } catch (err) {
    console.warn(`[fetchSheetValues] usedRange failed: ${err.message.slice(0, 80)}`)
  }
  try {
    const r = await graph(`${sheetBase}/range(address='${FALLBACK_RANGE}')`, token)
    const vals = r.values || []
    let last = vals.length - 1
    while (last > 0 && vals[last].every((v) => v === null || v === '')) last--
    return vals.slice(0, last + 1)
  } catch (err2) {
    console.warn(`[fetchSheetValues] fallback failed: ${err2.message.slice(0, 80)}`)
    return []
  }
}

// ---- Helpers ------------------------------------------------------------
function str(v) {
  if (v == null) return ''
  const s = String(v).trim()
  return ['null', 'nan', 'none', 'n/a'].includes(s.toLowerCase()) ? '' : s
}
function parseDate(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number') return new Date((v - 25569) * 86400 * 1000).toISOString().slice(0, 10)
  const s = String(v).trim()
  if (!s) return ''
  try { const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10) } catch { return '' }
}
function colLetter(idx) { let r = '', n = idx + 1; while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26) } return r }
function buildColMap(headerRow) {
  const col = {}
  headerRow.forEach((h, i) => { col[String(h || '').trim().toLowerCase()] = i })
  return {
    find(...terms) {
      for (const t of terms) {
        if (col[t.toLowerCase()] !== undefined) return col[t.toLowerCase()]
        const k = Object.keys(col).find((k) => k.includes(t.toLowerCase()))
        if (k !== undefined && col[k] !== undefined) return col[k]
      }
      return -1
    },
  }
}
function isActive(raw) {
  const s = (raw || '').trim().toLowerCase()
  return s === 'active'
}

// ---- Per-sheet parsers ----------------------------------------------------
// FMLA - 2026: Employee Name | Location | Date Sent | Received | Start of FMLA |
// Active/Not Active | Length of FMLA | Restrictions | Notes | Current Status | ... | Dates Taken
function parseFmla(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('employee name'), loc: c.find('location'), sent: c.find('date sent'),
    received: c.find('received'), start: c.find('start of fmla'), status: c.find('active/not active'),
    length: c.find('length of fmla'), restrictions: c.find('restrictions'), notes: c.find('notes'),
    currentStatus: c.find('current status'), datesTaken: c.find('dates taken'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    return {
      id: `FMLA-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.loc]),
      dateSent: parseDate(row[i.sent]), received: str(row[i.received]), startDate: str(row[i.start]),
      status: str(row[i.status]), active: isActive(row[i.status]), length: str(row[i.length]),
      restrictions: str(row[i.restrictions]), notes: str(row[i.notes]),
      currentStatus: str(i.currentStatus >= 0 ? row[i.currentStatus] : ''), datesTaken: str(i.datesTaken >= 0 ? row[i.datesTaken] : ''),
      _colMap: { status: i.status >= 0 ? colLetter(i.status) : null, notes: i.notes >= 0 ? colLetter(i.notes) : null },
    }
  }).filter(Boolean)
}

function parseFmlaHours(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('employee name'), loc: c.find('location'), status: c.find('active/not active'),
    length: c.find('length of fmla'), total: c.find('total allowed hours'), used: c.find('time used'),
    available: c.find('available time'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    const total = typeof row[i.total] === 'number' ? row[i.total] : null
    const used = typeof row[i.used] === 'number' ? row[i.used] : null
    return {
      id: `FMLAH-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.loc]),
      status: str(row[i.status]), active: isActive(row[i.status]), length: str(row[i.length]),
      totalHours: total, usedHours: used,
      availableHours: typeof row[i.available] === 'number' ? row[i.available] : (total != null && used != null ? total - used : null),
    }
  }).filter(Boolean)
}

// STD and WC share the same shape: Employee Name | Location | Start of X |
// Active/Not Active | Length of X | Restrictions | Notes
function parseStdOrWc(headerRow, dataRows, prefix, startKey, lengthKey) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('employee name'), loc: c.find('location'), start: c.find(startKey),
    status: c.find('active/not active'), length: c.find(lengthKey), restrictions: c.find('restrictions'), notes: c.find('notes'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    return {
      id: `${prefix}-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.loc]),
      startDate: str(row[i.start]), status: str(row[i.status]), active: isActive(row[i.status]),
      length: str(row[i.length]), restrictions: str(row[i.restrictions]), notes: str(row[i.notes]),
      _colMap: { status: i.status >= 0 ? colLetter(i.status) : null, notes: i.notes >= 0 ? colLetter(i.notes) : null },
    }
  }).filter(Boolean)
}

function parseLoa(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('employee name'), loc: c.find('location'), status: c.find('active/not active'),
    loaStart: c.find('start of loa'), rtw: c.find('rtw date'), notes: c.find('notes'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    return {
      id: `LOA-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.loc]),
      status: str(row[i.status]), active: isActive(row[i.status]),
      loaStart: str(i.loaStart >= 0 ? row[i.loaStart] : ''), rtwDate: str(i.rtw >= 0 ? row[i.rtw] : ''), notes: str(row[i.notes]),
    }
  }).filter(Boolean)
}

function parseNonFmla(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = { name: c.find('name'), site: c.find('site'), start: c.find('start date'), stillOn: c.find('still on leave'), rtw: c.find('exp rtw') }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    return {
      id: `NF-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.site]),
      startDate: str(row[i.start]), stillOnLeave: str(row[i.stillOn]), expectedRtw: str(i.rtw >= 0 ? row[i.rtw] : ''),
    }
  }).filter(Boolean)
}

// Closed FMLA cases has NO header row — raw positional passthrough.
function parseRawLog(dataRows, prefix) {
  return dataRows.map((row, i) => ({ id: `${prefix}-${String(i + 1).padStart(4, '0')}`, rowIndex: i + 1, cells: row.map((v) => str(v)) }))
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!SHARE_URL) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_ACTIVE_LEAVE_URL not set — add the share link in Netlify env vars to go live' }) }

  const params = event.queryStringParameters || {}
  const tabKey = (params.tab || 'fmla').toLowerCase()
  const sheetName = SHEETS[tabKey]
  if (!sheetName) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown tab: ${tabKey}. Use one of ${Object.keys(SHEETS).join(', ')}` }) }

  try {
    const token = await getToken()
    const { driveId, itemId } = await getDriveRef(token)
    const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}')
      const { rowIndex, updates, colMap } = body
      if (!rowIndex || !updates || !colMap) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'rowIndex, updates, colMap required' }) }
      await Promise.all(Object.entries(updates).filter(([f]) => colMap[f]).map(([f, v]) => graph(`${sheetBase}/range(address='${colMap[f]}${rowIndex}')`, token, 'PATCH', { values: [[v || '']] })))
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updated: Object.keys(updates), rowIndex, tab: tabKey }) }
    }

    const values = await fetchSheetValues(sheetBase, token)
    if (!values || values.length < 1) return { statusCode: 200, headers: cors, body: JSON.stringify({ records: [], count: 0, tab: tabKey }) }

    let records
    if (tabKey === 'closedfmla') {
      records = parseRawLog(values, 'CFM')
    } else {
      const [headerRow, ...dataRows] = values
      if (tabKey === 'fmla') records = parseFmla(headerRow, dataRows)
      else if (tabKey === 'fmlahours') records = parseFmlaHours(headerRow, dataRows)
      else if (tabKey === 'std') records = parseStdOrWc(headerRow, dataRows, 'STD', 'start of std', 'length of std')
      else if (tabKey === 'wc') records = parseStdOrWc(headerRow, dataRows, 'WC', 'start of wc', 'length of wc')
      else if (tabKey === 'loa') records = parseLoa(headerRow, dataRows)
      else if (tabKey === 'nonfmla') records = parseNonFmla(headerRow, dataRows)
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ records, count: records.length, tab: tabKey }) }
  } catch (err) {
    console.error(`[sharepoint-active-leave][${tabKey}]`, err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message, tab: tabKey }) }
  }
}
