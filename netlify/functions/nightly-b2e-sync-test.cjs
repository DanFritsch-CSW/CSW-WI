'use strict'

// Manual-test entrypoint — added 2026-08-11, same 403-avoidance split as
// every other *-digest-test.cjs in this app (no `schedule` entry, so
// Netlify allows a direct browser POST). NOT a dry run: runs the exact
// same purge/seed/refresh logic as the real 5am cron, against real data,
// for all 5 facilities. This exists specifically so "is the cron actually
// working" can be checked THE SAME DAY instead of waiting for tomorrow's
// scheduled run. Every call also writes to cron_health (facility rows +
// one summary row), same as the scheduled path.

const { runNightlyB2eSync } = require('./lib/nightly-b2e-sync-shared.cjs')

exports.handler = async () => {
  const summary = await runNightlyB2eSync({ trigger: 'manual' })
  return {
    statusCode: summary.ok === false && summary.error === 'missing env vars' ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summary),
  }
}
