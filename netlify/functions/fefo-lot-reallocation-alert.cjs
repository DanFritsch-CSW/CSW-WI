'use strict'

// FEFO Lot Reallocation Alert — real-time, per-project (added 2026-07-26 per
// Dean/Bry's Slack feedback, relayed via Dan): flag when a batch/lot
// allocated to an order gets cancelled and reallocated to a different lot
// without the office being notified — the exact gap that let the
// 7/22-vs-7/23 Fair Oaks date-code mixup ship before anyone caught it.
//
// ── Why this does NOT detect the raw cancel/reallocate task event ──────────
//
// The original plan was to detect this directly from
// silver.datex_slv_tasks (a cancelled pick task whose lot differs from the
// task that later completes on the same order/line). Validated live before
// building — and the validation FAILED in an important way, documented
// here so a future session doesn't re-attempt the same approach without
// re-reading this:
//
//   - Most cancelled/completed task pairs on the same order/line share the
//     SAME lot_id, SAME license plate, SAME target location, completed
//     ~0.1s after cancelled. That's Datex's own audit-trail bookkeeping for
//     ONE real physical pick (multi-lot case picking when an order line
//     needs more cases than one pallet holds), not a lot swap. An initial
//     "confirmed feasible" read of order 759352/line 2 (10 lots cancelled
//     before landing on one 22 days newer) was WRONG on this basis — it
//     was normal multi-lot picking by one employee (csw-celmore),
//     consolidating 12 real partial-pallet picks to one staging location,
//     not a FEFO violation.
//   - Narrowing to "genuinely abandoned" lots (cancelled with no completed
//     record on that same lot at all) mostly turned out to be zero-quantity
//     PLANNING-stage cancellations (actual_inventory_amount=0, no LP, no
//     location — nothing was ever physically touched), immediately followed
//     by decomposition into a burst of legitimate partial picks across many
//     lots to satisfy the line's quantity — again not a clean single-lot
//     swap.
//   - reason_code_id on cancelled picking tasks is NULL for 100% of rows
//     checked (0 of 95,673 in a 2-month sample) — Datex gives no "why was
//     this cancelled" signal to lean on either.
//
// Conclusion: the physical event Dean described (a warehouseman couldn't
// locate an allocated pallet, cancelled it, grabbed a different one) is not
// reliably reconstructable from this task audit trail without a real risk
// of firing on routine multi-lot-picking noise or missing real cases.
//
// ── What this detects instead: FEFO verdict transitions ─────────────────────
//
// Rather than the mechanism, this detects the OUTCOME Dean actually cares
// about, using the FEFO tab's own already-live, already-trusted verdict
// engine (orderVerdict/lineVerdict — the same logic driving every visible
// banner/KPI on the FEFO Rotation tab). Every ~30 min, this function:
//   1. Pulls the current 5-day forward order window per project (same
//      fefo-orders.cjs call the live tab makes).
//   2. Computes each order's verdict + severity (dependency-free CJS port
//      of src/lib/fefo.js — same pattern fefo-digest-run.cjs already uses;
//      mirror future verdict-engine changes here too).
//   3. Compares against the LAST POLL's stored verdict per order
//      (fefo_order_verdict_state table, keyed by dashboard_type + order_id).
//   4. Alerts ONLY on transitions INTO violation — an order that was
//      clean/stale/hold/blocked last poll and is now 'violation' — using
//      the same critical (>=4 days)/warning (1-3 days) severity split as
//      the live tab. Standing violations that haven't changed don't
//      re-alert every 30 min; that would just be a noisier version of the
//      nightly digest, not an urgent signal.
//
// This is a real design pivot from the original cancel/reallocate-task
// premise, agreed with Dan 2026-07-26 after the above validation failure.
//
// ── Two invocation paths (same convention as fefo-digest-run.cjs) ──────────
//   1. SCHEDULED (netlify.toml: "*/30 * * * *", a separate/slower tick than
//      the other digests' */15 — see NotifySettingsPanel description text:
//      "Checks continuously (~30 min)") — loops every active
//      fefo_realloc_* row and runs the check for each.
//   2. MANUAL TEST — POST { dashboardType: 'fefo_realloc_<projectId>' }.
//      Runs the exact same real detection logic (no fabricated demo data).
//      If it finds a real newly-violating order, posts the real alert. If
//      it finds none, posts a short "test successful, nothing new right
//      now" confirmation to Front instead, so Dan gets proof the
//      conversation ID is wired correctly without having to wait for a
//      coincidental real event.

const NO_CACHE_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

// Scoped to all FEFO projects EXCEPT JDF (Dan's explicit call, 2026-07-26)
// — JDF is a backward-looking closed-order retrospective audit, not a live
// allocation feed, so "newly appearing violation" doesn't apply to it the
// same way (every JDF order is already shipped by the time it's reviewed).
const FEFO_PROJECTS = [
  { id: 'faioa5', code: 'FAIOA5', name: 'Fair Oaks Farms', facility: 'ken' },
  { id: 'fofwe5', code: 'FOFWE5', name: 'Fair Oaks Farms West', facility: 'ken' },
  { id: 'riche5', code: 'RICHE5', name: 'Richelieu Foods', facility: 'ken' },
  { id: 'golst5', code: 'GOLST5', name: 'Crown Bakeries', facility: 'ken' },
  { id: 'birch5', code: 'BIRCH5', name: 'Birchwood Foods', facility: 'ken' },
  { id: 'palvi9', code: 'PALVI9', name: "Palermo's Caledonia", facility: 'cal' },
  { id: 'palma9', code: 'PALMA9', name: "Palermo's Caledonia Materials", facility: 'cal' },
  { id: 'paldsd9', code: 'PALDSD9', name: "Palermo's Caledonia DSD", facility: 'cal' },
]
const PROJECT_BY_DASHBOARD_TYPE = new Map(FEFO_PROJECTS.map(p => [`fefo_realloc_${p.id}`, p]))
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=fefo'
const DAY_COUNT = 5 // same forward window the live tab shows

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

async function sbUpsert(path, rows, onConflict) {
  if (!rows.length) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: `resolution=merge-duplicates,return=minimal`,
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(t) }
}

// ── Verdict engine — ported from src/lib/fefo.js (kept dependency-free) ────
// Identical logic to fefo-digest-run.cjs's port. Mirror any future changes
// made to fefo.js's verdict engine in both places.

const VERDICT_PRECEDENCE = { violation: 0, stale: 1, hold: 2, blocked: 3, clean: 4 }

function lineVerdict(line) {
  if (!line?.ship?.length) return 'clean'
  const datedShip = line.ship.filter(s => !s.dateUnknown)
  if (!datedShip.length) return 'clean'
  const oldKDay = Math.min(...datedShip.map(s => s.kDay ?? s.k))
  const rem = line.rem
  const remKDay = rem?.kDay ?? rem?.k
  if (rem && !rem.dateUnknown && rem.lps > 0 && remKDay != null && remKDay < oldKDay) {
    if (rem.hold) return 'hold'
    if (rem.locationBlocked) return 'blocked'
    return 'violation'
  }
  return 'clean'
}

function orderVerdict(order) {
  const verdicts = (order.lines || []).map(lineVerdict)
  const worst = verdicts.length
    ? verdicts.reduce((a, b) => VERDICT_PRECEDENCE[a] <= VERDICT_PRECEDENCE[b] ? a : b)
    : 'clean'
  if (order.past && worst !== 'violation') return 'stale'
  return worst
}

function parseDisplayDate(display) {
  if (!display || typeof display !== 'string') return null
  const m = display.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/)
  if (!m) return null
  const month = Number(m[1]), day = Number(m[2])
  let year = Number(m[3]); if (year < 100) year += 2000
  const d = new Date(Date.UTC(year, month - 1, day))
  return Number.isNaN(d.getTime()) ? null : d
}

function lineDaysOlder(line) {
  if (lineVerdict(line) !== 'violation') return 0
  if (!line?.ship?.length || !line?.rem?.date) return 0
  const datedShip = line.ship.filter(s => !s.dateUnknown)
  if (!datedShip.length) return 0
  const oldShip = datedShip.reduce((a, b) => a.k < b.k ? a : b)
  const shipDate = parseDisplayDate(oldShip.date)
  const remDate = parseDisplayDate(line.rem.date)
  if (!shipDate || !remDate) return 0
  return Math.max(0, Math.round((shipDate.getTime() - remDate.getTime()) / 86400000))
}

function orderMaxDaysOlder(order) {
  let max = 0
  for (const line of (order.lines || [])) { const d = lineDaysOlder(line); if (d > max) max = d }
  return max
}

// Severity thresholds — matches src/lib/fefo.js's SEVERITY_THRESHOLDS
// exactly (critical: 4, warning: 1). Locked in with Dan 2026-07-26 as the
// alert-worthy threshold: reuse both bands rather than inventing a
// separate cutoff for this alert.
function orderSeverity(order) {
  const days = orderMaxDaysOlder(order)
  if (days === 0) return null
  return days >= 4 ? 'critical' : 'warning'
}

// ── Message ──────────────────────────────────────────────────────────────

function buildAlertBody(newlyViolating, project) {
  const lines = []
  lines.push(`⚠ FEFO Lot Reallocation Alert — ${project.name} (${project.code})`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push('')
  const divider = '─'.repeat(28)
  lines.push(divider)
  lines.push(`**${newlyViolating.length} order${newlyViolating.length === 1 ? '' : 's'} newly out of rotation**`)
  lines.push(divider)
  lines.push('')
  lines.push('These orders were shipping the oldest available stock as of the last check (~30 min ago) and now are not — a newer lot got allocated in place of older, unallocated, off-hold stock that is still on hand.')
  lines.push('')
  for (const o of newlyViolating) {
    const days = orderMaxDaysOlder(o)
    const sev = orderSeverity(o)
    lines.push(`• ${o.id} — ${days}d older${sev ? ` (${sev.toUpperCase()})` : ''} — ${o.dest || 'dest unknown'}${o.appt ? ` — appt ${o.appt}` : ''}`)
    lines.push('')
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function buildTestOkBody(project) {
  return [
    `✓ FEFO Lot Reallocation Alert test — ${project.name} (${project.code})`,
    '',
    'Test successful — this Front conversation is wired up correctly. No newly-appearing FEFO violations were found for this project just now (that\'s expected most of the time — this only posts again when a real one shows up).',
  ].join('\n')
}

async function postFrontComment(conversationId, body) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

// ── Core per-project check ──────────────────────────────────────────────

async function runForProject({ settingsRow, project, isManualTest }) {
  const conversationId = settingsRow?.front_conversation_id
  if (!conversationId) {
    return { ok: false, reason: `No front_conversation_id configured for ${project.code}`, project: project.code }
  }

  const ordersRes = await fetch(`${SITE_URL}/.netlify/functions/fefo-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facility: project.facility, projectIds: [project.id], dayCount: DAY_COUNT }),
  })
  const ordersText = await ordersRes.text()
  let ordersJson
  try { ordersJson = JSON.parse(ordersText) } catch { ordersJson = { raw: ordersText } }
  if (!ordersRes.ok) {
    return { ok: false, reason: 'fefo-orders failed', detail: ordersJson, project: project.code }
  }

  const orders = ordersJson.ordersByProject?.[project.id] || []
  const dashboardType = `fefo_realloc_${project.id}`

  // Previous state for every order currently in view.
  const prevRows = orders.length
    ? await sbFetch(
        `fefo_order_verdict_state?dashboard_type=eq.${dashboardType}&order_id=in.(${orders.map(o => `"${o.id}"`).join(',')})&select=order_id,verdict`
      )
    : []
  const prevByOrderId = new Map((prevRows || []).map(r => [r.order_id, r.verdict]))

  const newlyViolating = []
  const stateRows = []
  for (const o of orders) {
    const verdict = orderVerdict(o)
    const severity = verdict === 'violation' ? orderSeverity(o) : null
    stateRows.push({ dashboard_type: dashboardType, order_id: o.id, verdict, severity, updated_at: new Date().toISOString() })
    const prevVerdict = prevByOrderId.get(o.id)
    if (verdict === 'violation' && prevVerdict !== 'violation') {
      newlyViolating.push(o)
    }
  }

  // Always persist current state so the NEXT poll has something to diff
  // against, regardless of whether this poll found anything alert-worthy.
  await sbUpsert('fefo_order_verdict_state', stateRows, 'dashboard_type,order_id')

  if (newlyViolating.length > 0) {
    const body = buildAlertBody(newlyViolating, project)
    const front = await postFrontComment(conversationId, body)
    return { ok: true, project: project.code, alerted: true, newlyViolatingCount: newlyViolating.length, commentId: front.id }
  }

  if (isManualTest) {
    const front = await postFrontComment(conversationId, buildTestOkBody(project))
    return { ok: true, project: project.code, alerted: false, testConfirmation: true, commentId: front.id }
  }

  return { ok: true, project: project.code, alerted: false, orderCount: orders.length }
}

async function runCheck({ isManualTest, dashboardType }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!SITE_URL) throw new Error('Site URL (process.env.URL/DEPLOY_URL) not available')

  if (isManualTest) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(dashboardType)
    if (!project) return { ok: false, reason: `Unknown dashboardType '${dashboardType}'` }
    const rows = await sbFetch(
      `prepick_notify_settings?facility=eq.${project.facility}&dashboard_type=eq.${dashboardType}&select=front_conversation_id,active`
    )
    const settingsRow = rows?.[0]
    return runForProject({ settingsRow, project, isManualTest: true })
  }

  // Scheduled tick — loop every active fefo_realloc_* row across all
  // facilities (dashboard_type already uniquely identifies the project).
  const rows = await sbFetch(
    `prepick_notify_settings?dashboard_type=like.fefo_realloc_*&active=eq.true&select=facility,dashboard_type,front_conversation_id,active`
  )
  const results = []
  for (const row of (rows || [])) {
    const project = PROJECT_BY_DASHBOARD_TYPE.get(row.dashboard_type)
    if (!project) continue
    try {
      const r = await runForProject({ settingsRow: row, project, isManualTest: false })
      results.push(r)
    } catch (e) {
      results.push({ ok: false, project: project.code, reason: e.message })
    }
  }
  return { ok: true, results }
}

exports.handler = async function (event) {
  const isScheduled = event.headers['x-netlify-event'] === 'schedule'
  const isManualTest = event.httpMethod === 'POST' && !isScheduled

  if (!isScheduled && !isManualTest) {
    return { statusCode: 405, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'POST only (or scheduled invocation)' }) }
  }

  let dashboardType
  if (isManualTest) {
    try { ({ dashboardType } = JSON.parse(event.body || '{}')) } catch { /* noop */ }
    if (!dashboardType) {
      return { statusCode: 400, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: 'dashboardType required for manual test, e.g. "fefo_realloc_faioa5"' }) }
    }
  }

  try {
    const result = await runCheck({ isManualTest, dashboardType })
    return { statusCode: result.ok ? 200 : 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ success: result.ok, ...result }) }
  } catch (err) {
    return { statusCode: 502, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) }
  }
}
