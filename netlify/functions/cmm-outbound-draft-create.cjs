'use strict'

// CMM Outbound Appts draft creation — SCHEDULED TICK ONLY.
//
// Split 2026-07-31, same fix pattern as fefo-digest-run.cjs /
// prepick-digest-run.cjs: Netlify blocks direct HTTP invocation of a
// function that carries a `schedule`, which is why "Create Draft Now
// (test)" 403ed here. This file keeps the `schedule` and ONLY loops every
// configured facility (today: just 'cal') on the cron tick; "Create Draft
// Now (test)" now calls the sibling cmm-outbound-draft-create-test.cjs
// instead. Both require lib/cmm-outbound-draft-shared.cjs so the actual
// draft-creation logic lives in exactly one place.
//
// See lib/cmm-outbound-draft-shared.cjs for the fuller original feature
// history (TO/CC email recipients vs internal-discussion followers, the
// CMM/Palermo's MotherDuck filter, the From-channel picker, etc) — none
// of that changed, only where the manual-test entry point lives.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  sbFetch,
  runDigest,
} = require('./lib/cmm-outbound-draft-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use cmm-outbound-draft-create-test for manual sends' }) }
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
    if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
    if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not set')

    const rows = await sbFetch(`prepick_notify_settings?dashboard_type=eq.cmm_outbound_appts&select=facility`)
    const results = []
    for (const row of rows || []) {
      results.push({ facility: row.facility, ...(await runDigest({ isManualTest: false, facility: row.facility })) })
    }
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, results }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
