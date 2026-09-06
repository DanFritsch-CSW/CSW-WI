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
  isConfigured,
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

function totalQuantity(agency) {
  return agency.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)
}

async function fetchBatchRows(batchId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/dpi_import_batches?batch_id=eq.${encodeURIComponent(batchId)}`,
    { headers: supabaseHeaders() }
  ).catch((err) => {
    console.error('[dpi-import-push] failed to fetch batch rows for summary:', err.message)
    return null
  })
  if (!res || !res.ok) return []
  return res.json().catch(() => [])
}

// Posts a one-line completion summary to the internal DPI status thread —
// direct send, not a draft (internal-only, informational, no external
// recipient risk — same posture as the existing CAL Appointments daily
// digest to cnv_1c7dl7mc). Never blocks/fails the push itself if this
// errors — a missed status ping shouldn't be treated the same as a failed
// Datex order.
//
// Confirmed 2026-09-06 against front-draft-shared.cjs's createFrontComment:
// POST /conversations/{id}/comments with { body: <string> } is the right
// shape for an internal-only note — no draft, no recipient resolution
// needed (this isn't a reply to a customer thread).
const FRONT_API_TOKEN = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const FRONT_STATUS_CONVERSATION_ID = 'cnv_1cboo2s4'

async function postFrontSummary(facility, monthKey, rows) {
  if (!FRONT_API_TOKEN) {
    console.error('[dpi-import-push] FRONT_API_TOKEN not configured — skipping status post')
    return
  }
  const success = rows.filter((r) => r.status === 'success' || r.status === 'simulated')
  const duplicates = rows.filter((r) => r.status === 'duplicate_skipped').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const totalCases = success.reduce((sum, r) => sum + (Number(r.total_quantity) || 0), 0)
  const simulated = rows.some((r) => r.status === 'simulated')

  const body = simulated
    ? `**DPI Monthly — ${facility}, ${monthKey}**\nPhase 1 simulated (Datex credentials not yet configured): ${rows.length} agencies parsed, no real orders created.`
    : `**DPI Monthly — ${facility}, ${monthKey}**\nPhase 1 complete: ${success.length} agencies, ${success.length} orders created, ${totalCases.toLocaleString()} cases total.\n${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped, ${failed} failed.`

  try {
    await fetch(`https://api2.frontapp.com/conversations/${FRONT_STATUS_CONVERSATION_ID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FRONT_API_TOKEN}` },
      body: JSON.stringify({ body }),
    })
  } catch (err) {
    console.error('[dpi-import-push] Front status post failed:', err.message)
  }
}

exports.handler = async function (event) {
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    console.error('[dpi-import-push] invalid JSON body')
    return
  }

  const { batchId, facility, monthKey, agencies, forceSimulate } = body

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
      total_quantity: totalQuantity(agency),
      status: 'queued',
    })
  }

  // Simulate mode — either credentials genuinely aren't configured, or Dan
  // manually forced it (checkbox on the page) to keep testing downstream
  // flow while SmartUp credentials are present but not yet actually working
  // (e.g. Ethan's Azure work is partway done — isConfigured() can return
  // true while the real API still rejects every call). forceSimulate always
  // wins over isConfigured() so this is never dependent on guessing whether
  // Azure's current state happens to look "configured."
  if (forceSimulate || !isConfigured()) {
    const reason = forceSimulate
      ? 'Manually forced to simulate — no real order was created.'
      : 'Datex SmartUp credentials not configured — no real order was created. Waiting on Azure app registration access.'
    for (const agency of agencies) {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'simulated',
        error_message: reason,
      })
    }
    await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
    return
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
    await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
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
        total_quantity: totalQuantity(agency),
      })
    } else {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'failed',
        datex_order_id: result.order_id ?? null,
        error_message: result.error,
      })
    }
  }

  await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
}
