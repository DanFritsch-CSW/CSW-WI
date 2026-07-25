'use strict'

// Space Planning — per-room, per-PROJECT live occupancy breakdown.
//
// Companion to space-per-room.cjs (which returns room-level LP totals only).
// This drills one level deeper: within each room, which projects/customers
// are occupying it right now, with a pallet-equivalent estimate instead of
// raw LP count (a single deep-lane location can hold 100+ LPs, so raw LP
// count is a poor proxy for physical space consumed).
//
// Input  (POST JSON):  { facility: 'mad' }
// Output (JSON):       { perRoom: { [room_id]: [ {
//                          projectName, lps, estPallets, casesNoPalletData
//                        }, ... ] },
//                        fetchedAt, elapsedMs, source: 'motherduck', warehouseId }
//
// Currently MAD-only, same scope/whitelist as space-per-room.cjs.
//
// ── Pallet-equivalent calc + a real data-quality gap found live ────────────
// estPallets = SUM(packaged_amount / (pallet_tie * pallet_high)) from
// silver.datex_slv_materialspackagingslookup, joined on (material_id,
// packaging_id). BUT: confirmed live against MAD data that ~33% of on-hand
// LPs carry pallet_tie=1 AND pallet_high=1 on their base packaging — not a
// real "1 case per pallet" configuration, just Datex's default when no
// case-level packaging record exists for that material (confirmed example:
// Saputo Finished Goods LPs with packaged_amount ~2,400 against tie=1×high=1,
// which would compute as ~2,400 "pallets" — nonsense). Treating tie=1&high=1
// the same as missing/null: those cases fall into `casesNoPalletData`
// instead of a garbage pallet estimate. Real, usable tie/high (product of
// >1) covers ~63% of on-hand LPs at MAD as of this build — similar order of
// magnitude to the ~86-92% order-line-level coverage documented elsewhere on
// this project, but lower here because this joins at the physical LP/lot
// level rather than the order-line level.
//
// ── duckdb / MotherDuck init pattern ────────────────────────────────────────
// Same as space-per-room.cjs / motherduck-l4w.cjs.

process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Mirrors space-per-room.cjs — only facilities with a seeded room list +
// Datex path mapping are supported.
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
        message: `Facility '${facility}' not scoped for per-room project breakdown yet. Only MAD is live.`,
      }),
    }
  }

  const sql = `
    WITH loc_to_room AS (
      SELECT
        lc.location_container_id,
        TRY_CAST(SPLIT_PART(lc.path, '/', 3) AS INTEGER) AS room_id
      FROM production_db.silver.datex_slv_locationcontainers lc
      WHERE lc.warehouse_id = ${warehouseId}
        AND lc.parent_id IS NOT NULL
    ),
    lp_room AS (
      SELECT lp.license_plate_id, lr.room_id
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN loc_to_room lr ON lr.location_container_id = lp.location_id
      WHERE lp.archived = false
        AND lp.warehouse_id = ${warehouseId}
        AND lr.room_id IS NOT NULL
    ),
    contents AS (
      SELECT
        lpc.license_plate_id,
        lpr.room_id,
        lpc.packaged_amount,
        COALESCE(p.project_name, 'Unassigned') AS project_name,
        pk.pallet_tie,
        pk.pallet_high
      FROM production_db.silver.datex_slv_licenseplatecontents lpc
      JOIN lp_room lpr ON lpr.license_plate_id = lpc.license_plate_id
      JOIN production_db.silver.datex_slv_lots l ON l.lot_id = lpc.lot_id
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = l.material_id
      LEFT JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
      LEFT JOIN production_db.silver.datex_slv_materialspackagingslookup pk
        ON pk.material_id = l.material_id AND pk.packaging_id = lpc.packaged_id
    )
    SELECT
      room_id,
      project_name,
      COUNT(DISTINCT license_plate_id)::BIGINT AS lps,
      SUM(
        CASE WHEN pallet_tie IS NOT NULL AND pallet_high IS NOT NULL AND (pallet_tie * pallet_high) > 1
          THEN packaged_amount / (pallet_tie * pallet_high)
          ELSE 0
        END
      ) AS est_pallets,
      SUM(
        CASE WHEN pallet_tie IS NULL OR pallet_high IS NULL OR (pallet_tie * pallet_high) <= 1
          THEN packaged_amount
          ELSE 0
        END
      ) AS cases_no_pallet_data
    FROM contents
    GROUP BY room_id, project_name
    ORDER BY room_id, est_pallets DESC
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

    const perRoom = {}
    for (const r of rows) {
      const roomId = Number(r.room_id)
      if (!perRoom[roomId]) perRoom[roomId] = []
      perRoom[roomId].push({
        projectName: r.project_name,
        lps: Number(r.lps) || 0,
        estPallets: Math.round((Number(r.est_pallets) || 0) * 10) / 10,
        casesNoPalletData: Math.round(Number(r.cases_no_pallet_data) || 0),
      })
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        perRoom,
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
