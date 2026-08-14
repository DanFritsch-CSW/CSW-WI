'use strict'

// Disciplinary Action Tracker — Attendance write-ups, Misconduct, and PIPs
// (Performance Improvement Plans), per Dan/Tim's 2026-08-07 HR call. Same
// Graph API auth pattern as the other sharepoint-*.cjs functions.
//
// Confirmed live 2026-08-07 via Microsoft 365 connector before writing any
// parsing logic. 3 sheets: Attendance Write Up, Misconduct, PIPs.
//
// 2026-08-14 fix — HR dashboard connect meeting flagged the HR-sent/GM-sent
// date columns rendering as raw numbers instead of dates. Root cause: these
// were read with str() instead of parseDate(), so an Excel date serial
// number (e.g. 46215) passed through unconverted. parseDate() added below
// (was missing from this file, unlike the other sharepoint-*.cjs functions)
// and applied to hrSentDate / gmSentBack.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET
const SHARE_URL     = process.env.SHAREPOINT_DISCIPLINARY_URL || null

const SHEETS = {
  attendance: 'Attendance Write Up',
  misconduct: 'Misconduct',
  pips:       'PIPs',
}

const FALLBACK_RANGE = 'A1:L100'

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
  if (!SHARE_URL) throw new Error('SHAREPOINT_DISCIPLINARY_URL not set — add the share link in Netlify env vars')
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
  try { const d = new Date(s); return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10) } catch { return s }
}
function marked(v) {
  return str(v).toLowerCase() === 'x'
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

// ---- Parsers --------------------------------------------------------------
// Attendance Write Up: Name | Location | Shift | Verbal Warning/Coaching |
// Written Warning | Final Written | Termination | HR Created/Sent to GMs | Upload to B2E
function parseAttendance(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('name'), loc: c.find('location'), shift: c.find('shift'),
    verbal: c.find('verbal warning'), written: c.find('written warning'),
    final: c.find('final written'), termination: c.find('termination'),
    hrSent: c.find('hr created'), b2e: c.find('upload to b2e'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    let step = ''
    if (marked(row[i.termination])) step = 'Termination'
    else if (marked(row[i.final])) step = 'Final Written'
    else if (marked(row[i.written])) step = 'Written Warning'
    else if (marked(row[i.verbal])) step = 'Verbal Warning/Coaching'
    return {
      id: `ATT-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.loc]), shift: str(row[i.shift]),
      step, hrSentDate: parseDate(row[i.hrSent]), b2eStatus: str(row[i.b2e]),
      _colMap: { b2e: i.b2e >= 0 ? colLetter(i.b2e) : null },
    }
  }).filter(Boolean)
}

// Misconduct: Name | Location | Shift | Coaching | Verbal | Written | Final | Termination | GM Sent back to HR | Upload to B2E
function parseMisconduct(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('name'), loc: c.find('location'), shift: c.find('shift'),
    coaching: c.find('coaching'), verbal: c.find('verbal warning'), written: c.find('written warning'),
    final: c.find('final written'), termination: c.find('termination'),
    gmSent: c.find('gm sent back to hr'), b2e: c.find('upload to b2e'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    let step = ''
    if (marked(row[i.termination])) step = 'Termination'
    else if (marked(row[i.final])) step = 'Final Written'
    else if (marked(row[i.written])) step = 'Written Warning'
    else if (marked(row[i.verbal])) step = 'Verbal Warning'
    else if (marked(row[i.coaching])) step = 'Coaching'
    return {
      id: `MIS-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, location: str(row[i.loc]), shift: str(row[i.shift]),
      step, gmSentBack: parseDate(row[i.gmSent]), b2eStatus: str(row[i.b2e]),
      _colMap: { b2e: i.b2e >= 0 ? colLetter(i.b2e) : null },
    }
  }).filter(Boolean)
}

// PIPs: Name | Site | Shifts | Start Date | Week 1-4 | Pass or Fail | End Date | Uploaded in B2E | Notes
function parsePips(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('name'), site: c.find('site'), shifts: c.find('shifts'), start: c.find('start date'),
    w1: c.find('week 1'), w2: c.find('week 2'), w3: c.find('week 3'), w4: c.find('week 4'),
    result: c.find('pass or fail'), end: c.find('end date'), b2e: c.find('uploaded in b2e'), notes: c.find('notes'),
  }
  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const name = str(row[i.name])
    if (!name) return null
    return {
      id: `PIP-${String(idx + 1).padStart(3, '0')}`, rowIndex, name, site: str(row[i.site]), shifts: str(row[i.shifts]),
      startDate: parseDate(row[i.start]), weeks: [str(row[i.w1]), str(row[i.w2]), str(row[i.w3]), str(row[i.w4])],
      result: str(row[i.result]), endDate: parseDate(row[i.end]), uploadedB2E: marked(row[i.b2e]), notes: str(row[i.notes]),
    }
  }).filter(Boolean)
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!SHARE_URL) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_DISCIPLINARY_URL not set — add the share link in Netlify env vars to go live' }) }

  const params = event.queryStringParameters || {}
  const tabKey = (params.tab || 'attendance').toLowerCase()
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

    const [headerRow, ...dataRows] = values
    let records
    if (tabKey === 'attendance') records = parseAttendance(headerRow, dataRows)
    else if (tabKey === 'misconduct') records = parseMisconduct(headerRow, dataRows)
    else if (tabKey === 'pips') records = parsePips(headerRow, dataRows)

    return { statusCode: 200, headers: cors, body: JSON.stringify({ records, count: records.length, tab: tabKey }) }
  } catch (err) {
    console.error(`[sharepoint-disciplinary][${tabKey}]`, err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message, tab: tabKey }) }
  }
}
