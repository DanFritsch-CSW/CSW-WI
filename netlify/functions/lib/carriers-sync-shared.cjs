'use strict'

/**
 * lib/carriers-sync-shared.cjs — added 2026-08-19 per Kay's long-standing
 * "carriers disappearing" feedback (cnv_1ayy4w9g, first raised June 2026).
 *
 * REWRITTEN 2026-10-10 (Dan's direct call) — this originally pulled from
 * Omni (topic gold__truck_appointments, via the omni-query.cjs proxy), and
 * had been failing on every single run since it was added, silently,
 * with zero rows ever written to scheduling_carriers. Root cause,
 * confirmed from live Netlify function logs:
 *
 *   Illegal json parameter found: Could not resolve subtype of
 *   [...Filter]: missing type id property 'type' (for POJO property
 *   'filters')
 *
 * The old fetchRecentCounts() query sent a filter shape
 * ({ after: cutoffStr }) missing a required 'type' discriminator Omni's
 * filter schema needs, and because it ran inside the same Promise.all as
 * the main carrier-list fetch, that one malformed filter killed the
 * ENTIRE sync on every attempt -- including the carrier list itself,
 * which would otherwise have worked fine.
 *
 * Beyond the bug, going through Omni's gold__truck_appointments topic at
 * all was the wrong source for a carrier MASTER list: it only surfaces
 * carriers that have actually appeared in a truck appointment record,
 * not the complete Datex carrier roster. production_db.silver.
 * datex_slv_carriers is the real master table (19,129 rows, confirmed
 * live) and is queried here directly via MotherDuck -- same duckdb
 * connection pattern already used successfully by
 * scheduling-order-search.cjs (HOME=/tmp, md:production_db, LOAD
 * motherduck) -- with zero dependency on Omni or its filter schema.
 *
 * FIXED 2026-10-10 (second pass) -- the first MotherDuck-based version
 * still failed on insert: "duplicate key value violates unique
 * constraint scheduling_carriers_pkey". Confirmed live: scheduling_carriers'
 * primary key is carrier_name (not carrier_id), and Datex's real carrier
 * master has 19,129 rows but only 18,547 DISTINCT raw names -- 582 names
 * have more than one carrier_id in Datex (duplicate/re-added entries).
 * Deduped in SQL, keeping the most recently active carrier_id per name
 * (highest 6-month appointment_count, carrier_id as a deterministic
 * tiebreaker) -- the correct choice for a name->id lookup table where two
 * rows sharing an identical name are indistinguishable to any matcher.
 *
 * FIXED 2026-10-10 (third pass, same day) -- STILL failed with the exact
 * same pkey error after the dedup above. Real bug: the SQL dedup
 * partitioned by the RAW carrier_name, but the JS mapping step below
 * applies .trim() to each name AFTER that dedup already ran. Confirmed
 * live: of the 18,547 raw-distinct names, only 18,502 are distinct once
 * trimmed -- 45 pairs differ only by leading/trailing whitespace, passed
 * the raw-name dedup as two separate "distinct" rows, then collided the
 * moment both got trimmed to the identical string on the way into
 * Supabase. Fixed by trimming carrier_name INSIDE the SQL, before the
 * ROW_NUMBER partition, so the dedup key is identical to the value that
 * actually gets inserted -- not fixable by deduping harder downstream,
 * since the mismatch was between two different "which string counts as
 * the name" definitions in two different places.
 *
 * appointment_count is still populated, as a sort-hint only (never a
 * cutoff -- a carrier with 0 recent appointments still gets synced), via
 * a single join to production_db.gold.truck_appointments' last 6 months,
 * done in the same SQL query rather than as a second separate fetch.
 *
 * Writes the full result into Supabase's scheduling_carriers table,
 * replacing its contents (delete then insert) -- same as before.
 */

async function queryCarriersFromMotherDuck() {
  const TOKEN = process.env.MOTHERDUCK_TOKEN
  if (!TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')

  const sql = `
    WITH recent_counts AS (
      SELECT carrier_id, COUNT(*) AS cnt
      FROM production_db.gold.truck_appointments
      WHERE scheduled_arrival >= (CURRENT_DATE - INTERVAL 6 MONTH)
      GROUP BY carrier_id
    ),
    carriers_with_counts AS (
      -- carrier_name is TRIMMED here, at the source -- everything
      -- downstream (dedup partition key, final SELECT, and the JS layer)
      -- now agrees on exactly what string counts as "the name". See the
      -- 2026-10-10 third-pass header note for why this matters: a dedup
      -- on the untrimmed value doesn't protect against two names that
      -- only collide after trimming.
      SELECT
        c.carrier_id,
        trim(c.carrier_name) AS carrier_name,
        COALESCE(rc.cnt, 0) AS appointment_count
      FROM production_db.silver.datex_slv_carriers c
      LEFT JOIN recent_counts rc ON rc.carrier_id = c.carrier_id
      WHERE c.carrier_name IS NOT NULL
        AND trim(c.carrier_name) != ''
        AND (c.parquet_record_operation_type IS NULL OR c.parquet_record_operation_type != 'D')
    ),
    deduped AS (
      -- scheduling_carriers' primary key is carrier_name. Keep the most
      -- recently active carrier_id per (now-trimmed) name.
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY carrier_name
        ORDER BY appointment_count DESC, carrier_id ASC
      ) AS rn
      FROM carriers_with_counts
    )
    SELECT carrier_id, carrier_name, appointment_count
    FROM deduped
    WHERE rn = 1
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
      .filter((r) => r.carrier_id != null && r.carrier_name)
      .map((r) => ({
        carrier_id: Number(r.carrier_id),
        // Already trimmed in SQL -- .trim() here is just a harmless
        // no-op safety net, not load-bearing anymore.
        carrier_name: String(r.carrier_name).trim(),
        appointment_count: Number(r.appointment_count) || 0,
      }))
  } finally {
    conn.close()
    db.close()
  }
}

// Runs the full sync: fetch from MotherDuck, replace scheduling_carriers in
// Supabase. Returns { synced, error } -- never throws, so the caller
// (scheduled or manual-test function) can always respond cleanly.
async function runCarriersSync() {
  const SUPA_URL = process.env.VITE_SUPABASE_URL
  const SUPA_KEY = process.env.VITE_SUPABASE_ANON_KEY
  if (!SUPA_URL || !SUPA_KEY) {
    return { synced: 0, error: 'Supabase env vars not configured' }
  }

  const { createClient } = require('@supabase/supabase-js')
  const supabase = createClient(SUPA_URL, SUPA_KEY)

  try {
    const carriers = await queryCarriersFromMotherDuck()

    if (carriers.length === 0) {
      return { synced: 0, error: 'MotherDuck returned zero carriers -- refusing to wipe the table on what looks like an outage' }
    }

    const rows = carriers.map((c) => ({
      carrier_name: c.carrier_name,
      carrier_id: c.carrier_id,
      appointment_count: c.appointment_count,
      synced_at: new Date().toISOString(),
    }))

    // Full replace: delete then insert. Safe for a weekly batch job with
    // no concurrent writers -- scheduling-omni-lookup.cjs only ever reads
    // this table, never writes it.
    const { error: delErr } = await supabase.from('scheduling_carriers').delete().neq('carrier_name', '__never_matches__')
    if (delErr) throw new Error(`delete failed: ${delErr.message}`)

    const { error: insErr } = await supabase.from('scheduling_carriers').insert(rows)
    if (insErr) throw new Error(`insert failed: ${insErr.message}`)

    return { synced: rows.length, error: null }
  } catch (err) {
    return { synced: 0, error: err.message }
  }
}

module.exports = { runCarriersSync }
