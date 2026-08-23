'use strict'

// Automated Appointment Creation pilot (Palermo's / Sam Rohde) — MANUAL
// TEST path. No `schedule` entry in netlify.toml on purpose, so this can
// be POSTed directly (see auto-appt-parse-run.cjs's header for why the
// scheduled sibling can't be triggered this way). Calls the EXACT same
// runScan() logic as the scheduled path — nothing here is a dry run: a
// real matching email really creates a real pending submission and really
// logs to auto_appt_attempts, same as the 15-minute scheduled run would.
// This exists purely so behavior can be verified without waiting for the
// next tick.

const { runScan } = require('./lib/auto-appt-parse-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }

  try {
    const results = await runScan()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, scanned: results.length, results }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
