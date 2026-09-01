'use strict'

// Customer Shortage Report email draft creation — MANUAL TEST ONLY.
// Sibling to shortage-report-email-run.cjs (see that file's header, and
// lib/shortage-report-email-shared.cjs's header, for why this split
// exists).
//
// No `schedule` entry in netlify.toml, so the browser can POST to it
// directly. Creates the draft immediately for tomorrow's date regardless
// of time/active/weekday settings, and does not touch last_sent_date.
// Requires {reportKey} in the POST body — no default, since this is
// meant to work across multiple customer reports as they get added.

const { runDigest } = require('./lib/shortage-report-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let body
  try { body = JSON.parse(event.body || '{}') } catch { body = {} }
  const reportKey = body.reportKey
  if (!reportKey) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '{reportKey} is required in the POST body' }) }
  }

  try {
    const result = await runDigest({ isManualTest: true, reportKey })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
