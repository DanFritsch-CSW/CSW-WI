'use strict'

// DPI Monthly Process reconciliation — MANUAL TEST ONLY.
//
// This function deliberately has NO `schedule` entry in netlify.toml, so
// Netlify allows a direct POST. Bypasses the 45-minute age gate (via
// runReconciliation's isTest flag) so this can be exercised right after a
// test push instead of waiting. NOT a dry run — really reads live
// MotherDuck data, really writes reconciliation_status back to
// dpi_import_batches, and really posts to Front if anything was checked.
//
// Optional POST body: { batchId } — scopes the check to one specific
// push instead of every eligible row across all cycles/facilities.

const { runReconciliation } = require('./lib/dpi-reconciliation-shared.cjs')

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'POST only' }) }
  }

  let batchId = null
  try {
    const body = JSON.parse(event.body || '{}')
    batchId = body.batchId || null
  } catch {
    // no body / invalid JSON — fine, just means "check everything eligible"
  }

  try {
    const result = await runReconciliation(true, batchId)
    console.log('[dpi-reconciliation-test]', JSON.stringify(result))
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }
  } catch (err) {
    console.error('[dpi-reconciliation-test] error:', err.message)
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: err.message }) }
  }
}
