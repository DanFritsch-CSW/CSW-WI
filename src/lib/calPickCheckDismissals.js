// src/lib/calPickCheckDismissals.js
//
// Dismiss/restore CRUD for the CAL Pick Location Lot Check tab (PALDSD9).
// Copy of wrPickCheckDismissals.js pointed at its own table
// (cal_pick_check_dismissals) so a Caledonia material code can never collide
// with a Wisconsin Rapids one -- wr_pick_check_dismissals is UNIQUE on
// material_code alone.
//
// Table: cal_pick_check_dismissals (material_code UNIQUE, dismissed_at,
// dismissed_until [NULL = permanent], note, dismissed_by, updated_at).
// Keyed on material_code only: dismissing is about a MATERIAL structurally
// not living on the pick line, not about a specific lot.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export async function fetchDismissals() {
  const { data, error } = await supabase
    .from('cal_pick_check_dismissals')
    .select('*')
    .order('dismissed_at', { ascending: false })
  if (error) throw error
  return data
}

// `days` null/undefined = permanent (dismissed_until stays NULL).
export async function dismissMaterial(materialCode, days, dismissedBy, note) {
  const dismissedUntil = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null
  const { error } = await supabase
    .from('cal_pick_check_dismissals')
    .upsert(
      [{
        material_code: materialCode,
        dismissed_by: dismissedBy || null,
        dismissed_at: new Date().toISOString(),
        dismissed_until: dismissedUntil,
        note: note || null,
        updated_at: new Date().toISOString(),
      }],
      { onConflict: 'material_code' }
    )
  if (error) throw error
}

// Restore deletes the row so a later re-dismissal starts clean.
export async function restoreMaterial(materialCode) {
  const { error } = await supabase
    .from('cal_pick_check_dismissals')
    .delete()
    .eq('material_code', materialCode)
  if (error) throw error
}
