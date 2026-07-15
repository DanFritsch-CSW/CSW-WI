'use strict'

// WR Pick Location Lot Check backend. First built 2026-07-14, refined
// twice more the same day after live validation with Dan + a recorded
// call with Kaylee. Real ask: for every Bernatello's material, is the
// OLDEST AVAILABLE on-hand lot (by vendor lot expiration date, same field
// the 120-day Omni "aging" report uses) actually sitting in the primary
// pick location right now? If not, is it staged in the secondaries
// (overhead rack directly above)? If not, it's out in the warehouse.
// Daily verification, not enforcement — nothing here blocks a pick.
//
// ── Location model (confirmed live, clarified by Dan) ──────────────────
// Every pickline ground slot (e.g. P029A, odd side / P034A, even side) is
// flagged `is_primary_pick=true` in Datex — a real, live, native flag, NOT
// derived from a static Excel export (an earlier plan to hand-parse Dan's
// Pickline_Layout.xlsx into a material->location map was scrapped after
// confirming live data had already drifted from that snapshot — location
// assignment is dynamic, whatever LP is physically in an is_primary_pick
// location IS that slot's current assignment). Some P-slots have a second
// level (P0xxB) that is ALSO is_primary_pick=true for higher zones.
//
// Directly above every P-slot sits an overhead reserve rack — NOT a
// primary location — named with a DIFFERENT letter prefix sharing the
// same 3-digit number, B/C/D suffix for the 3 shelf levels above:
//   - Odd-numbered P-slot (P029A) -> overhead rack is F029B/C/D
//   - Even-numbered P-slot (P034A) -> overhead rack is G034B/C/D
// Confirmed live across the full numeric range (1-67+). This is what Dan
// calls "secondaries" — where 2nd shift pulls the next pallet down from.
// It is NOT the same as "everywhere else in the warehouse" — a lot in an
// unrelated bulk/reserve location elsewhere is materially different (a
// bigger problem) than one staged directly above, ready to pull.
//
// ── Committed-cases netting (added after Dan's catch, same day) ────────
// Gross on-hand overstates what's actually available — Datex pick tasks
// reserve cases against a specific (location, lot) the moment they're
// Planned/Released, well before they're Completed, but
// licenseplatecontents still shows the full gross amount until the task
// executes. Netted per (expected_source_location_id, lot_id) using the
// same committed-cases-subtraction mechanism the KEN FEFO tab already
// uses (there it's lot-level warehouse-wide; here it's location+lot
// specific, since we need to know availability AT a specific slot, not
// just warehouse-wide). This flipped the picture materially — e.g. one
// material's "primary" classification turned out to be 100% committed
// stock, with the true oldest AVAILABLE lot sitting entirely in the
// warehouse instead.
//
// ── "Currently In Primary" is deliberately GROSS, not netted ────────────
// This column shows whichever lot is PHYSICALLY sitting in the primary
// slot right now, regardless of commitment status — a team member
// walking up to the slot sees a real pallet there even if every case on
// it is already committed to an order. Netting only applies to the
// available-cases math used for the primary/secondary/warehouse
// classification of the OLDEST lot, never to this display column. (Bug
// caught by Dan: a material showed "—" here despite Datex confirming a
// real 38-case pallet in the slot — turned out the location had 91 cases
// committed against only 38 physically present, netting it to 0 and
// silently dropping the row before it ever reached this column. Worth
// noting: 91 > 38 committed-vs-physical is itself a data-quality smell —
// likely stale Released tasks accumulating — flagged to Dan, not
// silently resolved here.)
//
// ── Classification per on-hand row, relative to whichever P-slot(s) a
// material currently occupies ──────────────────────────────────────────
//   - primary:   is_primary_pick = true
//   - secondary: NOT primary, but location matches the computed overhead
//                rack code(s) for that material's current primary slot(s)
//   - warehouse: NOT primary, NOT the computed overhead rack
//
// ── Status per material (available cases of the OLDEST on-hand lot) ────
//   - primary:   oldest available lot has cases in the primary slot
//   - secondary: oldest available lot has 0 cases in primary, but has
//                cases in the overhead rack (staged, ready to pull down)
//   - warehouse: oldest available lot has 0 cases in primary AND 0 in the
//                overhead rack — including materials with literally no
//                primary-slot presence at all right now (no anchor to
//                compute a secondary rack against, so it collapses to
//                warehouse rather than a separate ambiguous bucket)
//
// ── Scope: excludes non-food supply/equipment SKUs (lookup_code LIKE
// '99%' — pizza ovens, trays, POS kits, printer paper, cartons, etc,
// confirmed via a live catalog check) — mirrors the same exclusion the
// 120-day Omni aging report applies (screenshotted filter: "does not
// contain 995200,995201,9...").
//
// ── Aging severity — folded back in per Dan's request, so this one
// report can also drive customer communication (Bernatello's needs to
// know what's approaching expiration to sell through / ship). Same
// 120-day window and bands as the Omni report: Critical <30d,
// Warning 30-59d, Watch 60-119d, none >=120d.
//
// POST body: {} (no params — live "right now" snapshot, not date-scoped).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECT_ID = 320   // Bernatello's - Wisconsin Rapids
const WAREHOUSE_ID = 6   // WR
const EXCLUDED_STATUS_IDS = [2015, 2012] // same exclusion the 120-day Omni report uses

function num(v) { return Number(v ?? 0) || 0 }

function agingSeverity(daysRemaining) {
  if (daysRemaining == null) return null
  if (daysRemaining < 30) return 'critical'
  if (daysRemaining < 60) return 'warning'
  if (daysRemaining < 120) return 'watch'
  return null
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
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
      WITH committed AS (
        SELECT t.expected_source_location_id AS location_id, t.lot_id, SUM(t.expected_packaged_amount) AS committed_cases
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts ON ts.task_status_id = t.status_id
        WHERE ts.status_name IN ('Planned','Released')
        GROUP BY t.expected_source_location_id, t.lot_id
      ),
      onhand_raw AS (
        SELECT DISTINCT
          m.material_id, m.lookup_code AS material_code, m.Description AS material_name,
          lot.lot_id, lot.lookup_code AS lot_code, vl.expiration_date, lpc.Amount AS cases,
          loc.location_container_name AS location_name, loc.location_container_id, loc.is_primary_pick
        FROM production_db.silver.datex_slv_materials m
        JOIN production_db.silver.datex_slv_lots lot ON lot.material_id = m.material_id
        JOIN production_db.silver.datex_slv_vendorlots vl ON vl.vendor_lot_id = lot.vendor_lot_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.lot_id = lot.lot_id
        JOIN production_db.silver.datex_slv_licenseplates lp ON lp.license_plate_id = lpc.license_plate_id
        JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
        WHERE m.project_id = ${PROJECT_ID}
          AND m.lookup_code NOT ILIKE '99%'
          AND lp.Archived = false
          AND lp.warehouse_id = ${WAREHOUSE_ID}
          AND lpc.Amount > 0
          AND lot.status_id NOT IN (${EXCLUDED_STATUS_IDS.join(',')})
      ),
      -- GROSS current lot in primary -- deliberately independent of commitment
      -- netting, for the "Currently In Primary" display column.
      gross_current_primary AS (
        SELECT material_id, STRING_AGG(DISTINCT lot_code, ', ') AS current_lot_codes,
          STRING_AGG(DISTINCT location_name, ', ') AS current_primary_locations
        FROM (SELECT DISTINCT material_id, lot_code, location_name FROM onhand_raw WHERE is_primary_pick = true)
        GROUP BY material_id
      ),
      -- AVAILABLE on-hand (gross minus committed), netted per location+lot.
      -- Rows that net to zero are dropped -- this is what drives the
      -- primary/secondary/warehouse classification, NOT the display column above.
      onhand AS (
        SELECT o.material_id, o.material_code, o.material_name, o.lot_id, o.lot_code, o.expiration_date,
          o.location_name, o.is_primary_pick,
          GREATEST(SUM(o.cases) - COALESCE(MAX(c.committed_cases),0), 0) AS cases
        FROM onhand_raw o
        LEFT JOIN committed c ON c.location_id = o.location_container_id AND c.lot_id = o.lot_id
        GROUP BY o.material_id, o.material_code, o.material_name, o.lot_id, o.lot_code, o.expiration_date, o.location_name, o.is_primary_pick
        HAVING GREATEST(SUM(o.cases) - COALESCE(MAX(c.committed_cases),0), 0) > 0
      ),
      primary_nums AS (
        SELECT DISTINCT material_id, CAST(regexp_extract(location_name, '^P0*([0-9]+)[AB]$', 1) AS INTEGER) AS loc_num
        FROM onhand WHERE is_primary_pick = true
      ),
      material_secondary_codes AS (
        SELECT material_id,
          list(DISTINCT (CASE WHEN loc_num % 2 = 1 THEN 'F' ELSE 'G' END) || LPAD(CAST(loc_num AS VARCHAR),3,'0') || suffix) AS codes
        FROM primary_nums, (VALUES ('B'),('C'),('D')) AS s(suffix)
        GROUP BY material_id
      ),
      classified AS (
        SELECT o.*,
          CASE WHEN o.is_primary_pick THEN 'primary'
               WHEN list_contains(msc.codes, o.location_name) THEN 'secondary'
               ELSE 'warehouse' END AS bucket
        FROM onhand o
        LEFT JOIN material_secondary_codes msc ON msc.material_id = o.material_id
      ),
      oldest_lot AS (
        SELECT material_id, lot_id, lot_code, expiration_date,
          ROW_NUMBER() OVER (PARTITION BY material_id ORDER BY expiration_date ASC NULLS LAST) AS rn
        FROM (SELECT DISTINCT material_id, lot_id, lot_code, expiration_date FROM onhand)
      ),
      oldest_summary AS (
        SELECT c.material_id, ol.lot_code AS oldest_lot_code, ol.expiration_date AS oldest_expiration_date,
          SUM(CASE WHEN c.bucket='primary' THEN c.cases ELSE 0 END) AS cases_primary,
          SUM(CASE WHEN c.bucket='secondary' THEN c.cases ELSE 0 END) AS cases_secondary,
          SUM(CASE WHEN c.bucket='warehouse' THEN c.cases ELSE 0 END) AS cases_warehouse,
          STRING_AGG(DISTINCT CASE WHEN c.bucket='secondary' THEN c.location_name END, ', ') AS secondary_locations,
          STRING_AGG(DISTINCT CASE WHEN c.bucket='warehouse' THEN c.location_name END, ', ') AS warehouse_locations
        FROM classified c
        JOIN oldest_lot ol ON ol.material_id = c.material_id AND ol.lot_id = c.lot_id AND ol.rn = 1
        GROUP BY c.material_id, ol.lot_code, ol.expiration_date
      )
      SELECT
        m.lookup_code AS material_code, m.Description AS material_name,
        os.oldest_lot_code, os.oldest_expiration_date,
        os.cases_primary, os.cases_secondary, os.cases_warehouse,
        os.secondary_locations, os.warehouse_locations,
        gcp.current_lot_codes, gcp.current_primary_locations,
        CASE WHEN os.cases_primary > 0 THEN 'primary'
             WHEN os.cases_secondary > 0 THEN 'secondary'
             ELSE 'warehouse' END AS status
      FROM oldest_summary os
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = os.material_id
      LEFT JOIN gross_current_primary gcp ON gcp.material_id = os.material_id
      ORDER BY
        CASE WHEN os.cases_primary>0 THEN 0 WHEN os.cases_secondary>0 THEN 1 ELSE 2 END,
        os.oldest_expiration_date ASC NULLS LAST
    `

    const rows = await runQuery(sql)

    try { conn.close(); db.close() } catch (_) {}

    const nowMs = Date.now()
    const materials = rows.map(r => {
      const exp = r.oldest_expiration_date ? new Date(r.oldest_expiration_date) : null
      const daysRemaining = exp ? Math.round((exp.getTime() - nowMs) / 86400000) : null
      return {
        materialCode: r.material_code,
        materialName: r.material_name,
        oldestLotCode: r.oldest_lot_code,
        oldestExpirationDate: r.oldest_expiration_date,
        daysRemaining,
        aging: agingSeverity(daysRemaining),
        casesInPrimary: num(r.cases_primary),
        casesInSecondary: num(r.cases_secondary),
        casesInWarehouse: num(r.cases_warehouse),
        secondaryLocations: r.secondary_locations || null,
        warehouseLocations: r.warehouse_locations || null,
        currentLotCodes: r.current_lot_codes || null,
        currentPrimaryLocations: r.current_primary_locations || null,
        status: r.status,
      }
    })

    const summary = {
      total: materials.length,
      primary: materials.filter(m => m.status === 'primary').length,
      secondary: materials.filter(m => m.status === 'secondary').length,
      warehouse: materials.filter(m => m.status === 'warehouse').length,
      agingCritical: materials.filter(m => m.aging === 'critical').length,
      agingWarning: materials.filter(m => m.aging === 'warning').length,
      agingWatch: materials.filter(m => m.aging === 'watch').length,
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ materials, summary, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), elapsedMs: Date.now() - t0 }),
    }
  }
}
