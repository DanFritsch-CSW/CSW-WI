'use strict'

/**
 * Netlify Function: project-dockdoor-sync-run
 * Added 2026-10-13. Weekly scheduled rebuild of scheduling_project_dockdoor_map
 * from this app's own `submissions` table -- see
 * lib/project-dockdoor-sync-shared.cjs for the full design writeup.
 *
 * Has a `schedule` entry in netlify.toml, so per this app's established
 * convention Netlify blocks direct HTTP invocation of this function at
 * the platform level -- project-dockdoor-sync-test.cjs (no schedule
 * entry) exists for manual runs.
 */

const { runProjectDockDoorSync } = require('./lib/project-dockdoor-sync-shared.cjs')

exports.handler = async () => {
  const result = await runProjectDockDoorSync()
  if (result.error) {
    console.error('[project-dockdoor-sync-run] FAILED:', result.error)
  } else {
    console.log(`[project-dockdoor-sync-run] rebuilt ${result.synced} rows`)
  }
  return { statusCode: 200, body: JSON.stringify(result) }
}
