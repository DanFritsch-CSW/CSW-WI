import { useMemo, useState, useEffect } from 'react'
import { fetchDpiPickline } from '../lib/dpiPickline.js'

// ─── DPI Pickline ────────────────────────────────────────────────────────
// Replaces the DPI Putaways tab (2026-08-26 per Dan's request). Covers the
// 34 F8E/F8F primary pick positions (F8E01-1A..F8E17-1A, F8F01-1A..F8F17-1A)
// slotted during this session's planning work: SKUs ranked by 2-year
// spread-order pick-line frequency (many-SKU, modest-qty orders — DPI's
// dominant order shape at Madison — not raw case volume, which is
// dominated by occasional bulk-only lines that never touch a forward pick
// slot regardless of primary setup), cross-checked against real observed
// cases/pallet from received inventory since Datex's configured tie/high
// was found unreliable for several of these SKUs.
//
// This is deliberately a RESLOT TASK LIST, not a replenishment/depletion
// monitor. Same-day live checking found that although Datex's IsPrimaryPick
// flag went live on all 34 locations, flipping that flag doesn't move or
// clear whatever product physically occupies the spot — a live occupancy
// check found only 1 of 34 locations actually held its designated SKU.
// 11 held another customer's product entirely (Saputo, Jones Dairy Farm).
// A depletion/status monitor built on top of that would have been fiction.
// Once reslotting is actually done, this same view naturally becomes
// useful as a status check (every position shows "match" instead of a
// reslot flag) — no rebuild needed, just a change in what the live data
// shows.
//
// LIVE DATA: netlify/functions/motherduck-dpi-pickline.cjs on every load —
// the designated SKU-per-location list is hardcoded there (see that
// file's header for why: the Datex material-to-location binding table
// hadn't synced through as of this build), actual occupancy is queried
// live from MotherDuck every time this tab loads.

const LEVEL_META = {
  other_customer: { label: 'Other customer product', color: 'var(--red)', order: 0 },
  wrong_dpi:      { label: 'Wrong DPI SKU',           color: 'var(--yellow)', order: 1 },
  empty:          { label: 'Empty — no product',      color: 'var(--text-dim)', order: 2 },
  match:          { label: 'Correct — ready',         color: 'var(--green)', order: 3 },
}

export default function DpiPickline() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    fetchDpiPickline()
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshTick])

  const positions = data?.positions ?? []

  const counts = useMemo(() => {
    const c = { other_customer: 0, wrong_dpi: 0, empty: 0, match: 0 }
    for (const p of positions) c[p.level] = (c[p.level] ?? 0) + 1
    return c
  }, [positions])

  const filtered = filter === 'all' ? positions : positions.filter(p => p.level === filter)
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => LEVEL_META[a.level].order - LEVEL_META[b.level].order),
    [filtered]
  )

  const cardStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '12px 16px' }
  const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }
  const valueStyle = { fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 500 }

  if (loading && !data) {
    return <div style={{ padding: 20, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>Loading DPI Pickline…</div>
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
      <div style={{ marginBottom: 12 }}>
        <div className="section-label" style={{ marginBottom: 4 }}>DPI Pickline — F8E/F8F Primary Pick Reslot</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 680 }}>
          34 designated primary positions (F8E01-1A–F8E17-1A, F8F01-1A–F8F17-1A). Datex's IsPrimaryPick flag is live on all 34 —
          this checks what's actually sitting in each one right now against what's designated, live on every load. Flipping the
          flag doesn't move or clear existing product, so this starts as a reslot task list, not a status monitor.
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          {data?.fetchedAt && <span>as of {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
          <button className="est-reset-btn" onClick={() => setRefreshTick(t => t + 1)} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh'}</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <div
          onClick={() => setFilter(filter === 'other_customer' ? 'all' : 'other_customer')}
          style={{ ...cardStyle, borderTop: '2px solid var(--red)', cursor: 'pointer', outline: filter === 'other_customer' ? '1px solid var(--red)' : 'none' }}
        >
          <div style={labelStyle}>Other customer product</div>
          <div style={{ ...valueStyle, color: 'var(--red)' }}>{counts.other_customer}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>clear first</div>
        </div>
        <div
          onClick={() => setFilter(filter === 'wrong_dpi' ? 'all' : 'wrong_dpi')}
          style={{ ...cardStyle, borderTop: '2px solid var(--yellow)', cursor: 'pointer', outline: filter === 'wrong_dpi' ? '1px solid var(--yellow)' : 'none' }}
        >
          <div style={labelStyle}>Wrong DPI SKU</div>
          <div style={{ ...valueStyle, color: 'var(--yellow)' }}>{counts.wrong_dpi}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>internal reslot</div>
        </div>
        <div
          onClick={() => setFilter(filter === 'empty' ? 'all' : 'empty')}
          style={{ ...cardStyle, cursor: 'pointer', outline: filter === 'empty' ? '1px solid var(--text-dim)' : 'none' }}
        >
          <div style={labelStyle}>Empty</div>
          <div style={valueStyle}>{counts.empty}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>no product yet</div>
        </div>
        <div
          onClick={() => setFilter(filter === 'match' ? 'all' : 'match')}
          style={{ ...cardStyle, borderTop: '2px solid var(--green)', cursor: 'pointer', outline: filter === 'match' ? '1px solid var(--green)' : 'none' }}
        >
          <div style={labelStyle}>Correct — ready</div>
          <div style={{ ...valueStyle, color: 'var(--green)' }}>{counts.match}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>nothing to do</div>
        </div>
      </div>

      {filter !== 'all' && (
        <div style={{ marginBottom: 8 }}>
          <button className="est-reset-btn" onClick={() => setFilter('all')}>← show all 34</button>
        </div>
      )}

      {counts.other_customer > 0 && filter === 'all' && (
        <div style={{ ...cardStyle, marginBottom: 12, borderLeft: '3px solid var(--red)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--red)' }}>{counts.other_customer} position{counts.other_customer === 1 ? '' : 's'}</strong> currently
          hold another customer's product, not a DPI slotting inefficiency. Worth resolving before anything else on this list, and
          worth checking how it happened — these bays weren't supposed to hold anyone's reserve stock but DPI's.
        </div>
      )}

      <div style={{ maxHeight: 560, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }}>
        <table className="hourly-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Location</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'left' }}>Designated</th>
              <th style={{ textAlign: 'left' }}>Actually there</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>No positions match this filter.</td></tr>
            )}
            {sorted.map(p => {
              const meta = LEVEL_META[p.level]
              return (
                <tr key={p.loc}>
                  <td style={{ textAlign: 'left', fontWeight: 600 }}>{p.loc}</td>
                  <td style={{ textAlign: 'left', color: meta.color }}>{meta.label}</td>
                  <td style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                    <span style={{ fontWeight: 600 }}>{p.sku}</span> — {p.desc}
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    {p.actual.length === 0 ? (
                      <span style={{ color: 'var(--text-dim)' }}>—</span>
                    ) : (
                      p.actual.map((a, i) => (
                        <div key={i} style={{ color: a.isDpi ? 'var(--text-secondary)' : 'var(--red)' }}>
                          <span style={{ fontWeight: 600 }}>{a.sku}</span> — {a.desc}
                          {!a.isDpi && <span> ({a.project})</span>}
                          <span style={{ color: 'var(--text-dim)' }}> · {a.qty} cs</span>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
