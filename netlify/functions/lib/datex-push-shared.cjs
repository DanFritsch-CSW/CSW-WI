'use strict'

// Shared Datex FootPrint API pusher — ported into CSW-WI from the standalone
// scheduling app (DanFritsch-CSW/front_netlify_datex, scripts/datex-push.js)
// as part of the Datex Exceptions view (2026-08-03, Dan's ask: visibility +
// retry for carrier appointments stuck in limbo between Front and Datex).
//
// Auth is Azure AD client-credentials flow, NOT a static bearer key — the
// original repo's README undersold this (it documents DATEX_API_KEY as a
// simple bearer token); the actual implementation has always used Azure AD.
// This port follows the real code, not the stale doc.
//
// Required env vars (copy values from the front_netlify_datex Netlify site):
//   DATEX_BASE_URL      (optional — defaults to the value below)
//   DATEX_TENANT_ID
//   DATEX_CLIENT_ID
//   DATEX_CLIENT_SECRET
//   DATEX_SCOPE
//   DATEX_USER           (optional — defaults to 'csw-scheduling')
//
// Token caching: same two-layer strategy as the original (module-level for
// warm instances, Supabase `settings` table for cold starts), but using raw
// REST fetch against Supabase instead of @supabase/supabase-js — this repo's
// netlify/functions folder has no Supabase SDK dependency (see
// fefo-dismissals.cjs), so this stays consistent rather than adding one.

const DATEX_BASE_URL = process.env.DATEX_BASE_URL || 'https://csw-footprint-api.wavelength.host'

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

// ── Azure AD token cache ────────────────────────────────────────────────────

let _tokenCache = null

async function _readSupabaseToken() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/settings?select=value&key=eq.azure_token_cache`,
      { headers: supabaseHeaders() }
    )
    if (!res.ok) return null
    const rows = await res.json()
    const cached = rows?.[0]?.value
    if (!cached || typeof cached.token !== 'string' || typeof cached.expiresAt !== 'number') return null
    return cached
  } catch {
    return null // Supabase unavailable — fall through to Azure AD
  }
}

async function _writeSupabaseToken(token, expiresAt) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({
        key: 'azure_token_cache',
        value: { token, expiresAt },
        updated_at: new Date().toISOString(),
      }),
    })
  } catch {
    // Non-fatal — module-level cache still works for this instance
  }
}

async function getAccessToken() {
  const now = Date.now()
  const minRemaining = 10 * 60 * 1000 // 10-minute safety margin

  if (_tokenCache && _tokenCache.expiresAt > now + minRemaining) {
    return _tokenCache.token
  }

  const cached = await _readSupabaseToken()
  if (cached && cached.expiresAt > now + minRemaining) {
    _tokenCache = cached
    return cached.token
  }

  const { DATEX_TENANT_ID, DATEX_CLIENT_ID, DATEX_CLIENT_SECRET, DATEX_SCOPE } = process.env
  if (!DATEX_TENANT_ID || !DATEX_CLIENT_ID || !DATEX_CLIENT_SECRET || !DATEX_SCOPE) {
    throw new Error('Datex Azure AD env vars not configured (DATEX_TENANT_ID / DATEX_CLIENT_ID / DATEX_CLIENT_SECRET / DATEX_SCOPE)')
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: DATEX_CLIENT_ID,
    client_secret: DATEX_CLIENT_SECRET,
    scope: DATEX_SCOPE,
  })

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 30_000)
  let res
  try {
    res = await fetch(`https://login.microsoftonline.com/${DATEX_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: abort.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Azure token fetch failed (${res.status}): ${text.slice(0, 300)}`)
  }

  const json = await res.json()
  if (!json.access_token) throw new Error('Azure token response missing access_token')

  const expiresIn = json.expires_in || 3600
  const expiresAt = now + expiresIn * 1000
  _tokenCache = { token: json.access_token, expiresAt }
  _writeSupabaseToken(json.access_token, expiresAt) // fire-and-forget

  return _tokenCache.token
}

// ── Static ID maps ──────────────────────────────────────────────────────────

const WAREHOUSE_IDS = {
  'CSW-Franksville':      1,
  'CSW-Eau Claire':       3,
  'CSW-Madison':          4,
  'CSW-Kenosha':          5,
  'CSW-Wisconsin Rapids': 6,
}

const APPOINTMENT_TYPE_IDS = {
  'Inbound':          1,
  'Outbound':         2,
  'Inbound/Drop':     3,
  'Inbound/Work-In':  4,
  'Inbound/Lump':     5,
  'Outbound/Lump':    6,
  'Outbound/Drop':    7,
  'Outbound/Work-In': 8,
  'Outbound/Reload':  9,
  'Inbound/Reload':  14,
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function toIso(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function arrivalPlusDuration(arrivalIso, durationMinutes) {
  if (!arrivalIso) return null
  const d = new Date(arrivalIso)
  if (isNaN(d.getTime())) return null
  const mins = parseInt(durationMinutes, 10)
  const offset = (!isNaN(mins) && mins > 0) ? mins : 30
  return new Date(d.getTime() + offset * 60 * 1000).toISOString()
}

// missingRequiredFields — fields that must already be resolved (set by the
// agent during the original plugin approval flow) before a push is
// attempted. A record missing any of these never finished that flow, so
// pushing anyway would send nulls to Datex and likely create a broken
// appointment. Callers should check this BEFORE calling pushToDatex and
// surface it distinctly from a real Datex API error.
function missingRequiredFields(record) {
  const missing = []
  if (!record.warehouse || !WAREHOUSE_IDS[record.warehouse]) missing.push('warehouse')
  if (!record.type || !APPOINTMENT_TYPE_IDS[record.type]) missing.push('type')
  if (record.owner_datex_id == null) missing.push('owner')
  if (record.project_datex_id == null) missing.push('project')
  if (record.dock_door_datex_id == null) missing.push('dock door')
  if (record.carrier_datex_id == null) missing.push('carrier')
  if (!record.scheduled_arrival || !toIso(record.scheduled_arrival)) missing.push('scheduled_arrival')
  return missing
}

// ── Main export ───────────────────────────────────────────────────────────────

async function pushToDatex(record) {
  const dryRun = !process.env.DATEX_CLIENT_ID

  const payload = {
    lookupcode:           record.appointment_lookup_code || null,
    reference_number:     record.reference_number       || null,
    notes:                record.notes                  || null,
    scheduled_arrival:    toIso(record.scheduled_arrival),
    scheduled_departure:  arrivalPlusDuration(toIso(record.scheduled_arrival), record.appt_duration),
    user:                 process.env.DATEX_USER        || 'csw-scheduling',

    warehouse_id:         WAREHOUSE_IDS[record.warehouse]    ?? null,
    appointment_type_id:  APPOINTMENT_TYPE_IDS[record.type]  ?? null,

    scheduled_owner_id:   record.owner_datex_id    ?? null,
    scheduled_project_id: record.project_datex_id  ?? null,
    dock_door_id:         record.dock_door_datex_id ?? null,
    carrier_id:           record.carrier_datex_id  ?? null,

    order_ids:             [],
    load_container_id:     record.load_container_id ?? null,
    shipment_id:           null,
    shipping_container_id: null,
    id:                    null,
  }

  if (dryRun) {
    return { success: false, dry_run: true, payload }
  }

  let bearerToken
  try {
    bearerToken = await getAccessToken()
  } catch (err) {
    return { success: false, error: `Auth failed: ${err.message}` }
  }

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 60_000)
  let response
  try {
    response = await fetch(`${DATEX_BASE_URL}/api/dock_appointments/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload),
      signal: abort.signal,
    })
  } catch (err) {
    const isTimeout = err.name === 'AbortError'
    const msg = isTimeout
      ? 'Datex request timed out (60s) — appointment may have been created. Verify in Datex before retrying again.'
      : `Network error contacting Datex: ${err.message}`
    return { success: false, ambiguous: isTimeout, error: msg }
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 204) {
    return { success: true }
  }

  const text = await response.text().catch(() => '')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    if (text.toLowerCase().includes('inactivity timeout')) {
      _tokenCache = null
      _writeSupabaseToken('', 0)
      return { success: true, warning: 'Datex session timed out after submission. The appointment was likely created — verify in Datex.' }
    }
    return { success: false, error: `Datex returned HTTP ${response.status}: ${text.slice(0, 300)}` }
  }

  if (!response.ok) {
    const reason = body?.reason || body?.detail || body?.message || JSON.stringify(body)
    return { success: false, error: `Datex error (${response.status}): ${reason}` }
  }

  return { success: true, datex_appointment_id: body.dock_appointment_id ?? null }
}

module.exports = { pushToDatex, missingRequiredFields, WAREHOUSE_IDS, APPOINTMENT_TYPE_IDS }
