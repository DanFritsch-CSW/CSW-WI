'use strict'

// Shared core for the nightly B2E sync — SPLIT 2026-08-11 into
// lib/nightly-b2e-sync-shared.cjs + nightly-b2e-sync-run.cjs (scheduled) +
// nightly-b2e-sync-test.cjs (manual, no schedule), same pattern as every
// other digest in this app (see fefo-digest-shared.cjs's 2026-07-30 header
// for the full "Netlify blocks direct HTTP invocation of any function
// carrying a schedule" story). Reason for THIS split: Dean/Dan suspected
// the 5am cron wasn't running as expected (CAL's weekly digest showed a
// deep negative delta for a future day, then the same day showed a large
// positive delta minutes later with zero manual edits — see the
// 2026-08-11 investigation). Splitting this out gives a manual-test path
// so that theory can be checked THE SAME DAY instead of waiting for
// tomorrow's 10:00 UTC run.
//
// Also added this pass: cron_health logging. Every run (scheduled OR
// manual test) writes one row per facility plus one summary row to the
// new `cron_health` table — ok/error, duration, and (new) how many
// distinct days of B2E schedule data were actually returned and the
// furthest-out date actually written to roster_assignments. This exists
// because the live investigation found MAD/WR/EC had ZERO forward-seeded
// rows at all, and CAL/KEN's forward data stopped around day 8-9 despite
// FORWARD_DAYS=21 and B2E's own source table
// (silver.b2e_slv_futurescheduleentries) having real data out to
// 2026-10-06 for Caledonia — so the sync is silently not doing what it's
// configured to do. Rather than debug this via Netlify's dashboard log
// viewer every time, cron_health makes it a 5-second SQL query.
//
// Everything below this point is the original nightly-b2e-sync.cjs logic,
// unchanged in behavior — see that file's original header for the
// purge/seed/refresh design rationale (ported from src/lib/supabase.js
// and src/lib/omni.js).

const { createClient } = require('@supabase/supabase-js')

// ── Constants ──────────────────────────────────────────────────────────────

const FACILITIES = ['cal', 'mad', 'ec', 'ken', 'wr']
const FORWARD_DAYS = 21

function getAllowedJobCodes(facilityId) {
  return (facilityId === 'mad' || facilityId === 'ec') ? new Set(['205', '209']) : new Set(['205'])
}

const B2E_MODEL_ID = 'f3aaca97-bb7c-405d-809b-efab83649ab3'
const ROSTER       = 'silver__b2e_slv_employeeroster'
const SCHEDULE     = 'silver__b2e_slv_futurescheduleentries'

const B2E_LOCATION = {
  cal:  '019 - Caledonia',
  mad:  '011 - Madison',
  ec:   '012 - Eau Claire',
  ken:  '015 - Kenosha',
  wr:   '023 - Wisconsin Rapids',
}

const CAL2_DOCK_NAMES_35 = new Set([
  'Calvieon Howard', 'Ethan Lindsey', 'Jose Cuevas', 'Nicholas J. Free',
  'Nicholas Free', 'Zarious Brinner', 'Juan Bido', 'Eduardo Ramon',
])

// ── Time / lane utilities (ported from omni.js) ────────────────────────────

function cal2FallbackLane(name, shiftLane) {
  const is35 = [...CAL2_DOCK_NAMES_35].some(n => name.startsWith(n) || name.includes(n))
  const side = is35 ? 'side35' : 'side12'
  const suffix = { shift1: 'shift1', mid: 'mid', shift2: 'shift2', shift3: 'shift3' }[shiftLane] || 'shift1'
  return `${side}_${suffix}`
}

function scheduleToLane(workSchedule, startTime) {
  const ws = (workSchedule || '').toLowerCase()
  if (ws.includes('1st shift')) return 'shift1'
  if (ws.includes('mid'))       return 'mid'
  if (ws.includes('2nd shift')) return 'shift2'
  if (ws.includes('3rd shift')) return 'shift3'
  if (startTime && startTime !== '0' && startTime !== 0) {
    const hour = parseInt(String(startTime).split(':')[0], 10)
    if (!isNaN(hour)) {
      if (hour < 10)  return 'shift1'
      if (hour < 14)  return 'mid'
      if (hour < 20)  return 'shift2'
      return 'shift3'
    }
  }
  return 'shift1'
}

function parseB2eTime(s) {
  if (!s || s === '0' || s === 0) return null
  const str = String(s).trim().toLowerCase()
  const m = str.match(/^(\d{1,2}):(\d{2})\s*([ap])?/)
  if (m) {
    let h = parseInt(m[1], 10)
    const min = parseInt(m[2], 10)
    const ap  = m[3]
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

// ── Omni query — proxies to internal omni-query.cjs ────────────────────────

async function omniQuery(query, baseUrl) {
  const proxyUrl = `${baseUrl}/.netlify/functions/omni-query`
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { version: 5, ...query } }),
  })
  if (!res.ok) {
    let body = ''
    try { body = await res.text() } catch { /* ignore */ }
    throw new Error(`omni-query proxy HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const payload = await res.json()
  if (!payload || !Array.isArray(payload.rows)) {
    throw new Error(`omni-query proxy: missing rows field: ${JSON.stringify(payload).slice(0, 300)}`)
  }
  return payload.rows
}

// ── B2E fetchers (ported from omni.js) ─────────────────────────────────────

async function fetchB2eRosterForRange(baseUrl, facilityId, fromDate, daysForward, cal2DockAssignments) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return {}
  const isCal = facilityId === 'cal'

  const [rosterRows, scheduleRows] = await Promise.all([
    omniQuery({
      modelId: B2E_MODEL_ID, table: ROSTER,
      fields: [`${ROSTER}.employee_id`, `${ROSTER}.employee_status`],
      filters: {
        [`${ROSTER}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        [`${ROSTER}.employee_status`]:            { kind: 'EQUALS', type: 'string', values: ['Active'] },
      },
      limit: 500,
    }, baseUrl),
    omniQuery({
      modelId: B2E_MODEL_ID, table: SCHEDULE,
      fields: [
        `${SCHEDULE}.employee_id`, `${SCHEDULE}.first_name`, `${SCHEDULE}.last_name`,
        `${SCHEDULE}.default_job_code`, `${SCHEDULE}.start_time`, `${SCHEDULE}.end_time`,
        `${SCHEDULE}.modified_start_time`, `${SCHEDULE}.modified_end_time`,
        `${SCHEDULE}.work_schedule`, `${SCHEDULE}.ingestion_ts`, `${SCHEDULE}.entry_date`,
      ],
      filters: {
        [`${SCHEDULE}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
        [`${SCHEDULE}.entry_date`]: {
          kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
          isFiscal: false, left_side: fromDate, is_negative: false,
          offset_interval_string: `${daysForward} days`,
        },
      },
      sorts: [{ column_name: `${SCHEDULE}.ingestion_ts`, sort_descending: true }],
      limit: 5000,
    }, baseUrl),
  ])

  const activeIds = new Set(rosterRows.map(r => String(r[`${ROSTER}.employee_id`])))

  const maxIngestByEmp = new Map()
  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (!maxIngestByEmp.has(id) || ts > maxIngestByEmp.get(id)) {
      maxIngestByEmp.set(id, ts)
    }
  }

  const allowedJobCodes = getAllowedJobCodes(facilityId)
  const byDateEmp = new Map()
  // Diagnostic only — raw distinct entry_date count BEFORE the stale-snapshot
  // filter narrows to each employee's single freshest ingestion batch. Lets
  // cron_health show whether Omni's response itself was already truncated
  // (rawDistinctDates small) vs. the stale-snapshot dedup being what's
  // discarding far-future days (rawDistinctDates large, byDateEmp small).
  const rawDistinctDates = new Set()
  for (const r of scheduleRows) {
    const dateRaw = r[`${SCHEDULE}.entry_date`]
    if (dateRaw) rawDistinctDates.add(typeof dateRaw === 'string' ? dateRaw.slice(0, 10) : new Date(dateRaw).toISOString().slice(0, 10))
  }

  for (const r of scheduleRows) {
    const id = String(r[`${SCHEDULE}.employee_id`])
    if (!activeIds.has(id)) continue
    if (!allowedJobCodes.has(String(r[`${SCHEDULE}.default_job_code`] ?? ''))) continue
    const ts = r[`${SCHEDULE}.ingestion_ts`] ?? ''
    if (ts !== maxIngestByEmp.get(id)) continue
    const dateRaw = r[`${SCHEDULE}.entry_date`]
    if (!dateRaw) continue
    const dateIso = typeof dateRaw === 'string'
      ? dateRaw.slice(0, 10)
      : new Date(dateRaw).toISOString().slice(0, 10)
    if (!byDateEmp.has(dateIso)) byDateEmp.set(dateIso, new Map())
    const empMap = byDateEmp.get(dateIso)
    if (!empMap.has(id) || ts > empMap.get(id).ts) empMap.set(id, { row: r, ts })
  }

  const result = {}
  for (const [dateIso, empMap] of byDateEmp.entries()) {
    const employees = []
    for (const [id, { row: r }] of empMap.entries()) {
      const startTime = r[`${SCHEDULE}.modified_start_time`] ?? r[`${SCHEDULE}.start_time`]
      const endTime   = r[`${SCHEDULE}.modified_end_time`]   ?? r[`${SCHEDULE}.end_time`]
      const firstName = r[`${SCHEDULE}.first_name`] || ''
      const lastName  = r[`${SCHEDULE}.last_name`]  || ''
      const fullName  = [firstName, lastName].filter(Boolean).join(' ')
      const shiftLane = scheduleToLane(r[`${SCHEDULE}.work_schedule`], startTime)

      let defaultLane
      if (isCal) {
        const savedLane = cal2DockAssignments.get(id)
        if (savedLane) {
          const side = savedLane.startsWith('side35') ? 'side35' : 'side12'
          defaultLane = `${side}_${shiftLane}`
        } else {
          defaultLane = cal2FallbackLane(fullName, shiftLane)
        }
      } else {
        defaultLane = shiftLane
      }

      employees.push({
        id,
        name:         fullName,
        role:         null,
        job_code:     String(r[`${SCHEDULE}.default_job_code`] ?? ''),
        default_lane: defaultLane,
        shift_start:  normalizeShiftStart(startTime),
        shift_hours:  computeShiftHours(startTime, endTime),
        facility:     facilityId,
      })
    }
    result[dateIso] = employees
  }

  return { rosterByDate: result, rawDistinctDates: rawDistinctDates.size, rawRowCount: scheduleRows.length }
}

async function fetchActiveB2eEmployees(baseUrl, facilityId) {
  const location = B2E_LOCATION[facilityId]
  if (!location) return new Set()
  const rows = await omniQuery({
    modelId: B2E_MODEL_ID, table: ROSTER,
    fields: [`${ROSTER}.employee_id`],
    filters: {
      [`${ROSTER}.default_location_full_path`]: { kind: 'EQUALS', type: 'string', values: [location] },
      [`${ROSTER}.employee_status`]:            { kind: 'EQUALS', type: 'string', values: ['Active'] },
      [`${ROSTER}.default_job_code`]:           { kind: 'EQUALS', type: 'string', values: (facilityId === 'mad' || facilityId === 'ec') ? ['205', '209'] : ['205'] },
    },
    sorts: [],
    limit: 500,
  }, baseUrl)
  return new Set(rows.map(r => String(r[`${ROSTER}.employee_id`])))
}

// ── Supabase sync (ported from supabase.js) ────────────────────────────────

async function fetchCal2DockAssignments(supabase) {
  const { data, error } = await supabase.from('employees').select('id, default_lane').eq('facility', 'cal')
  if (error) {
    console.warn('fetchCal2DockAssignments error:', error.message)
    return new Map()
  }
  return new Map((data ?? []).map(e => [String(e.id), e.default_lane]))
}

async function purgeTerminatedAcrossFuture(supabase, facility, activeEmpIdSet, fromDate) {
  if (!activeEmpIdSet || activeEmpIdSet.size === 0) {
    return { skipped: true, reason: 'empty_active_set' }
  }
  const { data, error: fetchErr } = await supabase
    .from('roster_assignments')
    .select('employee_id')
    .eq('facility', facility)
    .gte('plan_date', fromDate)
    .eq('is_temp', false)
    .is('from_facility', null)
  if (fetchErr) return { error: `fetch: ${fetchErr.message}` }
  if (!data || !data.length) return { purged: 0 }
  const staleIds = [...new Set(
    data.map(r => String(r.employee_id)).filter(id => !activeEmpIdSet.has(id))
  )]
  if (!staleIds.length) return { purged: 0 }
  const { error: delErr } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .gte('plan_date', fromDate)
    .eq('is_temp', false)
    .is('from_facility', null)
    .eq('manually_edited', false)
    .in('employee_id', staleIds)
  if (delErr) return { error: `delete: ${delErr.message}` }
  return { purged: staleIds.length, staleIds }
}

async function seedForwardHorizon(supabase, facility, b2eRosterByDate, fromDate, daysForward) {
  if (!b2eRosterByDate || Object.keys(b2eRosterByDate).length === 0) {
    return { skipped: true, reason: 'empty_b2e_payload' }
  }

  const dates = []
  const base = new Date(fromDate + 'T00:00:00Z')
  for (let i = 1; i <= daysForward; i++) {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + i)
    dates.push(d.toISOString().slice(0, 10))
  }
  const dateSet = new Set(dates)

  const validKeys = new Set()
  const employeeByKey = new Map()
  for (const [date, employees] of Object.entries(b2eRosterByDate)) {
    if (!dateSet.has(date)) continue
    if (!Array.isArray(employees)) continue
    for (const e of employees) {
      if (!e?.id) continue
      const key = `${e.id}|${date}`
      validKeys.add(key)
      employeeByKey.set(key, { ...e, _date: date })
    }
  }

  const { data: existing, error: fErr } = await supabase
    .from('roster_assignments')
    .select('employee_id, plan_date, manually_edited, is_temp, from_facility, on_loan_to, shift_start, shift_hours')
    .eq('facility', facility)
    .in('plan_date', dates)
  if (fErr) return { error: `fetch existing: ${fErr.message}` }

  const existingKeys = new Set()
  const deleteByDate = {}
  const refreshRows = []
  for (const r of (existing ?? [])) {
    const key = `${r.employee_id}|${r.plan_date}`
    existingKeys.add(key)
    if (validKeys.has(key)) {
      const e = employeeByKey.get(key)
      if (e) {
        const dbStart  = r.shift_start == null ? null : Number(r.shift_start)
        const dbHours  = r.shift_hours == null ? null : Number(r.shift_hours)
        const b2eStart = e.shift_start == null ? null : Number(e.shift_start)
        const b2eHours = e.shift_hours == null ? null : Number(e.shift_hours)
        if (dbStart !== b2eStart || dbHours !== b2eHours) {
          refreshRows.push({
            employee_id:   r.employee_id,
            plan_date:     r.plan_date,
            shift_start:   b2eStart,
            shift_hours:   b2eHours,
            employee_name: e.name,
          })
        }
      }
      continue
    }
    if (r.is_temp) continue
    if (r.from_facility !== null) continue
    if (r.on_loan_to) continue
    if (r.manually_edited) continue
    if (!deleteByDate[r.plan_date]) deleteByDate[r.plan_date] = []
    deleteByDate[r.plan_date].push(r.employee_id)
  }

  const nowIso = new Date().toISOString()
  const rowsToInsert = []
  for (const key of validKeys) {
    if (existingKeys.has(key)) continue
    const e = employeeByKey.get(key)
    if (!e) continue
    rowsToInsert.push({
      facility:           e.facility ?? facility,
      employee_id:        e.id,
      employee_name:      e.name,
      role:               e.role ?? null,
      lane:               e.default_lane || 'shift1',
      plan_date:          e._date,
      shift_start:        e.shift_start ?? null,
      shift_hours:        e.shift_hours ?? null,
      is_temp:            false,
      from_facility:      null,
      on_loan_to:         null,
      last_b2e_sync_at:   nowIso,
      manually_edited:    false,
      manually_edited_at: null,
    })
  }

  const stats = { deleted: 0, inserted: 0, refreshed: 0, errors: [] }
  const tasks = []
  for (const [planDate, empIds] of Object.entries(deleteByDate)) {
    if (!empIds.length) continue
    stats.deleted += empIds.length
    tasks.push(
      supabase.from('roster_assignments').delete()
        .eq('facility', facility).eq('plan_date', planDate)
        .in('employee_id', empIds)
        .eq('is_temp', false).is('from_facility', null).is('on_loan_to', null)
        .eq('manually_edited', false)
        .then(({ error }) => { if (error) stats.errors.push(`delete ${planDate}: ${error.message}`) })
    )
  }
  if (rowsToInsert.length) {
    stats.inserted = rowsToInsert.length
    tasks.push(
      supabase.from('roster_assignments')
        .upsert(rowsToInsert, { onConflict: 'facility,employee_id,plan_date', ignoreDuplicates: true })
        .then(({ error }) => { if (error) stats.errors.push(`insert: ${error.message}`) })
    )
  }
  for (const u of refreshRows) {
    stats.refreshed += 1
    tasks.push(
      supabase.from('roster_assignments')
        .update({
          shift_start:      u.shift_start,
          shift_hours:      u.shift_hours,
          employee_name:    u.employee_name,
          last_b2e_sync_at: nowIso,
        })
        .eq('facility', facility).eq('employee_id', u.employee_id).eq('plan_date', u.plan_date)
        .then(({ error }) => { if (error) stats.errors.push(`refresh ${u.employee_id}|${u.plan_date}: ${error.message}`) })
    )
  }
  await Promise.all(tasks)
  return stats
}

// ── cron_health logging (best-effort — never throws, never blocks the sync) ─

async function logCronHealth(supabase, { functionName, facility, trigger, ok, durationMs, detail }) {
  try {
    await supabase.from('cron_health').insert({
      function_name: functionName,
      facility:      facility ?? null,
      trigger,
      ok,
      duration_ms:   durationMs,
      detail:        detail ?? null,
    })
  } catch (e) {
    console.warn('logCronHealth failed (non-fatal):', e.message)
  }
}

// ── Per-facility sync ────────────────────────────────────────────────────

async function syncFacility(supabase, baseUrl, facility, today, cal2Docks, trigger) {
  const facStart = Date.now()
  try {
    const [rangeResult, activeEmps] = await Promise.all([
      fetchB2eRosterForRange(
        baseUrl, facility, today, FORWARD_DAYS + 1,
        facility === 'cal' ? cal2Docks : new Map()
      ),
      fetchActiveB2eEmployees(baseUrl, facility),
    ])
    const { rosterByDate, rawDistinctDates, rawRowCount } = rangeResult
    const seededDates = Object.keys(rosterByDate).sort()
    const maxSeededDate = seededDates.length ? seededDates[seededDates.length - 1] : null

    const purge = await purgeTerminatedAcrossFuture(supabase, facility, activeEmps, today)
    const seed  = await seedForwardHorizon(supabase, facility, rosterByDate, today, FORWARD_DAYS)

    const result = {
      ok: true,
      activeEmps: activeEmps.size,
      // Diagnostic fields — added 2026-08-11 to answer "is the 21-day
      // window actually being reached" without a separate SQL query.
      b2eRawRowCount: rawRowCount,
      b2eRawDistinctDates: rawDistinctDates,
      b2eDatesAfterDedup: seededDates.length,
      maxSeededDate,
      expectedMaxDate: (() => {
        const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + FORWARD_DAYS)
        return d.toISOString().slice(0, 10)
      })(),
      purge,
      seed,
      ms: Date.now() - facStart,
    }
    await logCronHealth(supabase, {
      functionName: 'nightly-b2e-sync', facility, trigger, ok: true,
      durationMs: result.ms, detail: result,
    })
    return result
  } catch (e) {
    const result = {
      ok: false,
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 3).join(' | '),
      ms: Date.now() - facStart,
    }
    await logCronHealth(supabase, {
      functionName: 'nightly-b2e-sync', facility, trigger, ok: false,
      durationMs: result.ms, detail: result,
    })
    return result
  }
}

// ── Orchestrator — called by both -run.cjs (scheduled) and -test.cjs (manual) ─

async function runNightlyB2eSync({ trigger }) {
  const overallStart = Date.now()
  const SUPA_URL = process.env.VITE_SUPABASE_URL
  const SUPA_KEY = process.env.VITE_SUPABASE_ANON_KEY
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || 'https://csw-wi.netlify.app'

  if (!SUPA_URL || !SUPA_KEY) {
    return {
      ok: false,
      error: 'missing env vars',
      missing: { VITE_SUPABASE_URL: !!SUPA_URL, VITE_SUPABASE_ANON_KEY: !!SUPA_KEY },
    }
  }

  const supabase = createClient(SUPA_URL, SUPA_KEY)
  const today = new Date().toISOString().slice(0, 10)
  const cal2Docks = await fetchCal2DockAssignments(supabase)

  const facilityResults = await Promise.all(
    FACILITIES.map(async facility => {
      const result = await syncFacility(supabase, baseUrl, facility, today, cal2Docks, trigger)
      console.log(`[nightly-b2e-sync:${trigger}] ${facility}:`, JSON.stringify(result))
      return [facility, result]
    })
  )
  const results = Object.fromEntries(facilityResults)

  const summary = {
    ok:      Object.values(results).every(r => r.ok),
    trigger,
    ranAt:   new Date().toISOString(),
    today,
    baseUrl,
    totalMs: Date.now() - overallStart,
    results,
  }
  console.log(`[nightly-b2e-sync:${trigger}] summary:`, JSON.stringify(summary))

  // Summary row — facility=null — so "last run overall" is a single-row query.
  await logCronHealth(supabase, {
    functionName: 'nightly-b2e-sync-summary', facility: null, trigger,
    ok: summary.ok, durationMs: summary.totalMs, detail: summary,
  })

  return summary
}

module.exports = { runNightlyB2eSync, FACILITIES, FORWARD_DAYS }
