const DEFAULTS = { hours_per_appt: 1.5, break_pct: 10, shift1_hours: 8, shift2_hours: 8, shift1_start: 5, shift2_start: 13 }

// Override req/avail in hourly data using facility settings.
// req  = appts * hours_per_appt  (recalculated from raw appointment count)
// avail = avail * (1 - break_pct/100)  (capacity reduced by breaks)
export function applySettings(hourlyData, settings) {
  const hpa      = settings?.hours_per_appt ?? DEFAULTS.hours_per_appt
  const breakPct = settings?.break_pct      ?? DEFAULTS.break_pct
  const breakMul = 1 - breakPct / 100
  return hourlyData.map(row => ({
    ...row,
    req:   row.appts * hpa,
    avail: row.avail * breakMul,
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
 * Each active (shift1/shift2) employee contributes 1 to each hour they're working.
 * Break% is applied as a final multiplier (same as applySettings does for Omni avail).
 *
 * @param {Array}  employees - employee objects (must have id, shift_start, default_lane)
 * @param {Object} laneMap   - { [employeeId]: laneId }
 * @param {Object} settings  - facility settings (shift1_hours, shift2_hours, shift1_start, shift2_start, break_pct)
 * @returns {Array<number>}  24-element array indexed by hour 0-23
 */
export function buildRosterAvailability(employees, laneMap, settings) {
  const shift1Hours = settings?.shift1_hours ?? DEFAULTS.shift1_hours
  const shift2Hours = settings?.shift2_hours ?? DEFAULTS.shift2_hours
  const shift1Start = settings?.shift1_start ?? DEFAULTS.shift1_start
  const shift2Start = settings?.shift2_start ?? DEFAULTS.shift2_start
  const breakMul    = 1 - ((settings?.break_pct ?? DEFAULTS.break_pct) / 100)

  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
    if (lane !== 'shift1' && lane !== 'shift2') continue

    const defaultStart  = lane === 'shift1' ? shift1Start : shift2Start
    const shiftHours    = lane === 'shift1' ? shift1Hours : shift2Hours
    const startHour     = parseStartHour(emp.shift_start) ?? defaultStart

    for (let i = 0; i < shiftHours; i++) {
      hourlyAvail[(startHour + i) % 24] += 1
    }
  }

  return hourlyAvail.map(v => Math.round(v * breakMul * 10) / 10)
}
