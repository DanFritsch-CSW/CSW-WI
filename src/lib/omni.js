// Omni Analytics API helpers
// Calls /.netlify/functions/omni-query (server-side proxy) to avoid CORS.
// Auth: OMNI_API_KEY env var set in Netlify dashboard.

import { supabase } from './supabase.js'
import { fetchCustomDropProjects } from './supabase.js'

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

const OVERNIGHT_HOURS = new Set([0, 1, 2, 3, 4])

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

const PROJECT_DROP_RULES = {
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

// ── Shared helper: fetch appointments and bucket by hour, skipping/overlaying overnight ──

async function fetchApptHourMap(filters, date) {
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID, table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.scheduled_arrival`,
      `${VIEW_APPT}.dock_appointment_type_name`,
      `${VIEW_APPT}.count`,
    ],
    filters: { ...filters, ...scheduledArrivalDateFilter(date), ...apptStatusFilter() },
    sorts: [], limit: 1000,
  })

  const hourMap = {}
  for (const r of rows) {
    const h     = tsToHour(r[`${VIEW_APPT}.scheduled_arrival`])
    if (OVERNIGHT_HOURS.has(h)) continue
    const dir   = classifyApptType(r[`${VIEW_APPT}.dock_appointment_type_name`])
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    if (!hourMap[h]) hourMap[h] = { inb: 0, out: 0 }
    if (dir === 'inbound')  hourMap[h].inb += count
    if (dir === 'outbound') hourMap[h].out += count
  }

  try {
    const nextDay = nextDayISO(date)
    const overnightRows = await omniQuery({
      modelId: GOLD_MODEL_ID, table: VIEW_APPT,
      fields: [
        `${VIEW_APPT}.scheduled_arrival`,
        `${VIEW_APPT}.dock_appointment_type_name`,
        `${VIEW_APPT}.count`,
      ],
      filters: { ...filters, ...scheduledArrivalDateFilter(nextDay), ...apptStatusFilter() },
      sorts: [], limit: 1000,
    })
    for (const r of overnightRows) {
      const h     = tsToHour(r[`${VIEW_APPT}.scheduled_arrival`])
      if (!OVERNIGHT_HOURS.has(h)) continue
      const dir   = classifyApptType(r[`${VIEW_APPT}.dock_appointment_type_name`])
      const count = Number(r[`${VIEW_APPT}.count`]) || 0
      if (!hourMap[h]) hourMap[h] = { inb: 0, out: 0 }
      if (dir === 'inbound')  hourMap[h].inb += count
      if (dir === 'outbound') hourMap[h].out += count
    }
  } catch (e) {
    console.warn('Overnight appointment fetch failed (non-fatal):', e.message)
  }

  return hourMap
}

// ── Public API ─────────────────────────────────────────────────────────────────────

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

// ── KEN v2 / Diagnostic Mirror ──────────────────────────────────────────────────
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
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return {}
  return fetchApptHourMap(
    { [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] } },
    date
  )
}

export async function fetchProjectData(facilityId, date) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.project_name`,
      `${VIEW_APPT}.dock_appointment_type_name`,
      `${VIEW_APPT}.count`,
    ],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      ...scheduledArrivalDateFilter(date),
      ...apptStatusFilter(),
    },
    sorts: [{ column_name: `${VIEW_APPT}.project_name`, sort_descending: false }],
    limit: 500,
  })
  const projectMap = new Map()
  for (const r of rows) {
    const rawName = r[`${VIEW_APPT}.project_name`] || ''
    if (!rawName) continue
    const name = normalizeProjectName(facilityId, rawName)
    const dir   = classifyApptType(r[`${VIEW_APPT}.dock_appointment_type_name`])
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
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

export async function fetchProjectHourlyAppointments(facilityId, date, projectNames) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh || !projectNames?.length) return {}
  return fetchApptHourMap(
    {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: projectNames },
    },
    date
  )
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
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')
  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })
  const results = await Promise.all(pastDates.map(d => fetchHourlyData(facilityId, d).catch(() => [])))
  const sums = {}
  for (const rows of results)
    for (const row of rows) { sums[row.h] = (sums[row.h] ?? 0) + row.drops }
  return Object.entries(sums).map(([h, total]) => ({ h: Number(h), est: Math.round(total / weeksBack) }))
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
      const type = (r[`${VIEW_APPT}.dock_appointment_type_name`] || '').toLowerCase()
      const code = (r[`${VIEW_APPT}.lookup_code`] || '').toUpperCase()
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
    const type = (r[`${VIEW_APPT}.dock_appointment_type_name`] || '').toLowerCase()
    const code = (r[`${VIEW_APPT}.lookup_code`] || '').toUpperCase()
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
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')
  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })

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

    // Step 2 — L4W daily average, rounded to integer
    const dailyForecast = Math.round(dailyTotals.reduce((s, v) => s + v, 0) / weeksBack)

    if (dailyForecast === 0) return [projectName, {}]

    // Step 3 — aggregate raw hourly frequency across all 4 weeks
    const hourFreq = {}
    for (const hourMap of weeklyHourCounts)
      for (const [h, count] of Object.entries(hourMap))
        hourFreq[h] = (hourFreq[h] ?? 0) + count

    const totalFreq = Object.values(hourFreq).reduce((s, v) => s + v, 0)
    if (totalFreq === 0) return [projectName, {}]

    // Step 4 — distribute dailyForecast proportionally across historical hours
    const avgs = {}
    for (const [h, freq] of Object.entries(hourFreq)) {
      avgs[Number(h)] = Math.round(dailyForecast * (freq / totalFreq) * 100) / 100
    }
    return [projectName, avgs]
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

export async function fetchHistoricalProjectDrops(facilityId, targetDate, weeksBack = 4) {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')
  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })
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
  return Object.entries(sums).map(([project_name, total]) => ({ project_name, est_drops: Math.round(total / weeksBack) }))
}

export async function fetchActiveInventory(facilityId) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []
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
    limit: 200,
  })
  return rows
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
async function fetchB2eRosterForEntryDate(facilityId, entryDate, isCal, dockAssignments) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []

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
      `${SCHEDULE}.default_job_code`, `${SCHEDULE}.start_time`, `${SCHEDULE}.end_time`,
      `${SCHEDULE}.modified_start_time`, `${SCHEDULE}.modified_end_time`,
      `${SCHEDULE}.work_schedule`, `${SCHEDULE}.ingestion_ts`,
    ],
    filters: {
      [`${SCHEDULE}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
      [`${SCHEDULE}.entry_date`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: entryDate, is_negative: false, offset_interval_string: '0 days',
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
 *
 * Op day spans 5am→4:59am+1, so we do TWO B2E queries:
 * 1. entry_date = date — today's roster (1st/Mid/2nd + 3rd starting tonight)
 * 2. entry_date = date - 1 — prior-night carryover (3rd shifters whose shift
 *    started yesterday at 10pm and extends into today's post-5am window)
 *
 * Carryovers tagged is_carryover: true with a synthetic ID suffix so they
 * can coexist with the same employee's normal entry today (M-F 3rd shifters
 * commonly appear on both: yesterday's shift finishing this morning AND
 * tonight's shift starting at 10pm). NOT persisted to Supabase — recomputed
 * live each page load. Callers writing to employees or roster_assignments
 * tables must filter via e => !e.is_carryover.
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

  // Carryover rule: linearEnd = shift_start + shift_hours
  //   - linearEnd <= 24+5 (29) → tail entirely within yesterday's op day → skip
  //   - linearEnd > 29 → tail reaches into today's post-5am window → carryover
  // Example: 22:00 + 8.5h = 30.5 → 30.5 > 29 ✓ carryover (tail = 6:30am)
  //
  // NOTE: we deliberately do NOT dedup against today's roster. M-F 3rd shifters
  // legitimately appear on BOTH (their prior-night shift finishing this morning,
  // and tonight's shift starting at 10pm). Synthetic ID suffix prevents React
  // key collisions; the carryover entry's `originalId` field lets downstream
  // code reference the real employee when needed.
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
