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
// DEMAND (Needed) — sourced from BOTH Linked and Not Linked appointment
// order references, as of 2026-09-08. Originally Linked-only; per Dan's
// explicit ask after confirming how the link-status/order-status logic
// actually worked ("yes I want them counted towards needed"), Not Linked
// orders — real orders confirmed to exist in Datex via lookup_code,
// project-scoped, that just haven't been relationally connected to their
// appointment yet — now contribute their real order-line quantities too.
// Only "No Order Within Datex" (candidate numbers with no matching real
// order at all) are excluded from Needed; that's now the ONLY excluded
// category, not two. Order STATUS (Created/Processing/etc.) has never
// gated Needed and still doesn't — no order_status_id filter exists
// anywhere in this file; status is informational-only on the appointments
// panel. See extractOrderNumbers()/existingOrdersByCode below for the
// existence check, which is now project-scoped (confirmed live that
// lookup_code is NOT globally unique across projects — an earlier
// version of this existence check had no project filter, a real
// correctness gap that could have attributed a different customer's
// order's demand to this report; fixed in the same pass as this change).
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
// MULTI-FIELD ORDER MATCHING, FIXED 2026-09-09: the Not Linked existence
// check now matches candidate order numbers against lookup_code,
// owner_reference, AND vendor_reference — not lookup_code alone.
// Confirmed live on Sargento that appointment names commonly embed
// vendor_reference values (real orders, real quantities) rather than the
// order's own lookup_code; these were previously always misclassified as
// "No Order Within Datex" and excluded from Needed. Also extended
// extractOrderNumbers to capture a trailing single uppercase letter
// (e.g. "5421184I") — Sargento's vendor_reference format the original
// regex (leading-letters-only) could never match at all. Deduplication
// via ROW_NUMBER() is required alongside this: the same lookup_code can
// have multiple order_id rows from Datex's own re-plan/chain-versioning,
// confirmed live (one lookup_code had 3 order_id rows with identical
// orderlines) — without dedup, matching on owner_reference/
// vendor_reference (which returns every historical row) would double- or
// triple-count that order's real demand. See the inline comment above
// existSql for the full query-level explanation.
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

// Pulls candidate order numbers (e.g. "SO620394", "0010308494",
// "5421184I") out of an appointment name via regex. Extended 2026-09-09
// to allow ONE trailing uppercase letter after the digit run — confirmed
// live on Sargento that several real vendor_reference values look like
// "5421184I", "5652744P", etc. (digit run + single letter suffix), which
// the original prefix-only pattern ([A-Z]{0,3} BEFORE digits) could never
// match. Both Pretzilla (SO######) and Sargento (0010######, and now the
// letter-suffixed vendor-reference style) order references match this.
function extractOrderNumbers(text) {
  return [...new Set((text.match(/\b(?:[A-Z]{0,3}\d{6,}[A-Z]?)\b/g) || []))];
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
      // Matches against lookup_code, owner_reference (exact), AND
      // vendor_reference (prefix match via LIKE) — added 2026-09-09.
      // Confirmed live on Sargento: appointment names commonly embed
      // vendor_reference values (e.g. "ME10144090-01"), not the order's
      // own lookup_code, and the existence check previously only ever
      // looked at lookup_code — meaning these were real, linkable orders
      // that always fell through to "No Order Within Datex" and
      // contributed nothing to Needed. LIKE-prefix (not exact equality)
      // on vendor_reference specifically because vendor_reference can
      // carry a suffix the appointment text doesn't (confirmed: stored
      // "ME10144090-01" vs. extracted "ME10144090" — the regex correctly
      // stops at the hyphen, a real word-boundary, not a bug).
      //
      // ROW_NUMBER() dedup is required here: confirmed live that the
      // SAME lookup_code can have multiple order_id rows from Datex's own
      // re-plan/chain-versioning (same pattern noted for
      // datex_slv_tasks elsewhere in this app) — one lookup_code
      // ('0010309382') had 3 order_id rows, each with IDENTICAL
      // orderlines (600 units). Without dedup, matching via
      // vendor_reference/owner_reference (which returns ALL historical
      // rows sharing that lookup_code) would double- or triple-count that
      // single order's real demand. Only the highest order_id (the most
      // recent chain link, confirmed via created_sys_date_time ordering)
      // is kept per lookup_code.
      const quotedCandidates = candidateNumbers.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ');
      const existSql = `
        WITH candidates(c) AS (VALUES (${quotedCandidates}))
        , matched AS (
          SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.lookup_code ORDER BY o.order_id DESC) AS rn
          FROM production_db.silver.datex_slv_orders o
          WHERE o.project_id IN (${PROJECT_IDS.join(',')})
            AND EXISTS (
              SELECT 1 FROM candidates c
              WHERE o.lookup_code = c.c OR o.owner_reference = c.c OR o.vendor_reference LIKE c.c || '%'
            )
        )
        SELECT c.c AS candidate, m.order_id, s.status_name AS order_status
        FROM candidates c
        LEFT JOIN matched m
          ON (m.lookup_code = c.c OR m.owner_reference = c.c OR m.vendor_reference LIKE c.c || '%')
          AND m.rn = 1
        LEFT JOIN production_db.silver.datex_slv_orderstatuses s ON s.order_status_id = m.order_status_id
        WHERE m.order_id IS NOT NULL
      `;
      const existRows = await runQuery(existSql);
      existingOrdersByCode = new Map(existRows.map((r) => [r.candidate, { orderId: r.order_id, orderStatus: r.order_status }]));
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

    const orderIds = [...new Set([
      ...linkedRows.map((r) => r.order_id),
      // Not Linked orders count toward Needed too, added 2026-09-08 per
      // Dan's explicit ask ("yes I want them counted towards needed") —
      // see the header note above for the full reasoning. These are
      // confirmed-real orders (existingOrdersByCode, project-scoped) that
      // Datex just hasn't relationally connected to their appointment
      // yet; excluding their real quantities produced a silent gap.
      // "No Order Within Datex" candidates are never in this map, so they
      // correctly still contribute nothing.
      ...unlinkedAppts.flatMap((r) =>
        extractOrderNumbers(r.appt_code)
          .map((c) => existingOrdersByCode.get(c)?.orderId)
          .filter(Boolean)
      ),
    ])];

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
