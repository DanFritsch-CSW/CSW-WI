'use strict'

// DPI Monthly Process — line-persistence reconciliation.
//
// create_outbound_order_line gives no reliable success/failure signal
// (confirmed 2026-09-18: response comes back byte-identical whether a
// line persists or not), and MotherDuck has a real, NON-deterministic
// sync delay from Datex — typically well under 30 minutes, but confirmed
// live to sometimes run 80+ minutes for an isolated straggler line — so
// this can never be checked reliably inside the push itself (see
// dpi-monthly-shared.cjs and dpi-import-push-background.cjs for the full
// investigation, including an earlier same-day attempt at in-process
// verification that was built and then reverted once the real sync delay
// was confirmed).
//
// 2026-09-19 (three-phase redesign): earlier versions of this file used a
// single-observation "if it looks missing, backfill it immediately" model
// (first at 45, then 60 minutes after push), with up to 2 retry attempts
// spaced 60 minutes apart if the first backfill didn't fix it. This had a
// real, serious flaw, confirmed live TWICE: a line that's merely slow to
// sync — not actually missing — looks identical to a genuinely missing
// line at the moment of the FIRST look. Backfilling on a single
// observation means betting that "missing right now" means "actually
// missing," and losing that bet doesn't produce a harmless false alarm —
// it creates a real, permanent duplicate line in Datex, because there is
// no way to submit a line "only if it doesn't already exist." The fix
// mechanism was, in a real sense, the thing causing the defect.
//
// Per Dan, this redesigns around that specific failure mode instead of
// just tuning how long to wait: rather than act on the first sighting of
// a discrepancy, CONFIRM it independently before ever touching Datex.
// Three fixed, absolute checkpoints, all measured from the ORIGINAL push
// completion (not chained relative to each other, so every order's
// timeline is fixed and predictable regardless of exactly when a cron
// tick happens to fire):
//
//   T+60 min  — OBSERVE. Compare expected (CSV) vs actual (MotherDuck).
//               Clean → 'verified', done. A discrepancy → 'pending_
//               confirmation' — noted, but NOTHING is written to Datex
//               yet. This is deliberately a look-only step.
//   T+90 min  — CONFIRM & HEAL. Re-compare, independently, 30 minutes
//               later. Now clean → 'verified' — this is the case that
//               used to become a duplicate: a line that was merely
//               syncing slowly at T+60 has had 30 more minutes and, in
//               every case seen so far, shows up by T+90. Confirmed
//               missing-only → backfill now (exactly once — this design
//               doesn't retry backfills, because acting on a CONFIRMED
//               absence is a fundamentally more trustworthy signal than
//               acting on a single sighting, so a second unconditional
//               retry adds little). Confirmed quantity mismatch →
//               'mismatch' directly — never auto-healed regardless of
//               timing (see compareLines).
//   T+150 min — FINAL SWEEP. One independent, comprehensive, closing
//               check of EVERY order in the push, regardless of its
//               current status — including ones already 'verified' at
//               T+60 or T+90, which nothing else ever looks at again.
//               Overwrites reconciliation_status with the true, current
//               answer, but not destructively — the pre-sweep status/
//               checked_at/details are snapshotted into pre_sweep_*
//               columns first (added 2026-09-19, after a real batch's
//               T+60 "observe" pass only processed 38 of 70 rows for a
//               reason that couldn't be definitively confirmed after the
//               fact, precisely because the final sweep had already
//               overwritten the only record of it). This is the one
//               message per push meant to be trusted completely as the
//               final word, and it also naturally catches anything that
//               fell through a crack elsewhere (a crashed invocation
//               leaving a row stuck mid-claim, for instance) — now
//               without erasing the evidence of what that crack was.
//
// Every order gets a deterministic final answer by T+150 (2.5 hours) —
// no open-ended retry loop, no attempt counting, no "worst case could
// take 3 hours" — comfortably inside the 3-4 hour target with margin.
//
// Scope: only dpi_import_batches rows with status='success'. 'failed' is
// already known-bad (flagged at push time with a specific error),
// 'duplicate_skipped' never created anything new, 'simulated' never
// touched Datex at all — none of those need this check.
//
// Whole-batch gating (unchanged principle from the prior design): a real
// push can span ~15 minutes end-to-end (orders processed sequentially,
// each with its own updated_at). Every phase below gates on the WHOLE
// batch's oldest-eligible-moment — a batch is only included once every
// 'success' row in it has crossed the relevant threshold (i.e. gated on
// the batch's most-recently-pushed row) — so a push is always checked
// and reported as one complete unit, never dribbled across messages.

const { runMotherDuckQuery, getMaterialMap, submitLines, FACILITIES } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

const FIRST_CHECK_AFTER_MINUTES = 60
const CONFIRM_AFTER_MINUTES = 90
const FINAL_SWEEP_AFTER_MINUTES = 150
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

// Atomically claims one row by PATCHing it with a filter matching its
// CURRENT status — Postgres applies that filter as part of the same
// UPDATE, so if two invocations race for the same row, only the one
// whose PATCH lands first actually matches; the second gets an empty
// array back. Confirmed live 2026-09-19: two reconciliation invocations
// running close together, with no lock at all, split a 70-order batch's
// processing between them — didn't corrupt anything that time purely by
// luck of which rows each happened to grab, but nothing prevented them
// from grabbing the SAME row instead, which would risk a genuine
// duplicate backfill. 'checking' is a transitional status always
// overwritten with a real outcome by the end of processing that row.
async function claimRow(rowId, fromStatusFilter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dpi_import_batches?id=eq.${rowId}&${fromStatusFilter}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ reconciliation_status: 'checking' }),
  })
  if (!res.ok) return false
  const rows = await res.json().catch(() => [])
  return Array.isArray(rows) && rows.length > 0
}

// Same claim pattern, applied to a dpi_monthly_cycles row instead of a
// dpi_import_batches row — used to gate the final sweep so two
// invocations can't both run (and both post) it for the same cycle.
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

// Shared by all three phases: of the given batch_ids, which ones have
// EVERY 'success' row at least `minutesThreshold` old — i.e. the batch's
// own most-recently-pushed row has crossed that age. All three phases
// measure from the same fixed point (the original push), not from each
// other, so every order's checkpoint schedule stays absolute and
// predictable.
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

const FRONT_API_TOKEN = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const FRONT_STATUS_CONVERSATION_ID = 'cnv_1cboo2s4'

async function postToFront(body) {
  if (!FRONT_API_TOKEN) {
    console.error('[dpi-reconciliation] FRONT_API_TOKEN not configured — skipping status post')
    return
  }
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

// ── Phase 1: OBSERVE (T+60) ──────────────────────────────────────────
// Look-only. Never writes to Datex. A discrepancy just gets noted for
// Phase 2 to independently confirm 30 minutes later.
async function runObservePhase(isTest, batchIdFilter) {
  const filters = ['status=eq.success', 'datex_order_id=not.is.null', 'reconciliation_status=is.null']
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)
  const candidates = await supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
  if (candidates.length === 0) return { checked: 0, verified: 0, flagged: 0, facilities: [] }

  let rows = candidates
  if (!isTest) {
    const batchIds = [...new Set(candidates.map((r) => r.batch_id))]
    const ready = await batchesPastPushThreshold(batchIds, FIRST_CHECK_AFTER_MINUTES)
    rows = candidates.filter((r) => ready.has(r.batch_id))
  }
  if (rows.length === 0) return { checked: 0, verified: 0, flagged: 0, facilities: [] }

  const expectedByRowId = await resolveExpectedLines(rows)
  const orderIds = [...new Set(rows.map((r) => r.datex_order_id))]
  const actualByOrderId = await fetchActualLines(orderIds)

  const facilities = new Set()
  let checked = 0
  let verified = 0
  let flagged = 0

  for (const row of rows) {
    facilities.add(row.facility)
    const claimed = await claimRow(row.id, 'reconciliation_status=is.null')
    if (!claimed) continue // another invocation already grabbed this row this tick

    const expectedLines = expectedByRowId.get(row.id)
    checked += 1

    if (!expectedLines) {
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'mismatch',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: 'Could not resolve original staged CSV lines for this agency — cycle/staged data may have been deleted.',
      })
      continue
    }

    const { verified: isVerified, details } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))

    if (isVerified) {
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'verified',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: null,
      })
      verified += 1
    } else {
      // Deliberately look-only — nothing is submitted to Datex here.
      // reconciliation_checked_at doubles as "first seen at" for Phase 2
      // to measure its own 30-minute confirmation window from.
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'pending_confirmation',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: details,
      })
      flagged += 1
    }
  }

  return { checked, verified, flagged, facilities: [...facilities] }
}

// ── Phase 2: CONFIRM & HEAL (T+90) ───────────────────────────────────
// Independently re-checks anything flagged by Phase 1, 30 minutes after
// it was first seen. A line that was merely syncing slowly at T+60 has
// had 30 more minutes here — in every case seen so far, that's enough
// for it to show up, which is exactly what turns this into a caught
// false alarm instead of a duplicate. Backfills exactly once if the gap
// is still genuinely there; never retries afterward — see file header.
// 2026-09-20: closes a real, more severe failure mode than the isolated-
// straggler one this redesign originally targeted. Confirmed live: an
// entire 70-order batch's MotherDuck replication stalled for well over
// 150 minutes (not an isolated line — the WHOLE batch, 0 of 70 verified
// at any checkpoint). The "confirm independently 30 minutes later"
// safeguard doesn't catch this, because every order in a batch-wide
// stall still looks "confirmed missing" on a second look — there's no
// contradiction for it to catch, since NOTHING in the batch has synced
// yet. 10 of the 70 happened to reach the backfill step during that
// window and are now genuine duplicates needing manual cleanup.
//
// This computes, for each batch a candidate row belongs to, what
// fraction of that SAME batch's 'success' rows have already verified
// cleanly (from T+60 or an earlier confirm) — checked against ALL of the
// batch's rows, not just the ones currently pending confirmation, so a
// batch that's mostly fine already registers as healthy even if a few
// rows are still working through Phase 2. A real per-order drop rate has
// never been seen above ~12% of a batch (8/67, the worst on record) — a
// batch showing anywhere near 0% verified is categorically different:
// the signature of a systemic sync stall, not scattered genuine misses.
// BATCH_HEALTH_MIN_VERIFIED_RATIO is set well above the worst real drop
// rate specifically so it never second-guesses genuine per-order
// backfills, only batch-wide anomalies. Below the minimum batch size,
// percentages are too noisy to mean anything, so health checking is
// skipped entirely (small batches also carry proportionally small
// consequences if this guess is ever wrong).
const BATCH_HEALTH_MIN_SIZE = 10
const BATCH_HEALTH_MIN_VERIFIED_RATIO = 0.5

async function computeBatchHealth(batchIds) {
  const health = new Map() // batch_id -> { healthy: boolean, total, verifiedCount }
  if (batchIds.length === 0) return health

  const rows = await supabaseGet(
    `/rest/v1/dpi_import_batches?status=eq.success&batch_id=in.(${batchIds.map((id) => encodeURIComponent(id)).join(',')})&select=batch_id,reconciliation_status`
  )
  const byBatch = new Map()
  for (const row of rows) {
    if (!byBatch.has(row.batch_id)) byBatch.set(row.batch_id, { total: 0, verifiedCount: 0 })
    const entry = byBatch.get(row.batch_id)
    entry.total += 1
    if (row.reconciliation_status === 'verified') entry.verifiedCount += 1
  }

  for (const [batchId, entry] of byBatch) {
    const healthy = entry.total < BATCH_HEALTH_MIN_SIZE || entry.verifiedCount / entry.total >= BATCH_HEALTH_MIN_VERIFIED_RATIO
    health.set(batchId, { healthy, ...entry })
  }
  return health
}

async function runConfirmAndHealPhase(isTest, batchIdFilter) {
  const filters = ['status=eq.success', 'reconciliation_status=eq.pending_confirmation']
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)
  const candidates = await supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
  if (candidates.length === 0) return { checked: 0, verified: 0, healed: 0, deferred: 0, mismatches: [], facilities: [] }

  let rows = candidates
  if (!isTest) {
    const batchIds = [...new Set(candidates.map((r) => r.batch_id))]
    const ready = await batchesPastPushThreshold(batchIds, CONFIRM_AFTER_MINUTES)
    rows = candidates.filter((r) => ready.has(r.batch_id))
  }
  if (rows.length === 0) return { checked: 0, verified: 0, healed: 0, deferred: 0, mismatches: [], facilities: [] }

  const batchHealth = await computeBatchHealth([...new Set(rows.map((r) => r.batch_id))])
  const expectedByRowId = await resolveExpectedLines(rows)
  const orderIds = [...new Set(rows.map((r) => r.datex_order_id))]
  const actualByOrderId = await fetchActualLines(orderIds)

  const facilities = new Set()
  const mismatches = []
  let checked = 0
  let verified = 0
  let healed = 0
  let deferred = 0
  let linesBackfilledThisRun = 0

  for (const row of rows) {
    facilities.add(row.facility)
    const claimed = await claimRow(row.id, 'reconciliation_status=eq.pending_confirmation')
    if (!claimed) continue

    const expectedLines = expectedByRowId.get(row.id)
    checked += 1

    if (!expectedLines) {
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'mismatch',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: 'Could not resolve original staged CSV lines for this agency during confirmation check.',
      })
      mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
      continue
    }

    const { verified: isVerified, details, missingLines, hasQtyMismatch } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))

    if (isVerified) {
      // The exact case this redesign targets: looked wrong at T+60,
      // looks right now — a sync-delay false alarm, caught and closed
      // without ever touching Datex.
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
        reconciliation_details: row.shipment_id == null ? `${details} | cannot auto-backfill: no shipment_id stored for this order (pushed before backfill support existed)` : `${details} | confirmed at T+${CONFIRM_AFTER_MINUTES}min, not auto-healed (quantity mismatch)`,
      })
      mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details, neverAttempted: true })
      continue
    }

    // Confirmed, missing-only — the one action in this whole file that
    // actually writes new lines to Datex. Refuse to do it if this row's
    // batch looks like it's in a systemic sync stall rather than a
    // genuine per-order gap (see BATCH_HEALTH_MIN_SIZE/RATIO above) —
    // leave it in pending_confirmation, unbackfilled, for a later tick
    // to reassess once more of the batch has had a chance to sync.
    const health = batchHealth.get(row.batch_id)
    if (health && !health.healthy) {
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, { reconciliation_status: 'pending_confirmation' })
      deferred += 1
      continue
    }

    // Confirmed, missing-only — safe to backfill exactly once.
    if (linesBackfilledThisRun + missingLines.length > MAX_BACKFILL_LINES_PER_RUN) {
      // Over budget this run — revert to pending_confirmation so it's
      // picked back up (still "confirmed," no need to re-observe) as
      // soon as there's budget on a later tick.
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, { reconciliation_status: 'pending_confirmation' })
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
      reconciliation_details: `Confirmed missing at T+${CONFIRM_AFTER_MINUTES}min, resubmitted ${backfillResult.submittedCount} line(s). Final answer at T+${FINAL_SWEEP_AFTER_MINUTES}min.${backfillResult.partialWarning ? ' ' + backfillResult.partialWarning : ''}`,
    })
    healed += 1
  }

  return { checked, verified, healed, deferred, mismatches, facilities: [...facilities] }
}

// ── Phase 3: FINAL SWEEP (T+150) ─────────────────────────────────────
// One independent, comprehensive, closing check of EVERY order in the
// push, regardless of current status — including rows already
// 'verified' at T+60/T+90, which nothing else ever re-examines.
// Overwrites reconciliation_status with the true, current answer
// regardless of prior state, so this also self-corrects any row stuck
// mid-claim from a crashed invocation. Runs once per cycle
// (final_sweep_at, claimed atomically, gates re-running it) and always
// posts its own message, clearly labeled as the final word.
async function runFinalSweepPhase() {
  // Bounded to recently-created cycles: final_sweep_at only exists going
  // forward, so every historical cycle starts out NULL — without this
  // bound, the first tick after this shipped would try to sweep every
  // cycle ever created in one go.
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const cycles = await supabaseGet(
    `/rest/v1/dpi_monthly_cycles?final_sweep_at=is.null&created_at=gte.${encodeURIComponent(recentCutoff)}&select=id,facility,month_key,batch_id`
  )
  if (cycles.length === 0) return []

  const batchIds = cycles.map((c) => c.batch_id)
  const ready = await batchesPastPushThreshold(batchIds, FINAL_SWEEP_AFTER_MINUTES)
  const eligibleCycles = cycles.filter((c) => ready.has(c.batch_id))
  if (eligibleCycles.length === 0) return []

  const results = []
  for (const cycle of eligibleCycles) {
    const claimed = await claimCycleForFinalSweep(cycle.id)
    if (!claimed) continue // another invocation already swept (or is sweeping) this cycle

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

    const problems = []
    let cleanCount = 0

    for (const row of rows) {
      // 2026-09-19 fix: this loop used to overwrite reconciliation_status/
      // reconciliation_checked_at/reconciliation_details unconditionally,
      // with no record of what was there before — meaning the very
      // history needed to diagnose an earlier-phase anomaly (e.g. a batch
      // whose Phase 1 "observe" only processed some of its rows, most
      // likely from this app's already-documented Netlify scheduled-
      // function reliability issue, see netlify.toml) got destroyed by
      // the same sweep that would otherwise help explain it. Every row
      // now gets its pre-sweep status/checked_at/details snapshotted into
      // dedicated pre_sweep_* columns in the SAME patch that overwrites
      // the live fields, so "what did Phase 1/2 actually do to this row,
      // if anything" is never lost. row.reconciliation_status/
      // reconciliation_checked_at/reconciliation_details here are
      // whatever the earlier fetch found BEFORE this sweep touched
      // anything — exactly the pre-sweep values.
      const preSweep = {
        pre_sweep_status: row.reconciliation_status,
        pre_sweep_checked_at: row.reconciliation_checked_at,
        pre_sweep_details: row.reconciliation_details,
      }

      const expectedLines = expectedByRowId.get(row.id)
      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          ...preSweep,
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'original staged CSV data not found (final sweep)',
        })
        problems.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
        continue
      }

      const { verified, details } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      // Overwrites reconciliation_status regardless of its current value
      // — the authoritative, closing answer for this row. preSweep above
      // is what keeps that overwrite from being a destructive one.
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        ...preSweep,
        reconciliation_status: verified ? 'verified' : 'mismatch',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: verified ? null : `${details} | found during final T+${FINAL_SWEEP_AFTER_MINUTES}min sweep`,
      })

      if (verified) cleanCount += 1
      else problems.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details })
    }

    const detailsText = problems.length === 0
      ? `All ${rows.length} orders verified complete.`
      : `${cleanCount} of ${rows.length} orders verified complete. ${problems.length} do not match the original CSV.`
    await supabasePatch(`/rest/v1/dpi_monthly_cycles?id=eq.${cycle.id}`, { final_sweep_details: detailsText })

    await postFinalSweepSummary(cycle, rows.length, cleanCount, problems)
    results.push({ facility: cycle.facility, monthKey: cycle.month_key, swept: rows.length, verified: cleanCount, problems })
  }

  return results
}

async function postFinalSweepSummary(cycle, totalCount, cleanCount, problems) {
  const prefix = `**DPI Monthly FINAL SWEEP — ${cycle.facility}, ${cycle.month_key}**`
  const intro = `T+${FINAL_SWEEP_AFTER_MINUTES} minutes after import — a complete, independent re-check of every order against the original CSV, regardless of any earlier reconciliation status. This is the final word on this push.`

  if (problems.length === 0) {
    await postToFront(`${prefix}\n${intro}\nAll ${totalCount} orders verified complete. Nothing further needed.`)
    return
  }

  const problemLines = problems.slice(0, 15).map((p) => `- ${p.agency_name} (#${p.agency_number}, order ${p.datex_order_id}): ${p.details}`)
  const extra = problems.length > 15 ? `\n...and ${problems.length - 15} more` : ''
  await postToFront(
    `${prefix}\n${intro}\n${cleanCount} of ${totalCount} verified complete. ${problems.length} need manual review in Datex — these will NOT be auto-corrected:\n${problemLines.join('\n')}${extra}`
  )
}

async function postRoutineSummary(observeResult, confirmResult, isTest) {
  const prefix = isTest ? '**DPI Monthly Reconciliation (manual test run)**' : '**DPI Monthly Reconciliation**'
  const clauses = []

  if (observeResult.checked > 0) {
    clauses.push(
      `Observed ${observeResult.checked} new order(s) (${observeResult.facilities.join(', ')}) — ${observeResult.verified} verified` +
      (observeResult.flagged > 0 ? `, ${observeResult.flagged} flagged for independent confirmation in 30 min (not yet touched in Datex)` : '')
    )
  }

  if (confirmResult.checked > 0) {
    const mismatchCount = confirmResult.mismatches.length
    clauses.push(
      `confirmed ${confirmResult.checked} previously-flagged order(s) (${confirmResult.facilities.join(', ')}) — ${confirmResult.verified} were false alarms (sync caught up, nothing touched)` +
      (confirmResult.healed > 0 ? `, ${confirmResult.healed} confirmed missing and resubmitted` : '') +
      (mismatchCount > 0 ? `, ${mismatchCount} need manual review` : '') +
      (confirmResult.deferred > 0 ? `, ${confirmResult.deferred} deferred (batch looks like a systemic sync stall, not real drops — will re-check without backfilling anything yet)` : '')
    )
  }

  if (clauses.length === 0) return // nothing happened this tick — no noise post

  let body = `${prefix}\n${clauses.join('; ')}.`
  if (confirmResult.mismatches.length > 0) {
    const lines = confirmResult.mismatches.slice(0, 10).map((m) => `- ${m.agency_name} (#${m.agency_number}, order ${m.datex_order_id}): ${m.details}`)
    const extra = confirmResult.mismatches.length > 10 ? `\n...and ${confirmResult.mismatches.length - 10} more` : ''
    body += `\n${lines.join('\n')}${extra}`
  }

  await postToFront(body)
}

// Runs all three phases and posts whatever Front messages are due this
// tick. isTest bypasses the timing gates on Phases 1/2 (never on Phase
// 3 — a final sweep must reflect real elapsed time, not testing
// convenience, since prematurely closing out a push defeats the point).
// batchIdFilter scopes Phases 1/2 to one specific push (both -test-only
// conveniences); Phase 3 is deliberately never scoped by it, since a
// final sweep is about whether a whole push is done, independent of
// whatever single batch a -test call might be targeting.
async function runReconciliation(isTest = false, batchIdFilter = null) {
  const observeResult = await runObservePhase(isTest, batchIdFilter)
  const confirmResult = await runConfirmAndHealPhase(isTest, batchIdFilter)
  await postRoutineSummary(observeResult, confirmResult, isTest)

  const finalSweeps = await runFinalSweepPhase()

  return {
    ok: true,
    observed: observeResult.checked,
    observeVerified: observeResult.verified,
    flagged: observeResult.flagged,
    confirmed: confirmResult.checked,
    confirmVerified: confirmResult.verified,
    healed: confirmResult.healed,
    mismatches: confirmResult.mismatches,
    finalSweeps,
  }
}

module.exports = { runReconciliation, FIRST_CHECK_AFTER_MINUTES, CONFIRM_AFTER_MINUTES, FINAL_SWEEP_AFTER_MINUTES }
