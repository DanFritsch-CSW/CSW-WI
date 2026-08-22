'use strict'

// scheduling-order-search.cjs — Phase 1 of the Kenosha order search
// automation discussed in the 2026-08-20 Dan<>Kay meeting (Fathom
// recording 175274133). Kay's biggest daily time-sink for Kenosha
// appointments is manually checking Datex to confirm an order exists
// before scheduling it, and to pull its Owner Reference / Vendor
// Reference / Requested Ship Date / Notes.
//
// REWRITTEN 2026-08-21 to match the response contract PluginOrderSearchTab.jsx
// and schedulingApi.js's searchOrder() already expect (both already
// existed on main — this function itself was the missing piece). Original
// draft of this function used a different {reference,facilityId} /
// {exists,matches} shape before that existing UI was discovered; rebuilt
// against the real contract instead of asking the UI to adapt to it.
//
// Per that meeting's agreed phasing:
//   Phase 1: given a reference string, confirm whether a matching order
//     exists in Datex at all, showing identifying info (owner/project/
//     warehouse/status) — the simple yes/no + "which one" flag.
//   Phase 2: surface requestedDeliveryDate + notes in the UI card. Both
//     fields are ALREADY returned by this function (no reason to fetch
//     the row twice later) — Phase 2 is purely a PluginOrderSearchTab.jsx
//     display change, no backend work.
//
// Search is intentionally NOT scoped to a facility — the existing UI
// takes a single reference string with no facility selector, matching
// Kay's actual workflow (she often doesn't know which facility an order
// is filed under until she's found it).
//
// Root data source: production_db.bronze.datex_orders — there is no
// silver/gold layer for orders (confirmed via MotherDuck catalog search),
// so this reads bronze directly. Confirmed via direct query that this
// table has exactly one row per order Id (no CDC-style versioning to
// dedupe) and currently has zero soft-deleted rows, but the
// DeletedSysUser filter is kept for correctness going forward. Full
// query (including the owner/project/status joins) was validated against
// a real Kenosha order (TO277949) before writing this function.
//
// Per the meeting: Order Lookup Code matches Owner Reference for ~90% of
// customers, but not all — this searches LookupCode, OwnerReference, AND
// VendorReference together (not just one), so it works regardless of
// which reference a given customer's email actually contains. No
// per-customer custom rules needed for this phase; those would matter
// more for PARSING an inbound email's free text, not for this lookup
// itself.
//
// POST body: { query: string }
// Response: { found: boolean, count: number, query: string, orders: [{
//   orderId, lookupCode, ownerReference, vendorReference,
//   requestedDeliveryDate, notes, statusName, ownerName, projectName,
//   warehouseName, backOrder }] }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// warehouse_id -> display name. Matches the facility names used
// throughout this app (see WAREHOUSE_ADDRESSES in front-draft-shared.cjs
// and the WAREHOUSE_ID map in motherduck-appointments.cjs).
// CAL=1, EC=3, MAD=4, KEN=5, WR=6
const WAREHOUSE_NAME = {
  1: 'CSW-Franksville',
  3: 'CSW-Eau Claire',
  4: 'CSW-Madison',
  5: 'CSW-Kenosha',
  6: 'CSW-Wisconsin Rapids',
}

// Escape a string for embedding in a SQL literal — duckdb-node's .all()
// surface used here doesn't support parameter binding, so we hand-quote,
// matching the established pattern in motherduck-appointments.cjs.
function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function buildSql(query) {
  const normalizedRef = sqlLit(query.trim().toUpperCase())
  return `
    SELECT
      o.Id                       AS order_id,
      o.LookupCode               AS lookup_code,
      o.OwnerReference           AS owner_reference,
      o.VendorReference          AS vendor_reference,
      o.RequestedDeliveryDate    AS requested_delivery_date,
      o.Notes                    AS notes,
      o.BackOrder                AS back_order,
      s.Name                     AS status_name,
      a.Name                     AS owner_name,
      p.Name                     AS project_name,
      o.PreferredWarehouseId     AS warehouse_id
    FROM production_db.bronze.datex_orders o
    LEFT JOIN production_db.bronze.datex_orderstatuses s ON s.Id = o.OrderStatusId
    LEFT JOIN production_db.bronze.datex_accounts a ON a.Id = o.AccountId
    LEFT JOIN production_db.bronze.datex_projects p ON p.Id = o.ProjectId
    WHERE o.DeletedSysUser IS NULL
      AND (
        UPPER(TRIM(o.LookupCode)) = ${normalizedRef}
        OR UPPER(TRIM(o.OwnerReference)) = ${normalizedRef}
        OR UPPER(TRIM(o.VendorReference)) = ${normalizedRef}
      )
    ORDER BY o.Id DESC
    LIMIT 20
  `
}

function toOrders(rows) {
  return rows.map((r) => ({
    orderId: Number(r.order_id),
    lookupCode: r.lookup_code || null,
    ownerReference: r.owner_reference || null,
    vendorReference: r.vendor_reference || null,
    requestedDeliveryDate: r.requested_delivery_date || null,
    notes: r.notes || null,
    statusName: r.status_name || null,
    ownerName: r.owner_name || null,
    projectName: r.project_name || null,
    warehouseName: WAREHOUSE_NAME[Number(r.warehouse_id)] || null,
    backOrder: r.back_order === true,
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

  const { query } = body
  if (!query || !String(query).trim()) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing query' }) }
  }

  const sql = buildSql(String(query))

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

    const orders = toOrders(rows)
    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ found: orders.length > 0, count: orders.length, query: String(query), orders }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }),
    }
  }
}
