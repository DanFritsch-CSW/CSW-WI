'use strict'

/**
 * Netlify Function: scheduling-omni-appointments
 * Ported from front_netlify_datex/functions/omni-appointments.js (2026-08-03).
 *
 * ADAPTED (per CSW-WI's established learning on Omni reliability): the
 * original called https://csw.omniapp.co/api/v1/query/run directly. This
 * version proxies through the existing omni-query.cjs instead — it inherits
 * Arrow parsing, retry logic, and Omni-side timeout injection, and avoids
 * the known divergence where direct Netlify-function-to-Omni calls can
 * return empty rows that the client-side proxy path doesn't see.
 *
 * Returns hourly appointment counts for a given warehouse and date
 * (5am-5am shift window). Excludes cancelled appointments.
 *
 * GET /.netlify/functions/scheduling-omni-appointments?warehouse=CSW-Caledonia&date=2026-04-13
 * Response: { hours: [{ hour, inbound, outbound }], error?: string }
 */

const MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const TOPIC = 'gold__truck_appointments'

// Partial warehouse name strings for CONTAINS matching.
// CSW-Caledonia and CSW-Franksville are the same physical site.
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

// Robustly extract the hour (0-23) from a timestamp string via regex,
// avoiding Date-parsing inconsistencies with space-separated timestamps.
function extractHour(ts) {
  if (ts === null || ts === undefined) return null
  const s = String(ts)
  const m = s.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2})/)
  if (m) return parseInt(m[1], 10)
  return null
}

function omniProxyUrl() {
  const base = process.env.URL || process.env.DEPLOY_URL || ''
  return `${base}/.netlify/functions/omni-query`
}

async function fetchAppointmentRows(warehouseContains, date) {
  const query = {
    modelId: MODEL_ID,
    table: TOPIC,
    fields: [`${TOPIC}.scheduled_arrival`, `${TOPIC}.dock_appointment_type_name`, `${TOPIC}.count`],
    filters: {
      [`${TOPIC}.warehouse_name`]: { type: 'string', kind: 'CONTAINS', values: [warehouseContains], is_negative: false, case_insensitive: true },
      [`${TOPIC}.scheduled_arrival`]: { type: 'date', kind: 'TIME_FOR_UNIT_DURATION', left_side: date, is_negative: false },
      [`${TOPIC}.dock_status_name`]: { type: 'string', kind: 'EQUALS', values: ['Cancelled'], is_negative: true, case_insensitive: true },
    },
    limit: 1000,
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
  console.log(`[scheduling-omni-appointments] ${rows.length} rows from omni-query${rows.length > 0 ? ', sample: ' + JSON.stringify(rows[0]) : ''}`)
  return rows
}

// Aggregate raw rows → { [hour]: { hour, inbound, outbound } }. Matches on
// substrings of field keys since the exact key format may vary between
// display names and raw column names.
function aggregateRows(rows) {
  const hourMap = {}
  for (const row of rows) {
    let hourTs = null
    let type = ''
    let count = 0

    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined) continue
      const lk = key.toLowerCase()
      if (lk.includes('arrival')) {
        hourTs = val
      } else if (lk.includes('type') && lk.includes('name')) {
        type = String(val)
      } else if (lk.includes('count')) {
        count = typeof val === 'number' ? val : (Number(val) || 0)
      }
    }

    const h = extractHour(hourTs)
    if (h === null) continue

    if (!hourMap[h]) hourMap[h] = { hour: h, inbound: 0, outbound: 0 }
    if (type.includes('Inbound')) {
      hourMap[h].inbound += count
    } else {
      hourMap[h].outbound += count
    }
  }
  return hourMap
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }

  const params = event.queryStringParameters || {}
  const { warehouse, date } = params

  if (!warehouse || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'warehouse and date are required', hours: [] }) }
  }
  if (!process.env.OMNI_API_KEY) {
    console.warn('[scheduling-omni-appointments] OMNI_API_KEY not set')
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], error: 'OMNI_API_KEY not configured' }) }
  }

  const warehouseContains = WAREHOUSE_CONTAINS_MAP[warehouse] || warehouse.replace(/^CSW-/i, '')

  try {
    const nextDate = addDay(date)
    const [mainRows, overnightRows] = await Promise.all([
      fetchAppointmentRows(warehouseContains, date),
      fetchAppointmentRows(warehouseContains, nextDate),
    ])

    const hourMap = aggregateRows(mainRows)

    // Include overnight hours 0-4am from the next calendar date (same operational shift)
    const overnightMap = aggregateRows(overnightRows)
    for (const [h, data] of Object.entries(overnightMap)) {
      if (Number(h) < 5) hourMap[h] = data
    }

    const hours = Object.values(hourMap).filter((h) => h.inbound + h.outbound > 0)

    console.log(`[scheduling-omni-appointments] ${warehouse} ${date}: ${mainRows.length} main rows, ${overnightRows.length} overnight rows → ${hours.length} hours`)
    return { statusCode: 200, headers, body: JSON.stringify({ hours }) }
  } catch (err) {
    console.error('[scheduling-omni-appointments] error:', err.message)
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], error: err.message }) }
  }
}
