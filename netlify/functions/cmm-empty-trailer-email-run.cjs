'use strict'

// CMM Empty Trailer daily email -- SCHEDULED TICK ONLY. Same split
// pattern as cmm-outbound-draft-create.cjs / every other *-run.cjs in
// this app: Netlify blocks direct HTTP invocation of a function that
// carries a `schedule`, so "Create Now (test)" uses the sibling
// cmm-empty-trailer-email-test.cjs instead. See
// lib/cmm-empty-trailer-email-shared.cjs for the full design writeup.

const {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN,
  runDigest,
} = require('./lib/cmm-empty-trailer-email-shared.cjs')

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use cmm-empty-trailer-email-test for manual sends' }) }
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
