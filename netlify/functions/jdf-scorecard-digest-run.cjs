'use strict'

// JDF Putaway Scorecard daily digest — SCHEDULED TICK ONLY. Added
// 2026-08-11, same split-function pattern as every other digest in this
// app (Netlify blocks direct HTTP invocation of any function carrying a
// `schedule` in netlify.toml — see lib/fefo-digest-shared.cjs's header for
// the full story/repro). This file keeps the `schedule` and only handles
// the cron tick; "Send test digest now" calls the sibling function
// jdf-scorecard-digest-test.cjs instead, which has no schedule and can be
// invoked directly.

const {
  FACILITY, DASHBOARD_TYPE,
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  sbFetch, centralTodayDateStr, isNotifyTimeMatch, runDigest,
} = require('./lib/jdf-scorecard-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

async function runScheduledDigest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')

  const rows = await sbFetch(
    `prepick_notify_settings?facility=eq.${FACILITY}&dashboard_type=eq.${DASHBOARD_TYPE}&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const row = rows?.[0]
  if (!row) return { ok: true, skipped: true, reason: 'No settings row configured yet' }
  if (row.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }

  const notifyHour = row.notify_hour ?? 22
  const notifyMinute = row.notify_minute ?? 15
  if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
    return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
  }

  // Content date now equals the send date (2026-08-12 change -- see
  // lib/jdf-scorecard-digest-shared.cjs's header for the full before/after),
  // so this is just "is today a checked day," same as every other digest in
  // this app -- no more separate content-date-vs-send-day distinction.
  const today = centralTodayDateStr()
  const notifyDays = row.notify_days ?? [1, 2, 3, 4, 5]
  const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  const isoWeekday = todayWeekday === 0 ? 7 : todayWeekday
  if (!notifyDays.includes(isoWeekday)) {
    return { ok: true, skipped: true, reason: `Today (${today}) is not a checked day` }
  }

  if (row.last_sent_date === today) {
    return { ok: true, skipped: true, reason: 'Already sent for this date' }
  }

  return runDigest({ settingsRow: row, isManualTest: false })
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use jdf-scorecard-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
