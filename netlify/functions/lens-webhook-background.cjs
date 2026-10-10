'use strict'

/**
 * Netlify BACKGROUND Function: lens-webhook-background
 * Added 2026-10-10. Webhook receiver for the Front "Customer Lens" agent.
 *
 * Webhook URL to paste into Front (Settings > Agents > AI engine):
 *   https://csw-wi.netlify.app/.netlify/functions/lens-webhook-background
 *
 * Why "-background": Netlify answers 202 immediately and lets this run up to
 * 15 minutes. Front times out webhooks at 5s; the model call takes longer.
 * Because the 202 goes out first, signature verification happens here and a
 * bad signature simply does nothing (it cannot be rejected with a 401).
 *
 * Handles only type === 'mention'. Ignores assign / inbound / unassign so the
 * agent never acts on a conversation it was merely assigned.
 *
 * Env: FRONT_AGENT_SIGNING_SECRET (+ vars used by lib/lens-front-agent.cjs).
 */

const crypto = require('crypto')
const { runLensForMention } = require('./lib/lens-front-agent.cjs')

const MAX_SKEW_MS = 10 * 60 * 1000

function verifySignature(rawBody, headers, secret) {
  const ts = headers['x-front-request-timestamp']
  const sig = headers['x-front-signature']
  if (!ts || !sig || !secret) return false
  const skew = Math.abs(Date.now() - Number(ts))
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) return false
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`, 'utf8').digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

exports.handler = async (event) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || ''

    if (!verifySignature(rawBody, headers, process.env.FRONT_AGENT_SIGNING_SECRET)) {
      console.warn('[lens-webhook] signature check failed; ignoring request')
      return { statusCode: 200 }
    }

    let payload
    try { payload = JSON.parse(rawBody) } catch { return { statusCode: 200 } }

    console.log('[lens-webhook] event', JSON.stringify({ type: payload.type, id: payload.event_id }))

    if (payload.type !== 'mention') return { statusCode: 200 }
    if (!payload.conversation_id || !payload.comment_id) {
      console.warn('[lens-webhook] mention missing ids', JSON.stringify(payload))
      return { statusCode: 200 }
    }

    const result = await runLensForMention({
      conversationId: payload.conversation_id,
      commentId: payload.comment_id,
      eventId: payload.event_id,
    })
    console.log('[lens-webhook] result', JSON.stringify(result))
    return { statusCode: 200 }
  } catch (e) {
    console.error('[lens-webhook] error:', e.message)
    return { statusCode: 200 }
  }
}
