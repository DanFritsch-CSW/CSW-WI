'use strict'

// Netlify function — live FEFO orders from Datex via MotherDuck.
//
// POST input: { facility, projectIds, dayCount = 5 }
//   - facility:   'cal' | 'mad' | 'ken' | 'wr' | 'ec'
//   - projectIds: string[] of project IDs (one or more of 'faioa5', 'fofwe5',
//                 'riche5', 'golst5'). Single `projectId` is accepted for
//                 backward compat and wrapped in an array.
//   - dayCount:   optional, 1..7 (default 5)
//
// Response: {
//   ordersByProject: { [projectId]: Order[] },
//   errorsByProject: { [projectId]: string },
//   fetchedAt: ISO, elapsedMs, source: 'motherduck',
//   rowCounts: { [projectId]: { orders, allocations, onhand } },
// }
//
// ── duckdb / MotherDuck init pattern ────────────────────────────────────────
//
// Took several rounds of diagnostics in production to find the right pattern.
// What works on Netlify Lambda (Node 22, Linux x64):
//
//   1. Set HOME=/tmp BEFORE require('duckdb'). duckdb reads HOME at load
//      time to know where to cache extensions. Lambda's HOME is empty by
//      default. /tmp is the only writable directory on Lambda.
//   2. process.env.motherduck_token = TOKEN. The token MUST come via env
//      var. Passing it as the Database constructor's second arg silently
//      produces a broken db handle that fails at first use with the
//      misleading "Connection was never established" error.
//   3. Open an in-memory database. DO NOT use `md:production_db` as the
//      URI — that triggers eager MotherDuck connection inside the constructor,
//      which fails for the same home-directory reason but swallows the
//      error in async init. The Connection wrapper then throws the
//      "Connection was never established" message on every operation.
//   4. SET home_directory='/tmp' explicitly on the connection. Belt and
//      suspenders alongside the HOME env var.
//   5. INSTALL motherduck + LOAD motherduck. Cold start fetches the
//      extension (~10-20 MB) from extensions.duckdb.org into /tmp;
//      warm starts reuse the cache.
//   6. ATTACH 'md:production_db' AS prod (TYPE motherduck), then USE prod.
//      All subsequent queries can reference silver.<table> directly.
//
// Diagnostic v2 captured the actual error from Pattern C:
//   "IO Error: Can't find the home directory at ''
//    Specify a home directory using the SET home_directory='/path/to/dir' option."
// Patterns A/B/D/E hit the same error but reported it as "Connection was
// never established" because the failure happens inside the async Database
// init queue and the Connection wrapper just sees a dead handle.
//
// ── Schema / data architecture (per Phase 7a recon) ─────────────────────────
//   - hardallocations.shipment_line_id is always null in this Datex instance.
//     Allocations link to orders via TASKS, not shipment_line_id.
//   - Pre-pick orders only have lot-level allocation; LP-level assignment
//     happens at pick time. We return lot-level data with LP counts.
//   - Lot lookup_codes carry the date per-project (YDDDHHMMSS / MMDDYYYY /
//     PPW+MMDDYYYY). Server-side parsers compute the sortable k integer.

// Set HOME before requiring duckdb — duckdb reads it at load time.
process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECTS = {
  faioa5: { datexName: 'FAIR OAKS FARMS',      dateFormat: 'YDDDHHMMSS',   dateSemantic: 'pack' },
  fofwe5: { datexName: 'FAIR OAKS FARMS WEST', dateFormat: 'YDDDHHMMSS',   dateSemantic: 'pack' },
  riche5: { datexName: 'RICHELIEU KENOSHA',    dateFormat: 'MMDDYYYY',     dateSemantic: 'expiration' },
  golst5: { datexName: 'CROWN BAKERIES',       dateFormat: 'PPW+MMDDYYYY', dateSemantic: 'pack' },
}

const FACILITY_WAREHOUSE_ID = {
  cal: 1, ec: 3, mad: 4, ken: 5, wr: 6,
}

const HOLD_STATUS_NAMES = new Set([
  'HOLD', 'Pending Hold', 'QA Hold', 'Food Safety',
  'NOT RELEASED', 'Damaged / Hold', 'Administrative',
])
function isHoldStatus(s) {
  if (!s) return false
  if (HOLD_STATUS_NAMES.has(s)) return true
  return /hold|not released/i.test(s)
}

// ─── Date parsers (server copy — mirrors src/lib/fefo.js) ───────────────────

function parseFairOaksDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d)(\d{3})(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  const yDigit = Number(m[1])
  const doy    = Number(m[2])
  const hh     = Number(m[3])
  const mm     = Number(m[4])
  const ss     = Number(m[5])
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || ss > 59) return null
  const currentYear = new Date().getUTCFullYear()
  const currentDecade = Math.floor(currentYear / 10) * 10
  let year = currentDecade + yDigit
  if (year > currentYear + 1) year -= 10
  const d = new Date(Date.UTC(year, 0, 1))
  d.setUTCDate(doy)
  const month = d.getUTCMonth() + 1
  const day   = d.getUTCDate()
  const k = year * 1e9 + doy * 1e6 + hh * 1e4 + mm * 1e2 + ss
  return { k, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseRichelieuDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!m) return null
  const month = Number(m[1])
  const day   = Number(m[2])
  const year  = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null
  const k = year * 10000 + month * 100 + day
  return { k, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseCrownDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  return parseRichelieuDate(lookupCode.replace(/^PPW/i, ''))
}

function parseLotDateKey(lookupCode, dateFormat) {
  let parsed
  if (dateFormat === 'YDDDHHMMSS')        parsed = parseFairOaksDate(lookupCode)
  else if (dateFormat === 'MMDDYYYY')     parsed = parseRichelieuDate(lookupCode)
  else if (dateFormat === 'PPW+MMDDYYYY') parsed = parseCrownDate(lookupCode)
  else parsed = null
  if (!parsed) return { k: 0, display: lookupCode || '?', error: `unparseable ${dateFormat}` }
  return parsed
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function dayOffsetFrom(dateLike, today) {
  if (!dateLike) return null
  const d = new Date(dateLike)
  if (Number.isNaN(d.getTime())) return null
  const dDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const diffMs = dDay.getTime() - today.getTime()
  return Math.round(diffMs / 86400000)
}

function todayUtcMidnight() {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
}

function fmtDateISO(d) {
  return d.toISOString().slice(0, 10)
}

function shortUser(u) {
  if (!u) return ''
  return String(u).replace(/^FOOTPRINT\\(csw-)?/i, '')
}

function fmtDest(name, city, state) {
  const n = (name || '').trim()
  const c = (city || '').trim()
  const s = (state || '').trim()
  if (!n && !c) return ''
  const loc = c && s ? `${c}, ${s}` : c || s
  return loc ? `${n} \u2014 ${loc}` : n
}

// ─── Per-project query block (runs on shared duckdb connection) ─────────────

async function loadOrdersForProject(runQuery, { projectId, project, warehouseId, today, dateFrom, dateTo, dayCount }) {
  const safeProjectName = project.datexName.replace(/'/g, "''")

  // ── Query 1: order headers ──
  const orderSql = `
    WITH proj AS (
      SELECT project_id FROM silver.datex_slv_projects WHERE project_name = '${safeProjectName}'
    ),
    window_orders AS (
      SELECT
        o.order_id, o.lookup_code AS order_lookup,
        o.requested_delivery_date, o.modified_sys_user, o.modified_sys_date_time,
        os.status_name
      FROM silver.datex_slv_orders o
      JOIN proj ON o.project_id = proj.project_id
      JOIN silver.datex_slv_orderstatuses os ON o.order_status_id = os.order_status_id
      WHERE os.status_name = 'Processing'
        AND DATE(o.requested_delivery_date) BETWEEN '${dateFrom}' AND '${dateTo}'
    ),
    orders_with_tasks_in_wh AS (
      SELECT DISTINCT wo.order_id
      FROM window_orders wo
      JOIN silver.datex_slv_tasks t ON t.order_id = wo.order_id
      WHERE t.warehouse_id = ${warehouseId}
    )
    SELECT
      wo.order_id, wo.order_lookup,
      wo.requested_delivery_date,
      wo.status_name,
      wo.modified_sys_user,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.Name END)  AS dest_name,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.City END)  AS dest_city,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.State END) AS dest_state
    FROM window_orders wo
    JOIN orders_with_tasks_in_wh ot ON wo.order_id = ot.order_id
    LEFT JOIN silver.datex_slv_orderaddresses oa ON oa.order_id = wo.order_id
    GROUP BY wo.order_id, wo.order_lookup, wo.requested_delivery_date,
             wo.status_name, wo.modified_sys_user
    ORDER BY wo.requested_delivery_date ASC, wo.order_id ASC
  `
  const orderRows = await runQuery(orderSql)

  if (orderRows.length === 0) {
    return { orders: [], rowCounts: { orders: 0, allocations: 0, onhand: 0 } }
  }

  const orderIds = orderRows.map(r => Number(r.order_id))
  const orderIdList = orderIds.join(',')

  // ── Query 2: allocations per (order, material, lot) ──
  const allocSql = `
    SELECT
      t.order_id, t.order_line_number, t.material_id,
      m.lookup_code AS material_code, m.Description AS material_desc,
      t.lot_id, l.lookup_code AS lot_code, l.status_name AS lot_status,
      COUNT(DISTINCT t.task_id) AS lp_count_planned,
      COUNT(DISTINCT t.actual_source_license_plate_id) AS lp_count_actual,
      SUM(t.expected_packaged_amount) AS expected_cases,
      SUM(t.actual_packaged_amount)   AS actual_cases
    FROM silver.datex_slv_tasks t
    JOIN silver.datex_slv_lots l ON t.lot_id = l.lot_id
    JOIN silver.datex_slv_materials m ON t.material_id = m.material_id
    WHERE t.order_id IN (${orderIdList})
      AND t.lot_id IS NOT NULL
      AND t.warehouse_id = ${warehouseId}
    GROUP BY t.order_id, t.order_line_number, t.material_id,
             m.lookup_code, m.Description,
             t.lot_id, l.lookup_code, l.status_name
  `
  const allocRows = await runQuery(allocSql)

  const materialIds = [...new Set(allocRows.map(r => Number(r.material_id)))]

  // ── Query 3: on-hand by lot ──
  let onhandRows = []
  if (materialIds.length > 0) {
    const matIdList = materialIds.join(',')
    const onhandSql = `
      SELECT
        l.material_id, l.lot_id,
        l.lookup_code AS lot_code, l.status_name AS lot_status,
        COUNT(DISTINCT lpc.license_plate_id) AS lp_count,
        SUM(lpc.packaged_amount) AS cases_onhand
      FROM silver.datex_slv_licenseplatecontents lpc
      JOIN silver.datex_slv_lots l  ON lpc.lot_id = l.lot_id
      JOIN silver.datex_slv_licenseplates lp ON lpc.license_plate_id = lp.license_plate_id
      WHERE l.material_id IN (${matIdList})
        AND lp.warehouse_id = ${warehouseId}
        AND lp.Archived = false
        AND lpc.packaged_amount > 0
      GROUP BY l.material_id, l.lot_id, l.lookup_code, l.status_name
    `
    onhandRows = await runQuery(onhandSql)
  }

  // ── Assemble Order objects ──

  const linesByOrderMaterial = new Map()
  const allocLotsByLine = new Map()

  for (const r of allocRows) {
    const key = `${r.order_id}|${r.material_id}`
    if (!linesByOrderMaterial.has(key)) {
      linesByOrderMaterial.set(key, {
        orderId: Number(r.order_id),
        materialId: Number(r.material_id),
        code: r.material_code || `MAT-${r.material_id}`,
        desc: (r.material_desc || '').trim(),
        pack: '',
        ship: [],
      })
      allocLotsByLine.set(key, new Set())
    }
    const line = linesByOrderMaterial.get(key)
    const allocLots = allocLotsByLine.get(key)
    allocLots.add(Number(r.lot_id))

    const parsed = parseLotDateKey(r.lot_code, project.dateFormat)
    const cases = Number(r.actual_cases) > 0 ? Number(r.actual_cases) : Number(r.expected_cases) || 0
    const lps = Number(r.lp_count_actual) > 0
      ? Number(r.lp_count_actual)
      : Number(r.lp_count_planned) || 0
    line.ship.push({
      lot: r.lot_code,
      date: parsed.display,
      k: parsed.k,
      lps, cases,
    })
  }

  const onhandByMaterial = new Map()
  for (const r of onhandRows) {
    const mid = Number(r.material_id)
    if (!onhandByMaterial.has(mid)) onhandByMaterial.set(mid, [])
    onhandByMaterial.get(mid).push({
      lotId:    Number(r.lot_id),
      lotCode:  r.lot_code,
      status:   r.lot_status,
      cases:    Number(r.cases_onhand) || 0,
      lps:      Number(r.lp_count) || 0,
    })
  }

  for (const [key, line] of linesByOrderMaterial.entries()) {
    const allocLots = allocLotsByLine.get(key)
    const candidates = (onhandByMaterial.get(line.materialId) || [])
      .filter(c => !allocLots.has(c.lotId))
      .map(c => {
        const parsed = parseLotDateKey(c.lotCode, project.dateFormat)
        return { ...c, k: parsed.k, display: parsed.display }
      })
      .filter(c => c.cases > 0)
    if (candidates.length > 0) {
      const oldest = candidates.reduce((a, b) => a.k < b.k ? a : b)
      const held = isHoldStatus(oldest.status)
      line.rem = {
        lot:      oldest.lotCode,
        date:     oldest.display,
        k:        oldest.k,
        lps:      oldest.lps,
        cases:    oldest.cases,
        hold:     held,
        holdType: held ? oldest.status : undefined,
      }
    } else {
      line.rem = { lot: '', date: '', k: 0, lps: 0, cases: 0, hold: false }
    }
  }

  const orders = []
  for (const oh of orderRows) {
    const orderId = Number(oh.order_id)
    const reqDate = oh.requested_delivery_date
    const dayOffset = dayOffsetFrom(reqDate, today)
    const day = Math.max(0, Math.min(dayCount - 1, dayOffset == null ? 0 : dayOffset))
    const past = dayOffset != null && dayOffset < 0
    const orderLines = []
    for (const [key, line] of linesByOrderMaterial.entries()) {
      if (line.orderId !== orderId) continue
      line.ship.sort((a, b) => a.k - b.k)
      orderLines.push({
        code: line.code, desc: line.desc, pack: line.pack,
        ship: line.ship, rem: line.rem,
      })
    }
    if (orderLines.length === 0) continue
    orders.push({
      id:       `SO-${oh.order_lookup || orderId}`,
      day,
      proj:     projectId,
      dest:     fmtDest(oh.dest_name, oh.dest_city, oh.dest_state),
      appt:     '\u2014',
      past,
      status:   oh.status_name,
      allocBy:  shortUser(oh.modified_sys_user),
      lines:    orderLines,
    })
  }

  return {
    orders,
    rowCounts: { orders: orderRows.length, allocations: allocRows.length, onhand: onhandRows.length },
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return {
      statusCode: 500, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }),
    }
  }

  let facility, projectIds, projectId, dayCount
  try {
    ;({ facility, projectIds, projectId, dayCount } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }
  dayCount = Number(dayCount) || 5
  if (dayCount < 1 || dayCount > 7) dayCount = 5

  if (!projectIds && projectId) projectIds = [projectId]
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'projectIds (array) or projectId (string) required' }),
    }
  }
  const unknown = projectIds.filter(pid => !PROJECTS[pid])
  if (unknown.length > 0) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Unknown projectId(s): ${unknown.join(', ')}` }),
    }
  }
  const warehouseId = FACILITY_WAREHOUSE_ID[facility]
  if (!warehouseId) {
    return {
      statusCode: 400, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Unknown facility: ${facility}` }),
    }
  }

  const today = todayUtcMidnight()
  const dateFrom = fmtDateISO(new Date(today.getTime() - 86400000))
  const dateTo   = fmtDateISO(new Date(today.getTime() + (dayCount - 1) * 86400000))

  let conn, db
  const ordersByProject = {}
  const errorsByProject = {}
  const rowCountsByProject = {}
  try {
    // See top-of-file comment block for why this exact sequence.
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
    await exec(`ATTACH 'md:production_db' AS prod (TYPE motherduck)`)
    await exec('USE prod')

    // Sequential loop on the shared connection.
    for (const pid of projectIds) {
      try {
        const result = await loadOrdersForProject(runQuery, {
          projectId: pid,
          project: PROJECTS[pid],
          warehouseId, today, dateFrom, dateTo, dayCount,
        })
        ordersByProject[pid] = result.orders
        rowCountsByProject[pid] = result.rowCounts
      } catch (perProjectErr) {
        ordersByProject[pid] = []
        errorsByProject[pid] = perProjectErr.message || 'unknown error'
        rowCountsByProject[pid] = { orders: 0, allocations: 0, onhand: 0 }
      }
    }
  } catch (e) {
    for (const pid of projectIds) {
      ordersByProject[pid] = ordersByProject[pid] || []
      errorsByProject[pid] = e.message || 'connection failed'
      rowCountsByProject[pid] = rowCountsByProject[pid] || { orders: 0, allocations: 0, onhand: 0 }
    }
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502, headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        ordersByProject,
        errorsByProject,
        rowCountsByProject,
        error: e.message,
        stack: e.stack?.slice(0, 500),
        elapsedMs: Date.now() - t0,
      }),
    }
  }
  try { conn?.close(); db?.close() } catch (_) {}

  return {
    statusCode: 200, headers: NO_CACHE_HEADERS,
    body: JSON.stringify({
      ordersByProject,
      ...(Object.keys(errorsByProject).length > 0 ? { errorsByProject } : {}),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      source: 'motherduck',
      rowCounts: rowCountsByProject,
    }),
  }
}
