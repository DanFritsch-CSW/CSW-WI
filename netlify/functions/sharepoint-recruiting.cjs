'use strict'

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET

// Set this in Netlify env vars once the share link is available. No code change
// needed after that — just add SHAREPOINT_RECRUITING_URL and redeploy (or it
// picks up on next cold start).
const RECRUITING_SHARE_URL = process.env.SHAREPOINT_RECRUITING_URL || null

const TABS = {
  needs:       'Current Needs',
  filled:      'Filled',
  phonescreen: 'Phone Screen Notes',
  interviews:  'HR Interviews',
  ttf:         'TIME TO FILL TRACKER ', // trailing space matches source tab name
  y2026:       '2026',
  y2025:       '2025',
  y2024:       '2024',
  y2023:       '2023',
  y2022:       '2022',
}

const FALLBACK_RANGE_LARGE = 'A1:Q2000'
const FALLBACK_RANGE_SMALL = 'A1:Q500'

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
  if (!RECRUITING_SHARE_URL) throw new Error('SHAREPOINT_RECRUITING_URL not set — add the share link in Netlify env vars')
  const encoded = Buffer.from(RECRUITING_SHARE_URL).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
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
  for (const range of [FALLBACK_RANGE_LARGE, FALLBACK_RANGE_SMALL]) {
    try {
      const r = await graph(`${sheetBase}/range(address='${range}')`, token)
      const vals = r.values || []
      let last = vals.length - 1
      while (last > 0 && vals[last].every((v) => v === null || v === '' || v === 0)) last--
      return vals.slice(0, last + 1)
    } catch (err2) {
      console.warn(`[fetchSheetValues] fallback ${range} failed: ${err2.message.slice(0, 80)}`)
    }
  }
  return []
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

// Stage inference from the free-text "Pipeline" note on Current Needs
function inferStage(pipelineText) {
  const s = (pipelineText || '').toLowerCase()
  if (!s) return 'No Candidate'
  if (s.includes('cleared to start')) return 'Cleared to Start'
  if (s.includes('offer accepted') || s.includes('accepted offer')) return 'Offer Accepted'
  if (s.includes('bkg cleared') || s.includes('background cleared')) return 'Background Cleared'
  if (s.includes('offer sent') || s.includes('sent offer')) return 'Offer Sent'
  if (s.includes('internal transfer') || s.includes('internal move')) return 'Internal Transfer'
  if (s.includes('internal posting')) return 'Internal Posting'
  return 'In Process'
}

// ---- Tab parsers (header-based tabs) ------------------------------------
function parseCurrentNeeds(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i_pos = c.find('position'), i_shift = c.find('shift'), i_office = c.find('office')
  const i_pipe = c.find('pipeline'), i_reason = c.find('reason')
  const i_posted = c.find('date posted'), i_filled = c.find('date filled'), i_sent = c.find('sent')
  return dataRows.map((row, i) => {
    const rowIndex = i + 2
    const position = str(i_pos >= 0 ? row[i_pos] : '')
    if (!position) return null
    const pipeline = str(i_pipe >= 0 ? row[i_pipe] : '')
    return {
      id: `REQ-${String(i + 1).padStart(3, '0')}`, rowIndex,
      position, shift: str(i_shift >= 0 ? row[i_shift] : ''), facility: str(i_office >= 0 ? row[i_office] : ''),
      pipeline, stage: inferStage(pipeline), reason: str(i_reason >= 0 ? row[i_reason] : ''),
      datePosted: parseDate(i_posted >= 0 ? row[i_posted] : null), dateFilled: parseDate(i_filled >= 0 ? row[i_filled] : null),
      postingsSent: str(i_sent >= 0 ? row[i_sent] : ''),
      _colMap: {
        pipeline: i_pipe >= 0 ? colLetter(i_pipe) : null, reason: i_reason >= 0 ? colLetter(i_reason) : null,
        dateFilled: i_filled >= 0 ? colLetter(i_filled) : null, postingsSent: i_sent >= 0 ? colLetter(i_sent) : null,
      },
    }
  }).filter(Boolean)
}

function parseHrInterviews(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const i_name = c.find('name'), i_pos = c.find('position'), i_screened = c.find('date screened')
  const i_assessSent = c.find('date assessment sent'), i_assessDone = c.find('assessment completed')
  const i_next = c.find('move to next step'), i_scoreSched = c.find('scorecard interview scheduled')
  const i_fathom = c.find('scorecard interview fathom')
  return dataRows.map((row, i) => {
    const rowIndex = i + 2
    const name = str(i_name >= 0 ? row[i_name] : '')
    if (!name) return null
    return {
      id: `HRI-${String(i + 1).padStart(3, '0')}`, rowIndex, name, position: str(i_pos >= 0 ? row[i_pos] : ''),
      dateScreened: parseDate(i_screened >= 0 ? row[i_screened] : null),
      assessmentSent: parseDate(i_assessSent >= 0 ? row[i_assessSent] : null),
      assessmentCompleted: str(i_assessDone >= 0 ? row[i_assessDone] : ''),
      moveToNext: str(i_next >= 0 ? row[i_next] : ''), scorecardScheduled: str(i_scoreSched >= 0 ? row[i_scoreSched] : ''),
      fathomLink: str(i_fathom >= 0 ? row[i_fathom] : ''),
      _colMap: { assessmentCompleted: i_assessDone >= 0 ? colLetter(i_assessDone) : null, moveToNext: i_next >= 0 ? colLetter(i_next) : null, scorecardScheduled: i_scoreSched >= 0 ? colLetter(i_scoreSched) : null },
    }
  }).filter(Boolean)
}

function parseTimeToFill(headerRow, dataRows) {
  const c = buildColMap(headerRow)
  const idx = {
    jobTitle: c.find('job title'), location: c.find('location'), eeName: c.find('ee name'),
    offerDate: c.find('offer date'), offerAccepted: c.find('offer accepted date'),
    bkgCleared: c.find('background cleared date'), drugScreen: c.find('drug screen cleared'),
    startDate: c.find('start date'), status: c.find('status'), postedDate: c.find('posted date'),
    filledDate: c.find('filled/closed date'), daysToOffer: c.find('days to offer'),
    daysToAccept: c.find('days to accept'), daysToStart: c.find('days to start'),
    ttfOpenAccept: c.find('ttf'), ttsOpenStart: c.find('tts'), filledUnder30: c.find('filled (', '30d'),
  }
  return dataRows.map((row, i) => {
    const rowIndex = i + 2
    const jobTitle = str(idx.jobTitle >= 0 ? row[idx.jobTitle] : '')
    if (!jobTitle) return null
    return {
      id: `TTF-${String(i + 1).padStart(3, '0')}`, rowIndex, jobTitle, location: str(idx.location >= 0 ? row[idx.location] : ''),
      candidate: str(idx.eeName >= 0 ? row[idx.eeName] : ''), status: str(idx.status >= 0 ? row[idx.status] : ''),
      postedDate: parseDate(idx.postedDate >= 0 ? row[idx.postedDate] : null),
      startDate: parseDate(idx.startDate >= 0 ? row[idx.startDate] : null),
      daysToAccept: typeof row[idx.daysToAccept] === 'number' ? row[idx.daysToAccept] : null,
      daysToStart: typeof row[idx.daysToStart] === 'number' ? row[idx.daysToStart] : null,
      ttfOpenAccept: typeof row[idx.ttfOpenAccept] === 'number' ? row[idx.ttfOpenAccept] : null,
      ttsOpenStart: typeof row[idx.ttsOpenStart] === 'number' ? row[idx.ttsOpenStart] : null,
      filledUnder30: str(idx.filledUnder30 >= 0 ? row[idx.filledUnder30] : ''),
    }
  }).filter(Boolean)
}

function parseInterviewYear(headerRow, dataRows, year) {
  const c = buildColMap(headerRow)
  const i_name = c.find('candidate name'), i_pos = c.find('position'), i_shift = c.find('shift')
  const i_loc = c.find('location'), i_date = c.find('interview date'), i_outcome = c.find('outcome'), i_notes = c.find('notes')
  return dataRows.map((row, i) => {
    const rowIndex = i + 2
    const name = str(i_name >= 0 ? row[i_name] : '')
    if (!name) return null
    return {
      id: `${year}-${String(i + 1).padStart(3, '0')}`, rowIndex, name, position: str(i_pos >= 0 ? row[i_pos] : ''),
      shift: str(i_shift >= 0 ? row[i_shift] : ''), facility: str(i_loc >= 0 ? row[i_loc] : ''),
      interviewDate: parseDate(i_date >= 0 ? row[i_date] : null), outcome: str(i_outcome >= 0 ? row[i_outcome] : ''),
      notes: str(i_notes >= 0 ? row[i_notes] : ''),
      _colMap: { outcome: i_outcome >= 0 ? colLetter(i_outcome) : null, notes: i_notes >= 0 ? colLetter(i_notes) : null },
    }
  }).filter(Boolean)
}

// Filled & Phone Screen Notes ship with NO header row in the source file —
// positional passthrough until Dan adds headers. Frontend renders these as a
// raw log rather than a structured table.
function parseRawLog(dataRows, prefix) {
  return dataRows.map((row, i) => ({ id: `${prefix}-${String(i + 1).padStart(4, '0')}`, rowIndex: i + 1, cells: row.map((v) => str(v)) }))
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!RECRUITING_SHARE_URL) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_RECRUITING_URL not set — add the share link in Netlify env vars to go live' }) }

  const params = event.queryStringParameters || {}
  const tabKey = (params.tab || 'needs').toLowerCase()
  const sheetName = TABS[tabKey]
  if (!sheetName) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Unknown tab: ${tabKey}. Use one of ${Object.keys(TABS).join(', ')}` }) }

  try {
    const token = await getToken()
    const { driveId, itemId } = await getDriveRef(token)
    const sheetBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}')
      if (body.action === 'append') {
        const { values } = body
        if (!Array.isArray(values)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'values array required' }) }
        const used = await graph(`${sheetBase}/usedRange`, token)
        const nextRow = (used.rowCount || 1) + 1
        const endCol = colLetter(values.length - 1)
        await graph(`${sheetBase}/range(address='A${nextRow}:${endCol}${nextRow}')`, token, 'PATCH', { values: [values] })
        return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, rowIndex: nextRow }) }
      }
      const { rowIndex, updates, colMap } = body
      if (!rowIndex || !updates || !colMap) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'rowIndex, updates, colMap required (or action:"append" with values[])' }) }
      await Promise.all(Object.entries(updates).filter(([f]) => colMap[f]).map(([f, v]) => graph(`${sheetBase}/range(address='${colMap[f]}${rowIndex}')`, token, 'PATCH', { values: [[v || '']] })))
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updated: Object.keys(updates), rowIndex }) }
    }

    const values = await fetchSheetValues(sheetBase, token)
    if (!values || values.length < 1) return { statusCode: 200, headers: cors, body: JSON.stringify({ records: [], count: 0, tab: tabKey }) }

    let records
    if (tabKey === 'filled' || tabKey === 'phonescreen') {
      records = parseRawLog(values, tabKey === 'filled' ? 'FIL' : 'PSN')
    } else {
      const [headerRow, ...dataRows] = values
      if (tabKey === 'needs') records = parseCurrentNeeds(headerRow, dataRows)
      else if (tabKey === 'interviews') records = parseHrInterviews(headerRow, dataRows)
      else if (tabKey === 'ttf') records = parseTimeToFill(headerRow, dataRows)
      else records = parseInterviewYear(headerRow, dataRows, sheetName)
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ records, count: records.length, tab: tabKey }) }
  } catch (err) {
    console.error(`[sharepoint-recruiting][${tabKey}]`, err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message, tab: tabKey }) }
  }
}
