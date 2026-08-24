'use strict'

// Order Search — Phase 1, per the 2026-08-20 Dan<>Kay meeting: "build a
// simple function to search for orders in the system and confirm their
// existence (flag if in system or not)." Kay's single biggest time-sink
// today — manually checking Datex for order details before scheduling a
// Kenosha appointment.
//
// RECONCILED 2026-08-22 after discovering a parallel session had already
// built the full Phase 1 stack (this function + searchOrder() client
// wrapper + PluginOrderSearchTab.jsx UI) shortly before this pass started.
// That earlier work went through two different versions of THIS file —
// one targeting silver.datex_slv_orders, then a later rewrite targeting
// bronze.datex_orders with the stated reason "no silver/gold layer exists
// for orders." That reason doesn't hold up: a direct MotherDuck catalog
// search confirms silver.datex_slv_orders exists and is exactly what's
// needed here.
//
// UPDATED 2026-08-22 (later) after Kay hit a real false-positive: a
// reference number ("31553") coincidentally matched an unrelated,
// long-Completed Palermo's/Caledonia order while she was scheduling a
// Pedone Pinsa/Kenosha appointment — reference numbers are apparently not
// globally unique across customers over Datex's full history. Two fixes,
// both confirmed against live data before writing (see
// silver.datex_slv_orderstatuses counts: Created=3,939 orders,
// Processing=892, Completed=660,876, Cancelled=60,731 — Completed/
// Cancelled dwarf the active statuses, so an unscoped search is
// overwhelmingly likely to surface stale/irrelevant history):
//   1. Always restricts to order_status_id IN (1, 2) — Created and
//      Processing, the only two statuses with real "this order is still
//      active" meaning.
//   2. Accepts optional owner/project params and, when provided, requires
//      an exact case-insensitive match on BOTH.
//
// PHASE 2 added 2026-08-22 (later still): requestedShipDate and notes,
// pulled from datex_slv_orders.requested_delivery_date and .Notes.
//
// FIXED 2026-08-22 (later still) — the owner-scoping filter added above
// was joining through the WRONG table and broke real orders. Confirmed
// against live data (order 776740, Kay's own Pedone Pinsa/Kenosha test
// case): datex_slv_orders.account_id -> datex_slv_accounts.account_name
// resolves to "Greco and Sons, of Wisconsin" — the SHIP-TO/consignee on
// that specific order, not Datex's actual "Owner" concept (the "Owner *"
// field shown on the Datex order screen, which read "Pedone Pinsa" for
// this same order). Once the owner-scoping filter compared draft.owner
// ("Pedone Pinsa", correctly sourced elsewhere in this app) against that
// wrong field, it could never match, and a real active order came back as
// "not found."
//
// The correct chain, confirmed live: datex_slv_orders.project_id ->
// bronze.datex_projects.OwnerId -> bronze.datex_owners.Name. Both
// datex_projects and datex_owners carry historical CDC-style versions
// (VersionId/ingestion_ts), so both are deduped to latest via the same
// ROW_NUMBER pattern already used for project names. The datex_slv_accounts
// join is removed entirely — it was only ever providing the wrong value
// for ownerName and isn't used for anything else.
//
// FIXED 2026-08-24 — Dan/Kay flagged that the single date this function
// returned (requested_delivery_date, labeled "Requested Ship Date") isn't
// actually a ship date at all: it's genuinely a DELIVERY date, and
// different customers populate it inconsistently relative to their real
// ship date. Confirmed against live data (order 778492, Sargento
// Cheese/Caledonia): datex_slv_orders.requested_delivery_date = Sep 2
// (the delivery date), while the SEPARATE datex_shipments record linked
// via datex_slv_shipmentorderlookup has ExpectedDate = Aug 29 (the real
// ship date for this order). These are two genuinely different Datex
// entities (Order vs. Shipment), not a labeling mistake — so rather than
// guessing which one a given order "really" means, this now surfaces
// BOTH, clearly separated as requestedDeliveryDate and shipExpectedDate,
// and lets the human reviewing decide which applies. 724 orders in this
// dataset link to more than one shipment (confirmed via direct count
// before writing this join) — picks the most recently modified linked
// shipment per order via ROW_NUMBER, so results stay one row per order
// rather than fanning out.
//
// Response contract — orderNote: requestedShipDate was RENAMED to
// requestedDeliveryDate (accurate name) and shipExpectedDate/
// shipPickupDate were ADDED. Both OrderSearchBadge.jsx and PluginView.jsx
// were updated in the same pass to match this shape — check both before
// assuming the old requestedShipDate field name still works anywhere.
//   { found, count, query, orders: [{
//       orderId, lookupCode, statusName, ownerName, projectName,
//       warehouseName, ownerReference, vendorReference, backOrder,
//       requestedDeliveryDate, shipExpectedDate, shipPickupDate, notes
//   }] }
//
// Matches the given query against ALL THREE reference fields Kay checks
// manually today — lookup_code, owner_reference, vendor_reference — since
// per the 08-20 meeting, which field a given customer's reference lands
// in varies (owner_reference matches ~90% of the time, but not always).
//
// Deliberately does NOT filter by warehouse. preferred_warehouse_id on
// datex_slv_orders almost certainly uses the same Datex warehouse ID
// space as production_db.gold.truck_appointments.warehouse_id (CAL=1,
// EC=3, MAD=4, KEN=5, WR=6 — see motherduck-appointments.cjs), but that
// hasn't been independently confirmed for THIS table, and a wrong
// assumption here would silently hide a real order exactly when Kay needs
// a real answer. warehouseName is a best-effort label for a human to
// sanity-check, never used to filter results.
//
// POST body: { query: string, owner?: string, project?: string }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Best-effort label only — see header note on why this isn't used to filter.
const WAREHOUSE_NAMES = { 1: 'CAL', 3: 'EC', 4: 'MAD', 5: 'KEN', 6: 'WR' }

// Only statuses with real "this order is still active" meaning — see
// header note for the live counts that justified this. Everything else
// (Completed, Cancelled, and the zero-volume statuses) is excluded.
const ACTIVE_STATUS_IDS = [1, 2] // Created, Processing

function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function toDateOnly(value) {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
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

  const query = (body.query || '').trim()
  if (!query) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing query' }) }
  }
  const owner = (body.owner || '').trim()
  const project = (body.project || '').trim()

  const refLit = sqlLit(query)
  const statusList = ACTIVE_STATUS_IDS.join(', ')
  const ownerFilter = owner ? `AND LOWER(ow.owner_name) = LOWER(${sqlLit(owner)})` : ''
  const projectFilter = project ? `AND LOWER(p.project_name) = LOWER(${sqlLit(project)})` : ''

  const sql = `
    WITH latest_projects AS (
      SELECT Id AS project_id, Name AS project_name, OwnerId AS owner_id
      FROM (
        SELECT Id, Name, OwnerId, ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
        FROM production_db.bronze.datex_projects
      )
      WHERE rn = 1
    ),
    latest_owners AS (
      SELECT Id AS owner_id, Name AS owner_name
      FROM (
        SELECT Id, Name, ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
        FROM production_db.bronze.datex_owners
      )
      WHERE rn = 1
    ),
    latest_shipments AS (
      SELECT Id AS shipment_id, ExpectedDate, PickupDate
      FROM (
        SELECT Id, ExpectedDate, PickupDate, ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
        FROM production_db.bronze.datex_shipments
      )
      WHERE rn = 1
    ),
    order_shipment AS (
      -- 724 orders link to more than one shipment (confirmed via direct
      -- count before writing this) -- pick the most recently modified
      -- linked shipment per order so results stay one row per order.
      SELECT order_id, shipment_id
      FROM (
        SELECT order_id, shipment_id, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY modified_sys_date_time DESC) AS rn
        FROM production_db.silver.datex_slv_shipmentorderlookup
      )
      WHERE rn = 1
    )
    SELECT
      o.order_id,
      COALESCE(o.lookup_code, '') AS lookup_code,
      COALESCE(o.owner_reference, '') AS owner_reference,
      COALESCE(o.vendor_reference, '') AS vendor_reference,
      COALESCE(s.status_name, '') AS status_name,
      COALESCE(ow.owner_name, '') AS owner_name,
      COALESCE(p.project_name, '') AS project_name,
      o.preferred_warehouse_id,
      o.back_order,
      o.requested_delivery_date,
      sh.ExpectedDate AS ship_expected_date,
      sh.PickupDate AS ship_pickup_date,
      COALESCE(o.Notes, '') AS order_notes
    FROM production_db.silver.datex_slv_orders o
    LEFT JOIN production_db.silver.datex_slv_orderstatuses s
      ON s.order_status_id = o.order_status_id
    LEFT JOIN latest_projects p
      ON p.project_id = o.project_id
    LEFT JOIN latest_owners ow
      ON ow.owner_id = p.owner_id
    LEFT JOIN order_shipment os
      ON os.order_id = o.order_id
    LEFT JOIN latest_shipments sh
      ON sh.shipment_id = os.shipment_id
    WHERE (
      LOWER(o.lookup_code) = LOWER(${refLit})
      OR LOWER(o.owner_reference) = LOWER(${refLit})
      OR LOWER(o.vendor_reference) = LOWER(${refLit})
    )
    AND o.order_status_id IN (${statusList})
    ${ownerFilter}
    ${projectFilter}
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

    const orders = rows.map((r) => ({
      orderId: Number(r.order_id),
      lookupCode: String(r.lookup_code || ''),
      statusName: String(r.status_name || ''),
      ownerName: String(r.owner_name || ''),
      projectName: String(r.project_name || ''),
      warehouseName: WAREHOUSE_NAMES[Number(r.preferred_warehouse_id)] || '',
      ownerReference: String(r.owner_reference || ''),
      vendorReference: String(r.vendor_reference || ''),
      backOrder: Boolean(r.back_order),
      // requested_delivery_date observed values are always midnight
      // (date-only data wearing a TIMESTAMP type) -- format as a plain
      // date. This is a genuinely DIFFERENT field from the ship dates
      // below -- see this file's 2026-08-24 header note.
      requestedDeliveryDate: toDateOnly(r.requested_delivery_date),
      shipExpectedDate: toDateOnly(r.ship_expected_date),
      shipPickupDate: toDateOnly(r.ship_pickup_date),
      notes: String(r.order_notes || '').trim(),
    }))

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ found: orders.length > 0, count: orders.length, orders, query }),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }),
    }
  }
}
