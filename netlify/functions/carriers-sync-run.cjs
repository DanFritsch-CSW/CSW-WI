'use strict'

/**
 * Netlify Function: carriers-sync-run
 * Added 2026-08-19. Weekly scheduled sync of the complete Omni carrier
 * list into Supabase's scheduling_carriers table — see
 * lib/carriers-sync-shared.cjs for the full story and root-cause writeup.
 *
 * Has a `schedule` entry in netlify.toml, so per this app's established
 * convention Netlify blocks direct HTTP invocation of this function at
 * the platform level — carriers-sync-test.cjs (no schedule entry) exists
 * for manual runs.
 */

const { runCarriersSync } = require('./lib/carriers-sync-shared.cjs')

exports.handler = async () => {
  const result = await runCarriersSync()
  if (result.error) {
    console.error('[carriers-sync-run] FAILED:', result.error)
  } else {
    console.log(`[carriers-sync-run] synced ${result.synced} carriers`)
  }
  return { statusCode: 200, body: JSON.stringify(result) }
}
