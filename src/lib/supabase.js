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
  if (error) { console.error('fetchEmployees:', error); return [] }
  return data ?? []
}

export async function upsertEmployees(employees) {
  if (!supabase) return 'Supabase not configured'
  const { error } = await supabase
    .from('employees')
    .upsert(employees, { onConflict: 'id' })
  if (error) { console.error('upsertEmployees:', error); return error.message }
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

const SETTINGS_DEFAULTS = {
  hours_per_appt: 1.5,
  shift1_start: 5,  shift1_hours: 8,
  mid_start:    9,  mid_hours:    8,
  shift2_start: 13, shift2_hours: 8,
  shift3_start: 22, shift3_hours: 8,
  break_hour_1: 83, break_hour_2: 100, break_hour_3: 75, break_hour_4: 100,
  break_hour_5: 50, break_hour_6: 100, break_hour_7: 75, break_hour_8: 100,
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

// Returns { [hour]: est_drops } for the given facility + date
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

// hourlyValues: [{ h: number, est: number }] — one entry per shift hour
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

// Returns { [project_name]: total_est_drops } (sum across all hours) for facility + date
export async function fetchProjectDrops(facilityId, planDate) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_drops_forecast')
    .select('project_name, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
  if (error || !data) return {}
  const totals = {}
  data.forEach(r => { totals[r.project_name] = (totals[r.project_name] ?? 0) + r.est_drops })
  return totals
}

// Returns { [hour]: est_drops } for a specific facility + date + project
export async function fetchProjectHourlyDrops(facilityId, planDate, projectName) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('project_drops_forecast')
    .select('hour, est_drops')
    .eq('facility', facilityId)
    .eq('plan_date', planDate)
    .eq('project_name', projectName)
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.hour, r.est_drops]))
}

// hourlyValues: [{ h: number, est: number }] — saves per-hour drops for a project
export async function upsertProjectDrops(facilityId, planDate, projectName, hourlyValues) {
  if (!supabase) return
  const records = hourlyValues.map(({ h, est }) => ({
    facility:     facilityId,
    plan_date:    planDate,
    project_name: projectName,
    hour:         h,
    est_drops:    est ?? 0,
  }))
  const { error } = await supabase
    .from('project_drops_forecast')
    .upsert(records, { onConflict: 'facility,plan_date,project_name,hour' })
  if (error) console.error('upsertProjectDrops:', error)
}
