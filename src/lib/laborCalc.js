// Hardcoded shift defaults — used as fallback when an employee has no
// personal shift_start / shift_hours in their roster_assignments row.
const SHIFT_DEFAULTS = {
  shift1: { start: 5,  hours: 8 },
  mid:    { start: 9,  hours: 8 },
  shift2: { start: 13, hours: 8 },
  shift3: { start: 22, hours: 8 },
}

const LANE_TO_SHIFT = {
  shift1: 'shift1', mid: 'mid', shift2: 'shift2', shift3: 'shift3',
  side12_shift1: 'shift1', side12_mid: 'mid', side12_shift2: 'shift2', side12_shift3: 'shift3',
  side35_shift1: 'shift1', side35_mid: 'mid', side35_shift2: 'shift2', side35_shift3: 'shift3',
}

const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]

// Operational day boundary: 5am–4:59am.
const OP_DAY_START = 5
const OP_DAY_END_LINEAR = 24 + OP_DAY_START  // 29

function getBreakMultipliers(settings) {
  return BREAK_DEFAULTS.map((def, i) => (settings?.[`break_hour_${i + 1}`] ?? def) / 100)
}

/**
 * Compute per-clock-hour break multipliers for an employee with a custom
 * break schedule. Returns Array(24) where each element is the productivity
 * multiplier (0..1) for that clock hour, accounting for break-minute
 * overlap.
 *
 * Each break is a (start_decimal_hour, duration_minutes) window. For each
 * clock hour h, we compute total HOURS the employee is on break during
 * [h, h+1), and multiplier = 1 − (totalBreakHoursInHour).
 *
 * @param {Object|null} brk - { first_break_at, first_break_minutes,
 *                              lunch_at,        lunch_minutes,
 *                              second_break_at, second_break_minutes }
 */
function getEmployeeBreakMultipliers(brk) {
  const muls = new Array(24).fill(1)
  if (!brk) return muls
  const breaks = [
    [Number(brk.first_break_at),  Number(brk.first_break_minutes)  / 60],
    [Number(brk.lunch_at),        Number(brk.lunch_minutes)        / 60],
    [Number(brk.second_break_at), Number(brk.second_break_minutes) / 60],
  ]
  for (let h = 0; h < 24; h++) {
    let breakHoursInHour = 0
    for (const [start, durHours] of breaks) {
      if (!Number.isFinite(start) || !Number.isFinite(durHours) || durHours <= 0) continue
      const end = start + durHours
      const overlap = Math.max(0, Math.min(h + 1, end) - Math.max(h, start))
      breakHoursInHour += overlap
    }
    muls[h] = Math.max(0, 1 - breakHoursInHour)
  }
  return muls
}

/**
 * Apply facility settings to hourly data, producing the `req` column.
 *
 * @param {Array} hourlyData  - 24-row array from Omni; each row has `h` (0-23).
 * @param {Object} settings   - { hours_per_appt, break_hour_1..8, ... }.
 * @param {Array<number>|null} perHourReq - Optional 24-element array of
 *   pre-computed req values INDEXED BY HOUR (perHourReq[h] = req for hour h),
 *   e.g. blended from per-project HPAs. When provided, used directly via
 *   row.h lookup; otherwise falls back to appts × hours_per_appt.
 *
 *   IMPORTANT: hourlyData is typically in operational-day order (5am first,
 *   4am last), so the array index does NOT match the clock hour. Always
 *   look up perHourReq[row.h], never perHourReq[i].
 */
export function applySettings(hourlyData, settings, perHourReq = null) {
  const hpa = settings?.hours_per_appt ?? 1.5
  return hourlyData.map(row => {
    let req
    const h = row.h
    if (perHourReq && typeof h === 'number' && Number.isFinite(perHourReq[h])) {
      req = Math.round(perHourReq[h] * 10) / 10
    } else {
      req = Math.round((row.appts ?? 0) * hpa * 10) / 10
    }
    return { ...row, req }
  })
}

export function computeDailyKpis(hourly) {
  if (!hourly?.length) return { util: null, delta: null }
  const totalReq   = hourly.reduce((s, r) => s + (r.req   ?? 0), 0)
  const totalAvail = hourly.reduce((s, r) => s + (r.avail ?? 0), 0)
  const util  = totalAvail > 0 ? totalReq / totalAvail : null
  const delta = totalAvail > 0 ? totalAvail - totalReq  : null
  return { util, delta }
}

/**
 * Returns null if excluded from today's op-day calc; otherwise:
 *   { resolvedStart, resolvedHours, lane, rawStartDecimal, realShiftStart, isCarryover }
 *
 * For carryovers, resolvedStart is renormalized to 5am, resolvedHours = tail.
 * realShiftStart preserves the TRUE shift start (e.g. 22 for 10pm) so callers
 * can compute the correct break_hour index.
 */
function resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter) {
  const assignment = assignmentMap?.[emp.id]
  if (assignment?.on_loan_to) return null

  const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
  if (laneFilter && !laneFilter.has(lane)) return null

  const shiftKey = LANE_TO_SHIFT[lane]
  if (!shiftKey) return null  // pto, callin

  const shiftDefaults = SHIFT_DEFAULTS[shiftKey]
  const rawStart = assignment?.shift_start ?? emp.shift_start
  const rawHours = assignment?.shift_hours ?? emp.shift_hours

  if (rawStart == null && rawHours == null) return null  // Free Flow

  const rawStartDecimal = rawStart != null ? Number(rawStart) : shiftDefaults.start
  const startHour  = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
  const shiftHours = rawHours != null ? Number(rawHours) : shiftDefaults.hours

  const realStart   = isNaN(startHour) ? shiftDefaults.start : startHour
  const realHours   = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours
  const realDecimal = isNaN(rawStartDecimal) ? shiftDefaults.start : rawStartDecimal

  const isCarryover = emp.is_carryover === true

  if (isCarryover) {
    const linearEnd = realDecimal + realHours
    const tailHours = linearEnd - (24 + OP_DAY_START)
    if (tailHours <= 0) return null
    return {
      resolvedStart:   OP_DAY_START,
      resolvedHours:   tailHours,
      lane,
      rawStartDecimal: OP_DAY_START,
      realShiftStart:  realDecimal,
      isCarryover:     true,
    }
  }

  if (realStart < OP_DAY_START) return null

  return {
    resolvedStart:   realStart,
    resolvedHours:   realHours,
    lane,
    rawStartDecimal: realDecimal,
    realShiftStart:  realDecimal,
    isCarryover:     false,
  }
}

/**
 * Build a 24-element array of roster-based available labor hours per hour of day.
 *
 * Operational day = 5am–4:59am. Carryovers are renormalized to start at 5am
 * with only their tail hours counted.
 *
 * Break multiplier source per employee:
 *   - If `breaksMap` has an entry for emp.originalId ?? emp.id → use
 *     clock-time-based per-hour multipliers (getEmployeeBreakMultipliers).
 *   - Otherwise → use facility BREAK_DEFAULTS indexed by shift-hour-offset.
 *
 * @param {Map|null} breaksMap - Map<employee_id, breakOverride> (optional).
 */
export function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null, breaksMap = null) {
  const facilityBreakMuls = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours, realShiftStart, isCarryover } = shift
    const fullHours = Math.floor(resolvedHours)
    const frac      = resolvedHours - fullHours

    // Per-employee override (clock-time based)
    const empKey = String(emp.originalId ?? emp.id)
    const breakOverride = breaksMap?.get?.(empKey) ?? null
    const empMuls = breakOverride ? getEmployeeBreakMultipliers(breakOverride) : null

    // For carryover: at 5am today, the employee is in shift-hour
    // (OP_DAY_START + 24 - realShiftStart). E.g. 10pm start → 5+24-22 = 7
    // → break_hour_8 (0-indexed 7). breakIdxOffset shifts loop's i by that.
    const breakIdxOffset = isCarryover
      ? Math.floor((OP_DAY_START + 24) - realShiftStart)
      : 0

    for (let i = 0; i < fullHours; i++) {
      const hLinear = resolvedStart + i
      if (hLinear >= OP_DAY_END_LINEAR) break
      const hMod = hLinear % 24
      const mul = empMuls
        ? (empMuls[hMod] ?? 1)
        : (facilityBreakMuls[i + breakIdxOffset] ?? 1)
      hourlyAvail[hMod] += mul
    }
    if (frac > 0) {
      const hLinear = resolvedStart + fullHours
      if (hLinear < OP_DAY_END_LINEAR) {
        const hMod = hLinear % 24
        const mul = empMuls
          ? (empMuls[hMod] ?? 1)
          : (facilityBreakMuls[fullHours + breakIdxOffset] ?? 1)
        hourlyAvail[hMod] += frac * mul
      }
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}

/**
 * Build a 24-element array of raw staffed headcount per hour of day, plus
 * a per-hour map of employee name + per-hour contribution.
 */
export function buildRosterStaffedHeadcount(employees, laneMap, assignmentMap = {}, laneFilter = null) {
  const hourly = new Array(24).fill(0)
  const byHour = {}

  function addContribution(hour, name, contribution, isCarryover) {
    if (contribution <= 0) return
    hourly[hour] += contribution
    if (!byHour[hour]) byHour[hour] = []
    byHour[hour].push({
      name,
      contribution: Math.round(contribution * 100) / 100,
      isCarryover:  !!isCarryover,
    })
  }

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours, rawStartDecimal, isCarryover } = shift
    const empName = emp.name || `Employee ${emp.id}`

    const startOffset   = rawStartDecimal - resolvedStart
    const realEnd       = rawStartDecimal + resolvedHours
    const lastHourFloor = Math.floor(realEnd)
    const endFrac       = realEnd - lastHourFloor

    for (let h = resolvedStart; h <= lastHourFloor; h++) {
      if (h >= OP_DAY_END_LINEAR) break

      const hMod = h % 24
      let contribution = 1

      if (h === resolvedStart && startOffset > 0) {
        contribution -= startOffset
      }
      if (h === lastHourFloor) {
        if (endFrac === 0) {
          contribution = 0
        } else if (h === resolvedStart && startOffset > 0) {
          contribution = Math.min(endFrac - startOffset, contribution)
          if (contribution < 0) contribution = 0
        } else {
          contribution = Math.min(endFrac, contribution)
        }
      }

      addContribution(hMod, empName, contribution, isCarryover)
    }
  }

  for (const h in byHour) byHour[h].sort((a, b) => a.name.localeCompare(b.name))

  return {
    hourly: hourly.map(v => Math.round(v * 10) / 10),
    byHour,
  }
}

/**
 * Compute break-adjusted total hours for a set of employees.
 * Respects the 5am operational day cap for overnight shifts.
 * Optionally accepts a breaksMap of per-employee overrides; same selection
 * logic as buildRosterAvailability (override → clock-time muls, else facility).
 */
export function computeBreakAdjustedTotalHours(employees, laneMap, settings, assignmentMap = {}, laneFilter = null, breaksMap = null) {
  const facilityBreakMuls = getBreakMultipliers(settings)
  let total = 0

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours, realShiftStart, isCarryover } = shift
    const linearEnd   = resolvedStart + resolvedHours
    const cappedHours = !isCarryover && linearEnd > OP_DAY_END_LINEAR
      ? OP_DAY_END_LINEAR - resolvedStart
      : resolvedHours

    const empKey = String(emp.originalId ?? emp.id)
    const breakOverride = breaksMap?.get?.(empKey) ?? null
    const empMuls = breakOverride ? getEmployeeBreakMultipliers(breakOverride) : null

    const breakIdxOffset = isCarryover
      ? Math.floor((OP_DAY_START + 24) - realShiftStart)
      : 0

    const fullHours = Math.floor(cappedHours)
    const frac      = cappedHours - fullHours
    for (let i = 0; i < fullHours; i++) {
      const hMod = (resolvedStart + i) % 24
      const mul = empMuls
        ? (empMuls[hMod] ?? 1)
        : (facilityBreakMuls[i + breakIdxOffset] ?? 1)
      total += mul
    }
    if (frac > 0) {
      const hMod = (resolvedStart + fullHours) % 24
      const mul = empMuls
        ? (empMuls[hMod] ?? 1)
        : (facilityBreakMuls[fullHours + breakIdxOffset] ?? 1)
      total += frac * mul
    }
  }

  return Math.round(total * 10) / 10
}
