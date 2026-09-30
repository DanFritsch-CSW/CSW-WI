'use strict'

// Dan's Footprint Variance digest — MANUAL TEST ONLY. No `schedule` entry
// in netlify.toml, so this can be POSTed directly from the "Create thread
// now" button (Netlify blocks direct HTTP invocation of anything carrying
// a schedule — see dan-footprint-digest-run.cjs). NOT a dry run — this
// really creates a new Front discussion addressed to Dan, same as the
// scheduled path, just bypassing the time/day/active gate and skipping
// the last_sent_date write so repeated clicks in the same day always fire.
//
// Multi-facility as of 2026-09-30 — the caller (Dan.jsx's
// FootprintNotifyPanel) passes { facility: 'mad' | 'wr' } in the POST body
// so this knows which facility's thread to create; defaults to 'mad' if
// omitted for back-compat with any stale cached client build.

const { createFootprintThread } = require('./lib/dan-footprint-digest-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let facility = 'mad'
  try {
    const body = event.body ? JSON.parse(event.body) : {}
    if (body.facility) facility = body.facility
  } catch { /* malformed body — fall back to default facility */ }

  try {
    const result = await createFootprintThread({ isManualTest: true, facility })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
