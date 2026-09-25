'use strict'

// A16 -- DPI Monthly final push: creates a real Datex load container + dock
// appointment for ONE route, called once per scheduled route from
// Phase5FinalPush.jsx. Reuses the same building blocks already proven out
// for the Scheduling plugin rather than building a parallel implementation:
//   - Step 1 (load container): proxies through the EXISTING
//     scheduling-create-load-container.cjs endpoint (same
//     load_container_attempts ambiguous-timeout tracking, same no-retry-
//     on-timeout safety), rather than duplicating that logic here.
//   - Step 2 (appointment): calls pushToDatex directly from
//     datex-push-shared.cjs -- the Scheduling plugin's own appointment-push
//     wrapper (scheduling-push-to-datex-background.cjs) is tightly coupled
//     to its own `submissions` table and Front-reply flow, which doesn't
//     apply here, so this calls the shared library function directly
//     instead of going through that wrapper.
//
// Facility config (carrier/owner/project/dock door) is hardcoded per
// facility below -- confirmed live against production_db.gold.
// truck_appointments' real DPI outbound history for both facilities'
// carrier/owner/project IDs and EC's dock door. Madison's dock door is
// Dan's explicit choice (".East Dock -- Outbound", id 43394) -- the real
// historical pattern actually used a DIFFERENT door (Door 01-, 175 real
// uses vs. 4 for this one, none of them DPI) -- see the DPI Monthly
// Notion page for that discrepancy; Dan confirmed to use his door anyway.
// orderTypeId=2 for the load container matches deriveOrderTypeId's own
// Inbound(1)/Outbound(2) split in src/lib/pluginUtils.js -- DPI Monthly
// deliveries are always Outbound.
//
// Idempotency: refuses to push a route that's already been pushed
// successfully (final_push_status = 'success') -- re-running this for the
// same route would create a DUPLICATE Datex appointment. A route stuck at
// 'ambiguous' (a timeout with an unknown real-world outcome) also blocks a
// retry, matching the same reasoning as load_container_attempts -- a human
// needs to verify in Datex first, same as everywhere else in this app that
// touches a real Datex write.
//
// One appointment + one load container per ROUTE (one truck departure),
// not per stop -- confirmed with Dan.
//
// POST body: { routeId, facility, routeNumber, monthKey, scheduledArrivalIso, totalCases }

const { pushToDatex } = require('./lib/datex-push-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''

function supabaseHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) }
}

const FACILITY_CONFIG = {
  'Eau Claire': {
    warehouse: 'CSW-Eau Claire',
    carrier_datex_id: 1322, // Echo Brook
    owner_datex_id: 818, // Department of Public Instruction
    project_datex_id: 253, // DPI - CSW-Eau Claire
    dock_door_datex_id: 43486, // "  Scedule 1"
  },
  Madison: {
    warehouse: 'CSW-Madison',
    carrier_datex_id: 463, // J&J
    owner_datex_id: 818, // Department of Public Instruction
    project_datex_id: 122, // DPI - CSW-Madison
    dock_door_datex_id: 43394, // ".East Dock -- Outbound"
  },
}

async function fetchRoute(routeId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dpi_routes?id=eq.${routeId}&select=*`, { headers: supabaseHeaders() })
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0] || null
}

async function updateRoute(routeId, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/dpi_routes?id=eq.${routeId}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(fields),
  }).catch((err) => console.error('[dpi-final-push] update failed:', err.message))
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) }
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase env vars not configured' }) }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { routeId, facility, routeNumber, monthKey, scheduledArrivalIso, totalCases } = body
  if (!routeId || !facility || !routeNumber || !scheduledArrivalIso) {
    return { statusCode: 400, body: JSON.stringify({ error: 'routeId, facility, routeNumber, and scheduledArrivalIso are all required' }) }
  }

  const config = FACILITY_CONFIG[facility]
  if (!config) {
    return { statusCode: 400, body: JSON.stringify({ error: `No Datex facility config for "${facility}"` }) }
  }

  // Refuse to re-push an already-pushed or still-ambiguous route -- same
  // reasoning as load_container_attempts: pushing again risks a duplicate
  // Datex appointment.
  const existing = await fetchRoute(routeId)
  if (existing?.final_push_status === 'success') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: `Route ${routeNumber} was already pushed successfully (appointment ${existing.datex_appointment_id}). Not re-pushing.` }),
    }
  }
  if (existing?.final_push_status === 'ambiguous') {
    return {
      statusCode: 409,
      body: JSON.stringify({ error: `Route ${routeNumber}'s previous push attempt timed out with an unknown outcome. Verify in Datex before retrying.` }),
    }
  }

  const lookupCode = `DPI-${routeNumber}-${monthKey || ''}`

  // Step 1: load container (proxies the existing, already-hardened endpoint
  // rather than duplicating its ambiguous-timeout tracking here).
  let loadContainerId = null
  try {
    const lcRes = await fetch(`${process.env.URL || process.env.DEPLOY_URL}/.netlify/functions/scheduling-create-load-container`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookupcode: lookupCode, orderTypeId: 2, priority: 1 }), // 2 = Outbound (deriveOrderTypeId), 1 = standard priority
    })
    const lcData = await lcRes.json().catch(() => ({}))

    if (lcRes.status === 409 && lcData.errorCode === 'lc_ambiguous_pending') {
      await updateRoute(routeId, { final_push_status: 'ambiguous', final_push_error: lcData.error })
      return { statusCode: 409, body: JSON.stringify({ error: lcData.error }) }
    }
    if (lcRes.status === 504 && lcData.errorCode === 'lc_timeout') {
      await updateRoute(routeId, { final_push_status: 'ambiguous', final_push_error: lcData.error })
      return { statusCode: 504, body: JSON.stringify({ error: lcData.error }) }
    }
    if (lcData.dry_run) {
      return { statusCode: 200, body: JSON.stringify({ dry_run: true, loadContainerPayload: lcData.payload }) }
    }
    if (!lcData.ok) {
      await updateRoute(routeId, { final_push_status: 'failed', final_push_error: lcData.error || 'Load container creation failed' })
      return { statusCode: 502, body: JSON.stringify({ error: lcData.error || 'Load container creation failed' }) }
    }
    loadContainerId = lcData.loadcontainerId ?? null
  } catch (err) {
    await updateRoute(routeId, { final_push_status: 'failed', final_push_error: `Load container request failed: ${err.message}` })
    return { statusCode: 502, body: JSON.stringify({ error: `Load container request failed: ${err.message}` }) }
  }

  // Step 2: dock appointment, carrying the load container ID.
  const record = {
    appointment_lookup_code: lookupCode,
    reference_number: `${routeNumber} ${monthKey || ''}`.trim(),
    notes: `DPI Monthly final push — ${totalCases ?? '?'} cases, ${routeNumber}`,
    scheduled_arrival: scheduledArrivalIso,
    appt_duration: 30,
    warehouse: config.warehouse,
    type: 'Outbound',
    owner_datex_id: config.owner_datex_id,
    project_datex_id: config.project_datex_id,
    dock_door_datex_id: config.dock_door_datex_id,
    carrier_datex_id: config.carrier_datex_id,
    load_container_id: loadContainerId,
  }

  let datexResult
  try {
    datexResult = await pushToDatex(record)
  } catch (err) {
    await updateRoute(routeId, { final_push_status: 'failed', final_push_error: err.message, datex_load_container_id: loadContainerId })
    return { statusCode: 502, body: JSON.stringify({ error: err.message, loadContainerId }) }
  }

  if (datexResult.dry_run) {
    // No DATEX_CLIENT_ID configured -- preview only, nothing written to Datex.
    return { statusCode: 200, body: JSON.stringify({ dry_run: true, payload: datexResult.payload, loadContainerId }) }
  }

  if (datexResult.ambiguous) {
    await updateRoute(routeId, { final_push_status: 'ambiguous', final_push_error: datexResult.error, datex_load_container_id: loadContainerId })
    return { statusCode: 504, body: JSON.stringify({ error: datexResult.error, loadContainerId }) }
  }

  if (!datexResult.success) {
    await updateRoute(routeId, { final_push_status: 'failed', final_push_error: datexResult.error, datex_load_container_id: loadContainerId })
    return { statusCode: 502, body: JSON.stringify({ error: datexResult.error, loadContainerId }) }
  }

  await updateRoute(routeId, {
    final_push_status: 'success',
    final_push_error: null,
    datex_load_container_id: loadContainerId,
    datex_appointment_id: datexResult.datex_appointment_id ?? null,
    final_pushed_at: new Date().toISOString(),
  })

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      loadContainerId,
      appointmentId: datexResult.datex_appointment_id ?? null,
      warning: datexResult.warning || null,
    }),
  }
}
