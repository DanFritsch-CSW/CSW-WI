'use strict'

// Scheduled entrypoint ONLY — see lib/nightly-b2e-sync-shared.cjs header for
// why this was split out of the old combined nightly-b2e-sync.cjs on
// 2026-08-11. Keeps the `schedule` entry in netlify.toml (10:00 UTC / 5am
// CDT). Netlify does not allow direct HTTP invocation of any function that
// carries a schedule, so this file is scheduled-tick-only; manual testing
// goes through the sibling nightly-b2e-sync-test.cjs instead.

const { runNightlyB2eSync } = require('./lib/nightly-b2e-sync-shared.cjs')

exports.handler = async () => {
  const summary = await runNightlyB2eSync({ trigger: 'scheduled' })
  return {
    statusCode: summary.ok === false && summary.error === 'missing env vars' ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summary),
  }
}
