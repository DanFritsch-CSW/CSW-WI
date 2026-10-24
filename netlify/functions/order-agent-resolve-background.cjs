'use strict'

/**
 * Netlify BACKGROUND Function: order-agent-resolve-background
 * RENAMED 2026-10-24 from grassland-order-resolve-background.cjs as part of
 * clearing the "Known naming debt" flagged in the Notion Architecture doc —
 * this function has been fully generic (multi-customer) since 2026-10-13,
 * only the filename/URL still said Grassland. Safe to rename because the
 * ONLY caller is our own webhook's NETLIFY_RESOLVE_URL constant, updated in
 * the same change — nothing external points at this URL.
 *
 * What it calls is the multi-customer dispatcher: resolveAndPushBatch reads
 * the batch's customer_code and routes to that customer's adapter itself.
 * This file doesn't need to know which customer it is.
 *
 * Called by the order-agent-webhook Supabase Edge Function (still deployed
 * under the slug `grassland-order-webhook` pending a Front-side webhook URL
 * update — see that function's own header note) right after it writes a
 * 'parsed' row to order_agent_batches — this is the half of the pipeline
 * that needs real MotherDuck access (live inventory/lot/pallet resolution),
 * which a Deno Edge Function can't provide.
 *
 * Auth: a shared secret header (x-order-agent-internal-secret), not Front's
 * HMAC signature — this isn't a Front webhook, it's an internal handoff.
 *
 * Background (not a plain function): resolution + a real Datex push can
 * run past Netlify's normal ~10s function limit; this answers 202
 * immediately and runs up to 15 minutes, same reasoning as every other
 * background function in this app.
 *
 * Env: ORDER_AGENT_INTERNAL_SECRET (renamed from GRASSLAND_INTERNAL_SECRET,
 *      same value) (+ everything lib/order-agent-common.cjs needs:
 *      MOTHERDUCK_TOKEN, DATEX_SMARTUP_*, SUPABASE_*, GRASSLAND_AGENT_ACTIVE
 *      — that flag's own rename is a separate, lower-priority cleanup).
 */

const { resolveAndPushBatch, postFailureComment } = require('./lib/order-agent-common.cjs')

exports.handler = async (event) => {
  let batchId = null
  try {
    const headers = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    // TEMPORARY DUAL-READ (2026-10-24, remove once the Supabase-side
    // functions are confirmed redeployed under the new names — see the
    // naming-debt cutover note in order-agent-common.cjs): accepts EITHER
    // the renamed secret/header OR the pre-rename ones, so this Netlify
    // deploy can land before the still-live `grassland-order-webhook`
    // Supabase function (which is blocked on Dan setting
    // ORDER_AGENT_INTERNAL_SECRET by hand in the Supabase dashboard —
    // programmatic secret writes are paused there) gets redeployed, with
    // zero window where a real order handoff would 401.
    const expectedNew = process.env.ORDER_AGENT_INTERNAL_SECRET || ''
    const expectedOld = process.env.GRASSLAND_INTERNAL_SECRET || ''
    const got = headers['x-order-agent-internal-secret'] || headers['x-grassland-internal-secret'] || ''
    const expected = expectedNew || expectedOld
    const matches = (expectedNew && got === expectedNew) || (expectedOld && got === expectedOld)
    if (!expected || !matches) {
      // FIXED 2026-10-13 (real stall, cnv_1cmqpvx0/PO 0116897171): this used
      // to just warn+200 with nothing else — if the secret didn't match
      // (e.g. Netlify not yet redeployed with ORDER_AGENT_INTERNAL_SECRET),
      // the batch sat at 'parsed' forever with zero visible signal anywhere.
      console.error('[order-agent-resolve] bad or missing internal secret — ORDER_AGENT_INTERNAL_SECRET likely not set/redeployed on Netlify yet')
      return { statusCode: 200 }
    }

    let body
    try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 200 } }

    if (!body.batchId) {
      console.warn('[order-agent-resolve] missing batchId')
      return { statusCode: 200 }
    }
    batchId = body.batchId

    const result = await resolveAndPushBatch(batchId)
    console.log('[order-agent-resolve] result', JSON.stringify(result))
    return { statusCode: 200 }
  } catch (e) {
    // SAFETY NET (added 2026-10-13, same real stall): resolveAndPushBatch's
    // own branches all post a Front comment, but a genuinely unexpected
    // exception (MotherDuck connection drop, a real bug, etc.) used to just
    // get console.error'd here with no comment ever reaching Front — a
    // crash and a stuck-forever success looked identical from the thread.
    // This now always tells the thread SOMETHING happened, even if it
    // can't say exactly what, as long as we at least know which batch.
    console.error('[order-agent-resolve] unhandled error:', e.message)
    if (batchId) {
      await postFailureComment(batchId, `Order agent: an unexpected error stopped processing (batch ${batchId}). ${e.message}`).catch((err) => {
        console.error('[order-agent-resolve] also failed to post failure comment:', err.message)
      })
    }
    return { statusCode: 200 }
  }
}
