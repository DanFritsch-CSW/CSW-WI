'use strict'

/**
 * lib/project-dockdoor-sync-shared.cjs — added 2026-10-13, Dan's explicit
 * request, following directly from the per-field accuracy work that same
 * day. Sifting agent_field_accuracy and ai_appt_intake_log showed Project
 * and Dock Door sitting at the bottom of the accuracy table (15.8% each)
 * almost entirely because the generic extraction correctly leaves them
 * blank -- most first-contact emails never state either one, per the
 * extraction prompt's own "never guess" rule.
 *
 * Checked directly before building this (both against MotherDuck's
 * gold.truck_appointments AND, once that turned out to be the wrong
 * source -- see below -- against this app's own `submissions` table):
 * Project is almost perfectly deterministic from Owner + Warehouse alone
 * (most combos have exactly 1 historical project; a few have 2-3 with one
 * clearly dominant -- e.g. every Crown Bakeries/Kenosha appointment is
 * "CROWN BAKERIES", 100%). Dock Door is near-deterministic once Type
 * (Inbound/Outbound) is also known (e.g. Birchwood/Kenosha/Outbound is
 * "Misc. Outbound" 99.9% of the time). Since Owner resolution is already
 * fairly reliable (see scheduling-agent-webhook's Owner resolution
 * section) and Type is already ~94% accurate, a confidence-gated lookup
 * on (Owner, Warehouse, Type) can auto-fill both fields the same way
 * Carrier/Owner already auto-fill from a fuzzy/alias match -- never a
 * guess below a real confidence bar, same "never guess" principle.
 *
 * WRONG SOURCE AVOIDED: the obvious first instinct was to compute this
 * from MotherDuck's gold.truck_appointments, mirroring owners-sync-
 * shared.cjs/carriers-sync-shared.cjs. Checked live before building
 * either version and explicitly rejected: that table's
 * location_container_name field is the REAL PHYSICAL dock door assigned
 * at operation time (e.g. "Dock Door 22", "LD024A") -- 25-37 distinct
 * values per owner/warehouse/type combo, nothing close to deterministic.
 * It is NOT the same thing as this app's own `scheduled_dock_door` field
 * (a coarser scheduling-time GROUP label like "Misc. Outbound",
 * "OUTBOUND PALERMO", "Richelieu Outbound"), which is what a CSR actually
 * types into a submission and what this lookup needs to predict. This
 * app's own `submissions` table is the correct source: it already has
 * 25,646 rows across 73 distinct owners since 2026-03-27, directly
 * reflecting what gets typed into this exact system, not raw Datex door
 * assignments. Confirmed live before writing a line of SQL against it.
 *
 * Because the source is this app's own Supabase data rather than
 * MotherDuck, the whole aggregation runs as a single Postgres function
 * (refresh_scheduling_project_dockdoor_map(), see the migration that
 * created it) invoked via RPC -- no duckdb/native-module dependency at
 * all, unlike every other *-sync-shared.cjs in this app.
 *
 * `scheduling_project_dockdoor_map` is keyed on (owner_name, warehouse,
 * type) with the single most common project_name/dock_door for that key
 * plus counts (project_count/project_total, dock_count/dock_total) so
 * the webhook can compute its own confidence and apply its own threshold
 * at read time, rather than baking a cutoff into the sync -- the same
 * division of responsibility as fetchCarrierList/resolveCarrier (fetch
 * returns candidates+counts, the caller decides the bar). Full replace
 * each run, same convention as owners-sync/carriers-sync -- this function
 * is the only writer; scheduling-agent-webhook only ever reads it.
 */

async function runProjectDockDoorSync() {
  const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!SUPA_URL || !SUPA_KEY) {
    return { synced: 0, error: 'Supabase env vars not configured' }
  }

  const { createClient } = require('@supabase/supabase-js')
  const supabase = createClient(SUPA_URL, SUPA_KEY)

  try {
    const { data, error } = await supabase.rpc('refresh_scheduling_project_dockdoor_map')
    if (error) throw new Error(error.message)
    return { synced: typeof data === 'number' ? data : null, error: null }
  } catch (err) {
    return { synced: 0, error: err.message }
  }
}

module.exports = { runProjectDockDoorSync }
