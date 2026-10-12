'use strict'

/**
 * lib/owners-sync-shared.cjs — added 2026-10-12, Dan's explicit request
 * after a real live test (cnv_1cm... "Pickup Apt Needed (455095)",
 * dpwl@goselect.com, PO 522162) showed scheduling_agent extracting
 * Owner="Palermos" straight from the email's "VENDOR: Palermos" line --
 * a plausible-looking, but NOT Datex-valid, owner name. Datex's real
 * owner record is "Palermo Villa, Inc." (ID 704). Writing "Palermos"
 * verbatim means it would never resolve to a Datex owner ID at push
 * time, and a CSR would have to notice and fix it by hand every time.
 *
 * Carrier already solved exactly this class of problem back on 2026-10-10
 * (fuzzy-matching against a synced Supabase table, scheduling_carriers,
 * instead of trusting the raw extracted string) -- this is the same
 * pattern applied to Owner, built directly off that file's already-
 * learned lessons rather than repeating its mistakes:
 *   - Query MotherDuck DIRECTLY (production_db.bronze.datex_owners,
 *     deduped to latest CDC version), never through Omni -- Omni's own
 *     cached topics have independently been confirmed stale/lagging
 *     relative to live Datex data twice already today (see
 *     PluginView.jsx's 2026-10-12 project->owner header note).
 *   - Trim at the SQL source, before any dedup partition, so the dedup
 *     key matches exactly what ends up written to Supabase (carriers-
 *     sync-shared.cjs's 2026-10-10 "third pass" fix, avoided here from
 *     the start).
 *
 * IMPORTANT DIFFERENCE FROM CARRIER, confirmed live before writing this:
 * pure bigram-dice fuzzy matching alone does NOT catch "Palermos" vs.
 * "Palermo Villa, Inc." (scores ~0.52, well under the 0.8 threshold --
 * too much of the real name is the legal suffix "Villa, Inc." that the
 * informal name never had). This is a genuinely different problem from
 * Carrier's (where names are typically just spelling/formatting variants
 * of each other) -- it's an INFORMAL NAME vs. LEGAL ENTITY NAME problem.
 * scheduling-agent-webhook therefore checks a small, human-curated
 * `settings.owner_aliases` map FIRST (seeded with
 * {"palermos": "Palermo Villa, Inc."} from this exact case), falling back
 * to fuzzy-matching against this table only for genuine spelling/
 * formatting variance the alias map doesn't cover. See that file's
 * 2026-10-12 header note for the full resolution logic.
 *
 * 233 real owners confirmed live (production_db.bronze.datex_owners,
 * deduped) -- a small, stable list; weekly sync (same cadence as
 * carriers-sync-run.cjs) is comfortably sufficient.
 */

async function queryOwnersFromMotherDuck() {
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')

  const sql = `
    WITH latest_owners AS (
      -- Trimmed here, at the source, before the dedup partition below --
      -- same "trim first" discipline carriers-sync-shared.cjs's
      -- 2026-10-10 third-pass fix established, applied from the start
      -- here rather than discovered the hard way a second time.
      SELECT
        Id AS owner_id,
        trim(Name) AS owner_name,
        ROW_NUMBER() OVER (PARTITION BY Id ORDER BY ingestion_ts DESC) AS rn
      FROM production_db.bronze.datex_owners
    ),
    deduped AS (
      -- owner_name isn't Datex-unique in principle (233 rows confirmed
      -- live with zero collisions today, but nothing guarantees that
      -- stays true forever) -- dedup defensively the same way carriers
      -- does, keeping the lowest owner_id per name as a deterministic
      -- tiebreaker since there's no per-owner activity count to rank by
      -- the way carriers has appointment_count.
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY owner_name
        ORDER BY owner_id ASC
      ) AS name_rn
      FROM latest_owners
      WHERE rn = 1 AND owner_name IS NOT NULL AND owner_name != ''
    )
    SELECT owner_id, owner_name
    FROM deduped
    WHERE name_rn = 1
  `

  // Netlify Functions requires HOME=/tmp for the duckdb native module to
  // have a writable scratch dir -- same pattern as every other
  // motherduck-*.cjs function in this app (see scheduling-order-search.cjs).
  process.env.HOME = '/tmp'
  process.env.motherduck_token = TOKEN

  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: TOKEN })
  const conn = db.connect()

  try {
    await new Promise((resolve, reject) => {
      conn.run('LOAD motherduck', (err) => (err ? reject(err) : resolve()))
    })

    const rows = await new Promise((resolve, reject) => {
      conn.all(sql, (err, result) => (err ? reject(err) : resolve(result)))
    })

    return rows
      .filter((r) => r.owner_id != null && r.owner_name)
      .map((r) => ({
        owner_id: Number(r.owner_id),
        // Already trimmed in SQL -- .trim() here is a harmless no-op
        // safety net, not load-bearing.
        owner_name: String(r.owner_name).trim(),
      }))
  } finally {
    conn.close()
    db.close()
  }
}

// Runs the full sync: fetch from MotherDuck, replace scheduling_owners in
// Supabase. Returns { synced, error } -- never throws, so the caller
// (scheduled or manual-test function) can always respond cleanly.
async function runOwnersSync() {
  const SUPA_URL = process.env.VITE_SUPABASE_URL
  const SUPA_KEY = process.env.VITE_SUPABASE_ANON_KEY
  if (!SUPA_URL || !SUPA_KEY) {
    return { synced: 0, error: 'Supabase env vars not configured' }
  }

  const { createClient } = require('@supabase/supabase-js')
  const supabase = createClient(SUPA_URL, SUPA_KEY)

  try {
    const owners = await queryOwnersFromMotherDuck()

    if (owners.length === 0) {
      return { synced: 0, error: 'MotherDuck returned zero owners -- refusing to wipe the table on what looks like an outage' }
    }

    const rows = owners.map((o) => ({
      owner_name: o.owner_name,
      owner_id: o.owner_id,
      synced_at: new Date().toISOString(),
    }))

    // Full replace: delete then insert. Safe for a weekly batch job with
    // no concurrent writers -- scheduling-agent-webhook only ever reads
    // this table, never writes it.
    const { error: delErr } = await supabase.from('scheduling_owners').delete().neq('owner_name', '__never_matches__')
    if (delErr) throw new Error(`delete failed: ${delErr.message}`)

    const { error: insErr } = await supabase.from('scheduling_owners').insert(rows)
    if (insErr) throw new Error(`insert failed: ${insErr.message}`)

    return { synced: rows.length, error: null }
  } catch (err) {
    return { synced: 0, error: err.message }
  }
}

module.exports = { runOwnersSync }
