'use strict'

// DPI Monthly Process — carrier route sheet PDF (A1 fix).
//
// Jen's original ask (A1): carrier confirmation should happen BEFORE
// agency comms — carriers move stops, so confirming with them first means
// not re-scheduling every agency a second time when a stop shifts. Per
// Dan (2026-09-24): rather than a separate approval screen/phase, this is
// built directly into the Route Build stage as a print/PDF export — one
// button generates one PDF, one page per scheduled route, matching the
// exact layout of the printed sheet Dan shared (a real route's printed
// output: Route number, Load/Deliver Date with day label + calendar date,
// a highlighted routing note, then a per-stop table of Time/Agency#/
// Agency/City/Gross Weight/Total Cases/Travel Time with a totals row).
// That PDF IS the carrier-confirmation artifact — generate it, send it to
// the carrier, make any requested edits back in Route Build, regenerate,
// then proceed to Agency Comms. No separate phase screen, no Front-send
// integration (yet) — this function only renders the PDF; sending it is a
// manual step outside the app for now.
//
// Deliberately pure JS (pdf-lib), no headless-browser screenshot and no
// duckdb — same reasoning already applied in wr-secondary-repl-pdf.cjs
// (a Chromium dependency on Netlify's Lambda runtime carries the same
// class of cold-start/native-binary fragility duckdb already caused on
// this project). No MotherDuck query here either: the caller
// (Phase2BuildFlag.jsx) already has real per-agency gross weight in
// memory (its A7 weightMap) and passes fully-computed numbers in the
// request body — this function only lays them out on the page. Single
// source of truth stays the client's on-screen numbers; the PDF can never
// show something different from what's on screen when it was generated.
//
// Input (POST JSON): {
//   facility, monthKey,
//   routes: [{
//     routeNumber, loadDay, loadDateStr, loadTimeStr,
//     deliverDay, deliverDateStr, departDay, departTimeStr,
//     highlight,       // first pipe-segment of the route's notes, or null
//     restNotes,       // remaining pipe-segments, as an array of strings
//     stops: [{ time, agencyNumber, agencyName, city, grossWeight, totalCases, travelTime }],
//     totalWeight, totalCases,
//   }, ...]
// }
// Output: raw PDF bytes, Content-Type application/pdf, one page per route
// in the order given.
//
// Tested locally against synthetic data matching the reference sheet
// (route 109, Eau Claire) before shipping — rendered via pdftoppm and
// visually verified, same practice wr-secondary-repl-pdf.cjs's own header
// documents. Caught and fixed a real column-spacing bug (Gross Weight/
// Total Cases/Travel Time ran together with no visible gap) on first
// render.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 40

// Column x-positions within the stop table (portrait letter, ~532pt usable width).
const COLS = [
  { key: 'time', label: 'Time', x: MARGIN, width: 78 },
  { key: 'agencyNumber', label: 'Agency #', x: MARGIN + 84, width: 48 },
  { key: 'agencyName', label: 'Agency', x: MARGIN + 138, width: 138 },
  { key: 'city', label: 'City', x: MARGIN + 282, width: 58 },
  { key: 'grossWeight', label: 'Gross Weight', x: MARGIN + 348, width: 62, align: 'right' },
  { key: 'totalCases', label: 'Total Cases', x: MARGIN + 420, width: 38, align: 'right' },
  { key: 'travelTime', label: 'Travel Time', x: MARGIN + 468, width: 64 },
]

function fmtWeight(n) {
  const v = Number(n) || 0
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('en-US')
}

class RouteSheetPdf {
  constructor(doc, font, fontBold) {
    this.doc = doc
    this.font = font
    this.fontBold = fontBold
  }

  text(x, yFromTop, str, { size = 9, bold = false, color = rgb(0.1, 0.1, 0.12), align = 'left', width = 0 } = {}) {
    const f = bold ? this.fontBold : this.font
    let drawX = x
    if (align === 'right' && width) {
      const w = f.widthOfTextAtSize(String(str), size)
      drawX = x + width - w
    }
    this.page.drawText(String(str), { x: drawX, y: PAGE_H - yFromTop, size, font: f, color })
  }

  hr(yFromTop, x = MARGIN, width = PAGE_W - MARGIN * 2, color = rgb(0.3, 0.3, 0.3), thickness = 0.75) {
    this.page.drawLine({ start: { x, y: PAGE_H - yFromTop }, end: { x: x + width, y: PAGE_H - yFromTop }, thickness, color })
  }

  drawRoutePage(route) {
    this.page = this.doc.addPage([PAGE_W, PAGE_H])
    let y = MARGIN

    // Header block: Route number, Load/Deliver date lines with the
    // day-label bold + the derived calendar date small beside it —
    // matches the printed sheet's "Load Date - Mon [10/5]" format.
    this.text(MARGIN, y, 'Route', { size: 11, bold: true })
    this.text(MARGIN + 45, y, String(route.routeNumber || ''), { size: 13, bold: true })
    y += 20

    this.text(MARGIN, y, `Load Date - ${route.loadDay || '—'}${route.loadTimeStr ? ' ' + route.loadTimeStr : ''}`, { size: 10, bold: true })
    if (route.loadDateStr) this.text(MARGIN + 190, y - 3, route.loadDateStr, { size: 7, color: rgb(0.4, 0.4, 0.45) })
    y += 15

    // 2026-09-24 FIX: this line didn't exist at all — the PDF was built
    // before Appointment/Leave times existed as a real, edited feature,
    // against a reference sheet that only had Load/Deliver Date.
    // Confirmed live: Dan set an Appt/Leave time on a route and the
    // printed PDF still showed nothing for it. No derived calendar date
    // here (unlike Load/Deliver) — depart_day isn't guaranteed to fall
    // before deliver_day within the short window computeLoadDateStr
    // assumes, so a day label + time is shown without risking a date
    // computed in the wrong direction.
    if (route.departDay || route.departTimeStr) {
      this.text(MARGIN, y, `Leave Date - ${route.departDay || '—'}${route.departTimeStr ? ' ' + route.departTimeStr : ''}`, { size: 10, bold: true })
      y += 15
    }

    this.text(MARGIN, y, `Deliver Date - ${route.deliverDay || '—'}`, { size: 10, bold: true })
    if (route.deliverDateStr) this.text(MARGIN + 190, y - 3, route.deliverDateStr, { size: 7, color: rgb(0.4, 0.4, 0.45) })
    y += 6

    // Highlighted routing note (e.g. "Load 1st Mon PM") — yellow
    // highlight box behind the text, matching the reference sheet exactly.
    if (route.highlight) {
      y += 14
      const boxH = 14
      this.page.drawRectangle({
        x: MARGIN, y: PAGE_H - (y + 3), width: 220, height: boxH,
        color: rgb(1, 0.95, 0.4),
      })
      this.text(MARGIN + 3, y + 8, route.highlight, { size: 9 })
    }

    // Remaining route-level notes (anything after the first pipe-segment
    // in the source notes field) — no dedicated per-stop notes column
    // exists in dpi_route_stops, so these print as general route notes
    // rather than being forced onto a specific stop's row.
    if (route.restNotes && route.restNotes.length > 0) {
      y += 16
      for (const note of route.restNotes) {
        this.text(MARGIN, y, note, { size: 8, color: rgb(0.35, 0.35, 0.4) })
        y += 11
      }
    }

    y += 22
    this.hr(y)
    y += 12

    // Table header
    for (const col of COLS) {
      this.text(col.x, y, col.label, { size: 8, bold: true, align: col.align, width: col.width })
    }
    y += 6
    this.hr(y)
    y += 12

    // Stop rows
    for (const stop of route.stops || []) {
      for (const col of COLS) {
        let val = stop[col.key]
        if (col.key === 'grossWeight') val = fmtWeight(val)
        if (col.key === 'totalCases') val = fmtInt(val)
        this.text(col.x, y, val ?? '', { size: 8, align: col.align, width: col.width })
      }
      y += 15
      if (y > PAGE_H - MARGIN - 40) {
        // Overflow safety net: a route with an unusually long stop list
        // spills onto a fresh page rather than running off the bottom.
        // Real routes in this system top out around a dozen stops, so
        // this is a defensive fallback, not the expected path.
        this.page = this.doc.addPage([PAGE_W, PAGE_H])
        y = MARGIN
      }
    }

    // Totals row
    y += 4
    this.hr(y, MARGIN + 282, PAGE_W - MARGIN * 2 - 282)
    y += 12
    this.text(MARGIN + 282, y, 'Total', { size: 8, bold: true })
    this.text(MARGIN + 348, y, fmtWeight(route.totalWeight), { size: 8, bold: true, align: 'right', width: 62 })
    this.text(MARGIN + 420, y, fmtInt(route.totalCases), { size: 8, bold: true, align: 'right', width: 38 })
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }
  }

  const { facility, monthKey, routes } = body
  if (!Array.isArray(routes) || routes.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'routes must be a non-empty array' }) }
  }

  try {
    const doc = await PDFDocument.create()
    doc.setTitle(`DPI Carrier Route Sheets — ${facility || ''} ${monthKey || ''}`.trim())
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
    const builder = new RouteSheetPdf(doc, font, fontBold)

    for (const route of routes) builder.drawRoutePage(route)

    const bytes = await doc.save()
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="DPI-${(facility || 'route').replace(/\s+/g, '')}-${monthKey || ''}-carrier-routes.pdf"`,
      },
      body: Buffer.from(bytes).toString('base64'),
      isBase64Encoded: true,
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }) }
  }
}
