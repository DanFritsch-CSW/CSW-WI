'use strict'

// CMM Outbound Appts draft creation — MANUAL TEST ONLY. Added 2026-07-31
// as the sibling to cmm-outbound-draft-create.cjs (see that file's
// header, and lib/cmm-outbound-draft-shared.cjs's header, for why this
// split exists).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Always creates the
// draft immediately for tomorrow's date regardless of time/active/
// weekday settings, and does not touch last_sent_date. Defaults facility
// to 'cal' (the only facility wired up today) if the POST body omits it,
// matching the original combined function's fallback.

const { runDigest } = require('./lib/cmm-outbound-draft-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let body
  try { body = JSON.parse(event.body || '{}') } catch { body = {} }
  const facility = body.facility || 'cal'

  try {
    const result = await runDigest({ isManualTest: true, facility })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
