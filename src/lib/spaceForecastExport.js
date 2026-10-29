// Excel export for /spaceforecast (added 2026-10-29).
//
// One workbook: a sheet per facility, a Scenarios sheet and a Summary sheet.
// Everything derived is a live Excel formula so people can change a forecast cell,
// a stack factor, a capacity or a scenario and watch totals recalculate:
//   positions       = pallets / stack                      (facility sheet, right block)
//   zone used       = SUMIF(customer zone, positions) + SUMIFS(Scenarios positions in month range)
//   utilization     = zone used / capacity
//   95% flag        = used > capacity * 0.95
// Cached values (v) are written alongside each formula so previewers that don't
// recalculate still show numbers; Excel recalculates on open.
//
// "Now" is the live Datex LP count for linked rows (raw LPs, not divided by stack),
// otherwise the typed value. It is shown for reference and is not used by any formula.

import * as XLSX from 'xlsx'

const TARGET = 0.95
const FIRST = 7 // 0-based row index of the first customer row (Excel row 7)
const NM = 12

const L = (c) => XLSX.utils.encode_col(c)
const A = (r, c) => XLSX.utils.encode_cell({ r, c })
const safeName = (s) => String(s).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)
const q = (sheet) => `'${sheet.replace(/'/g, "''")}'`

function put(ws, r, c, v, z) {
  let cell
  if (v && typeof v === 'object' && 'f' in v) cell = { t: typeof v.v === 'string' ? 's' : 'n', f: v.f, v: v.v }
  else if (typeof v === 'number') cell = { t: 'n', v }
  else if (v == null || v === '') return
  else cell = { t: 's', v: String(v) }
  if (z) cell.z = z
  ws[A(r, c)] = cell
}

function finish(ws, rows, cols, widths) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows, c: cols } })
  ws['!cols'] = widths.map((w) => ({ wch: w }))
  return ws
}

// facs: [{ id, name, asOf, zones:[{name,capacity}], customers:[{name,zone,stack,now,src,fc[]}],
//          scen:[{name,zone,pallets,stack,from,to,on}] }]   (zone = zone NAME, from/to = 0-based month index)
export function buildWorkbook(facs, months) {
  const wb = XLSX.utils.book_new()
  const used = new Set(['Summary', 'Scenarios'])
  const sheetOf = {}
  facs.forEach((f) => {
    let n = safeName(f.name), k = 2
    while (used.has(n)) n = safeName(f.name).slice(0, 28) + ' ' + k++
    used.add(n); sheetOf[f.id] = n
  })

  // ---- Scenarios sheet --------------------------------------------------------
  const sc = {}
  const SC_MAX = 300
  ;['Facility', 'Zone', 'Scenario', 'Pallets', 'Stack', 'From month #', 'To month #', 'Active (1/0)', 'Positions'].forEach((h, c) => put(sc, 0, c, h))
  let sr = 1
  const scenPos = {} // `${facId}|${zone}` -> [12]
  facs.forEach((f) => f.scen.forEach((s) => {
    const pos = s.on ? (s.stack ? s.pallets / s.stack : 0) : 0
    put(sc, sr, 0, f.name); put(sc, sr, 1, s.zone); put(sc, sr, 2, s.name); put(sc, sr, 3, s.pallets); put(sc, sr, 4, s.stack)
    put(sc, sr, 5, s.from + 1); put(sc, sr, 6, s.to + 1); put(sc, sr, 7, s.on ? 1 : 0)
    sr++
    const key = `${f.id}|${s.zone}`
    scenPos[key] = scenPos[key] || Array(NM).fill(0)
    for (let i = s.from; i <= s.to; i++) scenPos[key][i] += pos
  }))
  for (let r = 1; r < SC_MAX; r++) {
    const row = r + 1
    const sc0 = sc[A(r, 3)] ? { p: sc[A(r, 3)].v, s: sc[A(r, 4)].v, a: sc[A(r, 7)].v } : null
    const v = sc0 ? (sc0.a === 1 && sc0.s ? sc0.p / sc0.s : 0) : 0
    put(sc, r, 8, { f: `IF(H${row}=1,IF(E${row}=0,0,D${row}/E${row}),0)`, v }, '#,##0.0')
  }
  put(sc, 0, 10, 'Month #'); put(sc, 0, 11, 'Month')
  months.forEach((mo, i) => { put(sc, i + 1, 10, i + 1); put(sc, i + 1, 11, mo) })
  put(sc, 14, 10, 'Add scenarios in the next empty row: Facility must match a facility sheet name, Zone a zone name on that sheet.')
  put(sc, 15, 10, 'From/To are month numbers (see the table above). Positions is a formula, filled down to row ' + SC_MAX + '.')
  finish(sc, SC_MAX, 11, [16, 18, 26, 10, 8, 13, 11, 12, 11, 9, 10, 10])

  // ---- Facility sheets --------------------------------------------------------
  const summary = [] // rows for the Summary sheet
  facs.forEach((f) => {
    const ws = {}
    const sn = sheetOf[f.id]
    const n = f.customers.length
    const last = FIRST + Math.max(n, 1) // Excel row number of last customer row (1-based)
    const zRange = `$B$${FIRST + 1}:$B$${last}`
    const POS0 = 5 + NM // first positions column (R)

    put(ws, 0, 0, `${f.name} space forecast (pallets and positions)`)
    put(ws, 1, 0, `Now = live on-hand LPs from Datex${f.asOf ? ' as of ' + f.asOf : ''} for rows linked to a Datex project, otherwise the typed value. Raw LPs, shown for reference only; no formula uses it.`)
    put(ws, 2, 0, 'Edit freely: Stack (col C), the monthly pallet cells, zone capacity (zone summary below) and the Scenarios sheet. Positions, zone totals, utilization and flags are formulas.')
    ;['Customer', 'Zone', 'Stack', 'Now (live LPs)', 'Now source'].forEach((h, c) => put(ws, 5, c, h))
    months.forEach((mo, i) => {
      put(ws, 4, 5 + i, i + 1); put(ws, 4, POS0 + i, i + 1)
      put(ws, 5, 5 + i, mo); put(ws, 5, POS0 + i, mo)
    })
    put(ws, 3, 5, 'PALLETS BY MONTH (forecast, editable)'); put(ws, 3, POS0, 'POSITIONS BY MONTH = pallets / stack (formulas)')
    put(ws, 4, 4, 'Month #')

    const pos = f.customers.map((c) => c.fc.map((v) => (c.stack ? v / c.stack : 0)))
    f.customers.forEach((c, ci) => {
      const r = FIRST + ci, row = r + 1
      put(ws, r, 0, c.name); put(ws, r, 1, c.zone); put(ws, r, 2, c.stack); put(ws, r, 3, Math.round(c.now), '#,##0'); put(ws, r, 4, c.src)
      c.fc.forEach((v, i) => {
        put(ws, r, 5 + i, v, '#,##0')
        put(ws, r, POS0 + i, { f: `IF($C${row}=0,0,${L(5 + i)}${row}/$C${row})`, v: pos[ci][i] }, '#,##0.0')
      })
    })

    // zone blocks
    const zones = f.zones
    const zUsed = zones.map((z) => Array.from({ length: NM }, (_, i) => {
      const base = f.customers.reduce((a, c, ci) => a + (c.zone === z.name ? pos[ci][i] : 0), 0)
      return base + ((scenPos[`${f.id}|${z.name}`] || [])[i] || 0)
    }))
    let r = FIRST + Math.max(n, 1) + 2
    const block = (title, head3) => {
      put(ws, r, 0, title)
      r++
      put(ws, r, 0, 'Zone'); put(ws, r, 1, 'Capacity (positions)'); put(ws, r, 2, '95% target'); if (head3) put(ws, r, 3, head3)
      months.forEach((mo, i) => put(ws, r, 5 + i, mo))
      r++
    }
    block('ZONE SUMMARY: used positions (customers + active scenarios)')
    const usedRow = {}, capCell = {}
    zones.forEach((z, zi) => {
      const row = r + 1
      put(ws, r, 0, z.name); put(ws, r, 1, z.capacity, '#,##0'); put(ws, r, 2, { f: `B${row}*${TARGET}`, v: z.capacity * TARGET }, '#,##0')
      usedRow[z.name] = r; capCell[z.name] = `B${row}`
      for (let i = 0; i < NM; i++) {
        const col = L(5 + i), pcol = L(POS0 + i)
        put(ws, r, 5 + i, {
          f: `SUMIF(${zRange},$A${row},${pcol}$${FIRST + 1}:${pcol}$${last})+SUMIFS(Scenarios!$I$2:$I$${SC_MAX},Scenarios!$A$2:$A$${SC_MAX},"${f.name.replace(/"/g, '""')}",Scenarios!$B$2:$B$${SC_MAX},$A${row},Scenarios!$F$2:$F$${SC_MAX},"<="&${col}$5,Scenarios!$G$2:$G$${SC_MAX},">="&${col}$5)`,
          v: zUsed[zi][i],
        }, '#,##0')
      }
      r++
    })
    const totRow = r, trow = r + 1
    put(ws, r, 0, 'All zones')
    const capSum = zones.reduce((a, z) => a + z.capacity, 0)
    if (zones.length) {
      put(ws, r, 1, { f: `SUM(B${trow - zones.length}:B${trow - 1})`, v: capSum }, '#,##0')
      put(ws, r, 2, { f: `B${trow}*${TARGET}`, v: capSum * TARGET }, '#,##0')
      for (let i = 0; i < NM; i++) {
        const col = L(5 + i)
        put(ws, r, 5 + i, { f: `SUM(${col}${trow - zones.length}:${col}${trow - 1})`, v: zUsed.reduce((a, u) => a + u[i], 0) }, '#,##0')
      }
    }
    r += 2

    block('UTILIZATION: used / capacity')
    const allRows = [...zones.map((z) => ({ name: z.name, src: usedRow[z.name], cap: z.capacity, u: zUsed[zones.indexOf(z)] })), { name: 'All zones', src: totRow, cap: capSum, u: Array.from({ length: NM }, (_, i) => zUsed.reduce((a, x) => a + x[i], 0)) }]
    if (zones.length) {
      allRows.forEach((zr) => {
        const srow = zr.src + 1
        put(ws, r, 0, zr.name)
        for (let i = 0; i < NM; i++) {
          const col = L(5 + i)
          put(ws, r, 5 + i, { f: `IF($B${srow}=0,"",${col}${srow}/$B${srow})`, v: zr.cap ? zr.u[i] / zr.cap : '' }, '0%')
        }
        r++
      })
    }
    r++
    block('FLAG: over the 95% target?')
    if (zones.length) {
      allRows.forEach((zr) => {
        const srow = zr.src + 1
        put(ws, r, 0, zr.name)
        for (let i = 0; i < NM; i++) {
          const col = L(5 + i)
          put(ws, r, 5 + i, { f: `IF($B${srow}=0,"",IF(${col}${srow}>$C${srow},IF(${col}${srow}>$B${srow},"OVER CAPACITY","over 95%"),"ok"))`, v: zr.cap ? (zr.u[i] > zr.cap ? 'OVER CAPACITY' : zr.u[i] > zr.cap * TARGET ? 'over 95%' : 'ok') : '' }, undefined)
        }
        r++
      })
    }

    finish(ws, r, POS0 + NM - 1, [34, 20, 18, 14, 12, ...Array(NM).fill(12), ...Array(NM).fill(13)])
    XLSX.utils.book_append_sheet(wb, ws, sheetOf[f.id])

    zones.forEach((z, zi) => {
      summary.push({ fac: f.name, sheet: sn, zone: z.name, cap: z.capacity, row: usedRow[z.name] + 1, u: zUsed[zi] })
    })
  })

  // ---- Summary sheet ----------------------------------------------------------
  const sm = {}
  put(sm, 0, 0, 'Space forecast summary: capacity vs. peak month in the next 12 months (formulas link to the facility sheets)')
  ;['Facility', 'Zone', 'Capacity', '95% target', 'Peak positions', 'Peak month', 'Peak utilization', 'Status'].forEach((h, c) => put(sm, 2, c, h))
  summary.forEach((s, i) => {
    const r = 3 + i, row = r + 1
    const cell = (c) => `${q(s.sheet)}!${c}`
    const peak = Math.max(...s.u)
    const pi = s.u.indexOf(peak)
    put(sm, r, 0, s.fac); put(sm, r, 1, s.zone)
    put(sm, r, 2, { f: cell(`$B$${s.row}`), v: s.cap }, '#,##0')
    put(sm, r, 3, { f: `C${row}*${TARGET}`, v: s.cap * TARGET }, '#,##0')
    put(sm, r, 4, { f: `MAX(${cell(`$F$${s.row}:$Q$${s.row}`)})`, v: peak }, '#,##0')
    put(sm, r, 5, { f: `INDEX(${cell('$F$6:$Q$6')},MATCH(E${row},${cell(`$F$${s.row}:$Q$${s.row}`)},0))`, v: months[pi] || '' })
    put(sm, r, 6, { f: `IF(C${row}=0,"",E${row}/C${row})`, v: s.cap ? peak / s.cap : '' }, '0%')
    put(sm, r, 7, { f: `IF(C${row}=0,"no capacity set",IF(E${row}>C${row},"OVER capacity",IF(E${row}>D${row},"over 95%","OK")))`, v: !s.cap ? 'no capacity set' : peak > s.cap ? 'OVER capacity' : peak > s.cap * TARGET ? 'over 95%' : 'OK' })
  })
  finish(sm, 3 + summary.length, 7, [20, 18, 12, 12, 15, 18, 16, 16])

  wb.SheetNames.unshift('Summary')
  wb.Sheets.Summary = sm
  wb.SheetNames.push('Scenarios')
  wb.Sheets.Scenarios = sc
  // book_append_sheet already added facility sheets in order; reorder: Summary, facilities, Scenarios
  wb.SheetNames = ['Summary', ...facs.map((f) => sheetOf[f.id]), 'Scenarios']
  return wb
}

export function downloadWorkbook(wb, name) {
  XLSX.writeFile(wb, name)
}
