'use strict'

// MotherDuck inventory proxy.
// Token is passed via motherduck_token env var — NOT in the ATTACH connection string.
// The MotherDuck extension reads the env var automatically after LOAD.

const zlib = require('zlib')

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

  // 2026-08-27, first pass (query restructure): was previously a FULL JOIN
  // between the entire company-wide licenseplates table and the entire
  // company-wide locationcontainers table (59,590 rows across all 5
  // warehouses), filtered down to one warehouse only in the outer WHERE
  // clause. Rewritten to resolve the target warehouse's locations FIRST
  // (the `locs` CTE below), then join license plates only against that
  // already-filtered location set — bounds the join to one facility's
  // location count instead of the company-wide total. Also switched FULL
  // JOIN -> JOIN since the frontend (src/lib/omniInventory.js's
  // buildLocationMap) already discards every row lacking both an lp and a
  // locationName. Verified functionally identical to the old query shape:
  // both returned exactly 36,638 rows for CSW-Franksville.
  // THIS FIRST PASS DID NOT FIX THE REAL BUG — see below.
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

    const responseBody = JSON.stringify({
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
    })

    // FIXED 2026-08-27, SECOND PASS -- the actual bug: the query-restructure
    // fix above was a real improvement but never the fix for the reported
    // 502s. The real error (only visible in the function's own response
    // body, confirmed live by Dan pulling it from DevTools' Network tab):
    //   Function.ResponseSizeTooLarge -- "Response payload size exceeded
    //   maximum allowed payload size (6291556 bytes)"
    // CAL's ~36,638-row inventory response, as raw JSON, lands right at
    // Netlify Functions' ~6MB synchronous-response ceiling (inherited from
    // AWS Lambda). WR (~6,796 rows) and EC (~8,056 rows) stay comfortably
    // under it -- same root cause (CAL's much larger inventory volume)
    // as the timeout investigation, but a completely different failure
    // mode than a slow query: the query was already fast, the RESPONSE
    // was just too big to send back.
    // Fix: gzip the JSON body before returning it, base64-encoded with
    // isBase64Encoded:true and a Content-Encoding:gzip header -- standard
    // Netlify/Lambda pattern for compressed sync responses. Browsers'
    // fetch() decompresses gzip transparently based on that header, so
    // src/lib/omniInventory.js needed zero changes. JSON like this
    // (highly repetitive keys/values) typically compresses 80-90%+,
    // which puts CAL's response well under the limit with real margin
    // to spare -- not just barely under it.
    const gzipped = zlib.gzipSync(Buffer.from(responseBody, 'utf8'))

    return {
      statusCode: 200,
      headers: { ...NO_CACHE_HEADERS, 'Content-Encoding': 'gzip' },
      body: gzipped.toString('base64'),
      isBase64Encoded: true,
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
