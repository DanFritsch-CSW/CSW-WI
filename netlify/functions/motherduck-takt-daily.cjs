'use strict'

// MotherDuck backend for the top-level Takt tab (added 2026-08-02).
// Sibling to motherduck-takt.cjs (which powers the Manager tab's quarterly
// bonus scorecard) — deliberately a SEPARATE function/file rather than an
// extra mode bolted onto that one, so this new tab can't regress the
// already-shipped, extensively-validated Manager tab metric. Same source
// table and formula, different grain: single day instead of a quarter,
// plus an optional per-employee breakdown.
//
// SOURCE TABLE: gold.takt_productivity_v2_agg. See motherduck-takt.cjs's
// header comment for the full formula/exclusion validation trail
// (employee_name IS NOT NULL exclusion, SUM/SUM weighted ratio, the
// known one-directional residual bias — all identical here).
//
// DATA LAG CAVEAT: confirmed live (2026-08-02) that this table lags —
// most facilities don't have same-day rows yet when checked mid-morning
// (Caledonia/Kenosha had partial same-day data, Madison/WR/EC did not).
// This function returns whatever the selected date actually has, including
// nulls/zero-employee facilities for a not-yet-ingested day — the
// frontend is responsible for showing "no data yet" rather than this
// function silently falling back to a different date.
//
// Two response shapes depending on whether `facility` is supplied:
//   { date } only            → facility-level rollup, all 5 facilities
//   { date, facility: 'cal' } → same rollup for that one facility PLUS
//                               a per-employee breakdown, sorted by
//                               Performance descending (highest first,
//                               per Dan's explicit call — full roster,
//                               not just underperformers).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const FACILITY_NAME = {
  cal: 'Caledonia',
  ken: 'Kenosha',
  mad: 'Madison',
  wr: 'Wisconsin Rapids',
  ec: 'Eau Claire',
}

function num(v) { return v == null ? null : Number(v) }

function computePcts(effNum, effDen, utilNum, utilDen) {
  const efficiencyPct = effDen ? (effNum / effDen) * 100 : null
  const utilizationPct = utilDen ? (utilNum / utilDen) * 100 : null
  const performancePct = efficiencyPct != null && utilizationPct != null
    ? (efficiencyPct * utilizationPct) / 100
    : null
  return {
    efficiencyPct: efficiencyPct != null ? Math.round(efficiencyPct * 100) / 100 : null,
    utilizationPct: utilizationPct != null ? Math.round(utilizationPct * 100) / 100 : null,
    performancePct: performancePct != null ? Math.round(performancePct * 100) / 100 : null,
  }
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

  let date, facility
  try {
    ;({ date, facility } = JSON.parse(event.body || '{}'))
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date')
    if (facility && !FACILITY_NAME[facility]) throw new Error('unknown facility')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { date: 'YYYY-MM-DD', facility?: 'cal'|'ken'|'mad'|'wr'|'ec' } — ${e.message}` }) }
  }

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

    const facilitySql = `
      SELECT
        facility_name,
        SUM(efficiency_numerator_seconds) AS eff_num,
        SUM(efficiency_denominator_seconds) AS eff_den,
        SUM(total_utilization_numerator_seconds) AS util_num,
        SUM(total_utilization_denominator_seconds) AS util_den,
        COUNT(DISTINCT employee_id) AS emp_count
      FROM production_db.gold.takt_productivity_v2_agg
      WHERE employee_name IS NOT NULL
        AND shift_start_date = DATE '${date}'
      GROUP BY facility_name
    `
    const facilityRows = await runQuery(facilitySql)

    const byFacilityName = {}
    facilityRows.forEach(r => { byFacilityName[r.facility_name] = r })

    const facilities = Object.entries(FACILITY_NAME).map(([id, name]) => {
      const r = byFacilityName[name]
      if (!r) {
        return { facility: id, facilityName: name, efficiency: { pct: null }, totalUtilization: { pct: null }, performance: { pct: null }, employeeCount: 0 }
      }
      const { efficiencyPct, utilizationPct, performancePct } = computePcts(num(r.eff_num), num(r.eff_den), num(r.util_num), num(r.util_den))
      return {
        facility: id,
        facilityName: name,
        efficiency: { pct: efficiencyPct },
        totalUtilization: { pct: utilizationPct },
        performance: { pct: performancePct },
        employeeCount: num(r.emp_count) || 0,
      }
    })

    let employees = null
    if (facility) {
      const facilityName = FACILITY_NAME[facility]
      const employeeSql = `
        SELECT
          employee_id, employee_name,
          SUM(efficiency_numerator_seconds) AS eff_num,
          SUM(efficiency_denominator_seconds) AS eff_den,
          SUM(total_utilization_numerator_seconds) AS util_num,
          SUM(total_utilization_denominator_seconds) AS util_den
        FROM production_db.gold.takt_productivity_v2_agg
        WHERE employee_name IS NOT NULL
          AND facility_name = '${facilityName.replace(/'/g, "''")}'
          AND shift_start_date = DATE '${date}'
        GROUP BY employee_id, employee_name
      `
      const employeeRows = await runQuery(employeeSql)
      employees = employeeRows.map(r => {
        const { efficiencyPct, utilizationPct, performancePct } = computePcts(num(r.eff_num), num(r.eff_den), num(r.util_num), num(r.util_den))
        return {
          employeeId: r.employee_id,
          employeeName: r.employee_name,
          efficiency: { pct: efficiencyPct },
          totalUtilization: { pct: utilizationPct },
          performance: { pct: performancePct },
        }
      }).sort((a, b) => (b.performance.pct ?? -Infinity) - (a.performance.pct ?? -Infinity))
    }

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        date,
        facilities,
        facility: facility || null,
        employees,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), date, facility, elapsedMs: Date.now() - t0 }),
    }
  }
}
