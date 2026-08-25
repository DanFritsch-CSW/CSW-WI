'use strict'

// MotherDuck backend for the Scorecard Draft Creator feature — added
// 2026-08-06. Computes ONE customer's weekly OTT (2hr v2 / 3hr all),
// Carrier % On-Time Arrival, Case Pick Accuracy (optional), and a
// day-by-day breakdown, scoped by MotherDuck project_name instead of the
// Manager tab's quarter/facility-wide scope.
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
// CARRIER % ON-TIME ARRIVAL (added 2026-08-06) — see prior header
// revisions for the full story. Computed from the same arrival_status
// bucketing as OTT: on-time % = (On Time + Early) / (On Time + Early +
// Late), excluding rows with no check-in data from both sides.
//
// Case Pick Accuracy reuses the identical formula from
// motherduck-case-pick-accuracy.cjs — no facility/customer filter needed,
// that table is already ~100% Bernatello's-WR by real data distribution.
//
// DAY-BY-DAY BREAKDOWN (added 2026-08-25, "Option B" coverage-check
// follow-through) — Dan supplied the ACTUAL Omni SQL for the "CSW
// Performance (Last Week by Day)" tile on Grassland's real dashboard.
// Translated directly from that query (OMNI_DATE → CAST AS DATE,
// OMNI_DATETIME_LITERAL/INTERVAL_ADD → the same previousWeekBounds() this
// file already computes, GROUP BY the scheduled date). Two things this
// broke out, both flagged to Dan rather than silently resolved:
//
// 1. Omni's real query filters by `owner_name = 'GRASSLAND DAIRY
//    PRODUCTS, INC'` PLUS three exact project_name patterns (Sam's -
//    Cooler / WM - Cooler / WM - Frozen, all CSW-Madison) — tighter than
//    this function's existing generic `project_name_contains` filter,
//    which has no owner_name check at all. NOT changed here — hardcoding
//    Grassland's exact strings into a function every customer shares
//    would break the "any customer, generic filter" design this whole
//    feature relies on. This means the day-by-day numbers below use the
//    SAME filter as every other metric in this response, not Omni's
//    tighter one — worth deciding separately whether to add an optional
//    owner_name filter to customer_scorecard_config for all metrics, not
//    just this one.
// 2. Omni's real query windows by `scheduled_arrival`, not `completed_on`
//    — the OTHER metrics in this function (OTT, Carrier %) window by
//    completed_on. Kept scheduled_arrival for THIS query specifically
//    (day-grouping is inherently about which day a load was scheduled;
//    windowing it by a different date entirely would produce a breakdown
//    that plausibly wouldn't match the dashboard at all), but this means
//    dailyBreakdown's total across all days will NOT necessarily equal
//    totalCompletedAppointments above, if any appointments' scheduled and
//    completed weeks differ. Not fixed — surfaced so it isn't mistaken
//    for a bug if the numbers don't add up to the same total.
//
// Also incorporates one filter detail from Omni's real SQL not previously
// applied elsewhere in this file: `checked_in_on IS NOT NULL` as an
// explicit top-level filter (Omni's dashboard tile excludes never-
// checked-in appointments from the day-by-day view entirely, rather than
// just letting them fall out of the percentage denominators).
//
// Week window: previous COMPLETE Monday–Sunday week, Central time —
// matches the cadence Omni actually sends these on (Monday ~1am Central)
// and every other weekly construct in this app (Weekly Labor Overview,
// etc.).
//
// ROUNDING (fixed 2026-08-06): OTT (2hr, 3hr) AND Carrier % On-Time
// Arrival round to the nearest WHOLE number, matching Omni's own
// dashboard display. Case Pick Accuracy rounds to the nearest 0.1%.
// dailyBreakdown's per-day percentages use the same whole-number
// rounding, for visual consistency with the weekly aggregates.
//
// LIVE-VERIFIED 2026-08-06: first real end-to-end test succeeded — real
// Front draft created, numbers pulled correctly, Claude wrote a real
// narrative. That test surfaced the missing Carrier % metric.
// dailyBreakdown itself is NOT yet live-verified as of this commit.

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
        COUNT(*) - COUNT(CASE WHEN notes ILIKE '%driver not ready%' AND turn_hours >= 3 THEN 1 END) AS ott3_denom,
        COUNT(CASE WHEN arrival_status IN ('On Time','Early') THEN 1 END) AS carrier_ontime_num,
        COUNT(CASE WHEN arrival_status IS NOT NULL THEN 1 END) AS carrier_ontime_denom
      FROM final
    `

    const ottRows = await runQuery(ottSql)
    const r = ottRows[0] || {}
    const ott2Denom = num(r.ott2_denom)
    const ott3Denom = num(r.ott3_denom)
    const ott2Pct = ott2Denom > 0 ? (num(r.ott2_num) / ott2Denom) * 100 : null
    const ott3Pct = ott3Denom > 0 ? (num(r.ott3_num) / ott3Denom) * 100 : null
    const carrierOntimeDenom = num(r.carrier_ontime_denom)
    const carrierOntimePct = carrierOntimeDenom > 0 ? (num(r.carrier_ontime_num) / carrierOntimeDenom) * 100 : null

    // Day-by-day breakdown — see file header for the full translation
    // story from Omni's real "CSW Performance (Last Week by Day)" SQL.
    // Windowed and grouped by scheduled_arrival (not completed_on) since
    // day-grouping is inherently about the scheduled date; includes the
    // `checked_in_on IS NOT NULL` filter Omni's real query has at the top
    // level, matching that tile's real behavior (never-checked-in
    // appointments don't appear in the day-by-day view at all).
    const dailySql = `
      WITH base AS (
        SELECT
          scheduled_arrival, checked_in_on, completed_on, "Notes" AS notes,
          CAST(scheduled_arrival AS DATE) AS scheduled_date,
          CASE
            WHEN checked_in_on < scheduled_arrival THEN scheduled_arrival
            ELSE checked_in_on
          END AS effective_start
        FROM production_db.gold.truck_appointments
        WHERE warehouse_name = '${esc(warehouseName)}'
          AND project_name ILIKE '%${esc(projectNameContains)}%'
          AND checked_in_on IS NOT NULL
          AND dock_status_name = 'Completed'
          AND dock_appointment_type_name IN (${typesSql})
          AND scheduled_arrival >= TIMESTAMP '${weekStart}'
          AND scheduled_arrival <  TIMESTAMP '${weekEndExclusive}'
      ),
      calc AS (
        SELECT
          *,
          DATE_DIFF('second', effective_start, completed_on) / 3600.0 AS turn_hours,
          CASE
            WHEN DATE_DIFF('second', scheduled_arrival, checked_in_on) BETWEEN 0 AND 900 THEN 'On Time'
            WHEN checked_in_on < scheduled_arrival THEN 'Early'
            WHEN DATE_DIFF('second', scheduled_arrival, checked_in_on) > 900 THEN 'Late'
            ELSE NULL
          END AS arrival_status
        FROM base
      ),
      final AS (
        SELECT
          *,
          CASE
            WHEN LOWER(arrival_status) = 'late' THEN 'Completed Within Target'
            WHEN ROUND(turn_hours, 2) <= 2 THEN 'Completed Within Target'
            ELSE 'Delayed'
          END AS delivery_status_2hr,
          CASE WHEN turn_hours <= 3 THEN 1 ELSE 0 END AS under_3_hours_
        FROM calc
      )
      SELECT
        scheduled_date,
        COUNT(*) AS total,
        COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') AND delivery_status_2hr = 'Completed Within Target' THEN 1 END) AS ott2_num,
        COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') THEN 1 END)
          - COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') AND notes ILIKE '%driver not ready%' AND turn_hours >= 2 THEN 1 END) AS ott2_denom,
        SUM(under_3_hours_) AS ott3_num,
        COUNT(*) - COUNT(CASE WHEN notes ILIKE '%driver not ready%' AND turn_hours >= 3 THEN 1 END) AS ott3_denom
      FROM final
      GROUP BY scheduled_date
      ORDER BY scheduled_date ASC
    `

    const dailyRows = await runQuery(dailySql)
    const dailyBreakdown = dailyRows.map((row) => {
      const d2 = num(row.ott2_denom)
      const d3 = num(row.ott3_denom)
      const p2 = d2 > 0 ? (num(row.ott2_num) / d2) * 100 : null
      const p3 = d3 > 0 ? (num(row.ott3_num) / d3) * 100 : null
      return {
        date: row.scheduled_date instanceof Date ? row.scheduled_date.toISOString().slice(0, 10) : String(row.scheduled_date),
        total: num(row.total),
        ott2Pct: p2 == null ? null : Math.round(p2),
        ott3Pct: p3 == null ? null : Math.round(p3),
      }
    })

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
        // Rounded to nearest 0.1% per Dan's ask (2026-08-06) — matches
        // Omni's own dashboard display rounding.
        pct: pct == null ? null : Math.round(pct * 10) / 10,
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
        // Rounded to nearest WHOLE number per Dan's ask (2026-08-06) —
        // matches Omni's own dashboard display rounding (e.g. 97.53% -> 98%).
        ott2: { pct: ott2Pct == null ? null : Math.round(ott2Pct), numerator: num(r.ott2_num), denominator: ott2Denom },
        ott3: { pct: ott3Pct == null ? null : Math.round(ott3Pct), numerator: num(r.ott3_num), denominator: ott3Denom },
        // Carrier % On-Time Arrival — added 2026-08-06, see file header for
        // formula/validation notes. Same whole-number rounding as OTT.
        carrierOnTime: {
          pct: carrierOntimePct == null ? null : Math.round(carrierOntimePct),
          numerator: num(r.carrier_ontime_num),
          denominator: carrierOntimeDenom,
        },
        casePickAccuracy,
        // Day-by-day breakdown — see file header for the real Omni SQL
        // this was translated from, and the two flagged filter/windowing
        // discrepancies vs. the rest of this function's metrics.
        dailyBreakdown,
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
