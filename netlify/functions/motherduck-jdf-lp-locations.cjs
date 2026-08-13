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
//                       by count desc) to populate the dropdown, PLUS (added
//                       2026-08-13 same day) a `referenceTable` array: every
//                       JDF material ranked by all-time shipping-pallet
//                       throughput (silver.datex_slv_archivedshippinglicenseplatecontents),
//                       with current active LPs and % Same Item (location
//                       purity, JDF-wide) alongside -- the same "Rank / SKU /
//                       Description / Active LPs / % Same Item" table built
//                       ad hoc in chat earlier this project, now live and
//                       rendered at the bottom of the tab
//                       (JdfSameItemReference.jsx) instead of being a
//                       one-off pull Dan has to ask for again each time.
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
// lots.lookup_code (MFG date source), materials.lookup_code/Description,
// archivedshippinglicenseplatecontents (throughput source, confirmed live
// before adding).
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
      //
      // referenceTable (added 2026-08-13) -- same onhand snapshot, joined
      // against location-purity stats (distinct SKU count per location,
      // JDF-wide -- identical definition to the Daily/Building-Wide "same
      // item" classification elsewhere on this tab, just not F8-scoped)
      // and against all-time shipping throughput. LEFT JOIN from throughput
      // so a material with shipping history but zero current on-hand still
      // shows a rank row (activeLps/pctSameItem simply come back null/0).
      const [materialRows, referenceRows] = await Promise.all([
        runQuery(`
          SELECT material_code, any_value(material_name) AS material_name,
                 COUNT(DISTINCT license_plate_id) AS active_lps
          FROM onhand
          GROUP BY material_code
          ORDER BY active_lps DESC
        `),
        runQuery(`
          WITH loc_stats AS (
            SELECT location, COUNT(DISTINCT material_code) AS distinct_skus
            FROM onhand GROUP BY location
          ),
          active_stats AS (
            SELECT o.material_code,
                   COUNT(DISTINCT o.license_plate_id) AS active_lps,
                   COUNT(DISTINCT CASE WHEN ls.distinct_skus = 1 THEN o.license_plate_id END) AS pure_lps
            FROM onhand o JOIN loc_stats ls ON ls.location = o.location
            GROUP BY o.material_code
          ),
          throughput AS (
            SELECT m.lookup_code AS material_code, any_value(m.Description) AS description,
                   COUNT(DISTINCT c.license_plate_id) AS shipping_pallets
            FROM production_db.silver.datex_slv_archivedshippinglicenseplatecontents c
            JOIN production_db.silver.datex_slv_lots l ON c.lot_id = l.lot_id
            JOIN production_db.silver.datex_slv_materials m ON l.material_id = m.material_id
            WHERE m.project_id = ${JDF_PROJECT_ID}
            GROUP BY 1
          )
          SELECT ROW_NUMBER() OVER (ORDER BY t.shipping_pallets DESC) AS rank,
                 t.material_code, t.description, t.shipping_pallets,
                 COALESCE(a.active_lps, 0) AS active_lps,
                 CASE WHEN COALESCE(a.active_lps, 0) > 0 THEN ROUND(100.0 * a.pure_lps / a.active_lps, 1) ELSE NULL END AS pct_same_item
          FROM throughput t
          LEFT JOIN active_stats a ON a.material_code = t.material_code
          ORDER BY rank
        `),
      ])
      try { conn.close(); db.close() } catch (_) {}
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({
          materials: materialRows.map(r => ({ code: r.material_code, name: (r.material_name || '').trim(), activeLps: num(r.active_lps) })),
          referenceTable: referenceRows.map(r => ({
            rank: num(r.rank),
            code: r.material_code,
            name: (r.description || '').trim(),
            shippingPallets: num(r.shipping_pallets),
            activeLps: num(r.active_lps),
            pctSameItem: r.pct_same_item === null || r.pct_same_item === undefined ? null : Number(r.pct_same_item),
          })),
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
