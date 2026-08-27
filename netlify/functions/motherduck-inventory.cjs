'use strict'

// MotherDuck inventory proxy.
// Token is passed via motherduck_token env var — NOT in the ATTACH connection string.
// The MotherDuck extension reads the env var automatically after LOAD.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const WAREHOUSE_MAP = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

exports.handler = async (event) => {
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

  let facilityId, includeEmpty
  try {
    ;({ facilityId, includeEmpty } = JSON.parse(event.body))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const whName = WAREHOUSE_MAP[facilityId]
  if (!whName) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Unknown facilityId: ${facilityId}` }) }
  }

  const safe = whName.replace(/'/g, "''")

  // FIXED 2026-08-27: was previously a FULL JOIN between the entire
  // company-wide licenseplates table and the entire company-wide
  // locationcontainers table (59,590 rows across all 5 warehouses),
  // filtered down to one warehouse only in the outer WHERE clause. That
  // meant every call — regardless of which facility was requested — had
  // to materialize the full cross-warehouse join before narrowing to one
  // facility. Caledonia/Franksville has ~5x Wisconsin Rapids' and ~4.5x
  // Eau Claire's inventory volume (confirmed live: 36,302 active LPs vs.
  // 6,796 / 8,056), which combined with this function's missing `timeout
  // = 26` in netlify.toml (every sibling motherduck-*.cjs function has
  // this, this one didn't) meant CAL's runs were the ones most likely to
  // exceed Netlify's short default timeout and come back as a 502.
  // Root-caused via a direct row-count/location-count comparison across
  // all 5 warehouses in MotherDuck before touching anything.
  //
  // Fix: resolve the target warehouse's locations FIRST (the `locs` CTE
  // below), then join license plates only against that already-filtered
  // location set. This pushes the warehouse filter to the start of the
  // plan instead of the end, so the join surface is bounded by the one
  // facility's location count (e.g. ~20K for CAL) instead of the
  // company-wide 59,590. Also switched FULL JOIN -> JOIN: the frontend
  // (src/lib/omniInventory.js's buildLocationMap) already discards every
  // row that lacks both an lp and a locationName, so the FULL JOIN's
  // location-with-no-LP rows were pure wasted computation — empty
  // locations are already handled separately via emptyLocSql below.
  // Verified functionally identical before shipping: ran both the old
  // and new query shapes live against MotherDuck for CSW-Franksville —
  // both returned exactly 36,638 rows.
  const inventorySql = `
    WITH wh AS (
      SELECT warehouse_id
      FROM production_db.silver.datex_slv_warehouses
      WHERE warehouse_name = '${safe}'
    ),
    locs AS (
      SELECT loc.location_container_id, loc.location_container_name
      FROM production_db.silver.datex_slv_locationcontainers loc
      JOIN wh ON loc.warehouse_id = wh.warehouse_id
    )
    SELECT
      lp.lookup_code                     AS lp_code,
      locs.location_container_name       AS location_name,
      COALESCE(lpc.packaged_amount, 0)   AS qty,
      COALESCE(m.lookup_code,  '')       AS material_code,
      COALESCE(NULLIF(m.Description, ''), m.material_name, '') AS material_description,
      COALESCE(vl.lookup_code, '')       AS vendor_lot,
      COALESCE(sl.lookup_code, '')       AS sys_lot
    FROM locs
    JOIN production_db.silver.datex_slv_licenseplates lp
          ON lp.location_id = locs.location_container_id
         AND NOT lp.archived
    LEFT JOIN production_db.silver.datex_slv_licenseplatecontents lpc
          ON lp.license_plate_id = lpc.license_plate_id
    LEFT JOIN production_db.silver.datex_slv_lots sl
          ON lpc.lot_id = sl.lot_id
    LEFT JOIN production_db.silver.datex_slv_vendorlots vl
          ON sl.vendor_lot_id = vl.vendor_lot_id
    LEFT JOIN production_db.silver.datex_slv_materials m
          ON sl.material_id = m.material_id
    ORDER BY locs.location_container_name, lp.lookup_code
  `

  const emptyLocSql = `
    SELECT loc.location_container_name AS location_name
    FROM production_db.silver.datex_slv_locationcontainers loc
    LEFT JOIN production_db.silver.datex_slv_warehouses wh
          ON loc.warehouse_id = wh.warehouse_id
    WHERE wh.warehouse_name = '${safe}'
    ORDER BY loc.location_container_name
  `

  let db, conn
  try {
    // HOME=/tmp so MotherDuck C++ init has a writable path for extension files
    process.env.HOME             = '/tmp'
    // motherduck_token env var is read automatically by the extension after LOAD
    process.env.motherduck_token = TOKEN

    const duckdb = require('duckdb')

    db   = new duckdb.Database(':memory:')
    conn = db.connect()

    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', err => err ? reject(err) : resolve())
    })

    // ATTACH using just the database name — token comes from env var, not the string
    await new Promise((resolve, reject) => {
      conn.run(
        "ATTACH 'md:production_db' AS production_db (READ_ONLY)",
        err => err ? reject(err) : resolve()
      )
    })

    const inventoryRows = await new Promise((resolve, reject) => {
      conn.all(inventorySql, (err, result) => err ? reject(err) : resolve(result))
    })

    let emptyRows = []
    if (includeEmpty) {
      emptyRows = await new Promise((resolve, reject) => {
        conn.all(emptyLocSql, (err, result) => err ? reject(err) : resolve(result))
      })
    }

    conn.close()
    db.close()

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        inventoryRows: inventoryRows.map(r => ({
          lp:                  String(r.lp_code              || ''),
          locationName:        String(r.location_name        || ''),
          qty:                 Number(r.qty)                  || 0,
          materialCode:        String(r.material_code        || ''),
          materialDescription: String(r.material_description || ''),
          vendorLot:           String(r.vendor_lot           || ''),
          sysLot:              String(r.sys_lot              || ''),
        })),
        emptyLocations: emptyRows.map(r => String(r.location_name || '')).filter(Boolean),
      }),
    }
  } catch (e) {
    try { if (conn) conn.close() } catch {}
    try { if (db)   db.close()   } catch {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 800) }),
    }
  }
}
