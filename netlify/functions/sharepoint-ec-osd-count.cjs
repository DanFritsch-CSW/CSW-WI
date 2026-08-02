'use strict'

// Direct SharePoint Graph read for Eau Claire's OSD tracker. Added
// 2026-08-02. EC is the one facility with NO daily-synced Silver table in
// MotherDuck (see motherduck-osd-count.cjs header for the full story on
// CAL/KEN/MAD, which DO have a synced copy) — so this function reads the
// live Excel file straight from SharePoint every time it's called, using
// the same Graph Workbook API pattern already proven in sharepoint-dvr.cjs
// (same env vars, same token/fetch helpers, same usedRange-with-bounded-
// fallback approach for large/oddly-formatted sheets).
//
// READ-ONLY. This function never writes to the EC tracker or any other
// SharePoint file — Dan was explicit that this portion of the app only
// reads OSD data, never modifies the source trackers.
//
// Same two rules as motherduck-osd-count.cjs (confirmed with Dan for
// consistency across facilities):
//   - Only rows where "CSW at Fault?" is truthy count.
//   - Quarter is defined by "Initial Email Date".
//
// driveId/itemId below were resolved once via Microsoft 365 search
// (Eau Claire Customer Inventory.OSD Tracker.xlsx) rather than re-deriving
// from the share URL on every call — one less round trip, same file.
// If this file is ever moved/renamed, these will need to be re-resolved.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET

const EC_DRIVE_ID = 'b!120Zjdj0C0-EvKbHRG5oi-uE8BmZTTRJkJoszTl3JCBLRG8AE6zGRplPW7yDgsqK'
const EC_ITEM_ID  = '015ENPMHTCENSEY63XCVCJEKHYKCXV7LE4'

// Bounded fallback ranges for when usedRange times out — same reasoning
// as sharepoint-dvr.cjs (some of these trackers have phantom formatting
// that makes usedRange hang or return nothing).
const FALLBACK_RANGE_LARGE = 'A1:CB5000'
const FALLBACK_RANGE_SMALL = 'A1:CB500'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

let _token = null, _tokenExpiry = 0
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  })
  const d = await res.json()
  if (!res.ok) throw new Error(`Auth failed: ${d.error_description || JSON.stringify(d)}`)
  _token = d.access_token
  _tokenExpiry = Date.now() + (d.expires_in - 120) * 1000
  return _token
}

async function graph(path, token) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Graph GET ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function findTrackerSheetName(token) {
  const r = await graph(`/drives/${EC_DRIVE_ID}/items/${EC_ITEM_ID}/workbook/worksheets`, token)
  const sheets = r.value || []
  const match = sheets.find((s) => /tracker/i.test(s.name)) || sheets[0]
  if (!match) throw new Error('No worksheets found in EC OSD tracker workbook')
  return match.name
}

async function fetchSheetValues(sheetBase, token) {
  try {
    const r = await graph(`${sheetBase}/usedRange`, token)
    if (r.values && r.values.length > 0) return r.values
  } catch (err) {
    console.warn(`[ec-osd] usedRange failed: ${err.message.slice(0, 80)}`)
  }
  for (const range of [FALLBACK_RANGE_LARGE, FALLBACK_RANGE_SMALL]) {
    try {
      const r = await graph(`${sheetBase}/range(address='${range}')`, token)
      const vals = r.values || []
      let last = vals.length - 1
      while (last > 0 && vals[last].every((v) => v === null || v === '' || v === 0)) last--
      return vals.slice(0, last + 1)
    } catch (err2) {
      console.warn(`[ec-osd] fallback ${range} failed: ${err2.message.slice(0, 80)}`)
    }
  }
  return []
}

function parseExcelDate(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return new Date((v - 25569) * 86400 * 1000)
  const d = new Date(String(v).trim())
  return isNaN(d.getTime()) ? null : d
}

function isTruthy(v) {
  if (v === true) return true
  if (typeof v === 'string') return ['true', 'yes', 'y', '1'].includes(v.trim().toLowerCase())
  if (typeof v === 'number') return v === 1
  return false
}

function buildColMap(headerRow) {
  const col = {}
  headerRow.forEach((h, i) => { col[String(h).trim().toLowerCase()] = i })
  return {
    find(...terms) {
      for (const t of terms) {
        if (col[t.toLowerCase()] !== undefined) return col[t.toLowerCase()]
        const k = Object.keys(col).find((k) => k.includes(t.toLowerCase()))
        if (k !== undefined) return col[k]
      }
      return -1
    },
  }
}

function quarterBounds(quarterStr) {
  const [yStr, qStr] = quarterStr.split('-Q')
  const y = Number(yStr)
  const q = Number(qStr)
  const startMonth = (q - 1) * 3
  return [new Date(Date.UTC(y, startMonth, 1)), new Date(Date.UTC(y, startMonth + 3, 1))]
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return { statusCode: 503, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  }

  let quarter
  try {
    ;({ quarter } = JSON.parse(event.body || '{}'))
    if (!quarter || !/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error('invalid quarter')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { quarter: 'YYYY-Qn' } — ${e.message}` }) }
  }

  const [qStart, qEnd] = quarterBounds(quarter)

  try {
    const token = await getToken()
    const sheetName = await findTrackerSheetName(token)
    const sheetBase = `/drives/${EC_DRIVE_ID}/items/${EC_ITEM_ID}/workbook/worksheets/${encodeURIComponent(sheetName)}`
    const values = await fetchSheetValues(sheetBase, token)

    if (!values || values.length < 2) {
      return {
        statusCode: 200, headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ facility: 'ec', quarter, osdCount: { count: 0 }, totalRowsThisQuarter: 0, sheetName, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 }),
      }
    }

    const [headerRow, ...dataRows] = values
    const c = buildColMap(headerRow)
    const i_date = c.find('initial email date')
    const i_fault = c.find('csw at fault')
    if (i_date < 0 || i_fault < 0) {
      throw new Error(`Expected columns not found on sheet "${sheetName}" (found ${headerRow.length} columns) — tracker template may differ from other facilities`)
    }

    let totalThisQuarter = 0
    let faultCount = 0
    for (const row of dataRows) {
      const d = parseExcelDate(row[i_date])
      if (!d || d < qStart || d >= qEnd) continue
      totalThisQuarter++
      if (isTruthy(row[i_fault])) faultCount++
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility: 'ec', quarter, sheetName,
        totalRowsThisQuarter: totalThisQuarter,
        osdCount: { count: faultCount },
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, quarter, elapsedMs: Date.now() - t0 }),
    }
  }
}
