'use strict'

// JDF Employee Daily Move Report — added 2026-08-13. Per Dan's ask on the
// same-item/same-tier project, following today's Madison 1st Shift Daily
// Check-In (Fathom recording 175194244): "Create an auto-generated daily
// report in the CSW Hub showing put-away effectiveness per person (per
// shift)." One PDF, one page per employee who moved a JDF pallet into F8
// that day, attached to the existing jdf_putaway_scorecard Front digest
// (see jdf-scorecard-digest-shared.cjs) rather than a separate delivery
// mechanism — reuses the exact PDF-attached-to-Front-comment pattern
// already proven twice in this app (attendance-points-shared.cjs's
// buildDisciplinaryFormPdf + frontPostCommentWithPdf, and
// wr-secondary-repl-digest-shared.cjs's postCommentWithPdf). pdf-lib is
// already a dependency for that reason — no new package needed.
//
// SCOPE NOTE: measures work COMPLETED that day (task completed_date_time),
// not LPs received that day — an employee putting away yesterday's
// backlog today still gets credited/debited for today's work. This is
// deliberately different from the Daily Putaway Scorecard's LP-received
// framing (see motherduck-jdf-putaways.cjs), because this report answers
// "how did this person do today," not "how much of today's freight moved
// cleanly" — those are different questions with different correct
// denominators.
//
// JOIN KEY NOTE (learned live in chat 2026-08-13 while investigating a
// specific mixed-bin case): a LicensePlateMove task references the pallet
// being moved via actual_source_license_plate_id, NOT
// actual_target_license_plate_id -- target there is the destination
// LOCATION, not a target plate. Getting this backwards silently returns
// zero rows for most real moves. Every query below uses the source field.
//
// FIXED 2026-08-13, TWICE: this query's OUTER SELECT list defines aliases
// `final_location` (= em.target_location) and `final_ts` (=
// em.completed_date_time) for the JS code below to consume -- but the
// emp_moves CTE itself has NO columns by those names, only
// `target_location` and `completed_date_time`/`first_ts`. Two separate
// clauses wrongly referenced the alias as if it were a real qualified
// column on `em`:
//   1. The JOIN's ON clause used `em.final_location` -- fixed to
//      `em.target_location`.
//   2. The ORDER BY used `em.final_ts` -- same mistake, fixed to
//      `em.completed_date_time`. This one actually reached production
//      and threw live in the real digest (Binder Error, confirmed from
//      the actual Front comment) before being caught and fixed here.
// General lesson, not just for this file: a qualified reference like
// `alias.name` always looks for a REAL column on that relation --
// output-list aliases are only safely referable unqualified (or not at
// all, inside a CTE chain like this). Verified this exact corrected query
// against live MotherDuck data (both 2026-08-13 and 2026-08-20 dates)
// before pushing.
//
// DEDUPE NOTE: a pallet moved more than once by the same person on the
// same day (confirmed live: two of csw-madison1's pallets moved twice
// within minutes, e.g. F8A37-2A -> F8A37-3A) collapses to ONE row keyed
// on its FINAL location for that employee, with move_count > 1 and both
// first_ts/final_ts surfaced -- per Dan's explicit ask ("moved twice") --
// rather than showing two separate move lines for what was really one
// pallet's day.
//
// LIMITATION (flagged, not hidden): Clean/Mixed status reflects each
// location's CURRENT contents, not necessarily what was there at the
// exact moment of that historical move -- same point-in-time constraint
// that killed the old 8-week trend chart (see motherduck-jdf-putaways.cjs
// header). A location showing 0 distinct materials means the pallet(s)
// placed there have since moved on again. This is disclosed on the PDF
// itself, not just in code comments.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

const JDF_PROJECT_ID = 365

function openDuck(motherduckToken) {
  process.env.HOME = '/tmp'
  process.env.motherduck_token = motherduckToken
  const duckdb = require('duckdb')
  const db = new duckdb.Database('md:production_db', { motherduck_token: motherduckToken })
  const conn = db.connect()
  return { db, conn }
}
function run(conn, sql) {
  return new Promise((resolve, reject) => conn.run(sql, (err) => err ? reject(err) : resolve()))
}
function all(conn, sql) {
  return new Promise((resolve, reject) => conn.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))
}

// queryEmployeeMoves — every employee's deduped, final-location move list
// for one Central calendar date, F8/JDF only. Returns a Map<employee,
// { moves: [...], totalMoves, cleanMoves, mixedMoves, pctEffective }>,
// sorted by totalMoves desc when iterated via employeeOrder.
async function queryEmployeeMoves(dateStr, motherduckToken) {
  const { db, conn } = openDuck(motherduckToken)
  try {
    await run(conn, 'LOAD motherduck')
    const rows = await all(conn, `
      WITH onhand AS (
        SELECT
          loc.location_container_name AS location,
          lp.license_plate_id,
          lp.lookup_code AS lp_code,
          m.lookup_code AS material_code,
          p.project_id
        FROM production_db.silver.datex_slv_licenseplates lp
        JOIN production_db.silver.datex_slv_locationcontainers loc ON loc.location_container_id = lp.location_id
        JOIN production_db.silver.datex_slv_licenseplatecontents lpc ON lpc.license_plate_id = lp.license_plate_id
        JOIN production_db.silver.datex_slv_lots lot ON lot.lot_id = lpc.lot_id
        JOIN production_db.silver.datex_slv_materials m ON m.material_id = lot.material_id
        JOIN production_db.silver.datex_slv_projects p ON p.project_id = m.project_id
        WHERE loc.location_container_name LIKE 'F8%' AND (lp.Archived IS NULL OR lp.Archived = false)
      ),
      loc_class AS (
        SELECT location, COUNT(DISTINCT material_code) FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS distinct_materials,
               STRING_AGG(DISTINCT material_code, ',') FILTER (WHERE project_id=${JDF_PROJECT_ID}) AS skus_here
        FROM onhand GROUP BY location
      ),
      moves AS (
        SELECT tt.Employee AS employee, tt.actual_source_license_plate_id AS license_plate_id,
               tgt.location_container_name AS target_location, tt.completed_date_time
        FROM production_db.silver.datex_slv_tasks tt
        JOIN production_db.silver.datex_slv_operationcodes oc ON oc.operation_code_id = tt.operation_code_id
        JOIN production_db.silver.datex_slv_locationcontainers tgt ON tgt.location_container_id = tt.actual_target_location_id
        WHERE oc.operation_code_name = 'LicensePlateMove' AND tgt.location_container_name LIKE 'F8%'
          AND tt.status_id = 2 AND CAST(tt.completed_date_time AS DATE) = DATE '${dateStr}'
          AND tt.Employee IS NOT NULL
      ),
      emp_moves AS (
        SELECT employee, license_plate_id, target_location, completed_date_time,
          ROW_NUMBER() OVER (PARTITION BY employee, license_plate_id ORDER BY completed_date_time DESC) AS rn,
          COUNT(*) OVER (PARTITION BY employee, license_plate_id) AS move_count,
          MIN(completed_date_time) OVER (PARTITION BY employee, license_plate_id) AS first_ts
        FROM moves
      )
      SELECT em.employee, o.lp_code, o.material_code, em.target_location AS final_location,
             em.move_count, em.first_ts, em.completed_date_time AS final_ts,
             lc.distinct_materials, lc.skus_here
      FROM emp_moves em
      JOIN onhand o ON o.license_plate_id = em.license_plate_id AND o.project_id = ${JDF_PROJECT_ID}
      JOIN loc_class lc ON lc.location = em.target_location
      WHERE em.rn = 1
      ORDER BY em.employee, em.completed_date_time
    `)

    const byEmployee = new Map()
    for (const r of rows || []) {
      if (!byEmployee.has(r.employee)) {
        byEmployee.set(r.employee, { moves: [], totalMoves: 0, cleanMoves: 0, mixedMoves: 0 })
      }
      const e = byEmployee.get(r.employee)
      const distinctMaterials = Number(r.distinct_materials ?? 0)
      const skusHere = (r.skus_here || '').split(',').filter(Boolean)
      const otherSkus = skusHere.filter(s => s !== r.material_code)
      // 0 distinct materials = the pallet has since moved on again (see
      // header LIMITATION note) -- surfaced as 'unknown', not silently
      // counted as clean or mixed either way.
      const status = distinctMaterials === 0 ? 'unknown' : (distinctMaterials > 1 ? 'mixed' : 'clean')
      e.moves.push({
        lpCode: r.lp_code,
        materialCode: r.material_code,
        finalLocation: r.final_location,
        moveCount: Number(r.move_count),
        firstTs: r.first_ts,
        finalTs: r.final_ts,
        status,
        sharingWith: otherSkus,
      })
      e.totalMoves += 1
      if (status === 'clean') e.cleanMoves += 1
      if (status === 'mixed') e.mixedMoves += 1
    }
    for (const e of byEmployee.values()) {
      const scored = e.cleanMoves + e.mixedMoves
      e.pctEffective = scored ? Math.round((e.cleanMoves / scored) * 1000) / 10 : null
    }
    return byEmployee
  } finally {
    try { conn.close(); db.close() } catch (_) {}
  }
}

// formatTime — FIXED 2026-08-13, confirmed against a live Datex lookup:
// Dan looked up LP F2608051381 directly in Datex and its LicensePlateMove
// completed at 6:26 PM per Datex's own UI. The raw stored value for that
// same move is "18:26:06.317" -- Datex displays it directly (24hr->12hr
// only, no shift). The FIRST version of this function appended 'Z' and
// converted through America/Chicago, treating the raw value as UTC and
// subtracting 5 hours -- producing 1:26 PM, which is simply wrong,
// confirmed against the actual source system. silver.datex_slv_tasks'
// completed_date_time is already Central local time (naive, no tz
// marker) -- format it directly.
//
// Parses the HH:MM straight out of the string rather than going through
// a JS Date object at all -- `new Date('2026-08-13 18:26:06')` gets
// interpreted in the SERVER's local timezone (a Netlify function runs in
// UTC), which would silently reintroduce the exact same class of bug on
// a server whose local zone isn't Central. Pure string parsing has no
// timezone dependency to get wrong.
function formatTime(ts) {
  const m = String(ts).match(/(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return String(ts)
  let hour = Number(m[1])
  const minute = m[2]
  const period = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12
  if (hour === 0) hour = 12
  return `${hour}:${minute} ${period}`
}
// formatTimeRange — compact "first -> final" for a pallet moved more than
// once. Drops the duplicate AM/PM suffix when both times share the same
// period (e.g. "5:49 -> 5:55 PM" not "5:49 PM -> 5:55 PM") so it fits the
// TIME column without crowding the LP Code column next to it -- the
// original format overflowed badly on real data (confirmed live in the
// first preview PDF).
function formatTimeRange(firstTs, finalTs) {
  const first = formatTime(firstTs)
  const final = formatTime(finalTs)
  const firstPeriod = first.slice(-2)
  const finalPeriod = final.slice(-2)
  const firstShown = firstPeriod === finalPeriod ? first.slice(0, -3) : first
  return `${firstShown} -> ${final}`
}
function formatHeaderDate(dateStr) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const d = new Date(`${dateStr}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
}

// buildEmployeeReportPdf — one PDF, one page (or more, if a person has a
// lot of moves) per employee. Sorted by totalMoves desc so the busiest
// movers -- the ones most worth reading first -- lead the document.
//
// LAYOUT FIXED 2026-08-13 (second pass, after first real render): the
// initial version drew each stat's small label and big number at the
// SAME (x, y) origin, just different font sizes -- they rendered
// literally on top of each other (visible in the first preview as
// "40%.e" where "% Effective" bled through behind "40%"). Fixed by
// stacking big-number-on-top / label-below, matching the KPI-card
// pattern already used in the on-screen JdfPutaways.jsx cards. Also
// widened the TIME column and shortened the double-move time-range
// format (formatTimeRange above) -- the original squeezed "5:49 PM ->
// 5:55 PM (x2)" into a column sized for a single timestamp and it
// visibly overran into the LP Code column on real data.
async function buildEmployeeReportPdf(byEmployee, dateStr) {
  const PAGE_W = 612, PAGE_H = 792 // US Letter, same as attendance-points-shared.cjs
  const MARGIN = 46
  const CONTENT_W = PAGE_W - MARGIN * 2
  const INK = rgb(0.08, 0.08, 0.1)
  const DIM = rgb(0.45, 0.45, 0.5)
  const GREEN = rgb(0.08, 0.5, 0.22)
  const RED = rgb(0.72, 0.15, 0.15)
  const ROW_H = 16
  const ROWS_PER_PAGE = 40
  // Column layout, widened from the first pass -- TIME needs enough room
  // for "5:49 -> 5:55 PM (x2)", not just a single timestamp.
  const col = {
    time: MARGIN, timeW: 118,
    lp: MARGIN + 122, lpW: 88,
    sku: MARGIN + 214, skuW: 46,
    loc: MARGIN + 264, locW: 62,
    status: MARGIN + 330, statusW: 52,
    share: MARGIN + 386,
  }

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontMono = await doc.embedFont(StandardFonts.Courier)

  const employees = [...byEmployee.entries()].sort((a, b) => b[1].totalMoves - a[1].totalMoves)

  for (const [employee, data] of employees) {
    const chunks = []
    for (let i = 0; i < data.moves.length; i += ROWS_PER_PAGE) chunks.push(data.moves.slice(i, i + ROWS_PER_PAGE))
    if (chunks.length === 0) chunks.push([])

    chunks.forEach((chunk, pageIdx) => {
      const page = doc.addPage([PAGE_W, PAGE_H])
      let y = PAGE_H - MARGIN

      const text = (str, x, size, bold = false, color = INK, useMono = false) => {
        page.drawText(str, { x, y, size, font: useMono ? fontMono : (bold ? fontBold : font), color })
      }

      text('JDF Putaway - Daily Move Report', MARGIN, 16, true)
      y -= 22
      text(`${employee}${pageIdx > 0 ? `  (cont'd, page ${pageIdx + 1})` : ''}`, MARGIN, 13, true)
      y -= 16
      text(`${formatHeaderDate(dateStr)}  \u00b7  Madison / F8`, MARGIN, 10, false, DIM)
      y -= 28

      if (pageIdx === 0) {
        // Stat blocks: BIG number on top, small dim label below it --
        // fixes the overlap bug (see function header note). Four evenly
        // spaced blocks across the content width.
        const blockW = CONTENT_W / 4
        const stats = [
          { label: 'MOVES', value: String(data.totalMoves), color: INK },
          { label: 'CLEAN', value: String(data.cleanMoves), color: GREEN },
          { label: 'MIXED', value: String(data.mixedMoves), color: RED },
          { label: 'EFFECTIVE', value: data.pctEffective === null ? '-' : `${data.pctEffective}%`, color: INK },
        ]
        const statTopY = y
        stats.forEach((s, i) => {
          const x = MARGIN + i * blockW
          page.drawText(s.value, { x, y: statTopY, size: 22, font: fontBold, color: s.color })
          page.drawText(s.label, { x, y: statTopY - 20, size: 8, font, color: DIM })
        })
        y = statTopY - 20 - 22
      }

      // Table header, with a light background band for separation.
      page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 16, color: rgb(0.94, 0.94, 0.95) })
      text('TIME', col.time + 4, 8, true, DIM)
      text('LP CODE', col.lp + 4, 8, true, DIM)
      text('SKU', col.sku + 4, 8, true, DIM)
      text('LOCATION', col.loc + 4, 8, true, DIM)
      text('STATUS', col.status + 4, 8, true, DIM)
      text('SHARING WITH', col.share + 4, 8, true, DIM)
      y -= 20

      chunk.forEach((m, i) => {
        if (i % 2 === 1) {
          page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: ROW_H, color: rgb(0.975, 0.975, 0.98) })
        }
        const timeLabel = m.moveCount > 1 ? `${formatTimeRange(m.firstTs, m.finalTs)} (x${m.moveCount})` : formatTime(m.finalTs)
        const timeSize = m.moveCount > 1 ? 7.5 : 8.5
        text(timeLabel, col.time + 4, timeSize, false, INK, true)
        text(m.lpCode, col.lp + 4, 8.5, false, INK, true)
        text(m.materialCode, col.sku + 4, 8.5)
        text(m.finalLocation, col.loc + 4, 8.5, false, INK, true)
        const statusColor = m.status === 'clean' ? GREEN : m.status === 'mixed' ? RED : DIM
        const statusLabel = m.status === 'clean' ? 'Clean' : m.status === 'mixed' ? 'Mixed' : 'Unknown'
        text(statusLabel, col.status + 4, 8.5, true, statusColor)
        text(m.sharingWith.join(', ') || '-', col.share + 4, 8, false, DIM)
        y -= ROW_H
      })

      if (pageIdx === chunks.length - 1) {
        y -= 14
        page.drawLine({ start: { x: MARGIN, y: y + 8 }, end: { x: PAGE_W - MARGIN, y: y + 8 }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) })
        text(
          "Status reflects each location's CURRENT contents, not necessarily what was there at the exact moment of",
          MARGIN, 7, false, DIM
        )
        y -= 9
        text(
          'this move. "Unknown" means the pallet has since moved again. Moves shown are pallets moved into F8 (JDF only).',
          MARGIN, 7, false, DIM
        )
      }
    })
  }

  return doc.save()
}

module.exports = { queryEmployeeMoves, buildEmployeeReportPdf }
