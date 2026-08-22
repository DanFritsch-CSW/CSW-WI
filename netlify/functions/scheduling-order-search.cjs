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
// needed here. This version reads FROM SILVER for orders/statuses/
// accounts (all three have silver views), and falls back to BRONZE only
// for project names specifically, since no silver view exists for
// projects (confirmed via the same catalog search, not assumed) — bronze
// there is deduped to the latest ingested version per project ID, since
// bronze.datex_projects carries historical CDC-style versions.
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
//      active" meaning. Completed and Cancelled orders are never
//      returned, regardless of reference match.
//   2. Accepts optional owner/project params (the draft's currently
//      selected Owner/Project in the plugin) and, when provided, requires
//      an exact case-insensitive match on BOTH — scoping the search to
//      the specific customer/project Kay is actually working on, so a
//      coincidental reference collision with a different customer's
//      order can no longer surface as a false "found." When owner/project
//      aren't yet set on the draft, falls back to the unscoped search
//      (still status-filtered) rather than returning nothing.
//
// PHASE 2 added 2026-08-22 (later still): requestedShipDate and notes,
// pulled from datex_slv_orders.requested_delivery_date and .Notes
// (exact column names confirmed via DESCRIBE before writing this — Notes
// is capitalized, unlike every other column here). Both are display-only
// additions to the same query Phase 1 already ran — no new joins, no new
// tables. requested_delivery_date is a TIMESTAMP but observed values are
// always midnight (date-only data wearing a timestamp type), so it's
// formatted as a plain date (YYYY-MM-DD) rather than a full timestamp.
// Notes is frequently Datex-auto-generated summary text (e.g.
// " [Total 1344 42819.84 LB 1510.65 CF]") rather than free-text human
// notes — passed through as-is, trimmed, since Kay still finds it useful
// context even when it's just a quantity summary.
//
// Response contract matches what PluginOrderSearchTab.jsx and
// searchOrder() already expect on main — verified directly against both
// files before writing this, not re-guessed:
//   { found, count, query, orders: [{
//       orderId, lookupCode, statusName, ownerName, projectName,
//       warehouseName, ownerReference, vendorReference, backOrder,
//       requestedShipDate, notes
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
  const ownerFilter = owner ? `AND LOWER(a.account_name) = LOWER(${sqlLit(owner)})` : ''
  const projectFilter = project ? `AND LOWER(p.project_name) = LOWER(${sqlLit(project)})` : ''

  const sql = `
    WITH latest_projects AS (
      SELECT Id AS project_id, Name AS project_name
      FROM (
        SELECT Id, Name, ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
        FROM production_db.bronze.datex_projects
      )
      WHERE rn = 1
    )
    SELECT
      o.order_id,
      COALESCE(o.lookup_code, '') AS lookup_code,
      COALESCE(o.owner_reference, '') AS owner_reference,
      COALESCE(o.vendor_reference, '') AS vendor_reference,
      COALESCE(s.status_name, '') AS status_name,
      COALESCE(a.account_name, '') AS owner_name,
      COALESCE(p.project_name, '') AS project_name,
      o.preferred_warehouse_id,
      o.back_order,
      o.requested_delivery_date,
      COALESCE(o.Notes, '') AS order_notes
    FROM production_db.silver.datex_slv_orders o
    LEFT JOIN production_db.silver.datex_slv_orderstatuses s
      ON s.order_status_id = o.order_status_id
    LEFT JOIN production_db.silver.datex_slv_accounts a
      ON a.account_id = o.account_id
    LEFT JOIN latest_projects p
      ON p.project_id = o.project_id
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

    const orders = rows.map((r) => {
      // requested_delivery_date observed values are always midnight
      // (date-only data wearing a TIMESTAMP type) — format as a plain
      // date, not a full timestamp, to match how Kay actually thinks
      // about a ship date.
      let requestedShipDate = null
      if (r.requested_delivery_date) {
        const d = new Date(r.requested_delivery_date)
        if (!isNaN(d.getTime())) requestedShipDate = d.toISOString().slice(0, 10)
      }
      return {
        orderId: Number(r.order_id),
        lookupCode: String(r.lookup_code || ''),
        statusName: String(r.status_name || ''),
        ownerName: String(r.owner_name || ''),
        projectName: String(r.project_name || ''),
        warehouseName: WAREHOUSE_NAMES[Number(r.preferred_warehouse_id)] || '',
        ownerReference: String(r.owner_reference || ''),
        vendorReference: String(r.vendor_reference || ''),
        backOrder: Boolean(r.back_order),
        requestedShipDate,
        notes: String(r.order_notes || '').trim(),
      }
    })

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
