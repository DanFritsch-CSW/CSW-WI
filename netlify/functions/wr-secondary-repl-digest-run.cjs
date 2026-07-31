'use strict'

// WR Secondary Replenishments digest — SCHEDULED TICK ONLY.
//
// Split 2026-07-31, same fix pattern as fefo-digest-run.cjs /
// prepick-digest-run.cjs: Netlify blocks direct HTTP invocation of a
// function that carries a `schedule`, which is why "Send test digest
// now" 403ed here. This file keeps the `schedule` and ONLY handles the
// cron tick; "Send test digest now" now calls the sibling
// wr-secondary-repl-digest-test.cjs instead. Both require
// lib/wr-secondary-repl-digest-shared.cjs so the actual digest logic
// (message building, PDF attachment, Front posting) lives in exactly one
// place.
//
// See lib/wr-secondary-repl-digest-shared.cjs for the fuller original
// feature history — none of that changed, only where the manual-test
// entry point lives.

const {
  sbFetch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch,
  postDigest,
} = require('./lib/wr-secondary-repl-digest-shared.cjs')

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
    `prepick_notify_settings?facility=eq.wr&dashboard_type=eq.secondary_repl&select=front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const settings = settingsRows?.[0]
  const conversationId = settings?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: 'No front_conversation_id configured for WR Secondary Replenishments in prepick_notify_settings' }
  }

  if (settings.active === false) return { ok: true, skipped: true, reason: 'Digest disabled' }

  const dateObj = centralTodayDateObj()
  const date = centralTodayISO()

  const notifyHour = settings.notify_hour ?? 7
  const notifyMinute = settings.notify_minute ?? 0
  if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
    return { ok: true, skipped: true, reason: 'Not the configured send time yet' }
  }
  if (settings.last_sent_date === date) {
    return { ok: true, skipped: true, reason: 'Already sent for this date' }
  }
  const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
  const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()
  if (!notifyDays.includes(isoWeekday)) {
    return { ok: true, skipped: true, reason: `${date} is not a configured notify day` }
  }

  return postDigest({ conversationId, dateObj, isManualTest: false })
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use wr-secondary-repl-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
