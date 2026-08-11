'use strict'

// Shared core for the JDF Putaway Scorecard daily digest — added 2026-08-11.
// Same scheduled/manual-test split as every other digest in this app
// (Netlify blocks direct HTTP invocation of any function carrying a
// `schedule` in netlify.toml — see lib/fefo-digest-shared.cjs's header for
// the full story/repro). jdf-scorecard-digest-run.cjs carries the schedule
// and only handles the cron tick; jdf-scorecard-digest-test.cjs has no
// schedule and handles "Send test digest now".
//
// One settings row: facility='mad', dashboard_type='jdf_putaway_scorecard'
// in prepick_notify_settings, driven by NotifySettingsPanel on the JDF
// Putaways tab (same shared panel every other digest in this app uses —
// M-F day toggles, configurable send time, Enabled checkbox, all already
// built in, nothing new needed there).
//
// Content date: same "yesterday, Central time" resolution as
// motherduck-jdf-putaways.cjs's Daily Putaway Scorecard block (this module
// runs its OWN independent MotherDuck query rather than calling that
// function over HTTP, following this app's established "self-contained
// port" convention for server-side digests — see weekly-labor-digest-
// shared.cjs's header for the precedent). The two are the same underlying
// classification (loc_class: distinct_materials/distinct_mfg_dates per
// location, JDF-only, F8-scoped) so the digest number and the on-screen
// number can't drift apart even though the query is duplicated here.
//
// No skip-to-next-valid-day concept: unlike the appointment-based digests
// (Pre-Pick, Cases, Daily Ops) which look FORWARD to tomorrow and can skip
// a night if tomorrow isn't a checked day, this digest always looks
// BACKWARD exactly one day from whatever day it fires on. There's no
// "next valid day" to jump to — see NotifySettingsPanel's
// showSkipToNextValidDay=false on this tab, same as FEFO.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN

const FACILITY = 'mad'
const DASHBOARD_TYPE = 'jdf_putaway_scorecard'
const JDF_PROJECT_ID = 365
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=jdf-putaways'

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
  if (!res.ok) { const t = await res.text(); throw new Error(await res.text()) }
}

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralYesterdayDateStr() {
  const { year, month, day } = centralNowParts()
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
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

// runQueries — one self-contained MotherDuck connection covering both the
// daily cohort and the building-wide baseline, mirroring the exact
// classification query in motherduck-jdf-putaways.cjs's 2026-08-11 addition.
async function runQueries(yesterday) {
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
        TRY_CAST(('20'||substr(lot.lookup_code,2,2)||'-'||substr(lot.lookup_code,4,2)||'-'||substr(lot.lookup_code,6,2)) AS DATE) AS mfg_date
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
      JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
      JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
      WHERE loc.location_container_name LIKE 'F8%'
        AND (lp.Archived IS NULL OR lp.Archived = false)
    `)
    await exec(`
      CREATE TEMP TABLE loc_class AS
      SELECT
        location,
        count(distinct material_id) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS distinct_materials,
        count(distinct mfg_date) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS distinct_mfg_dates
      FROM onhand
      GROUP BY location
    `)
    const [dailyRows, buildingRows] = await Promise.all([
      runQuery(`
        SELECT
          count(distinct o.license_plate_id) AS put_away,
          count(distinct CASE WHEN lc.distinct_materials <= 1 THEN o.license_plate_id END) AS same_item_tier,
          count(distinct CASE WHEN lc.distinct_materials <= 1 AND lc.distinct_mfg_dates <= 1 THEN o.license_plate_id END) AS same_item_tier_date
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${JDF_PROJECT_ID}
          AND o.created_date = DATE '${yesterday}'
      `),
      runQuery(`
        SELECT
          count(distinct o.license_plate_id) AS total_active,
          count(distinct CASE WHEN lc.distinct_materials <= 1 THEN o.license_plate_id END) AS same_item_tier,
          count(distinct CASE WHEN lc.distinct_materials <= 1 AND lc.distinct_mfg_dates <= 1 THEN o.license_plate_id END) AS same_item_tier_date
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${JDF_PROJECT_ID}
      `),
    ])
    return { daily: dailyRows[0] || {}, building: buildingRows[0] || {} }
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

function buildDigestBody(daily, building, yesterday) {
  const num = v => Number(v ?? 0) || 0
  const d = {
    putAway: num(daily.put_away),
    sameItemTier: num(daily.same_item_tier),
    sameItemTierDate: num(daily.same_item_tier_date),
  }
  const b = {
    totalActive: num(building.total_active),
    sameItemTier: num(building.same_item_tier),
    sameItemTierDate: num(building.same_item_tier_date),
  }

  const lines = []
  lines.push('JDF Putaways — Daily Scorecard')
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push(`Yesterday: ${formatHeaderDate(yesterday)}`)
  lines.push('')
  if (d.putAway === 0) {
    lines.push('No JDF pallets put away in F8 on that date.')
  } else {
    lines.push(`${d.putAway} pallet${d.putAway === 1 ? '' : 's'} put away`)
    lines.push(`Same item, same tier: ${d.sameItemTier} (${pct(d.sameItemTier, d.putAway)}%)`)
    lines.push(`Also same MAN date: ${d.sameItemTierDate} (${pct(d.sameItemTierDate, d.putAway)}%)`)
    lines.push(`Mixed: ${d.putAway - d.sameItemTier} (${pct(d.putAway - d.sameItemTier, d.putAway)}%)`)
  }
  lines.push('')
  lines.push('─'.repeat(28))
  lines.push('Building-Wide Baseline (all dates)')
  lines.push('─'.repeat(28))
  lines.push(`Total active pallets: ${b.totalActive}`)
  lines.push(`Same item, same tier: ${b.sameItemTier} (${pct(b.sameItemTier, b.totalActive)}%)`)
  lines.push(`Also same MAN date: ${b.sameItemTierDate} (${pct(b.sameItemTierDate, b.totalActive)}%)`)
  return lines.join('\n')
}

async function runDigest({ settingsRow, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for jdf_putaway_scorecard' }
  }
  const yesterday = centralYesterdayDateStr()
  const { daily, building } = await runQueries(yesterday)
  const body = buildDigestBody(daily, building, yesterday)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }
  if (!frontRes.ok) {
    return { ok: false, reason: 'Front API error posting comment', detail: frontJson }
  }

  if (!isManualTest) {
    await sbPatch(`prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}`, { last_sent_date: yesterday })
  }

  return { ok: true, date: yesterday, conversationId, commentId: frontJson.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  FACILITY, DASHBOARD_TYPE,
  sbFetch, sbPatch,
  centralYesterdayDateStr, isNotifyTimeMatch,
  runDigest,
}
