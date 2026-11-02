'use strict'

// Appointment check-in status lookup -- ADDED 2026-11-02 for the late-eta-nudge Supabase Edge
// Function (late-carrier ETA drafts). Supabase Edge Functions cannot load the native duckdb
// module, so MotherDuck is read here. Narrow on purpose: takes Datex appointment ids (that the
// scheduling agent created) and returns only status + check-in time, nothing else.
//
// Data lag: gold.truck_appointments trails Datex by ~20-30 min (accepted by Dan).
// Check-in signal: dock_status_name = 'Open' AND checked_in_on IS NULL means not checked in.
// 'Cancelled' also has a null checked_in_on, so callers must treat it as NOT late.
//
// POST body: { appointmentIds: number[] }   (max 200)
// Response:  { count, appointments: [{ appointmentId, scheduledArrival, checkedInOn, statusName, warehouseName }] }

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'MOTHERDUCK_TOKEN not configured' }) }
  }
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }
  const ids = [...new Set((Array.isArray(body.appointmentIds) ? body.appointmentIds : [])
    .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200)
  if (!ids.length) {
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ count: 0, appointments: [] }) }
  }

  const sql = `
    SELECT appointment_id, scheduled_arrival, checked_in_on, dock_status_name, warehouse_name
    FROM production_db.gold.truck_appointments
    WHERE appointment_id IN (${ids.join(', ')})
  `

  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN
  try {
    const duckdb = require('duckdb')
    const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
    const conn = db.connect()
    await new Promise((resolve, reject) => conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve())))
    const rows = await new Promise((resolve, reject) => conn.all(sql, (err, result) => (err ? reject(err) : resolve(result))))
    conn.close()
    db.close()

    // Timestamps are naive local (Central) wall-clock values; emit them as plain strings
    // (no Z conversion) so the caller compares like-for-like with submissions.scheduled_arrival.
    const fmt = (v) => {
      if (!v) return null
      const d = v instanceof Date ? v : new Date(v)
      if (Number.isNaN(d.getTime())) return String(v)
      return d.toISOString().slice(0, 19)
    }
    const appointments = rows.map((r) => ({
      appointmentId: Number(r.appointment_id),
      scheduledArrival: fmt(r.scheduled_arrival),
      checkedInOn: fmt(r.checked_in_on),
      statusName: String(r.dock_status_name || ''),
      warehouseName: String(r.warehouse_name || ''),
    }))
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ count: appointments.length, appointments }) }
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }
}
