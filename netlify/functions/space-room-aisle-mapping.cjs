'use strict'

// Space Planning — Datex aisle container lookup for one room (Phase 4a fix,
// 2026-07-25).
//
// Root cause this fixes: aisles added via SpacePlanningTab's "+ Add aisle"
// button (AisleAddRow) only ever set aisle_label — there was no field to
// enter datex_aisle_location_id, so every aisle added through the UI (not
// hand-fixed via direct SQL, like F8 was during the original Phase 4a build)
// silently has datex_aisle_location_id = null forever. That breaks the
// Phase 4b stacking-adjusted utilization math (computeEffectiveRoomOccupancy
// skips any aisle with no Datex link, so ALL of that room's LPs fall into
// the "unaccounted" 1:1 bucket — utilization silently reverts to the raw,
// unadjusted ratio with no error or warning). Confirmed exactly this way on
// F7 (2026-07-25): 9 aisles, all null, 103% utilization identical to the
// raw un-adjusted ratio.
//
// This function returns each of a room's direct child aisle containers with
// their `short_name` (confirmed live: matches the aisle_label convention
// exactly, e.g. F7's aisles are literally named short_name='E', 'F', 'G'...)
// so the client can match by label and bulk-link in one pass, instead of
// requiring a hand-run SQL UPDATE per room.
//
// Input  (POST JSON):  { facility: 'mad', roomDatexLocationId: 18455 }
// Output (JSON):       { aisles: [ { locationContainerId, shortName, name } ] }

process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const FACILITY_TO_WAREHOUSE = {
  mad: 4,
}

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

  let facility, roomDatexLocationId
  try {
    ;({ facility, roomDatexLocationId } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const warehouseId = FACILITY_TO_WAREHOUSE[facility]
  if (!warehouseId) {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: 'not_supported',
        message: `Facility '${facility}' not scoped for aisle mapping yet. Only MAD is live.`,
      }),
    }
  }
  const roomId = Number(roomDatexLocationId)
  if (!Number.isFinite(roomId)) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'roomDatexLocationId is required' }) }
  }

  const sql = `
    SELECT
      location_container_id,
      location_container_name,
      short_name
    FROM production_db.silver.datex_slv_locationcontainers
    WHERE warehouse_id = ${warehouseId}
      AND parent_id = ${roomId}
    ORDER BY location_container_name
  `

  let db, conn
  try {
    process.env.HOME = '/tmp'
    process.env.motherduck_token = TOKEN
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (s) => new Promise((resolve, reject) => {
      conn.run(s, err => err ? reject(err) : resolve())
    })
    const runQuery = (s) => new Promise((resolve, reject) => {
      conn.all(s, (err, result) => err ? reject(err) : resolve(result))
    })

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const rows = await runQuery(sql)
    try { conn?.close(); db?.close() } catch (_) {}

    const aisles = rows.map(r => ({
      locationContainerId: Number(r.location_container_id),
      shortName: (r.short_name || '').trim(),
      name: (r.location_container_name || '').trim(),
    }))

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        aisles,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        source: 'motherduck',
        warehouseId,
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
        elapsedMs: Date.now() - t0,
      }),
    }
  }
}
