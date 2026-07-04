'use strict'

// Space Planning — per-room live LP counts.
//
// Input  (POST JSON):  { facility: 'mad' }
// Output (JSON):       { perRoom: [{ datex_top_location_id, active_lps }],
//                        totals: { active_lps, distinct_rooms },
//                        fetchedAt, elapsedMs, source: 'motherduck', warehouseId }
//
// Currently scoped to MAD only (per Phase 3 rollout). Other facilities return
// { error: 'not_supported' } — extending to CAL/KEN/WR/EC just means adding
// them to FACILITY_TO_WAREHOUSE below AND seeding rooms with
// `datex_top_location_id` for those facilities in space_rooms.
//
// The per-room count is a PHYSICAL LP count (archived=false, warehouse_id=N),
// NOT the project-joined count that Network scorecards use via
// fetchActiveInventory. These will not sum to the same number — the Network
// number filters out internal/unassigned LPs via an Omni model join, while
// this endpoint reports the physical truth of what's in each room. Both are
// useful, they measure different things. Documented in the UI footnote.
//
// ── duckdb / MotherDuck init pattern ────────────────────────────────────────
// Same as motherduck-l4w.cjs / fefo-orders.cjs. See top comment in
// motherduck-l4w.cjs for the full rationale + the 5-round debug journey.

// Set HOME before requiring duckdb — duckdb reads it at load time.
process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Datex warehouse_id per facility. Mirrors userMemories mapping.
// Only facilities listed here are supported; extend when the room list
// gets seeded for other facilities.
const FACILITY_TO_WAREHOUSE = {
  mad: 4,
  // cal: 1,  // Franksville — Phase 3 not yet scoped
  // ec:  3,
  // ken: 5,
  // wr:  6,
}

// Datex top-level container ID per facility (parent of all rooms).
// Path traversal walks up to this to identify which room a location belongs to.
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
        message: `Facility '${facility}' not scoped for per-room breakdown yet. Only MAD is live in Phase 3.`,
      }),
    }
  }

  // Query: map each non-top-level location under /<rootLocationId>/ to its
  // top-level room via path splitting, then count distinct archived=false
  // license plates per room. Warehouse-scoped so nothing leaks across sites.
  //
  // Path format: '/7106/18449/...' — SPLIT_PART on '/' gives the room segment.
  // Position 3 is the top-level room id (position 1 is empty due to leading /,
  // position 2 is the warehouse root, position 3 is the room).
  const sql = `
    WITH loc_to_room AS (
      SELECT
        lc.location_container_id,
        TRY_CAST(SPLIT_PART(lc.path, '/', 3) AS INTEGER) AS room_id
      FROM production_db.silver.datex_slv_locationcontainers lc
      WHERE lc.warehouse_id = ${warehouseId}
        AND lc.parent_id IS NOT NULL
    )
    SELECT
      lr.room_id AS datex_top_location_id,
      COUNT(DISTINCT lp.license_plate_id)::BIGINT AS active_lps
    FROM production_db.silver.datex_slv_licenseplates lp
    JOIN loc_to_room lr ON lr.location_container_id = lp.location_id
    WHERE lp.archived = false
      AND lp.warehouse_id = ${warehouseId}
      AND lr.room_id IS NOT NULL
    GROUP BY lr.room_id
    ORDER BY active_lps DESC
  `

  let db, conn
  try {
    // See top comment in motherduck-l4w.cjs for why this exact sequence.
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

    const perRoom = rows.map(r => ({
      datex_top_location_id: Number(r.datex_top_location_id),
      active_lps: Number(r.active_lps) || 0,
    }))
    const totals = {
      active_lps: perRoom.reduce((s, r) => s + r.active_lps, 0),
      distinct_rooms: perRoom.length,
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        perRoom,
        totals,
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
