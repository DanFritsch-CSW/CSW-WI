'use strict'

/**
 * Netlify Function: ai-appt-intake-webhook
 * Added 2026-09-05. Live entry point for Front's "Inbound messages" webhook
 * event, subscribed on all 5 Appointments inboxes (CAL/KEN/MAD/WR/EC).
 *
 * Deliberately a SEPARATE function from scheduling-front-webhook.cjs (the
 * existing tag-added-driven Playbook receiver) — different event shape
 * (message-received vs tag-added), and keeping them apart means this new,
 * unverified pipeline can't risk regressing the Playbook path that was
 * just fixed (its webhook URL had been silently pointed at the old
 * standalone app's domain until this same session).
 *
 * See lib/ai-appt-intake-shared.cjs for the full design writeup, real-data
 * findings, and the confidence-gating/routing logic. This file is
 * intentionally thin — payload parsing + signature verification only.
 *
 * Env vars required: SUPABASE_URL/VITE_SUPABASE_URL, SUPABASE_ANON_KEY or
 * SUPABASE_SERVICE_ROLE_KEY, FRONT_API_TOKEN (or legacy FRONT_API_KEY),
 * ANTHROPIC_API_KEY, FRONT_WEBHOOK_SECRET (optional, HMAC verification).
 */

const crypto = require('crypto')
const { runIntakeForMessage } = require('./lib/ai-appt-intake-shared.cjs')

function verifySignature(rawBody, signature, secret) {
  if (!secret) {
    console.warn('[ai-appt-intake-webhook] FRONT_WEBHOOK_SECRET not set — skipping HMAC check')
    return true
  }
  if (!signature) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

// Front's "Inbound messages" webhook payload carries the message and
// conversation under payload.target.data / payload.conversation — pulled
// defensively since the exact nesting for this event type hasn't been
// exercised live yet (this is the first non-tag-added event this app
// subscribes to). Logged on every call so the real shape can be confirmed
// from Netlify function logs on first live traffic.
function extractIds(body) {
  const payload = body.payload || {}
  const messageId =
    payload.target?.data?.id ||
    payload.id ||
    payload.message?.id ||
    null
  const conversationId =
    payload.conversation?.id ||
    payload.target?.data?.conversation_id ||
    payload.conversation_id ||
    body.conversation_id ||
    null
  const inboxId =
    (payload.conversation?.inboxes || payload.target?.data?.inboxes || [])[0]?.id ||
    payload.inbox_id ||
    null
  return { messageId, conversationId, inboxId }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'OK', headers: { 'Content-Type': 'text/plain' } }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '')
  if (!rawBody || rawBody.trim() === '') {
    return { statusCode: 200, body: 'OK' }
  }

  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { statusCode: 400, body: 'Bad Request — invalid JSON' }
  }

  // Front sends type:"sync" to verify the endpoint is reachable when the
  // webhook subscription is first created/edited.
  if (body.type === 'sync') {
    const challenge = event.headers['x-front-challenge'] || body.challenge
    console.log('[ai-appt-intake-webhook] Sync ping — challenge:', challenge)
    const responseBody = challenge ? { challenge } : { ok: true }
    return { statusCode: 200, body: JSON.stringify(responseBody), headers: { 'Content-Type': 'application/json' } }
  }

  const signature = event.headers['x-front-signature'] || ''
  if (!verifySignature(rawBody, signature, process.env.FRONT_WEBHOOK_SECRET)) {
    console.error('[ai-appt-intake-webhook] Signature mismatch')
    return { statusCode: 401, body: 'Unauthorized' }
  }

  console.log('[ai-appt-intake-webhook] Body:', rawBody.slice(0, 2000))

  const { messageId, conversationId, inboxId } = extractIds(body)
  console.log('[ai-appt-intake-webhook] Parsed:', { messageId, conversationId, inboxId })

  if (!conversationId || !messageId || !inboxId) {
    console.warn('[ai-appt-intake-webhook] Missing conversationId/messageId/inboxId — skipping. Check payload shape above against extractIds().')
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, skipped: true, reason: 'Could not resolve conversationId/messageId/inboxId from payload' }),
    }
  }

  try {
    const result = await runIntakeForMessage({ conversationId, messageId, inboxId, isManualTest: false })
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }
  } catch (e) {
    console.error('[ai-appt-intake-webhook] Unhandled error:', e.message)
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, reason: e.message }) }
  }
}
