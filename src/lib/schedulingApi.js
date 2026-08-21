/**
 * Thin wrappers around the scheduling-* Netlify Functions.
 * Ported from front_netlify_datex/src/api.js (2026-08-03) — all endpoint
 * paths updated to the scheduling-* function names used in this repo
 * (e.g. get-submissions → scheduling-get-submissions). All Supabase access
 * stays server-side; no client-side DB credentials needed here.
 */

const BASE = '/.netlify/functions'

// ── Omni lookup cache — localStorage, 60-minute TTL ────────────────────────
// Lookup data (warehouses, owners, dock doors, etc.) changes rarely. Caching
// cuts Omni API queries by ~80% across plugin loads and dropdown interactions.
const LOOKUP_CACHE_TTL_MS = 60 * 60 * 1000 // 60 minutes — dropdown/reference data
const INSIGHTS_CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes — matches Datex→Omni lag

// Bump this whenever the appointment/labor insights response SHAPE or DATA
// SOURCE changes server-side (e.g. the 2026-08-19 Omni→MotherDuck switch).
// Without this, anyone with a still-warm 15-min localStorage cache entry
// keeps seeing pre-change numbers even after the underlying function is
// fixed and redeployed — exactly what happened testing the 08-19 labor/
// appointment-source fixes, where a stale cached value looked identical to
// the bug being chased and cost a round of confused re-testing. Bumping
// this invalidates every existing cache key automatically — no manual
// localStorage clearing needed on Dan's end.
const INSIGHTS_CACHE_VERSION = 'v2'

function getCached(key, ttl = LOOKUP_CACHE_TTL_MS) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const { ts, data } = JSON.parse(raw)
    if (Date.now() - ts > ttl) {
      localStorage.removeItem(key)
      return null
    }
    return data
  } catch {
    return null
  }
}

function setCached(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }))
  } catch {
    // localStorage unavailable (private browsing quota, etc.) — silent no-op
  }
}

export async function getOmniEmbedUrl({ warehouse, date } = {}) {
  const params = new URLSearchParams()
  if (warehouse) params.set('warehouse', warehouse)
  if (date) params.set('date', date)
  const qs = params.toString()
  const res = await fetch(`${BASE}/scheduling-omni-embed${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`Omni embed failed (${res.status})`)
  const { url } = await res.json()
  return url
}

export async function getSubmissions({ status, front_conversation_id } = {}, signal) {
  const params = new URLSearchParams()
  if (front_conversation_id) {
    params.set('front_conversation_id', front_conversation_id)
  } else if (status && status !== 'all') {
    params.set('status', status)
  }
  const qs = params.toString()
  const res = await fetch(`${BASE}/scheduling-get-submissions${qs ? `?${qs}` : ''}`, { signal })
  if (!res.ok) throw new Error(`Failed to fetch submissions (${res.status})`)
  return res.json()
}

export async function saveSubmission(id, frontConvId, edits) {
  const res = await fetch(`${BASE}/scheduling-save-submission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, front_conversation_id: frontConvId, edits }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Save failed (${res.status})`)
  }
  return res.json()
}

export async function getLookupOptions(type, warehouse) {
  const cacheKey = `omni_lookup:${type}:${warehouse ?? ''}`
  const cached = getCached(cacheKey)
  if (cached && cached.length > 0) return cached // never serve a cached empty — retry Omni

  const params = new URLSearchParams({ type })
  if (warehouse) params.set('warehouse', warehouse)
  const res = await fetch(`${BASE}/scheduling-omni-lookup?${params}`)
  if (!res.ok) throw new Error(`Lookup failed for "${type}" (${res.status})`)
  const { values } = await res.json()
  if (values.length > 0) setCached(cacheKey, values)
  return values
}

// Returns [{owner_name, project_name}] — all valid owner<->project pairs
// from Datex appointment history.
export async function getOwnerProjectMap() {
  const cacheKey = 'omni_lookup:owner_project_map:'
  const cached = getCached(cacheKey)
  if (cached && cached.length > 0) return cached

  const res = await fetch(`${BASE}/scheduling-omni-lookup?type=owner_project_map`)
  if (!res.ok) throw new Error(`Owner-project map failed (${res.status})`)
  const { values } = await res.json()
  if (values.length > 0) setCached(cacheKey, values)
  return values
}

// Returns [{name, id}] pairs for types that have Datex numeric IDs (owners,
// projects, dock_doors, carriers). Pass { topUsed: true } for the
// frequency-ranked top-250 list (carriers only).
export async function getLookupOptionsWithIds(type, warehouse, { topUsed = false } = {}) {
  const cacheKey = `omni_lookup:${type}:${warehouse ?? ''}:ids:${topUsed}`
  const cached = getCached(cacheKey)
  if (cached && cached.length > 0) return cached

  const params = new URLSearchParams({ type, with_ids: 'true' })
  if (warehouse) params.set('warehouse', warehouse)
  if (topUsed) params.set('top_used', 'true')
  const res = await fetch(`${BASE}/scheduling-omni-lookup?${params}`)
  if (!res.ok) throw new Error(`Lookup (with IDs) failed for "${type}" (${res.status})`)
  const { values } = await res.json()
  if (values.length > 0) setCached(cacheKey, values)
  return values // [{name, id}]
}

export async function createSubmission(frontConvId, fields) {
  const res = await fetch(`${BASE}/scheduling-create-submission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ front_conversation_id: frontConvId, fields }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Create failed (${res.status})`)
  }
  return res.json()
}

export async function getSettings(key) {
  const res = await fetch(`${BASE}/scheduling-settings?key=${encodeURIComponent(key)}`)
  if (!res.ok) throw new Error(`Settings fetch failed (${res.status})`)
  const { value } = await res.json()
  return value
}

export async function saveSettings(key, value) {
  const res = await fetch(`${BASE}/scheduling-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
  if (!res.ok) throw new Error(`Settings save failed (${res.status})`)
  return res.json()
}

export async function createRecurring(fields, startDatetime, recurrence) {
  const res = await fetch(`${BASE}/scheduling-create-recurring`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, start_datetime: startDatetime, recurrence }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Create recurring failed (${res.status})`)
  }
  return res.json() // { results: [...] }
}

export async function triggerFrontDraft(id, frontConvId, draftTemplate) {
  const res = await fetch(`${BASE}/scheduling-create-front-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(id ? { id } : {}),
      ...(frontConvId ? { front_conversation_id: frontConvId } : {}),
      ...(draftTemplate ? { draft_template: draftTemplate } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Draft creation failed (${res.status})`)
  }
  return res.json()
}

// Kept created_after for backward-compat / as a fallback signal, but the
// primary mechanism is now recordIds — the EXACT submission IDs created in
// this batch, which the caller already has (handleApproveAll's pushedIds).
// FIXED 2026-08-20 after Kay hit "No approved records found for this
// batch" on a batch that had genuinely succeeded (real datex_appointment_id,
// confirmed via direct Supabase query). Root cause: created_after alone
// compares a CLIENT-computed timestamp (Date.now() in the browser) against
// a SERVER-generated created_at column — if the client and server clocks
// drift by more than the 5-second buffer built into that timestamp, a
// genuinely successful, just-created appointment can fall outside the
// window and get silently excluded. record_ids sidesteps clock skew
// entirely by asking for those specific rows instead of a time window.
export async function triggerMultiFrontDraft(frontConvId, createdAfter, draftTemplate, recordIds) {
  const res = await fetch(`${BASE}/scheduling-create-multi-front-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      front_conversation_id: frontConvId,
      ...(recordIds?.length ? { record_ids: recordIds } : {}),
      created_after: createdAfter,
      ...(draftTemplate ? { draft_template: draftTemplate } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Multi draft creation failed (${res.status})`)
  }
  return res.json()
}

// Returns hourly appointment counts for a warehouse + date (5am-5am shift window).
export async function getAppointmentInsights(warehouse, date) {
  const cacheKey = `${INSIGHTS_CACHE_VERSION}:omni_appts:${warehouse}:${date}`
  const cached = getCached(cacheKey, INSIGHTS_CACHE_TTL_MS)
  if (cached) return cached
  const res = await fetch(`${BASE}/scheduling-omni-appointments?warehouse=${encodeURIComponent(warehouse)}&date=${date}`)
  const data = await res.json()
  setCached(cacheKey, data, INSIGHTS_CACHE_TTL_MS)
  return data
}

// Returns hourly labor staffing data for a warehouse + date (5am-5am shift
// window), sourced from the SAME roster-based calculation the real Labor
// Planning tab uses — see scheduling-labor-planning-insights.cjs. Falls
// back server-side to the old Omni-topic estimate when no roster is synced
// for that facility+date; `data.source` tells you which one you got
// ('roster' | 'omni_fallback'). Also returns `data.daily` — day-level
// {totalRequired, totalAvailable, delta} for the Day Insights summary row.
// Replaces the old direct call to scheduling-omni-labor (2026-08-18).
export async function getLaborInsights(warehouse, date) {
  const cacheKey = `${INSIGHTS_CACHE_VERSION}:labor_planning_insights:${warehouse}:${date}`
  const cached = getCached(cacheKey, INSIGHTS_CACHE_TTL_MS)
  if (cached) return cached
  const res = await fetch(`${BASE}/scheduling-labor-planning-insights?warehouse=${encodeURIComponent(warehouse)}&date=${date}`)
  const data = await res.json()
  // Never cache a fallback response — it should keep retrying the real
  // roster source on the next load rather than locking in an estimate.
  if (data.source === 'roster') setCached(cacheKey, data, INSIGHTS_CACHE_TTL_MS)
  return data
}

// Returns individual appointment records for a warehouse + date (5am-5am shift window).
export async function getHourAppointmentList(warehouse, date) {
  const cacheKey = `${INSIGHTS_CACHE_VERSION}:omni_appt_list:${warehouse}:${date}`
  const cached = getCached(cacheKey, INSIGHTS_CACHE_TTL_MS)
  if (cached) return cached
  const res = await fetch(`${BASE}/scheduling-omni-appointment-list?warehouse=${encodeURIComponent(warehouse)}&date=${date}`)
  const data = await res.json()
  setCached(cacheKey, data, INSIGHTS_CACHE_TTL_MS)
  return data
}

// Returns today's owner appointments + 120-day day-of-week average for a
// warehouse + date + owner + project.
export async function getOwnerInsights(warehouse, date, owner, project) {
  const cacheKey = `${INSIGHTS_CACHE_VERSION}:omni_owner:${warehouse}:${date}:${owner}:${project ?? ''}`
  const cached = getCached(cacheKey, INSIGHTS_CACHE_TTL_MS)
  if (cached) return cached
  const params = new URLSearchParams({ warehouse, date, owner })
  if (project) params.set('project', project)
  const res = await fetch(`${BASE}/scheduling-omni-owner-appointments?${params}`)
  const data = await res.json()
  setCached(cacheKey, data, INSIGHTS_CACHE_TTL_MS)
  return data
}

export async function createLoadContainer(fields) {
  const res = await fetch(`${BASE}/scheduling-create-load-container`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  // 504 timeout: Datex may have already created the container. Return the
  // JSON body (with errorCode: 'lc_timeout') so the caller can detect it and
  // block retries.
  if (res.status === 504) {
    try {
      return await res.json()
    } catch {
      /* fall through to generic error */
    }
  }
  if (!res.ok) {
    let message = `Create load container failed (${res.status})`
    try {
      const parsed = await res.json()
      if (parsed.error) message = parsed.error
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return res.json() // { ok, loadcontainerId } | { ok: false, error } | { ok: false, dry_run: true, payload }
}

export async function approveSubmission(id, frontConvId, edits, source, draftTemplate) {
  const res = await fetch(`${BASE}/scheduling-approve-submission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      front_conversation_id: frontConvId,
      ...(edits ? { edits } : {}),
      ...(source ? { source } : {}),
      ...(draftTemplate ? { draft_template: draftTemplate } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Approve failed (${res.status})`)
  }
  return res.json()
}

// Triggers the background Datex push for an already-prepped submission.
// Netlify returns 202 immediately; the function runs asynchronously. The
// Plugin polls get-submissions to detect completion.
export async function pushToDatexBackground(id, source, draftTemplate, sendEmail) {
  const res = await fetch(`${BASE}/scheduling-push-to-datex-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      ...(source ? { source } : {}),
      ...(draftTemplate ? { draft_template: draftTemplate } : {}),
      ...(sendEmail ? { send_email: true } : {}),
    }),
  })
  if (res.status !== 202 && !res.ok) {
    throw new Error(`Background push failed to trigger (${res.status})`)
  }
}

// Kenosha Order Search, Phase 1 — added 2026-08-21 per Dan/Kay's
// 2026-08-20 meeting. Checks whether an order exists in Datex by owner
// reference, vendor reference, or lookup code — see
// scheduling-order-search.cjs for the full design writeup. Not cached:
// order data changes far more often than the lookup/reference data cached
// elsewhere in this file, and staleness here would directly undermine the
// point of the tool (confirming an order exists RIGHT NOW).
export async function searchOrder(query) {
  const res = await fetch(`${BASE}/scheduling-order-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error || `Order search failed (${res.status})`)
  }
  return data // { found, count, orders, query }
}
