'use strict'

// JDF Putaway Scorecard daily digest — MANUAL TEST ONLY. Added 2026-08-11,
// sibling to jdf-scorecard-digest-run.cjs (see that file's header, and
// lib/jdf-scorecard-digest-shared.cjs's header, for why this split
// exists). This file deliberately has NO `schedule` entry in netlify.toml,
// so Netlify allows the browser to POST to it directly. Always sends
// immediately for yesterday's content date regardless of time/day/active,
// and does not touch last_sent_date — same "test doesn't interfere with
// the real scheduled send" behavior as every other *-digest-test.cjs.

const {
  FACILITY, DASHBOARD_TYPE,
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  sbFetch, runDigest,
} = require('./lib/jdf-scorecard-digest-shared.cjs')

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
