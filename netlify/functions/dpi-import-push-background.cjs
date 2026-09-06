'use strict'

// DPI Monthly Process — Phase 1 push.
// Triggered by the /dpimonthly page's "Push N orders to Datex" button.
// Runs as a Netlify background function (not on a schedule, so the
// run/test/shared split used by digest functions doesn't apply here —
// this needs the background suffix purely because pushing ~60-70+ agencies
// sequentially against a live API can exceed a normal function's timeout).
//
// Background functions return a 202 immediately and do not send a response
// body back to the caller — the /dpimonthly page polls the dpi_import_batches
// table (via Supabase directly from the client, same pattern as everywhere
// else in this app) to show live progress instead of waiting on this call.
//
// Body: { batchId, facility, monthKey, agencies: [...] } — see
// src/lib/dpiMonthlyParser.js for the exact agency shape this expects.

const {
  FACILITIES,
  getMaterialMap,
  getExistingLookupCodes,
  createAgencyOrder,
} = require('./lib/dpi-monthly-shared.cjs')

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

function supabaseHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function insertBatchRow(row) {
  await fetch(`${SUPABASE_URL}/rest/v1/dpi_import_batches`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  }).catch((err) => {
    console.error('[dpi-import-push] failed to insert batch row:', err.message)
  })
}

async function updateBatchRow(batchId, lookupCode, patch) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/dpi_import_batches?batch_id=eq.${encodeURIComponent(batchId)}&lookup_code=eq.${encodeURIComponent(lookupCode)}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    }
  ).catch((err) => {
    console.error('[dpi-import-push] failed to update batch row:', err.message)
  })
}

exports.handler = async function (event) {
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    console.error('[dpi-import-push] invalid JSON body')
    return
  }

  const { batchId, facility, monthKey, agencies } = body

  if (!batchId || !facility || !Array.isArray(agencies) || agencies.length === 0) {
    console.error('[dpi-import-push] missing batchId/facility/agencies — nothing to do')
    return
  }

  const cfg = FACILITIES[facility]
  if (!cfg) {
    console.error(`[dpi-import-push] unknown facility "${facility}"`)
    return
  }

  // Write initial "queued" rows for every agency up front, so the polling
  // UI can show the full list immediately rather than rows appearing one
  // at a time as they're processed.
  for (const agency of agencies) {
    await insertBatchRow({
      batch_id: batchId,
      facility,
      month_key: monthKey,
      agency_number: agency.agencyNumber,
      agency_name: agency.agencyName,
      first_name_sent: agency.firstName,
      lookup_code: agency.lookupCode,
      line_count: agency.lines.length,
      status: 'queued',
    })
  }

  let materialMap
  let existingLookupCodes
  try {
    ;[materialMap, existingLookupCodes] = await Promise.all([
      getMaterialMap(cfg.project_id),
      getExistingLookupCodes(cfg.project_id),
    ])
  } catch (err) {
    // Can't resolve materials or check duplicates — fail the whole batch
    // loudly rather than push blind guesses at Datex.
    console.error('[dpi-import-push] setup failed:', err.message)
    for (const agency of agencies) {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'failed',
        error_message: `Setup failed before any orders were attempted: ${err.message}`,
      })
    }
    return
  }

  for (const agency of agencies) {
    if (existingLookupCodes.has(agency.lookupCode)) {
      await updateBatchRow(batchId, agency.lookupCode, { status: 'duplicate_skipped' })
      continue
    }

    const result = await createAgencyOrder(facility, agency, materialMap)

    if (result.success) {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'success',
        datex_order_id: result.order_id,
      })
    } else {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'failed',
        datex_order_id: result.order_id ?? null,
        error_message: result.error,
      })
    }
  }
}
