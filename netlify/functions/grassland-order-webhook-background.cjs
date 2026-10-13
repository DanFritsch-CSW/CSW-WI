'use strict'

/**
 * Netlify BACKGROUND Function: grassland-order-webhook-background
 * Added 2026-10-13. Webhook receiver for the Front "Grassland order agent".
 *
 * Webhook URL to paste into Front (Settings > Agents > this agent >
 * Credentials > Front -> Agent):
 *   https://csw-wi.netlify.app/.netlify/functions/grassland-order-webhook-background
 *
 * Same reasoning as lens-webhook-background.cjs: Netlify answers 202
 * immediately and lets this run up to 15 minutes (PDF read + MotherDuck
 * resolution + a real Datex push comfortably exceeds Front's 5s webhook
 * timeout). Signature verification happens after the 202 goes out, so a
 * bad signature is silently dropped rather than rejected with a 401.
 *
 * Handles only type === 'mention'.
 *
 * Env: FRONT_GRASSLAND_AGENT_SIGNING_SECRET (or FRONT_AGENT_SIGNING_SECRET)
 *      (+ every var lib/grassland-front-agent.cjs and
 *      lib/grassland-order-shared.cjs need).
 */

const crypto = require('crypto')
const { runGrasslandAgentForMention } = require('./lib/grassland-front-agent.cjs')

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

    if (!verifySignature(rawBody, headers, process.env.FRONT_GRASSLAND_AGENT_SIGNING_SECRET || process.env.FRONT_AGENT_SIGNING_SECRET)) {
      console.warn('[grassland-order-webhook] signature check failed; ignoring request')
      return { statusCode: 200 }
    }

    let payload
    try { payload = JSON.parse(rawBody) } catch { return { statusCode: 200 } }

    console.log('[grassland-order-webhook] event', JSON.stringify({ type: payload.type, id: payload.event_id }))

    if (payload.type !== 'mention') return { statusCode: 200 }
    if (!payload.conversation_id || !payload.comment_id) {
      console.warn('[grassland-order-webhook] mention missing ids', JSON.stringify(payload))
      return { statusCode: 200 }
    }

    const result = await runGrasslandAgentForMention({
      conversationId: payload.conversation_id,
      commentId: payload.comment_id,
    })
    console.log('[grassland-order-webhook] result', JSON.stringify(result))
    return { statusCode: 200 }
  } catch (e) {
    console.error('[grassland-order-webhook] error:', e.message)
    return { statusCode: 200 }
  }
}
