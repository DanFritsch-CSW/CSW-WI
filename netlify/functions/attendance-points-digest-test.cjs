'use strict'

// Manual test entry point for the Attendance Points digest — no
// `schedule` in netlify.toml, so it can be called directly from the
// browser (same fix pattern as every other *-digest-test.cjs in this
// app). Requires { facility } in the POST body.
//
// IMPORTANT: unlike a typical "test" button elsewhere in this app, this
// is NOT a dry run. It really posts to the facility's Front conversation
// and really writes attendance_points_actions rows — identical behavior
// to a live scheduled tick. That's intentional per Dan's phase-in plan:
// this is how accuracy gets validated against a manual audit before a
// facility's `active` flag flips to true and the daily cron takes over
// unattended (see lib/attendance-points-shared.cjs header).

const { runDigest } = require('./lib/attendance-points-shared.cjs')
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  let facility
  try {
    ;({ facility } = JSON.parse(event.body || '{}'))
    if (!facility) throw new Error('facility required')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }

  try {
    const result = await runDigest({ isManualTest: true, facility })
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
