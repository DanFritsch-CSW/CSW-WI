'use strict'

// Space Planning — per-AISLE live occupancy breakdown (Phase 4b).
//
// Companion to space-per-room-projects.cjs, which drills room -> project.
// This drills one level deeper: room -> aisle -> project, using the same
// Datex path hierarchy discovered 2026-07-24 (root/room/aisle_container/bay
// — path segment 4 is the aisle container, matching space_room_aisles's
// datex_aisle_location_id). Confirmed live 2026-07-25 before building this:
// aisles routinely mix MULTIPLE customers together (e.g. F8's G aisle has
// 5 different projects with active LPs) — this is exactly why room/aisle
// capacity stays a min–max RANGE rather than resolving to one number; there's
// no way to know which specific bay within an aisle a given customer's
// product sits in, only which aisle-container as a whole.
//
// Input  (POST JSON):  { facility: 'mad' }
// Output (JSON):       { perAisle: { [aisle_container_id]: [
//                          { projectName, lps }, ...
//                        ] }, fetchedAt, elapsedMs, source: 'motherduck', warehouseId }
//
// Currently MAD-only, same scope/whitelist as space-per-room.cjs. No pallet
// estimate here (unlike the room-level version) — Dan's scope for this round
// (2026-07-25) is visibility only: which customers are in which aisle right
// now, by LP count. Pallet-equivalent estimate can be added later if needed.

process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const FACILITY_TO_WAREHOUSE = {
  mad: 4,
}
const FACILITY_ROOT_LOCATION_ID = {
  mad: 7106,
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

  let facility
  try {
    ;({ facility } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const warehouseId = FACILITY_TO_WAREHOUSE[facility]
  const rootLocationId = FACILITY_ROOT_LOCATION_ID[facility]
  if (!warehouseId || !rootLocationId) {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: 'not_supported',
        message: `Facility '${facility}' not scoped for per-aisle occupancy yet. Only MAD is live.`,
      }),
    }
  }

  const sql = `
    WITH loc_to_aisle AS (
      SELECT
        lc.location_container_id,
        TRY_CAST(SPLIT_PART(lc.path, '/', 3) AS INTEGER) AS room_id,
        TRY_CAST(SPLIT_PART(lc.path, '/', 4) AS INTEGER) AS aisle_container_id
      FROM production_db.silver.datex_slv_locationcontainers lc
      WHERE lc.warehouse_id = ${warehouseId}
        AND lc.parent_id IS NOT NULL
    ),
    lp_aisle AS (
      SELECT lp.license_plate_id, la.room_id, la.aisle_container_id
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN loc_to_aisle la ON la.location_container_id = lp.location_id
      WHERE lp.archived = false
        AND lp.warehouse_id = ${warehouseId}
        AND la.aisle_container_id IS NOT NULL
    )
    SELECT
      la.aisle_container_id,
      COALESCE(p.project_name, 'Unassigned') AS project_name,
      COUNT(DISTINCT lpc.license_plate_id)::BIGINT AS lps
    FROM production_db.silver.datex_slv_licenseplatecontents lpc
    JOIN lp_aisle la ON la.license_plate_id = lpc.license_plate_id
    JOIN production_db.silver.datex_slv_lots l ON l.lot_id = lpc.lot_id
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = l.material_id
    LEFT JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
    GROUP BY la.aisle_container_id, project_name
    ORDER BY la.aisle_container_id, lps DESC
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

    const perAisle = {}
    for (const r of rows) {
      const aisleId = Number(r.aisle_container_id)
      if (!perAisle[aisleId]) perAisle[aisleId] = []
      perAisle[aisleId].push({
        projectName: r.project_name,
        lps: Number(r.lps) || 0,
      })
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        perAisle,
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
