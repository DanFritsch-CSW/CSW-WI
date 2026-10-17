'use strict'

// JDF Inbound Watch — shared logic for the scheduled tick and the manual test.
//
// WHAT IT DOES (v1, agreed with Dan 2026-10-17):
//   Every 15 minutes, look for NEW Jones Dairy Farm inbound orders in Datex
//   (project_id 365, order class type = Inbound). For each new order, create
//   ONE Front DISCUSSION thread (Dan is the participant; changed from a Front
//   task on 2026-10-17 at Dan's request) whose first comment gives the link to
//   the order in Datex plus pallets + SKUs (from the order lines, so it fires
//   hours BEFORE the truck is unloaded).
//   Then, as pallets are received and moved into F8/F7, add COMMENTS to that
//   same thread with per-SKU put-away effectiveness:
//     - ONE progress comment as soon as >= 20% of the order's pallets have
//       left C1 Receiving (PROGRESS_FRACTION; was 50% until 2026-10-17)
//     - ONE final comment FINAL_HOURS (8) after the thread was announced,
//       REGARDLESS of whether the order is complete (Dan, 2026-10-17). It
//       reports whatever state the order is in at that moment (received, out
//       of receiving, still staged), so late re-moves that fix mixed
//       locations are captured before the final score is posted.
//   There is no separate "stalled" comment any more; the 8h final replaces it.
//
// WHY ORDER-BASED, NOT RECEIPT-BASED:
//   receipt_number is blank on JDF receiving tasks. The Datex inbound order
//   (e.g. JD101626-3IN) is created before the first pallet is received
//   (observed 0.2-3.9 hrs earlier on 23 recent orders) and carries ~one order
//   line per pallet, so pallets-per-SKU is known at creation.
//
// "EFFECTIVE" / CLEAN (JDF-ONLY, per Dan):
//   A pallet is clean if, at the moment of its (last) LicensePlateMove into an
//   F8 location, no OTHER JDF SKU was already sitting in that same location.
//   Other customers' product (Saputo, Lakeside...) is deliberately ignored:
//   F8 locations are two-deep with JDF in the front and slow-moving customers
//   behind, so sharing a location with them is by design.
//   "Already sitting there at move time" is reconstructed from move tasks: a
//   neighbour LP counts only if it arrived at that location at or before this
//   pallet's move (or has no recorded move there = older stock). So when two
//   SKUs get mixed, the pallet that arrived SECOND takes the hit, and a good
//   put-away is never blamed for something placed beside it later. Re-moving a
//   pallet to a clean spot (a fix) is reflected because the LAST move counts.
//
// WHO PUT IT AWAY (Dan, 2026-10-17):
//   Every progress / final comment names the user(s) who did the
//   put-aways, e.g. "Put away by: csw-dboss (47)". The user is the Datex
//   Employee on each received LP's LAST completed LicensePlateMove (same
//   "last move counts" rule as the scoring; falls back to the login part of
//   modified_sys_user if Employee is blank). Counts cover every pallet that
//   has left C1 Receiving by a move, scored or not. In the fix list, each
//   mixed location also names who made the offending (second-arrival) move.
//   PUTAWAY_USER_NAMES can map a login to a display name; unmapped logins are
//   shown as-is.
//
// SCOPE (Dan, 2026-10-16): scored freezers are F8 and F7, HARD-CODED below
//   (SCORED_FREEZERS). F1 and F2 are ignored — CSW is not putting new product
//   in those rooms. F7 was added because loads are being diverted there.
//   F2-F7 share F8's rack naming (e.g. F7X33-4B), so nothing else changes.
//
// WHERE EACH RECEIVED PALLET ENDS UP (so odd cases can't stall an order):
//   scored   = last LicensePlateMove landed in an F8/F7 location -> clean/mixed
//   door     = no scoring move and the pallet now sits at a Door (cross-dock)
//   other    = no scoring move, left receiving some other way (e.g. a batch
//              move or a non-LicensePlateMove put-away) -> counted as out of
//              receiving but NOT scored
//   staged   = still in C1 Receiving
//   COMPLETE (every pallet received, none still staged) no longer triggers
//   anything by itself; it only changes the wording of the 8h final comment.
//   (Observed over 30 days: 91% of JDF pallets end in F8, ~2.8% have no move
//   task - 68 still in C1 Receiving, 32 at doors, ~9 in F8 via another task
//   type.)
//
// STATE: Supabase table jdf_inbound_watch (see supabase/jdf_inbound_watch.sql).
//   First ever run SEEDS the table with whatever orders already exist (no
//   tasks, no comments) so deploying never floods Dan with old orders.
//
// ALWAYS LIVE (Dan, 2026-10-17): there is no env-var switch. The scheduled
//   tick always runs for real; the first run on an empty table only SEEDS
//   existing orders, so deploying never floods Dan. The manual test function
//   is a DRY RUN unless the POST body contains { "send": true }.
//
// Same run/test split as every other digest in this app (Netlify blocks
// direct HTTP invocation of any function that carries a `schedule`).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''
const FRONT_API_KEY = process.env.FRONT_API_TOKEN || process.env.FRONT_API_KEY || ''
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN || ''

const DAN_TEAMMATE_ID = 'tea_a3e8k' // same ID the other digests use
const JDF_PROJECT_ID = 365
const INBOUND_ORDER_TYPE_ID = 1 // datex_slv_orderclasses.order_type_id = 1 -> Inbound ASN / Inbound Material Transfer
// Direct link to the order in Datex (FootPrint Cloud ASN order editor); order_id is the only variable part.
const DATEX_ASN_ORDER_URL = 'https://csw-footprint-cloud.wavelength.host/FootprintManager_asn_order_editor?order_id='
// Wide on purpose: order timestamps and now() may be on different clocks, and
// the seen-table does the real de-duplication. Only the very first (seeding)
// run depends on this window.
const LOOKBACK_HOURS = 30
const TAIL_MAX_PALLETS = 3 // SKUs with <= this many pallets are flagged as odd-lot candidates
const PROGRESS_FRACTION = 0.2 // progress comment once this share of expected pallets has left C1 Receiving (Dan, 2026-10-17)
const FINAL_HOURS = 8 // final comment this many hours after announce, regardless of completion (Dan, 2026-10-17)
// false = the final comment ALWAYS waits for FINAL_HOURS (current behavior).
// true  = also post it early the moment every pallet is received and none are staged.
const FINAL_EARLY_WHEN_COMPLETE = false
const MAX_FIX_LOCATIONS = 8

const SCORED_FREEZERS = ['F8', 'F7'] // hard-coded per Dan 2026-10-16
const RECEIVING_STAGING = 'C1 Receiving'

// Optional login -> display name map for the "Put away by" line, e.g. { 'csw-dboss': 'D. Boss' }.
// Unmapped logins are shown exactly as Datex has them.
const PUTAWAY_USER_NAMES = {}

const TABLE = 'jdf_inbound_watch'

function scoredLocSql(col) {
  return `(${SCORED_FREEZERS.map((f) => `${col} LIKE '${f}%'`).join(' OR ')})`
}

function num(v) { return Number(v ?? 0) || 0 }

function userLabel(u) {
  const key = String(u || '').trim()
  if (!key) return 'unknown'
  return PUTAWAY_USER_NAMES[key] || key
}

// ───────────────────────────── Supabase ─────────────────────────────

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
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

// ───────────────────────────── Front ─────────────────────────────

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
    type: 'discussion',
    teammate_ids: [DAN_TEAMMATE_ID],
    subject,
    comment: { body: description },
  })
  return created.id
}

// POST /conversations/:id/comments. Front's changelog: author_id is optional;
// when omitted the comment posts as the API token's bot teammate.
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

// New/recent JDF inbound orders with one row per SKU. Order lines ~= pallets
// (verified: 36 lines / 36 pallets etc. on 22 of 23 recent orders).
function recentOrdersSql() {
  return `
    SELECT o.order_id, o.lookup_code AS order_code,
           m.lookup_code AS sku, trim(m.Description) AS description, count(*) AS pallets
    FROM production_db.silver.datex_slv_orders o
    JOIN production_db.silver.datex_slv_orderclasses oc
      ON oc.order_class_id = o.order_class_id AND oc.order_type_id = ${INBOUND_ORDER_TYPE_ID}
    JOIN production_db.silver.datex_slv_orderlines ol ON ol.order_id = o.order_id
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = ol.material_id
    WHERE o.project_id = ${JDF_PROJECT_ID}
      AND o.created_sys_date_time >= now() - INTERVAL ${LOOKBACK_HOURS} HOUR
    GROUP BY o.order_id, o.lookup_code, m.lookup_code, trim(m.Description)
    ORDER BY o.order_id, pallets DESC, sku`
}

// Per-order, per-SKU progress + conflict list + put-away users for the given order IDs.
// orderIds MUST be validated integers (they are interpolated).
function progressSql(orderIds) {
  const ids = orderIds.map((n) => {
    if (!Number.isInteger(n)) throw new Error(`Bad order id: ${n}`)
    return n
  }).join(',')
  const base = `
    WITH rcv AS (
      SELECT DISTINCT t.order_id, t.actual_target_license_plate_id AS lp_id, lot.material_id,
             cl.location_container_name AS cur_loc
      FROM production_db.silver.datex_slv_tasks t
      JOIN production_db.silver.datex_slv_operationcodes oc
        ON oc.operation_code_id = t.operation_code_id AND oc.operation_code_name = 'Receiving'
      JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = t.lot_id
      LEFT JOIN production_db.silver.datex_slv_licenseplates lpc0 ON lpc0.license_plate_id = t.actual_target_license_plate_id
      LEFT JOIN production_db.silver.datex_slv_locationcontainers cl ON cl.location_container_id = lpc0.location_id
      WHERE t.order_id IN (${ids}) AND t.project_id = ${JDF_PROJECT_ID}
        AND (t.Undone IS NULL OR t.Undone = false)
    ),
    putaway AS (
      SELECT lp_id, mv_user FROM (
        SELECT t.actual_source_license_plate_id AS lp_id,
               coalesce(nullif(trim(t.Employee), ''), list_extract(string_split(t.modified_sys_user, chr(92)), -1)) AS mv_user,
               row_number() OVER (PARTITION BY t.actual_source_license_plate_id ORDER BY t.completed_date_time DESC) AS rn
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_operationcodes oc
          ON oc.operation_code_id = t.operation_code_id AND oc.operation_code_name = 'LicensePlateMove'
        WHERE t.actual_source_license_plate_id IN (SELECT lp_id FROM rcv)
          AND t.completed_date_time IS NOT NULL AND (t.Undone IS NULL OR t.Undone = false)
      ) WHERE rn = 1
    ),
    lastmove AS (
      SELECT lp_id, loc_id, loc_name, mv_at FROM (
        SELECT t.actual_source_license_plate_id AS lp_id, t.actual_target_location_id AS loc_id,
               tl.location_container_name AS loc_name, t.completed_date_time AS mv_at,
               row_number() OVER (PARTITION BY t.actual_source_license_plate_id ORDER BY t.completed_date_time DESC) AS rn
        FROM production_db.silver.datex_slv_tasks t
        JOIN production_db.silver.datex_slv_operationcodes oc
          ON oc.operation_code_id = t.operation_code_id AND oc.operation_code_name = 'LicensePlateMove'
        JOIN production_db.silver.datex_slv_locationcontainers tl ON tl.location_container_id = t.actual_target_location_id
        WHERE t.actual_source_license_plate_id IN (SELECT lp_id FROM rcv)
          AND t.completed_date_time IS NOT NULL AND (t.Undone IS NULL OR t.Undone = false)
      ) WHERE rn = 1 AND ${scoredLocSql('loc_name')}
    ),
    arr AS (
      SELECT t.actual_source_license_plate_id AS lp_id, t.actual_target_location_id AS loc_id,
             max(t.completed_date_time) AS arr_at
      FROM production_db.silver.datex_slv_tasks t
      JOIN production_db.silver.datex_slv_operationcodes oc
        ON oc.operation_code_id = t.operation_code_id AND oc.operation_code_name = 'LicensePlateMove'
      WHERE t.actual_target_location_id IN (SELECT loc_id FROM lastmove)
        AND t.completed_date_time IS NOT NULL AND (t.Undone IS NULL OR t.Undone = false)
      GROUP BY 1, 2
    ),
    conflicts AS (
      SELECT DISTINCT lm.lp_id AS subject_lp, lm.loc_name, m2.lookup_code AS other_sku, pa.mv_user
      FROM lastmove lm
      JOIN rcv r ON r.lp_id = lm.lp_id
      LEFT JOIN putaway pa ON pa.lp_id = lm.lp_id
      JOIN production_db.silver.datex_slv_licenseplates lp2
        ON lp2.location_id = lm.loc_id AND lp2.license_plate_id <> lm.lp_id
       AND (lp2.Archived IS NULL OR lp2.Archived = false)
      JOIN production_db.silver.datex_slv_licenseplatecontents c2 ON c2.license_plate_id = lp2.license_plate_id
      JOIN production_db.silver.datex_slv_lots lot2 ON lot2.lot_id = c2.lot_id
      JOIN production_db.silver.datex_slv_materials m2
        ON m2.material_id = lot2.material_id AND m2.project_id = ${JDF_PROJECT_ID} AND m2.material_id <> r.material_id
      LEFT JOIN arr a ON a.lp_id = lp2.license_plate_id AND a.loc_id = lm.loc_id
      WHERE a.arr_at IS NULL OR a.arr_at <= lm.mv_at
    )`
  const skuRows = `${base}
    SELECT r.order_id, m.lookup_code AS sku,
           count(DISTINCT r.lp_id) AS received,
           count(DISTINCT lm.lp_id) AS scored,
           count(DISTINCT lm.lp_id) FILTER (WHERE lm.lp_id NOT IN (SELECT subject_lp FROM conflicts)) AS clean,
           count(DISTINCT r.lp_id) FILTER (WHERE lm.lp_id IS NULL AND coalesce(r.cur_loc,'') LIKE 'Door%') AS door,
           count(DISTINCT r.lp_id) FILTER (WHERE lm.lp_id IS NULL AND coalesce(r.cur_loc,'') NOT LIKE 'Door%'
                                             AND coalesce(r.cur_loc,'') <> '${RECEIVING_STAGING}') AS other,
           count(DISTINCT r.lp_id) FILTER (WHERE lm.lp_id IS NULL AND coalesce(r.cur_loc,'') = '${RECEIVING_STAGING}') AS staged
    FROM rcv r
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = r.material_id
    LEFT JOIN lastmove lm ON lm.lp_id = r.lp_id
    GROUP BY r.order_id, m.lookup_code`
  const conflictRows = `${base}
    SELECT DISTINCT r.order_id, m.lookup_code AS sku, c.loc_name, c.other_sku, c.mv_user
    FROM conflicts c
    JOIN rcv r ON r.lp_id = c.subject_lp
    JOIN production_db.silver.datex_slv_materials m ON m.material_id = r.material_id
    ORDER BY c.loc_name`
  // Who moved the pallets out of receiving: last completed LicensePlateMove per received LP
  // (any destination), counted for every pallet no longer sitting in C1 Receiving.
  const userRows = `${base}
    SELECT r.order_id, pa.mv_user, count(DISTINCT r.lp_id) AS pallets
    FROM rcv r
    JOIN putaway pa ON pa.lp_id = r.lp_id
    WHERE coalesce(r.cur_loc, '') <> '${RECEIVING_STAGING}'
    GROUP BY r.order_id, pa.mv_user
    ORDER BY r.order_id, pallets DESC`
  return { skuRows, conflictRows, userRows }
}

// ───────────────────────────── Formatting ─────────────────────────────

function groupOrders(rows) {
  const byOrder = new Map()
  for (const r of rows) {
    const id = num(r.order_id)
    if (!byOrder.has(id)) byOrder.set(id, { orderId: id, orderCode: r.order_code, skus: [], pallets: 0 })
    const o = byOrder.get(id)
    const p = num(r.pallets)
    o.skus.push({ sku: r.sku, description: r.description || '', pallets: p })
    o.pallets += p
  }
  return [...byOrder.values()].sort((a, b) => a.orderId - b.orderId)
}

function buildTask(order) {
  const subject = `JDF inbound ${order.orderCode} · ${order.pallets} pallets · ${order.skus.length} SKUs`
  const lines = [
    `Order in Datex: ${DATEX_ASN_ORDER_URL}${order.orderId}`,
    '',
    `${order.pallets} pallets · ${order.skus.length} SKUs`,
    '',
    ...order.skus.map((s) => `${s.sku}  ${s.description}  — ${s.pallets} plt`),
  ]
  const tails = order.skus.filter((s) => s.pallets <= TAIL_MAX_PALLETS)
  if (tails.length) {
    lines.push('', `Tail SKUs (≤${TAIL_MAX_PALLETS} plt, odd-lot candidates): ${tails.map((s) => `${s.sku} (${s.pallets})`).join(', ')}`)
  }
  return { subject, description: lines.join('\n') }
}

function pct(clean, total) { return total > 0 ? Math.round((100 * clean) / total) : 0 }

function skuLine(s) {
  if (s.scored === 0) {
    if (s.staged > 0) return `• ${s.sku} — not put away yet (${s.received} received)`
    return `• ${s.sku} — ${s.received} not scored (door / other)`
  }
  const mixed = s.scored - s.clean
  return `• ${s.sku} — ${s.clean}/${s.scored} clean (${pct(s.clean, s.scored)}%)${mixed ? ` · ${mixed} mixed` : ''}`
}

function fixList(conflicts) {
  // group by location -> SKUs involved + who made the (second-arrival) move
  const byLoc = new Map()
  for (const c of conflicts) {
    if (!byLoc.has(c.loc_name)) byLoc.set(c.loc_name, { skus: new Set(), users: new Set() })
    const e = byLoc.get(c.loc_name)
    e.skus.add(c.sku)
    e.skus.add(c.other_sku)
    if (c.mv_user) e.users.add(userLabel(c.mv_user))
  }
  const entries = [...byLoc.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const shown = entries.slice(0, MAX_FIX_LOCATIONS).map(([loc, e]) => {
    const who = e.users.size ? ` (moved by ${[...e.users].sort().join(', ')})` : ''
    return `• ${loc}: ${[...e.skus].sort().join(' + ')}${who}`
  })
  if (entries.length > MAX_FIX_LOCATIONS) shown.push(`• …and ${entries.length - MAX_FIX_LOCATIONS} more locations`)
  return shown
}

// "Put away by: csw-dboss (47) · csw-xyz (3)" — empty string when nothing has been moved yet.
function putawayByLine(users) {
  const list = (users || []).filter((u) => num(u.pallets) > 0)
  if (!list.length) return ''
  const parts = [...list]
    .sort((a, b) => num(b.pallets) - num(a.pallets) || String(a.user).localeCompare(String(b.user)))
    .map((u) => `${userLabel(u.user)} (${num(u.pallets)})`)
  return `Put away by: ${parts.join(' · ')}`
}

function buildComment(kind, p) {
  const totalClean = p.skus.reduce((a, s) => a + s.clean, 0)
  const clean = `${totalClean}/${p.scored} clean (${pct(totalClean, p.scored)}%)`
  let head
  if (kind === 'progress') {
    head = `Put-away check · ${p.leftReceiving} of ${p.expected} pallets out of receiving · ${clean}`
  } else {
    // 8h final: report the state as it is, including anything not received or still staged.
    const gaps = []
    if (p.received < p.expected) gaps.push(`${p.expected - p.received} not received`)
    if (p.staged > 0) gaps.push(`${p.staged} still in receiving`)
    head = `Final (${FINAL_HOURS}h) · ${p.leftReceiving} of ${p.expected} out of receiving${gaps.length ? ` · ${gaps.join(', ')}` : ''} · ${clean}`
  }
  const lines = [head, '', ...[...p.skus].sort((a, b) => b.received - a.received).map(skuLine)]
  const by = putawayByLine(p.users)
  if (by) lines.push('', by)
  const notes = []
  if (p.door) notes.push(`${p.door} cross-docked to doors (not scored)`)
  if (p.other) notes.push(`${p.other} left receiving by another task type (not scored)`)
  if (notes.length) lines.push('', ...notes.map((n) => `• ${n}`))
  const fixes = fixList(p.conflicts)
  if (fixes.length) lines.push('', kind === 'progress' ? 'Mixed so far (can still be re-moved):' : 'Fix list (re-move to clean these up):', ...fixes)
  else if (p.scored > 0) lines.push('', 'No mixed locations.')
  return lines.join('\n')
}

// Pure decision function, exported for testing.
// p: { expected, received, staged, leftReceiving }
// 'final' = FINAL_HOURS after announce regardless of completion (or early on completion only
// if FINAL_EARLY_WHEN_COMPLETE). 'progress' = once, as soon as PROGRESS_FRACTION of the
// expected pallets have left C1 Receiving. Final takes priority; nothing posts after final.
function decideComment(row, p, nowMs) {
  const ageHours = (nowMs - new Date(row.announced_at).getTime()) / 3.6e6
  const complete = p.expected > 0 && p.received >= p.expected && p.staged === 0
  const finalDue = ageHours >= FINAL_HOURS || (FINAL_EARLY_WHEN_COMPLETE && complete)
  if (finalDue && !row.final_sent) return 'final'
  if (
    !row.progress_sent && !row.final_sent &&
    p.expected > 0 && p.leftReceiving > 0 &&
    p.leftReceiving >= Math.ceil(PROGRESS_FRACTION * p.expected)
  ) return 'progress'
  return null
}

// ───────────────────────────── Main ─────────────────────────────

async function runWatch({ dryRun }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not configured')
  if (!dryRun && !FRONT_API_KEY) throw new Error('FRONT_API_TOKEN not set')

  const out = { dryRun, seeded: 0, wouldSeed: 0, newTasks: [], comments: [], errors: [] }
  const md = await openMotherDuck()
  try {
    const recent = groupOrders(await md.query(recentOrdersSql()))

    let anyRow
    try {
      anyRow = await sb(`${TABLE}?select=order_id&limit=1`)
    } catch (e) {
      if (e.status === 404 || /PGRST205|does not exist/i.test(e.body || '')) {
        throw new Error(`Table ${TABLE} not found — run supabase/jdf_inbound_watch.sql first`)
      }
      throw e
    }

    // First ever run: record existing orders silently, announce nothing.
    if (!anyRow.length) {
      if (dryRun) { out.wouldSeed = recent.length; return out }
      if (recent.length) {
        await sb(TABLE, {
          method: 'POST',
          prefer: 'resolution=ignore-duplicates,return=minimal',
          body: recent.map((o) => ({
            order_id: o.orderId, order_code: o.orderCode, pallets_expected: o.pallets,
            sku_count: o.skus.length, silent_seed: true, progress_sent: true, final_sent: true,
          })),
        })
      }
      out.seeded = recent.length
      return out
    }

    // 1) announce new orders
    const seen = new Set()
    if (recent.length) {
      const rows = await sb(`${TABLE}?select=order_id&order_id=in.(${recent.map((o) => o.orderId).join(',')})`)
      for (const r of rows) seen.add(num(r.order_id))
    }
    for (const order of recent.filter((o) => !seen.has(o.orderId))) {
      const task = buildTask(order)
      if (dryRun) { out.newTasks.push({ orderCode: order.orderCode, ...task }); continue }
      try {
        // Claim first (PK prevents double-announce); roll back if Front fails so it retries next tick.
        await sb(TABLE, {
          method: 'POST', prefer: 'return=minimal',
          body: { order_id: order.orderId, order_code: order.orderCode, pallets_expected: order.pallets, sku_count: order.skus.length },
        })
        try {
          const taskId = await createFrontDiscussion(task)
          await sb(`${TABLE}?order_id=eq.${order.orderId}`, { method: 'PATCH', prefer: 'return=minimal', body: { task_id: taskId } })
          out.newTasks.push({ orderCode: order.orderCode, taskId })
        } catch (e) {
          await sb(`${TABLE}?order_id=eq.${order.orderId}`, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {})
          throw e
        }
      } catch (e) {
        out.errors.push(`${order.orderCode}: ${e.message}`)
      }
    }

    // 2) milestone comments on open, announced orders
    const open = await sb(
      `${TABLE}?select=*&final_sent=eq.false&silent_seed=eq.false&task_id=not.is.null&order=order_id.asc&limit=40`
    )
    if (open.length) {
      const { skuRows, conflictRows, userRows } = progressSql(open.map((r) => num(r.order_id)))
      const [skuRes, conflictRes, userRes] = await Promise.all([md.query(skuRows), md.query(conflictRows), md.query(userRows)])
      const now = Date.now()
      for (const row of open) {
        const id = num(row.order_id)
        const skus = skuRes
          .filter((r) => num(r.order_id) === id)
          .map((r) => ({
            sku: r.sku, received: num(r.received), scored: num(r.scored), clean: num(r.clean),
            door: num(r.door), other: num(r.other), staged: num(r.staged),
          }))
        const sum = (k) => skus.reduce((a, s) => a + s[k], 0)
        const received = sum('received')
        const staged = sum('staged')
        const p = {
          expected: num(row.pallets_expected),
          received, staged, leftReceiving: received - staged,
          scored: sum('scored'), door: sum('door'), other: sum('other'),
          skus,
          conflicts: conflictRes.filter((r) => num(r.order_id) === id),
          users: userRes
            .filter((r) => num(r.order_id) === id)
            .map((r) => ({ user: r.mv_user, pallets: num(r.pallets) })),
        }
        const kind = decideComment(row, p, now)
        if (!kind) continue
        const body = buildComment(kind, p)
        if (dryRun) { out.comments.push({ orderCode: row.order_code, kind, body }); continue }
        try {
          await addFrontComment(row.task_id, body)
          const patch = kind === 'progress' ? { progress_sent: true } : { progress_sent: true, final_sent: true }
          await sb(`${TABLE}?order_id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch })
          out.comments.push({ orderCode: row.order_code, kind })
        } catch (e) {
          out.errors.push(`${row.order_code} (${kind} comment): ${e.message}`)
        }
      }
    }
    return out
  } finally {
    md.close()
  }
}

module.exports = {
  runWatch,
  // exported for tests
  groupOrders, buildTask, buildComment, decideComment, fixList, progressSql, putawayByLine,
}
