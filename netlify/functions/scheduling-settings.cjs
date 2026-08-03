'use strict'

// Ported from front_netlify_datex/functions/settings.js (2026-08-03). Raw
// REST fetch, matching this repo's convention. Note: this reads/writes the
// same `settings` key/value table already used by datex-push-shared.cjs for
// the 'azure_token_cache' key — no conflict, just be aware it's shared.
//
// GET  /.netlify/functions/scheduling-settings?key=abbreviations → { value: [...] | null }
// POST /.netlify/functions/scheduling-settings  body: { key, value } → { ok: true }

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
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  if (event.httpMethod === 'GET') {
    const key = event.queryStringParameters?.key
    if (!key) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing key' }) }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/settings?select=value&key=eq.${encodeURIComponent(key)}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: `Supabase HTTP ${res.status}: ${text.slice(0, 300)}` }) }
      }
      const rows = await res.json()
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ value: rows?.[0]?.value ?? null }) }
    } catch (err) {
      return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
    }
  }

  if (event.httpMethod === 'POST') {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }
    }

    const { key, value } = body
    if (!key) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing key' }) }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
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

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) }
}
