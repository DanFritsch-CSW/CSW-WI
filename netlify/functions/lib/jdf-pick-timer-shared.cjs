'use strict'

// JDF Pick Timer — shared logic for the scheduled tick and the manual test.
//
// WHAT IT DOES (agreed with Dan 2026-10-17):
//   Every 15 minutes, watch Jones Dairy Farm OUTBOUND orders at Madison
//   (Datex project_id 365, order class type = Outbound). When the first
//   Picking task of an order is completed, create ONE Front DISCUSSION thread
//   (Dan is the participant; changed from a Front task on 2026-10-17 at Dan's
//   request) that opens with the link to the order in Datex, and then add
//   comments to that same thread:
//     - Update      every tick while the completed-task counts change
//     - Stall       once, when picks are open and nothing has completed for 2h
//     - 10 PM note  once per night if the order is still open at 10 PM Central
//     - Final       when all picks are done (or Datex says Completed) and it
//                   has been quiet for 30 min: total pick time, shifts/days,
//                   Datex status, unpicked (short) allocations, vs. typical
//     - Stopped     36h after the task was created, if it never finished
//
// TIMING RULES (all derived from live data, see the Notion "JDF Watch" page):
//   * START = first completed *Picking* task. NOT the first task of either
//     kind: Manual Pick Allocation tasks complete at allocation time, often
//     hours or days BEFORE anyone picks.
//   * END = last completed Picking or Manual Pick Allocation task (Dan's
//     definition). Duration for a one-day order = END - START.
//   * Overnight: Datex task timestamps are Central local time and nothing
//     completes after 10 PM. For an order spanning days, "picking time" is the
//     sum of per-day windows (first pick that day -> last task that day) so the
//     overnight gap is not counted; wall-clock time is shown as a second line.
//   * DONE is NOT "no open tasks". 102 of 103 JDF orders (9/19-10/16) ended
//     Completed in Datex even though 22 still had open leftover tasks: those
//     are unpicked/short lines (e.g. JD101626-3OUT: 018753 40 CS and 018811
//     70 CS allocated, 0 picked). So DONE = all picks done OR Datex status
//     Completed, plus QUIET_MIN quiet, and leftover open tasks are reported as
//     "Short (not picked)", never as a blocker.
//   * Timestamps from MotherDuck here are naive Central; "now" is taken from
//     MotherDuck (timezone('America/Chicago', now())) so both sides match.
//
// STATE: Supabase table jdf_pick_timer (supabase/jdf_pick_timer.sql).
//   First ever run (empty table): orders already Completed/Cancelled are
//   recorded silently; orders still in progress (e.g. one open at deploy time)
//   DO get a task, with a description that already reflects their progress.
//
// ALWAYS LIVE: no env-var switch. The manual test function is a DRY RUN
// unless the POST body contains { "send": true }.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN || ''

const DAN_TEAMMATE_ID = 'tea_a3e8k' // same ID the other digests use
const JDF_PROJECT_ID = 365
const OUTBOUND_ORDER_TYPE_ID = 2 // datex_slv_orderclasses.order_type_id = 2 -> Sales Order etc.
// Direct link to the order in Datex (FootPrint Cloud sales order editor; note the camelCase orderId
// param, unlike the inbound ASN editor's order_id). JDF outbound is Sales Orders (class SO) and Hold
// Orders (class OHSO), both order_class_type_id 5 and both opened by this editor (confirmed on
// JD101626-6OUT, a Hold Order). The rare Outbound Material Transfer (class type 16) uses a different
// editor, so no link is shown for it rather than a wrong one.
const DATEX_SALES_ORDER_URL = 'https://csw-footprint-cloud.wavelength.host/FootprintManager_sales_order_editor?orderId='
const SALES_ORDER_CLASS_TYPE_ID = 5
const WINDOW_HOURS = 48 // look at orders whose first pick is this recent (dedupe is the table)
const LOOKBACK_DAYS = 30 // task scan bound
const QUIET_MIN = 30
const STALL_MIN = 120
const STOP_HOURS = 36
const HANDOFF_HOUR = 22 // 2nd shift ends 10 PM
const DAY_START_HOUR = 6 // 1st shift starts 6 AM
const MAX_OPEN_ITEMS = 6
// Typical JDF order: median first-pick -> last-task for orders that closed,
// 9/19-10/16/2026 (103 orders). Static on purpose; refresh if it drifts.
const TYPICAL_MIN = 111
const TYPICAL_TEXT = '1h 51m'

const TABLE = 'jdf_pick_timer'

function num(v) { return Number(v ?? 0) || 0 }

// ───────────────────────────── time helpers ─────────────────────────────
// All 'YYYY-MM-DD HH:MM:SS' strings are naive Central; parse them all the same way.
// Truncate to the minute so every duration agrees with the clock times we print.
function parseLocal(s) { return s ? Date.parse(String(s).slice(0, 16).replace(' ', 'T') + ':00Z') : NaN }
function clock(s) {
  const h = Number(s.slice(11, 13)), m = s.slice(14, 16)
  return `${((h + 11) % 12) + 1}:${m} ${h >= 12 ? 'PM' : 'AM'}`
}
function dayLabel(s) {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`)
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`
}
function dur(min) {
  const t = Math.max(0, Math.round(min))
  if (t < 60) return `${t}m`
  return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}m`
}
const sameDay = (a, b) => a.slice(0, 10) === b.slice(0, 10)

// ───────────────────────────── Supabase / Front ─────────────────────────────

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    err.body = text
    throw err
  }
  return text ? JSON.parse(text) : null
}

async function frontFetch(path, body) {
  const res = await fetch(`https://api2.frontapp.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Front POST ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

// Creates a Front internal discussion (same call as front-post-discussion.cjs and the
// Footprint variance digest): teammate_ids adds Dan as a participant, and the first
// comment is the opening message. Later updates are comments on the same conversation.
async function createFrontDiscussion({ subject, description }) {
  const created = await frontFetch('/conversations', {
    type: 'discussion', teammate_ids: [DAN_TEAMMATE_ID], subject, comment: { body: description },
  })
  return created.id
}
async function addFrontComment(conversationId, body) {
  await frontFetch(`/conversations/${encodeURIComponent(conversationId)}/comments`, { body })
}

// ───────────────────────────── MotherDuck ─────────────────────────────

async function openMotherDuck() {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database(':memory:')
  const conn = db.connect()
  const exec = (sql) => new Promise((resolve, reject) => conn.run(sql, (err) => (err ? reject(err) : resolve())))
  const query = (sql) => new Promise((resolve, reject) => conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))))
  await exec("SET home_directory='/tmp'")
  await exec('INSTALL motherduck')
  await exec('LOAD motherduck')
  await exec("ATTACH 'md:production_db'")
  const close = () => { try { conn.close(); db.close() } catch (_) {} }
  return { query, close }
}

function idList(ids) {
  return ids.map((n) => {
    if (!Number.isInteger(n)) throw new Error(`Bad order id: ${n}`)
    return n
  }).join(',') || 'NULL'
}

const TASK_FILTER = `
  oc.operation_code_name IN ('Picking','Manual Pick Allocation')
  AND t.project_id = ${JDF_PROJECT_ID} AND t.cancelled_date_time IS NULL
  AND (t.Undone IS NULL OR t.Undone = false)`

// One row per JDF outbound order whose first pick is inside the window, plus
// any explicitly requested order ids (open tracked orders older than the window).
function snapshotSql(ids) {
  return `
    WITH cn AS (SELECT timezone('America/Chicago', now()) AS central_now),
    t AS (
      SELECT t.order_id, oc.operation_code_name AS op, t.completed_date_time AS completed
      FROM production_db.silver.datex_slv_tasks t
      JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = t.operation_code_id
      WHERE ${TASK_FILTER} AND t.order_id IS NOT NULL
        AND t.created_sys_date_time >= (SELECT central_now FROM cn) - INTERVAL ${LOOKBACK_DAYS} DAY
    ),
    o AS (
      SELECT order_id,
        count(*) FILTER (WHERE op = 'Picking') AS picks,
        count(*) FILTER (WHERE op = 'Picking' AND completed IS NOT NULL) AS picks_done,
        count(*) FILTER (WHERE op = 'Manual Pick Allocation') AS manuals,
        count(*) FILTER (WHERE op = 'Manual Pick Allocation' AND completed IS NOT NULL) AS manuals_done,
        min(completed) FILTER (WHERE op = 'Picking') AS pick_first,
        greatest(max(completed) FILTER (WHERE op = 'Picking'), max(completed) FILTER (WHERE op = 'Manual Pick Allocation')) AS last_any
      FROM t GROUP BY order_id
    )
    SELECT o.order_id, od.lookup_code AS order_code, os.status_name, oc2.order_class_type_id AS class_type_id,
      strftime(od.fulfillment_date, '%Y-%m-%d %H:%M:%S') AS fulfilled_at,
      o.picks, o.picks_done, o.manuals, o.manuals_done,
      strftime(o.pick_first, '%Y-%m-%d %H:%M:%S') AS pick_first,
      strftime(o.last_any, '%Y-%m-%d %H:%M:%S') AS last_any,
      strftime((SELECT central_now FROM cn), '%Y-%m-%d %H:%M:%S') AS central_now
    FROM o
    JOIN production_db.silver.datex_slv_orders od ON od.order_id = o.order_id AND od.project_id = ${JDF_PROJECT_ID}
    JOIN production_db.silver.datex_slv_orderclasses oc2
      ON oc2.order_class_id = od.order_class_id AND oc2.order_type_id = ${OUTBOUND_ORDER_TYPE_ID}
    LEFT JOIN production_db.silver.datex_slv_orderstatuses os ON os.order_status_id = od.order_status_id
    WHERE o.pick_first IS NOT NULL
      AND (o.pick_first >= (SELECT central_now FROM cn) - INTERVAL ${WINDOW_HOURS} HOUR OR o.order_id IN (${idList(ids)}))
    ORDER BY o.pick_first`
}

// Per order per calendar day: first completed pick that day and last completed task that day.
function daysSql(ids) {
  return `
    SELECT t.order_id, strftime(CAST(t.completed_date_time AS DATE), '%Y-%m-%d') AS day,
      strftime(min(t.completed_date_time) FILTER (WHERE oc.operation_code_name = 'Picking'), '%Y-%m-%d %H:%M:%S') AS first_pick,
      strftime(max(t.completed_date_time), '%Y-%m-%d %H:%M:%S') AS last_task
    FROM production_db.silver.datex_slv_tasks t
    JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = t.operation_code_id
    WHERE ${TASK_FILTER} AND t.order_id IN (${idList(ids)}) AND t.completed_date_time IS NOT NULL
    GROUP BY 1, 2 ORDER BY 1, 2`
}

// Open (not completed, not cancelled, not undone) pick / allocation tasks.
function openSql(ids) {
  return `
    SELECT t.order_id, oc.operation_code_name AS op, m.lookup_code AS material,
      t.expected_inventory_amount AS expected, t.actual_inventory_amount AS actual
    FROM production_db.silver.datex_slv_tasks t
    JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = t.operation_code_id
    LEFT JOIN production_db.silver.datex_slv_materials m ON m.material_id = t.material_id
    WHERE ${TASK_FILTER} AND t.order_id IN (${idList(ids)}) AND t.completed_date_time IS NULL
    ORDER BY t.order_id, t.created_sys_date_time`
}

// ───────────────────────────── derive / decide ─────────────────────────────

function toSnap(r) {
  return {
    orderId: num(r.order_id), orderCode: r.order_code, status: r.status_name || 'Unknown', fulfilledAt: r.fulfilled_at || null,
    classTypeId: num(r.class_type_id),
    picks: num(r.picks), picksDone: num(r.picks_done), manuals: num(r.manuals), manualsDone: num(r.manuals_done),
    pickFirst: r.pick_first, lastAny: r.last_any || r.pick_first, centralNow: r.central_now,
  }
}

function derive(s) {
  const nowMs = parseLocal(s.centralNow), lastMs = parseLocal(s.lastAny), firstMs = parseLocal(s.pickFirst)
  return {
    ...s,
    picksOpen: s.picks - s.picksDone,
    sig: `${s.picksDone}/${s.manualsDone}`,
    idleMin: Math.max(0, (nowMs - lastMs) / 60000),
    elapsedMin: Math.max(0, (nowMs - firstMs) / 60000),
    hour: Number(s.centralNow.slice(11, 13)),
    today: s.centralNow.slice(0, 10),
  }
}

// Pure decision function, exported for testing. row = tracked state from Supabase.
function decide(row, d, ageHours) {
  if (row.final_sent) return null
  if (d.status === 'Cancelled') return 'cancelled'
  const picksFinished = d.picksOpen === 0 || d.status === 'Completed'
  if (picksFinished && d.idleMin >= QUIET_MIN) return 'final'
  if (ageHours >= STOP_HOURS) return 'stopped'
  if (!picksFinished && d.hour >= HANDOFF_HOUR && row.handoff_date !== d.today) return 'handoff'
  if (d.picksOpen > 0 && d.idleMin >= STALL_MIN && !row.stall_sent) return 'stall'
  if (d.sig !== row.last_sig) return 'update'
  return null
}

function patchFor(kind, d) {
  switch (kind) {
    case 'update': return { last_sig: d.sig, stall_sent: false }
    case 'stall': return { stall_sent: true }
    case 'handoff': // the 10 PM note already says how long it has been idle, so don't follow it with a stall comment
      return { handoff_date: d.today, ...(d.picksOpen > 0 && d.idleMin >= STALL_MIN ? { stall_sent: true } : {}) }
    default: return { final_sent: true, last_sig: d.sig } // final / stopped / cancelled
  }
}

// ───────────────────────────── formatting ─────────────────────────────

function itemsText(items) {
  if (!items?.length) return ''
  const shown = items.slice(0, MAX_OPEN_ITEMS).map((i) =>
    `${i.material || '?'} ${i.op === 'Picking' ? 'pick' : 'allocation'} (${num(i.expected)} CS)`)
  if (items.length > MAX_OPEN_ITEMS) shown.push(`+${items.length - MAX_OPEN_ITEMS} more`)
  return shown.join(' · ')
}

// "018753 40 CS · 018811 70 CS" -- unpicked quantities on a finished order
function shortsText(items) {
  const shown = items.slice(0, MAX_OPEN_ITEMS).map((i) => `${i.material || '?'} ${num(i.expected)} CS`)
  if (items.length > MAX_OPEN_ITEMS) shown.push(`+${items.length - MAX_OPEN_ITEMS} more`)
  return shown.join(' · ')
}

function buildTask(d) {
  const subject = `JDF pick timer · ${d.orderCode} · started ${clock(d.pickFirst)}`
  const lines = [
    ...(d.classTypeId === SALES_ORDER_CLASS_TYPE_ID ? [`Order in Datex: ${DATEX_SALES_ORDER_URL}${d.orderId}`, ''] : []),
    `First pick ${d.pickFirst && !sameDay(d.pickFirst, d.centralNow) ? dayLabel(d.pickFirst) + ' ' : ''}${clock(d.pickFirst)} · ${d.picks} picks · ${d.manuals} manual allocations`,
    `Progress now: ${d.picksDone}/${d.picks} picks done, ${d.manualsDone}/${d.manuals} allocations done · Datex status: ${d.status}`,
    '',
    'Clock = first completed pick → last completed pick/allocation. Updates post every 15 min while the counts change; a 10 PM note if the order is still open; a final message when picks are done (or Datex marks it Completed) and it has been quiet for 30 min.',
    `Typical JDF order: ${TYPICAL_TEXT} median (9/19–10/16, 103 orders).`,
  ]
  return { subject, description: lines.join('\n') }
}

// pickingWindows: [{day,start,end,min}] from daysSql rows (days with a pick only)
function pickingWindows(dayRows) {
  return dayRows.filter((r) => r.first_pick).map((r) => ({
    day: r.day, start: r.first_pick, end: r.last_task,
    min: Math.max(0, (parseLocal(r.last_task) - parseLocal(r.first_pick)) / 60000),
  }))
}

function buildComment(kind, d, ctx = {}) {
  const items = ctx.openItems || []
  const counts = `${d.picksDone}/${d.picks} picks${d.manuals ? ` · ${d.manualsDone}/${d.manuals} allocated` : ''}`
  if (kind === 'update') {
    const since = sameDay(d.pickFirst, d.centralNow) ? '' : ` (since ${dayLabel(d.pickFirst)} ${clock(d.pickFirst)})`
    return `Update · ${dur(d.elapsedMin)}${since} · ${counts}`
  }
  if (kind === 'stall') {
    return [`Possible stall · no pick/allocation completed for ${dur(d.idleMin)} (last ${clock(d.lastAny)}) · ${counts}`,
      items.length ? `Open: ${itemsText(items)}` : null, `Datex status: ${d.status}`].filter(Boolean).join('\n')
  }
  if (kind === 'handoff') {
    const dayStart = parseLocal(`${d.today} ${String(DAY_START_HOUR).padStart(2, '0')}:00:00`)
    const dayEnd = parseLocal(`${d.today} ${HANDOFF_HOUR}:00:00`)
    const start = Math.max(parseLocal(d.pickFirst), dayStart)
    const startTxt = parseLocal(d.pickFirst) >= dayStart ? clock(d.pickFirst) : `${DAY_START_HOUR}:00 AM`
    return [`2nd shift ended (10 PM), order still ${d.status} · ${counts}`,
      `Open this shift: ${dur((dayEnd - start) / 60000)} (${startTxt} → 10:00 PM) · last activity ${clock(d.lastAny)} (${dur(d.idleMin)} idle)`,
      items.length ? `Open items: ${itemsText(items)}` : null].filter(Boolean).join('\n')
  }
  if (kind === 'cancelled') return `Order cancelled in Datex · ${counts} · stopped tracking`
  if (kind === 'stopped') {
    return [`Stopped tracking after ${STOP_HOURS}h · ${counts} · Datex status: ${d.status}`,
      items.length ? `Still open: ${itemsText(items)}` : null].filter(Boolean).join('\n')
  }
  // final
  const wins = ctx.windows || []
  const wall = Math.max(0, (parseLocal(d.lastAny) - parseLocal(d.pickFirst)) / 60000)
  const multiDay = wins.length > 1
  const total = multiDay ? wins.reduce((a, w) => a + w.min, 0) : wall
  const diff = Math.round(total - TYPICAL_MIN)
  const head = multiDay
    ? `DONE · picking time ${dur(total)} (${dayLabel(d.pickFirst)} ${clock(d.pickFirst)} → ${dayLabel(d.lastAny)} ${clock(d.lastAny)}) · ${d.picks} picks · ${d.manuals} allocations`
    : `DONE ${dur(total)} (${clock(d.pickFirst)} → ${clock(d.lastAny)}) · ${d.picks} picks · ${d.manuals} allocations`
  const lines = [head]
  if (multiDay) {
    lines.push(`By day: ${wins.map((w) => `${dayLabel(w.start)} ${clock(w.start)}–${clock(w.end)} (${dur(w.min)})`).join(' + ')} · wall clock ${dur(wall)}`)
  }
  lines.push(d.status === 'Completed'
    ? `Datex: Completed${d.fulfilledAt ? ` ${dayLabel(d.fulfilledAt) === dayLabel(d.lastAny) ? '' : dayLabel(d.fulfilledAt) + ' '}${clock(d.fulfilledAt)}` : ''}`
    : `Datex status: ${d.status}`)
  if (items.length) lines.push(d.status === 'Completed' ? `Short (not picked): ${shortsText(items)}` : `Still open: ${itemsText(items)}`)
  lines.push(`Typical JDF order ${TYPICAL_TEXT}: this one ${diff >= 0 ? '+' : '−'}${dur(Math.abs(diff))}`)
  return lines.join('\n')
}

// ───────────────────────────── main ─────────────────────────────

async function runPickTimer({ dryRun }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')
  if (!dryRun && !FRONT_API_KEY) throw new Error('FRONT_API_TOKEN not set')

  const out = { dryRun, seeded: 0, wouldSeed: [], newTasks: [], comments: [], errors: [] }
  const md = await openMotherDuck()
  try {
    // tracked, still-open rows
    let any
    try { any = await sb(`${TABLE}?select=order_id&limit=1`) } catch (e) {
      if (e.status === 404 || /PGRST205|does not exist/i.test(e.body || '')) {
        throw new Error(`Table ${TABLE} not found — run supabase/jdf_pick_timer.sql first`)
      }
      throw e
    }
    const openRows = await sb(`${TABLE}?select=*&final_sent=eq.false&silent_seed=eq.false&task_id=not.is.null&order=order_id.asc&limit=40`)
    const snaps = (await md.query(snapshotSql(openRows.map((r) => num(r.order_id))))).map((r) => derive(toSnap(r)))
    const byId = new Map(snaps.map((s) => [s.orderId, s]))

    // which window orders are new?
    const known = new Set()
    if (snaps.length) {
      const rows = await sb(`${TABLE}?select=order_id&order_id=in.(${snaps.map((s) => s.orderId).join(',')})`)
      for (const r of rows) known.add(num(r.order_id))
    }
    let fresh = snaps.filter((s) => !known.has(s.orderId))

    // first ever run: record finished orders silently, announce in-progress ones
    if (!any.length) {
      const finished = fresh.filter((s) => s.status === 'Completed' || s.status === 'Cancelled')
      out.wouldSeed = finished.map((s) => s.orderCode)
      if (!dryRun && finished.length) {
        await sb(TABLE, {
          method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
          body: finished.map((s) => ({
            order_id: s.orderId, order_code: s.orderCode, started_at: s.pickFirst, picks_expected: s.picks,
            manuals_expected: s.manuals, silent_seed: true, final_sent: true, last_sig: s.sig,
          })),
        })
        out.seeded = finished.length
      }
      const seedIds = new Set(finished.map((s) => s.orderId))
      fresh = fresh.filter((s) => !seedIds.has(s.orderId))
    }

    // 1) announce new orders
    const tracked = openRows.map((r) => ({ ...r }))
    for (const d of fresh) {
      const task = buildTask(d)
      const row = {
        order_id: d.orderId, order_code: d.orderCode, task_id: null, started_at: d.pickFirst, picks_expected: d.picks,
        manuals_expected: d.manuals, final_sent: false, last_sig: d.sig, stall_sent: false, handoff_date: null,
        announced_at: new Date().toISOString(),
      }
      if (dryRun) {
        out.newTasks.push({ orderCode: d.orderCode, ...task })
        tracked.push({ ...row, task_id: 'DRY-RUN' })
        continue
      }
      try {
        await sb(TABLE, { method: 'POST', prefer: 'return=minimal', body: {
          order_id: row.order_id, order_code: row.order_code, started_at: row.started_at, picks_expected: row.picks_expected,
          manuals_expected: row.manuals_expected, last_sig: row.last_sig } })
        try {
          const taskId = await createFrontDiscussion(task)
          await sb(`${TABLE}?order_id=eq.${d.orderId}`, { method: 'PATCH', prefer: 'return=minimal', body: { task_id: taskId } })
          out.newTasks.push({ orderCode: d.orderCode, taskId })
          tracked.push({ ...row, task_id: taskId })
        } catch (e) {
          await sb(`${TABLE}?order_id=eq.${d.orderId}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {})
          throw e
        }
      } catch (e) { out.errors.push(`${d.orderCode}: ${e.message}`) }
    }

    // 2) comments for tracked orders
    const decisions = []
    for (const row of tracked) {
      const d = byId.get(num(row.order_id))
      if (!d) continue
      const ageHours = (Date.now() - new Date(row.announced_at).getTime()) / 3.6e6
      const kind = decide(row, d, ageHours)
      if (kind) decisions.push({ row, d, kind })
    }
    const needDetail = decisions.filter((x) => x.kind !== 'update' && x.kind !== 'cancelled').map((x) => x.d.orderId)
    const needDays = decisions.filter((x) => x.kind === 'final').map((x) => x.d.orderId)
    const [openRes, dayRes] = await Promise.all([
      needDetail.length ? md.query(openSql(needDetail)) : [],
      needDays.length ? md.query(daysSql(needDays)) : [],
    ])
    for (const { row, d, kind } of decisions) {
      const ctx = {
        openItems: openRes.filter((r) => num(r.order_id) === d.orderId).map((r) => ({ op: r.op, material: r.material, expected: r.expected })),
        windows: pickingWindows(dayRes.filter((r) => num(r.order_id) === d.orderId)),
      }
      const body = buildComment(kind, d, ctx)
      if (dryRun) { out.comments.push({ orderCode: d.orderCode, kind, body }); continue }
      try {
        await addFrontComment(row.task_id, body)
        await sb(`${TABLE}?order_id=eq.${d.orderId}`, { method: 'PATCH', prefer: 'return=minimal', body: patchFor(kind, d) })
        out.comments.push({ orderCode: d.orderCode, kind })
      } catch (e) { out.errors.push(`${d.orderCode} (${kind}): ${e.message}`) }
    }
    return out
  } finally {
    md.close()
  }
}

module.exports = {
  runPickTimer,
  // exported for tests
  snapshotSql, daysSql, openSql, toSnap, derive, decide, patchFor, buildTask, buildComment, pickingWindows,
}
