// src/lib/expCheckDismissals.js
//
// Dismiss/restore CRUD for the EXP Check (Pretzilla / Bernatello's) tab.
// Self-contained Supabase client (same reasoning as managerBonus.js /
// revisions.js) rather than growing src/lib/supabase.js further.
//
// Table: exp_check_dismissals (lot_code, material_code, dismissed_at,
// dismissed_until [NULL = permanent], note, dismissed_by). UNIQUE on
// (lot_code, material_code) -- dismissing an already-dismissed lot just
// updates the existing row (new duration/note) rather than creating a
// duplicate. All 4 CRUD RLS policies verified via pg_policies before
// shipping.
//
// Added 2026-08-02 per Dan's ask: give the tab the ability to dismiss a
// lot (e.g. the "relabeled -- verify manually" ones, once someone's
// actually checked them) for a period of time, so the dashboard doesn't
// stay cluttered with the same confirmed-fine lots forever. A dismissal
// is keyed on (lot_code, material_code) -- the same identity the tab
// already uses as its row key -- not on a verdict, so dismissing a lot
// clears it regardless of which bucket it's currently showing under.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

function dismissalKey(lotCode, materialCode) {
  return `${lotCode}::${materialCode}`
}

// Returns a Map<"lotCode::materialCode", dismissalRow> for every dismissal
// that's still active right now (dismissed_until is NULL, i.e. permanent,
// OR dismissed_until is still in the future). Expired dismissals are
// fetched too but excluded from the map -- once dismissed_until passes,
// the lot naturally reappears in the live check without any cleanup job
// needed.
export async function fetchActiveDismissals() {
  const { data, error } = await supabase
    .from('exp_check_dismissals')
    .select('*')
  if (error) throw error
  const now = Date.now()
  const map = new Map()
  for (const row of data || []) {
    const stillActive = !row.dismissed_until || new Date(row.dismissed_until).getTime() > now
    if (stillActive) {
      map.set(dismissalKey(row.lot_code, row.material_code), row)
    }
  }
  return map
}

// All dismissals (active + expired) for the "Dismissed" review tab, most
// recently dismissed first.
export async function fetchAllDismissals() {
  const { data, error } = await supabase
    .from('exp_check_dismissals')
    .select('*')
    .order('dismissed_at', { ascending: false })
  if (error) throw error
  return data
}

// durationDays: number of days from now, or null for a permanent dismissal.
export async function dismissLot(lotCode, materialCode, durationDays, note = null) {
  const dismissedUntil = durationDays
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null
  const { error } = await supabase
    .from('exp_check_dismissals')
    .upsert(
      [{
        lot_code: lotCode,
        material_code: materialCode,
        dismissed_at: new Date().toISOString(),
        dismissed_until: dismissedUntil,
        note,
      }],
      { onConflict: 'lot_code,material_code' }
    )
  if (error) throw error
}

export async function restoreLot(lotCode, materialCode) {
  const { error } = await supabase
    .from('exp_check_dismissals')
    .delete()
    .eq('lot_code', lotCode)
    .eq('material_code', materialCode)
  if (error) throw error
}

export { dismissalKey }
