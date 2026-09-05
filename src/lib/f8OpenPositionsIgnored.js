// src/lib/f8OpenPositionsIgnored.js
//
// Ignore/restore CRUD for the F8 Open Positions tab. Self-contained
// Supabase client, same pattern as wrPickCheckDismissals.js/
// expCheckDismissals.js/managerBonus.js -- doesn't grow the main
// supabase.js.
//
// Table: f8_open_positions_ignored (location_name PRIMARY KEY,
// ignored_until [NULL = permanent], note, ignored_by, ignored_at,
// updated_at). All 4 CRUD RLS policies verified via pg_policies before
// shipping.
//
// Keyed on location_name, not aisle-scoped -- this is a general "ignore
// this specific location" capability across F8B-F8E, separate from the
// structural F8E##-00 exclusion (which is baked into the MotherDuck query
// itself, not user-managed). Defaults to permanent (ignored_until=NULL)
// per Dan's framing that ignoring a location is usually a stable fact
// (damaged rack, permanently blocked, etc.), not noise that ages out --
// same reasoning as wr_pick_check_dismissals' material-level dismissals.
// A time-boxed option is still offered in case a location should only be
// ignored temporarily.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// Fetches every ignore row, expired or not -- the tab decides what to do
// with each based on ignored_until vs. now (same convention as
// fetchDismissals() in wrPickCheckDismissals.js).
export async function fetchIgnoredLocations() {
  const { data, error } = await supabase
    .from('f8_open_positions_ignored')
    .select('*')
    .order('ignored_at', { ascending: false })
  if (error) throw error
  return data
}

// Ignore (or re-ignore/extend) a location. `days` null/undefined means
// permanent (ignored_until stays NULL); a number means "reappear after
// N days if still unresolved."
export async function ignoreLocation(locationName, days, ignoredBy, note) {
  const ignoredUntil = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null
  const { error } = await supabase
    .from('f8_open_positions_ignored')
    .upsert(
      [{
        location_name: locationName.trim().toUpperCase(),
        ignored_by: ignoredBy || null,
        ignored_at: new Date().toISOString(),
        ignored_until: ignoredUntil,
        note: note || null,
        updated_at: new Date().toISOString(),
      }],
      { onConflict: 'location_name' }
    )
  if (error) throw error
}

// Restore (un-ignore) -- deletes the row entirely rather than just
// clearing ignored_until, so a re-ignore later starts clean.
export async function restoreLocation(locationName) {
  const { error } = await supabase
    .from('f8_open_positions_ignored')
    .delete()
    .eq('location_name', locationName)
  if (error) throw error
}
