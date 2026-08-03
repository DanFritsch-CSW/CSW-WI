'use strict'

// Retry-push-to-Datex — manual action from the Scheduling tab's Datex
// Exceptions view (2026-08-03). Re-attempts the Datex FootPrint push for a
// single `submissions` row that's stuck (failed / stuck-processing /
// approved-but-unconfirmed).
//
// Single attempt per click — this is a human watching the result, not an
// automated retry loop, so this deliberately skips the original scheduling
// app's 3-attempt backoff (push-to-datex-background.js). If it fails again,
// the person can just click again after reading the error.
//
// Refuses to push if:
//   - The record is already confirmed approved (datex_appointment_id set) —
//     that's not "stuck", it's done, and retrying would create a duplicate
//     appointment in Datex.
//   - Required fields were never resolved (owner/project/dock door/carrier/
//     scheduled_arrival) — those rows never finished the plugin's approval
//     flow, so pushing anyway would send nulls to Datex.
//
// POST { id: "<submissions uuid>" }

const { pushToDatex, missingRequiredFields } = require('./lib/datex-push-shared.cjs')

const NO_CACHE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

function supabaseHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function fetchSubmission(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: supabaseHeaders(),
  })
  if (!res.ok) throw new Error(`Supabase fetch failed: HTTP ${res.status}`)
  const rows = await res.json()
  return rows?.[0] || null
}

async function updateSubmission(id, fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(fields),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase update failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  const rows = await res.json()
  return rows?.[0] || null
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { id } = body
  if (!id) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'id required' }) }
  }

  let record
  try {
    record = await fetchSubmission(id)
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }
  if (!record) {
    return { statusCode: 404, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Submission not found' }) }
  }

  if (record.status === 'approved' && record.datex_appointment_id != null) {
    return {
      statusCode: 409,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: 'Already confirmed approved with a Datex appointment ID — refusing to retry to avoid creating a duplicate.' }),
    }
  }

  const missing = missingRequiredFields(record)
  if (missing.length) {
    return {
      statusCode: 422,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({ error: `Cannot push — missing: ${missing.join(', ')}. This record never finished the approval flow in the scheduling plugin.` }),
    }
  }

  await updateSubmission(id, { status: 'processing' }).catch(() => {})

  let result
  try {
    result = await pushToDatex(record)
  } catch (err) {
    result = { success: false, error: err.message }
  }

  if (result.dry_run) {
    const updated = await updateSubmission(id, {
      status: 'failed',
      datex_error: 'DATEX_CLIENT_ID not configured on this site — dry run only, no push attempted. Add the Datex Azure AD env vars to enable live pushes.',
    })
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ dry_run: true, payload: result.payload, submission: updated }) }
  }

  if (result.success) {
    const updateFields = {
      status: 'approved',
      datex_pushed_at: new Date().toISOString(),
      datex_error: result.warning || null,
    }
    if (result.datex_appointment_id != null) updateFields.datex_appointment_id = result.datex_appointment_id
    const updated = await updateSubmission(id, updateFields)
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, submission: updated }) }
  }

  if (result.ambiguous) {
    // Timeout — Datex may have already committed the appointment. Mark
    // approved-with-warning rather than failed, matching the original
    // scheduling app's ambiguous-timeout handling, so it doesn't get
    // blindly retried into a duplicate.
    const updated = await updateSubmission(id, { status: 'approved', datex_error: result.error })
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, ambiguous: true, submission: updated }) }
  }

  const updated = await updateSubmission(id, { status: 'failed', datex_error: result.error })
  return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: false, submission: updated, error: result.error }) }
}
