import { useMemo, useState, useEffect, Fragment } from 'react'
import { RACK_TYPE, RACK_GROUP, CUSTOMER_NAMES } from '../lib/jdfPutawaysLocations.js'
import { fetchJdfPutaways } from '../lib/jdfPutaways.js'
import { pct, classifyLocation, getWindowStart, windowLabel } from '../lib/jdfPutawaysLogic.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'
import JdfLpLocator from './JdfLpLocator.jsx'
import JdfSameItemReference from './JdfSameItemReference.jsx'

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
//
// ── 2026-08-11 redesign: Daily Putaway Scorecard + Building-Wide baseline ──
// Replaced the single "clean lanes %" headline with four cards per Dan's
// ops-accountability project: same item/same tier as the baseline (daily +
// building-wide), plus "also same MAN date" as a second, stricter layer
// (the FEFO/pick-efficiency number). Data comes from the SAME
// motherduck-jdf-putaways.cjs payload as everything else on this tab (new
// dailyScorecard/buildingWide keys -- see that file's 2026-08-11 header
// note), so these numbers can never drift from the aisle/rack-type
// breakdown below -- same underlying loc_class classification throughout.
// Daily was originally "yesterday," not "today" -- a same-day pull is
// mostly still sitting in receiving (validated live: 16 of 109 same-day
// vs. 120 of 143 the next day). CHANGED 2026-08-12 per Dan's explicit call:
// shows today instead, with a "still in receiving/staging" count called out
// directly on the card so the incompleteness is visible instead of hidden
// behind a one-day lag. See motherduck-jdf-putaways.cjs's 2026-08-12 header
// note for the stillStaged/totalReceived field definitions.
//
// Notify settings (2026-08-11): reuses the same NotifySettingsPanel shared
// component every other digest in this app already uses -- M-F day
// toggles, configurable send time, Enabled checkbox, Front conversation ID,
// "Send test digest now" -- backed by prepick_notify_settings
// (facility='mad', dashboard_type='jdf_putaway_scorecard'). See
// lib/jdf-scorecard-digest-shared.cjs for the digest itself.
//
// JDF LP Locator (2026-08-13): a repeatable, printable "where is every
// pallet of material X right now" tool, added directly into this tab (not
// a separate top-level tab, per Dan's explicit placement request) right
// below the Notify panel. See src/components/JdfLpLocator.jsx for the
// component itself -- backed by its own function
// (motherduck-jdf-lp-locations.cjs) since it answers a JDF-wide question
// (any location, not just F8) rather than reusing this tab's F8-scoped
// onhand data.
//
// JDF Same-Item Reference table (2026-08-13, same day): live version of
// the ad hoc "Rank / SKU / Description / Active LPs / % Same Item" table
// built in chat earlier this project, added to the very bottom of the tab
// per Dan's ask ("so I have a reference"). See
// src/components/JdfSameItemReference.jsx -- reuses the same
// motherduck-jdf-lp-locations.cjs picklist-mode call as JdfLpLocator (that
// response gained a `referenceTable` field), so this is a second
// independent fetch of a fast/cheap query rather than a new endpoint.

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

  const daily = data?.dailyScorecard ?? { date: null, totalReceived: 0, putAway: 0, stillStaged: 0, sameItemTier: 0, sameItemTierDate: 0 }
  const building = data?.buildingWide ?? { totalActive: 0, sameItemTier: 0, sameItemTierDate: 0 }
  const dailyMixed = daily.putAway - daily.sameItemTier
  const buildingMixed = building.totalActive - building.sameItemTier
  const dailyDateLabel = daily.date
    ? new Date(`${daily.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    : '—'

  const scoreCardStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '14px 18px' }
  const scoreLabelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }
  const scoreValueStyle = { fontFamily: 'var(--font-mono)', fontSize: 32, fontWeight: 600, lineHeight: 1 }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div className="section-label" style={{ marginBottom: 4 }}>JDF Putaways — Same Item, Same Tier</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 640 }}>
          Same item, same tier. Two numbers: how the team is executing today, and where the whole building stands right now.
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          {data?.fetchedAt && <span>as of {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
          <button className="est-reset-btn" onClick={() => setRefreshTick(t => t + 1)} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
      </div>

      {/* ── Row 1: baseline — Daily Putaway Score + Building-Wide Same Item/Tier ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ ...scoreCardStyle, borderTop: '2px solid var(--brand)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={scoreLabelStyle}>Daily Putaway Score — {dailyDateLabel}</div>
              <div style={{ ...scoreValueStyle, color: 'var(--brand)' }}>{pct(daily.sameItemTier, daily.putAway)}%</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>same item/tier of pallets put away</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>{daily.totalReceived} received</div>
              <div>{daily.putAway} put away</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
            <div>
              <span style={{ color: 'var(--green)', fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{daily.sameItemTier}</span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 6 }}>correct</span>
            </div>
            <div>
              <span style={{ color: 'var(--red)', fontSize: 18, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{dailyMixed}</span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 6 }}>mixed</span>
            </div>
          </div>
          {daily.stillStaged > 0 && (
            <div style={{
              marginTop: 12, padding: '6px 10px', borderRadius: 6, background: 'var(--bg3)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>still in receiving / staging — not yet put away</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--yellow)' }}>{daily.stillStaged}</span>
            </div>
          )}
        </div>

        <div style={{ ...scoreCardStyle, borderTop: '2px solid var(--green)' }}>
          <div style={scoreLabelStyle}>Building-Wide Same Item / Tier</div>
          <div style={{ ...scoreValueStyle, color: 'var(--green)' }}>{pct(building.sameItemTier, building.totalActive)}%</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, marginBottom: 14 }}>all active pallets, regardless of receipt date</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Total active pallets</span><strong style={{ color: 'var(--text-primary)' }}>{building.totalActive}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Same item / tier</span><strong style={{ color: 'var(--green)' }}>{building.sameItemTier}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Mixed</span><strong style={{ color: 'var(--red)' }}>{buildingMixed}</strong>
            </div>
          </div>
        </div>
      </div>

      {/* ── Row 2: layer — also same MAN date (FEFO/pick-efficiency layer) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ ...scoreCardStyle, borderTop: '2px solid var(--blue)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={scoreLabelStyle}>Daily — Also Same MAN Date</div>
              <div style={{ ...scoreValueStyle, color: 'var(--blue)' }}>{pct(daily.sameItemTierDate, daily.putAway)}%</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>of all pallets put away {dailyDateLabel}</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>{daily.putAway} put away{daily.stillStaged > 0 ? ` (${daily.stillStaged} staged)` : ''}</div>
              <div>{daily.sameItemTier} same item/tier</div>
              <div style={{ color: 'var(--blue)' }}>{daily.sameItemTierDate} also same date</div>
            </div>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 10 }}>
            {daily.sameItemTierDate} of the {daily.sameItemTier} same item/tier pallets
            ({pct(daily.sameItemTierDate, daily.sameItemTier)}%) also share a MAN date — this is where FEFO pick efficiency actually comes from.
          </div>
        </div>

        <div style={{ ...scoreCardStyle, borderTop: '2px solid var(--blue)' }}>
          <div style={scoreLabelStyle}>Building-Wide — Also Same MAN Date</div>
          <div style={{ ...scoreValueStyle, color: 'var(--blue)' }}>{pct(building.sameItemTierDate, building.totalActive)}%</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, marginBottom: 14 }}>of all active pallets, regardless of receipt date</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Same item / tier</span><strong style={{ color: 'var(--text-primary)' }}>{building.sameItemTier}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Also same MAN date</span><strong style={{ color: 'var(--blue)' }}>{building.sameItemTierDate}</strong>
            </div>
          </div>
        </div>
      </div>

      <NotifySettingsPanel
        facility="mad"
        dashboardType="jdf_putaway_scorecard"
        functionName="jdf-scorecard-digest-test"
        contentDateLabel="today"
        showSkipToNextValidDay={false}
        digestDescription="Posts the Daily Putaway Scorecard (same item/tier + also same MAN date, plus a still-staged count) and the Building-Wide baseline as a Front comment."
      />

      <JdfLpLocator />

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

      <JdfSameItemReference />
    </div>
  )
}
