'use strict'

// MotherDuck backend for the Scorecard Draft Creator feature — added
// 2026-08-06. Computes ONE customer's weekly OTT (2hr v2 / 3hr all) and,
// optionally, Case Pick Accuracy, scoped by MotherDuck project_name
// instead of the Manager tab's quarter/facility-wide scope.
//
// Deliberately a SEPARATE function from motherduck-ott.cjs and
// motherduck-case-pick-accuracy.cjs rather than an extra mode bolted onto
// either — same reasoning as motherduck-takt-daily.cjs being kept
// separate from motherduck-takt.cjs: this new caller can't regress an
// already-shipped, extensively-validated bonus-scorecard metric.
//
// OTT formula is the EXACT CTE from motherduck-ott.cjs (2hr v2 / 3hr all,
// effective_start / arrival_status / delivery_status logic), with one
// addition: a project_name ILIKE filter, since a customer's scorecard
// needs THEIR OTT, not the whole facility's. Confirmed live via Omni's
// gold__truck_appointments topic (2026-08-05) that project_name is a real,
// filterable field here: Bernatello's-WR outbound last week came back
// 97.5%/100% over 94 completed appts via Omni's own natural-language
// query, close to Andrew Young's actually-reported 98%/100% for the same
// week (small gap consistent with Omni's fuzzy "last week" window vs. an
// exact Mon-Sun boundary — this function uses the exact boundary).
//
// Case Pick Accuracy reuses the identical formula from
// motherduck-case-pick-accuracy.cjs (SUM(expected_scans) −
// SUM(ABS(discrepancy)), over SUM(expected_scans), from
// audit_app.shipment_container_discrepancies) — that table has no
// facility/customer column and is already ~100% Bernatello's-WR by real
// data distribution (confirmed in that function's own header), so no
// additional filter is applied here; this is the same query, just
// re-windowed to a week instead of a quarter.
//
// Week window: previous COMPLETE Monday–Sunday week, Central time —
// matches the cadence Omni actually sends these on (Monday ~1am Central)
// and every other weekly construct in this app (Weekly Labor Overview,
// etc.).
//
// NOT YET LIVE-VERIFIED end-to-end from this function specifically (the
// underlying formulas are validated; the project_name-filtered/weekly-
// windowed combination here has only been checked via Omni's natural-
// language layer, not by running this exact generated SQL against
// MotherDuck directly). Run "Send test draft now" before trusting this
// blindly for a real customer send.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const OUTBOUND_TYPES = ["Outbound", "Outbound/Drop", "Outbound/Lump", "Outbound/Reload", "Outbound/Work-In"]

function num(v) { return v == null ? null : Number(v) }

function esc(s) { return String(s).replace(/'/g, "''") }

// Previous complete Mon–Sun week, Central time, as [startISODate, endISODateExclusive].
function previousWeekBounds() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  const todayCentral = new Date(Date.UTC(get('year'), get('month') - 1, get('day')))
  const dow = todayCentral.getUTCDay() // 0=Sun..6=Sat
  const daysSinceMonday = dow === 0 ? 6 : dow - 1
  const thisMonday = new Date(todayCentral)
  thisMonday.setUTCDate(thisMonday.getUTCDate() - daysSinceMonday)
  const lastMonday = new Date(thisMonday)
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7)
  const fmt = (d) => d.toISOString().slice(0, 10)
  return [fmt(lastMonday), fmt(thisMonday)]
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

  let projectNameContains, warehouseName, includeCasePickAccuracy
  try {
    ;({ projectNameContains, warehouseName, includeCasePickAccuracy } = JSON.parse(event.body || '{}'))
    if (!projectNameContains) throw new Error('projectNameContains is required')
    if (!warehouseName) throw new Error('warehouseName is required')
  } catch (e) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Body must be { projectNameContains, warehouseName, includeCasePickAccuracy? } — ${e.message}` }),
    }
  }

  const [weekStart, weekEndExclusive] = previousWeekBounds()

  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  let conn, db
  try {
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
    const runQuery = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const typesSql = OUTBOUND_TYPES.map((t) => `'${t}'`).join(',')

    const ottSql = `
      WITH base AS (
        SELECT
          scheduled_arrival, checked_in_on, completed_on, "Notes" AS notes,
          CASE
            WHEN checked_in_on IS NULL THEN scheduled_arrival
            WHEN checked_in_on < scheduled_arrival THEN scheduled_arrival
            ELSE checked_in_on
          END AS effective_start
        FROM production_db.gold.truck_appointments
        WHERE warehouse_name = '${esc(warehouseName)}'
          AND project_name ILIKE '%${esc(projectNameContains)}%'
          AND dock_status_name = 'Completed'
          AND dock_appointment_type_name IN (${typesSql})
          AND completed_on >= TIMESTAMP '${weekStart}'
          AND completed_on <  TIMESTAMP '${weekEndExclusive}'
      ),
      calc AS (
        SELECT
          *,
          DATE_DIFF('second', effective_start, completed_on) / 3600.0 AS turn_hours,
          CASE
            WHEN checked_in_on IS NOT NULL AND scheduled_arrival IS NOT NULL
                 AND DATE_DIFF('second', scheduled_arrival, checked_in_on) BETWEEN 0 AND 900 THEN 'On Time'
            WHEN checked_in_on IS NOT NULL AND scheduled_arrival IS NOT NULL
                 AND checked_in_on < scheduled_arrival THEN 'Early'
            WHEN checked_in_on IS NOT NULL AND scheduled_arrival IS NOT NULL
                 AND DATE_DIFF('second', scheduled_arrival, checked_in_on) > 900 THEN 'Late'
            ELSE NULL
          END AS arrival_status
        FROM base
      ),
      final AS (
        SELECT
          *,
          CASE
            WHEN LOWER(arrival_status) IN ('late') THEN 'Completed Within Target'
            WHEN ROUND(turn_hours, 2) <= 2 THEN 'Completed Within Target'
            ELSE 'Delayed'
          END AS delivery_status_2hr,
          CASE WHEN turn_hours <= 3 THEN 1 ELSE 0 END AS under_3_hours_
        FROM calc
      )
      SELECT
        COUNT(*) AS total_completed,
        COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') AND delivery_status_2hr = 'Completed Within Target' THEN 1 END) AS ott2_num,
        COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') THEN 1 END)
          - COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') AND notes ILIKE '%driver not ready%' AND turn_hours >= 2 THEN 1 END) AS ott2_denom,
        SUM(under_3_hours_) AS ott3_num,
        COUNT(*) - COUNT(CASE WHEN notes ILIKE '%driver not ready%' AND turn_hours >= 3 THEN 1 END) AS ott3_denom
      FROM final
    `

    const ottRows = await runQuery(ottSql)
    const r = ottRows[0] || {}
    const ott2Denom = num(r.ott2_denom)
    const ott3Denom = num(r.ott3_denom)
    const ott2Pct = ott2Denom > 0 ? (num(r.ott2_num) / ott2Denom) * 100 : null
    const ott3Pct = ott3Denom > 0 ? (num(r.ott3_num) / ott3Denom) * 100 : null

    let casePickAccuracy = null
    if (includeCasePickAccuracy) {
      const cpaSql = `
        SELECT
          COUNT(DISTINCT shipment_container_id) AS containers,
          SUM(expected_scans) AS expected_sum,
          SUM(ABS(discrepancy)) AS abs_discrepancy_sum
        FROM production_db.audit_app.shipment_container_discrepancies
        WHERE created_timestamp_fallback >= TIMESTAMP '${weekStart}'
          AND created_timestamp_fallback <  TIMESTAMP '${weekEndExclusive}'
      `
      const cpaRows = await runQuery(cpaSql)
      const c = cpaRows[0] || {}
      const expectedSum = num(c.expected_sum)
      const absDiscrepancySum = num(c.abs_discrepancy_sum)
      const pct = expectedSum > 0 ? ((expectedSum - absDiscrepancySum) / expectedSum) * 100 : null
      casePickAccuracy = {
        pct: pct == null ? null : Math.round(pct * 100) / 100,
        containers: num(c.containers),
        expectedScans: expectedSum,
        absoluteDiscrepancy: absDiscrepancySum,
      }
    }

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        projectNameContains, warehouseName, weekStart, weekEndExclusive,
        totalCompletedAppointments: num(r.total_completed),
        ott2: { pct: ott2Pct == null ? null : Math.round(ott2Pct * 100) / 100, numerator: num(r.ott2_num), denominator: ott2Denom },
        ott3: { pct: ott3Pct == null ? null : Math.round(ott3Pct * 100) / 100, numerator: num(r.ott3_num), denominator: ott3Denom },
        casePickAccuracy,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), projectNameContains, warehouseName, elapsedMs: Date.now() - t0 }),
    }
  }
}
