// Read-only weekly labor-hours helper for the Weekly tab's "Labor Overview"
// sub-tab (added 2026-08-03). Mirrors the READ path of RosterBoard.jsx's
// _buildState (employees/laneMap/assignmentMap construction from a date's
// roster_assignments rows + B2E carryover rows) WITHOUT any of
// RosterBoard's write/seed/purge machinery — this is a passive weekly
// summary, not a place that should be mutating roster_assignments.
//
// If a date has no assignments rows yet (never opened in the Daily tab /
// Roster Board, or the nightly B2E cron/background horizon sync hasn't
// reached it), that day comes back as `null` rather than triggering a
// cold-cache seed here.
//
// Avail hours use buildRosterAvailability — the SAME function
// FacilityPanel.jsx uses for its own Daily "Total Hrs Avail" KPI (24-hour
// array, summed) — NOT computeBreakAdjustedTotalHours, a second
// hand-rolled total-hours implementation in laborCalc.js that treats
// carryover-employee hour-capping slightly differently (caught 2026-08-03
// (later) via Dan's Daily-vs-Weekly avail mismatch report, ~0.4h/day).
// Using the identical function Daily uses guarantees this can't drift
// from the validated Daily number for any date, by construction.
//
// Required hours (the other half of the Labor Hours Delta section) are
// deliberately NOT sourced from Omni's own labor_required column — that's
// a separate, less-trusted forecasting model per Dan/Dean's 2026-08-03
// Front discussion about the scheduling app. Instead, WeeklyLaborOverview
// derives required hours from the SAME weekly appointment/drops data
// already fetched for the Projects grid (dr + inb + out per project) x
// EACH PROJECT'S hours_per_appt override where one exists in
// project_labor_assumptions (same projectHpa map Daily's perHourReq uses)
// — see WeeklyLaborOverview.jsx. A flat facility-default rate was the
// original 2026-08-03 implementation; Dan caught it running ~10h/day low
// on KEN, which has 6 of 8 projects overridden above the 1.5 default.

import { fetchTodayAssignments, fetchEmployeeBreaks } from './supabase.js'
import { fetchB2eRoster } from './omni.js'
import { buildRosterAvailability } from './laborCalc.js'

function buildEmployeesFromAssignments(facility, assignments, carryovers) {
  const emps = assignments.filter(a => !a.is_temp).map(a => ({
    id: a.employee_id, name: a.employee_name, role: a.role || null,
    facility, is_temp: false, default_lane: a.lane,
  }))
  const tempEmps = assignments.filter(a => a.is_temp).map(a => ({
    id: a.employee_id, name: a.employee_name, role: a.role || 'Temp',
    facility, is_temp: true, default_lane: a.lane,
  }))
  const carryoverEmps = carryovers.map(c => ({
    id: c.id, originalId: c.originalId, name: c.name, role: c.role,
    facility, is_temp: false, is_carryover: true,
    default_lane: c.default_lane, shift_start: c.shift_start, shift_hours: c.shift_hours,
  }))
  const employees = [...emps, ...tempEmps, ...carryoverEmps]

  const laneMap = {}
  assignments.forEach(a => { laneMap[a.employee_id] = a.lane })
  for (const c of carryoverEmps) laneMap[c.id] = c.default_lane

  const assignmentMap = {}
  assignments.forEach(a => { assignmentMap[a.employee_id] = a })
  for (const c of carryoverEmps) {
    assignmentMap[c.id] = {
      facility, employee_id: c.id, employee_name: c.name, role: c.role,
      lane: c.default_lane, plan_date: null, is_temp: false,
      shift_start: c.shift_start, shift_hours: c.shift_hours, is_carryover: true,
    }
  }
  return { employees, laneMap, assignmentMap }
}

/**
 * Returns { [isoDate]: hoursAvail | null } for the given week's dates.
 * hoursAvail is null when no roster_assignments rows exist yet for that
 * date (rather than silently seeding/estimating one here).
 */
export async function fetchWeeklyRosterHours(facilityId, weekDays, settings) {
  const breaksMap = await fetchEmployeeBreaks(facilityId).catch(() => new Map())

  const perDay = await Promise.all(weekDays.map(async (date) => {
    try {
      const [assignments, b2eRosterFull] = await Promise.all([
        fetchTodayAssignments(facilityId, date),
        fetchB2eRoster(facilityId, date).catch(() => []),
      ])
      if (assignments.length === 0) return [date, null]
      const carryovers = b2eRosterFull.filter(e => e.is_carryover)
      const { employees, laneMap, assignmentMap } = buildEmployeesFromAssignments(facilityId, assignments, carryovers)
      // Same function + same "24-hour array, then sum" approach
      // FacilityPanel uses for its Daily Total Hrs Avail KPI.
      const hourlyAvail = buildRosterAvailability(employees, laneMap, settings, assignmentMap, null, breaksMap)
      const hours = Math.round(hourlyAvail.reduce((s, v) => s + v, 0) * 10) / 10
      return [date, hours]
    } catch (e) {
      console.warn(`fetchWeeklyRosterHours ${facilityId} ${date} failed (non-fatal):`, e?.message)
      return [date, null]
    }
  }))

  return Object.fromEntries(perDay)
}
