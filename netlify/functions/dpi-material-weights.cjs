'use strict'

// DPI Monthly Process — real material weight lookup (A7 fix).
//
// Jen's original complaint: her Waukesha route showed 41,000 lbs where the
// app showed 37,575 — the FDP201W CSV's own weight column
// (txtSumGrossWeight) is explicitly labeled "Gross weight," and the app was
// showing something else. Confirmed live 2026-09-23 against
// production_db.silver.datex_slv_materialspackagingslookup: this ISN'T a
// "read a different CSV column" fix — the CSV's weight column was never
// used for order creation at all (see dpiMonthlyParser.js's header comment,
// decision made 2026-09-05: "Datex materials are the weight source of
// truth"), and Phase 2's capacity flag has instead been using a flat
// placeholder (25 lb/case) the entire time, which is a bigger gap than
// Jen's report implied.
//
// The real fix is a per-material lookup against Datex's own packaging
// table, joined the same way getMaterialMap/createAgencyOrder already
// resolve material_id for the real push (lib/dpi-monthly-shared.cjs) —
// this function is deliberately a separate, read-only sibling of that
// resolution path, not a modification to it, so the real Datex push logic
// is untouched by this UI-only capacity-display fix.
//
// Confirmed live 2026-09-23 (Route MADISON, cycle 63, both stops):
//   Weight column          = NET (product only)
//   shipping_weight column = GROSS (Weight + tare_weight, i.e. the
//                            physical trailer-scale number Jen is after)
//   Placeholder (25 lb/case) came in ~7-11% under real gross weight on
//   real data — the same order of magnitude as Jen's original 41,000 vs
//   37,575 lb report.
// So gross_weight below is always shipping_weight, never Weight alone.
//
// lookup_code has a REAL trailing-space quirk in Datex's own data (at
// least one material confirmed: "100001 "). Every join below uses
// TRIM(m.lookup_code), matching the same normalization getMaterialMap
// already applies via `.trim()` in JS. Skipping this silently drops
// materials that actually exist, which looks identical to "not in the
// catalog" from the caller's side.
//
// Input  (POST JSON): { facility: 'Eau Claire'|'Madison', lookupCodes: [...] }
// Output (JSON): {
//   weights: { [lookupCode]: { materialId, netWeight, grossWeight } },
//   unresolved: [lookupCode, ...],   // genuinely not in this facility's catalog
//   fetchedAt, elapsedMs,
// }
// Unresolved codes are returned explicitly rather than just omitted, so
// the caller can flag "N line items using a fallback weight" instead of
// silently under-reporting a route's total.

process.env.HOME = process.env.HOME || '/tmp'

const { FACILITIES } = require('./lib/dpi-monthly-shared.cjs')

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
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
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

  let facility, lookupCodes
  try {
    ;({ facility, lookupCodes } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const cfg = FACILITIES[facility]
  if (!cfg) {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Unknown facility "${facility}" — expected "Eau Claire" or "Madison"` }),
    }
  }
  if (!Array.isArray(lookupCodes) || lookupCodes.length === 0) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'lookupCodes must be a non-empty array' }) }
  }

  const uniqueCodes = [...new Set(lookupCodes.map((c) => String(c).trim()).filter(Boolean))]
  const codesList = uniqueCodes.map((c) => `'${escapeSqlString(c)}'`).join(',')

  const sql = `
    SELECT
      TRIM(m.lookup_code) AS lookup_code,
      m.material_id,
      p.Weight AS net_weight,
      p.shipping_weight AS gross_weight
    FROM production_db.silver.datex_slv_materials m
    LEFT JOIN production_db.silver.datex_slv_materialspackagingslookup p
      ON p.material_id = m.material_id AND p.packaging_id = ${cfg.packaging_id}
    WHERE m.project_id = ${cfg.project_id}
      AND TRIM(m.lookup_code) IN (${codesList})
  `

  let db, conn
  try {
    process.env.HOME = '/tmp'
    process.env.motherduck_token = TOKEN
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (s) => new Promise((resolve, reject) => conn.run(s, (err) => (err ? reject(err) : resolve())))
    const runQuery = (s) => new Promise((resolve, reject) => conn.all(s, (err, rows) => (err ? reject(err) : resolve(rows))))

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    const rows = await runQuery(sql)
    try { conn?.close(); db?.close() } catch (_) { /* best effort */ }

    const weights = {}
    for (const row of rows) {
      if (row.net_weight == null || row.gross_weight == null) continue // material found, but no packaging_id row — treat as unresolved below
      weights[row.lookup_code] = {
        materialId: row.material_id,
        netWeight: Number(row.net_weight),
        grossWeight: Number(row.gross_weight),
      }
    }
    const unresolved = uniqueCodes.filter((c) => !weights[c])

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ weights, unresolved, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) { /* best effort */ }
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), elapsedMs: Date.now() - t0 }),
    }
  }
}
