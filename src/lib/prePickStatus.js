// Pre-Picked Order Status — Madison labor planning tab.
// Calls /.netlify/functions/motherduck-prepick-status (server-side proxy,
// same MOTHERDUCK_TOKEN as motherduck-appointments.cjs / motherduck-l4w.cjs).
//
// Returns outbound appointments for a facility/date with pick-completion
// status and pick-difficulty scoring attached. See the Netlify function
// header comment for the full definitions of "ready" and pick difficulty —
// summary: cases (not task counts) decide "ready", and pick difficulty is
// driven by whether a pick location mixes multiple lots together, not by
// raw pallet count.

import { PRIORITY_CUSTOMERS } from './constants.js'

async function prePickQuery(body) {
  const res = await fetch('/.netlify/functions/motherduck-prepick-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let err = {}
    try { err = await res.json() } catch { /* non-json */ }
    throw new Error(err.error || `motherduck-prepick-status ${res.status}`)
  }
  return res.json()
}

/**
 * Fetch pre-pick status for every outbound appointment on a facility/date.
 *
 * @param {string} facilityId - 'mad' | 'cal' | 'ken' | 'wr' | 'ec'
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {Promise<{appointments: Array, fetchedAt: string}>}
 */
export async function fetchPrePickStatus(facilityId, date) {
  return prePickQuery({ facilityId, date })
}

// ── Client-side display helpers ─────────────────────────────────────────
// Plain-language labels only — no raw scores surfaced to users (per Dan,
// 2026-07-11: "the number/score rating will confuse our internal team").
// The underlying pickLocations/rehandleRisk numbers still drive sort order
// internally; they're just never rendered as a number in the UI.

export const STATUS_META = {
  ready:        { label: 'Ready to load',    tone: 'good' },
  'not-started': { label: 'Not started',      tone: 'warn' },
  unresolved:   { label: 'Unresolved',        tone: 'bad' },
  placeholder:  { label: 'No order attached', tone: 'neutral' },
}

/**
 * Plain-language pick-difficulty band. Returns null (render as "Not
 * assigned yet") when the order has no hard allocation yet — small
 * each-pick orders often don't get slotted until release time.
 */
export function pickDifficultyLabel(pickLocations, rehandleRisk) {
  if (pickLocations == null || rehandleRisk == null) return null
  // Same weighting as validated 2026-07-11: pick count + locations*2 +
  // rehandle*3, rehandle-risk weighted heaviest since digging through a
  // mixed-lot lane costs the most time. pickLocations doubles as a rough
  // pick-count proxy here (one hard allocation per location, minimum).
  const score = pickLocations + pickLocations * 2 + rehandleRisk * 3
  if (score >= 100) return 'Heavy digging'
  if (score >= 40) return 'Some digging'
  return 'Easy grab'
}

/**
 * Sortable numeric score behind pickDifficultyLabel. Never rendered
 * directly — used only to order appointments by pick difficulty when the
 * user picks that sort mode.
 */
export function pickDifficultyScore(pickLocations, rehandleRisk) {
  if (pickLocations == null || rehandleRisk == null) return -1
  return pickLocations + pickLocations * 2 + rehandleRisk * 3
}

export function formatArrivalTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  } catch {
    return iso
  }
}

// ── Priority weighting (added 2026-07-12) ───────────────────────────────
// Orders matching PRIORITY_CUSTOMERS (constants.js) are pinned to the top
// of the list regardless of sort mode, with a gold star badge. Matches
// against carrier name OR the order's own lookup code / carrier text —
// case-insensitive substring match.

/**
 * @param {{carrierName?: string, orderLookupCode?: string, lookupCode?: string}} appt
 * @returns {boolean}
 */
export function isPriorityAppt(appt) {
  const haystack = `${appt.carrierName || ''} ${appt.orderLookupCode || appt.lookupCode || ''}`.toLowerCase()
  return PRIORITY_CUSTOMERS.some((name) => haystack.includes(name.toLowerCase()))
}
