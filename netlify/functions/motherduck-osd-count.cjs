'use strict'

// MotherDuck backend for the Manager tab's OSD — count live pull. Added
// 2026-08-02. Covers CAL/KEN/MAD only — WR doesn't have this metric on
// its scorecard (uses Case Pick Accuracy instead), and Eau Claire has no
// synced Silver table for its OSD tracker (see sharepoint-ec-osd-count.cjs,
// which reads EC's live SharePoint file directly instead).
//
// Source: silver.sharepoint_slv_<facility>_customer_osd_tracker_v2 — these
// are NOT built by this app. A separate data-platform pipeline (owned
// outside this project) already reads each facility's SharePoint OSD
// tracker daily and lands it here; this function only reads that copy.
// This app never writes to these trackers or their SharePoint source —
// read-only, by design, per Dan's explicit instruction.
//
// Confirmed with Dan before building:
//   - Only rows where "CSW at Fault?" = true count toward the metric —
//     matches the same "don't penalize the warehouse for someone else's
//     mistake" logic already applied to OTT and OSD $.
//   - Quarter is defined by "Initial Email Date", not "Order Date".
//
// Sanity-checked against real data before shipping: Q3-to-date CSW-at-fault
// counts were Caledonia 7, Kenosha 6, Madison 0 — all plausible against the
// anchor(16)/target_100(4)/target_120(2) already on the scorecard.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Facility → Silver table name. cal/ken/mad only — see header note above
// for wr (not applicable) and ec (different source, different function).
const TABLE_NAME = {
  cal: 'sharepoint_slv_caledonia_customer_osd_tracker_v2',
  ken: 'sharepoint_slv_kenosha_customer_osd_tracker_v2',
  mad: 'sharepoint_slv_madison_customer_osd_tracker_v2',
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
    if (!TABLE_NAME[facility]) throw new Error('unsupported facility for this function (cal/ken/mad only)')
    if (!quarter || !/^\d{4}-Q[1-4]$/.test(quarter)) throw new Error('invalid quarter')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Body must be { facility: 'cal'|'ken'|'mad', quarter: 'YYYY-Qn' } — ${e.message}` }) }
  }

  const tableName = TABLE_NAME[facility]
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
        COUNT(*) AS total_rows,
        COUNT(*) FILTER (WHERE "CSW at Fault?" = true) AS fault_count
      FROM production_db.silver.${tableName}
      WHERE "Initial Email Date" >= DATE '${qStart}'
        AND "Initial Email Date" <  DATE '${qEnd}'
    `

    const rows = await runQuery(sql)
    const r = rows[0] || {}

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility, quarter, quarterStart: qStart, quarterEndExclusive: qEnd,
        totalRowsThisQuarter: num(r.total_rows) || 0,
        osdCount: { count: num(r.fault_count) || 0 },
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
