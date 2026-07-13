'use strict'

// sharepoint-dvr-append.cjs
// Receives a Zapier webhook POST (LoadProof -> New Load Record)
// and appends a new incident row to the appropriate SharePoint DVRS Excel file.
//
// Endpoint: POST /.netlify/functions/sharepoint-dvr-append?facility=cal|ken|mad
//
// Zapier field mappings (left = key, right = LoadProof field):
//   secret          -> CSW-DVR-2026 (typed manually)
//   date            -> Date
//   loadproofUrl    -> Load Url
//   uploadedBy      -> Sitename
//   customer        -> Customers Madison (or Caledonia / Kenosha)
//   orderNum        -> Order Number
//   employee        -> Employee Name Submitting
//   incidentType    -> Category  (writes to Shipment Type column)
//   reason          -> Problem
//   licensePlate    -> License Plate
//   incidentNotes   -> Notes
//   photos          -> Num  (photo count)
//   videos          -> Live 2 (or Videos field)

const TENANT_ID      = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID      = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET  = process.env.SHAREPOINT_CLIENT_SECRET
const WEBHOOK_SECRET = process.env.SHAREPOINT_WEBHOOK_SECRET

const FACILITY_CONFIG = {
  mad: {
    shareUrl:  'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQAPASRQFjePQrRLN4AwInUiAer-IKqYNs0K8QDh33CXJa0',
    sheetName: 'Mad CSW INV CTRL -DVRS-',
  },
  ken: {
    shareUrl:  'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBQP5TR7kMuQ5VxOHGS9_aqAbxgjdncbKna0Z_YxdLMHGI',
    sheetName: 'Ken CSW INV CTRL -DVRS',
  },
  cal: {
    shareUrl:  'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBZx7jyJ1QoTogdo9k0MVgNAY3X7ovQjmyMssbvwbOYnlE',
    sheetName: 'Cal CSW INV CTRL -DVRS-',
  },
}

let _token = null, _tokenExpiry = 0
async function getToken () {
  if (_token && Date.now() < _tokenExpiry) return _token
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    }
  )
  const d = await res.json()
  if (!res.ok) throw new Error(`Auth failed: ${d.error_description || JSON.stringify(d)}`)
  _token = d.access_token
  _tokenExpiry = Date.now() + (d.expires_in - 120) * 1000
  return _token
}

async function graph (path, token, method = 'GET', body = null) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 204) return null
  const text = await res.text()
  if (!res.ok) throw new Error(`Graph ${method} ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text)
}

const _driveCache = {}
async function getDriveRef (facility, token) {
  if (_driveCache[facility]) return _driveCache[facility]
  const { shareUrl } = FACILITY_CONFIG[facility]
  const encoded = Buffer.from(shareUrl).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const item = await graph(`/shares/u!${encoded}/driveItem`, token)
  _driveCache[facility] = { driveId: item.parentReference.driveId, itemId: item.id }
  return _driveCache[facility]
}

function colLetter (idx) {
  let r = '', n = idx + 1
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26) }
  return r
}

function buildColMap (headerRow) {
  const col = {}
  headerRow.forEach((h, i) => { col[String(h).trim().toLowerCase()] = i })
  return {
    find (...terms) {
      for (const t of terms) {
        // Exact match first
        if (col[t.toLowerCase()] !== undefined) return col[t.toLowerCase()]
        // Then partial match
        const k = Object.keys(col).find(k => k.includes(t.toLowerCase()))
        if (k !== undefined) return col[k]
      }
      return -1
    },
  }
}

async function findLastDataRow (sheetBase, token) {
  const r = await graph(`${sheetBase}/range(address='A1:A10000')`, token)
  const vals = r.values || []
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] !== null && vals[i][0] !== '' && vals[i][0] !== 0) {
      return i + 1
    }
  }
  return 1
}

function toExcelDate (raw) {
  if (!raw) return new Date().toLocaleDateString('en-US')
  try {
    const d = new Date(raw)
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-US')
  } catch {}
  return raw
}

function str (v) { return v != null ? String(v).trim() : '' }

exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }

  let payload
  try { payload = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) } }

  if (WEBHOOK_SECRET && payload.secret !== WEBHOOK_SECRET) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid secret' }) }
  }

  const facility = ((event.queryStringParameters || {}).facility || 'mad').toLowerCase()
  const config   = FACILITY_CONFIG[facility]
  if (!config) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown facility: ${facility}` }) }

  try {
    const token  = await getToken()
    const { driveId, itemId } = await getDriveRef(facility, token)
    const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(config.sheetName)}`

    // Get header row to build column map dynamically
    const headerRange = await graph(`${sheetBase}/range(address='1:1')`, token)
    const headerRow   = headerRange.values?.[0] || []
    const c = buildColMap(headerRow)
    const totalCols = headerRow.length

    // --- Column index resolution ---
    // All searches use partial matching as fallback, so slight header
    // variations between facilities are handled automatically.

    // Date columns
    const i_date         = c.find('filter by this date')
    const i_lpDate       = c.find('loadproof date')           // col B in MAD: "Loadproof Date (Copy here)"

    // Incident details
    const i_type         = c.find('csw inv ctrl - shipment type', 'shipment type')
    const i_respParty    = c.find('csw inv ctrl - responsible party', 'responsible party')
    const i_lot          = c.find('csw inv ctrl - lot #', 'lot #')
    const i_mat          = c.find('csw inv ctrl - material #', 'material #')
    const i_reason       = c.find('csw inv ctrl - reason', 'reason')
    const i_lp           = c.find('csw inv ctrl - license plate', 'license plate')
    const i_cases        = c.find('csw inv ctrl - # of cases', '# of cases')
    const i_notes        = c.find('csw inv ctrl - notes', 'notes')
    // Order: MAD header is "CSW INV CTRL - Order" (no #), KEN/CAL may differ
    const i_order        = c.find('csw inv ctrl - order #', 'csw inv ctrl - order', 'order')
    const i_damage       = c.find('csw inv ctrl - damage type', 'damage type')
    const i_emp          = c.find('csw inv ctrl - employee', 'employee')
    const i_customer     = c.find('customer madison', 'customer caledonia', 'customer kenosha', 'customer')
    const i_category     = c.find('category')                 // col O in MAD: LoadProof category
    const i_photos       = c.find('photos')
    const i_videos       = c.find('videos')

    // LoadProof link + uploader
    const i_link         = c.find('link to load proof', 'load proof url', 'loadproof')
    const i_uploadBy     = c.find('uploaded by')

    // Build the row array
    const row = new Array(totalCols).fill('')
    const set = (idx, val) => { if (idx >= 0 && idx < totalCols && val !== '' && val != null) row[idx] = val }

    const dateStr = toExcelDate(payload.date)

    set(i_date,      dateStr)
    set(i_lpDate,    dateStr)                                  // copy date to Loadproof Date column too
    set(i_type,      str(payload.incidentType))
    set(i_respParty, str(payload.responsibleParty))
    set(i_lot,       str(payload.lotNum))
    set(i_mat,       str(payload.materialNum))
    set(i_reason,    str(payload.reason))
    set(i_lp,        str(payload.licensePlate))
    set(i_cases,     payload.cases != null ? Number(payload.cases) || '' : '')
    set(i_notes,     str(payload.incidentNotes))
    set(i_order,     str(payload.orderNum))
    set(i_damage,    str(payload.damageType))
    set(i_emp,       str(payload.employee))
    set(i_customer,  str(payload.customer))
    set(i_category,  str(payload.category))                   // LoadProof category field
    set(i_photos,    payload.photos != null ? Number(payload.photos) || '' : '')
    set(i_videos,    payload.videos != null ? Number(payload.videos) || '' : '')
    set(i_link,      str(payload.loadproofUrl))
    set(i_uploadBy,  str(payload.uploadedBy))

    // Find the next empty row and write
    const lastRow = await findLastDataRow(sheetBase, token)
    const nextRow = lastRow + 1
    const endCol  = colLetter(totalCols - 1)

    await graph(
      `${sheetBase}/range(address='A${nextRow}:${endCol}${nextRow}')`,
      token, 'PATCH',
      { values: [row] }
    )

    console.log(`[sharepoint-dvr-append][${facility}] Appended row ${nextRow}`)
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ success: true, facility, row: nextRow }),
    }

  } catch (err) {
    console.error(`[sharepoint-dvr-append][${facility}]`, err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message, facility }) }
  }
}
