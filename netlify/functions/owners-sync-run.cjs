'use strict'

/**
 * Netlify Function: owners-sync-run
 * Added 2026-10-12. Weekly scheduled sync of Datex's real owner master
 * (production_db.bronze.datex_owners) into Supabase's scheduling_owners
 * table — see lib/owners-sync-shared.cjs for the full story (Dan's real
 * "Palermos" vs. "Palermo Villa, Inc." test).
 *
 * Has a `schedule` entry in netlify.toml, so per this app's established
 * convention Netlify blocks direct HTTP invocation of this function at
 * the platform level — owners-sync-test.cjs (no schedule entry) exists
 * for manual runs.
 */

const { runOwnersSync } = require('./lib/owners-sync-shared.cjs')

exports.handler = async () => {
  const result = await runOwnersSync()
  if (result.error) {
    console.error('[owners-sync-run] FAILED:', result.error)
  } else {
    console.log(`[owners-sync-run] synced ${result.synced} owners`)
  }
  return { statusCode: 200, body: JSON.stringify(result) }
}
