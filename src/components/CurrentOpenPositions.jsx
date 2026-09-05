import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchOpenPositions } from '../lib/openPositions.js'
import { fetchF8OpenPositions } from '../lib/f8OpenPositions.js'
import { fetchIgnoredLocations } from '../lib/f8OpenPositionsIgnored.js'

// ─── Current Open Positions ──────────────────────────────────────────────
// Added 2026-09-04, new sub-tab on the Inventory page (alongside "Cycle
// Count Report") per Dan/Hill's Front conversation. Hill's actual ask:
// "quick view of open locations and where guys should tow in product,"
// specifically something that pulls up INSTANTLY on the dock computer "at
// that moment in time" rather than a once-a-day digest -- this is a live,
// on-demand view, no digest/schedule attached, by design.
//
// Has its own facility sub-tab row underneath (Caledonia / Kenosha /
// Madison / Wisconsin Rapids / Eau Claire):
//
//   - Madison reuses the ALREADY-LIVE, already-validated F8 Open
//     Positions data (motherduck-f8-open-positions.cjs) -- same aisle
//     cards, same Empty=2/1LP=1 (B-E) / Empty-only=1 (F) rules, same
//     ignore-list filtering. This is a READ-ONLY view here: the Notify
//     digest settings and "Manage ignored locations" controls stay on
//     the Labor Planning tab's F8OpenPositions.jsx (deliberately left
//     untouched per Dan's explicit "leave this initial build alone")
//     -- this component does not duplicate those controls, just the
//     resulting numbers.
//
//   - Caledonia/Kenosha/Wisconsin Rapids/Eau Claire are NEW
//     (motherduck-open-positions.cjs). Each facility's real pallet
//     capacity per location isn't stored anywhere in Datex (confirmed
//     live: max_license_plate_quantity is null everywhere, same finding
//     already documented in InventoryReport.jsx for Caledonia) -- so
//     unlike Madison's confirmed 2-position B-E / 1-position F split,
//     these four facilities use a conservative default: only genuinely
//     EMPTY locations (0 LPs) count as open, 1 position each. This can
//     be tightened facility-by-facility once real capacity conventions
//     are confirmed, the same way Madison's was.
//
// Zone grouping is facility-specific, confirmed against live location-
// naming samples before choosing (not guessed) -- see
// motherduck-open-positions.cjs's file header for the full reasoning per
// facility (Caledonia's dual legacy/F1-dash convention, Kenosha's uniform
// 2-letter+3digit+level, Wisconsin Rapids' letter-vs-numeric split, Eau
// Claire's compact F1<letter> convention).
//
// FLAGGED, not fixed: Wisconsin Rapids' numeric-prefixed zones (4/5/6/7,
// e.g. "410A") come back 100% empty right now -- structurally they look
// like real locations (same row+level-letter shape as the lettered
// aisles), not the same kind of confirmed-dead legacy pattern Madison's
// F8E##-00 locations turned out to be, so this is NOT excluded here.
// Worth Dan confirming whether that's a genuinely underused rack section
// or something that should be excluded.

const AISLE_ORDER = ['F8B', 'F8C', 'F8D', 'F8E', 'F8F']
const SINGLE_POSITION_AISLES = new Set(['F8F'])

const FACILITIES = [
  { id: 'cal', label: 'Caledonia' },
  { id: 'ken', label: 'Kenosha' },
  { id: 'mad', label: 'Madison' },
  { id: 'wr', label: 'Wisconsin Rapids' },
  { id: 'ec', label: 'Eau Claire' },
]

const cardStyle = {
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: '14px 18px',
  minWidth: 130,
}

function TotalCard({ total }) {
  return (
    <div style={{ ...cardStyle, borderColor: 'var(--brand, #d4a72c)', borderWidth: 2, borderStyle: 'solid' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--brand, #d4a72c)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Total
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
        {total}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
        open positions
      </div>
    </div>
  )
}

// ── Madison panel — reads the same live data as the Labor Planning tab's
// F8OpenPositions.jsx, no duplicate Notify/ignore-management controls here ──
function MadisonPanel() {
  const [data, setData] = useState(null)
  const [ignored, setIgnored] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([fetchF8OpenPositions(), fetchIgnoredLocations().catch(() => [])])
      .then(([d, ig]) => { if (!cancelled) { setData(d); setIgnored(ig) } })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const activeIgnoredNames = useMemo(() => {
    const now = Date.now()
    const set = new Set()
    for (const i of ignored) {
      if (!i.ignored_until || new Date(i.ignored_until).getTime() > now) set.add(i.location_name)
    }
    return set
  }, [ignored])

  const rawLocations = data?.locations ?? []

  const visibleAisles = useMemo(() => {
    const byAisle = {}
    for (const a of AISLE_ORDER) byAisle[a] = { aisle: a, empty: 0, oneLp: 0, openPositions: 0 }
    for (const loc of rawLocations) {
      if (activeIgnoredNames.has(loc.location)) continue
      const bucket = byAisle[loc.aisle]
      if (!bucket) continue
      if (loc.lpCount === 0) bucket.empty += 1
      if (loc.lpCount === 1) bucket.oneLp += 1
      bucket.openPositions += loc.openPositions
    }
    return AISLE_ORDER.map(a => byAisle[a])
  }, [rawLocations, activeIgnoredNames])

  const total = useMemo(() => visibleAisles.reduce((s, a) => s + a.openPositions, 0), [visibleAisles])

  if (loading) return <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading live data…</p>
  if (error) return <div style={{ color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{error}</div>

  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12 }}>
        F8 aisles B–F · B–E: Empty = 2 open, 1 LP = 1 open · F: Empty = 1 open (1 LP = full)
        {activeIgnoredNames.size > 0 && ` · ${activeIgnoredNames.size} location${activeIgnoredNames.size === 1 ? '' : 's'} ignored`}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {visibleAisles.map(a => (
          <div key={a.aisle} style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {a.aisle}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
              {a.openPositions}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
              {SINGLE_POSITION_AISLES.has(a.aisle) ? <>{a.empty} empty</> : <>{a.empty} empty · {a.oneLp} 1&nbsp;LP</>}
            </div>
          </div>
        ))}
        <TotalCard total={total} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 12 }}>
        Managed from Labor Planning → Madison → F8 Open Positions (Notify settings, ignored locations).
      </div>
    </div>
  )
}

// ── Generic panel — CAL/KEN/WR/EC ──
function GenericFacilityPanel({ facility }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchOpenPositions(facility)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [facility])

  useEffect(() => { load() }, [load])

  if (loading) return <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading live data…</p>
  if (error) {
    return (
      <div style={{ padding: '10px 14px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid #e05a5a', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
        <strong>Failed to load data:</strong> {error}
        <button onClick={load} style={{ marginLeft: 12, fontSize: 11, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #e05a5a', background: 'transparent', color: '#e05a5a' }}>Retry</button>
      </div>
    )
  }

  const zones = data?.zones ?? []
  const total = data?.totalOpenPositions ?? 0

  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
        Empty locations only — 1 open position each. Capacity-per-location isn't tracked in Datex here (same as
        Caledonia's cycle-count data), so this is a conservative default until confirmed otherwise.
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 14 }}>
        {zones.length} zone{zones.length === 1 ? '' : 's'} · fetched {data?.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : '—'}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {zones.map(z => (
          <div key={z.zone} style={cardStyle}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {z.zone}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
              {z.openPositions}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
              {z.empty} of {z.totalLocations}
            </div>
          </div>
        ))}
        <TotalCard total={total} />
      </div>
    </div>
  )
}

export default function CurrentOpenPositions() {
  const [facility, setFacility] = useState('mad')

  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 640 }}>
        Live pull-up of open pallet positions per facility — no schedule, no digest, just what's open right now.
      </div>
      <div className="cal2-tab-row" style={{ marginBottom: 16 }}>
        {FACILITIES.map(f => (
          <button
            key={f.id}
            className={`cal2-tab${facility === f.id ? ' active' : ''}`}
            onClick={() => setFacility(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {facility === 'mad' ? <MadisonPanel /> : <GenericFacilityPanel key={facility} facility={facility} />}
    </div>
  )
}
