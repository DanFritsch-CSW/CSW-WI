import { useEffect, useMemo, useState } from 'react'
import {
  FACILITY_DOTS, FACILITY_NAMES, FACILITIES,
  utilBand, facilityCapacity, facilityActual, facilityUtil,
  networkCapacity, networkActual, networkUtil,
  fmtInt, fmtPct,
  fetchSpaceRooms, fetchSpaceCustomerPositions,
} from '../../lib/spacePlanning.js'

// Phase 2 — Network/ALL view is read-only and live. Single-facility view
// (Phase 3) needs per-room occupancy from Datex location → room mapping,
// which is deferred for now.
export default function SpacePlanningTab() {
  const [facility, setFacility] = useState('all')
  const [rooms, setRooms] = useState([])
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
        console.error('SpacePlanningTab load:', err)
        setError(err?.message || 'Failed to load space data')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div>
      <FacilityTabStrip active={facility} onChange={setFacility} />
      <div style={{ marginTop: 20 }}>
        {loading && <LoadingState />}
        {error && !loading && <ErrorState error={error} />}
        {!loading && !error && facility === 'all' && (
          <NetworkView rooms={rooms} positions={positions} onFacilityClick={setFacility} />
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

function NetworkView({ rooms, positions, onFacilityClick }) {
  const cap  = useMemo(() => networkCapacity(rooms),        [rooms])
  const act  = useMemo(() => networkActual(positions),      [positions])
  const util = useMemo(() => networkUtil(rooms, positions), [rooms, positions])
  const band = utilBand(util)
  const facilityCount = new Set(rooms.map(r => r.facility)).size

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Network summary 3 cells (no forecast — see Phase 2 decision) */}
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
              onClick={() => onFacilityClick(facId)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function FacilityScorecard({ facility, rooms, positions, onClick }) {
  const cap  = facilityCapacity(rooms, facility)
  const act  = facilityActual(positions, facility)
  const util = facilityUtil(rooms, positions, facility)
  const band = utilBand(util)
  const dot  = FACILITY_DOTS[facility]
  const name = FACILITY_NAMES[facility]
  const roomCount = rooms.filter(r => r.facility === facility).length
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
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot }} />
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
