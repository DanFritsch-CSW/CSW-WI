import { useState, useEffect } from 'react'
import { fetchWrCasesToPick } from '../lib/wrCasesToPick.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'

// WR "Cases To Pick" sub-tab (added 2026-07-14) — recreates the Omni
// dashboard Dan uses as his benchmark (screenshotted 2026-07-14), sourced
// from MotherDuck instead of Omni. Scope: Bernatello's - Wisconsin Rapids
// only, same project scope as the existing Pickline tab. See
// netlify/functions/motherduck-wr-cases.cjs header comment for the exact
// filter logic this was reverse-engineered from.
//
// Dan's plan: "I'll add more to that tab once we got this recreated" — so
// this ships the 6-tile benchmark only; further additions are a separate
// pass once the numbers are confirmed to match Omni.
//
// Notify settings panel (added 2026-07-14, per Dan: "just as we did in
// the Madison PrePick Status") — same shared NotifySettingsPanel component
// PrePickStatus.jsx uses, backed by prepick_notify_settings
// (facility='wr', dashboard_type='cases_to_pick'). Posts a nightly digest
// comment to a configured Front conversation at a configurable time —
// functionName points at wr-cases-digest-test.cjs (changed 2026-07-31,
// was wr-cases-digest-run) since Netlify blocks direct invocation of any
// function carrying a `schedule`, which is what made "Send test digest
// now" 403. See wr-cases-digest-run.cjs / lib/wr-cases-digest-shared.cjs
// for the full story, and NotifySettingsPanel.jsx for the UI mechanics.

function fmt(n) {
  if (n == null) return '—'
  return Math.round(n).toLocaleString()
}

function StatTile({ label, value, sub }) {
  return (
    <div style={{
      background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4,
      minWidth: 220,
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{fmt(value)}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  )
}

export default function WrCasesToPick({ planDate }) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchWrCasesToPick(planDate)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [planDate])

  return (
    <div style={{ padding: '16px 4px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
        {planDate} · Bernatello's - Wisconsin Rapids
      </div>

      <NotifySettingsPanel
        facility="wr"
        dashboardType="cases_to_pick"
        functionName="wr-cases-digest-test"
        digestDescription="Nightly digest posts as a comment on this Front conversation, summarizing tomorrow's Bernatello's WR Cases To Pick numbers."
      />

      {loading && (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          Loading…
        </div>
      )}

      {error && (
        <div style={{
          padding: '8px 12px', color: '#e05a5a', fontSize: 12, fontFamily: 'var(--font-mono)',
          background: 'var(--bg2)', borderRadius: 8, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <StatTile label="Total DSD Cases (Pickline & Outside)" value={data.totalDsdCases} />
          <StatTile
            label="Cases To Pick Outside Pickline"
            value={data.casesOutsidePickline}
            sub={`Full pallet pick: ${fmt(data.fullPalletPickCount)} · Case pick: ${fmt(data.casePickCases)}`}
          />
          <StatTile label="Pickline Volume" value={data.picklineVolume} />
          <StatTile label="NON-DSD Cases" value={data.nonDsdCases} />
          <StatTile label="# of Full Pallets" value={data.fullPalletsSo} />
          <StatTile label="Case Picking on SO Orders" value={data.casePickingOnSoOrders} />
        </div>
      )}
    </div>
  )
}
