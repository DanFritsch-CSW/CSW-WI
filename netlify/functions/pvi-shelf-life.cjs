'use strict'

// Netlify function — PVI shelf-life risk snapshot from Datex via MotherDuck.
//
// GET/POST — no body needed. Facility is CAL-only (warehouse_id=1) for Phase 1.
//
// Response: {
//   lots: [
//     { material_id, material_code, material_desc,
//       lot_id, lot_code, lot_status,
//       expiration_date_iso,          // YYYY-MM-DD or null
//       received_at_iso,              // YYYY-MM-DD or null (fallback pack proxy)
//       project_lookup,               // 'PALVI9' | 'PALDSD9' | 'PALMA9' (of first PVI order using it)
//       cases_onhand, cases_committed, cases_available, lp_count }
//   ],
//   pendingOrders: [
//     { order_id, order_lookup, scheduled_arrival_iso,
//       ship_to_raw_name, project_lookup,
//       lines: [{ material_id, cases }] }
//   ],
//   velocity: [
//     { material_id, project_lookup,
//       cases_30d, cases_60d, cases_90d,
//       shipments_30d }
//   ],
//   materialShipHistory: [
//     { material_id, ship_to_raw_name, cases_90d, shipments_90d }
//   ],
//   fetchedAt, elapsedMs, source: 'motherduck',
//   rowCounts: { lots, pendingOrders, velocity, materialShipHistory }
// }
//
// The function is intentionally thin — it returns raw facts. All business
// logic (canonical resolution, FEFO depletion, verdict staging, copy-format)
// lives client-side in src/lib/pviShelfLife.js so it's testable and iterable
// without redeploying the Netlify function.
//
// ── DuckDB / MotherDuck init pattern ───────────────────────────────────────
// See netlify/functions/fefo-orders.cjs top-of-file for the full rationale.
// Short version: HOME=/tmp before require, in-memory db, ATTACH without alias.
//
// ── Schema anchors (verified 2026-07-02) ───────────────────────────────────
//   - datex_slv_lots does NOT have expiration_date. Expiration lives on
//     datex_slv_vendorlots, joined via lot.vendor_lot_id = vendorlot.vendor_lot_id.
//     Coverage: 100% of PVI lots have a vendorlots row with expiration_date populated.
//   - datex_slv_orderlines.packaged_amount = cases per line.
//   - datex_slv_lots.parquet_record_sys_date_time = received-at fallback.

process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PVI_PROJECT_LOOKUPS = ['PALVI9', 'PALDSD9', 'PALMA9']
const CAL_WAREHOUSE_ID = 1

// Window for pending orders — 3 weeks forward covers the longest end-customer
// scheduling horizon and gives us enough runway to project FEFO burn.
const PENDING_DAYS_FORWARD = 21

function toISODate(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function toISODateTime(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  const projList = PVI_PROJECT_LOOKUPS.map(p => `'${p}'`).join(',')

  let conn, db
  try {
    process.env.HOME = '/tmp'
    process.env.motherduck_token = TOKEN
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

    // ── Query 1: Lot-level inventory with committed subtraction ──────────
    //
    // Materials in scope = anything shipped under a PVI project in the last
    // 180 days. Broader than pvi-derive-accounts' 90-day window because a
    // seasonal SKU might have inventory today but no shipments in 90d.
    //
    // Expiration_date lives on datex_slv_vendorlots (not datex_slv_lots) —
    // joined via lot.vendor_lot_id = vendorlot.vendor_lot_id. See schema
    // anchor comment at top of file.
    //
    // `project_lookup` per material picked as MIN over active projects — a
    // few materials appear under both PALVI9 and PALDSD9; MIN is stable and
    // arbitrary but deterministic. Client can look up velocity per
    // (material, project) if the assignment ever matters.
    const lotSql = `
      WITH pvi_projects AS (
        SELECT project_id, lookup_code
        FROM production_db.silver.datex_slv_projects
        WHERE lookup_code IN (${projList})
      ),
      pvi_materials AS (
        SELECT
          ol.material_id,
          MIN(p.lookup_code) AS project_lookup
        FROM production_db.silver.datex_slv_orderlines ol
        JOIN production_db.silver.datex_slv_orders o ON o.order_id = ol.order_id
        JOIN pvi_projects p ON p.project_id = o.project_id
        WHERE o.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 180 DAY
        GROUP BY ol.material_id
      ),
      committed AS (
        SELECT t.lot_id, SUM(t.expected_packaged_amount) AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        WHERE t.warehouse_id = ${CAL_WAREHOUSE_ID}
          AND t.lot_id IS NOT NULL
          AND ts.status_name IN ('Planned', 'Released')
        GROUP BY t.lot_id
      )
      SELECT
        l.material_id,
        m.lookup_code                       AS material_code,
        m.Description                       AS material_desc,
        l.lot_id,
        l.lookup_code                       AS lot_code,
        l.status_name                       AS lot_status,
        vl.expiration_date                  AS expiration_date,
        l.parquet_record_sys_date_time      AS received_at,
        pm.project_lookup,
        COUNT(DISTINCT lpc.license_plate_id) AS lp_count,
        SUM(lpc.packaged_amount)             AS cases_onhand,
        COALESCE(MAX(c.cases_committed), 0)  AS cases_committed,
        GREATEST(
          SUM(lpc.packaged_amount) - COALESCE(MAX(c.cases_committed), 0),
          0
        )                                    AS cases_available
      FROM production_db.silver.datex_slv_licenseplatecontents lpc
      JOIN production_db.silver.datex_slv_lots l
        ON lpc.lot_id = l.lot_id
      JOIN production_db.silver.datex_slv_licenseplates lp
        ON lpc.license_plate_id = lp.license_plate_id
      JOIN production_db.silver.datex_slv_materials m
        ON l.material_id = m.material_id
      JOIN pvi_materials pm
        ON pm.material_id = l.material_id
      LEFT JOIN production_db.silver.datex_slv_vendorlots vl
        ON vl.vendor_lot_id = l.vendor_lot_id
      LEFT JOIN committed c
        ON c.lot_id = l.lot_id
      WHERE lp.warehouse_id = ${CAL_WAREHOUSE_ID}
        AND lp.Archived = false
        AND lpc.packaged_amount > 0
      GROUP BY
        l.material_id, m.lookup_code, m.Description,
        l.lot_id, l.lookup_code, l.status_name,
        vl.expiration_date, l.parquet_record_sys_date_time,
        pm.project_lookup
      HAVING SUM(lpc.packaged_amount) > 0
    `
    const lotRows = await runQuery(lotSql)

    // ── Query 2: Pending orders in the next 21 days (with ship-to) ───────
    //
    // Same "one appt per order — earliest active" pattern as fefo-orders,
    // but grouped down to (order, material) with a summed case count so we
    // know the demand shape per material for FEFO projection.
    const orderSql = `
      WITH pvi_projects AS (
        SELECT project_id, lookup_code
        FROM production_db.silver.datex_slv_projects
        WHERE lookup_code IN (${projList})
      ),
      appts AS (
        SELECT order_id, scheduled_arrival
        FROM (
          SELECT
            dai.item_entity_id           AS order_id,
            da.scheduled_arrival,
            ROW_NUMBER() OVER (
              PARTITION BY dai.item_entity_id
              ORDER BY da.scheduled_arrival ASC
            ) AS rn
          FROM production_db.silver.datex_slv_dockappointmentitems dai
          JOIN production_db.silver.datex_slv_dockappointments da
            ON da.dock_appointment_id = dai.dock_appointment_id
          JOIN production_db.silver.datex_slv_dockappointmentstatuses ds
            ON ds.dock_appointment_status_id = da.status_id
          WHERE dai.item_entity_type = 'Order'
            AND ds.dock_appointment_status_name NOT IN ('Cancelled', 'Completed')
            AND da.warehouse_id = ${CAL_WAREHOUSE_ID}
            AND DATE(da.scheduled_arrival) BETWEEN
                CURRENT_DATE - INTERVAL 1 DAY
                AND CURRENT_DATE + INTERVAL ${PENDING_DAYS_FORWARD} DAY
        ) ranked
        WHERE rn = 1
      )
      SELECT
        o.order_id,
        o.lookup_code                        AS order_lookup,
        a.scheduled_arrival,
        p.lookup_code                        AS project_lookup,
        MAX(CASE WHEN oa.type_id = 2 THEN oa."Name" END) AS ship_to_raw_name,
        ol.material_id,
        SUM(COALESCE(ol.packaged_amount, 0)) AS cases
      FROM production_db.silver.datex_slv_orders o
      JOIN pvi_projects p                                        ON p.project_id = o.project_id
      JOIN appts a                                               ON a.order_id = o.order_id
      JOIN production_db.silver.datex_slv_orderstatuses os       ON os.order_status_id = o.order_status_id
      JOIN production_db.silver.datex_slv_orderlines ol          ON ol.order_id = o.order_id
      LEFT JOIN production_db.silver.datex_slv_orderaddresses oa ON oa.order_id = o.order_id
      WHERE os.status_name = 'Processing'
      GROUP BY o.order_id, o.lookup_code, a.scheduled_arrival, p.lookup_code, ol.material_id
      ORDER BY a.scheduled_arrival ASC, o.order_id ASC
    `
    const orderRows = await runQuery(orderSql)

    // ── Query 3: Historical velocity per (material, project) ─────────────
    //
    // 90-day pick history bucketed into 30/60/90 windows so the client can
    // compute daily case rates and pick MIN (conservative). Also emit
    // shipments_30d for confidence tiers (High ≥12, Med 4–11, Low <4).
    //
    // We look at ACTUAL picks (tasks in status 'Completed') rather than order
    // lines — closer to true throughput and matches what the FEFO engine
    // actually consumed.
    const velSql = `
      WITH pvi_projects AS (
        SELECT project_id, lookup_code
        FROM production_db.silver.datex_slv_projects
        WHERE lookup_code IN (${projList})
      )
      SELECT
        t.material_id,
        p.lookup_code AS project_lookup,
        SUM(CASE WHEN t.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 30 DAY
                 THEN t.actual_packaged_amount ELSE 0 END) AS cases_30d,
        SUM(CASE WHEN t.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 60 DAY
                 THEN t.actual_packaged_amount ELSE 0 END) AS cases_60d,
        SUM(t.actual_packaged_amount)                       AS cases_90d,
        COUNT(DISTINCT CASE WHEN t.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 30 DAY
                            THEN t.order_id END)            AS shipments_30d
      FROM production_db.silver.datex_slv_tasks t
      JOIN production_db.silver.datex_slv_taskstatuses ts ON ts.task_status_id = t.status_id
      JOIN production_db.silver.datex_slv_orders o        ON o.order_id = t.order_id
      JOIN pvi_projects p                                 ON p.project_id = o.project_id
      WHERE t.warehouse_id = ${CAL_WAREHOUSE_ID}
        AND ts.status_name = 'Completed'
        AND t.actual_packaged_amount > 0
        AND t.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 90 DAY
      GROUP BY t.material_id, p.lookup_code
    `
    const velRows = await runQuery(velSql)

    // ── Query 4: Material × ship-to 90-day pick history ──────────────────
    //
    // For each PVI material, list every ship-to that received cases in the
    // last 90 days along with total cases + shipment count. The client uses
    // this to compute:
    //   (a) Dominant recipient per material (whoever got the most cases) —
    //       used to fill in "Projected ship" for lots with no scheduled
    //       demand and no velocity-based allocation.
    //   (b) Strictest spec per material (MAX of shelf-life-days across all
    //       resolved-canonical recipients) — used as the fallback baseline
    //       for the Vs. Spec column when no primary allocation exists.
    //
    // Verified query size: ~5k rows across ~740 materials × ~160 ship-tos
    // for the current PVI corpus. Small enough to ship over the wire.
    const histSql = `
      WITH pvi_projects AS (
        SELECT project_id, lookup_code
        FROM production_db.silver.datex_slv_projects
        WHERE lookup_code IN (${projList})
      )
      SELECT
        t.material_id,
        oa."Name"                                    AS ship_to_raw_name,
        SUM(t.actual_packaged_amount)                AS cases_90d,
        COUNT(DISTINCT t.order_id)                   AS shipments_90d
      FROM production_db.silver.datex_slv_tasks t
      JOIN production_db.silver.datex_slv_taskstatuses ts ON ts.task_status_id = t.status_id
      JOIN production_db.silver.datex_slv_orders o        ON o.order_id = t.order_id
      JOIN pvi_projects p                                 ON p.project_id = o.project_id
      LEFT JOIN production_db.silver.datex_slv_orderaddresses oa
        ON oa.order_id = t.order_id AND oa.type_id = 2
      WHERE t.warehouse_id = ${CAL_WAREHOUSE_ID}
        AND ts.status_name = 'Completed'
        AND t.actual_packaged_amount > 0
        AND t.parquet_record_sys_date_time >= CURRENT_DATE - INTERVAL 90 DAY
        AND oa."Name" IS NOT NULL
        AND oa."Name" != ''
      GROUP BY t.material_id, oa."Name"
    `
    const histRows = await runQuery(histSql)

    // ── Shape response ───────────────────────────────────────────────────

    const lots = lotRows.map(r => ({
      material_id:         Number(r.material_id),
      material_code:       r.material_code || `MAT-${r.material_id}`,
      material_desc:       (r.material_desc || '').trim(),
      lot_id:              Number(r.lot_id),
      lot_code:            r.lot_code || '',
      lot_status:          r.lot_status || '',
      expiration_date_iso: toISODate(r.expiration_date),
      received_at_iso:     toISODate(r.received_at),
      project_lookup:      r.project_lookup || null,
      cases_onhand:        Number(r.cases_onhand) || 0,
      cases_committed:     Number(r.cases_committed) || 0,
      cases_available:     Number(r.cases_available) || 0,
      lp_count:            Number(r.lp_count) || 0,
    }))

    // Roll up orderlines by order_id.
    const ordersById = new Map()
    for (const r of orderRows) {
      const oid = Number(r.order_id)
      if (!ordersById.has(oid)) {
        ordersById.set(oid, {
          order_id:              oid,
          order_lookup:          r.order_lookup || `ORD-${oid}`,
          scheduled_arrival_iso: toISODateTime(r.scheduled_arrival),
          ship_to_raw_name:      r.ship_to_raw_name || '',
          project_lookup:        r.project_lookup || null,
          lines:                 [],
        })
      }
      ordersById.get(oid).lines.push({
        material_id: Number(r.material_id),
        cases:       Number(r.cases) || 0,
      })
    }
    const pendingOrders = Array.from(ordersById.values())

    const velocity = velRows.map(r => ({
      material_id:    Number(r.material_id),
      project_lookup: r.project_lookup || null,
      cases_30d:      Number(r.cases_30d) || 0,
      cases_60d:      Number(r.cases_60d) || 0,
      cases_90d:      Number(r.cases_90d) || 0,
      shipments_30d:  Number(r.shipments_30d) || 0,
    }))

    const materialShipHistory = histRows.map(r => ({
      material_id:      Number(r.material_id),
      ship_to_raw_name: r.ship_to_raw_name || '',
      cases_90d:        Number(r.cases_90d) || 0,
      shipments_90d:    Number(r.shipments_90d) || 0,
    }))

    try { conn?.close(); db?.close() } catch (_) {}

    return {
      statusCode: 200, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        lots,
        pendingOrders,
        velocity,
        materialShipHistory,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        source: 'motherduck',
        rowCounts: {
          lots:                lotRows.length,
          pendingOrders:       orderRows.length,
          velocity:            velRows.length,
          materialShipHistory: histRows.length,
        },
      }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.slice(0, 500),
        elapsedMs: Date.now() - t0,
      }),
    }
  }
}
