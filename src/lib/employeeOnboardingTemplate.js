import { supabase } from './supabase.js'

// ─── Template Editor support ────────────────────────────────────────────────
// Added 2026-07-18 per Tim/Eli feedback ("expose those different elements...
// so that I'm not the bottleneck"). Backs the in-app editor for per-month
// values-discussion wording and numbered training modules — the actual
// curriculum CONTENT, as opposed to structure (months/weekly-config/eval
// categories), which stays in src/lib/employeeOnboardingCurriculum.js.
//
// module_key is stable and never reused after a delete — eo_completions rows
// reference it, so deleting a template module just orphans its old
// completion rows (harmless) rather than corrupting a different module's
// history. New modules get a generated key: `${monthKey}_custom_<id>`.

export async function fetchCurriculumValues() {
  if (!supabase) return {}
  const { data, error } = await supabase.from('eo_curriculum_values').select('*')
  if (error) { console.error('fetchCurriculumValues:', error); return {} }
  const byMonth = {}
  for (const row of (data ?? [])) byMonth[row.month_key] = row
  return byMonth
}

export async function updateCurriculumValue(monthKey, patch) {
  if (!supabase) return
  const { error } = await supabase
    .from('eo_curriculum_values')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('month_key', monthKey)
  if (error) { console.error('updateCurriculumValue:', error); throw error }
}

export async function fetchCurriculumModules() {
  if (!supabase) return { m1: [], m2: [], m3: [] }
  const { data, error } = await supabase
    .from('eo_curriculum_modules')
    .select('*')
    .order('sort_order')
  if (error) { console.error('fetchCurriculumModules:', error); return { m1: [], m2: [], m3: [] } }
  const grouped = { m1: [], m2: [], m3: [] }
  for (const row of (data ?? [])) {
    (grouped[row.month_key] ??= []).push({
      key: row.module_key,
      id: row.id,
      code: row.code,
      title: row.title,
      bullets: row.bullets || [],
      objectives: row.objectives,
      resourceLink: row.resource_link,
      resourceLabel: row.resource_label,
      perCustomer: row.per_customer,
      sortOrder: row.sort_order,
    })
  }
  return grouped
}

export async function addCurriculumModule({ monthKey, code, title, bullets, objectives, resourceLink, resourceLabel, sortOrder }) {
  if (!supabase) return null
  // Generated key is stable and unique — timestamp suffix avoids collisions
  // even if two people add a module in the same month around the same time.
  const moduleKey = `${monthKey}_custom_${Date.now()}`
  const { data, error } = await supabase
    .from('eo_curriculum_modules')
    .insert({
      month_key: monthKey, module_key: moduleKey,
      code: code || null, title: (title || '').trim(),
      bullets: bullets || [], objectives: objectives || null,
      resource_link: resourceLink || null, resource_label: resourceLabel || null,
      sort_order: sortOrder,
    })
    .select()
    .single()
  if (error) { console.error('addCurriculumModule:', error); throw error }
  return data
}

export async function updateCurriculumModule(id, patch) {
  if (!supabase) return
  const { error } = await supabase
    .from('eo_curriculum_modules')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) { console.error('updateCurriculumModule:', error); throw error }
}

export async function deleteCurriculumModule(id) {
  if (!supabase) return
  const { error } = await supabase.from('eo_curriculum_modules').delete().eq('id', id)
  if (error) { console.error('deleteCurriculumModule:', error); throw error }
}

// swapCurriculumModuleOrder — swaps sort_order between two adjacent modules
// in the same month, backing up/down reorder controls (mirrors the Customer
// Onboarding Template Editor's swapTemplateTaskOrder).
export async function swapCurriculumModuleOrder(modA, modB) {
  if (!supabase) return
  const { error: e1 } = await supabase
    .from('eo_curriculum_modules')
    .update({ sort_order: modB.sortOrder })
    .eq('id', modA.id)
  const { error: e2 } = await supabase
    .from('eo_curriculum_modules')
    .update({ sort_order: modA.sortOrder })
    .eq('id', modB.id)
  if (e1 || e2) console.error('swapCurriculumModuleOrder:', e1 || e2)
}

// ─── HR Handoff settings ─────────────────────────────────────────────────────
// Single pinned settings row (id=1) — Dan sets the target Front conversation
// ID once via a small settings block in the Template Editor view.

export async function fetchHrSettings() {
  if (!supabase) return { front_conversation_id: null, notify_enabled: false }
  const { data, error } = await supabase.from('eo_hr_settings').select('*').eq('id', 1).single()
  if (error) { console.error('fetchHrSettings:', error); return { front_conversation_id: null, notify_enabled: false } }
  return data
}

export async function updateHrSettings(patch) {
  if (!supabase) return
  const { error } = await supabase
    .from('eo_hr_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1)
  if (error) { console.error('updateHrSettings:', error); throw error }
}
