'use strict'

// Full bay-card + PDF rendering for the WR Secondary Replenishments
// digest (added 2026-07-15) — Dan asked for the digest to also attach a
// PDF similar to the tab's own Print button output. This module is a
// FULL port of WrSecondaryRepl.jsx's buildBays/buildPullMap/
// getPullLocations (materials, tier-by-tier detail, pull-from suggestions
// included) — richer than the stats-only buildBays already living in
// wr-secondary-repl.cjs (which only needs bay-level counts for its
// `summary` field). Kept as a separate module rather than reusing that
// trimmed version so a rendering-detail bug can't destabilize the
// already-working summary calc, and vice versa. Kept in sync manually
// with the client — same class of intentional duplication already
// accepted elsewhere in this codebase (e.g. fefo-digest-run.cjs mirrors
// fefo.js's verdict engine).
//
// PDF library: pdf-lib (pure JS, no native bindings) — deliberately NOT
// a headless-browser screenshot of the live page. Same reasoning Dan
// already applied to dailyops-digest-run.cjs: a Chromium dependency on
// Netlify's Lambda runtime carries the same class of fragility duckdb
// already caused on this project (cold starts, native binary bundling,
// timing races on "has data finished loading"). pdf-lib needs no
// external_node_modules/included_files bundling treatment at all (unlike
// duckdb/@napi-rs/canvas) since it's pure JS.
//
// Layout: greedy 2-column bin-packing (place each card in whichever
// column currently has the shorter content) — approximates the CSS grid
// masonry layout from wr-secondary-repl.css without needing a real layout
// engine. Not pixel-identical to the browser's Print button output, but
// same information, same 2-column side-by-side idea.
//
// Tested locally (Babel-parsed + rendered against synthetic sample data,
// visually verified via pdftoppm) before shipping — caught and fixed a
// real Y-coordinate inversion bug (new pages were starting content near
// the page BOTTOM instead of the top) that would have silently produced
// a garbled, mostly-blank multi-page PDF on every real run.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

const BUFFER_LOCS = [
  { loc: 'F029B', mat: '61002' }, { loc: 'F031B', mat: '61002' },
  { loc: 'F033B', mat: '61019' }, { loc: 'F035B', mat: '61019' },
  { loc: 'F037B', mat: '61003' }, { loc: 'F039B', mat: '61003' },
  { loc: 'F055B', mat: '61015' }, { loc: 'F057B', mat: '61015' },
  { loc: 'F069B', mat: '61010' }, { loc: 'F073B', mat: '61010' },
  { loc: 'F083B', mat: '059' },   { loc: 'F085B', mat: '059' },
  { loc: 'F087B', mat: '051' },   { loc: 'F089B', mat: '051' },
  { loc: 'F091B', mat: '056' },   { loc: 'F093B', mat: '056' },
  { loc: 'F095B', mat: '050' },   { loc: 'F097B', mat: '050' },
]

const AISLE_ORDER = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 }
function aisleRank(loc) {
  const ch = loc.charAt(0).toUpperCase()
  return AISLE_ORDER[ch] !== undefined ? AISLE_ORDER[ch] : 99
}

function buildPullMap(allInv) {
  const map = {}
  allInv.forEach(r => {
    if (!map[r.mat]) map[r.mat] = []
    map[r.mat].push(r)
  })
  Object.keys(map).forEach(mat => {
    map[mat].sort((a, b) => {
      const ra = aisleRank(a.loc), rb = aisleRank(b.loc)
      if (ra !== rb) return ra - rb
      return a.loc.localeCompare(b.loc)
    })
  })
  return map
}

function getPullLocations(mats, pullMap, bayCapacity, buffer, claimedLocs) {
  const target = bayCapacity + buffer
  const results = []
  for (const mat of mats) {
    const locs = (pullMap[mat] || []).filter(r => !r.loc.startsWith('P') && !claimedLocs.has(r.loc))
    let cumulative = 0
    const needed = []
    for (const r of locs) {
      if (cumulative >= target) break
      needed.push(r)
      cumulative += r.lp
    }
    if (needed.length > 0) {
      needed.forEach(r => claimedLocs.add(r.loc))
      results.push({ mat, locs: needed })
    }
  }
  return results
}

// Full-detail buildBays — same shape as WrSecondaryRepl.jsx's version.
function buildBaysFull(aisle, pslots, inv, lpMap) {
  const invMap = {}
  inv.forEach(r => {
    if (!invMap[r.loc]) invMap[r.loc] = []
    invMap[r.loc].push(r)
  })

  const isEven = n => n % 2 === 0
  const aisleFilter = aisle === 'G' ? isEven : n => !isEven(n)

  const relevantP = pslots.filter(p => {
    const m = p.loc.match(/P(\d+)/)
    if (!m) return false
    return aisleFilter(parseInt(m[1]))
  })

  const bayNums = [...new Set(relevantP.map(p => parseInt(p.loc.match(/P(\d+)/)[1])))].sort((a, b) => a - b)

  const bufferByNum = {}
  if (aisle === 'F') {
    BUFFER_LOCS.forEach(b => {
      const m = b.loc.match(/F(\d+)B/)
      if (!m) return
      const n = parseInt(m[1])
      if (!bufferByNum[n]) bufferByNum[n] = []
      bufferByNum[n].push(b)
    })
  }

  const regularBays = bayNums.map(num => {
    const faces = relevantP.filter(p => parseInt(p.loc.match(/P(\d+)/)[1]) === num).sort((a, b) => a.loc.localeCompare(b.loc))
    const isSplit = new Set(faces.map(f => f.loc)).size > 1
    const secPrefix = aisle + String(num).padStart(3, '0')
    const allTiers = ['B', 'C', 'D']

    const tierData = allTiers.map(t => {
      const key = secPrefix + t
      const lps = lpMap[key] || 0
      const empty = Math.max(0, 3 - lps)
      const secRows = (invMap[key] || []).map(r => ({ tier: t, loc: key, mat: r.mat }))
      return { t, key, lps, empty, secRows }
    })

    if (isSplit) {
      const mats = [...new Set(faces.map(f => f.mat))]
      const allSecRows = tierData.flatMap(td => td.secRows)
      const emptyPositions = tierData.reduce((s, td) => s + td.empty, 0)
      const hasMatchingInv = allSecRows.some(r => mats.includes(r.mat))
      return { num, faces, isSplit, mats, secPrefix, emptyPositions, hasMatchingInv, tierData, bufferTierData: [] }
    } else {
      const mats = [faces[0].mat]
      const bufferEntries = bufferByNum[num] || []
      const hasBuffer = bufferEntries.length > 0
      const regularTiers = hasBuffer ? tierData.filter(td => td.t !== 'B') : tierData

      const bufferTierData = bufferEntries.map(b => {
        const lps = lpMap[b.loc] || 0
        const empty = Math.max(0, 3 - lps)
        const secRows = (invMap[b.loc] || []).map(r => ({ tier: 'B_buf', loc: b.loc, mat: r.mat }))
        return { t: 'B_buf', key: b.loc, lps, empty, secRows, bufferMat: b.mat }
      })

      const allSecRows = [...regularTiers.flatMap(td => td.secRows), ...bufferTierData.flatMap(td => td.secRows)]
      const bufferEmpty = bufferTierData.reduce((s, td) => s + td.empty, 0)
      const emptyPositions = regularTiers.reduce((s, td) => s + td.empty, 0) + bufferEmpty
      const hasMatchingInv = allSecRows.some(r => mats.includes(r.mat))

      return { num, faces, isSplit: false, mats, secPrefix, emptyPositions, hasMatchingInv, tierData: regularTiers, bufferTierData }
    }
  })

  return regularBays.sort((a, b) => a.num - b.num)
}

function fmtInt(n) { return n == null ? '—' : Math.round(n).toLocaleString() }

// ── PDF rendering ────────────────────────────────────────────────────────

const PAGE_W = 612, PAGE_H = 792
const MARGIN = 36
const COL_GAP = 14
const COL_W = (PAGE_W - MARGIN * 2 - COL_GAP) / 2
const LINE_H = 11
const CARD_PAD = 8
const CARD_GAP = 8

function estimateCardLines(bay, pullMap) {
  // Header line + one line per tier + pull-from lines when short.
  let lines = 1
  const tiers = [...bay.tierData, ...(bay.bufferTierData || [])]
  lines += tiers.length
  if (bay.emptyPositions > 0) {
    const claimed = new Set()
    const capacity = (bay.tierData.length + (bay.bufferTierData || []).length) * 3
    const pulls = getPullLocations(bay.mats, pullMap, capacity, 3, claimed)
    lines += 1 + pulls.length // "Pull from" header + one line per material
  }
  return lines
}

class PdfBuilder {
  constructor(doc, font, fontBold) {
    this.doc = doc
    this.font = font
    this.fontBold = fontBold
    this.page = null
    this.colY = [0, 0] // current Y (top-down offset from MARGIN) per column
    this.pageTop = 0
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H])
    this.pageTop = MARGIN
    this.colY = [this.pageTop, this.pageTop]
  }

  text(x, yFromTop, str, { size = 9, bold = false, color = rgb(0.1, 0.1, 0.12) } = {}) {
    this.page.drawText(str, { x, y: PAGE_H - yFromTop, size, font: bold ? this.fontBold : this.font, color })
  }

  hr(yFromTop, width = PAGE_W - MARGIN * 2, x = MARGIN, color = rgb(0.6, 0.6, 0.6)) {
    this.page.drawLine({ start: { x, y: PAGE_H - yFromTop }, end: { x: x + width, y: PAGE_H - yFromTop }, thickness: 0.5, color })
  }

  // Full-width header block (title, date, stat strip). Always page 1, top.
  drawHeader(title, subtitle, stats) {
    this.newPage()
    let y = MARGIN + 4
    this.text(MARGIN, y, title, { size: 14, bold: true })
    y += 18
    this.text(MARGIN, y, subtitle, { size: 9, color: rgb(0.4, 0.4, 0.45) })
    y += 20
    const statW = (PAGE_W - MARGIN * 2) / stats.length
    stats.forEach((s, i) => {
      const x = MARGIN + i * statW
      this.text(x, y, fmtInt(s.val), { size: 16, bold: true, color: s.color || rgb(0.1, 0.1, 0.12) })
      this.text(x, y + 13, s.label.toUpperCase(), { size: 7, color: rgb(0.45, 0.45, 0.5) })
    })
    y += 34
    this.hr(y)
    y += 14
    this.colY = [y, y]
    this.sectionStartY = y
  }

  sectionTitle(label) {
    // Section titles always start a fresh full-width line, in the shorter column's flow —
    // simplest correct behavior: force both columns to the same Y (bottom of the taller one) first.
    const y = Math.max(this.colY[0], this.colY[1]) + 6
    this.text(MARGIN, y, label, { size: 11, bold: true })
    const ny = y + 14
    this.colY = [ny, ny]
  }

  // Places a card in whichever column is currently shortest (greedy packing).
  placeCard(lines) {
    const col = this.colY[0] <= this.colY[1] ? 0 : 1
    const height = CARD_PAD * 2 + lines * LINE_H
    if (this.colY[col] + height > PAGE_H - MARGIN) {
      this.newPage()
    }
    const x = MARGIN + col * (COL_W + COL_GAP)
    const yTop = this.colY[col]
    this.colY[col] = yTop + height + CARD_GAP
    return { x, yTop, width: COL_W }
  }

  drawCard(bay, pullMap) {
    const lineCount = estimateCardLines(bay, pullMap)
    const { x, yTop, width } = this.placeCard(lineCount)
    let y = yTop + CARD_PAD + 8

    this.page.drawRectangle({
      x, y: PAGE_H - (yTop + CARD_PAD * 2 + lineCount * LINE_H),
      width, height: CARD_PAD * 2 + lineCount * LINE_H,
      borderColor: rgb(0.75, 0.75, 0.78), borderWidth: 0.5,
    })

    const urgColor = bay.emptyPositions >= 5 ? rgb(0.75, 0.25, 0.25)
      : bay.emptyPositions >= 3 ? rgb(0.7, 0.55, 0.1)
      : rgb(0.15, 0.55, 0.25)

    this.text(x + CARD_PAD, y, bay.secPrefix, { size: 10, bold: true })
    this.text(x + width - CARD_PAD - 60, y, bay.emptyPositions > 0 ? `${bay.emptyPositions} empty` : 'full', { size: 9, bold: true, color: urgColor })
    y += LINE_H

    const tiers = [...bay.tierData, ...(bay.bufferTierData || [])]
    for (const td of tiers) {
      const tierMats = [...new Set((td.secRows || []).map(r => r.mat))]
      const label = td.t.replace('_buf', 'B')
      let line
      if (td.lps > 0) {
        line = `${label}: ${tierMats.filter(Boolean).join(', ') || '(no mat.)'} — ${td.lps} LP${td.lps !== 1 ? 's' : ''}`
      } else {
        line = `${label}: empty — 3 positions`
      }
      this.text(x + CARD_PAD, y, line.length > 62 ? line.slice(0, 62) + '…' : line, { size: 8 })
      y += LINE_H
    }

    if (bay.emptyPositions > 0) {
      const claimed = new Set()
      const capacity = tiers.length * 3
      const pulls = getPullLocations(bay.mats, pullMap, capacity, 3, claimed)
      this.text(x + CARD_PAD, y, 'Pull from:', { size: 8, bold: true, color: rgb(0.45, 0.45, 0.5) })
      y += LINE_H
      if (pulls.length === 0) {
        this.text(x + CARD_PAD, y, 'No pull locations found', { size: 8, color: rgb(0.6, 0.2, 0.2) })
      } else {
        for (const p of pulls) {
          const locsStr = p.locs.map(l => l.loc).join(', ')
          const line = `${p.mat} -> ${locsStr}`
          this.text(x + CARD_PAD, y, line.length > 62 ? line.slice(0, 62) + '…' : line, { size: 8, color: rgb(0.55, 0.4, 0.05) })
          y += LINE_H
        }
      }
    }
  }
}

async function buildSecondaryReplPdf(data) {
  const { pslots, lpMap, gInv, fInv, allInv, summary } = data
  const pullMap = buildPullMap(allInv || [])

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const builder = new PdfBuilder(doc, font, fontBold)

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric', year: 'numeric' })

  builder.drawHeader(
    `Secondary Replenishments — Bernatello's - Wisconsin Rapids`,
    `As of ${dateStr}`,
    [
      { label: 'Bays', val: summary?.bays },
      { label: 'Empty positions', val: summary?.emptyPositions },
      { label: 'Critical (5+)', val: summary?.critical, color: rgb(0.75, 0.25, 0.25) },
      { label: 'No secondary inv.', val: summary?.noSecondaryInv, color: rgb(0.7, 0.55, 0.1) },
      { label: 'Split bays', val: summary?.splitBays },
    ]
  )

  const gBays = buildBaysFull('G', pslots || [], gInv || [], lpMap || {})
  const fBays = buildBaysFull('F', pslots || [], fInv || [], lpMap || {})

  builder.sectionTitle('G Aisle · even')
  for (const bay of gBays) builder.drawCard(bay, pullMap)

  builder.sectionTitle('F Aisle · odd')
  for (const bay of fBays) builder.drawCard(bay, pullMap)

  return doc.save()
}

module.exports = { buildSecondaryReplPdf, buildBaysFull, buildPullMap, getPullLocations }
