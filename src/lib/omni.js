// Omni Analytics API helpers
// Calls /.netlify/functions/omni-query (server-side proxy) to avoid CORS.
// Auth: OMNI_API_KEY env var set in Netlify dashboard.

const MODEL_ID = '79a98af2-a904-4b5d-b25f-7f6a2c7ef467'

// Map facility IDs → Omni warehouse_name values used in labor_planning_app tables
const LABOR_WAREHOUSE = {
  cal: 'franksville',
  mad: 'madison',
  ken: 'kenosha',
  wr:  'wisconsin rapids',
  ec:  'eau claire',
}

// Map facility IDs → warehouse_name used in appointments/summary tables (CSW- prefix)
const CSW_WAREHOUSE = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

// Reverse maps: Omni warehouse_name → facility id
const WAREHOUSE_TO_FAC = Object.fromEntries(
  Object.entries(LABOR_WAREHOUSE).map(([k, v]) => [v, k])
)
const CSW_WAREHOUSE_TO_FAC = Object.fromEntries(
  Object.entries(CSW_WAREHOUSE).map(([k, v]) => [v, k])
)

const VIEW_H = 'labor_planning_app__hourly_labor_required_vs_available'

// NOTE: VIEW_P (labor_planning_app__hourly_inbound_outbound_drops_summary) is NO LONGER
// used for project-level or network appointment queries. The underlying dbt pipeline
// (model.data_platform.hourly_inbound_outbound_drops_summary) has a broken activity_date
// aggregation that stores all appointments for newer projects under a null date, causing
// them to be filtered out when querying by date. All appointment queries now use
// gold__truck_appointments directly. Consultants should fix the dbt model and this can
// be revisited once the pipeline is confirmed stable.
const VIEW_P = 'labor_planning_app__hourly_inbound_outbound_drops_summary'

// Raw appointments — source of truth for all project-level appointment data
const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_APPT     = 'gold__truck_appointments'

// Per-project drop estimation rules used during historical averaging.
// Methods (all case-insensitive on lookup_code):
//   inbound_all:             count all Inbound-type appointments
//   inbound_exclude_lookup:  excludeWhenAll is an array of AND-groups; a row is excluded when its
//                            lookup_code matches ALL patterns in any single group.
//   inbound_include_lookup:  count Inbound appts where lookup_code contains ANY of includePatterns
const PROJECT_DROP_RULES = {
  // CAL — PVI FG: exclude live unloads identified by PUR *combined with* CMM or Peter Brothers carrier.
  // PUR alone (other carriers) still counts as a drop. CMM/Peter Brothers without PUR are also drops.
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

// Returns true if projectName has a drop rule for the given facilityId.
// Used to filter stale Supabase data seeded before facility guards were added.
export function isRuleProject(facilityId, projectName) {
  const rule = PROJECT_DROP_RULES[projectName]
  return rule != null && rule.facility === facilityId
}

// ── B2E Roster ───────────────────────────────────────────────────
const B2E_MODEL_ID = 'f3aaca97-bb7c-405d-809b-efab83649ab3'
const ROSTER   = 'silver__b2e_slv_employeeroster'
const SCHEDULE = 'silver__b2e_slv_futurescheduleentries'

const B2E_LOCATION = {
  cal: '019 - Caledonia',
  mad: '011 - Madison',
  ec:  '012 - Eau Claire',
  ken: '015 - Kenosha',
  wr:  '023 - Wisconsin Rapids',
}

// Manager/supervisor employee IDs excluded from the roster board
const B2E_EXCLUDED_IDS = [
  192, 566, 619, 621, 650, 727, 750, 800, 826, 964, 966,
  5282, 5333, 5343, 5350, 5381, 5389, 5405, 5407, 5414,
  5423, 5429, 5434, 5438, 5441, 5442, 5449, 5462, 5470, 5472, 5474,
]

function scheduleToLane(workSchedule, startTime) {
  const ws = (workSchedule || '').toLowerCase()
  if (ws.includes('1st shift')) return 'shift1'
  if (ws.includes('mid'))       return 'mid'
  if (ws.includes('2nd shift')) return 'shift2'
  if (ws.includes('3rd shift')) return 'shift3'
  // 4x10s and free-flow: fall through to start-time bucketing
  if (startTime && startTime !== '0' && startTime !== 0) {
    const hour = parseInt(String(startTime).split(':')[0], 10)
    if (!isNaN(hour)) {
      if (hour < 10)             return 'shift1'  // 4am–9am
      if (hour < 14)             return 'mid'     // 10am–1pm
      if (hour < 20)             return 'shift2'  // 2pm–7pm
      return 'shift3'                             // 8pm–3am
    }
  }
  return 'shift1'
}

// Parse B2E time strings to a decimal 24-hour value.
// Handles "H:MMa" / "H:MMp" (Omni format), "HH:MM" (24-hour), and plain numeric hours.
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

// Returns integer start hour (0-23) for array indexing in the availability calc.
function normalizeShiftStart(startTime) {
  const h = parseB2eTime(startTime)
  return h != null ? Math.floor(h) : null
}

// Returns shift duration in decimal hours (e.g. 8.5), rounded to nearest 0.5.
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

/**
 * Hourly labor + appointment data for a facility on a given date.
 * Returns array of { h, req, avail, appts, inb, out }
 */
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
    // ts may be epoch ms/μs number or ISO string; extract UTC hour
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

/**
 * Project-level throughput for a facility on a given date.
 * Queries gold__truck_appointments directly — bypasses the broken dbt pipeline
 * in labor_planning_app__hourly_inbound_outbound_drops_summary which stores all
 * appointments for newer projects under a null activity_date.
 * Returns array of { name, inb, out, drops, tot }
 */
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

  // Aggregate by project name client-side
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

/**
 * Network-level daily KPIs across all facilities.
 * Returns object keyed by facility id: { appts, inb, out, labor, util, delta }
 * Labor data from VIEW_H; appointment totals from gold__truck_appointments.
 */
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

  // Aggregate appointment counts from gold by warehouse
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

/**
 * Fetch historical hourly drops for the same day-of-week as targetDate over the past
 * weeksBack weeks, then return the per-hour average as [{ h, est }].
 * Used to auto-seed hourly_drops_forecast when no manual data exists for a date.
 */
export async function fetchHistoricalHourlyDrops(facilityId, targetDate, weeksBack = 4) {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')

  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })

  const results = await Promise.all(pastDates.map(d => fetchHourlyData(facilityId, d).catch(() => [])))

  // Average drops per hour across all fetched weeks.
  // Divide by weeksBack (not weeks-with-data) so hours with zero drops in a week
  // are included in the denominator rather than inflating the average.
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

/**
 * Fetch historical project-level drops for the same day-of-week as targetDate over the past
 * weeksBack weeks, then return the per-project average as [{ project_name, est_drops }].
 * Used to auto-seed project_drops_forecast when no manual data exists for a date.
 */
// Queries raw appointments for a single project+date and applies a PROJECT_DROP_RULES rule.
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

// Like fetchProjectDropsByRule but returns { [hour]: count } instead of a total.
// Adds scheduled_arrival to the selected fields so we can group drops by UTC hour.
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
    // Extract UTC hour from scheduled_arrival (mirrors fetchHourlyData hour parsing)
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

/**
 * Fetch historical per-project hourly drops for the same day-of-week as targetDate
 * over the past weeksBack weeks, returning a 4-week average per project per hour.
 * Returns { [projectName]: { [hour]: avgDrops } }.
 */
export async function fetchHistoricalProjectHourlyDrops(facilityId, targetDate, weeksBack = 4) {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')

  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })

  // Determine which projects at this facility have drop rules
  const results = await Promise.all(pastDates.map(d => fetchProjectData(facilityId, d).catch(() => [])))
  const ruleProjects = [...new Set(results.flat().map(r => r.name).filter(n => PROJECT_DROP_RULES[n]?.facility === facilityId))]

  const out = {} // { projectName: { hour: avgDrops } }

  for (const projectName of ruleProjects) {
    const rule = PROJECT_DROP_RULES[projectName]
    const weeklyHourCounts = await Promise.all(
      pastDates.map(d => fetchProjectHourlyDropsByRule(facilityId, d, projectName, rule).catch(() => ({})))
    )
    // Sum per hour across all weeks, then average by weeksBack
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
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const base = new Date(targetDate + 'T00:00:00Z')

  const pastDates = Array.from({ length: weeksBack }, (_, i) => {
    const d = new Date(base.getTime() - (i + 1) * MS_PER_WEEK)
    return d.toISOString().slice(0, 10)
  })

  // Fetch project data for all past dates in parallel.
  // Only projects explicitly listed in PROJECT_DROP_RULES get a non-zero EST drops value.
  // All others default to 0 until their drop logic is confirmed and added to the config.
  const results = await Promise.all(pastDates.map(d => fetchProjectData(facilityId, d).catch(() => [])))

  const sums = {}

  // For projects with custom rules, query raw appointments sequentially (one project at a time)
  // to avoid overwhelming the Omni API with too many simultaneous requests.
  const ruleProjects = [...new Set(results.flat().map(r => r.name).filter(n => PROJECT_DROP_RULES[n]?.facility === facilityId))]
  for (const projectName of ruleProjects) {
    const rule = PROJECT_DROP_RULES[projectName]
    const counts = await Promise.all(
      pastDates.map(d => fetchProjectDropsByRule(facilityId, d, projectName, rule).catch(() => 0))
    )
    sums[projectName] = counts.reduce((s, c) => s + c, 0)
  }

  return Object.entries(sums).map(([project_name, total]) => ({
    project_name,
    est_drops: Math.round(total / weeksBack),
  }))
}

/**
 * Baseline employee roster for a facility from B2E (Omni → silver schema).
 * Single query against futurescheduleentries — name, location, shift label, and
 * start/end times all live there. Deduplicates on employee_id keeping the
 * most-recently ingested row. Hour-bucketing fallback in scheduleToLane is
 * retained until work_schedule reliability is confirmed across all facilities.
 */
export async function fetchB2eRoster(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []

  const refDate = date || new Date().toISOString().slice(0, 10)

  // Two parallel queries:
  // ROSTER   → active employee ID set (authoritative termination filter); no name fields here
  // SCHEDULE → names, job codes, shift times for the target date
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

  // Active employee ID set from ROSTER (termination gate)
  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))

  // Deduplicate SCHEDULE by employee — keep latest ingestion
  const schedMap = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  const excluded     = new Set(B2E_EXCLUDED_IDS.map(String))
  const allowedCodes = new Set(['205', '209'])

  // Build from SCHEDULE (names + shift times), gated by active ROSTER membership.
  // Terminated employees with stale schedule entries are excluded because they
  // won't appear in the ROSTER active set.
  return [...schedMap.entries()]
    .filter(([id, { row: r }]) => {
      if (!activeIds.has(id)) return false   // not in active ROSTER → terminated
      if (excluded.has(id)) return false
      const code = String(r[`${SCHEDULE}.default_job_code`] ?? '')
      return allowedCodes.has(code)
    })
    .map(([id, { row: r }]) => {
      const startTime  = r[`${SCHEDULE}.modified_start_time`] ?? r[`${SCHEDULE}.start_time`]
      const endTime    = r[`${SCHEDULE}.modified_end_time`]   ?? r[`${SCHEDULE}.end_time`]
      const firstName  = r[`${SCHEDULE}.first_name`] || ''
      const lastName   = r[`${SCHEDULE}.last_name`]  || ''
      return {
        id,
        name:         [firstName, lastName].filter(Boolean).join(' '),
        role:         null,
        job_code:     String(r[`${SCHEDULE}.default_job_code`] ?? ''),
        default_lane: scheduleToLane(r[`${SCHEDULE}.work_schedule`], startTime),
        shift_start:  normalizeShiftStart(startTime),
        shift_hours:  computeShiftHours(startTime, endTime),
        facility:     facilityId,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
