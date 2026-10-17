'use strict'

// JDF Pick Timer — SCHEDULED tick (every 15 minutes). See
// lib/jdf-pick-timer-shared.cjs for the full design writeup.
// Always live -- there is no env-var switch. Manual runs go through
// jdf-pick-timer-test.cjs (this function carries a `schedule`, so Netlify
// blocks direct HTTP invocation of it).

const { runPickTimer } = require('./lib/jdf-pick-timer-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use jdf-pick-timer-test for manual runs' }) }
  }
  try {
    const result = await runPickTimer({ dryRun: false })
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
