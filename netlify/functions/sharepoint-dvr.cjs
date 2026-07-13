'use strict'

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET

const FACILITY_CONFIG = {
  mad: {
    shareUrl:  'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQAPASRQFjePQrRLN4AwInUiAer-IKqYNs0K8QDh33CXJa0',
    sheetName: 'Mad CSW INV CTRL -DVRS-',
    prefix:    'MAD',
  },
  ken: {
    shareUrl:  'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBQP5TR7kMuQ5VxOHGS9_aqAbxgjdncbKna0Z_YxdLMHGI',
    sheetName: 'Ken CSW INV CTRL -DVRS',
    prefix:    'KEN',
  },
  cal: {
    shareUrl:  'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBZx7jyJ1QoTogdo9k0MVgNAY3X7ovQjmyMssbvwbOYnlE',
    sheetName: 'Cal CSW INV CTRL -DVRS-',
    prefix:    'DVR',
  },
}

// When usedRange is too large (phantom formatting extends used range),
// fall back to this explicit bounded range.
// 80 cols (CB) × 10000 rows = 800k cells — within the 5M Graph API limit.
const FALLBACK_RANGE = 'A1:CB10000'

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
  if (!res.ok) throw new Error(`Graph ${method} ${path} → ${res.status}: ${text}`)
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

// Fetch worksheet values.
// Tries usedRange first; falls back to bounded range if the sheet has
// phantom formatting that inflates the used range beyond Graph API limits.
async function fetchSheetValues (sheetBase, token) {
  try {
    const r = await graph(`${sheetBase}/usedRange`, token)
    if (r.values && r.values.length > 0) return r.values
  } catch (err) {
    const isLimit = err.message.toLowerCase().includes('rangeexceedslimit')
    if (!isLimit) throw err
    console.warn('[sharepoint-dvr] usedRange exceeded limit — falling back to', FALLBACK_RANGE)
  }
  // Fallback: fetch bounded range and strip trailing empty rows
  const r = await graph(`${sheetBase}/range(address='${FALLBACK_RANGE}')`, token)
  const vals = r.values || []
  let last = vals.length - 1
  while (last > 0 && vals[last].every(v => v === null || v === '' || v === 0)) last--
  return vals.slice(0, last + 1)
}

function parseDate (v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number') return new Date((v - 25569) * 86400 * 1000).toISOString().slice(0, 10)
  const s = String(v).trim()
  if (!s) return ''
  try { const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10) } catch { return '' }
}

function str (v) {
  if (v == null) return ''
  const s = String(v).trim()
  return ['null','nan','none','n/a'].includes(s.toLowerCase()) ? '' : s
}

function buildColMap (headerRow) {
  const col = {}
  headerRow.forEach((h, i) => { col[String(h).trim().toLowerCase()] = i })
  return {
    find (...terms) {
      for (const t of terms) {
        if (col[t.toLowerCase()] !== undefined) return col[t.toLowerCase()]
        const k = Object.keys(col).find(k => k.includes(t.toLowerCase()))
        if (k !== undefined) return col[k]
      }
      return -1
    },
  }
}

function colLetter (idx) {
  let r = '', n = idx + 1
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26) }
  return r
}

function parseRows (headerRow, dataRows, prefix) {
  const c = buildColMap(headerRow)
  const i_date       = c.find('filter by this date')
  const i_order      = c.find('csw inv ctrl - order #', 'order #')
  const i_customer   = c.find('customer caledonia','customer kenosha','customer madison','customer','csw inv ctrl - customer')
  const i_type       = c.find('csw inv ctrl - shipment type','shipment type')
  const i_reason     = c.find('csw inv ctrl - reason','reason')
  const i_emp        = c.find('csw inv ctrl - employee','employee')
  const i_respParty  = c.find('csw inv ctrl - responsible party','responsible party')
  const i_cases      = c.find('csw inv ctrl - # of cases','# of cases')
  const i_lot        = c.find('csw inv ctrl - lot #','lot #')
  const i_mat        = c.find('csw inv ctrl - material #','material #')
  const i_lp         = c.find('csw inv ctrl - license plate','license plate')
  const i_notes      = c.find('csw inv ctrl - notes','notes')
  const i_invNotes   = c.find('investigation notes')
  const i_adjDate    = c.find('date adjustment completed')
  const i_adjBy      = c.find('adjustment completed by')
  const i_adjNotes   = c.find('adjustment/resolved notes','adjustment notes')
  const i_coachReq   = c.find('coaching required?','coaching required')
  const i_coachDate  = c.find('date coaching completed')
  const i_coachBy    = c.find('coaching completed by')
  const i_coachNotes = c.find('coaching notes')
  const i_empResp    = c.find('employee who caused','employee responsible')

  const TYPE_NORM = {
    'inbound':'Inbound','outbound':'Outbound',
    'warehouse ops damage':'Warehouse Ops Damage','warehouse ops damage ':'Warehouse Ops Damage',
    'disposal':'Disposal','transfer':'Transfer','dsd':'DSD','cycle count':'Cycle Count',
  }

  const incidents = []
  let counter = 1
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const rowIndex = i + 2

    const incDate = parseDate(i_date >= 0 ? row[i_date] : null)
    if (!incDate) { counter++; continue }

    const adjDate = parseDate(i_adjDate >= 0 ? row[i_adjDate] : null)
    const adjBy   = str(i_adjBy >= 0 ? row[i_adjBy] : '')
    const adjOpen = !(adjDate || adjBy)

    const coachRaw     = str(i_coachReq >= 0 ? row[i_coachReq] : '').toLowerCase()
    const coaching     = coachRaw === 'yes' ? 'Yes' : coachRaw === 'no' ? 'No' : ''
    const coachDate    = parseDate(i_coachDate >= 0 ? row[i_coachDate] : null)
    const coachingOpen = coaching === 'Yes' && !coachDate

    if (!adjOpen && !coachingOpen) { counter++; continue }

    const typeRaw = str(i_type >= 0 ? row[i_type] : '').trim()
    const incidentType = TYPE_NORM[typeRaw.toLowerCase()] || typeRaw
    const reasonRaw    = str(i_reason >= 0 ? row[i_reason] : '')

    incidents.push({
      id: `${prefix}-${String(counter).padStart(4,'0')}`,
      rowIndex, date: incDate,
      orderNum:         str(i_order    >= 0 ? row[i_order]    : ''),
      customer:         str(i_customer >= 0 ? row[i_customer] : ''),
      employee:         str(i_emp      >= 0 ? row[i_emp]      : ''),
      responsibleParty: str(i_respParty >= 0 ? row[i_respParty] : ''),
      incidentType, reason: reasonRaw.charAt(0).toUpperCase() + reasonRaw.slice(1), damageType: '',
      cases: Number(i_cases >= 0 ? row[i_cases] : 0) || 0,
      lotNum:       str(i_lot >= 0 ? row[i_lot] : ''),
      materialNum:  str(i_mat >= 0 ? row[i_mat] : ''),
      licensePlate: str(i_lp  >= 0 ? row[i_lp]  : ''),
      incidentNotes:      str(i_notes    >= 0 ? row[i_notes]    : ''),
      investigationNotes: str(i_invNotes >= 0 ? row[i_invNotes] : ''),
      adjDate: adjDate || '', adjBy, adjNotes: str(i_adjNotes >= 0 ? row[i_adjNotes] : ''), adjOpen,
      coachingRequired:    coaching,
      employeeResponsible: str(i_empResp    >= 0 ? row[i_empResp]    : ''),
      coachingDate: coachDate || '',
      coachingBy:   str(i_coachBy    >= 0 ? row[i_coachBy]    : ''),
      coachingNotes: str(i_coachNotes >= 0 ? row[i_coachNotes] : ''),
      coachingOpen, loadproofUrl: '',
      _colMap: {
        adjDate:             i_adjDate    >= 0 ? colLetter(i_adjDate)    : null,
        adjBy:               i_adjBy      >= 0 ? colLetter(i_adjBy)      : null,
        adjNotes:            i_adjNotes   >= 0 ? colLetter(i_adjNotes)   : null,
        coachingRequired:    i_coachReq   >= 0 ? colLetter(i_coachReq)   : null,
        employeeResponsible: i_empResp    >= 0 ? colLetter(i_empResp)    : null,
        coachingDate:        i_coachDate  >= 0 ? colLetter(i_coachDate)  : null,
        coachingBy:          i_coachBy    >= 0 ? colLetter(i_coachBy)    : null,
        coachingNotes:       i_coachNotes >= 0 ? colLetter(i_coachNotes) : null,
      },
    })
    counter++
  }
  return incidents
}

exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Content-Type':'application/json',
  }
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode:503, headers:cors, body:JSON.stringify({ error:'SharePoint env vars not set' }) }

  const facility = ((event.queryStringParameters || {}).facility || 'mad').toLowerCase()
  const config   = FACILITY_CONFIG[facility]
  if (!config) return { statusCode:400, headers:cors, body:JSON.stringify({ error:`Unknown facility: ${facility}` }) }

  try {
    const token  = await getToken()
    const { driveId, itemId } = await getDriveRef(facility, token)
    const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(config.sheetName)}`

    // POST: write back to specific cells
    if (event.httpMethod === 'POST') {
      const { rowIndex, updates, colMap } = JSON.parse(event.body || '{}')
      if (!rowIndex || !updates || !colMap) return { statusCode:400, headers:cors, body:JSON.stringify({ error:'rowIndex, updates, colMap required' }) }
      await Promise.all(
        Object.entries(updates).filter(([f]) => colMap[f]).map(([f,v]) =>
          graph(`${sheetBase}/range(address='${colMap[f]}${rowIndex}')`, token, 'PATCH', { values:[[v||'']] })
        )
      )
      return { statusCode:200, headers:cors, body:JSON.stringify({ success:true, updated:Object.keys(updates), rowIndex }) }
    }

    // GET: read all open rows
    const values = await fetchSheetValues(sheetBase, token)
    if (!values || values.length < 2) return { statusCode:200, headers:cors, body:JSON.stringify({ incidents:[], count:0, facility }) }

    const [headerRow, ...dataRows] = values
    const incidents = parseRows(headerRow, dataRows, config.prefix)
    return { statusCode:200, headers:cors, body:JSON.stringify({ incidents, count:incidents.length, facility }) }

  } catch (err) {
    console.error(`[sharepoint-dvr][${facility}]`, err.message)
    return { statusCode:500, headers:cors, body:JSON.stringify({ error:err.message, facility }) }
  }
}
