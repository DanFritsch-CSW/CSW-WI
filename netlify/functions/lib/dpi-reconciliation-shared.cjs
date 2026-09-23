'use strict'

// DPI Monthly Process — line-persistence reconciliation.
//
// create_outbound_order_line gives no reliable success/failure signal
// (confirmed 2026-09-18: response comes back byte-identical whether a
// line persists or not), and MotherDuck has a real, NON-deterministic
// sync delay from Datex — typically well under 30 minutes, but confirmed
// live to run 80+ minutes for an isolated straggler line, and twice to
// exceed 2.5 HOURS for an entire batch — so this can never be checked
// reliably inside the push itself (see dpi-monthly-shared.cjs and
// dpi-import-push-background.cjs for the full investigation, including
// an earlier same-day attempt at in-process verification that was built
// and then reverted once the real sync delay was confirmed).
//
// ── 2026-09-21 RESTRUCTURE (current design) ──────────────────────────
// Per Dan, after watching several real runs: T+150 is the first moment
// the replica has reliably shown a COMPLETE picture of a batch. Earlier
// checkpoints repeatedly saw partial data (a 2026-09-21 run observed
// only 50 of 70 orders at T+60 while T+150 saw all 70 cleanly), and the
// previous design's habit of ACTING on those early partial reads is
// what produced every duplicate-line incident in this system's history:
// a line that merely hasn't synced looks identical to a missing one, and
// there is no way to submit a line "only if it doesn't already exist."
//
// So the structure now separates LOOKING from ACTING, and gives every
// write a full replica-lag cycle before it's judged:
//
//   T+60 min       — EARLY LOOK. Purely informational. Reads the replica,
//                    posts a heads-up about how the batch appears so far,
//                    and changes NOTHING: no status writes, no Datex
//                    writes. Its only durable effect is stamping
//                    early_look_at so it doesn't repeat every tick. A
//                    partial or alarming picture here is expected and
//                    explicitly labeled as such.
//   T+150 min      — FIRST RECONCILIATION + HEAL. The first checkpoint
//                    that is allowed to change anything. Clean →
//                    'verified'. Missing lines only → resubmit them once
//                    and mark 'backfilling'. Quantity mismatch or no
//                    shipment_id → 'mismatch' (never auto-healed; see
//                    compareLines).
//   heal + 150 min — POST-HEAL VALIDATION. Measured from the HEAL, not
//                    from the push (Dan's explicit choice): a backfilled
//                    line needs the same replica-lag allowance any other
//                    write does, and anchoring to a fixed T+300 would
//                    silently shrink that window whenever a heal ran late
//                    (budget caps, a skipped tick). Confirmed live
//                    2026-09-21: the 2 orders healed at T+90 were exactly
//                    the 2 still showing short at T+150 — the resubmitted
//                    lines simply hadn't surfaced yet. Clean → 'verified'.
//                    Still short → heal once more, up to
//                    MAX_BACKFILL_ATTEMPTS, then 'mismatch' for a human.
//   (all settled)  — FINAL SWEEP. Fires once a cycle has no rows left in
//                    a working state, so it can't contradict a heal
//                    that's still in flight. One authoritative re-check
//                    of every order, and the single message meant to be
//                    trusted as the final word on a push.
//
// Two safeguards apply to every phase that reads the replica:
//   SYNC FRESHNESS PROBE (fetchBatchSyncState) — before doing any
//     comparison work, ask the replica directly whether this batch's
//     lines exist AT ALL. Zero → the replica is provably behind for this
//     batch, so skip it entirely this tick rather than comparing against
//     data that isn't there. Cheap (one count), decisive, and it runs
//     before anything expensive or destructive.
//   BATCH HEALTH — a batch where almost nothing verifies is far more
//     likely mid-sync than genuinely 100% broken; real per-order drop
//     rates have never exceeded ~12% of a batch. Gates healing and the
//     final sweep's willingness to declare. Judged from THIS RUN's own
//     comparisons in the first-reconcile phase (see the pre-pass there
//     — judging from stored status can't work in a phase that is itself
//     the thing writing those statuses), and from stored status in the
//     final sweep, where every row genuinely has settled by then.
//
// Scope: only dpi_import_batches rows with status='success'. 'failed' is
// already known-bad (flagged at push time with a specific error),
// 'duplicate_skipped' never created anything new, 'simulated' never
// touched Datex at all — none of those need this check.
//
// Whole-batch gating: a real push can span ~15 minutes end-to-end
// (orders processed sequentially, each with its own updated_at). Phases
// keyed to the push gate on the batch's most-recently-pushed row, so a
// push is always checked and reported as one complete unit rather than
// dribbled across messages. Post-heal validation is deliberately
// per-ROW, since each row's heal has its own independent clock.

const { runMotherDuckQuery, getMaterialMap, submitLines, FACILITIES } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

// Look-only heads-up. Early enough to be useful as a signal, with no
// authority to act on what it sees.
const EARLY_LOOK_AFTER_MINUTES = 60
// The first checkpoint allowed to change anything — chosen because this
// is the first point real runs have consistently shown a complete batch.
const FIRST_RECONCILE_AFTER_MINUTES = 150
// How long a resubmitted line gets to surface in the replica before it's
// judged. Measured from the heal itself, not from the push.
const POST_HEAL_VALIDATE_AFTER_MINUTES = 150
// A gap surviving this many genuine, independently-validated heal
// attempts becomes a human-visible 'mismatch'. Each attempt is separated
// by a full POST_HEAL_VALIDATE_AFTER_MINUTES window, so this is a much
// stronger signal than repeated same-tick retries would be.
const MAX_BACKFILL_ATTEMPTS = 2
// Outer cap on how long the final sweep will keep waiting for a cycle to
// settle. Past this, it reports whatever it can see, explicitly flagged
// as unconfirmed — deferring forever would mean a genuinely broken batch
// never gets reported at all. Sized to clear the full worst-case path
// (T+150 heal, +150 validate, +150 second validate = T+450) with margin.
const FINAL_SWEEP_MAX_DEFER_MINUTES = 14 * 60
// Caps total lines backfilled in one invocation. Anything over this cap
// is simply left for the next tick — its state doesn't change, so
// nothing is lost, it just may take one extra tick to get to.
const MAX_BACKFILL_LINES_PER_RUN = 20

// A batch where almost nothing verifies is far more likely mid-sync than
// genuinely 100% broken (real per-order drop rates have never exceeded
// ~12% of a batch — 8/67, the worst on record), so the ratio sits well
// above that to avoid ever second-guessing genuine per-order gaps. Below
// the minimum size, percentages are too noisy to mean anything.
const BATCH_HEALTH_MIN_SIZE = 10
const BATCH_HEALTH_MIN_VERIFIED_RATIO = 0.5

// Statuses meaning "this row still has work in flight." Used to decide
// when a cycle has settled and the final sweep may run. NULL also counts
// as non-terminal and is checked separately.
const NON_TERMINAL_STATUSES = ['checking', 'backfilling', 'pending_confirmation']

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

// Atomically claims one row by PATCHing it with a filter matching its
// CURRENT status — Postgres applies that filter as part of the same
// UPDATE, so if two invocations race for the same row, only the one
// whose PATCH lands first actually matches; the second gets an empty
// array back. Confirmed live 2026-09-19: two reconciliation invocations
// running close together, with no lock at all, split a 70-order batch's
// processing between them — harmless that time by luck, but nothing
// prevented them from grabbing the SAME row, which would risk a
// duplicate backfill. 'checking' is transitional and always overwritten
// with a real outcome by the end of processing that row.
//
// claimed_at (2026-09-23 fix) is a dedicated column stamped by this PATCH
// — updated_at is NOT a reliable proxy for claim age (confirmed: a row
// repeatedly claimed still showed its original push-time updated_at, not
// the claim time), so orphan detection below could never actually measure
// how long a row had been claimed, and with concurrent invocations risked
// resetting a still-live claim, defeating the lock this function exists
// to provide.
async function claimRow(rowId, fromStatusFilter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dpi_import_batches?id=eq.${rowId}&${fromStatusFilter}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ reconciliation_status: 'checking', claimed_at: new Date().toISOString() }),
  })
  if (!res.ok) return false
  const rows = await res.json().catch(() => [])
  return Array.isArray(rows) && rows.length > 0
}

// Same claim pattern on dpi_monthly_cycles — gates the final sweep so
// two invocations can't both run (and both post) it for one cycle.
async function claimCycleForFinalSweep(cycleId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dpi_monthly_cycles?id=eq.${cycleId}&final_sweep_at=is.null`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ final_sweep_at: new Date().toISOString() }),
  })
  if (!res.ok) return false
  const rows = await res.json().catch(() => [])
  return Array.isArray(rows) && rows.length > 0
}

// Of the given batch_ids, which have EVERY 'success' row at least
// `minutesThreshold` old — i.e. the batch's most-recently-pushed row has
// crossed that age, so none of its rows can be younger.
async function batchesPastPushThreshold(batchIds, minutesThreshold) {
  if (batchIds.length === 0) return new Set()
  const rows = await supabaseGet(
    `/rest/v1/dpi_import_batches?status=eq.success&batch_id=in.(${batchIds.map((id) => encodeURIComponent(id)).join(',')})&select=batch_id,updated_at`
  )
  const latestByBatch = new Map()
  for (const row of rows) {
    const t = new Date(row.updated_at).getTime()
    const prev = latestByBatch.get(row.batch_id)
    if (prev == null || t > prev) latestByBatch.set(row.batch_id, t)
  }
  const cutoffMs = Date.now() - minutesThreshold * 60 * 1000
  return new Set([...latestByBatch.entries()].filter(([, t]) => t < cutoffMs).map(([id]) => id))
}

// Resolves the ORIGINAL staged CSV lines for a set of batch rows. Two
// hops required since dpi_import_batches has no foreign key to
// dpi_staged_agencies — batch_id (text) -> dpi_monthly_cycles.id ->
// dpi_staged_agencies.cycle_id + agency_number.
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

// Per-material actuals. `packaged_amount` holds the real persisted
// quantity (confirmed throughout this investigation;
// `expected_package_amount` is NULL on every real line).
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

// Cheap per-order line counts. Used to describe results accurately —
// "has 10 of 12 lines" vs "no lines at all yet" read identically in the
// old per-material-only output, and they're the difference between a
// real 2-minute fix and a false alarm.
async function fetchActualLineCounts(orderIds) {
  if (orderIds.length === 0) return new Map()
  const rows = await runMotherDuckQuery(`
    SELECT ol.order_id, count(*) AS line_count
    FROM production_db.silver.datex_slv_orderlines ol
    WHERE ol.order_id IN (${orderIds.join(',')})
    GROUP BY ol.order_id
  `)
  const byOrder = new Map()
  for (const row of rows) byOrder.set(row.order_id, Number(row.line_count) || 0)
  return byOrder
}

// Does this batch's data exist in the replica AT ALL? One cheap count.
// Answers only "has it arrived," not "is it complete" — a batch can pass
// this and still be mid-sync. It exists to catch the total-stall case
// unambiguously before anything expensive or destructive runs.
async function fetchBatchSyncState(orderIds) {
  if (orderIds.length === 0) return { anyLinesPresent: false, ordersWithLines: 0 }
  const rows = await runMotherDuckQuery(`
    SELECT count(DISTINCT ol.order_id) AS orders_with_lines
    FROM production_db.silver.datex_slv_orderlines ol
    WHERE ol.order_id IN (${orderIds.join(',')})
  `)
  const ordersWithLines = Number(rows?.[0]?.orders_with_lines) || 0
  return { anyLinesPresent: ordersWithLines > 0, ordersWithLines }
}

// NOTE (2026-09-21): a computeBatchHealth() helper used to live here,
// reading reconciliation_status from the database to judge whether a
// batch looked systemically stalled. It was removed because reading
// stored state is exactly what made it wrong in this design — see the
// batch-health pre-pass in runFirstReconcilePhase for the replacement
// (health judged from this run's own comparisons) and the inline ratio
// check in runFinalSweepPhase, which reads stored state legitimately
// since by then every row genuinely has a settled status.

// Splits `rows` into those whose batch has data in the replica and those
// whose batch doesn't. Shared by every phase that reads the replica.
async function partitionBySyncState(rows, phaseLabel) {
  const rowsByBatch = new Map()
  for (const row of rows) {
    if (!rowsByBatch.has(row.batch_id)) rowsByBatch.set(row.batch_id, [])
    rowsByBatch.get(row.batch_id).push(row)
  }
  const syncedRows = []
  let stalledBatches = 0
  for (const [batchId, batchRows] of rowsByBatch) {
    const batchOrderIds = [...new Set(batchRows.map((r) => r.datex_order_id).filter((id) => id != null))]
    const syncState = await fetchBatchSyncState(batchOrderIds)
    if (!syncState.anyLinesPresent) {
      console.error(`[dpi-reconciliation] ${phaseLabel}, batch ${batchId}: 0 of ${batchOrderIds.length} orders have any lines in MotherDuck yet — replica behind, skipping this tick`)
      stalledBatches += 1
      continue
    }
    syncedRows.push(...batchRows)
  }
  return { syncedRows, stalledBatches }
}

// Compares expected (staged CSV) against actual (MotherDuck) for one
// order. Returns missing lines as structured data so the caller can
// actually resubmit them.
function compareLines(expectedLines, actualLineMap) {
  const actual = actualLineMap || new Map()
  const missingLines = []
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
      // "backfill" by submitting the difference — we don't know if it
      // reflects a drop-and-partial-resubmit history, a real data
      // discrepancy, or something else. Always goes to a human.
      wrongQty.push(`${code} (expected ${expectedQty}, found ${actualQty})`)
    }
  }

  const verified = missingLines.length === 0 && wrongQty.length === 0
  const parts = []
  if (missingLines.length > 0) parts.push(`missing: ${missingLines.map((m) => `${m.code} (expected ${m.quantity})`).join(', ')}`)
  if (wrongQty.length > 0) parts.push(`quantity mismatch: ${wrongQty.join(', ')}`)

  return { verified, details: parts.length > 0 ? parts.join(' | ') : null, missingLines, hasQtyMismatch: wrongQty.length > 0 }
}

// Resubmits missingLines for one order, using a starting line_number
// beyond the original expected count (avoids any possible collision with
// the original submission's numbering). Resolves material_ids fresh via
// getMaterialMap (module-level cached after the first call).
async function backfillMissingLines(row, missingLines, expectedLineCount) {
  const cfg = FACILITIES[row.facility]
  if (!cfg) return { ok: false, error: `Unknown facility "${row.facility}" — cannot backfill` }
  const materialMap = await getMaterialMap(cfg.project_id)

  const resolved = []
  const unresolvable = []
  for (const line of missingLines) {
    const material_id = materialMap.get(line.code)
    if (material_id == null) { unresolvable.push(line.code); continue }
    resolved.push({ code: line.code, material_id, quantity: line.quantity })
  }
  if (resolved.length === 0) {
    return { ok: false, error: `None of the missing material codes resolved via MotherDuck: ${unresolvable.join(', ')}` }
  }

  const result = await submitLines(row.datex_order_id, row.shipment_id, cfg.packaging_id, resolved, expectedLineCount)
  if (!result.ok) return { ok: false, error: result.error }
  if (unresolvable.length > 0) {
    return { ok: true, submittedCount: resolved.length, partialWarning: `${unresolvable.length} missing code(s) could not be resolved and were skipped: ${unresolvable.join(', ')}` }
  }
  return { ok: true, submittedCount: resolved.length }
}

const FRONT_API_TOKEN = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const FRONT_STATUS_CONVERSATION_ID = 'cnv_1cboo2s4'

// 2026-09-23 fix — postToFront never checked res.ok, so a 4xx/5xx from
// Front was silently swallowed: the fetch resolved, the function
// returned normally, and nothing downstream (including the caller) had
// any way to know the message never posted. Confirmed live 2026-09-22:
// both the Madison and Eau Claire final sweeps completed and recorded
// the correct verdict in final_sweep_details, but neither Front message
// ever appeared, with no error anywhere in the prior code. Logging the
// status and response body on failure is the fix — next occurrence, the
// Netlify function log will state Front's actual objection instead of
// this needing to be re-diagnosed from scratch.
async function postToFront(body) {
  if (!FRONT_API_TOKEN) {
    console.error('[dpi-reconciliation] FRONT_API_TOKEN not configured — skipping status post')
    return
  }
  try {
    const res = await fetch(`https://api2.frontapp.com/conversations/${FRONT_STATUS_CONVERSATION_ID}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FRONT_API_TOKEN}` },
      body: JSON.stringify({ body }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error(`[dpi-reconciliation] Front post FAILED (${res.status}): ${errBody.slice(0, 500)}`)
    }
  } catch (err) {
    console.error('[dpi-reconciliation] Front status post failed:', err.message)
  }
}

// 2026-09-21 fix — orphaned 'checking' rows. claimRow sets 'checking'
// as a transitional marker that every code path overwrites with a real
// outcome milliseconds later. But if an invocation dies mid-row — a
// crash, a platform timeout, or a human interrupting a test run (which
// is exactly what happened 2026-09-21, leaving Trinity Lutheran #457961
// stuck for 1h42m) — that row is stranded: no phase queries for
// 'checking', so nothing ever picks it up again, and because 'checking'
// counts as non-terminal the FINAL SWEEP waits on it too. One orphan
// silently blocks a whole cycle's closing report until the 14-hour cap
// forces it out.
//
// Since a legitimate 'checking' lasts milliseconds, anything older than
// this threshold is definitionally orphaned. Resetting it to NULL puts
// it back in the first-reconcile queue with no other state to unwind —
// the row simply gets checked again on the next tick, as if it had
// never been claimed. Deliberately generous (15 min) so it can never
// race a genuinely in-flight invocation.
const ORPHANED_CHECKING_AFTER_MINUTES = 15

// 2026-09-23 fix — this used to key off updated_at, which claimRow does
// NOT reliably touch on its own (confirmed: a repeatedly-claimed row
// still showed push-time updated_at). That meant this function could
// never actually measure claim age, and worse, with concurrent
// invocations it could reset a genuinely live claim — defeating the very
// lock claimRow exists to provide. Now reads the dedicated claimed_at
// column, stamped only by claimRow's PATCH.
async function recoverOrphanedCheckingRows() {
  const cutoff = new Date(Date.now() - ORPHANED_CHECKING_AFTER_MINUTES * 60 * 1000).toISOString()
  const stranded = await supabaseGet(
    `/rest/v1/dpi_import_batches?reconciliation_status=eq.checking&claimed_at=lt.${encodeURIComponent(cutoff)}&select=id,agency_number,agency_name,batch_id`
  )
  if (stranded.length === 0) return 0
  for (const row of stranded) {
    console.error(`[dpi-reconciliation] recovering orphaned 'checking' row ${row.id} (${row.agency_name} #${row.agency_number}, batch ${row.batch_id}) — stuck past ${ORPHANED_CHECKING_AFTER_MINUTES}min, resetting for re-check`)
    await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}&reconciliation_status=eq.checking`, { reconciliation_status: null, claimed_at: null })
  }
  return stranded.length
}

// ── Phase A: EARLY LOOK (T+60) ───────────────────────────────────────
// Informational only. Never writes a reconciliation_status, never writes
// to Datex. Its one durable effect is stamping early_look_at so it
// doesn't repeat. Deliberately powerless: real runs have repeatedly
// shown the replica holding a partial picture at this point (50 of 70
// orders on 2026-09-21), and every duplicate-line incident in this
// system traces back to an earlier design ACTING on exactly that kind of
// incomplete read.
async function runEarlyLookPhase(isTest, batchIdFilter) {
  const filters = ['status=eq.success', 'datex_order_id=not.is.null', 'reconciliation_status=is.null', 'early_look_at=is.null']
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)
  const candidates = await supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
  if (candidates.length === 0) return null

  let rows = candidates
  if (!isTest) {
    const batchIds = [...new Set(candidates.map((r) => r.batch_id))]
    const ready = await batchesPastPushThreshold(batchIds, EARLY_LOOK_AFTER_MINUTES)
    rows = candidates.filter((r) => ready.has(r.batch_id))
  }
  if (rows.length === 0) return null

  const { syncedRows } = await partitionBySyncState(rows, 'early look')
  if (syncedRows.length === 0) return null

  const expectedByRowId = await resolveExpectedLines(syncedRows)
  const orderIds = [...new Set(syncedRows.map((r) => r.datex_order_id))]
  const actualCountByOrderId = await fetchActualLineCounts(orderIds)

  const facilities = new Set()
  let lookedComplete = 0
  let lookedShort = 0
  let noLinesYet = 0

  const stampedAt = new Date().toISOString()
  for (const row of syncedRows) {
    facilities.add(row.facility)
    const expectedLines = expectedByRowId.get(row.id)
    const actualCount = actualCountByOrderId.get(row.datex_order_id) || 0
    if (!expectedLines) continue
    if (actualCount === 0) noLinesYet += 1
    else if (actualCount >= expectedLines.length) lookedComplete += 1
    else lookedShort += 1

    // early_look_at only — reconciliation_status is deliberately left
    // untouched so Phase B still treats this row as brand new.
    await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, { early_look_at: stampedAt })
  }

  return { total: syncedRows.length, lookedComplete, lookedShort, noLinesYet, facilities: [...facilities] }
}

// ── Phase B: FIRST RECONCILIATION + HEAL (T+150) ─────────────────────
// The first checkpoint with authority to change anything. Chosen because
// T+150 is the first point real runs have consistently shown a complete
// batch in the replica.
async function runFirstReconcilePhase(isTest, batchIdFilter) {
  const empty = { checked: 0, verified: 0, healed: 0, deferred: 0, stalledBatches: 0, mismatches: [], facilities: [] }
  const filters = ['status=eq.success', 'datex_order_id=not.is.null', 'reconciliation_status=is.null']
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)
  const candidates = await supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
  if (candidates.length === 0) return empty

  let rows = candidates
  if (!isTest) {
    const batchIds = [...new Set(candidates.map((r) => r.batch_id))]
    const ready = await batchesPastPushThreshold(batchIds, FIRST_RECONCILE_AFTER_MINUTES)
    rows = candidates.filter((r) => ready.has(r.batch_id))
  }
  if (rows.length === 0) return empty

  const partitioned = await partitionBySyncState(rows, 'first reconcile')
  if (partitioned.syncedRows.length === 0) return { ...empty, stalledBatches: partitioned.stalledBatches }
  rows = partitioned.syncedRows
  const stalledBatches = partitioned.stalledBatches

  const expectedByRowId = await resolveExpectedLines(rows)
  const orderIds = [...new Set(rows.map((r) => r.datex_order_id))]
  const actualByOrderId = await fetchActualLines(orderIds)

  // 2026-09-21 fix — batch-health bootstrapping. computeBatchHealth reads
  // reconciliation_status from the DATABASE, which worked in the old
  // design because a separate earlier phase had already marked rows
  // 'verified' before healing was considered. In this design, THIS phase
  // is the one that does the verifying, so at the moment it runs every
  // row is still NULL — the ratio is always 0/N, every batch looks like
  // a total sync stall, and healing gets deferred on the first pass no
  // matter how healthy the batch actually is. Confirmed live 2026-09-21:
  // a batch that was 68/70 fine deferred both of its genuinely-short
  // rows, then healed them a tick later once the 68 had been written as
  // 'verified'. Correct behavior, but a wasted cycle and a misleading
  // "looks like a sync stall" message.
  //
  // So the health signal now comes from a read-only PRE-PASS over this
  // run's own comparisons: compare every row first, count how many come
  // out clean, and use THAT ratio to decide whether the batch looks
  // trustworthy enough to heal against. Same threshold, same intent —
  // just sourced from what this run actually observed rather than from
  // state it hasn't written yet. Cheap: the comparisons are pure
  // in-memory work over data already fetched above.
  const preflightByBatch = new Map()
  const preflightByRowId = new Map()
  for (const row of rows) {
    const expectedLines = expectedByRowId.get(row.id)
    if (!expectedLines) continue
    const result = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
    preflightByRowId.set(row.id, result)
    if (!preflightByBatch.has(row.batch_id)) preflightByBatch.set(row.batch_id, { total: 0, verifiedCount: 0 })
    const entry = preflightByBatch.get(row.batch_id)
    entry.total += 1
    if (result.verified) entry.verifiedCount += 1
  }
  const batchHealth = new Map()
  for (const [batchId, entry] of preflightByBatch) {
    const healthy = entry.total < BATCH_HEALTH_MIN_SIZE || entry.verifiedCount / entry.total >= BATCH_HEALTH_MIN_VERIFIED_RATIO
    batchHealth.set(batchId, { healthy, ...entry })
    if (!healthy) {
      console.error(`[dpi-reconciliation] first reconcile, batch ${batchId}: only ${entry.verifiedCount}/${entry.total} compare clean this run — treating as a sync stall, deferring all healing`)
    }
  }

  const facilities = new Set()
  const mismatches = []
  let checked = 0
  let verified = 0
  let healed = 0
  let deferred = 0
  let linesBackfilledThisRun = 0

  for (const row of rows) {
    facilities.add(row.facility)
    const claimed = await claimRow(row.id, 'reconciliation_status=is.null')
    if (!claimed) continue

    // 2026-09-23 fix — no per-row try/catch. An unhandled exception
    // anywhere in this block (most likely inside backfillMissingLines,
    // which makes real network calls to MotherDuck and Datex) used to
    // propagate straight out of the loop: it killed the rest of the
    // batch's rows for this tick AND left the current row stuck in
    // 'checking' with nothing to move it forward, since every phase that
    // could pick it back up filters on a DIFFERENT status. Confirmed
    // live: one order stranded itself in 'checking' twice, which is only
    // explainable by an exception during processing that also silently
    // killed the remaining rows in that tick's loop. Catching here means
    // one bad row can no longer take the whole tick down with it, and
    // immediately un-claiming (rather than waiting for the 15-minute
    // orphan sweep in recoverOrphanedCheckingRows) gets it re-checked on
    // the very next tick instead.
    try {
      const expectedLines = expectedByRowId.get(row.id)
      checked += 1

      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'Could not resolve original staged CSV lines for this agency — cycle/staged data may have been deleted.',
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
        continue
      }

      // Reuse the pre-pass result so the batch-health judgment above and
      // this row's actual disposition come from the identical comparison.
      // Falls back to a fresh compare if the entry is somehow absent —
      // it shouldn't be (the pre-pass covers every row with expectedLines,
      // and rows without it already returned above), but destructuring an
      // undefined here would take down the whole run.
      const { verified: isVerified, details, missingLines, hasQtyMismatch } =
        preflightByRowId.get(row.id) || compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))

      if (isVerified) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'verified',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: null,
        })
        verified += 1
        continue
      }

      if (hasQtyMismatch || row.shipment_id == null) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: row.shipment_id == null
            ? `${details} | cannot auto-backfill: no shipment_id stored for this order`
            : `${details} | not auto-healed (quantity mismatch — needs a human)`,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details })
        continue
      }

      // Missing-only and healable. Still refuse if the batch as a whole
      // looks like a sync stall rather than genuine per-order gaps.
      const health = batchHealth.get(row.batch_id)
      if (health && !health.healthy) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, { reconciliation_status: null, claimed_at: null })
        deferred += 1
        continue
      }

      if (linesBackfilledThisRun + missingLines.length > MAX_BACKFILL_LINES_PER_RUN) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, { reconciliation_status: null, claimed_at: null })
        continue
      }

      const backfillResult = await backfillMissingLines(row, missingLines, expectedLines.length)
      linesBackfilledThisRun += missingLines.length

      if (!backfillResult.ok) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | heal attempt failed: ${backfillResult.error}`,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: `${details} (heal failed: ${backfillResult.error})` })
        continue
      }

      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'backfilling',
        reconciliation_backfilled_at: new Date().toISOString(),
        reconciliation_backfill_count: 1,
        reconciliation_details: `Resubmitted ${backfillResult.submittedCount} missing line(s) at T+${FIRST_RECONCILE_AFTER_MINUTES}min. Will re-validate ${POST_HEAL_VALIDATE_AFTER_MINUTES}min after this heal.${backfillResult.partialWarning ? ' ' + backfillResult.partialWarning : ''}`,
      })
      healed += 1
    } catch (err) {
      console.error(`[dpi-reconciliation] first reconcile: unhandled error processing row ${row.id} (order ${row.datex_order_id}) — un-claiming for retry next tick: ${err.message}`)
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}&reconciliation_status=eq.checking`, { reconciliation_status: null, claimed_at: null })
    }
  }

  return { checked, verified, healed, deferred, stalledBatches, mismatches, facilities: [...facilities] }
}

// ── Phase C: POST-HEAL VALIDATION (heal + 150 min) ───────────────────
// Per-ROW, measured from that row's own heal — a resubmitted line needs
// the same replica-lag allowance as any other write, and anchoring to a
// fixed offset from the push would silently shrink that window whenever
// a heal ran late. Confirmed live 2026-09-21: the 2 orders healed at
// T+90 were exactly the 2 still showing short at T+150.
async function runPostHealValidationPhase(isTest, batchIdFilter) {
  const empty = { checked: 0, verified: 0, healedAgain: 0, stalledBatches: 0, mismatches: [], facilities: [] }
  const cutoff = new Date(Date.now() - POST_HEAL_VALIDATE_AFTER_MINUTES * 60 * 1000).toISOString()
  const filters = ['status=eq.success', 'reconciliation_status=eq.backfilling']
  if (!isTest) filters.push(`reconciliation_backfilled_at=lt.${encodeURIComponent(cutoff)}`)
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)
  let rows = await supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
  if (rows.length === 0) return empty

  const partitioned = await partitionBySyncState(rows, 'post-heal validation')
  if (partitioned.syncedRows.length === 0) return { ...empty, stalledBatches: partitioned.stalledBatches }
  rows = partitioned.syncedRows
  const stalledBatches = partitioned.stalledBatches

  const expectedByRowId = await resolveExpectedLines(rows)
  const orderIds = [...new Set(rows.map((r) => r.datex_order_id))]
  const actualByOrderId = await fetchActualLines(orderIds)
  const actualCountByOrderId = await fetchActualLineCounts(orderIds)

  const facilities = new Set()
  const mismatches = []
  let checked = 0
  let verified = 0
  let healedAgain = 0
  let linesBackfilledThisRun = 0

  for (const row of rows) {
    facilities.add(row.facility)
    const claimed = await claimRow(row.id, 'reconciliation_status=eq.backfilling')
    if (!claimed) continue

    // 2026-09-23 fix — same per-row try/catch as runFirstReconcilePhase,
    // and for the identical reason: this phase also claims into
    // 'checking' and also calls backfillMissingLines, so it carries the
    // same exposure to one bad row stranding itself and taking the rest
    // of the tick's rows down with it.
    try {
      const expectedLines = expectedByRowId.get(row.id)
      checked += 1

      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'Could not resolve original staged CSV lines during post-heal validation.',
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
        continue
      }

      const { verified: isVerified, details, missingLines, hasQtyMismatch } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      const attemptsSoFar = row.reconciliation_backfill_count || 1

      if (isVerified) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'verified',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: null,
        })
        verified += 1
        continue
      }

      // A quantity mismatch appearing AFTER a heal is the duplicate-line
      // signature (the heal landed on top of a line that was merely slow).
      // Never heal that further — it needs a human to delete the extra.
      if (hasQtyMismatch) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | quantity mismatch after heal attempt ${attemptsSoFar} — likely a duplicate line, needs manual review`,
        })
        mismatches.push({
          agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id,
          details, expectedLineCount: expectedLines.length, actualLineCount: actualCountByOrderId.get(row.datex_order_id) || 0,
        })
        continue
      }

      if (attemptsSoFar >= MAX_BACKFILL_ATTEMPTS) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | still short after ${attemptsSoFar} independently-validated heal attempts — needs manual review`,
        })
        mismatches.push({
          agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id,
          details, expectedLineCount: expectedLines.length, actualLineCount: actualCountByOrderId.get(row.datex_order_id) || 0,
        })
        continue
      }

      if (linesBackfilledThisRun + missingLines.length > MAX_BACKFILL_LINES_PER_RUN) {
        // Put it back as-is; backfilled_at is unchanged so it stays
        // eligible on the next tick.
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, { reconciliation_status: 'backfilling', claimed_at: null })
        continue
      }

      const backfillResult = await backfillMissingLines(row, missingLines, expectedLines.length)
      linesBackfilledThisRun += missingLines.length

      if (!backfillResult.ok) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: `${details} | second heal attempt failed: ${backfillResult.error}`,
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: `${details} (heal failed: ${backfillResult.error})` })
        continue
      }

      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'backfilling',
        reconciliation_backfilled_at: new Date().toISOString(),
        reconciliation_backfill_count: attemptsSoFar + 1,
        reconciliation_details: `Still short after heal ${attemptsSoFar}; resubmitted ${backfillResult.submittedCount} line(s) (attempt ${attemptsSoFar + 1}). Will re-validate ${POST_HEAL_VALIDATE_AFTER_MINUTES}min from now.${backfillResult.partialWarning ? ' ' + backfillResult.partialWarning : ''}`,
      })
      healedAgain += 1
    } catch (err) {
      console.error(`[dpi-reconciliation] post-heal validation: unhandled error processing row ${row.id} (order ${row.datex_order_id}) — reverting to 'backfilling' for retry next cycle: ${err.message}`)
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}&reconciliation_status=eq.checking`, { reconciliation_status: 'backfilling', claimed_at: null })
    }
  }

  return { checked, verified, healedAgain, stalledBatches, mismatches, facilities: [...facilities] }
}

// ── Phase D: FINAL SWEEP (once the cycle has settled) ────────────────
// Deliberately NOT on a fixed clock anymore. It runs when a cycle has no
// rows left in a working state, so it can never contradict a heal that's
// still in flight — the old fixed-T+150 sweep did exactly that, and its
// verdict was permanent because claiming sets final_sweep_at. Capped by
// FINAL_SWEEP_MAX_DEFER_MINUTES so a cycle that never settles still gets
// reported, explicitly flagged as unconfirmed.
async function runFinalSweepPhase() {
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const cycles = await supabaseGet(
    `/rest/v1/dpi_monthly_cycles?final_sweep_at=is.null&created_at=gte.${encodeURIComponent(recentCutoff)}&select=id,facility,month_key,batch_id`
  )
  if (cycles.length === 0) return []

  const batchIds = cycles.map((c) => c.batch_id)
  const ready = await batchesPastPushThreshold(batchIds, FIRST_RECONCILE_AFTER_MINUTES)
  const eligibleCycles = cycles.filter((c) => ready.has(c.batch_id))
  if (eligibleCycles.length === 0) return []

  const results = []
  for (const cycle of eligibleCycles) {
    const sweepRows = await supabaseGet(
      `/rest/v1/dpi_import_batches?batch_id=eq.${encodeURIComponent(cycle.batch_id)}&status=eq.success&select=datex_order_id,reconciliation_status`
    )
    const pastDeferCap = await batchesPastPushThreshold([cycle.batch_id], FINAL_SWEEP_MAX_DEFER_MINUTES)
    const forcedByCap = pastDeferCap.has(cycle.batch_id)

    if (sweepRows.length > 0 && !forcedByCap) {
      // Wait for every row to reach a terminal state — this is what keeps
      // the sweep from stepping on an in-flight heal.
      const stillWorking = sweepRows.filter((r) => r.reconciliation_status == null || NON_TERMINAL_STATUSES.includes(r.reconciliation_status)).length
      if (stillWorking > 0) {
        console.error(`[dpi-reconciliation] final sweep waiting on cycle ${cycle.id} (${cycle.facility} ${cycle.month_key}): ${stillWorking}/${sweepRows.length} rows still working`)
        continue
      }
      const sweepOrderIds = [...new Set(sweepRows.map((r) => r.datex_order_id).filter((id) => id != null))]
      const syncState = await fetchBatchSyncState(sweepOrderIds)
      if (!syncState.anyLinesPresent) {
        console.error(`[dpi-reconciliation] final sweep deferred for cycle ${cycle.id}: replica has no lines for this batch yet`)
        continue
      }
      const verifiedCount = sweepRows.filter((r) => r.reconciliation_status === 'verified').length
      if (sweepRows.length >= BATCH_HEALTH_MIN_SIZE && verifiedCount / sweepRows.length < BATCH_HEALTH_MIN_VERIFIED_RATIO) {
        console.error(`[dpi-reconciliation] final sweep deferred for cycle ${cycle.id}: only ${verifiedCount}/${sweepRows.length} verified — likely still catching up`)
        continue
      }
    }

    const claimed = await claimCycleForFinalSweep(cycle.id)
    if (!claimed) continue

    const rows = await supabaseGet(
      `/rest/v1/dpi_import_batches?batch_id=eq.${encodeURIComponent(cycle.batch_id)}&status=eq.success&select=*`
    )
    if (rows.length === 0) {
      await supabasePatch(`/rest/v1/dpi_monthly_cycles?id=eq.${cycle.id}`, { final_sweep_details: 'No real (status=success) orders existed to sweep.' })
      results.push({ facility: cycle.facility, monthKey: cycle.month_key, swept: 0, verified: 0, problems: [] })
      continue
    }

    const expectedByRowId = await resolveExpectedLines(rows)
    const orderIds = [...new Set(rows.map((r) => r.datex_order_id).filter((id) => id != null))]
    const actualByOrderId = await fetchActualLines(orderIds)
    const actualCountByOrderId = await fetchActualLineCounts(orderIds)

    // 2026-09-22 fix — the sweep used to compute its verdict and persist
    // each row inside ONE loop, then patch the cycle, then post to Front
    // LAST. Confirmed live: both the 2026-09-22 Madison and Eau Claire
    // sweeps completed correctly (final_sweep_details recorded "All 70 /
    // All 76 orders verified complete") but neither Front message ever
    // appeared — the notification sits downstream of 70-76 sequential
    // Supabase PATCHes, so anything that ends the invocation in that
    // loop loses the report while leaving the database perfectly
    // correct. From the operator's side that is indistinguishable from
    // the sweep never running, which is the worst possible failure mode
    // for the one message this whole system exists to produce.
    //
    // Now split into three ordered stages: COMPUTE the verdict
    // (read-only), REPORT it, then PERSIST. Reporting no longer depends
    // on any write succeeding, and the persist loop is idempotent — if
    // it dies partway, the next tick's sweep would recompute the same
    // answer anyway (and the cycle-level claim already guards against a
    // duplicate post).
    const problems = []
    let cleanCount = 0
    const rowOutcomes = [] // { rowId, patch } — persisted after reporting

    for (const row of rows) {
      // Snapshot what the earlier phases recorded before overwriting it,
      // so the forensic trail survives the sweep (added 2026-09-19 after
      // an earlier anomaly became undiagnosable for exactly this reason).
      const preSweep = {
        pre_sweep_status: row.reconciliation_status,
        pre_sweep_checked_at: row.reconciliation_checked_at,
        pre_sweep_details: row.reconciliation_details,
      }

      const expectedLines = expectedByRowId.get(row.id)
      if (!expectedLines) {
        rowOutcomes.push({ rowId: row.id, patch: {
          ...preSweep,
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'original staged CSV data not found (final sweep)',
        } })
        problems.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found', expectedLineCount: 0, actualLineCount: actualCountByOrderId.get(row.datex_order_id) || 0, healAttempts: row.reconciliation_backfill_count || 0 })
        continue
      }

      const { verified, details } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      rowOutcomes.push({ rowId: row.id, patch: {
        ...preSweep,
        reconciliation_status: verified ? 'verified' : 'mismatch',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: verified ? null : `${details} | confirmed by final sweep`,
      } })

      if (verified) cleanCount += 1
      else problems.push({
        agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details,
        expectedLineCount: expectedLines.length,
        actualLineCount: actualCountByOrderId.get(row.datex_order_id) || 0,
        healAttempts: row.reconciliation_backfill_count || 0,
      })
    }

    const detailsText = problems.length === 0
      ? `All ${rows.length} orders verified complete.`
      : `${cleanCount} of ${rows.length} orders verified complete. ${problems.length} do not match the original CSV.`

    // REPORT before persisting. The cycle-level detail patch goes first
    // (one cheap write, so the verdict is durable even if Front is
    // unreachable), then the Front post, then the per-row writes.
    await supabasePatch(`/rest/v1/dpi_monthly_cycles?id=eq.${cycle.id}`, { final_sweep_details: detailsText })
    await postFinalSweepSummary(cycle, rows.length, cleanCount, problems, forcedByCap)

    // PERSIST. Deliberately last: nothing above depends on it, and the
    // operator already has the answer by this point.
    for (const outcome of rowOutcomes) {
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${outcome.rowId}`, outcome.patch)
    }

    results.push({ facility: cycle.facility, monthKey: cycle.month_key, swept: rows.length, verified: cleanCount, problems })
  }

  return results
}

async function postFinalSweepSummary(cycle, totalCount, cleanCount, problems, forcedByCap) {
  const prefix = `**DPI Monthly FINAL SWEEP — ${cycle.facility}, ${cycle.month_key}**`
  const intro = `Every order re-checked against the original CSV after all heal attempts finished. This is the final word on this push.`

  if (problems.length === 0) {
    await postToFront(`${prefix}\n${intro}\nAll ${totalCount} orders verified complete. Nothing further needed.`)
    return
  }

  const notSyncedYet = problems.filter((p) => p.actualLineCount === 0)
  const genuinelyShort = problems.filter((p) => p.actualLineCount > 0)

  const capNote = forcedByCap
    ? `\n**NOTE: this batch never fully settled within ${Math.round(FINAL_SWEEP_MAX_DEFER_MINUTES / 60)} hours, so this is posted unconfirmed rather than deferred further. Verify directly in Datex before acting.**`
    : ''

  const sections = []
  if (genuinelyShort.length > 0) {
    const lines = genuinelyShort.slice(0, 15).map((p) => {
      const healNote = p.healAttempts > 0 ? ` (after ${p.healAttempts} heal attempt${p.healAttempts === 1 ? '' : 's'})` : ''
      return `- ${p.agency_name} (#${p.agency_number}, order ${p.datex_order_id}): has ${p.actualLineCount} of ${p.expectedLineCount} lines${healNote} — ${p.details}`
    })
    const extra = genuinelyShort.length > 15 ? `\n...and ${genuinelyShort.length - 15} more` : ''
    sections.push(`${genuinelyShort.length} order(s) need manual review in Datex — these will NOT be auto-corrected:\n${lines.join('\n')}${extra}`)
  }
  if (notSyncedYet.length > 0) {
    const lines = notSyncedYet.slice(0, 10).map((p) => `- ${p.agency_name} (#${p.agency_number}, order ${p.datex_order_id}): expected ${p.expectedLineCount} lines`)
    const extra = notSyncedYet.length > 10 ? `\n...and ${notSyncedYet.length - 10} more` : ''
    sections.push(`${notSyncedYet.length} order(s) show NO lines at all in MotherDuck — almost certainly still syncing rather than actually empty. Verify in Datex before treating these as real problems:\n${lines.join('\n')}${extra}`)
  }

  await postToFront(`${prefix}\n${intro}${capNote}\n${cleanCount} of ${totalCount} verified complete.\n\n${sections.join('\n\n')}`)
}

async function postEarlyLookSummary(earlyLook, isTest) {
  if (!earlyLook || earlyLook.total === 0) return
  const prefix = isTest ? '**DPI Monthly — early look (manual test run)**' : '**DPI Monthly — early look**'
  const parts = [`${earlyLook.lookedComplete} look complete`]
  if (earlyLook.lookedShort > 0) parts.push(`${earlyLook.lookedShort} look short`)
  if (earlyLook.noLinesYet > 0) parts.push(`${earlyLook.noLinesYet} show no lines yet`)
  await postToFront(
    `${prefix}\nT+${EARLY_LOOK_AFTER_MINUTES}min heads-up on ${earlyLook.total} order(s) (${earlyLook.facilities.join(', ')}): ${parts.join(', ')}. ` +
    `Nothing has been checked against Datex or changed — MotherDuck is usually still catching up at this point, so short/missing counts here are expected and often resolve on their own. ` +
    `The real reconciliation runs at T+${FIRST_RECONCILE_AFTER_MINUTES}min.`
  )
}

async function postWorkSummary(firstReconcile, postHeal, isTest) {
  const prefix = isTest ? '**DPI Monthly Reconciliation (manual test run)**' : '**DPI Monthly Reconciliation**'
  const clauses = []

  if (firstReconcile.checked > 0) {
    clauses.push(
      `Reconciled ${firstReconcile.checked} order(s) (${firstReconcile.facilities.join(', ')}) at T+${FIRST_RECONCILE_AFTER_MINUTES}min — ${firstReconcile.verified} verified` +
      (firstReconcile.healed > 0 ? `, ${firstReconcile.healed} short and resubmitted (re-validating in ${POST_HEAL_VALIDATE_AFTER_MINUTES}min)` : '') +
      (firstReconcile.mismatches.length > 0 ? `, ${firstReconcile.mismatches.length} need manual review` : '') +
      (firstReconcile.deferred > 0 ? `, ${firstReconcile.deferred} deferred (batch looks like a sync stall, nothing touched)` : '')
    )
  }

  if (postHeal.checked > 0) {
    clauses.push(
      `re-validated ${postHeal.checked} previously-healed order(s) (${postHeal.facilities.join(', ')}) — ${postHeal.verified} now complete` +
      (postHeal.healedAgain > 0 ? `, ${postHeal.healedAgain} still short and resubmitted once more` : '') +
      (postHeal.mismatches.length > 0 ? `, ${postHeal.mismatches.length} need manual review` : '')
    )
  }

  if (clauses.length === 0) {
    const totalStalled = (firstReconcile.stalledBatches || 0) + (postHeal.stalledBatches || 0)
    if (totalStalled > 0) {
      await postToFront(`${prefix}\nWaiting on MotherDuck — ${totalStalled} batch(es) due for a check have no order lines in the replica yet, so nothing was compared or changed this tick. Will re-check automatically every 15 minutes.`)
    }
    return
  }

  let body = `${prefix}\n${clauses.join('; ')}.`
  const allMismatches = [...firstReconcile.mismatches, ...postHeal.mismatches]
  if (allMismatches.length > 0) {
    const lines = allMismatches.slice(0, 10).map((m) => `- ${m.agency_name} (#${m.agency_number}, order ${m.datex_order_id}): ${m.details}`)
    const extra = allMismatches.length > 10 ? `\n...and ${allMismatches.length - 10} more` : ''
    body += `\n${lines.join('\n')}${extra}`
  }
  await postToFront(body)
}

// Runs every phase and posts whatever messages are due this tick.
// isTest bypasses the timing gates on the early look, first
// reconciliation, and post-heal validation — never on the final sweep,
// whose whole purpose is to wait until a cycle has genuinely settled.
async function runReconciliation(isTest = false, batchIdFilter = null) {
  // Runs first: an orphaned 'checking' row would otherwise be invisible
  // to every phase below AND block the final sweep until the 14h cap.
  const recovered = await recoverOrphanedCheckingRows()

  const earlyLook = await runEarlyLookPhase(isTest, batchIdFilter)
  await postEarlyLookSummary(earlyLook, isTest)

  const firstReconcile = await runFirstReconcilePhase(isTest, batchIdFilter)
  const postHeal = await runPostHealValidationPhase(isTest, batchIdFilter)
  await postWorkSummary(firstReconcile, postHeal, isTest)

  const finalSweeps = await runFinalSweepPhase()

  return { ok: true, recovered, earlyLook, firstReconcile, postHeal, finalSweeps }
}

module.exports = {
  runReconciliation,
  EARLY_LOOK_AFTER_MINUTES,
  FIRST_RECONCILE_AFTER_MINUTES,
  POST_HEAL_VALIDATE_AFTER_MINUTES,
  MAX_BACKFILL_ATTEMPTS,
  FINAL_SWEEP_MAX_DEFER_MINUTES,
  ORPHANED_CHECKING_AFTER_MINUTES,
}
