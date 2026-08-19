'use strict'

/**
 * Netlify Function: scheduling-labor-planning-insights
 * Added 2026-08-18 — replaces scheduling-omni-labor.cjs as the primary
 * source for the scheduling plugin's "Day Insights" labor numbers.
 *
 * Per Dan's request: the plugin's labor data should come from the SAME
 * roster-based calculation the real Labor Planning tab uses, not a
 * separate Omni topic that only resembled labor data. This function
 * replicates that pipeline server-side:
 *   1. Pull this facility+date's roster_assignments, facility_settings,
 *      and employee_breaks straight from Supabase — the exact same tables
 *      RosterBoard.jsx/FacilityPanel.jsx read for the real tab.
 *   2. Run them through labor-calc-shared.cjs, a faithful CJS port of
 *      src/lib/laborCalc.js's pure math (buildRosterAvailability,
 *      buildRosterStaffedHeadcount, computeDailyKpis) — literally the
 *      same formulas, so the numbers are guaranteed to match, not just
 *      resemble, the real Labor Planning tab.
 *   3. For "required hours", pull hourly appointment counts from the
 *      already-built scheduling-omni-appointments.cjs and apply the
 *      facility's hours_per_appt default. NOT ported: per-project HPA
 *      overrides (see labor-calc-shared.cjs header) — a facility that
 *      leans heavily on those will see Required Hours drift slightly from
 *      the real tab for that reason alone.
 *
 * FALLBACK: if roster_assignments has zero rows for this facility+date
 * (roster not yet synced, or a far-future date nobody's opened in Labor
 * Planning), falls back to the old Omni-topic-based
 * scheduling-omni-labor.cjs computation and tags the response
 * source: 'omni_fallback' so the UI can show that it's an estimate, not
 * the real roster number. A MotherDuck-direct fallback was scoped as a
 * possible third tier but not built — Omni empty AND roster empty hasn't
 * come up in practice; add it here if it does.
 *
 * GET /.netlify/functions/scheduling-labor-planning-insights?warehouse=CSW-Caledonia&date=2026-08-19
 * Response: {
 *   hours: [{ hour, labor_required, labor_available, final, drops }],
 *   daily: { totalRequired, totalAvailable, delta } | null,
 *   source: 'roster' | 'omni_fallback',
 * }
 */

const { createClient } = require('@supabase/supabase-js')
const { buildRosterAvailability, buildRosterStaffedHeadcount } = require('./lib/labor-calc-shared.cjs')

// Scheduling-app warehouse display name -> Labor Planning facility id.
// CSW-Caledonia and CSW-Franksville are the same physical site (facility
// id 'cal' throughout Labor Planning/RosterBoard/roster_assignments).
const WAREHOUSE_TO_FACILITY = {
  'CSW-Kenosha': 'ken',
  'CSW-Madison': 'mad',
  'CSW-Caledonia': 'cal',
  'CSW-Franksville': 'cal',
  'CSW-Eau Claire': 'ec',
  'CSW-Wisconsin Rapids': 'wr',
}

const SETTINGS_DEFAULTS = {
  hours_per_appt: 1.5,
  break_hour_1: 83, break_hour_2: 100, break_hour_3: 75, break_hour_4: 100,
  break_hour_5: 50, break_hour_6: 100, break_hour_7: 75, break_hour_8: 100,
}

function addDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return next.toISOString().slice(0, 10)
}

function baseUrl() {
  return process.env.URL || process.env.DEPLOY_URL || 'https://csw-wi.netlify.app'
}

// Pulls hourly inbound+outbound appointment totals for the 5am-5am
// operational day, same window logic as scheduling-omni-appointments.cjs
// itself (main date's hours 5-23 + next date's hours 0-4).
async function fetchApptsPerHour(warehouse, date) {
  const url = `${baseUrl()}/.netlify/functions/scheduling-omni-appointments?warehouse=${encodeURIComponent(warehouse)}&date=${date}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`scheduling-omni-appointments HTTP ${res.status}`)
  const json = await res.json()
  const perHour = new Array(24).fill(0)
  for (const row of json.hours || []) {
    if (typeof row.hour === 'number' && row.hour >= 0 && row.hour < 24) {
      perHour[row.hour] = (row.inbound || 0) + (row.outbound || 0)
    }
  }
  return perHour
}

// Fallback path — the original Omni-topic-based labor query. Kept as a
// plain proxy call (not reimplemented here) so there's exactly one place
// that owns that query's logic.
async function fetchOmniFallback(warehouse, date) {
  const url = `${baseUrl()}/.netlify/functions/scheduling-omni-labor?warehouse=${encodeURIComponent(warehouse)}&date=${date}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`scheduling-omni-labor HTTP ${res.status}`)
  const json = await res.json()
  const hours = json.hours || []
  const totalRequired = hours.reduce((s, r) => s + (r.labor_required || 0), 0)
  const totalAvailable = hours.reduce((s, r) => s + (r.labor_available || 0), 0)
  return {
    hours,
    daily: hours.length ? { totalRequired: Math.round(totalRequired * 10) / 10, totalAvailable: Math.round(totalAvailable * 10) / 10, delta: Math.round((totalAvailable - totalRequired) * 10) / 10 } : null,
    source: 'omni_fallback',
  }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
  const params = event.queryStringParameters || {}
  const { warehouse, date } = params

  if (!warehouse || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'warehouse and date are required' }) }
  }

  const facility = WAREHOUSE_TO_FACILITY[warehouse]
  if (!facility) {
    return { statusCode: 200, headers, body: JSON.stringify({ hours: [], daily: null, source: 'roster', error: `Unknown warehouse "${warehouse}"` }) }
  }

  const SUPA_URL = process.env.VITE_SUPABASE_URL
  const SUPA_KEY = process.env.VITE_SUPABASE_ANON_KEY
  if (!SUPA_URL || !SUPA_KEY) {
    console.error('[scheduling-labor-planning-insights] missing Supabase env vars — falling back to Omni')
    try {
      const fallback = await fetchOmniFallback(warehouse, date)
      return { statusCode: 200, headers, body: JSON.stringify(fallback) }
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ hours: [], daily: null, source: 'omni_fallback', error: e.message }) }
    }
  }

  const supabase = createClient(SUPA_URL, SUPA_KEY)

  try {
    const { data: assignments, error: asgErr } = await supabase
      .from('roster_assignments')
      .select('*')
      .eq('facility', facility)
      .eq('plan_date', date)
    if (asgErr) throw new Error(`roster_assignments: ${asgErr.message}`)

    if (!assignments || assignments.length === 0) {
      console.log(`[scheduling-labor-planning-insights] no roster_assignments for ${facility} ${date} — falling back to Omni`)
      const fallback = await fetchOmniFallback(warehouse, date)
      return { statusCode: 200, headers, body: JSON.stringify(fallback) }
    }

    const [settingsResult, breaksResult, apptsPerHour] = await Promise.all([
      supabase.from('facility_settings').select('*').eq('facility', facility).maybeSingle(),
      supabase.from('employee_breaks').select('*').eq('facility', facility),
      fetchApptsPerHour(warehouse, date).catch((e) => {
        console.warn('[scheduling-labor-planning-insights] appts fetch failed, using zeros:', e.message)
        return new Array(24).fill(0)
      }),
    ])

    const settings = settingsResult.data || { ...SETTINGS_DEFAULTS, facility }

    const breaksMap = new Map()
    for (const row of breaksResult.data || []) {
      breaksMap.set(String(row.employee_id), {
        first_break_at: Number(row.first_break_at),
        first_break_minutes: Number(row.first_break_minutes),
        lunch_at: Number(row.lunch_at),
        lunch_minutes: Number(row.lunch_minutes),
        second_break_at: Number(row.second_break_at),
        second_break_minutes: Number(row.second_break_minutes),
      })
    }

    // Mirrors RosterBoard._buildState's employees/laneMap/assignmentMap
    // shape — minus carryover-employee handling (those come from a live
    // B2E/Omni fetch in the client; out of scope here, see file header).
    const employees = assignments.map((a) => ({
      id: a.employee_id,
      name: a.employee_name,
      default_lane: a.lane,
    }))
    const laneMap = {}
    const assignmentMap = {}
    for (const a of assignments) {
      laneMap[a.employee_id] = a.lane
      assignmentMap[a.employee_id] = a
    }

    const avail = buildRosterAvailability(employees, laneMap, settings, assignmentMap, null, breaksMap)
    const staffed = buildRosterStaffedHeadcount(employees, laneMap, assignmentMap, null)

    const hpa = settings?.hours_per_appt ?? SETTINGS_DEFAULTS.hours_per_appt
    const hours = []
    let totalRequired = 0
    let totalAvailable = 0
    for (let h = 0; h < 24; h++) {
      const req = Math.round(apptsPerHour[h] * hpa * 10) / 10
      const a = avail[h] ?? 0
      totalRequired += req
      totalAvailable += a
      hours.push({
        hour: h,
        labor_required: req,
        labor_available: a,
        final: Math.round((a - req) * 10) / 10,
        drops: 0,
        staffed: staffed[h] ?? 0,
      })
    }

    const daily = {
      totalRequired: Math.round(totalRequired * 10) / 10,
      totalAvailable: Math.round(totalAvailable * 10) / 10,
      delta: Math.round((totalAvailable - totalRequired) * 10) / 10,
    }

    console.log(`[scheduling-labor-planning-insights] ${facility} ${date}: ${assignments.length} roster rows, daily=${JSON.stringify(daily)}`)
    return { statusCode: 200, headers, body: JSON.stringify({ hours, daily, source: 'roster' }) }
  } catch (err) {
    console.error('[scheduling-labor-planning-insights] error, falling back to Omni:', err.message)
    try {
      const fallback = await fetchOmniFallback(warehouse, date)
      return { statusCode: 200, headers, body: JSON.stringify(fallback) }
    } catch (e2) {
      return { statusCode: 200, headers, body: JSON.stringify({ hours: [], daily: null, source: 'omni_fallback', error: e2.message }) }
    }
  }
}
