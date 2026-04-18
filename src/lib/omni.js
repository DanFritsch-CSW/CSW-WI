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
const VIEW_P = 'labor_planning_app__hourly_inbound_outbound_drops_summary'

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

// Normalize B2E modified_start_time to "HH:MM" string, or null if invalid.
function normalizeShiftStart(startTime) {
  if (!startTime || startTime === '0' || startTime === 0) return null
  const s = String(startTime)
  const hour = parseInt(s.split(':')[0], 10)
  return isNaN(hour) ? null : s
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
 * Returns array of { name, inb, out, tot }
 */
export async function fetchProjectData(facilityId, date) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []

  const rows = await omniQuery({
    modelId: MODEL_ID,
    table: VIEW_P,
    fields: [
      `${VIEW_P}.project_name`,
      `${VIEW_P}.total_inbounds`,
      `${VIEW_P}.total_outbounds`,
      `${VIEW_P}.total_appointments`,
    ],
    filters: {
      [`${VIEW_P}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      ...activityDateFilter(date, VIEW_P),
      [`${VIEW_P}.total_appointments`]: {
        kind: 'EQUALS', type: 'number', values: ['0'],
        is_negative: true, is_inclusive: false,
      },
    },
    sorts: [{ column_name: `${VIEW_P}.total_appointments`, sort_descending: true }],
    limit: 100,
  })

  return rows.map(r => ({
    name: r[`${VIEW_P}.project_name`] || '',
    inb:  Number(r[`${VIEW_P}.total_inbounds`]) || 0,
    out:  Number(r[`${VIEW_P}.total_outbounds`]) || 0,
    tot:  Number(r[`${VIEW_P}.total_appointments`]) || 0,
  }))
}

/**
 * Network-level daily KPIs across all facilities.
 * Returns object keyed by facility id: { appts, inb, out, labor, util, delta }
 * Labor data from VIEW_H; appointment totals from VIEW_P (more reliable aggregates).
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
      modelId: MODEL_ID,
      table: VIEW_P,
      fields: [
        `${VIEW_P}.warehouse_name`,
        `${VIEW_P}.total_appointments`,
        `${VIEW_P}.total_inbounds`,
        `${VIEW_P}.total_outbounds`,
      ],
      filters: { ...activityDateFilter(date, VIEW_P) },
      sorts: [{ column_name: `${VIEW_P}.warehouse_name`, sort_descending: false }],
      limit: 500,
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
      labor,
      util:  labor > 0 ? Math.round(avail / labor * 100) : 0,
      delta: Math.round((avail - labor) * 10) / 10,
    }
  }

  // Group raw project rows by warehouse client-side (avoids broken aggregate field names)
  for (const r of apptRows) {
    const wh    = r[`${VIEW_P}.warehouse_name`]
    const facId = CSW_WAREHOUSE_TO_FAC[wh]
    if (!facId) continue
    if (!result[facId]) result[facId] = { labor: 0, util: 0, delta: 0 }
    result[facId].appts = (result[facId].appts || 0) + (Number(r[`${VIEW_P}.total_appointments`]) || 0)
    result[facId].inb   = (result[facId].inb   || 0) + (Number(r[`${VIEW_P}.total_inbounds`])    || 0)
    result[facId].out   = (result[facId].out   || 0) + (Number(r[`${VIEW_P}.total_outbounds`])   || 0)
  }

  return result
}

/**
 * Baseline employee roster for a facility from B2E (Omni → silver schema).
 * Two separate queries (ROSTER + SCHEDULE) joined client-side to avoid
 * Omni's implicit INNER JOIN dropping employees without recent schedule entries.
 * Exclusions applied client-side (Omni is_negative filter unreliable).
 * Returns array of { id, name, role, default_lane, facility }
 */
export async function fetchB2eRoster(facilityId, date) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return []

  const [rosterRows, scheduleRows] = await Promise.all([
    omniQuery({
      modelId: B2E_MODEL_ID,
      table: ROSTER,
      fields: [
        `${ROSTER}.employee_id`,
        `${ROSTER}.employee_name`,
      ],
      filters: {
        [`${ROSTER}.employee_status`]: { kind: 'EQUALS', type: 'string', values: ['Active'] },
        [`${ROSTER}.default_job_code`]: { kind: 'EQUALS', type: 'string', values: ['205'] },
        [`${ROSTER}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
      },
      sorts: [{ column_name: `${ROSTER}.employee_name`, sort_descending: false }],
      limit: 500,
    }),
    omniQuery({
      modelId: B2E_MODEL_ID,
      table: SCHEDULE,
      fields: [
        `${SCHEDULE}.employee_id`,
        `${SCHEDULE}.entry_date`,
        `${SCHEDULE}.start_time`,
        `${SCHEDULE}.end_time`,
        `${SCHEDULE}.modified_start_time`,
        `${SCHEDULE}.modified_end_time`,
        `${SCHEDULE}.work_schedule`,
        `${SCHEDULE}.type`,
        `${SCHEDULE}.ingestion_ts`,
      ],
      filters: {
        [`${SCHEDULE}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        ...(date ? {
          [`${SCHEDULE}.entry_date`]: {
            kind: 'TIME_FOR_UNIT_DURATION',
            type: 'date',
            ui_type: 'DAY',
            isFiscal: false,
            left_side: date,
            is_negative: false,
            offset_interval_string: '0 days',
          },
        } : {}),
      },
      sorts: [{ column_name: `${SCHEDULE}.ingestion_ts`, sort_descending: true }],
      limit: 2000,
    }),
  ])

  // Build schedule map: employee_id → most-recent row for target date
  const schedMap = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  const excluded = new Set(B2E_EXCLUDED_IDS.map(String))

  return rosterRows
    .filter(r => !excluded.has(String(r[`${ROSTER}.employee_id`])))
    .map(r => {
      const id    = String(r[`${ROSTER}.employee_id`])
      const sched = schedMap.get(id)
      const schedRow = sched?.row
      return {
        id,
        name:         r[`${ROSTER}.employee_name`] || '',
        role:         null,
        default_lane: schedRow
          ? scheduleToLane(
              schedRow[`${SCHEDULE}.work_schedule`],
              schedRow[`${SCHEDULE}.modified_start_time`] ?? schedRow[`${SCHEDULE}.start_time`],
            )
          : 'shift1',
        shift_start: schedRow
          ? normalizeShiftStart(schedRow[`${SCHEDULE}.modified_start_time`] ?? schedRow[`${SCHEDULE}.start_time`])
          : null,
        facility: facilityId,
      }
    })
}
