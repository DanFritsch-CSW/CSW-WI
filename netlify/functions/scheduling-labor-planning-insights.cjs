'use strict'

/**
 * Netlify Function: scheduling-labor-planning-insights
 * Added 2026-08-18, REWRITTEN 2026-08-19 for full parity with the real
 * Labor Planning tab after Dan reported the numbers didn't match:
 *   - Avail Hrs was missing carryover employees (overnight 3rd-shift
 *     employees whose shift tails past 5am into today) — these are fetched
 *     live from B2E/MotherDuck, never written to roster_assignments.
 *   - Req Hrs was missing EST Drops (forecasted per-project workload from
 *     project_hourly_drops_forecast) entirely, AND was using Omni-sourced
 *     appointment counts instead of the MotherDuck-direct source Labor
 *     Planning actually uses (Omni's gold view lags MotherDuck's gold
 *     layer by hours — see motherduck-appointments.cjs's own header).
 *   - Per-project Hours-Per-Appointment overrides (project_labor_assumptions)
 *     weren't applied at all.
 *
 * FIXED AGAIN 2026-08-19 (same day, after appointment counts + Avail Hrs
 * matched exactly but Req Hrs was still off by ~8): found a genuine latent
 * bug in FacilityPanel.jsx's own perHourReq memo, not something introduced
 * here. perHourReq looks up a project's live appointment count via
 * `perProjectHourly[h][name]`, but the data that's built from
 * (fetchProjectHourlyAppointments -> motherduck-appointments.cjs's
 * projectHourly mode) returns a FLAT {inb, out} object per hour — an
 * aggregate across ALL requested projects combined, never broken out per
 * project name. So `perProjectHourly[h][name]` always resolves to
 * `undefined` in the real app, and override-HPA projects never actually
 * get credit for their live appointments — only their EST Drops forecast
 * counts toward the override rate. An earlier version of this file fetched
 * each override project's REAL live count (correctly) — more accurate than
 * the real app, but for that exact reason didn't match its displayed
 * number. Now replicates the bug on purpose (see the override-blend
 * comment below) rather than silently being "more correct" than what
 * Dan's team actually sees. Worth fixing in FacilityPanel.jsx itself at
 * some point, but that's a separate decision since it would change Labor
 * Planning's own displayed Req Hrs number.
 *
 * FIXED AGAIN 2026-08-19 (same day, after Req Hrs also matched): Dan
 * pointed out the `delta` field mirrors Labor Planning's "Daily +/-" pill,
 * not "Daily +/- After Adj" — the number that also folds in manual hourly
 * labor adjustments ops enters directly (the ADJ column in the Hourly
 * Breakdown table). Added `totalAdj`/`laborAfterAdj`/`deltaAfterAdj` to the
 * `daily` response, mirroring KpiPills.jsx's exact formulas:
 *   laborAfterAdj = totalAvailable + totalAdj
 *   deltaAfterAdj = laborAfterAdj - totalRequired
 *
 * This version replicates FacilityPanel.jsx's full pipeline:
 *   1. roster_assignments (Supabase) — today's synced roster, as before.
 *   2. Carryover employees — live fetch via motherduck-b2e-roster.cjs,
 *      mirroring fetchB2eRoster's prior-night carryover logic in
 *      src/lib/omni.js exactly (same stale-snapshot filter, same
 *      linearEnd > 29 cutoff).
 *   3. EST Drops — read directly from project_hourly_drops_forecast
 *      (Supabase). NOT recomputed here (that's an expensive multi-week L4W
 *      calculation) — reads whatever FacilityPanel.jsx already seeded/the
 *      team already edited, which is exactly what the real tab displays.
 *   4. Live appointment counts — via motherduck-appointments.cjs (the same
 *      MotherDuck-direct source Labor Planning uses), NOT Omni.
 *   5. Per-project HPA overrides — project_labor_assumptions (Supabase),
 *      blended exactly like FacilityPanel.jsx's perHourReq memo — drops
 *      only, per the bug described above.
 *   6. Manual hourly labor adjustments (hourly_labor_adjustments, Supabase)
 *      — summed into totalAdj/laborAfterAdj/deltaAfterAdj, per Dan's
 *      2026-08-19 follow-up above.
 *
 * FALLBACK: unchanged from the first version — if roster_assignments has
 * zero rows for this facility+date, falls back to the old Omni-topic-based
 * scheduling-omni-labor.cjs and tags source: 'omni_fallback'. (The
 * fallback path doesn't compute totalAdj/laborAfterAdj/deltaAfterAdj —
 * those fields are omitted, matching the original omni_fallback shape.)
 *
 * GET /.netlify/functions/scheduling-labor-planning-insights?warehouse=CSW-Caledonia&date=2026-08-19
 * Response: {
 *   hours: [{ hour, labor_required, labor_available, final, drops, staffed }],
 *   daily: { totalRequired, totalAvailable, delta, totalAdj, laborAfterAdj, deltaAfterAdj } | null,
 *   source: 'roster' | 'omni_fallback',
 * }
 */

const { createClient } = require('@supabase/supabase-js')
const { buildRosterAvailability, buildRosterStaffedHeadcount } = require('./lib/labor-calc-shared.cjs')

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

// Mirrors getAllowedJobCodes in src/lib/omni.js exactly.
function allowedJobCodes(facilityId) {
  return (facilityId === 'mad' || facilityId === 'ec') ? new Set(['205', '209']) : new Set(['205'])
}

// Mirrors KEN_OMNI_NAME_MAP in src/lib/omni.js exactly — KEN-only project
// name merges applied when normalizing raw MotherDuck project names to the
// display names project_labor_assumptions/project_hourly_drops_forecast use.
const KEN_OMNI_NAME_MAP = new Map([
  ['FAIR OAKS FARMS', 'Fair Oaks Farms'],
  ['FAIR OAKS FARMS WEST', 'Fair Oaks Farms'],
  ['BIRCHWOOD FOODS  KENOSHA', 'Birchwood Foods Kenosha'],
  ['BOSSB5', 'BossBites'],
])

function normalizeProjectName(facilityId, rawName, customNameMap) {
  if (customNameMap.has(rawName)) return customNameMap.get(rawName)
  if (facilityId === 'ken' && KEN_OMNI_NAME_MAP.has(rawName)) return KEN_OMNI_NAME_MAP.get(rawName)
  return rawName
}

function parseB2eTime(s) {
  if (!s || s === '0' || s === 0) return null
  const str = String(s).trim().toLowerCase()
  const m = str.match(/^(\d{1,2}):(\d{2})\s*([ap])?/)
  if (m) {
    let h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    const ap = m[3]
    if (ap === 'p' && h !== 12) h += 12
    else if (ap === 'a' && h === 12) h = 0
    return h + min / 60
  }
  const plain = parseFloat(str)
  return isNaN(plain) ? null : plain
}

function normalizeShiftStart(startTime) {
  const h = parseB2eTime(startTime)
  if (h == null) return null
  return Math.round(h * 4) / 4
}

function computeShiftHours(startTime, endTime) {
  const sh = parseB2eTime(startTime)
  const eh = parseB2eTime(endTime)
  if (sh == null || eh == null) return null
  const hours = (eh - sh + 24) % 24
  return hours > 0 ? Math.round(hours * 2) / 2 : null
}

// Mirrors scheduleToLane in src/lib/omni.js. CAL-side (1-2 vs 3.5) isn't
// resolved here — it's irrelevant to the facility-wide totals this function
// computes, since LANE_TO_SHIFT maps side12_* and side35_* to the same
// shift bucket either way.
function scheduleToLane(workSchedule, startTime) {
  const ws = (workSchedule || '').toLowerCase()
  if (ws.includes('1st shift')) return 'shift1'
  if (ws.includes('mid')) return 'mid'
  if (ws.includes('2nd shift')) return 'shift2'
  if (ws.includes('3rd shift')) return 'shift3'
  if (startTime && startTime !== '0' && startTime !== 0) {
    const hour = parseInt(String(startTime).split(':')[0], 10)
    if (!isNaN(hour)) {
      if (hour < 10) return 'shift1'
      if (hour < 14) return 'mid'
      if (hour < 20) return 'shift2'
      return 'shift3'
    }
  }
  return 'shift1'
}

function prevDayISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const prev = new Date(Date.UTC(y, m - 1, d - 1))
  return prev.toISOString().slice(0, 10)
}

function baseUrl() {
  return process.env.URL || process.env.DEPLOY_URL || 'https://csw-wi.netlify.app'
}

async function mdAppointments(mode, facilityId, date, projectNames) {
  const res = await fetch(`${baseUrl()}/.netlify/functions/motherduck-appointments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, facilityId, date, ...(projectNames ? { projectNames } : {}) }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`motherduck-appointments ${mode} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function mdB2e(kind, facilityId, fromDate, daysForward) {
  const res = await fetch(`${baseUrl()}/.netlify/functions/motherduck-b2e-roster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, facilityId, ...(fromDate ? { fromDate } : {}), ...(daysForward ? { daysForward } : {}) }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`motherduck-b2e-roster ${kind} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const { rows } = await res.json()
  return rows
}

// Fetches carryover employees — people whose PRIOR day's shift extends past
// 5am into today's operational day. Mirrors fetchB2eRoster's carryover
// logic in src/lib/omni.js exactly (same stale-snapshot filter via
// per-employee max ingestion_ts, same job-code allowlist, same
// linearEnd > 24+5 cutoff for "still on the clock at 5am").
async function fetchCarryoverEmployees(facilityId, date) {
  const ROSTER = 'silver__b2e_slv_employeeroster'
  const SCHEDULE = 'silver__b2e_slv_futurescheduleentries'
  const priorDate = prevDayISO(date)

  const [rosterRows, scheduleRows] = await Promise.all([
    mdB2e('active_roster_all_jobcodes', facilityId),
    mdB2e('schedule_date', facilityId, priorDate),
  ])

  const activeIds = new Set(rosterRows.map((r) => String(r[`${ROSTER}.employee_id`])))

  const maxIngestByEmp = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!maxIngestByEmp.has(id) || ts > maxIngestByEmp.get(id)) maxIngestByEmp.set(id, ts)
  }

  const allowed = allowedJobCodes(facilityId)
  const schedMap = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    if (!allowed.has(String(r[`${SCHEDULE}.default_job_code`] ?? ''))) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (ts !== maxIngestByEmp.get(id)) continue
    const dateRaw = r[`${SCHEDULE}.entry_date`]
    if (!dateRaw) continue
    const dateIso = typeof dateRaw === 'string' ? dateRaw.slice(0, 10) : new Date(dateRaw).toISOString().slice(0, 10)
    if (dateIso !== priorDate) continue
    if (!schedMap.has(id) || ts > schedMap.get(id).ts) schedMap.set(id, { row: r, ts })
  }

  const carryovers = []
  for (const [id, { row: r }] of schedMap.entries()) {
    const startTime = r[`${SCHEDULE}.modified_start_time`] ?? r[`${SCHEDULE}.start_time`]
    const endTime = r[`${SCHEDULE}.modified_end_time`] ?? r[`${SCHEDULE}.end_time`]
    const shiftStart = normalizeShiftStart(startTime)
    const shiftHours = computeShiftHours(startTime, endTime)
    if (shiftStart == null || shiftHours == null) continue
    const linearEnd = Number(shiftStart) + Number(shiftHours)
    if (linearEnd <= 24 + 5) continue // doesn't actually tail into today's 5am+ window

    const fullName = [r[`${SCHEDULE}.first_name`] || '', r[`${SCHEDULE}.last_name`] || ''].filter(Boolean).join(' ')
    const lane = scheduleToLane(r[`${SCHEDULE}.work_schedule`], startTime)
    carryovers.push({
      id: `${id}__carryover`,
      originalId: id,
      name: fullName || `Employee ${id}`,
      default_lane: lane,
      shift_start: shiftStart,
      shift_hours: shiftHours,
      is_carryover: true,
    })
  }
  return carryovers
}

// EST Drops summed per hour — read directly from project_hourly_drops_forecast,
// NOT recomputed. This table is already seeded/maintained by FacilityPanel.jsx
// (and any manual edits the team has made), so reading it directly gives the
// exact same numbers the real tab shows without an expensive multi-week L4W
// recomputation here.
async function fetchEstDropsPerHour(supabase, facility, date) {
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('hour, est_drops')
    .eq('facility', facility)
    .eq('plan_date', date)
  const perHour = new Array(24).fill(0)
  if (error) {
    console.warn('[scheduling-labor-planning-insights] EST drops fetch failed:', error.message)
    return perHour
  }
  for (const r of data || []) {
    const h = Number(r.hour)
    if (h >= 0 && h < 24) perHour[h] += Number(r.est_drops) || 0
  }
  return perHour
}

// Per-project, per-hour EST drops — needed for the HPA-override blend below.
async function fetchEstDropsByProjectHour(supabase, facility, date) {
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, hour, est_drops')
    .eq('facility', facility)
    .eq('plan_date', date)
  const map = {}
  if (error) return map
  for (const r of data || []) {
    if (!map[r.project_name]) map[r.project_name] = {}
    const h = Number(r.hour)
    map[r.project_name][h] = (map[r.project_name][h] || 0) + (Number(r.est_drops) || 0)
  }
  return map
}

async function fetchProjectHpa(supabase, facility) {
  const { data, error } = await supabase.from('project_labor_assumptions').select('project_name, hours_per_appt').eq('facility', facility)
  const map = new Map()
  if (error) return map
  for (const r of data || []) map.set(r.project_name, Number(r.hours_per_appt))
  return map
}

async function fetchCustomProjectNameMap(supabase, facility) {
  const { data, error } = await supabase.from('facility_custom_drop_projects').select('project_name, omni_name').eq('facility', facility)
  const map = new Map()
  if (error) return map
  for (const r of data || []) map.set(r.omni_name, r.project_name)
  return map
}

// Sum of manual hourly labor adjustments — mirrors FacilityPanel.jsx's
// totalAdj exactly (Σ Object.values(hourlyAdjustments)). These are the
// per-hour +/- corrections ops enters directly in the Hourly Breakdown's
// ADJ column (e.g. "we sent 3 people home at 2pm" = -3 that hour).
async function fetchTotalAdj(supabase, facility, date) {
  const { data, error } = await supabase
    .from('hourly_labor_adjustments')
    .select('adjustment')
    .eq('facility', facility)
    .eq('plan_date', date)
  if (error) {
    console.warn('[scheduling-labor-planning-insights] hourly_labor_adjustments fetch failed:', error.message)
    return 0
  }
  return (data || []).reduce((s, r) => s + (Number(r.adjustment) || 0), 0)
}

// Fallback path — the original Omni-topic-based labor query.
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
    daily: hours.length
      ? { totalRequired: Math.round(totalRequired * 10) / 10, totalAvailable: Math.round(totalAvailable * 10) / 10, delta: Math.round((totalAvailable - totalRequired) * 10) / 10 }
      : null,
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
      return { statusCode: 200, headers, body: JSON.stringify(await fetchOmniFallback(warehouse, date)) }
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
      return { statusCode: 200, headers, body: JSON.stringify(await fetchOmniFallback(warehouse, date)) }
    }

    const [
      settingsResult,
      breaksResult,
      carryovers,
      apptHourMapResult,
      estDropsPerHour,
      estDropsByProjectHour,
      projectHpa,
      customNameMap,
      totalAdj,
    ] = await Promise.all([
      supabase.from('facility_settings').select('*').eq('facility', facility).maybeSingle(),
      supabase.from('employee_breaks').select('*').eq('facility', facility),
      fetchCarryoverEmployees(facility, date).catch((e) => {
        console.warn('[scheduling-labor-planning-insights] carryover fetch failed (non-fatal):', e.message)
        return []
      }),
      mdAppointments('hourMap', facility, date).catch((e) => {
        console.warn('[scheduling-labor-planning-insights] appts fetch failed, using zeros:', e.message)
        return { hourMap: {} }
      }),
      fetchEstDropsPerHour(supabase, facility, date),
      fetchEstDropsByProjectHour(supabase, facility, date),
      fetchProjectHpa(supabase, facility),
      fetchCustomProjectNameMap(supabase, facility),
      fetchTotalAdj(supabase, facility, date),
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

    // Roster employees (from Supabase) + live carryover employees (from B2E).
    const rosterEmployees = assignments.map((a) => ({ id: a.employee_id, name: a.employee_name, default_lane: a.lane }))
    const carryoverEmployees = carryovers.map((c) => ({ id: c.id, originalId: c.originalId, name: c.name, default_lane: c.default_lane, is_carryover: true }))
    const employees = [...rosterEmployees, ...carryoverEmployees]

    const laneMap = {}
    const assignmentMap = {}
    for (const a of assignments) {
      laneMap[a.employee_id] = a.lane
      assignmentMap[a.employee_id] = a
    }
    for (const c of carryovers) {
      laneMap[c.id] = c.default_lane
      assignmentMap[c.id] = { shift_start: c.shift_start, shift_hours: c.shift_hours, is_carryover: true }
    }

    const avail = buildRosterAvailability(employees, laneMap, settings, assignmentMap, null, breaksMap)
    const staffed = buildRosterStaffedHeadcount(employees, laneMap, assignmentMap, null)

    // Aggregate live appointment counts (MotherDuck-direct — same source
    // Labor Planning uses, not Omni). apptHourMap: { [hour]: {inb, out} }.
    const apptHourMap = apptHourMapResult.hourMap || {}
    const apptsPerHour = new Array(24).fill(0)
    for (let h = 0; h < 24; h++) {
      const row = apptHourMap[h]
      apptsPerHour[h] = row ? (row.inb || 0) + (row.out || 0) : 0
    }

    const hpa = settings?.hours_per_appt ?? SETTINGS_DEFAULTS.hours_per_appt

    // totalAppts[h] = live inbound+outbound + EST Drops, matching
    // FacilityPanel.jsx's rawWithAppts.appts exactly.
    const totalApptsPerHour = apptsPerHour.map((n, h) => n + (estDropsPerHour[h] || 0))

    // ── Per-project HPA override blend (only runs if any overrides exist
    // for this facility) — mirrors FacilityPanel.jsx's perHourReq memo
    // EXACTLY, including a genuine latent bug discovered 2026-08-19 while
    // chasing this exact mismatch: perHourReq looks up a project's live
    // appointment count via `perProjectHourly[h][name]`, but the
    // server-side data it's built from (fetchProjectHourlyAppointments ->
    // motherduck-appointments.cjs's projectHourly mode) returns a FLAT
    // {inb, out} object per hour — an aggregate across ALL requested
    // projects combined, not broken out per project name. So
    // `perProjectHourly[h][name]` always resolves to `undefined` in the
    // real app, and override-HPA projects NEVER actually get credit for
    // their live appointments — only their EST Drops forecast counts
    // toward the override rate. Every live appointment, override project
    // or not, silently falls into the default-rate "remaining" bucket.
    //
    // An earlier version of this file fetched each override project's
    // REAL live count (correctly) — which is more accurate than the real
    // app, but for that exact reason didn't match it. Replicating the bug
    // here on purpose: only dropCount ever contributes to
    // overrideHours/overrideAppts, live appointments never do. This is a
    // real bug in FacilityPanel.jsx worth fixing there too at some point —
    // but fixing it would change what the real Labor Planning tab
    // displays, so that's a separate decision, not something to silently
    // do here.
    let reqPerHour
    if (projectHpa.size > 0) {
      let projectDataRows = []
      try {
        const resp = await mdAppointments('projectData', facility, date)
        projectDataRows = resp.projects || []
      } catch (e) {
        console.warn('[scheduling-labor-planning-insights] projectData fetch failed, HPA overrides skipped:', e.message)
      }

      const overrideNames = new Set(projectHpa.keys())
      for (const r of projectDataRows) {
        const name = normalizeProjectName(facility, r.project_name, customNameMap)
        if (projectHpa.has(name)) overrideNames.add(name)
      }

      reqPerHour = new Array(24).fill(0)
      for (let h = 0; h < 24; h++) {
        let overrideHours = 0
        let overrideAppts = 0
        for (const name of overrideNames) {
          if (!projectHpa.has(name)) continue
          const dropCount = Number(estDropsByProjectHour?.[name]?.[h] ?? 0) || 0
          if (dropCount === 0) continue
          overrideHours += dropCount * projectHpa.get(name)
          overrideAppts += dropCount
        }
        const remainingAppts = Math.max(0, totalApptsPerHour[h] - overrideAppts)
        reqPerHour[h] = Math.round((overrideHours + remainingAppts * hpa) * 10) / 10
      }

      console.log(`[scheduling-labor-planning-insights] HPA overrides applied (drops-only, matching FacilityPanel.jsx's real behavior) for ${[...overrideNames].join(', ')}`)
    } else {
      reqPerHour = totalApptsPerHour.map((n) => Math.round(n * hpa * 10) / 10)
    }

    const hours = []
    let totalRequired = 0
    let totalAvailable = 0
    for (let h = 0; h < 24; h++) {
      const req = reqPerHour[h]
      const a = avail[h] ?? 0
      totalRequired += req
      totalAvailable += a
      hours.push({
        hour: h,
        labor_required: req,
        labor_available: a,
        final: Math.round((a - req) * 10) / 10,
        drops: estDropsPerHour[h] || 0,
        staffed: staffed[h] ?? 0,
      })
    }

    const totalRequiredR = Math.round(totalRequired * 10) / 10
    const totalAvailableR = Math.round(totalAvailable * 10) / 10
    const laborAfterAdj = Math.round((totalAvailableR + totalAdj) * 10) / 10
    const daily = {
      totalRequired: totalRequiredR,
      totalAvailable: totalAvailableR,
      delta: Math.round((totalAvailableR - totalRequiredR) * 10) / 10,
      totalAdj: Math.round(totalAdj * 10) / 10,
      laborAfterAdj,
      deltaAfterAdj: Math.round((laborAfterAdj - totalRequiredR) * 10) / 10,
    }

    // Diagnostic log — kept verbose on purpose. If a future mismatch shows
    // up, this line (visible in Netlify function logs) shows the exact
    // inputs (live appt total, drops total, HPA override count) that fed
    // the final numbers, so a discrepancy can be traced to a specific
    // input rather than re-derived from scratch.
    const liveApptsTotal = apptsPerHour.reduce((s, n) => s + n, 0)
    const dropsTotal = estDropsPerHour.reduce((s, n) => s + n, 0)
    console.log(
      `[scheduling-labor-planning-insights] ${facility} ${date}: ${assignments.length} roster rows + ${carryovers.length} carryovers, ` +
        `liveAppts=${liveApptsTotal}, drops=${dropsTotal}, hpaOverrides=${projectHpa.size}, daily=${JSON.stringify(daily)}`
    )
    return { statusCode: 200, headers, body: JSON.stringify({ hours, daily, source: 'roster' }) }
  } catch (err) {
    console.error('[scheduling-labor-planning-insights] error, falling back to Omni:', err.message)
    try {
      return { statusCode: 200, headers, body: JSON.stringify(await fetchOmniFallback(warehouse, date)) }
    } catch (e2) {
      return { statusCode: 200, headers, body: JSON.stringify({ hours: [], daily: null, source: 'omni_fallback', error: e2.message }) }
    }
  }
}
