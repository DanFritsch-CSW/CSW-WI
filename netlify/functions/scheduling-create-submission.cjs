'use strict'

// Ported from front_netlify_datex/functions/create-submission.js (2026-08-03).
// Raw REST fetch instead of @supabase/supabase-js, matching this repo's
// netlify/functions convention (no Supabase SDK dependency here).
//
// POST /.netlify/functions/scheduling-create-submission
// Body: { front_conversation_id?: string, fields: { warehouse, type, ... } }
// Returns: the full inserted record

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

  const { front_conversation_id, fields } = body
  if (!fields || !Object.keys(fields).length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing fields' }) }
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        ...fields,
        front_conversation_id: front_conversation_id || null,
        status: 'pending',
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Supabase HTTP ${res.status}: ${text.slice(0, 300)}` }) }
    }

    const rows = await res.json()
    const data = rows?.[0]

    if (!data?.id) {
      const cols = data ? Object.keys(data).join(', ') : 'data_is_null'
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `no_id columns_returned:[${cols}]` }) }
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
