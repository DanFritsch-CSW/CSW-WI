'use strict'

// Scheduling Agent field-accuracy digest -- SCHEDULED path. See
// lib/agent-accuracy-digest-shared.cjs for the full writeup. Once daily
// (8am Central, same time as the Palermo's digest) rather than the */15
// cadence other digests in this app use -- this is a once-a-day review
// summary, not a responsiveness-sensitive alert.

const { postDigest } = require('./lib/agent-accuracy-digest-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use agent-accuracy-digest-test for manual runs' }) }
  }

  try {
    const result = await postDigest()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
