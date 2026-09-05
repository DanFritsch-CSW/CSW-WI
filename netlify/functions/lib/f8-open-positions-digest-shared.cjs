'use strict'

// Shared core for the F8 Open Positions morning digest -- added
// 2026-09-04, per Dan's follow-up ask to auto-send the F8 Open Positions
// count to a Front conversation on a schedule, same as every other
// Madison sub-tab (JDF Putaways, DPI Pickline's pending equivalent).
// Same scheduled/manual-test split as every other digest in this app
// (Netlify blocks direct HTTP invocation of any function carrying a
// `schedule` in netlify.toml -- see lib/fefo-digest-shared.cjs's header
// for the full story/repro). f8-open-positions-digest-run.cjs carries the
// schedule and only handles the cron tick; f8-open-positions-digest-
// test.cjs has no schedule and handles "Send test digest now".
//
// One settings row: facility='mad', dashboard_type='f8_open_positions' in
// prepick_notify_settings, driven by NotifySettingsPanel on the F8 Open
// Positions tab (same shared panel every other digest in this app uses).
//
// Content date: TODAY (Central) -- this is a live snapshot check ("how
// many open positions right now"), not a forecast with lead time to look
// ahead across, same reasoning as FEFO's and EXP Check's own digests.
//
// Runs its OWN independent MotherDuck query rather than calling
// motherduck-f8-open-positions.cjs over HTTP, following this app's
// established "self-contained port" convention for server-side digests
// (see weekly-labor-digest-shared.cjs's header for the precedent). The
// classification logic (Empty=2 open, 1 LP=1 open, else 0) is copied
// verbatim from that function so the digest number can't drift from the
// on-screen number even though the query is duplicated here.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN

const FACILITY = 'mad'
const DASHBOARD_TYPE = 'f8_open_positions'
const MADISON_WAREHOUSE_NAME = 'CSW-Madison'
const AISLES = ['F8B', 'F8C', 'F8D', 'F8E']
const APP_URL = 'https://csw-wi.netlify.app'

const OPEN_POSITIONS_SQL = `
  WITH wh AS (
    SELECT warehouse_id
    FROM production_db.silver.datex_slv_warehouses
    WHERE warehouse_name = '${MADISON_WAREHOUSE_NAME}'
  ),
  locs AS (
    SELECT
      loc.location_container_id,
      loc.location_container_name,
      substr(loc.location_container_name, 1, 3) AS aisle
    FROM production_db.silver.datex_slv_locationcontainers loc
    JOIN wh ON loc.warehouse_id = wh.warehouse_id
    WHERE loc.location_container_name LIKE 'F8B%'
       OR loc.location_container_name LIKE 'F8C%'
       OR loc.location_container_name LIKE 'F8D%'
       OR loc.location_container_name LIKE 'F8E%'
  ),
  lp_counts AS (
    SELECT
      locs.location_container_id,
      count(DISTINCT lp.license_plate_id) AS lp_count
    FROM locs
    LEFT JOIN production_db.silver.datex_slv_licenseplates lp
      ON lp.location_id = locs.location_container_id
     AND (lp.Archived IS NULL OR lp.Archived = false)
    GROUP BY locs.location_container_id
  )
  SELECT
    locs.aisle AS aisle,
    COALESCE(lp_counts.lp_count, 0) AS lp_count
  FROM locs
  LEFT JOIN lp_counts ON lp_counts.location_container_id = locs.location_container_id
`

function num(v) { return Number(v ?? 0) || 0 }

function openPositionsForCount(lpCount) {
  if (lpCount === 0) return 2
  if (lpCount === 1) return 1
  return 0
}

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
}

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTodayDateStr() {
  const { year, month, day } = centralNowParts()
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

function formatHeaderDate(dateStr) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const d = new Date(`${dateStr}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
}

async function runQuery() {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database(':memory:')
  const conn = db.connect()
  const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
  const runAll = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))

  try {
    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)
    return await runAll(OPEN_POSITIONS_SQL)
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

function summarize(rows) {
  const byAisle = {}
  for (const a of AISLES) byAisle[a] = { aisle: a, empty: 0, oneLp: 0, openPositions: 0 }
  for (const r of rows) {
    const aisle = r.aisle
    if (!byAisle[aisle]) continue
    const lpCount = num(r.lp_count)
    const open = openPositionsForCount(lpCount)
    if (lpCount === 0) byAisle[aisle].empty += 1
    if (lpCount === 1) byAisle[aisle].oneLp += 1
    byAisle[aisle].openPositions += open
  }
  const aisles = AISLES.map(a => byAisle[a])
  const totalOpenPositions = aisles.reduce((s, a) => s + a.openPositions, 0)
  return { aisles, totalOpenPositions }
}

function buildDigestBody(aisles, totalOpenPositions, today) {
  const lines = []
  lines.push('F8 Open Positions — Madison')
  lines.push(APP_URL)
  lines.push('CSW Operations Hub — Madison → F8 Open Positions')
  lines.push(`As of: ${formatHeaderDate(today)}`)
  lines.push('')
  for (const a of aisles) {
    lines.push(`${a.aisle}: ${a.openPositions} open (${a.empty} empty · ${a.oneLp} 1 LP)`)
  }
  lines.push('')
  lines.push(`Total F8 Open: ${totalOpenPositions}`)
  return lines.join('\n')
}

async function frontPostComment(conversationId, body) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw Object.assign(new Error('Front comment failed'), { detail: json })
  return json
}

async function runDigest({ settingsRow, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for f8_open_positions' }
  }
  const today = centralTodayDateStr()
  const rows = await runQuery()
  const { aisles, totalOpenPositions } = summarize(rows)
  const body = buildDigestBody(aisles, totalOpenPositions, today)

  const posted = await frontPostComment(conversationId, body)

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}`, { last_sent_date: today })
  }

  return { ok: true, date: today, conversationId, commentId: posted.id, totalOpenPositions }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  FACILITY, DASHBOARD_TYPE,
  sbFetch, sbPatch,
  centralTodayDateStr, isNotifyTimeMatch,
  runDigest,
}
