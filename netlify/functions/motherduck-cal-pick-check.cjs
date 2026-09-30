'use strict'

// CAL (Caledonia) Pick Location Lot Check backend — PALDSD9 only. Built
// 2026-09-29 as a mirror of motherduck-wr-pick-check.cjs (WR / Bernatello's),
// after the PVI FEFO call with Sam Vega + Dean: DSD was getting flagged as
// "expired, expired, expired" because product that should have been pulled
// from the pick line at 45 days of shelf life never was. Read that WR file's
// header for the full design history; everything below that is not called
// out as a difference is intentionally identical.
//
// ── Same as WR ───────────────────────────────────────────────────────
//   - Availability + lot/LP granularity from gold.available_inventory_by_lp
//     (NOT hand-rolled task netting — see WR header for why).
//   - "In pick line" = the LP sits in a location Datex flags
//     is_primary_pick = true (native, live flag; whatever LP is physically
//     there IS that slot's current assignment).
//   - "Currently In Primary" column is GROSS (physically there, even if fully
//     committed); only the oldest-lot classification uses available cases.
//   - Scope excludes non-food SKUs (lookup_code LIKE '99%') and lot statuses
//     2015 / 2012 from the pick check itself (same exclusion as WR).
//   - POST body {} — live "right now" snapshot.
//
// ── Differences from WR ─────────────────────────────────────────────────
//   1. Project/warehouse: PALDSD9 = project_id 250, Caledonia = warehouse 1
//      (CAL/Franksville). Palermo's finished goods (PALVI9) and materials
//      (PALMA9) are NOT pick-lined — they have 3 and 1 flagged-primary rows
//      respectively — so they are deliberately out of scope.
//   2. NO "secondary" bucket. WR's secondary rack is computed from its P0xx
//      pick-slot naming (odd P-slot -> F0xx overhead rack, even -> G0xx).
//      Caledonia's locations (AD096A, AE098A, F1-H-004-D, BC155A ...) follow
//      no such rule, so there is nothing to compute. Status is two-valued:
//      'primary' (oldest available lot has cases in the pick line) or
//      'warehouse' (it does not; other_locations says where it is). If Sam
//      later defines a CAL staging location, a third bucket can be added.
//   3. Aging is a 45-day shelf-life window, not WR's 120-day Critical/
//      Warning/Watch bands (Sam, on the call: "if it's at 45 days or less, it
//      needs to get alerted"). Material rows carry aging = 'expired' (< 0d)
//      or 'aging45' (0-45d) off the OLDEST AVAILABLE lot.
//   4. Extra dataset `lots`: EVERY on-hand DSD lot at <= 45 days (including
//      already expired), by gross on-hand and INCLUDING lots the pick check
//      itself excludes/ignores (status 2015 holds, lots with zero available
//      cases). The material rows only ever look at each material's oldest
//      AVAILABLE lot, so a held lot at 10 days would never surface there —
//      but it is exactly the kind of lot Sam wants called out. Each lot row
//      says how many cases are physically in the pick line vs. elsewhere and
//      whether any of it is held (inactive_packaged_amount > 0 or status
//      2015/2012).
//
// ── Known nit ───────────────────────────────────────────────────────────
// Expiration comes from gold.available_inventory_by_lp (same as WR). The FEFO
// digest uses datex_slv_vendorlots.expiration_date. Checked live 2026-09-29:
// they agree for every PALDSD9 lot on hand except two held Milwaukee Pretzel
// Holiday Wreath lots (LP-level 10/16 vs vendor-lot 10/10 and 10/14).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECT_ID = 250   // PALDSD9 — Palermo's Caledonia DSD
const WAREHOUSE_ID = 1   // CAL / Franksville
const EXCLUDED_STATUS_IDS = [2015, 2012] // same exclusion WR's pick check uses
const AGING_WINDOW_DAYS = 45

function num(v) { return Number(v ?? 0) || 0 }

function centralTodayUTC() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return Date.UTC(get('year'), get('month') - 1, get('day'))
}

// exp is a 'YYYY-MM-DD' string (cast in SQL so there's no timezone drift).
function daysUntil(expStr, todayUTC) {
  if (!expStr) return null
  const [y, m, d] = String(expStr).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return Math.round((Date.UTC(y, m - 1, d) - todayUTC) / 86400000)
}

function agingBucket(days) {
  if (days == null) return null
  if (days < 0) return 'expired'
  if (days <= AGING_WINDOW_DAYS) return 'aging45'
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

    const materialsSql = `
      WITH base AS (
        SELECT ai.material_id, m.lookup_code AS material_code, m.Description AS material_name,
          ai.lot_id, lot.lookup_code AS lot_code, CAST(CAST(ai.expiration_date AS DATE) AS VARCHAR) AS expiration_date,
          ai.total_packaged_amount AS gross_cases, ai.available_packaged_amount AS avail_cases,
          loc.location_container_name AS location_name, COALESCE(loc.is_primary_pick, false) AS is_primary_pick
        FROM production_db.gold.available_inventory_by_lp ai
        JOIN production_db.silver.datex_slv_materials m ON m.material_id = ai.material_id
        JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = ai.lot_id
        JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = ai.location_id
        WHERE ai.warehouse_id = ${WAREHOUSE_ID}
          AND m.project_id = ${PROJECT_ID}
          AND m.lookup_code NOT ILIKE '99%'
          AND lot.status_id NOT IN (${EXCLUDED_STATUS_IDS.join(',')})
      ),
      -- GROSS current lot in the pick line -- deliberately independent of the
      -- availability filter, for the "Currently In Primary" display column.
      gross_current_primary AS (
        SELECT material_id, STRING_AGG(DISTINCT lot_code, ', ') AS current_lot_codes,
          STRING_AGG(DISTINCT location_name, ', ') AS current_primary_locations
        FROM (SELECT DISTINCT material_id, lot_code, location_name FROM base WHERE is_primary_pick = true AND gross_cases > 0)
        GROUP BY material_id
      ),
      onhand AS (SELECT * FROM base WHERE avail_cases > 0),
      oldest_lot AS (
        SELECT material_id, lot_id, lot_code, expiration_date,
          ROW_NUMBER() OVER (PARTITION BY material_id ORDER BY expiration_date ASC NULLS LAST) AS rn
        FROM (SELECT DISTINCT material_id, lot_id, lot_code, expiration_date FROM onhand)
      ),
      oldest_summary AS (
        SELECT c.material_id, ol.lot_code AS oldest_lot_code, ol.expiration_date AS oldest_expiration_date,
          SUM(CASE WHEN c.is_primary_pick THEN c.avail_cases ELSE 0 END) AS cases_primary,
          SUM(CASE WHEN NOT c.is_primary_pick THEN c.avail_cases ELSE 0 END) AS cases_other,
          STRING_AGG(DISTINCT CASE WHEN NOT c.is_primary_pick THEN c.location_name END, ', ') AS other_locations
        FROM onhand c
        JOIN oldest_lot ol ON ol.material_id = c.material_id AND ol.lot_id = c.lot_id AND ol.rn = 1
        GROUP BY c.material_id, ol.lot_code, ol.expiration_date
      )
      SELECT
        m.lookup_code AS material_code, m.Description AS material_name,
        os.oldest_lot_code, os.oldest_expiration_date,
        os.cases_primary, os.cases_other, os.other_locations,
        gcp.current_lot_codes, gcp.current_primary_locations,
        CASE WHEN os.cases_primary > 0 THEN 'primary' ELSE 'warehouse' END AS status
      FROM oldest_summary os
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = os.material_id
      LEFT JOIN gross_current_primary gcp ON gcp.material_id = os.material_id
      ORDER BY
        CASE WHEN os.cases_primary > 0 THEN 1 ELSE 0 END,
        os.oldest_expiration_date ASC NULLS LAST
    `

    // Every on-hand lot at <= AGING_WINDOW_DAYS (incl. expired), gross
    // on-hand, NOT filtered by lot status or availability — see header #4.
    const lotsSql = `
      SELECT m.lookup_code AS material_code, m.Description AS material_name,
        lot.lookup_code AS lot_code, lot.status_id,
        CAST(CAST(MIN(ai.expiration_date) AS DATE) AS VARCHAR) AS expiration_date,
        SUM(ai.total_packaged_amount) AS cases,
        SUM(ai.inactive_packaged_amount) AS held_cases,
        SUM(CASE WHEN COALESCE(loc.is_primary_pick, false) THEN ai.total_packaged_amount ELSE 0 END) AS cases_primary,
        STRING_AGG(DISTINCT CASE WHEN COALESCE(loc.is_primary_pick, false) THEN loc.location_container_name END, ', ') AS primary_locations,
        STRING_AGG(DISTINCT CASE WHEN NOT COALESCE(loc.is_primary_pick, false) THEN loc.location_container_name END, ', ') AS other_locations
      FROM production_db.gold.available_inventory_by_lp ai
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = ai.material_id
      JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = ai.lot_id
      JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = ai.location_id
      WHERE ai.warehouse_id = ${WAREHOUSE_ID}
        AND m.project_id = ${PROJECT_ID}
        AND m.lookup_code NOT ILIKE '99%'
        AND ai.total_packaged_amount > 0
        AND CAST(ai.expiration_date AS DATE) <= CURRENT_DATE + ${AGING_WINDOW_DAYS}
      GROUP BY m.lookup_code, m.Description, lot.lookup_code, lot.status_id
      ORDER BY MIN(ai.expiration_date) ASC, m.lookup_code
    `

    const [materialRows, lotRows] = await Promise.all([runQuery(materialsSql), runQuery(lotsSql)])

    try { conn.close(); db.close() } catch (_) {}

    const todayUTC = centralTodayUTC()

    const materials = materialRows.map(r => {
      const daysRemaining = daysUntil(r.oldest_expiration_date, todayUTC)
      return {
        materialCode: r.material_code,
        materialName: r.material_name,
        oldestLotCode: r.oldest_lot_code,
        oldestExpirationDate: r.oldest_expiration_date,
        daysRemaining,
        aging: agingBucket(daysRemaining),
        casesInPrimary: num(r.cases_primary),
        casesElsewhere: num(r.cases_other),
        otherLocations: r.other_locations || null,
        currentLotCodes: r.current_lot_codes || null,
        currentPrimaryLocations: r.current_primary_locations || null,
        status: r.status,
      }
    })

    const lots = lotRows.map(r => {
      const daysRemaining = daysUntil(r.expiration_date, todayUTC)
      const cases = num(r.cases)
      const casesPrimary = num(r.cases_primary)
      const statusId = num(r.status_id)
      return {
        materialCode: r.material_code,
        materialName: r.material_name,
        lotCode: r.lot_code,
        expirationDate: r.expiration_date,
        daysRemaining,
        aging: agingBucket(daysRemaining),
        cases,
        casesInPrimary: casesPrimary,
        casesElsewhere: Math.max(0, cases - casesPrimary),
        primaryLocations: r.primary_locations || null,
        otherLocations: r.other_locations || null,
        held: num(r.held_cases) > 0 || EXCLUDED_STATUS_IDS.includes(statusId),
      }
    })

    const summary = {
      total: materials.length,
      primary: materials.filter(m => m.status === 'primary').length,
      warehouse: materials.filter(m => m.status === 'warehouse').length,
      lotsAging: lots.filter(l => l.aging).length,
      lotsExpired: lots.filter(l => l.aging === 'expired').length,
      lotsHeldAging: lots.filter(l => l.aging && l.held).length,
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ materials, lots, summary, agingWindowDays: AGING_WINDOW_DAYS, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 }),
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
