'use strict'

// JDF Daily Comms daily email -- SCHEDULED TICK ONLY. Same split pattern as
// cmm-empty-trailer-email-run.cjs / every other *-run.cjs in this app:
// Netlify blocks direct HTTP invocation of a function that carries a
// `schedule`, so "Send Now (test)" uses the sibling
// jdf-daily-comms-email-test.cjs instead. See
// lib/jdf-daily-comms-email-shared.cjs for the full design writeup.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN,
  runDigest,
} = require('./lib/jdf-daily-comms-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use jdf-daily-comms-email-test for manual sends' }) }
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
    if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')

    const result = await runDigest({ isManualTest: false })
    return { statusCode: 200, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message, detail: err.detail }) }
  }
}
