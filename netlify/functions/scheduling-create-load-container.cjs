'use strict'

// Ported from front_netlify_datex/functions/create-load-container.js (2026-08-03).
// Creates a Datex load container before scheduling a dock appointment —
// Step 1 of the Load Container tab's two-step Datex push. Reuses the shared
// Azure AD token cache from datex-push-shared.cjs instead of duplicating it.
//
// POST /.netlify/functions/scheduling-create-load-container
// Body: { lookupcode: string, orderTypeId: number, priority: number }
// Returns:
//   { ok: true,  loadcontainerId: number }
//   { ok: true,  loadcontainerId: null, warning: string }  — created but no ID returned (204 or empty body)
//   { ok: false, error: string, errorCode: 'lc_timeout' }  — timed out; container may exist in Datex — do NOT retry
//   { ok: false, error: string }                           — definitive failure; safe to retry
//   { ok: false, dry_run: true, payload: object }          — when DATEX_CLIENT_ID is not set

const { getAccessToken, DATEX_BASE_URL } = require('./lib/datex-push-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

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

  const { lookupcode, orderTypeId, priority } = body
  if (!lookupcode) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Missing lookupcode' }) }
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
        return {
          statusCode: 504,
          headers: HEADERS,
          body: JSON.stringify({
            ok: false,
            errorCode: 'lc_timeout',
            error: 'Load container creation timed out — the container may have already been created in Datex. Do not retry. Verify in Datex before proceeding with the appointment.',
          }),
        }
      }
    } finally {
      clearTimeout(datexTimeout)
    }
  }

  if (lastErr) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: `Network error contacting Datex: ${lastErr.message}` }) }
  }

  // 204 No Content — container created but no body to parse an ID from.
  if (response.status === 204) {
    console.warn('[scheduling-create-load-container] Datex returned 204 — container created but no ID in response')
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
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ ok: false, error: `Datex returned HTTP ${response.status}: ${text.slice(0, 300)}` }) }
  }

  if (!response.ok) {
    const reason = responseBody?.reason || responseBody?.detail || responseBody?.message || JSON.stringify(responseBody)
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
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, loadcontainerId: null, warning: 'Load container created but no ID returned — verify in Datex and link the appointment manually if needed.' }),
    }
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, loadcontainerId }) }
}
