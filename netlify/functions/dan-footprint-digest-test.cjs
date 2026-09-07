'use strict'

// Dan's Footprint Variance digest — MANUAL TEST ONLY. No `schedule` entry
// in netlify.toml, so this can be POSTed directly from the "Create thread
// now" button (Netlify blocks direct HTTP invocation of anything carrying
// a schedule — see dan-footprint-digest-run.cjs). NOT a dry run — this
// really creates a new Front discussion addressed to Dan, same as the
// scheduled path, just bypassing the time/day/active gate and skipping
// the last_sent_date write so repeated clicks in the same day always fire.

const { createFootprintThread } = require('./lib/dan-footprint-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  try {
    const result = await createFootprintThread({ isManualTest: true })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
