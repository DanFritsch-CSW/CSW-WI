import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchCalPickCheck } from '../lib/calPickCheck.js'
import { fetchDismissals, dismissMaterial, restoreMaterial } from '../lib/calPickCheckDismissals.js'
import NotifySettingsPanel from './NotifySettingsPanel.jsx'

// CAL "Pick Location Lot Check" sub-tab — Palermo's Caledonia DSD (PALDSD9).
// Mirror of WrPickCheck.jsx (WR / Bernatello's), built 2026-09-29 after the
// PVI FEFO call (Sam Vega, Dean, Dan). See
// netlify/functions/motherduck-cal-pick-check.cjs for the full query design
// and the list of differences from WR.
//
// Question this answers, per DSD material: is the oldest AVAILABLE lot
// actually sitting in the pick line right now? If not, where is it? Not an
// enforcement tool — a daily verification list.
//
// Differences from WrPickCheck.jsx:
//   - Two statuses, not three. WR's SECONDARY (overhead rack computed from
//     P0xx slot naming) has no equivalent at Caledonia, so a material is
//     either IN PICK LINE (oldest available lot has cases in a
//     Datex-flagged primary-pick location) or NOT IN PICK LINE (locations
//     listed). Internal status keys stay 'primary' / 'warehouse'.
//   - 45-day shelf-life window instead of WR's 120-day Critical/Warning/
//     Watch bands: a material's oldest available lot is flagged EXPIRED
//     (< 0d) or ≤45d.
//   - Second table: "Lots at ≤45 days" — EVERY on-hand DSD lot within the
//     window (including expired lots and held lots), because the material
//     rows only ever look at the oldest AVAILABLE lot and would never show a
//     held lot or an expired one buried behind fresher stock. Shows how many
//     cases are physically in the pick line vs. elsewhere and where.
//   - Dismiss uses its own table (cal_pick_check_dismissals) — same
//     material-level, default-permanent semantics as WR. A dismissed
//     material is also removed from the ≤45-day lots table and headline
//     counts (dismissal means "this material is not managed off the pick
//     line").

const STATUS_META = {
  primary:   { label: 'IN PICK LINE',     color: '#3fb950', bg: 'rgba(63,185,80,0.12)' },
  warehouse: { label: 'NOT IN PICK LINE', color: '#e05a5a', bg: 'rgba(224,90,90,0.12)' },
}

const AGING_META = {
  expired: { label: 'EXPIRED', color: '#e05a5a', bg: 'rgba(224,90,90,0.12)' },
  aging45: { label: '≤45d',    color: '#d4a72c', bg: 'rgba(212,167,44,0.12)' },
}

const DISMISS_OPTIONS = [
  { label: 'Permanently (not on pick line)', days: null },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  if (!y) return '—'
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function fmtDaysLabel(days) {
  if (days == null) return ''
  return days < 0 ? `${Math.abs(days)}d past` : `${days}d`
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

function DismissMenu({ onDismiss, onClose }) {
  return (
    <div style={{
      position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
      background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 6,
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)', minWidth: 200, overflow: 'hidden',
    }}>
      {DISMISS_OPTIONS.map(opt => (
        <button
          key={opt.label}
          onClick={() => { onDismiss(opt.days); onClose() }}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
            background: 'transparent', border: 'none', color: 'var(--text-primary)',
            fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg2)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

const TH = { padding: '10px 14px' }
const THEAD_ROW = { background: 'var(--bg0)', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-dim)' }
const TABLE_BOX = { background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }
const MONO_DIM = { fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }

export default function CalPickCheck() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [filter, setFilter]   = useState('all')
  const [agingOnly, setAgingOnly] = useState(false)

  const [dismissals, setDismissals] = useState([])
  const [dismissMenuFor, setDismissMenuFor] = useState(null)
  const [dismissBusy, setDismissBusy] = useState(null)

  const loadDismissals = useCallback(() => {
    fetchDismissals().then(setDismissals).catch(() => {}) // best-effort — never blocks the live tab
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchCalPickCheck()
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    loadDismissals()
    return () => { cancelled = true }
  }, [loadDismissals])

  // Active dismissals only — a time-boxed one whose dismissed_until has
  // passed stops matching and the material reappears automatically.
  const activeDismissedCodes = useMemo(() => {
    const now = Date.now()
    const set = new Set()
    for (const d of dismissals) {
      if (!d.dismissed_until || new Date(d.dismissed_until).getTime() > now) set.add(d.material_code)
    }
    return set
  }, [dismissals])

  const liveMaterials = useMemo(() => data?.materials ?? [], [data])
  const liveLots = useMemo(() => data?.lots ?? [], [data])
  const windowDays = data?.agingWindowDays ?? 45

  const visibleMaterials = useMemo(
    () => liveMaterials.filter(m => !activeDismissedCodes.has(m.materialCode)),
    [liveMaterials, activeDismissedCodes]
  )
  const visibleLots = useMemo(
    () => liveLots.filter(l => !activeDismissedCodes.has(l.materialCode)),
    [liveLots, activeDismissedCodes]
  )

  // Headline numbers recompute client-side from the dismissal-filtered sets.
  const counts = useMemo(() => {
    const c = { total: 0, primary: 0, warehouse: 0, matAging: 0, lotsAging: 0, lotsExpired: 0 }
    for (const m of visibleMaterials) {
      c.total++
      c[m.status] = (c[m.status] || 0) + 1
      if (m.aging) c.matAging++
    }
    for (const l of visibleLots) {
      if (l.aging) c.lotsAging++
      if (l.aging === 'expired') c.lotsExpired++
    }
    return c
  }, [visibleMaterials, visibleLots])

  const rows = useMemo(() => {
    if (filter === 'dismissed') {
      const byCode = new Map(liveMaterials.map(m => [m.materialCode, m]))
      return dismissals
        .filter(d => activeDismissedCodes.has(d.material_code))
        .map(d => ({
          ...(byCode.get(d.material_code) || { materialCode: d.material_code, materialName: d.material_code, status: null }),
          _dismissal: d,
        }))
    }
    let r = filter === 'all' ? visibleMaterials : visibleMaterials.filter(m => m.status === filter)
    if (agingOnly) r = r.filter(m => m.aging)
    return r
  }, [filter, agingOnly, visibleMaterials, liveMaterials, dismissals, activeDismissedCodes])

  async function handleDismiss(materialCode, days) {
    setDismissBusy(materialCode)
    try {
      await dismissMaterial(materialCode, days, null, days ? null : 'Not managed off the pick line')
      loadDismissals()
    } finally {
      setDismissBusy(null)
    }
  }

  async function handleRestore(materialCode) {
    setDismissBusy(materialCode)
    try {
      await restoreMaterial(materialCode)
      loadDismissals()
    } finally {
      setDismissBusy(null)
    }
  }

  const dismissedCount = activeDismissedCodes.size

  return (
    <div style={{ padding: '16px 4px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
        Palermo's Caledonia DSD (PALDSD9) · live snapshot
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, maxWidth: 680 }}>
        Is the oldest AVAILABLE lot in the pick line? If not, where is it? The second table lists every on-hand lot at
        {' '}{windowDays} days of shelf life or less (including lots already expired and lots on hold) so product can be
        pulled from the pick line and Palermo's told while they can still sell it. Materials that aren't managed off
        the pick line can be dismissed below.
      </div>

      <NotifySettingsPanel
        facility="cal"
        dashboardType="pick_check"
        functionName="cal-pickcheck-digest-test"
        digestDescription="Posts a comment on this Front conversation summarizing PALDSD9 pick-line compliance and lots at 45 days of shelf life or less."
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
            <StatCard label="Checked" value={counts.total} onClick={() => setFilter('all')} active={filter === 'all'} />
            <StatCard label="In Pick Line" value={counts.primary} color={STATUS_META.primary.color} onClick={() => setFilter('primary')} active={filter === 'primary'} />
            <StatCard label="Not In Pick Line" value={counts.warehouse} color={STATUS_META.warehouse.color} onClick={() => setFilter('warehouse')} active={filter === 'warehouse'} />
            <StatCard
              label={`Materials ≤${windowDays}d`}
              value={counts.matAging}
              color="#d4a72c"
              onClick={() => setAgingOnly(v => !v)}
              active={agingOnly}
            />
            <StatCard label="Lots Expired" value={counts.lotsExpired} color={AGING_META.expired.color} />
            <StatCard label="Dismissed" value={dismissedCount} color="var(--text-dim)" onClick={() => setFilter('dismissed')} active={filter === 'dismissed'} />
          </div>

          <div style={TABLE_BOX}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={THEAD_ROW}>
                  <th style={TH}>Material</th>
                  <th style={TH}>Oldest Available Lot</th>
                  <th style={TH}>Currently In Pick Line</th>
                  <th style={TH}>Location</th>
                  <th style={TH}>Shelf Life</th>
                  <th style={TH}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const sm = m.status ? STATUS_META[m.status] : null
                  const am = m.aging ? AGING_META[m.aging] : null
                  const locList = m.status === 'warehouse' ? m.otherLocations : null
                  const isDismissedView = filter === 'dismissed'
                  return (
                    <tr key={m.materialCode} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={TH}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{m.materialName}</div>
                        <div style={MONO_DIM}>{m.materialCode}</div>
                      </td>
                      <td style={TH}>
                        {m.oldestLotCode !== undefined ? (
                          <>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{m.oldestLotCode ?? '—'}</div>
                            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                              {fmtDate(m.oldestExpirationDate)}{m.daysRemaining != null ? ` · ${fmtDaysLabel(m.daysRemaining)}` : ''}
                            </div>
                          </>
                        ) : <span style={{ color: 'var(--text-dim)' }}>no current stock</span>}
                      </td>
                      <td style={TH}>
                        {m.currentLotCodes ? (
                          <>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{m.currentLotCodes}</div>
                            <div style={MONO_DIM}>{m.currentPrimaryLocations}</div>
                          </>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td style={TH}>
                        {sm && <Badge label={sm.label} color={sm.color} bg={sm.bg} />}
                        {locList && (
                          <div style={{ ...MONO_DIM, marginTop: 4, maxWidth: 260 }}>{locList}</div>
                        )}
                        {isDismissedView && m._dismissal && (
                          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
                            Dismissed {fmtDate(m._dismissal.dismissed_at)}
                            {m._dismissal.dismissed_until ? ` · until ${fmtDate(m._dismissal.dismissed_until)}` : ' · permanently'}
                            {m._dismissal.note ? ` · ${m._dismissal.note}` : ''}
                          </div>
                        )}
                      </td>
                      <td style={TH}>
                        {am
                          ? <Badge label={`${am.label} · ${fmtDaysLabel(m.daysRemaining)}`} color={am.color} bg={am.bg} />
                          : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td style={{ ...TH, position: 'relative', textAlign: 'right' }}>
                        {isDismissedView ? (
                          <button
                            onClick={() => handleRestore(m.materialCode)}
                            disabled={dismissBusy === m.materialCode}
                            style={{
                              padding: '4px 10px', fontSize: 10, fontFamily: 'var(--font-mono)',
                              background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
                              color: 'var(--text-primary)', cursor: 'pointer',
                            }}
                          >
                            {dismissBusy === m.materialCode ? '…' : 'Restore'}
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => setDismissMenuFor(v => v === m.materialCode ? null : m.materialCode)}
                              disabled={dismissBusy === m.materialCode}
                              style={{
                                padding: '4px 10px', fontSize: 10, fontFamily: 'var(--font-mono)',
                                background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
                                color: 'var(--text-primary)', cursor: 'pointer',
                              }}
                            >
                              {dismissBusy === m.materialCode ? '…' : 'Dismiss'}
                            </button>
                            {dismissMenuFor === m.materialCode && (
                              <DismissMenu
                                onDismiss={(days) => handleDismiss(m.materialCode, days)}
                                onClose={() => setDismissMenuFor(null)}
                              />
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 26, marginBottom: 6, fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Lots at ≤{windowDays} days · all on-hand lots (incl. expired and on hold) · {visibleLots.length} lot{visibleLots.length === 1 ? '' : 's'}
          </div>
          <div style={TABLE_BOX}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={THEAD_ROW}>
                  <th style={TH}>Material</th>
                  <th style={TH}>Lot</th>
                  <th style={TH}>Shelf Life</th>
                  <th style={TH}>Cases</th>
                  <th style={TH}>In Pick Line</th>
                  <th style={TH}>Elsewhere</th>
                </tr>
              </thead>
              <tbody>
                {visibleLots.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '14px', color: 'var(--text-dim)' }}>No on-hand lots at ≤{windowDays} days.</td></tr>
                )}
                {visibleLots.map((l) => {
                  const am = l.aging ? AGING_META[l.aging] : null
                  return (
                    <tr key={`${l.materialCode}|${l.lotCode}`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={TH}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{l.materialName}</div>
                        <div style={MONO_DIM}>{l.materialCode}</div>
                      </td>
                      <td style={TH}>
                        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{l.lotCode}</div>
                        {l.held && (
                          <div style={{ marginTop: 4 }}>
                            <Badge label="ON HOLD" color="#5b9bd5" bg="rgba(91,155,213,0.12)" />
                          </div>
                        )}
                      </td>
                      <td style={TH}>
                        {am && <Badge label={`${am.label} · ${fmtDaysLabel(l.daysRemaining)}`} color={am.color} bg={am.bg} />}
                        <div style={{ ...MONO_DIM, marginTop: 4 }}>{fmtDate(l.expirationDate)}</div>
                      </td>
                      <td style={{ ...TH, fontFamily: 'var(--font-mono)' }}>{l.cases.toLocaleString()}</td>
                      <td style={TH}>
                        {l.casesInPrimary > 0 ? (
                          <>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{l.casesInPrimary.toLocaleString()} cs</div>
                            <div style={MONO_DIM}>{l.primaryLocations}</div>
                          </>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td style={TH}>
                        {l.casesElsewhere > 0 ? (
                          <>
                            <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{l.casesElsewhere.toLocaleString()} cs</div>
                            <div style={{ ...MONO_DIM, maxWidth: 300 }}>{l.otherLocations}</div>
                          </>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
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
