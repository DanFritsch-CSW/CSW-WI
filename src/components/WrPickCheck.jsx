import { useState, useEffect, useMemo } from 'react'
import { fetchWrPickCheck } from '../lib/wrPickCheck.js'

// WR "Pick Location Lot Check" sub-tab (added 2026-07-14) -- Dan's real ask
// from a recorded call with Kaylee: verify daily whether the OLDEST
// on-hand lot of each Bernatello's material is actually sitting in a
// primary pick location right now, or whether a newer lot got put there
// for convenience while the true oldest lot sits in secondary/reserve.
// Not an enforcement tool -- a verification checklist meant to catch and
// correct before it becomes a hard-move / lot-error / refund-task problem.
//
// See netlify/functions/motherduck-wr-pick-check.cjs header comment for
// the full query design and the key discovery that Datex's
// is_primary_pick flag is live/native -- location assignment is NOT a
// static material->location map (confirmed the originally-planned Excel-
// based map was already stale against live data before building this).
//
// Status meanings:
//   ok          -- oldest lot has at least some cases in a primary slot
//   mismatch    -- oldest lot has ZERO cases in any primary slot, but the
//                 material does have a primary slot with other stock in it
//                 (a newer lot is what's actually being picked)
//   no_location -- material has no on-hand stock in any primary slot at
//                 all right now. Ambiguous by design: could mean no slot
//                 exists for it, or the slot is just empty between
//                 restocks. Flagged separately from mismatch, not blended.

const STATUS_META = {
  ok:          { label: 'OLDEST LOT IN PLACE',     color: '#3fb950', bg: 'rgba(63,185,80,0.12)' },
  mismatch:    { label: 'OLDEST LOT IN SECONDARY', color: '#e05a5a', bg: 'rgba(224,90,90,0.12)' },
  no_location: { label: 'NO PRIMARY LOCATION',     color: '#d4a72c', bg: 'rgba(212,167,44,0.12)' },
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatCard({ label, value, tone, onClick, active }) {
  const toneColor = tone ? STATUS_META[tone].color : 'var(--text-primary)'
  return (
    <button
      onClick={onClick}
      style={{
        background: 'var(--bg1)', border: `1px solid ${active ? toneColor : 'var(--border)'}`,
        borderRadius: 8, padding: '14px 18px', textAlign: 'left', cursor: 'pointer',
        minWidth: 180, boxShadow: active ? `0 0 0 1px ${toneColor}` : 'none',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: toneColor, marginTop: 2 }}>{value}</div>
    </button>
  )
}

function Badge({ status }) {
  const m = STATUS_META[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999,
      border: `1px solid ${m.color}`, background: m.bg, color: m.color,
      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  )
}

export default function WrPickCheck() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [filter, setFilter]   = useState('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchWrPickCheck()
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const rows = useMemo(() => {
    if (!data?.materials) return []
    if (filter === 'all') return data.materials
    return data.materials.filter(m => m.status === filter)
  }, [data, filter])

  return (
    <div style={{ padding: '16px 4px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
        Bernatello's - Wisconsin Rapids · live snapshot
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 640 }}>
        Is the oldest on-hand lot of each material actually sitting in a primary pick location right now?
        Verification only -- nothing here blocks a pick.
      </div>

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
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
            <StatCard label="Materials Checked" value={data.summary.total} onClick={() => setFilter('all')} active={filter === 'all'} />
            <StatCard label="Oldest Lot In Place" value={data.summary.ok} tone="ok" onClick={() => setFilter('ok')} active={filter === 'ok'} />
            <StatCard label="Oldest Lot In Secondary" value={data.summary.mismatch} tone="mismatch" onClick={() => setFilter('mismatch')} active={filter === 'mismatch'} />
            <StatCard label="No Primary Location" value={data.summary.noLocation} tone="no_location" onClick={() => setFilter('no_location')} active={filter === 'no_location'} />
          </div>

          <div style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg0)', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-dim)' }}>
                  <th style={{ padding: '10px 14px' }}>Material</th>
                  <th style={{ padding: '10px 14px' }}>Oldest On-Hand Lot</th>
                  <th style={{ padding: '10px 14px' }}>Primary Slot Cases</th>
                  <th style={{ padding: '10px 14px' }}>Secondary Cases</th>
                  <th style={{ padding: '10px 14px' }}>Current Lot In Slot</th>
                  <th style={{ padding: '10px 14px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.materialId} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{m.materialName}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{m.materialCode}</div>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{m.oldestLotCode ?? '—'}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        {fmtDate(m.oldestExpirationDate)}{m.daysRemaining != null ? ` · ${m.daysRemaining}d` : ''}
                      </div>
                    </td>
                    <td style={{ padding: '10px 14px', color: m.casesInPrimary > 0 ? 'var(--text-primary)' : 'var(--text-dim)' }}>
                      {m.casesInPrimary}
                      {m.primaryLocations && (
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{m.primaryLocations}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-secondary)' }}>
                      {m.casesInSecondary}
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                      {m.currentLotCodes ?? '—'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <Badge status={m.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 10, fontFamily: 'var(--font-mono)' }}>
            fetched {new Date(data.fetchedAt).toLocaleTimeString()} · {data.elapsedMs}ms
          </div>
        </>
      )}
    </div>
  )
}
