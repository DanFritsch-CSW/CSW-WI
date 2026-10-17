'use strict'

// JDF Pick Timer — MANUAL test. No `schedule`, so it can be POSTed directly.
// DRY RUN by default: reads Datex + Supabase and returns exactly what it WOULD
// create (tasks/comments) without writing or calling Front.
// POST body { "send": true } runs for real.

const { runPickTimer } = require('./lib/jdf-pick-timer-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }
  let send = false
  try { send = JSON.parse(event.body || '{}').send === true } catch (_) {}
  try {
    const result = await runPickTimer({ dryRun: !send })
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }, null, 2) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
