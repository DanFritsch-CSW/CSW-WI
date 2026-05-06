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
 * Priority for each employee's start/hours:
 *  1. Day-specific assignment override (shift_start / shift_hours from roster_assignments)
 *  2. B2E schedule data stored on the employee object (emp.shift_start)
 *  3. Hardcoded SHIFT_DEFAULTS for the employee's shift bucket
 *
 * IMPORTANT: Supabase returns NUMERIC columns as strings in JS.
 * All shift_start and shift_hours values are coerced to Number before use.
 */
export function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls   = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'

    if (laneFilter && !laneFilter.has(lane)) continue

    const shiftKey = LANE_TO_SHIFT[lane]
    if (!shiftKey) continue  // pto, callin — not counted

    const shiftDefaults = SHIFT_DEFAULTS[shiftKey]
    const assignment    = assignmentMap?.[emp.id]

    // Coerce to Number — Supabase returns NUMERIC as strings, causing
    // string concatenation bugs in the hour index arithmetic below.
    const rawStart = assignment?.shift_start ?? emp.shift_start
    const startHour  = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
    const rawHours   = assignment?.shift_hours ?? shiftDefaults.hours
    const shiftHours = rawHours != null ? Number(rawHours) : shiftDefaults.hours

    // Guard against NaN (bad data) — fall back to shift default
    const resolvedStart = isNaN(startHour) ? shiftDefaults.start : startHour
    const resolvedHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours

    for (let i = 0; i < resolvedHours; i++) {
      const mul = breakMuls[i] ?? 1
      hourlyAvail[(resolvedStart + i) % 24] += mul
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}

/**
 * Compute break-adjusted total hours for a set of employees.
 * Used for the "Total Hrs Available" KPI pill.
 */
export function computeBreakAdjustedTotalHours(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls = getBreakMultipliers(settings)
  let total = 0

  for (const emp of employees) {
    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
    if (laneFilter && !laneFilter.has(lane)) continue
    const shiftKey = LANE_TO_SHIFT[lane]
    if (!shiftKey) continue

    const shiftDefaults = SHIFT_DEFAULTS[shiftKey]
    const assignment    = assignmentMap?.[emp.id]
    const rawHours      = assignment?.shift_hours ?? shiftDefaults.hours
    const shiftHours    = rawHours != null ? Number(rawHours) : shiftDefaults.hours
    const resolvedHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours

    for (let i = 0; i < resolvedHours; i++) {
      total += breakMuls[i] ?? 1
    }
  }

  return Math.round(total * 10) / 10
}
