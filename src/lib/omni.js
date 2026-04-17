// Omni Analytics API helpers
// Calls /.netlify/functions/omni-query (server-side proxy) to avoid CORS.
// Auth: OMNI_API_KEY env var set in Netlify dashboard.

const MODEL_ID = '79a98af2-a904-4b5d-b25f-7f6a2c7ef467'

// Map facility IDs → Omni warehouse_name values used in labor_planning_app tables
const LABOR_WAREHOUSE = {
  cal: 'caledonia',
  mad: 'madison',
  ken: 'kenosha',
  wr:  'wisconsin rapids',
  ec:  'eau claire',
}

// Map facility IDs → warehouse_name used in appointments/summary tables (CSW- prefix)
const CSW_WAREHOUSE = {
  cal: 'CSW-Caledonia',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

// Reverse map for fetchNetworkKpis: Omni warehouse_name → facility id
const WAREHOUSE_TO_FAC = Object.fromEntries(
  Object.entries(LABOR_WAREHOUSE).map(([k, v]) => [v, k])
)

const VIEW_H = 'labor_planning_app__hourly_labor_required_vs_available'
const VIEW_P = 'labor_planning_app__hourly_inbound_outbound_drops_summary'

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

function dateFilter(field, date) {
  return {
    [field]: {
      kind: 'TIME_FOR_UNIT_DURATION',
      type: 'date',
      ui_type: 'DAY',
      isFiscal: false,
      left_side: date,
      is_negative: false,
      offset_interval_string: null,
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
      `${VIEW_H}.hour_of_day`,
      `${VIEW_H}.labor_required`,
      `${VIEW_H}.labor_available_aw_update_`,
      `${VIEW_H}.inbound_count`,
      `${VIEW_H}.outbound_count`,
      `${VIEW_H}.drops`,
    ],
    filters: {
      [`${VIEW_H}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
      ...dateFilter(`${VIEW_H}.labor_shift_timestamp`, date),
    },
    sorts: [{ column_name: `${VIEW_H}.hour_of_day`, sort_descending: false }],
    limit: 100,
  })

  return rows.map(r => {
    const inb = Number(r[`${VIEW_H}.inbound_count`]) || 0
    const out = Number(r[`${VIEW_H}.outbound_count`]) || 0
    const drops = Number(r[`${VIEW_H}.drops`]) || 0
    return {
      h:     Number(r[`${VIEW_H}.hour_of_day`]) || 0,
      req:   Number(r[`${VIEW_H}.labor_required`]) || 0,
      avail: Number(r[`${VIEW_H}.labor_available_aw_update_`]) || 0,
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
      ...dateFilter(`${VIEW_P}.activity_date`, date),
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
 * Returns object keyed by facility id: { appts, inb, out, labor, util }
 */
export async function fetchNetworkKpis(date) {
  const rows = await omniQuery({
    modelId: MODEL_ID,
    table: VIEW_H,
    fields: [
      `${VIEW_H}.warehouse_name`,
      `${VIEW_H}.total_appointments_sum`,
      `${VIEW_H}.inbound_count_sum`,
      `${VIEW_H}.outbound_count_sum`,
      `${VIEW_H}.labor_required_sum`,
      `${VIEW_H}.adjusted_staffed_employee_sum`,
    ],
    filters: {
      ...dateFilter(`${VIEW_H}.labor_shift_timestamp`, date),
    },
    sorts: [{ column_name: `${VIEW_H}.warehouse_name`, sort_descending: false }],
    limit: 100,
  })

  const result = {}
  for (const r of rows) {
    const wh = r[`${VIEW_H}.warehouse_name`]
    const facId = WAREHOUSE_TO_FAC[wh]
    if (!facId) continue
    const labor = Number(r[`${VIEW_H}.labor_required_sum`]) || 0
    const avail = Number(r[`${VIEW_H}.adjusted_staffed_employee_sum`]) || 0
    result[facId] = {
      appts: Number(r[`${VIEW_H}.total_appointments_sum`]) || 0,
      inb:   Number(r[`${VIEW_H}.inbound_count_sum`]) || 0,
      out:   Number(r[`${VIEW_H}.outbound_count_sum`]) || 0,
      labor,
      util:  labor > 0 ? Math.round(avail / labor * 100) : 0,
    }
  }
  return result
}
