'use strict'

// Nightly FEFO Rotation digest — SCHEDULED TICK ONLY.
//
// Split 2026-07-30 from a single combined scheduled+manual-test function.
// Netlify does not allow direct HTTP invocation of a function that carries
// a `schedule` in netlify.toml — confirmed via Netlify's own docs and
// reproduced live (see lib/fefo-digest-shared.cjs's header for the full
// story). This file keeps the `schedule` and ONLY handles the cron tick;
// "Send test digest now" now calls the sibling function
// fefo-digest-test.cjs instead, which has no schedule and can be invoked
// directly. Both require lib/fefo-digest-shared.cjs so the actual digest
// logic (verdict engine, message building, Front posting) lives in exactly
// one place.
//
// See fefo-digest-shared.cjs for the full original feature history
// (per-project settings rows, JDF's closedOrders variant, etc). Content
// date for open-order (non-closedOrders) projects changed 2026-08-06 from
// a resolved "next business day" to a live "everything currently
// Processing" snapshot (see that file's header) — this file just needed
// to swap which date-resolution helper it calls; nothing else here changed.

const {
  PROJECT_BY_DASHBOARD_TYPE,
  sbFetch,
  centralTodayDateObj, sameCalendarDayDateObj, isNotifyTimeMatch, isoDate,
  runForProject,
} = require('./lib/fefo-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runScheduledDigest() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  // Loop every fefo_* row (across ALL facilities). closedOrders (JDF)
  // resolves its own closed/shipped calendar day; every other project now
  // just uses today (2026-08-06 — see lib/fefo-digest-shared.cjs's "Open-
  // order content date: live snapshot" note), then fires if this tick
  // matches the configured send time and it hasn't already sent today.
  const rows = await sbFetch(
    `prepick_notify_settings?dashboard_type=like.fefo_*&select=facility,dashboard_type,front_conversation_id,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  const results = []
  for (const row of (rows || [])) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(row.dashboard_type)
    if (!project) continue
    if (row.active === false) { results.push({ ok: true, skipped: true, project: project.code, reason: 'Digest disabled' }); continue }
    const dateObj = project.closedOrders ? sameCalendarDayDateObj() : centralTodayDateObj()
    const notifyHour = row.notify_hour ?? 22
    const notifyMinute = row.notify_minute ?? 15
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Not the configured send time yet' })
      continue
    }
    if (row.last_sent_date === isoDate(dateObj)) {
      results.push({ ok: true, skipped: true, project: project.code, reason: 'Already sent for this date' })
      continue
    }
    try {
      const r = await runForProject({ settingsRow: row, project, dateObj, isManualTest: false })
      results.push(r)
    } catch (e) {
      results.push({ ok: false, project: project.code, reason: e.message })
    }
  }
  return { ok: true, results }
}

exports.handler = async function (event) {
  // Scheduled-only. Netlify already blocks any direct HTTP POST from
  // reaching this function (see header) — this check is defense-in-depth
  // documentation, not the actual enforcement mechanism.
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use fefo-digest-test for manual sends' }) }
  }
  try {
    const result = await runScheduledDigest()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
