const DEFAULTS = {
  hours_per_appt: 1.5,
  shift1_start: 5,  shift1_hours: 8,
  mid_start:    9,  mid_hours:    8,
  shift2_start: 13, shift2_hours: 8,
  shift3_start: 22, shift3_hours: 8,
}

const LANE_KEYS = {
  shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  shift3: { start: 'shift3_start', hours: 'shift3_hours' },
  // CAL v2 side lanes — map to the same settings as their shift equivalent
  side12_shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  side12_mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  side12_shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  side12_shift3: { start: 'shift3_start', hours: 'shift3_hours' },
  side35_shift1: { start: 'shift1_start', hours: 'shift1_hours' },
  side35_mid:    { start: 'mid_start',    hours: 'mid_hours'    },
  side35_shift2: { start: 'shift2_start', hours: 'shift2_hours' },
  side35_shift3: { start: 'shift3_start', hours: 'shift3_hours' },
}
const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]

function getBreakMultipliers(settings) {
  return BREAK_DEFAULTS.map((def, i) => (settings?.[`break_hour_${i + 1}`] ?? def) / 100)
}

export function applySettings(hourlyData, settings) {
  const hpa = settings?.hours_per_appt ?? DEFAULTS.hours_per_appt
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
  if (!shiftStart) return null
  const val = Number(shiftStart)
  if (!isNaN(val)) return Math.floor(val)
  const h = parseInt(String(shiftStart).split(':')[0], 10)
  return isNaN(h) ? null : h
}

/**
 * Build a 24-element array of roster-based available labor hours per hour of day.
 *
 * @param {Array}    employees     - employee objects
 * @param {Object}   laneMap       - { [employeeId]: laneId }
 * @param {Object}   settings      - facility settings
 * @param {Object}   assignmentMap - day-specific overrides
 * @param {Set|null} laneFilter    - if provided, only count employees in these lane IDs
 * @returns {Array<number>}  24-element array indexed by hour 0-23
 */
export function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null) {
  const breakMuls   = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'

    // If a lane filter is provided, skip employees not in those lanes
    if (laneFilter && !laneFilter.has(lane)) continue

    const keys = LANE_KEYS[lane]
    if (!keys) continue  // pto, callin — not counted

    const assignment   = assignmentMap?.[emp.id]
    const defaultStart = settings?.[keys.start] ?? DEFAULTS[keys.start]
    const defaultHours = settings?.[keys.hours]  ?? DEFAULTS[keys.hours]

    const startHour  = assignment?.shift_start ?? parseStartHour(emp.shift_start) ?? defaultStart
    const shiftHours = assignment?.shift_hours ?? defaultHours

    for (let i = 0; i < shiftHours; i++) {
      const mul = breakMuls[i] ?? 1
      hourlyAvail[(startHour + i) % 24] += mul
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}
