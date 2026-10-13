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

const { resolveAndPushBatch, postFailureComment } = require('./lib/grassland-order-shared.cjs')

exports.handler = async (event) => {
  let batchId = null
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    const expected = process.env.GRASSLAND_INTERNAL_SECRET || ''
    const got = headers['x-grassland-internal-secret'] || ''
    if (!expected || got !== expected) {
      // FIXED 2026-10-13 (real stall, cnv_1cmqpvx0/PO 0116897171): this used
      // to just warn+200 with nothing else — if the secret didn't match
      // (e.g. Netlify not yet redeployed with GRASSLAND_INTERNAL_SECRET),
      // the batch sat at 'parsed' forever with zero visible signal anywhere.
      console.error('[grassland-order-resolve] bad or missing internal secret — GRASSLAND_INTERNAL_SECRET likely not set/redeployed on Netlify yet')
      return { statusCode: 200 }
    }

    let body
    try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 200 } }

    if (!body.batchId) {
      console.warn('[grassland-order-resolve] missing batchId')
      return { statusCode: 200 }
    }
    batchId = body.batchId

    const result = await resolveAndPushBatch(batchId)
    console.log('[grassland-order-resolve] result', JSON.stringify(result))
    return { statusCode: 200 }
  } catch (e) {
    // SAFETY NET (added 2026-10-13, same real stall): resolveAndPushBatch's
    // own branches all post a Front comment, but a genuinely unexpected
    // exception (MotherDuck connection drop, a real bug, etc.) used to just
    // get console.error'd here with no comment ever reaching Front — a
    // crash and a stuck-forever success looked identical from the thread.
    // This now always tells the thread SOMETHING happened, even if it
    // can't say exactly what, as long as we at least know which batch.
    console.error('[grassland-order-resolve] unhandled error:', e.message)
    if (batchId) {
      await postFailureComment(batchId, `Grassland order agent: an unexpected error stopped processing (batch ${batchId}). ${e.message}`).catch((err) => {
        console.error('[grassland-order-resolve] also failed to post failure comment:', err.message)
      })
    }
    return { statusCode: 200 }
  }
}
