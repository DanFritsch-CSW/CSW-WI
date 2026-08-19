'use strict'

/**
 * Netlify Function: scheduling-omni-appointments
 * Ported from front_netlify_datex/functions/omni-appointments.js (2026-08-03).
 * REWRITTEN 2026-08-19: switched from Omni's gold__truck_appointments view
 * to MotherDuck-direct (via motherduck-appointments.cjs), matching Labor
 * Planning's actual data source exactly. Found while chasing a labor-number
 * mismatch Dan reported — Omni's gold view lags MotherDuck's gold layer by
 * hours (see motherduck-appointments.cjs's own header), so the Day Insights
 * bars here were showing appointment counts that didn't match the real
 * Labor Planning tab for the same date/warehouse (e.g. Outbound 57 here vs
 * 55 on the real tab). Function name kept as-is so schedulingApi.js and
 * scheduling-labor-planning-insights.cjs don't need updating.
 *
 * motherduck-appointments.cjs's own SQL already implements the 5am-5am
 * operational-day window internally, so this is now a single call instead
 * of the old main-date + next-date two-query dance.
 *
 * Returns hourly appointment counts for a given warehouse and date
 * (5am-5am shift window). Excludes cancelled appointments.
 *
 * GET /.netlify/functions/scheduling-omni-appointments?warehouse=CSW-Caledonia&date=2026-04-13
 * Response: { hours: [{ hour, inbound, outbound }], error?: string }
 */

// CSW-Caledonia and CSW-Franksville are the same physical site (facility id 'cal').
const WAREHOUSE_TO_FACILITY = {
  'CSW-Kenosha': 'ken',
  'CSW-Madison': 'mad',
  'CSW-Caledonia': 'cal',
  'CSW-Franksville': 'cal',
  'CSW-Eau Claire': 'ec',
  'CSW-Wisconsin Rapids': 'wr',
}

function baseUrl() {
  return process.env.URL || process.env.DEPLOY_URL || 'https://csw-wi.netlify.app'
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }

  const params = event.queryStringParameters || {}
  const { warehouse, date } = params

  if (!warehouse || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'warehouse and date are required', hours: [] }) }
  }

  const facilityId = WAREHOUSE_TO_FACILITY[warehouse]
  if (!facilityId) {
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], error: `Unknown warehouse "${warehouse}"` }) }
  }

  try {
    const res = await fetch(`${baseUrl()}/.netlify/functions/motherduck-appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'hourMap', facilityId, date }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`motherduck-appointments HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const json = await res.json()
    const hourMap = json.hourMap || {}

    const hours = []
    for (const [h, row] of Object.entries(hourMap)) {
      const inbound = row?.inb || 0
      const outbound = row?.out || 0
      if (inbound + outbound > 0) {
        hours.push({ hour: Number(h), inbound, outbound })
      }
    }

    console.log(`[scheduling-omni-appointments] ${warehouse} ${date}: ${hours.length} hours with appointments (MotherDuck-direct)`)
    return { statusCode: 200, headers, body: JSON.stringify({ hours }) }
  } catch (err) {
    console.error('[scheduling-omni-appointments] error:', err.message)
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], error: err.message }) }
  }
}
