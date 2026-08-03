'use strict'

// Ported from front_netlify_datex/functions/approve-submission.js (2026-08-03).
// Fast synchronous prep step: validates, applies field edits, marks the
// record 'processing'. The actual Datex push is handed off to
// scheduling-push-to-datex-background.cjs, invoked by the client immediately
// after this returns — same two-step design as the original app.
//
// Dry-run mode (DATEX_CLIENT_ID not set): calls pushToDatex synchronously
// (no real network call in dry-run) to produce a payload preview.
//
// POST /.netlify/functions/scheduling-approve-submission
// Body: { id: "<uuid>", edits?: { field: value, ... } }
//       OR (legacy): { front_conversation_id: "<string>", edits? }
//
// Returns (live):    { ok: true, id, status: 'processing' }
// Returns (dry-run): { ok: false, dry_run: true, payload: {...} }

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

  const { id, front_conversation_id, edits } = body
  const col = id ? 'id' : front_conversation_id ? 'front_conversation_id' : null
  const value = id || front_conversation_id
  if (!col) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id' }) }
  }

  // Apply any field edits first
  if (edits && Object.keys(edits).length > 0) {
    const editRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions?${col}=eq.${encodeURIComponent(value)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify(edits),
    })
    if (!editRes.ok) {
      const text = await editRes.text().catch(() => '')
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Failed to save edits: HTTP ${editRes.status} ${text.slice(0, 200)}` }) }
    }
  }

  // Fetch the full record
  const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=*&${col}=eq.${encodeURIComponent(value)}`, {
    headers: supabaseHeaders(),
  })
  if (!fetchRes.ok) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Failed to fetch record: HTTP ${fetchRes.status}` }) }
  }
  const rows = await fetchRes.json()
  const record = rows?.[0]
  if (!record) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Submission not found' }) }
  }

  // Dry-run mode: no real API key configured — call pushToDatex synchronously
  // (it returns immediately with the payload preview, no network calls made).
  if (!process.env.DATEX_CLIENT_ID) {
    const datexResult = await pushToDatex(record)
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: false, dry_run: true, payload: datexResult.payload }) }
  }

  // Mark the record as processing so the plugin can show a spinner while polling.
  const processingRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(record.id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify({ status: 'processing', datex_error: null }),
  })
  if (!processingRes.ok) {
    const text = await processingRes.text().catch(() => '')
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Failed to set processing status: HTTP ${processingRes.status} ${text.slice(0, 200)}` }) }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, id: record.id, status: 'processing' }) }
}
