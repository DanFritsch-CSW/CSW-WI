'use strict'

// MotherDuck backend for the WR "Cases To Pick" sub-tab — recreates the
// Omni dashboard Dan uses as the benchmark for this tile set (screenshotted
// 2026-07-14). Scope confirmed with Dan: Bernatello's - Wisconsin Rapids
// only (project_id 320), same scope as the existing Pickline tab — not a
// broader WR rollup.
//
// POST body: { date: 'YYYY-MM-DD' }  (this is the app's planDate, used
// directly as requested_delivery_date — NOT "always tomorrow" the way the
// original Omni tiles were pinned; Dan's app already threads planDate
// through every other WR tab so this stays consistent with that.)
//
// ── Filter definitions — reverse-engineered from Dan's Omni filter-panel
//    screenshots (2026-07-14), not guessed:
//   - Total DSD Cases (Pickline & Outside): project_id=320, order_class_id=34
//     (DSD Order), order_status_id=1 (Created), requested_delivery_date=date.
//     Value = SUM(orderlines.Amount).
//   - Cases To Pick Outside Pickline: same DSD scope, orderlines.Amount>=15
//     AND pallet_qty>=0.5. pallet_qty = Amount / (pallet_tie * pallet_high)
//     per line, joined via materialspackagingslookup — same tie/high join
//     already used for pallet estimates in motherduck-prepick-status.cjs.
//   - Pickline Volume = Total DSD Cases − Cases To Pick Outside Pickline
//     (not a separate Omni query; the two example screenshots' numbers
//     back this out exactly: 3086 − 456 = 2630).
//   - True Warehouse Full Pallet Pick / True Warehouse Case Pick: split of
//     the "outside pickline" pool by whether pallet_qty lands on a whole
//     number (full pallets, no case-picking needed) vs has a fractional
//     remainder (needs case-level picking). Full Pallet reports PALLET
//     COUNT (SUM of whole pallet_qty); Case Pick reports CASE COUNT (SUM
//     of Amount) — this is why the two don't sum to the "outside pickline"
//     total in the same units.
//   - NON-DSD Cases / # of Full Pallets / Case Picking on SO Orders: same
//     shape but order_class_id=2 (Sales Order), order_status_id IN (1,2)
//     (Created, Processing — confirmed via Omni filter panel), and NO
//     Amount>=15 threshold (only the pallet_qty>=0.5 cutoff applies).
//
// ── Known gap, documented rather than silently guessed around:
// Lines whose SKU has no pallet_tie/pallet_high configured in Datex can't
// have a pallet_qty computed at all — they fall out of every pallet_qty
// threshold check (>=0.5), so they never count toward "outside pickline",
// full-pallet, or case-pick buckets. They still count in the DSD/NON-DSD
// case totals. This mirrors the same tie/high coverage gap documented in
// motherduck-prepick-status.cjs (2026-07-13) — not universal, ~86-92% line
// coverage observed there. Validate against live Omni numbers once this
// ships; if the totals drift, this coverage gap is the first place to look.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECT_ID = 320       // Bernatello's - Wisconsin Rapids
const DSD_CLASS_ID = 34      // DSD Order
const SO_CLASS_ID = 2        // Sales Order
const STATUS_CREATED = 1
const STATUS_PROCESSING = 2

function num(v) { return Number(v ?? 0) || 0 }

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let date
  try {
    ;({ date } = JSON.parse(event.body || '{}'))
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date')
  } catch {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'Body must be { date: "YYYY-MM-DD" }' }),
    }
  }

  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  let conn, db
  try {
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (sql) => new Promise((resolve, reject) => {
      conn.run(sql, (err) => err ? reject(err) : resolve())
    })
    const runQuery = (sql) => new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
    })

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    // Shared per-line CTE: every orderline for the project/date, with a
    // computed pallet_qty (NULL when the SKU has no tie/high configured).
    const linesCte = (orderClassId, statusFilterSql) => `
      SELECT
        ol.order_id,
        ol.Amount AS amount,
        CASE WHEN mpl.pallet_tie IS NOT NULL AND mpl.pallet_high IS NOT NULL
                  AND mpl.pallet_tie * mpl.pallet_high > 0
             THEN ol.Amount / (mpl.pallet_tie * mpl.pallet_high)
             ELSE NULL END AS pallet_qty
      FROM production_db.silver.datex_slv_orderlines ol
      JOIN production_db.silver.datex_slv_orders o ON o.order_id = ol.order_id
      LEFT JOIN production_db.silver.datex_slv_materialspackagingslookup mpl
        ON mpl.material_id = ol.material_id AND mpl.packaging_id = ol.packaged_id
      WHERE o.project_id = ${PROJECT_ID}
        AND o.order_class_id = ${orderClassId}
        AND o.requested_delivery_date::date = '${date}'
        AND ${statusFilterSql}
    `

    const dsdSql = `
      WITH lines AS (${linesCte(DSD_CLASS_ID, `o.order_status_id = ${STATUS_CREATED}`)})
      SELECT
        SUM(amount) AS total_cases,
        SUM(CASE WHEN amount >= 15 AND pallet_qty >= 0.5 THEN amount ELSE 0 END) AS outside_pickline_cases,
        SUM(CASE WHEN amount >= 15 AND pallet_qty >= 0.5 AND pallet_qty = FLOOR(pallet_qty)
                 THEN pallet_qty ELSE 0 END) AS full_pallet_count,
        SUM(CASE WHEN amount >= 15 AND pallet_qty >= 0.5 AND pallet_qty <> FLOOR(pallet_qty)
                 THEN amount ELSE 0 END) AS case_pick_cases
      FROM lines
    `

    const soSql = `
      WITH lines AS (${linesCte(SO_CLASS_ID, `o.order_status_id IN (${STATUS_CREATED}, ${STATUS_PROCESSING})`)})
      SELECT
        SUM(CASE WHEN pallet_qty >= 0.5 THEN amount ELSE 0 END) AS non_dsd_cases,
        SUM(CASE WHEN pallet_qty >= 0.5 AND pallet_qty = FLOOR(pallet_qty)
                 THEN pallet_qty ELSE 0 END) AS full_pallets,
        SUM(CASE WHEN pallet_qty >= 0.5 AND pallet_qty <> FLOOR(pallet_qty)
                 THEN amount ELSE 0 END) AS case_picking_so
      FROM lines
    `

    const [dsdRows, soRows] = await Promise.all([runQuery(dsdSql), runQuery(soSql)])
    const dsd = dsdRows[0] || {}
    const so = soRows[0] || {}

    const totalDsdCases = num(dsd.total_cases)
    const casesOutsidePickline = num(dsd.outside_pickline_cases)
    const picklineVolume = Math.max(0, totalDsdCases - casesOutsidePickline)

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        date,
        totalDsdCases,
        casesOutsidePickline,
        picklineVolume,
        fullPalletPickCount: num(dsd.full_pallet_count),
        casePickCases: num(dsd.case_pick_cases),
        nonDsdCases: num(so.non_dsd_cases),
        fullPalletsSo: num(so.full_pallets),
        casePickingOnSoOrders: num(so.case_picking_so),
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.slice(0, 500),
        date,
        elapsedMs: Date.now() - t0,
      }),
    }
  }
}
