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

// Operational day runs 5am–4:59am (hours 5–28 on a linear 0–28 scale).
// We do NOT wrap hours past 23 — a 3rd shift starting at 22 covers hours
// 22 and 23 on day N, then wraps into day N+1 (hours 0–5). Those wrap hours
// belong to the NEXT operational day and must not appear in today's array.
const OP_DAY_START = 5   // 5am — shifts starting before this are excluded

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
 * Build a 24-element array of roster-based available labor hours per hour of day.
 *
 * Key rules:
 * 1. Shifts starting before OP_DAY_START (5am) are excluded — they belong to
 *    the previous operational day.
 * 2. Hours are NOT wrapped past 23. A 3rd shift (start=22, hours=8.5) covers
 *    hours 22 and 23 on the current day; hours 0–6 wrap to the NEXT day and
 *    are simply not counted here. This prevents Sunday 3rd shift from
 *    inflating Monday's 12am–5am labor availability.
 * 3. Employees on loan (on_loan_to set) are excluded entirely.
 */
export function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls   = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const assignment = assignmentMap?.[emp.id]

    // Exclude employees on loan to another facility
    if (assignment?.on_loan_to) continue

    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'

    if (laneFilter && !laneFilter.has(lane)) continue

    const shiftKey = LANE_TO_SHIFT[lane]
    if (!shiftKey) continue  // pto, callin — not counted

    const shiftDefaults = SHIFT_DEFAULTS[shiftKey]

    const rawStart   = assignment?.shift_start ?? emp.shift_start
    const startHour  = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
    const rawHours   = assignment?.shift_hours ?? shiftDefaults.hours
    const shiftHours = rawHours != null ? Number(rawHours) : shiftDefaults.hours

    const resolvedStart = isNaN(startHour) ? shiftDefaults.start : startHour
    const resolvedHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours

    // Exclude shifts starting before the operational day boundary
    if (resolvedStart < OP_DAY_START) continue

    for (let i = 0; i < resolvedHours; i++) {
      const h = resolvedStart + i
      if (h > 23) break   // don't wrap past midnight — those hours are tomorrow
      const mul = breakMuls[i] ?? 1
      hourlyAvail[h] += mul
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}

/**
 * Compute break-adjusted total hours for a set of employees.
 * Excludes employees on loan (on_loan_to set).
 * Excludes shifts starting before OP_DAY_START.
 * Does not count hours that wrap past midnight (belong to next day).
 */
export function computeBreakAdjustedTotalHours(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls = getBreakMultipliers(settings)
  let total = 0

  for (const emp of employees) {
    const assignment = assignmentMap?.[emp.id]

    // Exclude employees on loan
    if (assignment?.on_loan_to) continue

    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
    if (laneFilter && !laneFilter.has(lane)) continue
    const shiftKey = LANE_TO_SHIFT[lane]
    if (!shiftKey) continue

    const shiftDefaults = SHIFT_DEFAULTS[shiftKey]

    const rawStart      = assignment?.shift_start ?? emp.shift_start
    const startHour     = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
    const resolvedStart = isNaN(startHour) ? shiftDefaults.start : startHour

    // Exclude shifts starting before operational day boundary
    if (resolvedStart < OP_DAY_START) continue

    const rawHours      = assignment?.shift_hours ?? shiftDefaults.hours
    const shiftHours    = rawHours != null ? Number(rawHours) : shiftDefaults.hours
    const resolvedHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours

    for (let i = 0; i < resolvedHours; i++) {
      if (resolvedStart + i > 23) break  // stop at midnight
      total += breakMuls[i] ?? 1
    }
  }

  return Math.round(total * 10) / 10
}
