'use strict'

// Automated Appointment Creation pilot — daily review digest, SCHEDULED
// path. See lib/auto-appt-review-digest-shared.cjs for the full writeup.
// Once daily (8am Central) rather than the */15 cadence other digests in
// this app use — this is a once-a-day review summary, not a
// responsiveness-sensitive alert.

const { postDigest } = require('./lib/auto-appt-review-digest-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use auto-appt-review-digest-test for manual runs' }) }
  }

  try {
    const result = await postDigest()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
