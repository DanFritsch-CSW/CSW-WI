import { createClient } from '@supabase/supabase-js'

const url  = import.meta.env.VITE_SUPABASE_URL  || ''
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export const supabase = url && key ? createClient(url, key) : null

export async function fetchTodayAssignments(facility, planDate) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('*')
    .eq('facility', facility)
    .eq('plan_date', planDate)
  if (error) { console.error('fetchTodayAssignments:', error); return [] }
  return data ?? []
}

// upsertAssignment — by default stamps manually_edited=true with a timestamp
// so the row is protected from B2E auto-sync / seedRosterAssignments overwrites.
// Pass { automatic: true } when the write is NOT a human action (e.g. auto-PTO
// override in RosterBoard.load()) so the protection flag is NOT set.
export async function upsertAssignment(assignment, opts = {}) {
  if (!supabase) return
  const row = { ...assignment }
  if (opts.automatic !== true) {
    row.manually_edited = true
    row.manually_edited_at = new Date().toISOString()
  }
  const { error } = await supabase
    .from('roster_assignments')
    .upsert(row, { onConflict: 'facility,employee_id,plan_date' })
  if (error) console.error('upsertAssignment:', error)
}

export async function fetchEmployees(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('facility', facility)
    .eq('job_code', '205')
  if (error) { console.error('fetchEmployees:', error); return [] }
  return data ?? []
}

export async function fetchCal2Employees() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, default_lane')
    .eq('facility', 'cal')
    .order('name')
  if (error) { console.error('fetchCal2Employees:', error); return [] }
  return data ?? []
}

export async function upsertEmployeeDockSide(employeeId, side, currentLane) {
  if (!supabase) return
  const shiftSuffix = (currentLane || '').replace(/^side(12|35)_/, '') || 'shift1'
  const newLane = `${side}_${shiftSuffix}`
  const { error } = await supabase
    .from('employees')
    .update({ default_lane: newLane })
    .eq('id', employeeId)
  if (error) console.error('upsertEmployeeDockSide:', error)
  return newLane
}

export async function replaceEmployees(facilityId, employees) {
  if (!supabase) return 'Supabase not configured'
  if (employees.length) {
    const { error } = await supabase
      .from('employees')
      .upsert(employees, { onConflict: 'id' })
    if (error) { console.error('replaceEmployees upsert:', error); return error.message }
  }
  const { data: current, error: fetchErr } = await supabase
    .from('employees').select('id').eq('facility', facilityId)
  if (fetchErr) { console.error('replaceEmployees fetch:', fetchErr); return fetchErr.message }
  const activeIds = new Set(employees.map(e => String(e.id)))
  const staleIds  = (current ?? []).filter(e => !activeIds.has(String(e.id))).map(e => e.id)
  if (!staleIds.length) return null
  const { error: delErr } = await supabase
    .from('employees').delete().in('id', staleIds)
  if (delErr) { console.error('replaceEmployees prune:', delErr); return delErr.message }
  return null
}

export async function upsertEmployees(employees) {
  if (!supabase) return 'Supabase not configured'
  const { error } = await supabase
    .from('employees')
    .upsert(employees, { onConflict: 'id' })
  if (error) { console.error('upsertEmployees:', error); return error.message }
  return null
}

// seedRosterAssignments — writes B2E roster data to Supabase as the baseline.
// CRITICAL: rows already marked manually_edited=true are NEVER touched. This
// protects user-made lane moves / PTO / call-in assignments / shift edits
// from being overwritten when a B2E sync (manual or auto-resync) runs.
export async function seedRosterAssignments(employees, planDate) {
  if (!supabase || !employees.length) return null
  const facility = employees[0]?.facility
  // Fetch existing manual rows so we can exclude them from the seed write.
  let manualIds = new Set()
  if (facility) {
    const { data: manualRows, error: mErr } = await supabase
      .from('roster_assignments')
      .select('employee_id')
      .eq('facility', facility)
      .eq('plan_date', planDate)
      .eq('manually_edited', true)
    if (mErr) { console.error('seedRosterAssignments fetch manual:', mErr); return mErr.message }
    manualIds = new Set((manualRows ?? []).map(r => String(r.employee_id)))
  }
  const filtered = employees.filter(e => !manualIds.has(String(e.id)))
  if (!filtered.length) return null
  const nowIso = new Date().toISOString()
  const rows = filtered.map(e => ({
    facility:          e.facility,
    employee_id:       e.id,
    employee_name:     e.name,
    role:              e.role ?? null,
    lane:              e.default_lane || 'shift1',
    plan_date:         planDate,
    shift_start:       e.shift_start ?? null,
    shift_hours:       e.shift_hours ?? null,
    is_temp:           false,
    from_facility:     null,
    on_loan_to:        null,
    last_b2e_sync_at:  nowIso,
    manually_edited:   false,
    manually_edited_at: null,
  }))
  const { error } = await supabase
    .from('roster_assignments')
    .upsert(rows, { onConflict: 'facility,employee_id,plan_date', ignoreDuplicates: false })
  if (error) { console.error('seedRosterAssignments:', error); return error.message }
  return null
}

// purgeStaleAssignments — removes future rows for employees at facilities
// they no longer belong to (e.g. after a B2E transfer). The .eq('manually_edited',
// false) guard protects manual cross-facility placements (loans, manual moves)
// from being purged.
export async function purgeStaleAssignments(employeeIds, correctFacility, fromDate) {
  if (!supabase || !employeeIds.length) return null
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .in('employee_id', employeeIds)
    .neq('facility', correctFacility)
    .is('from_facility', null)
    .eq('manually_edited', false)
    .gte('plan_date', fromDate)
  if (error) { console.error('purgeStaleAssignments:', error); return error.message }
  return null
}

// purgeTerminatedAssignments — deletes roster_assignments rows for a facility
// where the employee_id is no longer in the latest B2E pull. Called by every
// B2E sync (manual + silent auto-resync). Closes the loop where terminated
// employees previously persisted forever because seedRosterAssignments only
// upserts — it has no DELETE step.
//
// Protections (rows that are preserved):
//   - is_temp = true         → manual temps live independent of B2E
//   - from_facility != null  → incoming loans; the home facility's B2E owns
//                              the active/terminated status of that employee
//
// Intentionally NOT protected by manually_edited. If B2E says the person no
// longer exists at this facility, a manual lane move for them (to callin / PTO /
// specialProject) is just a manager working around the absence of a proper
// "remove employee" path — and that workaround is exactly what this purge
// replaces. The B2E source of truth wins.
//
// Scope: current plan_date only. Future-dated rows clean themselves up when
// a user visits that date and the next sync runs.
export async function purgeTerminatedAssignments(facility, planDate, currentB2eEmpIds) {
  if (!supabase) return null
  const { data, error: fetchErr } = await supabase
    .from('roster_assignments')
    .select('employee_id')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
    .is('from_facility', null)
  if (fetchErr) { console.error('purgeTerminatedAssignments fetch:', fetchErr); return fetchErr.message }
  if (!data || !data.length) return null
  const activeSet = new Set((currentB2eEmpIds ?? []).map(String))
  const staleIds = data
    .map(r => String(r.employee_id))
    .filter(id => !activeSet.has(id))
  if (!staleIds.length) return null
  const { error: delErr } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
    .is('from_facility', null)
    .in('employee_id', staleIds)
  if (delErr) { console.error('purgeTerminatedAssignments delete:', delErr); return delErr.message }
  return null
}

export async function deleteAssignment(facility, employeeId, planDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (error) console.error('deleteAssignment:', error)
}

export async function resetAssignmentsForDate(facility, planDate) {
  if (!supabase) return 'Supabase not configured'
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
  if (error) { console.error('resetAssignmentsForDate:', error); return error.message }
  return null
}

export async function sendEmployeeOnLoan({ employeeId, employeeName, role, sourceFacility, destFacility, destLane, planDate, shiftStart, shiftHours }) {
  if (!supabase) return 'Supabase not configured'
  const nowIso = new Date().toISOString()
  const { error: srcErr } = await supabase
    .from('roster_assignments')
    .update({ on_loan_to: destFacility, manually_edited: true, manually_edited_at: nowIso })
    .eq('facility', sourceFacility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (srcErr) { console.error('sendEmployeeOnLoan src:', srcErr); return srcErr.message }
  const { error: dstErr } = await supabase
    .from('roster_assignments')
    .upsert({
      facility:      destFacility,
      employee_id:   employeeId,
      employee_name: employeeName,
      role:          role ?? null,
      lane:          destLane,
      plan_date:     planDate,
      shift_start:   shiftStart ?? null,
      shift_hours:   shiftHours ?? null,
      is_temp:       false,
      from_facility: sourceFacility,
      on_loan_to:    null,
      manually_edited: true,
      manually_edited_at: nowIso,
    }, { onConflict: 'facility,employee_id,plan_date' })
  if (dstErr) { console.error('sendEmployeeOnLoan dst:', dstErr); return dstErr.message }
  return null
}

export async function recallLoan({ employeeId, sourceFacility, destFacility, planDate }) {
  if (!supabase) return 'Supabase not configured'
  const nowIso = new Date().toISOString()
  const { error: srcErr } = await supabase
    .from('roster_assignments')
    .update({ on_loan_to: null, manually_edited: true, manually_edited_at: nowIso })
    .eq('facility', sourceFacility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (srcErr) { console.error('recallLoan src:', srcErr); return srcErr.message }
  const { error: dstErr } = await supabase
    .from('roster_assignments')
    .delete()
    .eq('facility', destFacility)
    .eq('employee_id', employeeId)
    .eq('plan_date', planDate)
  if (dstErr) { console.error('recallLoan dst:', dstErr); return dstErr.message }
  return null
}

const SETTINGS_DEFAULTS = {
  hours_per_appt: 1.5,
  break_hour_1: 83, break_hour_2: 100, break_hour_3: 75,  break_hour_4: 100,
  break_hour_5: 50, break_hour_6: 100, break_hour_7: 75,  break_hour_8: 100,
}

export async function fetchFacilitySettings(facilityId) {
  if (!supabase) return SETTINGS_DEFAULTS
  const { data, error } = await supabase
    .from('facility_settings')
    .select('*')
    .eq('facility', facilityId)
    .single()
  if (error || !data) return { ...SETTINGS_DEFAULTS, facility: facilityId }
  return data
}

export async function upsertFacilitySettings(facilityId, values) {
  if (!supabase) return
  const { error } = await supabase
    .from('facility_settings')
    .upsert({ facility: facilityId, ...values }, { onConflict: 'facility' })
  if (error) console.error('upsertFacilitySettings:', error)
}

// ─── Project-level Hours-Per-Appointment Overrides ──────────────────────────
// Falls back to facility_settings.hours_per_appt when no row exists for a project.

export async function fetchProjectLaborAssumptions(facility) {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('project_labor_assumptions')
    .select('project_name, hours_per_appt')
    .eq('facility', facility)
  if (error) {
    console.error('fetchProjectLaborAssumptions', error)
    return new Map()
  }
  const map = new Map()
  for (const row of data || []) {
    map.set(row.project_name, Number(row.hours_per_appt))
  }
  return map
}

export async function upsertProjectLaborAssumption(facility, projectName, hoursPerAppt) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_labor_assumptions')
    .upsert(
      {
        facility,
        project_name: projectName,
        hours_per_appt: hoursPerAppt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,project_name', ignoreDuplicates: false }
    )
  if (error) {
    console.error('upsertProjectLaborAssumption', error)
    throw error
  }
}

export async function deleteProjectLaborAssumption(facility, projectName) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_labor_assumptions')
    .delete()
    .eq('facility', facility)
    .eq('project_name', projectName)
  if (error) {
    console.error('deleteProjectLaborAssumption', error)
    throw error
  }
}

// Union of project names known for this facility from DB sources only.
// Code-constant sources (PROJECT_DROP_RULES, KEN_GUARANTEED_PROJECTS) are added
// in the consumer (Settings.jsx) since they live in omni.js.
export async function fetchAllFacilityProjectNames(facility) {
  if (!supabase) return []
  const [dropsRes, customRes] = await Promise.all([
    supabase
      .from('project_hourly_drops_forecast')
      .select('project_name')
      .eq('facility', facility),
    supabase
      .from('facility_custom_drop_projects')
      .select('project_name')
      .eq('facility', facility),
  ])
  if (dropsRes.error) console.warn('fetchAllFacilityProjectNames drops', dropsRes.error)
  if (customRes.error) console.warn('fetchAllFacilityProjectNames custom', customRes.error)
  const names = new Set()
  for (const row of dropsRes.data || []) names.add(row.project_name)
  for (const row of customRes.data || []) names.add(row.project_name)
  return Array.from(names)
}

export async function fetchAllFacilitiesSettings() {
  const defaults = {}
  for (const key of ['cal', 'ken', 'mad', 'wr', 'ec']) {
    defaults[key] = SETTINGS_DEFAULTS.hours_per_appt
  }
  if (!supabase) return defaults
  const { data, error } = await supabase
    .from('facility_settings')
    .select('facility, hours_per_appt')
  if (error || !data) return defaults
  for (const row of data) {
    defaults[row.facility] = Number(row.hours_per_appt) || SETTINGS_DEFAULTS.hours_per_appt
  }
  return defaults
}

export async function fetchEstDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('hourly_drops_forecast')
    .select('hour, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.hour, r.est_drops]))
}

export async function upsertEstDrops(facilityId, planDate, hourlyValues) {
  if (!supabase) return
  const rows = hourlyValues.map(({ h, est }) => ({
    facility:  facilityId,
    plan_date: planDate,
    hour:      h,
    est_drops: est ?? 0,
  }))
  const { error } = await supabase
    .from('hourly_drops_forecast')
    .upsert(rows, { onConflict: 'facility,plan_date,hour' })
  if (error) console.error('upsertEstDrops:', error)
}

export async function fetchProjectDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_drops_forecast')
    .select('project_name, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.project_name, r.est_drops]))
}

export async function upsertProjectDrops(facilityId, planDate, rows) {
  if (!supabase) return
  const records = rows.map(({ project_name, est_drops }) => ({
    facility:     facilityId,
    plan_date:    planDate,
    project_name,
    est_drops:    est_drops ?? 0,
  }))
  const { error } = await supabase
    .from('project_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name' })
  if (error) console.error('upsertProjectDrops:', error)
}

const BREAK_MULS = [0.83, 1.00, 0.75, 1.00, 0.50, 1.00, 0.75, 1.00]

function breakAdjustedHours(rawHours) {
  const h         = rawHours != null ? Number(rawHours) : 8
  const fullHours = Math.floor(h)
  const frac      = h - fullHours
  let total = 0
  for (let i = 0; i < fullHours; i++) {
    total += BREAK_MULS[i] ?? 1
  }
  if (frac > 0) {
    total += frac * (BREAK_MULS[fullHours] ?? 1)
  }
  return total
}

export async function fetchAllFacilitiesLaborCounts(planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('facility, lane, shift_hours, on_loan_to')
    .eq('plan_date', planDate)
    .in('lane', ['shift1', 'mid', 'shift2', 'shift3',
                 'side12_shift1','side12_mid','side12_shift2','side12_shift3',
                 'side35_shift1','side35_mid','side35_shift2','side35_shift3'])
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    if (r.on_loan_to) continue
    const fac = r.facility
    if (!result[fac]) result[fac] = { headcount: 0, totalHours: 0 }
    result[fac].headcount  += 1
    result[fac].totalHours += breakAdjustedHours(r.shift_hours)
  }
  for (const fac of Object.keys(result)) {
    result[fac].totalHours = Math.round(result[fac].totalHours * 10) / 10
  }
  return result
}

export async function fetchProjectHourlyDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, hour, est_drops, manually_edited')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    if (!result[r.project_name]) result[r.project_name] = {}
    result[r.project_name][r.hour] = { est_drops: Number(r.est_drops), manually_edited: r.manually_edited ?? false }
  }
  return result
}

export async function fetchHourlyAdjustments(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('hourly_labor_adjustments')
    .select('hour, adjustment')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.hour, r.adjustment]))
}

export async function upsertHourlyAdjustment(facilityId, planDate, hour, adjustment) {
  if (!supabase) return
  const { error } = await supabase
    .from('hourly_labor_adjustments')
    .upsert({ facility: facilityId, plan_date: planDate, hour, adjustment },
            { onConflict: 'facility,plan_date,hour' })
  if (error) console.error('upsertHourlyAdjustment:', error)
}

export async function fetchAllFacilitiesEstDrops(planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('facility, est_drops')
    .eq('plan_date', planDate)
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    result[r.facility] = (result[r.facility] ?? 0) + Number(r.est_drops)
  }
  return result
}

export async function upsertProjectHourlyDrops(facilityId, planDate, rows) {
  if (!supabase) return
  const records = rows.map(({ project_name, h, est_drops }) => ({
    facility:        facilityId,
    plan_date:       planDate,
    project_name,
    hour:            h,
    est_drops:       est_drops ?? 0,
    manually_edited: true,
  }))
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour' })
  if (error) console.error('upsertProjectHourlyDrops:', error)
}

export async function upsertProjectHourlyDropsSeed(facilityId, planDate, rows) {
  if (!supabase || !rows.length) return
  const records = rows.map(({ project_name, h, est_drops }) => ({
    facility:        facilityId,
    plan_date:       planDate,
    project_name,
    hour:            h,
    est_drops:       est_drops ?? 0,
    manually_edited: false,
  }))
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour', ignoreDuplicates: false })
  if (error) console.error('upsertProjectHourlyDropsSeed:', error)
}

export async function deleteProjectHourlyDropsForProject(facilityId, planDate, projectName) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .delete()
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
    .eq('project_name', projectName)
  if (error) console.error('deleteProjectHourlyDropsForProject:', error)
}

export async function deleteOrphanSeedRows(facilityId, planDate, validKeys) {
  if (!supabase) return
  const validSet = new Set(validKeys)
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, hour')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
    .eq('manually_edited', false)
  if (error) { console.error('deleteOrphanSeedRows fetch:', error); return }
  if (!data || !data.length) return
  const orphans = data.filter(r => !validSet.has(`${r.project_name}|${r.hour}`))
  if (!orphans.length) return
  const byProject = {}
  for (const r of orphans) {
    if (!byProject[r.project_name]) byProject[r.project_name] = []
    byProject[r.project_name].push(r.hour)
  }
  for (const [project_name, hours] of Object.entries(byProject)) {
    const { error: delErr } = await supabase
      .from('project_hourly_drops_forecast')
      .delete()
      .eq('facility', facilityId)
      .eq('plan_date', planDate)
      .eq('project_name', project_name)
      .eq('manually_edited', false)
      .in('hour', hours)
    if (delErr) console.error('deleteOrphanSeedRows delete:', delErr)
  }
}

export async function clearExpiredManualEdits(facilityId, beforeDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .delete()
    .eq('facility', facilityId)
    .eq('manually_edited', true)
    .lt('plan_date', beforeDate)
  if (error) console.error('clearExpiredManualEdits:', error)
}

export async function fetchCustomDropProjects(facilityId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('facility_custom_drop_projects')
    .select('id, facility, project_name, omni_name')
    .eq('facility', facilityId)
    .order('project_name')
  if (error) { console.error('fetchCustomDropProjects:', error); return [] }
  return data ?? []
}

export async function addCustomDropProject(facilityId, projectName, omniName) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('facility_custom_drop_projects')
    .insert({ facility: facilityId, project_name: projectName.trim(), omni_name: omniName.trim() })
    .select()
    .single()
  if (error) { console.error('addCustomDropProject:', error); return null }
  return data
}

export async function deleteCustomDropProject(id) {
  if (!supabase) return
  const { error } = await supabase
    .from('facility_custom_drop_projects')
    .delete()
    .eq('id', id)
  if (error) console.error('deleteCustomDropProject:', error)
}

// ─── Historical EST Drops Cache ────────────────────────────────────────────

export async function fetchHistoricalDropsCache(facilityId, planDate, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('est_drops_historical_cache')
    .select('project_name, hour, est_drops, computed_at')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error) { console.error('fetchHistoricalDropsCache:', error); return null }
  if (!data || data.length === 0) return null
  let newest = 0
  for (const r of data) {
    const ts = new Date(r.computed_at).getTime()
    if (ts > newest) newest = ts
  }
  if (Date.now() - newest > maxAgeMs) return null
  const result = {}
  for (const r of data) {
    if (!result[r.project_name]) result[r.project_name] = {}
    result[r.project_name][r.hour] = Number(r.est_drops)
  }
  return result
}

export async function writeHistoricalDropsCache(facilityId, planDate, historicalDrops) {
  if (!supabase) return
  const { error: delErr } = await supabase
    .from('est_drops_historical_cache')
    .delete()
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (delErr) { console.error('writeHistoricalDropsCache delete:', delErr); return }
  const rows = []
  const computedAt = new Date().toISOString()
  for (const [project_name, hourMap] of Object.entries(historicalDrops || {})) {
    for (const [h, est_drops] of Object.entries(hourMap)) {
      rows.push({ facility: facilityId, plan_date: planDate, project_name, hour: Number(h), est_drops: Number(est_drops) || 0, computed_at: computedAt })
    }
  }
  if (!rows.length) return
  const { error: insErr } = await supabase
    .from('est_drops_historical_cache')
    .insert(rows)
  if (insErr) console.error('writeHistoricalDropsCache insert:', insErr)
}

export async function invalidateHistoricalDropsCache(facilityId, planDate) {
  if (!supabase) return
  const { error } = await supabase
    .from('est_drops_historical_cache')
    .delete()
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error) console.error('invalidateHistoricalDropsCache:', error)
}

// ─── WR Pick Schedule ─────────────────────────────────────────────────────

export async function fetchPickSchedule() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('wr_pick_schedule')
    .select('*')
    .order('day_of_week')
    .order('pick_seq')
  if (error) { console.error('fetchPickSchedule:', error); return [] }
  return data ?? []
}

export async function upsertPickScheduleRow(row) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('wr_pick_schedule')
    .upsert(row, { onConflict: 'day_of_week,route_number' })
    .select()
    .single()
  if (error) { console.error('upsertPickScheduleRow:', error); return null }
  return data
}

export async function insertPickScheduleRow(row) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('wr_pick_schedule')
    .insert(row)
    .select()
    .single()
  if (error) { console.error('insertPickScheduleRow:', error); return null }
  return data
}

export async function deletePickScheduleRow(id) {
  if (!supabase) return
  const { error } = await supabase
    .from('wr_pick_schedule')
    .delete()
    .eq('id', id)
  if (error) console.error('deletePickScheduleRow:', error)
}

// ─── WR Picker Assignments (job code 206) ───────────────────────────────────

export async function fetchPickerAssignments() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('wr_picker_assignments')
    .select('*')
    .order('employee_name')
  if (error) { console.error('fetchPickerAssignments:', error); return [] }
  return data ?? []
}

export async function upsertPickerAssignment(employeeId, employeeName, zone) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('wr_picker_assignments')
    .upsert(
      { employee_id: employeeId, employee_name: employeeName, zone, updated_at: new Date().toISOString() },
      { onConflict: 'employee_id' }
    )
    .select()
    .single()
  if (error) { console.error('upsertPickerAssignment:', error); return null }
  return data
}

export async function deletePickerAssignment(employeeId) {
  if (!supabase) return
  const { error } = await supabase
    .from('wr_picker_assignments')
    .delete()
    .eq('employee_id', employeeId)
  if (error) console.error('deletePickerAssignment:', error)
}

// ─── Roster staleness / auto-sync helpers ─────────────────────────────────

export async function checkRosterStaleness(facility, planDate, staleHours = 24) {
  if (!supabase) return false
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('last_b2e_sync_at')
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
    .not('last_b2e_sync_at', 'is', null)
    .limit(1)
  if (error || !data || data.length === 0) return true
  const syncedAt = new Date(data[0].last_b2e_sync_at).getTime()
  return Date.now() - syncedAt > staleHours * 60 * 60 * 1000
}

export async function markRosterRowsAsSynced(facility, planDate, syncedEmployeeIds = null) {
  if (!supabase) return
  let query = supabase
    .from('roster_assignments')
    .update({ last_b2e_sync_at: new Date().toISOString() })
    .eq('facility', facility)
    .eq('plan_date', planDate)
    .eq('is_temp', false)
  if (syncedEmployeeIds && syncedEmployeeIds.length > 0) {
    query = query.in('employee_id', syncedEmployeeIds)
  }
  const { error } = await query
  if (error) console.error('markRosterRowsAsSynced:', error)
}

// ─── Inventory Discrepancies ───────────────────────────────────────────────
//
// Persists flagged location discrepancies from the Inventory tab to Supabase
// so they survive page refreshes and accumulate across a full count session.
// Each row is keyed on (facility, location_id) with a 24h expiry.

export async function fetchInventoryDiscrepancies(facilityId) {
  if (!supabase) return new Map()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('inventory_discrepancies')
    .select('location_id, flag_data')
    .eq('facility', facilityId)
    .gt('expires_at', now)
  if (error) { console.error('fetchInventoryDiscrepancies:', error); return new Map() }
  return new Map((data ?? []).map(r => [r.location_id, r.flag_data]))
}

export async function upsertInventoryDiscrepancy(facilityId, locationId, flagData) {
  if (!supabase) return
  const now = new Date()
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase
    .from('inventory_discrepancies')
    .upsert(
      { facility: facilityId, location_id: locationId, flag_data: flagData, flagged_at: now.toISOString(), expires_at: expires },
      { onConflict: 'facility,location_id' }
    )
  if (error) console.error('upsertInventoryDiscrepancy:', error)
}

export async function deleteInventoryDiscrepancy(facilityId, locationId) {
  if (!supabase) return
  const { error } = await supabase
    .from('inventory_discrepancies')
    .delete()
    .eq('facility', facilityId)
    .eq('location_id', locationId)
  if (error) console.error('deleteInventoryDiscrepancy:', error)
}

export async function purgeExpiredInventoryDiscrepancies() {
  if (!supabase) return
  const { error } = await supabase
    .from('inventory_discrepancies')
    .delete()
    .lt('expires_at', new Date().toISOString())
  if (error) console.error('purgeExpiredInventoryDiscrepancies:', error)
}

// ─── Employee Break Schedule Overrides ──────────────────────────────────────
// Per-employee clock-time break schedule. When a row exists, it replaces the
// facility's BREAK_DEFAULTS multipliers for that employee in labor calc.
// All three break times are REQUIRED (NOT NULL in DB) — atomic override.

export async function fetchEmployeeBreaks(facility) {
  if (!supabase) return new Map()
  const { data, error } = await supabase
    .from('employee_breaks')
    .select('*')
    .eq('facility', facility)
  if (error) {
    console.error('fetchEmployeeBreaks:', error)
    return new Map()
  }
  const map = new Map()
  for (const row of data || []) {
    map.set(String(row.employee_id), {
      facility:              row.facility,
      first_break_at:        Number(row.first_break_at),
      first_break_minutes:   Number(row.first_break_minutes),
      lunch_at:              Number(row.lunch_at),
      lunch_minutes:         Number(row.lunch_minutes),
      second_break_at:       Number(row.second_break_at),
      second_break_minutes:  Number(row.second_break_minutes),
    })
  }
  return map
}

export async function upsertEmployeeBreak({ employeeId, facility, firstBreakAt, firstBreakMinutes, lunchAt, lunchMinutes, secondBreakAt, secondBreakMinutes }) {
  if (!supabase) return
  const { error } = await supabase
    .from('employee_breaks')
    .upsert({
      employee_id:           String(employeeId),
      facility,
      first_break_at:        firstBreakAt,
      first_break_minutes:   firstBreakMinutes,
      lunch_at:              lunchAt,
      lunch_minutes:         lunchMinutes,
      second_break_at:       secondBreakAt,
      second_break_minutes:  secondBreakMinutes,
      updated_at:            new Date().toISOString(),
    }, { onConflict: 'employee_id', ignoreDuplicates: false })
  if (error) {
    console.error('upsertEmployeeBreak:', error)
    throw error
  }
}

export async function deleteEmployeeBreak(employeeId) {
  if (!supabase) return
  const { error } = await supabase
    .from('employee_breaks')
    .delete()
    .eq('employee_id', String(employeeId))
  if (error) {
    console.error('deleteEmployeeBreak:', error)
    throw error
  }
}
