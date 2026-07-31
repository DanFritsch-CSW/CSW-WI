'use strict'

// Daily Ops snapshot digest (3 images + Madison Dock Counts) — SCHEDULED
// TICK ONLY.
//
// Split 2026-07-31, same fix pattern as fefo-digest-run.cjs /
// prepick-digest-run.cjs / wr-cases-digest-run.cjs: Netlify blocks direct
// HTTP invocation of a function that carries a `schedule`, which is why
// "Send test digest now" 403ed here. This file keeps the `schedule` and
// ONLY loops every configured facility (mad/wr/ec) on the cron tick;
// "Send test digest now" now calls the sibling dailyops-digest-test.cjs
// (single facility, required in the POST body, no schedule). Both require
// lib/dailyops-digest-shared.cjs so the actual rendering/posting logic
// lives in exactly one place.
//
// See lib/dailyops-digest-shared.cjs for the fuller original feature
// history (3 rendered PNGs, WR/EC extension, the double-send race fix via
// atomic last_sent_date claim, Dock Counts fold-in, etc) — none of that
// changed, only where the manual-test entry point lives.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FACILITY_CONFIGS,
  runDigestForFacility,
} = require('./lib/dailyops-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

async function runScheduledDigest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const results = []
  for (const facilityId of Object.keys(FACILITY_CONFIGS)) {
    try {
      results.push({ facility: facilityId, ...(await runDigestForFacility(facilityId, { isManualTest: false })) })
    } catch (err) {
      results.push({ facility: facilityId, ok: false, reason: err.message })
    }
  }
  return { ok: true, results }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use dailyops-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
