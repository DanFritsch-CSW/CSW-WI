// Hardcoded shift defaults — used as fallback when an employee has no
// personal shift_start / shift_hours in their roster_assignments row.
// These are no longer stored in or read from facility_settings.
const SHIFT_DEFAULTS = {
  shift1: { start: 5,  hours: 8 },
  mid:    { start: 9,  hours: 8 },
  shift2: { start: 13, hours: 8 },
  shift3: { start: 22, hours: 8 },
}

// Map any lane ID → the shift bucket whose defaults apply
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

// Override req using facility hours_per_appt setting.
export function applySettings(hourlyData, settings) {
  const hpa = settings?.hours_per_appt ?? 1.5
  return hourlyData.map(row => ({
    ...row,
    req: row.appts * hpa,
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
 * @param {Array}    employees     - employee objects
 * @param {Object}   laneMap       - { [employeeId]: laneId }
 * @param {Object}   settings      - facility settings (only break_hour_* used now)
 * @param {Object}   assignmentMap - day-specific overrides
 * @param {Set|null} laneFilter    - if provided, only count employees in these lane IDs
 * @returns {Array<number>}  24-element array indexed by hour 0-23
 */
export function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls   = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'

    // Skip employees not in the filtered lane set
    if (laneFilter && !laneFilter.has(lane)) continue

    const shiftKey = LANE_TO_SHIFT[lane]
    if (!shiftKey) continue  // pto, callin — not counted

    const shiftDefaults = SHIFT_DEFAULTS[shiftKey]
    const assignment    = assignmentMap?.[emp.id]

    // Resolve start hour: assignment override → B2E schedule → hardcoded default
    const startHour  = assignment?.shift_start  ?? parseStartHour(emp.shift_start)  ?? shiftDefaults.start
    // Resolve hours: assignment override → hardcoded default (B2E doesn't reliably provide duration)
    const shiftHours = assignment?.shift_hours  ?? shiftDefaults.hours

    for (let i = 0; i < shiftHours; i++) {
      const mul = breakMuls[i] ?? 1
      hourlyAvail[(startHour + i) % 24] += mul
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}
