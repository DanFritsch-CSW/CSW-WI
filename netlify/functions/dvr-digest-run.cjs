'use strict'

// LoadProof / DVRS open-incidents daily digest — SCHEDULED TICK ONLY.
//
// Split 2026-07-31, same fix pattern as fefo-digest-run.cjs /
// prepick-digest-run.cjs: Netlify blocks direct HTTP invocation of a
// function that carries a `schedule`, which is why "Send test digest
// now" 403ed here. This file keeps the `schedule` and ONLY handles the
// cron tick; "Send test digest now" now calls the sibling
// dvr-digest-test.cjs instead. Both require lib/dvr-digest-shared.cjs so
// the actual digest logic (data fetch, message building, Front posting)
// lives in exactly one place.
//
// See lib/dvr-digest-shared.cjs for the fuller original feature history
// (the earlier x-netlify-event scheduled-detection fix, the daily lock
// via last_sent_date, the skip-to-next-valid-day lookahead, etc) — none
// of that changed, only where the manual-test entry point lives.

const { runDigest, APP_URL } = require('./lib/dvr-digest-shared.cjs')

exports.handler = async function(event) {
  const isScheduled = event.headers?.['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Scheduled invocation only — use dvr-digest-test for manual sends' }) }
  }
  const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Content-Type':'application/json' }
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || APP_URL
  try {
    const result = await runDigest(false, baseUrl)
    console.log('[dvr-digest]', JSON.stringify(result))
    return { statusCode: 200, headers: cors, body: JSON.stringify(result) }
  } catch(err) {
    console.error('[dvr-digest] error:', err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
