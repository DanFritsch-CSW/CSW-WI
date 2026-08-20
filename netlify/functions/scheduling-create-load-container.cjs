'use strict'

// Ported from front_netlify_datex/functions/create-load-container.js (2026-08-03).
// Creates a Datex load container before scheduling a dock appointment —
// Step 1 of the Load Container tab's two-step Datex push. Reuses the shared
// Azure AD token cache from datex-push-shared.cjs instead of duplicating it.
//
// UPDATED 2026-08-19 after Dan pointed out a gap: the existing "Datex
// Exceptions" page (SchedulingTab.jsx) already tracks and gates ambiguous
// timeouts for the APPOINTMENT push step (see datex-retry-push.cjs), but
// that only covers submissions rows, which don't exist yet at THIS step —
// load container creation happens before a submissions row is ever
// created. A timeout here previously had nowhere to be recorded, so a
// person hitting the retry button in the Front plugin had no way to know
// a prior attempt might have already succeeded server-side.
//
// This now mirrors that exact safeguard pattern for load containers:
//   1. Before calling Datex, check load_container_attempts for an
//      unresolved (status='ambiguous') row for this SAME lookupcode —
//      refuse if found, exactly like datex-retry-push.cjs refuses to
//      re-push an already-confirmed submission. Forces a human to resolve
//      the prior ambiguous attempt (via the new Load Container Timeouts
//      tab) before a new attempt for that lookupcode is allowed.
//   2. On a timeout, INSERT an ambiguous attempt row before returning the
//      504 — so the outcome is tracked the moment it becomes uncertain,
//      not left to a text warning the UI doesn't actually enforce.
//   3. On success/definitive failure, log a 'created'/'failed' row too,
//      for a complete audit trail and so the Exceptions page can show
//      full context, not just the unresolved cases.
//
// POST /.netlify/functions/scheduling-create-load-container
// Body: { lookupcode: string, orderTypeId: number, priority: number, front_conversation_id?: string }
// Returns:
//   { ok: true,  loadcontainerId: number }
//   { ok: true,  loadcontainerId: null, warning: string }  — created but no ID returned (204 or empty body)
//   { ok: false, error: string, errorCode: 'lc_ambiguous_pending' } — blocked: unresolved prior attempt for this lookupcode
//   { ok: false, error: string, errorCode: 'lc_timeout' }  — timed out; container may exist in Datex — do NOT retry
//   { ok: false, error: string }                           — definitive failure; safe to retry
//   { ok: false, dry_run: true, payload: object }          — when DATEX_CLIENT_ID is not set

const { getAccessToken, DATEX_BASE_URL } = require('./lib/datex-push-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''

function supabaseHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

// Returns the unresolved ambiguous attempt row for this lookupcode, or
// null. Never throws — if Supabase is unreachable, we fail OPEN (allow the
// attempt) rather than blocking legitimate work because the tracking
// table itself is down.
async function findUnresolvedAmbiguousAttempt(lookupcode) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/load_container_attempts?lookupcode=eq.${encodeURIComponent(lookupcode)}&status=eq.ambiguous&select=*&order=created_at.desc&limit=1`,
      { headers: supabaseHeaders() }
    )
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] || null
  } catch {
    return null
  }
}

// Logs an attempt outcome. Never throws — logging failures shouldn't mask
// or replace the real Datex result being returned to the caller.
async function logAttempt(fields) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/load_container_attempts`, {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(fields),
    })
  } catch (err) {
    console.warn('[scheduling-create-load-container] failed to log attempt (non-fatal):', err.message)
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }
  }

  const { lookupcode, orderTypeId, priority, front_conversation_id } = body
  if (!lookupcode) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Missing lookupcode' }) }
  }

  // Refuse if a prior attempt for this exact lookupcode is still
  // unresolved — same reasoning as datex-retry-push.cjs's duplicate-ID
  // check: we genuinely don't know if Datex already created this
  // container, so creating another one risks a duplicate. A human needs
  // to resolve the prior attempt first (Load Container Timeouts tab).
  const pending = await findUnresolvedAmbiguousAttempt(lookupcode)
  if (pending) {
    return {
      statusCode: 409,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        errorCode: 'lc_ambiguous_pending',
        error: `A previous attempt to create "${lookupcode}" timed out and hasn't been resolved yet (${new Date(pending.created_at).toLocaleString()}). Check Datex and resolve it on the Scheduling Datex Exceptions page before trying again — retrying now risks creating a duplicate.`,
      }),
    }
  }

  // Dry-run mode: no API key — return payload preview without calling Datex
  if (!process.env.DATEX_CLIENT_ID) {
    const payload = { lookupcode, orderTypeId, priority }
    console.log('[scheduling-create-load-container] DRY RUN — payload that would be sent:', JSON.stringify(payload))
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: false, dry_run: true, payload }) }
  }

  let bearerToken
  try {
    bearerToken = await getAccessToken()
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ ok: false, error: `Auth failed: ${err.message}` }) }
  }

  // ── Datex call — NO retry on timeout ─────────────────────────────────────
  // If the request times out, Datex likely already created the container
  // server-side. Retrying would create a duplicate LC that can never
  // associate with the appointment. Only non-abort network errors (request
  // never reached Datex) get one retry.
  let response
  let lastErr

  for (let attempt = 1; attempt <= 2; attempt++) {
    const datexAbort = new AbortController()
    const datexTimeout = setTimeout(() => datexAbort.abort(), 11_000)
    try {
      response = await fetch(`${DATEX_BASE_URL}/api/loadcontainers/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearerToken}` },
        body: JSON.stringify({ lookupcode, orderTypeId, priority }),
        signal: datexAbort.signal,
      })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      console.warn(`[scheduling-create-load-container] attempt ${attempt} failed: ${err.message}`)

      if (err.name === 'AbortError') {
        clearTimeout(datexTimeout)
        await logAttempt({
          lookupcode,
          order_type_id: orderTypeId,
          priority,
          status: 'ambiguous',
          error: 'Request timed out after 11s — outcome in Datex unknown.',
          front_conversation_id: front_conversation_id || null,
        })
        return {
          statusCode: 504,
          headers: HEADERS,
          body: JSON.stringify({
            ok: false,
            errorCode: 'lc_timeout',
            error: 'Load container creation timed out — the container may have already been created in Datex. Do not retry. This attempt has been logged on the Scheduling Datex Exceptions page — verify in Datex and resolve it there before trying again.',
          }),
        }
      }
    } finally {
      clearTimeout(datexTimeout)
    }
  }

  if (lastErr) {
    await logAttempt({
      lookupcode,
      order_type_id: orderTypeId,
      priority,
      status: 'failed',
      error: `Network error contacting Datex: ${lastErr.message}`,
      front_conversation_id: front_conversation_id || null,
      resolved_at: new Date().toISOString(),
    })
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: `Network error contacting Datex: ${lastErr.message}` }) }
  }

  // 204 No Content — container created but no body to parse an ID from.
  if (response.status === 204) {
    console.warn('[scheduling-create-load-container] Datex returned 204 — container created but no ID in response')
    await logAttempt({
      lookupcode,
      order_type_id: orderTypeId,
      priority,
      status: 'created',
      error: 'Created but Datex returned 204 — no ID in response.',
      front_conversation_id: front_conversation_id || null,
      resolved_at: new Date().toISOString(),
    })
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, loadcontainerId: null, warning: 'Load container created but no ID returned — verify in Datex and link the appointment manually if needed.' }),
    }
  }

  const text = await response.text().catch(() => '')
  let responseBody
  try {
    responseBody = JSON.parse(text)
  } catch {
    await logAttempt({
      lookupcode,
      order_type_id: orderTypeId,
      priority,
      status: 'failed',
      error: `Datex returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      front_conversation_id: front_conversation_id || null,
      resolved_at: new Date().toISOString(),
    })
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: `Datex returned HTTP ${response.status}: ${text.slice(0, 300)}` }) }
  }

  if (!response.ok) {
    const reason = responseBody?.reason || responseBody?.detail || responseBody?.message || JSON.stringify(responseBody)
    await logAttempt({
      lookupcode,
      order_type_id: orderTypeId,
      priority,
      status: 'failed',
      error: `Datex error (${response.status}): ${reason}`,
      front_conversation_id: front_conversation_id || null,
      resolved_at: new Date().toISOString(),
    })
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: `Datex error (${response.status}): ${reason}` }) }
  }

  // Datex may return the ID under several field names — try all known variants.
  const loadcontainerId =
    responseBody.loadcontainerId ??
    responseBody.loadContainerId ??
    responseBody.id ??
    responseBody.loadcontainerid ??
    null

  if (!loadcontainerId) {
    console.warn('[scheduling-create-load-container] No ID in Datex response:', JSON.stringify(responseBody))
    await logAttempt({
      lookupcode,
      order_type_id: orderTypeId,
      priority,
      status: 'created',
      error: 'Created but no ID found in Datex response.',
      front_conversation_id: front_conversation_id || null,
      resolved_at: new Date().toISOString(),
    })
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, loadcontainerId: null, warning: 'Load container created but no ID returned — verify in Datex and link the appointment manually if needed.' }),
    }
  }

  await logAttempt({
    lookupcode,
    order_type_id: orderTypeId,
    priority,
    status: 'created',
    loadcontainer_id: loadcontainerId,
    front_conversation_id: front_conversation_id || null,
    resolved_at: new Date().toISOString(),
  })

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, loadcontainerId }) }
}
