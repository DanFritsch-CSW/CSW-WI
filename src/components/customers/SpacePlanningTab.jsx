import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  FACILITY_DOTS, FACILITY_NAMES, FACILITIES, PHASE3_FACILITIES,
  ZONES, utilBand, facilityCapacity, facilityActual, facilityUtil,
  networkCapacity, networkActual, networkUtil, isFacilityLive,
  fmtInt, fmtPct, fmtTime,
  fetchSpaceRooms, fetchSpaceCustomerPositions, fetchLiveActualsPerFacility,
  fetchLivePerRoomActuals, fetchLivePerRoomProjectBreakdown, updateRoomCapacity,
  fetchCustomerStacking, addCustomerStacking, updateCustomerStacking, deleteCustomerStacking,
  fetchKnownCustomersForFacility,
  updateRoomAisle, addRoomAisle, deleteRoomAisle, aislePositionsRange,
  fetchAislesForRooms, roomAislePositions,
  fetchLivePerAisleOccupancy,
  fetchMaterialStacking,
  computeEffectiveRoomOccupancy,
  computeEffectiveAisleOccupancy,
  fetchRoomAisleDatexMapping,
} from '../../lib/spacePlanning.js'
import { AisleOccupancyPanel, MaterialStackingSubsection } from './SpaceStackingExceptions.jsx'

// Phase 2 — Network/ALL view is read-only.
// Phase 2.5 — Network/ALL view actuals come from live Datex LP counts when
//   available, falling back to seeded Supabase fixtures per-facility on Omni
//   failure. The seeded path was the entire data source in Phase 2; it now
//   serves as graceful degradation.
// Phase 3 (single-facility view) — currently MAD-only. Per-room LP counts
//   come from netlify/functions/space-per-room via fetchLivePerRoomActuals.
//   Rooms are joined by space_rooms.datex_top_location_id → the top-level
//   Datex location container. Other facilities still show the deferred
//   placeholder until their room lists get seeded.
export default function SpacePlanningTab() {
  const [facility, setFacility] = useState('all')
  const [rooms, setRooms] = useState([])
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Phase 2.5 — live Datex actuals. Independent fetch lifecycle from Supabase
  // (Supabase is fast + stable; Omni is slow + occasionally times out) so a
  // slow Omni doesn't block the screen render.
  const [live, setLive] = useState(null)         // { totals, errors, fetchedAt, ok } | null
  const [liveLoading, setLiveLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([fetchSpaceRooms(), fetchSpaceCustomerPositions()])
      .then(([r, p]) => {
        if (cancelled) return
        setRooms(r)
        setPositions(p)
        setError(null)
      })
      .catch(err => {
        if (cancelled) return
        console.error('SpacePlanningTab Supabase load:', err)
        setError(err?.message || 'Failed to load space data')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLiveLoading(true)
    fetchLiveActualsPerFacility()
      .then(result => { if (!cancelled) setLive(result) })
      .catch(err => {
        if (cancelled) return
        // Total failure (shouldn't happen — Promise.allSettled inside the
        // helper absorbs per-facility errors). Treat as no-live-data.
        console.warn('fetchLiveActualsPerFacility unexpected error:', err)
        setLive({ totals: {}, errors: [{ facility: 'all', message: err?.message || 'unknown' }], fetchedAt: new Date().toISOString(), ok: false })
      })
      .finally(() => { if (!cancelled) setLiveLoading(false) })
    return () => { cancelled = true }
  }, [])

  const liveTotals = live?.totals || null

  return (
    <div>
      <FacilityTabStrip active={facility} onChange={setFacility} />
      <div style={{ marginTop: 20 }}>
        {loading && <LoadingState />}
        {error && !loading && <ErrorState error={error} />}
        {!loading && !error && facility === 'all' && (
          <NetworkView
            rooms={rooms}
            positions={positions}
            liveTotals={liveTotals}
            live={live}
            liveLoading={liveLoading}
            onFacilityClick={setFacility}
          />
        )}
        {!loading && !error && facility !== 'all' && PHASE3_FACILITIES.has(facility) && (
          <FacilityRoomView
            facility={facility}
            rooms={rooms}
            onRoomUpdated={(roomId, patch) => {
              setRooms(prev => prev.map(r => r.id === roomId ? { ...r, ...patch } : r))
            }}
          />
        )}
        {!loading && !error && facility !== 'all' && !PHASE3_FACILITIES.has(facility) && (
          <FacilityPlaceholder facility={facility} />
        )}
      </div>
    </div>
  )
}

function FacilityTabStrip({ active, onChange }) {
  const tabs = [{ id: 'all', label: 'ALL', dot: null }].concat(
    FACILITIES.map(id => ({ id, label: id.toUpperCase(), dot: FACILITY_DOTS[id] }))
  )
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {tabs.map(t => {
        const isActive = t.id === active
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              border: `1px solid ${isActive ? 'var(--brand, #a07818)' : 'var(--border)'}`,
              background: isActive ? 'var(--brand-bg, #fef9ec)' : 'var(--bg1, #fff)',
              borderRadius: 'var(--r-md, 8px)',
              color: isActive ? 'var(--brand, #a07818)' : 'var(--text-secondary)',
              fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t.dot && (
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: t.dot, display: 'inline-block',
              }} />
            )}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function NetworkView({ rooms, positions, liveTotals, live, liveLoading, onFacilityClick }) {
  const cap  = useMemo(() => networkCapacity(rooms),                    [rooms])
  const act  = useMemo(() => networkActual(positions, liveTotals),      [positions, liveTotals])
  const util = useMemo(() => networkUtil(rooms, positions, liveTotals), [rooms, positions, liveTotals])
  const band = utilBand(util)
  const facilityCount = new Set(rooms.map(r => r.facility)).size

  // Live-data state for the badge: counts of facilities reading live vs seeded.
  const liveCount = liveTotals ? Object.keys(liveTotals).length : 0
  const seededCount = FACILITIES.length - liveCount
  const hasErrors = live?.errors?.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Data freshness banner */}
      <DataFreshnessBanner
        live={live}
        liveLoading={liveLoading}
        liveCount={liveCount}
        seededCount={seededCount}
        hasErrors={hasErrors}
      />

      {/* Network summary 3 cells (no forecast — Phase 2 decision) */}
      <SummaryRow>
        <SummaryCell label="NETWORK CAPACITY"    value={fmtInt(cap)}  sub="pallet positions" />
        <SummaryCell label="ACTUAL POSITIONS"    value={fmtInt(act)}  sub={`across ${facilityCount} facilities`} />
        <SummaryCell label="NETWORK UTILIZATION" value={fmtPct(util)} sub={null} valueColor={band.color} />
      </SummaryRow>

      {/* Facility scorecards */}
      <div>
        <SectionLabel>FACILITIES</SectionLabel>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
          marginTop: 10,
        }}>
          {FACILITIES.map(facId => (
            <FacilityScorecard
              key={facId}
              facility={facId}
              rooms={rooms}
              positions={positions}
              liveTotals={liveTotals}
              onClick={() => onFacilityClick(facId)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function DataFreshnessBanner({ live, liveLoading, liveCount, seededCount, hasErrors }) {
  // 4 states: loading, all-live, partial, all-seeded.
  if (liveLoading) {
    return (
      <FreshnessRow
        dotColor="var(--text-dim, #9aaabb)"
        primary="Loading live Datex data…"
        secondary={null}
      />
    )
  }
  if (liveCount === FACILITIES.length) {
    return (
      <FreshnessRow
        dotColor="var(--green, #1a8a52)"
        primary="Live from Datex"
        secondary={`Updated ${fmtTime(live?.fetchedAt)} · all ${FACILITIES.length} facilities`}
      />
    )
  }
  if (liveCount > 0) {
    const failed = (live?.errors || []).map(e => e.facility.toUpperCase()).join(', ')
    return (
      <FreshnessRow
        dotColor="var(--orange, #d4824a)"
        primary={`Partial live data · ${liveCount}/${FACILITIES.length} facilities`}
        secondary={`Updated ${fmtTime(live?.fetchedAt)} · seeded fallback for ${failed}`}
      />
    )
  }
  // No live data at all.
  return (
    <FreshnessRow
      dotColor="var(--amber, #a07818)"
      primary="Showing seeded fixtures"
      secondary={hasErrors ? 'Datex unavailable — displaying last known sample data' : 'No live data available'}
    />
  )
}

function FreshnessRow({ dotColor, primary, secondary }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 14px',
      background: 'var(--bg2, #f8f9fb)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md, 8px)',
      fontSize: 12,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: dotColor, display: 'inline-block', flexShrink: 0,
      }} />
      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{primary}</span>
      {secondary && (
        <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
          · {secondary}
        </span>
      )}
    </div>
  )
}

function FacilityScorecard({ facility, rooms, positions, liveTotals, onClick }) {
  const cap  = facilityCapacity(rooms, facility)
  const act  = facilityActual(positions, facility, liveTotals)
  const util = facilityUtil(rooms, positions, facility, liveTotals)
  const band = utilBand(util)
  const dot  = FACILITY_DOTS[facility]
  const name = FACILITY_NAMES[facility]
  const roomCount = rooms.filter(r => r.facility === facility).length
  const isLive = isFacilityLive(facility, liveTotals)
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: 'var(--bg1, #fff)',
        border: '1px solid var(--border)',
        borderTop: `3px solid ${dot}`,
        borderRadius: 'var(--r-lg, 12px)',
        padding: 14,
        cursor: 'pointer',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease',
        font: 'inherit', color: 'inherit',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-1px)'
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.06)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div>
          <div style={{
            fontSize: 11, color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '0.08em',
          }}>
            {facility.toUpperCase()}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>
            {name}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <LiveBadge isLive={isLive} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot }} />
        </div>
      </div>

      <ScorecardRow label="ACTUAL"      value={fmtInt(act)} />
      <ScorecardRow label="CAPACITY"    value={fmtInt(cap)} />
      <ScorecardRow label="UTILIZATION" value={fmtPct(util)} valueColor={band.color} bold />

      <div style={{
        marginTop: 10, paddingTop: 8,
        borderTop: '1px solid var(--border-subtle, #eceff5)',
        fontSize: 10, color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.04em',
      }}>
        {roomCount} {roomCount === 1 ? 'room' : 'rooms'} · click for detail
      </div>
    </button>
  )
}

function LiveBadge({ isLive }) {
  return (
    <span
      title={isLive ? 'Live from Datex' : 'Showing seeded fallback data'}
      style={{
        fontSize: 9,
        padding: '2px 5px',
        borderRadius: 'var(--r-sm, 3px)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.06em',
        fontWeight: 600,
        background: isLive ? 'rgba(26, 138, 82, 0.12)' : 'rgba(160, 120, 24, 0.12)',
        color: isLive ? 'var(--green, #1a8a52)' : 'var(--amber, #a07818)',
        border: `1px solid ${isLive ? 'rgba(26, 138, 82, 0.3)' : 'rgba(160, 120, 24, 0.3)'}`,
      }}
    >
      {isLive ? 'LIVE' : 'SEED'}
    </span>
  )
}

function ScorecardRow({ label, value, valueColor, bold }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      padding: '4px 0',
    }}>
      <span style={{
        fontSize: 10, color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.06em',
      }}>{label}</span>
      <span style={{
        fontSize: bold ? 18 : 14,
        fontWeight: bold ? 600 : 500,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        color: valueColor || 'var(--text-primary)',
      }}>{value}</span>
    </div>
  )
}

function SummaryRow({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap: 12,
    }}>
      {children}
    </div>
  )
}

function SummaryCell({ label, value, sub, valueColor }) {
  return (
    <div style={{
      background: 'var(--bg2, #f8f9fb)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg, 12px)',
      padding: '14px 16px',
    }}>
      <div style={{
        fontSize: 10, color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.08em',
      }}>{label}</div>
      <div style={{
        fontSize: 26, fontWeight: 600,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        marginTop: 4,
        color: valueColor || 'var(--text-primary)',
      }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>
      )}
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10,
      color: 'var(--text-dim)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
    }}>{children}</div>
  )
}

function LoadingState() {
  return (
    <div style={{
      padding: '40px 0', textAlign: 'center',
      color: 'var(--text-secondary)', fontSize: 13,
    }}>
      Loading space data…
    </div>
  )
}

function ErrorState({ error }) {
  return (
    <div className="stub-page">
      <h2>Couldn't load space data</h2>
      <p style={{
        color: 'var(--red, #c0392b)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12,
      }}>
        {error}
      </p>
    </div>
  )
}

function FacilityPlaceholder({ facility }) {
  return (
    <div className="stub-page">
      <h2>{FACILITY_NAMES[facility]} ({facility.toUpperCase()})</h2>
      <p>Single-facility view — heatmap, floor map, per-room utilization table.</p>
      <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8 }}>
        Phase 3 — needs Datex location → room mapping (currently deferred)
      </p>
    </div>
  )
}

// ─── Phase 3: single-facility per-room view (MAD only for now) ─────────────

function FacilityRoomView({ facility, rooms, onRoomUpdated }) {
  const facilityRooms = useMemo(
    () => rooms.filter(r => r.facility === facility),
    [rooms, facility]
  )
  const [liveResult, setLiveResult] = useState(null)   // { byRoomId, total, fetchedAt, elapsedMs, error, source } | null
  const [liveLoading, setLiveLoading] = useState(true)

  // Per-room, per-project drill-down (pallet-equivalent). Independent fetch
  // lifecycle from the room-total query above — this one does a heavier join
  // across licenseplatecontents/lots/materials/projects, so it shouldn't
  // block the room table from rendering its totals first.
  const [breakdown, setBreakdown] = useState(null)     // { byRoomId, fetchedAt, elapsedMs, error, source } | null
  const [breakdownLoading, setBreakdownLoading] = useState(true)
  const [expandedRoomId, setExpandedRoomId] = useState(null)

  // Aisle rack geometry (Phase 4a) — fetched eagerly for every room in the
  // facility on load (not lazily per-expand). Needed up front because room
  // capacity is now computed from aisle data (Dan's catch, 2026-07-24: the
  // room-level Slots × Stack field was pure redundancy once aisles could
  // sum to the real number themselves), and that capacity has to show in
  // the collapsed row, not just inside the expanded drill-down. Datex-derived
  // for bay_count, otherwise manual — not live-refreshed on a timer, since
  // this is config that only changes when the physical racking does.
  const [aislesByRoomId, setAislesByRoomId] = useState(new Map()) // roomId -> aisle rows
  const [aislesLoading, setAislesLoading] = useState(true)

  // Live per-aisle occupancy (Phase 4b, 2026-07-25) — which customers are
  // physically in each aisle right now, by LP count. Visibility only per
  // Dan's scope call: this does NOT feed into capacity math (aisles mix
  // multiple customers, confirmed live — no way to resolve to one number
  // without bay-level tracking). Fetched once per facility, independent
  // lifecycle from geometry (aislesByRoomId) since it's a heavier query.
  const [aisleOccupancy, setAisleOccupancy] = useState(null) // { byAisleLocationId, ... } | null
  const [aisleOccupancyLoading, setAisleOccupancyLoading] = useState(true)

  // Customer stacking rows (Dan's call, 2026-07-25) — fetched here too, in
  // addition to CustomerStackingSection's own copy, so RoomRow can resolve
  // each occupant's stack mode when computing effective room occupancy.
  // Small/cheap read; duplicating it avoids a bigger prop-drilling refactor
  // through CustomerStackingSection, which stays independent.
  const [customerStackingRows, setCustomerStackingRows] = useState([])
  const [customerStackingLoading, setCustomerStackingLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLiveLoading(true)
    fetchLivePerRoomActuals(facility)
      .then(res => { if (!cancelled) setLiveResult(res) })
      .catch(err => {
        if (cancelled) return
        console.warn('fetchLivePerRoomActuals unexpected error:', err)
        setLiveResult({
          byRoomId: new Map(), total: 0,
          fetchedAt: new Date().toISOString(), elapsedMs: 0,
          error: err?.message || 'unknown', source: 'error',
        })
      })
      .finally(() => { if (!cancelled) setLiveLoading(false) })
    return () => { cancelled = true }
  }, [facility])

  useEffect(() => {
    let cancelled = false
    setBreakdownLoading(true)
    setExpandedRoomId(null) // collapse any open drill-down on facility change
    fetchLivePerRoomProjectBreakdown(facility)
      .then(res => { if (!cancelled) setBreakdown(res) })
      .catch(err => {
        if (cancelled) return
        console.warn('fetchLivePerRoomProjectBreakdown unexpected error:', err)
        setBreakdown({
          byRoomId: new Map(),
          fetchedAt: new Date().toISOString(), elapsedMs: 0,
          error: err?.message || 'unknown', source: 'error',
        })
      })
      .finally(() => { if (!cancelled) setBreakdownLoading(false) })
    return () => { cancelled = true }
  }, [facility])

  // Fetches aisle geometry for every room in this facility in one query,
  // whenever the room list changes (facility switch, or initial load).
  useEffect(() => {
    let cancelled = false
    if (facilityRooms.length === 0) {
      setAislesByRoomId(new Map())
      setAislesLoading(false)
      return
    }
    setAislesLoading(true)
    fetchAislesForRooms(facilityRooms.map(r => r.id))
      .then(map => { if (!cancelled) setAislesByRoomId(map) })
      .catch(err => {
        if (cancelled) return
        console.warn('fetchAislesForRooms unexpected error:', err)
        setAislesByRoomId(new Map())
      })
      .finally(() => { if (!cancelled) setAislesLoading(false) })
    return () => { cancelled = true }
  }, [facilityRooms])

  useEffect(() => {
    let cancelled = false
    setAisleOccupancyLoading(true)
    fetchLivePerAisleOccupancy(facility)
      .then(res => { if (!cancelled) setAisleOccupancy(res) })
      .catch(err => {
        if (cancelled) return
        console.warn('fetchLivePerAisleOccupancy unexpected error:', err)
        setAisleOccupancy({
          byAisleLocationId: new Map(),
          fetchedAt: new Date().toISOString(), elapsedMs: 0,
          error: err?.message || 'unknown', source: 'error',
        })
      })
      .finally(() => { if (!cancelled) setAisleOccupancyLoading(false) })
    return () => { cancelled = true }
  }, [facility])

  useEffect(() => {
    let cancelled = false
    setCustomerStackingLoading(true)
    fetchCustomerStacking(facility)
      .then(data => { if (!cancelled) setCustomerStackingRows(data) })
      .catch(err => {
        if (cancelled) return
        console.warn('fetchCustomerStacking (FacilityRoomView) unexpected error:', err)
      })
      .finally(() => { if (!cancelled) setCustomerStackingLoading(false) })
    return () => { cancelled = true }
  }, [facility])

  // Attach live LP count to each seeded room row. Rooms without a
  // datex_top_location_id show '—' for live LPs.
  const rows = useMemo(() => {
    const byId = liveResult?.byRoomId || new Map()
    return facilityRooms.map(r => ({
      ...r,
      live_lps: r.datex_top_location_id != null
        ? (byId.get(Number(r.datex_top_location_id)) ?? null)
        : null,
    })).sort((a, b) => {
      // Sort desc by live_lps, nulls last
      const av = a.live_lps ?? -1
      const bv = b.live_lps ?? -1
      return bv - av
    })
  }, [facilityRooms, liveResult])

  const total = liveResult?.total ?? 0
  const isLive = liveResult?.source === 'live' && !liveResult?.error
  const dot = FACILITY_DOTS[facility]
  const name = FACILITY_NAMES[facility]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: dot }} />
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
            {name} ({facility.toUpperCase()})
          </h2>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Per-room live inventory
        </span>
      </div>

      {/* Freshness banner */}
      <PerRoomFreshnessBanner
        liveLoading={liveLoading}
        liveResult={liveResult}
      />

      {/* Summary cell */}
      <SummaryRow>
        <SummaryCell
          label="TOTAL ACTIVE LPs"
          value={liveLoading ? '…' : fmtInt(total)}
          sub={`across ${facilityRooms.length} rooms`}
        />
        <SummaryCell
          label="LIVE STATUS"
          value={liveLoading ? 'LOADING' : (isLive ? 'LIVE' : 'OFFLINE')}
          sub={liveResult ? `Updated ${fmtTime(liveResult.fetchedAt)}` : null}
          valueColor={
            liveLoading ? 'var(--text-dim)'
              : isLive ? 'var(--green, #1a8a52)'
              : 'var(--red, #c0392b)'
          }
        />
      </SummaryRow>

      {/* Per-room table */}
      <div>
        <SectionLabel>ROOMS</SectionLabel>
        <RoomTable
          rows={rows}
          liveLoading={liveLoading}
          isLive={isLive}
          facility={facility}
          onRoomUpdated={onRoomUpdated}
          breakdown={breakdown}
          breakdownLoading={breakdownLoading}
          expandedRoomId={expandedRoomId}
          onToggleExpand={roomId => setExpandedRoomId(prev => prev === roomId ? null : roomId)}
          aislesByRoomId={aislesByRoomId}
          aislesLoading={aislesLoading}
          aisleOccupancy={aisleOccupancy}
          aisleOccupancyLoading={aisleOccupancyLoading}
          customerStackingRows={customerStackingRows}
          customerStackingLoading={customerStackingLoading}
          onAislesChanged={(roomId, nextAisles) => {
            setAislesByRoomId(prev => new Map(prev).set(roomId, nextAisles))
          }}
        />
      </div>

      {/* Footnote about counting semantics */}
      <div style={{
        fontSize: 11, color: 'var(--text-dim)',
        padding: '10px 12px',
        background: 'var(--bg2, #f8f9fb)',
        border: '1px solid var(--border-subtle, #eceff5)',
        borderRadius: 'var(--r-md, 8px)',
        lineHeight: 1.5,
      }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Note on counts:</strong>{' '}
        Per-room count is the physical active LP total (all non-archived license plates
        in each room, warehouse-scoped). The Network scorecard uses a project-joined
        count that filters out internal/unassigned LPs, so the two totals will differ.
        Once a room has aisle rack geometry configured, its capacity is a single fixed
        number — the single-stack floor summed from its aisles — true regardless of who's
        stored where. Utilization is adjusted instead: an occupant's LPs only count as
        half a position when they're BOTH physically sitting in an aisle whose rack can
        double-stack AND that occupant is flagged double-stack in Customer Stacking Notes
        below — a double-stack-capable customer whose product lands in a single-stack
        aisle gets no credit there, since the rack can't support it regardless of what
        their product could do elsewhere. Unmatched or unmapped customers count 1:1
        (conservative — never assumes double-stacking it can't confirm). This is
        customer-level only; material-level exceptions aren't factored into this specific
        calculation yet. Rooms without aisle geometry yet still use a manual Slots × Stack
        entry (click to edit) as a placeholder until they're characterized. Click a room's
        name to see which projects are occupying it right now and how many LPs each holds,
        plus its aisle rack geometry (bays × deep × tiers × max stack per tier — manual
        config except bay count, which is live-derivable from Datex, and each aisle's own
        UTIL — the same stacking-adjusted concept, scoped to just that aisle). Click an
        aisle's label to see which customers are physically in it right now.
      </div>

      {/* Customer stacking reference — manual, not tied to a specific room */}
      <CustomerStackingSection facility={facility} />
    </div>
  )
}

// Manual reference list: which customers double-stack vs single-stack.
// Not tied to a room (general per-customer note). Datex has no data to derive
// this automatically — see comment on fetchCustomerStacking in spacePlanning.js.
function CustomerStackingSection({ facility }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Material-level stacking exceptions (Phase 4b, 2026-07-25) — layered on
  // top of the customer-level default above. Fetched once per facility (not
  // per-customer) since the table is small by design (only real exceptions
  // Dan enters, no seeding), then grouped client-side by customer_name.
  const [materialRows, setMaterialRows] = useState([])
  const [materialsLoading, setMaterialsLoading] = useState(true)
  const materialsByCustomer = useMemo(() => {
    const map = new Map()
    for (const m of materialRows) {
      const list = map.get(m.customer_name) || []
      list.push(m)
      map.set(m.customer_name, list)
    }
    return map
  }, [materialRows])

  // Live customer/project list for the dropdown — same source as the Network
  // scorecard, so names always match real Datex projects. status: 'loading' |
  // 'ready' | 'error'. 'error' triggers a manual-text fallback in the add row.
  const [customerOptions, setCustomerOptions] = useState({ status: 'loading', options: [] })

  const load = () => {
    setLoading(true)
    fetchCustomerStacking(facility)
      .then(data => { setRows(data); setError(null) })
      .catch(err => setError(err?.message || 'Failed to load'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [facility])

  useEffect(() => {
    let cancelled = false
    setMaterialsLoading(true)
    fetchMaterialStacking(facility)
      .then(data => { if (!cancelled) setMaterialRows(data) })
      .catch(err => {
        if (cancelled) return
        console.warn('fetchMaterialStacking unexpected error:', err)
      })
      .finally(() => { if (!cancelled) setMaterialsLoading(false) })
    return () => { cancelled = true }
  }, [facility])

  useEffect(() => {
    let cancelled = false
    setCustomerOptions({ status: 'loading', options: [] })
    fetchKnownCustomersForFacility(facility).then(list => {
      if (cancelled) return
      setCustomerOptions(list == null ? { status: 'error', options: [] } : { status: 'ready', options: list })
    })
    return () => { cancelled = true }
  }, [facility])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <SectionLabel>CUSTOMER STACKING NOTES</SectionLabel>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Manual reference — not tied to a room</span>
      </div>
      <div style={{
        marginTop: 6,
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md, 8px)',
        overflow: 'hidden',
        background: 'var(--bg1, #fff)',
      }}>
        {loading && (
          <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
            Loading…
          </div>
        )}
        {error && !loading && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--red, #c0392b)' }}>{error}</div>
        )}
        {!loading && !error && (
          <>
            {rows.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
                No entries yet — add a customer below.
              </div>
            )}
            {rows.map(row => (
              <StackingRow
                key={row.id}
                row={row}
                facility={facility}
                materials={materialsByCustomer.get(row.customer_name) || []}
                materialsLoading={materialsLoading}
                onMaterialsChanged={nextList => {
                  setMaterialRows(prev => [
                    ...prev.filter(m => m.customer_name !== row.customer_name),
                    ...nextList,
                  ])
                }}
                onUpdated={updated => setRows(prev => prev.map(r => r.id === updated.id ? updated : r))}
                onDeleted={id => setRows(prev => prev.filter(r => r.id !== id))}
              />
            ))}
            <StackingAddRow
              facility={facility}
              existingNames={rows.map(r => r.customer_name.toLowerCase())}
              customerOptions={customerOptions}
              onAdded={row => setRows(prev => [...prev, row].sort((a, b) => a.customer_name.localeCompare(b.customer_name)))}
            />
          </>
        )}
      </div>
    </div>
  )
}

export function StackModeBadge({ mode }) {
  const isDouble = mode === 'double'
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
      padding: '2px 7px', borderRadius: 'var(--r-sm, 3px)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      background: isDouble ? 'rgba(42, 114, 184, 0.12)' : 'rgba(160, 120, 24, 0.12)',
      color: isDouble ? 'var(--blue, #2a72b8)' : 'var(--amber, #a07818)',
      border: `1px solid ${isDouble ? 'rgba(42, 114, 184, 0.3)' : 'rgba(160, 120, 24, 0.3)'}`,
    }}>
      {isDouble ? 'DOUBLE' : 'SINGLE'}
    </span>
  )
}

function StackingRow({ row, facility, materials, materialsLoading, onMaterialsChanged, onUpdated, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [stackMode, setStackMode] = useState(row.stack_mode)
  const [notes, setNotes] = useState(row.notes || '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr] = useState(null)

  async function save() {
    setSaving(true)
    setErr(null)
    // Customer name is fixed once created — it's the link to the real Datex
    // project, not something to retype. Only stack mode and notes are editable.
    const result = await updateCustomerStacking(row.id, { stackMode, notes })
    setSaving(false)
    if (result.success) {
      onUpdated(result.row)
      setEditing(false)
    } else {
      setErr(result.error)
    }
  }

  function cancel() {
    setStackMode(row.stack_mode)
    setNotes(row.notes || '')
    setEditing(false)
    setErr(null)
  }

  async function handleDelete() {
    if (!window.confirm(`Remove stacking note for "${row.customer_name}"?`)) return
    setDeleting(true)
    const result = await deleteCustomerStacking(row.id)
    setDeleting(false)
    if (result.success) {
      onDeleted(row.id)
    } else {
      setErr(result.error)
    }
  }

  if (editing) {
    return (
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid var(--border-subtle, #eceff5)',
        background: 'var(--bg2, #f8f9fb)',
      }}>
        <div style={{ flex: '1 1 180px', fontWeight: 600, color: 'var(--text-primary)' }}>{row.customer_name}</div>
        <StackModeToggle value={stackMode} onChange={setStackMode} disabled={saving} />
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          disabled={saving}
          style={{ flex: '1 1 200px', fontSize: 12, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }}
        />
        <button type="button" onClick={save} disabled={saving} style={smallBtnStyle('var(--green, #1a8a52)')}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={cancel} disabled={saving} style={smallBtnStyle('var(--text-dim)')}>
          Cancel
        </button>
        {err && <span style={{ fontSize: 11, color: 'var(--red, #c0392b)', flexBasis: '100%' }}>{err}</span>}
      </div>
    )
  }

  return (
    <Fragment>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        borderBottom: expanded ? 'none' : '1px solid var(--border-subtle, #eceff5)',
        fontSize: 13,
      }}>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          title="Click to see/add material-level stacking exceptions for this customer"
          style={{
            flex: '1 1 180px', display: 'flex', alignItems: 'center', gap: 5,
            fontWeight: 600, color: 'var(--text-primary)',
            background: 'none', border: 'none', padding: 0,
            font: 'inherit', textAlign: 'left', cursor: 'pointer',
          }}
        >
          <span style={{
            display: 'inline-block', width: 8, fontSize: 9,
            color: 'var(--text-dim)',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.1s ease',
          }}>▶</span>
          {row.customer_name}
        </button>
        <StackModeBadge mode={row.stack_mode} />
        <div style={{ flex: '1 1 200px', fontSize: 12, color: 'var(--text-secondary)' }}>{row.notes || '—'}</div>
        {materials.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
            {materials.length} material exception{materials.length === 1 ? '' : 's'}
          </span>
        )}
        <button type="button" onClick={() => setEditing(true)} style={smallBtnStyle('var(--text-secondary)')}>Edit</button>
        <button type="button" onClick={handleDelete} disabled={deleting} style={smallBtnStyle('var(--red, #c0392b)')}>
          {deleting ? '…' : 'Delete'}
        </button>
        {err && <span style={{ fontSize: 11, color: 'var(--red, #c0392b)' }}>{err}</span>}
      </div>
      {expanded && (
        <MaterialStackingSubsection
          facility={facility}
          customerName={row.customer_name}
          materials={materials}
          loading={materialsLoading}
          onMaterialsChanged={onMaterialsChanged}
        />
      )}
    </Fragment>
  )
}

const OTHER_OPTION = '__other__'

function StackingAddRow({ facility, existingNames, customerOptions, onAdded }) {
  const [selected, setSelected] = useState('')
  const [manualName, setManualName] = useState('')
  const [stackMode, setStackMode] = useState('double')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const useManual = customerOptions.status !== 'ready' || customerOptions.options.length === 0 || selected === OTHER_OPTION
  const customerName = useManual ? manualName.trim() : selected

  async function handleAdd() {
    if (!customerName) return
    if (existingNames.includes(customerName.toLowerCase())) {
      setErr('That customer already has an entry')
      return
    }
    setSaving(true)
    setErr(null)
    const result = await addCustomerStacking(facility, { customerName, stackMode, notes })
    setSaving(false)
    if (result.success) {
      onAdded(result.row)
      setSelected('')
      setManualName('')
      setNotes('')
      setStackMode('double')
    } else {
      setErr(result.error)
    }
  }

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
      padding: '10px 14px',
      background: 'var(--bg2, #f8f9fb)',
    }}>
      {customerOptions.status === 'ready' && customerOptions.options.length > 0 ? (
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          disabled={saving}
          style={{ flex: '1 1 220px', fontSize: 13, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: '#fff' }}
        >
          <option value="">Select customer…</option>
          {customerOptions.options.map(o => (
            <option key={o.name} value={o.name}>{o.name} ({fmtInt(o.lps)} LPs)</option>
          ))}
          <option value={OTHER_OPTION}>Other / not listed…</option>
        </select>
      ) : (
        <span style={{ flex: '1 1 220px', fontSize: 11, color: 'var(--amber, #a07818)' }}>
          {customerOptions.status === 'loading' ? 'Loading live customer list…' : "Couldn't load live customer list — enter manually"}
        </span>
      )}
      {useManual && (
        <input
          value={manualName}
          onChange={e => setManualName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
          placeholder="Customer name"
          disabled={saving}
          style={{ flex: '1 1 180px', fontSize: 13, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }}
        />
      )}
      <StackModeToggle value={stackMode} onChange={setStackMode} disabled={saving} />
      <input
        value={notes}
        onChange={e => setNotes(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        placeholder="Notes (optional)"
        disabled={saving}
        style={{ flex: '1 1 200px', fontSize: 12, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }}
      />
      <button
        type="button"
        onClick={handleAdd}
        disabled={saving || !customerName}
        style={smallBtnStyle('var(--brand, #a07818)', true)}
      >
        {saving ? 'Adding…' : '+ Add'}
      </button>
      {err && <span style={{ fontSize: 11, color: 'var(--red, #c0392b)', flexBasis: '100%' }}>{err}</span>}
    </div>
  )
}

export function StackModeToggle({ value, onChange, disabled }) {
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      {['single', 'double'].map(mode => {
        const active = value === mode
        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            onClick={() => onChange(mode)}
            style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.03em',
              padding: '4px 10px', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              background: active ? 'var(--brand, #a07818)' : 'var(--bg1, #fff)',
              color: active ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {mode.toUpperCase()}
          </button>
        )
      })}
    </div>
  )
}

export function smallBtnStyle(color, filled) {
  return {
    fontSize: 11, fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 4,
    border: `1px solid ${color}`,
    background: filled ? color : 'transparent',
    color: filled ? '#fff' : color,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }
}

function PerRoomFreshnessBanner({ liveLoading, liveResult }) {
  if (liveLoading) {
    return (
      <FreshnessRow
        dotColor="var(--text-dim, #9aaabb)"
        primary="Loading live Datex data…"
        secondary={null}
      />
    )
  }
  if (liveResult?.source === 'live' && !liveResult.error) {
    return (
      <FreshnessRow
        dotColor="var(--green, #1a8a52)"
        primary="Live from Datex"
        secondary={`Updated ${fmtTime(liveResult.fetchedAt)} · ${liveResult.elapsedMs}ms`}
      />
    )
  }
  return (
    <FreshnessRow
      dotColor="var(--red, #c0392b)"
      primary="Live data unavailable"
      secondary={liveResult?.error || 'Unknown error'}
    />
  )
}

function RoomTable({ rows, liveLoading, isLive, facility, onRoomUpdated, breakdown, breakdownLoading, expandedRoomId, onToggleExpand, aislesByRoomId, aislesLoading, aisleOccupancy, aisleOccupancyLoading, customerStackingRows, customerStackingLoading, onAislesChanged }) {
  if (!rows.length) {
    return (
      <div style={{
        padding: 24, textAlign: 'center',
        color: 'var(--text-secondary)', fontSize: 13,
        background: 'var(--bg2, #f8f9fb)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md, 8px)',
        marginTop: 10,
      }}>
        No rooms configured for this facility.
      </div>
    )
  }
  const total = rows.reduce((s, r) => s + (r.live_lps ?? 0), 0)
  const GRID = '1.1fr 0.9fr 0.9fr 1.3fr 0.9fr 0.8fr'
  return (
    <div style={{
      marginTop: 10,
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md, 8px)',
      overflow: 'hidden',
      background: 'var(--bg1, #fff)',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        padding: '10px 14px',
        background: 'var(--bg2, #f8f9fb)',
        borderBottom: '1px solid var(--border)',
        fontSize: 10,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.08em',
        color: 'var(--text-dim)',
        textTransform: 'uppercase',
      }}>
        <div>Room</div>
        <div>Zone</div>
        <div style={{ textAlign: 'right' }}>Live LPs</div>
        <div style={{ textAlign: 'right' }}>Capacity</div>
        <div style={{ textAlign: 'right' }}>Util</div>
        <div style={{ textAlign: 'right' }}>Datex ID</div>
      </div>
      {rows.map(row => (
        <RoomRow
          key={row.id}
          row={row}
          liveLoading={liveLoading}
          isLive={isLive}
          gridTemplate={GRID}
          facility={facility}
          onRoomUpdated={onRoomUpdated}
          breakdown={breakdown}
          breakdownLoading={breakdownLoading}
          expanded={expandedRoomId === row.id}
          onToggleExpand={onToggleExpand}
          aisles={aislesByRoomId.get(row.id)}
          aislesLoading={aislesLoading}
          aisleOccupancy={aisleOccupancy}
          aisleOccupancyLoading={aisleOccupancyLoading}
          customerStackingRows={customerStackingRows}
          customerStackingLoading={customerStackingLoading}
          onAislesChanged={onAislesChanged}
        />
      ))}
      {/* Total row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        padding: '10px 14px',
        background: 'var(--bg2, #f8f9fb)',
        borderTop: '2px solid var(--border)',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      }}>
        <div>Total</div>
        <div />
        <div style={{ textAlign: 'right', color: 'var(--text-primary)' }}>
          {liveLoading ? '…' : fmtInt(total)}
        </div>
        <div />
        <div />
        <div />
      </div>
    </div>
  )
}

function RoomRow({ row, liveLoading, isLive, gridTemplate, facility, onRoomUpdated, breakdown, breakdownLoading, expanded, onToggleExpand, aisles, aislesLoading, aisleOccupancy, aisleOccupancyLoading, customerStackingRows, customerStackingLoading, onAislesChanged }) {
  const zoneInfo = ZONES[row.zone] || { label: row.zone || '—', color: 'var(--text-dim)' }
  const aisleCalc = roomAislePositions(aisles)
  const hasAisleData = aisleCalc.aisleCount > 0
  // Capacity is a flat single number — the single-stack floor — not a range
  // (Dan's call, 2026-07-25). Utilization's numerator is adjusted instead:
  // see computeEffectiveRoomOccupancy in spacePlanning.js for exactly how.
  const cap = hasAisleData ? aisleCalc.min : (row.slots || 0) * (row.stack || 0)
  const occupancyReady = hasAisleData && !aisleOccupancyLoading && !customerStackingLoading && !aisleOccupancy?.error
  const effectiveUsed = occupancyReady
    ? computeEffectiveRoomOccupancy(aisles, aisleOccupancy?.byAisleLocationId, customerStackingRows, row.live_lps)
    : row.live_lps // fall back to raw LP count while occupancy/stacking data is still loading or errored
  const util = cap > 0 && effectiveUsed != null ? (effectiveUsed / cap) * 100 : null
  const band = utilBand(util)
  const canExpand = row.datex_top_location_id != null
  return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: gridTemplate,
        padding: '10px 14px',
        borderBottom: expanded ? 'none' : '1px solid var(--border-subtle, #eceff5)',
        fontSize: 13,
        alignItems: 'center',
      }}>
        <button
          type="button"
          onClick={() => canExpand && onToggleExpand(row.id)}
          disabled={!canExpand}
          title={canExpand ? 'Click to see which projects occupy this room' : 'No Datex room mapping'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontWeight: 600, color: 'var(--text-primary)',
            background: 'none', border: 'none', padding: 0,
            font: 'inherit', textAlign: 'left',
            cursor: canExpand ? 'pointer' : 'default',
          }}
        >
          {canExpand && (
            <span style={{
              display: 'inline-block', width: 10, fontSize: 10,
              color: 'var(--text-dim)',
              transform: expanded ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.1s ease',
            }}>▶</span>
          )}
          {row.name}
        </button>
        <div>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11, color: 'var(--text-secondary)',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: zoneInfo.color, display: 'inline-block',
            }} />
            {zoneInfo.label}
          </span>
        </div>
        <div style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          color: isLive ? 'var(--text-primary)' : 'var(--text-dim)',
        }}>
          {liveLoading ? '…' : (row.live_lps != null ? fmtInt(row.live_lps) : '—')}
        </div>
        {aislesLoading ? (
          <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-dim)' }}>…</div>
        ) : hasAisleData ? (
          <ComputedCapacityCell aisleCalc={aisleCalc} />
        ) : (
          <CapacityCell room={row} onRoomUpdated={onRoomUpdated} />
        )}
        <div style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          fontWeight: util != null ? 600 : 400,
          color: util != null ? band.color : 'var(--text-dim)',
        }}>
          {util != null ? fmtPct(util) : '—'}
        </div>
        <div style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 11,
          color: 'var(--text-dim)',
        }}>
          {row.datex_top_location_id ?? '—'}
        </div>
      </div>
      {expanded && (
        <>
          <ProjectBreakdownPanel
            roomId={row.datex_top_location_id}
            breakdown={breakdown}
            breakdownLoading={breakdownLoading}
          />
          <AisleGeometrySection
            roomId={row.id}
            facility={facility}
            roomDatexLocationId={row.datex_top_location_id}
            aisles={aisles}
            loading={aislesLoading}
            aisleOccupancy={aisleOccupancy}
            aisleOccupancyLoading={aisleOccupancyLoading}
            customerStackingRows={customerStackingRows}
            onAislesChanged={onAislesChanged}
          />
        </>
      )}
    </div>
  )
}

// Drill-down panel shown under a room row when expanded — which projects are
// occupying this room right now, and how many LPs each holds. Sorted by LP
// count descending (server response is ordered by pallet estimate, which we
// no longer display, so we re-sort here).
function ProjectBreakdownPanel({ roomId, breakdown, breakdownLoading }) {
  const projects = useMemo(() => {
    const list = breakdown?.byRoomId?.get(Number(roomId)) || []
    return [...list].sort((a, b) => b.lps - a.lps)
  }, [breakdown, roomId])
  return (
    <div style={{
      padding: '4px 14px 12px 30px',
      borderBottom: '1px solid var(--border-subtle, #eceff5)',
      background: 'var(--bg2, #f8f9fb)',
    }}>
      {breakdownLoading && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 0' }}>
          Loading project breakdown…
        </div>
      )}
      {!breakdownLoading && breakdown?.error && (
        <div style={{ fontSize: 11, color: 'var(--red, #c0392b)', padding: '6px 0' }}>
          Couldn't load project breakdown — {breakdown.error}
        </div>
      )}
      {!breakdownLoading && !breakdown?.error && projects.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 0' }}>
          No occupied projects found for this room.
        </div>
      )}
      {!breakdownLoading && !breakdown?.error && projects.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 0.8fr',
          rowGap: 4, columnGap: 10,
          fontSize: 12,
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em' }}>PROJECT</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em', textAlign: 'right' }}>LPs</div>
          {projects.map((p, i) => (
            <Fragment key={`${p.projectName}-${i}`}>
              <div style={{ color: 'var(--text-primary)' }}>{p.projectName}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--text-secondary)' }}>{fmtInt(p.lps)}</div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

// Rack geometry per aisle within this room — bays × deep × tiers × max stack
// per tier. bay_count is live-derivable from Datex (confirmed 2026-07-24 —
// every bay is a real distinct location container); deep/tiers/max_stack_per_tier
// stay manual (Datex has none of that). Edited in place the same way the
// room-level Slots × Stack cell works. POSITIONS shows the single-stack floor
// only (aislePositionsRange(aisle).min) — not a range (Dan's call, 2026-07-25:
// capacity is one fixed number; the stacking adjustment lives in the room's
// utilization NUMERATOR instead, via computeEffectiveRoomOccupancy, which
// only credits an occupant's LPs at half-weight when they're BOTH in a
// double-stack-capable aisle AND actually flagged double-stack — see
// Customer Stacking Notes below for who's flagged, and click an aisle's
// label to see who's physically occupying it right now).
//
// UTIL column (added 2026-07-25 per Dan's ask) shows the same stacking-
// adjusted utilization concept as the room-level number, scoped to just
// this aisle — computeEffectiveAisleOccupancy(aisle, occupants,
// customerStackingRows).effectiveLps ÷ this aisle's single-stack floor.
// Needs a Datex link + loaded occupancy data; shows '—' otherwise.
//
// "Link Datex aisles" button (added 2026-07-25) fixes a real gap: aisles
// added via "+ Add aisle" only ever set aisle_label, with no field to enter
// datex_aisle_location_id — so every UI-added aisle silently had no Datex
// link, which meant computeEffectiveRoomOccupancy could never apply the
// stacking adjustment for that room (confirmed on F7: 9 aisles, all
// unlinked, utilization identical to the raw unadjusted ratio). This button
// looks up the room's real aisle containers and bulk-links by label match.
function AisleGeometrySection({ roomId, facility, roomDatexLocationId, aisles, loading, aisleOccupancy, aisleOccupancyLoading, customerStackingRows, onAislesChanged }) {
  const [adding, setAdding] = useState(false)
  const [linking, setLinking] = useState(false)
  const [linkResult, setLinkResult] = useState(null) // { linked, unmatched } | { error } | null

  // "Link Datex aisles" — fixes the gap that let F7's 9 aisles sit with
  // datex_aisle_location_id = null indefinitely (2026-07-25): aisles added
  // via "+ Add aisle" only ever set aisle_label, with no way to enter the
  // Datex link at creation time. This looks up the room's real aisle
  // containers and matches by label (case-insensitive) against short_name —
  // confirmed live to be a reliable 1:1 match — bulk-linking every unlinked
  // aisle in one pass instead of requiring a hand-run SQL UPDATE.
  async function handleLinkDatexAisles() {
    if (!roomDatexLocationId) {
      setLinkResult({ error: 'This room has no Datex room mapping — cannot look up aisle containers.' })
      return
    }
    setLinking(true)
    setLinkResult(null)
    const mapping = await fetchRoomAisleDatexMapping(facility, roomDatexLocationId)
    if (mapping == null) {
      setLinking(false)
      setLinkResult({ error: "Couldn't look up Datex aisle containers — try again." })
      return
    }
    const byShortName = new Map(mapping.map(m => [m.shortName.toUpperCase(), m]))
    let linked = 0
    const unmatched = []
    let nextAisles = aisles || []
    for (const aisle of (aisles || [])) {
      if (aisle.datex_aisle_location_id != null) continue // already linked, leave alone
      const match = byShortName.get(aisle.aisle_label.toUpperCase())
      if (!match) { unmatched.push(aisle.aisle_label); continue }
      const result = await updateRoomAisle(aisle.id, { datexAisleLocationId: match.locationContainerId })
      if (result.success) {
        linked += 1
        nextAisles = nextAisles.map(a => a.id === aisle.id ? result.aisle : a)
      } else {
        unmatched.push(aisle.aisle_label)
      }
    }
    onAislesChanged(roomId, nextAisles)
    setLinking(false)
    setLinkResult({ linked, unmatched })
  }

  return (
    <div style={{
      padding: '10px 14px 14px 30px',
      borderBottom: '1px solid var(--border-subtle, #eceff5)',
      background: 'var(--bg1, #fff)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{
          fontSize: 10, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          Aisle rack geometry
        </span>
        {!loading && !adding && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={handleLinkDatexAisles} disabled={linking} style={smallBtnStyle('var(--blue, #2a72b8)')}>
              {linking ? 'Linking…' : 'Link Datex aisles'}
            </button>
            <button type="button" onClick={() => setAdding(true)} style={smallBtnStyle('var(--text-secondary)')}>
              + Add aisle
            </button>
          </div>
        )}
      </div>

      {linkResult && (
        <div style={{
          fontSize: 11, marginBottom: 6,
          color: linkResult.error ? 'var(--red, #c0392b)' : 'var(--text-secondary)',
        }}>
          {linkResult.error
            ? linkResult.error
            : `Linked ${linkResult.linked} aisle${linkResult.linked === 1 ? '' : 's'} to Datex.${linkResult.unmatched.length ? ` No match found for: ${linkResult.unmatched.join(', ')}.` : ''}`}
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 0' }}>
          Loading aisle geometry…
        </div>
      )}

      {!loading && aisles && aisles.length === 0 && !adding && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 0' }}>
          No aisles configured for this room yet.
        </div>
      )}

      {!loading && aisles && aisles.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '0.5fr 0.55fr 0.55fr 0.55fr 0.7fr 1fr 0.6fr 1.3fr 0.5fr',
          rowGap: 4, columnGap: 10,
          fontSize: 12, alignItems: 'center',
        }}>
          <AisleHeaderCell>AISLE</AisleHeaderCell>
          <AisleHeaderCell align="center">BAYS</AisleHeaderCell>
          <AisleHeaderCell align="center">DEEP</AisleHeaderCell>
          <AisleHeaderCell align="center">TIERS</AisleHeaderCell>
          <AisleHeaderCell align="center">MAX STACK</AisleHeaderCell>
          <AisleHeaderCell align="center">POSITIONS</AisleHeaderCell>
          <AisleHeaderCell align="center">UTIL</AisleHeaderCell>
          <AisleHeaderCell>NOTES</AisleHeaderCell>
          <AisleHeaderCell />
          {aisles.map(aisle => (
            <AisleRow
              key={aisle.id}
              aisle={aisle}
              occupants={aisle.datex_aisle_location_id != null ? aisleOccupancy?.byAisleLocationId?.get(Number(aisle.datex_aisle_location_id)) : undefined}
              occupancyLoading={aisleOccupancyLoading}
              occupancyError={aisleOccupancy?.error}
              customerStackingRows={customerStackingRows}
              onUpdated={updated => onAislesChanged(roomId, aisles.map(a => a.id === updated.id ? updated : a))}
              onDeleted={id => onAislesChanged(roomId, aisles.filter(a => a.id !== id))}
            />
          ))}
        </div>
      )}

      {adding && (
        <AisleAddRow
          roomId={roomId}
          existingLabels={(aisles || []).map(a => a.aisle_label.toLowerCase())}
          onAdded={aisle => {
            onAislesChanged(roomId, [...(aisles || []), aisle].sort((a, b) => a.aisle_label.localeCompare(b.aisle_label)))
            setAdding(false)
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  )
}

function AisleHeaderCell({ children, align }) {
  return (
    <div style={{
      fontSize: 10, color: 'var(--text-dim)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      letterSpacing: '0.06em', textAlign: align || 'left',
    }}>
      {children}
    </div>
  )
}

function AisleRow({ aisle, occupants, occupancyLoading, occupancyError, customerStackingRows, onUpdated, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [bayCount, setBayCount] = useState(aisle.bay_count ?? '')
  const [deep, setDeep] = useState(aisle.deep ?? '')
  const [tiers, setTiers] = useState(aisle.tiers ?? '')
  const [maxStack, setMaxStack] = useState(aisle.max_stack_per_tier ?? '')
  const [notes, setNotes] = useState(aisle.notes || '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr] = useState(null)

  const range = aislePositionsRange(aisle)

  // Per-aisle utilization (added 2026-07-25 per Dan's ask, while already
  // expanding a room's Aisle Rack Geometry — same stacking-adjusted logic
  // as the room-level number, just scoped to this one aisle's live
  // occupants. Needs a Datex link + loaded occupancy data to compute;
  // otherwise shows '—' (or '…' while occupancy is still loading).
  const hasDatexMapping = aisle.datex_aisle_location_id != null
  const aisleUtilReady = hasDatexMapping && !occupancyLoading && !occupancyError && range != null && range.min > 0
  const aisleUtil = aisleUtilReady
    ? (computeEffectiveAisleOccupancy(aisle, occupants || [], customerStackingRows).effectiveLps / range.min) * 100
    : null
  const aisleBand = utilBand(aisleUtil)

  async function save() {
    setSaving(true)
    setErr(null)
    const result = await updateRoomAisle(aisle.id, {
      bayCount: bayCount === '' ? null : bayCount,
      deep: deep === '' ? null : deep,
      tiers: tiers === '' ? null : tiers,
      maxStackPerTier: maxStack === '' ? null : maxStack,
      notes,
    })
    setSaving(false)
    if (result.success) {
      onUpdated(result.aisle)
      setEditing(false)
    } else {
      setErr(result.error)
    }
  }

  function cancel() {
    setBayCount(aisle.bay_count ?? '')
    setDeep(aisle.deep ?? '')
    setTiers(aisle.tiers ?? '')
    setMaxStack(aisle.max_stack_per_tier ?? '')
    setNotes(aisle.notes || '')
    setEditing(false)
    setErr(null)
  }

  async function handleDelete() {
    if (!window.confirm(`Remove aisle "${aisle.aisle_label}"?`)) return
    setDeleting(true)
    const result = await deleteRoomAisle(aisle.id)
    setDeleting(false)
    if (result.success) {
      onDeleted(aisle.id)
    } else {
      setErr(result.error)
    }
  }

  // justifySelf centers each input within its grid cell — the previous version
  // left inputs anchored to the left edge of a wider column than the input
  // itself, which read as "off-centered" against the column headers above.
  const numInputStyle = {
    width: 44, fontSize: 12, padding: '2px 4px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    border: '1px solid var(--border)', borderRadius: 4,
    textAlign: 'center', justifySelf: 'center',
  }
  const centeredCellStyle = (hasValue) => ({
    textAlign: 'center', justifySelf: 'center',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    color: hasValue ? 'var(--text-primary)' : 'var(--text-dim)',
  })

  if (editing) {
    return (
      <>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{aisle.aisle_label}</div>
        <input type="number" min="0" value={bayCount} onChange={e => setBayCount(e.target.value)} disabled={saving} style={numInputStyle} />
        <input type="number" min="0" value={deep} onChange={e => setDeep(e.target.value)} disabled={saving} style={numInputStyle} />
        <input type="number" min="0" value={tiers} onChange={e => setTiers(e.target.value)} disabled={saving} style={numInputStyle} />
        <input type="number" min="0" value={maxStack} onChange={e => setMaxStack(e.target.value)} disabled={saving} style={numInputStyle} />
        <div style={{ textAlign: 'center', justifySelf: 'center', color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>—</div>
        <div style={{ textAlign: 'center', justifySelf: 'center', color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>—</div>
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          disabled={saving}
          style={{ fontSize: 12, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 4, width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 4, justifySelf: 'end' }}>
          <button type="button" onClick={save} disabled={saving} style={smallBtnStyle('var(--green, #1a8a52)')}>
            {saving ? '…' : 'Save'}
          </button>
          <button type="button" onClick={cancel} disabled={saving} style={smallBtnStyle('var(--text-dim)')}>
            X
          </button>
        </div>
        {err && (
          <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--red, #c0392b)' }}>{err}</div>
        )}
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        title="Click to see which customers are physically in this aisle right now"
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontWeight: 600, color: 'var(--text-primary)',
          background: 'none', border: 'none', padding: 0,
          font: 'inherit', textAlign: 'left', cursor: 'pointer',
        }}
      >
        <span style={{
          display: 'inline-block', width: 8, fontSize: 9,
          color: 'var(--text-dim)',
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.1s ease',
        }}>▶</span>
        {aisle.aisle_label}
      </button>
      <div style={centeredCellStyle(aisle.bay_count != null)}>
        {aisle.bay_count ?? '—'}
      </div>
      <div style={centeredCellStyle(aisle.deep != null)}>
        {aisle.deep ?? '—'}
      </div>
      <div style={centeredCellStyle(aisle.tiers != null)}>
        {aisle.tiers ?? '—'}
      </div>
      <div style={centeredCellStyle(aisle.max_stack_per_tier != null)}>
        {aisle.max_stack_per_tier ?? '—'}
      </div>
      <div style={{ ...centeredCellStyle(range != null), fontWeight: range != null ? 600 : 400 }}>
        {range != null ? fmtInt(range.min) : '—'}
      </div>
      <div style={{
        textAlign: 'center', justifySelf: 'center',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12,
        fontWeight: aisleUtil != null ? 600 : 400,
        color: aisleUtil != null ? aisleBand.color : 'var(--text-dim)',
      }}>
        {occupancyLoading ? '…' : (aisleUtil != null ? fmtPct(aisleUtil) : '—')}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontStyle: aisle.notes ? 'normal' : 'italic' }}>
        {aisle.notes || (aisle.deep == null ? 'needs geometry input' : '')}
      </div>
      <div style={{ display: 'flex', gap: 4, justifySelf: 'end' }}>
        <button type="button" onClick={() => setEditing(true)} style={smallBtnStyle('var(--text-secondary)')}>Edit</button>
        <button type="button" onClick={handleDelete} disabled={deleting} style={smallBtnStyle('var(--red, #c0392b)')}>
          {deleting ? '…' : 'X'}
        </button>
      </div>
      {err && (
        <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--red, #c0392b)' }}>{err}</div>
      )}
      {expanded && (
        <AisleOccupancyPanel
          occupants={occupants}
          loading={occupancyLoading}
          error={occupancyError}
          hasDatexMapping={aisle.datex_aisle_location_id != null}
        />
      )}
    </>
  )
}


function AisleAddRow({ roomId, existingLabels, onAdded, onCancel }) {
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  async function handleAdd() {
    const trimmed = label.trim()
    if (!trimmed) return
    if (existingLabels.includes(trimmed.toLowerCase())) {
      setErr('That aisle already exists for this room')
      return
    }
    setSaving(true)
    setErr(null)
    const result = await addRoomAisle(roomId, { aisleLabel: trimmed })
    setSaving(false)
    if (result.success) {
      onAdded(result.aisle)
    } else {
      setErr(result.error)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <input
        value={label}
        onChange={e => setLabel(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
        placeholder="Aisle label (e.g. K)"
        disabled={saving}
        style={{ width: 140, fontSize: 13, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }}
      />
      <button type="button" onClick={handleAdd} disabled={saving || !label.trim()} style={smallBtnStyle('var(--brand, #a07818)', true)}>
        {saving ? 'Adding…' : '+ Add'}
      </button>
      <button type="button" onClick={onCancel} disabled={saving} style={smallBtnStyle('var(--text-dim)')}>
        Cancel
      </button>
      {err && <span style={{ fontSize: 11, color: 'var(--red, #c0392b)' }}>{err}</span>}
    </div>
  )
}

// Read-only capacity cell shown once a room has aisle geometry configured —
// replaces the manual Slots × Stack cell entirely (Dan's catch, 2026-07-24:
// there's no reason to hand-enter a room total when the aisles underneath
// it already have real, computable positions). Shows a single flat number —
// the single-stack floor (aisleCalc.min) — not a range. Dan's call
// (2026-07-25): capacity should be one fixed denominator; the stacking
// adjustment happens in the utilization NUMERATOR instead (see
// computeEffectiveRoomOccupancy), not by widening the capacity itself.
function ComputedCapacityCell({ aisleCalc }) {
  const { min, aisleCount, incompleteCount } = aisleCalc
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12, color: 'var(--text-primary)',
      }}>
        {fmtInt(min)}
      </div>
      <div style={{
        fontSize: 9,
        color: incompleteCount > 0 ? 'var(--amber, #a07818)' : 'var(--text-dim)',
      }}>
        {aisleCount} aisle{aisleCount === 1 ? '' : 's'}
        {incompleteCount > 0 ? ` · ${incompleteCount} unconfirmed` : ''}
      </div>
    </div>
  )
}

// Click-to-edit Slots × Stack cell. Follows the same pattern as PickScheduleEditor's
// inline-editable cells: click to enter edit mode, two small number inputs, save on
// blur (when both inputs have lost focus) or Enter key. Escape cancels and reverts.
// Writes directly to Supabase via updateRoomCapacity — no separate Settings page.
function CapacityCell({ room, onRoomUpdated }) {
  const [editing, setEditing] = useState(false)
  const [slots, setSlots] = useState(room.slots || 0)
  const [stack, setStack] = useState(room.stack || 0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const blurTimerRef = useRef(null)

  // Keep local input state in sync if the room prop changes externally
  // (e.g. another tab/session updated it and a refetch happened).
  useEffect(() => {
    if (!editing) {
      setSlots(room.slots || 0)
      setStack(room.stack || 0)
    }
  }, [room.slots, room.stack, editing])

  const cap = (room.slots || 0) * (room.stack || 0)

  async function commit() {
    const nextSlots = Math.max(0, Math.round(Number(slots) || 0))
    const nextStack = Math.max(0, Math.round(Number(stack) || 0))
    if (nextSlots === (room.slots || 0) && nextStack === (room.stack || 0)) {
      setEditing(false)
      setErr(null)
      return
    }
    setSaving(true)
    setErr(null)
    const result = await updateRoomCapacity(room.id, { slots: nextSlots, stack: nextStack })
    setSaving(false)
    if (result.success) {
      onRoomUpdated?.(room.id, { slots: nextSlots, stack: nextStack })
      setEditing(false)
    } else {
      setErr(result.error || 'Save failed')
      // Stay in edit mode so the user doesn't lose their input.
    }
  }

  function cancel() {
    setSlots(room.slots || 0)
    setStack(room.stack || 0)
    setEditing(false)
    setErr(null)
  }

  // Debounced blur: only commit if focus has left BOTH inputs (moving from
  // the slots input to the stack input shouldn't trigger a save mid-edit).
  function handleBlur() {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    blurTimerRef.current = setTimeout(() => {
      if (editing) commit()
    }, 120)
  }
  function handleFocus() {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to edit capacity"
        style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 12,
          color: cap > 0 ? 'var(--text-primary)' : 'var(--text-dim)',
          background: 'none',
          border: '1px dashed transparent',
          borderRadius: 4,
          padding: '2px 4px',
          cursor: 'pointer',
          font: 'inherit',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent' }}
      >
        {cap > 0 ? `${room.slots} × ${room.stack} = ${fmtInt(cap)}` : 'Set capacity'}
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        <input
          type="number"
          min="0"
          autoFocus
          value={slots}
          onChange={e => setSlots(e.target.value)}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { e.preventDefault(); cancel() }
          }}
          disabled={saving}
          style={{
            width: 48, fontSize: 12, padding: '2px 4px',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            border: '1px solid var(--border)', borderRadius: 4,
            textAlign: 'right',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>×</span>
        <input
          type="number"
          min="0"
          value={stack}
          onChange={e => setStack(e.target.value)}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { e.preventDefault(); cancel() }
          }}
          disabled={saving}
          style={{
            width: 48, fontSize: 12, padding: '2px 4px',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            border: '1px solid var(--border)', borderRadius: 4,
            textAlign: 'right',
          }}
        />
      </div>
      {saving && (
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>Saving…</span>
      )}
      {err && (
        <span style={{ fontSize: 9, color: 'var(--red, #c0392b)' }}>{err}</span>
      )}
    </div>
  )
}
