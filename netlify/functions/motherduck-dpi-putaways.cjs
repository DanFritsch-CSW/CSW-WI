'use strict'

// DPI Putaways backend — F5 + F8 (Madison) DPI slotting-compliance scorecard.
// Duplicated from motherduck-jdf-putaways.cjs per Dan's 2026-08-25 request
// ("duplicate the JDF Putaway tab for DPI, identical in nature"), with three
// explicit scope decisions confirmed by Dan before building:
//   1. DPI hard-coded to F5 + F8 (not F2 — DPI has zero active inventory
//      there today, confirmed live; not building-wide — DPI also has stock
//      in D1/F3/C8 that this tab intentionally does not cover).
//   2. The second scorecard layer uses RECEIPT DATE, not a parsed
//      manufacture date. JDF's lot codes are self-dating (F + YYMMDD); DPI's
//      are plain sequential numbers (confirmed live: e.g. 162202, 1076304)
//      with no date encoded in them at all. DPI lots DO carry a populated
//      lot.receive_date (confirmed live); licenseplatecontents.expiration_date
//      is null for every DPI row checked, so receive_date is the only usable
//      per-lot date signal — this is "same intake cohort", not FEFO/shelf-life.
//   3. F5 and F8 are physically different racks with overlapping aisle
//      letters (both have an "A" aisle, e.g.) — grouping by aisle letter
//      alone the way jdfPutawaysLocations.js does for JDF's single F8 zone
//      would silently merge two unrelated racks. This function returns a
//      combined `${zone}-${aisle}` key (e.g. "F5-A", "F8-A") for every
//      location/aisle-level grouping instead of a bare letter.
//
// DPI = Datex project_id 122 ("DPI - CSW-Madison", lookup_code DPI1) —
// confirmed live as the only DPI project with any F5/F8 inventory (DPI's
// other 4 projects — Transportation accounts and the EC-facility pair —
// carry zero F5/F8 Madison stock).
//
// Everything else below mirrors motherduck-jdf-putaways.cjs's structure and
// header commentary exactly — same onhand/loc_class temp-table pattern, same
// dailyScorecard (today's received cohort)/buildingWide (all-time) split,
// same "put away" = landed in F5/F8 definition, same stillStaged callout.
// See that file's header for the fuller design rationale where this comment
// doesn't repeat it.
//
// POST body: {} (no params).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const DPI_PROJECT_ID = 122
const EVENT_WINDOW_DAYS = 14

function num(v) { return Number(v ?? 0) || 0 }
function fmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : null }

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function centralTodayDateStr() {
  const { year, month, day } = centralNowParts()
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
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

    // Materialize the F5+F8 on-hand snapshot once. `zone_aisle` combines
    // the 2-char zone prefix with the aisle letter (e.g. "F5-A", "F8-A") so
    // F5 and F8's overlapping letter names never collide downstream.
    await exec(`
      CREATE TEMP TABLE onhand AS
      SELECT
        loc.location_container_name AS location,
        substr(loc.location_container_name,1,2) || '-' || substr(loc.location_container_name,3,1) AS zone_aisle,
        lp.license_plate_id,
        CAST(lp.created_sys_date_time AS DATE) AS created_date,
        lot.lot_id,
        m.material_id,
        m.lookup_code AS material_code,
        m.Description AS material_name,
        p.project_id,
        p.lookup_code AS project_code,
        p.project_name AS project_name,
        CAST(lot.receive_date AS DATE) AS recv_date
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
      JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
      JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
      WHERE (loc.location_container_name LIKE 'F5%' OR loc.location_container_name LIKE 'F8%')
        AND (lp.Archived IS NULL OR lp.Archived = false)
    `)

    // Per-location classification -- DPI-only stats plus other-customer LP
    // counts (not counted against DPI; mirrors JDF's "shared lanes" note).
    await exec(`
      CREATE TEMP TABLE loc_class AS
      SELECT
        location, any_value(zone_aisle) AS zone_aisle,
        count(distinct license_plate_id) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS dpi_lp,
        count(distinct material_id) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS distinct_materials,
        count(distinct recv_date) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS distinct_recv_dates,
        min(recv_date) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS earliest,
        max(recv_date) FILTER (WHERE project_id=${DPI_PROJECT_ID}) AS latest,
        count(distinct license_plate_id) FILTER (WHERE project_id!=${DPI_PROJECT_ID}) AS other_lp,
        string_agg(DISTINCT CASE WHEN project_id!=${DPI_PROJECT_ID} THEN project_code END, ',') AS other_customers
      FROM onhand
      GROUP BY location
    `)

    const today = centralTodayDateStr()

    const [
      locationRows, itemDetailRows, materialNameRows, customerNameRows,
      employeeEventRows, allMoveRows, dailyRows, buildingWideRows, receivedTodayRows,
    ] = await Promise.all([
      runQuery(`
        SELECT location, zone_aisle, dpi_lp, distinct_materials, distinct_recv_dates, earliest, latest, other_lp, other_customers
        FROM loc_class
        WHERE dpi_lp > 0
        ORDER BY location
      `),
      runQuery(`
        SELECT o.location, o.material_code, o.recv_date, count(distinct o.license_plate_id) AS lp_count
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${DPI_PROJECT_ID}
          AND o.recv_date IS NOT NULL
          AND (lc.distinct_materials > 1 OR lc.distinct_recv_dates > 1)
        GROUP BY o.location, o.material_code, o.recv_date
        ORDER BY o.location, o.recv_date DESC
      `),
      runQuery(`SELECT DISTINCT material_code, material_name FROM onhand WHERE project_id = ${DPI_PROJECT_ID}`),
      runQuery(`SELECT DISTINCT project_code, project_name FROM onhand WHERE project_id != ${DPI_PROJECT_ID}`),
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
          AND lc.dpi_lp > 0
          AND (lc.distinct_materials > 1 OR lc.distinct_recv_dates > 1)
        ORDER BY t.completed_date_time DESC
      `),
      runQuery(`
        SELECT
          substr(loc2.location_container_name,1,2) || '-' || substr(loc2.location_container_name,3,1) AS zone_aisle,
          strftime(t.completed_date_time, '%Y-%m-%d %H:%M:%S.%g') AS completed_at
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = t.operation_code_id
        JOIN production_db.silver.datex_slv_locationcontainers loc2 ON loc2.location_container_id = t.actual_target_location_id
        WHERE oc.operation_code_name = 'LicensePlateMove'
          AND (loc2.location_container_name LIKE 'F5%' OR loc2.location_container_name LIKE 'F8%')
          AND t.completed_date_time >= now() - INTERVAL ${EVENT_WINDOW_DAYS} DAY
        ORDER BY t.completed_date_time DESC
      `),
      // Daily Putaway Scorecard -- LPs created (received) TODAY (Central).
      runQuery(`
        SELECT
          count(distinct o.license_plate_id) AS put_away,
          count(distinct CASE WHEN lc.distinct_materials <= 1 THEN o.license_plate_id END) AS same_item_tier,
          count(distinct CASE WHEN lc.distinct_materials <= 1 AND lc.distinct_recv_dates <= 1 THEN o.license_plate_id END) AS same_item_tier_recv_date
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${DPI_PROJECT_ID}
          AND o.created_date = DATE '${today}'
      `),
      // Building-Wide baseline -- every active DPI LP in F5/F8 right now.
      runQuery(`
        SELECT
          count(distinct o.license_plate_id) AS total_active,
          count(distinct CASE WHEN lc.distinct_materials <= 1 THEN o.license_plate_id END) AS same_item_tier,
          count(distinct CASE WHEN lc.distinct_materials <= 1 AND lc.distinct_recv_dates <= 1 THEN o.license_plate_id END) AS same_item_tier_recv_date
        FROM onhand o
        JOIN loc_class lc ON lc.location = o.location
        WHERE o.project_id = ${DPI_PROJECT_ID}
      `),
      // Received-anywhere-today (any Madison location, not just F5/F8) --
      // the gap between this and put_away is "still in receiving/staging".
      runQuery(`
        SELECT count(distinct lpc.license_plate_id) AS total_received
        FROM production_db.silver.datex_slv_licenseplates lp
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
        JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
        JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
        WHERE m.project_id = ${DPI_PROJECT_ID}
          AND lp.warehouse_id = 4
          AND CAST(lp.created_sys_date_time AS DATE) = DATE '${today}'
          AND (lp.Archived IS NULL OR lp.Archived = false)
      `),
    ])

    try { conn.close(); db.close() } catch (_) {}

    const locations = locationRows.map(r => [
      r.location, r.zone_aisle, num(r.dpi_lp), num(r.distinct_materials), num(r.distinct_recv_dates),
      fmtDate(r.earliest), fmtDate(r.latest), num(r.other_lp), r.other_customers || '',
    ])

    const locationItemDetail = {}
    for (const r of itemDetailRows) {
      if (!locationItemDetail[r.location]) locationItemDetail[r.location] = []
      locationItemDetail[r.location].push([r.material_code, fmtDate(r.recv_date), num(r.lp_count)])
    }

    const materialNames = {}
    for (const r of materialNameRows) materialNames[r.material_code] = r.material_name

    const customerNames = {}
    for (const r of customerNameRows) customerNames[r.project_code] = r.project_name

    const employeeEvents = employeeEventRows.map(r => [r.employee, r.location, r.status, r.completed_at, r.lot_code])
    const allMoves = allMoveRows.map(r => [r.zone_aisle, r.completed_at])

    const dailyRow = dailyRows[0] || {}
    const buildingRow = buildingWideRows[0] || {}
    const totalReceived = num(receivedTodayRows?.[0]?.total_received)
    const putAway = num(dailyRow.put_away)
    const dailyScorecard = {
      date: today,
      totalReceived,
      putAway,
      stillStaged: Math.max(totalReceived - putAway, 0),
      sameItemTier: num(dailyRow.same_item_tier),
      sameItemTierRecvDate: num(dailyRow.same_item_tier_recv_date),
    }
    const buildingWide = {
      totalActive: num(buildingRow.total_active),
      sameItemTier: num(buildingRow.same_item_tier),
      sameItemTierRecvDate: num(buildingRow.same_item_tier_recv_date),
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        locations, locationItemDetail, materialNames, customerNames, employeeEvents, allMoves,
        dailyScorecard, buildingWide,
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
