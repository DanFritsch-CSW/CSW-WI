'use strict'

// JDF Inbound Watch — SCHEDULED tick (every 15 minutes). See
// lib/jdf-inbound-watch-shared.cjs for the full design writeup.
// Does nothing unless env JDF_INBOUND_WATCH_ACTIVE === 'true'.
// Manual runs go through jdf-inbound-watch-test.cjs (this function carries a
// `schedule`, so Netlify blocks direct HTTP invocation of it).

const { runWatch } = require('./lib/jdf-inbound-watch-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use jdf-inbound-watch-test for manual runs' }) }
  }
  if (process.env.JDF_INBOUND_WATCH_ACTIVE !== 'true') {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, skipped: true, reason: 'JDF_INBOUND_WATCH_ACTIVE is not "true"' }) }
  }
  try {
    const result = await runWatch({ dryRun: false })
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
