'use strict'

// DPI Monthly Process reconciliation — SCHEDULED TICK ONLY.
//
// Same split pattern as dvr-digest-run.cjs / fefo-digest-run.cjs / etc:
// Netlify blocks direct HTTP invocation of a function that carries a
// `schedule`, so this file handles the cron tick only. Manual runs (for
// testing without waiting 45 minutes) go through dpi-reconciliation-test.cjs
// instead. See lib/dpi-reconciliation-shared.cjs for the actual
// comparison logic and the full design writeup.

const { runReconciliation } = require('./lib/dpi-reconciliation-shared.cjs')

exports.handler = async function (event) {
  const isScheduled = event.headers?.['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Scheduled invocation only — use dpi-reconciliation-test for manual runs' }),
    }
  }
  try {
    const result = await runReconciliation(false)
    console.log('[dpi-reconciliation]', JSON.stringify(result))
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }
  } catch (err) {
    console.error('[dpi-reconciliation] error:', err.message)
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
