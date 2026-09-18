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
// 2026-09-18 (self-healing rewrite): this originally ran report-only —
// flag discrepancies, let a human manually add missing lines via the
// Datex UI. A real 67-agency production push at 750ms/line came back
// 59/67 fully correct, 8/67 short by 1-5 lines each. Per Dan: import
// should be 100% accurate every time, and reconciliation should not
// require routine human intervention. No per-line delay value can be
// proven to reach exactly zero on an endpoint this unreliable, so this
// now SELF-HEALS instead of just reporting:
//   1. First check (45+ min after push, well past the real sync delay):
//      if lines are missing, automatically resubmit just the missing
//      ones (safe at this point — see the sync-delay note above; this is
//      a fundamentally different timing regime than the same-day
//      in-process attempt that was reverted). Row moves to
//      'backfilling', not 'mismatch'.
//   2. Second check (45+ min after the backfill attempt): re-verify. If
//      now clean, 'verified'. If still short and attempts remain, backfill
//      AGAIN with whatever's still missing. Only after MAX_BACKFILL_ATTEMPTS
//      genuine attempts does a row finally become 'mismatch' — the only
//      state that should ever need a human to look at it.
// A human is now only needed for the rare case where the SAME lines keep
// failing to persist across multiple real resubmission attempts, not for
// routine single-attempt drops.
//
// Scope: only dpi_import_batches rows with status='success'. 'failed' is
// already known-bad (flagged at push time with a specific error),
// 'duplicate_skipped' never created anything new, 'simulated' never
// touched Datex at all — none of those need this check.

const { runMotherDuckQuery, getMaterialMap, submitLines, FACILITIES } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const RECONCILE_AFTER_MINUTES = 45
// A gap surviving this many genuine backfill attempts (each spaced
// RECONCILE_AFTER_MINUTES apart) finally becomes a human-visible
// 'mismatch' — at that point the same lines have failed to persist
// across multiple real, independent resubmissions, which is a
// meaningfully different (and much rarer) situation than a single drop.
const MAX_BACKFILL_ATTEMPTS = 2
// Caps total lines backfilled in one invocation so this stays well under
// this function's ~26s timeout (LINE_CREATE_DELAY_MS alone is 750ms/line
// — 20 lines is 15s of pure delay, leaving headroom for the MotherDuck/
// Supabase calls around it). Anything over this cap is simply left
// untouched this run — its status/updated_at don't change, so it's
// immediately eligible again on the next 15-minute scheduled tick.
// Nothing is lost, it just may take one extra tick to get to.
const MAX_BACKFILL_LINES_PER_RUN = 20

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

// Rows never checked before. See file header for why only status='success'
// rows qualify. ignoreAgeForTesting bypasses the 45-minute wait — used
// only by the -test entry point.
async function findFreshEligibleRows({ ignoreAgeForTesting = false, batchIdFilter = null } = {}) {
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

// Rows where a backfill was attempted and are now old enough (45+ min
// since THAT attempt, not since the original push) to safely re-check
// against MotherDuck.
async function findBackfillingEligibleRows({ ignoreAgeForTesting = false, batchIdFilter = null } = {}) {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60 * 1000).toISOString()
  const filters = [
    'reconciliation_status=eq.backfilling',
  ]
  if (!ignoreAgeForTesting) filters.push(`reconciliation_backfilled_at=lt.${encodeURIComponent(cutoff)}`)
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
// for one order. Returns the missing lines as structured data (not just a
// display string) so the caller can actually resubmit them.
function compareLines(expectedLines, actualLineMap) {
  const actual = actualLineMap || new Map()
  const missingLines = [] // [{ code, quantity }]
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
      missingLines.push({ code, quantity: expectedQty })
    } else if (actualQty !== expectedQty) {
      // A quantity mismatch (as opposed to fully missing) is NOT safe to
      // "backfill" by submitting the difference — we don't know if this
      // reflects a genuine drop-and-partial-resubmit history, a real data
      // discrepancy, or something else. These always go straight to
      // 'mismatch' for a human to look at rather than being auto-healed.
      wrongQty.push(`${code} (expected ${expectedQty}, found ${actualQty})`)
    }
  }

  const verified = missingLines.length === 0 && wrongQty.length === 0
  const parts = []
  if (missingLines.length > 0) parts.push(`missing: ${missingLines.map((m) => `${m.code} (expected ${m.quantity})`).join(', ')}`)
  if (wrongQty.length > 0) parts.push(`quantity mismatch: ${wrongQty.join(', ')}`)

  return { verified, details: parts.length > 0 ? parts.join(' | ') : null, missingLines, hasQtyMismatch: wrongQty.length > 0 }
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

  // Auto-healed backfills are routine, working-as-intended behavior — not
  // something Dan needs to review — so they're mentioned only as a quiet
  // count, never itemized like genuine mismatches are. Genuine mismatches
  // (survived MAX_BACKFILL_ATTEMPTS) are the only thing this message
  // treats as needing attention.
  const healedNote = summary.healedByBackfill > 0
    ? ` (${summary.healedByBackfill} auto-corrected after a missing-line resubmission)`
    : ''
  const inProgressNote = summary.stillBackfilling > 0
    ? ` ${summary.stillBackfilling} more currently self-healing, will re-check automatically.`
    : ''

  const body =
    summary.mismatches.length === 0
      ? `${prefix}\nChecked ${summary.checked} order(s) — ${summary.verified} verified complete against the original CSV${healedNote}.${inProgressNote}`
      : `${prefix}\nChecked ${summary.checked} order(s) — ${summary.verified} verified${healedNote}, ${summary.mismatches.length} still short after ${MAX_BACKFILL_ATTEMPTS} resubmission attempts and need manual review:\n${mismatchLines.join('\n')}${extra}${inProgressNote}`

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

// Resubmits missingLines for one order via submitLines, using a starting
// line_number safely beyond the original expected count (avoids any
// possible collision with the original submission's numbering — line_number
// hasn't been shown to enforce real uniqueness, but there's no reason to
// risk it). Resolves material_ids fresh via getMaterialMap (cheap — it's
// module-level cached in dpi-monthly-shared.cjs after the first call).
async function backfillMissingLines(row, missingLines, expectedLineCount) {
  const cfg = FACILITIES[row.facility]
  if (!cfg) {
    return { ok: false, error: `Unknown facility "${row.facility}" — cannot backfill` }
  }
  const materialMap = await getMaterialMap(cfg.project_id)

  const resolved = []
  const unresolvable = []
  for (const line of missingLines) {
    const material_id = materialMap.get(line.code)
    if (material_id == null) {
      unresolvable.push(line.code)
      continue
    }
    resolved.push({ code: line.code, material_id, quantity: line.quantity })
  }
  if (resolved.length === 0) {
    return { ok: false, error: `None of the missing material codes resolved via MotherDuck: ${unresolvable.join(', ')}` }
  }

  const result = await submitLines(row.datex_order_id, row.shipment_id, cfg.packaging_id, resolved, expectedLineCount)
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  if (unresolvable.length > 0) {
    return { ok: true, submittedCount: resolved.length, partialWarning: `${unresolvable.length} missing code(s) could not be resolved and were skipped: ${unresolvable.join(', ')}` }
  }
  return { ok: true, submittedCount: resolved.length }
}

// Runs one full reconciliation pass (both fresh checks and backfill
// re-checks) and posts the Front summary. isTest bypasses the 45-minute
// age gates; batchIdFilter scopes to one specific push (both -test-only
// conveniences).
async function runReconciliation(isTest = false, batchIdFilter = null) {
  let linesBackfilledThisRun = 0
  let verifiedCount = 0
  let healedByBackfill = 0
  let stillBackfilling = 0
  const mismatches = []
  let checkedCount = 0

  // ── Phase 1: rows never checked before ────────────────────────────────
  const freshRows = await findFreshEligibleRows({ ignoreAgeForTesting: isTest, batchIdFilter })
  if (freshRows.length > 0) {
    const expectedByRowId = await resolveExpectedLines(freshRows)
    const orderIds = [...new Set(freshRows.map((r) => r.datex_order_id))]
    const actualByOrderId = await fetchActualLines(orderIds)

    for (const row of freshRows) {
      const expectedLines = expectedByRowId.get(row.id)

      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'Could not resolve original staged CSV lines for this agency — cycle/staged data may have been deleted.',
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
        checkedCount += 1
        continue
      }

      const { verified, details, missingLines, hasQtyMismatch } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      checkedCount += 1

      if (verified) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'verified',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: null,
        })
        verifiedCount += 1
        continue
      }

      // Quantity mismatches, or a row with no shipment_id stored (pushed
      // before this column existed), can't be safely auto-healed — go
      // straight to 'mismatch' for a human.
      if (hasQtyMismatch || row.shipment_id == null) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: row.shipment_id == null ? `${details} | cannot auto-backfill: no shipment_id stored for this order (pushed before backfill support existed)` : details,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details })
        continue
      }

      // Missing-only gap on a row we CAN backfill — attempt it now,
      // budget permitting.
      if (linesBackfilledThisRun + missingLines.length > MAX_BACKFILL_LINES_PER_RUN) {
        // Over budget this run — leave the row untouched (no status
        // change), so it's still eligible on the very next scheduled tick.
        continue
      }

      const backfillResult = await backfillMissingLines(row, missingLines, expectedLines.length)
      linesBackfilledThisRun += missingLines.length

      if (!backfillResult.ok) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | backfill attempt failed: ${backfillResult.error}`,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: `${details} (backfill failed: ${backfillResult.error})` })
        continue
      }

      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'backfilling',
        reconciliation_backfilled_at: new Date().toISOString(),
        reconciliation_backfill_count: 1,
        reconciliation_details: `Resubmitted ${backfillResult.submittedCount} missing line(s); will re-verify in ${RECONCILE_AFTER_MINUTES}+ min.${backfillResult.partialWarning ? ' ' + backfillResult.partialWarning : ''}`,
      })
      stillBackfilling += 1
    }
  }

  // ── Phase 2: rows currently self-healing, ready for re-check ──────────
  const backfillingRows = await findBackfillingEligibleRows({ ignoreAgeForTesting: isTest, batchIdFilter })
  if (backfillingRows.length > 0) {
    const expectedByRowId = await resolveExpectedLines(backfillingRows)
    const orderIds = [...new Set(backfillingRows.map((r) => r.datex_order_id))]
    const actualByOrderId = await fetchActualLines(orderIds)

    for (const row of backfillingRows) {
      const expectedLines = expectedByRowId.get(row.id)
      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'Could not resolve original staged CSV lines for this agency during backfill re-check.',
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
        checkedCount += 1
        continue
      }

      const { verified, details, missingLines, hasQtyMismatch } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      checkedCount += 1

      if (verified) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'verified',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: null,
        })
        verifiedCount += 1
        healedByBackfill += 1
        continue
      }

      const attemptsSoFar = row.reconciliation_backfill_count || 1
      const exhausted = hasQtyMismatch || attemptsSoFar >= MAX_BACKFILL_ATTEMPTS

      if (exhausted) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | still short after ${attemptsSoFar} backfill attempt(s) — needs manual review.`,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details })
        continue
      }

      if (linesBackfilledThisRun + missingLines.length > MAX_BACKFILL_LINES_PER_RUN) {
        continue // over budget this run — retry on the next tick, backfilled_at unchanged so it's still eligible immediately
      }

      const backfillResult = await backfillMissingLines(row, missingLines, expectedLines.length)
      linesBackfilledThisRun += missingLines.length

      if (!backfillResult.ok) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | second backfill attempt failed: ${backfillResult.error}`,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: `${details} (backfill failed: ${backfillResult.error})` })
        continue
      }

      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'backfilling',
        reconciliation_backfilled_at: new Date().toISOString(),
        reconciliation_backfill_count: attemptsSoFar + 1,
        reconciliation_details: `Resubmitted ${backfillResult.submittedCount} missing line(s) (attempt ${attemptsSoFar + 1}); will re-verify in ${RECONCILE_AFTER_MINUTES}+ min.${backfillResult.partialWarning ? ' ' + backfillResult.partialWarning : ''}`,
      })
      stillBackfilling += 1
    }
  }

  const summary = { ok: true, checked: checkedCount, verified: verifiedCount, healedByBackfill, stillBackfilling, mismatches }
  await postReconciliationSummary(summary, isTest)
  return summary
}

module.exports = { runReconciliation, RECONCILE_AFTER_MINUTES, MAX_BACKFILL_ATTEMPTS }
