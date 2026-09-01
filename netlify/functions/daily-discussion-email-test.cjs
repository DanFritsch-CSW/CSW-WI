'use strict'

// Daily Discussion email draft creation — MANUAL TEST ONLY. Sibling to
// daily-discussion-email-run.cjs (see that file's header, and
// lib/daily-discussion-email-shared.cjs's header, for why this split
// exists).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Always creates the
// draft immediately for tomorrow's date regardless of time/active/
// weekday settings, and does not touch last_sent_date. Requires
// {facility} in the POST body — no default, since unlike CMM Outbound
// this feature is meant to work across any of the 5 facilities and
// guessing one would be wrong more often than not.

const { runDigest } = require('./lib/daily-discussion-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let body
  try { body = JSON.parse(event.body || '{}') } catch { body = {} }
  const facility = body.facility
  if (!facility) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: '{facility} is required in the POST body' }) }
  }

  try {
    const result = await runDigest({ isManualTest: true, facility })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
