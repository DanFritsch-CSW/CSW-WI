'use strict'

// Coaching Dashboard — Tim Morris's own prototype (built with Claude,
// sent via Front 2026-08-14), adapted here to match the rest of the app's
// pattern: live SharePoint read instead of a manual "download xlsx -> run
// python script -> rebuild app" pipeline. The actual dashboard component
// (CoachingDashboard.jsx) and its data shape are UNCHANGED from what Tim
// built — this function just produces that same JSON shape from a live
// Graph API read instead of a local Python script.
//
// Read-only, deliberately: per Tim's own documented workflow, edits
// happen in Excel (add a session row) or via asking Claude directly to
// pull a Fathom transcript and draft the recap/homework/LOE fields — not
// through this dashboard. No POST handler needed.
//
// BLOCKED as of 2026-08-17: SHAREPOINT_COACHING_URL not set — Tim needs
// to confirm whether this workbook lives on SharePoint yet, or is still
// local/email-only. Once it's there, add the env var in Netlify and this
// goes live with no code change, same as every other tracker in this app.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET
const SHARE_URL     = process.env.SHAREPOINT_COACHING_URL || null

const SHEET_LOG      = 'Coaching Log'
const SHEET_MANAGERS = 'Managers'
const FALLBACK_RANGE = 'A1:Q400'
const MANAGERS_RANGE = 'A1:G45'

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

async function graph(path, token) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Graph GET ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text)
}

let _driveRef = null
async function getDriveRef(token) {
  if (_driveRef) return _driveRef
  if (!SHARE_URL) throw new Error('SHAREPOINT_COACHING_URL not set — add the share link in Netlify env vars')
  const encoded = Buffer.from(SHARE_URL).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const item = await graph(`/shares/u!${encoded}/driveItem`, token)
  _driveRef = { driveId: item.parentReference.driveId, itemId: item.id }
  return _driveRef
}

async function fetchSheetValues(sheetBase, token, fallbackRange) {
  try {
    const r = await graph(`${sheetBase}/usedRange`, token)
    if (r.values && r.values.length > 0) return r.values
  } catch (err) {
    console.warn(`[fetchSheetValues] usedRange failed: ${err.message.slice(0, 80)}`)
  }
  const r = await graph(`${sheetBase}/range(address='${fallbackRange}')`, token)
  const vals = r.values || []
  let last = vals.length - 1
  while (last > 0 && vals[last].every((v) => v === null || v === '')) last--
  return vals.slice(0, last + 1)
}

// ---- Helpers ------------------------------------------------------------
function str(v) {
  if (v == null) return ''
  const s = String(v).trim()
  return ['null', 'nan', 'none', 'n/a'].includes(s.toLowerCase()) ? '' : s
}
function toDateStr(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number') return new Date((v - 25569) * 86400 * 1000).toISOString().slice(0, 10)
  const d = new Date(v)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}
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

// Row 2 of Coaching Log is the real header (row 1 is section group labels
// like "Session Detail" / "Homework" spanning merged cells).
function parseCoachingLog(rows) {
  const headerRow = rows[1] || rows[0]
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('manager name'), date: c.find('meeting date'), fathom: c.find('fathom link'),
    recap: c.find('mtg recap'), lastHw: c.find('last homework'), hwDone: c.find('hw completion'),
    g1: c.find('loe 1 - goal'), s1: c.find('loe 1 - status'), n1: c.find("loe 1 - tim's notes"),
    g2: c.find('loe 2 - goal'), s2: c.find('loe 2 - status'), n2: c.find("loe 2 - tim's notes"),
    g3: c.find('loe 3 - goal'), s3: c.find('loe 3 - status'), n3: c.find("loe 3 - tim's notes"),
    comment: c.find('tim overall comment'), status: c.find('processing status'),
  }
  const dataRows = rows.slice(2)
  const sessions = []
  for (const row of dataRows) {
    // Same stop-at-first-blank-row rule as parseManagers — protects
    // against any trailing notes/instructions further down the sheet.
    if (row.every((v) => str(v) === '')) break
    const name = str(row[i.name])
    if (!name) continue
    const idx = sessions.length
    const lastHomework = str(row[i.lastHw])
    sessions.push({
      row: idx + 3,
      manager: name,
      date: toDateStr(row[i.date]),
      fathomUrl: str(row[i.fathom]) || null,
      recap: str(row[i.recap]),
      lastHomework,
      lastHomeworkItems: lastHomework ? lastHomework.split(/\r?\n|;\s*/).map((s) => s.trim()).filter(Boolean) : [],
      hwCompletion: str(row[i.hwDone]),
      loes: [
        { n: 1, goal: str(row[i.g1]), status: str(row[i.s1]), notes: str(row[i.n1]) },
        { n: 2, goal: str(row[i.g2]), status: str(row[i.s2]), notes: str(row[i.n2]) },
        { n: 3, goal: str(row[i.g3]), status: str(row[i.s3]), notes: str(row[i.n3]) },
      ].filter((l) => l.goal || l.status || l.notes),
      overallComment: str(row[i.comment]),
      processingStatus: str(row[i.status]),
    })
  }
  return sessions
}

function parseManagers(rows) {
  const headerRow = rows[2] || rows[0] // row 3 is the real header per the sheet's own layout
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('manager name'), title: c.find('title'), team: c.find('team or site'),
    coach: c.find('coach'), active: c.find('active'),
  }
  const dataRows = rows.slice(3)
  const managers = []
  for (const row of dataRows) {
    // Stop at the first fully-blank row — anything after that (e.g. a
    // footnote like "Note: Alex Andino above is a worked example...") is
    // sheet documentation, not roster data, even if column A has text.
    if (row.every((v) => str(v) === '')) break
    const name = str(row[i.name])
    if (!name) continue
    managers.push({
      name, title: str(row[i.title]), team: str(row[i.team]), coach: str(row[i.coach]),
      active: str(row[i.active]).toLowerCase() !== 'no',
    })
  }
  return managers
}

// Combines the two sheets into exactly the JSON shape CoachingDashboard.jsx
// expects (see its README: managers[] with sessions[]/latest, sessions
// sorted newest-first, pendingProcessing count).
function buildDashboardData(logSessions, managers) {
  const byManager = new Map()
  for (const s of logSessions) {
    if (!byManager.has(s.manager)) byManager.set(s.manager, [])
    byManager.get(s.manager).push(s)
  }
  for (const list of byManager.values()) list.sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  const managerList = managers.length ? managers : [...byManager.keys()].map((name) => ({ name, title: '', team: '', active: true }))

  const outManagers = managerList.map((m) => {
    const sessions = byManager.get(m.name) || []
    return {
      name: m.name, title: m.title, team: m.team, active: m.active,
      sessionCount: sessions.length,
      sessions,
      latest: sessions[0] || null,
    }
  })

  const pendingProcessing = logSessions.filter((s) => s.processingStatus.toLowerCase() === 'needs processing').length

  return {
    source: 'Coaching_Dashboard_Data.xlsx (live via SharePoint)',
    generatedAt: new Date().toISOString(),
    pendingProcessing,
    managers: outManagers,
  }
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!SHARE_URL) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_COACHING_URL not set — confirm with Tim whether this workbook is on SharePoint yet, then add the share link in Netlify env vars to go live' }) }

  try {
    const token = await getToken()
    const { driveId, itemId } = await getDriveRef(token)
    const logBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(SHEET_LOG)}`
    const mgrBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(SHEET_MANAGERS)}`

    const [logValues, mgrValues] = await Promise.all([
      fetchSheetValues(logBase, token, FALLBACK_RANGE),
      fetchSheetValues(mgrBase, token, MANAGERS_RANGE),
    ])

    const sessions = parseCoachingLog(logValues)
    const managers = parseManagers(mgrValues)
    const data = buildDashboardData(sessions, managers)

    return { statusCode: 200, headers: cors, body: JSON.stringify(data) }
  } catch (err) {
    console.error('[sharepoint-coaching]', err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) }
  }
}
