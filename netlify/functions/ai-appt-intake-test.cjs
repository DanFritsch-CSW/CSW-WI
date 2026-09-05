'use strict'

/**
 * Netlify Function: ai-appt-intake-test
 * Added 2026-09-05. Manual test entry point for the AI Appointment Intake
 * pipeline — NOT a dry run, same convention as every other *-test.cjs in
 * this app: it really calls the Claude API and, if confidence clears the
 * bar, really writes to `submissions`. Bypasses the dedupe/first-message
 * gate so the same conversation can be re-run repeatedly while validating.
 *
 * POST body: { conversationId, messageId, inboxId }
 *   - conversationId: cnv_xxx
 *   - messageId: msg_xxx (the specific inbound message to extract from)
 *   - inboxId: inb_xxx (one of the 5 known Appointments inboxes — see
 *     lib/ai-appt-intake-shared.cjs's INBOX_WAREHOUSE_MAP)
 *
 * See lib/ai-appt-intake-shared.cjs for the full pipeline.
 */

const { runIntakeForMessage } = require('./lib/ai-appt-intake-shared.cjs')

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: 'Bad Request — invalid JSON' }
  }

  const { conversationId, messageId, inboxId } = body
  if (!conversationId || !messageId || !inboxId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, reason: 'conversationId, messageId, and inboxId are all required' }),
    }
  }

  try {
    const result = await runIntakeForMessage({ conversationId, messageId, inboxId, isManualTest: true })
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: e.message }) }
  }
}
