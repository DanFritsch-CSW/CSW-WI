import { useMemo, useState, useEffect, Fragment } from 'react'
import { RACK_TYPE, RACK_GROUP, CUSTOMER_NAMES } from '../lib/jdfPutawaysLocations.js'
import { fetchJdfPutaways } from '../lib/jdfPutaways.js'
import { pct, classifyLocation, getWindowStart, windowLabel } from '../lib/jdfPutawaysLogic.js'

// ─── JDF Putaways ───────────────────────────────────────────────────────
// Visibility tool for F8 (Madison) JDF slotting: how well putaways are
// following FEFO/single-SKU discipline within JDF's own product, who's
// been moving pallets into currently-mixed locations, and recent raw
// volume by employee/aisle.
//
// LIVE DATA (2026-07-20 rewrite): all data below comes from
// netlify/functions/motherduck-jdf-putaways.cjs on every load -- see that
// file's header comment for the underlying MotherDuck query. This
// replaces the original 2026-07-17 build's manually-refreshed snapshot
// (src/lib/jdfPutaways{Locations,Events,Moves,Items}.js) which is now
// orphaned (Claude has no file-delete tool -- those files are unused dead
// code, safe to ignore or manually remove from the repo).
//
// DROPPED in this rewrite: the 8-week "weekly clean-move rate" chart.
// Reconstructing "was this location clean at the moment of a past move"
// isn't possible without point-in-time state tracking this app doesn't
// have -- the old snapshot's version had quietly used each move's
// CURRENT-day classification, which wasn't a real historical trend.
// Dropped per Dan's call rather than shipped with that caveat baked in.
//
// Comingling in the 7-deep drive-in racks (A, G, H) is NOT scored here --
// putting a slower-moving customer's pallets behind faster JDF movers is a
// deliberate way to use full lane depth. Only JDF's own SKU/date discipline
// counts toward clean/mixed.

const STATUS_ORDER = { clean: 0, mixed_date: 1, mixed_item: 2 }

export default function JdfPutaways() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const [groupBy, setGroupBy] = useState('aisle')
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [sortKey, setSortKey] = useState('location')
  const [sortDir, setSortDir] = useState('asc')
  const [locationFilter, setLocationFilter] = useState('')
  const [selectedEmployee, setSelectedEmployee] = useState(null)
  const [selectedLocation, setSelectedLocation] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    fetchJdfPutaways()
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshTick])

  const rawLocations = data?.locations ?? []
  const employeeEvents = data?.employeeEvents ?? []
  const allF8Moves = data?.allMoves ?? []
  const locationItemDetail = data?.locationItemDetail ?? {}
  const materialNames = data?.materialNames ?? {}
  // Curated labels win over Datex's raw project_name for customers we know.
  const customerNames = useMemo(() => ({ ...(data?.customerNames ?? {}), ...CUSTOMER_NAMES }), [data])

  const now = useMemo(() => new Date(), [data])
  const windowStart = useMemo(() => getWindowStart(now), [now])

  const enriched = useMemo(
    () =>
      rawLocations.map(loc => {
        const [location, aisle, jdfLp, distinctMaterials, distinctMfgDates, earliest, latest, otherLp, otherCustomers] = loc
        return {
          location, aisle, jdfLp, distinctMaterials, distinctMfgDates, earliest, latest, otherLp,
          otherCustomers: otherCustomers ? otherCustomers.split(',') : [],
          isShared: otherLp > 0,
          status: classifyLocation(loc),
          rackGroup: RACK_GROUP[aisle] || 'unknown',
        }
      }),
    [rawLocations]
  )

  const groupKey = groupBy === 'aisle' ? 'aisle' : 'rackGroup'

  const groups = useMemo(() => {
    const map = new Map()
    for (const r of enriched) {
      const key = r[groupKey]
      if (!map.has(key)) map.set(key, { key, total: 0, multi: 0, clean: 0, mixedDate: 0, mixedItem: 0, shared: 0 })
      const g = map.get(key)
      g.total += 1
      if (r.status !== 'single') g.multi += 1
      if (r.status === 'clean') g.clean += 1
      if (r.status === 'mixed_date') g.mixedDate += 1
      if (r.status === 'mixed_item') g.mixedItem += 1
      if (r.isShared) g.shared += 1
    }
    return Array.from(map.values())
      .map(g => ({
        ...g,
        rackType: groupBy === 'aisle' ? RACK_TYPE[g.key] : (g.key === '7-deep' ? '4-high lanes' : '7-high lanes'),
        cleanPct: pct(g.clean, g.multi),
        mixedDatePct: pct(g.mixedDate, g.multi),
        mixedItemPct: pct(g.mixedItem, g.multi),
        sharedPct: pct(g.shared, g.total),
      }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }, [enriched, groupKey, groupBy])

  const scoredGroups = groups.filter(g => g.multi > 0)

  const totals = useMemo(() => {
    const multi = enriched.filter(r => r.status !== 'single').length
    const clean = enriched.filter(r => r.status === 'clean').length
    const mixedDate = enriched.filter(r => r.status === 'mixed_date').length
    const mixedItem = enriched.filter(r => r.status === 'mixed_item').length
    const deep = enriched.filter(r => r.rackGroup === '7-deep')
    const avgLanePallets = deep.length
      ? Math.round((deep.reduce((s, r) => s + r.jdfLp + r.otherLp, 0) / deep.length) * 10) / 10
      : 0
    return { multi, clean, mixedDate, mixedItem, cleanPct: pct(clean, multi), avgLanePallets }
  }, [enriched])

  const worst = useMemo(() => {
    if (!scoredGroups.length) return null
    return scoredGroups.reduce((a, b) => (a.cleanPct <= b.cleanPct ? a : b))
  }, [scoredGroups])

  function selectGroup(key) {
    setSelectedGroup(key === selectedGroup ? null : key)
    setLocationFilter('')
  }

  const drillLocations = useMemo(() => {
    if (!selectedGroup) return []
    let rows = enriched.filter(r => r[groupKey] === selectedGroup && r.status !== 'single')
    if (locationFilter.trim()) {
      const q = locationFilter.trim().toUpperCase()
      rows = rows.filter(r => r.location.toUpperCase().includes(q))
    }
    const dir = sortDir === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      let av, bv
      switch (sortKey) {
        case 'status': av = STATUS_ORDER[a.status]; bv = STATUS_ORDER[b.status]; break
        case 'earliest': av = a.earliest; bv = b.earliest; break
        case 'jdfLp': av = a.jdfLp; bv = b.jdfLp; break
        case 'otherLp': av = a.otherLp; bv = b.otherLp; break
        default: av = a.location; bv = b.location
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    return rows
  }, [enriched, selectedGroup, groupKey, sortKey, sortDir, locationFilter])

  function toggleSort(key) {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  // ── Recent-activity window (employee + aisle raw volume) ──────────────
  const recentByEmployee = useMemo(() => {
    const map = new Map()
    for (const [employee, location, status, ts, lpCode] of employeeEvents) {
      const t = new Date(ts)
      if (t < windowStart || t > now) continue
      if (!map.has(employee)) map.set(employee, { employee, mixedItem: 0, mixedDate: 0, events: [] })
      const e = map.get(employee)
      if (status === 'mixed_item') e.mixedItem += 1
      else e.mixedDate += 1
      e.events.push({ location, status, ts, lpCode })
    }
    return Array.from(map.values())
      .map(e => ({ ...e, total: e.mixedItem + e.mixedDate, events: [...e.events].sort((a, b) => new Date(b.ts) - new Date(a.ts)) }))
      .sort((a, b) => b.total - a.total)
  }, [employeeEvents, windowStart, now])

  const selectedEmployeeData = recentByEmployee.find(e => e.employee === selectedEmployee) || null

  const groupedLocations = useMemo(() => {
    if (!selectedEmployeeData) return []
    const map = new Map()
    for (const ev of selectedEmployeeData.events) {
      if (!map.has(ev.location)) map.set(ev.location, { location: ev.location, moves: [], mixedItem: 0, mixedDate: 0 })
      const g = map.get(ev.location)
      g.moves.push(ev)
      if (ev.status === 'mixed_item') g.mixedItem += 1
      else g.mixedDate += 1
    }
    return Array.from(map.values())
      .map(g => ({
        ...g,
        moves: [...g.moves].sort((a, b) => new Date(b.ts) - new Date(a.ts)),
        latestTs: g.moves.reduce((max, m) => (new Date(m.ts) > new Date(max) ? m.ts : max), g.moves[0].ts),
      }))
      .sort((a, b) => new Date(b.latestTs) - new Date(a.latestTs))
  }, [selectedEmployeeData])

  const recentByAisle = useMemo(() => {
    const mixedMap = new Map()
    for (const [, location, status, ts] of employeeEvents) {
      const t = new Date(ts)
      if (t < windowStart || t > now) continue
      const aisle = location.charAt(2)
      if (!mixedMap.has(aisle)) mixedMap.set(aisle, { mixedItem: 0, mixedDate: 0 })
      const a = mixedMap.get(aisle)
      if (status === 'mixed_item') a.mixedItem += 1
      else a.mixedDate += 1
    }
    const totalMap = new Map()
    for (const [aisle, ts] of allF8Moves) {
      const t = new Date(ts)
      if (t < windowStart || t > now) continue
      totalMap.set(aisle, (totalMap.get(aisle) || 0) + 1)
    }
    const aisles = new Set([...mixedMap.keys(), ...totalMap.keys()])
    return Array.from(aisles)
      .map(aisle => {
        const m = mixedMap.get(aisle) || { mixedItem: 0, mixedDate: 0 }
        const total = totalMap.get(aisle) || 0
        const mixed = m.mixedItem + m.mixedDate
        const clean = Math.max(total - mixed, 0)
        return { aisle, mixedItem: m.mixedItem, mixedDate: m.mixedDate, clean, total: Math.max(total, mixed) }
      })
      .sort((a, b) => b.total - a.total)
  }, [employeeEvents, allF8Moves, windowStart, now])

  const cardStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '12px 16px' }
  const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }
  const valueStyle = { fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 500 }

  if (loading && !data) {
    return <div style={{ padding: 20, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Loading JDF Putaways…</div>
  }

  if (err && !data) {
    return (
      <div style={{ padding: 20, fontFamily: 'var(--font-mono)', fontSize: 12, color: '#e05a5a' }}>
        {err}
        <button className="est-reset-btn" style={{ marginLeft: 10 }} onClick={() => setRefreshTick(t => t + 1)}>Retry</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="section-label" style={{ marginBottom: 4 }}>JDF Putaways — F8 slotting visibility</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 620 }}>
            JDF product only — surfacing where slotting could run tighter, not a scorecard on any one person.
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            {data?.fetchedAt && <span>as of {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
            <button className="est-reset-btn" onClick={() => setRefreshTick(t => t + 1)} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 500, color: 'var(--brand)' }}>{totals.cleanPct}%</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>clean lanes (JDF-only)</div>
        </div>
      </div>

      <div style={{ ...cardStyle, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
        <strong style={{ color: 'var(--text-primary)' }}>About shared lanes:</strong> in the 7-deep drive-in racks (A, G, H),
        placing a slower-moving customer's pallets behind faster JDF movers is a deliberate way to use full lane depth —
        it isn't counted against JDF here. The 2-deep aisles (B–F) don't have that depth to backfill, so sharing there
        is rare and worth a second look when it shows up.
      </div>

      <div className="cal2-tab-row">
        <button className={`cal2-tab${groupBy === 'aisle' ? ' active' : ''}`} onClick={() => { setGroupBy('aisle'); setSelectedGroup(null) }}>By aisle</button>
        <button className={`cal2-tab${groupBy === 'rackGroup' ? ' active' : ''}`} onClick={() => { setGroupBy('rackGroup'); setSelectedGroup(null) }}>By rack type</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <div style={{ ...cardStyle, borderTop: '2px solid var(--green)' }}>
          <div style={labelStyle}>Clean</div>
          <div style={{ ...valueStyle, color: 'var(--green)' }}>{totals.clean}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>locations</div>
        </div>
        <div style={{ ...cardStyle, borderTop: '2px solid var(--yellow)' }}>
          <div style={labelStyle}>Mixed date</div>
          <div style={{ ...valueStyle, color: 'var(--yellow)' }}>{totals.mixedDate}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>same SKU, diff mfg</div>
        </div>
        <div style={{ ...cardStyle, borderTop: '2px solid var(--red)' }}>
          <div style={labelStyle}>Mixed item</div>
          <div style={{ ...valueStyle, color: 'var(--red)' }}>{totals.mixedItem}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>diff SKUs, one slot</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Avg pallets/lane</div>
          <div style={valueStyle}>{totals.avgLanePallets}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>7-deep aisles — utilization</div>
        </div>
      </div>

      {worst && (
        <div style={{ ...cardStyle, marginBottom: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          {groupBy === 'aisle' ? 'Aisle' : 'Rack type'} <strong style={{ color: 'var(--text-primary)' }}>{worst.key}</strong> ({worst.rackType}) has
          the lowest clean rate at <strong style={{ color: 'var(--text-primary)' }}>{worst.cleanPct}%</strong> — that's JDF's own
          SKU/date discipline, unrelated to lane sharing.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
        {scoredGroups.map(g => {
          const maxTotal = scoredGroups.reduce((m, x) => Math.max(m, x.multi), 1)
          return (
            <div key={g.key} onClick={() => selectGroup(g.key)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <div style={{ width: 90, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>
                {groupBy === 'aisle' ? `Aisle ${g.key}` : g.key}
              </div>
              <div style={{ flex: 1, display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', background: 'var(--bg3)' }}>
                <div style={{ width: `${(g.clean / maxTotal) * 100}%`, background: 'var(--green)' }} title={`${g.clean} clean`} />
                <div style={{ width: `${(g.mixedDate / maxTotal) * 100}%`, background: 'var(--yellow)' }} title={`${g.mixedDate} mixed date`} />
                <div style={{ width: `${(g.mixedItem / maxTotal) * 100}%`, background: 'var(--red)' }} title={`${g.mixedItem} mixed item`} />
              </div>
              <div style={{ width: 30, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0 }}>{g.multi}</div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginBottom: 16 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--green)', marginRight: 4, borderRadius: 2 }} />Clean</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--yellow)', marginRight: 4, borderRadius: 2 }} />Mixed date</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', marginRight: 4, borderRadius: 2 }} />Mixed SKU</span>
        <span style={{ fontStyle: 'italic' }}>Click a bar to drill into locations</span>
      </div>

      {selectedGroup && (
        <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'var(--bg2)', padding: '8px 12px' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
              {groupBy === 'aisle' ? 'Aisle' : 'Rack type'} {selectedGroup} · {drillLocations.length} of{' '}
              {enriched.filter(r => r[groupKey] === selectedGroup && r.status !== 'single').length} multi-pallet locations
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="text" value={locationFilter} onChange={e => setLocationFilter(e.target.value)}
                placeholder="Filter location, e.g. A01"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', width: 150, background: 'var(--bg1)' }}
              />
              <button className="est-reset-btn" onClick={() => setSelectedGroup(null)}>Close</button>
            </div>
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="hourly-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => toggleSort('location')}>
                    Location {sortKey === 'location' && (sortDir === 'asc' ? '▲' : '▼')}
                  </th>
                  <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => toggleSort('status')}>
                    Status {sortKey === 'status' && (sortDir === 'asc' ? '▲' : '▼')}
                  </th>
                  <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => toggleSort('earliest')}>
                    Mfg date range {sortKey === 'earliest' && (sortDir === 'asc' ? '▲' : '▼')}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('jdfLp')}>
                    JDF LPs {sortKey === 'jdfLp' && (sortDir === 'asc' ? '▲' : '▼')}
                  </th>
                  <th style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => toggleSort('otherLp')}>
                    Co-shared with {sortKey === 'otherLp' && (sortDir === 'asc' ? '▲' : '▼')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {drillLocations.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>No locations match "{locationFilter}"</td></tr>
                )}
                {drillLocations.map(r => (
                  <tr key={r.location}>
                    <td style={{ textAlign: 'left', fontWeight: 600 }}>{r.location}</td>
                    <td style={{ textAlign: 'left', color: r.status === 'clean' ? 'var(--green)' : r.status === 'mixed_date' ? 'var(--yellow)' : 'var(--red)' }}>
                      {r.status === 'clean' ? 'Clean' : r.status === 'mixed_date' ? 'Mixed date' : 'Mixed SKU'}
                    </td>
                    <td style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>{r.earliest === r.latest ? r.earliest : `${r.earliest} → ${r.latest}`}</td>
                    <td>{r.jdfLp}</td>
                    <td style={{ textAlign: 'left' }}>
                      {r.isShared
                        ? <span style={{ color: 'var(--blue)' }}>{r.otherCustomers.map(c => customerNames[c] || c).join(', ')} ({r.otherLp})</span>
                        : <span style={{ color: 'var(--text-dim)' }}>JDF only</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Raw volume by employee ─────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="section-label" style={{ marginBottom: 4 }}>Raw volume by employee</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>{windowLabel(now)}</div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
          Mixed-slot pallets moved into their current F8 location, traced to whoever performed the last move. Raw count,
          not a rate against how much volume each person handles — a busier mover will naturally show up more.
        </div>
        {recentByEmployee.length === 0 ? (
          <div style={{ ...cardStyle, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>No mixed-slot moves recorded in this window.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recentByEmployee.map(e => {
              const maxTotal = recentByEmployee[0].total || 1
              const isSel = selectedEmployee === e.employee
              return (
                <div
                  key={e.employee}
                  onClick={() => { setSelectedEmployee(isSel ? null : e.employee); setSelectedLocation(null) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '2px 4px', borderRadius: 4, background: isSel ? 'var(--bg3)' : 'transparent' }}
                >
                  <div style={{ width: 100, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>{e.employee}</div>
                  <div style={{ flex: 1, display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', background: 'var(--bg3)' }}>
                    <div style={{ width: `${(e.mixedItem / maxTotal) * 100}%`, background: '#e57373' }} title={`${e.mixedItem} mixed item`} />
                    <div style={{ width: `${(e.mixedDate / maxTotal) * 100}%`, background: '#f0c14b' }} title={`${e.mixedDate} mixed date`} />
                  </div>
                  <div style={{ width: 26, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0 }}>{e.total}</div>
                </div>
              )
            })}
          </div>
        )}

        {selectedEmployeeData && (
          <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg2)', padding: '6px 12px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {selectedEmployeeData.employee} · {groupedLocations.length} location{groupedLocations.length === 1 ? '' : 's'} ({selectedEmployeeData.events.length} moves)
              </span>
              <button className="est-reset-btn" onClick={() => setSelectedEmployee(null)}>Close</button>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table className="hourly-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Location</th>
                    <th style={{ textAlign: 'left' }}>Type</th>
                    <th>Moves</th>
                    <th style={{ textAlign: 'left' }}>Latest</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedLocations.map((g, i) => {
                    const isLocSel = selectedLocation === g.location
                    const detail = locationItemDetail[g.location]
                    const typeLabel = g.mixedItem > 0 && g.mixedDate > 0 ? 'SKU + date' : g.mixedItem > 0 ? 'Mixed SKU' : 'Mixed date'
                    return (
                      <Fragment key={i}>
                        <tr onClick={() => setSelectedLocation(isLocSel ? null : g.location)} style={{ cursor: 'pointer', background: isLocSel ? 'var(--bg3)' : undefined }}>
                          <td style={{ textAlign: 'left', fontWeight: 600 }}>{g.location}</td>
                          <td style={{ textAlign: 'left', color: g.mixedItem > 0 ? 'var(--red)' : 'var(--yellow)' }}>{typeLabel}</td>
                          <td>{g.moves.length}</td>
                          <td style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                            {new Date(g.latestTs).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </td>
                        </tr>
                        {isLocSel && (
                          <tr>
                            <td colSpan={4} style={{ background: 'var(--bg2)' }}>
                              <div style={{ padding: '6px 4px', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                                <div style={{ color: 'var(--text-dim)', marginBottom: 6 }}>
                                  {g.moves.map((m, k) => (
                                    <span key={k} style={{ marginRight: 12 }}>
                                      {new Date(m.ts).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                      {' · '}{m.lpCode}
                                    </span>
                                  ))}
                                </div>
                                {!detail ? (
                                  <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>No item detail on file for this location (may no longer be mixed).</div>
                                ) : (
                                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                      <tr style={{ color: 'var(--text-dim)' }}>
                                        <th style={{ textAlign: 'left', padding: '2px 6px' }}>Material</th>
                                        <th style={{ textAlign: 'left', padding: '2px 6px' }}>Description</th>
                                        <th style={{ textAlign: 'left', padding: '2px 6px' }}>Mfg date</th>
                                        <th style={{ textAlign: 'right', padding: '2px 6px' }}>LPs</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.map(([mat, date, cnt], j) => (
                                        <tr key={j}>
                                          <td style={{ padding: '2px 6px', fontWeight: 600 }}>{mat}</td>
                                          <td style={{ padding: '2px 6px', color: 'var(--text-secondary)' }}>{materialNames[mat] || '—'}</td>
                                          <td style={{ padding: '2px 6px', color: 'var(--text-secondary)' }}>{date}</td>
                                          <td style={{ padding: '2px 6px', textAlign: 'right' }}>{cnt}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginTop: 8 }}>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#e57373', marginRight: 4, borderRadius: 2 }} />Mixed SKU</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#f0c14b', marginRight: 4, borderRadius: 2 }} />Mixed man date</span>
        </div>
      </div>

      {/* ── Raw pallets per aisle ───────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="section-label" style={{ marginBottom: 4 }}>Raw pallets per aisle</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>{windowLabel(now)}</div>
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
          All F8 JDF pallet moves in this window, grouped by aisle — clean landings alongside the mixed-slot moves from
          above, so you can see volume and hit-rate together.
        </div>
        {recentByAisle.length === 0 ? (
          <div style={{ ...cardStyle, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>No pallet moves recorded in this window.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recentByAisle.map(a => {
              const maxTotal = recentByAisle[0].total || 1
              return (
                <div key={a.aisle} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 100, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>Aisle {a.aisle}</div>
                  <div style={{ flex: 1, display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', background: 'var(--bg3)' }}>
                    <div style={{ width: `${(a.clean / maxTotal) * 100}%`, background: 'var(--green)' }} title={`${a.clean} clean`} />
                    <div style={{ width: `${(a.mixedItem / maxTotal) * 100}%`, background: '#e57373' }} title={`${a.mixedItem} mixed item`} />
                    <div style={{ width: `${(a.mixedDate / maxTotal) * 100}%`, background: '#f0c14b' }} title={`${a.mixedDate} mixed date`} />
                  </div>
                  <div style={{ width: 26, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0 }}>{a.total}</div>
                </div>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginTop: 8 }}>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--green)', marginRight: 4, borderRadius: 2 }} />Clean</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#e57373', marginRight: 4, borderRadius: 2 }} />Mixed SKU</span>
          <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#f0c14b', marginRight: 4, borderRadius: 2 }} />Mixed man date</span>
        </div>
      </div>
    </div>
  )
}
