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

export async function seedRosterAssignments(employees, planDate) {
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
    from_facility: null,
    on_loan_to:    null,
  }))
  const { error } = await supabase
    .from('roster_assignments')
    .upsert(rows, { onConflict: 'facility,employee_id,plan_date', ignoreDuplicates: false })
  if (error) { console.error('seedRosterAssignments:', error); return error.message }
  return null
}

export async function purgeStaleAssignments(employeeIds, correctFacility, fromDate) {
  if (!supabase || !employeeIds.length) return null
  const { error } = await supabase
    .from('roster_assignments')
    .delete()
    .in('employee_id', employeeIds)
    .neq('facility', correctFacility)
    .is('from_facility', null)
    .gte('plan_date', fromDate)
  if (error) { console.error('purgeStaleAssignments:', error); return error.message }
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
  const { error: srcErr } = await supabase
    .from('roster_assignments')
    .update({ on_loan_to: destFacility })
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
    }, { onConflict: 'facility,employee_id,plan_date' })
  if (dstErr) { console.error('sendEmployeeOnLoan dst:', dstErr); return dstErr.message }
  return null
}

export async function recallLoan({ employeeId, sourceFacility, destFacility, planDate }) {
  if (!supabase) return 'Supabase not configured'
  const { error: srcErr } = await supabase
    .from('roster_assignments')
    .update({ on_loan_to: null })
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
  const h = rawHours != null ? Number(rawHours) : 8
  let total = 0
  for (let i = 0; i < h; i++) {
    total += BREAK_MULS[i] ?? 1
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

// Overwrites existing rows — used by manual edits and Copy to dates
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

// Inserts only rows that don't already exist — used by auto-seed to protect manual edits
export async function insertProjectHourlyDropsIfMissing(facilityId, planDate, rows) {
  if (!supabase || !rows.length) return
  const records = rows.map(({ project_name, h, est_drops }) => ({
    facility:     facilityId,
    plan_date:    planDate,
    project_name,
    hour:         h,
    est_drops:    est_drops ?? 0,
  }))
  const { error } = await supabase
    .from('project_hourly_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour', ignoreDuplicates: true })
  if (error) console.error('insertProjectHourlyDropsIfMissing:', error)
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
  // zone = 1-12 or null (unassigned)
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
