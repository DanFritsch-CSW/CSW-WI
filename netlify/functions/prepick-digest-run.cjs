'use strict'

// Nightly Madison Pre-Pick Status digest — SCHEDULED TICK ONLY.
//
// Split 2026-07-31 from a single combined scheduled+manual-test function,
// same fix pattern as fefo-digest-run.cjs (2026-07-30): Netlify does not
// allow direct HTTP invocation of a function that carries a `schedule` in
// netlify.toml, which is why "Send test digest now" 403ed here too. This
// file keeps the `schedule` and ONLY handles the cron tick;
// "Send test digest now" now calls the sibling function
// prepick-digest-test.cjs instead, which has no schedule and can be
// invoked directly. Both require lib/prepick-digest-shared.cjs so the
// actual digest logic (message building, Front posting) lives in exactly
// one place.
//
// See lib/prepick-digest-shared.cjs for the fuller original feature
// history (configurable send time, weekday filter, skip-to-next-valid-day
// lookahead, pallet estimates, the time-display timezone fix, etc) — none
// of that changed, only where the manual-test entry point lives.

const {
  sbFetch,
  isNotifyTimeMatch, tomorrowCentral, isoWeekday, isoDate,
  postDigest,
} = require('./lib/prepick-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runScheduledDigest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.mad&dashboard_type=eq.prepick&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date,skip_to_next_valid_day`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for Madison in prepick_notify_settings' }
  }

  if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }

  let dateObj = tomorrowCentral()
  const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
  const skipToNextValidDay = settings.skip_to_next_valid_day === true

  if (!notifyDays.includes(isoWeekday(dateObj))) {
    if (!skipToNextValidDay) {
      return { ok: true, skipped: true, reason: `${isoDate(dateObj)} is not a configured notify day` }
    }
    let advanced = 0
    while (!notifyDays.includes(isoWeekday(dateObj)) && advanced < 7) {
      dateObj = new Date(dateObj.getTime() + 24 * 60 * 60 * 1000)
      advanced++
    }
    if (!notifyDays.includes(isoWeekday(dateObj))) {
      return { ok: true, skipped: true, reason: 'No configured notify day found within 7 days' }
    }
  }
  const date = isoDate(dateObj)

  const notifyHour = settings.notify_hour ?? 22
  const notifyMinute = settings.notify_minute ?? 15
  if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
    return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
  }
  if (settings.last_sent_date === date) {
    return { ok: true, skipped: true, reason: 'Already sent for this date' }
  }

  return postDigest({ conversationId, dateObj, isManualTest: false })
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use prepick-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
