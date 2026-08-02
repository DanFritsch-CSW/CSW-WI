'use strict'

// EXP Check nightly digest — SCHEDULED TICK ONLY.
//
// Split the same way every other digest on this project is split (see
// lib/exp-check-digest-shared.cjs and lib/fefo-digest-shared.cjs for the
// full story): Netlify blocks direct HTTP invocation of any function that
// carries a `schedule` in netlify.toml, so this file keeps the `schedule`
// and only handles the cron tick. "Send test digest now" calls the
// sibling function exp-check-digest-test.cjs instead, which has no
// schedule and can be invoked directly.
//
// One row PER CUSTOMER (facility='all'), not per Datex project — see
// lib/exp-check-digest-shared.cjs's header for why this changed from the
// original per-project design.

const {
  CUSTOMER_BY_DASHBOARD_TYPE,
  sbFetch,
  centralTodayDateObj, isNotifyTimeMatch, isoWeekday, isoDate,
  runForCustomer,
} = require('./lib/exp-check-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runScheduledDigest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  // Loop every exp_check_* row (facility='all' for every row) — content
  // date is TODAY for all of them (live status check, no forecast lead-
  // time), so there's no per-row date resolution needed like FEFO's
  // next-business-day logic.
  const rows = await sbFetch(
    `prepick_notify_settings?dashboard_type=like.exp_check_*&select=facility,dashboard_type,front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const dateObj = centralTodayDateObj()
  const date = isoDate(dateObj)
  const results = []
  for (const row of (rows || [])) {
    const customer = CUSTOMER_BY_DASHBOARD_TYPE.get(row.dashboard_type)
    if (!customer) continue
    if (row.active === false) { results.push({ ok: true, skipped: true, customer: customer.label, reason: 'Digest disabled' }); continue }
    const notifyDays = (row.notify_days && row.notify_days.length) ? row.notify_days : [1, 2, 3, 4, 5]
    if (!notifyDays.includes(isoWeekday(dateObj))) {
      results.push({ ok: true, skipped: true, customer: customer.label, reason: 'Not a configured send day' })
      continue
    }
    const notifyHour = row.notify_hour ?? 8
    const notifyMinute = row.notify_minute ?? 0
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ ok: true, skipped: true, customer: customer.label, reason: 'Not the configured send time yet' })
      continue
    }
    if (row.last_sent_date === date) {
      results.push({ ok: true, skipped: true, customer: customer.label, reason: 'Already sent for this date' })
      continue
    }
    try {
      const r = await runForCustomer({ settingsRow: row, customer, dateObj, isManualTest: false })
      results.push(r)
    } catch (e) {
      results.push({ ok: false, customer: customer.label, reason: e.message })
    }
  }
  return { ok: true, results }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use exp-check-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
