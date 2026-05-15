// Hardcoded shift defaults — used as fallback when an employee has no
// personal shift_start / shift_hours in their roster_assignments row.
const SHIFT_DEFAULTS = {
  shift1: { start: 5,  hours: 8 },
  mid:    { start: 9,  hours: 8 },
  shift2: { start: 13, hours: 8 },
  shift3: { start: 22, hours: 8 },
}

const LANE_TO_SHIFT = {
  shift1:        'shift1',
  mid:           'mid',
  shift2:        'shift2',
  shift3:        'shift3',
  side12_shift1: 'shift1',
  side12_mid:    'mid',
  side12_shift2: 'shift2',
  side12_shift3: 'shift3',
  side35_shift1: 'shift1',
  side35_mid:    'mid',
  side35_shift2: 'shift2',
  side35_shift3: 'shift3',
}

const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]

// Operational day boundary: 5am–4:59am.
// Shifts starting before this hour belong to the previous operational day
// and are excluded from today's availability calc.
const OP_DAY_START = 5

function getBreakMultipliers(settings) {
  return BREAK_DEFAULTS.map((def, i) => (settings?.[`break_hour_${i + 1}`] ?? def) / 100)
}

export function applySettings(hourlyData, settings) {
  const hpa = settings?.hours_per_appt ?? 1.5
  return hourlyData.map(row => ({
    ...row,
    req: Math.round(row.appts * hpa * 10) / 10,
  }))
}

export function computeDailyKpis(hourly) {
  if (!hourly?.length) return { util: null, delta: null }
  const totalReq   = hourly.reduce((s, r) => s + (r.req   ?? 0), 0)
  const totalAvail = hourly.reduce((s, r) => s + (r.avail ?? 0), 0)
  const util  = totalAvail > 0 ? totalReq / totalAvail : null
  const delta = totalAvail > 0 ? totalAvail - totalReq  : null
  return { util, delta }
}

function parseStartHour(shiftStart) {
  if (shiftStart === null || shiftStart === undefined || shiftStart === '') return null
  const val = Number(shiftStart)
  if (!isNaN(val)) return Math.floor(val)
  const h = parseInt(String(shiftStart).split(':')[0], 10)
  return isNaN(h) ? null : h
}

/**
 * Apply break multipliers to a shift of `resolvedHours` length.
 * Handles fractional hours (e.g. 8.5h) by running floor(h) full iterations
 * then adding one partial iteration scaled by the remainder.
 * breakMuls[i] defaults to 1.0 beyond the defined array length.
 */
function applyBreakMuls(resolvedHours, breakMuls) {
  const fullHours = Math.floor(resolvedHours)
  const frac      = resolvedHours - fullHours
  let total = 0
  for (let i = 0; i < fullHours; i++) {
    total += breakMuls[i] ?? 1
  }
  if (frac > 0) {
    total += frac * (breakMuls[fullHours] ?? 1)
  }
  return total
}

/**
 * Shared exclusion logic + resolved start/hours/lane for an employee.
 * `resolvedStart` here uses raw decimal start (NOT floored) so callers that
 * need to know about pre-hour partial starts (e.g. 6:30 start → 0.5 contribution
 * at 6am) get the fractional information. Callers that need an integer start
 * should floor it themselves.
 * Returns null if the employee should be excluded from labor calcs entirely.
 * Otherwise returns { resolvedStart, resolvedHours, lane, rawStartDecimal }.
 */
function resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter) {
  const assignment = assignmentMap?.[emp.id]

  // Exclude employees on loan to another facility
  if (assignment?.on_loan_to) return null

  const lane = laneMap[emp.id] || emp.default_lane || 'shift1'

  if (laneFilter && !laneFilter.has(lane)) return null

  const shiftKey = LANE_TO_SHIFT[lane]
  if (!shiftKey) return null  // pto, callin — not counted

  const shiftDefaults = SHIFT_DEFAULTS[shiftKey]

  const rawStart = assignment?.shift_start ?? emp.shift_start
  const rawHours = assignment?.shift_hours ?? emp.shift_hours

  // Exclude employees with no schedule data (e.g. "Free Flow" in B2E).
  if (rawStart == null && rawHours == null) return null

  // Raw decimal start (e.g. 6.5 for 6:30am) — preserved for fractional-hour calcs
  const rawStartDecimal = rawStart != null ? Number(rawStart) : shiftDefaults.start
  const startHour  = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
  const shiftHours = rawHours != null ? Number(rawHours) : shiftDefaults.hours

  const resolvedStart = isNaN(startHour) ? shiftDefaults.start : startHour
  const resolvedHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours
  const resolvedRawStart = isNaN(rawStartDecimal) ? shiftDefaults.start : rawStartDecimal

  // Exclude shifts starting before operational day boundary (uses floored start)
  if (resolvedStart < OP_DAY_START) return null

  return { resolvedStart, resolvedHours, lane, rawStartDecimal: resolvedRawStart }
}

/**
 * Build a 24-element array of roster-based available labor hours per hour of day.
 *
 * Operational day = 5am–4:59am. Hours 0–4 (12am–4am) are the TAIL of the
 * current operational day, not the start of the next.
 *
 * Key rules:
 * 1. Shifts starting before OP_DAY_START (5am) are excluded — they belong to
 *    the previous operational day.
 * 2. Shifts that cross midnight wrap via % 24 — all resolvedHours are counted,
 *    no early break at 5am. A 10pm–6am shift (start=22, hours=8) covers
 *    22, 23, 0, 1, 2, 3, 4, 5 — the worker is physically present until 6am
 *    so the 5am hour is included.
 * 3. Employees on loan (on_loan_to set) are excluded entirely.
 * 4. Fractional shift lengths (e.g. 8.5h) are handled correctly — the partial
 *    hour receives a prorated break multiplier.
 * 5. Employees with no schedule data (both shift_start and shift_hours are null
 *    on both the assignment and employee record) are excluded. These are
 *    "Free Flow" employees in B2E with no valid shift — Omni excludes them too.
 */
export function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls   = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours } = shift
    const fullHours = Math.floor(resolvedHours)
    const frac      = resolvedHours - fullHours

    for (let i = 0; i < fullHours; i++) {
      const hMod = (resolvedStart + i) % 24
      const mul  = breakMuls[i] ?? 1
      hourlyAvail[hMod] += mul
    }
    // Partial final hour
    if (frac > 0) {
      const hMod = (resolvedStart + fullHours) % 24
      hourlyAvail[hMod] += frac * (breakMuls[fullHours] ?? 1)
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}

/**
 * Build a 24-element array of raw staffed headcount per hour of day, plus
 * a per-hour map of employee name + per-hour contribution.
 *
 * This is the "Raw Staffed Employee" equivalent — pure body count, NO break math.
 * Used for reconciliation against Omni's Raw Staffed Employee column.
 *
 * Contribution semantics (one per employee per hour they touch):
 *   - Full hour on the clock: 1.0
 *   - Shift START is fractional (e.g. 6:30am start) at hour 6: 0.5 (worked 30 of 60 min)
 *   - Shift END is fractional (e.g. 8.5h shift ending at 1:30pm) at hour 13: 0.5
 *   - If both start AND end land in the same hour (very short partial), contribution
 *     is `min(startFrac, endFrac)` — rare edge case, conservative handling.
 *
 * Same exclusion rules as buildRosterAvailability:
 *   - on-loan, PTO/callin, free-flow (null shifts), pre-5am starts excluded
 *   - lane filter respected for CAL v2 side tabs
 *
 * Returns:
 *   {
 *     hourly: number[24]                                       // headcount per hour (rounded 1 decimal)
 *     byHour: { [hour: number]: Array<{name: string, contribution: number}> }  // sorted alphabetically by name
 *   }
 */
export function buildRosterStaffedHeadcount(employees, laneMap, assignmentMap = {}, laneFilter = null) {
  const hourly = new Array(24).fill(0)
  const byHour = {}

  function addContribution(hour, name, contribution) {
    if (contribution <= 0) return
    hourly[hour] += contribution
    if (!byHour[hour]) byHour[hour] = []
    byHour[hour].push({ name, contribution: Math.round(contribution * 100) / 100 })
  }

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours, rawStartDecimal } = shift
    const empName = emp.name || `Employee ${emp.id}`

    // Start offset: how much of the start hour is BEFORE the shift begins.
    // e.g. shift starts at 6:30 → startOffset = 0.5 (first 30 min of 6am not worked).
    // Shift starts at 6:00 (integer) → startOffset = 0.
    const startOffset = rawStartDecimal - resolvedStart

    // Effective real-time end (decimal hours from shift start). e.g. start 6.5, hours 8 → ends at 14.5.
    const realEnd = rawStartDecimal + resolvedHours

    // We walk integer hours from `resolvedStart` (floor of start) to `ceil(realEnd) - 1`.
    // For each hour the employee touches, compute contribution.
    const lastHourFloor = Math.floor(realEnd)
    const endFrac       = realEnd - lastHourFloor  // 0 means shift ends exactly on the hour

    for (let h = resolvedStart; h <= lastHourFloor; h++) {
      const hMod = h % 24
      let contribution = 1

      // First hour partial start: subtract the part of the hour BEFORE shift start.
      if (h === resolvedStart && startOffset > 0) {
        contribution -= startOffset
      }
      // Last hour partial end: only count up to the end frac.
      // If shift ends exactly on the hour (endFrac === 0), this hour shouldn't count at all.
      if (h === lastHourFloor) {
        if (endFrac === 0) {
          contribution = 0  // shift ended exactly at the start of this hour
        } else if (h === resolvedStart && startOffset > 0) {
          // edge case: shift both starts AND ends in same hour
          contribution = Math.min(endFrac - startOffset, contribution)
          if (contribution < 0) contribution = 0
        } else {
          contribution = Math.min(endFrac, contribution)
        }
      }

      addContribution(hMod, empName, contribution)
    }
  }

  // Sort each hour's name list alphabetically for stable display
  for (const h in byHour) byHour[h].sort((a, b) => a.name.localeCompare(b.name))

  return {
    hourly: hourly.map(v => Math.round(v * 10) / 10),
    byHour,
  }
}

/**
 * Compute break-adjusted total hours for a set of employees.
 * Excludes employees on loan (on_loan_to set).
 * Excludes shifts starting before OP_DAY_START.
 * Excludes employees with no schedule data (both start and hours null).
 * All resolvedHours count — no early break when wrapping past midnight.
 * Fractional shift lengths handled correctly via applyBreakMuls().
 */
export function computeBreakAdjustedTotalHours(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls = getBreakMultipliers(settings)
  let total = 0

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    total += applyBreakMuls(shift.resolvedHours, breakMuls)
  }

  return Math.round(total * 10) / 10
}
