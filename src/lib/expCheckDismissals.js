// src/lib/expCheckDismissals.js
//
// Dismiss/restore CRUD for the EXP Check tab. Self-contained Supabase
// client, same pattern as managerBonus.js/revisions.js, rather than
// growing the main supabase.js.
//
// Table: exp_check_dismissals (lot_code, material_code, dismissed_by,
// dismissed_at, dismissed_until, note). UNIQUE(lot_code, material_code) --
// re-dismissing the same lot/material just extends dismissed_until rather
// than creating a duplicate row. All 4 CRUD RLS policies verified via
// pg_policies before shipping.
//
// Note: this table already existed (empty) when this file was written --
// confirmed live via pg_policies/information_schema before building
// against it, rather than assuming the schema. Columns are `note`
// (singular) and there's no `facility` column -- facility is derived
// client-side from the lot data itself, not stored here.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// Fetches every dismissal row, expired or not -- the tab decides what to
// do with each based on dismissed_until vs. now (so "Dismissed" filter
// can still show recently-expired ones for context if wanted later).
export async function fetchDismissals() {
  const { data, error } = await supabase
    .from('exp_check_dismissals')
    .select('*')
    .order('dismissed_at', { ascending: false })
  if (error) throw error
  return data
}

// Dismiss (or re-dismiss/extend) a specific lot+material for `days` days.
export async function dismissLot(lotCode, materialCode, days, dismissedBy, note) {
  const dismissedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase
    .from('exp_check_dismissals')
    .upsert(
      [{
        lot_code: lotCode,
        material_code: materialCode,
        dismissed_by: dismissedBy || null,
        dismissed_at: new Date().toISOString(),
        dismissed_until: dismissedUntil,
        note: note || null,
      }],
      { onConflict: 'lot_code,material_code' }
    )
  if (error) throw error
}

// Restore (un-dismiss) -- deletes the row entirely rather than just
// setting dismissed_until to the past, so a restored lot doesn't leave
// stale history cluttering the table if it's dismissed again later.
export async function undismissLot(lotCode, materialCode) {
  const { error } = await supabase
    .from('exp_check_dismissals')
    .delete()
    .eq('lot_code', lotCode)
    .eq('material_code', materialCode)
  if (error) throw error
}
