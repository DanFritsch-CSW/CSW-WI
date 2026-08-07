'use strict'

// 30/60/90 Check-In tracker — HR's new-hire follow-up calls (Maria/Amy),
// distinct from the Employee Onboarding module's trainer curriculum
// (day30_review_conducted etc. in Supabase). Same Graph API pattern as
// sharepoint-dvr.cjs / sharepoint-recruiting.cjs.
//
// Source workbook has one sheet PER FACILITY (not one sheet with a facility
// column, unlike Current Needs on the Recruiting tracker): Caledonia,
// Kenosha, WR, Madison. No Eau Claire sheet yet as of 2026-08-07.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET
const SHARE_URL     = process.env.SHAREPOINT_306090_URL || null

const FACILITY_SHEETS = {
  cal:     'Caledonia',
  ken:     'Kenosha',
  wr:      'WR',
  mad:     'Madison',
  // ec: not present in the source workbook yet
}

const FALLBACK_RANGE = 'A1:L200'

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
  if (!SHARE_URL) throw new Error('SHAREPOINT_306090_URL not set — add the share link in Netlify env vars')
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

// Milestone status classification. Source cells look like: "Done", "Done 6/3",
// "Reached out", "Reached out 5/6", "N/A", or blank.
function classifyStatus(raw, targetDateStr) {
  const s = (raw || '').trim().toLowerCase()
  if (s.startsWith('done')) return 'Done'
  if (s.startsWith('reached out')) return 'Reached Out'
  if (s === 'n/a') return 'N/A'
  if (!s) {
    if (targetDateStr) {
      const target = new Date(targetDateStr + 'T00:00:00')
      if (!isNaN(target.getTime()) && target.getTime() < Date.now()) return 'Overdue'
    }
    return 'Upcoming'
  }
  return 'Upcoming'
}

// ---- Parser ---------------------------------------------------------------
// Columns confirmed 2026-08-07 from the live workbook:
// Facility | First Name | Last Name | Shift | Start Date |
// 30 day date | 30 day Review Completed | 60 day Date | 60 day review Completed |
// 90 day Date | 90 Day Completed | Enrolled into Benefits?
function parseFacilitySheet(headerRow, dataRows, facilityKey) {
  const c = buildColMap(headerRow)
  const i_first = c.find('first name'), i_last = c.find('last name'), i_shift = c.find('shift')
  const i_start = c.find('start date')
  const i_d30 = c.find('30 day date'), i_s30 = c.find('30 day review completed')
  const i_d60 = c.find('60 day  date', '60 day date'), i_s60 = c.find('60 day review completed')
  const i_d90 = c.find('90 day date'), i_s90 = c.find('90 day completed')
  const i_benefits = c.find('enrolled into benefits')

  return dataRows.map((row, i) => {
    const rowIndex = i + 2
    const first = str(i_first >= 0 ? row[i_first] : '')
    const last = str(i_last >= 0 ? row[i_last] : '')
    if (!first && !last) return null
    const d30 = parseDate(i_d30 >= 0 ? row[i_d30] : null)
    const d60 = parseDate(i_d60 >= 0 ? row[i_d60] : null)
    const d90 = parseDate(i_d90 >= 0 ? row[i_d90] : null)
    const s30raw = str(i_s30 >= 0 ? row[i_s30] : '')
    const s60raw = str(i_s60 >= 0 ? row[i_s60] : '')
    const s90raw = str(i_s90 >= 0 ? row[i_s90] : '')
    return {
      id: `${facilityKey.toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
      rowIndex,
      facility: facilityKey,
      name: `${first} ${last}`.trim(),
      shift: str(i_shift >= 0 ? row[i_shift] : ''),
      startDate: parseDate(i_start >= 0 ? row[i_start] : null),
      milestones: {
        d30: { date: d30, statusRaw: s30raw, status: classifyStatus(s30raw, d30) },
        d60: { date: d60, statusRaw: s60raw, status: classifyStatus(s60raw, d60) },
        d90: { date: d90, statusRaw: s90raw, status: classifyStatus(s90raw, d90) },
      },
      benefitsEnrolled: str(i_benefits >= 0 ? row[i_benefits] : ''),
      _colMap: {
        s30: i_s30 >= 0 ? colLetter(i_s30) : null,
        s60: i_s60 >= 0 ? colLetter(i_s60) : null,
        s90: i_s90 >= 0 ? colLetter(i_s90) : null,
        benefitsEnrolled: i_benefits >= 0 ? colLetter(i_benefits) : null,
      },
    }
  }).filter(Boolean)
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!SHARE_URL) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_306090_URL not set — add the share link in Netlify env vars to go live' }) }

  const params = event.queryStringParameters || {}

  try {
    const token = await getToken()
    const { driveId, itemId } = await getDriveRef(token)

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}')
      const { facility, rowIndex, updates, colMap } = body
      if (!facility || !rowIndex || !updates || !colMap) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'facility, rowIndex, updates, colMap required' }) }
      }
      const sheetName = FACILITY_SHEETS[facility]
      if (!sheetName) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown facility: ${facility}` }) }
      const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`
      await Promise.all(Object.entries(updates).filter(([f]) => colMap[f]).map(([f, v]) => graph(`${sheetBase}/range(address='${colMap[f]}${rowIndex}')`, token, 'PATCH', { values: [[v || '']] })))
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updated: Object.keys(updates), rowIndex, facility }) }
    }

    // GET — facility=all pulls every configured sheet, or pass facility=cal etc for one.
    const facilityParam = (params.facility || 'all').toLowerCase()
    const targets = facilityParam === 'all' ? Object.keys(FACILITY_SHEETS) : [facilityParam]

    const results = {}
    for (const fac of targets) {
      const sheetName = FACILITY_SHEETS[fac]
      if (!sheetName) continue
      const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`
      const values = await fetchSheetValues(sheetBase, token)
      if (!values || values.length < 1) { results[fac] = []; continue }
      const [headerRow, ...dataRows] = values
      results[fac] = parseFacilitySheet(headerRow, dataRows, fac)
    }

    const records = Object.values(results).flat()
    return { statusCode: 200, headers: cors, body: JSON.stringify({ records, count: records.length, byFacility: results }) }
  } catch (err) {
    console.error('[sharepoint-30-60-90]', err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) }
  }
}
