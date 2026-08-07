'use strict'

// Referral Bonus Tracker — single sheet, per Dan/Tim's 2026-08-07 HR call.
// Same Graph API auth pattern as the other sharepoint-*.cjs functions.
// Confirmed live 2026-08-07 via Microsoft 365 connector before writing
// any parsing logic.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET
const SHARE_URL     = process.env.SHAREPOINT_REFERRAL_URL || null

const SHEET_NAME = 'Referral '  // trailing space matches source tab name
const FALLBACK_RANGE = 'A1:G200'

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
  if (!SHARE_URL) throw new Error('SHAREPOINT_REFERRAL_URL not set — add the share link in Netlify env vars')
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
function isPaid(v) {
  return str(v).toLowerCase() === 'yes'
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

// Referral | Who was referred | Hire Date | 90 days ($200) | Paid? | 1 year ($300) | Paid?
// Two columns are both literally named "Paid?" — buildColMap.find only returns
// the first match, so we locate both by raw header position instead.
function parseReferrals(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i_name = c.find('name'), i_referred = c.find('who was referred'), i_hire = c.find('hire date')
  const i_90 = c.find('90 days'), i_1yr = c.find('1 year')
  // Both "Paid?" columns sit immediately after their bonus-date column.
  const i_90paid = i_90 >= 0 ? i_90 + 1 : -1
  const i_1yrpaid = i_1yr >= 0 ? i_1yr + 1 : -1

  return dataRows.map((row, idx) => {
    const rowIndex = idx + 2
    const referred = str(row[i_referred])
    if (!referred) return null
    return {
      id: `REF-${String(idx + 1).padStart(3, '0')}`, rowIndex,
      referrerName: str(row[i_name]), referredName: referred, hireDate: str(row[i_hire]),
      bonus90Date: str(row[i_90]), bonus90Paid: isPaid(row[i_90paid]),
      bonus1yrDate: str(row[i_1yr]), bonus1yrPaid: isPaid(row[i_1yrpaid]),
      _colMap: { bonus90Paid: i_90paid >= 0 ? colLetter(i_90paid) : null, bonus1yrPaid: i_1yrpaid >= 0 ? colLetter(i_1yrpaid) : null },
    }
  }).filter(Boolean)
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!SHARE_URL) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_REFERRAL_URL not set — add the share link in Netlify env vars to go live' }) }

  try {
    const token = await getToken()
    const { driveId, itemId } = await getDriveRef(token)
    const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(SHEET_NAME)}`

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}')
      const { rowIndex, updates, colMap } = body
      if (!rowIndex || !updates || !colMap) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'rowIndex, updates, colMap required' }) }
      await Promise.all(Object.entries(updates).filter(([f]) => colMap[f]).map(([f, v]) => graph(`${sheetBase}/range(address='${colMap[f]}${rowIndex}')`, token, 'PATCH', { values: [[v || '']] })))
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updated: Object.keys(updates), rowIndex }) }
    }

    const values = await fetchSheetValues(sheetBase, token)
    if (!values || values.length < 1) return { statusCode: 200, headers: cors, body: JSON.stringify({ records: [], count: 0 }) }
    const [headerRow, ...dataRows] = values
    const records = parseReferrals(headerRow, dataRows)
    return { statusCode: 200, headers: cors, body: JSON.stringify({ records, count: records.length }) }
  } catch (err) {
    console.error('[sharepoint-referral-bonus]', err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) }
  }
}
