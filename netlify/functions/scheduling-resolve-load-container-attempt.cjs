'use strict'

// scheduling-resolve-load-container-attempt.cjs — added 2026-08-19.
// Resolves an ambiguous load_container_attempts row from the Scheduling
// Datex Exceptions page's "Load Container Timeouts" tab. Two resolutions:
//   - 'found': the container DOES exist in Datex — record its ID, mark
//     'created'. The lookupcode is now safe for a NEW appointment to
//     reference this container, but a fresh create-load-container call
//     for the same lookupcode is still (correctly) unnecessary.
//   - 'not_found': confirmed the container was NEVER created — mark
//     'failed'. This clears the block in scheduling-create-load-container.cjs,
//     so the same lookupcode can be attempted again from the Front plugin.
//
// Kept as a server function rather than a direct client-side Supabase
// write, matching this app's existing convention (see
// scheduling-delete-submission.cjs's header) of keeping writes to a single
// path per table.
//
// POST { id: "<load_container_attempts uuid>", resolution: "found" | "not_found", loadcontainer_id?: number }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

function supabaseHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { id, resolution, loadcontainer_id } = body
  if (!id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'id required' }) }
  }
  if (resolution !== 'found' && resolution !== 'not_found') {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'resolution must be "found" or "not_found"' }) }
  }
  if (resolution === 'found' && !loadcontainer_id) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'loadcontainer_id required when resolution is "found"' }) }
  }

  const updateFields =
    resolution === 'found'
      ? { status: 'created', loadcontainer_id, resolved_at: new Date().toISOString() }
      : { status: 'failed', resolved_at: new Date().toISOString() }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/load_container_attempts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(updateFields),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: `Supabase update failed: HTTP ${res.status} ${text.slice(0, 200)}` }) }
  }

  const rows = await res.json()
  const updated = rows?.[0] || null
  if (!updated) {
    return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'load_container_attempts row not found' }) }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, attempt: updated }) }
}
