'use strict'

// Attendance Points daily digest — SCHEDULED TICK ONLY. Loops every
// facility marked active=true in attendance_points_notify_settings and
// posts any NEW threshold crossing (6/8/10 pts) as a Front comment on
// that facility's HR conversation. See lib/attendance-points-shared.cjs
// for the full design, the dedupe mechanism, and the known B2E
// data-freshness caveat (single historical load as of build time — this
// needs a recurring Data Platform sync before it's safe to run for real).
//
// Same "Netlify blocks direct HTTP invocation of a scheduled function"
// fix pattern as every other digest in this app — manual runs go through
// the sibling attendance-points-digest-test.cjs instead.

const { sbFetch, runDigest } = require('./lib/attendance-points-shared.cjs')
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use attendance-points-digest-test for manual runs' }) }
  }

  try {
    const rows = await sbFetch(`attendance_points_notify_settings?active=eq.true&select=facility`)
    const results = []
    for (const row of rows || []) {
      results.push({ facility: row.facility, ...(await runDigest({ isManualTest: false, facility: row.facility })) })
    }
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, results }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
