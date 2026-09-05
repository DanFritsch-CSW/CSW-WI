'use strict'

// F8 Open Positions backend -- Madison, F8 aisles B-F. Added 2026-09-04
// per Dan's request: a simple per-aisle count of open pallet positions,
// sitting next to DPI Pickline in FacilityPanel.jsx's MAD_TABS row.
//
// Definition (Dan's explicit rule):
//   - B/C/D/E aisles hold 2 pallet positions per location:
//       - ZERO license plates ("Empty")     = 2 open positions
//       - EXACTLY ONE license plate ("1 LP") = 1 open position
//       - anything else (2+ LPs)             = 0 open positions
//   - F aisle holds only 1 pallet position per location (added
//     2026-09-04, later still) -- confirmed live before building: F8F
//     has no legacy '-00' locations (0 of 200, unlike F8E) and its real
//     slots mostly sit at 1 LP with some at 2 (double-stacked), never 0
//     unless truly empty. Per Dan's explicit framing, only EMPTY F8F
//     locations count as open (1 open position each) -- a location
//     already holding 1 LP is considered FULL there, not partially
//     open, so 1-LP F8F locations contribute 0.
//
// Query shape mirrors motherduck-inventory.cjs's warehouse-scoping pattern
// (resolve CSW-Madison's warehouse_id first, then filter locations to
// that warehouse before joining license plates -- keeps the join bounded
// to Madison's own location count, not company-wide). Scoped further to
// just the F8B/F8C/F8D/F8E/F8F aisles via a location-name prefix match,
// so this is a much smaller/faster query than the full Inventory tab
// dump -- no need for the gzip-response handling motherduck-inventory.cjs
// needs for its much larger payload.
//
// FIXED 2026-09-04 (later): Dan flagged old/inactive legacy locations in
// F8E that should be completely ignored -- confirmed live before
// excluding anything, per standing project rule. Every F8E aisle position
// (F8E01 through F8E58+) has a real numbered pick slot (F8E##-1A through
// F8E##-7A) PLUS a legacy F8E##-00 location sitting alongside it. Queried
// live: 40 of these F8E##-00 locations exist, effectively all sitting at
// 0 license plates (one exception, F8E10-00, had 5 -- flagged to Dan
// separately, not treated as a reason to keep the pattern). Checked the
// other three aisles too before scoping the fix: F8B has exactly 1 stray
// '-00' location (not what Dan flagged), F8C/F8D have none at all -- so
// this exclusion is scoped to F8E specifically, matching Dan's explicit
// ask, not applied blanket across all four aisles. Excluded via a NOT
// clause in the `locs` CTE below rather than filtering client-side, so
// these locations never enter the classification/count logic at all.
// This structural exclusion is separate from the user-managed ignore
// list below -- it can never be un-ignored from the UI.
//
// ADDED 2026-09-04 (later still): per-location results now returned
// (`locations`), not just the aisle aggregate, so the frontend can offer
// a manual "ignore this location" capability (f8_open_positions_ignored
// table, managed via src/lib/f8OpenPositionsIgnored.js) and recompute
// aisle totals with ignored locations excluded -- same client-side-
// recompute convention as WrPickCheck.jsx's dismissal handling
// (visibleMaterials / filteredCounts). This function itself stays
// unaware of the ignore list -- `aisles`/`totalOpenPositions` below are
// the UNFILTERED baseline; the frontend is the one place that combines
// this with the live ignore list to produce what's actually displayed.
// The digest (f8-open-positions-digest-shared.cjs), which has no client
// to lean on, fetches the ignore list itself server-side instead.
//
// POST body: {} (no params).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const MADISON_WAREHOUSE_NAME = 'CSW-Madison'
const AISLES = ['F8B', 'F8C', 'F8D', 'F8E', 'F8F']

// F8F holds only 1 pallet position per location, vs. 2 for B/C/D/E --
// see file header for the live-confirmed reasoning.
const SINGLE_POSITION_AISLES = new Set(['F8F'])

const OPEN_POSITIONS_SQL = `
  WITH wh AS (
    SELECT warehouse_id
    FROM production_db.silver.datex_slv_warehouses
    WHERE warehouse_name = '${MADISON_WAREHOUSE_NAME}'
  ),
  locs AS (
    SELECT
      loc.location_container_id,
      loc.location_container_name,
      substr(loc.location_container_name, 1, 3) AS aisle
    FROM production_db.silver.datex_slv_locationcontainers loc
    JOIN wh ON loc.warehouse_id = wh.warehouse_id
    WHERE (
      loc.location_container_name LIKE 'F8B%'
      OR loc.location_container_name LIKE 'F8C%'
      OR loc.location_container_name LIKE 'F8D%'
      OR loc.location_container_name LIKE 'F8E%'
      OR loc.location_container_name LIKE 'F8F%'
    )
    -- Legacy/inactive F8E##-00 locations -- confirmed live 2026-09-04
    -- (see file header), completely ignored per Dan's explicit request.
    -- F8F has no equivalent legacy pattern (confirmed live: 0 of 200),
    -- so no exclusion is needed there.
    AND NOT (loc.location_container_name LIKE 'F8E%' AND loc.location_container_name LIKE '%-00')
  ),
  lp_counts AS (
    SELECT
      locs.location_container_id,
      count(DISTINCT lp.license_plate_id) AS lp_count
    FROM locs
    LEFT JOIN production_db.silver.datex_slv_licenseplates lp
      ON lp.location_id = locs.location_container_id
     AND (lp.Archived IS NULL OR lp.Archived = false)
    GROUP BY locs.location_container_id
  )
  SELECT
    locs.aisle AS aisle,
    locs.location_container_name AS location,
    COALESCE(lp_counts.lp_count, 0) AS lp_count
  FROM locs
  LEFT JOIN lp_counts ON lp_counts.location_container_id = locs.location_container_id
  ORDER BY locs.location_container_name
`

// Shared classification -- used by both this live endpoint and the
// digest (f8-open-positions-digest-shared.cjs runs its own independent
// copy of this SQL + logic, same "self-contained port" convention as
// jdf-scorecard-digest-shared.cjs, so the digest number can never
// silently drift from what this tab shows).
function num(v) { return Number(v ?? 0) || 0 }

function openPositionsForCount(aisle, lpCount) {
  if (SINGLE_POSITION_AISLES.has(aisle)) {
    return lpCount === 0 ? 1 : 0  // F8F: only Empty counts, 1 position each
  }
  if (lpCount === 0) return 2  // Empty
  if (lpCount === 1) return 1  // 1 LP
  return 0                     // 2+ LPs -- not counted
}

function buildAisleSummary(rows) {
  const byAisle = {}
  for (const a of AISLES) byAisle[a] = { aisle: a, totalLocations: 0, empty: 0, oneLp: 0, openPositions: 0 }

  for (const r of rows) {
    const aisle = r.aisle
    if (!byAisle[aisle]) continue // ignore anything outside B-F, shouldn't happen given the WHERE clause
    const lpCount = num(r.lp_count)
    const open = openPositionsForCount(aisle, lpCount)
    byAisle[aisle].totalLocations += 1
    if (lpCount === 0) byAisle[aisle].empty += 1
    if (lpCount === 1) byAisle[aisle].oneLp += 1
    byAisle[aisle].openPositions += open
  }

  const aisles = AISLES.map(a => byAisle[a])
  const totalOpenPositions = aisles.reduce((s, a) => s + a.openPositions, 0)
  return { aisles, totalOpenPositions }
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

    const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
    const runQuery = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const rows = await runQuery(OPEN_POSITIONS_SQL)

    try { conn.close(); db.close() } catch (_) {}

    const { aisles, totalOpenPositions } = buildAisleSummary(rows)

    // Per-location detail -- powers the frontend's ignore-list management
    // UI and its client-side recomputed (ignore-filtered) aisle totals.
    const locations = rows.map(r => {
      const lpCount = num(r.lp_count)
      return {
        location: r.location,
        aisle: r.aisle,
        lpCount,
        openPositions: openPositionsForCount(r.aisle, lpCount),
      }
    })

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        aisles,
        totalOpenPositions,
        locations,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
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

module.exports.AISLES = AISLES
module.exports.SINGLE_POSITION_AISLES = SINGLE_POSITION_AISLES
module.exports.openPositionsForCount = openPositionsForCount
module.exports.buildAisleSummary = buildAisleSummary
module.exports.OPEN_POSITIONS_SQL = OPEN_POSITIONS_SQL
