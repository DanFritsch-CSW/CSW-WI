'use strict'

// WR Pick Location Lot Check backend (added 2026-07-14) -- Dan's real ask,
// captured on a recorded call with Kaylee: for every Bernatello's material,
// is the OLDEST on-hand lot (by vendor lot expiration date, same field the
// 120-day Omni "aging" report uses) actually sitting in a primary pick
// location right now? If a newer lot occupies the primary slot while the
// true oldest lot is stuck in secondary/reserve, 2nd shift replenishers
// under time pressure grab whatever's convenient instead of pulling
// inquiry -- which is what's driving the lot errors / hard-move / refund-
// task problem Kaylee described. This is a daily verification check, not
// an enforcement/blocking mechanism.
//
// -- Key discovery this session (verified live before building):
// Datex's `silver.datex_slv_locationcontainers.is_primary_pick` is a real,
// native boolean flag per location -- NOT something we need to hand-derive
// from a static Excel export. This replaces the originally-planned
// "material -> location" map parsed from Dan's Pickline_Layout.xlsx
// entirely: that file was a point-in-time snapshot (confirmed stale live --
// e.g. P111A held material 61151 in the file but material 47002 live).
// Location-to-material "ownership" is NOT fixed 1:1; whatever LP is
// physically in an is_primary_pick location IS that slot's live assignment,
// and it changes as pallets get repositioned. There is no
// materials.preferred_location_id-style static mapping in Datex (checked
// materials table columns -- only number_of_primary_pick_locations_allowed
// _per_warehouse exists, which is a config limit, not an assignment).
//
// -- Query shape:
// 1. onhand: every on-hand lot for Bernatello's (project_id=320), warehouse
//    6, active (non-archived) LPs, excluding the same status_ids the Omni
//    120-day report excludes (2015, 2012) -- with is_primary_pick carried
//    per row from the joined location.
// 2. oldest_lot: per material, the single lot with the earliest vendor lot
//    expiration_date (same source field as the 120-day report -- NOT
//    licenseplatecontents.expiration_date, which is null on every row
//    checked; the real value lives on datex_slv_vendorlots).
// 3. oldest_lot_cases: cases of that specific oldest lot broken out by
//    primary vs secondary location.
// 4. primary_presence: whether the material has ANY on-hand stock sitting
//    in an is_primary_pick location right now (any lot, not just oldest).
// 5. Classify:
//    - no_location: material has zero on-hand stock in any primary-pick
//      location at all right now. Ambiguous by design -- could mean this
//      material has no primary slot in this warehouse, or its slot is
//      simply empty between restocks. Flagged distinctly, not conflated
//      with "mismatch."
//    - mismatch: material has stock in a primary location, but the oldest
//      lot isn't among it (oldest lot has 0 cases in any primary slot) --
//      a newer lot is what's actually in the pick line.
//    - ok: the oldest lot has at least some cases sitting in a primary
//      pick location right now.
//
// -- Validated live 2026-07-14 (Bernatello's, warehouse 6): 111 materials
// with on-hand stock -> 86 ok / 14 mismatch / 11 no_location. Confirmed
// example: material 62103 (Brew Pub Patriot Mac & Bacon Pizza) had its
// single on-hand lot split across 4 secondary locations (G076B/C/D,
// G079A), zero in any primary slot -- classifies as no_location, not
// mismatch, since there's no primary-slot presence to compare against.
//
// POST body: {} (no params needed -- this is a live "right now" snapshot,
// not date-scoped like the appointment/labor tabs).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECT_ID = 320   // Bernatello's - Wisconsin Rapids
const WAREHOUSE_ID = 6   // WR
const EXCLUDED_STATUS_IDS = [2015, 2012] // same exclusion the 120-day Omni report uses

function num(v) { return Number(v ?? 0) || 0 }

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

    const sql = `
      WITH onhand AS (
        SELECT DISTINCT
          m.material_id, m.lookup_code AS material_code, m.Description AS material_name,
          lot.lot_id, lot.lookup_code AS lot_code,
          vl.lookup_code AS vendor_lot_code,
          vl.expiration_date,
          lpc.Amount AS cases,
          loc.location_container_name AS location_name,
          loc.is_primary_pick
        FROM production_db.silver.datex_slv_materials m
        JOIN production_db.silver.datex_slv_lots lot ON lot.material_id = m.material_id
        JOIN production_db.silver.datex_slv_vendorlots vl ON vl.vendor_lot_id = lot.vendor_lot_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.lot_id = lot.lot_id
        JOIN production_db.silver.datex_slv_licenseplates lp ON lp.license_plate_id = lpc.license_plate_id
        JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
        WHERE m.project_id = ${PROJECT_ID}
          AND lp.Archived = false
          AND lp.warehouse_id = ${WAREHOUSE_ID}
          AND lpc.Amount > 0
          AND lot.status_id NOT IN (${EXCLUDED_STATUS_IDS.join(',')})
      ),
      oldest_lot AS (
        SELECT material_id, lot_id, lot_code, vendor_lot_code, expiration_date,
          ROW_NUMBER() OVER (PARTITION BY material_id ORDER BY expiration_date ASC NULLS LAST) AS rn
        FROM (SELECT DISTINCT material_id, lot_id, lot_code, vendor_lot_code, expiration_date FROM onhand)
      ),
      oldest_lot_cases AS (
        SELECT
          o.material_id,
          ol.lot_code AS oldest_lot_code,
          ol.vendor_lot_code AS oldest_vendor_lot_code,
          ol.expiration_date AS oldest_expiration_date,
          SUM(CASE WHEN o.is_primary_pick THEN o.cases ELSE 0 END) AS cases_in_primary,
          SUM(CASE WHEN NOT o.is_primary_pick THEN o.cases ELSE 0 END) AS cases_in_secondary,
          STRING_AGG(DISTINCT CASE WHEN o.is_primary_pick THEN o.location_name END, ', ') AS primary_locations,
          STRING_AGG(DISTINCT CASE WHEN NOT o.is_primary_pick THEN o.location_name END, ', ') AS secondary_locations
        FROM onhand o
        JOIN oldest_lot ol ON ol.material_id = o.material_id AND ol.lot_id = o.lot_id AND ol.rn = 1
        GROUP BY o.material_id, ol.lot_code, ol.vendor_lot_code, ol.expiration_date
      ),
      primary_presence AS (
        SELECT DISTINCT material_id, location_name, lot_code, expiration_date, cases
        FROM onhand WHERE is_primary_pick = true
      ),
      -- Whatever lot currently sits in a primary slot, in case it differs from the oldest lot
      -- (used to show the picker what's actually in the line right now for a "mismatch" row).
      current_pick_lot AS (
        SELECT material_id,
          STRING_AGG(DISTINCT lot_code, ', ') AS current_lot_codes,
          MIN(expiration_date) AS current_earliest_expiration
        FROM primary_presence
        GROUP BY material_id
      )
      SELECT
        oc.material_id,
        m.lookup_code AS material_code,
        m.Description AS material_name,
        oc.oldest_lot_code,
        oc.oldest_vendor_lot_code,
        oc.oldest_expiration_date,
        oc.cases_in_primary,
        oc.cases_in_secondary,
        oc.primary_locations,
        oc.secondary_locations,
        cpl.current_lot_codes,
        cpl.current_earliest_expiration,
        CASE
          WHEN cpl.material_id IS NULL THEN 'no_location'
          WHEN oc.cases_in_primary > 0 THEN 'ok'
          ELSE 'mismatch'
        END AS status
      FROM oldest_lot_cases oc
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = oc.material_id
      LEFT JOIN current_pick_lot cpl ON cpl.material_id = oc.material_id
      ORDER BY
        CASE WHEN cpl.material_id IS NULL THEN 2 WHEN oc.cases_in_primary > 0 THEN 0 ELSE 1 END,
        oc.oldest_expiration_date ASC NULLS LAST
    `

    const rows = await runQuery(sql)

    try { conn.close(); db.close() } catch (_) {}

    const nowMs = Date.now()
    const materials = rows.map(r => {
      const exp = r.oldest_expiration_date ? new Date(r.oldest_expiration_date) : null
      const daysRemaining = exp ? Math.round((exp.getTime() - nowMs) / 86400000) : null
      return {
        materialId: r.material_id,
        materialCode: r.material_code,
        materialName: r.material_name,
        oldestLotCode: r.oldest_lot_code,
        oldestVendorLotCode: r.oldest_vendor_lot_code,
        oldestExpirationDate: r.oldest_expiration_date,
        daysRemaining,
        casesInPrimary: num(r.cases_in_primary),
        casesInSecondary: num(r.cases_in_secondary),
        primaryLocations: r.primary_locations || null,
        secondaryLocations: r.secondary_locations || null,
        currentLotCodes: r.current_lot_codes || null,
        status: r.status,
      }
    })

    const summary = {
      total: materials.length,
      ok: materials.filter(m => m.status === 'ok').length,
      mismatch: materials.filter(m => m.status === 'mismatch').length,
      noLocation: materials.filter(m => m.status === 'no_location').length,
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        materials,
        summary,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
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
