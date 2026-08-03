'use strict'

/**
 * Netlify Function: scheduling-omni-labor
 * Ported from front_netlify_datex/functions/omni-labor.js (2026-08-03).
 * Proxies through omni-query.cjs instead of calling Omni directly.
 *
 * This is the function Dan flagged as the actual target for wiring the
 * scheduling app's "insights" into CSW-WI's real labor planning data — see
 * the Front thread (cnv_1c0xstn8) where he said he wants to flip this over
 * so scheduling shows a schedule/don't-schedule signal at booking time.
 * Right now it's still pointed at the same Omni topic
 * (labor_planning_app__hourly_labor_required_vs_available) the standalone
 * app used — a good next step once this whole port is live would be
 * swapping this for a direct call into src/lib/laborCalc.js instead of a
 * second Omni round-trip, since CSW-WI already computes this.
 *
 * ⚠️ Same unverified-filter note as scheduling-omni-owner-appointments.cjs:
 * uses `kind: 'BETWEEN'` for the activity_date filter (even for a single-day
 * range here). If labor numbers look wrong, check this first.
 *
 * Returns hourly labor staffing (required vs available) for a warehouse and
 * date. final = labor_available - labor_required (negative = short-staffed).
 *
 * GET /.netlify/functions/scheduling-omni-labor?warehouse=CSW-Caledonia&date=2026-04-13
 * Response: { hours: [{ hour, labor_required, labor_available, final, drops }] }
 */

const MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const TOPIC = 'labor_planning_app__hourly_labor_required_vs_available'

// CSW-Caledonia is the same physical site as CSW-Franksville — stored as
// "franksville" in labor data. labor_planning_app.* views use lowercase
// warehouse names (matches this project's known MotherDuck convention).
const WAREHOUSE_LABOR_MAP = {
  'CSW-Kenosha': 'kenosha',
  'CSW-Madison': 'madison',
  'CSW-Caledonia': 'franksville',
  'CSW-Franksville': 'franksville',
  'CSW-Eau Claire': 'eau claire',
  'CSW-Wisconsin Rapids': 'wisconsin rapids',
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

function omniProxyUrl() {
  const base = process.env.URL || process.env.DEPLOY_URL || ''
  return `${base}/.netlify/functions/omni-query`
}

async function fetchLaborRows(laborWarehouse, activityDate) {
  const query = {
    modelId: MODEL_ID,
    table: TOPIC,
    fields: [`${TOPIC}.hour_of_day_timestamp`, `${TOPIC}.labor_required`, `${TOPIC}.labor_available_aw_update_`, `${TOPIC}.drops`],
    filters: {
      [`${TOPIC}.warehouse_name`]: { type: 'string', kind: 'CONTAINS', values: [laborWarehouse], is_negative: false, case_insensitive: true },
      [`${TOPIC}.activity_date`]: { type: 'date', kind: 'BETWEEN', left_side: activityDate, right_side: addDay(activityDate), is_negative: false },
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
  return json.rows || []
}

// Match by substring to handle both display-name and underscore key formats.
function parseRows(rows) {
  const hourMap = {}
  for (const row of rows) {
    let hourTs = null
    let laborReq = 0
    let laborAvail = 0
    let drops = 0

    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined) continue
      const lk = key.toLowerCase()
      if (lk.includes('hour') && (lk.includes('day') || lk.includes('timestamp'))) {
        hourTs = val
      } else if (lk.includes('available')) {
        laborAvail = parseFloat(val) || 0
      } else if (lk.includes('required')) {
        laborReq = parseFloat(val) || 0
      } else if (lk === 'drops' || (lk.includes('drops') && !lk.includes('outbound'))) {
        drops = parseFloat(val) || 0
      }
    }

    if (hourTs === null) continue
    const h = extractHour(hourTs)
    if (h === null) continue

    hourMap[h] = { hour: h, labor_required: laborReq, labor_available: laborAvail, final: laborAvail - laborReq, drops }
  }
  return hourMap
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }

  const params = event.queryStringParameters || {}
  const { warehouse, date } = params

  if (!warehouse || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'warehouse and date are required' }) }
  }
  if (!process.env.OMNI_API_KEY) {
    console.warn('[scheduling-omni-labor] OMNI_API_KEY not configured')
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], error: 'OMNI_API_KEY not configured' }) }
  }

  const laborWarehouse = WAREHOUSE_LABOR_MAP[warehouse]
  if (!laborWarehouse) {
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [] }) }
  }

  try {
    const nextDate = addDay(date)
    const [mainRows, overnightRows] = await Promise.all([
      fetchLaborRows(laborWarehouse, date),
      fetchLaborRows(laborWarehouse, nextDate),
    ])

    console.log(`[scheduling-omni-labor] ${mainRows.length} main rows, ${overnightRows.length} overnight rows`)

    const hourMap = parseRows(mainRows)

    const overnightMap = parseRows(overnightRows)
    for (const [h, data] of Object.entries(overnightMap)) {
      if (Number(h) < 5) hourMap[h] = data
    }

    const hours = Object.values(hourMap)
    console.log(`[scheduling-omni-labor] ${warehouse} ${date}: ${mainRows.length} main + ${overnightRows.length} overnight rows → ${hours.length} hours`)
    return { statusCode: 200, headers, body: JSON.stringify({ hours }) }
  } catch (err) {
    console.error('[scheduling-omni-labor] error:', err.message)
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], error: err.message }) }
  }
}
