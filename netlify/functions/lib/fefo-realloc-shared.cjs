'use strict'

// Shared core for the FEFO Lot Reallocation Alert — split out 2026-07-30
// from fefo-lot-reallocation-alert.cjs.
//
// Same reason as lib/fefo-digest-shared.cjs's split: Netlify blocks direct
// HTTP invocation of any function carrying a `schedule` in netlify.toml.
// This module holds the actual detection/alerting logic; the scheduled
// function (fefo-lot-reallocation-alert.cjs, keeps its `schedule`) and the
// new manual-test-only function (fefo-lot-reallocation-alert-test.cjs, no
// schedule) both require this module rather than duplicating logic.
//
// See fefo-lot-reallocation-alert.cjs's original header (preserved in git
// history) for the full design history — most importantly, WHY this
// detects FEFO verdict transitions rather than raw task cancellations
// (the original cancel/reallocate-task approach was validated live and
// found unreliable — see that writeup for the full story).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const SITE_URL = process.env.URL || process.env.DEPLOY_URL

const FEFO_PROJECTS = [
  { id: 'faioa5', code: 'FAIOA5', name: 'Fair Oaks Farms', facility: 'ken' },
  { id: 'fofwe5', code: 'FOFWE5', name: 'Fair Oaks Farms West', facility: 'ken' },
  { id: 'riche5', code: 'RICHE5', name: 'Richelieu Foods', facility: 'ken' },
  { id: 'golst5', code: 'GOLST5', name: 'Crown Bakeries', facility: 'ken' },
  { id: 'birch5', code: 'BIRCH5', name: 'Birchwood Foods', facility: 'ken' },
  { id: 'palvi9', code: 'PALVI9', name: "Palermo's Caledonia", facility: 'cal' },
  { id: 'palma9', code: 'PALMA9', name: "Palermo's Caledonia Materials", facility: 'cal' },
  { id: 'paldsd9', code: 'PALDSD9', name: "Palermo's Caledonia DSD", facility: 'cal' },
  // Added 2026-08-28 alongside the live-tab Echo Lakes addition (see
  // fefo-orders.cjs/fefo.js for the full writeup) -- included here so the
  // FEFO Lot Reallocation Alert settings panel (which maps over the
  // client's FEFO_PROJECTS list) doesn't offer a project this file can't
  // actually alert for.
  { id: 'echlk5', code: 'ECHLK5', name: 'Echo Lakes Foods', facility: 'ken' },
]
const PROJECT_BY_DASHBOARD_TYPE = new Map(FEFO_PROJECTS.map(p => [`fefo_realloc_${p.id}`, p]))
const APP_URL = 'https://csw-wi.netlify.app/customers?tab=fefo'
const DAY_COUNT = 5

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

async function sbUpsert(path, rows) {
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

function orderSeverity(order) {
  const days = orderMaxDaysOlder(order)
  if (days === 0) return null
  return days >= 4 ? 'critical' : 'warning'
}

// ── Manual reallocation detection (2026-10-07, IT Ops Sync action item) ────
//
// Dean's ask on the call: when a lot shows up as a newly-violating FEFO
// order, tell ops WHY in the Front alert if it's because someone manually
// reallocated inventory (e.g. the Hunt Brothers/Palermo's partials case —
// Henry/Sergio pulling partials out of rotation on purpose to rebuild them
// into full pallets) rather than a genuine FEFO miss. This doesn't suppress
// the alert (Hill's call: still fine to flag even when the reallocation was
// legitimate) — it just attaches the "why" so ops can triage faster.
//
// Confirmed live via MotherDuck the same day: Datex records this as a
// COMPLETED Manual Pick/Batch Allocation task (operation_code_id 23 or 71 —
// production_db.bronze.datex_operationcodes.SystemLabel
// 'ManualPickAllocation' / 'ManualBatchAllocation') with a Notes field
// carrying one of two live patterns:
//   - "Created by conversion of pick task" — a pick task got converted to
//     a manual allocation (what Arielle found manually via the Datex CLI).
//   - "ManualAllocationTask [id] created through reallocation process by
//     user [username]" — explicit, names the user who triggered it
//     directly in the note. Preferred when present (no need to fall back
//     to modified_sys_user).
//
// This matches on ORDER, not lot: the manual-allocation task's lot_id is
// frequently NULL (the task doesn't always carry the destination lot), but
// order_id is always populated and buildAlertBody already resolves each
// lot bullet back to its first affected order, so order-level attribution
// is sufficient.
//
// order.id from fefo-orders.cjs is a DISPLAY string (`SO-<lookup_code>`),
// not the raw numeric order_id datex_slv_tasks keys on — so this joins
// through datex_slv_orders.lookup_code rather than order_id directly.
const MANUAL_REALLOC_LOOKBACK_HOURS = 48
const MANUAL_REALLOC_NOTE_PATTERN = "(t.Notes ILIKE '%conversion of pick task%' OR t.Notes ILIKE '%reallocation process%')"

function shortDatexUser(u) {
  if (!u) return 'unknown user'
  return String(u).replace(/^FOOTPRINT\\(csw-)?/i, '').replace(/^csw-/i, '')
}

async function queryMotherDuck(sql) {
  process.env.HOME = process.env.HOME || '/tmp'
  process.env.motherduck_token = process.env.MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database(':memory:')
  const conn = db.connect()
  const exec = (s) => new Promise((resolve, reject) => conn.run(s, (err) => err ? reject(err) : resolve()))
  const runQuery = (s) => new Promise((resolve, reject) => conn.all(s, (err, rows) => err ? reject(err) : resolve(rows)))
  try {
    await exec("SET home_directory='/tmp'")
    await exec('INSTALL motherduck')
    await exec('LOAD motherduck')
    await exec(`ATTACH 'md:production_db'`)
    return await runQuery(sql)
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

// findManualReallocations — given the `order.id` display strings
// (`SO-<lookup_code>`) of the newly-violating orders for one project,
// returns a Map<orderDisplayId, { user, note, completedAt }> for every one
// that has a matching completed manual-allocation task in the lookback
// window. Best-effort: a MotherDuck failure here should never block the
// underlying FEFO alert from going out, so it logs and returns an empty
// map rather than throwing.
async function findManualReallocations(orderDisplayIds) {
  const lookupCodes = orderDisplayIds
    .map(id => String(id).replace(/^SO-/, ''))
    .filter(Boolean)
  if (!lookupCodes.length) return new Map()
  if (!process.env.MOTHERDUCK_TOKEN) return new Map()

  const lookupList = lookupCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(',')
  const sql = `
    SELECT o.lookup_code AS order_lookup, t.Notes, t.completed_date_time, t.modified_sys_user
    FROM production_db.silver.datex_slv_tasks t
    JOIN production_db.silver.datex_slv_orders o ON o.order_id = t.order_id
    JOIN production_db.silver.datex_slv_taskstatuses ts ON ts.task_status_id = t.status_id
    WHERE o.lookup_code IN (${lookupList})
      AND t.operation_code_id IN (23, 71)
      AND ts.status_name = 'Completed'
      AND t.completed_date_time >= NOW() - INTERVAL '${MANUAL_REALLOC_LOOKBACK_HOURS} hours'
      AND ${MANUAL_REALLOC_NOTE_PATTERN}
    ORDER BY t.completed_date_time DESC
  `
  let rows
  try {
    rows = await queryMotherDuck(sql)
  } catch (e) {
    console.warn('findManualReallocations failed (alert still proceeds without it):', e.message)
    return new Map()
  }

  const byOrderDisplayId = new Map()
  for (const r of rows) {
    const displayId = `SO-${r.order_lookup}`
    if (byOrderDisplayId.has(displayId)) continue // rows are DESC by completed_date_time — keep most recent
    const explicitUserMatch = String(r.Notes || '').match(/reallocation process by user \[([^\]]+)\]/i)
    const user = explicitUserMatch ? shortDatexUser(explicitUserMatch[1]) : shortDatexUser(r.modified_sys_user)
    byOrderDisplayId.set(displayId, { user, note: r.Notes, completedAt: r.completed_date_time })
  }
  return byOrderDisplayId
}

// buildAlertBody — regrouped by culprit lot, not by order (2026-09-25, per
// Dean's Fathom check-in with Dan). Before this change, every newly-
// violating order got its own bullet, so a single misallocated lot that
// clipped 5 different orders produced 5 near-identical lines. Dean's ask:
// one bullet per culprit lot (the newer lot that jumped the queue —
// line.rem.lot), showing the first affected order for context, with an
// "also affects N more orders" tail instead of enumerating every one.
// Grouping key is the REM lot code, not the order or the material —
// deliberately collapses across materials/lines too, since the thing
// ops cares about triaging is "this lot got misallocated," not "this
// line item on this order is 3 days older."
//
// reallocByOrder (added 2026-10-07) — Map<orderDisplayId, {user,...}> from
// findManualReallocations above. When the FIRST affected order for a lot
// has a match, the bullet gets a trailing "— reallocated by <user>" note.
// Per Hill's call on the IT Ops Sync: this is informational only, it does
// NOT suppress or downgrade the alert — a legitimate manual reallocation
// (e.g. Hunt Brothers partials) still surfaces, just with the cause
// attached so ops can triage it in one glance instead of digging through
// Datex task history.
function buildAlertBody(newlyViolating, project, reallocByOrder) {
  reallocByOrder = reallocByOrder || new Map()
  const lines = []
  lines.push(`⚠ FEFO Lot Reallocation Alert — ${project.name} (${project.code})`)
  lines.push(APP_URL)
  lines.push('CSW Operations Hub')
  lines.push('')
  const divider = '─'.repeat(28)
  lines.push(divider)

  // Group violating lines by culprit lot (line.rem.lot) across all newly-
  // violating orders. A lot with no parsed code (shouldn't happen for a
  // 'violation' verdict, since that requires a real rem entry) falls back
  // to '(unknown lot)' rather than being dropped.
  const orderIndex = new Map(newlyViolating.map((o, i) => [o, i]))
  const entriesByLot = new Map() // lot -> [{ order, days }]
  for (const o of newlyViolating) {
    for (const line of (o.lines || [])) {
      if (lineVerdict(line) !== 'violation') continue
      const lot = line.rem?.lot || '(unknown lot)'
      const days = lineDaysOlder(line)
      if (!entriesByLot.has(lot)) entriesByLot.set(lot, [])
      entriesByLot.get(lot).push({ order: o, days })
    }
  }

  const lotCount = entriesByLot.size
  lines.push(`**${lotCount} lot${lotCount === 1 ? '' : 's'} newly out of rotation** (${newlyViolating.length} order${newlyViolating.length === 1 ? '' : 's'} affected)`)
  lines.push(divider)
  lines.push('')
  lines.push('These orders were shipping the oldest available stock as of the last check (~30 min ago) and now are not — a newer lot got allocated in place of older, unallocated, off-hold stock that is still on hand.')
  lines.push('')

  for (const [lot, entries] of entriesByLot.entries()) {
    // Dedupe multiple lines on the same order hitting the same lot down to
    // one entry per order, keeping the worst (max) days-older for that order.
    const byOrder = new Map()
    for (const e of entries) {
      const existing = byOrder.get(e.order)
      if (!existing || e.days > existing.days) byOrder.set(e.order, e)
    }
    const orderEntries = [...byOrder.values()]
      .sort((a, b) => orderIndex.get(a.order) - orderIndex.get(b.order))
    const first = orderEntries[0]
    const maxDays = Math.max(...orderEntries.map(e => e.days))
    const sev = maxDays >= 4 ? 'critical' : 'warning'
    const moreCount = orderEntries.length - 1
    const realloc = reallocByOrder.get(first.order.id)
    const reallocSuffix = realloc ? ` — reallocated by ${realloc.user}` : ''
    lines.push(`• Lot ${lot} jumped the queue — ${first.order.id} — ${first.days}d older (${sev.toUpperCase()}) — ${first.order.dest || 'dest unknown'}${first.order.appt ? ` — appt ${first.order.appt}` : ''}${moreCount > 0 ? ` — also affects ${moreCount} more order${moreCount === 1 ? '' : 's'}` : ''}${reallocSuffix}`)
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

  await sbUpsert('fefo_order_verdict_state', stateRows)

  if (newlyViolating.length > 0) {
    // Best-effort lookup — a MotherDuck failure here must never block the
    // underlying alert (see findManualReallocations's own try/catch).
    const reallocByOrder = await findManualReallocations(newlyViolating.map(o => o.id))
    const body = buildAlertBody(newlyViolating, project, reallocByOrder)
    const front = await postFrontComment(conversationId, body)
    return {
      ok: true, project: project.code, alerted: true,
      newlyViolatingCount: newlyViolating.length,
      reallocatedCount: reallocByOrder.size,
      commentId: front.id,
    }
  }

  if (isManualTest) {
    const front = await postFrontComment(conversationId, buildTestOkBody(project))
    return { ok: true, project: project.code, alerted: false, testConfirmation: true, commentId: front.id }
  }

  return { ok: true, project: project.code, alerted: false, orderCount: orders.length }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, SITE_URL,
  FEFO_PROJECTS, PROJECT_BY_DASHBOARD_TYPE,
  sbFetch,
  runForProject,
  // exported for the manual-test function / potential direct testing
  findManualReallocations,
}
