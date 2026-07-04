import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FACILITY_DOTS, FACILITY_NAMES, FACILITIES, PHASE3_FACILITIES,
  ZONES, utilBand, facilityCapacity, facilityActual, facilityUtil,
  networkCapacity, networkActual, networkUtil, isFacilityLive,
  fmtInt, fmtPct, fmtTime,
  fetchSpaceRooms, fetchSpaceCustomerPositions, fetchLiveActualsPerFacility,
  fetchLivePerRoomActuals, updateRoomCapacity,
} from '../../lib/spacePlanning.js'

// Phase 2 — Network/ALL view is read-only.
// Phase 2.5 — Network/ALL view actuals come from live Datex LP counts when
//   available, falling back to seeded Supabase fixtures per-facility on Omni
//   failure. The seeded path was the entire data source in Phase 2; it now
//   serves as graceful degradation.
// Phase 3 (single-facility view) — currently MAD-only. Per-room LP counts
//   come from netlify/functions/space-per-room via fetchLivePerRoomActuals.
//   Rooms are joined by space_rooms.datex_top_location_id → the top-level
//   Datex location container. Other facilities still show the deferred
//   placeholder until their room lists get seeded. Capacity (slots × stack)
//   is editable inline in this tab — no separate Settings page — via
//   CapacityCell + updateRoomCapacity.
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
        <RoomTable rows={rows} liveLoading={liveLoading} isLive={isLive} onRoomUpdated={onRoomUpdated} />
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
        Click any Slots × Stack cell to set capacity — it saves immediately, no separate
        Settings page needed. Utilization uses the physical LP count against that capacity.
      </div>
    </div>
  )
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

function RoomTable({ rows, liveLoading, isLive, onRoomUpdated }) {
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
        <div style={{ textAlign: 'right' }}>Slots × Stack</div>
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
          onRoomUpdated={onRoomUpdated}
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

function RoomRow({ row, liveLoading, isLive, gridTemplate, onRoomUpdated }) {
  const zoneInfo = ZONES[row.zone] || { label: row.zone || '—', color: 'var(--text-dim)' }
  const cap = (row.slots || 0) * (row.stack || 0)
  const util = cap > 0 && row.live_lps != null ? (row.live_lps / cap) * 100 : null
  const band = utilBand(util)
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: gridTemplate,
      padding: '10px 14px',
      borderBottom: '1px solid var(--border-subtle, #eceff5)',
      fontSize: 13,
      alignItems: 'center',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{row.name}</div>
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
      <CapacityCell room={row} onRoomUpdated={onRoomUpdated} />
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
