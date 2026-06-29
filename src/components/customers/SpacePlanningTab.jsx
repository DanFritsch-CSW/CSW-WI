import { useEffect, useMemo, useState } from 'react'
import {
  FACILITY_DOTS, FACILITY_NAMES, FACILITIES,
  utilBand, facilityCapacity, facilityActual, facilityUtil,
  networkCapacity, networkActual, networkUtil, isFacilityLive,
  fmtInt, fmtPct, fmtTime,
  fetchSpaceRooms, fetchSpaceCustomerPositions, fetchLiveActualsPerFacility,
} from '../../lib/spacePlanning.js'

// Phase 2 — Network/ALL view is read-only.
// Phase 2.5 — Network/ALL view actuals come from live Datex LP counts when
//   available, falling back to seeded Supabase fixtures per-facility on Omni
//   failure. The seeded path was the entire data source in Phase 2; it now
//   serves as graceful degradation.
// Phase 3 (single-facility view) still needs the Datex location → room
// mapping, which is deferred.
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
        {!loading && !error && facility !== 'all' && (
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
