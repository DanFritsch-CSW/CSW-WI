import { supabase } from './supabase.js'

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

export function facilityActual(positions, facility) {
  return positions
    .filter(c => c.facility === facility)
    .reduce((sum, c) => sum + (c.actual_positions || 0), 0)
}

export function facilityUtil(rooms, positions, facility) {
  const cap = facilityCapacity(rooms, facility)
  if (cap <= 0) return null
  return (facilityActual(positions, facility) / cap) * 100
}

// Network = rollup across all 5 facilities.
export function networkCapacity(rooms) {
  return rooms.reduce((sum, r) => sum + capacity(r), 0)
}

export function networkActual(positions) {
  return positions.reduce((sum, c) => sum + (c.actual_positions || 0), 0)
}

export function networkUtil(rooms, positions) {
  const cap = networkCapacity(rooms)
  if (cap <= 0) return null
  return (networkActual(positions) / cap) * 100
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
