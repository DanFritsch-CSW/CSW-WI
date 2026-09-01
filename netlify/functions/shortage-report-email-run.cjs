'use strict'

// Customer Shortage Report email draft creation — SCHEDULED TICK ONLY.
//
// Mirrors cmm-outbound-draft-create.cjs (same run/test/shared split, same
// reason: Netlify blocks direct HTTP invocation of any function that
// carries a `schedule`). Loops every configured reportKey (today: just
// 'pretzilla_ken') on the cron tick. The manual "Create Draft Now (test)"
// button calls the sibling shortage-report-email-test.cjs instead.
//
// See lib/shortage-report-email-shared.cjs for the full design writeup —
// this feature was moved here from an earlier Daily Discussion Email
// version, and is keyed by reportKey rather than facility so it can grow
// to more customers within the Customer Shortage Report tab.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  DASHBOARD_TYPE,
  sbFetch,
  runDigest,
} = require('./lib/shortage-report-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use shortage-report-email-test for manual sends' }) }
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
    if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
    if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not set')

    // NOTE: rows are keyed by reportKey stored in the `facility` column —
    // see lib/shortage-report-email-shared.cjs header for why.
    const rows = await sbFetch(`prepick_notify_settings?dashboard_type=eq.${DASHBOARD_TYPE}&select=facility`)
    const results = []
    for (const row of rows || []) {
      results.push({ reportKey: row.facility, ...(await runDigest({ isManualTest: false, reportKey: row.facility })) })
    }
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, results }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
