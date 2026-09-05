import { useState, useEffect, useCallback } from 'react'
import { fetchF8OpenPositions } from '../lib/f8OpenPositions.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'

// ─── F8 Open Positions ───────────────────────────────────────────────────
// Added 2026-09-04, sits next to "DPI Pickline" in FacilityPanel.jsx's
// MAD_TABS row. Per Dan's request, kept deliberately simple: just how
// many open pallet positions exist per aisle in F8B-F8E, no drill-down
// table, no filters.
//
// Definition (Dan's explicit rule):
//   - a location with ZERO license plates ("Empty")     = 2 open positions
//   - a location with EXACTLY ONE license plate ("1 LP") = 1 open position
//   - anything else (2+ LPs)                             = 0 open positions
// Computed server-side in motherduck-f8-open-positions.cjs -- see that
// file's header for the query and classification logic.
//
// Notify digest (added same day, per Dan's follow-up ask): reuses the
// same shared NotifySettingsPanel component every other digest in this
// app uses -- M-F day toggles, configurable send time, Enabled checkbox,
// Front conversation ID, "Send test digest now" -- backed by
// prepick_notify_settings (facility='mad',
// dashboard_type='f8_open_positions'). See
// lib/f8-open-positions-digest-shared.cjs for the digest itself, which
// runs its own independent copy of the same query/classification logic
// (same "self-contained port" convention as jdf-scorecard-digest-
// shared.cjs), so the digest number can never drift from what this tab
// shows.

const cardStyle = {
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: '16px 20px',
  minWidth: 150,
}

export default function F8OpenPositions() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await fetchF8OpenPositions()
      setData(d)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const aisles = data?.aisles ?? []
  const total = data?.totalOpenPositions ?? 0

  const refreshLabel = lastRefresh
    ? lastRefresh.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }) +
      ' ' + lastRefresh.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'loading…'

  return (
    <div style={{ padding: '16px 4px', fontSize: 13 }}>
      <div style={{ marginBottom: 4 }}>
        <div className="section-label" style={{ marginBottom: 4 }}>F8 Open Positions</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          CSW-Madison · F8 aisles B–E · Empty = 2 open · 1 LP = 1 open
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 16px', flexWrap: 'wrap' }}>
        <button
          onClick={load}
          disabled={loading}
          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: loading ? 'default' : 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', opacity: loading ? 0.5 : 1 }}
        >
          {loading ? '⟳ Loading…' : '↻ Refresh'}
        </button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
          as of {refreshLabel}
        </span>
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid #e05a5a', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          <strong>Failed to load data:</strong> {error}
          <button onClick={load} style={{ marginLeft: 12, fontSize: 11, padding: '2px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #e05a5a', background: 'transparent', color: '#e05a5a' }}>
            Retry
          </button>
        </div>
      )}

      {loading && !lastRefresh ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>Loading live data…</p>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          {aisles.map(a => (
            <div key={a.aisle} style={cardStyle}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {a.aisle}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
                {a.openPositions}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
                {a.empty} empty · {a.oneLp} 1&nbsp;LP
              </div>
            </div>
          ))}

          <div style={{ ...cardStyle, borderColor: 'var(--brand, #d4a72c)', borderWidth: 2, borderStyle: 'solid' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--brand, #d4a72c)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Total F8
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 700, color: 'var(--brand, #d4a72c)', lineHeight: 1 }}>
              {total}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
              open positions
            </div>
          </div>
        </div>
      )}

      <NotifySettingsPanel
        facility="mad"
        dashboardType="f8_open_positions"
        functionName="f8-open-positions-digest-test"
        contentDateLabel="today"
        showSkipToNextValidDay={false}
        digestDescription="Posts today's F8 Open Positions count per aisle (F8B–F8E) plus the total as a Front comment."
      />
    </div>
  )
}
