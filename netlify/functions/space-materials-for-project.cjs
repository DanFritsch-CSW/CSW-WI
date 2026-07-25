'use strict'

// Space Planning — live materials-with-on-hand-inventory for one customer
// project (Phase 4b, material-level stacking exceptions).
//
// Powers the material-exception dropdown in CustomerStackingSection: rather
// than a free-typed material name (which drifts — typos, casing, SKU vs
// description), this returns real Datex materials that actually have active
// inventory for that customer right now, sorted by LP count so the most
// relevant materials surface first. Scoped to ONE customer per call (not a
// facility-wide materials dump) — a single project can have 100+ materials
// total, but typically far fewer with live on-hand stock, and scoping keeps
// the dropdown usable as customers add/retire materials over time without
// needing any code change here (this is why it's a live query, not seeded).
//
// Input  (POST JSON):  { facility: 'mad', projectName: 'Jones Dairy Farm - CSW-Madison' }
// Output (JSON):       { materials: [ { materialName, lookupCode, lps }, ... ],
//                        fetchedAt, elapsedMs, source: 'motherduck', warehouseId }
//
// Currently MAD-only, same scope/whitelist as space-per-room.cjs.
// projectName is free text from the live Datex project list OR a shortened
// customer name typed into space_customer_stacking before this feature
// existed — matched via case-insensitive PREFIX match (ILIKE), not exact
// equality (see comment above the SQL below for why). Single-quotes are
// escaped before interpolation into the SQL string to avoid breaking the
// query (this project's queries are built via string interpolation
// throughout, not parameterized statements, since the DuckDB Node driver
// used here doesn't support bound params for `conn.all`).

process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const FACILITY_TO_WAREHOUSE = {
  mad: 4,
}

function escapeSqlString(s) {
  return String(s).replace(/'/g, "''")
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

  let facility, projectName
  try {
    ;({ facility, projectName } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const warehouseId = FACILITY_TO_WAREHOUSE[facility]
  if (!warehouseId) {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: 'not_supported',
        message: `Facility '${facility}' not scoped for live materials lookup yet. Only MAD is live.`,
      }),
    }
  }
  if (!projectName || typeof projectName !== 'string') {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'projectName is required' }) }
  }

  const safeProjectName = escapeSqlString(projectName)

  // Prefix match (ILIKE, case-insensitive), not exact equality — confirmed
  // live 2026-07-25 that space_customer_stacking.customer_name entries often
  // store a shortened name (e.g. "Jones Dairy Farm") rather than the full
  // Datex project_name ("Jones Dairy Farm - CSW-Madison"), since that table
  // predates this feature and some rows were typed in manually. An exact
  // match on those rows silently returns zero materials — not a fetch
  // failure, but the UI can't tell the difference without this fix. Verified
  // safe against cross-facility collisions: even when a customer name prefix
  // matches multiple facilities' project variants (e.g. "Colony Brands"
  // matches CAL/KEN/MAD variants), the warehouse_id filter below already
  // scopes results to this facility's own project, since a differently-
  // faciliated project's materials won't have any LPs in this warehouse.
  const sql = `
    SELECT
      m.material_name,
      m.lookup_code,
      COUNT(DISTINCT lp.license_plate_id)::BIGINT AS lps
    FROM production_db.silver.datex_slv_licenseplates lp
    JOIN production_db.silver.datex_slv_licenseplatecontents lpc
      ON lpc.license_plate_id = lp.license_plate_id
    JOIN production_db.silver.datex_slv_lots l ON l.lot_id = lpc.lot_id
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = l.material_id
    JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
    WHERE lp.archived = false
      AND lp.warehouse_id = ${warehouseId}
      AND p.project_name ILIKE '${safeProjectName}%'
    GROUP BY m.material_name, m.lookup_code
    ORDER BY lps DESC
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

    const materials = rows.map(r => ({
      materialName: (r.material_name || '').trim(),
      lookupCode: r.lookup_code || null,
      lps: Number(r.lps) || 0,
    })).filter(m => m.materialName)

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        materials,
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
