'use strict'

// Dan's Footprint Variance digest — SCHEDULED TICK ONLY.
//
// Same split-function convention as every other digest in this app:
// Netlify blocks direct HTTP invocation of any function carrying a
// `schedule` in netlify.toml, so the manual "Create thread now" button
// calls the sibling dan-footprint-digest-test.cjs instead (no schedule).
//
// See lib/dan-footprint-digest-shared.cjs for the full design writeup —
// in short, this creates a BRAND-NEW Front discussion each time it fires
// (not a comment on an existing thread), addressed only to Dan.

const {
  sbFetch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch,
  createFootprintThread,
} = require('./lib/dan-footprint-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

async function runScheduledDigest() {
  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.dan&dashboard_type=eq.footprint_variance&select=notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  if (!settings) {
    return { ok: false, reason: 'No prepick_notify_settings row for facility=dan, dashboard_type=footprint_variance' }
  }
  if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }

  const date = centralTodayISO()
  const notifyHour = settings.notify_hour ?? 7
  const notifyMinute = settings.notify_minute ?? 0
  if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
    return { ok: true, skipped: true, reason: 'Not the configured trigger time yet' }
  }
  if (settings.last_sent_date === date) {
    return { ok: true, skipped: true, reason: 'Already created a thread for this date' }
  }
  const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
  const dateObj = centralTodayDateObj()
  const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()
  if (!notifyDays.includes(isoWeekday)) {
    return { ok: true, skipped: true, reason: `${date} is not a configured trigger day` }
  }

  return createFootprintThread({ isManualTest: false })
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use dan-footprint-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
