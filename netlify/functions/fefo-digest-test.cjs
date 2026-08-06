'use strict'

// FEFO nightly digest — MANUAL TEST ONLY. Added 2026-07-30 as the sibling
// to fefo-digest-run.cjs (see that file's header, and
// lib/fefo-digest-shared.cjs's header, for why this split exists: Netlify
// blocks direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml, which is what made "Send test digest now" 403 for every
// FEFO project, not just the newly-added Palermo's ones it was first
// noticed on).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. It only ever runs
// the manual-test path for a single dashboardType — no scheduled loop
// lives here at all (that stays in fefo-digest-run.cjs). Always sends
// immediately for the resolved content date regardless of time/active,
// and does not touch last_sent_date — same "test doesn't interfere with
// the real scheduled send" behavior as before the split.
//
// Content date for open-order (non-closedOrders) projects changed
// 2026-08-06 from a resolved "next business day" to a live "everything
// currently Processing" snapshot (see lib/fefo-digest-shared.cjs's header)
// — this file just needed to swap which date-resolution helper it calls.

const {
  PROJECT_BY_DASHBOARD_TYPE,
  sbFetch,
  centralTodayDateObj, sameCalendarDayDateObj,
  runForProject,
} = require('./lib/fefo-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runTest(dashboardType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const project = PROJECT_BY_DASHBOARD_TYPE.get(dashboardType)
  if (!project) return { ok: false, reason: `Unknown dashboardType '${dashboardType}'` }
  const rows = await sbFetch(
    `prepick_notify_settings?facility=eq.${project.facility}&dashboard_type=eq.${dashboardType}&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settingsRow = rows?.[0]
  const dateObj = project.closedOrders ? sameCalendarDayDateObj() : centralTodayDateObj()
  return runForProject({ settingsRow, project, dateObj, isManualTest: true })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let dashboardType
  try { ({ dashboardType } = JSON.parse(event.body || '{}')) } catch { /* noop */ }
  if (!dashboardType) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'dashboardType required, e.g. "fefo_faioa5"' }) }
  }
  try {
    const result = await runTest(dashboardType)
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
