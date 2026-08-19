'use strict'

// Delete-submission — manual action from the Scheduling tab's Datex
// Exceptions view (2026-08-18). Permanently removes a `submissions` row.
// Added alongside retry so Dan can clear out junk/duplicate/unrecoverable
// records (e.g. the 1000-row Stale Pending backlog) instead of only being
// able to view or retry them.
//
// No RLS policy exists on `submissions` (confirmed via
// `SELECT relrowsecurity FROM pg_class WHERE relname='submissions'` →
// false) — RLS is disabled table-wide, so this delete isn't at risk of the
// silent-no-op-with-no-error failure mode that missing DELETE policies
// normally cause on this project's other tables. Still routed through a
// Netlify function rather than direct client-side Supabase calls, to keep
// one consistent write path (matches save/approve/retry) and leave room to
// add auth/audit logging here later without a frontend change.
//
// POST { id: "<submissions uuid>" }

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

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: supabaseHeaders({ Prefer: 'return=representation' }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Supabase delete failed: HTTP ${res.status} ${text.slice(0, 200)}` }) }
    }
    const rows = await res.json().catch(() => [])
    if (!rows.length) {
      // No RLS on this table, so an empty result means the id genuinely
      // didn't match a row (already deleted, or bad id) — not a silent
      // policy block.
      return { statusCode: 404, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'No submission found with that id (may already be deleted).' }) }
    }
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, deleted: rows[0] }) }
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }
}
