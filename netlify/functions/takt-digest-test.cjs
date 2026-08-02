'use strict'

// Takt tab Notify digest — MANUAL TEST ONLY. Added 2026-08-02, sibling to
// takt-digest-run.cjs (see that file's header, and
// lib/takt-digest-shared.cjs's header, for why this split exists and why
// the content date is always "yesterday").
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Requires
// { facility } in the POST body — 'cal'|'ken'|'mad'|'wr'|'ec'|'all'.
// Always sends immediately for the content date regardless of
// time/active/weekday settings, and does not touch last_sent_date (same
// "not a dry run, but doesn't affect scheduling state" posture as every
// other *-digest-test.cjs here).

const {
  sbFetch,
  contentDateObj,
  postDigest,
} = require('./lib/takt-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL
const VALID_FACILITIES = ['cal', 'ken', 'mad', 'wr', 'ec', 'all']

async function runTest(facility) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')
  if (!VALID_FACILITIES.includes(facility)) throw new Error(`facility must be one of ${VALID_FACILITIES.join(', ')}`)

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${facility}&dashboard_type=eq.takt&select=front_conversation_id`
  )
  const conversationId = settingsRows?.[0]?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for Takt (${facility}) in prepick_notify_settings` }
  }

  return postDigest({ facility, conversationId, isManualTest: true })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let facility
  try {
    ;({ facility } = JSON.parse(event.body || '{}'))
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Body must be { facility }' }) }
  }
  try {
    const result = await runTest(facility)
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
