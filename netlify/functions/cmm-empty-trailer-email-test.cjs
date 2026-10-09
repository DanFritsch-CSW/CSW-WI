'use strict'

// CMM Empty Trailer daily email -- MANUAL TEST ONLY. No `schedule` entry
// in netlify.toml, so the browser can POST to it directly (same
// 403-avoidance pattern as every other *-digest-test.cjs in this app).
//
// NOT a dry run -- this really sends a live email via Front to whatever
// TO/CC recipients are configured in Settings > CMM Empty Trailer,
// bypassing the time/day/active gate and skipping the last_sent_date
// write. Same caution as cmm-outbound-draft-create-test.cjs, but more so:
// there's no draft step here to catch a mistake before it reaches
// external Palermo's/CMM inboxes.

const { runDigest } = require('./lib/cmm-empty-trailer-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }

  try {
    const result = await runDigest({ isManualTest: true })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
