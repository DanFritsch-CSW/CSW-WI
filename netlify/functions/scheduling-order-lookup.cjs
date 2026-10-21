'use strict'

// Order lookup for the reference fixer -- ADDED 2026-10-21 (Dan's explicit request: Birchwood /
// Sargento Reference # fix). A SEPARATE, narrower sibling of scheduling-order-search.cjs: that
// function matches reference fields by EXACT text, which is right for the Order Search tab and
// the webhook's intake lookup but cannot find Birchwood's POs (Datex stores vendor_reference as
// "000516305"; the email and the agent have "516305"). Rather than change a function the plugin
// UI and the intake webhook both rely on, this one is new and used only by the
// scheduling-reference-fixer Edge Function.
//
// Differences from scheduling-order-search:
//   - Compares reference fields with leading zeros ignored and case/whitespace ignored (the
//     query is also stripped of parentheses and a leading "PO", because the agent sometimes
//     captures "(000)516306" or "PO142314").
//   - The OWNER is required and must match the order's Datex owner exactly (case-insensitive).
//     This is what keeps a coincidental number at another customer from matching.
//   - Returns which field matched (matchedOn): if the agent captured the ORDER number (Sargento
//     "0010315552") the fixer needs to add the PO, and if it captured the PO the fixer adds the
//     order number.
//   - Still restricted to active orders (Created / Processing) so stale history cannot collide
//     (e.g. a June 2026 Birchwood order whose lookup code is 516306 vs the live PO 516306).
//
// Verified against live data before writing: "(000)516306" -> order 811895 (vendor 000516305
// style zeros), "0010315552" -> vendor 2833801 via lookup_code, "PO142314" -> 0010315594, and a
// Birchwood PO asked with owner "Sargento Cheese Inc." returns nothing.
//
// POST body: { query: string, owner: string }
// Response:  { found, count, query, orders: [{ orderId, lookupCode, ownerReference,
//             vendorReference, statusName, ownerName, projectName, warehouseName, matchedOn,
//             createdAt }] }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Best-effort label only (same ids as scheduling-order-search.cjs).
const WAREHOUSE_NAMES = { 1: 'CAL', 3: 'EC', 4: 'MAD', 5: 'KEN', 6: 'WR' }
const ACTIVE_STATUS_IDS = [1, 2] // Created, Processing

function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// "(000)516306" -> "516306"; "PO142314" -> "142314"; "0010315552" -> "10315552"; "9138676z" -> "9138676Z"
function normQuery(raw) {
  return String(raw || '')
    .replace(/[()]/g, '')
    .replace(/^po/i, '')
    .trim()
    .toUpperCase()
    .replace(/^0+/, '')
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

  const query = String(body.query || '').trim()
  const owner = String(body.owner || '').trim()
  const q = normQuery(query)
  if (!q) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing or empty query' }) }
  }
  if (!owner) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Missing owner (required so a number cannot match another customer)' }) }
  }

  const qLit = sqlLit(q)
  const norm = (col) => `ltrim(upper(trim(${col})), '0')`
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
      o.created_sys_date_time,
      CASE
        WHEN ${norm('o.vendor_reference')} = ${qLit} THEN 'vendor_reference'
        WHEN ${norm('o.lookup_code')} = ${qLit} THEN 'lookup_code'
        ELSE 'owner_reference'
      END AS matched_on
    FROM production_db.silver.datex_slv_orders o
    LEFT JOIN production_db.silver.datex_slv_orderstatuses s ON s.order_status_id = o.order_status_id
    LEFT JOIN latest_projects p ON p.project_id = o.project_id
    LEFT JOIN latest_owners ow ON ow.owner_id = p.owner_id
    WHERE (
      ${norm('o.lookup_code')} = ${qLit}
      OR ${norm('o.owner_reference')} = ${qLit}
      OR ${norm('o.vendor_reference')} = ${qLit}
    )
    AND o.order_status_id IN (${ACTIVE_STATUS_IDS.join(', ')})
    AND LOWER(ow.owner_name) = LOWER(${sqlLit(owner)})
    ORDER BY o.created_sys_date_time DESC
    LIMIT 10
  `

  // Same Netlify/duckdb pattern as scheduling-order-search.cjs.
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
      ownerReference: String(r.owner_reference || ''),
      vendorReference: String(r.vendor_reference || ''),
      statusName: String(r.status_name || ''),
      ownerName: String(r.owner_name || ''),
      projectName: String(r.project_name || ''),
      warehouseName: WAREHOUSE_NAMES[Number(r.preferred_warehouse_id)] || '',
      matchedOn: String(r.matched_on || ''),
      createdAt: r.created_sys_date_time ? new Date(r.created_sys_date_time).toISOString() : null,
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
