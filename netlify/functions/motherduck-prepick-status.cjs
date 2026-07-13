'use strict'

// MotherDuck query for outbound "Pre-Picked Order Status" — Madison labor
// planning tab. Built 2026-07-11 per Dan. Rewritten 2026-07-13 to use the
// proper relational join instead of lookup_code text-matching. Case counts
// corrected 2026-07-13 (later same day) — see notes below.
//
// For every outbound appointment on a given facility/date, resolves the
// linked Datex order(s), determines whether it's fully picked with no
// outstanding work, and — for orders still being picked — scores pick
// difficulty based on how many warehouse locations the picker must visit
// and whether any of those locations mix multiple lots together (the real
// driver of pick time, not raw pallet count — see 2026-07-11 conversation
// with Dan).
//
// POST body: { facilityId: 'mad', date: 'YYYY-MM-DD' }
//
// Response shape:
//   {
//     appointments: [{
//       lookupCode, projectName, carrierName, scheduledArrival, notes,
//       orderIds, orderLookupCodes,   // arrays — an appointment can cover multiple orders
//       status: 'ready' | 'not-started' | 'unresolved' | 'placeholder',
//       expectedCases,                 // reliable — sum of orderlines.Amount
//       actualCases,                   // ONLY set when status='ready' (= expectedCases); null otherwise — see notes
//       pickLocations, rehandleRisk,   // summed across all orders; null when no hard allocation yet
//       warehouseMismatch: { orderWarehouseId, expectedWarehouseId } | null,
//     }],
//     fetchedAt,
//   }
//
// ── Order matching — rewritten 2026-07-13 ───────────────────────────────
// The 2026-07-11/12 versions of this function tried to match an
// appointment to an order by parsing the noisy lookup_code text
// ("*(NOVONESIS) - 85155270") and matching extracted tokens against
// silver.datex_slv_orders.lookup_code. That approach had two real,
// confirmed failure modes:
//   1. Short/ambiguous candidates could substring-match unrelated orders
//      company-wide (e.g. "64527" matched six different orders that
//      merely happened to end in the same 5 digits).
//   2. Some appointments aren't tied to a single order at all — they're
//      tied to a LOAD CONTAINER holding multiple shipments/orders (e.g.
//      Rhodes' appointment "64527" is actually load container 22712,
//      containing 3 separate orders — S/R224668, S/R224669, S/R224750 —
//      none of which contain "64527" anywhere in their own lookup_code).
//      Text-matching could never find these; Upper Cut Brands and DPI
//      were ALSO load-container/direct-order cases that text-matching
//      incorrectly reported as "no order exists anywhere in Datex."
//
// The fix: use the actual relational link Datex already provides —
// silver.datex_slv_dockappointmentitems — which ties
// gold.truck_appointments.appointment_id directly to either:
//   - item_entity_type='Order', item_entity_id = order_id directly, or
//   - item_entity_type='LoadContainer', item_entity_id = load_container_id,
//     which is expanded via datex_slv_shipments (load_container_id) →
//     datex_slv_orderlines (shipment_id) → order_id to get ALL orders
//     riding on that container.
// This is exact — no text-parsing, no ambiguity, no substring collisions —
// and was validated against all 24 real Madison Monday appointments before
// shipping: every previously-"Unresolved" appointment (Rhodes x2, Upper
// Cut, DPI) resolved correctly, and none of the previously-matched orders
// changed.
//
// An appointment can now legitimately cover MULTIPLE orders (a load
// container consolidating several shipments) — case counts, task status,
// and pick-difficulty are summed across all of them, mirroring how this
// was already handled for Kenosha's multi-order appointments.
//
// Placeholder detection (HOLD/SAVE, e.g. "(JONES) - HOLD", "GRASSLAND
// SAVE") still uses lookup_code tokenizing, since these have no
// dockappointmentitems rows to join against at all.
//
// ── Case counts — corrected 2026-07-13 ──────────────────────────────────
// Dan flagged that expected/actual case counts (e.g. "800/1257" on the
// Novonesis 85155270 appointment) didn't match the real order line
// quantities at all (real order = 501 cases). Root cause: this function
// was summing expected_inventory_amount/actual_inventory_amount across
// ALL of an order's tasks — but datex_slv_tasks is an audit-trail-style
// table, not a clean list of independent task lines. Confirmed on that
// exact order: a single underlying pick gets re-planned/re-split into
// NEW task_id rows repeatedly as the system redirects it (observed
// expected_inventory_amount values 251→201→151→101→51 on 5 different
// task_ids, each just a snapshot of "amount still remaining" at that
// re-plan moment, not 5 independent 251/201/151/101/51-unit requirements).
// Summing blindly triple/quadruple-counted the same physical cases.
//
// Fix: expectedCases now comes from SUM(datex_slv_orderlines.Amount) per
// order — confirmed reliable (matches the known-correct 501 for that
// order exactly, and matches known order sizes on every other order
// checked). Two other candidate "actual picked so far" sources were
// checked and ruled out:
//   - orderlines.packaged_amount: always exactly equals Amount on every
//     order checked, including orders confirmed genuinely untouched — it's
//     a packaging SPEC set at order entry, not a live progress counter.
//   - orderlines.license_plate_id: null on every order regardless of pick
//     status — populated at a later shipping stage, not useful here.
// No reliable source for "cases picked so far" on a PARTIALLY-picked order
// was found this session. Rather than keep guessing, actualCases is only
// populated when status='ready' (where, by the ready definition itself,
// all cases are done — actualCases = expectedCases). For 'not-started'
// orders, actualCases is null and the frontend shows no progress number
// rather than a potentially-wrong one. If a real "picked so far" source
// surfaces later (Dan may know of a Datex report/field this session didn't
// check), this is the place to wire it in.
//
// ── "Ready" definition ───────────────────────────────────────────────────
// An appointment is 'ready' when, across ALL of its orders combined, there
// are zero tasks in Released/Planned status AND at least one Completed
// task. This is NOT the same as "100% of tasks completed" — tasks
// frequently get Cancelled and re-batched during picking (confirmed
// 2026-07-11 on 3 Grassland orders: 20 Cancelled + 20 Completed tasks,
// full case count covered, zero Released — that's ready). This
// classification logic (unlike the case-count sums) does not appear to be
// affected by the re-planning-snapshot issue above — it only checks task
// STATUS presence/absence, not summed amounts — and has matched known-
// correct real orders throughout this session.
//
// ── Pick difficulty ──────────────────────────────────────────────────────
// pickLocations = distinct locations hard-allocated across all of this
//   appointment's orders' tasks.
// rehandleRisk  = for locations holding MORE THAN ONE LOT, the count of
//   pallets at that location that are NOT the required lot (i.e. pallets
//   that may need to be moved aside to reach the correct one). Locations
//   holding a single lot contribute ZERO rehandle risk regardless of how
//   many pallets are stacked there — grabbing any pallet off a single-lot
//   bulk lane is trivial. This directly reflects Dan's 2026-07-11 call:
//   "if it's all one lot, that's easy — multiple lots is when it's
//   complicated."
// pickLocations/rehandleRisk are null when none of the appointment's
// orders have a hard allocation yet (small each-pick orders often get
// slotted at release time, not pre-assigned) — surfaced client-side as
// "Not assigned yet".

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// Matches WAREHOUSE_ID in motherduck-appointments.cjs
const WAREHOUSE_ID = {
  cal: 1,
  ec:  3,
  mad: 4,
  ken: 5,
  wr:  6,
}

const PLACEHOLDER_TOKENS = new Set(['HOLD', 'SAVE'])

function nextDayISO(date) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Split a raw lookup_code on anything that isn't a letter/digit/dash, used
// only for placeholder (HOLD/SAVE) detection now — real order matching
// goes through the relational join instead.
function tokenize(raw) {
  return String(raw || '').split(/[^A-Za-z0-9-]+/).filter(Boolean)
}

function isPlaceholder(raw) {
  return tokenize(raw).some(t => PLACEHOLDER_TOKENS.has(t.toUpperCase()))
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { facilityId, date } = body
  const warehouseId = WAREHOUSE_ID[facilityId]
  if (!warehouseId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'Missing/invalid facilityId or date (YYYY-MM-DD)' }),
    }
  }

  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  let conn, db
  try {
    const duckdb = require('duckdb')
    db = new duckdb.Database(':memory:')
    conn = db.connect()

    const exec = (sql) => new Promise((resolve, reject) => {
      conn.run(sql, (err) => err ? reject(err) : resolve())
    })
    const runQuery = (sql) => new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows))
    })

    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)

    // ── Step 1: outbound appointments for this facility/date ─────────────
    const nextDate = nextDayISO(date)
    const apptSql = `
      SELECT
        appointment_id,
        COALESCE(lookup_code, '')                AS lookup_code,
        COALESCE(project_name, '')                AS project_name,
        COALESCE(carrier_name, '')                AS carrier_name,
        scheduled_arrival::VARCHAR                 AS scheduled_arrival,
        COALESCE(Notes, '')                        AS notes
      FROM production_db.gold.truck_appointments
      WHERE warehouse_id = ${warehouseId}
        AND scheduled_arrival >= TIMESTAMP '${date} 05:00:00'
        AND scheduled_arrival <  TIMESTAMP '${nextDate} 05:00:00'
        AND dock_status_name != 'Cancelled'
        AND LOWER(dock_appointment_type_name) LIKE 'outbound%'
      ORDER BY scheduled_arrival
    `
    const apptRows = await runQuery(apptSql)

    // Split out placeholder appointments (HOLD/SAVE, no real cargo) before
    // spending any query effort trying to resolve them to an order.
    const realAppts = []
    const placeholderAppts = []
    for (const a of apptRows) {
      if (!a.lookup_code || isPlaceholder(a.lookup_code)) {
        placeholderAppts.push(a)
      } else {
        realAppts.push(a)
      }
    }

    // ── Step 2: dockappointmentitems for these appointments ───────────────
    // item_entity_type is either 'Order' (item_entity_id = order_id
    // directly) or 'LoadContainer' (item_entity_id = load_container_id,
    // expanded below into its constituent orders).
    const apptIds = realAppts.map(a => a.appointment_id)
    let itemRows = []
    if (apptIds.length > 0) {
      const itemSql = `
        SELECT dock_appointment_id, item_entity_type, item_entity_id
        FROM production_db.silver.datex_slv_dockappointmentitems
        WHERE dock_appointment_id IN (${apptIds.join(',')})
      `
      itemRows = await runQuery(itemSql)
    }

    const directOrderIdsByAppt = new Map()   // appointment_id -> Set(order_id)
    const containerIdsByAppt = new Map()     // appointment_id -> Set(load_container_id)
    for (const r of itemRows) {
      const apptId = Number(r.dock_appointment_id)
      if (r.item_entity_type === 'Order') {
        if (!directOrderIdsByAppt.has(apptId)) directOrderIdsByAppt.set(apptId, new Set())
        directOrderIdsByAppt.get(apptId).add(Number(r.item_entity_id))
      } else if (r.item_entity_type === 'LoadContainer') {
        if (!containerIdsByAppt.has(apptId)) containerIdsByAppt.set(apptId, new Set())
        containerIdsByAppt.get(apptId).add(Number(r.item_entity_id))
      }
    }

    // ── Step 3: expand load containers into their constituent orders ─────
    const allContainerIds = [...new Set([...containerIdsByAppt.values()].flatMap(s => [...s]))]
    const orderIdsByContainer = new Map() // load_container_id -> Set(order_id)
    if (allContainerIds.length > 0) {
      const containerOrderSql = `
        SELECT DISTINCT s.load_container_id, ol.order_id
        FROM production_db.silver.datex_slv_shipments s
        JOIN production_db.silver.datex_slv_orderlines ol ON ol.shipment_id = s.shipment_id
        WHERE s.load_container_id IN (${allContainerIds.join(',')})
      `
      const containerOrderRows = await runQuery(containerOrderSql)
      for (const r of containerOrderRows) {
        const cid = Number(r.load_container_id)
        if (!orderIdsByContainer.has(cid)) orderIdsByContainer.set(cid, new Set())
        orderIdsByContainer.get(cid).add(Number(r.order_id))
      }
    }

    // ── Step 4: build final order_id set per appointment ──────────────────
    const orderIdsByAppt = new Map() // appointment_id -> Set(order_id)
    for (const a of realAppts) {
      const apptId = Number(a.appointment_id)
      const set = new Set(directOrderIdsByAppt.get(apptId) || [])
      for (const cid of (containerIdsByAppt.get(apptId) || [])) {
        for (const oid of (orderIdsByContainer.get(cid) || [])) set.add(oid)
      }
      orderIdsByAppt.set(apptId, set)
    }

    const resolvedOrderIds = [...new Set(
      [...orderIdsByAppt.values()].flatMap(s => [...s])
    )]

    // ── Step 5: order metadata (lookup_code, status, warehouse) ───────────
    const orderById = new Map()
    if (resolvedOrderIds.length > 0) {
      const orderSql = `
        SELECT order_id, lookup_code, order_status_id, preferred_warehouse_id
        FROM production_db.silver.datex_slv_orders
        WHERE order_id IN (${resolvedOrderIds.join(',')})
      `
      const orderRows = await runQuery(orderSql)
      for (const r of orderRows) orderById.set(Number(r.order_id), r)
    }

    // ── Step 6: reliable expected cases per order (order lines) ───────────
    // SUM(orderlines.Amount) — confirmed reliable 2026-07-13, unlike any
    // task-table-derived sum. See file header for why.
    const expectedByOrder = new Map()
    if (resolvedOrderIds.length > 0) {
      const idList = resolvedOrderIds.join(',')
      const linesSql = `
        SELECT order_id, SUM(Amount) AS expected
        FROM production_db.silver.datex_slv_orderlines
        WHERE order_id IN (${idList})
        GROUP BY order_id
      `
      const lineRows = await runQuery(linesSql)
      for (const r of lineRows) expectedByOrder.set(Number(r.order_id), Number(r.expected) || 0)
    }

    // ── Step 7: task STATUS per order (for ready/not-started only) ────────
    // Only counts task statuses now, not summed amounts — the amount sums
    // were the unreliable part (see file header). Status presence/absence
    // has held up as correct all session.
    const taskAggByOrder = new Map()
    if (resolvedOrderIds.length > 0) {
      const idList = resolvedOrderIds.join(',')
      const taskSql = `
        SELECT
          t.order_id,
          ts.status_name,
          COUNT(*) AS task_count
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts ON t.status_id = ts.task_status_id
        WHERE t.order_id IN (${idList})
        GROUP BY t.order_id, ts.status_name
      `
      const taskRows = await runQuery(taskSql)
      for (const r of taskRows) {
        const oid = Number(r.order_id)
        if (!taskAggByOrder.has(oid)) {
          taskAggByOrder.set(oid, { released: 0, planned: 0, completed: 0, cancelled: 0 })
        }
        const agg = taskAggByOrder.get(oid)
        const status = (r.status_name || '').toLowerCase()
        const count = Number(r.task_count) || 0
        if (status === 'released') agg.released += count
        else if (status === 'planned') agg.planned += count
        else if (status === 'completed') agg.completed += count
        else if (status === 'cancelled') agg.cancelled += count
      }
    }

    // ── Step 8: pick difficulty (hard allocations + lot mix) ──────────────
    const complexityByOrder = new Map()
    if (resolvedOrderIds.length > 0) {
      const idList = resolvedOrderIds.join(',')
      const complexitySql = `
        WITH loc_detail AS (
          SELECT
            t.order_id, ha.hard_allocation_id, lc.location_container_id,
            had.lot_id AS required_lot_id,
            COUNT(DISTINCT lpc.lot_id) AS distinct_lots,
            COUNT(DISTINCT lp.license_plate_id) AS active_lps,
            SUM(CASE WHEN lpc.lot_id = had.lot_id THEN 1 ELSE 0 END) AS matching_lps
          FROM production_db.silver.datex_slv_hardallocations ha
          JOIN production_db.silver.datex_slv_tasks t ON ha.task_id = t.task_id
          JOIN production_db.silver.datex_slv_hardallocationdetails had ON had.hard_allocation_id = ha.hard_allocation_id
          JOIN production_db.silver.datex_slv_locationcontainers lc ON ha.location_id = lc.location_container_id
          LEFT JOIN production_db.silver.datex_slv_licenseplates lp
            ON lp.location_id = lc.location_container_id AND lp.status_name NOT IN ('Shipped','Archived')
          LEFT JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
          WHERE t.order_id IN (${idList})
          GROUP BY t.order_id, ha.hard_allocation_id, lc.location_container_id, had.lot_id
        )
        SELECT
          order_id,
          COUNT(DISTINCT location_container_id) AS pick_locations,
          SUM(CASE WHEN distinct_lots > 1 THEN GREATEST(active_lps - matching_lps, 0) ELSE 0 END) AS rehandle_risk
        FROM loc_detail
        GROUP BY order_id
      `
      const complexityRows = await runQuery(complexitySql)
      for (const r of complexityRows) {
        complexityByOrder.set(Number(r.order_id), {
          pickLocations: Number(r.pick_locations) || 0,
          rehandleRisk: Number(r.rehandle_risk) || 0,
        })
      }
    }

    // ── Assemble response ──────────────────────────────────────────────────
    const expectedWarehouseId = warehouseId
    const appointments = []

    for (const a of realAppts) {
      const apptId = Number(a.appointment_id)
      const orderIds = [...(orderIdsByAppt.get(apptId) || [])]
      const base = {
        lookupCode: a.lookup_code,
        projectName: a.project_name,
        carrierName: a.carrier_name,
        scheduledArrival: a.scheduled_arrival,
        notes: a.notes,
      }

      if (orderIds.length === 0) {
        appointments.push({
          ...base,
          orderIds: [],
          orderLookupCodes: [],
          status: 'unresolved',
          expectedCases: null,
          actualCases: null,
          pickLocations: null,
          rehandleRisk: null,
          warehouseMismatch: null,
        })
        continue
      }

      // Sum reliable expected cases, task status, and pick difficulty
      // across ALL orders on this appointment (handles load-container-
      // consolidated appointments the same way Kenosha's multi-order
      // appointments are handled).
      let released = 0, planned = 0, completed = 0
      let hasAnyTaskData = false
      let expectedTotal = 0
      let hasAnyExpectedData = false
      let pickLocations = 0, rehandleRisk = 0
      let hasAnyComplexityData = false
      const mismatchedWarehouses = new Set()
      const orderLookupCodes = []

      for (const oid of orderIds) {
        const order = orderById.get(oid)
        if (order) {
          orderLookupCodes.push(order.lookup_code)
          const owh = order.preferred_warehouse_id != null ? Number(order.preferred_warehouse_id) : null
          if (owh != null && owh !== expectedWarehouseId) mismatchedWarehouses.add(owh)
        }
        if (expectedByOrder.has(oid)) {
          hasAnyExpectedData = true
          expectedTotal += expectedByOrder.get(oid)
        }
        const agg = taskAggByOrder.get(oid)
        if (agg) {
          hasAnyTaskData = true
          released += agg.released
          planned += agg.planned
          completed += agg.completed
        }
        const complexity = complexityByOrder.get(oid)
        if (complexity) {
          hasAnyComplexityData = true
          pickLocations += complexity.pickLocations
          rehandleRisk += complexity.rehandleRisk
        }
      }

      let status = 'not-started'
      if (hasAnyTaskData) {
        const noOpenWork = released === 0 && planned === 0
        const hasActivity = completed > 0
        if (noOpenWork && hasActivity) status = 'ready'
      }

      const warehouseMismatch = mismatchedWarehouses.size > 0
        ? { orderWarehouseId: [...mismatchedWarehouses][0], expectedWarehouseId }
        : null

      appointments.push({
        ...base,
        orderIds,
        orderLookupCodes,
        status,
        expectedCases: hasAnyExpectedData ? expectedTotal : null,
        // No reliable "picked so far" source for partial orders — only
        // populate actualCases when 'ready' (= expectedCases by
        // definition). See file header for why this isn't shown for
        // not-started orders.
        actualCases: (status === 'ready' && hasAnyExpectedData) ? expectedTotal : null,
        pickLocations: hasAnyComplexityData ? pickLocations : null,
        rehandleRisk: hasAnyComplexityData ? rehandleRisk : null,
        warehouseMismatch,
      })
    }

    for (const a of placeholderAppts) {
      appointments.push({
        lookupCode: a.lookup_code,
        projectName: a.project_name,
        carrierName: a.carrier_name,
        scheduledArrival: a.scheduled_arrival,
        notes: a.notes,
        orderIds: [],
        orderLookupCodes: [],
        status: 'placeholder',
        expectedCases: null,
        actualCases: null,
        pickLocations: null,
        rehandleRisk: null,
        warehouseMismatch: null,
      })
    }

    appointments.sort((a, b) => (a.scheduledArrival || '').localeCompare(b.scheduledArrival || ''))

    try { conn.close(); db.close() } catch (_) {}

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        appointments,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.slice(0, 500),
        facilityId,
        date,
        elapsedMs: Date.now() - t0,
      }),
    }
  }
}
