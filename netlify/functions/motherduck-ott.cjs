'use strict'

// MotherDuck backend for the Manager tab's OTT (On Time Truck) live pull.
// Added 2026-07-30. Replicates the EXACT calculation logic from Omni's
// gold__truck_appointments view (confirmed via Omni model introspection,
// not guessed — see Notion changelog 2026-07-30 for the full field-by-field
// writeup) for the two specific percentages Dan confirmed the team actually
// uses on their dashboards:
//   - OTT — 2 Hour: "Percent On Time - 2hr v2" — only judges Early/On-Time
//     arrivals against the 2hr turn-time threshold; Late and Work-in trucks
//     are excluded entirely from both numerator and denominator (not
//     penalized, not credited).
//   - OTT — 3 Hour: "Percent Under 3 Hrs All" — the only 3hr variant that
//     exists in the model (no v2 sibling for 3hr). Every completed
//     appointment counts; Late/Work-in trucks ARE judged against the
//     3hr threshold.
//
// This is a direct MotherDuck query, not proxied through Omni's API —
// every field needed (scheduled_arrival, checked_in_on, completed_on,
// dock_appointment_type_name, dock_status_name, Notes, warehouse_name)
// is a real column on gold.truck_appointments, so there's no need to
// round-trip through omni-query.cjs for this one.
//
// Field logic (verified against Omni's model definitions):
//   effective_start = scheduled_arrival IF checked_in_on IS NULL
//                                        OR checked_in_on < scheduled_arrival
//                    = checked_in_on OTHERWISE (early arrivals get no credit
//                      — the clock never starts before the appointment time)
//   turn_hours       = DATE_DIFF('second', effective_start, completed_on) / 3600.0
//   arrival_status   = 'Work-in' if dock_appointment_type_name contains
//                         'inbound/work-in' or 'outbound/work-in' (case-insens.)
//                     = 'On Time' if checked_in_on is 0-15 min after scheduled_arrival
//                     = 'Early' if checked_in_on < scheduled_arrival
//                     = 'Late' if checked_in_on is >15 min after scheduled_arrival
//                     = NULL otherwise (never checked in / no scheduled_arrival)
//   delivery_status  = 'Completed Within Target' if arrival_status IN ('Late','Work-in')
//                       (carrier's own lateness/work-in isn't held against the warehouse)
//                     = 'Completed Within Target' if ROUND(turn_hours,2) <= 2
//                     = 'Delayed' otherwise
//   under_3_hours_   = 1 if turn_hours <= 3 else 0
//
// Scope matches the Omni dashboard SQL Dan/Dean supplied 2026-07-30:
// dock_status_name = 'Completed', dock_appointment_type_name IN the 5
// Outbound variants, "driver not ready" notes at/over threshold excluded
// from the denominator (same as the live dashboard).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Facility → warehouse_name, confirmed live against gold.truck_appointments
// (warehouse_id 1/3/4/5/6 → Franksville/Eau Claire/Madison/Kenosha/WI Rapids,
// matching this project's standing MotherDuck warehouse ID map).
const WAREHOUSE_NAME = {
  cal: 'CSW-Franksville',
  ec:  'CSW-Eau Claire',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
}

const OUTBOUND_TYPES = ["Outbound", "Outbound/Drop", "Outbound/Lump", "Outbound/Reload", "Outbound/Work-In"]

function num(v) { return v == null ? null : Number(v) }

// 'YYYY-Qn' -> [startDateStr, endDateStrExclusive]
function quarterBounds(quarterStr) {
  const [yStr, qStr] = quarterStr.split('-Q')
  const y = Number(yStr)
  const q = Number(qStr)
  const startMonth = (q - 1) * 3 // 0-indexed
  const start = new Date(Date.UTC(y, startMonth, 1))
  const end = new Date(Date.UTC(y, startMonth + 3, 1))
  const fmt = (d) => d.toISOString().slice(0, 10)
  return [fmt(start), fmt(end)]
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

  let facility, quarter
  try {
    ;({ facility, quarter } = JSON.parse(event.body || '{}'))
    if (!WAREHOUSE_NAME[facility]) throw new Error('unknown facility')
    if (!quarter || !/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error('invalid quarter')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { facility, quarter: 'YYYY-Qn' } — ${e.message}` }) }
  }

  const warehouseName = WAREHOUSE_NAME[facility]
  const [qStart, qEnd] = quarterBounds(quarter)

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

    const sql = `
      WITH base AS (
        SELECT
          scheduled_arrival, checked_in_on, completed_on, "Notes" AS notes,
          CASE
            WHEN checked_in_on IS NULL THEN scheduled_arrival
            WHEN checked_in_on < scheduled_arrival THEN scheduled_arrival
            ELSE checked_in_on
          END AS effective_start
        FROM production_db.gold.truck_appointments
        WHERE warehouse_name = '${warehouseName}'
          AND dock_status_name = 'Completed'
          AND dock_appointment_type_name IN (${typesSql})
          AND completed_on >= TIMESTAMP '${qStart}'
          AND completed_on <  TIMESTAMP '${qEnd}'
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
        -- OTT 2hr v2: only Early/On-Time arrivals count, driver-not-ready-at-threshold excluded
        COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') AND delivery_status_2hr = 'Completed Within Target' THEN 1 END) AS ott2_num,
        COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') THEN 1 END)
          - COUNT(CASE WHEN arrival_status NOT IN ('Work-in','Late') AND notes ILIKE '%driver not ready%' AND turn_hours >= 2 THEN 1 END) AS ott2_denom,
        -- OTT 3hr all: every completed appointment counts, driver-not-ready-at-threshold excluded
        SUM(under_3_hours_) AS ott3_num,
        COUNT(*) - COUNT(CASE WHEN notes ILIKE '%driver not ready%' AND turn_hours >= 3 THEN 1 END) AS ott3_denom
      FROM final
    `

    const rows = await runQuery(sql)
    const r = rows[0] || {}
    const ott2Denom = num(r.ott2_denom)
    const ott3Denom = num(r.ott3_denom)
    const ott2Pct = ott2Denom > 0 ? (num(r.ott2_num) / ott2Denom) * 100 : null
    const ott3Pct = ott3Denom > 0 ? (num(r.ott3_num) / ott3Denom) * 100 : null

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility, quarter, warehouseName, quarterStart: qStart, quarterEndExclusive: qEnd,
        totalCompletedAppointments: num(r.total_completed),
        ott2: { pct: ott2Pct == null ? null : Math.round(ott2Pct * 100) / 100, numerator: num(r.ott2_num), denominator: ott2Denom },
        ott3: { pct: ott3Pct == null ? null : Math.round(ott3Pct * 100) / 100, numerator: num(r.ott3_num), denominator: ott3Denom },
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), facility, quarter, elapsedMs: Date.now() - t0 }),
    }
  }
}
