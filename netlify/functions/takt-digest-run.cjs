'use strict'

// Takt tab Notify digest — SCHEDULED TICK ONLY. Added 2026-08-02.
//
// Backs SIX settings rows in prepick_notify_settings, all
// dashboard_type='takt': one per facility (cal/ken/mad/wr/ec) plus
// facility='all' for the senior-leadership rollup across every facility.
// Same split-function pattern as every other digest here (schedule lives
// on this file only; manual test lives in the sibling takt-digest-test.cjs
// since Netlify blocks direct HTTP invocation of anything with a
// `schedule`). See lib/takt-digest-shared.cjs for the message-building
// logic and — importantly — the "content date is always yesterday
// relative to the send" rule.

const {
  sbFetch,
  contentDateISO, contentDateObj, isNotifyTimeMatch,
  postDigest,
} = require('./lib/takt-digest-shared.cjs')

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
    `prepick_notify_settings?dashboard_type=eq.takt&select=facility,front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )

  const date = contentDateISO()
  const dateObj = contentDateObj()
  const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()

  const results = []
  for (const settings of (settingsRows || [])) {
    const facility = settings.facility
    const conversationId = settings.front_conversation_id
    if (!conversationId) {
      results.push({ facility, ok: false, skipped: true, reason: 'No front_conversation_id configured' })
      continue
    }
    if (settings.active === false) {
      results.push({ facility, ok: true, skipped: true, reason: 'Digest disabled' })
      continue
    }
    if (settings.last_sent_date === date) {
      results.push({ facility, ok: true, skipped: true, reason: 'Already sent for this date' })
      continue
    }
    const notifyHour = settings.notify_hour ?? 6
    const notifyMinute = settings.notify_minute ?? 0
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ facility, ok: true, skipped: true, reason: 'Not the configured send time yet' })
      continue
    }
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
    if (!notifyDays.includes(isoWeekday)) {
      results.push({ facility, ok: true, skipped: true, reason: `${date} is not a configured notify day` })
      continue
    }

    try {
      const result = await postDigest({ facility, conversationId, isManualTest: false })
      results.push({ facility, ...result })
    } catch (err) {
      results.push({ facility, ok: false, reason: err.message })
    }
  }

  return results
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use takt-digest-test for manual sends' }) }
  }
  try {
    const results = await runScheduledDigests()
    const anyFailed = results.some(r => r.ok === false && !r.skipped)
    return { statusCode: anyFailed ? 500 : 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: !anyFailed, results }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
