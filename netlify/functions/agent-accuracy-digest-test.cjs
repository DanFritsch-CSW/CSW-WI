'use strict'

// Scheduling Agent field-accuracy digest -- MANUAL TEST path. No
// `schedule` entry, so this can be POSTed directly. NOT a dry run --
// really creates a Front Task assigned to Dan if there's activity in the
// last 24 hours.

const { postDigest } = require('./lib/agent-accuracy-digest-shared.cjs')

const HEADERS = { 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) }
  }

  try {
    const result = await postDigest()
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
