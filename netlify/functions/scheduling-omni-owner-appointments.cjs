'use strict'

/**
 * Netlify Function: scheduling-omni-owner-appointments
 * Ported from front_netlify_datex/functions/omni-owner-appointments.js (2026-08-03).
 * Proxies through omni-query.cjs instead of calling Omni directly (same
 * adaptation as the other scheduling-omni-* functions).
 *
 * ⚠️ KNOWN RISK, ported as-is but NOT verified: the 120-day history query
 * below uses filter kind 'BETWEEN' with ISO date strings for
 * scheduled_arrival. Per this project's own confirmed Omni behavior,
 * BETWEEN with ISO timestamp strings does not reliably constrain by date and
 * can return unfiltered data — the confirmed-reliable pattern is
 * TIME_FOR_UNIT_DURATION. If the "avgDow" (day-of-week average) numbers this
 * returns look implausible (e.g. way too high, or identical regardless of
 * date range), that's the first thing to check — verify against MotherDuck
 * directly before trusting this function's output.
 *
 * Returns two datasets for a selected owner:
 *   today  — their appointments on the selected date at this warehouse (by hour)
 *   avgDow — their typical day-of-week average over the last 120 days
 *
 * GET /.netlify/functions/scheduling-omni-owner-appointments?warehouse=CSW-Caledonia&date=2026-04-13&owner=Jones+Dairy+Farm
 * Response: { today: [{ hour, inbound, outbound }], avgDow: {...} | null, error?: string }
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

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function omniProxyUrl() {
  const base = process.env.URL || process.env.DEPLOY_URL || ''
  return `${base}/.netlify/functions/omni-query`
}

async function runOmniQuery(query) {
  const res = await fetch(omniProxyUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`omni-query ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  return json.rows || []
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }

  const params = event.queryStringParameters || {}
  const { warehouse, date, owner, project } = params

  if (!warehouse || !date || !owner) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'warehouse, date, and owner are required' }) }
  }
  if (!process.env.OMNI_API_KEY) {
    console.warn('[scheduling-omni-owner-appointments] OMNI_API_KEY not configured')
    return { statusCode: 200, headers, body: JSON.stringify({ today: [], avgDow: null, error: 'OMNI_API_KEY not configured' }) }
  }

  const warehouseContains = WAREHOUSE_CONTAINS_MAP[warehouse] || warehouse.replace(/^CSW-/i, '')

  const baseFilters = {
    [`${TOPIC}.warehouse_name`]: { type: 'string', kind: 'CONTAINS', values: [warehouseContains], is_negative: false, case_insensitive: true },
    [`${TOPIC}.owner_name`]: { type: 'string', kind: 'CONTAINS', values: [owner], is_negative: false, case_insensitive: true },
    ...(project ? { [`${TOPIC}.project_name`]: { type: 'string', kind: 'CONTAINS', values: [project], is_negative: false, case_insensitive: true } } : {}),
    [`${TOPIC}.dock_status_name`]: { type: 'string', kind: 'EQUALS', values: ['Cancelled'], is_negative: true, case_insensitive: true },
  }

  const todayQuery = {
    modelId: MODEL_ID,
    table: TOPIC,
    fields: [`${TOPIC}.scheduled_arrival`, `${TOPIC}.dock_appointment_type_name`, `${TOPIC}.count`],
    filters: { ...baseFilters, [`${TOPIC}.scheduled_arrival`]: { type: 'date', kind: 'TIME_FOR_UNIT_DURATION', left_side: date, is_negative: false } },
    limit: 1000,
  }

  // ⚠️ See file-level warning — BETWEEN is unverified/potentially unreliable here.
  const cutoff = daysAgo(120)
  const todayDate = new Date().toISOString().slice(0, 10)
  const historyQuery = {
    modelId: MODEL_ID,
    table: TOPIC,
    fields: [`${TOPIC}.scheduled_arrival`, `${TOPIC}.dock_appointment_type_name`, `${TOPIC}.count`],
    filters: { ...baseFilters, [`${TOPIC}.scheduled_arrival`]: { type: 'date', kind: 'BETWEEN', left_side: cutoff, right_side: todayDate, is_negative: false } },
    limit: 5000,
  }

  let todayRows = []
  let historyRows = []
  const [todayResult2, historyResult] = await Promise.allSettled([runOmniQuery(todayQuery), runOmniQuery(historyQuery)])
  if (todayResult2.status === 'fulfilled') {
    todayRows = todayResult2.value
  } else {
    console.error('[scheduling-omni-owner-appointments] today query error:', todayResult2.reason?.message)
  }
  if (historyResult.status === 'fulfilled') {
    historyRows = historyResult.value
  } else {
    console.error('[scheduling-omni-owner-appointments] history query error:', historyResult.reason?.message)
  }

  // --- Transform today's rows ---
  const todayMap = {}
  for (const row of todayRows) {
    let hourTs = null
    let type = ''
    let count = 0
    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined) continue
      const lk = key.toLowerCase()
      if (lk.includes('count')) {
        count = typeof val === 'number' ? val : (Number(val) || 0)
      } else if (lk.includes('type') && lk.includes('name')) {
        type = String(val)
      } else if (lk.includes('arrival')) {
        hourTs = val
      }
    }
    if (hourTs === null) continue
    const h = extractHour(hourTs)
    if (h === null) continue
    if (!todayMap[h]) todayMap[h] = { hour: h, inbound: 0, outbound: 0 }
    if (type.includes('Inbound')) {
      todayMap[h].inbound += count
    } else {
      todayMap[h].outbound += count
    }
  }

  const todayResult = Object.values(todayMap)
    .filter((h) => h.inbound + h.outbound > 0)
    .sort((a, b) => {
      const sa = a.hour < 5 ? a.hour + 24 : a.hour
      const sb = b.hour < 5 ? b.hour + 24 : b.hour
      return sa - sb
    })

  // --- Compute day-of-week average from 120-day history ---
  const [reqY, reqM, reqD] = date.split('-').map(Number)
  const reqDow = new Date(reqY, reqM - 1, reqD).getDay()
  const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  function countDowOccurrences(targetDow, daysBack) {
    let n = 0
    const base = new Date()
    for (let i = 0; i <= daysBack; i++) {
      const d = new Date(base)
      d.setDate(d.getDate() - i)
      if (d.getDay() === targetDow) n++
    }
    return n
  }
  const dowOccurrences = countDowOccurrences(reqDow, 120)

  function extractDate(ts) {
    if (ts === null || ts === undefined) return null
    const s = String(ts)
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
    return m ? m[1] : null
  }

  let dowInbound = 0
  let dowOutbound = 0
  for (const row of historyRows) {
    let arrivalTs = null
    let type = ''
    let count = 0
    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined) continue
      const lk = key.toLowerCase()
      if (lk.includes('count')) {
        count = typeof val === 'number' ? val : (Number(val) || 0)
      } else if (lk.includes('type') && lk.includes('name')) {
        type = String(val)
      } else if (lk.includes('arrival')) {
        arrivalTs = val
      }
    }
    const dateStr = extractDate(arrivalTs)
    if (!dateStr) continue
    const [dY, dM, dD] = dateStr.split('-').map(Number)
    const rowDow = new Date(dY, dM - 1, dD).getDay()
    if (rowDow !== reqDow) continue
    if (type.includes('Inbound')) {
      dowInbound += count
    } else {
      dowOutbound += count
    }
  }

  const avgDow = dowOccurrences > 0
    ? {
        dayName: DOW_NAMES[reqDow],
        inbound: Math.round((dowInbound / dowOccurrences) * 10) / 10,
        outbound: Math.round((dowOutbound / dowOccurrences) * 10) / 10,
        total: Math.round(((dowInbound + dowOutbound) / dowOccurrences) * 10) / 10,
        occurrences: dowOccurrences,
      }
    : null

  console.log(`[scheduling-omni-owner-appointments] ${warehouse} ${date} owner="${owner}" project="${project || ''}": todayRows=${todayRows.length} historyRows=${historyRows.length} reqDow=${reqDow}(${DOW_NAMES[reqDow]}) dowOccurrences=${dowOccurrences} avgDow=${JSON.stringify(avgDow)}`)

  return { statusCode: 200, headers, body: JSON.stringify({ today: todayResult, avgDow }) }
}
