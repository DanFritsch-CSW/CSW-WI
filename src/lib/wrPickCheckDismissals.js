// src/lib/wrPickCheckDismissals.js
//
// Dismiss/restore CRUD for the WR Pick Location Lot Check tab. Self-
// contained Supabase client, same pattern as expCheckDismissals.js/
// managerBonus.js -- doesn't grow the main supabase.js.
//
// Table: wr_pick_check_dismissals (material_code UNIQUE, dismissed_at,
// dismissed_until [NULL = permanent], note, dismissed_by, updated_at).
// This table already existed (empty, never wired to any UI) when this
// file was written -- confirmed live via information_schema/pg_policies
// before building against it. All 4 CRUD RLS policies were already in
// place.
//
// Keyed on material_code only, not lot_code -- unlike EXP Check's
// dismissals (which are about a specific lot's dates being noise), this
// dismissal is about a MATERIAL structurally not living on the P-slot
// pickline at all (e.g. Tavern-Style Crust Pub, picked entirely from
// C/D/E/F rack locations, never a P-slot). That's a stable fact about
// the material, not a per-lot thing -- every future lot of that material
// would hit the same false "WAREHOUSE" flag, so dismissing by
// material_code (usually permanently, dismissed_until = NULL) is the
// correct grain here.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// Fetches every dismissal row, expired or not -- the tab decides what to
// do with each based on dismissed_until vs. now.
export async function fetchDismissals() {
  const { data, error } = await supabase
    .from('wr_pick_check_dismissals')
    .select('*')
    .order('dismissed_at', { ascending: false })
  if (error) throw error
  return data
}

// Dismiss (or re-dismiss/extend) a material. `days` null/undefined means
// permanent (dismissed_until stays NULL); a number means "reappear after
// N days if still unresolved."
export async function dismissMaterial(materialCode, days, dismissedBy, note) {
  const dismissedUntil = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null
  const { error } = await supabase
    .from('wr_pick_check_dismissals')
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

// Restore (un-dismiss) -- deletes the row entirely rather than just
// clearing dismissed_until, so a re-dismissal later starts clean.
export async function restoreMaterial(materialCode) {
  const { error } = await supabase
    .from('wr_pick_check_dismissals')
    .delete()
    .eq('material_code', materialCode)
  if (error) throw error
}
