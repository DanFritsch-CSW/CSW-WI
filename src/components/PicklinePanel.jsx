import { useState, useMemo, useRef, useCallback } from 'react'
import { parsePicklineCSV } from '../lib/parsePicklineCSV.js'

// ─── Pickline constants (same as CSW-Pickline app) ────────────────────────────
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

const CREW_PALETTE = [
  { color: '#E3F2FD', border: '#90CAF9' },
  { color: '#E0F7FA', border: '#4DD0E1' },
  { color: '#FFF8E1', border: '#FFD54F' },
  { color: '#FCE4EC', border: '#F48FB1' },
  { color: '#F1F8E9', border: '#AED581' },
  { color: '#EDE7F6', border: '#B39DDB' },
  { color: '#FBE9E7', border: '#FFAB91' },
]

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
  while (cum < targetCases && t < 19*60) {
    tl.push({ t, cum, picking: true, rate: globalRate })
    cum += globalRate
    t++
  }
  tl.push({ t, cum, picking: false, rate: globalRate })
  return tl
}

function casesToClock(tl, target) {
  for (let i = 0; i < tl.length - 1; i++) {
    const rate = tl[i].rate
    if (tl[i].picking && target >= tl[i].cum && target < tl[i].cum + rate) {
      return tl[i].t + (target - tl[i].cum) / rate
    }
  }
  return tl[tl.length - 1].t
}

function pickWindow(tl, cumBefore, cs) {
  const s = casesToClock(tl, cumBefore)
  const e = casesToClock(tl, cumBefore + cs)
  return { start: s, end: e, crossBrk: BREAKS.some(([bs, be]) => s < be && e > bs) }
}

const T_MIN = 0.15
function intensityBg(hex, ratio) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const t = ratio <= 1.0 ? T_MIN + 0.35 * ratio
          : ratio <= 1.5 ? 0.5 + 1.5 * (ratio - 1.0)
          :                ratio - 0.25
  return `rgb(${Math.round(255+(r-255)*t)},${Math.round(255+(g-255)*t)},${Math.round(255+(b-255)*t)})`
}

function getZoneDemand(routes) {
  const d = {}
  routes.forEach(r => Object.entries(r.z || {}).forEach(([z, v]) => {
    d[+z] = (d[+z] || 0) + (v || 0)
  }))
  return d
}

function buildCrews(pickers, routes, mode = 'spread') {
  const ZONE_LOCS        = {1:4,2:3,3:4,4:4,5:3,6:6,7:3,8:4,9:4,10:4,11:4,12:4}
  const WALK_WEIGHT      = 50
  const MAX_LOCS_PER_GROUP = 9
  const working = Math.max(1, pickers - 1)
  const p = (n) => n === 1 ? '1 person' : `${n} people`
  const zoneDemand = getZoneDemand(routes)
  const adjDemand = {}
  for (let z = 1; z <= 12; z++) adjDemand[z] = (zoneDemand[z] || 0) + WALK_WEIGHT * (ZONE_LOCS[z] || 0)
  const rawCs  = (zones) => zones.reduce((a, z) => a + (zoneDemand[z] || 0), 0)
  const adjCs  = (zones) => zones.reduce((a, z) => a + adjDemand[z], 0)
  const locs   = (zones) => zones.reduce((a, z) => a + (ZONE_LOCS[z] || 0), 0)

  const palletCs  = rawCs([1, 2])
  const z34Cs     = rawCs([3, 4])
  const z34People = Math.min(2, working)
  const z5Cs      = zoneDemand[5] || 0
  const z5Assigned = working > z34People ? 1 : 0

  const remainZones = [6,7,8,9,10,11,12]
  const remainAdj   = adjCs(remainZones)
  let peopleLeft    = Math.max(0, working - z34People - z5Assigned)
  const csTarget    = peopleLeft > 0 ? remainAdj / peopleLeft : Infinity
  const avgZoneAdj  = remainZones.length > 0 ? remainAdj / remainZones.length : 0
  const MAX_ZONES_PER_GROUP = mode === 'spread'
    ? 2
    : (peopleLeft > 0 && avgZoneAdj < csTarget * 0.40 ? 3 : 2)
  const assignThreshold = mode === 'spread' ? 1.50 : 1.85
  const SOLO_THRESHOLD  = 1.05
  const PAIR_CUT_MIN    = 0.65

  const groups = []
  const flushGroup = (groupZones, cumAdj, assign) => {
    assign = Math.min(Math.max(assign, 1), 2, peopleLeft)
    groups.push({ zones: [...groupZones], count: assign, cs: rawCs(groupZones) })
    peopleLeft -= assign
  }

  let cumAdj = 0, cumLocs = 0, groupZones = []
  if (peopleLeft > 0) {
    let i = 0
    while (i < remainZones.length && peopleLeft > 0) {
      if (peopleLeft === 2) {
        const rest     = remainZones.slice(i)
        const totalAdj = adjCs(rest)
        let bestCut = 0, bestScore = Infinity, accAdj = 0, accLocs = 0
        for (let j = 0; j < rest.length - 1; j++) {
          accAdj  += adjDemand[rest[j]]
          accLocs += ZONE_LOCS[rest[j]] || 0
          const g2Locs    = locs(rest.slice(j + 1))
          const imbalance = Math.abs(2 * accAdj - totalAdj)
          const locPenalty = (accLocs > MAX_LOCS_PER_GROUP || g2Locs > MAX_LOCS_PER_GROUP) ? 1e9 : 0
          const score = imbalance + locPenalty
          if (score < bestScore) { bestScore = score; bestCut = j }
        }
        if (bestScore >= 1e9) {
          accAdj = 0; bestScore = Infinity
          for (let j = 0; j < rest.length - 1; j++) {
            accAdj += adjDemand[rest[j]]
            const imbalance = Math.abs(2 * accAdj - totalAdj)
            if (imbalance < bestScore) { bestScore = imbalance; bestCut = j }
          }
        }
        const g1 = rest.slice(0, bestCut + 1)
        const g2 = rest.slice(bestCut + 1)
        groups.push({ zones: g1, count: 1, cs: rawCs(g1) })
        groups.push({ zones: g2, count: 1, cs: rawCs(g2) })
        peopleLeft = 0
        break
      }
      const z     = remainZones[i]
      const zAdj  = adjDemand[z]
      const zLocs = ZONE_LOCS[z] || 0
      if (groupZones.length > 0 && peopleLeft > 1 && cumLocs + zLocs > MAX_LOCS_PER_GROUP) {
        const assign = (cumAdj >= csTarget * assignThreshold && peopleLeft >= 2) ? 2 : 1
        flushGroup(groupZones, cumAdj, assign)
        groupZones = []; cumAdj = 0; cumLocs = 0
        if (peopleLeft <= 0) {
          const extra = remainZones.slice(i)
          groups[groups.length - 1].zones.push(...extra)
          groups[groups.length - 1].cs += rawCs(extra)
          break
        }
        continue
      }
      groupZones.push(z); cumAdj += zAdj; cumLocs += zLocs; i++
      const isLast       = i === remainZones.length
      const nextAdj      = !isLast ? adjDemand[remainZones[i]] : 0
      const span         = groupZones.length
      const singleHeavy  = span === 1 && cumAdj >= csTarget * SOLO_THRESHOLD
      const pairNatural  = span === 2 && cumAdj >= csTarget * 2 * PAIR_CUT_MIN
      const wouldBust    = (cumAdj + nextAdj) > csTarget * 2 * 1.05
      const tooManyZones = span >= MAX_ZONES_PER_GROUP
      const mustFlush    = peopleLeft === 1
      const shouldCut    = isLast || mustFlush || tooManyZones || singleHeavy || pairNatural || (wouldBust && span >= 2)
      if (shouldCut) {
        const assign = (cumAdj >= csTarget * assignThreshold && peopleLeft >= 2) ? 2 : 1
        flushGroup(groupZones, cumAdj, assign)
        groupZones = []; cumAdj = 0; cumLocs = 0
        if (peopleLeft <= 0) {
          if (i < remainZones.length) {
            const extra = remainZones.slice(i)
            groups[groups.length - 1].zones.push(...extra)
            groups[groups.length - 1].cs += rawCs(extra)
          }
          break
        }
      }
    }
  }

  const crews = [
    { label: '1 person — pallet/Z2', zones: [1,2], ...CREW_PALETTE[0], flex: 'covers Z1 + Z2', count: 1, cs: palletCs },
    { label: '2 people — Z3–4',      zones: [3,4], ...CREW_PALETTE[1], flex: 'flex ↔ Z2 / Z5', count: z34People, cs: z34Cs },
  ]
  if (z5Assigned) {
    crews.push({ label: '1 person — Z5', zones: [5], ...CREW_PALETTE[2], flex: 'flex ↔ Z4 / Z6', count: 1, cs: z5Cs })
  }
  groups.forEach((g, i) => {
    const zFirst = g.zones[0], zLast = g.zones[g.zones.length - 1]
    const zLabel = g.zones.length === 1 ? `Z${zFirst}` : `Z${zFirst}–${zLast}`
    const prevZ  = i === 0 ? 5 : groups[i-1].zones[groups[i-1].zones.length-1]
    const nextZ  = i < groups.length - 1 ? groups[i+1].zones[0] : null
    const flexStr = nextZ ? `flex ↔ Z${prevZ} / Z${nextZ}` : `flex → Z${prevZ}`
    crews.push({ label: `${p(g.count)} — ${zLabel}`, zones: g.zones, ...CREW_PALETTE[(i+3) % CREW_PALETTE.length], flex: flexStr, count: g.count, cs: g.cs })
  })
  return crews
}

// ─── CSV Upload Area ──────────────────────────────────────────────────────────
function CsvUploadArea({ onSnapshot }) {
  const [dragging, setDragging]     = useState(false)
  const [files, setFiles]           = useState({ cases: null, tiehigh: null, pickseq: null, shortage: null })
  const [parsing, setParsing]       = useState(false)
  const [parseError, setParseError] = useState(null)
  const inputRef = useRef(null)

  const FILE_LABELS = [
    { key: 'cases',    label: 'Cases CSV',     hint: 'Required — Bernatello\'s order export', required: true },
    { key: 'tiehigh',  label: 'TieHigh CSV',   hint: 'Optional — enables pallet allocation', required: false },
    { key: 'pickseq',  label: 'Pick Seq CSV',  hint: 'Optional — route sort order by day',   required: false },
    { key: 'shortage', label: 'Shortage CSV',  hint: 'Optional — inventory shortage report', required: false },
  ]

  function classifyFile(filename) {
    const n = filename.toLowerCase()
    if (/tie.?high|pickline/.test(n)) return 'tiehigh'
    if (/shortage/.test(n)) return 'shortage'
    if (/bernatello|pick.?sched|pick.?seq/.test(n)) return 'pickseq'
    return 'cases'
  }

  function handleFiles(fileList) {
    const next = { ...files }
    for (const f of Array.from(fileList)) {
      const key = classifyFile(f.name)
      next[key] = f
    }
    setFiles(next)
    setParseError(null)
  }

  function onDrop(e) {
    e.preventDefault(); setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  async function readText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = e => res(e.target.result)
      r.onerror = () => rej(new Error('Failed to read file'))
      r.readAsText(file)
    })
  }

  async function handleParse() {
    if (!files.cases) return
    setParsing(true); setParseError(null)
    try {
      const casesText    = await readText(files.cases)
      const tieHighText  = files.tiehigh  ? await readText(files.tiehigh)  : null
      const pickSeqText  = files.pickseq  ? await readText(files.pickseq)  : null
      const shortageText = files.shortage ? await readText(files.shortage) : null
      const snap = parsePicklineCSV(casesText, 'manual', tieHighText, pickSeqText, shortageText)
      if (!snap.routes || snap.routes.length === 0) throw new Error('No routes found — check column mapping')
      onSnapshot(snap)
    } catch (err) {
      setParseError(err.message ?? 'Parse failed')
    } finally {
      setParsing(false)
    }
  }

  const hasRequired = !!files.cases

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'Arial, sans-serif' }}>
      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? '#1565C0' : '#b0c4f0'}`,
          borderRadius: 8,
          padding: '32px 24px',
          textAlign: 'center',
          background: dragging ? '#e8f0fe' : '#f5f8ff',
          cursor: 'pointer',
          marginBottom: 20,
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#1565C0', marginBottom: 4 }}>
          Drop CSV files here or click to browse
        </div>
        <div style={{ fontSize: 11, color: '#888' }}>
          Drop multiple files at once — they'll be auto-classified by filename
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          multiple
          style={{ display: 'none' }}
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      {/* File status */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
        {FILE_LABELS.map(({ key, label, hint, required }) => (
          <div key={key} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 14px',
            background: files[key] ? '#e8f5e9' : '#f9f9f9',
            border: `1px solid ${files[key] ? '#a5d6a7' : '#e0e0e0'}`,
            borderRadius: 6,
          }}>
            <span style={{ fontSize: 16, marginTop: 1 }}>{files[key] ? '✅' : required ? '⬜' : '☐'}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: files[key] ? '#2e7d32' : '#444' }}>
                {label}{required && <span style={{ color: '#c62828', marginLeft: 2 }}>*</span>}
              </div>
              <div style={{ fontSize: 10, color: '#888', marginTop: 1 }}>
                {files[key] ? files[key].name : hint}
              </div>
            </div>
            {files[key] && (
              <button
                onClick={e => { e.stopPropagation(); setFiles(prev => ({ ...prev, [key]: null })) }}
                style={{ marginLeft: 'auto', fontSize: 14, color: '#999', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, paddingLeft: 4 }}
              >×</button>
            )}
          </div>
        ))}
      </div>

      {parseError && (
        <div style={{ background: '#ffebee', border: '1px solid #ef9a9a', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: '#c62828', marginBottom: 16 }}>
          ⚠ {parseError}
        </div>
      )}

      <button
        onClick={handleParse}
        disabled={!hasRequired || parsing}
        style={{
          width: '100%', padding: '12px', background: hasRequired ? '#1565C0' : '#ccc',
          color: '#fff', border: 'none', borderRadius: 6, fontSize: 14,
          fontWeight: 'bold', cursor: hasRequired ? 'pointer' : 'not-allowed',
          transition: 'background 0.15s',
        }}
      >
        {parsing ? 'Parsing…' : 'Load Pick Brief'}
      </button>
    </div>
  )
}

// ─── Main Pick Table ──────────────────────────────────────────────────────────
function PickTable({ pickers, cpmh, tl, netCs, hourOverrides, setHourOverride, routes, crews, crewMode, setCrewMode }) {
  const brkFmt = BREAKS.map(([s, e]) => `${fmt(s)}–${fmt(e)}`).join('  |  ')
  const NUM_LEFT = 7

  const zoneCrewColor = {}, zoneCrewBorder = {}
  crews.forEach(crew => crew.zones.forEach(z => {
    zoneCrewColor[z] = crew.color
    zoneCrewBorder[z] = crew.border
  }))

  const paceRows = useMemo(() => {
    let cumPickMins = 0, cumCases = 0
    const result = PACE.map((b, idx) => {
      const effPickers = hourOverrides[idx]?.pickers ?? pickers
      const effCpmh    = hourOverrides[idx]?.cpmh    ?? cpmh
      const rate       = (effPickers * effCpmh) / 60
      cumPickMins += b.pickMins
      const thisCases = Math.round(rate * b.pickMins)
      cumCases += thisCases
      return { label: b.label, clockStart: b.clockStart, pickMins: b.pickMins, cumPickMins, cumCases, thisCases, effPickers, effCpmh, idx }
    })
    let cs = 13*60 + 30, coveredAt = -1
    const globalRate = (pickers * cpmh) / 60
    while (cs < 19*60) {
      const pm = cs === 13*60 + 30 ? 30 : 60
      const end = cs + pm
      const lastMin = end - 1
      const h1 = cs/60|0, m1 = cs%60, lh = lastMin/60|0, lm = lastMin%60
      const ap = lh >= 12 ? 'pm' : 'am'
      const s1 = `${h1>12?h1-12:h1}${m1?':'+String(m1).padStart(2,'0'):''}`
      const s2 = `${lh>12?lh-12:lh}:${String(lm).padStart(2,'0')}`
      cumPickMins += pm
      const thisCases = Math.round(globalRate * pm)
      cumCases += thisCases
      result.push({ label: `${s1}–${s2}${ap}`, clockStart: cs, pickMins: pm, cumPickMins, cumCases, thisCases, effPickers: pickers, effCpmh: cpmh, idx: null })
      cs += pm
      if (coveredAt === -1 && cumCases >= netCs) coveredAt = result.length - 1
      else if (coveredAt >= 0) break
    }
    return result
  }, [pickers, cpmh, netCs, hourOverrides])

  let netDoneRow = -1, cumSoFar = 0
  for (let i = 0; i < paceRows.length; i++) {
    cumSoFar += paceRows[i].thisCases
    if (netDoneRow === -1 && cumSoFar >= netCs) netDoneRow = i
  }
  const netDoneTime = netCs > 0 ? fmt(casesToClock(tl, netCs)) : null

  const crewHourlyCs = useMemo(() => {
    const result = Array.from({ length: PACE.length }, () => new Array(crews.length).fill(0))
    let cum = 0
    routes.forEach(row => {
      const { cs, z = {} } = row
      if (!cs) return
      const { start, end } = pickWindow(tl, cum, cs)
      const dur = end - start
      crews.forEach((crew, ci) => {
        const crewRouteCs = crew.zones.reduce((a, zone) => a + (z[zone] || 0), 0)
        if (!crewRouteCs) return
        PACE.forEach((pace, pi) => {
          const hEnd = pace.clockStart + (pace.clockStart === 13*60 ? 30 : 60)
          if (dur > 0) {
            const overlap = Math.max(0, Math.min(end, hEnd) - Math.max(start, pace.clockStart))
            result[pi][ci] += crewRouteCs * overlap / dur
          } else if (start >= pace.clockStart && start < hEnd) {
            result[pi][ci] += crewRouteCs
          }
        })
      })
      cum += cs
    })
    return result.map(row => row.map(Math.round))
  }, [crews, routes, tl])

  let cumCs = 0, seq = 0
  const zoneTotals = {}
  let totalAlloc = 0, totalGross = 0, totalShorted = 0

  const rowEls = routes.map(row => {
    const { rt, nm, cs, z = {}, ready, apptEnd, live, alloc = 0, gross = 0, shorted = 0 } = row
    seq++
    const unsched = !cs
    const readyEl = ready != null ? (() => {
      const h = Math.floor(ready/60), m = ready%60
      const ap = h < 12 ? 'am' : 'pm'
      const hd = h%12 || 12
      const readyStr = `${hd}:${String(m).padStart(2,'0')}${ap}`
      return live
        ? <span style={{ background:'#C62828', color:'#fff', borderRadius:3, padding:'1px 4px', fontSize:9, fontWeight:'bold', marginLeft:4 }}>🚛 {readyStr}</span>
        : <span style={{ color:'#888', fontSize:9, marginLeft:4 }}>✓{readyStr}</span>
    })() : null

    let pwEl = <span style={{ color:'#aaa', fontSize:10 }}>— UNSCHEDULED —</span>
    let isAmber = false, isLate = false, isCaution = false

    if (!unsched) {
      const { start, end, crossBrk } = pickWindow(tl, cumCs, cs)
      isAmber = crossBrk
      const apptDeadline = apptEnd ?? (ready != null ? ready + APPT_WINDOW_MINS : null)
      if (apptDeadline != null) {
        isLate    = end > apptDeadline - 15
        isCaution = !isLate && end > apptDeadline - 30
      }
      const SHIFT_END = 13 * 60 + 30
      const capped = start >= SHIFT_END - 0.01
      const sym = crossBrk ? <sup style={{ color:'#5C6BC0', fontSize:8 }}>ǁǁ</sup> : null
      if (capped) {
        pwEl = <span style={{ background:'#111', color:'#fff', borderRadius:3, padding:'1px 6px', fontSize:10, fontWeight:'bold', whiteSpace:'nowrap' }}>{fmt(start)} – {fmt(end)}</span>
      } else if (isLate) {
        pwEl = <span style={{ background:'#C62828', color:'#fff', fontWeight:'bold', borderRadius:3, padding:'1px 6px', fontSize:10, whiteSpace:'nowrap' }}>{fmt(start)}{sym} – {fmt(end)}<sup style={{ fontSize:8, marginLeft:2 }}>⚠LATE</sup></span>
      } else if (isCaution) {
        pwEl = <span style={{ background:'#E65100', color:'#fff', fontWeight:'bold', borderRadius:3, padding:'1px 6px', fontSize:10, whiteSpace:'nowrap' }}>{fmt(start)}{sym} – {fmt(end)}<sup style={{ fontSize:8, marginLeft:2 }}>⚠CAUTION</sup></span>
      } else if (isAmber) {
        pwEl = <span style={{ background:'#FFCC02', color:'#333', fontWeight:'bold', borderRadius:3, padding:'1px 4px', fontSize:10, whiteSpace:'nowrap' }}>{fmt(start)}{sym} – {fmt(end)}</span>
      } else {
        pwEl = <span style={{ color:'#1565C0', fontSize:10, whiteSpace:'nowrap' }}>{fmt(start)} – {fmt(end)}</span>
      }
      cumCs += cs
    }

    totalAlloc   += alloc
    totalGross   += gross
    totalShorted += shorted

    const zSum   = Object.values(z).reduce((a, b) => a + b, 0)
    const unalloc = cs && (cs - zSum) > 5 ? cs - zSum : 0
    const csEl   = unsched ? <span style={{ color:'#aaa' }}>—</span>
      : cs >= 300 ? <span style={{ color:'#E65100', fontWeight:'bold' }}>{cs}cs</span> : `${cs}cs`
    const rowBg  = unsched ? '#f9f9f9' : isLate ? '#FFEBEE' : isCaution ? '#FFF3E0' : isAmber ? '#FFF3CD' : seq%2===0 ? '#f9fafb' : '#fff'
    const td = (content, extra={}) => (
      <td style={{ border:'1px solid #dde', padding:'3px 5px', background:rowBg, fontSize:11, ...extra }}>{content}</td>
    )
    return (
      <tr key={`${rt}-${seq}`} title={unalloc > 0 ? `⚠ ${unalloc}cs unallocated to zones` : ''}>
        {td(<strong>{rt}</strong>, { textAlign:'center', position:'sticky', left:0, zIndex:1 })}
        {td(
          <span>{nm}{readyEl}{unalloc>0 && <span style={{ color:'#999', fontSize:9, marginLeft:4 }}>⚠{unalloc}cs</span>}</span>,
          { textAlign:'left', paddingLeft:6, whiteSpace:'nowrap', position:'sticky', left:43, zIndex:1 }
        )}
        {td(<span style={{ color:'#555' }}>{gross > 0 ? `${gross}cs` : '—'}</span>, { textAlign:'center' })}
        {td(<span style={{ color:'#7B1FA2', fontWeight:'bold' }}>{alloc > 0 ? `${alloc}cs` : '—'}</span>, { textAlign:'center' })}
        {td(<span style={{ color:'#C62828', fontWeight:'bold' }}>{shorted > 0 ? `${shorted}cs` : '—'}</span>, { textAlign:'center' })}
        {td(csEl, { textAlign:'center' })}
        {td(pwEl, { whiteSpace:'nowrap', textAlign:'center' })}
        {Array.from({ length:12 }, (_, i) => {
          const zi = i + 1
          const v = (z && z[zi]) || 0
          if (v > 0) zoneTotals[zi] = (zoneTotals[zi] || 0) + v
          const colBg = unsched ? '#f9f9f9' : zoneCrewColor[zi] || rowBg
          return <td key={zi} style={{ border:`1px solid ${zoneCrewBorder[zi]||'#dde'}`, padding:'3px 4px', fontSize:11, textAlign:'center', background:colBg }}>{v || ''}</td>
        })}
      </tr>
    )
  })

  const totalCs = routes.reduce((s, r) => s + (r.cs || 0), 0)
  const totalBaseCases = paceRows.slice(0, PACE.length).reduce((s, r) => s + r.thisCases, 0)
  const hasOverrides   = Object.keys(hourOverrides).length > 0
  const thZ   = { background:'#37474F', color:'#fff', padding:'3px 5px', fontSize:10, border:'1px solid #555', textAlign:'center' }
  const miniBtn = { fontSize:9, padding:'0 3px', lineHeight:'14px', minWidth:14, border:'1px solid #bbb', borderRadius:3, background:'#f5f5f5', cursor:'pointer' }
  const redBarStyle = { background:'#BF360C', color:'#fff', fontWeight:'bold', fontSize:10, padding:'4px 10px', border:'none' }

  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ background:'#f5f5f5', fontSize:10, color:'#555', padding:'3px 8px' }}>
        Pick time derived from CPMH pace rate. ǁǁ = crosses break. Amber = interrupted mid-route.{' '}
        <span style={{ color:'#E65100', fontWeight:'bold' }}>Orange = pick window 15–30 min before appt deadline.</span>{' '}
        <span style={{ color:'#C62828', fontWeight:'bold' }}>Red = pick window within 15 min of or past appt deadline.</span>{' '}
        ⚠ = zone breakdown incomplete.
        &nbsp;|&nbsp; Breaks: {brkFmt}
      </div>
      <div style={{ overflowX:'auto' }}>
        <table style={{ borderCollapse:'collapse', fontSize:11, tableLayout:'fixed', minWidth:900 }}>
          <colgroup>
            <col style={{ width:42 }} />
            <col style={{ width:130 }} />
            <col style={{ width:65 }} />
            <col style={{ width:65 }} />
            <col style={{ width:65 }} />
            <col style={{ width:100 }} />
            {Array.from({ length:12 }, (_, i) => <col key={i} style={{ width:38 }} />)}
          </colgroup>

          <tbody>
            <tr>
              <td colSpan={NUM_LEFT + 12} style={{ background:'#1565C0', color:'#fff', fontWeight:'bold', fontSize:11, padding:'5px 8px', border:'1px solid #0d47a1' }}>
                {totalBaseCases.toLocaleString()} cs est. shift capacity
                {hasOverrides
                  ? <span style={{ fontWeight:'normal', fontSize:10, marginLeft:8, opacity:0.8 }}>({Object.keys(hourOverrides).length} hr override{Object.keys(hourOverrides).length>1?'s':''})</span>
                  : <span style={{ fontWeight:'normal', fontSize:10, marginLeft:8, opacity:0.8 }}>{cpmh} CPMH × {pickers} pkrs</span>}
              </td>
            </tr>
            {netDoneRow === -1 && (
              <tr><td colSpan={NUM_LEFT + 12} style={redBarStyle}>
                ⏳ Primary orders extend past schedule — check picker count or CPMH target
              </td></tr>
            )}
            <tr>
              <th colSpan={2} style={{ background:'#1565C0', color:'#fff', padding:'4px 6px', fontSize:10, textAlign:'center', border:'1px solid #0d47a1', whiteSpace:'nowrap' }}>Clock</th>
              <th style={{ background:'#1565C0', color:'#fff', padding:'4px 6px', fontSize:10, textAlign:'center', border:'1px solid #0d47a1' }}>Pkrs</th>
              <th style={{ background:'#1565C0', color:'#fff', padding:'4px 6px', fontSize:10, textAlign:'center', border:'1px solid #0d47a1' }}>CPMH</th>
              <th style={{ background:'#1565C0', color:'#fff', padding:'4px 6px', fontSize:10, textAlign:'center', border:'1px solid #0d47a1', whiteSpace:'pre-line', lineHeight:1.3 }}>{'Pick mins\nthis hr'}</th>
              <th style={{ background:'#1565C0', color:'#fff', padding:'4px 6px', fontSize:10, textAlign:'center', border:'1px solid #0d47a1', whiteSpace:'pre-line', lineHeight:1.3 }}>{'Cases\nthis hr'}</th>
              <th style={{ background:'#1565C0', border:'1px solid #0d47a1', width:65 }} />
              {crews.map(crew => (
                <th key={crew.zones[0]} colSpan={crew.zones.length}
                  style={{ ...thZ, background:crew.border, color:'#222', fontSize:9, fontWeight:'bold', whiteSpace:'nowrap' }}>
                  {crew.zones.map(z => `Z${z}`).join('+')}
                </th>
              ))}
            </tr>
            {paceRows.map((r, i) => {
              if (i >= PACE.length && i > netDoneRow + 1) return null
              const isMon = netDoneRow >= 0 && i > netDoneRow
              const bg = isMon ? (i%2===0?'#fff9e6':'#FFF3CD') : (i%2===0?'#fff':'#e8f5e9')
              const crewRow = i < PACE.length ? crewHourlyCs[i] : Array(crews.length).fill(0)
              const pkrsOverridden = r.idx !== null && hourOverrides[r.idx]?.pickers != null
              const cpmhOverridden = r.idx !== null && hourOverrides[r.idx]?.cpmh    != null
              const divider = netDoneRow >= 0 && i === netDoneRow + 1 ? (
                <tr key="div"><td colSpan={NUM_LEFT + 12} style={redBarStyle}>
                  ✓ Primary orders complete ~{netDoneTime}
                </td></tr>
              ) : null
              return [divider, (
                <tr key={i} style={{ background:bg }}>
                  <td colSpan={2} style={{ border:'1px solid #dde', padding:'4px 8px', fontWeight:'bold', whiteSpace:'nowrap' }}>{r.label}</td>
                  {r.idx !== null ? (<>
                    <td style={{ border:'1px solid #dde', padding:'2px 3px', textAlign:'center' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:1, justifyContent:'center' }}>
                        <button style={miniBtn} onClick={() => setHourOverride(r.idx, 'pickers', Math.max(1, r.effPickers-1))}>−</button>
                        <span style={{ minWidth:14, textAlign:'center', fontWeight:pkrsOverridden?'bold':'normal', color:pkrsOverridden?'#C62828':'#555' }}>{r.effPickers}</span>
                        <button style={miniBtn} onClick={() => setHourOverride(r.idx, 'pickers', Math.min(16, r.effPickers+1))}>+</button>
                        {pkrsOverridden && <button style={{ ...miniBtn, color:'#aaa', marginLeft:1 }} onClick={() => setHourOverride(r.idx, 'pickers', null)}>×</button>}
                      </div>
                    </td>
                    <td style={{ border:'1px solid #dde', padding:'2px 3px', textAlign:'center' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:1, justifyContent:'center' }}>
                        <button style={miniBtn} onClick={() => setHourOverride(r.idx, 'cpmh', Math.max(60, r.effCpmh-5))}>−</button>
                        <span style={{ minWidth:24, textAlign:'center', fontWeight:cpmhOverridden?'bold':'normal', color:cpmhOverridden?'#C62828':'#555' }}>{r.effCpmh}</span>
                        <button style={miniBtn} onClick={() => setHourOverride(r.idx, 'cpmh', Math.min(300, r.effCpmh+5))}>+</button>
                        {cpmhOverridden && <button style={{ ...miniBtn, color:'#aaa', marginLeft:1 }} onClick={() => setHourOverride(r.idx, 'cpmh', null)}>×</button>}
                      </div>
                    </td>
                  </>) : (<>
                    <td style={{ border:'1px solid #dde', padding:'2px 3px', textAlign:'center', color:'#999', fontSize:10 }}>{r.effPickers}</td>
                    <td style={{ border:'1px solid #dde', padding:'2px 3px', textAlign:'center', color:'#999', fontSize:10 }}>{r.effCpmh}</td>
                  </>)}
                  <td style={{ border:'1px solid #dde', padding:'4px 8px', textAlign:'center' }}>{r.pickMins}</td>
                  <td style={{ border:'1px solid #dde', padding:'4px 8px', textAlign:'center' }}>{r.thisCases.toLocaleString()}</td>
                  <td style={{ border:'1px solid #dde' }} />
                  {crews.map((crew, ci) => {
                    const cs = crewRow[ci]
                    const capacity = (i < PACE.length && crew.count > 0) ? (crew.count * r.effCpmh / 60) * r.pickMins : 0
                    const ratio = capacity > 0 ? cs / capacity : 0
                    const cellBg = cs > 0 ? intensityBg(crew.border, Math.min(ratio, 2.0)) : bg
                    return (
                      <td key={ci} colSpan={crew.zones.length}
                        style={{ border:`1px solid ${crew.border||'#dde'}`, padding:'4px 4px', textAlign:'center', background:cellBg, color:'#333', fontSize:10 }}>
                        {cs || ''}
                      </td>
                    )
                  })}
                </tr>
              )]
            })}
          </tbody>

          <tbody>
            <tr>
              <td colSpan={NUM_LEFT} style={{ background:'#263238', border:'1px solid #555', padding:'4px 6px', position:'sticky', left:0, zIndex:3 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  <span style={{ color:'#fff', fontWeight:'bold', fontSize:10 }}>CREW POSITIONING</span>
                  <span style={{ color:'#90A4AE', fontSize:9 }}>column tint = crew zone ownership</span>
                  <div style={{ display:'flex', gap:3, marginLeft:'auto' }}>
                    {[['spread','Spread'],['standard','Standard']].map(([m, lbl]) => (
                      <button key={m} onClick={() => setCrewMode(m)}
                        style={{ fontSize:9, padding:'1px 6px', borderRadius:3, cursor:'pointer',
                          border: crewMode===m ? '1px solid #90CAF9' : '1px solid #546E7A',
                          background: crewMode===m ? '#1565C0' : '#37474F',
                          color: crewMode===m ? '#fff' : '#90A4AE',
                          fontWeight: crewMode===m ? 'bold' : 'normal' }}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              </td>
              {crews.map(crew => (
                <td key={crew.zones[0]} colSpan={crew.zones.length}
                  style={{ background:crew.border, border:'2px solid #555', padding:'4px 6px', textAlign:'center', whiteSpace:'nowrap' }}>
                  <div style={{ fontWeight:'bold', fontSize:10, color:'#222' }}>{crew.label}</div>
                  <div style={{ fontSize:9, color:'#555', fontStyle:'italic' }}>{crew.flex}</div>
                  {crew.crewCs != null && (
                    <div style={{ marginTop:3, display:'flex', gap:5, flexWrap:'wrap', alignItems:'baseline', justifyContent:'center' }}>
                      <span style={{ fontWeight:'bold', color:'#1565C0', fontSize:10 }}>{crew.crewCs.toLocaleString()}cs</span>
                      <span style={{ color:'#666', fontSize:9 }}>{crew.pct}% of demand</span>
                    </div>
                  )}
                  {crew.perPerson != null && (
                    <div style={{ fontSize:9, color: crew.heavy?'#B71C1C': crew.light?'#E65100':'#555', fontWeight: crew.heavy?'bold':'normal' }}>
                      ~{crew.perPerson.toLocaleString()}cs/person
                      {crew.heavy?' ▲ heavy': crew.light?' ▼ light':''}
                    </div>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <td colSpan={2} style={{ background:'#CFD8DC', fontWeight:'bold', padding:'4px 8px', textAlign:'left', border:'1px solid #b0bec5', position:'sticky', left:0, zIndex:2 }}>TOTAL</td>
              <td style={{ background:'#CFD8DC', fontWeight:'bold', textAlign:'center', border:'1px solid #b0bec5', color:'#555' }}>{totalGross.toLocaleString()}cs</td>
              <td style={{ background:'#CFD8DC', fontWeight:'bold', textAlign:'center', border:'1px solid #b0bec5', color:'#7B1FA2' }}>{totalAlloc > 0 ? `${totalAlloc.toLocaleString()}cs` : '—'}</td>
              <td style={{ background:'#CFD8DC', fontWeight:'bold', textAlign:'center', border:'1px solid #b0bec5', color:'#C62828' }}>{totalShorted > 0 ? `${totalShorted.toLocaleString()}cs` : '—'}</td>
              <td style={{ background:'#CFD8DC', fontWeight:'bold', textAlign:'center', border:'1px solid #b0bec5' }}>{totalCs.toLocaleString()}cs</td>
              <td style={{ background:'#CFD8DC', border:'1px solid #b0bec5' }} />
              {Array.from({length:12}, (_, i) => (
                <td key={i} style={{ background:zoneCrewColor[i+1]||'#CFD8DC', fontWeight:'bold', textAlign:'center', border:`1px solid ${zoneCrewBorder[i+1]||'#b0bec5'}`, fontSize:11 }}>{zoneTotals[i+1]||''}</td>
              ))}
            </tr>
            <tr>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'center', position:'sticky', left:0, zIndex:2 }}>Route</th>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'left', position:'sticky', left:43, zIndex:2 }}>Route Name</th>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'center' }}>Gross</th>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'center' }}>Alloc Pull</th>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'center' }}>Shorted</th>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'center' }}>NET Cases</th>
              <th style={{ background:'#37474F', color:'#fff', padding:'4px 6px', border:'1px solid #555', fontSize:11, whiteSpace:'nowrap', textAlign:'center' }}>Pick Window</th>
              {Array.from({length:12}, (_, i) => {
                const zi = i + 1
                return <th key={zi} style={{ ...thZ, background:zoneCrewBorder[zi]||'#37474F', color:'#333' }}>Z{zi}</th>
              })}
            </tr>
          </tbody>
          <tbody>{rowEls}</tbody>
        </table>
      </div>
    </div>
  )
}

// ─── PicklinePanel: top-level component used in FacilityPanel (WR) ────────────
export default function PicklinePanel() {
  const [snapshot, setSnapshot]           = useState(null)
  const [pickers, setPickers]             = useState(9)
  const [cpmh, setCpmh]                   = useState(150)
  const [hourOverrides, setHourOverrides] = useState({})
  const [crewMode, setCrewMode]           = useState('spread')

  function setHourOverride(idx, field, value) {
    setHourOverrides(prev => {
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

  function handleSnapshot(snap) {
    setSnapshot(snap)
    setHourOverrides({})
  }

  const routes = snapshot?.routes     ?? []
  const netCs  = snapshot?.net_cs     ?? 0
  const grossCs  = snapshot?.gross_cs   ?? 0
  const allocCs  = snapshot?.alloc_cs   ?? 0
  const shortedCs = snapshot?.shorted_cs ?? 0
  const snapDate  = snapshot?.snapshot_date ?? null
  const nextDates = snapshot?.next_dates ?? []

  const tl    = useMemo(() => buildTimeline(pickers, cpmh, netCs, hourOverrides), [pickers, cpmh, netCs, hourOverrides])
  const crews = useMemo(() => buildCrews(pickers, routes, crewMode), [pickers, routes, crewMode])

  const enrichedCrews = useMemo(() => {
    const zoneTotals = {}
    routes.forEach(r => Object.entries(r.z||{}).forEach(([z, v]) => { zoneTotals[+z] = (zoneTotals[+z]||0) + (v||0) }))
    const totalMapped = Object.values(zoneTotals).reduce((a, b) => a + b, 0)
    const avgPerPicker = pickers > 1 ? totalMapped / (pickers - 1) : totalMapped
    return crews.map(crew => {
      const crewCs   = crew.zones.reduce((a, z) => a + (zoneTotals[z]||0), 0)
      const pct      = totalMapped > 0 ? Math.round(crewCs/totalMapped*100) : 0
      const perPerson = crew.count > 0 ? Math.round(crewCs/crew.count) : null
      const heavy = perPerson !== null && perPerson > avgPerPicker * 1.3
      const light = perPerson !== null && perPerson < avgPerPicker * 0.7
      return { ...crew, crewCs, pct, perPerson, heavy, light }
    })
  }, [crews, routes, pickers])

  const target      = Math.round(cpmh * pickers * HRS)
  const netDoneTime = useMemo(() => netCs > 0 ? fmt(casesToClock(tl, netCs)) : null, [tl, netCs])
  const totalCap    = tl[tl.length-1].cum
  const PRE_PICK_CUTOFF = 13 * 60 + 30
  const cumAt130pm  = (tl.find(e => e.t >= PRE_PICK_CUTOFF) ?? tl[tl.length-1]).cum
  const monCs       = nextDates[0]?.net_cs ?? 0
  const monPickable = Math.min(Math.max(0, cumAt130pm - netCs), monCs)

  const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
  const dateLabel = snapDate ? fmtDate(snapDate) : '—'

  const btnStyle = (disabled) => ({
    width:32, height:32, border:'1px solid #1565C0', borderRadius:5,
    background:'#fff', color:'#1565C0', fontSize:20, cursor:disabled?'not-allowed':'pointer',
    opacity:disabled?0.3:1, lineHeight:1, display:'flex', alignItems:'center', justifyContent:'center',
  })

  if (!snapshot) {
    return <CsvUploadArea onSnapshot={handleSnapshot} />
  }

  return (
    <div style={{ fontFamily:'Arial, sans-serif', fontSize:11 }}>

      {/* Header bar */}
      <div style={{ background:'#1565C0', color:'#fff', padding:'8px 14px', fontSize:14, fontWeight:'bold',
        display:'flex', justifyContent:'space-between', alignItems:'center', borderRadius:'6px 6px 0 0', marginBottom:0 }}>
        <span>CSW Pick Line — {dateLabel} Brief</span>
        <button
          onClick={() => { setSnapshot(null); setHourOverrides({}) }}
          style={{ fontSize:11, padding:'3px 10px', background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.3)', borderRadius:4, color:'#fff', cursor:'pointer' }}
        >
          ↑ Load new CSV
        </button>
      </div>

      {/* Stats bar */}
      <div style={{ background:'#E8F5E9', border:'1px solid #A5D6A7', padding:'4px 10px', fontSize:10, color:'#2E7D32', marginBottom:8, display:'flex', flexDirection:'column', gap:3 }}>
        <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
          <span style={{ fontWeight:'bold', color:'#1B5E20', minWidth:90 }}>{dateLabel}</span>
          <span>📦 Gross: <strong>{grossCs.toLocaleString()}cs</strong></span>
          <span>↩ Alloc pull: <strong>{allocCs.toLocaleString()}cs</strong></span>
          {shortedCs > 0 && <span>⚠ Shorted: <strong style={{ color:'#C62828' }}>{shortedCs.toLocaleString()}cs</strong></span>}
          <span>✅ NET pick line: <strong>{netCs.toLocaleString()}cs</strong></span>
        </div>
        {nextDates.map(nd => (
          <div key={nd.date} style={{ display:'flex', gap:16, flexWrap:'wrap', opacity:0.8 }}>
            <span style={{ fontWeight:'bold', color:'#1B5E20', minWidth:90 }}>{fmtDate(nd.date)}</span>
            <span>📦 Gross: <strong>{nd.gross_cs.toLocaleString()}cs</strong></span>
            <span>↩ Alloc pull: <strong>{nd.alloc_cs.toLocaleString()}cs</strong></span>
            {(nd.shorted_cs ?? 0) > 0 && <span>⚠ Shorted: <strong style={{ color:'#C62828' }}>{nd.shorted_cs.toLocaleString()}cs</strong></span>}
            <span>✅ NET pick line: <strong>{nd.net_cs.toLocaleString()}cs</strong></span>
          </div>
        ))}
      </div>

      {/* Picker + CPMH controls */}
      <div style={{ background:'#f0f4ff', border:'1px solid #b0c4f0', borderRadius:6,
        padding:'10px 14px', display:'flex', alignItems:'center', gap:12, marginBottom:10, flexWrap:'wrap' }}>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ fontSize:13, fontWeight:'bold', color:'#1565C0', minWidth:120 }}>Pickers Available</div>
            <button style={btnStyle(pickers<=1)} onClick={() => pickers>1 && setPickers(p=>p-1)}>−</button>
            <span style={{ fontSize:28, fontWeight:'bold', color:'#1565C0', minWidth:28, textAlign:'center' }}>{pickers}</span>
            <button style={btnStyle(pickers>=20)} onClick={() => pickers<20 && setPickers(p=>p+1)}>+</button>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ fontSize:13, fontWeight:'bold', color:'#1565C0', minWidth:120 }}>CPMH Target</div>
            <button style={btnStyle(cpmh<=60)} onClick={() => cpmh>60 && setCpmh(c=>c-5)}>−</button>
            <span style={{ fontSize:28, fontWeight:'bold', color:'#1565C0', minWidth:28, textAlign:'center' }}>{cpmh}</span>
            <button style={btnStyle(cpmh>=300)} onClick={() => cpmh<300 && setCpmh(c=>c+5)}>+</button>
            <input type="range" min={60} max={300} step={5} value={cpmh}
              onChange={e => setCpmh(Number(e.target.value))}
              style={{ width:140, accentColor:'#1565C0' }} />
          </div>
        </div>
        <div style={{ fontSize:12, color:'#444', lineHeight:2.0 }}>
          <div>Shift capacity: <strong>{target.toLocaleString()} cs</strong></div>
          <div>Primary complete est: <strong>~{netDoneTime}</strong></div>
          <div>Pre-pick: <strong style={{ color: totalCap>=netCs ? '#6A1B9A' : '#C62828' }}>
            {totalCap >= netCs
              ? `~${monPickable.toLocaleString()}cs available${nextDates[0] ? ` → ${fmtDate(nextDates[0].date)}` : ''}`
              : `${(netCs-totalCap).toLocaleString()}cs SHORT`}
          </strong></div>
        </div>
      </div>

      <PickTable
        pickers={pickers} cpmh={cpmh} tl={tl} netCs={netCs}
        hourOverrides={hourOverrides} setHourOverride={setHourOverride}
        routes={routes} crews={enrichedCrews}
        crewMode={crewMode} setCrewMode={setCrewMode}
      />

      <div style={{ background:'#ECEFF1', padding:'6px 10px', fontSize:9, color:'#78909C', borderTop:'1px solid #CFD8DC' }}>
        Zone heat map: ≥10%=yellow · ≥20%=amber · ≥30%=orange · ≥40%=red.
        Pick windows estimated from CPMH pace; actual may vary.
      </div>
    </div>
  )
}
