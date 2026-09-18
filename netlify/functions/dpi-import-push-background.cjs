'use strict'

// DPI Monthly Process — Phase 1 push.
// Triggered by the /dpimonthly page's "Push N orders to Datex" button.
// Runs as a Netlify background function (not on a schedule, so the
// run/test/shared split used by digest functions doesn't apply here —
// this needs the background suffix purely because pushing many agencies
// sequentially against a live API can exceed a normal function's timeout).
//
// Background functions return a 202 immediately and do not send a response
// body back to the caller — the /dpimonthly page polls the dpi_import_batches
// table (via Supabase directly from the client, same pattern as everywhere
// else in this app) to show live progress instead of waiting on this call.
//
// 2026-09-18: SELF-CHAINING added. Netlify background functions have a
// hard, documented 15-minute (900s) execution ceiling — an AWS Lambda
// function that gets killed mid-run with no graceful wind-down if
// exceeded. A real full month's CSV import can total 1,000-1,500 lines
// across all agencies in one facility push, all processed sequentially —
// at any per-line delay large enough to matter for create_outbound_order_line
// reliability (see dpi-monthly-shared.cjs's investigation notes), that
// volume risks exceeding the ceiling in a single invocation. Rather than
// trying to pick one delay value that's both reliable AND always fits in
// 15 minutes at any volume, this function now tracks its own elapsed time
// and, if it's running low on budget, hands off whatever agencies remain
// to a fresh invocation of itself before exiting — so total volume no
// longer has any relationship to a single invocation's time limit.
//
// The dpi_import_batches "queued" rows (written up front, once, by the
// FIRST invocation only) are what make this safe: a continuation
// invocation is just handed the remaining agency objects directly (their
// full line data isn't persisted anywhere else, so it has to be passed
// along) and picks up exactly where the last one stopped — nothing is
// re-initialized, nothing is skipped. The /dpimonthly page's polling UI
// doesn't know or care how many actual function invocations produced the
// rows it's watching.
//
// Body: { batchId, facility, monthKey, agencies: [...], forceSimulate,
//         isContinuation, chainDepth } — see src/lib/dpiMonthlyParser.js
// for the exact agency shape `agencies` expects. isContinuation/chainDepth
// are only ever set by this function calling itself, never by the
// frontend.

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

// Leaves a real safety margin under Netlify's 900-second hard ceiling —
// covers final cleanup (postFrontSummary, or firing the next continuation)
// plus the fact that "elapsed since this invocation started" doesn't
// include Netlify's own cold-start/dispatch overhead before our code
// starts running.
const TIME_BUDGET_MS = 12 * 60 * 1000
// Bounds worst-case chaining if something is genuinely broken (e.g. every
// single call takes far longer than expected) — real volumes need at most
// 2-3 hops (see dpi-monthly-shared.cjs's delay math), this is a generous
// ceiling, not a target.
const MAX_CHAIN_DEPTH = 10

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

// Fires the next invocation in the chain and returns — does not wait for
// it to complete (it's a separate background function run). Same
// server-side self-call pattern as this app's other internal proxying
// (${process.env.URL}/.netlify/functions/...).
async function triggerContinuation({ batchId, facility, monthKey, forceSimulate }, remainingAgencies, chainDepth) {
  const baseUrl = process.env.URL || process.env.DEPLOY_URL
  if (!baseUrl) {
    console.error('[dpi-import-push] cannot chain — process.env.URL/DEPLOY_URL not set')
    return false
  }
  await fetch(`${baseUrl}/.netlify/functions/dpi-import-push-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId,
      facility,
      monthKey,
      forceSimulate,
      agencies: remainingAgencies,
      isContinuation: true,
      chainDepth: chainDepth + 1,
    }),
  }).catch((err) => {
    console.error('[dpi-import-push] failed to trigger continuation:', err.message)
  })
  return true
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
  const startedAt = Date.now()

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    console.error('[dpi-import-push] invalid JSON body')
    return
  }

  const { batchId, facility, monthKey, agencies, forceSimulate, isContinuation, chainDepth } = body
  const currentChainDepth = Number(chainDepth) || 0

  if (!batchId || !facility || !Array.isArray(agencies) || agencies.length === 0) {
    console.error('[dpi-import-push] missing batchId/facility/agencies — nothing to do')
    return
  }

  const cfg = FACILITIES[facility]
  if (!cfg) {
    console.error(`[dpi-import-push] unknown facility "${facility}"`)
    return
  }

  if (!isContinuation) {
    // Clear any rows from a previous ATTEMPT on this same batchId before
    // starting fresh — without this, retrying a failed push (same cycle,
    // same batch_id) accumulates duplicate historical rows instead of
    // replacing them, and the polling query returns stale entries
    // alongside the new attempt. Only the very first invocation in a
    // chain does this — a continuation must never touch rows the earlier
    // links in the chain already wrote.
    await fetch(`${SUPABASE_URL}/rest/v1/dpi_import_batches?batch_id=eq.${encodeURIComponent(batchId)}`, {
      method: 'DELETE',
      headers: supabaseHeaders(),
    }).catch((err) => {
      console.error('[dpi-import-push] failed to clear previous batch rows:', err.message)
    })

    // Write initial "queued" rows for EVERY agency in the full push up
    // front, so the polling UI can show the complete list immediately —
    // regardless of how many function invocations it takes to actually
    // work through them.
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
  } else {
    console.error(`[dpi-import-push] continuation invocation (chain depth ${currentChainDepth}), ${agencies.length} agencies remaining`)
  }

  // Simulate mode — either credentials genuinely aren't configured, or Dan
  // manually forced it (checkbox on the page) to keep testing downstream
  // flow while SmartUp credentials are present but not yet actually working
  // (e.g. Ethan's Azure work is partway done — isConfigured() can return
  // true while the real API still rejects every call). forceSimulate always
  // wins over isConfigured() so this is never dependent on guessing whether
  // Azure's current state happens to look "configured." No chaining needed
  // here — marking rows simulated has no real API delay regardless of volume.
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

  // Run these separately (not Promise.all) so a failure names which
  // subsystem broke — "This operation was aborted" alone gave no clue
  // whether it was MotherDuck's cold-start extension load or the SmartUp
  // duplicate-check call, and this always failed on the FIRST attempt
  // after a deploy/idle period, succeeding on retry once the container
  // was warm. getMaterialMap now retries its own cold-start case
  // internally (see dpi-monthly-shared.cjs); this still catches either
  // failing and says which one. Runs fresh on every invocation, including
  // continuations — module-level caches don't reliably survive across
  // separate function invocations.
  let materialMap
  let existingLookupCodes
  try {
    materialMap = await getMaterialMap(cfg.project_id)
  } catch (err) {
    console.error('[dpi-import-push] setup failed (materials):', err.message)
    for (const agency of agencies) {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'failed',
        error_message: `Setup failed before any orders were attempted (material resolution via MotherDuck): ${err.message}`,
      })
    }
    await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
    return
  }
  try {
    existingLookupCodes = await getExistingLookupCodes(cfg.project_id)
  } catch (err) {
    console.error('[dpi-import-push] setup failed (duplicate check):', err.message)
    for (const agency of agencies) {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'failed',
        error_message: `Setup failed before any orders were attempted (duplicate check via SmartUp API): ${err.message}`,
      })
    }
    await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
    return
  }

  for (let i = 0; i < agencies.length; i++) {
    // Time-budget check before starting each new agency — if there isn't
    // enough of this invocation's execution window left to be confident of
    // finishing safely, hand off everything from here on to a fresh
    // invocation instead of risking a mid-run kill (which would leave the
    // remaining agencies stuck at 'queued' forever with no final status).
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      const remaining = agencies.slice(i)
      if (currentChainDepth >= MAX_CHAIN_DEPTH) {
        console.error(`[dpi-import-push] MAX_CHAIN_DEPTH (${MAX_CHAIN_DEPTH}) reached with ${remaining.length} agencies still queued — not chaining further. Push is incomplete; these agencies need a manual retry.`)
        await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
        return
      }
      console.error(`[dpi-import-push] time budget reached with ${remaining.length}/${agencies.length} agencies left in this invocation — chaining to a new one.`)
      await triggerContinuation({ batchId, facility, monthKey, forceSimulate }, remaining, currentChainDepth)
      return // the continuation will finish the rest and post the final summary
    }

    const agency = agencies[i]

    if (existingLookupCodes.has(agency.lookupCode)) {
      await updateBatchRow(batchId, agency.lookupCode, { status: 'duplicate_skipped' })
      continue
    }

    const result = await createAgencyOrder(facility, agency, materialMap)

    if (result.success) {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'success',
        datex_order_id: result.order_id,
        shipment_id: result.shipment_id ?? null,
        total_quantity: totalQuantity(agency),
      })
    } else {
      await updateBatchRow(batchId, agency.lookupCode, {
        status: 'failed',
        datex_order_id: result.order_id ?? null,
        shipment_id: result.shipment_id ?? null,
        error_message: result.error,
      })
    }
  }

  // Only reached if this invocation finished every agency it was handed
  // without needing to chain — i.e. this is genuinely the last link.
  await postFrontSummary(facility, monthKey, await fetchBatchRows(batchId))
}
