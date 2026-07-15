'use strict'

// WR Pick Location Lot Check backend. Built 2026-07-14, refined multiple
// times through 2026-07-15 after live validation with Dan (recorded call
// with Kaylee for the original ask; several live corrections after). Real
// ask: for every Bernatello's material, is the OLDEST AVAILABLE on-hand
// lot (by vendor lot expiration date, same field the 120-day Omni "aging"
// report uses) actually sitting in the primary pick location right now?
// If not, is it staged in the secondaries (overhead rack directly above)?
// If not, it's out in the warehouse. Daily verification, not enforcement
// — nothing here blocks a pick.
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
//
// ── Availability source: gold.available_inventory_by_lp (NOT hand-rolled
// task netting) — corrected 2026-07-15 ──────────────────────────────────
// First attempt computed "available" by summing active Planned/Released
// pick tasks per (location, lot) and subtracting from gross on-hand. Dan
// caught this was wrong via the actual Datex Footprint Cloud UI: filtering
// Inventory Hub to location B104A showed EVERY line at Available amount
// = 0, even though allocated/soft_allocated in our own hand-rolled calc
// were also 0 there — meaning task-based netting wasn't the real
// mechanism driving unavailability at all. Root cause, confirmed live:
// every LP sitting at B104A had a non-null `shipment_id` on
// datex_slv_licenseplates — i.e. already picked and assigned to a
// specific outbound shipment, which zeroes Datex's own availability
// calc regardless of task status. Rather than re-deriving this (shipment
// assignment, allocation, soft-allocation, etc. all interact), this
// version uses `gold.available_inventory_by_lp` directly — CSW's own
// gold-layer table that already reflects Datex's authoritative
// calculation. Validated live against the exact B104A screenshot: matches
// Available=0 on every line. Table also carries lot_id/license_plate_id
// at full granularity (gold.available_inventory_by_location, checked
// first, aggregates to material+location only with lot_id/
// license_plate_id always null for this warehouse — not usable for
// FEFO-style oldest-lot logic, hence by_lp instead).
//
// ── "Currently In Primary" is deliberately GROSS, not availability-
// filtered ───────────────────────────────────────────────────────────────
// This column shows whichever lot is PHYSICALLY sitting in the primary
// slot right now (gold table's total_packaged_amount > 0), regardless of
// availability — a team member walking up to the slot sees a real pallet
// there even if it's fully committed to an order. Only the primary/
// secondary/warehouse classification of the OLDEST lot uses the
// available_packaged_amount filter.
//
// ── Classification per on-hand row, relative to whichever P-slot(s) a
// material currently occupies (with available stock) ───────────────────
//   - primary:   is_primary_pick = true
//   - secondary: NOT primary, but location matches the computed overhead
//                rack code(s) for that material's current primary slot(s)
//   - warehouse: NOT primary, NOT the computed overhead rack
//
// ── Status per material (AVAILABLE cases of the OLDEST on-hand lot,
// where "on-hand" now means available_packaged_amount > 0) ─────────────
//   - primary:   oldest available lot has cases in the primary slot
//   - secondary: oldest available lot has 0 cases in primary, but has
//                cases in the overhead rack (staged, ready to pull down)
//   - warehouse: oldest available lot has 0 cases in primary AND 0 in the
//                overhead rack — including materials with no primary-slot
//                presence at all right now
//
// ── Scope: excludes non-food supply/equipment SKUs (lookup_code LIKE
// '99%' — pizza ovens, trays, POS kits, printer paper, cartons, etc,
// confirmed via a live catalog check) — mirrors the same exclusion the
// 120-day Omni aging report applies.
//
// ── Aging severity — folded in per Dan's request, so this one report can
// also drive customer communication (Bernatello's needs to know what's
// approaching expiration to sell through / ship). Same 120-day window and
// bands as the Omni report: Critical <30d, Warning 30-59d, Watch 60-119d.
//
// ── Validated live 2026-07-15 (Bernatello's, warehouse 6, post-gold-table
// fix): 102 materials with available stock -> 88 primary / 1 secondary /
// 13 warehouse. Numbers will drift run to run — live production snapshot.
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
      WITH base AS (
        SELECT ai.material_id, m.lookup_code AS material_code, m.Description AS material_name,
          ai.lot_id, lot.lookup_code AS lot_code, ai.expiration_date,
          ai.total_packaged_amount AS gross_cases, ai.available_packaged_amount AS avail_cases,
          loc.location_container_name AS location_name, loc.is_primary_pick
        FROM production_db.gold.available_inventory_by_lp ai
        JOIN production_db.silver.datex_slv_materials m ON m.material_id = ai.material_id
        JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = ai.lot_id
        JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = ai.location_id
        WHERE ai.warehouse_id = ${WAREHOUSE_ID}
          AND m.project_id = ${PROJECT_ID}
          AND m.lookup_code NOT ILIKE '99%'
          AND lot.status_id NOT IN (${EXCLUDED_STATUS_IDS.join(',')})
      ),
      -- GROSS current lot in primary -- deliberately independent of the
      -- availability filter, for the "Currently In Primary" display column.
      gross_current_primary AS (
        SELECT material_id, STRING_AGG(DISTINCT lot_code, ', ') AS current_lot_codes,
          STRING_AGG(DISTINCT location_name, ', ') AS current_primary_locations
        FROM (SELECT DISTINCT material_id, lot_code, location_name FROM base WHERE is_primary_pick = true AND gross_cases > 0)
        GROUP BY material_id
      ),
      -- AVAILABLE on-hand, straight from Datex's own gold-layer calc --
      -- this is what drives the primary/secondary/warehouse classification,
      -- NOT the display column above.
      onhand AS (
        SELECT material_id, material_code, material_name, lot_id, lot_code, expiration_date,
          location_name, is_primary_pick, avail_cases AS cases
        FROM base
        WHERE avail_cases > 0
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
