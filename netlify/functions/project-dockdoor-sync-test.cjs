'use strict'

/**
 * Netlify Function: project-dockdoor-sync-test
 * Added 2026-10-13 -- manual-trigger twin of project-dockdoor-sync-run.cjs.
 * No `schedule` entry, so it can be POSTed to directly instead of waiting
 * for the weekly cron. NOT a dry run -- it really replaces the contents of
 * scheduling_project_dockdoor_map with a fresh rebuild from `submissions`.
 */

const { runProjectDockDoorSync } = require('./lib/project-dockdoor-sync-shared.cjs')

exports.handler = async () => {
  const result = await runProjectDockDoorSync()
  return {
    statusCode: result.error ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  }
}
