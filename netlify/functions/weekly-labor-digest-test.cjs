'use strict'

// Weekly Labor Overview digest — MANUAL TEST ONLY. Added 2026-08-03, the
// sibling to weekly-labor-digest-run.cjs (see that file's header, and
// lib/weekly-labor-digest-shared.cjs's header, for why this split
// exists and what the digest actually computes).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Always sends
// immediately for the CURRENT week (Monday of the week containing
// today, Central time) regardless of time/active/weekday settings, and
// does not touch last_sent_date.
//
// Requires { facility } in the POST body ('cal' or 'ken') — this
// function backs two settings rows sharing one Netlify function, same
// as fefo-digest-test.cjs backs one row per FEFO project.

const {
  sbFetch,
  centralTodayISO, mondayOfISO,
  postDigest,
} = require('./lib/weekly-labor-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runTest(facilityId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')
  if (facilityId !== 'cal' && facilityId !== 'ken') {
    return { ok: false, reason: `Unsupported facility for Weekly Labor digest: ${facilityId}` }
  }

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.${facilityId}&dashboard_type=eq.weekly_labor&select=front_conversation_id`
  )
  const conversationId = settingsRows?.[0]?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${facilityId} Weekly Labor in prepick_notify_settings` }
  }

  const mondayISO = mondayOfISO(centralTodayISO())
  return postDigest({ facilityId, conversationId, mondayISO })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let facility
  try {
    ;({ facility } = JSON.parse(event.body || '{}'))
  } catch {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }
  try {
    const result = await runTest(facility)
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
