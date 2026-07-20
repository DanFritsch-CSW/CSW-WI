'use strict'

// JDF Putaways backend — F8 (Madison) JDF slotting-compliance scorecard.
// Replaces the 2026-07-17 static-snapshot build (RAW_LOCATIONS/EMPLOYEE_EVENTS/
// ALL_F8_MOVES/LOCATION_ITEM_DETAIL baked into src/lib/jdfPutaways*.js) with a
// live MotherDuck query, per Dan's 2026-07-20 request. Schema confirmed live
// before building (per standing rule) rather than guessed:
//   - JDF = Datex project_id 365 ("Jones Dairy Farm - CSW-Madison", lookup_code JDF1).
//   - F8 on-hand snapshot: silver.datex_slv_licenseplates -> locationcontainers
//     -> licenseplatecontents -> lots -> materials -> projects, filtered to
//     location_container_name LIKE 'F8%'. Confirmed live: ~1,643 F8 locations,
//     ~2,090 JDF LP rows currently on hand.
//   - Employee move history: silver.datex_slv_tasks joined to
//     silver.datex_slv_operationcodes WHERE operation_code_name = 'LicensePlateMove'
//     (Employee, completed_date_time, actual_target_location_id, lot_id) — this
//     IS the real Datex mechanism behind the old EMPLOYEE_EVENTS/ALL_F8_MOVES
//     snapshot files (confirmed: 133k historical LicensePlateMove rows into F8,
//     55 distinct employees; ~360 landed in a currently-mixed location in the
//     last 10 days alone — well within this function's timeout budget).
//   - Mfg date is still derived from the lot code (F + YYMMDD + seq), exactly
//     mirroring jdfPutawaysLogic.js's parseLotCodeDate — Datex has no usable
//     expiration/shelf-life fields for JDF (see that file's header comment).
//     Done here via TRY_CAST so an invalid month/day (bad parse) comes back
//     NULL, matching the client parser's own validation.
//
// Scope note: the 8-week "weekly clean-move rate" chart from the old snapshot
// was DROPPED per Dan's 2026-07-20 call. Reconstructing "was this location
// clean at the moment of a past move" isn't possible without point-in-time
// state tracking we don't have — the mock's version had silently used each
// move's CURRENT-day classification, which isn't a real historical trend.
// Everything returned here is a live "right now" snapshot instead.
//
// POST body: {} (no params).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const JDF_PROJECT_ID = 365
// Generous margin over the client's rolling window (24h, or 72h on Mondays) --
// keeps the payload small while never trimming data the UI might still need.
const EVENT_WINDOW_DAYS = 14

function num(v) { return Number(v ?? 0) || 0 }
function fmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : null }

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
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

    // Materialize the F8 on-hand snapshot once; every query below reads from it.
    await exec(`
      CREATE TEMP TABLE onhand AS
      SELECT
        loc.location_container_name AS location,
        substr(loc.location_container_name,3,1) AS aisle,
        lp.license_plate_id,
        lot.lot_id,
        m.material_id,
        m.lookup_code AS material_code,
        m.Description AS material_name,
        p.project_id,
        p.lookup_code AS project_code,
        p.project_name AS project_name,
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

    // Per-location classification -- JDF-only stats (clean/mixed scoring) plus
    // other-customer LP counts (deliberately NOT counted against JDF; see the
    // component's own "About shared lanes" note).
    await exec(`
      CREATE TEMP TABLE loc_class AS
      SELECT
        location, any_value(aisle) AS aisle,
        count(distinct license_plate_id) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS jdf_lp,
        count(distinct material_id) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS distinct_materials,
        count(distinct mfg_date) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS distinct_mfg_dates,
        min(mfg_date) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS earliest,
        max(mfg_date) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS latest,
        count(distinct license_plate_id) FILTER (WHERE project_id!=${JDF_PROJECT_ID}) AS other_lp,
        string_agg(DISTINCT CASE WHEN project_id!=${JDF_PROJECT_ID} THEN project_code END, ',') AS other_customers
      FROM onhand
      GROUP BY location
    `)

    const [locationRows, itemDetailRows, materialNameRows, customerNameRows, employeeEventRows, allMoveRows] = await Promise.all([
      runQuery(`
        SELECT location, aisle, jdf_lp, distinct_materials, distinct_mfg_dates, earliest, latest, other_lp, other_customers
        FROM loc_class
        WHERE jdf_lp > 0
        ORDER BY location
      `),
      runQuery(`
        SELECT o.location, o.material_code, o.mfg_date, count(distinct o.license_plate_id) AS lp_count
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${JDF_PROJECT_ID}
          AND o.mfg_date IS NOT NULL
          AND (lc.distinct_materials > 1 OR lc.distinct_mfg_dates > 1)
        GROUP BY o.location, o.material_code, o.mfg_date
        ORDER BY o.location, o.mfg_date DESC
      `),
      runQuery(`SELECT DISTINCT material_code, material_name FROM onhand WHERE project_id = ${JDF_PROJECT_ID}`),
      runQuery(`SELECT DISTINCT project_code, project_name FROM onhand WHERE project_id != ${JDF_PROJECT_ID}`),
      runQuery(`
        SELECT t.Employee AS employee, lc.location,
          CASE WHEN lc.distinct_materials > 1 THEN 'mixed_item' ELSE 'mixed_date' END AS status,
          strftime(t.completed_date_time, '%Y-%m-%d %H:%M:%S.%g') AS completed_at,
          lot.lookup_code AS lot_code
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = t.operation_code_id
        JOIN production_db.silver.datex_slv_locationcontainers loc2 ON loc2.location_container_id = t.actual_target_location_id
        JOIN loc_class lc ON lc.location = loc2.location_container_name
        LEFT JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = t.lot_id
        WHERE oc.operation_code_name = 'LicensePlateMove'
          AND t.completed_date_time >= now() - INTERVAL ${EVENT_WINDOW_DAYS} DAY
          AND t.Employee IS NOT NULL
          AND lc.jdf_lp > 0
          AND (lc.distinct_materials > 1 OR lc.distinct_mfg_dates > 1)
        ORDER BY t.completed_date_time DESC
      `),
      runQuery(`
        SELECT substr(loc2.location_container_name,3,1) AS aisle,
          strftime(t.completed_date_time, '%Y-%m-%d %H:%M:%S.%g') AS completed_at
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = t.operation_code_id
        JOIN production_db.silver.datex_slv_locationcontainers loc2 ON loc2.location_container_id = t.actual_target_location_id
        WHERE oc.operation_code_name = 'LicensePlateMove'
          AND loc2.location_container_name LIKE 'F8%'
          AND t.completed_date_time >= now() - INTERVAL ${EVENT_WINDOW_DAYS} DAY
        ORDER BY t.completed_date_time DESC
      `),
    ])

    try { conn.close(); db.close() } catch (_) {}

    const locations = locationRows.map(r => [
      r.location, r.aisle, num(r.jdf_lp), num(r.distinct_materials), num(r.distinct_mfg_dates),
      fmtDate(r.earliest), fmtDate(r.latest), num(r.other_lp), r.other_customers || '',
    ])

    const locationItemDetail = {}
    for (const r of itemDetailRows) {
      if (!locationItemDetail[r.location]) locationItemDetail[r.location] = []
      locationItemDetail[r.location].push([r.material_code, fmtDate(r.mfg_date), num(r.lp_count)])
    }

    const materialNames = {}
    for (const r of materialNameRows) materialNames[r.material_code] = r.material_name

    const customerNames = {}
    for (const r of customerNameRows) customerNames[r.project_code] = r.project_name

    const employeeEvents = employeeEventRows.map(r => [r.employee, r.location, r.status, r.completed_at, r.lot_code])
    const allMoves = allMoveRows.map(r => [r.aisle, r.completed_at])

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        locations, locationItemDetail, materialNames, customerNames, employeeEvents, allMoves,
        fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), elapsedMs: Date.now() - t0 }),
    }
  }
}
