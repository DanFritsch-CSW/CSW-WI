import { useState, useEffect, useMemo } from 'react'

// ── Customer Snapshot ─────────────────────────────────────────
// Per-customer, per-weekday volume vs. baseline view. Shipping in the Weekly
// view per Kay Martin's request — snippable white card she can crop and share
// with external customers.
//
// Data: ONE Omni query against gold__truck_appointments covering the trailing
// 8-week window for the facility. Raw rows get bucketed client-side by
// (customer, week, weekday, type). Customer is project_name (with KEN normalization).
//
// Type taxonomy:
//   - Outbound:  dock_appointment_type_name starts with "Outbound"
//   - Drops:     inbound rows where lookup_code matches the per-customer drop rule
//                (KEN + CAL only — other facilities don't track drops this way)
//   - Inbound:   inbound rows that AREN'T classified as drops
//
// Baseline (Normal) = median of the OTHER 7 weeks for the same weekday/type.
// "% of Normal" = scheduled / normal × 100, color-coded:
//   ≥100% green   |   70-99% default   |   <70% amber

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_APPT = 'gold__truck_appointments'

const CSW_WAREHOUSE = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

// Mirrors the KEN-only normalization in omni.js — same Omni dataset, same logic.
const KEN_OMNI_NAME_MAP = new Map([
  ['FAIR OAKS FARMS', 'Fair Oaks Farms'],
  ['FAIR OAKS FARMS WEST', 'Fair Oaks Farms'],
  ['BIRCHWOOD FOODS  KENOSHA', 'Birchwood Foods Kenosha'],
  ['BOSSB5', 'BossBites'],
])

// Drop classification rules — mirrors PROJECT_DROP_RULES in omni.js.
// KEN customers in this map have their inbound appointments classified as drops
// based on lookup_code patterns. Non-listed customers/facilities → no drops.
const DROP_RULES = {
  ken: new Map([
    ['CROWN BAKERIES',                  { method: 'all' }],
    ['Pretzilla Kenosha',               { method: 'all' }],
    ['Fair Oaks Farms',                 { method: 'all' }],
    ['Birchwood Foods Kenosha',         { method: 'all' }],
    ['BossBites',                       { method: 'all' }],
    ['RICHELIEU KENOSHA',               { method: 'include', patterns: ['TOP', 'PSH'] }],
    ['RICHELIEU RAW MATERIALS KENOSHA', { method: 'include', patterns: ['TOP', 'PSH'] }],
  ]),
  cal: new Map([
    ["Palermo's CALEDONIA finished", { method: 'exclude', excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']] }],
    ['Palermos CALEDONIA finished',  { method: 'exclude', excludeWhenAll: [['PUR', 'CMM'], ['PUR', 'PETER BROTHERS']] }],
  ]),
}

function classifyType(typeName) {
  const t = (typeName || '').toLowerCase()
  if (t.startsWith('inbound'))  return 'inbound'
  if (t.startsWith('outbound')) return 'outbound'
  return null
}

function isDrop(facilityId, projectName, lookupCode, type) {
  if (type !== 'inbound') return false
  const rule = DROP_RULES[facilityId]?.get(projectName)
  if (!rule) return false
  const code = (lookupCode || '').toUpperCase()
  if (rule.method === 'all') return true
  if (rule.method === 'include') return rule.patterns.some(p => code.includes(p))
  if (rule.method === 'exclude') return !rule.excludeWhenAll.some(group => group.every(p => code.includes(p)))
  return false
}

function normalizeProjectName(facilityId, rawName) {
  if (facilityId === 'ken' && KEN_OMNI_NAME_MAP.has(rawName)) {
    return KEN_OMNI_NAME_MAP.get(rawName)
  }
  return rawName
}

async function omniQuery(query) {
  const res = await fetch('/.netlify/functions/omni-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { version: 5, ...query } }),
  })
  if (!res.ok) {
    let body = {}
    try { body = await res.json() } catch { /* non-json */ }
    throw new Error(body.error || `omni-query ${res.status}`)
  }
  const { rows } = await res.json()
  return rows
}

// 0=Mon..6=Sun (Monday-anchored, matches the rest of the app)
function isoToWeekday(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z')
  const jsDay = d.getUTCDay()
  return jsDay === 0 ? 6 : jsDay - 1
}

function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  const jsDay = d.getUTCDay()
  const diff = jsDay === 0 ? -6 : 1 - jsDay
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function fmtMD(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

const DAY_LABELS = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su']
const TYPES = [
  { id: 'in',  label: 'Inbound' },
  { id: 'out', label: 'Outbound' },
  { id: 'dr',  label: 'Drops' },
]
const NUM_WEEKS = 8

export default function CustomerSnapshot({ facilityId, planDate, color }) {
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [selTypes, setSelTypes] = useState(['out'])
  const [selWeekIdx, setSelWeekIdx] = useState(NUM_WEEKS - 1)

  const [card1, setCard1] = useState({ customer: '', query: '', open: false })
  const [card2, setCard2] = useState({ customer: '', query: '', open: false })

  // 8 trailing weeks anchored on Monday — index 0 is oldest, index 7 (NUM_WEEKS-1) is current.
  const weeks = useMemo(() => {
    const currentWeekMon = mondayOf(planDate)
    return Array.from({ length: NUM_WEEKS }, (_, i) =>
      addDaysIso(currentWeekMon, -7 * (NUM_WEEKS - 1 - i))
    )
  }, [planDate])

  const fromDate = weeks[0]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows(null)

    async function load() {
      try {
        const wh = CSW_WAREHOUSE[facilityId]
        if (!wh) { setLoading(false); return }
        const apiRows = await omniQuery({
          modelId: GOLD_MODEL_ID,
          table: VIEW_APPT,
          fields: [
            `${VIEW_APPT}.project_name`,
            `${VIEW_APPT}.dock_appointment_type_name`,
            `${VIEW_APPT}.scheduled_arrival`,
            `${VIEW_APPT}.count`,
            `${VIEW_APPT}.lookup_code`,
          ],
          filters: {
            [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
            // 8-week window via TIME_FOR_UNIT_DURATION (BETWEEN is broken on timestamps — see omni.js comments).
            [`${VIEW_APPT}.scheduled_arrival`]: {
              kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
              isFiscal: false, left_side: fromDate, is_negative: false,
              offset_interval_string: `${NUM_WEEKS * 7} days`,
            },
            // Exclude Cancelled, keep HOLD (capacity reservations — see omni.js KAY/DEAN comments).
            [`${VIEW_APPT}.dock_status_name`]: {
              kind: 'EQUALS', type: 'string', values: ['Cancelled'], is_negative: true,
            },
          },
          sorts: [],
          limit: 5000,
        })
        if (cancelled) return
        console.log(`[CustomerSnapshot] ${facilityId}: omni returned ${apiRows?.length ?? 'null'} rows for window starting ${fromDate}`)
        setRows(apiRows)
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [facilityId, fromDate])

  // Bucket rows by (customer, weekIdx, weekdayIdx, bucketType).
  // bucketType: 'in' (non-drop inbound), 'out', 'dr' (rule-classified drops)
  const buckets = useMemo(() => {
    if (!rows) return null
    const map = {}
    const customers = new Set()
    for (const r of rows) {
      const rawName = r[`${VIEW_APPT}.project_name`] || ''
      if (!rawName) continue
      const name = normalizeProjectName(facilityId, rawName)
      const ts = r[`${VIEW_APPT}.scheduled_arrival`]
      const typeName = r[`${VIEW_APPT}.dock_appointment_type_name`]
      const lookupCode = r[`${VIEW_APPT}.lookup_code`]
      const count = Number(r[`${VIEW_APPT}.count`]) || 0
      if (!count) continue
      const type = classifyType(typeName)
      if (!type) continue

      const isoDate = typeof ts === 'string'
        ? ts.slice(0, 10)
        : new Date(ts).toISOString().slice(0, 10)
      const weekdayIdx = isoToWeekday(isoDate)
      const dayMon = mondayOf(isoDate)
      const weekIdx = weeks.indexOf(dayMon)
      if (weekIdx < 0) continue

      let bucketType
      if (isDrop(facilityId, name, lookupCode, type)) bucketType = 'dr'
      else if (type === 'inbound') bucketType = 'in'
      else bucketType = 'out'

      const key = `${name}|${weekIdx}|${weekdayIdx}|${bucketType}`
      map[key] = (map[key] || 0) + count
      customers.add(name)
    }
    return {
      data: map,
      customers: [...customers].sort((a, b) => a.localeCompare(b)),
    }
  }, [rows, facilityId, weeks])

  // Default the two cards to the top customers when data arrives.
  useEffect(() => {
    if (!buckets || buckets.customers.length === 0) return
    setCard1(c => c.customer ? c : { ...c, customer: buckets.customers[0] })
    if (buckets.customers.length > 1) {
      setCard2(c => c.customer ? c : { ...c, customer: buckets.customers[1] })
    }
  }, [buckets])

  function weekRowFor(customer, weekIdx) {
    const types = selTypes.length ? selTypes : ['in', 'out', 'dr']
    const sched = new Array(7).fill(0)
    const normal = new Array(7).fill(0)
    for (let dow = 0; dow < 7; dow++) {
      for (const t of types) {
        sched[dow] += buckets.data[`${customer}|${weekIdx}|${dow}|${t}`] || 0
      }
      // Normal = median over the OTHER 7 weeks for the same weekday + selected types
      const samples = []
      for (let w = 0; w < NUM_WEEKS; w++) {
        if (w === weekIdx) continue
        let v = 0
        for (const t of types) v += buckets.data[`${customer}|${w}|${dow}|${t}`] || 0
        samples.push(v)
      }
      if (samples.length) {
        const sorted = [...samples].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        normal[dow] = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      }
    }
    const pct = sched.map((s, i) => normal[i] ? Math.round(s / normal[i] * 100) : null)
    return { sched, normal, pct }
  }

  function selectedTypesLabel() {
    if (!selTypes.length) return 'TOTAL'
    return selTypes.map(t => TYPES.find(x => x.id === t).label).join(' + ').toUpperCase()
  }

  function renderCard(card, setCard, key) {
    const filtered = card.query
      ? buckets.customers.filter(c => c.toLowerCase().includes(card.query.toLowerCase()))
      : buckets.customers
    const data = card.customer ? weekRowFor(card.customer, selWeekIdx) : null
    const weekMon = weeks[selWeekIdx]
    const weekSun = addDaysIso(weekMon, 6)
    const weekYear = new Date(weekMon + 'T00:00:00Z').getUTCFullYear()

    return (
      <div className="snap-col" key={key}>
        <div className="snap-combo">
          <input
            className="snap-input"
            value={card.open ? card.query : card.customer}
            placeholder={card.customer || 'Select a customer'}
            onFocus={(e) => { setCard({ ...card, open: true, query: '' }); e.target.select() }}
            onBlur={() => setTimeout(() => setCard(c => ({ ...c, open: false })), 150)}
            onChange={(e) => setCard({ ...card, query: e.target.value, open: true })}
          />
          {card.open && (
            <div className="snap-menu">
              {filtered.length === 0 ? (
                <div className="snap-noopt">No matching customers</div>
              ) : filtered.map(c => (
                <div
                  key={c}
                  className={`snap-opt${c === card.customer ? ' on' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); setCard({ customer: c, open: false, query: '' }) }}
                >{c}</div>
              ))}
            </div>
          )}
        </div>

        {data && (
          <div className="snap-card" style={{ '--sn-accent': color, '--sn-accent-bg': color + '1f' }}>
            <div className="snap-head">{card.customer.toUpperCase()} — {selectedTypesLabel()}</div>
            <div className="snap-sub">Week of {fmtMD(weekMon)} – {fmtMD(weekSun)}, {weekYear}</div>
            <table className="snap-table">
              <thead>
                <tr>
                  <th className="sn-corner"></th>
                  {DAY_LABELS.map((d, i) => <th key={i} className="sn-th">{d}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="sn-rowlbl">Normal · 8-wk median</td>
                  {data.normal.map((n, i) => <td key={i} className="sn-cell">{n}</td>)}
                </tr>
                <tr>
                  <td className="sn-rowlbl">Scheduled</td>
                  {data.sched.map((s, i) => <td key={i} className="sn-cell">{s}</td>)}
                </tr>
                <tr className="sn-divide">
                  <td className="sn-rowlbl">% of Normal</td>
                  {data.pct.map((p, i) => {
                    if (p === null) return <td key={i} className="sn-cell sn-pct pct-dim">—</td>
                    const cls = p >= 100 ? 'pct-green' : p < 70 ? 'pct-amber' : ''
                    return <td key={i} className={`sn-cell sn-pct ${cls}`}>{p}%</td>
                  })}
                </tr>
              </tbody>
            </table>
            <div className="snap-note">
              Normal = median of the other 7 weeks (same weekday). HOLD appointments included; Cancelled excluded.
            </div>
            <div className="snap-foot">
              <span>CSW · {facilityId.toUpperCase()}</span>
              <span>Generated {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (loading) return <div className="snap-status">Loading customer snapshot…</div>
  if (error)   return <div className="snap-status snap-error">Snapshot unavailable: {error}</div>
  if (!buckets || buckets.customers.length === 0) {
    const rowCount = rows?.length ?? 0
    const detail = rowCount === 0
      ? 'Omni returned no rows for this facility in the past 8 weeks.'
      : `Omni returned ${rowCount} rows but none were bucketable (check console for [CustomerSnapshot] log; likely a date-parsing or warehouse-name mismatch).`
    return (
      <div className="snap-status">
        No customer activity in the past 8 weeks.
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dim)' }}>{detail}</div>
      </div>
    )
  }

  // Week options — reversed so most-recent is at the top of the dropdown
  const weekOptions = weeks.map((mon, i) => ({
    value: i,
    label: `${i === NUM_WEEKS - 1 ? 'This week · ' : ''}${fmtMD(mon)} – ${fmtMD(addDaysIso(mon, 6))}`,
  })).reverse()

  return (
    <div className="snap-wrap">
      <div className="snap-intro">
        Customer Snapshot — pick one or more types and a week, set a customer on each card, then crop a white card to share with the customer.
      </div>
      <div className="snap-filters">
        <span className="snap-flbl">Type</span>
        <div className="type-multi">
          {TYPES.map(t => (
            <button
              key={t.id}
              className={`type-chip${selTypes.includes(t.id) ? ' on' : ''}`}
              onClick={() => setSelTypes(prev =>
                prev.includes(t.id) ? prev.filter(x => x !== t.id) : [...prev, t.id]
              )}
            >{t.label}</button>
          ))}
        </div>
        <span className="snap-flbl">Week</span>
        <select
          className="snap-sel"
          value={selWeekIdx}
          onChange={(e) => setSelWeekIdx(Number(e.target.value))}
        >
          {weekOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="snap-compare">
        {renderCard(card1, setCard1, 'c1')}
        {renderCard(card2, setCard2, 'c2')}
      </div>
    </div>
  )
}
