'use strict'

// Netlify function — live FEFO orders from Datex via MotherDuck.
//
// POST input: { facility, projectIds, dayCount = 5 }
//   - facility:   'cal' | 'mad' | 'ken' | 'wr' | 'ec'
//   - projectIds: string[] of project IDs (one or more of 'faioa5', 'fofwe5',
//                 'riche5', 'golst5', 'birch5').
//   - dayCount:   optional, 1..7 (default 5)
//
// ── Date formats per project ────────────────────────────────────────────────
//
//   YDDDHHMMSS       — Fair Oaks lot lookup_code (year+DOY+time)
//   MMDDYYYY         — Richelieu lot lookup_code (expiration date)
//   PPW+MMDDYYYY     — Crown lot lookup_code (PPW-prefixed pack date)
//   receiveDate      — Birchwood — no date encoded in lookup_code.
//                      Use lot.receive_date TIMESTAMP directly. Verb changes
//                      to "received" on the client since it's not pack date.
//
// ── Dismissals (2026-07-08, Sadie's replacement-batch ask) ──────────────────
//
// Users can dismiss individual lots via /.netlify/functions/fefo-dismissals.
// Rows are in Supabase.fefo_dismissals with a dismissed_until timestamp.
// This function pulls active dismissals at request time and filters those
// lots out of REM candidates so violations stop firing for them.

// Set HOME before requiring duckdb — duckdb reads it at load time.
process.env.HOME = process.env.HOME || '/tmp'

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const PROJECTS = {
  faioa5: { datexName: 'FAIR OAKS FARMS',         dateFormat: 'YDDDHHMMSS',   dateSemantic: 'pack' },
  fofwe5: { datexName: 'FAIR OAKS FARMS WEST',    dateFormat: 'YDDDHHMMSS',   dateSemantic: 'pack' },
  riche5: { datexName: 'RICHELIEU KENOSHA',       dateFormat: 'MMDDYYYY',     dateSemantic: 'expiration' },
  golst5: { datexName: 'CROWN BAKERIES',          dateFormat: 'PPW+MMDDYYYY', dateSemantic: 'pack' },
  birch5: { datexName: 'BIRCHWOOD FOODS  KENOSHA', dateFormat: 'receiveDate', dateSemantic: 'received' },
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

const NON_ALLOCATABLE_LOCATION_PATTERNS = [
  /receiving/i, /staging/i, /quarantine/i,
  /\bdock\b/i, /\bdoor\b/i, /desktop/i, /\bscanner\b/i, /inspection/i,
]

function classifyLocations(locationsString) {
  if (!locationsString) return { locations: [], primary: '', locationBlocked: false }
  const parts = String(locationsString).split(' | ').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return { locations: [], primary: '', locationBlocked: false }
  const blocked = parts.map(p => NON_ALLOCATABLE_LOCATION_PATTERNS.some(rx => rx.test(p)))
  return { locations: parts, primary: parts[0], locationBlocked: blocked.every(Boolean) }
}

// ─── Dismissals (Supabase) ──────────────────────────────────────────────────
//
// Best-effort — if the fetch fails we return an empty set and log. FEFO data
// still returns; users just don't see the effect of dismissals until Supabase
// recovers.

async function loadActiveDismissals(projectIds) {
  const SUPABASE_URL =
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    ''
  const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  if (!SUPABASE_URL || !SUPABASE_KEY || !projectIds?.length) return new Set()
  try {
    const inList = projectIds.map(p => `"${p}"`).join(',')
    const nowIso = new Date().toISOString()
    const params = new URLSearchParams()
    params.set('select', 'project_id,lot_lookup_code')
    params.set('project_id', `in.(${inList})`)
    params.set('dismissed_until', `gt.${nowIso}`)
    const url = `${SUPABASE_URL}/rest/v1/fefo_dismissals?${params.toString()}`
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    })
    if (!res.ok) return new Set()
    const rows = await res.json()
    const set = new Set()
    for (const r of rows) set.add(`${r.project_id}|${r.lot_lookup_code}`)
    return set
  } catch (e) {
    console.warn('loadActiveDismissals failed:', e.message)
    return new Set()
  }
}

// ─── Date parsers ──────────────────────────────────────────────────────────

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
  const kDay = year * 1000 + doy
  const k    = kDay * 1e6 + hh * 1e4 + mm * 1e2 + ss
  return { k, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseRichelieuDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  const m = lookupCode.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!m) return null
  const month = Number(m[1])
  const day   = Number(m[2])
  const year  = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null
  const kDay = year * 10000 + month * 100 + day
  return { k: kDay, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseCrownDate(lookupCode) {
  if (!lookupCode || typeof lookupCode !== 'string') return null
  return parseRichelieuDate(lookupCode.replace(/^PPW/i, ''))
}

function parseReceiveDate(receiveDate) {
  if (!receiveDate) return null
  const d = receiveDate instanceof Date ? receiveDate : new Date(receiveDate)
  if (Number.isNaN(d.getTime())) return null
  const year  = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day   = d.getUTCDate()
  const hh    = d.getUTCHours()
  const mm    = d.getUTCMinutes()
  const ss    = d.getUTCSeconds()
  const kDay = year * 10000 + month * 100 + day
  const k    = kDay * 1e6 + hh * 1e4 + mm * 1e2 + ss
  return { k, kDay, display: `${month}/${day}/${String(year).slice(-2)}` }
}

function parseLotDateKey(lookupCode, dateFormat, extras) {
  let parsed
  if (dateFormat === 'YDDDHHMMSS')        parsed = parseFairOaksDate(lookupCode)
  else if (dateFormat === 'MMDDYYYY')     parsed = parseRichelieuDate(lookupCode)
  else if (dateFormat === 'PPW+MMDDYYYY') parsed = parseCrownDate(lookupCode)
  else if (dateFormat === 'receiveDate')  parsed = parseReceiveDate(extras?.receiveDate)
  else parsed = null
  if (!parsed) return { k: 0, kDay: 0, display: lookupCode || '?', error: `unparseable ${dateFormat}` }
  return parsed
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function arrivalToDate(scheduledArrival) {
  if (!scheduledArrival) return null
  if (scheduledArrival instanceof Date) return scheduledArrival
  const d = new Date(scheduledArrival)
  return Number.isNaN(d.getTime()) ? null : d
}

function fmtApptTime(scheduledArrival) {
  const arrival = arrivalToDate(scheduledArrival)
  if (!arrival) return '—'
  const h = String(arrival.getUTCHours()).padStart(2, '0')
  const m = String(arrival.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function fmtPack(palletTie, palletHigh, shortName) {
  const t = Number(palletTie) || 0
  const h = Number(palletHigh) || 0
  if (t > 0 && h > 0) return `${t}×${h}`
  const s = String(shortName || '').trim()
  return s
}

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

function fmtDateISO(d) { return d.toISOString().slice(0, 10) }

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
  return loc ? `${n} — ${loc}` : n
}

// ─── Per-project query block ───────────────────────────────────────────────

async function loadOrdersForProject(runQuery, { projectId, project, warehouseId, today, dateFrom, dateTo, dayCount, dismissedSet }) {
  const safeProjectName = project.datexName.replace(/'/g, "''")

  const orderSql = `
    WITH proj AS (
      SELECT project_id FROM production_db.silver.datex_slv_projects
      WHERE project_name = '${safeProjectName}'
    ),
    appts AS (
      SELECT order_id, scheduled_arrival, appt_lookup, appt_status
      FROM (
        SELECT
          dai.item_entity_id        AS order_id,
          da.scheduled_arrival,
          da.lookup_code            AS appt_lookup,
          ds.dock_appointment_status_name AS appt_status,
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
          AND da.warehouse_id = ${warehouseId}
          AND DATE(da.scheduled_arrival) BETWEEN '${dateFrom}' AND '${dateTo}'
      ) ranked
      WHERE rn = 1
    )
    SELECT
      o.order_id,
      o.lookup_code AS order_lookup,
      o.requested_delivery_date,
      os.status_name,
      o.modified_sys_user,
      a.scheduled_arrival,
      a.appt_lookup,
      a.appt_status,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.Name END)  AS dest_name,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.City END)  AS dest_city,
      MAX(CASE WHEN oa.type_id = 2 THEN oa.State END) AS dest_state
    FROM production_db.silver.datex_slv_orders o
    JOIN proj                                                  ON o.project_id = proj.project_id
    JOIN production_db.silver.datex_slv_orderstatuses os       ON o.order_status_id = os.order_status_id
    JOIN appts a                                               ON a.order_id = o.order_id
    LEFT JOIN production_db.silver.datex_slv_orderaddresses oa ON oa.order_id = o.order_id
    WHERE os.status_name = 'Processing'
    GROUP BY o.order_id, o.lookup_code, o.requested_delivery_date,
             os.status_name, o.modified_sys_user,
             a.scheduled_arrival, a.appt_lookup, a.appt_status
    ORDER BY a.scheduled_arrival ASC, o.order_id ASC
  `
  const orderRows = await runQuery(orderSql)

  if (orderRows.length === 0) {
    return { orders: [], rowCounts: { orders: 0, allocations: 0, onhand: 0 } }
  }

  const orderIds = orderRows.map(r => Number(r.order_id))
  const orderIdList = orderIds.join(',')

  const allocSql = `
    SELECT
      t.order_id, t.order_line_number, t.material_id,
      m.lookup_code AS material_code, m.Description AS material_desc,
      mp.pallet_tie, mp.pallet_high,
      iu.short_name AS pack_unit_short,
      t.lot_id, l.lookup_code AS lot_code, l.status_name AS lot_status,
      l.receive_date AS lot_receive_date,
      COUNT(DISTINCT t.task_id) AS lp_count_planned,
      COUNT(DISTINCT t.actual_source_license_plate_id) AS lp_count_actual,
      SUM(t.expected_packaged_amount) AS expected_cases,
      SUM(t.actual_packaged_amount)   AS actual_cases
    FROM production_db.silver.datex_slv_tasks t
    JOIN production_db.silver.datex_slv_lots l ON t.lot_id = l.lot_id
    JOIN production_db.silver.datex_slv_materials m ON t.material_id = m.material_id
    LEFT JOIN production_db.silver.datex_slv_materialspackagingslookup mp
      ON mp.material_id = t.material_id
      AND mp.is_reporting_default = true
      AND mp.deprecated_packaging = false
    LEFT JOIN production_db.silver.datex_slv_inventorymeasurementunits iu
      ON iu.inventory_measurement_unit_id = mp.packaging_id
    WHERE t.order_id IN (${orderIdList})
      AND t.lot_id IS NOT NULL
      AND t.warehouse_id = ${warehouseId}
    GROUP BY t.order_id, t.order_line_number, t.material_id,
             m.lookup_code, m.Description,
             mp.pallet_tie, mp.pallet_high, iu.short_name,
             t.lot_id, l.lookup_code, l.status_name, l.receive_date
  `
  const allocRows = await runQuery(allocSql)

  const materialIds = [...new Set(allocRows.map(r => Number(r.material_id)))]

  let onhandRows = []
  if (materialIds.length > 0) {
    const matIdList = materialIds.join(',')
    const onhandSql = `
      WITH committed_raw AS (
        SELECT t.lot_id, t.expected_packaged_amount AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        WHERE t.warehouse_id = ${warehouseId}
          AND t.lot_id IS NOT NULL
          AND ts.status_name IN ('Planned', 'Released', 'Started', 'Suspended')

        UNION ALL

        SELECT lpc.lot_id, t.expected_packaged_amount AS cases_committed
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_taskstatuses ts
          ON ts.task_status_id = t.status_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc
          ON lpc.license_plate_id = t.actual_source_license_plate_id
        WHERE t.warehouse_id = ${warehouseId}
          AND t.lot_id IS NULL
          AND t.actual_source_license_plate_id IS NOT NULL
          AND lpc.lot_id IS NOT NULL
          AND ts.status_name IN ('Planned', 'Released', 'Started', 'Suspended')
      ),
      committed AS (
        SELECT lot_id, SUM(cases_committed) AS cases_committed
        FROM committed_raw
        GROUP BY lot_id
      ),
      lot_locations AS (
        SELECT
          lpc.lot_id,
          STRING_AGG(DISTINCT loc.location_container_name, ' | ') AS locations
        FROM production_db.silver.datex_slv_licenseplatecontents lpc
        JOIN production_db.silver.datex_slv_licenseplates lp
          ON lpc.license_plate_id = lp.license_plate_id
        LEFT JOIN production_db.silver.datex_slv_locationcontainers loc
          ON lp.location_id = loc.location_container_id
        WHERE lp.warehouse_id = ${warehouseId}
          AND lp.Archived = false
          AND lpc.packaged_amount > 0
        GROUP BY lpc.lot_id
      )
      SELECT
        l.material_id, l.lot_id,
        l.lookup_code AS lot_code, l.status_name AS lot_status,
        MAX(l.receive_date) AS lot_receive_date,
        COUNT(DISTINCT lpc.license_plate_id) AS lp_count,
        SUM(lpc.packaged_amount) AS cases_onhand,
        COALESCE(MAX(c.cases_committed), 0) AS cases_committed,
        GREATEST(
          SUM(lpc.packaged_amount) - COALESCE(MAX(c.cases_committed), 0),
          0
        ) AS cases_available,
        MAX(ll.locations) AS locations
      FROM production_db.silver.datex_slv_licenseplatecontents lpc
      JOIN production_db.silver.datex_slv_lots l  ON lpc.lot_id = l.lot_id
      JOIN production_db.silver.datex_slv_licenseplates lp ON lpc.license_plate_id = lp.license_plate_id
      LEFT JOIN committed c ON c.lot_id = l.lot_id
      LEFT JOIN lot_locations ll ON ll.lot_id = l.lot_id
      WHERE l.material_id IN (${matIdList})
        AND lp.warehouse_id = ${warehouseId}
        AND lp.Archived = false
        AND lpc.packaged_amount > 0
      GROUP BY l.material_id, l.lot_id, l.lookup_code, l.status_name
    `
    onhandRows = await runQuery(onhandSql)
  }

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
        pack: fmtPack(r.pallet_tie, r.pallet_high, r.pack_unit_short),
        ship: [],
      })
      allocLotsByLine.set(key, new Set())
    }
    const line = linesByOrderMaterial.get(key)
    const allocLots = allocLotsByLine.get(key)
    allocLots.add(Number(r.lot_id))

    const parsed = parseLotDateKey(r.lot_code, project.dateFormat, { receiveDate: r.lot_receive_date })
    const cases = Number(r.actual_cases) > 0 ? Number(r.actual_cases) : Number(r.expected_cases) || 0
    const lps = Number(r.lp_count_actual) > 0
      ? Number(r.lp_count_actual)
      : Number(r.lp_count_planned) || 0
    const shipHeld = isHoldStatus(r.lot_status)
    line.ship.push({
      lot: r.lot_code,
      date: parsed.display,
      k: parsed.k,
      kDay: parsed.kDay,
      lps, cases,
      hold:     shipHeld,
      holdType: shipHeld ? r.lot_status : undefined,
    })
  }

  const onhandByMaterial = new Map()
  for (const r of onhandRows) {
    const mid = Number(r.material_id)
    if (!onhandByMaterial.has(mid)) onhandByMaterial.set(mid, [])
    const locInfo = classifyLocations(r.locations)
    onhandByMaterial.get(mid).push({
      lotId:    Number(r.lot_id),
      lotCode:  r.lot_code,
      status:   r.lot_status,
      receiveDate:   r.lot_receive_date,
      cases:          Number(r.cases_available) || 0,
      casesGross:     Number(r.cases_onhand) || 0,
      casesCommitted: Number(r.cases_committed) || 0,
      lps:            Number(r.lp_count) || 0,
      location:        locInfo.primary,
      locations:       locInfo.locations,
      locationBlocked: locInfo.locationBlocked,
    })
  }

  for (const [key, line] of linesByOrderMaterial.entries()) {
    const allocLots = allocLotsByLine.get(key)
    const candidates = (onhandByMaterial.get(line.materialId) || [])
      .filter(c => !allocLots.has(c.lotId))
      // Drop dismissed lots — Sadie's replacement-batch fix. dismissedSet
      // keys are `${projectId}|${lot_lookup_code}` for active dismissals.
      .filter(c => !dismissedSet || !dismissedSet.has(`${projectId}|${c.lotCode}`))
      .map(c => {
        const parsed = parseLotDateKey(c.lotCode, project.dateFormat, { receiveDate: c.receiveDate })
        return { ...c, k: parsed.k, kDay: parsed.kDay, display: parsed.display }
      })
      .filter(c => c.cases > 0)
    if (candidates.length > 0) {
      const oldest = candidates.reduce((a, b) => a.k < b.k ? a : b)
      const held = isHoldStatus(oldest.status)
      line.rem = {
        lot:      oldest.lotCode,
        date:     oldest.display,
        k:        oldest.k,
        kDay:     oldest.kDay,
        lps:      oldest.lps,
        cases:    oldest.cases,
        hold:     held,
        holdType: held ? oldest.status : undefined,
        location:        oldest.location || '',
        locations:       oldest.locations || [],
        locationBlocked: !!oldest.locationBlocked,
      }
    } else {
      line.rem = {
        lot: '', date: '', k: 0, kDay: 0, lps: 0, cases: 0,
        hold: false,
        location: '', locations: [], locationBlocked: false,
      }
    }
  }

  const nowMs = Date.now()
  const orders = []
  for (const oh of orderRows) {
    const orderId = Number(oh.order_id)
    const arrival = arrivalToDate(oh.scheduled_arrival)
    const dayOffset = dayOffsetFrom(arrival, today)
    const day = Math.max(0, Math.min(dayCount - 1, dayOffset == null ? 0 : dayOffset))
    const past = arrival ? arrival.getTime() < nowMs : false

    const orderLines = []
    for (const [, line] of linesByOrderMaterial.entries()) {
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
      appt:     fmtApptTime(oh.scheduled_arrival),
      past,
      status:   oh.status_name,
      apptStatus: oh.appt_status || null,
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

  // Pull active dismissals BEFORE the duckdb work — parallel with almost no
  // added latency because Supabase REST is fast.
  const dismissedSetPromise = loadActiveDismissals(projectIds)

  let conn, db
  const ordersByProject = {}
  const errorsByProject = {}
  const rowCountsByProject = {}
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

    const dismissedSet = await dismissedSetPromise

    for (const pid of projectIds) {
      try {
        const result = await loadOrdersForProject(runQuery, {
          projectId: pid,
          project: PROJECTS[pid],
          warehouseId, today, dateFrom, dateTo, dayCount,
          dismissedSet,
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
