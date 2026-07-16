import { supabase } from './supabase.js'
import { OT_LANE_DIRECTION } from './constants.js'

// ── Facility-wide Overtime (Madison, added 2026-07-16) ──────────────────
// Lets a manager bump every active-lane employee's shift by N hours in one
// click instead of hand-editing each tile, for the "everyone works a 9hr
// day today" scenario. See OT_LANE_DIRECTION in constants.js for which side
// of the shift each lane extends.
//
// Scope: current facility + plan_date only. Applies to shift1/mid/shift2/
// shift3 lanes (pto/callin/specialProject are untouched — OT is a shift-
// time concept, not applicable there). Includes temps (is_temp=true) and
// loaned-in employees (from_facility != null) since they're physically
// working the MAD schedule that day; excludes anyone currently loaned OUT
// (on_loan_to != null) and anyone with a null shift_start/shift_hours
// (B2E "Free Flow" — no base time to extend). Carryover tiles are never
// persisted to Supabase at all, so they're naturally out of scope too.
//
// ot_hours on each row (roster_assignments.ot_hours, added via migration
// add_ot_hours_to_roster_assignments) stores the delta actually applied so
// revertFacilityOt can undo it exactly, and so a page reload later the same
// day still shows the OT-adjusted times (they're just the row's current
// shift_start/hours — no separate "OT mode" needed to render correctly).
//
// NOTE on B2E sync interaction: per the standing shift-time-ownership policy
// in supabase.js (B2E always owns shift_start/shift_hours), a later "Sync
// from B2E" click — manual or the 24h silent auto-resync — overwrites these
// rows back to standard B2E times, clearing ot_hours implicitly (the column
// itself isn't reset, but the values it described no longer apply). This is
// intentional: OT is a same-day call, not a standing schedule change, so
// it's fine that a fresh sync wipes it — the manager or CSR just re-applies
// OT if it's still needed after a sync.
export async function applyFacilityOt(facility, planDate, otHours) {
  if (!supabase) return { error: 'Supabase not configured', count: 0 }
  const activeLanes = Object.keys(OT_LANE_DIRECTION)
  const { data, error: fetchErr } = await supabase
    .from('roster_assignments')
    .select('id, lane, shift_start, shift_hours, on_loan_to')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .in('lane', activeLanes)
    .not('shift_start', 'is', null)
    .not('shift_hours', 'is', null)
    .is('on_loan_to', null)
  if (fetchErr) { console.error('applyFacilityOt fetch:', fetchErr); return { error: fetchErr.message, count: 0 } }
  if (!data || !data.length) return { error: null, count: 0 }

  const amount = Number(otHours)
  const updates = data.map(row => {
    const direction = OT_LANE_DIRECTION[row.lane] ?? 'end'
    const newStart = direction === 'start' ? Number(row.shift_start) - amount : Number(row.shift_start)
    const newHours = Number(row.shift_hours) + amount
    return { id: row.id, shift_start: newStart, shift_hours: newHours, ot_hours: amount }
  })

  const results = await Promise.all(updates.map(u =>
    supabase.from('roster_assignments')
      .update({ shift_start: u.shift_start, shift_hours: u.shift_hours, ot_hours: u.ot_hours })
      .eq('id', u.id)
  ))
  const failed = results.filter(r => r.error)
  if (failed.length) {
    console.error('applyFacilityOt update failures:', failed.map(f => f.error))
    return { error: `${failed.length} of ${updates.length} rows failed to update`, count: updates.length - failed.length }
  }
  return { error: null, count: updates.length }
}

// revertFacilityOt — undoes applyFacilityOt for the given facility+date,
// using each row's stored ot_hours as the exact delta to subtract back out.
export async function revertFacilityOt(facility, planDate) {
  if (!supabase) return { error: 'Supabase not configured', count: 0 }
  const { data, error: fetchErr } = await supabase
    .from('roster_assignments')
    .select('id, lane, shift_start, shift_hours, ot_hours')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .not('ot_hours', 'is', null)
  if (fetchErr) { console.error('revertFacilityOt fetch:', fetchErr); return { error: fetchErr.message, count: 0 } }
  if (!data || !data.length) return { error: null, count: 0 }

  const updates = data.map(row => {
    const direction = OT_LANE_DIRECTION[row.lane] ?? 'end'
    const amount = Number(row.ot_hours)
    const restoredStart = direction === 'start' ? Number(row.shift_start) + amount : Number(row.shift_start)
    const restoredHours = Number(row.shift_hours) - amount
    return { id: row.id, shift_start: restoredStart, shift_hours: restoredHours }
  })

  const results = await Promise.all(updates.map(u =>
    supabase.from('roster_assignments')
      .update({ shift_start: u.shift_start, shift_hours: u.shift_hours, ot_hours: null })
      .eq('id', u.id)
  ))
  const failed = results.filter(r => r.error)
  if (failed.length) {
    console.error('revertFacilityOt update failures:', failed.map(f => f.error))
    return { error: `${failed.length} of ${updates.length} rows failed to revert`, count: updates.length - failed.length }
  }
  return { error: null, count: updates.length }
}

// checkFacilityOtStatus — not currently called by RosterBoard (which derives
// OT-active state client-side from assignmentMap, already in memory after
// load()), but kept here as a direct DB-truth check for other consumers
// (e.g. a future Daily Ops digest note, or a debugging console call).
// Returns the common ot_hours amount if every OT'd row agrees (the normal
// case — one button click sets the same amount on every row), or count
// alone with amount=null if amounts differ.
export async function checkFacilityOtStatus(facility, planDate) {
  if (!supabase) return { active: false, amount: null, count: 0 }
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('ot_hours')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .not('ot_hours', 'is', null)
  if (error) { console.error('checkFacilityOtStatus:', error); return { active: false, amount: null, count: 0 } }
  if (!data || !data.length) return { active: false, amount: null, count: 0 }
  const amounts = new Set(data.map(r => Number(r.ot_hours)))
  return { active: true, amount: amounts.size === 1 ? [...amounts][0] : null, count: data.length }
}
