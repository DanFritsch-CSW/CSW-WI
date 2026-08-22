'use strict'

// scheduling-order-search.cjs — added 2026-08-21, Phase 1 of the Kenosha
// order search automation discussed in the 2026-08-20 Dan<>Kay meeting
// (Fathom recording 175274133). Kay's biggest daily time-sink for Kenosha
// appointments is manually checking Datex to confirm an order exists
// before scheduling it, and to pull its Owner Reference / Vendor
// Reference / Requested Ship Date / Notes.
//
// Per that meeting's agreed phasing:
//   Phase 1 (this function): given a reference string, confirm whether a
//     matching order exists in Datex at all — the simple yes/no flag.
//   Phase 2: surface the requested delivery date + notes alongside it.
//
// Both phases are served by the SAME query here — there's no reason to
// build this twice, since fetching a few extra columns costs nothing once
// the row is already being read. Phase 1's UI only needs to show
// exists/not-exists; Phase 2's UI can show the rest of what this function
// already returns. See PluginView.jsx for how Phase 1 surfaces this
// (a simple "Order found / not found" check next to Reference #).
//
// Root data source: production_db.bronze.datex_orders — there is no
// silver/gold layer for orders (confirmed via MotherDuck catalog search
// 2026-08-21), so this reads bronze directly. Confirmed via direct query
// that this table has exactly one row per order Id (no CDC-style
// versioning to dedupe) and currently has zero soft-deleted rows, but the
// DeletedSysUser filter is kept for correctness going forward. Query
// logic itself was validated end-to-end against a real Kenosha order
// (TO277949) before this function was written, not just tested after.
//
// Per the meeting: Order Lookup Code matches Owner Reference for ~90% of
// customers, but not all — this searches LookupCode, OwnerReference, AND
// VendorReference together (not just one), so it works regardless of
// which reference a given customer's email actually contains. No
// per-customer custom rules needed for this phase; those would matter
// more for PARSING an inbound email's free text, not for this lookup
// itself.
//
// POST body: { reference: string, facilityId?: 'cal'|'mad'|'ken'|'wr'|'ec' }
// Response: { exists: boolean, matches: [{ id, lookupCode, ownerReference,
//   vendorReference, requestedDeliveryDate, notes, statusId, statusName,
//   ownerName, warehouseId }] }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// warehouse_id map — matches production_db.gold.truck_appointments and
// every other motherduck-*.cjs function in this app.
// CAL=1, EC=3, MAD=4, KEN=5, WR=6
const WAREHOUSE_ID = {
  cal: 1,
  ec: 3,
  mad: 4,
  ken: 5,
  wr: 6,
}

// Escape a string for embedding in a SQL literal — duckdb-node's .all()
// surface used here doesn't support parameter binding, so we hand-quote,
// matching the established pattern in motherduck-appointments.cjs.
function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function buildSql(reference, warehouseId) {
  const normalizedRef = sqlLit(reference.trim().toUpperCase())
  const warehouseFilter = warehouseId ? `AND o.PreferredWarehouseId = ${warehouseId}` : ''
  return `
    SELECT
      o.Id                       AS id,
      o.LookupCode               AS lookup_code,
      o.OwnerReference           AS owner_reference,
      o.VendorReference          AS vendor_reference,
      o.RequestedDeliveryDate    AS requested_delivery_date,
      o.Notes                    AS notes,
      o.OrderStatusId            AS status_id,
      s.Name                     AS status_name,
      a.Name                     AS owner_name,
      o.PreferredWarehouseId     AS warehouse_id
    FROM production_db.bronze.datex_orders o
    LEFT JOIN production_db.bronze.datex_orderstatuses s ON s.Id = o.OrderStatusId
    LEFT JOIN production_db.bronze.datex_accounts a ON a.Id = o.AccountId
    WHERE o.DeletedSysUser IS NULL
      AND (
        UPPER(TRIM(o.LookupCode)) = ${normalizedRef}
        OR UPPER(TRIM(o.OwnerReference)) = ${normalizedRef}
        OR UPPER(TRIM(o.VendorReference)) = ${normalizedRef}
      )
      ${warehouseFilter}
    ORDER BY o.Id DESC
    LIMIT 20
  `
}

function toMatches(rows) {
  return rows.map((r) => ({
    id: Number(r.id),
    lookupCode: r.lookup_code || null,
    ownerReference: r.owner_reference || null,
    vendorReference: r.vendor_reference || null,
    requestedDeliveryDate: r.requested_delivery_date || null,
    notes: r.notes || null,
    statusId: r.status_id != null ? Number(r.status_id) : null,
    statusName: r.status_name || null,
    ownerName: r.owner_name || null,
    warehouseId: r.warehouse_id != null ? Number(r.warehouse_id) : null,
  }))
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

  const { reference, facilityId } = body
  if (!reference || !String(reference).trim()) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing reference' }) }
  }

  const warehouseId = facilityId ? WAREHOUSE_ID[facilityId] : undefined
  if (facilityId && !warehouseId) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Unknown facilityId "${facilityId}"` }) }
  }

  const sql = buildSql(String(reference), warehouseId)

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

    const matches = toMatches(rows)
    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ exists: matches.length > 0, matches }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }),
    }
  }
}
