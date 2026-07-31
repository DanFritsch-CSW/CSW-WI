'use strict'

// LoadProof / DVRS open-incidents daily digest — MANUAL TEST ONLY. Added
// 2026-07-31 as the sibling to dvr-digest-run.cjs (see that file's
// header, and lib/dvr-digest-shared.cjs's header, for why this split
// exists).
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows the browser to POST to it directly. Always sends
// immediately for today regardless of time/active/weekday settings, and
// does not touch last_sent_date.

const { runDigest, APP_URL } = require('./lib/dvr-digest-shared.cjs')

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'POST only' }) }
  }
  const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Content-Type':'application/json' }
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || APP_URL
  try {
    const result = await runDigest(true, baseUrl)
    console.log('[dvr-digest-test]', JSON.stringify(result))
    return { statusCode: 200, headers: cors, body: JSON.stringify(result) }
  } catch(err) {
    console.error('[dvr-digest-test] error:', err.message)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
