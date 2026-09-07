import { supabase } from './supabase.js'

// Dan's private Footprint tracker (/dan) — Madison Active LPs vs. manually
// set Projected Footprint, by customer/project. Kept in its own file rather
// than growing supabase.js (already ~76KB) per this project's file-hygiene
// convention.
//
// Table: dan_footprint_targets(facility TEXT DEFAULT 'mad', project_name TEXT,
// projected_footprint NUMERIC, updated_at, updated_by). PK (facility, project_name).
// All 4 CRUD RLS policies present (anon_select/insert/update/delete) —
// verified via pg_policies before shipping, per this project's standing
// "missing DELETE policy silently no-ops deletes" rule.
//
// Active LPs are NOT stored here — they come live from
// fetchKnownCustomersForFacility('mad') in spacePlanning.js (same Omni
// path the Customer Stacking dropdown already uses). This table only
// tracks the manual projected-footprint target per project, and which
// projects Dan has chosen to track (add/remove).

export async function fetchFootprintTargets(facility = 'mad') {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('dan_footprint_targets')
    .select('*')
    .eq('facility', facility)
    .order('project_name')
  if (error) { console.error('fetchFootprintTargets:', error); return [] }
  return data ?? []
}

export async function upsertFootprintTarget(facility, projectName, projectedFootprint, updatedBy = 'Dan') {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { data, error } = await supabase
    .from('dan_footprint_targets')
    .upsert(
      {
        facility,
        project_name: projectName.trim(),
        projected_footprint: Number(projectedFootprint) || 0,
        updated_by: updatedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'facility,project_name', ignoreDuplicates: false }
    )
    .select()
    .single()
  if (error) { console.error('upsertFootprintTarget:', error); return { success: false, error: error.message } }
  return { success: true, row: data }
}

export async function deleteFootprintTarget(facility, projectName) {
  if (!supabase) return { success: false, error: 'Supabase not configured' }
  const { error } = await supabase
    .from('dan_footprint_targets')
    .delete()
    .eq('facility', facility)
    .eq('project_name', projectName)
  if (error) { console.error('deleteFootprintTarget:', error); return { success: false, error: error.message } }
  return { success: true }
}
