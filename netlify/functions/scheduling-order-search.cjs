'use strict'

// netlify/functions/scheduling-order-search.cjs — added 2026-08-21.
//
// Kenosha Order Search, Phase 1 (per Dan/Kay's 2026-08-20 meeting): given a
// reference string, confirm whether an order exists in Datex and show
// enough identifying info (project, owner, warehouse, status) for a CSR
// to visually confirm it's the right order — before this, Kay had to
// manually check Datex for every Kenosha appointment's order details.
//
// Lookup key deliberately checks all THREE fields the meeting identified
// as in use across customers, since which one a given customer's
// reference actually matches varies (owner_reference, vendor_reference,
// or lookup_code — the last of which matches owner_reference ~90% of the
// time per Kay, but not always):
//   - owner_reference
//   - vendor_reference
//   - lookup_code
//
// Data source: production_db.silver.datex_slv_orders (MotherDuck), joined
// against datex_slv_projects/datex_slv_accounts/datex_slv_warehouses/
// datex_slv_orderstatuses for human-readable names instead of raw IDs.
// silver preferred over bronze per this org's standing convention.
//
// This same view already carries requested_delivery_date and Notes —
// Phase 2 (per the meeting: "pull and display the requested delivery date
// and relevant notes") needs NO new data plumbing, just returning fields
// already selected here. Deliberately returned in the Phase 1 response
// now (rather than added later) since there's no cost to including them;
// only the UI decision of when to surface them is actually being phased.
//
// Query uses ?-parameterized values (DuckDB node bindings support
// positional params), not string interpolation — this endpoint takes
// arbitrary user-typed input, unlike this codebase's other MotherDuck
// functions which only interpolate internally-generated values (e.g.
// motherduck-exp-check.cjs's project ID list).
//
// POST /.netlify/functions/scheduling-order-search
// Body: { query: string }
// Response: { found: boolean, count: number, orders: [...], query }

const duckdb = require('duckdb');

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let query;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    query = (body.query || '').trim();
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!query) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing query' }) };
  }
  if (query.length > 100) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Query too long' }) };
  }

  const db = getDb();
  const conn = db.connect();

  const runQuery = (sql) =>
    new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  // Parameterized variant — takes positional ? params, used for the
  // user-supplied search string specifically.
  const runQueryParams = (sql, params) =>
    new Promise((resolve, reject) => {
      conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    await runQuery(`ATTACH 'md:production_db' (READ_ONLY)`);

    const sql = `
      SELECT
        o.order_id,
        o.lookup_code,
        o.owner_reference,
        o.vendor_reference,
        o.requested_delivery_date,
        o.Notes AS notes,
        o.order_status_id,
        os.status_name,
        o.created_sys_date_time,
        o.back_order,
        p.project_name,
        a.account_name AS owner_name,
        w.warehouse_name
      FROM production_db.silver.datex_slv_orders o
      LEFT JOIN production_db.silver.datex_slv_projects p ON p.project_id = o.project_id
      LEFT JOIN production_db.silver.datex_slv_accounts a ON a.account_id = p.owner_id
      LEFT JOIN production_db.silver.datex_slv_warehouses w ON w.warehouse_id = o.preferred_warehouse_id
      LEFT JOIN production_db.silver.datex_slv_orderstatuses os ON os.order_status_id = o.order_status_id
      WHERE UPPER(TRIM(o.owner_reference)) = UPPER(TRIM(?))
         OR UPPER(TRIM(o.vendor_reference)) = UPPER(TRIM(?))
         OR UPPER(TRIM(o.lookup_code)) = UPPER(TRIM(?))
      ORDER BY o.created_sys_date_time DESC
      LIMIT 25
    `;

    const rows = await runQueryParams(sql, [query, query, query]);

    const orders = rows.map((r) => ({
      orderId: r.order_id,
      lookupCode: r.lookup_code,
      ownerReference: r.owner_reference,
      vendorReference: r.vendor_reference,
      requestedDeliveryDate: r.requested_delivery_date,
      notes: r.notes,
      statusName: r.status_name,
      backOrder: !!r.back_order,
      createdAt: r.created_sys_date_time,
      projectName: r.project_name,
      ownerName: r.owner_name,
      warehouseName: r.warehouse_name,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: orders.length > 0, count: orders.length, orders, query }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  } finally {
    conn.close();
    db.close(() => {});
  }
};
