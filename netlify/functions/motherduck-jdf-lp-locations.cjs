'use strict'

// JDF LP Locator — added 2026-08-13, per Dan's ask on the same-item/same-tier
// project ("select a JDF material and the PDF is available to print"). Lives
// inside the JDF Putaways tab (src/components/JdfLpLocator.jsx), not a
// separate top-level tab.
//
// Two modes via POST body, mirroring the optional-param pattern used
// elsewhere in this app rather than two separate functions, since both
// queries share the same onhand temp table and connection setup:
//   {}              -> returns the material picklist (every JDF material
//                       currently on hand, with its active LP count, sorted
//                       by count desc) to populate the dropdown.
//   { sku: '018505' } -> returns full LP-level detail for that material:
//                       LP code, current location, MFG date (decoded from
//                       the lot code, same convention as
//                       motherduck-jdf-putaways.cjs / jdfPutawaysLogic.js),
//                       units, and whether that LP's location is
//                       Clean/Mixed (bin holds only this SKU vs. others),
//                       plus which other SKU(s) it's sharing with.
//
// Deliberately NOT scoped to F8 only, unlike motherduck-jdf-putaways.cjs --
// this tool answers "where is every pallet of this material right now,"
// anywhere in the building (receiving, staging, or any freezer), not just
// the F8 slotting-compliance question. Schema/columns confirmed live
// before writing (same silver.datex_slv_* tables already used elsewhere
// in this app): licenseplates.lookup_code, licenseplatecontents.Amount,
// lots.lookup_code (MFG date source), materials.lookup_code/Description.
//
// POST body: {} or { sku: string }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const JDF_PROJECT_ID = 365

function num(v) { return Number(v ?? 0) || 0 }
function fmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : null }

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

  let sku = null
  try {
    const body = event.body ? JSON.parse(event.body) : {}
    sku = body.sku ? String(body.sku).trim() : null
  } catch (_) { /* treat unparsable body as no-sku (picklist) request */ }

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

    // JDF-wide on-hand snapshot -- every active LP, any location (not F8-only;
    // see header note). Shared by both response modes below.
    await exec(`
      CREATE TEMP TABLE onhand AS
      SELECT
        loc.location_container_name AS location,
        lp.license_plate_id,
        lp.lookup_code AS lp_code,
        lot.lookup_code AS lot_code,
        m.material_id,
        m.lookup_code AS material_code,
        m.Description AS material_name,
        TRY_CAST(('20'||substr(lot.lookup_code,2,2)||'-'||substr(lot.lookup_code,4,2)||'-'||substr(lot.lookup_code,6,2)) AS DATE) AS mfg_date,
        lpc.Amount AS units
      FROM production_db.silver.datex_slv_licenseplates lp
      JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
      JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
      JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
      WHERE p.project_id = ${JDF_PROJECT_ID}
        AND (lp.Archived IS NULL OR lp.Archived = false)
    `)

    if (!sku) {
      // Picklist mode -- material dropdown, sorted by active LP count desc
      // so the busiest/most-relevant SKUs (the ones the consolidation
      // project actually cares about) sort to the top.
      const rows = await runQuery(`
        SELECT material_code, any_value(material_name) AS material_name,
               COUNT(DISTINCT license_plate_id) AS active_lps
        FROM onhand
        GROUP BY material_code
        ORDER BY active_lps DESC
      `)
      try { conn.close(); db.close() } catch (_) {}
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({
          materials: rows.map(r => ({ code: r.material_code, name: (r.material_name || '').trim(), activeLps: num(r.active_lps) })),
          fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
        }),
      }
    }

    // Detail mode -- every active LP for this material, current location,
    // and whether that location is Clean (this SKU only) or Mixed (shared
    // with other SKU(s), listed in sharingWith).
    await exec(`
      CREATE TEMP TABLE loc_stats AS
      SELECT location, COUNT(DISTINCT material_code) AS distinct_skus,
             STRING_AGG(DISTINCT material_code, ',') AS skus_here
      FROM onhand
      GROUP BY location
    `)
    const [materialRows, lpRows] = await Promise.all([
      runQuery(`SELECT DISTINCT material_code, material_name FROM onhand WHERE material_code = '${sku.replace(/'/g, "''")}'`),
      runQuery(`
        SELECT o.lp_code, o.location, o.mfg_date, o.units, ls.distinct_skus, ls.skus_here
        FROM onhand o
        JOIN loc_stats ls ON ls.location = o.location
        WHERE o.material_code = '${sku.replace(/'/g, "''")}'
        ORDER BY o.location
      `),
    ])
    try { conn.close(); db.close() } catch (_) {}

    const materialName = (materialRows[0]?.material_name || '').trim()
    const lps = lpRows.map(r => {
      const skusHere = (r.skus_here || '').split(',').filter(Boolean)
      const otherSkus = skusHere.filter(s => s !== sku)
      return {
        lpCode: r.lp_code,
        location: r.location,
        mfgDate: fmtDate(r.mfg_date),
        units: num(r.units),
        status: otherSkus.length ? 'mixed' : 'clean',
        sharingWith: otherSkus,
      }
    })

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        sku, materialName, lps,
        totalLps: lps.length,
        cleanCount: lps.filter(l => l.status === 'clean').length,
        mixedCount: lps.filter(l => l.status === 'mixed').length,
        fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0,
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
