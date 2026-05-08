import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { fetchPickSchedule, upsertPickScheduleRow, insertPickScheduleRow, deletePickScheduleRow } from '../lib/supabase.js'

// ─── Pickline constants ───────────────────────────────────────────────────────
const HRS = 8.0
const PACE = [
  { label: '5–5:59am',   clockStart: 5*60,  pickMins: 50 },
  { label: '6–6:59am',   clockStart: 6*60,  pickMins: 60 },
  { label: '7–7:59am',   clockStart: 7*60,  pickMins: 45 },
  { label: '8–8:59am',   clockStart: 8*60,  pickMins: 60 },
  { label: '9–9:59am',   clockStart: 9*60,  pickMins: 30 },
  { label: '10–10:59am', clockStart: 10*60, pickMins: 60 },
  { label: '11–11:59am', clockStart: 11*60, pickMins: 45 },
  { label: '12–12:59pm', clockStart: 12*60, pickMins: 60 },
  { label: '1–1:30pm',   clockStart: 13*60, pickMins: 30 },
]
const BREAKS = [[7*60, 7*60+15], [9*60, 9*60+30], [11*60+30, 11*60+45]]
const SHIFT_START = 5*60 + 10
const APPT_WINDOW_MINS = 120
const DAYS_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday']

const CREW_PALETTE = [
  { color: '#E3F2FD', border: '#90CAF9' },
  { color: '#E0F7FA', border: '#4DD0E1' },
  { color: '#FFF8E1', border: '#FFD54F' },
  { color: '#FCE4EC', border: '#F48FB1' },
  { color: '#F1F8E9', border: '#AED581' },
  { color: '#EDE7F6', border: '#B39DDB' },
  { color: '#FBE9E7', border: '#FFAB91' },
]

const ROUTE_NAMES = {
  '1':'Sioux Falls','2':'Eau Claire','6':'Eau Claire','13':'Maple Lake',
  '16':'Rochester','19':'Maple Lake','23':'Des Moines','39':'Superior',
  '41':'Oak Creek','45':'Maple Lake','60':'Greenville','63':'Lodi',
  '70':'Superior','74':'Oak Creek','79':'Grand Forks','81':'Maple Lake',
  '82':'Maple Lake','84':'St Paul','85':'St Paul','86':'St Paul','87':'St Paul',
  '90':'Oak Creek','98':'Kansas City','99':'Kansas City','600':'Kewaskum',
  '605':'Des Moines','612':'Greenville','618':'Glendale Hts','621':'Glendale Hts',
  '624':'Glendale Hts','627':'Glendale Hts','630':'Glendale Hts','639':'Kansas City',
  '640':'Mitchell','642':'Glendale Hts','651':'Lodi','661':'Wis Rapids','667':'Kewaskum',
}
const ROUTE_LIVE = new Set(['98','99','639','39','70','16','23','605'])

// ─── Time helpers ─────────────────────────────────────────────────────────────
function minsToDisplay(mins) {
  if (mins == null) return ''
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const ap = h < 12 ? 'am' : 'pm'
  const hd = h % 12 || 12
  return m === 0 ? `${hd}${ap}` : `${hd}:${String(m).padStart(2,'0')}${ap}`
}

function parseDisplayTime(str) {
  if (!str || !str.trim()) return null
  const s = str.trim().toLowerCase()
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const ap = m[3]
  if (ap === 'pm' && h !== 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

// ─── XLSX Parser ──────────────────────────────────────────────────────────────
function sheetToRows(wb, nameHint) {
  const key = Object.keys(wb.Sheets).find(k =>
    k.toLowerCase().includes(nameHint.toLowerCase())
  )
  if (!key) return []
  const XLSX = wb._XLSX
  return XLSX.utils.sheet_to_json(wb.Sheets[key], { defval: '' })
}

function normalizeRouteNum(raw) {
  return String(raw ?? '').trim().replace(/^0+(\d)/, '$1')
}

function normalizeDate(val) {
  if (!val) return ''
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  const s = String(val).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`
  return s
}

const DAYS_OF_WEEK = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
function dateToDow(dateStr) {
  if (!dateStr) return null
  const parts = dateStr.split('-').map(Number)
  if (parts.length < 3 || parts.some(isNaN)) return null
  return DAYS_OF_WEEK[new Date(parts[0], parts[1]-1, parts[2]).getDay()]
}

function parseApptMinutes(val) {
  if (!val) return null
  const n = typeof val === 'number' ? val : parseFloat(String(val))
  if (isNaN(n) || n <= 0) return null
  const mins = Math.round(n / 1e6 / 60)
  if (mins < 0 || mins > 1439) return null
  return mins
}

// Build a lookup map from Supabase schedule: { [day]: { [routeNum]: schedRow } }
function buildScheduleMap(scheduleRows) {
  const map = {}
  for (const row of scheduleRows) {
    const day = row.day_of_week
    const rt  = String(row.route_number)
    if (!map[day]) map[day] = {}
    map[day][rt] = {
      seq:       row.pick_seq,
      name:      row.route_name || null,
      apptStart: row.appt_start_mins ?? null,
      apptEnd:   row.appt_end_mins   ?? null,
      live:      (row.drop_or_live || '').toLowerCase() === 'live',
    }
  }
  return map
}

export function parsePicklineXlsx(wb, scheduleRows = []) {
  const schedMap = buildScheduleMap(scheduleRows)

  // 1. TieHigh
  const skuMap = {}
  for (const row of sheetToRows(wb, 'TieHigh')) {
    const code = String(row['Material Lookup Code'] ?? '').trim()
    if (!code) continue
    const zone = parseInt(String(row['Pickline Zones'] ?? '').replace(/\D/g, ''), 10) || 0
    const fp   = parseInt(String(row['Full Pallet (t x h)'] ?? '0'), 10) || 0
    skuMap[code] = { zone, fullPallet: fp }
  }
  const hasTieHigh = Object.keys(skuMap).length > 0

  // 2. Shortage
  const shortageMap = {}
  for (const row of sheetToRows(wb, 'Shortage')) {
    let dateVal = row['Requested Delivery Date Date'] || row['Pick Up Date'] || row['Date'] || ''
    if (dateVal instanceof Date) dateVal = dateVal.toISOString().slice(0, 10)
    const date    = normalizeDate(String(dateVal))
    const itemNum = String(row['Item Number'] ?? row['Material Lookup Code'] ?? '').trim()
    if (!itemNum) continue
    const avail = Math.max(0, parseInt(String(row['Total Available Cases'] ?? '0'), 10) || 0)
    const key = date || '__any__'
    if (!shortageMap[key]) shortageMap[key] = {}
    shortageMap[key][itemNum] = avail
  }
  const hasShortages = Object.keys(shortageMap).length > 0

  // 3. Cases
  const dateRtSkuOrig  = {}
  const dateRtSkuLines = {}
  for (const row of sheetToRows(wb, 'Cases')) {
    const route   = String(row["Route Number (Bernatello's)"] ?? '').trim()
    const cases   = parseInt(parseFloat(String(row['Packaged Amount Sum'] ?? '0')), 10) || 0
    const matCode = String(row['Material Lookup Code'] ?? '').trim()
    let dateVal   = row['Requested Delivery Date Date']
    if (dateVal instanceof Date) dateVal = dateVal.toISOString().slice(0, 10)
    const date = normalizeDate(String(dateVal ?? ''))
    if (!date || !route || cases <= 0) continue
    const rt = normalizeRouteNum(route)
    if (!dateRtSkuOrig[date])               dateRtSkuOrig[date] = {}
    if (!dateRtSkuOrig[date][rt])           dateRtSkuOrig[date][rt] = {}
    dateRtSkuOrig[date][rt][matCode] = (dateRtSkuOrig[date][rt][matCode] || 0) + cases
    if (!dateRtSkuLines[date])              dateRtSkuLines[date] = {}
    if (!dateRtSkuLines[date][rt])          dateRtSkuLines[date][rt] = {}
    if (!dateRtSkuLines[date][rt][matCode]) dateRtSkuLines[date][rt][matCode] = []
    dateRtSkuLines[date][rt][matCode].push(cases)
  }

  const allDates     = Object.keys(dateRtSkuOrig).sort()
  const snapshotDate = allDates[0] ?? new Date().toISOString().slice(0, 10)

  // 4. Shortages
  const rtSkuShorted = {}
  if (hasShortages) {
    for (const date of allDates) {
      rtSkuShorted[date] = {}
      const rtSkuOrig  = dateRtSkuOrig[date]
      const dow        = dateToDow(date)
      const seqForDay  = (dow && schedMap[dow]) ? schedMap[dow] : {}
      const sortedRts  = Object.keys(rtSkuOrig).sort((a, b) => {
        const sa = seqForDay[a]?.seq ?? null, sb = seqForDay[b]?.seq ?? null
        if (sa !== null && sb !== null) return sa - sb
        if (sa !== null) return -1
        if (sb !== null) return 1
        return parseInt(a, 10) - parseInt(b, 10)
      })
      for (const rt of sortedRts) rtSkuShorted[date][rt] = {}
      const dateShortages = shortageMap[date] ?? shortageMap['__any__'] ?? {}
      for (const [itemNum, available] of Object.entries(dateShortages)) {
        const totalOrdered = sortedRts.reduce((s, rt) => s + (rtSkuOrig[rt][itemNum] || 0), 0)
        if (totalOrdered === 0 || available >= totalOrdered) continue
        let remaining = available
        for (const rt of sortedRts) {
          const ordered = rtSkuOrig[rt][itemNum] || 0
          if (ordered === 0) continue
          const allocated = Math.min(ordered, remaining)
          rtSkuShorted[date][rt][itemNum] = ordered - allocated
          remaining = Math.max(0, remaining - allocated)
        }
      }
    }
  }

  // 5. Route maps
  const dateRouteMaps = {}
  for (const date of allDates) {
    dateRouteMaps[date] = {}
    const rtSkuLines     = dateRtSkuLines[date]
    const rtSkuOrig      = dateRtSkuOrig[date]
    const shortedForDate = rtSkuShorted[date] ?? {}
    for (const rt of Object.keys(rtSkuLines)) {
      const rtShorted = shortedForDate[rt] ?? {}
      const rm = { gross: 0, alloc: 0, net: 0, shorted: 0, z: {} }
      for (const [matCode, lines] of Object.entries(rtSkuLines[rt])) {
        const origTotal    = rtSkuOrig[rt][matCode] || 0
        const shortedTotal = rtShorted[matCode] || 0
        rm.gross += origTotal; rm.shorted += shortedTotal
        if (shortedTotal >= origTotal) continue
        let remainingShortage = shortedTotal
        const adjLines = [...lines].sort((a, b) => b - a).map(c => {
          if (remainingShortage <= 0) return c
          const cut = Math.min(c, remainingShortage); remainingShortage -= cut; return c - cut
        })
        if (hasTieHigh) {
          const sku = skuMap[matCode]
          for (const adjCases of adjLines) {
            if (adjCases <= 0) continue
            if (sku && adjCases >= sku.fullPallet / 2) { rm.alloc += adjCases }
            else { rm.net += adjCases; if (sku && sku.zone > 0) rm.z[sku.zone] = (rm.z[sku.zone] || 0) + adjCases }
          }
        } else { rm.net += origTotal - shortedTotal }
      }
      dateRouteMaps[date][rt] = rm
    }
  }

  // 6. Summarize — use Supabase schedule for seq/name/apptStart/apptEnd/live
  function summarize(routeMap, date) {
    const dow = dateToDow(date)
    const seqForDay = (dow && schedMap[dow]) ? schedMap[dow] : {}
    const routes = Object.keys(routeMap)
      .sort((a, b) => {
        const sa = seqForDay[a]?.seq ?? null, sb = seqForDay[b]?.seq ?? null
        if (sa !== null && sb !== null) return sa - sb
        if (sa !== null) return -1; if (sb !== null) return 1
        return parseInt(a, 10) - parseInt(b, 10)
      })
      .map(rt => {
        const sched = seqForDay[rt]
        return {
          rt, nm: sched?.name ?? ROUTE_NAMES[rt] ?? `Rt ${rt}`,
          cs: routeMap[rt].net, gross: routeMap[rt].gross,
          alloc: routeMap[rt].alloc, shorted: routeMap[rt].shorted,
          ready: sched?.apptStart ?? null, apptEnd: sched?.apptEnd ?? null,
          live: sched?.live ?? ROUTE_LIVE.has(rt), z: routeMap[rt].z,
        }
      })
    return {
      routes,
      net_cs:     routes.reduce((s, r) => s + r.cs,      0),
      alloc_cs:   routes.reduce((s, r) => s + r.alloc,   0),
      shorted_cs: routes.reduce((s, r) => s + r.shorted, 0),
      gross_cs:   routes.reduce((s, r) => s + r.gross,   0),
    }
  }

  const primary    = summarize(dateRouteMaps[snapshotDate] ?? {}, snapshotDate)
  const next_dates = allDates.slice(1).map(date => {
    const s = summarize(dateRouteMaps[date], date)
    return { date, gross_cs: s.gross_cs, alloc_cs: s.alloc_cs, shorted_cs: s.shorted_cs, net_cs: s.net_cs }
  })
  return { snapshot_date: snapshotDate, generated_at: new Date().toISOString(), source: 'manual', ...primary, next_dates }
}

// ─── Omni rows → snapshot (same shape as parsePicklineXlsx output) ─────────────
export function buildSnapshotFromOmni(casesRows, tieHighRows, shortageRows, date, scheduleRows = []) {
  // Build a fake workbook-like structure from the Omni rows and reuse the xlsx parser logic
  // Instead, inline the logic to avoid XLSX dependency in this path

  const schedMap = buildScheduleMap(scheduleRows)

  // TieHigh map: code → { zone, fullPallet }
  const skuMap = {}
  for (const row of tieHighRows) {
    const code = String(row['Material Lookup Code'] ?? '').trim()
    if (!code) continue
    const zone = Number(row['Pickline Zones']) || 0
    const fp   = Number(row['Full Pallet (t x h)']) || 0
    skuMap[code] = { zone, fullPallet: fp }
  }
  const hasTieHigh = Object.keys(skuMap).length > 0

  // Shortage map: { [date]: { [itemNum]: availableCases } }
  const shortageMap = {}
  for (const row of shortageRows) {
    const d       = String(row['Requested Delivery Date Date'] ?? date).slice(0, 10) || '__any__'
    const itemNum = String(row['Item Number'] ?? '').trim()
    if (!itemNum) continue
    const avail = Math.max(0, Number(row['Total Available Cases'] ?? 0))
    if (!shortageMap[d]) shortageMap[d] = {}
    shortageMap[d][itemNum] = avail
  }
  const hasShortages = Object.keys(shortageMap).length > 0

  // Cases accumulation: { [date]: { [rt]: { [matCode]: [caseCount, ...] } } }
  const dateRtSkuOrig  = {}
  const dateRtSkuLines = {}
  for (const row of casesRows) {
    const route   = String(row["Route Number (Bernatello's)"] ?? '').trim()
    const cases   = parseInt(parseFloat(String(row['Packaged Amount Sum'] ?? '0')), 10) || 0
    const matCode = String(row['Material Lookup Code'] ?? '').trim()
    const d       = normalizeDate(String(row['Requested Delivery Date Date'] ?? date))
    if (!d || !route || cases <= 0) continue
    const rt = normalizeRouteNum(route)
    if (!dateRtSkuOrig[d])               dateRtSkuOrig[d] = {}
    if (!dateRtSkuOrig[d][rt])           dateRtSkuOrig[d][rt] = {}
    dateRtSkuOrig[d][rt][matCode] = (dateRtSkuOrig[d][rt][matCode] || 0) + cases
    if (!dateRtSkuLines[d])              dateRtSkuLines[d] = {}
    if (!dateRtSkuLines[d][rt])          dateRtSkuLines[d][rt] = {}
    if (!dateRtSkuLines[d][rt][matCode]) dateRtSkuLines[d][rt][matCode] = []
    dateRtSkuLines[d][rt][matCode].push(cases)
  }

  const allDates     = Object.keys(dateRtSkuOrig).sort()
  const snapshotDate = allDates[0] ?? date

  // Shortage distribution (same logic as xlsx parser)
  const rtSkuShorted = {}
  if (hasShortages) {
    for (const d of allDates) {
      rtSkuShorted[d] = {}
      const rtSkuOrig = dateRtSkuOrig[d]
      const dow       = dateToDow(d)
      const seqForDay = (dow && schedMap[dow]) ? schedMap[dow] : {}
      const sortedRts = Object.keys(rtSkuOrig).sort((a, b) => {
        const sa = seqForDay[a]?.seq ?? null, sb = seqForDay[b]?.seq ?? null
        if (sa !== null && sb !== null) return sa - sb
        if (sa !== null) return -1; if (sb !== null) return 1
        return parseInt(a, 10) - parseInt(b, 10)
      })
      for (const rt of sortedRts) rtSkuShorted[d][rt] = {}
      const dateShortages = shortageMap[d] ?? shortageMap['__any__'] ?? {}
      for (const [itemNum, available] of Object.entries(dateShortages)) {
        const totalOrdered = sortedRts.reduce((s, rt) => s + (rtSkuOrig[rt][itemNum] || 0), 0)
        if (totalOrdered === 0 || available >= totalOrdered) continue
        let remaining = available
        for (const rt of sortedRts) {
          const ordered = rtSkuOrig[rt][itemNum] || 0
          if (ordered === 0) continue
          const allocated = Math.min(ordered, remaining)
          rtSkuShorted[d][rt][itemNum] = ordered - allocated
          remaining = Math.max(0, remaining - allocated)
        }
      }
    }
  }

  // Route maps
  const dateRouteMaps = {}
  for (const d of allDates) {
    dateRouteMaps[d] = {}
    const rtSkuLines     = dateRtSkuLines[d]
    const rtSkuOrig      = dateRtSkuOrig[d]
    const shortedForDate = rtSkuShorted[d] ?? {}
    for (const rt of Object.keys(rtSkuLines)) {
      const rtShorted = shortedForDate[rt] ?? {}
      const rm = { gross: 0, alloc: 0, net: 0, shorted: 0, z: {} }
      for (const [matCode, lines] of Object.entries(rtSkuLines[rt])) {
        const origTotal    = rtSkuOrig[rt][matCode] || 0
        const shortedTotal = rtShorted[matCode] || 0
        rm.gross += origTotal; rm.shorted += shortedTotal
        if (shortedTotal >= origTotal) continue
        let remainingShortage = shortedTotal
        const adjLines = [...lines].sort((a, b) => b - a).map(c => {
          if (remainingShortage <= 0) return c
          const cut = Math.min(c, remainingShortage); remainingShortage -= cut; return c - cut
        })
        if (hasTieHigh) {
          const sku = skuMap[matCode]
          for (const adjCases of adjLines) {
            if (adjCases <= 0) continue
            if (sku && adjCases >= sku.fullPallet / 2) { rm.alloc += adjCases }
            else { rm.net += adjCases; if (sku && sku.zone > 0) rm.z[sku.zone] = (rm.z[sku.zone] || 0) + adjCases }
          }
        } else { rm.net += origTotal - shortedTotal }
      }
      dateRouteMaps[d][rt] = rm
    }
  }

  // Summarize
  function summarize(routeMap, d) {
    const dow = dateToDow(d)
    const seqForDay = (dow && schedMap[dow]) ? schedMap[dow] : {}
    const routes = Object.keys(routeMap)
      .sort((a, b) => {
        const sa = seqForDay[a]?.seq ?? null, sb = seqForDay[b]?.seq ?? null
        if (sa !== null && sb !== null) return sa - sb
        if (sa !== null) return -1; if (sb !== null) return 1
        return parseInt(a, 10) - parseInt(b, 10)
      })
      .map(rt => {
        const sched = seqForDay[rt]
        return {
          rt, nm: sched?.name ?? ROUTE_NAMES[rt] ?? `Rt ${rt}`,
          cs: routeMap[rt].net, gross: routeMap[rt].gross,
          alloc: routeMap[rt].alloc, shorted: routeMap[rt].shorted,
          ready: sched?.apptStart ?? null, apptEnd: sched?.apptEnd ?? null,
          live: sched?.live ?? ROUTE_LIVE.has(rt), z: routeMap[rt].z,
        }
      })
    return {
      routes,
      net_cs:     routes.reduce((s, r) => s + r.cs,      0),
      alloc_cs:   routes.reduce((s, r) => s + r.alloc,   0),
      shorted_cs: routes.reduce((s, r) => s + r.shorted, 0),
      gross_cs:   routes.reduce((s, r) => s + r.gross,   0),
    }
  }

  const primary    = summarize(dateRouteMaps[snapshotDate] ?? {}, snapshotDate)
  const next_dates = allDates.slice(1).map(d => {
    const s = summarize(dateRouteMaps[d], d)
    return { date: d, gross_cs: s.gross_cs, alloc_cs: s.alloc_cs, shorted_cs: s.shorted_cs, net_cs: s.net_cs }
  })
  return { snapshot_date: snapshotDate, generated_at: new Date().toISOString(), source: 'omni', ...primary, next_dates }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(m) {
  let hh = Math.floor(m / 60), mm = Math.round(m % 60)
  if (mm >= 60) { hh++; mm = 0 }
  const ap = hh < 12 ? 'am' : 'pm'
  const h = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh)
  return `${h}:${String(mm).padStart(2, '0')}${ap}`
}

function buildTimeline(pickers, cpmh, targetCases = 0, hourOverrides = {}) {
  const tl = []
  let cum = 0
  for (let idx = 0; idx < PACE.length; idx++) {
    const b = PACE[idx]
    const effPickers = hourOverrides[idx]?.pickers ?? pickers
    const effCpmh    = hourOverrides[idx]?.cpmh    ?? cpmh
    const rate       = (effPickers * effCpmh) / 60
    const bucketEnd  = b.clockStart + (b.clockStart === 13*60 ? 30 : 60)
    for (let t = b.clockStart; t < bucketEnd; t++) {
      const inBreak = t < SHIFT_START || BREAKS.some(([bs, be]) => t >= bs && t < be)
      tl.push({ t, cum, picking: !inBreak, rate })
      if (!inBreak) cum += rate
    }
  }
  const globalRate = (pickers * cpmh) / 60
  let t = 13*60 + 30
  while (cum < targetCases && t < 19*60) { tl.push({ t, cum, picking: true, rate: globalRate }); cum += globalRate; t++ }
  tl.push({ t, cum, picking: false, rate: globalRate })
  return tl
}

function casesToClock(tl, target) {
  for (let i = 0; i < tl.length - 1; i++) {
    const rate = tl[i].rate
    if (tl[i].picking && target >= tl[i].cum && target < tl[i].cum + rate)
      return tl[i].t + (target - tl[i].cum) / rate
  }
  return tl[tl.length - 1].t
}

function pickWindow(tl, cumBefore, cs) {
  const s = casesToClock(tl, cumBefore), e = casesToClock(tl, cumBefore + cs)
  return { start: s, end: e, crossBrk: BREAKS.some(([bs, be]) => s < be && e > bs) }
}

const T_MIN = 0.15
function intensityBg(hex, ratio) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16)
  const t = ratio<=1.0 ? T_MIN+0.35*ratio : ratio<=1.5 ? 0.5+1.5*(ratio-1.0) : ratio-0.25
  return `rgb(${Math.round(255+(r-255)*t)},${Math.round(255+(g-255)*t)},${Math.round(255+(b-255)*t)})`
}

function getZoneDemand(routes) {
  const d = {}
  routes.forEach(r => Object.entries(r.z||{}).forEach(([z,v]) => { d[+z]=(d[+z]||0)+(v||0) }))
  return d
}

function buildCrews(pickers, routes, mode='spread') {
  const ZONE_LOCS={1:4,2:3,3:4,4:4,5:3,6:6,7:3,8:4,9:4,10:4,11:4,12:4}
  const WALK_WEIGHT=50, MAX_LOCS_PER_GROUP=9
  const working=Math.max(1,pickers-1)
  const p=(n)=>n===1?'1 person':`${n} people`
  const zoneDemand=getZoneDemand(routes)
  const adjDemand={}
  for(let z=1;z<=12;z++) adjDemand[z]=(zoneDemand[z]||0)+WALK_WEIGHT*(ZONE_LOCS[z]||0)
  const rawCs=(zones)=>zones.reduce((a,z)=>a+(zoneDemand[z]||0),0)
  const adjCs=(zones)=>zones.reduce((a,z)=>a+adjDemand[z],0)
  const locs=(zones)=>zones.reduce((a,z)=>a+(ZONE_LOCS[z]||0),0)
  const palletCs=rawCs([1,2]),z34Cs=rawCs([3,4]),z34People=Math.min(2,working)
  const z5Cs=zoneDemand[5]||0,z5Assigned=working>z34People?1:0
  const remainZones=[6,7,8,9,10,11,12],remainAdj=adjCs(remainZones)
  let peopleLeft=Math.max(0,working-z34People-z5Assigned)
  const csTarget=peopleLeft>0?remainAdj/peopleLeft:Infinity
  const avgZoneAdj=remainZones.length>0?remainAdj/remainZones.length:0
  const MAX_ZONES_PER_GROUP=mode==='spread'?2:(peopleLeft>0&&avgZoneAdj<csTarget*0.40?3:2)
  const assignThreshold=mode==='spread'?1.50:1.85
  const SOLO_THRESHOLD=1.05,PAIR_CUT_MIN=0.65
  const groups=[]
  const flushGroup=(groupZones,cumAdj,assign)=>{
    assign=Math.min(Math.max(assign,1),2,peopleLeft)
    groups.push({zones:[...groupZones],count:assign,cs:rawCs(groupZones)})
    peopleLeft-=assign
  }
  let cumAdj=0,cumLocs=0,groupZones=[]
  if(peopleLeft>0){
    let i=0
    while(i<remainZones.length&&peopleLeft>0){
      if(peopleLeft===2){
        const rest=remainZones.slice(i),totalAdj=adjCs(rest)
        let bestCut=0,bestScore=Infinity,accAdj=0,accLocs=0
        for(let j=0;j<rest.length-1;j++){
          accAdj+=adjDemand[rest[j]];accLocs+=ZONE_LOCS[rest[j]]||0
          const g2Locs=locs(rest.slice(j+1)),imbalance=Math.abs(2*accAdj-totalAdj)
          const locPenalty=(accLocs>MAX_LOCS_PER_GROUP||g2Locs>MAX_LOCS_PER_GROUP)?1e9:0
          const score=imbalance+locPenalty;if(score<bestScore){bestScore=score;bestCut=j}
        }
        if(bestScore>=1e9){accAdj=0;bestScore=Infinity;for(let j=0;j<rest.length-1;j++){accAdj+=adjDemand[rest[j]];const imbalance=Math.abs(2*accAdj-totalAdj);if(imbalance<bestScore){bestScore=imbalance;bestCut=j}}}
        groups.push({zones:rest.slice(0,bestCut+1),count:1,cs:rawCs(rest.slice(0,bestCut+1))})
        groups.push({zones:rest.slice(bestCut+1),count:1,cs:rawCs(rest.slice(bestCut+1))})
        peopleLeft=0;break
      }
      const z=remainZones[i],zAdj=adjDemand[z],zLocs=ZONE_LOCS[z]||0
      if(groupZones.length>0&&peopleLeft>1&&cumLocs+zLocs>MAX_LOCS_PER_GROUP){
        const assign=(cumAdj>=csTarget*assignThreshold&&peopleLeft>=2)?2:1
        flushGroup(groupZones,cumAdj,assign);groupZones=[];cumAdj=0;cumLocs=0
        if(peopleLeft<=0){const extra=remainZones.slice(i);groups[groups.length-1].zones.push(...extra);groups[groups.length-1].cs+=rawCs(extra);break}
        continue
      }
      groupZones.push(z);cumAdj+=zAdj;cumLocs+=zLocs;i++
      const isLast=i===remainZones.length,nextAdj=!isLast?adjDemand[remainZones[i]]:0,span=groupZones.length
      const singleHeavy=span===1&&cumAdj>=csTarget*SOLO_THRESHOLD
      const pairNatural=span===2&&cumAdj>=csTarget*2*PAIR_CUT_MIN
      const wouldBust=(cumAdj+nextAdj)>csTarget*2*1.05
      const shouldCut=isLast||peopleLeft===1||span>=MAX_ZONES_PER_GROUP||singleHeavy||pairNatural||(wouldBust&&span>=2)
      if(shouldCut){
        const assign=(cumAdj>=csTarget*assignThreshold&&peopleLeft>=2)?2:1
        flushGroup(groupZones,cumAdj,assign);groupZones=[];cumAdj=0;cumLocs=0
        if(peopleLeft<=0){if(i<remainZones.length){const extra=remainZones.slice(i);groups[groups.length-1].zones.push(...extra);groups[groups.length-1].cs+=rawCs(extra)}break}
      }
    }
  }
  const crews=[
    {label:'1 person — pallet/Z2',zones:[1,2],...CREW_PALETTE[0],flex:'covers Z1 + Z2',count:1,cs:palletCs},
    {label:'2 people — Z3–4',zones:[3,4],...CREW_PALETTE[1],flex:'flex ↔ Z2 / Z5',count:z34People,cs:z34Cs},
  ]
  if(z5Assigned) crews.push({label:'1 person — Z5',zones:[5],...CREW_PALETTE[2],flex:'flex ↔ Z4 / Z6',count:1,cs:z5Cs})
  groups.forEach((g,i)=>{
    const zFirst=g.zones[0],zLast=g.zones[g.zones.length-1]
    const zLabel=g.zones.length===1?`Z${zFirst}`:`Z${zFirst}–${zLast}`
    const prevZ=i===0?5:groups[i-1].zones[groups[i-1].zones.length-1]
    const nextZ=i<groups.length-1?groups[i+1].zones[0]:null
    crews.push({label:`${p(g.count)} — ${zLabel}`,zones:g.zones,...CREW_PALETTE[(i+3)%CREW_PALETTE.length],flex:nextZ?`flex ↔ Z${prevZ} / Z${nextZ}`:`flex → Z${prevZ}`,count:g.count,cs:g.cs})
  })
  return crews
}

// ─── Pick Schedule Editor ─────────────────────────────────────────────────────
function TimeCell({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState('')
  const inputRef = useRef(null)

  function startEdit() {
    setDraft(minsToDisplay(value))
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function commit() {
    const parsed = parseDisplayTime(draft)
    if (parsed !== null) onSave(parsed)
    else if (draft.trim() === '') onSave(null)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        style={{ width: 62, fontSize: 11, padding: '1px 3px', border: '1px solid #1565C0', borderRadius: 3 }}
        placeholder="5:30am"
      />
    )
  }
  return (
    <span
      onClick={startEdit}
      style={{ cursor: 'pointer', color: value != null ? '#1565C0' : '#bbb', fontSize: 11,
               borderBottom: '1px dashed #b0c4f0', padding: '0 2px' }}
    >
      {value != null ? minsToDisplay(value) : '—'}
    </span>
  )
}

function TextCell({ value, onSave, width = 90, placeholder = '' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState('')
  const inputRef = useRef(null)

  function startEdit() { setDraft(value || ''); setEditing(true); setTimeout(() => inputRef.current?.select(), 0) }
  function commit() { onSave(draft.trim()); setEditing(false) }

  if (editing) {
    return (
      <input ref={inputRef} value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        style={{ width, fontSize: 11, padding: '1px 3px', border: '1px solid #1565C0', borderRadius: 3 }}
        placeholder={placeholder}
      />
    )
  }
  return (
    <span onClick={startEdit}
      style={{ cursor: 'pointer', color: value ? '#222' : '#bbb', fontSize: 11,
               borderBottom: '1px dashed #ddd', padding: '0 2px', whiteSpace: 'nowrap' }}
    >
      {value || placeholder || '—'}
    </span>
  )
}

function DropLiveCell({ value, onSave }) {
  const isLive = (value || '').toLowerCase() === 'live'
  return (
    <button
      onClick={() => onSave(isLive ? 'Drop' : 'Live')}
      style={{
        fontSize: 10, padding: '1px 6px', borderRadius: 3, cursor: 'pointer', border: 'none',
        background: isLive ? '#C62828' : '#E8F5E9',
        color: isLive ? '#fff' : '#2E7D32', fontWeight: 'bold',
      }}
    >
      {isLive ? '🚛 Live' : 'Drop'}
    </button>
  )
}

function PickScheduleEditor({ scheduleRows, onRowUpdate, onRowAdd, onRowDelete }) {
  const [activeDay, setActiveDay] = useState('Monday')
  const [saving, setSaving]       = useState(null)
  const [addingDay, setAddingDay] = useState(null)
  const [newRow, setNewRow]       = useState({})

  const dayRows = useMemo(() =>
    scheduleRows.filter(r => r.day_of_week === activeDay)
      .sort((a, b) => a.pick_seq - b.pick_seq),
    [scheduleRows, activeDay]
  )

  async function handleUpdate(row, field, value) {
    const updated = { ...row, [field]: value }
    setSaving(row.id)
    await onRowUpdate(updated)
    setSaving(null)
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this route row?')) return
    await onRowDelete(id)
  }

  async function handleAdd() {
    const seq = (dayRows.length ? Math.max(...dayRows.map(r => r.pick_seq)) : 0) + 1
    const row = {
      day_of_week:    activeDay,
      pick_seq:       seq,
      route_number:   parseInt(newRow.route_number) || 0,
      route_name:     newRow.route_name || '',
      description:    newRow.description || '',
      appt_start_mins: parseDisplayTime(newRow.appt_start) ?? null,
      appt_end_mins:   parseDisplayTime(newRow.appt_end) ?? null,
      carrier:        newRow.carrier || '',
      drop_or_live:   newRow.drop_or_live || 'Drop',
    }
    if (!row.route_number) return
    await onRowAdd(row)
    setNewRow({})
    setAddingDay(null)
  }

  const thStyle = { background: '#37474F', color: '#fff', padding: '4px 6px', fontSize: 10,
                    border: '1px solid #546E7A', textAlign: 'center', whiteSpace: 'nowrap' }
  const tdStyle = { border: '1px solid #dde', padding: '3px 5px', fontSize: 11,
                    background: '#fff', textAlign: 'center', verticalAlign: 'middle' }

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 11 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, borderBottom: '2px solid #e0e0e0', paddingBottom: 6 }}>
        {DAYS_ORDER.map(day => (
          <button key={day} onClick={() => setActiveDay(day)}
            style={{
              padding: '4px 14px', fontSize: 11, borderRadius: '4px 4px 0 0', cursor: 'pointer',
              border: '1px solid ' + (activeDay === day ? '#1565C0' : '#ccc'),
              background: activeDay === day ? '#1565C0' : '#f5f5f5',
              color: activeDay === day ? '#fff' : '#555', fontWeight: activeDay === day ? 'bold' : 'normal',
              borderBottom: activeDay === day ? '2px solid #fff' : '1px solid #ccc', marginBottom: -2,
            }}
          >
            {day.slice(0,3)} <span style={{ opacity: 0.7, fontSize: 10 }}>({scheduleRows.filter(r => r.day_of_week === day).length})</span>
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: '#888' }}>{dayRows.length} routes · click any cell to edit · changes save instantly</span>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
          <thead>
            <tr>
              <th style={thStyle}>Seq</th>
              <th style={thStyle}>Route #</th>
              <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 8 }}>Route Name</th>
              <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 8 }}>Description</th>
              <th style={thStyle}>Appt Start</th>
              <th style={thStyle}>Appt End</th>
              <th style={{ ...thStyle, textAlign: 'left', paddingLeft: 8 }}>Carrier</th>
              <th style={thStyle}>Drop / Live</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {dayRows.map((row, i) => (
              <tr key={row.id} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafb' }}>
                <td style={{ ...tdStyle, color: '#888', width: 36 }}>
                  <TextCell value={String(row.pick_seq)} width={32}
                    onSave={v => handleUpdate(row, 'pick_seq', parseInt(v) || row.pick_seq)} />
                </td>
                <td style={{ ...tdStyle, fontWeight: 'bold', width: 60 }}>
                  <TextCell value={String(row.route_number)} width={48}
                    onSave={v => handleUpdate(row, 'route_number', parseInt(v) || row.route_number)} />
                </td>
                <td style={{ ...tdStyle, textAlign: 'left', paddingLeft: 8 }}>
                  <TextCell value={row.route_name} width={110}
                    onSave={v => handleUpdate(row, 'route_name', v)} />
                </td>
                <td style={{ ...tdStyle, textAlign: 'left', paddingLeft: 8 }}>
                  <TextCell value={row.description} width={130}
                    onSave={v => handleUpdate(row, 'description', v)} />
                </td>
                <td style={tdStyle}>
                  <TimeCell value={row.appt_start_mins}
                    onSave={v => handleUpdate(row, 'appt_start_mins', v)} />
                </td>
                <td style={tdStyle}>
                  <TimeCell value={row.appt_end_mins}
                    onSave={v => handleUpdate(row, 'appt_end_mins', v)} />
                </td>
                <td style={{ ...tdStyle, textAlign: 'left', paddingLeft: 8 }}>
                  <TextCell value={row.carrier} width={90}
                    onSave={v => handleUpdate(row, 'carrier', v)} />
                </td>
                <td style={tdStyle}>
                  <DropLiveCell value={row.drop_or_live}
                    onSave={v => handleUpdate(row, 'drop_or_live', v)} />
                </td>
                <td style={{ ...tdStyle, width: 28 }}>
                  {saving === row.id
                    ? <span style={{ color: '#888', fontSize: 9 }}>💾</span>
                    : <button onClick={() => handleDelete(row.id)}
                        style={{ fontSize: 10, padding: '1px 4px', background: 'none', border: '1px solid #ffcdd2',
                                 borderRadius: 3, color: '#C62828', cursor: 'pointer' }}>✕</button>
                  }
                </td>
              </tr>
            ))}
            {addingDay === activeDay ? (
              <tr style={{ background: '#E8F5E9' }}>
                <td style={tdStyle}><span style={{ color: '#888', fontSize: 10 }}>new</span></td>
                <td style={tdStyle}>
                  <input value={newRow.route_number || ''} onChange={e => setNewRow(p => ({...p, route_number: e.target.value}))}
                    placeholder="Rt #" style={{ width: 48, fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }} />
                </td>
                <td style={tdStyle}>
                  <input value={newRow.route_name || ''} onChange={e => setNewRow(p => ({...p, route_name: e.target.value}))}
                    placeholder="Name" style={{ width: 100, fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }} />
                </td>
                <td style={tdStyle}>
                  <input value={newRow.description || ''} onChange={e => setNewRow(p => ({...p, description: e.target.value}))}
                    placeholder="Description" style={{ width: 120, fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }} />
                </td>
                <td style={tdStyle}>
                  <input value={newRow.appt_start || ''} onChange={e => setNewRow(p => ({...p, appt_start: e.target.value}))}
                    placeholder="5:30am" style={{ width: 62, fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }} />
                </td>
                <td style={tdStyle}>
                  <input value={newRow.appt_end || ''} onChange={e => setNewRow(p => ({...p, appt_end: e.target.value}))}
                    placeholder="7:30am" style={{ width: 62, fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }} />
                </td>
                <td style={tdStyle}>
                  <input value={newRow.carrier || ''} onChange={e => setNewRow(p => ({...p, carrier: e.target.value}))}
                    placeholder="Carrier" style={{ width: 80, fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }} />
                </td>
                <td style={tdStyle}>
                  <select value={newRow.drop_or_live || 'Drop'}
                    onChange={e => setNewRow(p => ({...p, drop_or_live: e.target.value}))}
                    style={{ fontSize: 11, padding: '1px 3px', border: '1px solid #a5d6a7', borderRadius: 3 }}>
                    <option>Drop</option><option>Live</option>
                  </select>
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: 3 }}>
                    <button onClick={handleAdd}
                      style={{ fontSize: 10, padding: '2px 6px', background: '#2E7D32', color: '#fff',
                               border: 'none', borderRadius: 3, cursor: 'pointer' }}>Save</button>
                    <button onClick={() => { setAddingDay(null); setNewRow({}) }}
                      style={{ fontSize: 10, padding: '2px 6px', background: '#eee', border: '1px solid #ccc',
                               borderRadius: 3, cursor: 'pointer' }}>✕</button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr>
                <td colSpan={9} style={{ ...tdStyle, background: '#f9f9f9' }}>
                  <button onClick={() => setAddingDay(activeDay)}
                    style={{ fontSize: 11, padding: '3px 12px', background: '#fff', border: '1px dashed #90CAF9',
                             borderRadius: 4, color: '#1565C0', cursor: 'pointer' }}>
                    + Add route to {activeDay}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Upload Area ──────────────────────────────────────────────────────────────
function UploadArea({ onSnapshot, scheduleRows }) {
  const [dragging, setDragging]     = useState(false)
  const [file, setFile]             = useState(null)
  const [parsing, setParsing]       = useState(false)
  const [parseError, setParseError] = useState(null)
  const [omniPulling, setOmniPulling] = useState(false)
  const inputRef = useRef(null)

  function handleFiles(fileList) {
    const f = Array.from(fileList).find(f => /\.(xlsx|xls|csv)$/i.test(f.name))
    if (f) { setFile(f); setParseError(null) }
  }

  async function handleLoad() {
    if (!file) return
    setParsing(true); setParseError(null)
    try {
      const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')
      const buf  = await file.arrayBuffer()
      const wb   = XLSX.read(buf, { type: 'array', cellDates: true })
      wb._XLSX   = XLSX
      const snap = parsePicklineXlsx(wb, scheduleRows)
      if (!snap.routes || snap.routes.length === 0)
        throw new Error('No routes found — check that the Cases sheet has data')
      onSnapshot(snap)
    } catch (err) {
      setParseError(err.message ?? 'Failed to parse file')
    } finally {
      setParsing(false)
    }
  }

  async function handleOmniPull() {
    setOmniPulling(true); setParseError(null)
    try {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const date = tomorrow.toISOString().slice(0, 10)
      const res = await fetch('/.netlify/functions/omni-pickline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `Omni request failed (${res.status})`)
      }
      const { casesRows, tieHighRows, shortageRows } = await res.json()
      const snap = buildSnapshotFromOmni(casesRows, tieHighRows, shortageRows, date, scheduleRows)
      if (!snap.routes || snap.routes.length === 0)
        throw new Error('No routes found in Omni — orders may not be in system yet (try after 4pm)')
      onSnapshot(snap)
    } catch (err) {
      setParseError(err.message ?? 'Omni pull failed')
    } finally {
      setOmniPulling(false)
    }
  }

  return (
    <div style={{ maxWidth: 540, margin: '40px auto', fontFamily: 'Arial, sans-serif' }}>
      {/* Pull from Omni button */}
      <button
        onClick={handleOmniPull}
        disabled={omniPulling}
        style={{
          width: '100%', padding: '13px', fontSize: 14, fontWeight: 'bold',
          background: omniPulling ? '#ccc' : '#2E7D32', color: '#fff',
          border: 'none', borderRadius: 6, cursor: omniPulling ? 'not-allowed' : 'pointer',
          marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}
      >
        {omniPulling
          ? <><span style={{ fontSize: 16 }}>⏳</span> Pulling from Omni…</>
          : <><span style={{ fontSize: 16 }}>⬇</span> Pull from Omni — tomorrow's orders</>
        }
      </button>
      <div style={{ fontSize: 10, color: '#888', textAlign: 'center', marginBottom: 16 }}>
        Queries Bernatello's orders, TieHigh, and Shortages directly · Pick Schedule from in-app table
      </div>

      {/* Divider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1, height: 1, background: '#e0e0e0' }} />
        <span style={{ fontSize: 11, color: '#aaa', whiteSpace: 'nowrap' }}>or upload Excel file</span>
        <div style={{ flex: 1, height: 1, background: '#e0e0e0' }} />
      </div>

      {/* Excel drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? '#1565C0' : file ? '#43a047' : '#b0c4f0'}`,
          borderRadius: 8, padding: '28px 24px', textAlign: 'center',
          background: dragging ? '#e8f0fe' : file ? '#f1f8e9' : '#f5f8ff',
          cursor: 'pointer', marginBottom: 16, transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 6 }}>{file ? '📊' : '📂'}</div>
        {file ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#2e7d32', marginBottom: 4 }}>{file.name}</div>
            <div style={{ fontSize: 11, color: '#888' }}>Click to replace</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, fontWeight: 'bold', color: '#1565C0', marginBottom: 4 }}>Drop the OMNI Excel file here or click to browse</div>
            <div style={{ fontSize: 11, color: '#888' }}>Single .xlsx file — reads Cases, TieHigh, and Shortage sheets</div>
            <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>Pick Schedule is now managed in-app → Pick Schedule tab</div>
          </>
        )}
        <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
        {[
          { label: 'Cases In Created Status', hint: 'Route / SKU / cases ordered', required: true },
          { label: 'TieHigh and Pickline Layout', hint: 'Zone mapping + pallet thresholds', required: false },
          { label: 'Shortage Report', hint: 'Inventory shortfall data', required: false },
          { label: 'Pick Schedule', hint: 'Managed in-app — Pick Schedule tab ✓', required: false, managed: true },
        ].map(({ label, hint, required, managed }) => (
          <div key={label} style={{ padding: '8px 12px', borderRadius: 6, fontSize: 11,
                                    background: managed ? '#f1f8e9' : '#f9f9f9',
                                    border: `1px solid ${managed ? '#a5d6a7' : '#e0e0e0'}` }}>
            <div style={{ fontWeight: 'bold', color: managed ? '#2E7D32' : '#444', marginBottom: 2 }}>
              {label}{required && <span style={{ color: '#c62828', marginLeft: 3 }}>*</span>}
              {managed && <span style={{ marginLeft: 4 }}>✓</span>}
            </div>
            <div style={{ color: '#999' }}>{hint}</div>
          </div>
        ))}
      </div>

      {parseError && (
        <div style={{ background: '#ffebee', border: '1px solid #ef9a9a', borderRadius: 6,
                      padding: '10px 14px', fontSize: 12, color: '#c62828', marginBottom: 14 }}>⚠ {parseError}</div>
      )}

      <button onClick={handleLoad} disabled={!file || parsing}
        style={{ width: '100%', padding: '12px', fontSize: 14, fontWeight: 'bold',
                 background: file ? '#1565C0' : '#ccc', color: '#fff', border: 'none',
                 borderRadius: 6, cursor: file ? 'pointer' : 'not-allowed' }}>
        {parsing ? 'Loading…' : 'Load Pick Brief'}
      </button>
    </div>
  )
}

// ─── Pick Table ───────────────────────────────────────────────────────────────
function PickTable({ pickers, cpmh, tl, netCs, hourOverrides, setHourOverride, routes, crews, crewMode, setCrewMode }) {
  const brkFmt = BREAKS.map(([s,e]) => `${fmt(s)}–${fmt(e)}`).join('  |  ')
  const NUM_LEFT = 7
  const zoneCrewColor={}, zoneCrewBorder={}
  crews.forEach(crew => crew.zones.forEach(z => { zoneCrewColor[z]=crew.color; zoneCrewBorder[z]=crew.border }))

  const paceRows = useMemo(() => {
    let cumPickMins=0, cumCases=0
    const result = PACE.map((b,idx) => {
      const effPickers=hourOverrides[idx]?.pickers??pickers, effCpmh=hourOverrides[idx]?.cpmh??cpmh
      const rate=(effPickers*effCpmh)/60
      cumPickMins+=b.pickMins; const thisCases=Math.round(rate*b.pickMins); cumCases+=thisCases
      return {label:b.label,clockStart:b.clockStart,pickMins:b.pickMins,cumPickMins,cumCases,thisCases,effPickers,effCpmh,idx}
    })
    let cs=13*60+30, coveredAt=-1
    const globalRate=(pickers*cpmh)/60
    while(cs<19*60){
      const pm=cs===13*60+30?30:60, end=cs+pm, lastMin=end-1
      const h1=cs/60|0,m1=cs%60,lh=lastMin/60|0,lm=lastMin%60,ap=lh>=12?'pm':'am'
      const s1=`${h1>12?h1-12:h1}${m1?':'+String(m1).padStart(2,'0'):''}`, s2=`${lh>12?lh-12:lh}:${String(lm).padStart(2,'0')}`
      cumPickMins+=pm; const thisCases=Math.round(globalRate*pm); cumCases+=thisCases
      result.push({label:`${s1}–${s2}${ap}`,clockStart:cs,pickMins:pm,cumPickMins,cumCases,thisCases,effPickers:pickers,effCpmh:cpmh,idx:null})
      cs+=pm; if(coveredAt===-1&&cumCases>=netCs) coveredAt=result.length-1; else if(coveredAt>=0) break
    }
    return result
  }, [pickers, cpmh, netCs, hourOverrides])

  let netDoneRow=-1, cumSoFar=0
  for(let i=0;i<paceRows.length;i++){cumSoFar+=paceRows[i].thisCases;if(netDoneRow===-1&&cumSoFar>=netCs) netDoneRow=i}
  const netDoneTime=netCs>0?fmt(casesToClock(tl,netCs)):null

  const crewHourlyCs = useMemo(() => {
    const result=Array.from({length:PACE.length},()=>new Array(crews.length).fill(0))
    let cum=0
    routes.forEach(row => {
      const {cs,z={}}=row; if(!cs) return
      const {start,end}=pickWindow(tl,cum,cs); const dur=end-start
      crews.forEach((crew,ci) => {
        const crewRouteCs=crew.zones.reduce((a,zone)=>a+(z[zone]||0),0); if(!crewRouteCs) return
        PACE.forEach((pace,pi) => {
          const hEnd=pace.clockStart+(pace.clockStart===13*60?30:60)
          if(dur>0){const overlap=Math.max(0,Math.min(end,hEnd)-Math.max(start,pace.clockStart));result[pi][ci]+=crewRouteCs*overlap/dur}
          else if(start>=pace.clockStart&&start<hEnd) result[pi][ci]+=crewRouteCs
        })
      })
      cum+=cs
    })
    return result.map(row=>row.map(Math.round))
  }, [crews, routes, tl])

  let cumCs=0,seq=0; const zoneTotals={}
  let totalAlloc=0,totalGross=0,totalShorted=0

  const rowEls = routes.map(row => {
    const {rt,nm,cs,z={},ready,apptEnd,live,alloc=0,gross=0,shorted=0}=row
    seq++; const unsched=!cs
    const readyEl=ready!=null?(()=>{
      const h=Math.floor(ready/60),m=ready%60,ap=h<12?'am':'pm',hd=h%12||12
      const readyStr=`${hd}:${String(m).padStart(2,'0')}${ap}`
      return live
        ?<span style={{background:'#C62828',color:'#fff',borderRadius:3,padding:'1px 4px',fontSize:9,fontWeight:'bold',marginLeft:4}}>🚛 {readyStr}</span>
        :<span style={{color:'#888',fontSize:9,marginLeft:4}}>✓{readyStr}</span>
    })():null
    let pwEl=<span style={{color:'#aaa',fontSize:10}}>— UNSCHEDULED —</span>
    let isAmber=false,isLate=false,isCaution=false
    if(!unsched){
      const {start,end,crossBrk}=pickWindow(tl,cumCs,cs)
      isAmber=crossBrk
      const apptDeadline=apptEnd??(ready!=null?ready+APPT_WINDOW_MINS:null)
      if(apptDeadline!=null){isLate=end>apptDeadline-15;isCaution=!isLate&&end>apptDeadline-30}
      const capped=start>=13*60+30-0.01
      const sym=crossBrk?<sup style={{color:'#5C6BC0',fontSize:8}}>ǁǁ</sup>:null
      if(capped) pwEl=<span style={{background:'#111',color:'#fff',borderRadius:3,padding:'1px 6px',fontSize:10,fontWeight:'bold',whiteSpace:'nowrap'}}>{fmt(start)} – {fmt(end)}</span>
      else if(isLate) pwEl=<span style={{background:'#C62828',color:'#fff',fontWeight:'bold',borderRadius:3,padding:'1px 6px',fontSize:10,whiteSpace:'nowrap'}}>{fmt(start)}{sym} – {fmt(end)}<sup style={{fontSize:8,marginLeft:2}}>⚠LATE</sup></span>
      else if(isCaution) pwEl=<span style={{background:'#E65100',color:'#fff',fontWeight:'bold',borderRadius:3,padding:'1px 6px',fontSize:10,whiteSpace:'nowrap'}}>{fmt(start)}{sym} – {fmt(end)}<sup style={{fontSize:8,marginLeft:2}}>⚠CAUTION</sup></span>
      else if(isAmber) pwEl=<span style={{background:'#FFCC02',color:'#333',fontWeight:'bold',borderRadius:3,padding:'1px 4px',fontSize:10,whiteSpace:'nowrap'}}>{fmt(start)}{sym} – {fmt(end)}</span>
      else pwEl=<span style={{color:'#1565C0',fontSize:10,whiteSpace:'nowrap'}}>{fmt(start)} – {fmt(end)}</span>
      cumCs+=cs
    }
    totalAlloc+=alloc;totalGross+=gross;totalShorted+=shorted
    const zSum=Object.values(z).reduce((a,b)=>a+b,0),unalloc=cs&&(cs-zSum)>5?cs-zSum:0
    const csEl=unsched?<span style={{color:'#aaa'}}>—</span>:cs>=300?<span style={{color:'#E65100',fontWeight:'bold'}}>{cs}cs</span>:`${cs}cs`
    const rowBg=unsched?'#f9f9f9':isLate?'#FFEBEE':isCaution?'#FFF3E0':isAmber?'#FFF3CD':seq%2===0?'#f9fafb':'#fff'
    const td=(content,extra={})=><td style={{border:'1px solid #dde',padding:'3px 5px',background:rowBg,fontSize:11,...extra}}>{content}</td>
    return (
      <tr key={`${rt}-${seq}`} title={unalloc>0?`⚠ ${unalloc}cs unallocated to zones`:''}>
        {td(<strong>{rt}</strong>,{textAlign:'center',position:'sticky',left:0,zIndex:1})}
        {td(<span>{nm}{readyEl}{unalloc>0&&<span style={{color:'#999',fontSize:9,marginLeft:4}}>⚠{unalloc}cs</span>}</span>,{textAlign:'left',paddingLeft:6,whiteSpace:'nowrap',position:'sticky',left:43,zIndex:1})}
        {td(<span style={{color:'#555'}}>{gross>0?`${gross}cs`:'—'}</span>,{textAlign:'center'})}
        {td(<span style={{color:'#7B1FA2',fontWeight:'bold'}}>{alloc>0?`${alloc}cs`:'—'}</span>,{textAlign:'center'})}
        {td(<span style={{color:'#C62828',fontWeight:'bold'}}>{shorted>0?`${shorted}cs`:'—'}</span>,{textAlign:'center'})}
        {td(csEl,{textAlign:'center'})}
        {td(pwEl,{whiteSpace:'nowrap',textAlign:'center'})}
        {Array.from({length:12},(_,i)=>{
          const zi=i+1,v=(z&&z[zi])||0
          if(v>0) zoneTotals[zi]=(zoneTotals[zi]||0)+v
          return <td key={zi} style={{border:`1px solid ${zoneCrewBorder[zi]||'#dde'}`,padding:'3px 4px',fontSize:11,textAlign:'center',background:unsched?'#f9f9f9':zoneCrewColor[zi]||rowBg}}>{v||''}</td>
        })}
      </tr>
    )
  })

  const totalCs=routes.reduce((s,r)=>s+(r.cs||0),0)
  const totalBaseCases=paceRows.slice(0,PACE.length).reduce((s,r)=>s+r.thisCases,0)
  const hasOverrides=Object.keys(hourOverrides).length>0
  const thZ={background:'#37474F',color:'#fff',padding:'3px 5px',fontSize:10,border:'1px solid #555',textAlign:'center'}
  const miniBtn={fontSize:9,padding:'0 3px',lineHeight:'14px',minWidth:14,border:'1px solid #bbb',borderRadius:3,background:'#f5f5f5',cursor:'pointer'}
  const redBar={background:'#BF360C',color:'#fff',fontWeight:'bold',fontSize:10,padding:'4px 10px',border:'none'}

  return (
    <div style={{marginBottom:20}}>
      <div style={{background:'#f5f5f5',fontSize:10,color:'#555',padding:'3px 8px'}}>
        ǁǁ = crosses break. Amber = interrupted.{' '}
        <span style={{color:'#E65100',fontWeight:'bold'}}>Orange = 15–30 min to appt.</span>{' '}
        <span style={{color:'#C62828',fontWeight:'bold'}}>Red = within 15 min / past appt.</span>{' '}
        ⚠ = zone incomplete. &nbsp;|&nbsp; Breaks: {brkFmt}
      </div>
      <div style={{overflowX:'auto'}}>
        <table style={{borderCollapse:'collapse',fontSize:11,tableLayout:'fixed',minWidth:900}}>
          <colgroup>
            <col style={{width:42}}/><col style={{width:130}}/>
            <col style={{width:65}}/><col style={{width:65}}/>
            <col style={{width:65}}/><col style={{width:100}}/>
            {Array.from({length:12},(_,i)=><col key={i} style={{width:38}}/>)}
          </colgroup>
          <tbody>
            <tr><td colSpan={NUM_LEFT+12} style={{background:'#1565C0',color:'#fff',fontWeight:'bold',fontSize:11,padding:'5px 8px',border:'1px solid #0d47a1'}}>
              {totalBaseCases.toLocaleString()} cs est. shift capacity
              {hasOverrides?<span style={{fontWeight:'normal',fontSize:10,marginLeft:8,opacity:0.8}}>({Object.keys(hourOverrides).length} hr override{Object.keys(hourOverrides).length>1?'s':''})</span>:<span style={{fontWeight:'normal',fontSize:10,marginLeft:8,opacity:0.8}}>{cpmh} CPMH × {pickers} pkrs</span>}
            </td></tr>
            {netDoneRow===-1&&<tr><td colSpan={NUM_LEFT+12} style={redBar}>⏳ Primary orders extend past schedule — check picker count or CPMH target</td></tr>}
            <tr>
              <th colSpan={2} style={{background:'#1565C0',color:'#fff',padding:'4px 6px',fontSize:10,textAlign:'center',border:'1px solid #0d47a1',whiteSpace:'nowrap'}}>Clock</th>
              <th style={{background:'#1565C0',color:'#fff',padding:'4px 6px',fontSize:10,textAlign:'center',border:'1px solid #0d47a1'}}>Pkrs</th>
              <th style={{background:'#1565C0',color:'#fff',padding:'4px 6px',fontSize:10,textAlign:'center',border:'1px solid #0d47a1'}}>CPMH</th>
              <th style={{background:'#1565C0',color:'#fff',padding:'4px 6px',fontSize:10,textAlign:'center',border:'1px solid #0d47a1',whiteSpace:'pre-line',lineHeight:1.3}}>{'Pick mins\nthis hr'}</th>
              <th style={{background:'#1565C0',color:'#fff',padding:'4px 6px',fontSize:10,textAlign:'center',border:'1px solid #0d47a1',whiteSpace:'pre-line',lineHeight:1.3}}>{'Cases\nthis hr'}</th>
              <th style={{background:'#1565C0',border:'1px solid #0d47a1',width:65}}/>
              {crews.map(crew=>(<th key={crew.zones[0]} colSpan={crew.zones.length} style={{...thZ,background:crew.border,color:'#222',fontSize:9,fontWeight:'bold',whiteSpace:'nowrap'}}>{crew.zones.map(z=>`Z${z}`).join('+')}</th>))}
            </tr>
            {paceRows.map((r,i)=>{
              if(i>=PACE.length&&i>netDoneRow+1) return null
              const isMon=netDoneRow>=0&&i>netDoneRow
              const bg=isMon?(i%2===0?'#fff9e6':'#FFF3CD'):(i%2===0?'#fff':'#e8f5e9')
              const crewRow=i<PACE.length?crewHourlyCs[i]:Array(crews.length).fill(0)
              const pkrsOvr=r.idx!==null&&hourOverrides[r.idx]?.pickers!=null
              const cpmhOvr=r.idx!==null&&hourOverrides[r.idx]?.cpmh!=null
              const divider=netDoneRow>=0&&i===netDoneRow+1?<tr key="div"><td colSpan={NUM_LEFT+12} style={redBar}>✓ Primary orders complete ~{netDoneTime}</td></tr>:null
              return [divider,(
                <tr key={i} style={{background:bg}}>
                  <td colSpan={2} style={{border:'1px solid #dde',padding:'4px 8px',fontWeight:'bold',whiteSpace:'nowrap'}}>{r.label}</td>
                  {r.idx!==null?(<>
                    <td style={{border:'1px solid #dde',padding:'2px 3px',textAlign:'center'}}>
                      <div style={{display:'flex',alignItems:'center',gap:1,justifyContent:'center'}}>
                        <button style={miniBtn} onClick={()=>setHourOverride(r.idx,'pickers',Math.max(1,r.effPickers-1))}>−</button>
                        <span style={{minWidth:14,textAlign:'center',fontWeight:pkrsOvr?'bold':'normal',color:pkrsOvr?'#C62828':'#555'}}>{r.effPickers}</span>
                        <button style={miniBtn} onClick={()=>setHourOverride(r.idx,'pickers',Math.min(16,r.effPickers+1))}>+</button>
                        {pkrsOvr&&<button style={{...miniBtn,color:'#aaa',marginLeft:1}} onClick={()=>setHourOverride(r.idx,'pickers',null)}>×</button>}
                      </div>
</td>
                    <td style={{border:'1px solid #dde',padding:'2px 3px',textAlign:'center'}}>
                      <div style={{display:'flex',alignItems:'center',gap:1,justifyContent:'center'}}>
                        <button style={miniBtn} onClick={()=>setHourOverride(r.idx,'cpmh',Math.max(60,r.effCpmh-5))}>−</button>
                        <span style={{minWidth:24,textAlign:'center',fontWeight:cpmhOvr?'bold':'normal',color:cpmhOvr?'#C62828':'#555'}}>{r.effCpmh}</span>
                        <button style={miniBtn} onClick={()=>setHourOverride(r.idx,'cpmh',Math.min(300,r.effCpmh+5))}>+</button>
                        {cpmhOvr&&<button style={{...miniBtn,color:'#aaa',marginLeft:1}} onClick={()=>setHourOverride(r.idx,'cpmh',null)}>×</button>}
                      </div>
                    </td>
                  </>):(<>
                    <td style={{border:'1px solid #dde',padding:'2px 3px',textAlign:'center',color:'#999',fontSize:10}}>{r.effPickers}</td>
                    <td style={{border:'1px solid #dde',padding:'2px 3px',textAlign:'center',color:'#999',fontSize:10}}>{r.effCpmh}</td>
                  </>)}
                  <td style={{border:'1px solid #dde',padding:'4px 8px',textAlign:'center'}}>{r.pickMins}</td>
                  <td style={{border:'1px solid #dde',padding:'4px 8px',textAlign:'center'}}>{r.thisCases.toLocaleString()}</td>
                  <td style={{border:'1px solid #dde'}}/>
                  {crews.map((crew,ci)=>{
                    const cs=crewRow[ci],capacity=(i<PACE.length&&crew.count>0)?(crew.count*r.effCpmh/60)*r.pickMins:0
                    const ratio=capacity>0?cs/capacity:0
                    return <td key={ci} colSpan={crew.zones.length} style={{border:`1px solid ${crew.border||'#dde'}`,padding:'4px 4px',textAlign:'center',background:cs>0?intensityBg(crew.border,Math.min(ratio,2.0)):bg,color:'#333',fontSize:10}}>{cs||''}</td>
                  })}
                </tr>
              )]
            })}
          </tbody>
          <tbody>
            <tr>
              <td colSpan={NUM_LEFT} style={{background:'#263238',border:'1px solid #555',padding:'4px 6px',position:'sticky',left:0,zIndex:3}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  <span style={{color:'#fff',fontWeight:'bold',fontSize:10}}>CREW POSITIONING</span>
                  <span style={{color:'#90A4AE',fontSize:9}}>column tint = crew zone ownership</span>
                  <div style={{display:'flex',gap:3,marginLeft:'auto'}}>
                    {[['spread','Spread'],['standard','Standard']].map(([m,lbl])=>(
                      <button key={m} onClick={()=>setCrewMode(m)} style={{fontSize:9,padding:'1px 6px',borderRadius:3,cursor:'pointer',border:crewMode===m?'1px solid #90CAF9':'1px solid #546E7A',background:crewMode===m?'#1565C0':'#37474F',color:crewMode===m?'#fff':'#90A4AE',fontWeight:crewMode===m?'bold':'normal'}}>{lbl}</button>
                    ))}
                  </div>
                </div>
              </td>
              {crews.map(crew=>(
                <td key={crew.zones[0]} colSpan={crew.zones.length} style={{background:crew.border,border:'2px solid #555',padding:'4px 6px',textAlign:'center',whiteSpace:'nowrap'}}>
                  <div style={{fontWeight:'bold',fontSize:10,color:'#222'}}>{crew.label}</div>
                  <div style={{fontSize:9,color:'#555',fontStyle:'italic'}}>{crew.flex}</div>
                  {crew.crewCs!=null&&<div style={{marginTop:3,display:'flex',gap:5,flexWrap:'wrap',alignItems:'baseline',justifyContent:'center'}}><span style={{fontWeight:'bold',color:'#1565C0',fontSize:10}}>{crew.crewCs.toLocaleString()}cs</span><span style={{color:'#666',fontSize:9}}>{crew.pct}% of demand</span></div>}
                  {crew.perPerson!=null&&<div style={{fontSize:9,color:crew.heavy?'#B71C1C':crew.light?'#E65100':'#555',fontWeight:crew.heavy?'bold':'normal'}}>~{crew.perPerson.toLocaleString()}cs/person{crew.heavy?' ▲ heavy':crew.light?' ▼ light':''}</div>}
                </td>
              ))}
            </tr>
            <tr>
              <td colSpan={2} style={{background:'#CFD8DC',fontWeight:'bold',padding:'4px 8px',textAlign:'left',border:'1px solid #b0bec5',position:'sticky',left:0,zIndex:2}}>TOTAL</td>
              <td style={{background:'#CFD8DC',fontWeight:'bold',textAlign:'center',border:'1px solid #b0bec5',color:'#555'}}>{totalGross.toLocaleString()}cs</td>
              <td style={{background:'#CFD8DC',fontWeight:'bold',textAlign:'center',border:'1px solid #b0bec5',color:'#7B1FA2'}}>{totalAlloc>0?`${totalAlloc.toLocaleString()}cs`:'—'}</td>
              <td style={{background:'#CFD8DC',fontWeight:'bold',textAlign:'center',border:'1px solid #b0bec5',color:'#C62828'}}>{totalShorted>0?`${totalShorted.toLocaleString()}cs`:'—'}</td>
              <td style={{background:'#CFD8DC',fontWeight:'bold',textAlign:'center',border:'1px solid #b0bec5'}}>{totalCs.toLocaleString()}cs</td>
              <td style={{background:'#CFD8DC',border:'1px solid #b0bec5'}}/>
              {Array.from({length:12},(_,i)=>(<td key={i} style={{background:zoneCrewColor[i+1]||'#CFD8DC',fontWeight:'bold',textAlign:'center',border:`1px solid ${zoneCrewBorder[i+1]||'#b0bec5'}`,fontSize:11}}>{zoneTotals[i+1]||''}</td>))}
            </tr>
            <tr>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'center',position:'sticky',left:0,zIndex:2}}>Route</th>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'left',position:'sticky',left:43,zIndex:2}}>Route Name</th>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'center'}}>Gross</th>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'center'}}>Alloc Pull</th>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'center'}}>Shorted</th>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'center'}}>NET Cases</th>
              <th style={{background:'#37474F',color:'#fff',padding:'4px 6px',border:'1px solid #555',fontSize:11,whiteSpace:'nowrap',textAlign:'center'}}>Pick Window</th>
              {Array.from({length:12},(_,i)=>{const zi=i+1;return <th key={zi} style={{...thZ,background:zoneCrewBorder[zi]||'#37474F',color:'#333'}}>Z{zi}</th>})}
            </tr>
          </tbody>
          <tbody>{rowEls}</tbody>
        </table>
      </div>
    </div>
  )
}

// ─── PicklinePanel ────────────────────────────────────────────────────────────
export default function PicklinePanel({ snapshot, hourOverrides, onSnapshot, onOverridesChange, onClear }) {
  const [pickers,       setPickers]       = useState(9)
  const [cpmh,          setCpmh]          = useState(150)
  const [crewMode,      setCrewMode]      = useState('spread')
  const [wrTab,         setWrTab]         = useState('brief')  // 'brief' | 'schedule'
  const [scheduleRows,  setScheduleRows]  = useState([])
  const [schedLoading,  setSchedLoading]  = useState(true)

  useEffect(() => {
    fetchPickSchedule().then(rows => {
      setScheduleRows(rows)
      setSchedLoading(false)
    })
  }, [])

  const handleRowUpdate = useCallback(async (updated) => {
    const saved = await upsertPickScheduleRow(updated)
    if (saved) {
      setScheduleRows(prev => prev.map(r => r.id === saved.id ? saved : r))
    }
  }, [])

  const handleRowAdd = useCallback(async (row) => {
    const saved = await insertPickScheduleRow(row)
    if (saved) {
      setScheduleRows(prev => [...prev, saved].sort((a, b) =>
        DAYS_ORDER.indexOf(a.day_of_week) - DAYS_ORDER.indexOf(b.day_of_week) || a.pick_seq - b.pick_seq
      ))
    }
  }, [])

  const handleRowDelete = useCallback(async (id) => {
    await deletePickScheduleRow(id)
    setScheduleRows(prev => prev.filter(r => r.id !== id))
  }, [])

  function setHourOverride(idx, field, value) {
    onOverridesChange(prev => {
      const curr = prev[idx] || {}
      if (value === null) {
        const { [field]: _, ...rest } = curr
        const next = { ...prev }
        if (Object.keys(rest).length) next[idx] = rest; else delete next[idx]
        return next
      }
      return { ...prev, [idx]: { ...curr, [field]: value } }
    })
  }

  const routes    = snapshot?.routes      ?? []
  const netCs     = snapshot?.net_cs      ?? 0
  const grossCs   = snapshot?.gross_cs    ?? 0
  const allocCs   = snapshot?.alloc_cs    ?? 0
  const shortedCs = snapshot?.shorted_cs  ?? 0
  const snapDate  = snapshot?.snapshot_date ?? null
  const nextDates = snapshot?.next_dates  ?? []

  const tl    = useMemo(() => buildTimeline(pickers, cpmh, netCs, hourOverrides), [pickers, cpmh, netCs, hourOverrides])
  const crews = useMemo(() => buildCrews(pickers, routes, crewMode), [pickers, routes, crewMode])

  const enrichedCrews = useMemo(() => {
    const zoneTotals = {}
    routes.forEach(r => Object.entries(r.z||{}).forEach(([z,v]) => { zoneTotals[+z]=(zoneTotals[+z]||0)+(v||0) }))
    const totalMapped=Object.values(zoneTotals).reduce((a,b)=>a+b,0)
    const avgPerPicker=pickers>1?totalMapped/(pickers-1):totalMapped
    return crews.map(crew => {
      const crewCs=crew.zones.reduce((a,z)=>a+(zoneTotals[z]||0),0)
      const pct=totalMapped>0?Math.round(crewCs/totalMapped*100):0
      const perPerson=crew.count>0?Math.round(crewCs/crew.count):null
      return {...crew,crewCs,pct,perPerson,heavy:perPerson!==null&&perPerson>avgPerPicker*1.3,light:perPerson!==null&&perPerson<avgPerPicker*0.7}
    })
  }, [crews, routes, pickers])

  const target      = Math.round(cpmh * pickers * HRS)
  const netDoneTime = useMemo(() => netCs>0?fmt(casesToClock(tl,netCs)):null, [tl, netCs])
  const totalCap    = tl[tl.length-1].cum
  const cumAt130pm  = (tl.find(e=>e.t>=13*60+30)??tl[tl.length-1]).cum
  const monCs       = nextDates[0]?.net_cs ?? 0
  const monPickable = Math.min(Math.max(0,cumAt130pm-netCs),monCs)
  const fmtDate     = d => new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})
  const dateLabel   = snapDate ? fmtDate(snapDate) : '—'
  const btnStyle    = (disabled) => ({width:32,height:32,border:'1px solid #1565C0',borderRadius:5,background:'#fff',color:'#1565C0',fontSize:20,cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.3:1,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'})

  const tabBtn = (id, label) => (
    <button
      key={id}
      onClick={() => setWrTab(id)}
      style={{
        padding: '5px 16px', fontSize: 12, cursor: 'pointer',
        borderRadius: '4px 4px 0 0',
        border: '1px solid ' + (wrTab === id ? '#1565C0' : '#ccc'),
        borderBottom: wrTab === id ? '2px solid #fff' : '1px solid #ccc',
        background: wrTab === id ? '#fff' : '#f0f4ff',
        color: wrTab === id ? '#1565C0' : '#666',
        fontWeight: wrTab === id ? 'bold' : 'normal',
        marginBottom: -1,
      }}
    >{label}</button>
  )

  return (
    <div style={{fontFamily:'Arial, sans-serif',fontSize:11}}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ccc',
                    marginBottom: 0, paddingTop: 4, paddingLeft: 2, background: '#f5f8ff' }}>
        {tabBtn('brief',  snapshot ? `📋 Pick Brief — ${dateLabel}` : '📋 Pick Brief')}
        {tabBtn('schedule', schedLoading ? '📅 Pick Schedule…' : `📅 Pick Schedule (${scheduleRows.length})`)}
      </div>

      {wrTab === 'brief' && (
        <div>
          {!snapshot ? (
            <UploadArea onSnapshot={onSnapshot} scheduleRows={scheduleRows} />
          ) : (
            <div>
              <div style={{background:'#1565C0',color:'#fff',padding:'8px 14px',fontSize:14,fontWeight:'bold',
                           display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span>CSW Pick Line — {dateLabel} Brief{snapshot.source === 'omni' ? ' · via Omni' : ''}</span>
                <button onClick={onClear} style={{fontSize:11,padding:'3px 10px',background:'rgba(255,255,255,0.15)',
                         border:'1px solid rgba(255,255,255,0.3)',borderRadius:4,color:'#fff',cursor:'pointer'}}>
                  ↑ Load new file
                </button>
              </div>

              <div style={{background:'#E8F5E9',border:'1px solid #A5D6A7',padding:'4px 10px',fontSize:10,
                           color:'#2E7D32',marginBottom:8,display:'flex',flexDirection:'column',gap:3}}>
                <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                  <span style={{fontWeight:'bold',color:'#1B5E20',minWidth:90}}>{dateLabel}</span>
                  <span>📦 Gross: <strong>{grossCs.toLocaleString()}cs</strong></span>
                  <span>↩ Alloc pull: <strong>{allocCs.toLocaleString()}cs</strong></span>
                  {shortedCs>0&&<span>⚠ Shorted: <strong style={{color:'#C62828'}}>{shortedCs.toLocaleString()}cs</strong></span>}
                  <span>✅ NET pick line: <strong>{netCs.toLocaleString()}cs</strong></span>
                </div>
                {nextDates.map(nd=>(
                  <div key={nd.date} style={{display:'flex',gap:16,flexWrap:'wrap',opacity:0.8}}>
                    <span style={{fontWeight:'bold',color:'#1B5E20',minWidth:90}}>{fmtDate(nd.date)}</span>
                    <span>📦 Gross: <strong>{nd.gross_cs.toLocaleString()}cs</strong></span>
                    <span>↩ Alloc pull: <strong>{nd.alloc_cs.toLocaleString()}cs</strong></span>
                    {(nd.shorted_cs??0)>0&&<span>⚠ Shorted: <strong style={{color:'#C62828'}}>{nd.shorted_cs.toLocaleString()}cs</strong></span>}
                    <span>✅ NET pick line: <strong>{nd.net_cs.toLocaleString()}cs</strong></span>
                  </div>
                ))}
              </div>

              <div style={{background:'#f0f4ff',border:'1px solid #b0c4f0',borderRadius:6,padding:'10px 14px',
                           display:'flex',alignItems:'center',gap:12,marginBottom:10,flexWrap:'wrap'}}>
                <div style={{display:'flex',flexDirection:'column',gap:10}}>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{fontSize:13,fontWeight:'bold',color:'#1565C0',minWidth:120}}>Pickers Available</div>
                    <button style={btnStyle(pickers<=1)} onClick={()=>pickers>1&&setPickers(p=>p-1)}>−</button>
                    <span style={{fontSize:28,fontWeight:'bold',color:'#1565C0',minWidth:28,textAlign:'center'}}>{pickers}</span>
                    <button style={btnStyle(pickers>=20)} onClick={()=>pickers<20&&setPickers(p=>p+1)}>+</button>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{fontSize:13,fontWeight:'bold',color:'#1565C0',minWidth:120}}>CPMH Target</div>
                    <button style={btnStyle(cpmh<=60)} onClick={()=>cpmh>60&&setCpmh(c=>c-5)}>−</button>
                    <span style={{fontSize:28,fontWeight:'bold',color:'#1565C0',minWidth:28,textAlign:'center'}}>{cpmh}</span>
                    <button style={btnStyle(cpmh>=300)} onClick={()=>cpmh<300&&setCpmh(c=>c+5)}>+</button>
                    <input type="range" min={60} max={300} step={5} value={cpmh}
                      onChange={e=>setCpmh(Number(e.target.value))} style={{width:140,accentColor:'#1565C0'}}/>
                  </div>
                </div>
                <div style={{fontSize:12,color:'#444',lineHeight:2.0}}>
                  <div>Shift capacity: <strong>{target.toLocaleString()} cs</strong></div>
                  <div>Primary complete est: <strong>~{netDoneTime}</strong></div>
                  <div>Pre-pick: <strong style={{color:totalCap>=netCs?'#6A1B9A':'#C62828'}}>
                    {totalCap>=netCs?`~${monPickable.toLocaleString()}cs available${nextDates[0]?` → ${fmtDate(nextDates[0].date)}`:''}`:`${(netCs-totalCap).toLocaleString()}cs SHORT`}
                  </strong></div>
                </div>
              </div>

              <PickTable pickers={pickers} cpmh={cpmh} tl={tl} netCs={netCs}
                hourOverrides={hourOverrides} setHourOverride={setHourOverride}
                routes={routes} crews={enrichedCrews} crewMode={crewMode} setCrewMode={setCrewMode}/>

              <div style={{background:'#ECEFF1',padding:'6px 10px',fontSize:9,color:'#78909C',borderTop:'1px solid #CFD8DC'}}>
                Zone heat map: ≥10%=yellow · ≥20%=amber · ≥30%=orange · ≥40%=red. Pick windows estimated from CPMH pace; actual may vary.
              </div>
            </div>
          )}
        </div>
      )}

      {wrTab === 'schedule' && (
        <div style={{ padding: '12px 4px' }}>
          {schedLoading ? (
            <div style={{ textAlign: 'center', color: '#888', padding: 40 }}>Loading schedule…</div>
          ) : (
            <PickScheduleEditor
              scheduleRows={scheduleRows}
              onRowUpdate={handleRowUpdate}
              onRowAdd={handleRowAdd}
              onRowDelete={handleRowDelete}
            />
          )}
        </div>
      )}
    </div>
  )
}
