'use strict'

/**
 * Netlify BACKGROUND Function: grassland-order-resolve-background
 * Rewritten 2026-10-13 (replaces the earlier single-runtime design).
 *
 * Called by the grassland-order-webhook Supabase Edge Function right after
 * it writes a 'parsed' row to grassland_order_batches — this is the half of
 * the pipeline that needs real MotherDuck access (live inventory/lot/pallet
 * resolution), which a Deno Edge Function can't provide.
 *
 * Auth: a shared secret header (x-grassland-internal-secret), not Front's
 * HMAC signature — this isn't a Front webhook, it's an internal handoff.
 *
 * Background (not a plain function): resolution + a real Datex push can
 * run past Netlify's normal ~10s function limit; this answers 202
 * immediately and runs up to 15 minutes, same reasoning as every other
 * background function in this app.
 *
 * Env: GRASSLAND_INTERNAL_SECRET (+ everything
 *      lib/grassland-order-shared.cjs needs: MOTHERDUCK_TOKEN,
 *      DATEX_SMARTUP_*, SUPABASE_*, GRASSLAND_AGENT_ACTIVE).
 */

const { resolveAndPushBatch } = require('./lib/grassland-order-shared.cjs')

exports.handler = async (event) => {
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    const expected = process.env.GRASSLAND_INTERNAL_SECRET || ''
    const got = headers['x-grassland-internal-secret'] || ''
    if (!expected || got !== expected) {
      console.warn('[grassland-order-resolve] bad or missing internal secret; ignoring request')
      return { statusCode: 200 }
    }

    let body
    try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 200 } }

    if (!body.batchId) {
      console.warn('[grassland-order-resolve] missing batchId')
      return { statusCode: 200 }
    }

    const result = await resolveAndPushBatch(body.batchId)
    console.log('[grassland-order-resolve] result', JSON.stringify(result))
    return { statusCode: 200 }
  } catch (e) {
    console.error('[grassland-order-resolve] error:', e.message)
    return { statusCode: 200 }
  }
}
