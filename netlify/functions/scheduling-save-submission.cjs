'use strict'

// Ported from front_netlify_datex/functions/save-submission.js (2026-08-03).
// Raw REST fetch, matching this repo's netlify/functions convention.
//
// POST /.netlify/functions/scheduling-save-submission
// Body: { id: "<uuid>", edits: { field: value, ... } }
//       OR (legacy): { front_conversation_id: "<string>", edits: ... }

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

  // Accept either identifier; prefer UUID id
  const col = id ? 'id' : front_conversation_id ? 'front_conversation_id' : null
  const value = id || front_conversation_id
  if (!col) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id' }) }
  }
  if (!edits || !Object.keys(edits).length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing edits' }) }
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?${col}=eq.${encodeURIComponent(value)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(edits),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Supabase HTTP ${res.status}: ${text.slice(0, 300)}` }) }
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
