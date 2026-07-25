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

// ─── Phase 3 — Live per-room, per-project drill-down ─────────────────────────────
//
// Companion to fetchLivePerRoomActuals: within a room, which projects/customers
// are occupying it right now, with a pallet-equivalent estimate (not raw LP
// count — a single deep-lane location can hold 100+ LPs of one project, so LP
// count alone is a poor proxy for physical space consumed).
//
// IMPORTANT data-quality note (confirmed live, see space-per-room-projects.cjs
// header comment for the full story): ~1/3 of on-hand LPs at MAD carry a
// pallet_tie=1/pallet_high=1 default that is NOT a real pallet config — those
// cases are reported under `casesNoPalletData` per project instead of a
// garbage pallet estimate. `estPallets` only reflects materials with a real
// (tie×high > 1) packaging config on file.
//
// Returns:
//   {
//     byRoomId:  Map<room_id: number, [{ projectName, lps, estPallets, casesNoPalletData }]>,
//     fetchedAt: ISO timestamp string,
//     elapsedMs: number,
//     error:     string | null,
//     source:    'live' | 'error',
//   }
export async function fetchLivePerRoomProjectBreakdown(facility) {
  const t0 = Date.now()
  if (!PHASE3_FACILITIES.has(facility)) {
    return {
      byRoomId: new Map(),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      error: `Facility '${facility}' not yet scoped for per-room breakdown`,
      source: 'error',
    }
  }
  try {
    const res = await fetch('/.netlify/functions/space-per-room-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility }),
    })
    if (!res.ok) {
      let body = {}
      try { body = await res.json() } catch { /* non-json */ }
      throw new Error(body.error || `space-per-room-projects ${res.status}`)
    }
    const { perRoom, fetchedAt, elapsedMs } = await res.json()
    const byRoomId = new Map()
    for (const [roomId, projects] of Object.entries(perRoom || {})) {
      byRoomId.set(Number(roomId), projects)
    }
    return {
      byRoomId,
      fetchedAt: fetchedAt || new Date().toISOString(),
      elapsedMs: elapsedMs ?? (Date.now() - t0),
      error: null,
      source: 'live',
    }
  } catch (e) {
    console.warn('fetchLivePerRoomProjectBreakdown failed:', e.message)
    return {
      byRoomId: new Map(),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      error: e.message,
      source: 'error',
    }
  }
}

// ─── Customer stacking reference (in-tab, MAD only for now) ─────────────────────
//
// Manual reference list: which customers' product double-stacks vs single-stacks
// in a room. Not tied to a specific room — Dan's call (2026-07-04) is that this
// is a general per-customer note, not per-room-per-customer. Datex has no data
// to derive this automatically (checked: LP Height/Length/Width are null across
// the board, parent_id/nesting unused, location-level LP counts reflect deep-lane
// storage depth rather than physical stack count) — this is manual knowledge,
// simply given a place to live instead of staying tribal.
//
// Lives in space_customer_stacking: facility, customer_name, stack_mode
// ('single'|'double'), notes, timestamps. UNIQUE(facility, customer_name) —
// one entry per customer per facility, editable/upsertable in place.

export async function fetchCustomerStacking(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('space_customer_stacking')
    .select('*')
    .eq('facility', facility)
    .order('customer_name')
  if (error) { console.error('fetchCustomerStacking:', error); return [] }
  return data ?? []
}

// Insert a new customer stacking entry. Returns { success, row } or
// { success: false, error }. Fails on duplicate (facility, customer_name) —
// caller should use updateCustomerStacking to edit an existing entry instead.
export async function addCustomerStacking(facility, { customerName, stackMode, notes }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { data, error } = await supabase
    .from('space_customer_stacking')
    .insert({
      facility,
      customer_name: customerName.trim(),
      stack_mode: stackMode,
      notes: notes?.trim() || null,
    })
    .select()
    .single()
  if (error) {
    console.error('addCustomerStacking:', error)
    return { success: false, error: error.code === '23505' ? 'That customer already has an entry for this facility' : error.message }
  }
  return { success: true, row: data }
}

export async function updateCustomerStacking(id, { customerName, stackMode, notes }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const patch = { updated_at: new Date().toISOString() }
  if (customerName != null) patch.customer_name = customerName.trim()
  if (stackMode != null) patch.stack_mode = stackMode
  if (notes !== undefined) patch.notes = notes?.trim() || null
  const { data, error } = await supabase
    .from('space_customer_stacking')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) {
    console.error('updateCustomerStacking:', error)
    return { success: false, error: error.message }
  }
  return { success: true, row: data }
}

export async function deleteCustomerStacking(id) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase.from('space_customer_stacking').delete().eq('id', id)
  if (error) {
    console.error('deleteCustomerStacking:', error)
    return { success: false, error: error.message }
  }
  return { success: true }
}

// ─── Phase 4a — Aisle rack geometry config (in-tab, mirrors capacity editor) ──────
//
// Capacity per room isn't uniform — different aisles have different rack
// geometry (deep × tiers) and different physical stacking ceilings (some
// aisles allow double-stacking totes per tier, some don't, regardless of
// what a customer's product could otherwise support). Datex has zero data
// on any of this (confirmed live, 2026-07-24: location_container dimension
// fields and child_footprint/child_stack_height are null for every aisle
// container checked) — this is manual rack-construction knowledge that only
// changes when the physical racking changes.
//
// New live capability discovered 2026-07-24: Datex DOES expose aisle-level
// location containers below the room level (e.g. F8 → A/B/C/D/E/F/G/H/J
// aisle containers → individual bay locations underneath). The earlier
// 2026-07-05 recon only checked room-level, so this wasn't previously known.
// `datex_aisle_location_id` links each row to that real Datex aisle
// container, enabling live per-aisle occupancy in a later phase.
//
// Lives in space_room_aisles: room_id (FK), aisle_label, datex_aisle_location_id
// (nullable — set when the aisle has a known Datex container),
// deep/tiers/max_stack_per_tier (nullable — rack geometry, entered manually),
// bay_count (nullable — number of physical bay positions in the aisle, e.g.
// F8's C aisle runs F8C01 through F8C57 = 57 bays; unlike deep/tiers/stack
// this IS live-derivable from Datex, since each bay is a real distinct
// location container — confirmed 2026-07-24 by counting distinct bay numbers
// under each aisle container, not guessed), notes. UNIQUE(room_id, aisle_label).

export async function fetchRoomAisles(roomId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('space_room_aisles')
    .select('*')
    .eq('room_id', roomId)
    .order('aisle_label')
  if (error) { console.error('fetchRoomAisles:', error); return [] }
  return data ?? []
}

// Updates rack geometry for one aisle row. Returns { success, aisle } or
// { success: false, error }. Clamps deep/tiers/max_stack_per_tier/bayCount to
// non-negative integers when provided; null clears a field (e.g. "not yet
// characterized" stays null until someone fills it in — distinct from 0).
export async function updateRoomAisle(aisleId, { deep, tiers, maxStackPerTier, bayCount, notes }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const clampOrNull = v => (v == null || v === '') ? null : Math.max(0, Math.round(Number(v)))
  const patch = { updated_at: new Date().toISOString() }
  if (deep !== undefined) patch.deep = clampOrNull(deep)
  if (tiers !== undefined) patch.tiers = clampOrNull(tiers)
  if (maxStackPerTier !== undefined) patch.max_stack_per_tier = clampOrNull(maxStackPerTier)
  if (bayCount !== undefined) patch.bay_count = clampOrNull(bayCount)
  if (notes !== undefined) patch.notes = notes?.trim() || null
  const { data, error } = await supabase
    .from('space_room_aisles')
    .update(patch)
    .eq('id', aisleId)
    .select()
    .single()
  if (error) {
    console.error('updateRoomAisle:', error)
    return { success: false, error: error.message }
  }
  return { success: true, aisle: data }
}

// Add a new aisle row (e.g. a room getting a new aisle characterized for
// the first time). Rejects duplicate (room_id, aisle_label) with a friendly
// message. Geometry fields optional at creation — can be filled in after.
export async function addRoomAisle(roomId, { aisleLabel, datexAisleLocationId, deep, tiers, maxStackPerTier, bayCount, notes }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { data, error } = await supabase
    .from('space_room_aisles')
    .insert({
      room_id: roomId,
      aisle_label: aisleLabel.trim(),
      datex_aisle_location_id: datexAisleLocationId ?? null,
      deep: deep ?? null,
      tiers: tiers ?? null,
      max_stack_per_tier: maxStackPerTier ?? null,
      bay_count: bayCount ?? null,
      notes: notes?.trim() || null,
    })
    .select()
    .single()
  if (error) {
    console.error('addRoomAisle:', error)
    return { success: false, error: error.code === '23505' ? 'That aisle already exists for this room' : error.message }
  }
  return { success: true, aisle: data }
}

export async function deleteRoomAisle(aisleId) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase.from('space_room_aisles').delete().eq('id', aisleId)
  if (error) {
    console.error('deleteRoomAisle:', error)
    return { success: false, error: error.message }
  }
  return { success: true }
}

// Pure helper — theoretical pallet-equivalent positions for one aisle,
// assuming its rack physically allows double-stacking (max_stack_per_tier),
// across every bay in the aisle. This is the RACK CEILING for the WHOLE
// AISLE, not adjusted for any particular customer's actual stacking
// behavior — see the capacity-math phase for the customer-adjusted version
// (MIN of rack ceiling and customer stack mode).
//
// bay_count matters here: deep×tiers alone is the capacity of ONE bay
// opening, not the whole aisle. An aisle like F8's C (2 deep × 7 tiers ×
// 57 bays) has 57x the positions of a single bay — omitting bay_count was
// exactly the gap Dan caught (2026-07-24): the UI showed per-bay geometry
// but never multiplied out to the aisle's real total.
export function aislePositions(aisle) {
  if (aisle.deep == null || aisle.tiers == null || aisle.bay_count == null) return null
  const stack = aisle.max_stack_per_tier ?? 1
  return aisle.deep * aisle.tiers * stack * aisle.bay_count
}

// Range version — added 2026-07-24 same day, per Dan's catch: the single
// "positions" number above silently assumes EVERY occupant of a double-stack-
// capable aisle actually double-stacks, which isn't true. Only specific
// customers (and sometimes specific materials) can physically double-stack —
// that's exactly what space_customer_stacking records. But that table is
// customer-level, not aisle-level, and there's no live per-aisle occupancy
// yet (Phase 4b, not built) to know WHICH customer is sitting in WHICH aisle
// right now. Rather than keep publishing a falsely precise single figure,
// this returns a range: `min` assumes single-stack everywhere (the floor —
// true regardless of who's actually in the aisle), `max` assumes the rack's
// full double-stack ceiling is used throughout (the same number aislePositions
// returns). Real usable capacity sits somewhere between the two depending on
// the actual customer mix — check Customer Stacking Notes for who's flagged
// as double-stack-capable. When max_stack_per_tier is 1 (or unset), min===max
// since there's no ambiguity — the aisle can only ever be single-stacked.
//
// NOTE 2026-07-25: this is still the underlying range concept, but the UI no
// longer DISPLAYS a range for capacity/utilization — Dan's call: use `min`
// (single-stack floor) as the sole denominator, and adjust the numerator
// instead (see computeEffectiveRoomOccupancy below). `min` from this function
// remains the source of truth for that fixed denominator.
export function aislePositionsRange(aisle) {
  if (aisle.deep == null || aisle.tiers == null || aisle.bay_count == null) return null
  const base = aisle.deep * aisle.tiers * aisle.bay_count
  const stack = aisle.max_stack_per_tier ?? 1
  return { min: base, max: base * stack }
}

// Bulk fetch — all aisles for every room in a facility, in one query. Used
// so room-level capacity (see roomAislePositions below) can be computed for
// every visible room row, not just the one currently expanded. Returns a
// Map<room_id, aisle[]> — rooms with no configured aisles simply have no
// entry (caller should treat "missing key" the same as "empty array": no
// aisle data yet, fall back to the manual Slots × Stack field).
export async function fetchAislesForRooms(roomIds) {
  if (!supabase || !roomIds?.length) return new Map()
  const { data, error } = await supabase
    .from('space_room_aisles')
    .select('*')
    .in('room_id', roomIds)
    .order('aisle_label')
  if (error) { console.error('fetchAislesForRooms:', error); return new Map() }
  const byRoomId = new Map()
  for (const aisle of (data ?? [])) {
    const list = byRoomId.get(aisle.room_id) || []
    list.push(aisle)
    byRoomId.set(aisle.room_id, list)
  }
  return byRoomId
}

// Room-level capacity computed as the sum of its aisles' positions — this is
// what replaced the room-level manual Slots × Stack entry once a room has
// aisle geometry configured (Dan's catch, 2026-07-24: the room-level field
// was pure redundancy once aisles could compute the real number themselves).
// Aisles with incomplete geometry (aislePositionsRange returns null — e.g. an
// aisle whose stack capability isn't confirmed yet) are excluded from the
// sum rather than silently treated as zero, and reported separately so the
// UI can flag the total as a floor, not a final number.
//
// Returns { min, max, completeCount, incompleteCount, aisleCount }. `min`/`max`
// are the same range concept as aislePositionsRange, summed across every
// complete aisle — min is the single-stack-everywhere floor (this is what the
// UI now uses as ROOM CAPACITY, flat, no range — Dan's call 2026-07-25), max
// is the rack-ceiling-everywhere assumption (kept for reference, no longer
// displayed). Caller should treat aisleCount === 0 as "no aisle data for this
// room" — fall back to the manual room-level capacity field entirely, not to
// min/max (which would both be 0 and read as "room holds nothing").
export function roomAislePositions(aisles) {
  if (!aisles || aisles.length === 0) {
    return { min: 0, max: 0, completeCount: 0, incompleteCount: 0, aisleCount: 0 }
  }
  let min = 0
  let max = 0
  let completeCount = 0
  let incompleteCount = 0
  for (const aisle of aisles) {
    const range = aislePositionsRange(aisle)
    if (range == null) {
      incompleteCount += 1
    } else {
      min += range.min
      max += range.max
      completeCount += 1
    }
  }
  return { min, max, completeCount, incompleteCount, aisleCount: aisles.length }
}

// ─── Phase 4b — Live per-aisle occupancy (visibility only, 2026-07-25) ───────────
//
// Which customers/projects are physically occupying each aisle right now,
// by LP count. Confirmed live before building: aisles routinely mix MULTIPLE
// customers together (F8's G aisle has 5 different projects with active
// LPs) — there's no way to know which specific bay a given customer's
// product sits in, only which aisle-container as a whole. This is exactly
// why aisle/room capacity stays a min–max RANGE (see aislePositionsRange /
// roomAislePositions above) rather than resolving to one number — that
// would need bay-level tracking this app doesn't have. Dan's explicit scope
// for this round: show occupancy + let him record material stacking
// exceptions; do NOT attempt to auto-resolve capacity from this data yet.
//
// UPDATE 2026-07-25 later same day: this occupancy data is now ALSO the
// input to computeEffectiveRoomOccupancy below, which resolves room
// utilization to a single stacking-adjusted number per Dan's request — the
// "do NOT auto-resolve capacity" scope note above referred to the earlier,
// broader ask; this narrower calculation (customer-level only, see that
// function's docs for exactly what it does and doesn't account for) is what
// Dan asked for next.
//
// Returns:
//   {
//     byAisleLocationId: Map<datex_aisle_location_id: number, [{ projectName, lps }]>,
//     fetchedAt, elapsedMs, error, source: 'live' | 'error'
//   }
export async function fetchLivePerAisleOccupancy(facility) {
  const t0 = Date.now()
  if (!PHASE3_FACILITIES.has(facility)) {
    return {
      byAisleLocationId: new Map(),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      error: `Facility '${facility}' not yet scoped for per-aisle occupancy`,
      source: 'error',
    }
  }
  try {
    const res = await fetch('/.netlify/functions/space-per-aisle-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility }),
    })
    if (!res.ok) {
      let body = {}
      try { body = await res.json() } catch { /* non-json */ }
      throw new Error(body.error || `space-per-aisle-projects ${res.status}`)
    }
    const { perAisle, fetchedAt, elapsedMs } = await res.json()
    const byAisleLocationId = new Map()
    for (const [aisleId, projects] of Object.entries(perAisle || {})) {
      byAisleLocationId.set(Number(aisleId), projects)
    }
    return {
      byAisleLocationId,
      fetchedAt: fetchedAt || new Date().toISOString(),
      elapsedMs: elapsedMs ?? (Date.now() - t0),
      error: null,
      source: 'live',
    }
  } catch (e) {
    console.warn('fetchLivePerAisleOccupancy failed:', e.message)
    return {
      byAisleLocationId: new Map(),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      error: e.message,
      source: 'error',
    }
  }
}

// Live materials with on-hand inventory for one customer — powers the
// material-exception dropdown so it's always current as customers add/retire
// materials over time, same "live list, not free text" pattern as
// fetchKnownCustomersForFacility. Scoped per customer (not a facility-wide
// dump) since a single project can carry 100+ materials total.
//
// Returns array of { materialName, lookupCode, lps } on success (sorted by
// lps descending), or null on failure — callers should treat null as "fall
// back to manual text entry", same convention as fetchKnownCustomersForFacility.
export async function fetchMaterialsForCustomer(facility, customerName) {
  if (!PHASE3_FACILITIES.has(facility)) return null
  try {
    const res = await fetch('/.netlify/functions/space-materials-for-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility, projectName: customerName }),
    })
    if (!res.ok) {
      let body = {}
      try { body = await res.json() } catch { /* non-json */ }
      throw new Error(body.error || `space-materials-for-project ${res.status}`)
    }
    const { materials } = await res.json()
    return materials || []
  } catch (e) {
    console.warn('fetchMaterialsForCustomer failed:', e.message)
    return null
  }
}

// ─── Material stacking exceptions (Phase 4b) ─────────────────────────────────────
//
// Customer-level stacking (space_customer_stacking, above) is a default —
// but Dan's reminder (2026-07-25): "only select customer and potentially
// select materials are able to be double stacked" — some customers have
// specific materials that break from their own default (e.g. a customer
// that's generally double-stack-capable might have one fragile SKU that
// isn't). This table records those as EXCEPTIONS layered on top of the
// customer default, not a full replacement — most materials for a customer
// simply inherit the customer-level stack_mode and never need an entry here.
//
// Lives in space_material_stacking: facility, customer_name, material_name,
// material_lookup_code, stack_mode ('single'|'double'), notes, timestamps.
// UNIQUE(facility, customer_name, material_name).
//
// Scalability note: this table only ever grows with real exceptions Dan
// actually enters — there's no seeding or bulk generation, keeping it small
// and manageable as customers and their material catalogs change over time.

export async function fetchMaterialStacking(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('space_material_stacking')
    .select('*')
    .eq('facility', facility)
    .order('customer_name')
    .order('material_name')
  if (error) { console.error('fetchMaterialStacking:', error); return [] }
  return data ?? []
}

// Insert a new material stacking exception. Returns { success, row } or
// { success: false, error }. Fails on duplicate (facility, customer_name,
// material_name) — caller should use updateMaterialStacking to edit instead.
export async function addMaterialStacking(facility, { customerName, materialName, lookupCode, stackMode, notes }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { data, error } = await supabase
    .from('space_material_stacking')
    .insert({
      facility,
      customer_name: customerName.trim(),
      material_name: materialName.trim(),
      material_lookup_code: lookupCode || null,
      stack_mode: stackMode,
      notes: notes?.trim() || null,
    })
    .select()
    .single()
  if (error) {
    console.error('addMaterialStacking:', error)
    return { success: false, error: error.code === '23505' ? 'That material already has an exception for this customer' : error.message }
  }
  return { success: true, row: data }
}

export async function updateMaterialStacking(id, { stackMode, notes }) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const patch = { updated_at: new Date().toISOString() }
  if (stackMode != null) patch.stack_mode = stackMode
  if (notes !== undefined) patch.notes = notes?.trim() || null
  const { data, error } = await supabase
    .from('space_material_stacking')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) {
    console.error('updateMaterialStacking:', error)
    return { success: false, error: error.message }
  }
  return { success: true, row: data }
}

export async function deleteMaterialStacking(id) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase.from('space_material_stacking').delete().eq('id', id)
  if (error) {
    console.error('deleteMaterialStacking:', error)
    return { success: false, error: error.message }
  }
  return { success: true }
}

// ─── Effective room occupancy — stacking-adjusted, single denominator ───────────
//
// Dan's call (2026-07-25): no range for capacity or utilization. Capacity is
// simply the single-stack floor (roomAislePositions(aisles).min) — a hard
// physical minimum true regardless of who's stored where. Utilization's
// NUMERATOR is adjusted instead: LPs get counted as HALF a position only
// when BOTH (a) they're physically sitting in an aisle whose rack can
// double-stack, AND (b) that occupant is actually flagged double-stack —
// otherwise they count as a full position. This is exactly Dan's example:
// a double-stack-capable customer whose LPs land in a single-stack aisle
// (B/C/D/E) gets no halving credit there, because the rack physically can't
// support it regardless of what that customer's product could do elsewhere.
//
// Matching a live Datex project name (e.g. "Jones Dairy Farm - CSW-Madison")
// against space_customer_stacking.customer_name uses the same case-
// insensitive PREFIX match as space-materials-for-project.cjs, since that
// table often stores a shortened name. Unmatched projects default to
// 'single' — conservative, never invents double-stack credit for a customer
// with no recorded stacking mode.
//
// KNOWN LIMITATION: this only resolves stack mode at the CUSTOMER level.
// space_material_stacking exceptions aren't factored in here, because the
// per-aisle occupancy data (fetchLivePerAisleOccupancy) is per-PROJECT, not
// per-material — there's no per-aisle-per-material breakdown to apply a
// material-level override against. Would need a further backend query
// (per-aisle-per-material occupancy) to close this gap.
export function findCustomerStackMode(projectName, customerStackingRows) {
  if (!projectName || !customerStackingRows?.length) return 'single'
  const upper = projectName.toUpperCase()
  const match = customerStackingRows.find(r => upper.startsWith((r.customer_name || '').toUpperCase()))
  return match ? match.stack_mode : 'single'
}

// Computes the stacking-adjusted "effective" occupied count for a room, to
// be compared against roomAislePositions(aisles).min as capacity. Walks each
// aisle's live occupants (from fetchLivePerAisleOccupancy), halves an
// occupant's LP count only when the aisle can double-stack AND that
// occupant's resolved stack mode is 'double'; otherwise counts 1:1. Any
// portion of the room's live LP total not accounted for by aisle-level
// occupancy (aisles missing a Datex link, or timing gaps between the two
// live queries) is added back at face value (1:1) — conservative, since we
// can't confirm double-stacking for LPs we can't attribute to a specific aisle.
//
// Returns a plain number (not null) — 0 if there's nothing to compute from.
export function computeEffectiveRoomOccupancy(aisles, occupancyByAisleId, customerStackingRows, liveLps) {
  let effectiveUsed = 0
  let mappedLpTotal = 0
  for (const aisle of (aisles || [])) {
    if (aisle.datex_aisle_location_id == null) continue
    const occupants = occupancyByAisleId?.get(Number(aisle.datex_aisle_location_id)) || []
    const aisleDoubleCapable = (aisle.max_stack_per_tier ?? 1) > 1
    for (const occ of occupants) {
      mappedLpTotal += occ.lps
      const mode = findCustomerStackMode(occ.projectName, customerStackingRows)
      effectiveUsed += (aisleDoubleCapable && mode === 'double') ? occ.lps / 2 : occ.lps
    }
  }
  const unaccounted = Math.max(0, (liveLps ?? 0) - mappedLpTotal)
  return effectiveUsed + unaccounted
}

// Real project/customer list for a facility, sourced from the same
// fetchActiveInventory path the Network scorecard uses — guarantees the
// stacking-notes dropdown links to actual Datex project names instead of
// free-typed text that can drift (typos, casing, "Colony Brands" vs
// "colony brands" becoming two different entries). Already sorted by LP
// count descending (fetchActiveInventory's own sort), so the biggest
// customers surface first.
//
// Returns array of { name, lps } on success, or null on failure — callers
// should treat null as "fall back to manual text entry", not as "empty list".
export async function fetchKnownCustomersForFacility(facility) {
  try {
    const rows = await fetchActiveInventory(facility)
    return rows.filter(r => r.name && r.name.trim())
  } catch (e) {
    console.warn('fetchKnownCustomersForFacility failed:', e.message)
    return null
  }
}
