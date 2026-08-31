// netlify/functions/motherduck-pretzilla-shortage.cjs
//
// Pretzilla Kenosha Shortage Report — automates the team's daily hand-built
// Excel (Pretzilla_Template.xlsx / 09_01pretzilla_shortage.xlsx). Built
// 2026-08-31 per Dan's ask (Fathom "Pretzilla Daily" call, 2026-08-31) +
// validated live against the team's actual 09/01 Excel for Kenosha
// (SO620075, SO620188, SO620189, SO620231, SO620285, SO620319): 6 of 7
// materials matched exactly. The 7th (109282) differed only because the
// order qty changed and inventory got picked between the Excel build and
// the live pull — expected drift, not a bug, confirmed by checking the
// raw orderline (modified_sys_date_time same day, 10:50am).
//
// Also caught a real false-shortage in the manual sheet: material 208494
// showed SHORT = -66 because Active/Inactive/Inbound were left BLANK (not
// zero) in the Excel — the row was never finished. Excel's SUM/IF formula
// treats blank as 0, producing a false shortage. Live pull shows 3,031
// active on hand, i.e. not actually short. The automated version would not
// have produced this false positive.
//
// SCOPE (confirmed with Dan 2026-08-31): Kenosha only, project_ids 230
// (PRETZ5) and 342 (PRTZL5, COOLER). NOT the other 4 Pretzilla project_ids
// (CAL/MAD) yet, and NOT the other ~16 CSW customers Dan mentioned on the
// call as eventual candidates for this same report shape. Extend to a
// CUSTOMERS-style config object (see motherduck-exp-check.cjs for the
// pattern) once Kenosha is validated across a full week.
//
// DEMAND — two independent sources, cross-checked against each other:
//
//   1. PRIMARY (appointment-based): datex_slv_dockappointmentitems ->
//      datex_slv_dockappointments, filtered to appointments scheduled for
//      targetDate. This is what the team actually does on the call
//      ("look at all the appointments for tomorrow") and is the only
//      reliable way to catch multi-order consolidated trucks. Validated
//      live for 2026-09-01: a single appointment ("AMC WM Belvedere
//      61915633") covering 12 separate orders resolved correctly, all 12
//      attributed to the right appointment via the item_entity_type='Order'
//      join — same relational-join pattern already proven for KEN drop-rule
//      projects elsewhere in this app. Also correctly picked up SO620189,
//      whose requested_delivery_date (8/27) is BEFORE targetDate but whose
//      appointment IS scheduled for targetDate (an overdue/still-open
//      order) — something the requested_delivery_date-only approach below
//      would miss on its own.
//
//   2. CROSS-CHECK (requested_delivery_date): datex_slv_orders WHERE
//      requested_delivery_date = targetDate AND fulfillment_date IS NULL.
//      Any order in this set NOT found via the appointment join is
//      surfaced in `needsReview` — real demand that exists in Datex but
//      hasn't been tied to a scheduled truck yet. On 2026-08-31, this
//      cross-check surfaced 12 real orders (the Belvedere truck) that
//      weren't in the team's in-progress Excel yet — i.e. this is a real
//      completeness check, not just a theoretical safety net.
//
// INVENTORY — gold.available_inventory_by_lp, warehouse_id=5 (Kenosha),
// summed per material_id. This gold table already carries exactly the
// fields the manual process hand-copies:
//   active_packaged_amount         -> Active
//   inactive_packaged_amount       -> Inactive        (display only)
//   incoming_packaged_amount       -> Inbound (auto)   (overridable, see
//                                                        pretzilla_shortage_overrides)
//   soft_allocated_packaged_amount -> Soft-Allocated   (display only)
// Validated live: Active/Inactive matched the Excel exactly for 6 of 7
// materials (the 7th drifted for the same real-world reason as Needed,
// above). Soft-Allocated read back as 0 across the board at pull time even
// though the Excel showed real values — expected, per Dan's own framing on
// the call: soft-allocated converts to hard-allocated (picked) as the day
// progresses, so a later-in-the-day pull naturally reads lower than a
// morning one. The field itself is real and populated elsewhere in the
// system (spot-checked: 301 rows nonzero org-wide at validation time).
//
// SHORT = Active + Inbound - Needed, only returned when negative. This
// matches the source spreadsheet's ACTUAL formula (row 26) exactly —
// Inactive and Soft-Allocated are informational only in the original Excel
// too (confirmed by reading the formula itself, not by the verbal
// description of it from the Fathom call, which don't match).
//
// targetDate is REQUIRED and must be pre-computed by the caller (frontend
// computes "tomorrow" in America/Chicago — see tomorrowCentral() in
// src/lib/pretzillaShortage.js). This function deliberately never computes
// "today"/"tomorrow" itself, to avoid the naive-timestamp/UTC
// function-runtime trap documented elsewhere in this codebase (see
// completed_date_time handling in other MotherDuck functions).

const duckdb = require('duckdb');

const PROJECT_IDS = [230, 342]; // Pretzilla Kenosha (PRETZ5) + COOLER (PRTZL5)
const WAREHOUSE_ID = 5; // Kenosha

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let targetDate;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    targetDate = body.targetDate;
    if (!isValidDate(targetDate)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'targetDate (YYYY-MM-DD) is required' }),
      };
    }
  } catch (_) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid JSON body' }) };
  }

  const db = getDb();
  const conn = db.connect();
  const runQuery = (sql) =>
    new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    await runQuery(`ATTACH 'md:production_db' (READ_ONLY)`);

    // Appointments scheduled for targetDate whose dockappointmentitems
    // resolve to a Pretzilla KEN order (item_entity_type='Order').
    const appointmentsSql = `
      SELECT DISTINCT
        da.dock_appointment_id AS appt_id,
        da.lookup_code         AS appt_code,
        da.scheduled_arrival   AS scheduled_arrival,
        o.order_id             AS order_id,
        o.lookup_code          AS order_no
      FROM production_db.silver.datex_slv_dockappointmentitems dai
      JOIN production_db.silver.datex_slv_dockappointments da
        ON da.dock_appointment_id = dai.dock_appointment_id
      JOIN production_db.silver.datex_slv_orders o
        ON o.order_id = dai.item_entity_id AND dai.item_entity_type = 'Order'
      WHERE o.project_id IN (${PROJECT_IDS.join(',')})
        AND CAST(da.scheduled_arrival AS DATE) = DATE '${targetDate}'
      ORDER BY da.scheduled_arrival, o.lookup_code
    `;
    const appointmentRows = await runQuery(appointmentsSql);

    // Cross-check set: orders whose requested_delivery_date = targetDate
    // and not yet fulfilled, regardless of whether an appointment has been
    // scheduled for them yet. Anything here not covered by the appointment
    // join above is real orphaned demand -> needsReview.
    const crossCheckSql = `
      SELECT order_id, lookup_code AS order_no, requested_delivery_date
      FROM production_db.silver.datex_slv_orders
      WHERE project_id IN (${PROJECT_IDS.join(',')})
        AND CAST(requested_delivery_date AS DATE) = DATE '${targetDate}'
        AND fulfillment_date IS NULL
    `;
    const crossCheckRows = await runQuery(crossCheckSql);

    const matchedOrderIds = new Set(appointmentRows.map((r) => r.order_id));
    const needsReview = crossCheckRows
      .filter((r) => !matchedOrderIds.has(r.order_id))
      .map((r) => ({ orderNo: r.order_no, requestedDeliveryDate: r.requested_delivery_date }));

    const orderIds = [...new Set([
      ...appointmentRows.map((r) => r.order_id),
      ...crossCheckRows.map((r) => r.order_id),
    ])];

    if (orderIds.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDate,
          materials: [],
          appointments: [],
          needsReview,
          orderCount: 0,
          fetchedAt: new Date().toISOString(),
        }),
      };
    }

    // Needed per material, summed across every resolved order (both the
    // appointment-matched set and the cross-check orphans — an orphan
    // order's demand is still real demand even if it's not on a truck yet).
    const neededSql = `
      SELECT
        m.material_id            AS material_id,
        m.lookup_code            AS material_code,
        m.description            AS description,
        SUM(ol.packaged_amount)  AS needed
      FROM production_db.silver.datex_slv_orderlines ol
      JOIN production_db.silver.datex_slv_materials m ON m.material_id = ol.material_id
      WHERE ol.order_id IN (${orderIds.join(',')})
      GROUP BY m.material_id, m.lookup_code, m.description
      ORDER BY m.lookup_code
    `;
    const neededRows = await runQuery(neededSql);
    const materialIds = neededRows.map((r) => r.material_id);

    const invSql = `
      SELECT
        material_id,
        SUM(active_packaged_amount)         AS active,
        SUM(inactive_packaged_amount)       AS inactive,
        SUM(incoming_packaged_amount)       AS inbound_auto,
        SUM(soft_allocated_packaged_amount) AS soft_alloc
      FROM production_db.gold.available_inventory_by_lp
      WHERE warehouse_id = ${WAREHOUSE_ID}
        AND material_id IN (${materialIds.join(',') || '-1'})
      GROUP BY material_id
    `;
    const invRows = materialIds.length ? await runQuery(invSql) : [];
    const invByMaterial = new Map(invRows.map((r) => [r.material_id, r]));

    const materials = neededRows.map((r) => {
      const inv = invByMaterial.get(r.material_id) || {};
      const needed = Number(r.needed) || 0;
      const active = Number(inv.active) || 0;
      const inactive = Number(inv.inactive) || 0;
      const inboundAuto = Number(inv.inbound_auto) || 0;
      const softAlloc = Number(inv.soft_alloc) || 0;
      const rawShort = active + inboundAuto - needed;
      return {
        materialCode: r.material_code,
        description: r.description,
        needed,
        active,
        inactive,
        inboundAuto,
        softAlloc,
        short: rawShort < 0 ? rawShort : 0,
      };
    });

    // Group appointment rows into one entry per appointment, with the list
    // of orders it covers (this is the "12 orders, 1 truck" view).
    const appointments = [];
    const apptIndex = new Map();
    for (const r of appointmentRows) {
      let entry = apptIndex.get(r.appt_id);
      if (!entry) {
        entry = {
          apptId: r.appt_id,
          apptCode: r.appt_code,
          scheduledArrival: r.scheduled_arrival,
          orders: [],
        };
        apptIndex.set(r.appt_id, entry);
        appointments.push(entry);
      }
      entry.orders.push(r.order_no);
    }
    appointments.sort((a, b) => new Date(a.scheduledArrival) - new Date(b.scheduledArrival));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDate,
        materials,
        appointments,
        needsReview,
        orderCount: orderIds.length,
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
