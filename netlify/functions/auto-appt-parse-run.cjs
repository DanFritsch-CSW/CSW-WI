'use strict'

// Automated Appointment Creation pilot (Palermo's / Sam Rohde) —
// SCHEDULED path. See lib/auto-appt-parse-shared.cjs for the full design
// writeup and scope constraints, and auto-appt-parse-test.cjs for the
// manual-trigger sibling.
//
// Netlify blocks direct HTTP invocation of any function with a `schedule`
// entry in netlify.toml (returns 403 before function code runs — same
// behavior documented in fefo-digest-shared.cjs and every other run/test
// split in this app). This function only ever fires on the real
// */15 * * * * schedule; auto-appt-parse-test.cjs (no schedule entry) is
// the way to trigger the same logic on demand.

const { runScan } = require('./lib/auto-appt-parse-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use auto-appt-parse-test for manual runs' }) }
  }

  try {
    const results = await runScan()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, scanned: results.length, results }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
