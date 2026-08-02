'use strict'

// Shared core for the Attendance Points HR automation. Added 2026-08-02.
// Watches B2E's own rolling attendance-points balance
// (silver.b2e_slv_pointsbalance) for new threshold crossings (6/8/10 pts,
// per CSW's non-union Attendance Policy) and posts a disciplinary-action
// summary as a Front comment on the facility's HR conversation thread.
// Signature lines are never represented as filled anywhere in this
// pipeline — a human still pulls and signs the real form.
//
// KNOWN LIMITATION AT BUILD TIME (documented so it isn't silently lost):
// both b2e_slv_pointsbalance and b2e_slv_detailedpointsreport have
// exactly ONE historical load in MotherDuck (2026-08-01 and 2026-06-01
// respectively) — the SFTP sync that should land these daily/nightly
// isn't on a recurring schedule yet. This function is fully built and
// correct against the data as it exists today, but a "daily" check is
// only as good as its daily data. Needs the Data Platform team to put
// both b2e_detailedpointsreport and b2e_pointsbalance on a recurring
// sync before this is safe to run unattended on a real cron — same class
// of dependency as the OSD tracker fix (see motherduck-osd-count.cjs).
//
// Phase-in per Dan (2026-08-02): every facility seeded active=false.
// "Run check now (test)" is NOT a dry run — it posts real Front comments
// and writes real attendance_points_actions rows, same as a live cron
// tick would. That's intentional: it's how accuracy gets validated
// against a manual audit before a facility's active flag flips to true
// and the daily schedule takes over unattended. No code change needed to
// flip a facility on — same active-flag gate as every other digest in
// this app.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const FRONT_TOKEN = process.env.FRONT_API_TOKEN
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN

// B2E's own default_location string per facility — confirmed live
// against silver.b2e_slv_pointsbalance (2026-08-02). 'Ultra Cold' also
// appears in B2E but isn't one of this app's 5 facilities — deliberately
// excluded here.
const FACILITY_LOCATION = {
  cal: '019 - Caledonia',
  ken: '015 - Kenosha',
  wr:  '023 - Wisconsin Rapids',
  mad: '011 - Madison',
  ec:  '012 - Eau Claire',
}
const FACILITY_DISPLAY = { cal: 'Caledonia', ken: 'Kenosha', wr: 'Wisconsin Rapids', mad: 'Madison', ec: 'Eau Claire' }

// Per CSW's non-union Attendance Policy (10-point / rolling 6-month
// program). Checked low-to-high but a person who jumps two levels at
// once (e.g. 3 -> 10 points between checks) gets a form generated for
// EACH newly-crossed level, not just the highest — every level is its
// own documented disciplinary step per the policy form.
const THRESHOLDS = [
  { points: 6,  action: 'Written Warning' },
  { points: 8,  action: 'Final Warning' },
  { points: 10, action: 'Termination' },
]

// The point VALUE on a single B2E transaction maps directly to the
// policy's violation category — no free-text parsing needed (the
// detailed report's `comment` field is sparse/inconsistent in real data).
const CATEGORY_BY_POINTS = {
  4:   { key: 'no_call_no_show',   label: 'Absence without advanced notification (no-call/no-show)' },
  2:   { key: 'unexcused_absence', label: 'Unexcused absence' },
  0.5: { key: 'unexcused_tardy',   label: 'Unexcused tardy or departure of more than 15 minutes of assigned shift' },
}

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

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!res.ok) throw new Error(typeof json === 'string' ? json : JSON.stringify(json))
  return json
}

function openDuck() {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = MOTHERDUCK_TOKEN
  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: MOTHERDUCK_TOKEN })
  const conn = db.connect()
  return { db, conn }
}

function run(conn, sql) {
  return new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
}
function all(conn, sql) {
  return new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))
}

// Current point balance per active employee at one facility.
async function queryPointsBalance(facility) {
  const location = FACILITY_LOCATION[facility]
  if (!location) throw new Error(`Unknown facility "${facility}"`)
  const { db, conn } = openDuck()
  try {
    await run(conn, 'LOAD motherduck')
    const rows = await all(conn, `
      SELECT employee_id, first_name, last_name, points, updated_to_date
      FROM production_db.silver.b2e_slv_pointsbalance
      WHERE default_location = '${location}' AND employee_status = 'Active'
      ORDER BY points DESC
    `)
    return rows || []
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

// Most recent known transaction per employee — used to attribute the
// triggering category/date on a new threshold hit. See file header:
// only one historical load exists as of build time, so "most recent" is
// really "only known" until the daily sync lands. TRY_STRPTIME returns
// NULL on anything it can't parse rather than erroring the whole query.
async function queryLatestTransactions(employeeIds) {
  if (!employeeIds.length) return new Map()
  const { db, conn } = openDuck()
  try {
    await run(conn, 'LOAD motherduck')
    const idList = employeeIds.join(',')
    const rows = await all(conn, `
      SELECT employee_id, points, comment, modified,
             TRY_STRPTIME(modified, '%m/%d/%Y %I:%M%p') AS modified_ts
      FROM production_db.silver.b2e_slv_detailedpointsreport
      WHERE employee_id IN (${idList})
      QUALIFY ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY modified_ts DESC NULLS LAST) = 1
    `)
    const map = new Map()
    for (const r of rows || []) map.set(Number(r.employee_id), r)
    return map
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Builds the internal Front comment body — a pre-filled summary pointing
// at the real Disciplinary Action Form, NOT a substitute for the signed
// paper form. Signature lines are deliberately never represented here.
function buildFormComment({ employeeName, facility, threshold, points, category, triggeringDate }) {
  const facilityDisplay = FACILITY_DISPLAY[facility] || facility.toUpperCase()
  const catLabel = category?.label || 'Unknown — check B2E detailed points report'
  return `
<strong>Attendance Points — Disciplinary Action Needed</strong><br>
Facility: ${escapeHtml(facilityDisplay)}<br>
Employee: <strong>${escapeHtml(employeeName)}</strong><br>
Current Point Count: <strong>${points}</strong><br>
Threshold Crossed: <strong>${threshold.points} points → ${threshold.action}</strong><br>
Likely Category: ${escapeHtml(catLabel)}${triggeringDate ? ` (as of ${escapeHtml(triggeringDate)})` : ''}<br>
<br>
Please pull the Disciplinary Action Form, confirm dates missed against B2E, and complete Employee/Supervisor signatures.
This is a system-generated notice — not a substitute for the signed paper form.
`.trim()
}

async function frontPostComment(conversationId, body) {
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw Object.assign(new Error('Front comment failed'), { detail: json })
  return json
}

// Core digest logic — shared by the scheduled run and the manual test
// button. Returns one result entry per NEW threshold crossing found.
async function runDigest({ isManualTest, facility }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env not configured')
  if (!FRONT_TOKEN) throw new Error('FRONT_API_TOKEN not set')
  if (!MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN not set')
  if (!FACILITY_LOCATION[facility]) throw new Error(`Unknown facility "${facility}"`)

  const settingsRows = await sbFetch(`attendance_points_notify_settings?facility=eq.${facility}&select=front_conversation_id,active`)
  const settings = settingsRows?.[0]
  if (!settings) return { ok: false, reason: `No attendance_points_notify_settings row for ${facility}` }
  if (!isManualTest && settings.active !== true) return { ok: true, skipped: true, reason: 'Digest disabled (active=false)' }
  if (!settings.front_conversation_id) return { ok: false, reason: 'No Front conversation ID configured for this facility' }

  const balances = await queryPointsBalance(facility)
  if (!balances.length) return { ok: true, newActions: [], reason: 'No active employees with a B2E balance found' }

  const employeeIds = balances.map(b => Number(b.employee_id))
  const latestTx = await queryLatestTransactions(employeeIds)

  // Existing actions already recorded for these employees at this
  // facility — dedupe key is (employee_id, facility, threshold_hit), see
  // attendance_points_actions' UNIQUE constraint.
  const existingRows = await sbFetch(
    `attendance_points_actions?employee_id=in.(${employeeIds.join(',')})&facility=eq.${facility}&select=employee_id,threshold_hit`
  )
  const existingSet = new Set((existingRows || []).map(r => `${r.employee_id}:${r.threshold_hit}`))

  const newActions = []
  for (const emp of balances) {
    const points = Number(emp.points)
    for (const threshold of THRESHOLDS) {
      if (points < threshold.points) continue
      const key = `${emp.employee_id}:${threshold.points}`
      if (existingSet.has(key)) continue

      const tx = latestTx.get(Number(emp.employee_id))
      const category = tx ? CATEGORY_BY_POINTS[Number(tx.points)] : null
      const employeeName = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
      const triggeringDate = tx?.modified_ts ? String(tx.modified_ts).slice(0, 10) : null

      const commentBody = buildFormComment({ employeeName, facility, threshold, points, category, triggeringDate })
      const posted = await frontPostComment(settings.front_conversation_id, commentBody)
      const frontCommentId = posted?.id || null

      await sbPost('attendance_points_actions', {
        employee_id: Number(emp.employee_id),
        facility,
        threshold_hit: threshold.points,
        points_at_flag: points,
        triggering_date: triggeringDate,
        triggering_category: category?.key || null,
        front_comment_id: frontCommentId,
      })

      newActions.push({
        employeeId: emp.employee_id, employeeName, threshold: threshold.points,
        action: threshold.action, points, category: category?.key || null, frontCommentId,
      })

      existingSet.add(key)
    }
  }

  return { ok: true, facility, checkedCount: balances.length, newActions }
}

module.exports = {
  SUPABASE_URL, SUPABASE_KEY, FRONT_TOKEN, MOTHERDUCK_TOKEN,
  FACILITY_LOCATION, FACILITY_DISPLAY, THRESHOLDS, CATEGORY_BY_POINTS,
  sbFetch, sbPost,
  queryPointsBalance, queryLatestTransactions,
  runDigest,
}
