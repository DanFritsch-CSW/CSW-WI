'use strict'

// DPI Monthly Process reconciliation — SCHEDULED TICK ONLY.
//
// 2026-09-19: converted from a regular scheduled function (26s hard
// timeout, per its old netlify.toml block) to a background function
// (-background suffix, up to 15 minutes) after confirmed live evidence
// of partial-batch processing: a 70-order Madison push only got 24
// orders observed at T+60, and one specific order (802337) sat
// completely unchecked with reconciliation_status still NULL all the
// way until the T+150 final sweep caught it fresh — meaning it was never
// even attempted at T+60 or T+90. One reconciliation invocation now runs
// three phases (observe, confirm+heal, final sweep) in sequence, each
// looping through up to a full batch of rows with two sequential
// Supabase round-trips per row (a claim PATCH, then a result PATCH) plus
// a MotherDuck query — for 70 rows that's up to 140+ sequential network
// calls in one invocation, comfortably capable of exceeding a 26-second
// budget on its own, and worse under a cold start (this app's own
// experience with the PUSH function needing a retry on its first attempt
// points at cold starts being a real, live cost in this environment, not
// a theoretical one). The old dpi-reconciliation-run.cjs file is left in
// place (no file-delete tool, same pattern as several other orphaned
// function files in this app — see netlify.toml's shortage-report-
// email-run.cjs comment for a matching example) but is now inert: its
// netlify.toml block is gone, so Netlify never invokes it on a schedule,
// and its own internal `x-netlify-event !== 'schedule'` guard means it
// can't be invoked directly either.
//
// Same split pattern as dvr-digest-run.cjs / fefo-digest-run.cjs / etc:
// Netlify blocks direct HTTP invocation of a function that carries a
// `schedule`, so this file handles the cron tick only. Manual runs (for
// testing without waiting for the real timing gates) go through
// dpi-reconciliation-test.cjs instead — that one stays a REGULAR
// (non-background) function on purpose: a manual test is something Dan
// is actively watching and wants a synchronous result from, and test
// runs are typically against smaller scopes than a full-batch scheduled
// tick, so the same risk doesn't apply there today. See
// lib/dpi-reconciliation-shared.cjs for the actual comparison logic and
// the full three-phase design writeup.

const { runReconciliation } = require('./lib/dpi-reconciliation-shared.cjs')

exports.handler = async function (event) {
  const isScheduled = event.headers?.['x-netlify-event'] === 'schedule'
  if (!isScheduled) {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Scheduled invocation only — use dpi-reconciliation-test for manual runs' }),
    }
  }
  try {
    const result = await runReconciliation(false)
    console.log('[dpi-reconciliation]', JSON.stringify(result))
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }
  } catch (err) {
    console.error('[dpi-reconciliation] error:', err.message)
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
