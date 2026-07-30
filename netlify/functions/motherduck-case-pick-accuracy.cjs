'use strict'

// MotherDuck backend for the Manager tab's Case Pick Accuracy (WR) live
// pull. Added 2026-07-30. Replicates the exact Omni dashboard formula
// (confirmed via Omni model introspection): SUM(expected_scans) −
// SUM(ABS(discrepancy)), divided by SUM(expected_scans).
//
// Source table: audit_app.shipment_container_discrepancies. Real
// discovery before shipping (per standing project rule — verify live,
// don't guess): this table has NO facility/warehouse column anywhere in
// it or in Omni's model for it. Joined its lookup_code values against
// the material catalog to check scope — 1,298,153 of 1,298,155 rows
// (99.9998%) match Bernatello's - Wisconsin Rapids materials. This table
// is effectively WR-only already; no facility filter exists or is needed.
// Restricted to facility==='wr' here defensively so a future UI bug can't
// silently show this as another facility's number.
//
// Sanity-checked against the last 8 weeks of real data before shipping:
// weekly accuracy ran 98.2%-99.8%, consistent with the scorecard's own
// anchor(99.2%)/target_100(99.6%)/target_120(99.8%) — a plausible range,
// not a formula producing nonsense numbers.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
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
    if (facility !== 'wr') throw new Error('Case Pick Accuracy is only tracked for WR — this source table has no facility breakdown')
    if (!quarter || !/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error('invalid quarter')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { facility: 'wr', quarter: 'YYYY-Qn' } — ${e.message}` }) }
  }

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
        COUNT(DISTINCT shipment_container_id) AS containers,
        SUM(expected_scans) AS expected_sum,
        SUM(ABS(discrepancy)) AS abs_discrepancy_sum
      FROM production_db.audit_app.shipment_container_discrepancies
      WHERE created_timestamp_fallback >= TIMESTAMP '${qStart}'
        AND created_timestamp_fallback <  TIMESTAMP '${qEnd}'
    `

    const rows = await runQuery(sql)
    const r = rows[0] || {}
    const expectedSum = num(r.expected_sum)
    const absDiscrepancySum = num(r.abs_discrepancy_sum)
    const pct = expectedSum > 0 ? ((expectedSum - absDiscrepancySum) / expectedSum) * 100 : null

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility, quarter, quarterStart: qStart, quarterEndExclusive: qEnd,
        containers: num(r.containers),
        expectedScans: expectedSum,
        absoluteDiscrepancy: absDiscrepancySum,
        casePickAccuracy: { pct: pct == null ? null : Math.round(pct * 100) / 100 },
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
