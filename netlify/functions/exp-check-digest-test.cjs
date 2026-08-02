'use strict'

// EXP Check nightly digest — MANUAL TEST ONLY. Sibling to
// exp-check-digest-run.cjs (see that file's header, and
// lib/exp-check-digest-shared.cjs's header, for why this split exists).
//
// No `schedule` entry in netlify.toml, so Netlify allows the browser to
// POST here directly. Always sends immediately for today's date
// regardless of time/day/active, and does not touch last_sent_date — same
// "test doesn't interfere with the real scheduled send" behavior as every
// other digest's test button on this project.
//
// One row PER CUSTOMER (facility='all') — see
// lib/exp-check-digest-shared.cjs's header for why this changed from the
// original per-project design.

const {
  CUSTOMER_BY_DASHBOARD_TYPE,
  sbFetch,
  centralTodayDateObj,
  runForCustomer,
} = require('./lib/exp-check-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runTest(dashboardType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const customer = CUSTOMER_BY_DASHBOARD_TYPE.get(dashboardType)
  if (!customer) return { ok: false, reason: `Unknown dashboardType '${dashboardType}'` }
  const rows = await sbFetch(
    `prepick_notify_settings?facility=eq.all&dashboard_type=eq.${dashboardType}&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settingsRow = rows?.[0]
  const dateObj = centralTodayDateObj()
  return runForCustomer({ settingsRow, customer, dateObj, isManualTest: true })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let dashboardType
  try { ({ dashboardType } = JSON.parse(event.body || '{}')) } catch { /* noop */ }
  if (!dashboardType) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'dashboardType required, e.g. "exp_check_bernatellos"' }) }
  }
  try {
    const result = await runTest(dashboardType)
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
