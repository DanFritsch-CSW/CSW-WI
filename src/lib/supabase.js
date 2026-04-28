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

export async function upsertAssignment(assignment) {
  if (!supabase) return
  const { error } = await supabase
    .from('roster_assignments')
    .upsert(assignment, { onConflict: 'facility,employee_id,plan_date' })
  if (error) console.error('upsertAssignment:', error)
}

export async function fetchEmployees(facility) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('facility', facility)
    .in('job_code', ['205', '209'])
  if (error) { console.error('fetchEmployees:', error); return [] }
  return data ?? []
}

// Fetch all cal2 employees for the dock assignment editor.
// Returns { id, name, default_lane } sorted by name.
export async function fetchCal2Employees() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, default_lane')
    .eq('facility', 'cal2')
    .order('name')
  if (error) { console.error('fetchCal2Employees:', error); return [] }
  return data ?? []
}

// Update the dock side for a single employee by writing the correct
// side-prefixed lane into employees.default_lane.
// side: 'side12' | 'side35'
// Preserves the shift bucket (shift1/mid/shift2/shift3) from the current lane.
export async function upsertEmployeeDockSide(employeeId, side, currentLane) {
  if (!supabase) return
  // Extract existing shift suffix, default to shift1 if lane not yet set
  const shiftSuffix = (currentLane || '').replace(/^side(12|35)_/, '') || 'shift1'
  const newLane = `${side}_${shiftSuffix}`
  const { error } = await supabase
    .from('employees')
    .update({ default_lane: newLane })
    .eq('id', employeeId)
  if (error) console.error('upsertEmployeeDockSide:', error)
  return newLane
}

// Syncs the employee list for a facility: upserts current B2E employees, then
// deletes any stale facility employees not in the B2E result.
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

export async function seedRosterAssignments(employees, planDate, ignoreDuplicates = true) {
  if (!supabase || !employees.length) return null
  const rows = employees.map(e => ({
    facility:      e.facility,
    employee_id:   e.id,
    employee_name: e.name,
    role:          e.role ?? null,
    lane:          e.default_lane || 'shift1',
    plan_date:     planDate,
    shift_start:   e.shift_start ?? null,
    shift_hours:   e.shift_hours ?? null,
    is_temp:       false,
  }))
  const { error } = await supabase
    .from('roster_assignments')
    .upsert(rows, { onConflict: 'facility,employee_id,plan_date', ignoreDuplicates })
  if (error) { console.error('seedRosterAssignments:', error); return error.message }
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

// Returns per-facility: { [facilityId]: { headcount, totalHours } }
// headcount  = # of active-lane (shift1/mid/shift2/shift3) employees
// totalHours = sum of shift_hours for those employees (fallback 8 hrs if null)
export async function fetchAllFacilitiesLaborCounts(planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('roster_assignments')
    .select('facility, lane, shift_hours')
    .eq('plan_date', planDate)
    .in('lane', ['shift1', 'mid', 'shift2', 'shift3',
                 'side12_shift1','side12_mid','side12_shift2','side12_shift3',
                 'side35_shift1','side35_mid','side35_shift2','side35_shift3'])
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    // Normalise cal2 → cal for the scorecards (cal2 is excluded from the ALL grid anyway)
    const fac = r.facility
    if (!result[fac]) result[fac] = { headcount: 0, totalHours: 0 }
    result[fac].headcount  += 1
    result[fac].totalHours += r.shift_hours != null ? Number(r.shift_hours) : 8
  }
  return result
}

export async function fetchProjectHourlyDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_hourly_drops_forecast')
    .select('project_name, hour, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  const result = {}
  for (const r of data) {
    if (!result[r.project_name]) result[r.project_name] = {}
    result[r.project_name][r.hour] = r.est_drops
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
    result[r.facility] = (result[r.facility] ?? 0) + r.est_drops
  }
  return result
}

export async function upsertProjectHourlyDrops(facilityId, planDate, rows) {
  if (!supabase) return
  const records = rows.map(({ project_name, h, est_drops }) => ({
    facility:     facilityId,
    plan_date:    planDate,
    project_name,
    hour:         h,
    est_drops:    est_drops ?? 0,
  }))
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour' })
  if (error) console.error('upsertProjectHourlyDrops:', error)
}
