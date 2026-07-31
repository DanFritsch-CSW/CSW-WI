'use strict'

// Madison Pre-Pick Status digest — MANUAL TEST ONLY. Added 2026-07-31 as
// the sibling to prepick-digest-run.cjs (see that file's header, and
// lib/prepick-digest-shared.cjs's header, for why this split exists:
// Netlify blocks direct HTTP invocation of any function carrying a
// `schedule` in netlify.toml, which is what made "Send test digest now"
// 403 here — same root cause already fixed for the FEFO digests on
// 2026-07-30, now applied across the rest of the app's digests).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Always sends
// immediately for tomorrow's date regardless of time/active/weekday
// settings, and does not touch last_sent_date — same "test doesn't
// interfere with the real scheduled send" behavior as before the split.

const {
  sbFetch,
  tomorrowCentral,
  postDigest,
} = require('./lib/prepick-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runTest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.mad&dashboard_type=eq.prepick&select=front_conversation_id`
  )
  const conversationId = settingsRows?.[0]?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for Madison in prepick_notify_settings' }
  }

  const dateObj = tomorrowCentral()
  return postDigest({ conversationId, dateObj, isManualTest: true })
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
