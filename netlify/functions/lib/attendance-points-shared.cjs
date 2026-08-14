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
// wr-secondary-repl-pdf.cjs).
//
// PDF NOTE (2026-08-14, fifth pass — CURRENT LAYOUT): Dan supplied a real
// completed example (Miguel Rodriguez, WR, 08/13/2026) as a .docx, and
// the exact extracted text was diffed against this generator line-by-
// line before rewriting. Layout now matches that real form exactly:
//   - Title is ONE line, "Attendance Disciplinary Action Form" (not two
//     lines "Attendance Policy" / "Disciplinary Action Form" as before).
//   - DATE / NAME / POSITION each on their own line (previous pass had
//     Date+Name on one line, and had no Position line at all).
//   - POSITION IS LEFT BLANK. Checked b2e_slv_pointsbalance and
//     b2e_slv_employeeroster — the only job-related field anywhere in
//     the warehouse is default_job_code, a raw numeric code (e.g. "601")
//     with NO lookup table anywhere mapping it to a readable title like
//     "Order Selector". Rather than guess or hardcode an incomplete
//     code->title map, Position is left blank for a human to fill by
//     hand — same treatment as the signature lines. Revisit only if
//     given a real code->title mapping.
//   - "ACTION TAKEN:" is a real bordered 2x2 grid (previous pass drew
//     inline checkboxes with no borders): row 1 = [X-if-6pts | "Written
//     Warning"] [X-if-8pts | "Final Written Warning"]; row 2 = [blank |
//     blank] [X-if-10pts | "Discharge"].
//   - Real form's checkbox label at 10 points is literally "Discharge",
//     NOT "Termination" — even though the intro paragraph above it says
//     "10 Points: Termination". This is an inconsistency in CSW's own
//     source form, preserved exactly rather than "corrected."
//   - "Current Point Count: N" is its OWN standalone bold/underlined
//     line, positioned AFTER Dates Missed and BEFORE Signatures — it is
//     NOT part of the Action Taken grid (previous pass folded it into
//     that section).
//   - Dates Missed list is just Date + Points, two columns, no "Type"
//     column (previous pass added one; the real form doesn't have it).
//     Dates render as MM/DD/YYYY (e.g. "08/05/2026") matching the real
//     form — previous pass rendered ISO (YYYY-MM-DD).
//   - "EMPLOYEE: ___ SUPERVISOR: ___" are SIDE BY SIDE on one line. (The
//     immediately prior pass, per Dean Dioguardi's feedback on a
//     DIFFERENT reference example, had put these on separate lines —
//     that reference apparently didn't match this real one. Side-by-side
//     is now confirmed correct against an actual completed form.)
//
// Known, deliberate deviation from the real form (flagged to Dan, not
// silently added): a small "(Facility: X)" note next to the Name line.
// The real form has no facility field, but this automation covers 5
// locations and HR needs to know which one a given notice is for.
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
//
// SIGNED-COPY LOOP (2026-08-14): this function only handles generation +
// delivery (PDF -> Front). The rest of Dan's described loop — supervisor
// gets it signed, scans it, uploads the signed copy back into the app,
// HR downloads it later to manually enter into B2E — is handled
// separately by hr_signed_documents (Supabase table) + the 'hr-documents'
// Storage bucket + src/lib/hrDocuments.js + the SignedDocumentCell
// component wired into AttendancePointsTab's Recent Actions Log. See
// those files, not this one, for that half of the workflow.

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
// newest first — this is what populates the "Dates Missed" section on
// the generated form (the real form leaves this section blank for a
// human to hand-write; the automation fills it from B2E instead).
// Filtered to points > 0 (skip any zero/negative adjustment rows). See
// file header: only one historical load exists in MotherDuck as of
// build time, so this is the full transaction history available today,
// not necessarily the full rolling-6-month history once the sync lands.
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

// Real form uses MM/DD/YYYY (e.g. "08/05/2026"), not ISO — matches the
// exact Miguel Rodriguez reference example.
function formatMmDdYyyy(v) {
  if (!v) return ''
  const d = new Date(v)
  if (isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${d.getFullYear()}`
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
    lines.push(`<br>Filled Disciplinary Action Form attached, including the full dated point history on file. Confirm against B2E, then complete Position/Employee/Supervisor signatures by hand — this is a system-generated notice, not a substitute for the signed paper form. Once signed, scan and upload it back into the dashboard's Attendance Points tab so HR can retrieve it for B2E filing.`)
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

// Builds a filled Disciplinary Action Form PDF matching the real
// completed example (Miguel Rodriguez, WR, 2026-08-13) line-for-line —
// see file header for the full diff against the previous pass. Position
// and both signature lines are always left blank — a human fills those
// by hand on the printed/scanned copy.
async function buildDisciplinaryFormPdf({ employeeName, facilityDisplay, points, thresholdPoints, transactions }) {
  const PAGE_W = 612, PAGE_H = 792 // US Letter
  const MARGIN = 54
  const CONTENT_W = PAGE_W - MARGIN * 2
  const INK = rgb(0.08, 0.08, 0.1)

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([PAGE_W, PAGE_H])

  let y = PAGE_H - MARGIN

  const text = (str, x, size, bold = false, color = INK) => {
    page.drawText(str, { x, y, size, font: bold ? fontBold : font, color })
  }
  const underlineAt = (x, width, size, thisY = y) => {
    page.drawLine({ start: { x, y: thisY - size * 0.16 }, end: { x: x + width, y: thisY - size * 0.16 }, thickness: 0.6, color: INK })
  }
  const textUnderlined = (str, x, size, bold = false) => {
    const f = bold ? fontBold : font
    text(str, x, size, bold)
    underlineAt(x, f.widthOfTextAtSize(str, size), size)
  }
  const centeredText = (str, size, bold = false) => {
    const f = bold ? fontBold : font
    const w = f.widthOfTextAtSize(str, size)
    const x = MARGIN + (CONTENT_W - w) / 2
    page.drawText(str, { x, y, size, font: f, color: INK })
    return x
  }
  const centeredUnderlined = (str, size, bold = false) => {
    const f = bold ? fontBold : font
    const w = f.widthOfTextAtSize(str, size)
    const x = centeredText(str, size, bold)
    underlineAt(x, w, size)
  }

  // ── Title ──────────────────────────────────────────────
  centeredUnderlined('Attendance Disciplinary Action Form', 14, true)
  y -= 22

  // ── Date / Name / Position — each its own line ─────────
  text(`DATE: ${formatMmDdYyyy(new Date())}`, MARGIN, 10, true)
  text(`(Facility: ${facilityDisplay})`, MARGIN + 340, 9, false, rgb(0.45, 0.45, 0.5))
  y -= 15
  text(`NAME: ${employeeName}`, MARGIN, 10, true)
  y -= 15
  // POSITION deliberately left blank — see file header note.
  text('POSITION:', MARGIN, 10, true)
  y -= 18

  textUnderlined('Program', MARGIN, 10, true)
  y -= 13
  text('10-point system in a rolling 6 month period', MARGIN, 10)
  y -= 16

  text('Employees will be charged points based on the schedule below:', MARGIN, 10, true)
  y -= 14
  text('+4 Points', MARGIN, 9, true)
  text('Absence without advanced notification (no-call/no-show)', MARGIN + 58, 9)
  y -= 12
  text('+2 Points', MARGIN, 9, true)
  text('Unexcused absence', MARGIN + 58, 9)
  y -= 12
  text('+1/2 Point', MARGIN, 9, true)
  text('Unexcused tardy or departure of more than 15 minutes of assigned shift', MARGIN + 58, 9)
  y -= 18

  textUnderlined('Disciplinary Action', MARGIN, 11, true)
  y -= 14
  text('When an employee reaches the following points, the corresponding disciplinary action may result:', MARGIN, 9, true)
  y -= 14
  text('6 Points: Written Warning', MARGIN, 9)
  text('8 Points: Final Warning', MARGIN + 190, 9)
  text('10 Points: Termination', MARGIN + 360, 9)
  y -= 26

  // Big centered banner line, wraps 2 lines like the real form.
  centeredText('THIS IS TO CONFIRM IN WRITING THE DISCIPLINARY ACTION FOR', 13, true)
  y -= 16
  centeredText('ATTENDANCE', 13, true)
  y -= 26

  // ── Action Taken — real bordered 2x2 grid ───────────────
  textUnderlined('ACTION TAKEN:', MARGIN, 11, true)
  y -= 18

  {
    const rowH = 22
    const col1W = 22   // checkbox col
    const col2W = 220  // label col
    const col3W = 22
    const col4W = CONTENT_W - col1W - col2W - col3W
    const tableTop = y + 15
    const tableLeft = MARGIN

    page.drawLine({ start: { x: tableLeft, y: tableTop }, end: { x: tableLeft + CONTENT_W, y: tableTop }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) })
    page.drawLine({ start: { x: tableLeft, y: tableTop - rowH }, end: { x: tableLeft + CONTENT_W, y: tableTop - rowH }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) })
    page.drawLine({ start: { x: tableLeft, y: tableTop - rowH * 2 }, end: { x: tableLeft + CONTENT_W, y: tableTop - rowH * 2 }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) })
    let cx = tableLeft
    for (const w of [col1W, col2W, col3W, col4W]) {
      page.drawLine({ start: { x: cx, y: tableTop }, end: { x: cx, y: tableTop - rowH * 2 }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) })
      cx += w
    }
    page.drawLine({ start: { x: cx, y: tableTop }, end: { x: cx, y: tableTop - rowH * 2 }, thickness: 0.7, color: rgb(0.2, 0.2, 0.2) })

    const cellText = (str, colX, rowTopY, bold = false) => {
      page.drawText(str, { x: colX + 5, y: rowTopY - rowH / 2 - 3, size: 9, font: bold ? fontBold : font, color: INK })
    }
    // Row 1: [X-if-6pts | Written Warning] [X-if-8pts | Final Written Warning]
    if (thresholdPoints === 6) cellText('X', tableLeft, tableTop, true)
    cellText('Written Warning', tableLeft + col1W, tableTop)
    if (thresholdPoints === 8) cellText('X', tableLeft + col1W + col2W, tableTop, true)
    cellText('Final Written Warning', tableLeft + col1W + col2W + col3W, tableTop)
    // Row 2: [blank | blank] [X-if-10pts | Discharge] — "Discharge" is the
    // real form's exact wording here, not "Termination" (see file header).
    if (thresholdPoints === 10) cellText('X', tableLeft + col1W + col2W, tableTop - rowH, true)
    cellText('Discharge', tableLeft + col1W + col2W + col3W, tableTop - rowH)

    y = tableTop - rowH * 2 - 16
  }

  // ── Dates Missed — just Date + Points, no Type column ───
  textUnderlined('Dates Missed:', MARGIN, 10, true)
  y -= 14

  const MAX_ROWS = 14
  const shown = (transactions || []).slice(0, MAX_ROWS)
  if (shown.length === 0) {
    text('No individual transaction history available — see B2E detailed points report.', MARGIN + 20, 9, false, rgb(0.5, 0.5, 0.5))
    y -= 13
  } else {
    let sum = 0
    for (const tx of shown) {
      const dateStr = formatMmDdYyyy(tx.modified_ts) || tx.modified || '—'
      const pts = Number(tx.points)
      sum += pts
      text(dateStr, MARGIN + 20, 9)
      text(String(pts), MARGIN + 140, 9)
      y -= 13
    }
    if ((transactions || []).length > MAX_ROWS) {
      text(`+${transactions.length - MAX_ROWS} more — see B2E for full history`, MARGIN + 20, 8, false, rgb(0.5, 0.5, 0.5))
      y -= 12
    }
    if (Math.abs(sum - points) > 0.01) {
      text(`Note: listed transactions sum to ${sum}; may not exactly match Current Point Count due to the rolling`, MARGIN + 4, 7, false, rgb(0.6, 0.4, 0.1))
      y -= 9
      text(`6-month decay / manual edits — B2E's balance is authoritative.`, MARGIN + 4, 7, false, rgb(0.6, 0.4, 0.1))
      y -= 12
    }
  }
  y -= 12

  // Current Point Count — its OWN standalone line, not part of the grid.
  textUnderlined(`Current Point Count: ${points}`, MARGIN, 11, true)
  y -= 30

  textUnderlined('SIGNATURES', MARGIN, 11, true)
  y -= 20
  // Side by side, per the real form.
  text('EMPLOYEE: _____________________', MARGIN, 10)
  text('SUPERVISOR: ______________________', MARGIN + 280, 10)
  y -= 30

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
