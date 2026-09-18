'use strict'

// DPI Monthly Process — line-persistence reconciliation.
//
// create_outbound_order_line gives no reliable success/failure signal
// (confirmed 2026-09-18: response comes back byte-identical whether a
// line persists or not), and MotherDuck has a real ~30-minute sync delay
// from Datex, so this can never be checked reliably inside the push
// itself (see dpi-monthly-shared.cjs and dpi-import-push-background.cjs
// for the full investigation, including an earlier same-day attempt at
// in-process verification that was built and then reverted once the real
// sync delay was confirmed — it checked far too soon and risked creating
// duplicate lines).
//
// This runs SEPARATELY, well after that delay (RECONCILE_AFTER_MINUTES,
// default 45 — a 15-minute safety margin), and compares what actually
// persisted in Datex against the ORIGINAL staged CSV data (dpi_staged_
// agencies), not against what the push function thought happened. Report-
// only: flags discrepancies for a human to act on (e.g. manually adding a
// missing line via the Datex UI, as already done during this
// investigation) rather than auto-backfilling — a deliberate choice per
// Dan, since auto-resubmission carries its own risks even at this safer
// timescale and hasn't been asked for.
//
// Scope: only dpi_import_batches rows with status='success'. 'failed' is
// already known-bad (flagged at push time with a specific error),
// 'duplicate_skipped' never created anything new, 'simulated' never
// touched Datex at all — none of those need this check.

const { runMotherDuckQuery } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const RECONCILE_AFTER_MINUTES = 45

function supabaseHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  }
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, { headers: supabaseHeaders() })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase GET ${path} failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return res.json()
}

async function supabasePatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`[dpi-reconciliation] Supabase PATCH ${path} failed (${res.status}): ${text.slice(0, 300)}`)
  }
}

// Finds dpi_import_batches rows eligible for reconciliation. See file
// header for why only status='success' rows qualify.
//
// ignoreAgeForTesting bypasses the 45-minute wait — used only by the
// -test entry point, so this can be exercised without waiting.
async function findEligibleBatchRows({ ignoreAgeForTesting = false, batchIdFilter = null } = {}) {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60 * 1000).toISOString()
  const filters = [
    'status=eq.success',
    'datex_order_id=not.is.null',
    'reconciliation_status=is.null',
  ]
  if (!ignoreAgeForTesting) filters.push(`updated_at=lt.${encodeURIComponent(cutoff)}`)
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)

  return supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
}

// Resolves the ORIGINAL staged CSV lines for a set of batch rows. Two
// hops required since dpi_import_batches has no foreign key to
// dpi_staged_agencies — batch_id (text) -> dpi_monthly_cycles.id ->
// dpi_staged_agencies.cycle_id + agency_number. Returns a Map keyed by
// the batch row's own id.
async function resolveExpectedLines(batchRows) {
  const uniqueBatchIds = [...new Set(batchRows.map((r) => r.batch_id))]
  if (uniqueBatchIds.length === 0) return new Map()

  const cycles = await supabaseGet(
    `/rest/v1/dpi_monthly_cycles?batch_id=in.(${uniqueBatchIds.join(',')})&select=id,batch_id`
  )
  const cycleIdByBatchId = new Map(cycles.map((c) => [c.batch_id, c.id]))
  const cycleIds = [...new Set(cycles.map((c) => c.id))]
  if (cycleIds.length === 0) return new Map()

  const staged = await supabaseGet(
    `/rest/v1/dpi_staged_agencies?cycle_id=in.(${cycleIds.join(',')})&select=cycle_id,agency_number,lines`
  )

  const linesByCycleAgency = new Map()
  for (const row of staged) {
    linesByCycleAgency.set(`${row.cycle_id}::${row.agency_number}`, row.lines || [])
  }

  const result = new Map()
  for (const row of batchRows) {
    const cycleId = cycleIdByBatchId.get(row.batch_id)
    if (cycleId == null) continue
    const lines = linesByCycleAgency.get(`${cycleId}::${row.agency_number}`)
    if (lines) result.set(row.id, lines)
  }
  return result
}

// Queries MotherDuck once for every order_id needing a check, grouped by
// (order_id, lookup_code) with quantities summed — `packaged_amount`
// holds the real persisted quantity (confirmed throughout this
// investigation; `expected_package_amount` is NULL on every real line).
async function fetchActualLines(orderIds) {
  if (orderIds.length === 0) return new Map()
  const rows = await runMotherDuckQuery(`
    SELECT ol.order_id, m.lookup_code, SUM(ol.packaged_amount) AS actual_qty
    FROM production_db.silver.datex_slv_orderlines ol
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = ol.material_id
    WHERE ol.order_id IN (${orderIds.join(',')})
    GROUP BY ol.order_id, m.lookup_code
  `)
  const byOrder = new Map() // order_id -> Map(lookup_code -> qty)
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, new Map())
    byOrder.get(row.order_id).set(String(row.lookup_code).trim(), Number(row.actual_qty) || 0)
  }
  return byOrder
}

// Compares expected (staged CSV) lines against actual (MotherDuck) lines
// for one order.
function compareLines(expectedLines, actualLineMap) {
  const actual = actualLineMap || new Map()
  const missing = []
  const wrongQty = []

  const expectedByCode = new Map()
  for (const line of expectedLines) {
    const code = String(line.materialLookupCode || '').trim()
    const qty = Number(line.quantity) || 0
    expectedByCode.set(code, (expectedByCode.get(code) || 0) + qty)
  }

  for (const [code, expectedQty] of expectedByCode) {
    const actualQty = actual.get(code)
    if (actualQty == null) {
      missing.push(`${code} (expected ${expectedQty})`)
    } else if (actualQty !== expectedQty) {
      wrongQty.push(`${code} (expected ${expectedQty}, found ${actualQty})`)
    }
  }

  if (missing.length === 0 && wrongQty.length === 0) {
    return { verified: true, details: null }
  }

  const parts = []
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
  if (wrongQty.length > 0) parts.push(`quantity mismatch: ${wrongQty.join(', ')}`)
  return { verified: false, details: parts.join(' | ') }
}

const FRONT_API_TOKEN = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const FRONT_STATUS_CONVERSATION_ID = 'cnv_1cboo2s4'

async function postReconciliationSummary(summary, isTest) {
  if (!FRONT_API_TOKEN) {
    console.error('[dpi-reconciliation] FRONT_API_TOKEN not configured — skipping status post')
    return
  }
  if (summary.checked === 0) return // nothing to report this run — no noise post

  const prefix = isTest ? '**DPI Monthly Reconciliation (manual test run)**' : '**DPI Monthly Reconciliation**'
  const mismatchLines = summary.mismatches
    .slice(0, 10)
    .map((m) => `- ${m.agency_name} (#${m.agency_number}, order ${m.datex_order_id}): ${m.details}`)
  const extra = summary.mismatches.length > 10 ? `\n...and ${summary.mismatches.length - 10} more` : ''

  const body =
    summary.mismatches.length === 0
      ? `${prefix}\nChecked ${summary.checked} order(s) pushed 45+ min ago — all verified complete against the original CSV.`
      : `${prefix}\nChecked ${summary.checked} order(s) pushed 45+ min ago — ${summary.verified} verified, ${summary.mismatches.length} with discrepancies:\n${mismatchLines.join('\n')}${extra}`

  try {
    await fetch(`https://api2.frontapp.com/conversations/${FRONT_STATUS_CONVERSATION_ID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FRONT_API_TOKEN}` },
      body: JSON.stringify({ body }),
    })
  } catch (err) {
    console.error('[dpi-reconciliation] Front status post failed:', err.message)
  }
}

// Runs one full reconciliation pass and posts the Front summary.
// isTest bypasses the 45-minute age gate; batchIdFilter scopes to one
// specific push (both -test-only conveniences).
async function runReconciliation(isTest = false, batchIdFilter = null) {
  const eligible = await findEligibleBatchRows({ ignoreAgeForTesting: isTest, batchIdFilter })
  if (eligible.length === 0) {
    return { ok: true, checked: 0, verified: 0, mismatches: [] }
  }

  const expectedByRowId = await resolveExpectedLines(eligible)
  const orderIds = [...new Set(eligible.map((r) => r.datex_order_id))]
  const actualByOrderId = await fetchActualLines(orderIds)

  let verifiedCount = 0
  const mismatches = []

  for (const row of eligible) {
    const expectedLines = expectedByRowId.get(row.id)

    if (!expectedLines) {
      // Couldn't resolve the original staged data — flag rather than
      // skip silently, since this means reconciliation itself is broken
      // for this row, not that the order is confirmed fine.
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'mismatch',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: 'Could not resolve original staged CSV lines for this agency — cycle/staged data may have been deleted.',
      })
      mismatches.push({
        agency_number: row.agency_number,
        agency_name: row.agency_name,
        datex_order_id: row.datex_order_id,
        details: 'original staged data not found',
      })
      continue
    }

    const { verified, details } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))

    await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
      reconciliation_status: verified ? 'verified' : 'mismatch',
      reconciliation_checked_at: new Date().toISOString(),
      reconciliation_details: details,
    })

    if (verified) {
      verifiedCount += 1
    } else {
      mismatches.push({
        agency_number: row.agency_number,
        agency_name: row.agency_name,
        datex_order_id: row.datex_order_id,
        details,
      })
    }
  }

  const summary = { ok: true, checked: eligible.length, verified: verifiedCount, mismatches }
  await postReconciliationSummary(summary, isTest)
  return summary
}

module.exports = { runReconciliation, RECONCILE_AFTER_MINUTES }
