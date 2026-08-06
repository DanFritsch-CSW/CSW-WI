'use strict'

// Manual-test entrypoint for the Scorecard Draft Creator — no `schedule`
// entry in netlify.toml, so Netlify allows direct browser/curl POSTs (same
// 403-avoidance split pattern as every other *-digest-test.cjs in this app).
//
// NOT A DRY RUN — same convention as every other manual test button in this
// app (Attendance Points, WR Pick Check, etc.): this creates a REAL Front
// draft on the conversation you point it at, and really calls the Claude
// API. It does NOT write to scorecard_draft_log (manual tests are expected
// to re-run against the same conversation repeatedly), and it never sends
// anything — draft-only, per the standing design rule.
//
// Body: { customerKey: 'bernatellos', conversationId: 'cnv_xxxxx' }
// conversationId must be supplied explicitly — this does not search Front,
// since the whole point of a manual test is to point it at a KNOWN past
// conversation (e.g. a recent real Bernatello's scorecard thread) to check
// output quality before relying on the scheduled path.

const { runForConversation } = require('./lib/scorecard-draft-shared.cjs')

exports.handler = async (event) => {
  const NO_CACHE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: 'Method Not Allowed' }
  }

  let customerKey, conversationId
  try {
    ;({ customerKey, conversationId } = JSON.parse(event.body || '{}'))
    if (!customerKey || !conversationId) throw new Error('customerKey and conversationId are both required')
  } catch (e) {
    return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message }) }
  }

  try {
    const result = await runForConversation({ customerKey, conversationId, isManualTest: true })
    return { statusCode: result.ok ? 200 : 502, headers: NO_CACHE_HEADERS, body: JSON.stringify(result) }
  } catch (e) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }) }
  }
}
