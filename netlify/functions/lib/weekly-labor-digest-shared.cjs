'use strict'

// Shared core for the Weekly Labor Overview "Labor Daily +/- After Adj"
// digest — added 2026-08-03. CAL and KEN only (per Dan's scope call —
// matches Kay's original Cal/Ken Front thread this feature automates).
//
// This is a SELF-CONTAINED PORT of src/lib/weeklyLabor.js (which is
// itself a client-side port of FacilityPanel.jsx's avail/req/adj calc),
// following this project's established convention for server-side
// digests that need client-equivalent logic in the Node/cjs runtime
// (see nightly-b2e-sync.cjs's own "ported from omni.js" header note).
// It cannot import the ESM client lib directly (different module system,
// and weeklyLabor.js's fetch calls use relative URLs that only resolve
// in a browser) — so the math and B2E/roster fetch logic are re-derived
// here against the same underlying Netlify functions and Supabase
// tables, verified field-for-field against src/lib/omni.js and
// src/lib/laborCalc.js at the time of writing.
//
// Same split-function pattern as every other digest here: this file has
// no `schedule` of its own — weekly-labor-digest-run.cjs (scheduled) and
// weekly-labor-digest-test.cjs (manual, no schedule) both require this.
//
// Headline number = Daily +/- After Adj (avail + manual hourly
// adjustments, minus required hours), matching the Daily tab's own KPI
// pill and the on-screen Weekly > Labor Overview sub-tab exactly — see
// weeklyLabor.js's header comment for the three-round precision saga
// this format is built on (per-project rate overrides applied hour-by-
// hour, each hour's req rounded to 1 decimal before summing).

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN   = process.env.FRONT_API_TOKEN
const SITE_URL      = process.env.URL || process.env.DEPLOY_URL

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

const FACILITIES = ['cal', 'ken']
const FACILITY_LABELS = { cal: 'Caledonia', ken: 'Kenosha' }

// ── Time helpers (same pattern as lib/wr-cases-digest-shared.cjs) ──────────

function centralNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = t => Number(parts.find(p => p.type === t).value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') }
}

function centralTodayISO() {
  const { year, month, day } = centralNowParts()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isNotifyTimeMatch(notifyHour, notifyMinute) {
  const { hour, minute } = centralNowParts()
  const bucket = Math.floor(minute / 15) * 15
  const targetBucket = Math.floor(notifyMinute / 15) * 15
  return hour === notifyHour && bucket === targetBucket
}

function isoWeekdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  const dow = d.getUTCDay()
  return dow === 0 ? 7 : dow
}

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Monday of the week containing iso (Mon=1..Sun=0 → -6 shift), matching
// LaborPlanning.jsx's mondayOf / FacilityPanel.jsx's mondayOfWeek.
function mondayOfISO(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

function formatMDD(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

// ── Supabase REST helpers ───────────────────────────────────────────────

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

// ── B2E / roster fetchers (ported from src/lib/omni.js) ────────────────
// Faithful port of fetchB2eRosterForEntryDate / fetchB2eRoster — same
// stale-snapshot max-ingestion-ts filter, same job-code allowlist, same
// shift/lane derivation. Calls motherduck-b2e-roster.cjs directly
// (absolute URL) instead of a relative fetch, since this runs server-side.

const B2E_LOCATION = { cal: '019 - Caledonia', ken: '015 - Kenosha' }
const ROSTER   = 'silver__b2e_slv_employeeroster'
const SCHEDULE = 'silver__b2e_slv_futurescheduleentries'
const CARRYOVER_ID_SUFFIX = '__carryover'

const CAL2_DOCK_NAMES_35 = new Set([
  'Calvieon Howard', 'Ethan Lindsey', 'Jose Cuevas', 'Nicholas J. Free',
  'Nicholas Free', 'Zarious Brinner', 'Juan Bido', 'Eduardo Ramon',
])

function getAllowedJobCodes(facilityId) {
  return (facilityId === 'mad' || facilityId === 'ec') ? new Set(['205', '209']) : new Set(['205'])
}

function cal2FallbackLane(name, shiftLane) {
  const is35 = [...CAL2_DOCK_NAMES_35].some(n => name.startsWith(n) || name.includes(n))
  const side = is35 ? 'side35' : 'side12'
  const suffix = { shift1: 'shift1', mid: 'mid', shift2: 'shift2', shift3: 'shift3' }[shiftLane] || 'shift1'
  return `${side}_${suffix}`
}

function scheduleToLane(workSchedule, startTime) {
  const ws = (workSchedule || '').toLowerCase()
  if (ws.includes('1st shift')) return 'shift1'
  if (ws.includes('mid'))       return 'mid'
  if (ws.includes('2nd shift')) return 'shift2'
  if (ws.includes('3rd shift')) return 'shift3'
  if (startTime && startTime !== '0' && startTime !== 0) {
    const hour = parseInt(String(startTime).split(':')[0], 10)
    if (!isNaN(hour)) {
      if (hour < 10) return 'shift1'
      if (hour < 14) return 'mid'
      if (hour < 20) return 'shift2'
      return 'shift3'
    }
  }
  return 'shift1'
}

function parseB2eTime(s) {
  if (!s || s === '0' || s === 0) return null
  const str = String(s).trim().toLowerCase()
  const m = str.match(/^(\d{1,2}):(\d{2})\s*([ap])?/)
  if (m) {
    let h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    const ap = m[3]
    if (ap === 'p' && h !== 12) h += 12
    else if (ap === 'a' && h === 12) h = 0
    return h + min / 60
  }
  const plain = parseFloat(str)
  return isNaN(plain) ? null : plain
}

function normalizeShiftStart(startTime) {
  const h = parseB2eTime(startTime)
  if (h == null) return null
  return Math.round(h * 4) / 4
}

function computeShiftHours(startTime, endTime) {
  const sh = parseB2eTime(startTime)
  const eh = parseB2eTime(endTime)
  if (sh == null || eh == null) return null
  const hours = (eh - sh + 24) % 24
  return hours > 0 ? Math.round(hours * 2) / 2 : null
}

function prevDayISO(iso) { return addDaysISO(iso, -1) }

async function motherduckB2eQuery(payload) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/motherduck-b2e-roster`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new Error(body.error || `motherduck-b2e-roster ${res.status}`)
  }
  const { rows } = await res.json()
  return rows
}

async function fetchCal2DockAssignments() {
  if (!supabase) return new Map()
  const { data, error } = await supabase.from('employees').select('id, default_lane').eq('facility', 'cal')
  if (error || !data) return new Map()
  return new Map(data.map(e => [String(e.id), e.default_lane]))
}

async function fetchB2eRosterForEntryDate(facilityId, entryDate, isCal, dockAssignments) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []

  const [rosterRows, scheduleRows] = await Promise.all([
    motherduckB2eQuery({ kind: 'active_roster_all_jobcodes', facilityId }),
    motherduckB2eQuery({ kind: 'schedule_date', facilityId, fromDate: entryDate }),
  ])

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))

  const maxIngestByEmp = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!maxIngestByEmp.has(id) || ts > maxIngestByEmp.get(id)) maxIngestByEmp.set(id, ts)
  }

  const schedMap = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (ts !== maxIngestByEmp.get(id)) continue
    const dateRaw = r[`${SCHEDULE}.entry_date`]
    if (!dateRaw) continue
    const dateIso = typeof dateRaw === 'string' ? dateRaw.slice(0, 10) : new Date(dateRaw).toISOString().slice(0, 10)
    if (dateIso !== entryDate) continue
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  return [...schedMap.entries()]
    .filter(([id, { row: r }]) => activeIds.has(id) && getAllowedJobCodes(facilityId).has(String(r[`${SCHEDULE}.default_job_code`] ?? '')))
    .map(([id, { row: r }]) => {
      const startTime = r[`${SCHEDULE}.modified_start_time`] ?? r[`${SCHEDULE}.start_time`]
      const endTime   = r[`${SCHEDULE}.modified_end_time`]   ?? r[`${SCHEDULE}.end_time`]
      const firstName = r[`${SCHEDULE}.first_name`] || ''
      const lastName  = r[`${SCHEDULE}.last_name`]  || ''
      const fullName  = [firstName, lastName].filter(Boolean).join(' ')
      const shiftLane = scheduleToLane(r[`${SCHEDULE}.work_schedule`], startTime)

      let defaultLane
      if (isCal) {
        const savedLane = dockAssignments.get(id)
        if (savedLane) {
          const side = savedLane.startsWith('side35') ? 'side35' : 'side12'
          defaultLane = `${side}_${shiftLane}`
        } else {
          defaultLane = cal2FallbackLane(fullName, shiftLane)
        }
      } else {
        defaultLane = shiftLane
      }

      return {
        id, name: fullName, role: null,
        job_code: String(r[`${SCHEDULE}.default_job_code`] ?? ''),
        default_lane: defaultLane,
        shift_start: normalizeShiftStart(startTime),
        shift_hours: computeShiftHours(startTime, endTime),
        facility: facilityId,
      }
    })
}

async function fetchB2eRoster(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []
  const isCal = facilityId === 'cal'
  const dockAssignments = isCal ? await fetchCal2DockAssignments() : new Map()

  const [todayRoster, priorNightRoster] = await Promise.all([
    fetchB2eRosterForEntryDate(facilityId, date, isCal, dockAssignments),
    fetchB2eRosterForEntryDate(facilityId, prevDayISO(date), isCal, dockAssignments).catch(() => []),
  ])

  const carryovers = priorNightRoster
    .filter(e => {
      if (e.shift_start == null || e.shift_hours == null) return false
      const linearEnd = Number(e.shift_start) + Number(e.shift_hours)
      return linearEnd > 24 + 5
    })
    .map(e => ({ ...e, originalId: e.id, id: `${e.id}${CARRYOVER_ID_SUFFIX}`, is_carryover: true }))

  return [...todayRoster, ...carryovers]
}

// ── Labor calc math (ported from src/lib/laborCalc.js) ──────────────────

const SHIFT_DEFAULTS = {
  shift1: { start: 5, hours: 8 }, mid: { start: 9, hours: 8 },
  shift2: { start: 13, hours: 8 }, shift3: { start: 22, hours: 8 },
}
const LANE_TO_SHIFT = {
  shift1: 'shift1', mid: 'mid', shift2: 'shift2', shift3: 'shift3',
  side12_shift1: 'shift1', side12_mid: 'mid', side12_shift2: 'shift2', side12_shift3: 'shift3',
  side35_shift1: 'shift1', side35_mid: 'mid', side35_shift2: 'shift2', side35_shift3: 'shift3',
}
const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]
const OP_DAY_START = 5
const OP_DAY_END_LINEAR = 24 + OP_DAY_START

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

function resolveEmployeeShift(emp, laneMap, assignmentMap, laneFilter) {
  const assignment = assignmentMap?.[emp.id]
  if (assignment?.on_loan_to) return null

  const lane = laneMap[emp.id] || emp.default_lane || 'shift1'
  if (laneFilter && !laneFilter.has(lane)) return null

  const shiftKey = LANE_TO_SHIFT[lane]
  if (!shiftKey) return null

  const shiftDefaults = SHIFT_DEFAULTS[shiftKey]
  const rawStart = assignment?.shift_start ?? emp.shift_start
  const rawHours = assignment?.shift_hours ?? emp.shift_hours
  if (rawStart == null && rawHours == null) return null

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
    return { resolvedStart: OP_DAY_START, resolvedHours: tailHours, lane, rawStartDecimal: OP_DAY_START, realShiftStart: realDecimal, isCarryover: true }
  }

  if (realStart < OP_DAY_START) return null
  return { resolvedStart: realStart, resolvedHours: realHours, lane, rawStartDecimal: realDecimal, realShiftStart: realDecimal, isCarryover: false }
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

    const breakIdxOffset = isCarryover ? Math.floor((OP_DAY_START + 24) - realShiftStart) : 0

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

  return hourlyAvail.map(v => Math.round(v * 10) / 10)
}

function buildEmployeesFromAssignments(facility, assignments, carryovers) {
  const emps = assignments.filter(a => !a.is_temp).map(a => ({
    id: a.employee_id, name: a.employee_name, role: a.role || null, facility, is_temp: false, default_lane: a.lane,
  }))
  const tempEmps = assignments.filter(a => a.is_temp).map(a => ({
    id: a.employee_id, name: a.employee_name, role: a.role || 'Temp', facility, is_temp: true, default_lane: a.lane,
  }))
  const carryoverEmps = carryovers.map(c => ({
    id: c.id, originalId: c.originalId, name: c.name, role: c.role, facility, is_temp: false, is_carryover: true,
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
      facility, employee_id: c.id, employee_name: c.name, role: c.role, lane: c.default_lane,
      plan_date: null, is_temp: false, shift_start: c.shift_start, shift_hours: c.shift_hours, is_carryover: true,
    }
  }
  return { employees, laneMap, assignmentMap }
}

// ── Supabase data fetchers (mirrors src/lib/supabase.js) ────────────────

async function fetchTodayAssignments(facility, planDate) {
  if (!supabase) return []
  const data = await sbFetch(`roster_assignments?facility=eq.${facility}&plan_date=eq.${planDate}`)
  return data || []
}

async function fetchEmployeeBreaks(facility) {
  const data = await sbFetch(`employee_breaks?facility=eq.${facility}`)
  const map = new Map()
  for (const row of data || []) {
    map.set(String(row.employee_id), {
      first_break_at: Number(row.first_break_at), first_break_minutes: Number(row.first_break_minutes),
      lunch_at: Number(row.lunch_at), lunch_minutes: Number(row.lunch_minutes),
      second_break_at: Number(row.second_break_at), second_break_minutes: Number(row.second_break_minutes),
    })
  }
  return map
}

async function fetchFacilitySettings(facility) {
  const data = await sbFetch(`facility_settings?facility=eq.${facility}`)
  return (data && data[0]) || { hours_per_appt: 1.5 }
}

async function fetchProjectLaborAssumptions(facility) {
  const data = await sbFetch(`project_labor_assumptions?facility=eq.${facility}&select=project_name,hours_per_appt`)
  const map = new Map()
  for (const row of data || []) map.set(row.project_name, Number(row.hours_per_appt))
  return map
}

async function fetchProjectHourlyDrops(facility, planDate) {
  const data = await sbFetch(`project_hourly_drops_forecast?facility=eq.${facility}&plan_date=eq.${planDate}&select=project_name,hour,est_drops,manually_edited`)
  const result = {}
  for (const r of data || []) {
    if (!result[r.project_name]) result[r.project_name] = {}
    result[r.project_name][r.hour] = { est_drops: Number(r.est_drops), manually_edited: r.manually_edited ?? false }
  }
  return result
}

async function fetchHourlyAdjustments(facility, planDate) {
  const data = await sbFetch(`hourly_labor_adjustments?facility=eq.${facility}&plan_date=eq.${planDate}&select=hour,adjustment`)
  return Object.fromEntries((data || []).map(r => [r.hour, r.adjustment]))
}

// ── Omni-equivalent fetchers (mirrors motherduck-appointments.cjs callers) ─

async function fetchHourlyAppointments(facilityId, date) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/motherduck-appointments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'hourMap', facilityId, date }),
  })
  if (!res.ok) return {}
  const { hourMap } = await res.json()
  return hourMap ?? {}
}

async function fetchProjectHourlyAppointments(facilityId, date, projectNames) {
  if (!projectNames?.length) return {}
  const res = await fetch(`${SITE_URL}/.netlify/functions/motherduck-appointments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'projectHourly', facilityId, date, projectNames }),
  })
  if (!res.ok) return {}
  const { hourMap } = await res.json()
  return hourMap ?? {}
}

// Project-name normalization (KEN Fair Oaks/Birchwood/BossBites Omni-name
// merges) — ported from src/lib/omni.js's normalizeProjectName. Empty for
// CAL (CUSTOM_OMNI_NAME_MAPS is currently empty in the client too).
const KEN_OMNI_NAME_MAP = new Map([
  ['FAIR OAKS FARMS', 'Fair Oaks Farms'], ['FAIR OAKS FARMS WEST', 'Fair Oaks Farms'],
  ['BIRCHWOOD FOODS  KENOSHA', 'Birchwood Foods Kenosha'],
  ['BOSSB5', 'BossBites'],
])
function normalizeProjectName(facilityId, rawName) {
  if (facilityId === 'ken' && KEN_OMNI_NAME_MAP.has(rawName)) return KEN_OMNI_NAME_MAP.get(rawName)
  return rawName
}
function classifyApptType(typeName) {
  const t = (typeName || '').toLowerCase()
  if (t.startsWith('inbound')) return 'inbound'
  if (t.startsWith('outbound')) return 'outbound'
  return null
}

async function fetchProjectData(facilityId, date) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/motherduck-appointments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'projectData', facilityId, date }),
  })
  if (!res.ok) return []
  const { projects } = await res.json()
  const projectMap = new Map()
  for (const r of projects || []) {
    const rawName = r.project_name || ''
    if (!rawName) continue
    const name = normalizeProjectName(facilityId, rawName)
    const dir = classifyApptType(r.dock_appointment_type_name)
    const count = Number(r.count) || 0
    if (!projectMap.has(name)) projectMap.set(name, { name, inb: 0, out: 0 })
    const p = projectMap.get(name)
    if (dir === 'inbound') p.inb += count
    if (dir === 'outbound') p.out += count
  }
  return [...projectMap.values()]
}

// ── Per-day computations (mirrors src/lib/weeklyLabor.js) ───────────────

async function computeDayAvail(facilityId, date, settings, breaksMap) {
  const [assignments, b2eRosterFull] = await Promise.all([
    fetchTodayAssignments(facilityId, date),
    fetchB2eRoster(facilityId, date).catch(() => []),
  ])
  if (assignments.length === 0) return null
  const carryovers = b2eRosterFull.filter(e => e.is_carryover)
  const { employees, laneMap, assignmentMap } = buildEmployeesFromAssignments(facilityId, assignments, carryovers)
  const hourlyAvail = buildRosterAvailability(employees, laneMap, settings, assignmentMap, null, breaksMap)
  return Math.round(hourlyAvail.reduce((s, v) => s + v, 0) * 10) / 10
}

async function computeDayReq(facilityId, date, settings, projectHpa) {
  const defaultHpa = settings?.hours_per_appt ?? 1.5
  const hasOverrides = projectHpa.size > 0

  const dayProjects = await fetchProjectData(facilityId, date).catch(() => [])
  const dayProjectNames = dayProjects.map(p => p.name)
  const overrideNames = hasOverrides ? [...new Set([...dayProjectNames, ...projectHpa.keys()])] : []

  const [hourlyAppts, projectHourlyDrops, perProjectHourly] = await Promise.all([
    fetchHourlyAppointments(facilityId, date).catch(() => ({})),
    fetchProjectHourlyDrops(facilityId, date).catch(() => ({})),
    hasOverrides ? fetchProjectHourlyAppointments(facilityId, date, overrideNames).catch(() => ({})) : Promise.resolve({}),
  ])

  const estDropsByHour = {}
  for (const hourMap of Object.values(projectHourlyDrops)) {
    for (const [h, v] of Object.entries(hourMap)) {
      const val = typeof v === 'object' ? (v?.est_drops ?? 0) : Number(v ?? 0)
      estDropsByHour[h] = (estDropsByHour[h] ?? 0) + val
    }
  }

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
  return Math.round(totalReq * 10) / 10
}

async function computeDayAdj(facilityId, date) {
  const adj = await fetchHourlyAdjustments(facilityId, date).catch(() => ({}))
  return Object.values(adj).reduce((s, v) => s + Number(v || 0), 0)
}

// ── Week assembly + digest body ─────────────────────────────────────────

async function computeWeek(facilityId, mondayISO) {
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysISO(mondayISO, i))
  const [settings, breaksMap, projectHpa] = await Promise.all([
    fetchFacilitySettings(facilityId),
    fetchEmployeeBreaks(facilityId),
    fetchProjectLaborAssumptions(facilityId),
  ])

  const days = await Promise.all(weekDays.map(async (date) => {
    const [avail, reqHours, totalAdj] = await Promise.all([
      computeDayAvail(facilityId, date, settings, breaksMap).catch(() => null),
      computeDayReq(facilityId, date, settings, projectHpa).catch(() => null),
      computeDayAdj(facilityId, date).catch(() => 0),
    ])
    if (avail == null || reqHours == null) return { date, delta: null }
    const availAfterAdj = Math.round((avail + totalAdj) * 10) / 10
    const delta = Math.round((availAfterAdj - reqHours) * 10) / 10
    return { date, avail, reqHours, totalAdj, availAfterAdj, delta }
  }))

  return { weekDays, days }
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function fmtDelta(n) {
  if (n == null) return '—'
  return `${n > 0 ? '+' : ''}${n}`
}

function buildDigestBody(facilityId, mondayISO, week) {
  const lines = []
  lines.push(`${FACILITY_LABELS[facilityId] || facilityId} — Labor Daily +/- After Adj (${formatMDD(mondayISO)}–${formatMDD(addDaysISO(mondayISO, 6))}):`)
  lines.push('')
  week.days.forEach((d, i) => {
    lines.push(`${DAY_LABELS[i]} ${formatMDD(d.date)}: ${fmtDelta(d.delta)}`)
  })
  return lines.join('\n')
}

// ── Duplicate-send guard (round 2) ──────────────────────────────────────
//
// 2026-08-04: Dan reported the digest posting the SAME message twice, at
// the same timestamp, for both CAL and KEN. First fix: a conditional
// PATCH on prepick_notify_settings.last_sent_date, scoped to rows where
// it wasn't already today (relying on Postgres re-checking the WHERE
// clause after a concurrent UPDATE's lock releases — standard, documented
// READ COMMITTED behavior).
//
// 2026-08-05: it happened again — KEN posted twice, CAL three times,
// seconds apart (12:15:31/:43 for KEN; 12:15:44/:54/:55 for CAL),
// nearly a full day after the first fix had deployed (confirmed via
// commit timestamp vs. incident timestamp), so this wasn't a stale-
// deploy issue. Without Netlify invocation logs to inspect, the exact
// failure mode of the conditional-PATCH approach is unconfirmed — it
// may be correct and something upstream (multiple near-simultaneous
// scheduled invocations, Netlify's "at least once" delivery) is
// triggering a genuinely large number of concurrent claim attempts in
// a way that exposes a subtlety this file's author didn't anticipate.
//
// Rather than keep relying on an approach whose failure mode is
// unproven, claimSendSlot() now uses an INSERT into a dedicated table
// (weekly_labor_digest_sends, PRIMARY KEY (facility, plan_date)) with
// `Prefer: resolution=ignore-duplicates` (= `ON CONFLICT DO NOTHING`).
// This is unconditional: Postgres enforces the unique constraint with
// zero ambiguity regardless of how many concurrent INSERTs race for the
// same key — DO NOTHING rows are never returned by RETURNING, so
// `rows.length > 0` unambiguously means "I am the exclusive winner for
// this (facility, day)." There is no WHERE-clause re-evaluation subtlety
// to get wrong here; a unique-constraint violation is not negotiable.
//
// Only the SCHEDULED path (weekly-labor-digest-run.cjs) claims a slot.
// The manual test path (weekly-labor-digest-test.cjs) intentionally
// ignores this guard entirely and always sends on click — that's its
// whole point, not a bug.

async function claimSendSlot(facilityId, today) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_labor_digest_sends`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=ignore-duplicates',
    },
    body: JSON.stringify({ facility: facilityId, plan_date: today }),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
  const rows = await res.json()
  return rows.length > 0
}

// ── Post to Front ─────────────────────────────────────────────────────

async function postDigest({ facilityId, conversationId, mondayISO }) {
  const week = await computeWeek(facilityId, mondayISO)
  const body = buildDigestBody(facilityId, mondayISO, week)

  const frontRes = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const frontText = await frontRes.text()
  let frontJson
  try { frontJson = JSON.parse(frontText) } catch { frontJson = { raw: frontText } }
  if (!frontRes.ok) return { ok: false, reason: 'Front API error posting comment', detail: frontJson }

  return { ok: true, date: mondayISO, conversationId, commentId: frontJson.id }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FACILITIES, FACILITY_LABELS,
  sbFetch, sbPatch,
  centralNowParts, centralTodayISO, isNotifyTimeMatch, isoWeekdayOf, mondayOfISO,
  computeWeek, buildDigestBody, claimSendSlot, postDigest,
}
