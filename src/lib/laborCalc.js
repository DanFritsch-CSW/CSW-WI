const DEFAULTS = { hours_per_appt: 1.5, shift1_hours: 8, shift2_hours: 8, shift1_start: 5, shift2_start: 13 }
const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]

// Returns an array of fractional multipliers (0–1) for each shift hour.
function getBreakMultipliers(settings) {
  return BREAK_DEFAULTS.map((def, i) => (settings?.[`break_hour_${i + 1}`] ?? def) / 100)
}

// Override req/avail in hourly data using facility settings.
// req = appts * hours_per_appt (recalculated from raw appointment count)
export function applySettings(hourlyData, settings) {
  const hpa = settings?.hours_per_appt ?? DEFAULTS.hours_per_appt
  return hourlyData.map(row => ({
    ...row,
    req: row.appts * hpa,
  }))
}

// Compute daily util% and delta from transformed hourly rows.
export function computeDailyKpis(hourly) {
  if (!hourly?.length) return { util: null, delta: null }
  const totalReq   = hourly.reduce((s, r) => s + (r.req   ?? 0), 0)
  const totalAvail = hourly.reduce((s, r) => s + (r.avail ?? 0), 0)
  const util  = totalAvail > 0 ? totalReq / totalAvail : null
  const delta = totalAvail > 0 ? totalAvail - totalReq  : null
  return { util, delta }
}

// Parse "HH:MM" or numeric hour string to integer hour (0-23), or null.
function parseStartHour(shiftStart) {
  if (!shiftStart) return null
  const h = parseInt(String(shiftStart).split(':')[0], 10)
  return isNaN(h) ? null : h
}

/**
 * Build a 24-element array of roster-based available labor hours per hour of day.
 * Each employee contributes their per-shift-hour availability fraction to each clock
 * hour they work (shift hour 1 = first hour of their shift, regardless of start time).
 *
 * @param {Array}  employees - employee objects (must have id, shift_start, default_lane)
 * @param {Object} laneMap   - { [employeeId]: laneId }
 * @param {Object} settings  - facility settings (shift1_hours, shift2_hours, shift1_start, shift2_start, break_hour_1…8)
 * @returns {Array<number>}  24-element array indexed by hour 0-23
 */
export function buildRosterAvailability(employees, laneMap, settings) {
  const shift1Hours = settings?.shift1_hours ?? DEFAULTS.shift1_hours
  const shift2Hours = settings?.shift2_hours ?? DEFAULTS.shift2_hours
  const shift1Start = settings?.shift1_start ?? DEFAULTS.shift1_start
  const shift2Start = settings?.shift2_start ?? DEFAULTS.shift2_start
  const breakMuls   = getBreakMultipliers(settings)

  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
    if (lane !== 'shift1' && lane !== 'shift2') continue

    const defaultStart = lane === 'shift1' ? shift1Start : shift2Start
    const shiftHours   = lane === 'shift1' ? shift1Hours : shift2Hours
    const startHour    = parseStartHour(emp.shift_start) ?? defaultStart

    for (let i = 0; i < shiftHours; i++) {
      const mul = breakMuls[i] ?? 1
      hourlyAvail[(startHour + i) % 24] += mul
    }
  }

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}
