'use strict'

// FEFO Lot Reallocation Alert — MANUAL TEST ONLY. Added 2026-07-30 as the
// sibling to fefo-lot-reallocation-alert.cjs (see that file's header, and
// lib/fefo-realloc-shared.cjs's header, for why this split exists —
// Netlify blocks direct HTTP invocation of any scheduled function, which
// made "Send test alert now" 403 the same way it did for the nightly
// digest test button).
//
// No `schedule` entry in netlify.toml, so Netlify allows direct POSTs.
// Runs the exact same real detection logic as the scheduled function for
// a single project — posts a real alert if one genuinely exists, or a
// short "wiring confirmed, nothing new" message otherwise. No fabricated
// demo data either way, same as before the split.

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

async function runTest(dashboardType) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  const project = PROJECT_BY_DASHBOARD_TYPE.get(dashboardType)
  if (!project) return { ok: false, reason: `Unknown dashboardType '${dashboardType}'` }
  const rows = await sbFetch(
    `prepick_notify_settings?facility=eq.${project.facility}&dashboard_type=eq.${dashboardType}&select=front_conversation_id,active`
  )
  const settingsRow = rows?.[0]
  return runForProject({ settingsRow, project, isManualTest: true })
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let dashboardType
  try { ({ dashboardType } = JSON.parse(event.body || '{}')) } catch { /* noop */ }
  if (!dashboardType) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'dashboardType required, e.g. "fefo_realloc_faioa5"' }) }
  }
  try {
    const result = await runTest(dashboardType)
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
