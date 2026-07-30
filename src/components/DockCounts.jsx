import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchDockCounts, DOCK_ROWS, buildDockCountsMessage } from '../lib/dockCounts.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'

// Madison Dock Counts — added 2026-07-30 per Dan's ops manager's daily
// manual message ("Looking ahead to tomorrow, Dock 8 has N inbound and N
// outbound loads..."). Counting method (dock location name, not
// appointment type) is documented in motherduck-dock-counts.cjs's header —
// confirmed against the ops manager's own East/West example counts before
// shipping.
//
// Placement — REVISED same day per Dan's feedback: originally shipped as
// its own MAD_TABS entry ("Dock Counts" tab); Dan didn't like a separate
// tab and wanted this folded into the Daily Ops tab instead, next to its
// existing Notify Settings section. Now rendered inline inside
// FacilityPanel.jsx's `warehouseContent`, directly under the daily_ops
// NotifySettingsPanel, gated `isDaily && isMad` — no MAD_TABS entry, no
// separate route.
//
// Scope, per Dan's explicit call: ON-DEMAND PULL for now, not an automated
// nightly digest — this fetches live on mount/date-change/refresh-click
// only. The NotifySettingsPanel below is fully wired (Front conversation
// ID, send time, Mon-Fri toggle) exactly like every other MAD digest, but
// the underlying prepick_notify_settings row is left/seeded with
// active=false, so nothing fires on a schedule until Dan checks Enabled
// himself — that's the "ability to toggle it back on" he asked for.
//
// "Alex and Troy will be here to help" (staffing note in Dan's example
// message) has no data source in this app (nothing ties an employee to
// "helping on the dock" in that sense) — deliberately NOT included here;
// stays a manual addition if/when this message actually gets sent.

function tomorrowISO() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

export default function DockCounts() {
  const [date, setDate] = useState(tomorrowISO())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [copyMsg, setCopyMsg] = useState(null)

  const load = useCallback((d) => {
    setLoading(true)
    setError(null)
    fetchDockCounts(d)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(date) }, [date, load])

  const message = useMemo(() => {
    if (!data) return ''
    return buildDockCountsMessage(data.date, data.docks)
  }, [data])

  function copyMessage() {
    navigator.clipboard.writeText(message)
      .then(() => setCopyMsg('Copied.'))
      .catch(() => setCopyMsg('Copy failed — select and copy manually.'))
    setTimeout(() => setCopyMsg(null), 2500)
  }

  const inputStyle = {
    background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)', padding: '3px 6px',
  }
  const btnStyle = {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
    padding: '4px 10px', cursor: 'pointer',
  }

  return (
    <div style={{ padding: '16px 4px', borderTop: '1px solid var(--border)', marginTop: 8 }}>
      <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>Dock Counts</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 680 }}>
        Inbound/outbound load counts by dock (Dock 8, East, West), counted the same way the ops manager
        does — by which dock/location the appointment is scheduled at, not the appointment's own
        inbound/outbound type. Pulled on demand; use Notify Settings below to turn on an automated
        nightly Front post instead.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={{ color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>Date:</label>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
        <button type="button" style={btnStyle} onClick={() => load(date)} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <button type="button" style={btnStyle} onClick={copyMessage} disabled={!data}>
          Copy message
        </button>
        {copyMsg && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{copyMsg}</span>}
      </div>

      <NotifySettingsPanel
        facility="mad"
        dashboardType="dock_counts"
        functionName="dockcounts-digest-run"
        digestDescription="Posts the same dock-count breakdown shown below as a Front comment."
        contentDateLabel="tomorrow"
      />

      {error && (
        <div style={{
          padding: '8px 12px', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)',
          background: 'var(--bg2)', borderRadius: 8, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          Loading…
        </div>
      )}

      {data && (
        <>
          <div style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', maxWidth: 360 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ background: 'var(--bg0)', textAlign: 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-dim)' }}>
                  <th style={{ padding: '10px 14px' }}></th>
                  <th style={{ padding: '10px 14px', textAlign: 'right' }}>In</th>
                  <th style={{ padding: '10px 14px', textAlign: 'right' }}>Out</th>
                </tr>
              </thead>
              <tbody>
                {DOCK_ROWS.map(row => {
                  const d = data.docks?.[row.key] || { in: 0, out: 0 }
                  return (
                    <tr key={row.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>{row.label}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--text-primary)' }}>{d.in}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--text-primary)' }}>{d.out}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {data.docks?.other && (data.docks.other.in > 0 || data.docks.other.out > 0) && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#d4a72c', fontFamily: 'var(--font-mono)' }}>
              {data.docks.other.in + data.docks.other.out} load(s) at an unrecognized dock/location
              {data.otherLocations?.length ? `: ${data.otherLocations.map(l => l.locationName).join(', ')}` : ''}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
              Message preview (Front-ready):
            </div>
            <pre style={{
              background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '12px 16px', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap', maxWidth: 420,
            }}>
              {message}
            </pre>
          </div>

          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 10, fontFamily: 'var(--font-mono)' }}>
            fetched {new Date(data.fetchedAt).toLocaleTimeString()} · {data.elapsedMs}ms
          </div>
        </>
      )}
    </div>
  )
}
