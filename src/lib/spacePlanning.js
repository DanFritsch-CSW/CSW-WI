import { supabase } from './supabase.js'
import { fetchActiveInventory } from './omni.js'

// Space Planning module — shared constants + pure helpers + fetch functions.
// Lives separately from supabase.js so the data layer stays low-level and
// domain helpers / Supabase calls for Customers/Space Planning are colocated.

// ─── Constants ─────────────────────────────────────────────────

// Zones (handoff §1.4) — Phase 2 uses these for room metadata + scorecard
// rollup only. Per-zone occupancy needs the Datex location → room mapping
// that's deferred for now (per Dan, 2026-06-28).
export const ZONES = {
  freezer: { id: 'freezer', label: 'Freezer',     color: '#2a72b8', short: 'FZ' },
  cooler:  { id: 'cooler',  label: 'Cooler',      color: '#1a8a52', short: 'CL' },
  dry:     { id: 'dry',     label: 'Dry',         color: '#a07818', short: 'DR' },
  deep:    { id: 'deep',    label: 'Deep Freeze', color: '#7b5cd0', short: 'DP' },
}

// Facility brand colors (handoff §0).
export const FACILITY_DOTS = {
  cal: '#e07b4d',
  mad: '#4d9de0',
  ken: '#3dba7e',
  wr:  '#d4b84a',
  ec:  '#c084fc',
}

export const FACILITY_NAMES = {
  cal: 'Caledonia',
  mad: 'Madison',
  ken: 'Kenosha',
  wr:  'Wisconsin Rapids',
  ec:  'Eau Claire',
}

// Order for tab strip + scorecard grid.
export const FACILITIES = ['cal', 'mad', 'ken', 'wr', 'ec']

// Facilities that have per-room breakdown live (Phase 3). Others show the
// generic placeholder. Extend as room lists get seeded for other sites.
export const PHASE3_FACILITIES = new Set(['mad'])

// ─── Utilization color bands ───────────────────────────────────────────
// Per handoff §2: <70 green · 70–84 amber/gold · 85–94 orange · ≥95 red · null dim.
export function utilBand(pct) {
  if (pct == null || Number.isNaN(pct))
    return { band: 'none', color: 'var(--text-dim, #9aaabb)', label: '—' }
  if (pct < 70)
    return { band: 'low',  color: 'var(--green, #1a8a52)',  label: 'OK' }
  if (pct < 85)
    return { band: 'mid',  color: 'var(--amber, #a07818)',  label: 'Watch' }
  if (pct < 95)
    return { band: 'high', color: 'var(--orange, #d4824a)', label: 'High' }
  return  { band: 'over', color: 'var(--red, #c0392b)',    label: 'Over' }
}

// ─── Pure calc helpers ─────────────────────────────────────────────────

export function capacity(room) {
  return Math.max(0, (room.slots || 0) * (room.stack || 0))
}

export function facilityCapacity(rooms, facility) {
  return rooms
    .filter(r => r.facility === facility)
    .reduce((sum, r) => sum + capacity(r), 0)
}

// Sum of seeded actuals from Supabase. Phase 2.5 overrides this per-facility
// when a live Datex LP count is available; this is the fallback when Omni
// is down or the facility's live query failed.
export function facilityActualSeeded(positions, facility) {
  return positions
    .filter(c => c.facility === facility)
    .reduce((sum, c) => sum + (c.actual_positions || 0), 0)
}

// Phase 2.5 resolver: prefer live Datex LP count when present, else seeded.
// `liveTotals` shape: { [facility]: number } — what fetchLiveActualsPerFacility
// returns in its `.totals` field. Missing key = no live data for that facility.
export function facilityActual(positions, facility, liveTotals = null) {
  if (liveTotals && Number.isFinite(liveTotals[facility])) {
    return liveTotals[facility]
  }
  return facilityActualSeeded(positions, facility)
}

export function facilityUtil(rooms, positions, facility, liveTotals = null) {
  const cap = facilityCapacity(rooms, facility)
  if (cap <= 0) return null
  return (facilityActual(positions, facility, liveTotals) / cap) * 100
}

// Network rollups respect the same live-over-seeded preference.
export function networkCapacity(rooms) {
  return rooms.reduce((sum, r) => sum + capacity(r), 0)
}

export function networkActual(positions, liveTotals = null) {
  return FACILITIES.reduce(
    (sum, fac) => sum + facilityActual(positions, fac, liveTotals),
    0
  )
}

export function networkUtil(rooms, positions, liveTotals = null) {
  const cap = networkCapacity(rooms)
  if (cap <= 0) return null
  return (networkActual(positions, liveTotals) / cap) * 100
}

// Whether a given facility's actuals came from live Datex vs. seeded fixtures.
// Used by the UI to flag scorecards as "live" or "seeded".
export function isFacilityLive(facility, liveTotals) {
  return !!(liveTotals && Number.isFinite(liveTotals[facility]))
}

// ─── Formatters ──────────────────────────────────────────────────────

export function fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

export function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return Math.round(n) + '%'
}

// Format an ISO timestamp as "11:42am" (12h local time).
export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  let h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const ap = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  return `${h}:${m}${ap}`
}

// ─── Supabase fetch helpers ─────────────────────────────────────────────
// Read-only in Phase 2. Edit/upsert/delete helpers land in Phase 3+ alongside
// the single-facility view and edit mode UI.

export async function fetchSpaceRooms(facility = null) {
  if (!supabase) return []
  let q = supabase.from('space_rooms').select('*').order('facility').order('name')
  if (facility) q = q.eq('facility', facility)
  const { data, error } = await q
  if (error) { console.error('fetchSpaceRooms:', error); return [] }
  return data ?? []
}

export async function fetchSpaceCustomerPositions(facility = null) {
  if (!supabase) return []
  let q = supabase.from('space_customer_positions').select('*').order('facility').order('customer_name')
  if (facility) q = q.eq('facility', facility)
  const { data, error } = await q
  if (error) { console.error('fetchSpaceCustomerPositions:', error); return [] }
  return data ?? []
}

// ─── Live Datex actuals (Phase 2.5) ─────────────────────────────────────────────
//
// Fetches the count of active license plates per facility from Datex via Omni,
// using the same `fetchActiveInventory` path that drives the MAD inventory
// panel. That path joins LPs to `silver__datex_slv_projects` (INNER JOIN via
// Omni's project_name field), which filters out internal/unassigned LPs —
// matching the customer-owned-inventory semantic the handoff's LIVE_ACTUAL
// numbers use (e.g. MAD 5,521 vs the raw 19,432 non-archived LPs).
//
// Fires 5 facility queries in parallel via Promise.allSettled, so a single
// facility's Omni hiccup doesn't blank the whole Network view. Facilities
// that fail are omitted from `.totals`; the UI falls back to seeded numbers
// for those facilities (via the `facilityActual` resolver above) and surfaces
// a warning naming which facilities went stale.
//
// Per-facility latency: ~1–3s depending on project count. Wall-clock total
// is max-of-5 since they run concurrently. Pagination (5 pages × 500) is
// handled inside fetchActiveInventory.
//
// Returns:
//   {
//     totals:    { [facility]: number },   // facilities that succeeded
//     errors:    [{ facility, message }],  // facilities that failed
//     fetchedAt: ISO timestamp string,
//     ok:        boolean (true iff at least one facility returned data)
//   }
export async function fetchLiveActualsPerFacility() {
  const results = await Promise.allSettled(
    FACILITIES.map(facId => fetchActiveInventory(facId))
  )
  const totals = {}
  const errors = []
  results.forEach((r, i) => {
    const facId = FACILITIES[i]
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      const total = r.value.reduce((s, p) => s + (Number(p.lps) || 0), 0)
      totals[facId] = total
    } else {
      const msg = r.reason?.message || r.reason?.toString?.() || 'unknown error'
      errors.push({ facility: facId, message: msg })
      console.warn(`fetchLiveActualsPerFacility ${facId}:`, msg)
    }
  })
  return {
    totals,
    errors,
    fetchedAt: new Date().toISOString(),
    ok: Object.keys(totals).length > 0,
  }
}

// ─── Phase 3 — Room capacity edits (in-tab, MAD only) ─────────────────────────────
//
// Inline capacity editor lives inside SpacePlanningTab's FacilityRoomView —
// there is no separate Settings page for this. Updates slots + stack on a
// single room row. Called on blur/save from the CapacityCell component.
//
// Returns { success: true, room } on success, { success: false, error } on
// failure. Caller (CapacityCell) shows an inline error and keeps the edit
// open so the user doesn't lose their input.
export async function updateRoomCapacity(roomId, { slots, stack }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const cleanSlots = Math.max(0, Math.round(Number(slots) || 0))
  const cleanStack  = Math.max(0, Math.round(Number(stack) || 0))
  const { data, error } = await supabase
    .from('space_rooms')
    .update({ slots: cleanSlots, stack: cleanStack, updated_at: new Date().toISOString() })
    .eq('id', roomId)
    .select()
    .single()
  if (error) {
    console.error('updateRoomCapacity:', error)
    return { success: false, error: error.message }
  }
  return { success: true, room: data }
}

// ─── Phase 3 — Live per-room actuals ─────────────────────────────────────────────
//
// Fetches physical LP counts per top-level Datex room for a single facility
// via the MotherDuck-backed Netlify function (netlify/functions/space-per-room).
//
// IMPORTANT — different measurement than fetchActiveInventory / Network scorecard.
// The Network view uses fetchActiveInventory which is a project-joined
// customer-owned-inventory count (MAD ~5,521). This function returns the
// PHYSICAL LP count per room (archived=false, warehouse-scoped), which will
// be higher (MAD ~20,342 total physical LPs including internal/system LPs
// not tied to a customer project). Both are correct; they measure different
// things. UI documents the discrepancy inline.
//
// Currently MAD-only per Phase 3 rollout. Extend server-side (FACILITY_TO_WAREHOUSE
// + FACILITY_ROOT_LOCATION_ID) and add PHASE3_FACILITIES entries here when
// other facilities' room lists get seeded.
//
// Returns:
//   {
//     byRoomId:  Map<datex_top_location_id: number, active_lps: number>,
//     total:     number  (sum of active_lps across all rooms in response),
//     fetchedAt: ISO timestamp string,
//     elapsedMs: number,
//     error:     string | null,
//     source:    'live' | 'error',
//   }
export async function fetchLivePerRoomActuals(facility) {
  const t0 = Date.now()
  if (!PHASE3_FACILITIES.has(facility)) {
    return {
      byRoomId: new Map(), total: 0,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      error: `Facility '${facility}' not yet scoped for per-room breakdown`,
      source: 'error',
    }
  }
  try {
    const res = await fetch('/.netlify/functions/space-per-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility }),
    })
    if (!res.ok) {
      let body = {}
      try { body = await res.json() } catch { /* non-json */ }
      throw new Error(body.error || `space-per-room ${res.status}`)
    }
    const { perRoom, totals, fetchedAt, elapsedMs } = await res.json()
    const byRoomId = new Map()
    for (const row of (perRoom || [])) {
      byRoomId.set(Number(row.datex_top_location_id), Number(row.active_lps) || 0)
    }
    return {
      byRoomId,
      total: totals?.active_lps ?? 0,
      fetchedAt: fetchedAt || new Date().toISOString(),
      elapsedMs: elapsedMs ?? (Date.now() - t0),
      error: null,
      source: 'live',
    }
  } catch (e) {
    console.warn('fetchLivePerRoomActuals failed:', e.message)
    return {
      byRoomId: new Map(), total: 0,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      error: e.message,
      source: 'error',
    }
  }
}
