'use strict'

// JDF Inbound Watch — SCHEDULED tick (every 15 minutes). See
// lib/jdf-inbound-watch-shared.cjs for the full design writeup.
// Always live -- there is no env-var switch. The first run on an empty table
// only seeds existing orders silently (see the shared lib), so deploying
// never floods Dan with old orders.
// Manual runs go through jdf-inbound-watch-test.cjs (this function carries a
// `schedule`, so Netlify blocks direct HTTP invocation of it).

const { runWatch } = require('./lib/jdf-inbound-watch-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use jdf-inbound-watch-test for manual runs' }) }
  }
  try {
    const result = await runWatch({ dryRun: false })
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
