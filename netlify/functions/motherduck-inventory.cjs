'use strict'

// MotherDuck inventory proxy.
// Key Netlify serverless fixes:
//   - home_directory set in Database constructor config (not as SQL SET)
//     because LOAD motherduck calls its C++ init before SQL executes
//   - In-memory + ATTACH pattern avoids auth-at-construction error
//   - No INSTALL needed — motherduck bundled in duckdb npm package

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

  const inventorySql = `
    SELECT
      lp.lookup_code                     AS lp_code,
      loc.location_container_name        AS location_name,
      COALESCE(lpc.packaged_amount, 0)   AS qty,
      COALESCE(m.lookup_code,  '')       AS material_code,
      COALESCE(vl.lookup_code, '')       AS vendor_lot,
      COALESCE(sl.lookup_code, '')       AS sys_lot
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
      AND wh.warehouse_name = '${safe}'
    ORDER BY loc.location_container_name, lp.lookup_code
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
    process.env.motherduck_token = TOKEN

    const duckdb = require('duckdb')

    // Pass home_directory in constructor config — must be set before any extension
    // init runs. The MotherDuck C++ init function reads home dir at LOAD time,
    // so a SQL SET afterwards is too late.
    db   = new duckdb.Database(':memory:', { home_directory: '/tmp' })
    conn = db.connect()

    // Load MotherDuck extension (bundled in npm package, no INSTALL needed)
    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', err => err ? reject(err) : resolve())
    })

    // Attach production_db read-only with token
    await new Promise((resolve, reject) => {
      conn.run(
        `ATTACH 'md:production_db?motherduck_token=${TOKEN}' AS production_db (READ_ONLY)`,
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
    try { if (conn) conn.close() } catch {}
    try { if (db)   db.close()   } catch {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 800) }),
    }
  }
}
