import { useState, useEffect, useMemo } from 'react'
import { fetchWrPickCheck } from '../lib/wrPickCheck.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'

// WR "Pick Location Lot Check" sub-tab. Real ask from a recorded call
// between Dan and Kaylee: verify daily whether the OLDEST AVAILABLE
// on-hand lot of each Bernatello's material is actually sitting in a
// primary pick location right now. If not, is it staged in the
// secondaries (overhead rack directly above)? If not, it's out in the
// warehouse. Not an enforcement tool — a verification checklist meant to
// catch and correct before it becomes a hard-move / lot-error / refund-
// task problem, and to flag aging inventory back to the customer.
//
// See netlify/functions/motherduck-wr-pick-check.cjs header comment for
// the full query design: the is_primary_pick / F0xx-G0xx secondary-rack
// discovery, the committed-cases netting (gross on-hand overstates what's
// truly available), and why "Currently In Primary" is deliberately gross
// (not netted) — it shows whatever's physically in the slot even when
// every case there is already committed to an order.
//
// Status meanings:
//   primary    — oldest available lot has cases in the primary slot
//   secondary  — oldest available lot is staged in the overhead rack
//                directly above (F0xx odd-numbered slots, G0xx even) —
//                a newer lot is what's actually being picked, but the
//                true oldest is one pull-down away
//   warehouse  — oldest available lot is neither in primary nor the
//                overhead rack — genuinely out in the building, including
//                materials with no primary-slot presence at all right now
//
// Aging severity mirrors the 120-day Omni report (Critical <30d, Warning
// 30-59d, Watch 60-119d) — folded in per Dan's request so this one report
// can also drive communication back to Bernatello's about what needs to
// sell through or ship soon.

const STATUS_META = {
  primary:   { label: 'PRIMARY',   color: '#3fb950', bg: 'rgba(63,185,80,0.12)' },
  secondary: { label: 'SECONDARY', color: '#d4a72c', bg: 'rgba(212,167,44,0.12)' },
  warehouse: { label: 'WAREHOUSE', color: '#e05a5a', bg: 'rgba(224,90,90,0.12)' },
}

const AGING_META = {
  critical: { label: 'CRITICAL', color: '#e05a5a', bg: 'rgba(224,90,90,0.12)' },
  warning:  { label: 'WARNING',  color: '#d4a72c', bg: 'rgba(212,167,44,0.12)' },
  watch:    { label: 'WATCH',    color: '#b08d2f', bg: 'rgba(212,167,44,0.08)' },
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function Badge({ label, color, bg }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999,
      border: `1px solid ${color}`, background: bg, color,
      fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function StatCard({ label, value, color, onClick, active }) {
  const toneColor = color || 'var(--text-primary)'
  return (
    <button
      onClick={onClick}
      style={{
        background: 'var(--bg1)', border: `1px solid ${active ? toneColor : 'var(--border)'}`,
        borderRadius: 8, padding: '14px 18px', textAlign: 'left', cursor: 'pointer',
        minWidth: 170, boxShadow: active ? `0 0 0 1px ${toneColor}` : 'none',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: toneColor, marginTop: 2 }}>{value}</div>
    </button>
  )
}

export default function WrPickCheck() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [filter, setFilter]   = useState('all')
  const [agingOnly, setAgingOnly] = useState(false)

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
    let r = filter === 'all' ? data.materials : data.materials.filter(m => m.status === filter)
    if (agingOnly) r = r.filter(m => m.aging)
    return r
  }, [data, filter, agingOnly])

  return (
    <div style={{ padding: '16px 4px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
        Bernatello's - Wisconsin Rapids · live snapshot
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 680 }}>
        Is the oldest AVAILABLE lot in the primary pick slot? If not, is it in the secondaries (overhead rack directly
        above)? If not, it's out in the warehouse. Cases already committed to an active pick task are netted out
        first. Aging flags carry the 120-day threshold for communicating sell-through/ship timing to Bernatello's.
      </div>

      <NotifySettingsPanel
        facility="wr"
        dashboardType="pick_check"
        functionName="wr-pickcheck-digest-run"
        digestDescription="Posts a comment on this Front conversation summarizing current pick-location compliance and aging flags."
        contentDateLabel="today"
        showSkipToNextValidDay={false}
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
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
            <StatCard label="Checked" value={data.summary.total} onClick={() => setFilter('all')} active={filter === 'all'} />
            <StatCard label="Primary" value={data.summary.primary} color={STATUS_META.primary.color} onClick={() => setFilter('primary')} active={filter === 'primary'} />
            <StatCard label="Secondary" value={data.summary.secondary} color={STATUS_META.secondary.color} onClick={() => setFilter('secondary')} active={filter === 'secondary'} />
            <StatCard label="Warehouse" value={data.summary.warehouse} color={STATUS_META.warehouse.color} onClick={() => setFilter('warehouse')} active={filter === 'warehouse'} />
            <StatCard
              label="Aging Flags (<120d)"
              value={data.summary.agingCritical + data.summary.agingWarning + data.summary.agingWatch}
              color="#d4a72c"
              onClick={() => setAgingOnly(v => !v)}
              active={agingOnly}
            />
          </div>

          <div style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg0)', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-dim)' }}>
                  <th style={{ padding: '10px 14px' }}>Material</th>
                  <th style={{ padding: '10px 14px' }}>Oldest Available Lot</th>
                  <th style={{ padding: '10px 14px' }}>Currently In Primary</th>
                  <th style={{ padding: '10px 14px' }}>Location</th>
                  <th style={{ padding: '10px 14px' }}>Aging</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const sm = STATUS_META[m.status]
                  const am = m.aging ? AGING_META[m.aging] : null
                  const locList = m.status === 'secondary' ? m.secondaryLocations : m.status === 'warehouse' ? m.warehouseLocations : null
                  return (
                    <tr key={m.materialCode} style={{ borderTop: '1px solid var(--border-subtle)' }}>
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
                      <td style={{ padding: '10px 14px' }}>
                        {m.currentLotCodes ? (
                          <>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{m.currentLotCodes}</div>
                            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{m.currentPrimaryLocations}</div>
                          </>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <Badge label={sm.label} color={sm.color} bg={sm.bg} />
                        {locList && (
                          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 4, maxWidth: 260 }}>
                            {locList}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {am
                          ? <Badge label={`${am.label} · ${m.daysRemaining}d`} color={am.color} bg={am.bg} />
                          : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                    </tr>
                  )
                })}
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
