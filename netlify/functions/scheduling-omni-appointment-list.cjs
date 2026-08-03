'use strict'

/**
 * Netlify Function: scheduling-omni-appointment-list
 * Ported from front_netlify_datex/functions/omni-appointment-list.js (2026-08-03).
 * Proxies through omni-query.cjs instead of calling Omni directly (same
 * reliability adaptation as scheduling-omni-appointments.cjs).
 *
 * Returns individual appointment records for a warehouse + date (5am-5am
 * shift window) — populates expandable hourly detail rows in the Day
 * Insights panel. Excludes cancelled appointments.
 *
 * GET /.netlify/functions/scheduling-omni-appointment-list?warehouse=CSW-Caledonia&date=2026-04-13
 * Response: { appts: [{ hour, time, code, dock_door, type }], error?: string }
 */

const MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const TOPIC = 'gold__truck_appointments'

const WAREHOUSE_CONTAINS_MAP = {
  'CSW-Kenosha': 'Kenosha',
  'CSW-Madison': 'Madison',
  'CSW-Caledonia': 'Franksville',
  'CSW-Franksville': 'Franksville',
  'CSW-Eau Claire': 'Eau Claire',
  'CSW-Wisconsin Rapids': 'Wisconsin Rapids',
}

function addDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return next.toISOString().slice(0, 10)
}

function extractHour(ts) {
  if (ts === null || ts === undefined) return null
  const s = String(ts)
  const m = s.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2})/)
  if (m) return parseInt(m[1], 10)
  return null
}

// Format timestamp → compact 12h time string, e.g. "6:00a", "11:30a", "2:15p"
function extractTime(ts) {
  if (!ts) return null
  const m = String(ts).match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = m[2]
  if (h === 0) return `12:${min}a`
  if (h === 12) return `12:${min}p`
  if (h < 12) return `${h}:${min}a`
  return `${h - 12}:${min}p`
}

function omniProxyUrl() {
  const base = process.env.URL || process.env.DEPLOY_URL || ''
  return `${base}/.netlify/functions/omni-query`
}

async function fetchRows(warehouseContains, date) {
  const query = {
    modelId: MODEL_ID,
    table: TOPIC,
    fields: [
      `${TOPIC}.scheduled_arrival`,
      `${TOPIC}.dock_appointment_type_name`,
      `${TOPIC}.location_container_name`, // dock door name
      `${TOPIC}.owner_name`,
    ],
    filters: {
      [`${TOPIC}.warehouse_name`]: { type: 'string', kind: 'CONTAINS', values: [warehouseContains], is_negative: false, case_insensitive: true },
      [`${TOPIC}.scheduled_arrival`]: { type: 'date', kind: 'TIME_FOR_UNIT_DURATION', left_side: date, is_negative: false },
      [`${TOPIC}.dock_status_name`]: { type: 'string', kind: 'EQUALS', values: ['Cancelled'], is_negative: true, case_insensitive: true },
    },
    limit: 500,
  }

  const res = await fetch(omniProxyUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`omni-query ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  const rows = json.rows || []
  if (rows.length > 0) {
    console.log(`[scheduling-omni-appointment-list] ${rows.length} rows, sample keys: ${JSON.stringify(Object.keys(rows[0]))}`)
  }
  return rows
}

function parseRows(rows) {
  return rows
    .map((row) => {
      let arrival = null
      let type = ''
      let dock_door = null
      let code = null
      for (const [key, val] of Object.entries(row)) {
        if (val === null || val === undefined) continue
        const lk = key.toLowerCase()
        if (lk.includes('arrival')) {
          arrival = String(val)
        } else if (lk.includes('type') && lk.includes('name')) {
          type = String(val)
        } else if (lk.includes('location') || lk.includes('container')) {
          dock_door = String(val)
        } else if (lk.includes('owner')) {
          code = String(val)
        }
      }
      const hour = extractHour(arrival)
      const time = extractTime(arrival)
      return { hour, time, code, dock_door, type }
    })
    .filter((r) => r.hour !== null)
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }

  const params = event.queryStringParameters || {}
  const { warehouse, date } = params

  if (!warehouse || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'warehouse and date are required', appts: [] }) }
  }
  if (!process.env.OMNI_API_KEY) {
    console.warn('[scheduling-omni-appointment-list] OMNI_API_KEY not set')
    return { statusCode: 200, headers, body: JSON.stringify({ appts: [], error: 'OMNI_API_KEY not configured' }) }
  }

  const warehouseContains = WAREHOUSE_CONTAINS_MAP[warehouse] || warehouse.replace(/^CSW-/i, '')

  try {
    const nextDate = addDay(date)
    const [mainRows, overnightRows] = await Promise.all([
      fetchRows(warehouseContains, date),
      fetchRows(warehouseContains, nextDate),
    ])

    const mainAppts = parseRows(mainRows)
    const overnightAppts = parseRows(overnightRows).filter((r) => r.hour < 5)

    const appts = [...mainAppts, ...overnightAppts]

    console.log(`[scheduling-omni-appointment-list] ${warehouse} ${date}: ${appts.length} appts (${mainAppts.length} main + ${overnightAppts.length} overnight)`)
    return { statusCode: 200, headers, body: JSON.stringify({ appts }) }
  } catch (err) {
    console.error('[scheduling-omni-appointment-list] error:', err.message)
    return { statusCode: 200, headers, body: JSON.stringify({ appts: [], error: err.message }) }
  }
}
