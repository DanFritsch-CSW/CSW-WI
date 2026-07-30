'use strict'

// FEFO Lot Reallocation Alert — SCHEDULED TICK ONLY.
//
// Split 2026-07-30 — same reason as fefo-digest-run.cjs's split (see
// lib/fefo-digest-shared.cjs's header for the full story): Netlify blocks
// direct HTTP invocation of any function carrying a `schedule` in
// netlify.toml. This file keeps the `schedule` and only handles the
// ~30-min cron tick; "Send test alert now" now calls the sibling function
// fefo-lot-reallocation-alert-test.cjs instead, which has no schedule.
// Both require lib/fefo-realloc-shared.cjs for the actual detection logic.
//
// See lib/fefo-realloc-shared.cjs for the full original design history
// (why this detects FEFO verdict transitions rather than raw task
// cancellations, severity thresholds, scope, etc).

const {
  PROJECT_BY_DASHBOARD_TYPE,
  sbFetch,
  runForProject,
} = require('./lib/fefo-realloc-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

async function runScheduledCheck() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const rows = await sbFetch(
    `prepick_notify_settings?dashboard_type=like.fefo_realloc_*&active=eq.true&select=facility,dashboard_type,front_conversation_id,active`
  )
  const results = []
  for (const row of (rows || [])) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(row.dashboard_type)
    if (!project) continue
    try {
      const r = await runForProject({ settingsRow: row, project, isManualTest: false })
      results.push(r)
    } catch (e) {
      results.push({ ok: false, project: project.code, reason: e.message })
    }
  }
  return { ok: true, results }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use fefo-lot-reallocation-alert-test for manual sends' }) }
  }
  try {
    const result = await runScheduledCheck()
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
