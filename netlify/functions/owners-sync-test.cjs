'use strict'

/**
 * Netlify Function: owners-sync-test
 * Added 2026-10-12 — manual-trigger twin of owners-sync-run.cjs. No
 * `schedule` entry, so it can be POSTed to directly instead of waiting
 * for the weekly cron. NOT a dry run — it really replaces the contents of
 * scheduling_owners in Supabase with a fresh pull from MotherDuck.
 */

const { runOwnersSync } = require('./lib/owners-sync-shared.cjs')

exports.handler = async () => {
  const result = await runOwnersSync()
  return {
    statusCode: result.error ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  }
}
