import { supabase } from './supabase.js'

// ─── Employee Onboarding ────────────────────────────────────────────────────
//
// Built 2026-07-15 — tracks the 3-month warehouse floor new-hire training
// curriculum (see src/lib/employeeOnboardingCurriculum.js for the fixed
// content) per employee. Requested by Tim Morris / Dan; curriculum sourced
// from Onboarding_Standardization_Notes.docx.
//
// New hires are added MANUALLY (name, facility, start date, trainer) — not
// pulled from B2E, per Dan's direction 2026-07-15. Distinct module from
// Customers > Customer Onboarding (onboarding_customers / _task_* tables) —
// that tracks new CUSTOMER onboarding, this tracks new EMPLOYEE training.
//
// Completion state is stored generically in eo_completions, keyed by the
// curriculum's stable module_key strings (e.g. 'm1_101', 'm1_week1') rather
// than one table per content type — the curriculum mixes single-entry
// modules (date/comments/observer) with repeatable weekly load logs (up to
// 10 dated entries/week), so repeatable rows are stored as a jsonb `entries`
// array on the same row shape instead of a second table.

export async function fetchOnboardingEmployees() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('employee_onboarding')
    .select('*')
    .order('start_date', { ascending: false })
  if (error) { console.error('fetchOnboardingEmployees:', error); return [] }
  return data ?? []
}

export async function createOnboardingEmployee({ employeeName, facility, startDate, trainerName }) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('employee_onboarding')
    .insert({
      employee_name: (employeeName || '').trim(),
      facility: facility || null,
      start_date: startDate || null,
      trainer_name: (trainerName || '').trim() || null,
      status: 'active',
    })
    .select()
    .single()
  if (error) { console.error('createOnboardingEmployee:', error); throw error }
  return data
}

export async function updateOnboardingEmployee(id, patch) {
  if (!supabase) return
  const { error } = await supabase
    .from('employee_onboarding')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) { console.error('updateOnboardingEmployee:', error); throw error }
}

export async function setEmployeeStatus(id, status) {
  return updateOnboardingEmployee(id, { status })
}

export async function deleteOnboardingEmployee(id) {
  if (!supabase) return
  // ON DELETE CASCADE on eo_completions / eo_evaluations handles child rows.
  const { error } = await supabase.from('employee_onboarding').delete().eq('id', id)
  if (error) console.error('deleteOnboardingEmployee:', error)
}

// ─── Module completions (values / numbered modules / weekly logs) ──────────

export async function fetchCompletions(onboardingId) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('eo_completions')
    .select('*')
    .eq('onboarding_id', onboardingId)
  if (error) { console.error('fetchCompletions:', error); return {} }
  const byKey = {}
  for (const row of (data ?? [])) byKey[row.module_key] = row
  return byKey
}

// upsertCompletion — single-entry modules (values, numbered training
// modules). patch may include completed, completed_date, comments,
// observer_name.
export async function upsertCompletion(onboardingId, moduleKey, patch) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('eo_completions')
    .upsert(
      { onboarding_id: onboardingId, module_key: moduleKey, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'onboarding_id,module_key' },
    )
    .select()
    .single()
  if (error) { console.error('upsertCompletion:', error); throw error }
  return data
}

// upsertWeeklyEntries — repeatable weekly load-observation logs. `entries`
// is an array of { date, grade, comments, observer } (grade omitted for
// Month 3 per WEEKLY_CONFIG.m3.hasGrade === false).
export async function upsertWeeklyEntries(onboardingId, moduleKey, entries) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('eo_completions')
    .upsert(
      { onboarding_id: onboardingId, module_key: moduleKey, entries, updated_at: new Date().toISOString() },
      { onConflict: 'onboarding_id,module_key' },
    )
    .select()
    .single()
  if (error) { console.error('upsertWeeklyEntries:', error); throw error }
  return data
}

// ─── End-of-Onboarding Evaluation ───────────────────────────────────────────

export async function fetchEvaluations(onboardingId) {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('eo_evaluations')
    .select('*')
    .eq('onboarding_id', onboardingId)
  if (error) { console.error('fetchEvaluations:', error); return {} }
  const byKey = {}
  for (const row of (data ?? [])) byKey[row.category_key] = row
  return byKey
}

export async function upsertEvaluation(onboardingId, categoryKey, patch) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('eo_evaluations')
    .upsert(
      { onboarding_id: onboardingId, category_key: categoryKey, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'onboarding_id,category_key' },
    )
    .select()
    .single()
  if (error) { console.error('upsertEvaluation:', error); throw error }
  return data
}
