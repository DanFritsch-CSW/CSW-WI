import { useState, useEffect, useMemo } from 'react'

// ── Customer Snapshot ─────────────────────────────────────────
// Per-customer, per-weekday volume vs. baseline view. Shipping in the Weekly
// view per Kay Martin's request — snippable white card she can crop and share
// with external customers.
//
// Data approach: 56 PER-DAY Omni queries (8 weeks × 7 days), batched 12 at a
// time. Each query returns (appointment_id, project_name, type, lookup_code)
// for one specific date. The date is known from the query parameter so we tag
// each returned row with its (weekIdx, weekdayIdx) before flattening.
//
// Why per-day instead of per-week or 56-day windows:
//   When `scheduled_arrival` appears in the SELECT list of an Omni query with
//   a multi-day `TIME_FOR_UNIT_DURATION` filter, Omni collapses to the START
//   day of the window — we verified this against MotherDuck (MAD Tue-Sun data
//   exists but never came back). The single-day `offset_interval_string: '0
//   days'` pattern is rock-solid (it's what `fetchAppointmentList` uses).
//   `fetchKnownProjectsByFacility` works with 30-day windows specifically
//   because it omits `scheduled_arrival` from the SELECT — Omni then doesn't
//   touch the time dimension.
//
// We don't need `scheduled_arrival` in the response anyway — the query date IS
// the appointment date, so we attach (weekIdx, weekdayIdx) at query time.
//
// Why appointment_id is in the SELECT:
//   Omni implicitly GROUP BYs the dimensions in the SELECT list. Without a
//   unique-per-row dimension, two appointments that share the same
//   (project_name, type, lookup_code) tuple collapse to a single row in the
//   response — and we under-count the day. Real example caught 2026-06-30
//   at KEN/Pretzilla 7/2: two separate appointments at 8am and 9am both
//   carried the lookup_code "(PZ) - SO618308, SO618242, SO618446" (one
//   appointment per stop on a multi-stop route). Omni collapsed them to 1,
//   so Scheduled showed 11 instead of 12. Adding appointment_id (unique per
//   appointment in gold.truck_appointments) forces Omni to keep each row
//   distinct without breaking the single-day TIME_FOR_UNIT_DURATION pattern.
//   We never read appointment_id client-side — it exists purely as a
//   dedup-breaker.
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
//
// Known limitation — Datex→silver sync lag:
//   Appointments created in Datex within roughly the last hour may not yet
//   have propagated to the silver/gold layer Omni reads from. The card's
//   counts reflect what was visible at snapshot generation time; the
//   footnote on the card surfaces this so consumers aren't confused when
//   a freshly-scheduled appointment doesn't appear.

const GOLD_MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const VIEW_APPT = 'gold__truck_appointments'

const CSW_WAREHOUSE = {
  cal: 'CSW-Franksville',
  mad: 'CSW-Madison',
  ken: 'CSW-Kenosha',
  wr:  'CSW-Wisconsin Rapids',
  ec:  'CSW-Eau Claire',
}

const KEN_OMNI_NAME_MAP = new Map([
  ['FAIR OAKS FARMS', 'Fair Oaks Farms'],
  ['FAIR OAKS FARMS WEST', 'Fair Oaks Farms'],
  ['BIRCHWOOD FOODS  KENOSHA', 'Birchwood Foods Kenosha'],
  ['BOSSB5', 'BossBites'],
])

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
  return rows || []
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
const BATCH_SIZE = 12  // concurrent omni queries per chunk

export default function CustomerSnapshot({ facilityId, planDate, color }) {
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)  // 0..56
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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows(null)
    setProgress(0)

    async function load() {
      try {
        const wh = CSW_WAREHOUSE[facilityId]
        if (!wh) { setLoading(false); return }

        // Build all 56 (date, weekIdx, weekdayIdx) tuples
        const tuples = []
        weeks.forEach((weekMon, wIdx) => {
          for (let d = 0; d < 7; d++) {
            tuples.push({ date: addDaysIso(weekMon, d), weekIdx: wIdx, weekdayIdx: d })
          }
        })

        const allRows = []
        let completed = 0
        // Sequential chunks of BATCH_SIZE parallel queries
        for (let i = 0; i < tuples.length; i += BATCH_SIZE) {
          if (cancelled) return
          const batch = tuples.slice(i, i + BATCH_SIZE)
          const batchResults = await Promise.all(batch.map(t =>
            omniQuery({
              modelId: GOLD_MODEL_ID,
              table: VIEW_APPT,
              fields: [
                // appointment_id is unique per row — without it, Omni dedupes
                // rows sharing the same (project, type, lookup_code) tuple.
                // We never read this value client-side; it exists purely as
                // a dimension that forces per-appointment rows.
                `${VIEW_APPT}.appointment_id`,
                `${VIEW_APPT}.project_name`,
                `${VIEW_APPT}.dock_appointment_type_name`,
                `${VIEW_APPT}.lookup_code`,
              ],
              filters: {
                [`${VIEW_APPT}.warehouse_name`]: { kind: 'EQUALS', type: 'string', values: [wh] },
                [`${VIEW_APPT}.scheduled_arrival`]: {
                  kind: 'TIME_FOR_UNIT_DURATION', type: 'date', ui_type: 'DAY',
                  isFiscal: false, left_side: t.date, is_negative: false,
                  offset_interval_string: '0 days',
                },
                [`${VIEW_APPT}.dock_status_name`]: {
                  kind: 'EQUALS', type: 'string', values: ['Cancelled'], is_negative: true,
                },
              },
              sorts: [],
              limit: 500,
            })
              .then(dayRows => dayRows.map(r => ({ r, weekIdx: t.weekIdx, weekdayIdx: t.weekdayIdx })))
              .catch(() => [])
          ))
          for (const arr of batchResults) allRows.push(...arr)
          completed += batch.length
          if (!cancelled) setProgress(completed)
        }

        if (cancelled) return
        const perWeekTotals = Array(NUM_WEEKS).fill(0)
        for (const x of allRows) perWeekTotals[x.weekIdx]++
        console.log(`[CustomerSnapshot] ${facilityId}: ${allRows.length} total appointments across 56 days (per-week: ${perWeekTotals.join(',')})`)
        setRows(allRows)
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [facilityId, weeks])

  // Bucket rows. Each row already carries weekIdx + weekdayIdx from the fetch.
  const buckets = useMemo(() => {
    if (!rows) return null
    const map = {}
    const customers = new Set()
    let skippedNoName = 0
    let skippedNoType = 0
    for (const { r, weekIdx, weekdayIdx } of rows) {
      const rawName = r[`${VIEW_APPT}.project_name`] || ''
      if (!rawName) { skippedNoName++; continue }
      const name = normalizeProjectName(facilityId, rawName)
      const typeName = r[`${VIEW_APPT}.dock_appointment_type_name`]
      const lookupCode = r[`${VIEW_APPT}.lookup_code`]
      const type = classifyType(typeName)
      if (!type) { skippedNoType++; continue }

      let bucketType
      if (isDrop(facilityId, name, lookupCode, type)) bucketType = 'dr'
      else if (type === 'inbound') bucketType = 'in'
      else bucketType = 'out'

      const key = `${name}|${weekIdx}|${weekdayIdx}|${bucketType}`
      map[key] = (map[key] || 0) + 1
      customers.add(name)
    }
    if (skippedNoName || skippedNoType) {
      console.log(`[CustomerSnapshot] ${facilityId}: skipped ${skippedNoName} no-name + ${skippedNoType} no-type rows`)
    }
    return {
      data: map,
      customers: [...customers].sort((a, b) => a.localeCompare(b)),
    }
  }, [rows, facilityId])

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
    const allCustomers = buckets?.customers || []
    const filtered = card.query
      ? allCustomers.filter(c => c.toLowerCase().includes(card.query.toLowerCase()))
      : allCustomers
    const hasData = !!buckets && card.customer && allCustomers.includes(card.customer)
    const data = hasData ? weekRowFor(card.customer, selWeekIdx) : null
    const weekMon = weeks[selWeekIdx]
    const weekSun = addDaysIso(weekMon, 6)
    const weekYear = new Date(weekMon + 'T00:00:00Z').getUTCFullYear()

    return (
      <div className="snap-col" key={key}>
        <div className="snap-combo">
          <input
            className="snap-input"
            value={card.open ? card.query : card.customer}
            placeholder={card.customer || (allCustomers.length ? 'Select a customer' : 'No customers available')}
            disabled={allCustomers.length === 0}
            onFocus={(e) => { if (allCustomers.length === 0) return; setCard({ ...card, open: true, query: '' }); e.target.select() }}
            onBlur={() => setTimeout(() => setCard(c => ({ ...c, open: false })), 150)}
            onChange={(e) => setCard({ ...card, query: e.target.value, open: true })}
          />
          {card.open && allCustomers.length > 0 && (
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
              Normal = median of the other 7 weeks (same weekday). HOLD appointments included; Cancelled excluded. Counts reflect Datex at snapshot time; appointments created within the last hour may not yet appear.
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

  const weekOptions = weeks.map((mon, i) => ({
    value: i,
    label: `${i === NUM_WEEKS - 1 ? 'This week · ' : ''}${fmtMD(mon)} – ${fmtMD(addDaysIso(mon, 6))}`,
  })).reverse()

  let statusBanner = null
  if (loading) {
    statusBanner = (
      <div className="snap-status">
        Loading customer snapshot… {progress > 0 && <span>({progress}/56 days)</span>}
      </div>
    )
  } else if (error) {
    statusBanner = <div className="snap-status snap-error">Snapshot unavailable: {error}</div>
  } else if (buckets && buckets.customers.length === 0) {
    statusBanner = (
      <div className="snap-status">
        No customer activity in the past 8 weeks.
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dim)' }}>
          Check the browser console for the [CustomerSnapshot] log to see how many rows came back per week.
        </div>
      </div>
    )
  }

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
      {statusBanner}
    </div>
  )
}
