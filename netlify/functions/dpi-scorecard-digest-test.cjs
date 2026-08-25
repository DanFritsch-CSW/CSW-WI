'use strict'

// DPI Putaway Scorecard daily digest — MANUAL TEST ONLY. Duplicated from
// jdf-scorecard-digest-test.cjs 2026-08-25, sibling to
// dpi-scorecard-digest-run.cjs. No `schedule` entry, so the browser can
// POST to it directly for "Send test digest now".

const {
  FACILITY, DASHBOARD_TYPE,
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  sbFetch, runDigest,
} = require('./lib/dpi-scorecard-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

async function runTest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')

  const rows = await sbFetch(
    `prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settingsRow = rows?.[0]
  return runDigest({ settingsRow, isManualTest: true })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  try {
    const result = await runTest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
