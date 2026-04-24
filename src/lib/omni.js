// Omni Analytics API helpers
// Calls /.netlify/functions/omni-query (server-side proxy) to avoid CORS.
// Auth: OMNI_API_KEY env var set in Netlify dashboard.

import { supabase } from './supabase.js'

const MODEL_ID = '79a98af2-a904-4b5d-b25f-7f6a2c7ef467'

const LABOR_WAREHOUSE = {
  cal:  'franksville',
  cal2: 'franksville',
  mad:  'madison',
  ken:  'kenosha',
  wr:   'wisconsin rapids',
  ec:   'eau claire',
}

const CSW_WAREHOUSE = {
  cal:  'CSW-Franksville',
  cal2: 'CSW-Franksville',
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
const VIEW_P        = 'labor_planning_app__hourly_inbound_outbound_drops_summary'
const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_APPT     = 'gold__truck_appointments'
const VIEW_LP       = 'silver__datex_slv_licenseplates'
const VIEW_LP_WH    = 'silver__datex_slv_warehouses'
const VIEW_LP_PROJ  = 'silver__datex_slv_projects'

const PROJECT_DROP_RULES = {
  'Palermos CALEDONIA finished': {
    facility: 'cal',
    method: 'inbound_exclude_lookup',
    excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']],
  },
  'CROWN BAKERIES':          { facility: 'ken', method: 'inbound_all' },
  'Pretzilla Kenosha':       { facility: 'ken', method: 'inbound_all' },
  'BIRCHWOOD FOODS KENOSHA': { facility: 'ken', method: 'inbound_all' },
  'FAIR OAKS FARMS':         { facility: 'ken', method: 'inbound_all' },
  'FAIR OAKS FARMS WEST':    { facility: 'ken', method: 'inbound_all' },
  'RICHELIEU KENOSHA':               { facility: 'ken', method: 'inbound_include_lookup', includePatterns: ['TOP', 'PSH'] },
  'RICHELIEU RAW MATERIALS KENOSHA': { facility: 'ken', method: 'inbound_include_lookup', includePatterns: ['TOP', 'PSH'] },
}

export function isRuleProject(facilityId, projectName) {
  const rule = PROJECT_DROP_RULES[projectName]
  if (!rule) return false
  const effectiveFac = facilityId === 'cal2' ? 'cal' : facilityId
  return rule.facility === effectiveFac
}

const B2E_MODEL_ID = 'f3aaca97-bb7c-405d-809b-efab83649ab3'
const ROSTER       = 'silver__b2e_slv_employeeroster'
const SCHEDULE     = 'silver__b2e_slv_futurescheduleentries'

const B2E_LOCATION = {
  cal:  '019 - Caledonia',
  cal2: '019 - Caledonia',
  mad:  '011 - Madison',
  ec:   '012 - Eau Claire',
  ken:  '015 - Kenosha',
  wr:   '023 - Wisconsin Rapids',
}

const B2E_EXCLUDED_IDS = [
  192, 566, 619, 621, 650, 727, 750, 800, 826, 964, 966,
  5282, 5333, 5343, 5350, 5381, 5389, 5405, 5407, 5414,
  5423, 5429, 5434, 5438, 5441, 5442, 5449, 5462, 5470, 5472, 5474,
]

const CAL2_DOCK_NAMES_35 = new Set([
  'Calvieon Howard',
  'Ethan Lindsey',
  'Jose Cuevas',
  'Nicholas J. Free',
  'Nicholas Free',
  'Zarious Brinner',
  'Juan Bido',
  'Eduardo Ramon',
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
  return h != null ? Math.floor(h) : null
}

function computeShiftHours(startTime, endTime) {
  const sh = parseB2eTime(startTime)
  const eh = parseB2eTime(endTime)
  if (sh == null || eh == null) return null
  const hours = (eh - sh + 24) % 24
  return hours > 0 ? Math.round(hours * 2) / 2 : null
}

async function omniQuery(query) {
  const res = await fetch('/.netlify/functions/omni-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`omni-query ${res.status}: ${text}`)
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

function scheduledArrivalDateFilter(date) {
  return {
    [`${VIEW_APPT}.scheduled_arrival`]: {
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
  ' - CSW-Madison',
  ' - CSW-Franksville',
  ' - CSW-Kenosha',
  ' - CSW-Wisconsin Rapids',
  ' - CSW-Eau Claire',
  '-CSW-Madison',
  ' - Madison',
]

function stripWarehouseSuffix(name) {
  if (!name) return name
  for (const suffix of CSW_NAME_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name
}

// ── Public API ───────────────────────────────────────────────────

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
      `${VIEW_H}.inbound_count`,
      `${VIEW_H}.outbound_count`,
      `${VIEW_H}.drops`,
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
  return rows.map(r => {
    const inb   = Number(r[`${VIEW_H}.inbound_count`]) || 0
    const out   = Number(r[`${VIEW_H}.outbound_count`]) || 0
    const drops = Number(r[`${VIEW_H}.drops`]) || 0
    const h     = tsToHour(r[`${VIEW_H}.hour_of_day_timestamp`])
    return {
      h,
      req:   Number(r[`${VIEW_H}.labor_required`]) || 0,
      avail: Number(r[`${VIEW_H}.labor_available_aw_update_`]) || 0,
      drops, inb, out,
      appts: inb + drops + out,
    }
  })
}

export async function fetchProjectData(facilityId, date) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.project_name`,
      `${VIEW_APPT}.dock_appointment_type_name_groups`,
      `${VIEW_APPT}.count`,
    ],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      ...scheduledArrivalDateFilter(date),
    },
    sorts: [{ column_name: `${VIEW_APPT}.project_name`, sort_descending: false }],
    limit: 500,
  })
  const projectMap = new Map()
  for (const r of rows) {
    const name = r[`${VIEW_APPT}.project_name`] || ''
    if (!name) continue
    const typeGroup = (r[`${VIEW_APPT}.dock_appointment_type_name_groups`] || '').toLowerCase()
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    if (!projectMap.has(name)) projectMap.set(name, { name, inb: 0, out: 0, drops: 0 })
    const p = projectMap.get(name)
    if (typeGroup === 'inbounds') p.inb += count
    else if (typeGroup === 'outbounds') p.out += count
  }
  return [...projectMap.values()]
    .map(p => ({ ...p, tot: p.inb + p.out + p.drops }))
    .filter(p => p.tot > 0)
    .sort((a, b) => b.tot - a.tot)
}

export async function fetchProjectHourlyAppointments(facilityId, date, projectNames) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh || !projectNames?.length) return {}
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.scheduled_arrival`,
      `${VIEW_APPT}.dock_appointment_type_name_groups`,
      `${VIEW_APPT}.count`,
    ],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: projectNames },
      ...scheduledArrivalDateFilter(date),
    },
    sorts: [],
    limit: 1000,
  })
  const hourMap = {}
  for (const r of rows) {
    const h     = tsToHour(r[`${VIEW_APPT}.scheduled_arrival`])
    const group = (r[`${VIEW_APPT}.dock_appointment_type_name_groups`] || '').toLowerCase()
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    if (!hourMap[h]) hourMap[h] = { inb: 0, out: 0 }
    if (group === 'inbounds')  hourMap[h].inb += count
    if (group === 'outbounds') hourMap[h].out += count
  }
  return hourMap
}

export async function fetchNetworkKpis(date) {
  const [laborRows, apptRows] = await Promise.all([
    omniQuery({
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
    }),
    omniQuery({
      modelId: GOLD_MODEL_ID,
      table: VIEW_APPT,
      fields: [
        `${VIEW_APPT}.warehouse_name`,
        `${VIEW_APPT}.dock_appointment_type_name_groups`,
        `${VIEW_APPT}.count`,
      ],
      filters: { ...scheduledArrivalDateFilter(date) },
      sorts: [{ column_name: `${VIEW_APPT}.warehouse_name`, sort_descending: false }],
      limit: 1000,
    }),
  ])
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
    const typeGroup = (r[`${VIEW_APPT}.dock_appointment_type_name_groups`] || '').toLowerCase()
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    result[facId].appts = (result[facId].appts || 0) + count
    if (typeGroup === 'inbounds')  result[facId].inb = (result[facId].inb || 0) + count
    if (typeGroup === 'outbounds') result[facId].out = (result[facId].out || 0) + count
  }
  return result
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
  for (const rows of results) {
    for (const row of rows) { sums[row.h] = (sums[row.h] ?? 0) + row.drops }
  }
  return Object.entries(sums).map(([h, total]) => ({ h: Number(h), est: Math.round(total / weeksBack) }))
}

async function fetchProjectDropsByRule(facilityId, date, projectName, rule) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return 0
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID, table: VIEW_APPT,
    fields: [`${VIEW_APPT}.lookup_code`, `${VIEW_APPT}.dock_appointment_type_name`, `${VIEW_APPT}.count`],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: [projectName] },
      [`${VIEW_APPT}.scheduled_arrival`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false, offset_interval_string: '0 days',
      },
    },
    sorts: [], limit: 500,
  })
  return rows
    .filter(r => {
      const type = (r[`${VIEW_APPT}.dock_appointment_type_name`] || '').toLowerCase()
      const code = (r[`${VIEW_APPT}.lookup_code`] || '').toUpperCase()
      if (!type.startsWith('inbound')) return false
      if (rule.method === 'inbound_all') return true
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
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: [projectName] },
      [`${VIEW_APPT}.scheduled_arrival`]: {
        kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
        isFiscal: false, left_side: date, is_negative: false, offset_interval_string: '0 days',
      },
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
  const effectiveFacId = facilityId === 'cal2' ? 'cal' : facilityId
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')
  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })
  const results = await Promise.all(pastDates.map(d => fetchProjectData(effectiveFacId, d).catch(() => [])))
  const ruleProjects = [...new Set(results.flat().map(r => r.name).filter(n => PROJECT_DROP_RULES[n]?.facility === effectiveFacId))]
  const out = {}
  for (const projectName of ruleProjects) {
    const rule = PROJECT_DROP_RULES[projectName]
    const weeklyHourCounts = await Promise.all(
      pastDates.map(d => fetchProjectHourlyDropsByRule(effectiveFacId, d, projectName, rule).catch(() => ({})))
    )
    const sums = {}
    for (const hourMap of weeklyHourCounts) {
      for (const [h, count] of Object.entries(hourMap)) { sums[h] = (sums[h] ?? 0) + count }
    }
    const avgs = Object.fromEntries(Object.entries(sums).map(([h, total]) => [Number(h), Math.round(total / weeksBack)]))
    if (Object.keys(avgs).length > 0) out[projectName] = avgs
  }
  return out
}

export async function fetchHistoricalProjectDrops(facilityId, targetDate, weeksBack = 4) {
  const effectiveFacId = facilityId === 'cal2' ? 'cal' : facilityId
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')
  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })
  const results = await Promise.all(pastDates.map(d => fetchProjectData(effectiveFacId, d).catch(() => [])))
  const sums = {}
  const ruleProjects = [...new Set(results.flat().map(r => r.name).filter(n => PROJECT_DROP_RULES[n]?.facility === effectiveFacId))]
  for (const projectName of ruleProjects) {
    const rule = PROJECT_DROP_RULES[projectName]
    const counts = await Promise.all(pastDates.map(d => fetchProjectDropsByRule(effectiveFacId, d, projectName, rule).catch(() => 0)))
    sums[projectName] = counts.reduce((s, c) => s + c, 0)
  }
  return Object.entries(sums).map(([project_name, total]) => ({ project_name, est_drops: Math.round(total / weeksBack) }))
}

// ── Active Inventory ─────────────────────────────────────────────
// Matches the Omni workbook baseline exactly:
//   Filter: silver__datex_slv_licenseplates.archived = false
//           (boolean, is_negative:true means "not archived")
//   Filter: silver__datex_slv_warehouses.warehouse_name CONTAINS "CSW-Madison"
//   Dimension: silver__datex_slv_projects.project_name
//   Measure: silver__datex_slv_licenseplates.lookup_code_count_distinct
// Expected values: Grassland WM Cooler ~1,708, Saputo ~1,547, Grassland Sam's ~1,305 etc.
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
    .eq('facility', 'cal2')
  if (error || !data) return new Map()
  return new Map(data.map(e => [String(e.id), e.default_lane]))
}

export async function fetchB2eRoster(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []
  const refDate = date || new Date().toISOString().slice(0, 10)
  const isCal2  = facilityId === 'cal2'
  const dockAssignments = isCal2 ? await fetchCal2DockAssignments() : new Map()

  const [rosterRows, scheduleRows] = await Promise.all([
    omniQuery({
      modelId: B2E_MODEL_ID, table: ROSTER,
      fields: [`${ROSTER}.employee_id`, `${ROSTER}.employee_status`],
      filters: {
        [`${ROSTER}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        [`${ROSTER}.employee_status`]: { kind: 'EQUALS', type: 'string', values: ['Active'] },
      },
      limit: 500,
    }),
    omniQuery({
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
          isFiscal: false, left_side: refDate, is_negative: false, offset_interval_string: '0 days',
        },
      },
      sorts: [{ column_name: `${SCHEDULE}.ingestion_ts`, sort_descending: true }],
      limit: 500,
    }),
  ])

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))
  const schedMap  = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  const excluded     = new Set(B2E_EXCLUDED_IDS.map(String))
  const allowedCodes = new Set(['205', '209'])

  return [...schedMap.entries()]
    .filter(([id, { row: r }]) => {
      if (!activeIds.has(id)) return false
      if (excluded.has(id)) return false
      return allowedCodes.has(String(r[`${SCHEDULE}.default_job_code`] ?? ''))
    })
    .map(([id, { row: r }]) => {
      const startTime = r[`${SCHEDULE}.modified_start_time`] ?? r[`${SCHEDULE}.start_time`]
      const endTime   = r[`${SCHEDULE}.modified_end_time`]   ?? r[`${SCHEDULE}.end_time`]
      const firstName = r[`${SCHEDULE}.first_name`] || ''
      const lastName  = r[`${SCHEDULE}.last_name`]  || ''
      const fullName  = [firstName, lastName].filter(Boolean).join(' ')
      const shiftLane = scheduleToLane(r[`${SCHEDULE}.work_schedule`], startTime)

      let defaultLane
      if (isCal2) {
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
    .sort((a, b) => a.name.localeCompare(b.name))
}
