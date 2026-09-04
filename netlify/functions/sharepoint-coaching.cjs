'use strict'

// Coaching Dashboard — Tim Morris's own prototype (built with Claude,
// sent via Front 2026-08-14), adapted to match the rest of the app's
// pattern: live SharePoint read instead of a manual "download xlsx -> run
// python script -> rebuild app" pipeline.
//
// 2026-09-04 — Tim/Dan Fathom call: dashboard was showing stale data and
// wrong names because it was pointed at the ORIGINAL file, while Tim had
// moved on to Coaching_Dashboard_Data_UPDATED.xlsx. Re-pointed
// SHAREPOINT_COACHING_URL. The new file is NOT just newer rows in the
// same shape — Tim restructured the Coaching Log columns:
//   - "Homework Assigned" (col E) replaces "Last Homework" — semantically
//     this is what's due NEXT session, not what was checked from last
//     time. Still mapped to lastHomework/lastHomeworkItems below since
//     that's what CoachingDashboard.jsx's UI already expects and renders
//     as a checklist — functionally equivalent for display purposes.
//   - Each LOE's "Tim's Notes" column is GONE, replaced by a numeric
//     "LOE N - Progress" (0-100%). loe.notes is now always empty (the
//     component already renders "Notes not written yet" gracefully for
//     that); the numeric progress is captured as loe.progress for future
//     use even though the current UI doesn't render it.
//   - "HW Completion" (was per-session) is GONE, replaced by "Prior
//     Homework Done?" (col P) — did they complete what was assigned LAST
//     session. Mapped to hwCompletion since it's the closest equivalent
//     the UI has a slot for.
//   - "Tim Overall Comment" free-text column is GONE, replaced by a
//     computed "Overall Progress" formula column (col O, average of the
//     three LOE progress values — do not write to this column, it's a
//     live formula). Surfaced as overallComment = "Overall progress: N%"
//     rather than leaving that UI slot blank for every manager — this is
//     the sheet's own computed value, not fabricated.
//
// TWO-WAY as of 2026-09-04: Tim wants "info to pass both ways" — added
// POST support. 'update' patches specific fields on an existing row
// (e.g. Claude filling in Recap/Homework/LOEs from a Fathom transcript
// and flipping Processing Status to 'Processed'). 'append' adds a brand
// new session row. Both use a fixed field->column map (LOG_FIELD_COLS)
// and deliberately EXCLUDE column O (Overall Progress) since it's a live
// formula — writing to it would destroy the formula.

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET
const SHARE_URL     = process.env.SHAREPOINT_COACHING_URL || null

const SHEET_LOG      = 'Coaching Log'
const SHEET_MANAGERS = 'Managers'
const FALLBACK_RANGE = 'A1:Q400'
const MANAGERS_RANGE = 'A1:H45'

// Coaching Log field -> column letter. Column O (Overall Progress) is
// deliberately absent — it's a live AVERAGE() formula, never write to it.
const LOG_FIELD_COLS = {
  managerName: 'A', meetingDate: 'B', fathomLink: 'C', recap: 'D', homeworkAssigned: 'E',
  g1: 'F', s1: 'G', p1: 'H',
  g2: 'I', s2: 'J', p2: 'K',
  g3: 'L', s3: 'M', p3: 'N',
  priorHomeworkDone: 'P', processingStatus: 'Q',
}

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
  const text = await res.text()
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`Graph ${method} ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text)
}

let _driveRef = null
async function getDriveRef(token) {
  if (_driveRef) return _driveRef
  // Prefer direct drive/item IDs when set — the doc.aspx-style URL Tim
  // sent (with a curly-brace sourcedoc GUID) got rejected by Netlify's
  // env-var API (422) for reasons that weren't worth chasing further;
  // resolving the file once via the Microsoft 365 connector and hardcoding
  // its stable driveId/itemId sidesteps the whole URL-encoding problem.
  const driveId = process.env.SHAREPOINT_COACHING_DRIVE_ID
  const itemId = process.env.SHAREPOINT_COACHING_ITEM_ID
  if (driveId && itemId) {
    _driveRef = { driveId, itemId }
    return _driveRef
  }
  if (!SHARE_URL) throw new Error('Neither SHAREPOINT_COACHING_DRIVE_ID/ITEM_ID nor SHAREPOINT_COACHING_URL is set')
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
// Same as str() but preserves "N/A" — it's a real, meaningful dropdown
// value for Prior Homework Done? (see the Lists sheet: Yes/Partial/No/N/A),
// not a null sentinel like it is for most other cells in this app.
function strKeepNA(v) {
  if (v == null) return ''
  const s = String(v).trim()
  return ['null', 'nan', 'none'].includes(s.toLowerCase()) ? '' : s
}
function toDateStr(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number') return new Date((v - 25569) * 86400 * 1000).toISOString().slice(0, 10)
  const d = new Date(v)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}
function toProgressPct(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v <= 1 ? Math.round(v * 100) : Math.round(v)
  const n = parseFloat(String(v).replace('%', ''))
  return isNaN(n) ? null : Math.round(n)
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
// like "Session Detail" / "LOE 1" spanning merged cells).
function parseCoachingLog(rows) {
  const headerRow = rows[1] || rows[0]
  const c = buildColMap(headerRow)
  const i = {
    name: c.find('manager name'), date: c.find('meeting date'), fathom: c.find('fathom link'),
    recap: c.find('mtg recap'), hwAssigned: c.find('homework assigned'),
    g1: c.find('loe 1 - goal'), s1: c.find('loe 1 - status'), p1: c.find('loe 1 - progress'),
    g2: c.find('loe 2 - goal'), s2: c.find('loe 2 - status'), p2: c.find('loe 2 - progress'),
    g3: c.find('loe 3 - goal'), s3: c.find('loe 3 - status'), p3: c.find('loe 3 - progress'),
    overallProgress: c.find('overall progress'), priorHwDone: c.find('prior homework done'),
    status: c.find('processing status'),
  }
  const dataRows = rows.slice(2)
  const sessions = []
  for (const row of dataRows) {
    // Stop at the first fully-blank row — protects against trailing
    // notes/instructions further down the sheet (a real bug caught in
    // the original workbook's Managers tab — same defense here).
    if (row.every((v) => str(v) === '')) break
    const name = str(row[i.name])
    if (!name) continue
    const idx = sessions.length
    const hwAssigned = str(row[i.hwAssigned])
    const overallPct = toProgressPct(row[i.overallProgress])
    sessions.push({
      row: idx + 3,
      manager: name,
      date: toDateStr(row[i.date]),
      fathomUrl: str(row[i.fathom]) || null,
      recap: str(row[i.recap]),
      lastHomework: hwAssigned,
      lastHomeworkItems: hwAssigned ? hwAssigned.split(/\r?\n|;\s*/).map((s) => s.trim()).filter(Boolean) : [],
      hwCompletion: strKeepNA(row[i.priorHwDone]),
      loes: [
        { n: 1, goal: str(row[i.g1]), status: str(row[i.s1]), notes: '', progress: toProgressPct(row[i.p1]) },
        { n: 2, goal: str(row[i.g2]), status: str(row[i.s2]), notes: '', progress: toProgressPct(row[i.p2]) },
        { n: 3, goal: str(row[i.g3]), status: str(row[i.s3]), notes: '', progress: toProgressPct(row[i.p3]) },
      ].filter((l) => l.goal || l.status || l.progress != null),
      overallProgress: overallPct,
      // "Tim Overall Comment" no longer exists in this template — surface
      // the sheet's own computed Overall Progress instead of leaving this
      // UI slot blank for every manager.
      overallComment: overallPct != null ? `Overall progress: ${overallPct}%` : '',
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
    // Same stop-at-first-blank-row rule — catches trailing footnotes
    // even if column A still has text (caught a real bug here before).
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

// Combines the two sheets into the JSON shape CoachingDashboard.jsx
// expects (managers[] with sessions[]/latest, pendingProcessing count).
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
    source: 'Coaching_Dashboard_Data_UPDATED.xlsx (live via SharePoint)',
    generatedAt: new Date().toISOString(),
    pendingProcessing,
    managers: outManagers,
  }
}

// --------------------------------------------------------------------------
exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' }
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SharePoint env vars not set' }) }
  if (!process.env.SHAREPOINT_COACHING_DRIVE_ID && !SHARE_URL) {
    return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'SHAREPOINT_COACHING_DRIVE_ID/ITEM_ID (or SHAREPOINT_COACHING_URL) not set' }) }
  }

  try {
    const token = await getToken()
    const { driveId, itemId } = await getDriveRef(token)
    const logBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(SHEET_LOG)}`
    const mgrBase = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(SHEET_MANAGERS)}`

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}')

      if (body.action === 'append') {
        // New session row. fields is an object keyed like LOG_FIELD_COLS
        // (managerName, meetingDate, fathomLink, recap, homeworkAssigned,
        // g1/s1/p1, g2/s2/p2, g3/s3/p3, priorHomeworkDone, processingStatus).
        const fields = body.fields || {}
        if (!fields.managerName) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'fields.managerName required' }) }
        const used = await graph(`${logBase}/usedRange`, token)
        const nextRow = (used.rowCount || 2) + 1
        await Promise.all(
          Object.entries(fields)
            .filter(([f]) => LOG_FIELD_COLS[f])
            .map(([f, v]) => graph(`${logBase}/range(address='${LOG_FIELD_COLS[f]}${nextRow}')`, token, 'PATCH', { values: [[v ?? '']] }))
        )
        return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, rowIndex: nextRow }) }
      }

      // Default: update specific fields on an existing row (e.g. Claude
      // filling in a Fathom-processed session and flipping Processing
      // Status to 'Processed').
      const { rowIndex, fields } = body
      if (!rowIndex || !fields) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'rowIndex and fields required (or action:"append" with fields.managerName)' }) }
      await Promise.all(
        Object.entries(fields)
          .filter(([f]) => LOG_FIELD_COLS[f])
          .map(([f, v]) => graph(`${logBase}/range(address='${LOG_FIELD_COLS[f]}${rowIndex}')`, token, 'PATCH', { values: [[v ?? '']] }))
      )
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, updated: Object.keys(fields), rowIndex }) }
    }

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
