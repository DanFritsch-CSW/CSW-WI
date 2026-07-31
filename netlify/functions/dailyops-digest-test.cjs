'use strict'

// Daily Ops snapshot digest — MANUAL TEST ONLY. Added 2026-07-31 as the
// sibling to dailyops-digest-run.cjs (see that file's header, and
// lib/dailyops-digest-shared.cjs's header, for why this split exists).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Requires a single
// {facility: 'mad'|'wr'|'ec'} in the POST body — the NotifySettingsPanel
// on each facility's Daily Ops tab already passes
// manualTestBody={{facility: facility.id}}, so no frontend change was
// needed beyond pointing functionName at this file. Always sends
// immediately for tomorrow's date regardless of time/active/weekday
// settings, and does not touch last_sent_date.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FACILITY_CONFIGS,
  runDigestForFacility,
} = require('./lib/dailyops-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

async function runTest(facility) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  if (!facility || !FACILITY_CONFIGS[facility]) {
    return { ok: false, reason: `Manual test requires a valid "facility" in the POST body (one of: ${Object.keys(FACILITY_CONFIGS).join(', ')})` }
  }
  return runDigestForFacility(facility, { isManualTest: true })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let facility = null
  try {
    const body = event.body ? JSON.parse(event.body) : {}
    facility = body.facility || null
  } catch { /* leave null — runTest reports the missing-facility error */ }

  try {
    const result = await runTest(facility)
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
