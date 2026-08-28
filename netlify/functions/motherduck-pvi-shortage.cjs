// netlify/functions/motherduck-pvi-shortage.cjs
//
// PVI Shortage Report -- Palermo's CALEDONIA finished. Built 2026-08-28
// out of the original Omni report (Front cnv_1c79gvh0, Katie Sobieski's
// request, thread also involving Hill Hamrick / Andrew Wasz). Moved out
// of Omni entirely per Dan's explicit ask -- the new joins below need
// custom exclusion logic Omni's join-builder handled clumsily for
// something this specific, and pasting the equivalent hand-written
// Advanced SQL into a fresh Omni tab failed with "could not run this
// query in this context" (root cause: the original Omni topic's base
// join used a modeled field, ${silver_datex_slv_tasks.effective_material_id},
// which only resolves inside that topic's own model context and isn't
// portable raw SQL).
//
// effective_material_id resolved: confirmed live in MotherDuck that
// material_id is populated on 100% (1282/1282) of Manual Pick Allocation
// tasks on this project over a 30-day sample -- so the "effective" field
// was just task.material_id directly, no COALESCE/fallback needed. Used
// as plain material_id below.
//
// What Katie originally asked for (5 items) and where each stands:
//   1. Remove Kenosha transfer columns (J-P). NOT addressed here --
//      turned out calc_1/2/3 in the old Omni query were CSW Notes / PVI
//      Remarks / Running Again (confirmed live against the actual Omni
//      dashboard), not the Kenosha columns. Still need Katie to name the
//      actual J-P columns. Per Dan's confirmation (2026-08-28): nobody
//      fills these three in anymore, so they're dropped entirely from
//      this rebuild rather than carried forward as always-blank columns.
//   2. Appointment time -- DONE (apptTime / apptLookupCode below).
//   3. Exclude orders processed via "Create Manual Allocation Tasks" --
//      NOT enabled. Lead: tasks created by a service-account-looking user
//      (FOOTPRINT\csw-fpservice) stood out in a 30-day sample, but this
//      is UNVALIDATED against orders Hill/Katie actually know were
//      processed that way. Left commented out below -- do not enable
//      without that validation, since this is now a customer-facing
//      automated send once the daily job is built, not just an internal
//      dashboard.
//   4. Exclude unallocated Lot/LP-specific order lines -- implemented,
//      but the "unallocated" status mapping is a GUESS (order line
//      status_id = 8, i.e. Datex's PLAN status) based on the status list
//      (INIT/CANC/ACC/PLAN/WORK/COMP/BKOR/NOINV/ERR/VAlloc) -- CONFIRM
//      WITH HILL before trusting this. Exposed as a togglable
//      `excludeLotLp` request param (default true) specifically so this
//      can be flipped off in the UI to compare before/after impact
//      without a code change while that confirmation is pending.
//   5. Soft Incoming inventory column -- implemented
//      (gold.available_inventory_by_material.soft_incoming_amount,
//      summed per material since that table has one row per
//      warehouse/location/LP/lot combo). NOTE: returned 0 for every row
//      tested live so far -- worth checking with Hill/Katie whether this
//      customer/project ever actually has soft-incoming inventory before
//      leaning on this column meaning anything.
//
// Also folded in per Hill's ask in the same thread: order line Marks
// field (marks below).
//
// Scope is intentionally identical to the original report: Manual Pick
// Allocation tasks, Processing orders, Palermos CALEDONIA finished
// project, released in the last `dayWindow` days (default 1, matching
// the original daily-report cadence). dayWindow is adjustable via the
// request body so this can be tested against a wider window without
// waiting for tomorrow's data.

const duckdb = require('duckdb');

const PROJECT_NAME = 'Palermos CALEDONIA finished';

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let dayWindow = 1;
  let excludeLotLp = true;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (body.dayWindow && Number.isFinite(Number(body.dayWindow))) {
      dayWindow = Math.max(1, Math.min(30, Number(body.dayWindow)));
    }
    if (typeof body.excludeLotLp === 'boolean') {
      excludeLotLp = body.excludeLotLp;
    }
  } catch (_) {
    // ignore, use defaults
  }

  const db = getDb();
  const conn = db.connect();

  const runQuery = (sql) =>
    new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    await runQuery(`ATTACH 'md:production_db' (READ_ONLY)`);

    const sql = `
      WITH base AS (
        SELECT
          m.lookup_code AS item_code,
          m.material_name AS description,
          o.lookup_code AS order_number,
          o.order_id,
          oa.first_name AS destination,
          t.expected_inventory_amount AS qty_needed_short
        FROM production_db.silver.datex_slv_tasks t
        LEFT JOIN production_db.silver.datex_slv_taskstatuses ts ON t.status_id = ts.task_status_id
        LEFT JOIN production_db.silver.datex_slv_projects p ON t.project_id = p.project_id
        LEFT JOIN production_db.silver.datex_slv_operationcodes oc ON t.operation_code_id = oc.operation_code_id
        LEFT JOIN production_db.silver.datex_slv_orders o ON t.order_id = o.order_id
        LEFT JOIN production_db.silver.datex_slv_orderstatuses os ON o.order_status_id = os.order_status_id
        LEFT JOIN production_db.silver.datex_slv_orderaddresses oa ON o.order_id = oa.order_id
        LEFT JOIN production_db.silver.datex_slv_materials m ON t.material_id = m.material_id
        WHERE oc.operation_code_name = 'Manual Pick Allocation'
          AND oa.type_id = 2
          AND os.status_name = 'Processing'
          AND p.project_name = '${PROJECT_NAME}'
          AND t.created_sys_date_time >= CURRENT_DATE - INTERVAL ${dayWindow} DAY
          AND ts.status_name = 'Released'
          -- #3 UNCONFIRMED -- do not enable without validating against
          -- known orders (see file header):
          -- AND t.created_sys_user NOT LIKE '%fpservice%'
      ),
      appt AS (
        SELECT
          o.lookup_code AS order_number,
          MIN(date_trunc('minute', ta.scheduled_arrival)) AS appt_time,
          MIN(ta.lookup_code) AS appt_lookup_code
        FROM production_db.gold.truck_appointments ta
        LEFT JOIN production_db.silver.datex_slv_dockappointments da ON ta.appointment_id = da.dock_appointment_id
        LEFT JOIN production_db.silver.datex_slv_dockappointmentitems dai ON da.dock_appointment_id = dai.dock_appointment_id
        LEFT JOIN production_db.silver.datex_slv_orders o ON dai.item_entity_id = o.order_id AND dai.item_entity_type = 'Order'
        WHERE (NOT (ta.dock_status_name LIKE '%Completed%' OR ta.dock_status_name LIKE '%Cancelled%') OR ta.dock_status_name IS NULL)
          AND ta.project_name = '${PROJECT_NAME}'
          AND ta.scheduled_arrival >= CURRENT_DATE - INTERVAL 7 DAY
        GROUP BY o.lookup_code
      ),
      lot_status AS (
        SELECT
          m.lookup_code AS item_code,
          MIN(CASE l.status_id
              WHEN 1 THEN 'Active' WHEN 2 THEN 'Inactive' WHEN 2000 THEN 'Discontinued'
              WHEN 2001 THEN 'Damaged No Charge CSW' WHEN 2002 THEN 'HOLD' WHEN 2004 THEN 'Damaged customer'
              WHEN 2005 THEN 'Damaged / Hold' WHEN 2006 THEN 'Short Date' WHEN 2007 THEN 'Incubation Hold'
              WHEN 2008 THEN 'ADON' WHEN 2009 THEN 'Administrative' WHEN 2010 THEN 'USDA'
              WHEN 2011 THEN 'Food Safety' WHEN 2012 THEN 'QA Hold' WHEN 2015 THEN 'Pending Hold'
              WHEN 2016 THEN 'Inactive/Active' WHEN 2019 THEN 'POS Hold' WHEN 2020 THEN 'Mislabeled Pallet Correction Pending'
              WHEN 2022 THEN 'NOT RELEASED' ELSE 'Unknown Status' END) AS non_active_inventory
        FROM production_db.silver.datex_slv_licenseplates lp
        LEFT JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lp.license_plate_id = lpc.license_plate_id
        LEFT JOIN production_db.silver.datex_slv_lots l ON lpc.lot_id = l.lot_id
        LEFT JOIN production_db.silver.datex_slv_materials m ON l.material_id = m.material_id
        LEFT JOIN production_db.silver.datex_slv_projects p ON m.project_id = p.project_id
        WHERE (l.status_id != 1 OR l.status_id IS NULL)
          AND p.project_name = '${PROJECT_NAME}'
        GROUP BY m.lookup_code
      ),
      orderline_flags AS (
        SELECT
          o.order_id,
          MIN(ol."Marks") AS marks,
          MAX(CASE WHEN ol.status_id = 8   -- PLAN / unallocated -- CONFIRM WITH HILL, see file header
                    AND (ol.lot_id IS NOT NULL OR ol.license_plate_id IS NOT NULL)
                   THEN 1 ELSE 0 END) AS has_unallocated_lot_lp_line
        FROM production_db.silver.datex_slv_orders o
        LEFT JOIN production_db.silver.datex_slv_orderlines ol ON o.order_id = ol.order_id
        GROUP BY o.order_id
      ),
      soft_incoming AS (
        SELECT
          m.lookup_code AS item_code,
          SUM(a.soft_incoming_amount) AS soft_incoming_amount
        FROM production_db.gold.available_inventory_by_material a
        LEFT JOIN production_db.silver.datex_slv_materials m ON a.material_id = m.material_id
        GROUP BY m.lookup_code
      )
      SELECT
        base.item_code,
        base.description,
        base.order_number,
        base.destination,
        appt.appt_time,
        appt.appt_lookup_code,
        lot_status.non_active_inventory,
        base.qty_needed_short,
        soft_incoming.soft_incoming_amount,
        orderline_flags.marks,
        orderline_flags.has_unallocated_lot_lp_line
      FROM base
      LEFT JOIN appt ON base.order_number = appt.order_number
      LEFT JOIN lot_status ON base.item_code = lot_status.item_code
      LEFT JOIN orderline_flags ON base.order_id = orderline_flags.order_id
      LEFT JOIN soft_incoming ON base.item_code = soft_incoming.item_code
      ${excludeLotLp ? 'WHERE COALESCE(orderline_flags.has_unallocated_lot_lp_line, 0) = 0' : ''}
      ORDER BY appt.appt_time NULLS FIRST
      LIMIT 1000
    `;

    const rows = await runQuery(sql);

    const items = rows.map((r) => ({
      itemCode: r.item_code,
      description: r.description,
      orderNumber: r.order_number,
      destination: r.destination,
      apptTime: r.appt_time,
      apptLookupCode: r.appt_lookup_code,
      nonActiveInventory: r.non_active_inventory,
      qtyNeededShort: r.qty_needed_short === null || r.qty_needed_short === undefined ? null : Number(r.qty_needed_short),
      softIncomingAmount: r.soft_incoming_amount === null || r.soft_incoming_amount === undefined ? null : Number(r.soft_incoming_amount),
      marks: r.marks,
      hasUnallocatedLotLpLine: !!r.has_unallocated_lot_lp_line,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        dayWindow,
        excludeLotLp,
        fetchedAt: new Date().toISOString(),
      }),
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
