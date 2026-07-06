'use strict'

// MotherDuck query proxy for appointment data — replaces Omni for the
// four appointment fetchers (hourMap, projectData, appointmentList,
// projectHourly). Fixes the "created appts don't show up for hours" lag
// that stems from Omni's gold model refresh cadence trailing MotherDuck's
// gold layer.
//
// Uses the same env/connection pattern as motherduck-labor.cjs.
//
// POST body:
//   { mode: 'hourMap' | 'projectData' | 'appointmentList' | 'projectHourly',
//     facilityId: 'cal'|'mad'|'ken'|'wr'|'ec',
//     date: 'YYYY-MM-DD',
//     projectNames?: string[]   // only for 'projectHourly'
//   }
//
// Operational day window: [date 05:00:00, nextDay 05:00:00).
// scheduled_arrival in gold.truck_appointments is already in CT (naive
// local timestamp), so a plain range filter is correct — no tz math.
//
// HOLD appointments are INCLUDED (per 2026-05-27 product decision — Kay
// cancels unused HOLDs daily as her control mechanism).
// Only 'Cancelled' status is excluded.

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

// warehouse_id map — matches production_db.gold.truck_appointments
// CAL=1, EC=3, MAD=4, KEN=5, WR=6
const WAREHOUSE_ID = {
  cal: 1,
  ec:  3,
  mad: 4,
  ken: 5,
  wr:  6,
}

function nextDayISO(date) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Escape a string for embedding in a SQL literal. duckdb-node doesn't
// support parameter binding on the .all() API surface we're using, so we
// hand-quote. All inputs are known-shape (facility ids, ISO dates,
// project names from Omni/DB), but escape defensively regardless.
function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// Direction classifier — mirrors classifyApptType in src/lib/omni.js.
// dock_appointment_type_name is one of: Inbound, Inbound/Drop, Outbound,
// Outbound/Drop (per gold catalog). Startswith is the right match here.
const DIR_CASE = `
  CASE
    WHEN LOWER(dock_appointment_type_name) LIKE 'inbound%'  THEN 'inbound'
    WHEN LOWER(dock_appointment_type_name) LIKE 'outbound%' THEN 'outbound'
    ELSE NULL
  END
`

function buildSql(mode, warehouseId, date, projectNames) {
  const nextDate = nextDayISO(date)
  const startTs  = `TIMESTAMP '${date} 05:00:00'`
  const endTs    = `TIMESTAMP '${nextDate} 05:00:00'`
  const whereBase = `
    warehouse_id = ${warehouseId}
    AND scheduled_arrival >= ${startTs}
    AND scheduled_arrival <  ${endTs}
    AND dock_status_name != 'Cancelled'
  `

  if (mode === 'hourMap') {
    return `
      SELECT
        EXTRACT(hour FROM scheduled_arrival)::INTEGER AS h,
        ${DIR_CASE} AS dir,
        COUNT(*) AS n
      FROM production_db.gold.truck_appointments
      WHERE ${whereBase}
      GROUP BY 1, 2
      HAVING dir IS NOT NULL
      ORDER BY 1
    `
  }

  if (mode === 'projectData') {
    return `
      SELECT
        COALESCE(project_name, '') AS project_name,
        ${DIR_CASE} AS dir,
        COUNT(*) AS n
      FROM production_db.gold.truck_appointments
      WHERE ${whereBase}
        AND project_name IS NOT NULL
        AND project_name != ''
      GROUP BY 1, 2
      HAVING dir IS NOT NULL
    `
  }

  if (mode === 'appointmentList') {
    return `
      SELECT
        COALESCE(lookup_code, '')                       AS lookup_code,
        COALESCE(dock_appointment_type_name, '')        AS dock_appointment_type_name,
        scheduled_arrival::VARCHAR                      AS scheduled_arrival,
        COALESCE(project_name, '')                      AS project_name,
        COALESCE(carrier_name, '')                      AS carrier_name,
        COALESCE(Notes, '')                             AS notes
      FROM production_db.gold.truck_appointments
      WHERE ${whereBase}
      ORDER BY scheduled_arrival
    `
  }

  if (mode === 'projectHourly') {
    if (!Array.isArray(projectNames) || projectNames.length === 0) {
      throw new Error('projectHourly mode requires non-empty projectNames array')
    }
    const inList = projectNames.map(sqlLit).join(', ')
    return `
      SELECT
        EXTRACT(hour FROM scheduled_arrival)::INTEGER AS h,
        ${DIR_CASE} AS dir,
        COUNT(*) AS n
      FROM production_db.gold.truck_appointments
      WHERE ${whereBase}
        AND project_name IN (${inList})
      GROUP BY 1, 2
      HAVING dir IS NOT NULL
      ORDER BY 1
    `
  }

  throw new Error(`Unknown mode: ${mode}`)
}

// ── Client-side shape transforms ─────────────────────────────────────────
// These mirror the return shapes the previous Omni implementations gave
// callers. Downstream code (FacilityPanel, ProjectList, AppointmentList,
// etc.) is unchanged and expects these exact shapes.

function toHourMap(rows) {
  const out = {}
  for (const r of rows) {
    const h = Number(r.h)
    if (!Number.isFinite(h)) continue
    if (!out[h]) out[h] = { inb: 0, out: 0 }
    const n = Number(r.n) || 0
    if (r.dir === 'inbound')  out[h].inb += n
    if (r.dir === 'outbound') out[h].out += n
  }
  return out
}

function toProjectData(rows) {
  // Return raw project × direction rows; the client normalizes names
  // (KEN Fair Oaks/Birchwood/etc merges) and aggregates. Keeps the
  // Omni-callsite parity intact — those name maps live in src/lib/omni.js.
  return rows.map(r => ({
    project_name:               String(r.project_name || ''),
    dock_appointment_type_name: r.dir === 'inbound'  ? 'Inbound'
                              : r.dir === 'outbound' ? 'Outbound'
                              : '',
    count:                      Number(r.n) || 0,
  }))
}

function toAppointmentList(rows) {
  return rows.map(r => ({
    lookup_code:                String(r.lookup_code || ''),
    dock_appointment_type_name: String(r.dock_appointment_type_name || ''),
    scheduled_arrival:          String(r.scheduled_arrival || ''),
    project_name:               String(r.project_name || ''),
    carrier_name:               String(r.carrier_name || ''),
    notes:                      String(r.notes || ''),
  }))
}

exports.handler = async (event) => {
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

  const { mode, facilityId, date, projectNames } = body
  const warehouseId = WAREHOUSE_ID[facilityId]

  if (!mode || !warehouseId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      statusCode: 400,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'Missing/invalid mode, facilityId, or date (YYYY-MM-DD)' }),
    }
  }

  let sql
  try {
    sql = buildSql(mode, warehouseId, date, projectNames)
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }

  // ── Netlify Functions requires HOME=/tmp for the duckdb native module
  // to have a writable path for its scratch dir. Same pattern as
  // motherduck-labor.cjs.
  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  try {
    const duckdb = require('duckdb')
    const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
    const conn = db.connect()

    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', (err) => err ? reject(err) : resolve())
    })

    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => err ? reject(err) : resolve(result))
    })

    conn.close()
    db.close()

    let payload
    if (mode === 'hourMap' || mode === 'projectHourly') {
      payload = { hourMap: toHourMap(rows) }
    } else if (mode === 'projectData') {
      payload = { projects: toProjectData(rows) }
    } else if (mode === 'appointmentList') {
      payload = { rows: toAppointmentList(rows) }
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify(payload),
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        error: e.message,
        stack: e.stack?.slice(0, 500),
        mode,
        facilityId,
        date,
      }),
    }
  }
}
