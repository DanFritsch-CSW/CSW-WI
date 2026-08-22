'use strict'

// Order Search — Phase 1 (2026-08-21), per the 2026-08-20 Dan<>Kay meeting:
// "build a simple function to search for orders in the system and confirm
// their existence (flag if in system or not)." This is Kay's single
// biggest time-sink today — manually checking Datex for order details
// before scheduling a Kenosha appointment.
//
// Searches production_db.silver.datex_slv_orders — confirmed via
// MotherDuck catalog search before writing this (not guessed) as the
// correct silver-layer source; house convention prefers silver.datex_slv_*
// over bronze unless there's a specific reason otherwise.
//
// Matches the given reference against ALL THREE fields Kay checks
// manually today — lookup_code, owner_reference, vendor_reference — since
// per the same meeting, which field a given customer's reference actually
// lands in varies (owner_reference matches ~90% of the time, but not
// always), and Kay doesn't always know which one to search on for the
// order sitting in front of her.
//
// Deliberately does NOT filter by warehouse. preferred_warehouse_id on
// this table almost certainly uses the same Datex warehouse ID space as
// production_db.gold.truck_appointments.warehouse_id (CAL=1, EC=3, MAD=4,
// KEN=5, WR=6 — see motherduck-appointments.cjs), but that hasn't been
// independently confirmed for THIS table, and a wrong assumption here
// would silently hide a real order exactly when Kay needs a real answer.
// Returns warehouse_name as a best-effort label for a human to sanity-
// check, rather than using it to filter results.
//
// Phase 2 (ship date + notes) is a deliberate follow-up, not built here —
// this endpoint intentionally returns only enough to confirm existence
// and let a human sanity-check it's the right order (lookup code, which
// field matched, status, project/warehouse), not the full order detail.
//
// POST body: { reference: string }
// Response: { found: boolean, matches: [{
//   order_id, lookup_code, owner_reference, vendor_reference,
//   matched_field, status_name, warehouse_name, project_id
// }] }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Best-effort label only — see header note on why this isn't used to filter.
const WAREHOUSE_NAMES = { 1: 'CAL', 3: 'EC', 4: 'MAD', 5: 'KEN', 6: 'WR' }

function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const ref = (body.reference || '').trim()
  if (!ref) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing reference' }) }
  }

  const refLit = sqlLit(ref)

  const sql = `
    SELECT
      o.order_id,
      COALESCE(o.lookup_code, '') AS lookup_code,
      COALESCE(o.owner_reference, '') AS owner_reference,
      COALESCE(o.vendor_reference, '') AS vendor_reference,
      COALESCE(s.status_name, '') AS status_name,
      o.preferred_warehouse_id,
      o.project_id,
      CASE
        WHEN LOWER(o.lookup_code) = LOWER(${refLit}) THEN 'lookup_code'
        WHEN LOWER(o.owner_reference) = LOWER(${refLit}) THEN 'owner_reference'
        WHEN LOWER(o.vendor_reference) = LOWER(${refLit}) THEN 'vendor_reference'
      END AS matched_field
    FROM production_db.silver.datex_slv_orders o
    LEFT JOIN production_db.silver.datex_slv_orderstatuses s
      ON s.order_status_id = o.order_status_id
    WHERE
      LOWER(o.lookup_code) = LOWER(${refLit})
      OR LOWER(o.owner_reference) = LOWER(${refLit})
      OR LOWER(o.vendor_reference) = LOWER(${refLit})
    ORDER BY o.created_sys_date_time DESC
    LIMIT 10
  `

  // Netlify Functions requires HOME=/tmp for the duckdb native module to
  // have a writable scratch dir — same pattern as every other
  // motherduck-*.cjs function in this app.
  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  try {
    const duckdb = require('duckdb')
    const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
    const conn = db.connect()

    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve()))
    })

    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => (err ? reject(err) : resolve(result)))
    })

    conn.close()
    db.close()

    const matches = rows.map((r) => ({
      order_id: Number(r.order_id),
      lookup_code: String(r.lookup_code || ''),
      owner_reference: String(r.owner_reference || ''),
      vendor_reference: String(r.vendor_reference || ''),
      matched_field: String(r.matched_field || ''),
      status_name: String(r.status_name || ''),
      warehouse_name: WAREHOUSE_NAMES[Number(r.preferred_warehouse_id)] || null,
      project_id: r.project_id != null ? Number(r.project_id) : null,
    }))

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ found: matches.length > 0, matches }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }),
    }
  }
}
