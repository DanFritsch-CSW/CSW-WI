'use strict'

// CMM Empty Trailer hourly ping -- MANUAL TEST ONLY. No `schedule` entry in
// netlify.toml, so the browser can POST to it directly (same 403-avoidance
// pattern as every other *-digest-test.cjs in this app).
//
// NOT a dry run -- really posts a comment to whatever conversation is
// currently in last_conversation_id, bypassing the active/hour-window/
// already-pinged-this-hour gates. Still fails with a clear reason if no
// kickoff email has sent today (nothing to ping yet).

const { runPing } = require('./lib/cmm-empty-trailer-ping-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }

  try {
    const result = await runPing({ isManualTest: true })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
