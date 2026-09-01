// netlify/functions/motherduck-shortage-report.cjs
//
// Customer Shortage Report backend — GENERALIZED 2026-09-01 from
// motherduck-pretzilla-shortage.cjs to accept {targetDate, reportKey}
// instead of being hardcoded to Pretzilla/Kenosha. Per Dan's explicit
// direction when Sargento (Caledonia) was added: "mimic Sargento just as
// Pretzilla -- any future additions will probably be for all customers."
// Scope (warehouseId/projectIds/apptTag) now comes from
// lib/shortage-report-configs.cjs — the same config file
// lib/shortage-report-email-shared.cjs uses, so the report and its email
// draft can never scope-drift from each other. Adding a third customer
// later means one new entry in that config file; nothing here changes.
//
// motherduck-pretzilla-shortage.cjs is now ORPHANED/unregistered (left in
// place, no file-delete tool, same pattern as dockcounts-digest-run.cjs).
// Everything below is otherwise an EXACT port of that file's query logic
// — see its header for the full original validation history (live Excel
// comparison, the appointment-coverage bug, the soft-allocated bug, the
// Allocated-column and Inbound-removed decisions). None of that logic
// changed, only the scope parameters.
//
// DEMAND (Needed) — appointments-only, sourced STRICTLY from
// dockappointmentitems -> Order links, scoped to the reportKey's
// warehouse/projects/appointment tag. Unlinked/no-order appointments are
// surfaced for visibility (linkStatus) but excluded from Needed.
//
// OUTBOUND ONLY, FIXED 2026-09-01 (later same day): appointment query now
// joins silver.datex_slv_dockappointmenttypes and filters to
// dock_appointment_type_name LIKE 'Outbound%'. Found live on Sargento
// (Caledonia): several appointments tagged (SARG) were actually type_id=1
// ("Inbound") carrying PO-style numbers (e.g. "4500620025") that don't
// exist as sales orders in Datex at all — they showed up as "No Order
// Within Datex" noise and, worse, would have been silently excluded from
// Needed anyway since they're not real outbound demand, but cluttered the
// appointments panel. Pretzilla's (PZ)-tagged appointments happened to
// already be 100% Outbound, which is why this was invisible there — this
// filter is a no-op for Pretzilla, a real fix for Sargento, and applies
// uniformly to any future customer per Dan's ask ("make this consistent
// across all customers").
//
// SHORT = Active - Needed, only returned when negative. Inactive and
// Allocated (soft + hard) are informational only, not netted in.
//
// targetDate is REQUIRED, pre-computed by the frontend in America/Chicago.

const duckdb = require('duckdb');
const { REPORT_CONFIGS } = require('./lib/shortage-report-configs.cjs');

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Pulls candidate order numbers (e.g. "SO620394", "0010308494") out of an
// appointment name via regex. Both Pretzilla (SO######) and Sargento
// (0010######) order lookup_codes observed live match this pattern —
// 6+ digit numeric runs, with or without a leading letter prefix.
function extractOrderNumbers(text) {
  return [...new Set((text.match(/\b(?:[A-Z]{0,3}\d{6,})\b/g) || []))];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let targetDate, reportKey;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    targetDate = body.targetDate;
    reportKey = body.reportKey;
    if (!isValidDate(targetDate)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'targetDate (YYYY-MM-DD) is required' }),
      };
    }
    if (!reportKey || !REPORT_CONFIGS[reportKey]) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `reportKey is required and must be one of: ${Object.keys(REPORT_CONFIGS).join(', ')}` }),
      };
    }
  } catch (_) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid JSON body' }) };
  }

  const { warehouseId: WAREHOUSE_ID, projectIds: PROJECT_IDS, apptTag: APPT_TAG } = REPORT_CONFIGS[reportKey];

  const db = getDb();
  const conn = db.connect();
  const runQuery = (sql) =>
    new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    await runQuery(`ATTACH 'md:production_db' (READ_ONLY)`);

    const allApptsSql = `
      SELECT da.dock_appointment_id AS appt_id, da.lookup_code AS appt_code, da.scheduled_arrival
      FROM production_db.silver.datex_slv_dockappointments da
      JOIN production_db.silver.datex_slv_dockappointmenttypes t
        ON t.dock_appointment_type_id = da.type_id
      WHERE da.warehouse_id = ${WAREHOUSE_ID}
        AND da.lookup_code LIKE '%${APPT_TAG}%'
        AND da.status_id NOT IN (4, 5)
        AND t.dock_appointment_type_name LIKE 'Outbound%'
        AND CAST(da.scheduled_arrival AS DATE) = DATE '${targetDate}'
      ORDER BY da.scheduled_arrival
    `;
    const allApptRows = await runQuery(allApptsSql);

    const linkedSql = `
      SELECT
        dai.dock_appointment_id AS appt_id,
        o.order_id              AS order_id,
        o.lookup_code            AS order_no,
        s.status_name            AS order_status
      FROM production_db.silver.datex_slv_dockappointmentitems dai
      JOIN production_db.silver.datex_slv_orders o
        ON o.order_id = dai.item_entity_id AND dai.item_entity_type = 'Order'
      LEFT JOIN production_db.silver.datex_slv_orderstatuses s
        ON s.order_status_id = o.order_status_id
      WHERE o.project_id IN (${PROJECT_IDS.join(',')})
        AND dai.dock_appointment_id IN (${allApptRows.map((r) => r.appt_id).join(',') || '-1'})
    `;
    const linkedRows = allApptRows.length ? await runQuery(linkedSql) : [];

    const linkedByAppt = new Map();
    for (const r of linkedRows) {
      if (!linkedByAppt.has(r.appt_id)) linkedByAppt.set(r.appt_id, []);
      linkedByAppt.get(r.appt_id).push({ orderId: r.order_id, orderNo: r.order_no, orderStatus: r.order_status });
    }

    const unlinkedAppts = allApptRows.filter((r) => !linkedByAppt.has(r.appt_id));
    const candidateNumbers = [...new Set(
      unlinkedAppts.flatMap((r) => extractOrderNumbers(r.appt_code))
    )];
    let existingOrdersByCode = new Map();
    if (candidateNumbers.length) {
      const quoted = candidateNumbers.map((c) => `'${c}'`).join(',');
      const existSql = `
        SELECT o.lookup_code, o.order_id, s.status_name AS order_status
        FROM production_db.silver.datex_slv_orders o
        LEFT JOIN production_db.silver.datex_slv_orderstatuses s
          ON s.order_status_id = o.order_status_id
        WHERE o.lookup_code IN (${quoted})
      `;
      const existRows = await runQuery(existSql);
      existingOrdersByCode = new Map(existRows.map((r) => [r.lookup_code, { orderId: r.order_id, orderStatus: r.order_status }]));
    }

    const appointments = allApptRows.map((r) => {
      const linked = linkedByAppt.get(r.appt_id);
      if (linked && linked.length) {
        return {
          apptId: r.appt_id,
          apptCode: r.appt_code,
          scheduledArrival: r.scheduled_arrival,
          linkStatus: 'linked',
          orders: linked.map((l) => ({ orderNo: l.orderNo, orderStatus: l.orderStatus })),
        };
      }
      const candidates = extractOrderNumbers(r.appt_code);
      const foundExisting = candidates.filter((c) => existingOrdersByCode.has(c));
      if (foundExisting.length) {
        return {
          apptId: r.appt_id,
          apptCode: r.appt_code,
          scheduledArrival: r.scheduled_arrival,
          linkStatus: 'not_linked',
          orders: foundExisting.map((c) => ({
            orderNo: c,
            orderStatus: existingOrdersByCode.get(c).orderStatus,
          })),
        };
      }
      return {
        apptId: r.appt_id,
        apptCode: r.appt_code,
        scheduledArrival: r.scheduled_arrival,
        linkStatus: 'no_order_in_datex',
        orders: candidates.map((c) => ({ orderNo: c, orderStatus: null })),
      };
    });

    const orderIds = [...new Set(linkedRows.map((r) => r.order_id))];

    if (orderIds.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportKey,
          targetDate,
          materials: [],
          appointments,
          orderCount: 0,
          fetchedAt: new Date().toISOString(),
        }),
      };
    }

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
        active_packaged_amount         AS active,
        inactive_packaged_amount       AS inactive,
        soft_allocated_packaged_amount AS soft_alloc,
        allocated_packaged_amount      AS hard_alloc
      FROM production_db.gold.available_inventory_by_material
      WHERE warehouse_id = ${WAREHOUSE_ID}
        AND material_id IN (${materialIds.join(',') || '-1'})
    `;
    const invRows = materialIds.length ? await runQuery(invSql) : [];
    const invByMaterial = new Map(invRows.map((r) => [r.material_id, r]));

    const materials = neededRows.map((r) => {
      const inv = invByMaterial.get(r.material_id) || {};
      const needed = Number(r.needed) || 0;
      const active = Number(inv.active) || 0;
      const inactive = Number(inv.inactive) || 0;
      const softAlloc = Number(inv.soft_alloc) || 0;
      const hardAlloc = Number(inv.hard_alloc) || 0;
      const rawShort = active - needed;
      return {
        materialCode: r.material_code,
        description: r.description,
        needed,
        active,
        inactive,
        allocated: softAlloc + hardAlloc,
        short: rawShort < 0 ? rawShort : 0,
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportKey,
        targetDate,
        materials,
        appointments,
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
