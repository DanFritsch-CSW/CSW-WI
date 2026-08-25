'use strict'

// Shared core for the DPI Putaway Scorecard daily digest — duplicated from
// jdf-scorecard-digest-shared.cjs on 2026-08-25 (see motherduck-dpi-
// putaways.cjs's header for the three scope decisions Dan confirmed before
// this was built: F5+F8 only, receipt-date instead of parsed mfg date,
// zone-qualified aisle keys). Same scheduled/manual-test split as every
// other digest in this app.
//
// One settings row: facility='mad', dashboard_type='dpi_putaway_scorecard'
// in prepick_notify_settings, driven by NotifySettingsPanel on the DPI
// Putaways tab.
//
// SCOPE NOTE: unlike the JDF version, this digest does NOT attach a
// per-employee move-report PDF (jdf-employee-report-shared.cjs's PDF
// pipeline was left out of this first pass to keep the change reviewable —
// see the chat where this was built). Straightforward to add later by
// porting that module the same way if Dan wants it.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN

const FACILITY = 'mad'
const DASHBOARD_TYPE = 'dpi_putaway_scorecard'
const DPI_PROJECT_ID = 122
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=dpi-putaways'

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
  if (!res.ok) { throw new Error(await res.text()) }
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

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0 }

async function runQueries(today) {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database(':memory:')
  const conn = db.connect()
  const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
  const runQuery = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))

  try {
    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)
    await exec(`
      CREATE TEMP TABLE onhand AS
      SELECT
        loc.location_container_name AS location,
        lp.license_plate_id,
        CAST(lp.created_sys_date_time AS DATE) AS created_date,
        m.material_id,
        p.project_id,
        CAST(lot.receive_date AS DATE) AS recv_date
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
      JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
      JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
      WHERE (loc.location_container_name LIKE 'F5%' OR loc.location_container_name LIKE 'F8%')
        AND (lp.Archived IS NULL OR lp.Archived = false)
    `)
    await exec(`
      CREATE TEMP TABLE loc_class AS
      SELECT
        location,
        count(distinct material_id) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS distinct_materials,
        count(distinct recv_date) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS distinct_recv_dates
      FROM onhand
      GROUP BY location
    `)
    const [dailyRows, buildingRows, receivedRows] = await Promise.all([
      runQuery(`
        SELECT
          count(distinct o.license_plate_id) AS put_away,
          count(distinct CASE WHEN lc.distinct_materials <= 1 THEN o.license_plate_id END) AS same_item_tier,
          count(distinct CASE WHEN lc.distinct_materials <= 1 AND lc.distinct_recv_dates <= 1 THEN o.license_plate_id END) AS same_item_tier_recv_date
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${DPI_PROJECT_ID}
          AND o.created_date = DATE '${today}'
      `),
      runQuery(`
        SELECT
          count(distinct o.license_plate_id) AS total_active,
          count(distinct CASE WHEN lc.distinct_materials <= 1 THEN o.license_plate_id END) AS same_item_tier,
          count(distinct CASE WHEN lc.distinct_materials <= 1 AND lc.distinct_recv_dates <= 1 THEN o.license_plate_id END) AS same_item_tier_recv_date
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${DPI_PROJECT_ID}
      `),
      runQuery(`
        SELECT count(distinct lpc.license_plate_id) AS total_received
        FROM production_db.silver.datex_slv_licenseplates lp
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
        JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
        JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
        WHERE m.project_id = ${DPI_PROJECT_ID}
          AND lp.warehouse_id = 4
          AND CAST(lp.created_sys_date_time AS DATE) = DATE '${today}'
          AND (lp.Archived IS NULL OR lp.Archived = false)
      `),
    ])
    return { daily: dailyRows[0] || {}, building: buildingRows[0] || {}, received: receivedRows[0] || {} }
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

function buildDigestBody(daily, building, received, today) {
  const num = v => Number(v ?? 0) || 0
  const totalReceived = num(received.total_received)
  const putAway = num(daily.put_away)
  const d = {
    totalReceived,
    putAway,
    stillStaged: Math.max(totalReceived - putAway, 0),
    sameItemTier: num(daily.same_item_tier),
    sameItemTierRecvDate: num(daily.same_item_tier_recv_date),
  }
  const b = {
    totalActive: num(building.total_active),
    sameItemTier: num(building.same_item_tier),
    sameItemTierRecvDate: num(building.same_item_tier_recv_date),
  }

  const lines = []
  lines.push('DPI Putaways — Daily Scorecard')
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`Today: ${formatHeaderDate(today)}`)
  lines.push('')
  if (d.totalReceived === 0) {
    lines.push('No DPI pallets received in F5/F8 today yet.')
  } else {
    lines.push(`${d.totalReceived} pallet${d.totalReceived === 1 ? '' : 's'} received, ${d.putAway} put away`)
    if (d.stillStaged > 0) lines.push(`Still in receiving/staging: ${d.stillStaged}`)
    lines.push(`Same item, same tier: ${d.sameItemTier} (${pct(d.sameItemTier, d.putAway)}%)`)
    lines.push(`Also same receipt date: ${d.sameItemTierRecvDate} (${pct(d.sameItemTierRecvDate, d.putAway)}%)`)
    lines.push(`Mixed: ${d.putAway - d.sameItemTier} (${pct(d.putAway - d.sameItemTier, d.putAway)}%)`)
  }
  lines.push('')
  lines.push('─'.repeat(28))
  lines.push('Building-Wide Baseline (F5/F8, all dates)')
  lines.push('─'.repeat(28))
  lines.push(`Total active pallets: ${b.totalActive}`)
  lines.push(`Same item, same tier: ${b.sameItemTier} (${pct(b.sameItemTier, b.totalActive)}%)`)
  lines.push(`Also same receipt date: ${b.sameItemTierRecvDate} (${pct(b.sameItemTierRecvDate, b.totalActive)}%)`)
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
    return { ok: false, reason: 'No front_conversation_id configured for dpi_putaway_scorecard' }
  }
  const today = centralTodayDateStr()
  const { daily, building, received } = await runQueries(today)
  const body = buildDigestBody(daily, building, received, today)
  const posted = await frontPostComment(conversationId, body)

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}`, { last_sent_date: today })
  }

  return { ok: true, date: today, conversationId, commentId: posted.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  FACILITY, DASHBOARD_TYPE,
  sbFetch, sbPatch,
  centralTodayDateStr, isNotifyTimeMatch,
  runDigest,
}
