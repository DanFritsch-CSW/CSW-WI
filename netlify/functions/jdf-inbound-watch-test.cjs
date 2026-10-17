'use strict'

// JDF Inbound Watch — MANUAL test. No `schedule`, so it can be POSTed directly.
// DRY RUN by default: reads Datex + Supabase and returns exactly what it WOULD
// create (tasks/comments) without writing or calling Front.
// POST body { "send": true } runs for real (ignores the kill switch).
// NOTE: a real first run on an empty table only SEEDS existing orders silently.

const { runWatch } = require('./lib/jdf-inbound-watch-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let send = false
  try { send = JSON.parse(event.body || '{}').send === true } catch (_) {}
  try {
    const result = await runWatch({ dryRun: !send })
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }, null, 2) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
