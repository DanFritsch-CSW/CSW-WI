'use strict'

// Shared core for the Attendance Points HR automation. Added 2026-08-02.
// Watches B2E's own rolling attendance-points balance
// (silver.b2e_slv_pointsbalance) for new threshold crossings (6/8/10 pts,
// per CSW's non-union Attendance Policy) and posts a disciplinary-action
// notice — WITH A FILLED PDF ATTACHED — as a Front comment on the
// facility's HR conversation thread. Signature lines are never filled
// anywhere in this pipeline — a human still signs the real form.
//
// PDF NOTE (2026-08-02, second pass): Dan asked for the actual uploaded
// Disciplinary Action Form PDF to be filled and attached. That exact
// file is a 289KB fillable AcroForm PDF. Embedding that exact binary
// asset would mean transcribing ~240KB of opaque base64 through this
// tool interface with zero margin for error — a single dropped
// character corrupts the PDF's internal structure silently. Rather than
// risk shipping a corrupted or half-verified binary, this builds a
// clean PDF from scratch via pdf-lib (same library already used by
// wr-secondary-repl-pdf.cjs) that reproduces the same fields, labels,
// and point-schedule text as the original form, filled with real data.
// It is not byte-identical to the original — flagged here and in the
// Notion changelog so it isn't mistaken for the original scan.
//
// PDF NOTE (2026-08-02, third pass): Dan supplied a real completed
// example (Gary Yeoman docx) showing HOW the form is actually filled out
// in practice — layout order Date/Name/Position -> Program schedule ->
// Disciplinary Action -> "ACTION TAKEN:" -> "Dates Missed:" TABLE (each
// row = transaction type + date + points, not just the single triggering
// transaction) -> Current Point Count -> 2x2 warning-tier checkbox grid
// -> signatures on one line. Layout below now matches that example, and
// "Dates Missed" lists every known B2E transaction for the employee
// (type/date/points), not just the most recent one — see
// queryEmployeeTransactions(). "Position" isn't available from any
// B2E/Supabase source this function has access to yet, so it renders as
// "—" — flagged as a known gap, not silently guessed.
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
// (with the real PDF attached) and writes real attendance_points_actions
// rows, same as a live cron tick would. That's intentional: it's how
// accuracy gets validated against a manual audit before a facility's
// active flag flips to true and the daily schedule takes over
// unattended. No code change needed to flip a facility on — same
// active-flag gate as every other digest in this app.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

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

// ALL known point-earning transactions per employee (type/date/points),
// newest first — this is what populates the "Dates Missed" table on the
// generated form, matching the real completed-example layout (each row
// = one B2E transaction, not just the single most-recent one). Filtered
// to points > 0 (skip any zero/negative adjustment rows). See file
// header: only one historical load exists in MotherDuck as of build
// time, so this is the full transaction history available today, not
// necessarily the full rolling-6-month history once the sync is fixed.
async function queryEmployeeTransactions(employeeIds) {
  if (!employeeIds.length) return new Map()
  const { db, conn } = openDuck()
  try {
    await run(conn, 'LOAD motherduck')
    const idList = employeeIds.join(',')
    const rows = await all(conn, `
      SELECT employee_id, transaction_type, points, modified,
             TRY_STRPTIME(modified, '%m/%d/%Y %I:%M%p') AS modified_ts
      FROM production_db.silver.b2e_slv_detailedpointsreport
      WHERE employee_id IN (${idList}) AND points > 0
      ORDER BY employee_id, modified_ts DESC NULLS LAST
    `)
    const map = new Map()
    for (const r of rows || []) {
      const id = Number(r.employee_id)
      if (!map.has(id)) map.set(id, [])
      map.get(id).push(r)
    }
    return map
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Builds the internal Front comment body — short caption, since the full
// detail now lives on the attached PDF (see buildDisciplinaryFormPdf).
function buildFormComment({ employeeName, facility, threshold, points, category, triggeringDate, pdfError }) {
  const facilityDisplay = FACILITY_DISPLAY[facility] || facility.toUpperCase()
  const catLabel = category?.label || 'unknown — check B2E detailed points report'
  const lines = [
    `<strong>Attendance Points — Disciplinary Action Needed</strong><br>`,
    `Facility: ${escapeHtml(facilityDisplay)} · Employee: <strong>${escapeHtml(employeeName)}</strong><br>`,
    `Current Point Count: <strong>${points}</strong> · Threshold Crossed: <strong>${threshold.points} pts → ${threshold.action}</strong><br>`,
    `Most Recent Category: ${escapeHtml(catLabel)}${triggeringDate ? ` (as of ${escapeHtml(triggeringDate)})` : ''}<br>`,
  ]
  if (pdfError) {
    lines.push(`<br>PDF attachment failed to generate (${escapeHtml(pdfError)}) — pull the form manually.`)
  } else {
    lines.push(`<br>Filled Disciplinary Action Form attached, including the full dated point history on file. Confirm against B2E, then complete Employee/Supervisor signatures — this is a system-generated notice, not a substitute for the signed paper form.`)
  }
  return lines.join('\n')
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

// Front comment WITH a PDF attachment — same multipart pattern already
// proven in lib/wr-secondary-repl-digest-shared.cjs's postCommentWithPdf.
async function frontPostCommentWithPdf(conversationId, body, pdfBytes, filename) {
  const form = new FormData()
  form.set('body', body)
  form.set('attachments[]', new Blob([pdfBytes], { type: 'application/pdf' }), filename)
  const res = await fetch(`https://api2.frontapp.com/conversations/${conversationId}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FRONT_TOKEN}`, Accept: 'application/json' },
    body: form,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw Object.assign(new Error('Front comment+PDF failed'), { detail: json })
  return json
}

// Builds a filled Disciplinary Action Form PDF. Layout matches the real
// completed example Dan supplied (Gary Yeoman docx): Date/Name/Position
// -> Program schedule -> Disciplinary Action -> "ACTION TAKEN:" ->
// "Dates Missed:" table (every known transaction, not just the latest)
// -> Current Point Count -> 2x2 warning-tier checkbox grid ->
// signatures on one line. Signature lines are blank underscores — NEVER
// filled. "Position" isn't available from any data source this function
// has today, so it renders as "—".
async function buildDisciplinaryFormPdf({ employeeName, facilityDisplay, points, thresholdPoints, transactions }) {
  const PAGE_W = 612, PAGE_H = 792 // US Letter
  const MARGIN = 50

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([PAGE_W, PAGE_H])

  let y = PAGE_H - MARGIN

  const text = (str, x, size, bold = false, color = rgb(0.08, 0.08, 0.1)) => {
    page.drawText(str, { x, y, size, font: bold ? fontBold : font, color })
  }
  const hr = (yPos) => page.drawLine({
    start: { x: MARGIN, y: yPos }, end: { x: PAGE_W - MARGIN, y: yPos },
    thickness: 0.75, color: rgb(0.6, 0.6, 0.6),
  })
  const checkbox = (label, checked, x) => {
    page.drawRectangle({ x, y: y - 9, width: 10, height: 10, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 })
    if (checked) page.drawText('X', { x: x + 1.5, y: y - 8, size: 9, font: fontBold })
    page.drawText(label, { x: x + 16, y, size: 9, font })
  }

  // ── Header ──────────────────────────────────────────────
  text('Attendance Disciplinary Action Form', MARGIN, 15, true)
  y -= 10
  text('System-generated — pending human review and signature', MARGIN, 8, false, rgb(0.5, 0.5, 0.5))
  y -= 20

  text(`DATE: ${new Date().toLocaleDateString('en-US')}`, MARGIN, 10, true)
  text(`NAME: ${employeeName}`, MARGIN + 200, 10, true)
  y -= 16
  text(`POSITION: —`, MARGIN, 10, true)
  text(`FACILITY: ${facilityDisplay}`, MARGIN + 200, 10, true)
  y -= 20

  // ── Program / point schedule ───────────────────────────
  text('Program', MARGIN, 10, true)
  y -= 13
  text('10-point system in a rolling 6-month period. Employees will be charged points per the schedule below:', MARGIN, 9)
  y -= 14
  text('+4 Points   Absence without advanced notification (no-call/no-show)', MARGIN + 10, 9)
  y -= 12
  text('+2 Points   Unexcused absence', MARGIN + 10, 9)
  y -= 12
  text('+1/2 Point  Unexcused tardy or departure of more than 15 minutes of assigned shift', MARGIN + 10, 9)
  y -= 18

  // ── Disciplinary Action ─────────────────────────────────
  text('Disciplinary Action', MARGIN, 10, true)
  y -= 13
  text('When an employee reaches the following points, the corresponding disciplinary action may result:', MARGIN, 9)
  y -= 13
  text('6 Points: Written Warning      8 Points: Final Warning      10 Points: Termination', MARGIN + 10, 9, true)
  y -= 18

  text('THIS IS TO CONFIRM IN WRITING THE DISCIPLINARY ACTION FOR ATTENDANCE', MARGIN, 9, true)
  y -= 16
  hr(y + 6)
  y -= 14

  // ── Action Taken / Dates Missed table ───────────────────
  text('ACTION TAKEN:', MARGIN, 10, true)
  y -= 15
  text('Dates Missed:', MARGIN, 10, true)
  y -= 14

  const MAX_ROWS = 14
  const shown = (transactions || []).slice(0, MAX_ROWS)
  if (shown.length === 0) {
    text('No individual transaction history available — see B2E detailed points report.', MARGIN + 10, 9, false, rgb(0.5, 0.5, 0.5))
    y -= 13
  } else {
    text('Type', MARGIN + 10, 8, true, rgb(0.4, 0.4, 0.45))
    text('Date', MARGIN + 140, 8, true, rgb(0.4, 0.4, 0.45))
    text('Points', MARGIN + 250, 8, true, rgb(0.4, 0.4, 0.45))
    y -= 11
    let sum = 0
    for (const tx of shown) {
      const dateStr = tx.modified_ts ? String(tx.modified_ts).slice(0, 10) : (tx.modified || '—')
      const pts = Number(tx.points)
      sum += pts
      text(tx.transaction_type || '—', MARGIN + 10, 9)
      text(dateStr, MARGIN + 140, 9)
      text(String(pts), MARGIN + 250, 9)
      y -= 12
    }
    if ((transactions || []).length > MAX_ROWS) {
      text(`+${transactions.length - MAX_ROWS} more — see B2E for full history`, MARGIN + 10, 8, false, rgb(0.5, 0.5, 0.5))
      y -= 12
    }
    if (Math.abs(sum - points) > 0.01) {
      text(`Note: sum of listed transactions (${sum}) may not exactly match Current Point Count due to the rolling 6-month decay / manual edits — B2E's balance is authoritative.`, MARGIN + 10, 7, false, rgb(0.6, 0.4, 0.1))
      y -= 12
    }
  }
  y -= 8
  hr(y + 6)
  y -= 16

  text(`Current Point Count: ${points}`, MARGIN, 11, true)
  y -= 22

  // ── Warning-tier checkbox grid (2x2, matches the real example) ─
  checkbox('Written Warning (6 pts)', thresholdPoints === 6, MARGIN)
  checkbox('Final Warning (8 pts)', thresholdPoints === 8, MARGIN + 260)
  y -= 20
  checkbox('Termination / Discharge (10 pts)', thresholdPoints === 10, MARGIN)
  y -= 34

  // ── Signatures ──────────────────────────────────────────
  text('SIGNATURES', MARGIN, 10, true)
  y -= 20
  text('EMPLOYEE: ________________________', MARGIN, 10)
  text('SUPERVISOR: ________________________', MARGIN + 260, 10)
  y -= 30

  text('FUTURE VIOLATIONS WILL RESULT IN DISCIPLINARY ACTION LEADING UP TO AND INCLUDING TERMINATION.', MARGIN, 8, true)
  y -= 16
  text('Generated by CSW-WI Attendance Points automation — verify against source B2E data before filing.', MARGIN, 7, false, rgb(0.55, 0.55, 0.55))

  return doc.save()
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
  const txByEmployee = await queryEmployeeTransactions(employeeIds)

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

      const transactions = txByEmployee.get(Number(emp.employee_id)) || []
      const latestTx = transactions[0] || null
      const category = latestTx ? CATEGORY_BY_POINTS[Number(latestTx.points)] : null
      const employeeName = [emp.first_name, emp.last_name].filter(Boolean).join(' ')
      const triggeringDate = latestTx?.modified_ts ? String(latestTx.modified_ts).slice(0, 10) : null
      const facilityDisplay = FACILITY_DISPLAY[facility] || facility.toUpperCase()

      let pdfError = null
      let posted
      try {
        const pdfBytes = await buildDisciplinaryFormPdf({
          employeeName, facilityDisplay, points, thresholdPoints: threshold.points, transactions,
        })
        const commentBody = buildFormComment({ employeeName, facility, threshold, points, category, triggeringDate })
        posted = await frontPostCommentWithPdf(
          settings.front_conversation_id, commentBody, pdfBytes,
          `disciplinary-action-${emp.employee_id}-${threshold.points}pt.pdf`
        )
      } catch (e) {
        pdfError = e.message
        const fallbackBody = buildFormComment({ employeeName, facility, threshold, points, category, triggeringDate, pdfError })
        posted = await frontPostComment(settings.front_conversation_id, fallbackBody)
      }
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
        action: threshold.action, points, category: category?.key || null, frontCommentId, pdfError,
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
  queryPointsBalance, queryEmployeeTransactions,
  buildDisciplinaryFormPdf,
  runDigest,
}
