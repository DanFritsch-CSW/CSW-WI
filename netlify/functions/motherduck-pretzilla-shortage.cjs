// netlify/functions/motherduck-pretzilla-shortage.cjs
//
// Customer Shortage Report backend. Automates the team's daily hand-built
// shortage Excel (Pretzilla_Template.xlsx / 09_01pretzilla_shortage.xlsx).
// Built 2026-08-31 per Dan's ask (Fathom "Pretzilla Daily" call) +
// validated live against the team's actual 09/01 Excel for Kenosha: 6 of 7
// materials matched exactly; the 7th was real order/inventory drift
// between Excel-build time and pull time (confirmed via
// modified_sys_date_time on the raw orderline).
//
// SCOPE (confirmed with Dan 2026-08-31): Kenosha only, project_ids 230
// (PRETZ5) and 342 (PRTZL5, COOLER). Appointment coverage is scoped via
// the lookup_code containing "(PZ)" (Datex's own convention for Pretzilla
// Kenosha appointments — confirmed against the live Dock Appointments Hub
// filtered to Owner=PRETZ9/Project=PRETZ5/Warehouse=CSW-Kenosha, every row
// carries a "(PZ)" tag somewhere in its name, not necessarily at the
// start — some are prefixed with "$" or "*" first, e.g.
// "$ *(PZ) -KENOSHA SO620189" — hence LIKE '%(PZ)%', not '(PZ)%'). NOT the
// other 4 Pretzilla project_ids (CAL/MAD) yet. Extend to a CUSTOMERS-style
// config object (see motherduck-exp-check.cjs) once Kenosha is validated.
//
// === APPOINTMENT COVERAGE BUG, FOUND AND FIXED 2026-09-01 ===
// An earlier version of this function only surfaced appointments that had
// an actual dockappointmentitems -> Order relational link. Checked live
// against every "(PZ)" appointment scheduled 9/2: only 2 of 6 had that
// link. The other 4 had real order numbers TYPED INTO THE APPOINTMENT
// NAME as free text (e.g. "(PZ) - SO620392, SO620346, SO620347") with NO
// relational link in Datex at all — meaning 3 of those order numbers
// (SO620392/346/347) are real, current orders due 9/2 that the old query
// silently missed entirely. A 4th referenced order number (SO620402,
// "FRONT ROYAL") doesn't exist in datex_slv_orders at all yet — an
// appointment placeholder ahead of the order being created.
//
// Per Dan's explicit decision: do NOT parse those text-only order numbers
// into the demand/Needed calculation (too uncertain to trust
// automatically) — but DO surface every appointment, classified by link
// status, so a human can see what's missing:
//   - "linked":            dockappointmentitems row exists, order pulled
//                           into Needed as before.
//   - "not_linked":        no relational link, but the appointment name
//                           contains an order number (regex /SO\d{6}/)
//                           that DOES exist in datex_slv_orders. Shown,
//                           NOT counted in Needed.
//   - "no_order_in_datex": no relational link, and either no order-number
//                           pattern in the name, or the referenced number
//                           doesn't exist in datex_slv_orders at all
//                           (includes pure holds like "MRS HELD" and
//                           not-yet-created orders like the FRONT ROYAL
//                           case above).
//
// === SOFT-ALLOCATED BUG, FOUND AND FIXED 2026-09-01 ===
// gold.available_inventory_by_lp.soft_allocated_packaged_amount reads 0
// for EVERY license plate on every material tested — confirmed live
// against material 108281, where Footprint Cloud's own Inventory Hub
// shows Soft Allocated = 120. Root cause: soft allocation is an
// order/pick-task-level fact, not a per-LP fact, so it never gets
// stamped onto individual by_lp rows. gold.available_inventory_by_material
// (the material-level aggregate, one row per material+warehouse) has the
// correct value — confirmed exact match (120) against Footprint. Active
// and Inactive matched between both tables in every case tested, so this
// was isolated to Soft-Allocated (and, by the same reasoning, Inbound).
// Inventory now sources from available_inventory_by_material instead of
// available_inventory_by_lp.
//
// DEMAND (Needed) — appointments-only (per Dan's 2026-08-31 ask), sourced
// STRICTLY from dockappointmentitems -> Order links. Text-parsed order
// numbers from unlinked appointments are surfaced for visibility (see
// above) but never included in Needed — see the classification writeup.
//
// SHORT = Active + Inbound - Needed, only returned when negative. Matches
// the source spreadsheet's actual row-26 formula — Inactive and
// Soft-Allocated are informational only, not netted in.
//
// targetDate is REQUIRED, pre-computed by the frontend in America/Chicago
// (tomorrowCentral() in src/lib/pretzillaShortage.js) — this function
// never computes "today"/"tomorrow" itself.

const duckdb = require('duckdb');

const PROJECT_IDS = [230, 342]; // Pretzilla Kenosha (PRETZ5) + COOLER (PRTZL5)
const WAREHOUSE_ID = 5; // Kenosha
const APPT_TAG = '(PZ)'; // Datex's own naming convention for these appointments

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Pulls candidate order numbers (e.g. "SO620394") out of an appointment
// name via regex. Datex order lookup_codes observed live are all "SO" +
// 6 digits.
function extractOrderNumbers(text) {
  return [...new Set((text.match(/SO\d{6}/g) || []))];
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

    // ALL Pretzilla-Kenosha appointments for targetDate, regardless of
    // whether they have an order link yet. status_id NOT IN (4,5) excludes
    // completed/historical (4) and cancelled/hold placeholders (5) —
    // confirmed live this matches the Dock Appointments Hub's own "Open,
    // In-Yard, Door Assigned" filter (all 6 real appointments carry
    // status_id=0; the excluded HOLD rows carry status_id=5).
    const allApptsSql = `
      SELECT dock_appointment_id AS appt_id, lookup_code AS appt_code, scheduled_arrival
      FROM production_db.silver.datex_slv_dockappointments
      WHERE warehouse_id = ${WAREHOUSE_ID}
        AND lookup_code LIKE '%${APPT_TAG}%'
        AND status_id NOT IN (4, 5)
        AND CAST(scheduled_arrival AS DATE) = DATE '${targetDate}'
      ORDER BY scheduled_arrival
    `;
    const allApptRows = await runQuery(allApptsSql);

    // Relational links only, for the same appointment set.
    const linkedSql = `
      SELECT
        dai.dock_appointment_id AS appt_id,
        o.order_id              AS order_id,
        o.lookup_code            AS order_no
      FROM production_db.silver.datex_slv_dockappointmentitems dai
      JOIN production_db.silver.datex_slv_orders o
        ON o.order_id = dai.item_entity_id AND dai.item_entity_type = 'Order'
      WHERE o.project_id IN (${PROJECT_IDS.join(',')})
        AND dai.dock_appointment_id IN (${allApptRows.map((r) => r.appt_id).join(',') || '-1'})
    `;
    const linkedRows = allApptRows.length ? await runQuery(linkedSql) : [];

    const linkedByAppt = new Map();
    for (const r of linkedRows) {
      if (!linkedByAppt.has(r.appt_id)) linkedByAppt.set(r.appt_id, []);
      linkedByAppt.get(r.appt_id).push({ orderId: r.order_id, orderNo: r.order_no });
    }

    // For appointments with zero relational links, pull candidate order
    // numbers out of the name and check whether they exist in Datex at all.
    const unlinkedAppts = allApptRows.filter((r) => !linkedByAppt.has(r.appt_id));
    const candidateNumbers = [...new Set(
      unlinkedAppts.flatMap((r) => extractOrderNumbers(r.appt_code))
    )];
    let existingOrdersByCode = new Map();
    if (candidateNumbers.length) {
      const quoted = candidateNumbers.map((c) => `'${c}'`).join(',');
      const existSql = `
        SELECT lookup_code, order_id
        FROM production_db.silver.datex_slv_orders
        WHERE lookup_code IN (${quoted})
      `;
      const existRows = await runQuery(existSql);
      existingOrdersByCode = new Map(existRows.map((r) => [r.lookup_code, r.order_id]));
    }

    // Build final appointment list with link-status classification.
    const appointments = allApptRows.map((r) => {
      const linked = linkedByAppt.get(r.appt_id);
      if (linked && linked.length) {
        return {
          apptId: r.appt_id,
          apptCode: r.appt_code,
          scheduledArrival: r.scheduled_arrival,
          linkStatus: 'linked',
          orders: linked.map((l) => l.orderNo),
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
          orders: foundExisting,
        };
      }
      return {
        apptId: r.appt_id,
        apptCode: r.appt_code,
        scheduledArrival: r.scheduled_arrival,
        linkStatus: 'no_order_in_datex',
        orders: candidates, // referenced but nonexistent, or empty (pure hold)
      };
    });

    // Needed/materials are computed STRICTLY from linked orders — see
    // header for why unlinked/no-order appointments are excluded here.
    const orderIds = [...new Set(linkedRows.map((r) => r.order_id))];

    if (orderIds.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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

    // Inventory — material-level aggregate (available_inventory_by_material),
    // NOT the by_lp table. See header for why: soft allocation is not a
    // per-LP fact and reads 0 on every LP row even when real.
    const invSql = `
      SELECT
        material_id,
        active_packaged_amount         AS active,
        inactive_packaged_amount       AS inactive,
        incoming_packaged_amount       AS inbound_auto,
        soft_allocated_packaged_amount AS soft_alloc
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

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
