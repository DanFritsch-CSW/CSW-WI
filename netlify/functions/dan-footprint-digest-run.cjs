'use strict'

// Dan's Footprint Variance digest — SCHEDULED TICK ONLY.
//
// Same split-function convention as every other digest in this app:
// Netlify blocks direct HTTP invocation of any function carrying a
// `schedule` in netlify.toml, so the manual "Create thread now" button
// calls the sibling dan-footprint-digest-test.cjs instead (no schedule).
//
// Multi-facility as of 2026-09-30 — loops every
// dashboard_type=like.footprint_variance_* row (across all tracked
// facilities, same pattern as fefo-digest-run.cjs's per-project loop) so
// Madison and Wisconsin Rapids can each run on their own configured
// time/days/active state and fire into their own separate Front thread,
// per Dan's explicit call not to combine them.
//
// See lib/dan-footprint-digest-shared.cjs for the full design writeup —
// in short, each matching row creates a BRAND-NEW Front discussion each
// time it fires (not a comment on an existing thread), addressed only to
// Dan.

const {
  FACILITY_BY_DASHBOARD_TYPE,
  sbFetch,
  centralTodayISO, centralTodayDateObj, isNotifyTimeMatch,
  createFootprintThread,
} = require('./lib/dan-footprint-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

async function runScheduledDigest() {
  const settingsRows = await sbFetch(
    `prepick_notify_settings?facility=eq.dan&dashboard_type=like.footprint_variance_*&select=dashboard_type,notify_hour,notify_minute,notify_days,active,last_sent_date`
  )
  if (!settingsRows || !settingsRows.length) {
    return { ok: false, reason: 'No prepick_notify_settings rows for facility=dan, dashboard_type=footprint_variance_*' }
  }

  const date = centralTodayISO()
  const dateObj = centralTodayDateObj()
  const isoWeekday = dateObj.getUTCDay() === 0 ? 7 : dateObj.getUTCDay()

  const results = []
  for (const settings of settingsRows) {
    const facilityMeta = FACILITY_BY_DASHBOARD_TYPE.get(settings.dashboard_type)
    if (!facilityMeta) { results.push({ ok: true, skipped: true, dashboardType: settings.dashboard_type, reason: 'Unrecognized dashboard_type' }); continue }

    if (settings.active === false) { results.push({ ok: true, skipped: true, facility: facilityMeta.id, reason: 'Digest disabled' }); continue }

    const notifyHour = settings.notify_hour ?? 7
    const notifyMinute = settings.notify_minute ?? 0
    if (!isNotifyTimeMatch(notifyHour, notifyMinute)) {
      results.push({ ok: true, skipped: true, facility: facilityMeta.id, reason: 'Not the configured trigger time yet' })
      continue
    }
    if (settings.last_sent_date === date) {
      results.push({ ok: true, skipped: true, facility: facilityMeta.id, reason: 'Already created a thread for this date' })
      continue
    }
    const notifyDays = settings.notify_days ?? [1, 2, 3, 4, 5]
    if (!notifyDays.includes(isoWeekday)) {
      results.push({ ok: true, skipped: true, facility: facilityMeta.id, reason: `${date} is not a configured trigger day` })
      continue
    }

    try {
      const r = await createFootprintThread({ isManualTest: false, facility: facilityMeta.id })
      results.push(r)
    } catch (e) {
      results.push({ ok: false, facility: facilityMeta.id, reason: e.message })
    }
  }

  return { ok: true, results }
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
