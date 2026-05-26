'use strict'

// MotherDuck inventory proxy using the MotherDuck HTTP API.
// Switched from the duckdb Node package which had connection reliability issues
// ("Connection was never established or has been closed already") for large
// result sets in Netlify serverless functions.
// HTTP API is stateless, reliable, and requires no native bindings.

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

async function runMDQuery(token, sql) {
  const res = await fetch('https://api.motherduck.com/v1/databases/production_db/query', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MotherDuck HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  return res.json()
}

function parseRows(data) {
  // MotherDuck HTTP API returns { data: { columns: [...], rows: [[...]] } }
  if (!data?.data?.columns || !data?.data?.rows) return []
  const cols = data.data.columns.map(c => (typeof c === 'string' ? c : c.name))
  return data.data.rows.map(row => {
    const obj = {}
    cols.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
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

  // All LP content rows for this facility — raw SQL, no Omni aggregation
  const inventorySql = `
    SELECT
      lp.lookup_code                     AS lp_code,
      loc.location_container_name        AS location_name,
      COALESCE(lpc.packaged_amount, 0)   AS qty,
      COALESCE(m.lookup_code,  '')       AS material_code,
      COALESCE(vl.lookup_code, '')       AS vendor_lot,
      COALESCE(sl.lookup_code, '')       AS sys_lot
    FROM silver.datex_slv_licenseplates lp
    LEFT JOIN silver.datex_slv_licenseplatecontents lpc
          ON lp.license_plate_id = lpc.license_plate_id
    FULL JOIN silver.datex_slv_locationcontainers loc
          ON lp.location_id = loc.location_container_id
    LEFT JOIN silver.datex_slv_warehouses wh
          ON loc.warehouse_id = wh.warehouse_id
    LEFT JOIN silver.datex_slv_lots sl
          ON lpc.lot_id = sl.lot_id
    LEFT JOIN silver.datex_slv_vendorlots vl
          ON sl.vendor_lot_id = vl.vendor_lot_id
    LEFT JOIN silver.datex_slv_materials m
          ON sl.material_id = m.material_id
    WHERE NOT lp.archived
      AND wh.warehouse_name = '${safe}'
    ORDER BY loc.location_container_name, lp.lookup_code
  `

  const emptyLocSql = `
    SELECT loc.location_container_name AS location_name
    FROM silver.datex_slv_locationcontainers loc
    LEFT JOIN silver.datex_slv_warehouses wh
          ON loc.warehouse_id = wh.warehouse_id
    WHERE wh.warehouse_name = '${safe}'
    ORDER BY loc.location_container_name
  `

  try {
    // Always run inventory query
    const invData  = await runMDQuery(TOKEN, inventorySql)
    const invRows  = parseRows(invData)

    // Only run empty locations if requested (background phase)
    let emptyLocations = []
    if (includeEmpty) {
      const emptyData = await runMDQuery(TOKEN, emptyLocSql)
      emptyLocations  = parseRows(emptyData)
        .map(r => String(r.location_name || ''))
        .filter(Boolean)
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        inventoryRows: invRows.map(r => ({
          lp:           String(r.lp_code       || ''),
          locationName: String(r.location_name || ''),
          qty:          Number(r.qty)           || 0,
          materialCode: String(r.material_code || ''),
          vendorLot:    String(r.vendor_lot    || ''),
          sysLot:       String(r.sys_lot       || ''),
        })),
        emptyLocations,
      }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message }),
    }
  }
}
