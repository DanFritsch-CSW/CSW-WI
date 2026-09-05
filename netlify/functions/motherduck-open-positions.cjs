'use strict'

// Current Open Positions backend -- CAL/KEN/WR/EC. Added 2026-09-04, per
// Dan/Hill's Front conversation: a quick, on-demand ("pull up on the dock
// computer at that moment," not a once-daily digest) view of open
// locations, added as a new sub-tab in the Inventory page (Cycle Count
// Report | Current Open Positions), with per-facility sub-tabs
// underneath. Madison is deliberately NOT handled here -- it reuses the
// already-live, already-validated motherduck-f8-open-positions.cjs
// (F8B-F8F aisles, Empty=2/1LP=1 for B-E, Empty-only=1 for F). This
// function covers the other four facilities, whose location-naming and
// pallet-capacity conventions had never been investigated before this.
//
// CLASSIFICATION (deliberately conservative, confirm/tweak from here):
// unlike Madison's F8 aisles (where Dan explicitly confirmed a location
// holds either 1 or 2 pallet positions), Datex has no capacity field for
// any of these four facilities either -- confirmed the same way the
// Inventory tab's own comment already documents for Caledonia:
// max_license_plate_quantity is null across every location. Rather than
// guess a per-facility capacity multiplier, this counts ONLY genuinely
// EMPTY locations (0 license plates) as open, 1 position each. A
// location holding even 1 LP is treated as not-open here -- Dan's own
// framing on F8F ("1 LP = full") is applied as the SAFE DEFAULT
// everywhere until each facility's real capacity convention (if any) is
// confirmed live, the same way Madison's B-E-vs-F split was.
//
// ZONE GROUPING (confirmed live before choosing, not guessed):
//   - Caledonia (CSW-Franksville): two live naming conventions coexist --
//     legacy 2-letter+3digit+level codes (e.g. BB123F) and a "F1-<letter>-
//     <bay>-<level>" dash convention for Room F1 (e.g. F1-GG-039). Zone =
//     first two dash-segments for F1-prefixed names (giving clean F1-A
//     through F1-R aisle buckets, confirmed live: 26 distinct, cleanly
//     sized), else the first 2 characters (BB, BA, AI, etc.).
//   - Kenosha: uniformly 2-letter+3digit+level (BG637A, AH059D, etc.) --
//     zone = first 2 characters. Confirmed live: ~30 clean buckets.
//   - Wisconsin Rapids: a genuine mix of letter-prefixed (A107D, P054A)
//     and purely numeric (676C, 650B) codes -- zone = first 1 character
//     (confirmed live: 19 distinct buckets, letters A-G/L/M/O/P/R/S/W/X
//     plus digit-led numeric locations grouped by leading digit).
//   - Eau Claire: mostly a compact "F1<letter><bay><level>" convention
//     (F1A18A) plus a handful of other codes (D2A24, C1BB03D, named zones
//     like "Dock") -- zone = first 3 characters for F1-prefixed names
//     (F1A/F1B/F1C/etc, confirmed live: clean per-aisle buckets), else
//     first 2 characters.
//
// FLAGGED, not fixed: Wisconsin Rapids' numeric-prefixed zones (4/5/6/7,
// e.g. "410A") come back 100% empty right now. Structurally they look
// like real locations (same row+level-letter shape as the lettered
// aisles), NOT the same kind of confirmed-dead legacy pattern Madison's
// F8E##-00 locations turned out to be -- so this is intentionally left
// in, not excluded. Worth Dan confirming whether that's a genuinely
// underused rack section or something that should be treated differently.
//
// Response is AGGREGATED server-side (zone-level only, not per-location)
// -- these facilities have 9,000-40,000 total locations each, far too
// many to usefully return row-by-row for a quick pull-up view. No
// ignore-list support here yet (that's Madison/F8-specific for now, tied
// to f8_open_positions_ignored) -- can be added the same way if this
// generalizes well after Dan reviews it.
//
// POST body: { facility: 'cal'|'ken'|'wr'|'ec' }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const FACILITY_CONFIG = {
  cal: {
    warehouseName: 'CSW-Franksville',
    label: 'Caledonia',
    zoneExpr: `CASE
      WHEN loc.location_container_name LIKE 'F1-%'
        THEN split_part(loc.location_container_name, '-', 1) || '-' || split_part(loc.location_container_name, '-', 2)
      ELSE substr(loc.location_container_name, 1, 2)
    END`,
  },
  ken: {
    warehouseName: 'CSW-Kenosha',
    label: 'Kenosha',
    zoneExpr: `substr(loc.location_container_name, 1, 2)`,
  },
  wr: {
    warehouseName: 'CSW-Wisconsin Rapids',
    label: 'Wisconsin Rapids',
    zoneExpr: `substr(loc.location_container_name, 1, 1)`,
  },
  ec: {
    warehouseName: 'CSW-Eau Claire',
    label: 'Eau Claire',
    zoneExpr: `CASE
      WHEN loc.location_container_name LIKE 'F1%'
        THEN substr(loc.location_container_name, 1, 3)
      ELSE substr(loc.location_container_name, 1, 2)
    END`,
  },
}

function num(v) { return Number(v ?? 0) || 0 }

function buildSql(cfg) {
  return `
    WITH wh AS (
      SELECT warehouse_id
      FROM production_db.silver.datex_slv_warehouses
      WHERE warehouse_name = '${cfg.warehouseName}'
    ),
    locs AS (
      SELECT
        loc.location_container_id,
        ${cfg.zoneExpr} AS zone
      FROM production_db.silver.datex_slv_locationcontainers loc
      JOIN wh ON loc.warehouse_id = wh.warehouse_id
    ),
    lp_counts AS (
      SELECT
        locs.location_container_id,
        count(DISTINCT lp.license_plate_id) AS lp_count
      FROM locs
      LEFT JOIN production_db.silver.datex_slv_licenseplates lp
        ON lp.location_id = locs.location_container_id
       AND (lp.Archived IS NULL OR lp.Archived = false)
      GROUP BY locs.location_container_id
    )
    SELECT
      locs.zone AS zone,
      count(*) AS total_locations,
      count(*) FILTER (WHERE COALESCE(lp_counts.lp_count, 0) = 0) AS empty_count
    FROM locs
    LEFT JOIN lp_counts ON lp_counts.location_container_id = locs.location_container_id
    GROUP BY locs.zone
    ORDER BY locs.zone
  `
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  let facility
  try {
    ;({ facility } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const cfg = FACILITY_CONFIG[facility]
  if (!cfg) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Unknown or unsupported facility: ${facility}. Use motherduck-f8-open-positions for Madison.` }) }
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

    const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
    const runQuery = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const rows = await runQuery(buildSql(cfg))

    try { conn.close(); db.close() } catch (_) {}

    const zones = rows.map(r => {
      const empty = num(r.empty_count)
      return {
        zone: r.zone,
        totalLocations: num(r.total_locations),
        empty,
        openPositions: empty, // conservative default -- see file header
      }
    })
    const totalOpenPositions = zones.reduce((s, z) => s + z.openPositions, 0)

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        facility,
        facilityLabel: cfg.label,
        warehouseName: cfg.warehouseName,
        zones,
        totalOpenPositions,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
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

module.exports.FACILITY_CONFIG = FACILITY_CONFIG
module.exports.buildSql = buildSql
