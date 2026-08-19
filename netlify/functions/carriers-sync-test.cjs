'use strict'

/**
 * Netlify Function: carriers-sync-test
 * Added 2026-08-19 — manual-trigger twin of carriers-sync-run.cjs. No
 * `schedule` entry, so it can be POSTed to directly instead of waiting
 * for the weekly cron. NOT a dry run — it really replaces the contents of
 * scheduling_carriers in Supabase with a fresh pull from Omni.
 */

const { runCarriersSync } = require('./lib/carriers-sync-shared.cjs')

exports.handler = async () => {
  const result = await runCarriersSync()
  return {
    statusCode: result.error ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  }
}
