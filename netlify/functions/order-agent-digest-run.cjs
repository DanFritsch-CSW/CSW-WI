'use strict'

// order_agent usage digest -- SCHEDULED path. See
// lib/order-agent-digest-shared.cjs for the full writeup. Nightly at 11pm
// Central (04:00 UTC during DST), same slot as the other two agent digests.

const { postDigest } = require('./lib/order-agent-digest-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.headers?.['x-netlify-event'] !== 'schedule') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Scheduled invocation only — use order-agent-digest-test for manual runs' }) }
  }
  try {
    const result = await postDigest()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
