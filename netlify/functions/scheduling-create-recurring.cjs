'use strict'

// Ported from front_netlify_datex/functions/create-recurring.js (2026-08-03).
// Creates multiple recurring dock appointments — one Supabase record + Datex
// push per occurrence. Reuses datex-push-shared.cjs for the actual push.
//
// POST /.netlify/functions/scheduling-create-recurring
// Body: {
//   fields: { warehouse, carrier, carrier_datex_id, type, owner, owner_datex_id,
//             project, project_datex_id, scheduled_dock_door, dock_door_datex_id,
//             reference_number, appointment_lookup_code, notes },
//   start_datetime: "<ISO string>",
//   recurrence: { frequency: 'daily' | 'weekly' | 'monthly', occurrences: <1-52> }
// }
// Returns: { results: [{ id, scheduled_arrival, success, datex_appointment_id?, dry_run?, error? }] }

const { pushToDatex } = require('./lib/datex-push-shared.cjs')

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const HEADERS = { 'Content-Type': 'application/json' }

function supabaseHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

// ── Date helpers ─────────────────────────────────────────────────────────────

// Add months to a date, clamping to the last valid day of the target month.
// e.g. Jan 31 + 1 month → Feb 28/29 (not Mar 2).
function addMonths(date, months) {
  const d = new Date(date)
  const day = d.getUTCDate()
  d.setUTCMonth(d.getUTCMonth() + months)
  if (d.getUTCDate() < day) d.setUTCDate(0)
  return d
}

function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function generateDates(startIso, frequency, occurrences) {
  const start = new Date(startIso)
  const dates = []
  if (frequency === 'daily') {
    let d = new Date(start)
    while (dates.length < occurrences) {
      const day = d.getUTCDay()
      if (day !== 0 && day !== 6) dates.push(toDatetimeLocal(d))
      d = new Date(d)
      d.setUTCDate(d.getUTCDate() + 1)
    }
  } else {
    for (let i = 0; i < occurrences; i++) {
      let d
      if (frequency === 'weekly') {
        d = new Date(start)
        d.setUTCDate(d.getUTCDate() + i * 7)
      } else {
        d = addMonths(start, i)
      }
      dates.push(toDatetimeLocal(d))
    }
  }
  return dates
}

// Build a clean row object with only known Supabase columns.
function buildRow(fields, scheduled_arrival) {
  return {
    warehouse: fields.warehouse || null,
    carrier: fields.carrier || null,
    carrier_datex_id: fields.carrier_datex_id ?? null,
    type: fields.type || null,
    owner: fields.owner || null,
    owner_datex_id: fields.owner_datex_id ?? null,
    project: fields.project || null,
    project_datex_id: fields.project_datex_id ?? null,
    scheduled_dock_door: fields.scheduled_dock_door || null,
    dock_door_datex_id: fields.dock_door_datex_id ?? null,
    reference_number: fields.reference_number || null,
    appointment_lookup_code: fields.appointment_lookup_code || null,
    notes: fields.notes || null,
    scheduled_arrival,
    front_conversation_id: null,
    status: 'pending',
  }
}

async function insertSubmission(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Insert failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  const rows = await res.json()
  return rows?.[0]
}

async function updateSubmission(id, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(fields),
  }).catch(() => {})
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const { fields, start_datetime, recurrence } = body

  if (!fields || !start_datetime || !recurrence) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields, start_datetime, or recurrence' }) }
  }

  const { frequency, occurrences } = recurrence

  if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid frequency' }) }
  }
  if (!occurrences || occurrences < 1 || occurrences > 52) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'occurrences must be 1-52' }) }
  }

  const dates = generateDates(start_datetime, frequency, occurrences)

  // Step 1: Insert all Supabase records in parallel
  const insertResults = await Promise.allSettled(dates.map((scheduled_arrival) => insertSubmission(buildRow(fields, scheduled_arrival))))

  // Step 2: Push to Datex in parallel for successful inserts
  const datexResults = await Promise.allSettled(
    insertResults.map(async (ins, i) => {
      const scheduled_arrival = dates[i]

      if (ins.status === 'rejected') {
        return { scheduled_arrival, success: false, error: ins.reason?.message ?? 'Insert failed' }
      }
      const record = ins.value
      if (!record?.id) {
        return { scheduled_arrival, success: false, error: 'Insert returned no record' }
      }

      let datexResult
      try {
        datexResult = await pushToDatex(record)
      } catch (err) {
        await updateSubmission(record.id, { status: 'failed', datex_error: err.message })
        return { id: record.id, scheduled_arrival, success: false, error: err.message }
      }

      if (datexResult.dry_run) {
        return { id: record.id, scheduled_arrival, success: false, dry_run: true, payload: datexResult.payload }
      }

      if (!datexResult.success) {
        const errMsg = datexResult.error || 'Unknown Datex error'
        await updateSubmission(record.id, { status: 'failed', datex_error: errMsg })
        return { id: record.id, scheduled_arrival, success: false, error: errMsg }
      }

      const approveFields = { status: 'approved', datex_pushed_at: new Date().toISOString(), datex_error: null }
      if (datexResult.datex_appointment_id != null) approveFields.datex_appointment_id = datexResult.datex_appointment_id
      await updateSubmission(record.id, approveFields)

      return {
        id: record.id,
        scheduled_arrival,
        success: true,
        datex_appointment_id: datexResult.datex_appointment_id ?? null,
        ...(datexResult.warning ? { warning: datexResult.warning } : {}),
      }
    })
  )

  const results = datexResults.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { scheduled_arrival: dates[i], success: false, error: r.reason?.message ?? 'Unexpected error' }
  )

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ results }) }
}
