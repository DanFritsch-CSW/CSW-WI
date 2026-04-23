// Omni Analytics API helpers
// Calls /.netlify/functions/omni-query (server-side proxy) to avoid CORS.
// Auth: OMNI_API_KEY env var set in Netlify dashboard.

const MODEL_ID = '79a98af2-a904-4b5d-b25f-7f6a2c7ef467'

// Map facility IDs → Omni warehouse_name values used in labor_planning_app tables
const LABOR_WAREHOUSE = {
  cal:  'franksville',
  cal2: 'franksville',   // same physical facility as cal
  mad:  'madison',
  ken:  'kenosha',
  wr:   'wisconsin rapids',
  ec:   'eau claire',
}

// Map facility IDs → warehouse_name used in appointments/summary tables (CSW- prefix)
const CSW_WAREHOUSE = {
  cal:  'CSW-Franksville',
  cal2: 'CSW-Franksville',   // same physical facility as cal
  mad:  'CSW-Madison',
  ken:  'CSW-Kenosha',
  wr:   'CSW-Wisconsin Rapids',
  ec:   'CSW-Eau Claire',
}

// Reverse maps: Omni warehouse_name → facility id
// cal2 intentionally omitted — reverse lookup returns 'cal'
const WAREHOUSE_TO_FAC = {
  franksville:       'cal',
  madison:           'mad',
  kenosha:           'ken',
  'wisconsin rapids':'wr',
  'eau claire':      'ec',
}
const CSW_WAREHOUSE_TO_FAC = {
  'CSW-Franksville':       'cal',
  'CSW-Madison':           'mad',
  'CSW-Kenosha':           'ken',
  'CSW-Wisconsin Rapids':  'wr',
  'CSW-Eau Claire':        'ec',
}

const VIEW_H = 'labor_planning_app__hourly_labor_required_vs_available'

const VIEW_P = 'labor_planning_app__hourly_inbound_outbound_drops_summary'

// Raw appointments — source of truth for all project-level appointment data
const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_APPT     = 'gold__truck_appointments'

const PROJECT_DROP_RULES = {
  // CAL / CAL2 — PVI FG: exclude live unloads
  'Palermos CALEDONIA finished': {
    facility: 'cal',
    method: 'inbound_exclude_lookup',
    excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']],
  },

  // KEN — all inbounds are drops
  'CROWN BAKERIES':          { facility: 'ken', method: 'inbound_all' },
  'Pretzilla Kenosha':       { facility: 'ken', method: 'inbound_all' },
  'BIRCHWOOD FOODS KENOSHA': { facility: 'ken', method: 'inbound_all' },
  'FAIR OAKS FARMS':         { facility: 'ken', method: 'inbound_all' },
  'FAIR OAKS FARMS WEST':    { facility: 'ken', method: 'inbound_all' },

  // KEN — Richelieu drops only when lookup code contains TOP or PSH
  'RICHELIEU KENOSHA':               { facility: 'ken', method: 'inbound_include_lookup', includePatterns: ['TOP', 'PSH'] },
  'RICHELIEU RAW MATERIALS KENOSHA': { facility: 'ken', method: 'inbound_include_lookup', includePatterns: ['TOP', 'PSH'] },
}

// cal2 mirrors cal rules — isRuleProject needs to accept both
export function isRuleProject(facilityId, projectName) {
  const rule = PROJECT_DROP_RULES[projectName]
  if (!rule) return false
  // cal2 shares cal's rules
  const effectiveFac = facilityId === 'cal2' ? 'cal' : facilityId
  return rule.facility === effectiveFac
}

// ── B2E Roster ───────────────────────────────────────────────────
const B2E_MODEL_ID = 'f3aaca97-bb7c-405d-809b-efab83649ab3'
const ROSTER   = 'silver__b2e_slv_employeeroster'
const SCHEDULE = 'silver__b2e_slv_futurescheduleentries'

const B2E_LOCATION = {
  cal:  '019 - Caledonia',
  cal2: '019 - Caledonia',   // same location as cal
  mad:  '011 - Madison',
  ec:   '012 - Eau Claire',
  ken:  '015 - Kenosha',
  wr:   '023 - Wisconsin Rapids',
}

// Manager/supervisor employee IDs excluded from the roster board
const B2E_EXCLUDED_IDS = [
  192, 566, 619, 621, 650, 727, 750, 800, 826, 964, 966,
  5282, 5333, 5343, 5350, 5381, 5389, 5405, 5407, 5414,
  5423, 5429, 5434, 5438, 5441, 5442, 5449, 5462, 5470, 5472, 5474,
]

// CAL v2 dock assignment map: employee name → lane id on the split board.
// 3.5 side employees are mapped to side35_* lanes; everyone else defaults to side12_*.
// Partial names are checked with startsWith so middle initials don't break matches.
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

function cal2DefaultLane(name, shiftLane) {
  // shiftLane is the standard shift1/mid/shift2/shift3 from scheduleToLane
  // Map to the correct side + shift
  const is35 = [...CAL2_DOCK_NAMES_35].some(n => name.startsWith(n) || name.includes(n))
  const side = is35 ? 'side35' : 'side12'
  // Map standard shift IDs to side-prefixed IDs
  const shiftSuffix = {
    shift1: 'shift1',
    mid:    'mid',
    shift2: 'shift2',
    shift3: 'shift3',
  }[shiftLane] || 'shift1'
  return `${side}_${shiftSuffix}`
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
    let h      = parseInt(m[1], 10)
    const min  = parseInt(m[2], 10)
    const ap   = m[3]
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
      kind: 'TIME_FOR_UNIT_DURATION',
      type: 'date',
      ui_type: 'DAY',
      isFiscal: false,
      left_side: date,
      is_negative: false,
      offset_interval_string: '0 days',
    },
  }
}

function scheduledArrivalDateFilter(date) {
  return {
    [`${VIEW_APPT}.scheduled_arrival`]: {
      kind: 'TIME_FOR_UNIT_DURATION',
      type: 'date',
      ui_type: 'DAY',
      isFiscal: false,
      left_side: date,
      is_negative: false,
      offset_interval_string: '0 days',
    },
  }
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
        kind: 'TIME_FOR_UNIT_DURATION',
        type: 'date',
        ui_type: 'DAY',
        isFiscal: false,
        left_side: date,
        is_negative: false,
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
    const ts    = r[`${VIEW_H}.hour_of_day_timestamp`]
    let h = 0
    if (typeof ts === 'number') {
      h = new Date(ts > 1e12 ? ts / 1000 : ts).getUTCHours()
    } else if (typeof ts === 'string') {
      const m = ts.match(/[T ](\d{2}):/)
      h = m ? parseInt(m[1]) : 0
    }
    return {
      h,
      req:   Number(r[`${VIEW_H}.labor_required`]) || 0,
      avail: Number(r[`${VIEW_H}.labor_available_aw_update_`]) || 0,
      drops,
      inb,
      out,
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
    for (const row of rows) {
      sums[row.h] = (sums[row.h] ?? 0) + row.drops
    }
  }

  return Object.entries(sums).map(([h, total]) => ({
    h:   Number(h),
    est: Math.round(total / weeksBack),
  }))
}

async function fetchProjectDropsByRule(facilityId, date, projectName, rule) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return 0

  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
    fields: [
      `${VIEW_APPT}.lookup_code`,
      `${VIEW_APPT}.dock_appointment_type_name`,
      `${VIEW_APPT}.count`,
    ],
    filters: {
      [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      [`${VIEW_APPT}.project_name`]:   { kind: 'EQUALS', type: 'string', values: [projectName] },
      [`${VIEW_APPT}.scheduled_arrival`]: {
        kind: 'TIME_FOR_UNIT_DURATION',
        type: 'date',
        ui_type: 'DAY',
        isFiscal: false,
        left_side: date,
        is_negative: false,
        offset_interval_string: '0 days',
      },
    },
    sorts: [],
    limit: 500,
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
    modelId: GOLD_MODEL_ID,
    table: VIEW_APPT,
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
        kind: 'TIME_FOR_UNIT_DURATION',
        type: 'date',
        ui_type: 'DAY',
        isFiscal: false,
        left_side: date,
        is_negative: false,
        offset_interval_string: '0 days',
      },
    },
    sorts: [],
    limit: 500,
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
    const ts = r[`${VIEW_APPT}.scheduled_arrival`]
    let h = 0
    if (typeof ts === 'number') {
      h = new Date(ts > 1e12 ? ts / 1000 : ts).getUTCHours()
    } else if (typeof ts === 'string') {
      const m = ts.match(/[T ](\d{2}):/)
      h = m ? parseInt(m[1]) : 0
    }
    const count = Number(r[`${VIEW_APPT}.count`]) || 0
    hourCounts[h] = (hourCounts[h] ?? 0) + count
  }
  return hourCounts
}

export async function fetchHistoricalProjectHourlyDrops(facilityId, targetDate, weeksBack = 4) {
  // cal2 uses cal's historical data and rules
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
      for (const [h, count] of Object.entries(hourMap)) {
        sums[h] = (sums[h] ?? 0) + count
      }
    }
    const avgs = Object.fromEntries(
      Object.entries(sums).map(([h, total]) => [Number(h), Math.round(total / weeksBack)])
    )
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
    const counts = await Promise.all(
      pastDates.map(d => fetchProjectDropsByRule(effectiveFacId, d, projectName, rule).catch(() => 0))
    )
    sums[projectName] = counts.reduce((s, c) => s + c, 0)
  }

  return Object.entries(sums).map(([project_name, total]) => ({
    project_name,
    est_drops: Math.round(total / weeksBack),
  }))
}

export async function fetchB2eRoster(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []

  const refDate = date || new Date().toISOString().slice(0, 10)
  const isCal2  = facilityId === 'cal2'

  const [rosterRows, scheduleRows] = await Promise.all([
    omniQuery({
      modelId: B2E_MODEL_ID,
      table: ROSTER,
      fields: [
        `${ROSTER}.employee_id`,
        `${ROSTER}.employee_status`,
      ],
      filters: {
        [`${ROSTER}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        [`${ROSTER}.employee_status`]: { kind: 'EQUALS', type: 'string', values: ['Active'] },
      },
      limit: 500,
    }),
    omniQuery({
      modelId: B2E_MODEL_ID,
      table: SCHEDULE,
      fields: [
        `${SCHEDULE}.employee_id`,
        `${SCHEDULE}.first_name`,
        `${SCHEDULE}.last_name`,
        `${SCHEDULE}.default_job_code`,
        `${SCHEDULE}.start_time`,
        `${SCHEDULE}.end_time`,
        `${SCHEDULE}.modified_start_time`,
        `${SCHEDULE}.modified_end_time`,
        `${SCHEDULE}.work_schedule`,
        `${SCHEDULE}.ingestion_ts`,
      ],
      filters: {
        [`${SCHEDULE}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        [`${SCHEDULE}.entry_date`]: {
          kind: 'TIME_FOR_UNIT_DURATION',
          type: 'date',
          ui_type: 'DAY',
          isFiscal: false,
          left_side: refDate,
          is_negative: false,
          offset_interval_string: '0 days',
        },
      },
      sorts: [{ column_name: `${SCHEDULE}.ingestion_ts`, sort_descending: true }],
      limit: 500,
    }),
  ])

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))

  const schedMap = new Map()
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
      const code = String(r[`${SCHEDULE}.default_job_code`] ?? '')
      return allowedCodes.has(code)
    })
    .map(([id, { row: r }]) => {
      const startTime  = r[`${SCHEDULE}.modified_start_time`] ?? r[`${SCHEDULE}.start_time`]
      const endTime    = r[`${SCHEDULE}.modified_end_time`]   ?? r[`${SCHEDULE}.end_time`]
      const firstName  = r[`${SCHEDULE}.first_name`] || ''
      const lastName   = r[`${SCHEDULE}.last_name`]  || ''
      const fullName   = [firstName, lastName].filter(Boolean).join(' ')
      const shiftLane  = scheduleToLane(r[`${SCHEDULE}.work_schedule`], startTime)

      return {
        id,
        name:         fullName,
        role:         null,
        job_code:     String(r[`${SCHEDULE}.default_job_code`] ?? ''),
        // For cal2, map into side-prefixed lanes; otherwise use standard lane
        default_lane: isCal2 ? cal2DefaultLane(fullName, shiftLane) : shiftLane,
        shift_start:  normalizeShiftStart(startTime),
        shift_hours:  computeShiftHours(startTime, endTime),
        facility:     facilityId,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
