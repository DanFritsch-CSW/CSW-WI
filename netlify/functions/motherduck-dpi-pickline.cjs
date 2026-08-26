'use strict'

// DPI Pickline backend — F8E01-1A..F8E17-1A / F8F01-1A..F8F17-1A primary
// pick reslot checker. Built 2026-08-26 replacing the DPI Putaways tab per
// Dan's request, after live checking confirmed a real problem: Datex's
// IsPrimaryPick flag on these 34 locations went live (confirmed via
// bronze.datex_locationcontainers) days before this was built, but
// flipping that flag does not move or clear whatever product physically
// occupies the location. A live occupancy check that same day found only
// 1 of 34 locations actually held its designated SKU — 11 held another
// customer's product entirely (Saputo project_id 220, Jones Dairy Farm
// project_id 365), the rest held DPI product but the wrong SKU.
//
// This function is intentionally NOT a replenishment/depletion monitor —
// that only means something once these 34 locations actually hold what
// they're designated to hold. It's a reslot task list: designated SKU
// (hardcoded below, from the velocity-ranked slotting plan built earlier
// the same session — spread-order pick-line frequency over a 2-year
// window, cross-referenced against real on-hand and observed cases/pallet
// since Datex's configured tie/high was found unreliable for this
// account) vs. whatever MotherDuck shows physically sitting there right
// now, checked live on every load. Each position also carries a live
// `pullFrom` list — the top 3 real reserve locations (by quantity, outside
// the 34 primary positions and outside transient staging) currently
// holding that SKU, so the reslot task list tells a crew where to go, not
// just what's wrong. Added 2026-08-26 per Dan's request to mimic
// WrSecondaryRepl.jsx's "Pull from" pattern.
//
// DESIGNATED_LOCATIONS is hardcoded rather than pulled from a settings
// table because the underlying Datex material-to-location BINDING table
// (silver.datex_slv_primarypicklocations) had not synced through as of
// this build — its source export was still 5 days stale even after a
// same-day location-flag change came through cleanly on a different
// pipeline (see this function's git history / Notion changelog for the
// full diagnostic). Once that binding table is confirmed live and
// trustworthy, this hardcoded list should be replaced with a live join
// against it instead of maintained by hand here.
//
// DPI = Datex project_id 122 ("DPI - CSW-Madison"). Both F8E and F8F are
// scenario-modeled at 2 pallets/position (Dan confirmed live F8F can
// physically hold 2 pallets floor-level, same as F8E).
//
// POST body: {} (no params).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const DPI_PROJECT_ID = 122

// Designated primary SKU per location — from the interleaved slotting
// plan (both bays ranked together once F8F was confirmed 2-pallet
// capacity, so the two highest-frequency SKUs pair at position 01 on
// both sides of the aisle).
const DESIGNATED_LOCATIONS = [
  { loc: 'F8E01-1A', bay: '8E', sku: 'C530', desc: 'Chicken Nug WG Breaded' },
  { loc: 'F8E02-1A', bay: '8E', sku: 'C501', desc: 'Chicken Smackers WG' },
  { loc: 'F8E03-1A', bay: '8E', sku: '100348', desc: 'Corn Frz' },
  { loc: 'F8E04-1A', bay: '8E', sku: 'C310', desc: 'Turkey Mini Corn Dog' },
  { loc: 'F8E05-1A', bay: '8E', sku: '100351', desc: 'Beans Green Frz' },
  { loc: 'F8E06-1A', bay: '8E', sku: '100117', desc: 'Chix Fajita' },
  { loc: 'F8E07-1A', bay: '8E', sku: '100021', desc: 'Cheese Mozz Shred 30' },
  { loc: 'F8E08-1A', bay: '8E', sku: 'C402', desc: 'Beef Meatballs' },
  { loc: 'F8E09-1A', bay: '8E', sku: '100350', desc: 'Peas Frz' },
  { loc: 'F8E10-1A', bay: '8E', sku: '100187', desc: 'Ham Cooked Frz Sliced' },
  { loc: 'F8E11-1A', bay: '8E', sku: 'C803', desc: 'French Toast Sticks' },
  { loc: 'F8E12-1A', bay: '8E', sku: 'C415', desc: 'Beef Patties' },
  { loc: 'F8E13-1A', bay: '8E', sku: '110730', desc: 'Pork Pulled Cooked' },
  { loc: 'F8E14-1A', bay: '8E', sku: '100357', desc: 'Oven Potatoes' },
  { loc: 'F8E15-1A', bay: '8E', sku: '110851', desc: 'Fish AK Poll Sticks' },
  { loc: 'F8E16-1A', bay: '8E', sku: 'C551', desc: 'Mandr Orange Chicken' },
  { loc: 'F8E17-1A', bay: '8E', sku: '111900', desc: 'Turkey Deli Breast Sliced' },
  { loc: 'F8F01-1A', bay: '8F', sku: 'C526', desc: 'Chicken Patty WG Breaded' },
  { loc: 'F8F02-1A', bay: '8F', sku: '100256', desc: 'Strawberry Cup 4.5oz' },
  { loc: 'F8F03-1A', bay: '8F', sku: 'C705', desc: 'Cheese Stuffed Sticks' },
  { loc: 'F8F04-1A', bay: '8F', sku: '100101', desc: 'Chicken Diced Cooked' },
  { loc: 'F8F05-1A', bay: '8F', sku: '110393', desc: 'Pancakes Whl Wheat' },
  { loc: 'F8F06-1A', bay: '8F', sku: 'C722', desc: 'Cheese Quesadillas' },
  { loc: 'F8F07-1A', bay: '8F', sku: '100158', desc: 'Beef 40' },
  { loc: 'F8F08-1A', bay: '8F', sku: '110860', desc: 'Strawberries Sliced' },
  { loc: 'F8F09-1A', bay: '8F', sku: 'C704', desc: 'Macaroni & Cheese' },
  { loc: 'F8F10-1A', bay: '8F', sku: '110859', desc: 'Mixed Berry Cup' },
  { loc: 'F8F11-1A', bay: '8F', sku: '100352', desc: 'Carrots 30' },
  { loc: 'F8F12-1A', bay: '8F', sku: '110473', desc: 'Broccoli 30lb' },
  { loc: 'F8F13-1A', bay: '8F', sku: '111751', desc: 'Egg Patty Round' },
  { loc: 'F8F14-1A', bay: '8F', sku: '100241', desc: 'Peaches Cup 4.4' },
  { loc: 'F8F15-1A', bay: '8F', sku: '100188', desc: 'Ham Ckd Fz Cube' },
  { loc: 'F8F16-1A', bay: '8F', sku: '111881', desc: 'Chicken Pulled Cooked' },
  { loc: 'F8F17-1A', bay: '8F', sku: '111120', desc: 'Strawberry Whole Unswt IQF' },
]

function num(v) { return Number(v ?? 0) || 0 }

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

    const locList = DESIGNATED_LOCATIONS.map(d => `'${d.loc}'`).join(',')
    const skuList = DESIGNATED_LOCATIONS.map(d => `'${d.sku}'`).join(',')

    const [occupancyRows, pullRows] = await Promise.all([
      runQuery(`
        SELECT
          loc.location_container_name AS location,
          m.lookup_code AS actual_sku,
          m.Description AS actual_desc,
          p.project_id,
          p.project_name AS actual_project,
          SUM(lpc.packaged_amount) AS qty
        FROM production_db.silver.datex_slv_licenseplates lp
        JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
        JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
        JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
        JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
        WHERE loc.location_container_name IN (${locList})
          AND (lp.Archived IS NULL OR lp.Archived = false)
        GROUP BY loc.location_container_name, m.lookup_code, m.Description, p.project_id, p.project_name
        ORDER BY loc.location_container_name
      `),
      // Pull-from: real reserve locations currently holding each designated SKU, outside the
      // 34 primary positions themselves and outside transient staging ("Door %"). Top 3 per SKU
      // by quantity — fewest physical moves to complete the reslot, not a travel-distance ranking
      // (DPI's freezer aisle doesn't have WR's established furthest-aisle-first convention).
      runQuery(`
        SELECT sku, location, qty, rn FROM (
          SELECT
            m.lookup_code AS sku,
            loc.location_container_name AS location,
            SUM(lpc.packaged_amount) AS qty,
            ROW_NUMBER() OVER (PARTITION BY m.lookup_code ORDER BY SUM(lpc.packaged_amount) DESC) AS rn
          FROM production_db.silver.datex_slv_licenseplates lp
          JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
          JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
          JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
          JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
          WHERE m.lookup_code IN (${skuList}) AND m.project_id = ${DPI_PROJECT_ID}
            AND (lp.Archived IS NULL OR lp.Archived = false)
            AND loc.location_container_name NOT IN (${locList})
            AND loc.location_container_name NOT ILIKE 'Door%'
          GROUP BY m.lookup_code, loc.location_container_name
        ) ranked
        WHERE rn <= 3
        ORDER BY sku, rn
      `),
    ])

    try { conn.close(); db.close() } catch (_) {}

    // Group actual occupancy by location — a location can hold >1 SKU
    const actualByLoc = {}
    for (const r of occupancyRows) {
      if (!actualByLoc[r.location]) actualByLoc[r.location] = []
      actualByLoc[r.location].push({
        sku: r.actual_sku,
        desc: r.actual_desc,
        project: r.actual_project,
        isDpi: num(r.project_id) === DPI_PROJECT_ID,
        qty: num(r.qty),
      })
    }

    const pullBySku = {}
    for (const r of pullRows) {
      if (!pullBySku[r.sku]) pullBySku[r.sku] = []
      pullBySku[r.sku].push({ loc: r.location, qty: num(r.qty) })
    }

    const positions = DESIGNATED_LOCATIONS.map(d => {
      const actual = actualByLoc[d.loc] || []
      const skus = actual.map(a => a.sku)
      let level
      if (skus.length === 1 && skus[0] === d.sku) level = 'match'
      else if (actual.some(a => !a.isDpi)) level = 'other_customer'
      else if (actual.length === 0) level = 'empty'
      else level = 'wrong_dpi'
      return { ...d, actual, level, pullFrom: pullBySku[d.sku] || [] }
    })

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        positions,
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
