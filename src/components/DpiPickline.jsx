import { useMemo, useState, useEffect, useCallback } from 'react'
import { fetchDpiPickline } from '../lib/dpiPickline.js'
import '../styles/dpi-pickline.css'

// ─── DPI Pickline ────────────────────────────────────────────────────────
// Replaces the DPI Putaways tab (2026-08-26). Rebuilt 2026-08-26 (same day,
// later) to mimic WrSecondaryRepl.jsx's card/pull-suggestion layout per
// Dan's direct ask — two columns (F8E left, F8F right) instead of WR's
// single-column-with-aisle-toggle, since DPI's two bays are meant to be
// worked side by side, not switched between.
//
// Ported from WrSecondaryRepl.jsx's real, live conventions (not guessed):
//   - Card-per-position layout, urgency-colored status line
//   - "Pull from" suggestion block, live reserve locations ranked by qty
//     (WR ranks furthest-aisle-first since it's replenishing a shared pick
//     face from anywhere in the building; DPI ranks by qty descending —
//     fewest physical pallet moves to complete the reslot — since there's
//     no equivalent aisle-priority convention for this freezer bay)
//   - Filter buttons + sort toggle, print button with dedicated print CSS
//   - Refresh button + last-fetched timestamp
// NOT ported: WR's split-face/buffer-slot logic (no DPI equivalent — one
// SKU per position here, no shared multi-material bays) and its Notify
// digest panel (flagged to Dan as a natural next step, not built this
// pass — needs a new digest function + Supabase settings row).
//
// LIVE DATA: netlify/functions/motherduck-dpi-pickline.cjs — designated
// SKU-per-location list hardcoded there (see that file's header for why),
// actual occupancy AND real "pull from" reserve locations queried live on
// every load.

const LEVEL_META = {
  other_customer: { label: 'Other customer product', color: '#e05a5a', order: 0 },
  wrong_dpi:      { label: 'Wrong DPI SKU',           color: '#d4a72c', order: 1 },
  empty:          { label: 'Empty — no product',      color: 'var(--text-dim)', order: 2 },
  match:          { label: 'Correct — ready',         color: '#3fb950', order: 3 },
}

function urgencyColor(level) {
  return LEVEL_META[level]?.color ?? 'var(--text-dim)'
}

function PullSuggestions({ pullFrom }) {
  if (!pullFrom || pullFrom.length === 0) return null
  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>Pull from</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {pullFrom.map((r, i) => (
          <span key={i} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: 'rgba(212,167,44,0.12)', color: '#d4a72c', border: '1px solid rgba(212,167,44,0.35)', fontFamily: 'var(--font-mono)' }}>
            {r.loc} <span style={{ opacity: 0.7 }}>{r.qty} cs</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function PositionCard({ pos }) {
  const meta = LEVEL_META[pos.level]
  const urg = urgencyColor(pos.level)
  const cardStyle = { border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--bg1)', marginBottom: 8 }

  return (
    <div className="dpi-pickline-card" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{pos.loc}</span>
        <span style={{ fontSize: 12, color: urg, fontWeight: 600 }}>{meta.label}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
        Designated: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pos.sku}</span> — {pos.desc}
      </div>

      {pos.level !== 'match' && pos.actual.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {pos.actual.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
              <span style={{
                fontSize: 10, padding: '1px 5px', borderRadius: 3,
                background: a.isDpi ? 'var(--bg2)' : 'rgba(224,90,90,0.14)',
                color: a.isDpi ? 'var(--text-secondary)' : '#e05a5a',
                border: `1px solid ${a.isDpi ? 'var(--border-subtle)' : 'rgba(224,90,90,0.35)'}`,
              }}>
                {a.sku} — {a.desc}{!a.isDpi ? ` (${a.project})` : ''} · {a.qty} cs
              </span>
            </div>
          ))}
        </div>
      )}
      {pos.level === 'empty' && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 4 }}>No product currently in this location.</div>
      )}

      {pos.level !== 'match' && <PullSuggestions pullFrom={pos.pullFrom} />}
      {pos.level !== 'match' && (!pos.pullFrom || pos.pullFrom.length === 0) && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 6, fontSize: 11, color: '#e05a5a', fontStyle: 'italic' }}>
          No reserve inventory found for this SKU anywhere else in the building.
        </div>
      )}
    </div>
  )
}

function BayColumn({ title, capacityLabel, positions }) {
  return (
    <div className="dpi-pickline-col">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{capacityLabel}</span>
      </div>
      {positions.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>No positions match the current filter.</p>
      ) : (
        positions.map(p => <PositionCard key={p.loc} pos={p} />)
      )}
    </div>
  )
}

const FILTER_LABELS = {
  all: 'All Positions',
  other_customer: 'Other Customer Product',
  wrong_dpi: 'Wrong DPI SKU',
  empty: 'Empty',
  match: 'Correct — Ready',
}

export default function DpiPickline() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('position')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchDpiPickline()
      setData(d)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const positions = data?.positions ?? []

  const counts = useMemo(() => {
    const c = { other_customer: 0, wrong_dpi: 0, empty: 0, match: 0 }
    for (const p of positions) c[p.level] = (c[p.level] ?? 0) + 1
    return c
  }, [positions])

  const filtered = filter === 'all' ? positions : positions.filter(p => p.level === filter)
  const sortFn = sort === 'position'
    ? (a, b) => a.loc.localeCompare(b.loc)
    : (a, b) => LEVEL_META[a.level].order - LEVEL_META[b.level].order

  const eCol = [...filtered.filter(p => p.bay === '8E')].sort(sortFn)
  const fCol = [...filtered.filter(p => p.bay === '8F')].sort(sortFn)

  const refreshLabel = lastRefresh
    ? lastRefresh.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) + ' ' + lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'loading…'

  return (
    <div style={{ padding: '16px 4px', fontSize: 13 }}>
      <div className="dpi-pickline-print-title">
        DPI Pickline — F8E / F8F Primary Pick Reslot — {FILTER_LABELS[filter]}
      </div>

      <div className="dpi-pickline-no-print" style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
        DPI - CSW-Madison · data {refreshLabel}
      </div>
      <div className="dpi-pickline-no-print" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 700 }}>
        34 designated primary positions. Datex's IsPrimaryPick flag is live on all 34 — this checks what's actually sitting in
        each one against what's designated, live on every load, and where to pull the correct SKU from to fix it.
      </div>

      <div className="dpi-pickline-no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <button
          onClick={load}
          disabled={loading}
          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'default' : 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', opacity: loading ? 0.5 : 1 }}
        >
          {loading ? '⟳ Loading…' : '↻ Refresh data'}
        </button>
        <button
          onClick={() => window.print()}
          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          Print / Save PDF
        </button>
        <select value={filter} onChange={e => setFilter(e.target.value)} className="settings-field-input" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6 }}>
          <option value="all">All positions</option>
          <option value="other_customer">Other customer product</option>
          <option value="wrong_dpi">Wrong DPI SKU</option>
          <option value="empty">Empty</option>
          <option value="match">Correct — ready</option>
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)} className="settings-field-input" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6 }}>
          <option value="position">Sort: position</option>
          <option value="severity">Sort: worst first</option>
        </select>
      </div>

      <div className="dpi-pickline-no-print" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {[
          { key: 'other_customer', label: 'Other customer product', val: counts.other_customer, color: '#e05a5a' },
          { key: 'wrong_dpi', label: 'Wrong DPI SKU', val: counts.wrong_dpi, color: '#d4a72c' },
          { key: 'empty', label: 'Empty', val: counts.empty, color: 'var(--text-primary)' },
          { key: 'match', label: 'Correct — ready', val: counts.match, color: '#3fb950' },
        ].map(s => (
          <button
            key={s.key}
            onClick={() => setFilter(filter === s.key ? 'all' : s.key)}
            style={{
              textAlign: 'left', background: 'var(--bg1)', border: `1px solid ${filter === s.key ? s.color : 'var(--border)'}`,
              borderRadius: 8, padding: '10px 16px', minWidth: 150, cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, color: s.color }}>{loading ? '—' : s.val}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)' }}>{s.label}</div>
          </button>
        ))}
      </div>

      {counts.other_customer > 0 && filter === 'all' && (
        <div className="dpi-pickline-no-print" style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 6, background: 'var(--bg2)', borderLeft: '3px solid #e05a5a', fontSize: 12, color: 'var(--text-secondary)' }}>
          <strong style={{ color: '#e05a5a' }}>{counts.other_customer} position{counts.other_customer === 1 ? '' : 's'}</strong> hold another
          customer's product, not a DPI slotting issue — worth resolving first, and worth understanding how it happened.
        </div>
      )}

      {error && (
        <div className="dpi-pickline-no-print" style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid #e05a5a', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          <strong>Failed to load data:</strong> {error}
          <button onClick={load} style={{ marginLeft: 12, fontSize: 11, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #e05a5a', background: 'transparent', color: '#e05a5a' }}>
            Retry
          </button>
        </div>
      )}

      {loading && !lastRefresh ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading live data…</p>
      ) : (
        <div className="dpi-pickline-grid">
          <BayColumn title="F8E" capacityLabel="58 positions · 2 plt" positions={eCol} />
          <BayColumn title="F8F" capacityLabel="50 positions · 2 plt" positions={fCol} />
        </div>
      )}

      {lastRefresh && (
        <div className="dpi-pickline-no-print" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 10, fontFamily: 'var(--font-mono)' }}>
          fetched {lastRefresh.toLocaleTimeString()} {data?.elapsedMs != null ? `· ${data.elapsedMs}ms` : ''}
        </div>
      )}
    </div>
  )
}
