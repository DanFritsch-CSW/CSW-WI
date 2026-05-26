'use strict'

// MotherDuck inventory proxy — replaces Omni for location contents.
// Queries silver.datex_slv_* directly for accurate, fast results.
// Bypasses Omni's measure aggregation issue (packaged_amount fan-out).
// Uses same duckdb pattern as motherduck-labor.cjs.

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

  // Primary query: occupied locations — all LP content rows for this warehouse
  const inventorySql = `
    SELECT
      lp.lookup_code                    AS lp_code,
      loc.location_container_name       AS location_name,
      lpc.packaged_amount               AS qty,
      m.lookup_code                     AS material_code,
      vl.lookup_code                    AS vendor_lot,
      sl.lookup_code                    AS sys_lot
    FROM production_db.silver.datex_slv_licenseplates lp
    LEFT JOIN production_db.silver.datex_slv_licenseplatecontents lpc
          ON lp.license_plate_id = lpc.license_plate_id
    FULL JOIN production_db.silver.datex_slv_locationcontainers loc
          ON lp.location_id = loc.location_container_id
    LEFT JOIN production_db.silver.datex_slv_warehouses wh
          ON loc.warehouse_id = wh.warehouse_id
    LEFT JOIN production_db.silver.datex_slv_lots sl
          ON lpc.lot_id = sl.lot_id
    LEFT JOIN production_db.silver.datex_slv_vendorlots vl
          ON sl.vendor_lot_id = vl.vendor_lot_id
    LEFT JOIN production_db.silver.datex_slv_materials m
          ON sl.material_id = m.material_id
    WHERE NOT lp.archived
      AND wh.warehouse_name = '${whName.replace(/'/g, "''")}'
    ORDER BY loc.location_container_name, lp.lookup_code
  `

  // Empty locations query — only runs if includeEmpty=true
  const emptyLocSql = `
    SELECT loc.location_container_name AS location_name
    FROM production_db.silver.datex_slv_locationcontainers loc
    LEFT JOIN production_db.silver.datex_slv_warehouses wh
          ON loc.warehouse_id = wh.warehouse_id
    WHERE wh.warehouse_name = '${whName.replace(/'/g, "''")}'
    ORDER BY loc.location_container_name
  `

  try {
    process.env.motherduck_token = TOKEN
    const duckdb = require('duckdb')
    const db   = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
    const conn = db.connect()

    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', err => err ? reject(err) : resolve())
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
          lp:           String(r.lp_code       || ''),
          locationName: String(r.location_name || ''),
          qty:          Number(r.qty)           || 0,
          materialCode: String(r.material_code || ''),
          vendorLot:    String(r.vendor_lot    || ''),
          sysLot:       String(r.sys_lot       || ''),
        })),
        emptyLocations: emptyRows.map(r => String(r.location_name || '')).filter(Boolean),
      }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }),
    }
  }
}
