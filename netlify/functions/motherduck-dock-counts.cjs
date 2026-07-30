'use strict'

// Madison Dock Counts backend. Added 2026-07-30, per Dan's ops manager's
// manual message format:
//   "Looking ahead to tomorrow, Dock 8 has 21 inbound and 7 outbound
//   loads. East has 3 inbound and 1 outbound, while West has 4 inbound
//   and 9 outbound."
//
// ── Counting method — confirmed live against Dan's own example numbers,
// not guessed ────────────────────────────────────────────────────────────
// gold.truck_appointments has both a real appointment TYPE
// (dock_appointment_type_name: Inbound/Outbound/Inbound-Drop/Outbound-Drop)
// and a scheduled dock/location (location_container_name, e.g.
// " .East Dock -- Inbound", " .West Dock -- Outbound", " .Dock 8 --
// Inbounds"). These two don't always agree — a handful of West Dock loads
// are scheduled at " .West Dock -- Inbound" but carry an Outbound
// appointment type. Verified against Dan's East (3/1) and West (4/9)
// example counts: they only reproduce exactly when counting by the DOCK'S
// OWN location-name suffix (whichever slot the load is scheduled at),
// not by the appointment's own type field. So this counts by location
// name, exactly matching what the ops manager counts by hand walking the
// dock schedule.
//
// dock label extraction: strip the leading " ." and match on "Dock 8" /
// "East" / "West" (case-insensitive substring). Anything that doesn't
// match one of those three buckets is surfaced under "other" rather than
// silently dropped, in case a 4th dock/location naming shows up later
// (same defensive pattern as the F6/F7 Datex-naming-inconsistency lesson
// elsewhere on this project).
//
// Excludes Cancelled appointments (dock_status_name != 'Cancelled'),
// same convention as every other appointment-count query on this project.
//
// POST body: { date: 'YYYY-MM-DD' } (required — no default; the digest
// and the on-demand UI both pass an explicit date, usually tomorrow).

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

const WAREHOUSE_NAME = 'CSW-Madison'

function classifyDock(locationName) {
  const n = (locationName || '').toUpperCase()
  if (n.includes('DOCK 8')) return 'dock8'
  if (n.includes('EAST')) return 'east'
  if (n.includes('WEST')) return 'west'
  return 'other'
}

function classifyDirection(locationName) {
  const n = (locationName || '').toUpperCase()
  if (n.includes('INBOUND')) return 'in'
  if (n.includes('OUTBOUND')) return 'out'
  return 'other'
}

exports.handler = async (event) => {
  const t0 = Date.now()
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  let date
  try {
    const body = JSON.parse(event.body || '{}')
    date = body.date
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '{date: "YYYY-MM-DD"} is required' }) }
  }

  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
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

    const sql = `
      SELECT location_container_name, COUNT(*) AS loads
      FROM production_db.gold.truck_appointments
      WHERE warehouse_name = '${WAREHOUSE_NAME}'
        AND scheduled_arrival::DATE = DATE '${date}'
        AND dock_status_name != 'Cancelled'
      GROUP BY 1
    `
    const rows = await runQuery(sql)
    try { conn.close(); db.close() } catch (_) {}

    const docks = {
      dock8: { in: 0, out: 0 },
      east: { in: 0, out: 0 },
      west: { in: 0, out: 0 },
      other: { in: 0, out: 0 },
    }
    const otherLocations = []
    for (const r of rows) {
      const dock = classifyDock(r.location_container_name)
      const dir = classifyDirection(r.location_container_name)
      const n = Number(r.loads) || 0
      if (dir === 'in') docks[dock].in += n
      else if (dir === 'out') docks[dock].out += n
      else { docks[dock].in += n } // unclassified direction — count conservatively, flag via otherLocations
      if (dock === 'other' || dir === 'other') otherLocations.push({ locationName: r.location_container_name, loads: n })
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ date, docks, otherLocations, fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - t0 }),
    }
  } catch (e) {
    try { conn?.close(); db?.close() } catch (_) {}
    return {
      statusCode: 502,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500), elapsedMs: Date.now() - t0 }),
    }
  }
}
