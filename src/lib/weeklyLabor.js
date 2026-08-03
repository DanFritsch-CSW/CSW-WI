// Read-only weekly labor-hours helper for the Weekly tab's "Labor Overview"
// sub-tab (added 2026-08-03). Two exports:
//
//   fetchWeeklyRosterHours    — avail side
//   fetchWeeklyRequiredHours  — req side
//
// ── Avail ────────────────────────────────────────────────────────────
// Mirrors the READ path of RosterBoard.jsx's _buildState (assignments +
// B2E carryover rows → employees/laneMap/assignmentMap) WITHOUT any of
// RosterBoard's write/seed/purge machinery — this is a passive weekly
// summary, not a place that should be mutating roster_assignments. A
// date with no roster_assignments rows yet comes back `null` rather than
// triggering a cold-cache seed here.
//
// Uses buildRosterAvailability — the SAME function FacilityPanel.jsx uses
// for its Daily "Total Hrs Avail" KPI (24-hour array, summed) — NOT
// computeBreakAdjustedTotalHours, a second hand-rolled implementation
// that treats carryover-employee hour-capping slightly differently
// (caught 2026-08-03 (later) via a ~0.4h/day Daily-vs-Weekly mismatch).
//
// ── Required ─────────────────────────────────────────────────────────
// 2026-08-03 (later still): Dan caught the Weekly req total (a per-
// project daily-total × override-rate sum) still not matching Daily's
// real number even after the avail fix and the first req fix (KEN Mon
// 8/3: Weekly 171.8h vs Daily's validated 161.6h). Root cause: Daily's
// actual perHourReq formula in FacilityPanel.jsx is NOT simply
// (each project's daily total × its rate) — it blends per-project rates
// HOUR BY HOUR against the facility-wide hourly appointment total, and
// clamps the "non-override" remainder to zero if the override projects'
// own per-hour counts (from a separate per-project Omni query) exceed
// the aggregate per-hour total (from a different Omni query) at that
// hour. That clamping is invisible at the daily-total level — it only
// shows up hour by hour — so a day-level linear sum, however
// mathematically tidy, cannot reproduce it.
//
// fetchWeeklyRequiredHours therefore replicates FacilityPanel's
// perHourReq loop verbatim, hour by hour, using the same three sources
// Daily uses: fetchHourlyAppointments (facility-wide per-hour appts),
// fetchProjectHourlyDrops (per-project per-hour EST drops, Supabase),
// and fetchProjectHourlyAppointments (per-project per-hour live appts,
// only fetched when overrides exist — same guard Daily uses). This is
// the only way to guarantee an exact match to the validated Daily number
// for any date, since the two are now doing the literal same math.
//
// 2026-08-03 (round 3): even the hour-by-hour replication was still
// ~0.4h/day off from Daily (same direction, two different days — Mon
// 8/3: 161.2 vs 161.6, Tue 8/4: 179.2 vs 179.6 — ruling out live-data
// timing drift, which would vary in size and sign). Root cause:
// applySettings() in laborCalc.js rounds EACH HOUR's req to 1 decimal
// (`Math.round(perHourReq[h] * 10) / 10`) before FacilityPanel sums 24
// of them into totalLaborReq. The first version here summed the raw,
// unrounded per-hour values and rounded only the grand total once —
// mathematically closer to the "true" number, but not what Daily
// literally computes. Fixed by rounding each hour's contribution to 1
// decimal before adding it to the running total, matching applySettings
// exactly.
//
// Deliberately NOT sourced from Omni's own labor_required column — a
// separate, less-trusted forecasting model per Dan/Dean's 2026-08-03
// Front discussion about the scheduling app.

import { fetchTodayAssignments, fetchEmployeeBreaks, fetchProjectHourlyDrops } from './supabase.js'
import { fetchB2eRoster, fetchHourlyAppointments, fetchProjectHourlyAppointments } from './omni.js'
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


/**
 * Returns { [isoDate]: reqHours | null } for the given week's dates.
 * Replicates FacilityPanel.jsx's perHourReq loop hour-by-hour so the
 * total matches Daily's validated "Labor Req Total" KPI exactly for any
 * date — see the header comment above for why a day-level per-project
 * sum can't do this on its own.
 *
 * @param facilityId
 * @param weekDays          array of ISO date strings
 * @param settings          facility settings ({ hours_per_appt, ... })
 * @param projectHpa        Map<projectName, rate> from project_labor_assumptions
 * @param weeklyProjectAppts { [isoDate]: { [projectName]: { inb, out } } }
 *   — same data FacilityPanel already fetched for the Weekly Projects
 *   grid; used only to get each day's live-appt project name list
 *   (mirrors Daily's `projects.map(p => p.name)`).
 */
export async function fetchWeeklyRequiredHours(facilityId, weekDays, settings, projectHpa, weeklyProjectAppts) {
  const defaultHpa = settings?.hours_per_appt ?? 1.5
  const hasOverrides = !!(projectHpa && projectHpa.size > 0)

  const perDay = await Promise.all(weekDays.map(async (date) => {
    try {
      const dayProjectNames = Object.keys(weeklyProjectAppts?.[date] || {})
      const overrideNames = hasOverrides
        ? [...new Set([...dayProjectNames, ...projectHpa.keys()])]
        : []

      const [hourlyAppts, projectHourlyDrops, perProjectHourly] = await Promise.all([
        fetchHourlyAppointments(facilityId, date).catch(() => ({})),
        fetchProjectHourlyDrops(facilityId, date).catch(() => ({})),
        hasOverrides
          ? fetchProjectHourlyAppointments(facilityId, date, overrideNames).catch(() => ({}))
          : Promise.resolve({}),
      ])

      // Facility-wide EST drops per hour (sum across all projects) —
      // same as FacilityPanel's `estDrops` useMemo.
      const estDropsByHour = {}
      for (const hourMap of Object.values(projectHourlyDrops)) {
        for (const [h, v] of Object.entries(hourMap)) {
          const val = typeof v === 'object' ? (v?.est_drops ?? 0) : Number(v ?? 0)
          estDropsByHour[h] = (estDropsByHour[h] ?? 0) + val
        }
      }

      // NOTE: each hour's req is rounded to 1 decimal HERE, before being
      // added to totalReq — matching applySettings()'s
      // `Math.round(perHourReq[h] * 10) / 10` exactly. Summing 24 raw
      // (unrounded) per-hour values and rounding only the final total
      // is mathematically "more precise" but produces a different
      // number than what Daily's KPI actually displays, since Daily
      // sums already-rounded per-hour req values.
      let totalReq = 0
      for (let h = 0; h < 24; h++) {
        const apptSrc = hourlyAppts[h] ?? { inb: 0, out: 0 }
        const est = estDropsByHour[h] ?? 0
        const totalAppts = (apptSrc.inb ?? 0) + est + (apptSrc.out ?? 0)

        let hourReq
        if (!hasOverrides) {
          hourReq = totalAppts * defaultHpa
        } else {
          const hourMap = perProjectHourly[h] || {}
          let overrideHours = 0
          let overrideAppts = 0
          for (const name of overrideNames) {
            if (!projectHpa.has(name)) continue
            const counts = hourMap[name]
            const liveAppts = (counts?.inb ?? 0) + (counts?.out ?? 0)
            const dropRaw = projectHourlyDrops?.[name]?.[h]
            const dropCount = typeof dropRaw === 'object' ? (dropRaw?.est_drops ?? 0) : Number(dropRaw ?? 0)
            const projectTotal = liveAppts + dropCount
            if (projectTotal === 0) continue
            overrideHours += projectTotal * projectHpa.get(name)
            overrideAppts += projectTotal
          }
          const remainingAppts = Math.max(0, totalAppts - overrideAppts)
          hourReq = overrideHours + remainingAppts * defaultHpa
        }
        totalReq += Math.round(hourReq * 10) / 10
      }

      return [date, Math.round(totalReq * 10) / 10]
    } catch (e) {
      console.warn(`fetchWeeklyRequiredHours ${facilityId} ${date} failed (non-fatal):`, e?.message)
      return [date, null]
    }
  }))

  return Object.fromEntries(perDay)
}
