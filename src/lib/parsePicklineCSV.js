/**
 * parsePicklineCSV
 *
 * Pure CSV parser for Bernatello's Omni pick order exports.
 * Ported from CSW-Pickline/src/parseOmniCSV.js — no Supabase, no network.
 * Used by PicklinePanel inside the Labor Planning app.
 */

const COL_ROUTE = "Route Number (Bernatello's)"
const COL_CASES = 'Packaged Amount Sum'
const COL_DATE  = 'Requested Delivery Date Date'
const ROUTE_NAME_COL_CANDIDATES = ["Route Name (Bernatello's)", 'Route Name', 'Route Description', 'Route']
const COL_TH_CODE = 'Material Lookup Code'
const COL_TH_ZONE = 'Pickline Zones'
const COL_TH_FP   = 'Full Pallet (t x h)'
const MATERIAL_COL_CANDIDATES = ['Material Lookup Code', 'Material', 'Material Number', 'SKU', 'Item']
const SHORT_AVAIL_COL = 'Total Available Cases'
const SHORT_DATE_CANDIDATES = ['Pick Up Date', 'Pickup Date', 'Requested Delivery Date Date', 'Date']
const SHORT_MAT_CANDIDATES  = ['Item Number', 'Material Lookup Code', 'Material', 'Material Number', 'SKU', 'Item']

function getMatCode(row) {
  for (const col of MATERIAL_COL_CANDIDATES) {
    const val = String(row[col] ?? '').trim()
    if (val) return val
  }
  return ''
}

function getShortageMatCode(row) {
  for (const col of SHORT_MAT_CANDIDATES) {
    const val = String(row[col] ?? '').trim()
    if (val) return val
  }
  return ''
}

const ROUTE_NAMES = {
  '1':'Sioux Falls','2':'Eau Claire','6':'Eau Claire','8':'Unknown','13':'Maple Lake',
  '16':'Rochester','19':'Maple Lake','21':'Unknown','23':'Des Moines','25':'Unknown',
  '39':'Superior','41':'Oak Creek','45':'Maple Lake','51':'Unknown','60':'Greenville',
  '63':'Lodi','70':'Superior','74':'Oak Creek','79':'Grand Forks','81':'Maple Lake',
  '82':'Maple Lake','84':'St Paul','85':'St Paul','86':'St Paul','87':'St Paul',
  '90':'Oak Creek','95':'Unknown','98':'Kansas City','99':'Kansas City','600':'Kewaskum',
  '605':'Des Moines','611':'Unknown','612':'Greenville','618':'Glendale Hts','621':'Glendale Hts',
  '624':'Glendale Hts','627':'Glendale Hts','630':'Glendale Hts','639':'Kansas City',
  '640':'Mitchell','642':'Glendale Hts','651':'Lodi','661':'Wis Rapids','667':'Kewaskum',
}
const ROUTE_READY = {
  '84':330,'85':330,'86':330,'87':330,'13':360,'19':360,'45':360,'81':360,'82':360,
  '60':390,'612':390,'600':420,'667':420,'63':435,'651':435,'1':510,'640':510,'79':540,
  '661':600,'2':630,'6':630,'98':660,'99':660,'639':660,'618':690,'621':690,'624':690,
  '627':690,'630':690,'642':690,'41':720,'74':720,'90':720,'39':750,'70':750,'16':780,
  '23':840,'605':840,
}
const ROUTE_LIVE = new Set(['98','99','639','39','70','16','23','605'])

const DAYS_OF_WEEK = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

function dateToDow(dateStr) {
  if (!dateStr) return null
  const parts = String(dateStr).split('-').map(Number)
  if (parts.length < 3 || parts.some(isNaN)) return null
  return DAYS_OF_WEEK[new Date(parts[0], parts[1] - 1, parts[2]).getDay()]
}

function normalizeDate(val) {
  if (!val && val !== 0) return ''
  if (val instanceof Date) return val.toISOString().split('T')[0]
  if (typeof val === 'number') {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000))
    return d.toISOString().split('T')[0]
  }
  const s = String(val).trim()
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`
  return s
}

function buildDaySeqMap(pickSeqRows) {
  const map = {}
  for (const row of pickSeqRows) {
    const rt   = String(row['Route Number'] ?? '').trim().replace(/^0+(\d)/, '$1')
    const day  = String(row['Day Of Week']  ?? '').trim()
    const seq  = parseInt(String(row['Pick Seq'] ?? ''), 10)
    const name = String(row['Route Name']   ?? '').trim()
    if (!rt || !day || isNaN(seq)) continue
    if (!map[day]) map[day] = {}
    map[day][rt] = { seq, name: name || null }
  }
  return map
}

function buildShortageMap(shortageRows) {
  const map = {}
  for (const row of shortageRows) {
    const matCode = getShortageMatCode(row)
    if (!matCode) continue
    let date = ''
    for (const col of SHORT_DATE_CANDIDATES) {
      const val = row[col]
      if (val !== undefined && val !== '') { date = normalizeDate(val); break }
    }
    const rawAvail = parseFloat(String(row[SHORT_AVAIL_COL] ?? ''))
    const available = isNaN(rawAvail) ? 0 : Math.max(0, Math.floor(rawAvail))
    const key = date || '__any__'
    if (!map[key]) map[key] = {}
    map[key][matCode] = available
  }
  return map
}

function csvToRows(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) throw new Error('CSV has no data rows')
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map(line => {
    const values = []
    let current = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue }
      if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue }
      current += ch
    }
    values.push(current.trim())
    const row = {}
    headers.forEach((h, i) => { row[h] = values[i] ?? '' })
    return row
  }).filter(row => Object.values(row).some(v => v !== ''))
}

function buildSnapshotFromRows(casesRows, tieHighRows, source, pickSeqRows = [], shortageRows = []) {
  const daySeqMap = buildDaySeqMap(pickSeqRows)
  const skuMap = {}
  for (const row of tieHighRows) {
    const code = String(row[COL_TH_CODE] ?? '').trim()
    if (!code) continue
    const fp   = parseInt(String(row[COL_TH_FP]   ?? '0'), 10) || 0
    const zone = parseInt(String(row[COL_TH_ZONE] ?? '').replace(/\D/g, ''), 10) || 0
    skuMap[code] = { zone, fullPallet: fp }
  }
  const hasTieHigh = Object.keys(skuMap).length > 0
  const shortageMap = buildShortageMap(shortageRows)
  const hasShortages = Object.keys(shortageMap).length > 0

  const dateRtSkuOrig  = {}
  const dateRtSkuLines = {}
  const routeNameFromCsv = {}

  for (const row of casesRows) {
    const route   = String(row[COL_ROUTE] ?? '').trim()
    const cases   = parseInt(parseFloat(String(row[COL_CASES] ?? '0')), 10) || 0
    const date    = normalizeDate(row[COL_DATE])
    const matCode = getMatCode(row)
    if (!date || !route) continue
    const rt = route.replace(/^0+(\d)/, '$1')
    if (!dateRtSkuOrig[date]) dateRtSkuOrig[date] = {}
    if (!dateRtSkuOrig[date][rt]) dateRtSkuOrig[date][rt] = {}
    dateRtSkuOrig[date][rt][matCode] = (dateRtSkuOrig[date][rt][matCode] || 0) + cases
    if (!dateRtSkuLines[date]) dateRtSkuLines[date] = {}
    if (!dateRtSkuLines[date][rt]) dateRtSkuLines[date][rt] = {}
    if (!dateRtSkuLines[date][rt][matCode]) dateRtSkuLines[date][rt][matCode] = []
    dateRtSkuLines[date][rt][matCode].push(cases)
    if (!routeNameFromCsv[rt]) {
      for (const col of ROUTE_NAME_COL_CANDIDATES) {
        const val = String(row[col] ?? '').trim()
        if (val) { routeNameFromCsv[rt] = val; break }
      }
    }
  }

  const allDates = Object.keys(dateRtSkuOrig).sort()
  const snapshotDate = allDates[0] ?? null

  const rtSkuShorted = {}
  if (hasShortages) {
    for (const date of allDates) {
      rtSkuShorted[date] = {}
      const rtSkuOrig = dateRtSkuOrig[date]
      const dow       = dateToDow(date)
      const seqForDay = (dow && daySeqMap[dow]) ? daySeqMap[dow] : {}
      const sortedRoutes = Object.keys(rtSkuOrig).sort((a, b) => {
        const sa = seqForDay[a]?.seq ?? null, sb = seqForDay[b]?.seq ?? null
        if (sa !== null && sb !== null) return sa - sb
        if (sa !== null) return -1
        if (sb !== null) return 1
        return parseInt(a, 10) - parseInt(b, 10)
      })
      for (const rt of sortedRoutes) rtSkuShorted[date][rt] = {}
      const dateShortages = shortageMap[date] ?? shortageMap['__any__'] ?? {}
      for (const [matCode, available] of Object.entries(dateShortages)) {
        const totalOrdered = sortedRoutes.reduce((s, rt) => s + (rtSkuOrig[rt][matCode] || 0), 0)
        if (totalOrdered === 0 || available >= totalOrdered) continue
        let remaining = available
        for (const rt of sortedRoutes) {
          const ordered = rtSkuOrig[rt][matCode] || 0
          if (ordered === 0) continue
          const allocated = Math.min(ordered, remaining)
          rtSkuShorted[date][rt][matCode] = ordered - allocated
          remaining = Math.max(0, remaining - allocated)
        }
      }
    }
  }

  const dateRouteMaps = {}
  for (const date of allDates) {
    dateRouteMaps[date] = {}
    const rtSkuLines     = dateRtSkuLines[date]
    const rtSkuOrig      = dateRtSkuOrig[date]
    const shortedForDate = rtSkuShorted[date] ?? {}
    for (const rt of Object.keys(rtSkuLines)) {
      const rtShorted = shortedForDate[rt] ?? {}
      const rm = { gross: 0, alloc: 0, pallets: 0, net: 0, shorted: 0, z: {} }
      for (const [matCode, lines] of Object.entries(rtSkuLines[rt])) {
        const origTotal    = rtSkuOrig[rt][matCode] || 0
        const shortedTotal = rtShorted[matCode] || 0
        rm.gross   += origTotal
        rm.shorted += shortedTotal
        if (shortedTotal >= origTotal) continue
        let remainingShortage = shortedTotal
        const adjLines = [...lines].sort((a, b) => b - a).map(c => {
          if (remainingShortage <= 0) return c
          const cut = Math.min(c, remainingShortage)
          remainingShortage -= cut
          return c - cut
        })
        if (hasTieHigh) {
          const sku = skuMap[matCode]
          for (const adjCases of adjLines) {
            if (adjCases <= 0) continue
            if (sku && adjCases >= sku.fullPallet / 2) {
              rm.alloc += adjCases
              rm.pallets += 1
            } else {
              rm.net += adjCases
              if (sku && sku.zone > 0) rm.z[sku.zone] = (rm.z[sku.zone] || 0) + adjCases
            }
          }
        } else {
          rm.net += origTotal - shortedTotal
        }
      }
      dateRouteMaps[date][rt] = rm
    }
  }

  function summarizeRouteMap(routeMap, date) {
    const dow       = dateToDow(date)
    const seqForDay = (dow && daySeqMap[dow]) ? daySeqMap[dow] : {}
    const routes = Object.keys(routeMap)
      .sort((a, b) => {
        const sa = seqForDay[a]?.seq ?? null, sb = seqForDay[b]?.seq ?? null
        if (sa !== null && sb !== null) return sa - sb
        if (sa !== null) return -1
        if (sb !== null) return 1
        return parseInt(a, 10) - parseInt(b, 10)
      })
      .map(rt => ({
        rt,
        nm: seqForDay[rt]?.name ?? routeNameFromCsv[rt] ?? ROUTE_NAMES[rt] ?? `Rt ${rt}`,
        cs:      routeMap[rt].net,
        gross:   routeMap[rt].gross,
        alloc:   routeMap[rt].alloc,
        shorted: routeMap[rt].shorted,
        pallets: routeMap[rt].pallets,
        ready:   ROUTE_READY[rt] ?? null,
        live:    ROUTE_LIVE.has(rt),
        z:       routeMap[rt].z,
      }))
    return {
      routes,
      net_cs:     routes.reduce((s, r) => s + r.cs,      0),
      alloc_cs:   routes.reduce((s, r) => s + r.alloc,   0),
      shorted_cs: routes.reduce((s, r) => s + r.shorted, 0),
      gross_cs:   routes.reduce((s, r) => s + r.gross,   0),
    }
  }

  const primary    = summarizeRouteMap(dateRouteMaps[snapshotDate] ?? {}, snapshotDate)
  const next_dates = allDates.slice(1).map(date => {
    const s = summarizeRouteMap(dateRouteMaps[date], date)
    return { date, gross_cs: s.gross_cs, alloc_cs: s.alloc_cs, shorted_cs: s.shorted_cs, net_cs: s.net_cs }
  })

  return {
    snapshot_date: snapshotDate ?? new Date().toISOString().slice(0, 10),
    generated_at:  new Date().toISOString(),
    source,
    gross_cs:   primary.gross_cs,
    alloc_cs:   primary.alloc_cs,
    shorted_cs: primary.shorted_cs,
    net_cs:     primary.net_cs,
    routes:     primary.routes,
    next_dates,
  }
}

export function parsePicklineCSV(
  csvText,
  source = 'manual',
  tieHighCsvText = null,
  pickSeqCsvText = null,
  shortageCsvText = null,
) {
  const casesRows    = csvToRows(csvText)
  const tieHighRows  = tieHighCsvText  ? csvToRows(tieHighCsvText)  : []
  const pickSeqRows  = pickSeqCsvText  ? csvToRows(pickSeqCsvText)  : []
  const shortageRows = shortageCsvText ? csvToRows(shortageCsvText) : []
  return buildSnapshotFromRows(casesRows, tieHighRows, source, pickSeqRows, shortageRows)
}
