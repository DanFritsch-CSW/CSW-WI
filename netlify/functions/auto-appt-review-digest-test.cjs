'use strict'

// Automated Appointment Creation pilot — daily review digest, MANUAL TEST
// path. No `schedule` entry, so this can be POSTed directly. NOT a dry
// run — really posts a comment to cnv_1c7dl7mc if there's activity in the
// last 24 hours.

const { postDigest } = require('./lib/auto-appt-review-digest-shared.cjs')

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
