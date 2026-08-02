'use strict'

// MotherDuck backend for the Manager tab's Takt Performance live pull.
// Added 2026-08-02, after a genuinely extensive validation effort against
// two real months of the live Takt dashboard (June and July 2026,
// screenshots from Dan) — see the Notion changelog entry from this
// session for the full investigation trail. Summary of what was tried
// and what's still unresolved:
//
// SOURCE TABLE: gold.takt_productivity_v2_agg — NOT the raw bronze
// productivity tables. This gold table is the one that actually has
// purpose-built numerator/denominator seconds fields per metric
// (efficiency_numerator_seconds/efficiency_denominator_seconds,
// total_utilization_numerator_seconds/total_utilization_denominator_seconds)
// — using these as a properly WEIGHTED ratio (SUM/SUM) is what got
// Utilization to reconcile. The earlier, wrong approach was averaging the
// row-level `utilization` field directly (AVG(utilization)) — that
// happened to look right for July's Wisconsin Rapids by coincidence, but
// was off by as much as 17-18 points for Eau Claire in both months tested.
//
// FORMULA:
//   Efficiency = SUM(efficiency_numerator_seconds) / SUM(efficiency_denominator_seconds)
//   Total Utilization = SUM(total_utilization_numerator_seconds) / SUM(total_utilization_denominator_seconds)
//   Performance = Efficiency × Total Utilization
// (Confirmed Performance = Efficiency × Utilization directly against the
// dashboard's own displayed Performance/Efficiency/Total Utilization
// trio, for all 5 facilities, both months — that multiplicative
// relationship itself was never in question.)
//
// REQUIRED EXCLUSION: employee_name IS NOT NULL. A meaningful chunk of
// rows carry a real employee_id but a null extracted name — these are an
// unassigned/system bucket, and at least some of them are severe data
// quality outliers (e.g. one Wisconsin Rapids row on 2026-07-06 had
// earned_seconds of 198,816 against direct_worked_seconds of only 19,194
// — a ~10x ratio from a single row). Excluding these is what fixed
// Wisconsin Rapids' Efficiency from ~2x inflated down to within ~1 point.
//
// KNOWN UNRESOLVED RESIDUAL BIAS (per Dan's explicit instruction, ship
// anyway — this comment is so the caveat doesn't get lost): after both
// fixes above, every one of the 10 facility-months tested (5 facilities ×
// June + July) still comes out slightly HIGH vs the real dashboard number,
// never low. Most are within 1-3 points on Performance. Caledonia is the
// worst in both months (+5.2 to +5.4 points) — checked for one dominant
// outlier row/employee there (found a Karelys N. Vega-Cartagena row with
// efficiency_denominator_seconds = 1, an obvious glitch) but excluding it
// (or her entirely) barely moved the number (85.6% → 85.1%), so
// Caledonia's gap is NOT explained by one bad row — likely a genuine
// duplicate-load issue (Caledonia had by far the most distinct
// _dlt_load_id values of any facility in spot checks) that wasn't fully
// chased down. The consistent one-directional (always high, never low)
// bias across every facility suggests one more shared exclusion is still
// missing, common to all facilities, worse in Caledonia specifically.
// Do not treat this metric as fully reconciled — it's "close, ship
// anyway" by explicit decision, not "verified exact."

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Facility → exact facility_name value in gold.takt_productivity_v2_agg.
// Confirmed live against the table (json_extract_string(facility,'$.name')
// on the bronze source, facility_name directly here) — plain English
// names, not codes.
const FACILITY_NAME = {
  cal: 'Caledonia',
  ken: 'Kenosha',
  mad: 'Madison',
  wr: 'Wisconsin Rapids',
  ec: 'Eau Claire',
}

function num(v) { return v == null ? null : Number(v) }

function quarterBounds(quarterStr) {
  const [yStr, qStr] = quarterStr.split('-Q')
  const y = Number(yStr)
  const q = Number(qStr)
  const startMonth = (q - 1) * 3
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
    if (!FACILITY_NAME[facility]) throw new Error('unknown facility')
    if (!quarter || !/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error('invalid quarter')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { facility, quarter: 'YYYY-Qn' } — ${e.message}` }) }
  }

  const facilityName = FACILITY_NAME[facility]
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

    const sql = `
      SELECT
        SUM(efficiency_numerator_seconds) AS eff_num,
        SUM(efficiency_denominator_seconds) AS eff_den,
        SUM(total_utilization_numerator_seconds) AS util_num,
        SUM(total_utilization_denominator_seconds) AS util_den
      FROM production_db.gold.takt_productivity_v2_agg
      WHERE facility_name = '${facilityName.replace(/'/g, "''")}'
        AND employee_name IS NOT NULL
        AND shift_start_date >= DATE '${qStart}'
        AND shift_start_date <  DATE '${qEnd}'
    `

    const rows = await runQuery(sql)
    const r = rows[0] || {}

    try { conn.close(); db.close() } catch (_) {}

    const effNum = num(r.eff_num)
    const effDen = num(r.eff_den)
    const utilNum = num(r.util_num)
    const utilDen = num(r.util_den)

    const efficiencyPct = effDen ? (effNum / effDen) * 100 : null
    const utilizationPct = utilDen ? (utilNum / utilDen) * 100 : null
    const performancePct = efficiencyPct != null && utilizationPct != null
      ? (efficiencyPct * utilizationPct) / 100
      : null

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility, quarter, facilityName, quarterStart: qStart, quarterEndExclusive: qEnd,
        efficiency: { pct: efficiencyPct != null ? Math.round(efficiencyPct * 100) / 100 : null },
        totalUtilization: { pct: utilizationPct != null ? Math.round(utilizationPct * 100) / 100 : null },
        performance: { pct: performancePct != null ? Math.round(performancePct * 100) / 100 : null },
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
