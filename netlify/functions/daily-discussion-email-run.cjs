'use strict'

// Daily Discussion email draft creation — SCHEDULED TICK ONLY.
//
// Mirrors cmm-outbound-draft-create.cjs exactly (same run/test/shared
// split, same reason: Netlify blocks direct HTTP invocation of any
// function that carries a `schedule`). This file keeps the `schedule` and
// ONLY loops every configured facility on the cron tick. The manual
// "Create Draft Now (test)" button calls the sibling
// daily-discussion-email-test.cjs instead.
//
// See lib/daily-discussion-email-shared.cjs for the full design writeup
// (why this exists separately from front-daily-discussion-run.cjs, the
// facility-selectable + general-appointment-query differences from CMM
// Outbound).

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  DASHBOARD_TYPE,
  sbFetch,
  runDigest,
} = require('./lib/daily-discussion-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use daily-discussion-email-test for manual sends' }) }
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
    if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
    if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not set')

    const rows = await sbFetch(`prepick_notify_settings?dashboard_type=eq.${DASHBOARD_TYPE}&select=facility`)
    const results = []
    for (const row of rows || []) {
      results.push({ facility: row.facility, ...(await runDigest({ isManualTest: false, facility: row.facility })) })
    }
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, results }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
