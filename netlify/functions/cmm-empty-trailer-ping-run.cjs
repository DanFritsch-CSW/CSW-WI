'use strict'

// CMM Empty Trailer hourly ping -- SCHEDULED TICK ONLY. Same split pattern
// as every other scheduled/manual-test pair in this app: Netlify blocks
// direct HTTP invocation of a function that carries a `schedule`, so manual
// testing uses the sibling cmm-empty-trailer-ping-test.cjs instead. See
// lib/cmm-empty-trailer-ping-shared.cjs for the full design writeup.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN,
  runPing,
} = require('./lib/cmm-empty-trailer-ping-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use cmm-empty-trailer-ping-test for manual pings' }) }
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
    if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')

    const result = await runPing({ isManualTest: false })
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
