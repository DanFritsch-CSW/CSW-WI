'use strict'

/**
 * Server-side (CJS) port of the pure calculation functions in
 * src/lib/laborCalc.js — added 2026-08-18 to power
 * scheduling-labor-planning-insights.cjs.
 *
 * IMPORTANT: this is a faithful line-for-line port, not a reinterpretation.
 * If src/lib/laborCalc.js's math ever changes, this file needs the same
 * change made here too, or the scheduling plugin's labor numbers will
 * silently drift from what the real Labor Planning tab shows. There's no
 * automated way to keep these in sync (ESM module in src/ vs CJS function
 * here) — a hand-diff against src/lib/laborCalc.js is the check to run if
 * anyone reports numbers not matching between the two.
 *
 * Intentionally NOT ported: project-level Hours-Per-Appointment overrides
 * (projectHpa blending in FacilityPanel.jsx's perHourReq memo). This
 * function uses only the facility-wide default hours_per_appt from
 * facility_settings. If a facility relies heavily on per-project HPA
 * overrides, its Required Hours here will differ from the real Labor
 * Planning tab for that reason specifically — worth flagging if numbers
 * look off for such a facility.
 */

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

const OP_DAY_START = 5
const OP_DAY_END_LINEAR = 24 + OP_DAY_START // 29

function getBreakMultipliers(settings) {
  return BREAK_DEFAULTS.map((def, i) => (settings?.[`break_hour_${i + 1}`] ?? def) / 100)
}

function getEmployeeBreakMultipliers(brk) {
  const muls = new Array(24).fill(1)
  if (!brk) return muls
  const breaks = [
    [Number(brk.first_break_at), Number(brk.first_break_minutes) / 60],
    [Number(brk.lunch_at), Number(brk.lunch_minutes) / 60],
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

function computeDailyKpis(hourly) {
  if (!hourly?.length) return { util: null, delta: null }
  const totalReq = hourly.reduce((s, r) => s + (r.req ?? 0), 0)
  const totalAvail = hourly.reduce((s, r) => s + (r.avail ?? 0), 0)
  const util = totalAvail > 0 ? totalReq / totalAvail : null
  const delta = totalAvail - totalReq
  return { util, delta }
}

function resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter) {
  const assignment = assignmentMap?.[emp.id]
  if (assignment?.on_loan_to) return null

  const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
  if (laneFilter && !laneFilter.has(lane)) return null

  const shiftKey = LANE_TO_SHIFT[lane]
  if (!shiftKey) return null // pto, callin

  const shiftDefaults = SHIFT_DEFAULTS[shiftKey]
  const rawStart = assignment?.shift_start ?? emp.shift_start
  const rawHours = assignment?.shift_hours ?? emp.shift_hours

  if (rawStart == null && rawHours == null) return null // Free Flow

  const rawStartDecimal = rawStart != null ? Number(rawStart) : shiftDefaults.start
  const startHour = rawStart != null ? Math.floor(Number(rawStart)) : shiftDefaults.start
  const shiftHours = rawHours != null ? Number(rawHours) : shiftDefaults.hours

  const realStart = isNaN(startHour) ? shiftDefaults.start : startHour
  const realHours = isNaN(shiftHours) || shiftHours <= 0 ? shiftDefaults.hours : shiftHours
  const realDecimal = isNaN(rawStartDecimal) ? shiftDefaults.start : rawStartDecimal

  const isCarryover = emp.is_carryover === true

  if (isCarryover) {
    const linearEnd = realDecimal + realHours
    const tailHours = linearEnd - (24 + OP_DAY_START)
    if (tailHours <= 0) return null
    return {
      resolvedStart: OP_DAY_START,
      resolvedHours: tailHours,
      lane,
      rawStartDecimal: OP_DAY_START,
      realShiftStart: realDecimal,
      isCarryover: true,
    }
  }

  if (realStart < OP_DAY_START) return null

  return {
    resolvedStart: realStart,
    resolvedHours: realHours,
    lane,
    rawStartDecimal: realDecimal,
    realShiftStart: realDecimal,
    isCarryover: false,
  }
}

function buildRosterAvailability(employees, laneMap, settings, assignmentMap = {}, laneFilter = null, breaksMap = null) {
  const facilityBreakMuls = getBreakMultipliers(settings)
  const hourlyAvail = new Array(24).fill(0)

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours, realShiftStart, isCarryover } = shift
    const fullHours = Math.floor(resolvedHours)
    const frac = resolvedHours - fullHours

    const empKey = String(emp.originalId ?? emp.id)
    const breakOverride = breaksMap?.get?.(empKey) ?? null
    const empMuls = breakOverride ? getEmployeeBreakMultipliers(breakOverride) : null

    const breakIdxOffset = isCarryover
      ? Math.floor((OP_DAY_START + 24) - realShiftStart)
      : 0

    for (let i = 0; i < fullHours; i++) {
      const hLinear = resolvedStart + i
      if (hLinear >= OP_DAY_END_LINEAR) break
      const hMod = hLinear % 24
      const mul = empMuls ? (empMuls[hMod] ?? 1) : (facilityBreakMuls[i + breakIdxOffset] ?? 1)
      hourlyAvail[hMod] += mul
    }
    if (frac > 0) {
      const hLinear = resolvedStart + fullHours
      if (hLinear < OP_DAY_END_LINEAR) {
        const hMod = hLinear % 24
        const mul = empMuls ? (empMuls[hMod] ?? 1) : (facilityBreakMuls[fullHours + breakIdxOffset] ?? 1)
        hourlyAvail[hMod] += frac * mul
      }
    }
  }

  return hourlyAvail.map((v) => Math.round(v * 10) / 10)
}

function buildRosterStaffedHeadcount(employees, laneMap, assignmentMap = {}, laneFilter = null) {
  const hourly = new Array(24).fill(0)

  for (const emp of employees) {
    const shift = resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter)
    if (!shift) continue

    const { resolvedStart, resolvedHours, rawStartDecimal } = shift
    const startOffset = rawStartDecimal - resolvedStart
    const realEnd = rawStartDecimal + resolvedHours
    const lastHourFloor = Math.floor(realEnd)
    const endFrac = realEnd - lastHourFloor

    for (let h = resolvedStart; h <= lastHourFloor; h++) {
      if (h >= OP_DAY_END_LINEAR) break
      const hMod = h % 24
      let contribution = 1
      if (h === resolvedStart && startOffset > 0) contribution -= startOffset
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
      if (contribution > 0) hourly[hMod] += contribution
    }
  }

  return hourly.map((v) => Math.round(v * 10) / 10)
}

module.exports = {
  buildRosterAvailability,
  buildRosterStaffedHeadcount,
  computeDailyKpis,
}
