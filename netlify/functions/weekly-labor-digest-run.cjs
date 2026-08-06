'use strict'

// Weekly Labor Overview digest — SCHEDULED TICK ONLY. Added 2026-08-03.
//
// Backs up to TWO settings rows in prepick_notify_settings, both
// dashboard_type='weekly_labor': facility='cal' and facility='ken' (per
// Dan's scope call — matches Kay's original Cal/Ken Front thread this
// automates, not all 5 facilities). Same split-function pattern as every
// other digest here: this file keeps the `schedule` and only handles the
// cron tick; "Send test digest now" calls the sibling
// weekly-labor-digest-test.cjs instead (Netlify blocks direct HTTP
// invocation of anything carrying a `schedule`).
//
// Content window = a ROLLING 7 DAYS starting TODAY (Central time), not
// Mon-Sun of the calendar week containing today — changed 2026-08-06 per
// Kay Martin's Front request ("could we get that auto populating fxn to
// provide the next 7 days rather than the current week?"). Fires on
// whichever notify_days/notify_hour/notify_minute are configured in the
// shared NotifySettingsPanel (same UI as MAD/WR/EC) — with notify_days
// set to multiple weekdays, each day's send shows a fresh 7-day window
// starting that day, which is the whole point of "rolling."
//
// See lib/weekly-labor-digest-shared.cjs for the actual calc (a
// self-contained cjs port of src/lib/weeklyLabor.js) and message-building
// logic.

const {
  sbFetch, sbPatch,
  centralTodayISO, isNotifyTimeMatch, isoWeekdayOf,
  claimSendSlot, postDigest,
} = require('./lib/weekly-labor-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runScheduledDigests() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const settingsRows = await sbFetch(
    `prepick_notify_settings?dashboard_type=eq.weekly_labor&select=facility,front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )

  const today = centralTodayISO()
  const isoWeekday = isoWeekdayOf(today)

  const results = []
  for (const settings of (settingsRows || [])) {
    const facilityId = settings.facility
    const conversationId = settings.front_conversation_id
    if (!conversationId) {
      results.push({ facility: facilityId, ok: false, skipped: true, reason: 'No front_conversation_id configured' })
      continue
    }
    if (settings.active === false) {
      results.push({ facility: facilityId, ok: true, skipped: true, reason: 'Digest disabled' })
      continue
    }
    // Cheap early-exit only — NOT the correctness guard (that's
    // claimSendSlot below, backed by a unique-constraint table). This
    // field is now purely informational; kept in sync on successful
    // sends below so a glance at prepick_notify_settings still shows a
    // sensible "last sent" date, but nothing here depends on it being
    // accurate to avoid duplicates.
    if (settings.last_sent_date === today) {
      results.push({ facility: facilityId, ok: true, skipped: true, reason: 'Already sent today' })
      continue
    }
    const notifyDays = settings.notify_days ?? [1]
    if (!notifyDays.includes(isoWeekday)) {
      results.push({ facility: facilityId, ok: true, skipped: true, reason: `${today} is not a configured notify day` })
      continue
    }
    const notifyHour = settings.notify_hour ?? 7
    const notifyMinute = settings.notify_minute ?? 30
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ facility: facilityId, ok: true, skipped: true, reason: 'Not the configured send time yet' })
      continue
    }

    // Unconditional claim BEFORE computing/sending — a unique-constraint
    // INSERT into weekly_labor_digest_sends, see claimSendSlot's header
    // comment in weekly-labor-digest-shared.cjs for the round-2 story
    // (the first fix, a conditional PATCH, still let 2-3 duplicates
    // through on 2026-08-05 for reasons that couldn't be confirmed
    // without Netlify invocation logs).
    try {
      const claimed = await claimSendSlot(facilityId, today)
      if (!claimed) {
        results.push({ facility: facilityId, ok: true, skipped: true, reason: 'Lost race — another invocation already claimed this send' })
        continue
      }
    } catch (err) {
      results.push({ facility: facilityId, ok: false, reason: `claimSendSlot failed: ${err.message}` })
      continue
    }

    try {
      const result = await postDigest({ facilityId, conversationId, startDate: today })
      results.push({ facility: facilityId, ...result })
      if (result.ok) {
        // Best-effort, informational only — see the comment above the
        // "Already sent today" check. Not awaited-for-correctness;
        // failure here doesn't affect the duplicate-send guarantee.
        sbPatch(`prepick_notify_settings?facility=eq.${facilityId}&dashboard_type=eq.weekly_labor`, { last_sent_date: today })
          .catch(err => console.warn(`last_sent_date bookkeeping update failed for ${facilityId} (non-fatal):`, err.message))
      }
    } catch (err) {
      results.push({ facility: facilityId, ok: false, reason: err.message })
    }
  }

  return results
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use weekly-labor-digest-test for manual sends' }) }
  }
  try {
    const results = await runScheduledDigests()
    const anyFailed = results.some(r => r.ok === false && !r.skipped)
    return { statusCode: anyFailed ? 500 : 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: !anyFailed, results }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
