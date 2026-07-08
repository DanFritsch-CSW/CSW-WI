// Omni Analytics API helpers
// Calls /.netlify/functions/omni-query (server-side proxy) to avoid CORS.
// Auth: OMNI_API_KEY env var set in Netlify dashboard.

import { supabase } from './supabase.js'
import {
  fetchCustomDropProjects,
  fetchHistoricalDropsCache,
  writeHistoricalDropsCache,
} from './supabase.js'

const MODEL_ID = '79a98af2-a904-4b5d-b25f-7f6a2c7ef467'

const LABOR_WAREHOUSE = {
  cal:  'franksville',
  mad:  'madison',
  ken:  'kenosha',
  wr:   'wisconsin rapids',
  ec:   'eau claire',
}

const CSW_WAREHOUSE = {
  cal:  'CSW-Franksville',
  mad:  'CSW-Madison',
  ken:  'CSW-Kenosha',
  wr:   'CSW-Wisconsin Rapids',
  ec:   'CSW-Eau Claire',
}

const WAREHOUSE_TO_FAC = {
  franksville:        'cal',
  madison:            'mad',
  kenosha:            'ken',
  'wisconsin rapids': 'wr',
  'eau claire':       'ec',
}
const CSW_WAREHOUSE_TO_FAC = {
  'CSW-Franksville':      'cal',
  'CSW-Madison':          'mad',
  'CSW-Kenosha':          'ken',
  'CSW-Wisconsin Rapids': 'wr',
  'CSW-Eau Claire':       'ec',
}

const VIEW_H        = 'labor_planning_app__hourly_labor_required_vs_available'
const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_APPT     = 'gold__truck_appointments'
const VIEW_LP       = 'silver__datex_slv_licenseplates'
const VIEW_LP_WH    = 'silver__datex_slv_warehouses'
const VIEW_LP_PROJ  = 'silver__datex_slv_projects'

// ── Appointments source: MotherDuck ─────────────────────────────────────
// Appointment data comes from /.netlify/functions/motherduck-appointments,
// which queries production_db.gold.truck_appointments directly. This is
// deliberately not routed through Omni's gold__truck_appointments view —
// that view lags the underlying gold layer by hours, which caused the
// "created 6h ago but still not showing" class of complaint. MotherDuck
// gold is refreshed on the source pipeline cadence.
//
// The four public fetchers below (fetchHourlyAppointments, fetchProjectData,
// fetchAppointmentList, fetchProjectHourlyAppointments) all go through
// this proxy. Signatures and return shapes are unchanged from the previous
// Omni implementations — no callers need to change.
//
// Requires MOTHERDUCK_TOKEN env var in Netlify (already present for
// motherduck-labor.cjs and motherduck-l4w.cjs).

async function mdAppointmentsQuery(body) {
  const res = await fetch('/.netlify/functions/motherduck-appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let err = {}
    try { err = await res.json() } catch { /* non-json */ }
    throw new Error(err.error || `motherduck-appointments ${res.status}`)
  }
  return res.json()
}

// Suffix appended to carryover employee IDs to distinguish them from the
// same employee's normal entry when they work back-to-back overnight shifts.
// Surface-checked by RosterBoard, EmployeeTile, and laborCalc via the
// is_carryover flag — this suffix is just a unique React key.
export const CARRYOVER_ID_SUFFIX = '__carryover'

function classifyApptType(typeName) {
  const t = (typeName || '').toLowerCase()
  if (t.startsWith('inbound'))  return 'inbound'
  if (t.startsWith('outbound')) return 'outbound'
  return null
}

function apptStatusFilter() {
  return {
    [`${VIEW_APPT}.dock_status_name`]: {
      kind: 'EQUALS',
      type: 'string',
      values: ['Cancelled'],
      is_negative: true,
    },
  }
}

// HOLD appointments are PRESERVED in labor demand, EST drops, and the
// appointment list — explicit product decision per Kay Martin (KEN) and Dean
// Dioguardi on 2026-05-27. Warehouse managers create placeholder HOLDs in
// Datex as capacity reservations; ~99% of them convert to real appointments
// 12–24 hours before showtime (e.g. Richelieu Raw routinely requests 1–3
// reloads by 6pm same-day). Excluding them caused understaffing. Kay's daily
// process is to cancel any HOLD that goes unused — that's the control
// mechanism, not a code filter. See 2026-05-27 Slack thread + changelog.

const OVERNIGHT_HOURS = new Set([0, 1, 2, 3, 4])

// ── US observed holidays — sampled L4W dates that fall on these days are
// SKIPPED and replaced by walking further back, so e.g. Memorial Day Monday
// doesn't drag down a typical Monday's drop average to zero.
//
// Federal holidays observed by most freight customers / 3PL operations:
//   New Year's Day        — Jan 1   (observed on adjacent weekday if weekend)
//   MLK Day               — 3rd Monday of January
//   Presidents Day        — 3rd Monday of February
//   Memorial Day          — last Monday of May
//   Juneteenth            — Jun 19
//   Independence Day      — Jul 4
//   Labor Day             — 1st Monday of September
//   Thanksgiving          — 4th Thursday of November
//   Day after Thanksgiving — Friday following Thanksgiving (most facilities closed)
//   Christmas             — Dec 25
//   New Year's Eve        — Dec 31 (many customers run reduced schedules)
//
// This is intentionally conservative — we'd rather walk back one extra week
// than count a half-empty holiday day toward the L4W average.
function getObservedHolidayDates(year) {
  const dates = new Set()

  // Fixed-date holidays (observed on weekday-adjusted dates when they fall on a weekend)
  const fixedDates = [
    { month: 1,  day: 1  }, // New Year's Day
    { month: 6,  day: 19 }, // Juneteenth
    { month: 7,  day: 4  }, // Independence Day
    { month: 12, day: 24 }, // Christmas Eve (often half-day)
    { month: 12, day: 25 }, // Christmas
    { month: 12, day: 31 }, // NYE
  ]
  for (const { month, day } of fixedDates) {
    const d = new Date(Date.UTC(year, month - 1, day))
    dates.add(d.toISOString().slice(0, 10))
    // Also add the observed-on date if it falls on a weekend
    const dow = d.getUTCDay()
    if (dow === 0) { // Sunday → observed Monday
      const obs = new Date(d); obs.setUTCDate(d.getUTCDate() + 1)
      dates.add(obs.toISOString().slice(0, 10))
    } else if (dow === 6) { // Saturday → observed Friday
      const obs = new Date(d); obs.setUTCDate(d.getUTCDate() - 1)
      dates.add(obs.toISOString().slice(0, 10))
    }
  }

  // Nth-weekday-of-month holidays
  // Helper: get the date of the Nth occurrence of weekday (0=Sun..6=Sat) in given month
  function nthWeekdayOfMonth(year, month, weekday, n) {
    const first = new Date(Date.UTC(year, month - 1, 1))
    const offset = (weekday - first.getUTCDay() + 7) % 7
    const day = 1 + offset + (n - 1) * 7
    return new Date(Date.UTC(year, month - 1, day))
  }
  // Helper: get the LAST occurrence of weekday in given month
  function lastWeekdayOfMonth(year, month, weekday) {
    const last = new Date(Date.UTC(year, month, 0)) // last day of month
    const offset = (last.getUTCDay() - weekday + 7) % 7
    return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset))
  }

  dates.add(nthWeekdayOfMonth(year, 1,  1, 3).toISOString().slice(0, 10)) // MLK: 3rd Mon Jan
  dates.add(nthWeekdayOfMonth(year, 2,  1, 3).toISOString().slice(0, 10)) // Presidents: 3rd Mon Feb
  dates.add(lastWeekdayOfMonth(year, 5, 1).toISOString().slice(0, 10))    // Memorial: last Mon May
  dates.add(nthWeekdayOfMonth(year, 9,  1, 1).toISOString().slice(0, 10)) // Labor: 1st Mon Sep
  const thx = nthWeekdayOfMonth(year, 11, 4, 4)                            // Thanksgiving: 4th Thu Nov
  dates.add(thx.toISOString().slice(0, 10))
  const dayAfterThx = new Date(thx); dayAfterThx.setUTCDate(thx.getUTCDate() + 1)
  dates.add(dayAfterThx.toISOString().slice(0, 10))                        // Day after Thanksgiving

  return dates
}

// Cache holidays per year so we don't recompute on every L4W lookup.
const HOLIDAY_CACHE = new Map()
function isObservedHoliday(isoDate) {
  const year = parseInt(isoDate.slice(0, 4), 10)
  if (!HOLIDAY_CACHE.has(year)) HOLIDAY_CACHE.set(year, getObservedHolidayDates(year))
  return HOLIDAY_CACHE.get(year).has(isoDate)
}

/**
 * Build a list of N valid same-weekday past dates for L4W sampling.
 *
 * Walks back week-by-week from targetDate, skipping any date that is:
 *   - Strictly in the future (relative to "now") — Datex/Omni won't have
 *     real appointment data for those days yet; counting them drags the
 *     average to zero.
 *   - A US observed holiday (Memorial Day, July 4, Thanksgiving, etc.) —
 *     reduced/skeleton operations distort the typical-weekday average.
 *
 * If we can't find `count` valid dates within `maxLookback` weeks, returns
 * whatever we found (caller should still average over `count` so a partial
 * sample window scales down naturally).
 */
export function buildValidPastDates(targetDate, count = 4, maxLookback = 12) {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')
  const todayIso = new Date().toISOString().slice(0, 10)
  const valid = []
  const skipped = []
  for (let i = 1; i <= maxLookback && valid.length < count; i++) {
    const d = new Date(base.getTime() - i * MS_PER_WEEK)
    const iso = d.toISOString().slice(0, 10)
    if (iso >= todayIso) { skipped.push(`${iso} (future)`); continue }
    if (isObservedHoliday(iso)) { skipped.push(`${iso} (holiday)`); continue }
    valid.push(iso)
  }
  if (skipped.length) {
    console.debug(`L4W sampling for ${targetDate}: using ${valid.join(', ')} | skipped ${skipped.join(', ')}`)
  }
  return valid
}

function nextDayISO(date) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function prevDayISO(date) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function scheduledArrivalDateFilter(date) {
  return {
    [`${VIEW_APPT}.scheduled_arrival`]: {
      kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
      isFiscal: false, left_side: date, is_negative: false,
      offset_interval_string: '0 days',
    },
  }
}

export const KEN_GUARANTEED_PROJECTS = [
  'CROWN BAKERIES',
  'Pretzilla Kenosha',
  'Birchwood Foods Kenosha',
  'Fair Oaks Farms',
  'RICHELIEU KENOSHA',
  'RICHELIEU RAW MATERIALS KENOSHA',
  'BossBites',
]

const FAIR_OAKS_OMNI_NAMES  = ['FAIR OAKS FARMS', 'FAIR OAKS FARMS WEST']
const BIRCHWOOD_OMNI_NAMES  = ['BIRCHWOOD FOODS  KENOSHA']
const BOSSBITES_OMNI_NAMES  = ['BOSSB5']

const KEN_OMNI_NAME_MAP = new Map([
  ...FAIR_OAKS_OMNI_NAMES.map(n => [n, 'Fair Oaks Farms']),
  ...BIRCHWOOD_OMNI_NAMES.map(n => [n, 'Birchwood Foods Kenosha']),
  ...BOSSBITES_OMNI_NAMES.map(n => [n, 'BossBites']),
])

const CUSTOM_OMNI_NAME_MAPS = {}

export const PROJECT_DROP_RULES = {
  'Palermos CALEDONIA finished': {
    facility: 'cal',
    method: 'inbound_exclude_lookup',
    excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']],
  },
  'CROWN BAKERIES':    { facility: 'ken', method: 'inbound_all' },
  'Pretzilla Kenosha': { facility: 'ken', method: 'inbound_all' },
  'Birchwood Foods Kenosha': {
    facility: 'ken',
    method: 'inbound_all_merged',
    omniNames: BIRCHWOOD_OMNI_NAMES,
  },
  'Fair Oaks Farms': {
    facility: 'ken',
    method: 'inbound_all_merged',
    omniNames: FAIR_OAKS_OMNI_NAMES,
  },
  'RICHELIEU KENOSHA':               { facility: 'ken', method: 'inbound_include_lookup', includePatterns: ['TOP', 'PSH'] },
  'RICHELIEU RAW MATERIALS KENOSHA': { facility: 'ken', method: 'inbound_include_lookup', includePatterns: ['TOP', 'PSH'] },
  'BossBites': {
    facility: 'ken',
    method: 'inbound_all_merged',
    omniNames: BOSSBITES_OMNI_NAMES,
  },
}

const CUSTOM_DROP_RULES_CACHE = {}

export async function loadCustomDropRules(facilityId) {
  const rows = await fetchCustomDropProjects(facilityId)
  CUSTOM_DROP_RULES_CACHE[facilityId] = rows
  if (!CUSTOM_OMNI_NAME_MAPS[facilityId]) CUSTOM_OMNI_NAME_MAPS[facilityId] = new Map()
  for (const row of rows) {
    CUSTOM_OMNI_NAME_MAPS[facilityId].set(row.omni_name, row.project_name)
    if (!PROJECT_DROP_RULES[row.project_name]) {
      PROJECT_DROP_RULES[row.project_name] = {
        facility: facilityId,
        method: 'inbound_all_merged',
        omniNames: [row.omni_name],
      }
    }
  }
  return rows
}

export function getCustomDropProjects(facilityId) {
  return CUSTOM_DROP_RULES_CACHE[facilityId] ?? []
}

function normalizeProjectName(facilityId, rawName) {
  if (CUSTOM_OMNI_NAME_MAPS[facilityId]?.has(rawName)) {
    return CUSTOM_OMNI_NAME_MAPS[facilityId].get(rawName)
  }
  if (facilityId === 'ken' && KEN_OMNI_NAME_MAP.has(rawName)) {
    return KEN_OMNI_NAME_MAP.get(rawName)
  }
  return rawName
}

export function isRuleProject(facilityId, projectName) {
  const rule = PROJECT_DROP_RULES[projectName]
  if (rule) return rule.facility === facilityId
  const custom = CUSTOM_DROP_RULES_CACHE[facilityId] ?? []
  return custom.some(r => r.project_name === projectName)
}

const B2E_MODEL_ID = 'f3aaca97-bb7c-405d-809b-efab83649ab3'
const ROSTER       = 'silver__b2e_slv_employeeroster'
const SCHEDULE     = 'silver__b2e_slv_futurescheduleentries'
const TIME_OFF     = 'silver__b2e_slv_futuretimeoff'

const B2E_LOCATION = {
  cal:  '019 - Caledonia',
  mad:  '011 - Madison',
  ec:   '012 - Eau Claire',
  ken:  '015 - Kenosha',
  wr:   '023 - Wisconsin Rapids',
}

const ALLOWED_JOB_CODES = new Set(['205'])

const CAL2_DOCK_NAMES_35 = new Set([
  'Calvieon Howard', 'Ethan Lindsey', 'Jose Cuevas', 'Nicholas J. Free',
  'Nicholas Free', 'Zarious Brinner', 'Juan Bido', 'Eduardo Ramon',
])

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
      if (hour < 10)  return 'shift1'
      if (hour < 14)  return 'mid'
      if (hour < 20)  return 'shift2'
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
    const ap  = m[3]
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

export function redistributeToIntegers(hourMap) {
  const entries = Object.entries(hourMap)
    .map(([h, v]) => ({ hour: Number(h), raw: Number(v) || 0 }))
    .filter(e => e.raw > 0)

  if (entries.length === 0) return {}

  const targetTotal = Math.round(entries.reduce((s, e) => s + e.raw, 0))
  if (targetTotal === 0) return {}

  entries.forEach(e => { e.floor = Math.floor(e.raw); e.frac = e.raw - e.floor })

  const floorSum = entries.reduce((s, e) => s + e.floor, 0)
  let remainder = targetTotal - floorSum

  const ranked = [...entries].sort((a, b) => b.frac - a.frac || a.hour - b.hour)

  const result = {}
  for (const e of entries) result[e.hour] = e.floor
  for (const e of ranked) {
    if (remainder <= 0) break
    result[e.hour] += 1
    remainder -= 1
  }

  return Object.fromEntries(Object.entries(result).filter(([, v]) => v > 0))
}

function computeShiftHours(startTime, endTime) {
  const sh = parseB2eTime(startTime)
  const eh = parseB2eTime(endTime)
  if (sh == null || eh == null) return null
  const hours = (eh - sh + 24) % 24
  return hours > 0 ? Math.round(hours * 2) / 2 : null
}

// Custom error class — lets callers distinguish Omni timeouts from other failures
// and short-circuit retry storms (e.g. if KEN historical drops timeouts, don't keep
// retrying every other Omni call too).
export class OmniQueryError extends Error {
  constructor(message, { status, timedOut, reason } = {}) {
    super(message)
    this.name     = 'OmniQueryError'
    this.status   = status   ?? null
    this.timedOut = timedOut ?? false
    this.reason   = reason   ?? null
  }
}

async function omniQuery(query) {
  let res
  try {
    res = await fetch('/.netlify/functions/omni-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { version: 5, ...query } }),
    })
  } catch (e) {
    throw new OmniQueryError(`Network error reaching omni-query: ${e.message}`, { status: 0 })
  }

  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new OmniQueryError(
      body.error || `omni-query ${res.status}`,
      { status: res.status, timedOut: body.timedOut === true, reason: body.reason }
    )
  }

  const { rows } = await res.json()
  return rows
}


// motherduckB2eQuery — same fetch surface as omniQuery but hits the
// MotherDuck-direct B2E roster function. Used for all B2E roster/
// schedule reads (2026-07-08 pivot) so the app doesn't depend on
// Omni's B2E model, which returned empty rows twice this week for
// KEN queries where MotherDuck ground truth had the data. See
// netlify/functions/motherduck-b2e-roster.cjs for the server side.
//
// Rows come back with Omni-qualified column names (SCHEDULE.field,
// ROSTER.field) so downstream stale-snapshot + filter + lane
// derivation logic runs unchanged.
async function motherduckB2eQuery(payload) {
  let res
  try {
    res = await fetch('/.netlify/functions/motherduck-b2e-roster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    throw new OmniQueryError(`Network error reaching motherduck-b2e-roster: ${e.message}`, { status: 0 })
  }
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new OmniQueryError(
      body.error || `motherduck-b2e-roster ${res.status}`,
      { status: res.status }
    )
  }
  const { rows } = await res.json()
  return rows
}

function activityDateFilter(date, view = VIEW_H) {
  return {
    [`${view}.activity_date`]: {
      kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
      isFiscal: false, left_side: date, is_negative: false,
      offset_interval_string: '0 days',
    },
  }
}

function tsToHour(ts) {
  if (typeof ts === 'number') return new Date(ts > 1e12 ? ts / 1000 : ts).getUTCHours()
  if (typeof ts === 'string') { const m = ts.match(/[T ](\d{2}):/); return m ? parseInt(m[1]) : 0 }
  return 0
}

const CSW_NAME_SUFFIXES = [
  ' - CSW-Madison', ' - CSW-Franksville', ' - CSW-Kenosha',
  ' - CSW-Wisconsin Rapids', ' - CSW-Eau Claire', '-CSW-Madison', ' - Madison',
]

function stripWarehouseSuffix(name) {
  if (!name) return name
  for (const suffix of CSW_NAME_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name
}

// ── Public API ───────────────────────────────────────────────────────────────────────────

export async function fetchHourlyData(facilityId, date) {
  const wh = LABOR_WAREHOUSE[facilityId]
  if (!wh) return []
  const rows = await omniQuery({
    modelId: MODEL_ID,
    table: VIEW_H,
    fields: [
      `${VIEW_H}.hour_of_day_timestamp`,
      `${VIEW_H}.labor_required`,
      `${VIEW_H}.labor_available_aw_update_`,
    ],
    filters: {
      [`${VIEW_H}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_H}.labor_shift_timestamp`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false,
        offset_interval_string: '0 days',
      },
    },
    sorts: [{ column_name: `${VIEW_H}.hour_of_day_timestamp`, sort_descending: false }],
    limit: 100,
  })
  return rows.map(r => ({
    h:     tsToHour(r[`${VIEW_H}.hour_of_day_timestamp`]),
    req:   Number(r[`${VIEW_H}.labor_required`]) || 0,
    avail: Number(r[`${VIEW_H}.labor_available_aw_update_`]) || 0,
    inb: 0, out: 0, drops: 0, appts: 0,
  }))
}

// ── KEN v2 / Diagnostic Mirror ──────────────────────────────────────────────────────────────────
//
// Mirrors the Omni dashboard table for KEN v2. Queries ALL columns from
// hourly_labor_required_vs_available using activity_date (a real base column),
// then client-side filters to the 5am→5am operational window — replicating
// exactly what Omni's labor_shift_timestamp virtual field does in the dashboard SQL.
//
// Two queries: activity_date = date (hours 5-23) + activity_date = nextDay (hours 0-4).
// Returns all columns: raw_staffed, adj_staffed, breaks, wh_adj, labor_avail,
// labor_avail_aw, labor_req, inb, out, drops, total_appts.
export async function fetchOmniLaborFullRow(facilityId, date) {
  const wh = LABOR_WAREHOUSE[facilityId]
  if (!wh) return []

  const FIELDS = [
    `${VIEW_H}.hour_of_day_timestamp`,
    `${VIEW_H}.raw_staffed_employee`,
    `${VIEW_H}.adjusted_staffed_employee`,
    `${VIEW_H}.employees_on_break`,
    `${VIEW_H}.warehouse_labor_adjustment`,
    `${VIEW_H}.labor_available`,
    `${VIEW_H}.labor_available_aw_update_`,
    `${VIEW_H}.labor_required`,
    `${VIEW_H}.inbound_count`,
    `${VIEW_H}.outbound_count`,
    `${VIEW_H}.drops`,
    `${VIEW_H}.total_appointments`,
  ]

  const warehouseFilter = {
    [`${VIEW_H}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
  }

  // Fetch hours 5-23 from the target date, and hours 0-4 from the next day.
  // This replicates the labor_shift_timestamp 5am→5am window.
  const [dayRows, nextDayRows] = await Promise.all([
    omniQuery({
      modelId: MODEL_ID, table: VIEW_H, fields: FIELDS,
      filters: { ...warehouseFilter, ...activityDateFilter(date) },
      sorts: [{ column_name: `${VIEW_H}.hour_of_day_timestamp`, sort_descending: false }],
      limit: 100,
    }),
    omniQuery({
      modelId: MODEL_ID, table: VIEW_H, fields: FIELDS,
      filters: { ...warehouseFilter, ...activityDateFilter(nextDayISO(date)) },
      sorts: [{ column_name: `${VIEW_H}.hour_of_day_timestamp`, sort_descending: false }],
      limit: 100,
    }).catch(() => []),
  ])

  const parseRow = r => ({
    h:          tsToHour(r[`${VIEW_H}.hour_of_day_timestamp`]),
    rawStaffed: Number(r[`${VIEW_H}.raw_staffed_employee`])       || 0,
    adjStaffed: Number(r[`${VIEW_H}.adjusted_staffed_employee`])  || 0,
    breaks:     Number(r[`${VIEW_H}.employees_on_break`])         || 0,
    whAdj:      Number(r[`${VIEW_H}.warehouse_labor_adjustment`]) || 0,
    avail:      Number(r[`${VIEW_H}.labor_available`])            || 0,
    availAw:    Number(r[`${VIEW_H}.labor_available_aw_update_`]) || 0,
    req:        Number(r[`${VIEW_H}.labor_required`])             || 0,
    inb:        Number(r[`${VIEW_H}.inbound_count`])              || 0,
    out:        Number(r[`${VIEW_H}.outbound_count`])             || 0,
    drops:      Number(r[`${VIEW_H}.drops`])                      || 0,
    appts:      Number(r[`${VIEW_H}.total_appointments`])         || 0,
  })

  // Hours 5-23: from the target date
  const dayParsed = dayRows.map(parseRow).filter(r => r.h >= 5)
  // Hours 0-4: from the next day (the overnight tail of the operational day)
  const overnightParsed = nextDayRows.map(parseRow).filter(r => OVERNIGHT_HOURS.has(r.h))

  return [...dayParsed, ...overnightParsed]
    .sort((a, b) => {
      const sa = a.h < 5 ? a.h + 24 : a.h
      const sb = b.h < 5 ? b.h + 24 : b.h
      return sa - sb
    })
}

export async function fetchHourlyAppointments(facilityId, date) {
  const { hourMap } = await mdAppointmentsQuery({ mode: 'hourMap', facilityId, date })
  return hourMap ?? {}
}

export async function fetchProjectData(facilityId, date) {
  const resp = await mdAppointmentsQuery({ mode: 'projectData', facilityId, date })
  const rows = resp.projects ?? []
  const projectMap = new Map()
  for (const r of rows) {
    const rawName = r.project_name || ''
    if (!rawName) continue
    const name = normalizeProjectName(facilityId, rawName)
    const dir   = classifyApptType(r.dock_appointment_type_name)
    const count = Number(r.count) || 0
    if (!projectMap.has(name)) projectMap.set(name, { name, inb: 0, out: 0, drops: 0 })
    const p = projectMap.get(name)
    if (dir === 'inbound')  p.inb += count
    if (dir === 'outbound') p.out += count
  }
  return [...projectMap.values()]
    .map(p => ({ ...p, tot: p.inb + p.out + p.drops }))
    .filter(p => p.tot > 0)
    .sort((a, b) => b.tot - a.tot)
}

/**
 * Fetch row-level appointment list for a facility's operational day (5am→4:59am+1).
 * Backed by /.netlify/functions/motherduck-appointments, which queries
 * production_db.gold.truck_appointments directly.
 *
 * Excludes cancelled appointments. HOLD appointments ARE included — they
 * represent real capacity reservations that typically convert to bookings
 * 12–24h before arrival (per Kay/Dean 5/27). Kay cancels unused HOLDs daily
 * as her control.
 *
 * Returns an array of rows: { lookup_code, type, scheduled_arrival, project_name,
 *   carrier_name, notes }
 */
export async function fetchAppointmentList(facilityId, date) {
  const { rows } = await mdAppointmentsQuery({ mode: 'appointmentList', facilityId, date })
  return (rows ?? []).map(r => ({
    lookup_code:       r.lookup_code       || '',
    type:              classifyApptType(r.dock_appointment_type_name),
    scheduled_arrival: r.scheduled_arrival || null,
    project_name:      r.project_name      || '',
    carrier_name:      r.carrier_name      || '',
    notes:             r.notes             || '',
  }))
}

export async function fetchProjectHourlyAppointments(facilityId, date, projectNames) {
  if (!projectNames?.length) return {}
  const { hourMap } = await mdAppointmentsQuery({
    mode: 'projectHourly', facilityId, date, projectNames,
  })
  return hourMap ?? {}
}

// Session-level cache — project names change slowly; one load per page visit is enough.
let _knownProjectsCache = null

/**
 * Returns a Map of facility-id → sorted unique project names that have
 * had at least one appointment in the past `daysBack` days.
 *
 * Single Omni call. CAL split view (`cal2`) is rolled up into `cal`.
 * Returns empty Map on failure (does not throw).
 *
 * @param {number} daysBack - Lookback window in days. Default 30.
 * @returns {Promise<Map<string, string[]>>}
 */
export async function fetchKnownProjectsByFacility(daysBack = 30) {
  if (_knownProjectsCache) return _knownProjectsCache

  const today = new Date().toISOString().slice(0, 10)
  const startD = new Date(today + 'T00:00:00Z')
  startD.setUTCDate(startD.getUTCDate() - daysBack)
  const fromDate = startD.toISOString().slice(0, 10)

  let rows
  try {
    rows = await omniQuery({
      modelId: GOLD_MODEL_ID,
      table: VIEW_APPT,
      fields: [
        `${VIEW_APPT}.warehouse_name`,
        `${VIEW_APPT}.project_name`,
      ],
      filters: {
        // TIME_FOR_UNIT_DURATION with left_side = start date and offset = daysBack
        // gives a daysBack-day window. BETWEEN silently returns unfiltered on timestamps.
        [`${VIEW_APPT}.scheduled_arrival`]: {
          kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
          isFiscal: false, left_side: fromDate, is_negative: false,
          offset_interval_string: `${daysBack} days`,
        },
        ...apptStatusFilter(),
      },
      sorts: [
        { column_name: `${VIEW_APPT}.warehouse_name`, sort_descending: false },
        { column_name: `${VIEW_APPT}.project_name`,   sort_descending: false },
      ],
      limit: 2000,
    })
  } catch (err) {
    console.warn('fetchKnownProjectsByFacility failed', err)
    return new Map()
  }

  const byFac = new Map()
  for (const r of rows) {
    const wh  = r[`${VIEW_APPT}.warehouse_name`]
    const raw = r[`${VIEW_APPT}.project_name`]
    if (!wh || !raw) continue
    const facId = CSW_WAREHOUSE_TO_FAC[wh]
    if (!facId) continue
    const name = normalizeProjectName(facId, raw)
    if (!byFac.has(facId)) byFac.set(facId, new Set())
    byFac.get(facId).add(name)
  }

  // Convert sets to sorted arrays (cal2 is already merged into cal via CSW_WAREHOUSE_TO_FAC)
  const result = new Map(
    [...byFac.entries()].map(([facId, names]) => [
      facId,
      [...names].sort((a, b) => a.localeCompare(b)),
    ])
  )
  _knownProjectsCache = result
  return result
}

export async function fetchNetworkKpis(date) {
  const laborRows = await omniQuery({
    modelId: MODEL_ID,
    table: VIEW_H,
    fields: [
      `${VIEW_H}.warehouse_name`,
      `${VIEW_H}.labor_required_sum`,
      `${VIEW_H}.adjusted_staffed_employee_sum`,
    ],
    filters: { ...activityDateFilter(date, VIEW_H) },
    sorts: [{ column_name: `${VIEW_H}.warehouse_name`, sort_descending: false }],
    limit: 100,
  })

  const apptRows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.warehouse_name`,
      `${VIEW_APPT}.dock_appointment_type_name`,
      `${VIEW_APPT}.count`,
    ],
    filters: {
      ...scheduledArrivalDateFilter(date),
      ...apptStatusFilter(),
    },
    sorts: [{ column_name: `${VIEW_APPT}.warehouse_name`, sort_descending: false }],
    limit: 1000,
  })

  const result = {}
  for (const r of laborRows) {
    const wh    = r[`${VIEW_H}.warehouse_name`]
    const facId = WAREHOUSE_TO_FAC[wh]
    if (!facId) continue
    const labor = Number(r[`${VIEW_H}.labor_required_sum`]) || 0
    const avail = Number(r[`${VIEW_H}.adjusted_staffed_employee_sum`]) || 0
    result[facId] = {
      appts: 0, inb: 0, out: 0,
      labor: Math.round(labor * 10) / 10,
      avail: Math.round(avail * 10) / 10,
      util:  labor > 0 ? Math.round(avail / labor * 100) : 0,
      delta: Math.round((avail - labor) * 10) / 10,
    }
  }
  for (const r of apptRows) {
    const wh    = r[`${VIEW_APPT}.warehouse_name`]
    const facId = CSW_WAREHOUSE_TO_FAC[wh]
    if (!facId) continue
    if (!result[facId]) result[facId] = { labor: 0, util: 0, delta: 0 }
    const dir   = classifyApptType(r[`${VIEW_APPT}.dock_appointment_type_name`])
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    result[facId].appts = (result[facId].appts || 0) + count
    if (dir === 'inbound')  result[facId].inb = (result[facId].inb || 0) + count
    if (dir === 'outbound') result[facId].out = (result[facId].out || 0) + count
  }
  return result
}

async function batchedRun(tasks, concurrency = 2) {
  const results = []
  let i = 0
  async function runNext() {
    if (i >= tasks.length) return
    const idx = i++
    results[idx] = await tasks[idx]()
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runNext))
  return results
}

export async function fetchHistoricalHourlyDrops(facilityId, targetDate, weeksBack = 4) {
  const pastDates = buildValidPastDates(targetDate, weeksBack)
  const results = await Promise.all(pastDates.map(d => fetchHourlyData(facilityId, d).catch(() => [])))
  const sums = {}
  for (const rows of results)
    for (const row of rows) { sums[row.h] = (sums[row.h] ?? 0) + row.drops }
  const divisor = pastDates.length || weeksBack
  return Object.entries(sums).map(([h, total]) => ({ h: Number(h), est: Math.round(total / divisor) }))
}

async function fetchProjectDropsByRule(facilityId, date, projectName, rule) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return 0
  const omniNames = rule.omniNames ?? [projectName]
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID, table: VIEW_APPT,
    fields: [`${VIEW_APPT}.lookup_code`, `${VIEW_APPT}.dock_appointment_type_name`, `${VIEW_APPT}.count`],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: omniNames },
      [`${VIEW_APPT}.scheduled_arrival`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false, offset_interval_string: '0 days',
      },
      ...apptStatusFilter(),
    },
    sorts: [], limit: 500,
  })
  return rows
    .filter(r => {
      const code = (r[`${VIEW_APPT}.lookup_code`] || '').toUpperCase()
      const type = (r[`${VIEW_APPT}.dock_appointment_type_name`] || '').toLowerCase()
      if (!type.startsWith('inbound')) return false
      if (rule.method === 'inbound_all' || rule.method === 'inbound_all_merged') return true
      if (rule.method === 'inbound_exclude_lookup')
        return !rule.excludeWhenAll.some(group => group.every(p => code.includes(p.toUpperCase())))
      if (rule.method === 'inbound_include_lookup')
        return rule.includePatterns.some(p => code.includes(p.toUpperCase()))
      return false
    })
    .reduce((s, r) => s + (Number(r[`${VIEW_APPT}.count`]) || 0), 0)
}

async function fetchProjectHourlyDropsByRule(facilityId, date, projectName, rule) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return {}
  const omniNames = rule.omniNames ?? [projectName]
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID, table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.lookup_code`,
      `${VIEW_APPT}.dock_appointment_type_name`,
      `${VIEW_APPT}.count`,
      `${VIEW_APPT}.scheduled_arrival`,
    ],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: omniNames },
      [`${VIEW_APPT}.scheduled_arrival`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false, offset_interval_string: '0 days',
      },
      ...apptStatusFilter(),
    },
    sorts: [], limit: 500,
  })
  const hourCounts = {}
  for (const r of rows) {
    const code = (r[`${VIEW_APPT}.lookup_code`] || '').toUpperCase()
    const type = (r[`${VIEW_APPT}.dock_appointment_type_name`] || '').toLowerCase()
    if (!type.startsWith('inbound')) continue
    if (rule.method === 'inbound_exclude_lookup') {
      if (rule.excludeWhenAll.some(group => group.every(p => code.includes(p.toUpperCase())))) continue
    } else if (rule.method === 'inbound_include_lookup') {
      if (!rule.includePatterns.some(p => code.includes(p.toUpperCase()))) continue
    }
    const h = tsToHour(r[`${VIEW_APPT}.scheduled_arrival`])
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    hourCounts[h] = (hourCounts[h] ?? 0) + count
  }
  return hourCounts
}

export async function fetchHistoricalProjectHourlyDrops(facilityId, targetDate, weeksBack = 4) {
  const pastDates = buildValidPastDates(targetDate, weeksBack)
  // If we couldn't find any valid past dates, return empty (caller fallback handles it).
  if (!pastDates.length) return {}
  const effectiveWeeks = pastDates.length

  const results = []
  for (const d of pastDates)
    results.push(await fetchProjectData(facilityId, d).catch(() => []))

  const seenProjects = new Set(
    results.flat().map(r => r.name).filter(n => isRuleProject(facilityId, n))
  )
  if (facilityId === 'ken') {
    for (const p of KEN_GUARANTEED_PROJECTS) seenProjects.add(p)
  }
  for (const row of (CUSTOM_DROP_RULES_CACHE[facilityId] ?? []))
    seenProjects.add(row.project_name)

  const ruleProjects = [...seenProjects]
  const guaranteedForFacility = facilityId === 'ken' ? KEN_GUARANTEED_PROJECTS : []

  const projectTasks = ruleProjects.map(projectName => async () => {
    const rule = PROJECT_DROP_RULES[projectName]
    if (!rule) return [projectName, {}]

    // Fetch raw hourly counts for each of the 4 past same-weekday dates
    const weeklyHourCounts = await Promise.all(
      pastDates.map(d => fetchProjectHourlyDropsByRule(facilityId, d, projectName, rule).catch(() => ({})))
    )

    // Step 1 — daily totals per week (sum all hours for that day)
    const dailyTotals = weeklyHourCounts.map(hourMap =>
      Object.values(hourMap).reduce((s, v) => s + v, 0)
    )

    // Step 2 — L4W daily average over the dates that actually counted
    // (excludes future + holiday dates). Rounded to integer.
    const dailyForecast = Math.round(dailyTotals.reduce((s, v) => s + v, 0) / effectiveWeeks)

    if (dailyForecast === 0) return [projectName, {}]

    // Step 3 — aggregate raw hourly frequency across all 4 weeks
    const hourFreq = {}
    for (const hourMap of weeklyHourCounts)
      for (const [h, count] of Object.entries(hourMap))
        hourFreq[h] = (hourFreq[h] ?? 0) + count

    const totalFreq = Object.values(hourFreq).reduce((s, v) => s + v, 0)
    if (totalFreq === 0) return [projectName, {}]

    // Step 4 — build decimal proportions, then redistribute to integers via largest-remainder
    const decimalMap = {}
    for (const [h, freq] of Object.entries(hourFreq)) {
      const avg = dailyForecast * (freq / totalFreq)
      if (avg > 0) decimalMap[Number(h)] = avg
    }
    return [projectName, redistributeToIntegers(decimalMap)]
  })

  const projectResults = await batchedRun(projectTasks, 2)

  const out = {}
  for (const [projectName, avgs] of projectResults) {
    if (Object.keys(avgs).length > 0) {
      out[projectName] = avgs
    } else if (
      guaranteedForFacility.includes(projectName) ||
      (CUSTOM_DROP_RULES_CACHE[facilityId] ?? []).some(r => r.project_name === projectName)
    ) {
      out[projectName] = { 17: 0 }
    }
  }
  return out
}

/**
 * Cached wrapper around fetchHistoricalProjectHourlyDrops.
 *
 * Reads from est_drops_historical_cache first. If the cache is fresh
 * (default: < 7 days since computed_at), returns the cached result without
 * hitting Omni — saves ~28 Omni queries on KEN facility loads.
 *
 * On cache miss / stale cache / forceRefresh: re-queries Omni via the
 * uncached function, then writes the result back to the cache.
 *
 * 7-day TTL rationale (per Dean Dioguardi, 2026-05-29): L4W is by definition
 * a slow-moving signal — daily/weekly fluctuations are noise relative to the
 * underlying weekly pattern. Refreshing more often than once a week trades
 * 28 Omni queries × every facility load for negligible signal improvement.
 * The per-project ↺ refresh button (which calls this with forceRefresh:true)
 * is the escape hatch when something genuinely needs to be recomputed.
 *
 * Options:
 *   - forceRefresh: bypass cache read, always query Omni (used by the
 *     per-project ↺ refresh button, which already invalidates the cache
 *     before calling, but this is a belt-and-suspenders guarantee).
 *   - maxAgeMs: override the 7-day TTL.
 */
const L4W_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ── Phase 1 MotherDuck migration ─────────────────────────────────────────────
//
// fetchHistoricalProjectHourlyDropsMD replaces the Omni-based equivalent
// with a single SQL query against MotherDuck via /netlify/functions/motherduck-l4w.
// ~28 sequential Omni queries collapse into 1 round trip.
//
// Toggle: VITE_USE_MD_L4W='true' in the build env. Defaults to false so
// the Omni path stays canonical until we've validated parity in production.
// On any MD error the cached wrapper falls back to Omni automatically so a
// flag flip is safe to roll out.
//
// Date logic stays client-side (buildValidPastDates) so the server doesn't
// need to know about holidays or "today". The server just receives a list
// of ISO dates and aggregates appointments for those exact dates.
const USE_MD_L4W = (import.meta?.env?.VITE_USE_MD_L4W === 'true')

export async function fetchHistoricalProjectHourlyDropsMD(facilityId, targetDate, weeksBack = 4) {
  const validDates = buildValidPastDates(targetDate, weeksBack)
  // Pass through the same custom-rules cache the Omni path uses so MD has
  // the omni_name → display_name map for facility_custom_drop_projects.
  const customRules = CUSTOM_DROP_RULES_CACHE[facilityId] ?? []

  const res = await fetch('/.netlify/functions/motherduck-l4w', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facilityId, validDates, customRules }),
  })
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new OmniQueryError(
      body.error || `motherduck-l4w ${res.status}`,
      { status: res.status, reason: body.stack }
    )
  }
  const { result } = await res.json()
  // Server already applied redistributeToIntegers and the KEN/custom backfill.
  // Result shape matches fetchHistoricalProjectHourlyDrops exactly: { [project]: { [hour]: int } }.
  return result || {}
}

export async function fetchHistoricalProjectHourlyDropsCached(
  facilityId,
  targetDate,
  { forceRefresh = false, maxAgeMs = L4W_CACHE_TTL_MS, weeksBack = 4 } = {}
) {
  if (!forceRefresh) {
    const cached = await fetchHistoricalDropsCache(facilityId, targetDate, maxAgeMs)
    if (cached) {
      // Normalize stale decimal values that predate the largest-remainder migration
      const normalized = {}
      for (const [proj, hourMap] of Object.entries(cached)) {
        const hasPositive = Object.values(hourMap).some(v => Number(v) > 0)
        normalized[proj] = hasPositive ? redistributeToIntegers(hourMap) : hourMap
      }
      return normalized
    }
  }

  // Try MotherDuck first when the feature flag is on. Fall back to Omni on
  // any error (network, 500, schema mismatch) so flipping the flag is safe
  // even if MD has a hiccup.
  let fresh
  if (USE_MD_L4W) {
    try {
      const t0 = performance.now?.() ?? Date.now()
      fresh = await fetchHistoricalProjectHourlyDropsMD(facilityId, targetDate, weeksBack)
      const t1 = performance.now?.() ?? Date.now()
      console.debug(`L4W via MotherDuck (${facilityId}, ${targetDate}): ${Math.round(t1 - t0)}ms`)
    } catch (e) {
      console.warn(`L4W MotherDuck failed, falling back to Omni: ${e.message}`)
      fresh = await fetchHistoricalProjectHourlyDrops(facilityId, targetDate, weeksBack)
    }
  } else {
    fresh = await fetchHistoricalProjectHourlyDrops(facilityId, targetDate, weeksBack)
  }

  // Write back to cache — fire-and-forget. If write fails (RLS, transient
  // network) we still return the fresh result to the caller; next page load
  // will just re-query the upstream.
  writeHistoricalDropsCache(facilityId, targetDate, fresh).catch(e =>
    console.warn('writeHistoricalDropsCache failed (non-fatal):', e?.message)
  )

  return fresh
}

export async function fetchHistoricalProjectDrops(facilityId, targetDate, weeksBack = 4) {
  const pastDates = buildValidPastDates(targetDate, weeksBack)
  if (!pastDates.length) return []
  const effectiveWeeks = pastDates.length
  const results = await Promise.all(pastDates.map(d => fetchProjectData(facilityId, d).catch(() => [])))
  const sums = {}
  const ruleProjects = [...new Set(results.flat().map(r => r.name).filter(n => isRuleProject(facilityId, n)))]
  const tasks = ruleProjects.map(projectName => async () => {
    const rule = PROJECT_DROP_RULES[projectName]
    if (!rule) return [projectName, 0]
    const weekCounts = await Promise.all(pastDates.map(d => fetchProjectDropsByRule(facilityId, d, projectName, rule).catch(() => 0)))
    return [projectName, weekCounts.reduce((s, c) => s + c, 0)]
  })
  const counts = await batchedRun(tasks, 2)
  for (const [name, total] of counts) sums[name] = total
  return Object.entries(sums).map(([project_name, total]) => ({ project_name, est_drops: Math.round(total / effectiveWeeks) }))
}

export async function fetchActiveInventory(facilityId) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []

  // Paginate: fetch up to 5 pages × 500 rows to avoid the hard 1000-row cap.
  const PAGE_SIZE = 500
  const MAX_PAGES = 5
  const allRows = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await omniQuery({
      modelId: GOLD_MODEL_ID,
      table: VIEW_LP,
      fields: [
        `${VIEW_LP_PROJ}.project_name`,
        `${VIEW_LP}.lookup_code_count_distinct`,
      ],
      filters: {
        [`${VIEW_LP}.archived`]:          { type: 'boolean', is_negative: true, treat_nulls_as_false: false },
        [`${VIEW_LP_WH}.warehouse_name`]: { kind: 'CONTAINS', type: 'string', values: [wh], is_negative: false, case_insensitive: true },
      },
      sorts: [{ column_name: `${VIEW_LP}.lookup_code_count_distinct`, sort_descending: true }],
      limit:  PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    allRows.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }

  return allRows
    .map(r => ({
      name: stripWarehouseSuffix(r[`${VIEW_LP_PROJ}.project_name`] || ''),
      lps:  Number(r[`${VIEW_LP}.lookup_code_count_distinct`]) || 0,
    }))
    .filter(r => r.name && r.name.trim() !== '' && r.lps > 0)
}

async function fetchCal2DockAssignments() {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('employees')
    .select('id, default_lane')
    .eq('facility', 'cal')
  if (error || !data) return new Map()
  return new Map(data.map(e => [String(e.id), e.default_lane]))
}

export async function fetchB2eTimeOff(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return new Map()
  try {
    const rows = await omniQuery({
      modelId: B2E_MODEL_ID,
      table: TIME_OFF,
      fields: [
        `${TIME_OFF}.employee_id`,
        `${TIME_OFF}.time_off_name`,
      ],
      filters: {
        [`${TIME_OFF}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        [`${TIME_OFF}.default_job_code`]:           { kind: 'EQUALS', type: 'string', values: ['205'] },
        [`${TIME_OFF}.date`]: {
          kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
          isFiscal: false, left_side: date, is_negative: false,
          offset_interval_string: '0 days',
        },
      },
      sorts: [],
      limit: 200,
    })
    const map = new Map()
    for (const r of rows) {
      const id    = String(r[`${TIME_OFF}.employee_id`])
      const name  = r[`${TIME_OFF}.time_off_name`] || 'PTO'
      const label = name.toLowerCase().includes('fmla')   ? 'FMLA'
                  : name.toLowerCase().includes('unpaid') ? 'Unpaid'
                  : name.toLowerCase().includes('bereavement') ? 'Bereave'
                  : 'PTO'
      map.set(id, label)
    }
    return map
  } catch (e) {
    console.warn('fetchB2eTimeOff failed (non-fatal):', e.message)
    return new Map()
  }
}

// Internal helper — fetches active schedule rows for a single B2E entry_date.
//
// IMPORTANT — stale-snapshot filter scope: the schedule query pulls a 14-day
// forward window (not just entryDate) so per-employee max_ingestion_ts is
// computed across the full window, not just the requested date's rows.
//
// Why: B2E's futurescheduleentries is append-only. When an employee's
// schedule pattern changes (Daniel Franco 2026-07-08: M-F 8am → M/T/F/S 6am),
// the OLD batch's rows for the now-off days (Wed/Thu) remain as ghosts
// forever. A per-date query for one of those Wed/Thu dates returns ONLY
// the old ghost row — its ingestion_ts is trivially the "max" within that
// one date's row set, so the naive per-date max filter can't tell it's stale.
// The employee then gets seeded into Supabase with 8am shift data based on
// a schedule they no longer have. Dean/Taylor 2026-07-08.
//
// The fix expands the query to 14 days and uses per-employee-across-window
// max_ingestion_ts (matching fetchB2eRosterForRange's behavior). Rows are
// then filtered back to entryDate only after the stale-filter has done its
// job. If an employee's newest snapshot doesn't include entryDate, their
// row for entryDate is filtered out — which is exactly what we want.
async function fetchB2eRosterForEntryDate(facilityId, entryDate, isCal, dockAssignments) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []

  // MotherDuck-direct fetch (was two sequential omniQuery calls before
  // the 2026-07-08 pivot away from Omni for B2E reads). Parallelised
  // because we're no longer chasing Omni's connection reuse behaviour.
  const [rosterRows, scheduleRows] = await Promise.all([
    motherduckB2eQuery({ kind: 'active_roster_all_jobcodes', facilityId }),
    motherduckB2eQuery({ kind: 'schedule_date', facilityId, fromDate: entryDate }),
  ])

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))

  // Compute per-employee max_ingestion_ts ACROSS the full 14-day window.
  // This lets us detect stale-snapshot ghost rows: an employee whose newest
  // snapshot doesn't include entryDate will have that row filtered.
  const maxIngestByEmp = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!maxIngestByEmp.has(id) || ts > maxIngestByEmp.get(id)) {
      maxIngestByEmp.set(id, ts)
    }
  }

  // Filter to entryDate rows only, AND require ts === per-employee max_ts.
  const schedMap = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (ts !== maxIngestByEmp.get(id)) continue  // stale-snapshot filter
    const dateRaw = r[`${SCHEDULE}.entry_date`]
    if (!dateRaw) continue
    const dateIso = typeof dateRaw === 'string'
      ? dateRaw.slice(0, 10)
      : new Date(dateRaw).toISOString().slice(0, 10)
    if (dateIso !== entryDate) continue  // narrow back down to just the requested date
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  return [...schedMap.entries()]
    .filter(([id, { row: r }]) => {
      if (!activeIds.has(id)) return false
      return ALLOWED_JOB_CODES.has(String(r[`${SCHEDULE}.default_job_code`] ?? ''))
    })
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
        id,
        name:         fullName,
        role:         null,
        job_code:     String(r[`${SCHEDULE}.default_job_code`] ?? ''),
        default_lane: defaultLane,
        shift_start:  normalizeShiftStart(startTime),
        shift_hours:  computeShiftHours(startTime, endTime),
        facility:     facilityId,
      }
    })
}

/**
 * Fetch the roster for a given operational date.
 */
export async function fetchB2eRoster(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []
  const refDate = date || new Date().toISOString().slice(0, 10)
  const isCal   = facilityId === 'cal'
  const dockAssignments = isCal ? await fetchCal2DockAssignments() : new Map()

  const [todayRoster, priorNightRoster] = await Promise.all([
    fetchB2eRosterForEntryDate(facilityId, refDate, isCal, dockAssignments),
    fetchB2eRosterForEntryDate(facilityId, prevDayISO(refDate), isCal, dockAssignments).catch(e => {
      console.warn('Prior-night carryover fetch failed (non-fatal):', e.message)
      return []
    }),
  ])

  const carryovers = priorNightRoster
    .filter(e => {
      if (e.shift_start == null || e.shift_hours == null) return false
      const linearEnd = Number(e.shift_start) + Number(e.shift_hours)
      return linearEnd > 24 + 5
    })
    .map(e => ({
      ...e,
      originalId:   e.id,
      id:           `${e.id}${CARRYOVER_ID_SUFFIX}`,
      is_carryover: true,
    }))

  return [...todayRoster, ...carryovers].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Fetch B2E rosters for a forward window in a SINGLE Omni round trip.
 * Applies stale-snapshot filter: per-employee max ingestion_ts drops rows
 * from prior B2E snapshot batches so seedForwardHorizon's delete branch
 * removes stale (employee, date) pairs from Supabase.
 */
export async function fetchB2eRosterForRange(facilityId, fromDate, daysForward) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return {}
  const isCal = facilityId === 'cal'

  // MotherDuck-direct fetch (was two omniQuery calls before the
  // 2026-07-08 pivot away from Omni for B2E reads).
  const [rosterRows, scheduleRows, dockAssignments] = await Promise.all([
    motherduckB2eQuery({ kind: 'active_roster_all_jobcodes', facilityId }),
    motherduckB2eQuery({ kind: 'schedule_range', facilityId, fromDate, daysForward }),
    isCal ? fetchCal2DockAssignments() : Promise.resolve(new Map()),
  ])

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))

  const maxIngestByEmp = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!maxIngestByEmp.has(id) || ts > maxIngestByEmp.get(id)) {
      maxIngestByEmp.set(id, ts)
    }
  }

  const byDateEmp = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    if (!ALLOWED_JOB_CODES.has(String(r[`${SCHEDULE}.default_job_code`] ?? ''))) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (ts !== maxIngestByEmp.get(id)) continue
    const dateRaw = r[`${SCHEDULE}.entry_date`]
    if (!dateRaw) continue
    const dateIso = typeof dateRaw === 'string'
      ? dateRaw.slice(0, 10)
      : new Date(dateRaw).toISOString().slice(0, 10)
    if (!byDateEmp.has(dateIso)) byDateEmp.set(dateIso, new Map())
    const empMap = byDateEmp.get(dateIso)
    if (!empMap.has(id) || ts > empMap.get(id).ts) empMap.set(id, { row: r, ts })
  }

  const result = {}
  for (const [dateIso, empMap] of byDateEmp.entries()) {
    const employees = []
    for (const [id, { row: r }] of empMap.entries()) {
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

      employees.push({
        id,
        name:         fullName,
        role:         null,
        job_code:     String(r[`${SCHEDULE}.default_job_code`] ?? ''),
        default_lane: defaultLane,
        shift_start:  normalizeShiftStart(startTime),
        shift_hours:  computeShiftHours(startTime, endTime),
        facility:     facilityId,
      })
    }
    result[dateIso] = employees
  }

  return result
}

export async function fetchActiveB2eEmployees(facilityId) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return new Set()
  try {
    const rosterRows = await motherduckB2eQuery({ kind: 'active_roster', facilityId })
    return new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))
  } catch (e) {
    console.warn('fetchActiveB2eEmployees failed (non-fatal):', e.message)
    return new Set()
  }
}

export async function fetchWrPickers(date) {
  const location = B2E_LOCATION['wr']
  const refDate  = date || new Date().toISOString().slice(0, 10)

  const rosterRows = await omniQuery({
    modelId: B2E_MODEL_ID, table: ROSTER,
    fields: [`${ROSTER}.employee_id`, `${ROSTER}.employee_status`],
    filters: {
      [`${ROSTER}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
      [`${ROSTER}.employee_status`]: { kind: 'EQUALS', type: 'string', values: ['Active'] },
    },
    limit: 500,
  })

  const scheduleRows = await omniQuery({
    modelId: B2E_MODEL_ID, table: SCHEDULE,
    fields: [
      `${SCHEDULE}.employee_id`, `${SCHEDULE}.first_name`, `${SCHEDULE}.last_name`,
      `${SCHEDULE}.default_job_code`, `${SCHEDULE}.ingestion_ts`,
    ],
    filters: {
      [`${SCHEDULE}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
      [`${SCHEDULE}.entry_date`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: refDate, is_negative: false, offset_interval_string: '0 days',
      },
    },
    sorts: [{ column_name: `${SCHEDULE}.ingestion_ts`, sort_descending: true }],
    limit: 500,
  })

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))
  const schedMap  = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  return [...schedMap.entries()]
    .filter(([id, { row: r }]) =>
      activeIds.has(id) &&
      String(r[`${SCHEDULE}.default_job_code`] ?? '') === '206'
    )
    .map(([id, { row: r }]) => ({
      id,
      name: [r[`${SCHEDULE}.first_name`] || '', r[`${SCHEDULE}.last_name`] || ''].filter(Boolean).join(' '),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
