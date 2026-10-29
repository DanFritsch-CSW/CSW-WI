'use strict'

// Space Forecast live feed -- on-hand LPs per Datex warehouse + project +
// material group, from MotherDuck (production_db.gold.inventory_history_summary).
// Added 2026-10-29 for /spaceforecast's "Now" column and "Unmapped" list.
//
// Request:  POST { facilityId: 'cal' | 'mad' | 'ken' | 'wr' | 'ec' }
// Response: { asOf: 'YYYY-MM-DD', rows: [ { warehouseId, projectId, projectName,
//             materialGroupId, materialGroup, lps, weighted } ] }
//
// WHAT THE NUMBERS ARE
//   lps       raw license-plate count (inventory_count). This is what feeds "Now":
//             the page divides by the plan row's own stack factor to get positions,
//             so using Datex's weighted count there would apply stacking twice.
//   weighted  Datex's weighted_inventory_count (a stackable material group counts
//             0.5). Returned for the stackability audit hover; NOT used for "Now".
//
// SNAPSHOT DAY: the latest activity_date present for that warehouse. asOf is
// returned and shown on the page so nobody mistakes it for a live scan.
//
// Rows are one per project + material group (the plan rows are mapped on that key
// in space_forecast_project_map), already aggregated, a few dozen to ~120 per
// facility, so no gzip needed.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const WAREHOUSE_MAP = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

  let facilityId
  try {
    ;({ facilityId } = JSON.parse(event.body))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const whName = WAREHOUSE_MAP[facilityId]
  if (!whName) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Unknown facilityId: ${facilityId}` }) }
  }
  const safe = whName.replace(/'/g, "''")

  const sql = `
    WITH d AS (
      SELECT MAX(activity_date) AS d
      FROM production_db.gold.inventory_history_summary
      WHERE warehouse_name = '${safe}'
    )
    SELECT
      s.warehouse_id                                AS warehouse_id,
      s.project_id                                  AS project_id,
      TRIM(s.project_name)                          AS project_name,
      s.material_group_id                           AS material_group_id,
      COALESCE(g.material_group_name, '(none)')     AS material_group,
      SUM(s.inventory_count)                        AS lps,
      SUM(s.weighted_inventory_count)               AS weighted,
      ANY_VALUE(CAST(d.d AS VARCHAR))               AS as_of
    FROM production_db.gold.inventory_history_summary s
    JOIN d ON s.activity_date = d.d
    LEFT JOIN production_db.silver.datex_slv_materialgroups g
           ON g.material_group_id = s.material_group_id
    WHERE s.warehouse_name = '${safe}'
    GROUP BY s.warehouse_id, s.project_id, TRIM(s.project_name), s.material_group_id, g.material_group_name
    HAVING SUM(s.inventory_count) > 0
    ORDER BY lps DESC
  `

  let db, conn
  try {
    // HOME=/tmp so MotherDuck C++ init has a writable path for extension files
    process.env.HOME             = '/tmp'
    process.env.motherduck_token = TOKEN

    const duckdb = require('duckdb')
    db   = new duckdb.Database(':memory:')
    conn = db.connect()

    await new Promise((resolve, reject) => { conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve())) })
    await new Promise((resolve, reject) => {
      conn.run("ATTACH 'md:production_db' AS production_db (READ_ONLY)", (err) => (err ? reject(err) : resolve()))
    })

    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => (err ? reject(err) : resolve(result)))
    })

    conn.close()
    db.close()

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        asOf: rows.length ? String(rows[0].as_of) : null,
        rows: rows.map((r) => ({
          warehouseId:     Number(r.warehouse_id),
          projectId:       Number(r.project_id),
          projectName:     String(r.project_name || ''),
          materialGroupId: r.material_group_id == null ? null : Number(r.material_group_id),
          materialGroup:   String(r.material_group || ''),
          lps:             Number(r.lps) || 0,
          weighted:        Number(r.weighted) || 0,
        })),
      }),
    }
  } catch (e) {
    try { if (conn) conn.close() } catch {}
    try { if (db)   db.close()   } catch {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 800) }),
    }
  }
}
