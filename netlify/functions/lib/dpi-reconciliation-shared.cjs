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
//   1. First check (60+ min after push, well past the real sync delay):
//      if lines are missing, automatically resubmit just the missing
//      ones (safe at this point — see the sync-delay note above; this is
//      a fundamentally different timing regime than the same-day
//      in-process attempt that was reverted). Row moves to
//      'backfilling', not 'mismatch'.
//   2. Second check (60+ min after the backfill attempt): re-verify. If
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
//
// 2026-09-18 (whole-batch gating fix): a real 70-agency push spanned
// ~14 minutes end-to-end (orders processed sequentially, each with its
// own updated_at). The original per-ROW age check let a reconciliation
// tick fire the moment the FIRST-pushed rows crossed 45 minutes, while
// the last few pushed were still a few minutes short — producing a
// confusing partial report ("checked 67" when 70 were pushed), with the
// remaining 3 silently picked up and reported separately on the next
// tick. Nothing was ever lost or wrong, but Dan's call: a batch should
// be checked and reported as ONE complete unit, not dribbled across
// multiple Front messages. findFreshEligibleRows now gates on the
// OLDEST-eligible-moment of the whole batch — a batch's rows are only
// included once every 'success' row in that batch is at least
// RECONCILE_AFTER_MINUTES old (i.e. gated on the batch's most-recently-
// pushed row, not each row individually). If a batch isn't fully ready
// yet, it's simply skipped this tick and picked up whole on a later one
// — this is the "wait another 15 minutes and try again" behavior.
// Phase 2 (backfill re-checks) is intentionally NOT batch-gated — each
// row's own backfill timer is independent of its siblings, since only
// SOME rows in a batch typically need backfilling in the first place.

const { runMotherDuckQuery, getMaterialMap, submitLines, FACILITIES } = require('./dpi-monthly-shared.cjs')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

// 2026-09-19: raised from 45 to 60 minutes after a real, confirmed
// failure of the 45-minute assumption. A fresh Madison push that night
// had 4 orders where the ORIGINAL line hadn't yet synced into MotherDuck
// at the 45-minute mark — reconciliation saw it as genuinely missing,
// resubmitted it, and once the real original line finally synced in
// alongside the new duplicate, the quantity came back doubled (or
// tripled). The ~30-minute MotherDuck sync delay this whole design leans
// on is a typical figure, not a guarantee — 45 minutes wasn't always
// enough margin. 60 minutes doesn't make this impossible, just less
// likely; if it recurs, the fix is a bigger structural change (e.g.
// checking sync completion directly), not another bump of this number.
const RECONCILE_AFTER_MINUTES = 60
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

// 2026-09-19: closes a real race condition confirmed live — two
// reconciliation invocations running close together (a scheduled tick
// overlapping with another, no lock ever existed) both queried "not yet
// checked" rows and split a 70-order batch's processing between them
// (18 rows in one, 52 in the other), so the Front summary for the
// second invocation only described the 52 IT had touched, looking like
// 18 orders had vanished when they hadn't — everything was still
// correctly processed exactly once, purely by luck of timing, but nothing
// prevented two invocations from grabbing the SAME row instead, which
// would risk a genuine duplicate backfill (a second, code-level cause of
// duplicate lines, stacked on top of the MotherDuck-sync-delay one).
//
// This atomically claims one row by PATCHing it with a filter matching
// its CURRENT status (fromStatus) — Postgres applies that filter as part
// of the same UPDATE statement, so if two invocations race for the same
// row, only the one whose PATCH lands first actually matches the filter;
// the second one's WHERE clause matches zero rows and gets an empty
// array back. 'checking' is a transitional status that always gets
// overwritten with a real outcome (verified/mismatch/backfilling) by the
// end of processing that row — a row should never be visibly stuck in
// 'checking' unless its invocation crashed mid-row, which the next
// tick's fresh/backfilling queries won't pick back up (a real but rare
// gap; a stuck 'checking' row would need a manual status reset).
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

// Rows never checked before, gated on WHOLE-BATCH readiness (see file
// header). ignoreAgeForTesting bypasses the age gate entirely — used
// only by the -test entry point.
async function findFreshEligibleRows({ ignoreAgeForTesting = false, batchIdFilter = null } = {}) {
  const filters = [
    'status=eq.success',
    'datex_order_id=not.is.null',
    'reconciliation_status=is.null',
  ]
  if (batchIdFilter) filters.push(`batch_id=eq.${encodeURIComponent(batchIdFilter)}`)

  // Fetch all not-yet-checked 'success' rows first, WITHOUT an age filter
  // — age is evaluated per-batch below, not per-row, so it can't be
  // pushed down into the REST query the way it used to be.
  const candidates = await supabaseGet(`/rest/v1/dpi_import_batches?${filters.join('&')}&select=*`)
  if (ignoreAgeForTesting || candidates.length === 0) return candidates

  const cutoffMs = Date.now() - RECONCILE_AFTER_MINUTES * 60 * 1000
  const latestUpdatedByBatch = new Map() // batch_id -> most recent updated_at (ms) among its candidate rows

  for (const row of candidates) {
    const t = new Date(row.updated_at).getTime()
    const prev = latestUpdatedByBatch.get(row.batch_id)
    if (prev == null || t > prev) latestUpdatedByBatch.set(row.batch_id, t)
  }

  // A batch is ready only once its OWN most-recently-touched row has
  // crossed the age threshold — i.e. every row in it has, since none can
  // be newer than that one.
  const readyBatchIds = new Set(
    [...latestUpdatedByBatch.entries()].filter(([, latestMs]) => latestMs < cutoffMs).map(([id]) => id)
  )

  return candidates.filter((row) => readyBatchIds.has(row.batch_id))
}

// Rows where a backfill was attempted and are now old enough (60+ min
// since THAT attempt, not since the original push) to safely re-check
// against MotherDuck. Intentionally per-ROW, not per-batch — see file
// header for why this phase doesn't need the same batch-gating as
// findFreshEligibleRows.
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
  const totalChecked = summary.freshChecked + summary.recheckChecked
  if (totalChecked === 0) return // nothing to report this run — no noise post

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

  // 2026-09-18 fix: mismatches were previously always described as
  // "still short after N resubmission attempts," even for a row where
  // zero attempts were made (no shipment_id stored — pushed before that
  // column existed, so a safe automatic resubmit was never possible in
  // the first place). That wording falsely implied a resubmission had
  // silently failed, when in fact none was ever tried.
  //
  // 2026-09-19 fix: the "exhausted" half of that same wording had a
  // related, subtler version of the same problem — it always named
  // MAX_BACKFILL_ATTEMPTS (2) regardless of how many attempts that
  // SPECIFIC row actually went through (a row can be exhausted after
  // just 1 real attempt if the retry itself produces a quantity
  // mismatch, since compareLines treats any quantity mismatch as
  // immediately exhausted — see the doubled-quantity incident this
  // night). The per-row reconciliation_details line was already
  // accurate here; only this rolled-up summary sentence wasn't. Rather
  // than assert a specific attempt count that can vary per row, this
  // just points at the itemized lines below, which already state each
  // row's real count.
  const neverAttemptedCount = summary.mismatches.filter((m) => m.neverAttempted).length
  const exhaustedCount = summary.mismatches.length - neverAttemptedCount
  const mismatchReasonParts = []
  if (exhaustedCount > 0) mismatchReasonParts.push(`${exhaustedCount} still short after a resubmission attempt (see below for each)`)
  if (neverAttemptedCount > 0) mismatchReasonParts.push(`${neverAttemptedCount} could not be auto-backfilled at all (pushed before shipment_id tracking existed)`)
  const mismatchReasonSummary = mismatchReasonParts.join(', ')

  // 2026-09-19 fix: a single tick can run a FRESH check (a batch just
  // crossing the age gate) and a BACKFILL RE-CHECK (rows already
  // self-healing from an earlier, unrelated tick) at the same time —
  // different operations, often different facilities and order counts,
  // previously combined into one undifferentiated "Checked N order(s)"
  // number with no facility named at all (e.g. a fresh check of 42
  // Eau Claire/Madison rows and a re-check of 3 unrelated Madison rows
  // from an hour earlier looked like two inexplicable, arbitrary
  // numbers back to back). Each phase now gets its own clearly-labeled
  // clause, only included if that phase actually ran this tick.
  const phaseClauses = []
  if (summary.freshChecked > 0) {
    phaseClauses.push(`Checked ${summary.freshChecked} new order(s) (${summary.freshFacilities.join(', ')})`)
  }
  if (summary.recheckChecked > 0) {
    phaseClauses.push(`re-checked ${summary.recheckChecked} order(s) previously self-healing (${summary.recheckFacilities.join(', ')})`)
  }
  const phaseSummary = phaseClauses.join(', ')

  const body =
    summary.mismatches.length === 0
      ? `${prefix}\n${phaseSummary} — ${summary.verified} verified complete against the original CSV${healedNote}.${inProgressNote}`
      : `${prefix}\n${phaseSummary} — ${summary.verified} verified${healedNote}, ${summary.mismatches.length} need manual review (${mismatchReasonSummary}):\n${mismatchLines.join('\n')}${extra}${inProgressNote}`

  await postToFront(body)
}

// Shared by postReconciliationSummary and postFinalSweepSummary — both
// post to the same status thread, just with different message shapes.
async function postToFront(body) {
  if (!FRONT_API_TOKEN) return
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

// 2026-09-19: FINAL SWEEP — per Dan, every barrier to guarantee a push is
// clear, accurate, and fully resolved within 3-4 hours. The 60-minute
// self-healing cycle above handles the vast majority of gaps
// automatically and quickly, but it has real, structural limits: a
// quantity mismatch (including one self-healing itself causes, per the
// duplicate-line incidents this session) is intentionally never retried,
// a missing shipment_id blocks any auto-backfill outright, and — closed
// this same session, but worth designing around regardless — a crashed
// invocation could in principle leave a row stuck mid-claim. Rather than
// trust that every one of these edge cases individually reports itself
// correctly, this runs ONE independent, comprehensive, authoritative
// re-check of EVERY 'success' order in a push, regardless of whatever
// reconciliation_status it currently holds, a fixed FINAL_SWEEP_AFTER_HOURS
// after the push completed — using the exact same expected-vs-actual
// comparison as everything above, just scoped to "the whole push" instead
// of "whatever's due for a check this tick." Its own PATCH to each row
// overwrites reconciliation_status with the true, current answer
// (verified/mismatch) regardless of prior state, so a stuck 'checking'
// row or a missed edge case gets caught and corrected here even if
// nothing upstream ever flagged it. Runs once per cycle (final_sweep_at
// gates re-running it) and always posts its own message, clearly labeled
// as the final word — so there's exactly one message per push that can
// be trusted as the complete, closing answer without needing to piece
// together everything that came before it.
// 2026-09-19: lowered from 3.5 to 2 hours per Dan — comfortably past
// the ~80-minute MotherDuck sync-delay outlier confirmed live tonight,
// while still landing well inside the 3-4 hour target window. Not a
// race against self-healing's own schedule despite the tighter number:
// see the deferral check in findCyclesNeedingFinalSweep below — a cycle
// only gets swept once nothing in it is still legitimately mid-flight
// on its own backfill clock.
const FINAL_SWEEP_AFTER_HOURS = 2

async function findCyclesNeedingFinalSweep() {
  // 2026-09-19 fix: deliberately NOT filtered to status=eq.in_progress —
  // a cycle can reach 'complete' (all the way through Phase 5) well
  // before FINAL_SWEEP_AFTER_HOURS have passed, since a human can click
  // through Phases 2-5 in minutes. The sweep is about whether the REAL
  // Datex orders are correct, which has nothing to do with what UI phase
  // the cycle has reached — filtering to in_progress would have silently
  // skipped every push that got wrapped up quickly, which is likely most
  // of them.
  // Also bounded to recently-created cycles: final_sweep_at is a brand
  // new column, so every historical cycle (all of today's test runs,
  // older abandoned test cycles, etc.) starts out NULL — without this
  // bound, the very first tick after this ships would try to sweep every
  // cycle ever created in one go.
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const cycles = await supabaseGet(
    `/rest/v1/dpi_monthly_cycles?final_sweep_at=is.null&created_at=gte.${encodeURIComponent(recentCutoff)}&select=id,facility,month_key,batch_id`
  )
  if (cycles.length === 0) return []

  const batchIds = [...new Set(cycles.map((c) => c.batch_id))]
  const rows = await supabaseGet(
    `/rest/v1/dpi_import_batches?status=eq.success&batch_id=in.(${batchIds.map((id) => encodeURIComponent(id)).join(',')})&select=batch_id,updated_at`
  )
  if (rows.length === 0) return [] // no real orders in any of these cycles yet — nothing to sweep

  const latestByBatch = new Map()
  for (const row of rows) {
    const t = new Date(row.updated_at).getTime()
    const prev = latestByBatch.get(row.batch_id)
    if (prev == null || t > prev) latestByBatch.set(row.batch_id, t)
  }

  const cutoffMs = Date.now() - FINAL_SWEEP_AFTER_HOURS * 60 * 60 * 1000
  const timeEligible = cycles.filter((c) => {
    const latest = latestByBatch.get(c.batch_id)
    return latest != null && latest < cutoffMs
  })
  if (timeEligible.length === 0) return []

  // 2026-09-19: at a 2-hour sweep window, it's genuinely possible for a
  // row to still be mid-flight on its OWN legitimate backfill schedule
  // (self-healing's worst case — 2 real attempts, each needing
  // RECONCILE_AFTER_MINUTES to verify — can take up to 3 hours). Phase 1
  // and 2 above already run before this in the same invocation, so
  // anything that was DUE this tick has already been handled by the time
  // we get here — a row still showing 'backfilling' with a backfilled_at
  // younger than RECONCILE_AFTER_MINUTES is therefore genuinely not due
  // yet, not something Phase 2 missed. Sweeping it now would mean
  // reporting "mismatch" on something that might still resolve itself
  // within the hour, one attempt early. Any cycle with such a row is
  // simply skipped THIS tick — not marked swept — so it's naturally
  // reconsidered again in 15 minutes, once that row's own window has
  // either resolved it or made it due for Phase 2 to act on first.
  const pendingCutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60 * 1000).toISOString()
  const eligibleBatchIds = timeEligible.map((c) => c.batch_id)
  const stillMidFlight = await supabaseGet(
    `/rest/v1/dpi_import_batches?status=eq.success&reconciliation_status=eq.backfilling&reconciliation_backfilled_at=gte.${encodeURIComponent(pendingCutoff)}&batch_id=in.(${eligibleBatchIds.map((id) => encodeURIComponent(id)).join(',')})&select=batch_id`
  )
  const midFlightBatchIds = new Set(stillMidFlight.map((r) => r.batch_id))

  return timeEligible.filter((c) => !midFlightBatchIds.has(c.batch_id))
}

async function runFinalSweepForCycle(cycle) {
  const rows = await supabaseGet(
    `/rest/v1/dpi_import_batches?batch_id=eq.${encodeURIComponent(cycle.batch_id)}&status=eq.success&select=*`
  )
  if (rows.length === 0) {
    await supabasePatch(`/rest/v1/dpi_monthly_cycles?id=eq.${cycle.id}`, {
      final_sweep_at: new Date().toISOString(),
      final_sweep_details: 'No real (status=success) orders existed to sweep.',
    })
    return { swept: 0, verified: 0, problems: [] }
  }

  const expectedByRowId = await resolveExpectedLines(rows)
  const orderIds = [...new Set(rows.map((r) => r.datex_order_id).filter((id) => id != null))]
  const actualByOrderId = await fetchActualLines(orderIds)

  const problems = []
  let cleanCount = 0

  for (const row of rows) {
    const expectedLines = expectedByRowId.get(row.id)
    if (!expectedLines) {
      await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
        reconciliation_status: 'mismatch',
        reconciliation_checked_at: new Date().toISOString(),
        reconciliation_details: 'original staged CSV data not found (final sweep)',
      })
      problems.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found' })
      continue
    }

    const { verified, details } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
    // Overwrites reconciliation_status regardless of its current value —
    // this is the authoritative, closing answer for this row, not
    // subject to whatever intermediate state it was left in.
    await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
      reconciliation_status: verified ? 'verified' : 'mismatch',
      reconciliation_checked_at: new Date().toISOString(),
      reconciliation_details: verified ? null : `${details} | found during final ${FINAL_SWEEP_AFTER_HOURS}hr sweep`,
    })

    if (verified) {
      cleanCount += 1
    } else {
      problems.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details })
    }
  }

  const detailsText = problems.length === 0
    ? `All ${rows.length} orders verified complete.`
    : `${cleanCount} of ${rows.length} orders verified complete. ${problems.length} do not match the original CSV.`

  await supabasePatch(`/rest/v1/dpi_monthly_cycles?id=eq.${cycle.id}`, {
    final_sweep_at: new Date().toISOString(),
    final_sweep_details: detailsText,
  })

  await postFinalSweepSummary(cycle, rows.length, cleanCount, problems)
  return { swept: rows.length, verified: cleanCount, problems }
}

async function postFinalSweepSummary(cycle, totalCount, cleanCount, problems) {
  const prefix = `**DPI Monthly FINAL SWEEP — ${cycle.facility}, ${cycle.month_key}**`
  const intro = `${FINAL_SWEEP_AFTER_HOURS} hours after import — a complete, independent re-check of every order against the original CSV, regardless of any earlier reconciliation status. This is the final word on this push.`

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

// Runs one full reconciliation pass (both fresh checks and backfill
// re-checks) and posts the Front summary. isTest bypasses the 60-minute
// age gates; batchIdFilter scopes to one specific push (both -test-only
// conveniences).
async function runReconciliation(isTest = false, batchIdFilter = null) {
  let linesBackfilledThisRun = 0
  let verifiedCount = 0
  let healedByBackfill = 0
  let stillBackfilling = 0
  const mismatches = []
  // 2026-09-19 fix: a single reconciliation tick can run a FRESH check
  // (a batch just crossing the age gate for the first time) and a
  // BACKFILL RE-CHECK (rows already self-healing from an earlier,
  // unrelated tick) in the same invocation — two different operations on
  // two different, often differently-facilitied sets of rows. The old
  // combined "checked N" count gave no way to tell these apart (e.g. "42"
  // vs "3" back to back looked arbitrary), so they're now tracked and
  // reported separately, along with which facility(ies) each phase
  // touched.
  let freshCheckedCount = 0
  let recheckCheckedCount = 0
  const freshFacilities = new Set()
  const recheckFacilities = new Set()

  // ── Phase 1: rows never checked before ────────────────────────────────
  const freshRows = await findFreshEligibleRows({ ignoreAgeForTesting: isTest, batchIdFilter })
  if (freshRows.length > 0) {
    const expectedByRowId = await resolveExpectedLines(freshRows)
    const orderIds = [...new Set(freshRows.map((r) => r.datex_order_id))]
    const actualByOrderId = await fetchActualLines(orderIds)

    for (const row of freshRows) {
      freshFacilities.add(row.facility)
      const claimed = await claimRow(row.id, 'reconciliation_status=is.null')
      if (!claimed) continue // another invocation already grabbed this row this tick — not double-counted, not double-processed
      const expectedLines = expectedByRowId.get(row.id)

      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'Could not resolve original staged CSV lines for this agency — cycle/staged data may have been deleted.',
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found', neverAttempted: true })
        freshCheckedCount += 1
        continue
      }

      const { verified, details, missingLines, hasQtyMismatch } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      freshCheckedCount += 1

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
        // 2026-09-18 fix: NEITHER reason for reaching this branch ever
        // attempts a backfill — a quantity mismatch is intentionally
        // never auto-healed (too risky, see compareLines), and a missing
        // shipment_id makes a safe resubmit impossible outright. The old
        // summary wording said "still short after N resubmission
        // attempts" for every mismatch uniformly, which is simply false
        // here (0 attempts were made, not N) and was confusing Dan into
        // thinking a real resubmission had silently failed.
        // neverAttempted lets postReconciliationSummary word this
        // honestly, whichever of the two reasons applies.
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details, neverAttempted: true })
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
      recheckFacilities.add(row.facility)
      const claimed = await claimRow(row.id, 'reconciliation_status=eq.backfilling')
      if (!claimed) continue // another invocation already grabbed this row this tick
      const expectedLines = expectedByRowId.get(row.id)
      if (!expectedLines) {
        await supabasePatch(`/rest/v1/dpi_import_batches?id=eq.${row.id}`, {
          reconciliation_status: 'mismatch',
          reconciliation_checked_at: new Date().toISOString(),
          reconciliation_details: 'Could not resolve original staged CSV lines for this agency during backfill re-check.',
        })
        mismatches.push({ agency_number: row.agency_number, agency_name: row.agency_name, datex_order_id: row.datex_order_id, details: 'original staged data not found', neverAttempted: true })
        recheckCheckedCount += 1
        continue
      }

      const { verified, details, missingLines, hasQtyMismatch } = compareLines(expectedLines, actualByOrderId.get(row.datex_order_id))
      recheckCheckedCount += 1

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

  const summary = {
    ok: true,
    freshChecked: freshCheckedCount,
    freshFacilities: [...freshFacilities],
    recheckChecked: recheckCheckedCount,
    recheckFacilities: [...recheckFacilities],
    verified: verifiedCount,
    healedByBackfill,
    stillBackfilling,
    mismatches,
  }
  await postReconciliationSummary(summary, isTest)

  // ── Phase 3: final sweep for any cycle whose push crossed the
  // FINAL_SWEEP_AFTER_HOURS mark and hasn't been swept yet ─────────────
  // Deliberately NOT scoped by batchIdFilter — a final sweep is about
  // "is this whole push actually done," independent of whatever single
  // batch a -test call might be targeting.
  const cyclesNeedingSweep = await findCyclesNeedingFinalSweep()
  const finalSweeps = []
  for (const cycle of cyclesNeedingSweep) {
    finalSweeps.push({ facility: cycle.facility, monthKey: cycle.month_key, ...(await runFinalSweepForCycle(cycle)) })
  }

  return { ...summary, finalSweeps }
}

module.exports = { runReconciliation, RECONCILE_AFTER_MINUTES, MAX_BACKFILL_ATTEMPTS, FINAL_SWEEP_AFTER_HOURS }
