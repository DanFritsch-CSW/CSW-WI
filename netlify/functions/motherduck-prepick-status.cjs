'use strict'

// MotherDuck query for outbound "Pre-Picked Order Status" — Madison labor
// planning tab. Built 2026-07-11 per Dan. Matching logic corrected 2026-07-12
// after production showed everything as "Unresolved" — see notes below.
// Added project_name 2026-07-13 (Dan wanted the customer/project shown as
// the main row label, not the carrier).
//
// For every outbound appointment on a given facility/date, resolves the
// linked Datex order (best-effort match — see matching notes below),
// determines whether it's fully picked with no outstanding work, and — for
// orders still being picked — scores pick difficulty based on how many
// warehouse locations the picker must visit and whether any of those
// locations mix multiple lots together (the real driver of pick time, not
// raw pallet count — see 2026-07-11 conversation with Dan).
//
// POST body: { facilityId: 'mad', date: 'YYYY-MM-DD' }
//
// Response shape:
//   {
//     appointments: [{
//       lookupCode, projectName, carrierName, scheduledArrival, notes,
//       orderId, orderLookupCode,
//       status: 'ready' | 'not-started' | 'unresolved' | 'placeholder',
//       expectedCases, actualCases,
//       pickLocations, rehandleRisk,   // null when no hard allocation yet (not-yet-released orders)
//       warehouseMismatch: { orderWarehouseId, expectedWarehouseId } | null,
//     }],
//     fetchedAt,
//   }
//
// ── Order matching notes (corrected 2026-07-12) ─────────────────────────
// gold.truck_appointments.lookup_code is NOT a clean order code — it's a
// noisy compound string like "*(NOVONESIS) - 85155270" or
// "*(GRASSLAND) - 1150897 (0005153991)". The original 2026-07-11 version of
// this function assumed Madison's lookup_code was already clean (based on
// an ad-hoc Omni pull that happened to return a cleaner field) and never
// re-validated against this actual table — that shipped a real bug where
// EVERY appointment came back "Unresolved" in production, because the
// entire noisy string was being used as the match key instead of the real
// order code embedded inside it.
//
// Fix: tokenize the raw lookup_code on anything that isn't a letter/digit/
// dash, then treat any token containing a digit and at least 4 characters
// long as a candidate order code (handles "85155270", "1150897" +
// "0005153991" as two candidates, "M027", "HCI-0190-103616-16", etc. — all
// confirmed against real Madison orders this session). Each appointment can
// have multiple candidates (e.g. an order number AND a trailing PO
// reference in parens); exact match on any candidate wins.
//
// Substring fallback is intentionally conservative (candidates >=6 chars,
// accepted only when exactly one order matches). Validated against real
// data that short candidates can be genuinely ambiguous — the previously
// assumed "54-prefix truncation" case (appointment shows "64527", a real
// order is "5464527") turned out to ALSO substring-match five other,
// completely unrelated orders company-wide that merely happen to end in
// the same 5 digits (e.g. "0010264527", "PSH0064527", "SO364527"). Guessing
// one would be an outright wrong match. Such appointments now correctly
// surface as 'unresolved' rather than silently picking a possibly-wrong
// order — a real data gap, surfaced honestly rather than hidden or guessed.
//
// Placeholder detection (also fixed 2026-07-12): HOLD/SAVE appointments are
// compound strings too ("(JONES) - HOLD", "GRASSLAND SAVE"), not bare
// "HOLD"/"SAVE" — the original exact-string regex never matched these
// either. Fixed by tokenizing and checking for a HOLD/SAVE token anywhere.
//
// ── "Ready" definition ───────────────────────────────────────────────────
// An order is 'ready' when it has zero tasks in Released/Planned status
// AND at least one Completed task. This is NOT the same as "100% of tasks
// completed" — tasks frequently get Cancelled and re-batched during
// picking (confirmed 2026-07-11 on 3 Grassland orders: 20 Cancelled + 20
// Completed tasks, full case count covered, zero Released — that's ready).
// Cases are the source of truth for completion; task-count ratios are not.
//
// ── Pick difficulty ──────────────────────────────────────────────────────
// pickLocations = distinct locations hard-allocated for this order's tasks.
// rehandleRisk  = for locations holding MORE THAN ONE LOT, the count of
//   pallets at that location that are NOT the required lot (i.e. pallets
//   that may need to be moved aside to reach the correct one). Locations
//   holding a single lot contribute ZERO rehandle risk regardless of how
//   many pallets are stacked there — grabbing any pallet off a single-lot
//   bulk lane is trivial. This directly reflects Dan's 2026-07-11 call:
//   "if it's all one lot, that's easy — multiple lots is when it's
//   complicated."
// pickLocations/rehandleRisk are null when the order has no hard
// allocation yet (small each-pick orders often get slotted at release
// time, not pre-assigned) — surfaced client-side as "Not assigned yet".

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

function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// Split a raw lookup_code on anything that isn't a letter/digit/dash.
// Dashes are kept as token characters (not delimiters) so compound codes
// like "HCI-0190-103616-16" survive intact as one token.
function tokenize(raw) {
  return String(raw || '').split(/[^A-Za-z0-9-]+/).filter(Boolean)
}

// Candidate order/PO codes embedded in a noisy appointment lookup_code.
// Any token containing at least one digit and >=4 characters is a
// candidate — customer-name tokens (all letters, e.g. "NOVONESIS",
// "RHODES") are naturally excluded since they have no digits.
function extractCandidateCodes(raw) {
  const tokens = tokenize(raw)
  return [...new Set(tokens.filter(t => /\d/.test(t) && t.length >= 4))]
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
    // spending any query effort trying to match them to an order.
    const realAppts = []
    const placeholderAppts = []
    for (const a of apptRows) {
      if (!a.lookup_code || isPlaceholder(a.lookup_code)) {
        placeholderAppts.push(a)
      } else {
        realAppts.push(a)
      }
    }

    // ── Step 2: extract candidate order codes per appointment ────────────
    const apptsWithCandidates = realAppts.map(a => ({
      appt: a,
      candidates: extractCandidateCodes(a.lookup_code),
    }))

    let matchedOrders = []
    const allCodes = [...new Set(apptsWithCandidates.flatMap(x => x.candidates))]
    if (allCodes.length > 0) {
      const whereClauses = allCodes
        .map(c => `lookup_code = ${sqlLit(c)} OR lookup_code LIKE ${sqlLit('%' + c + '%')}`)
        .join(' OR ')
      const orderSql = `
        SELECT order_id, lookup_code, order_status_id, preferred_warehouse_id
        FROM production_db.silver.datex_slv_orders
        WHERE ${whereClauses}
      `
      matchedOrders = await runQuery(orderSql)
    }

    // Resolve an appointment's candidate codes to (at most) one order.
    // Exact match on any candidate first, in candidate order (earlier
    // candidates are typically the primary order number, later ones
    // trailing PO references). When multiple orders share the exact same
    // lookup_code (confirmed real case: "M027" exists on 3 separate order
    // records from different dates), prefer the one currently Processing
    // (order_status_id=2) over old Completed ones, tie-broken by highest
    // order_id (most recent).
    //
    // Substring fallback is intentionally conservative: only attempted for
    // candidates >=6 characters, and only accepted when EXACTLY ONE order
    // contains it. Validated this session that short candidates (e.g. the
    // confirmed 5-digit truncation case "64527") can substring-match SIX
    // unrelated orders company-wide that merely happen to end in the same
    // digits (e.g. "0010264527", "PSH0064527", "SO364527") — silently
    // picking one of those would be an outright wrong match, worse than
    // surfacing 'unresolved' honestly.
    function pickBestAmong(orders) {
      if (orders.length === 0) return null
      if (orders.length === 1) return orders[0]
      const active = orders.filter(o => Number(o.order_status_id) === 2)
      const pool = active.length > 0 ? active : orders
      return pool.reduce((best, o) => (Number(o.order_id) > Number(best.order_id) ? o : best), pool[0])
    }

    function findOrderForCandidates(candidates) {
      for (const c of candidates) {
        const exactMatches = matchedOrders.filter(o => o.lookup_code === c)
        if (exactMatches.length > 0) return pickBestAmong(exactMatches)
      }
      for (const c of candidates) {
        if (c.length < 6) continue
        const subs = matchedOrders.filter(o => o.lookup_code && o.lookup_code.includes(c))
        if (subs.length === 1) return subs[0]
      }
      return null
    }

    const apptOrderPairs = apptsWithCandidates.map(({ appt, candidates }) => ({
      appt,
      order: findOrderForCandidates(candidates),
    }))

    const resolvedOrderIds = [...new Set(
      apptOrderPairs.filter(p => p.order).map(p => Number(p.order.order_id))
    )]

    // ── Step 3: task completion status per order ──────────────────────────
    // Cases are the source of truth for "done" — task counts are NOT (tasks
    // routinely get Cancelled + re-batched mid-pick; a lower Completed task
    // count than total tasks does not mean work remains, see file header).
    const taskAggByOrder = new Map()
    if (resolvedOrderIds.length > 0) {
      const idList = resolvedOrderIds.join(',')
      const taskSql = `
        SELECT
          t.order_id,
          ts.status_name,
          COUNT(*) AS task_count,
          SUM(t.expected_inventory_amount) AS expected,
          SUM(t.actual_inventory_amount)   AS actual
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts ON t.status_id = ts.task_status_id
        WHERE t.order_id IN (${idList})
        GROUP BY t.order_id, ts.status_name
      `
      const taskRows = await runQuery(taskSql)
      for (const r of taskRows) {
        const oid = Number(r.order_id)
        if (!taskAggByOrder.has(oid)) {
          taskAggByOrder.set(oid, { released: 0, planned: 0, completed: 0, cancelled: 0, expectedTotal: 0, actualTotal: 0 })
        }
        const agg = taskAggByOrder.get(oid)
        const status = (r.status_name || '').toLowerCase()
        const count = Number(r.task_count) || 0
        if (status === 'released') agg.released += count
        else if (status === 'planned') agg.planned += count
        else if (status === 'completed') agg.completed += count
        else if (status === 'cancelled') agg.cancelled += count
        // expected/actual across ALL statuses — cases are truth, not task status
        agg.expectedTotal += Number(r.expected) || 0
        agg.actualTotal   += Number(r.actual) || 0
      }
    }

    // ── Step 4: pick difficulty (hard allocations + lot mix) ──────────────
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

    for (const { appt, order } of apptOrderPairs) {
      const base = {
        lookupCode: appt.lookup_code,
        projectName: appt.project_name,
        carrierName: appt.carrier_name,
        scheduledArrival: appt.scheduled_arrival,
        notes: appt.notes,
      }

      if (!order) {
        appointments.push({
          ...base,
          orderId: null,
          orderLookupCode: null,
          status: 'unresolved',
          expectedCases: null,
          actualCases: null,
          pickLocations: null,
          rehandleRisk: null,
          warehouseMismatch: null,
        })
        continue
      }

      const oid = Number(order.order_id)
      const agg = taskAggByOrder.get(oid)
      const complexity = complexityByOrder.get(oid) || null

      let status = 'not-started'
      if (agg) {
        const noOpenWork = agg.released === 0 && agg.planned === 0
        const hasActivity = agg.completed > 0
        if (noOpenWork && hasActivity) status = 'ready'
      }

      const orderWarehouseId = order.preferred_warehouse_id != null ? Number(order.preferred_warehouse_id) : null
      const warehouseMismatch = (orderWarehouseId != null && orderWarehouseId !== expectedWarehouseId)
        ? { orderWarehouseId, expectedWarehouseId }
        : null

      appointments.push({
        ...base,
        orderId: oid,
        orderLookupCode: order.lookup_code,
        status,
        expectedCases: agg ? agg.expectedTotal : null,
        actualCases: agg ? agg.actualTotal : null,
        pickLocations: complexity ? complexity.pickLocations : null,
        rehandleRisk: complexity ? complexity.rehandleRisk : null,
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
        orderId: null,
        orderLookupCode: null,
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
