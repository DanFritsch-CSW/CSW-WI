import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FEFO_PROJECTS, getProject, dateVerb,
  orderVerdict, lineVerdict, compareByVerdict, verdictCopy,
  bannerCounts, kpiRow, rollupByProject,
  dayLabel, daySubLabel,
  VERDICT_TOKENS,
  fefoOrderList, fetchLiveFefoOrders,
} from '../../lib/fefo.js'

// Phase 6 — mock UI for FEFO Rotation against fixtures.
// Phase 7 — live data wiring. When VITE_USE_LIVE_FEFO === 'true' AND the user
//   filters to a specific project (not "All Projects"), fetches real orders
//   from Datex via /.netlify/functions/fefo-orders. Falls back to mock on
//   error or when flag is off.
// "All Projects" view stays mock for now (Phase 7c will fan-out across all 4
// projects in parallel).
//
// Verdict engine + UI rendering is shape-stable across both sources — only
// the data origin differs.

const USE_LIVE_FEFO = (import.meta?.env?.VITE_USE_LIVE_FEFO === 'true')

export default function FefoRotationTab() {
  const [day, setDay] = useState(0)
  const [proj, setProj] = useState('all')
  const [openOrders, setOpenOrders] = useState(() => new Set())

  // Mock orders are always available — they back the "All" view and serve as
  // fallback when a live fetch fails or the flag is off.
  const mockOrders = useMemo(() => fefoOrderList(), [])

  // Live orders per project (when flag is on + project filter is single).
  // Shape: { [projectId]: { orders, loading, error, fetchedAt, source } }
  const [liveByProject, setLiveByProject] = useState({})

  // Re-fetch when the user picks a specific project AND the live flag is on.
  // De-dupes by `proj` so we don't re-hit Datex on day-stepper changes.
  const inFlightRef = useRef(new Set())
  useEffect(() => {
    if (!USE_LIVE_FEFO || proj === 'all') return
    if (liveByProject[proj] && !liveByProject[proj].error) return
    if (inFlightRef.current.has(proj)) return
    inFlightRef.current.add(proj)
    setLiveByProject(prev => ({
      ...prev,
      [proj]: { ...(prev[proj] || {}), loading: true },
    }))
    fetchLiveFefoOrders(proj)
      .then(result => {
        setLiveByProject(prev => ({
          ...prev,
          [proj]: {
            orders:    result.orders,
            loading:   false,
            error:     result.error || null,
            fetchedAt: result.fetchedAt,
            source:    result.source,
            elapsedMs: result.elapsedMs,
          },
        }))
      })
      .catch(err => {
        setLiveByProject(prev => ({
          ...prev,
          [proj]: { orders: [], loading: false, error: err.message || 'unknown', source: 'mock' },
        }))
      })
      .finally(() => {
        inFlightRef.current.delete(proj)
      })
  }, [proj, liveByProject])

  const liveForCurrent = USE_LIVE_FEFO && proj !== 'all' ? liveByProject[proj] : null
  const isLive = !!(liveForCurrent && liveForCurrent.source === 'live')

  // Visible = filtered by day + project, sorted by severity.
  // Source-of-truth: live data when we have it for this project, else mock.
  const visible = useMemo(() => {
    let pool
    if (USE_LIVE_FEFO && proj !== 'all' && liveForCurrent?.source === 'live' && liveForCurrent.orders) {
      pool = liveForCurrent.orders
    } else {
      pool = mockOrders.filter(o => proj === 'all' ? true : o.proj === proj)
    }
    const filtered = pool.filter(o => o.day === day)
    return [...filtered].sort(compareByVerdict)
  }, [mockOrders, liveForCurrent, day, proj])

  // Auto-expand violations + stale on view change (handoff §3.5).
  useEffect(() => {
    const auto = new Set()
    for (const o of visible) {
      const v = orderVerdict(o)
      if (v === 'violation' || v === 'stale') auto.add(o.id)
    }
    setOpenOrders(auto)
  }, [day, proj, visible])

  const toggleOrder = (id) => {
    setOpenOrders(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const banners = useMemo(() => bannerCounts(visible),    [visible])
  const kpis    = useMemo(() => kpiRow(visible),          [visible])
  const rollup  = useMemo(() => rollupByProject(visible), [visible])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <ControlsRow
        day={day}        onDayChange={setDay}
        proj={proj}      onProjChange={setProj}
        orderCount={visible.length}
        liveState={liveForCurrent}
        isLive={isLive}
      />
      <Banners banners={banners} />
      <KpiRow kpis={kpis} />
      {proj === 'all' && visible.length > 0 && (
        <ProjectRollup rollup={rollup} onProjClick={setProj} />
      )}
      <OrdersList
        orders={visible}
        openOrders={openOrders}
        onToggle={toggleOrder}
        showProjectChip={proj === 'all'}
        loading={liveForCurrent?.loading}
      />
    </div>
  )
}

// ─── Controls row: day stepper + project select + data source badge ─────────

function ControlsRow({ day, onDayChange, proj, onProjChange, orderCount, liveState, isLive }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap',
    }}>
      <DayStepper day={day} onChange={onDayChange} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <DataSourceBadge liveState={liveState} isLive={isLive} proj={proj} />
        <span style={{
          fontSize: 11, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          letterSpacing: '0.06em',
        }}>
          {orderCount} {orderCount === 1 ? 'order' : 'orders'}
        </span>
        <ProjectSelect proj={proj} onChange={onProjChange} />
      </div>
    </div>
  )
}

function DataSourceBadge({ liveState, isLive, proj }) {
  // Only render when the flag is on (otherwise it'd just say MOCK forever)
  // OR when there's a live attempt in flight / errored.
  if (!USE_LIVE_FEFO) return null
  if (proj === 'all') return (
    <BadgeChip color="var(--text-dim, #9aaabb)" label="MOCK" title="All Projects view uses mock fixtures. Pick a specific project for live data." />
  )
  if (liveState?.loading) return <BadgeChip color="var(--text-dim, #9aaabb)" label="LOADING…" />
  if (isLive) {
    const ms = liveState.elapsedMs
    return <BadgeChip color="var(--green, #1a8a52)" label="LIVE" title={`From Datex via MotherDuck${ms ? ` · ${ms}ms` : ''}`} />
  }
  // Error or no-result fallback to mock
  return <BadgeChip color="var(--amber, #a07818)" label="MOCK" title={liveState?.error ? `Live fetch failed: ${liveState.error}` : 'Mock fixture data'} />
}

function BadgeChip({ color, label, title }) {
  return (
    <span
      title={title || ''}
      style={{
        fontSize: 9, fontWeight: 600,
        padding: '2px 6px',
        borderRadius: 'var(--r-sm, 4px)',
        background: 'rgba(0,0,0,0.04)',
        color,
        border: `1px solid ${color}`,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.08em',
      }}
    >
      {label}
    </span>
  )
}

function DayStepper({ day, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px',
      background: 'var(--bg2, #f8f9fb)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md, 8px)',
    }}>
      <StepBtn
        disabled={day <= 0}
        onClick={() => onChange(Math.max(0, day - 1))}
        ariaLabel="Previous day"
      >‹</StepBtn>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 130, lineHeight: 1.2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {dayLabel(day)}
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          letterSpacing: '0.06em', marginTop: 2,
        }}>
          {daySubLabel(day)}
        </span>
      </div>
      <StepBtn
        disabled={day >= 4}
        onClick={() => onChange(Math.min(4, day + 1))}
        ariaLabel="Next day"
      >›</StepBtn>
    </div>
  )
}

function StepBtn({ children, onClick, disabled, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        width: 24, height: 24, padding: 0,
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm, 4px)',
        color: disabled ? 'var(--text-dim)' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 14, fontWeight: 600,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}

function ProjectSelect({ proj, onChange }) {
  return (
    <select
      value={proj}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: '6px 10px',
        background: 'var(--bg1, #fff)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md, 8px)',
        color: 'var(--text-primary)',
        fontSize: 12, fontWeight: 500,
        fontFamily: 'inherit',
        cursor: 'pointer',
      }}
    >
      <option value="all">All Projects</option>
      {FEFO_PROJECTS.map(p => (
        <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
      ))}
    </select>
  )
}

// ─── Banners ────────────────────────────────────────────────────────────────

function Banners({ banners }) {
  const items = []
  if (banners.violations.length > 0) {
    items.push({
      key: 'v', kind: 'violation',
      title: `${banners.violations.length} FEFO violation${banners.violations.length === 1 ? '' : 's'}`,
      body: `Orders shipping newer stock while older unallocated, off-hold inventory is on hand: ${banners.violations.join(', ')}. Resolve before the truck leaves.`,
    })
  }
  if (banners.stale.length > 0) {
    items.push({
      key: 's', kind: 'stale',
      title: `${banners.stale.length} stale allocation${banners.stale.length === 1 ? '' : 's'}`,
      body: `Orders past appointment still holding allocated stock: ${banners.stale.join(', ')}.`,
    })
  }
  if (banners.holds.length > 0) {
    items.push({
      key: 'h', kind: 'hold',
      title: `${banners.holds.length} lot${banners.holds.length === 1 ? '' : 's'} on hold`,
      body: `Older lots correctly skipped because on hold: ${banners.holds.join(', ')}. Release once cleared.`,
    })
  }
  if (banners.allClean) {
    items.push({
      key: 'c', kind: 'clean',
      title: 'All clear',
      body: 'Every order is pulling the oldest available lot.',
    })
  }
  if (!items.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map(b => {
        const t = VERDICT_TOKENS[b.kind]
        return (
          <div key={b.key} style={{
            display: 'flex', gap: 12, padding: '10px 14px',
            background: t.bg,
            border: `1px solid ${t.color}`,
            borderLeft: `4px solid ${t.color}`,
            borderRadius: 'var(--r-md, 8px)',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: t.color, marginBottom: 2 }}>
                {b.title}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                {b.body}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── KPI row (6 cells) ──────────────────────────────────────────────────────

function KpiRow({ kpis }) {
  const cells = [
    { label: 'ORDERS SHIPPING', value: kpis.orders,     color: null },
    { label: 'PALLET POSITIONS', value: kpis.lps,        color: null },
    { label: 'MATERIALS',        value: kpis.materials, color: null },
    { label: 'VIOLATIONS',       value: kpis.violations, color: kpis.violations > 0 ? VERDICT_TOKENS.violation.color : VERDICT_TOKENS.clean.color },
    { label: 'STALE',            value: kpis.stale,      color: kpis.stale > 0 ? VERDICT_TOKENS.stale.color : 'var(--text-dim)' },
    { label: 'LOTS ON HOLD',     value: kpis.holds,      color: kpis.holds > 0 ? VERDICT_TOKENS.hold.color : 'var(--text-dim)' },
  ]
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 10,
    }}>
      {cells.map(c => (
        <div key={c.label} style={{
          background: 'var(--bg2, #f8f9fb)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md, 8px)',
          padding: '10px 14px',
        }}>
          <div style={{
            fontSize: 9, color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '0.08em',
          }}>{c.label}</div>
          <div style={{
            fontSize: 22, fontWeight: 600,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            marginTop: 4,
            color: c.color || 'var(--text-primary)',
          }}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Project rollup (only when "All Projects") ──────────────────────────────

function ProjectRollup({ rollup, onProjClick }) {
  const visible = rollup.filter(r => r.orders > 0)
  if (!visible.length) return null
  return (
    <div>
      <SectionLabel>BY PROJECT</SectionLabel>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
        gap: 10,
        marginTop: 8,
      }}>
        {visible.map(r => {
          const hasIssue = r.violations > 0 || r.stale > 0
          const flagToken = hasIssue ? VERDICT_TOKENS.violation : VERDICT_TOKENS.clean
          const flagText = r.violations > 0
            ? `${r.violations} violation${r.violations === 1 ? '' : 's'}`
            : r.stale > 0
              ? `${r.stale} stale`
              : 'in rotation'
          return (
            <button
              key={r.proj.id}
              type="button"
              onClick={() => onProjClick(r.proj.id)}
              style={{
                textAlign: 'left',
                background: 'var(--bg1, #fff)',
                border: '1px solid var(--border)',
                borderLeft: `3px solid ${r.proj.color}`,
                borderRadius: 'var(--r-md, 8px)',
                padding: 12,
                cursor: 'pointer',
                font: 'inherit', color: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 600,
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    letterSpacing: '0.06em',
                    color: r.proj.color,
                  }}>{r.proj.code}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 2 }}>
                    {r.orders} order{r.orders === 1 ? '' : 's'} · {r.lps} LP
                  </div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  padding: '3px 6px',
                  background: flagToken.bg,
                  color: flagToken.color,
                  border: `1px solid ${flagToken.color}`,
                  borderRadius: 'var(--r-sm, 4px)',
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  whiteSpace: 'nowrap',
                }}>
                  {flagText}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Orders list ────────────────────────────────────────────────────────────

function OrdersList({ orders, openOrders, onToggle, showProjectChip, loading }) {
  if (loading) {
    return (
      <div style={{
        padding: '40px 0', textAlign: 'center',
        color: 'var(--text-secondary)', fontSize: 13,
      }}>
        Loading live FEFO data…
      </div>
    )
  }
  if (!orders.length) {
    return (
      <div style={{
        padding: '40px 0', textAlign: 'center',
        color: 'var(--text-secondary)', fontSize: 13,
      }}>
        No orders scheduled for this day.
      </div>
    )
  }
  return (
    <div>
      <SectionLabel>ORDERS · sorted by severity</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        {orders.map(o => (
          <OrderCard
            key={o.id}
            order={o}
            open={openOrders.has(o.id)}
            onToggle={() => onToggle(o.id)}
            showProjectChip={showProjectChip}
          />
        ))}
      </div>
    </div>
  )
}

function OrderCard({ order, open, onToggle, showProjectChip }) {
  const verdict = orderVerdict(order)
  const t = VERDICT_TOKENS[verdict]
  const project = getProject(order.proj)
  const totalLps = order.lines.reduce((s, l) => s + l.ship.reduce((a, b) => a + (b.lps || 0), 0), 0)
  const skuCount = order.lines.length

  return (
    <div style={{
      background: 'var(--bg1, #fff)',
      border: '1px solid var(--border)',
      borderLeft: `4px solid ${t.color}`,
      borderRadius: 'var(--r-md, 8px)',
      overflow: 'hidden',
    }}>
      {/* Header (clickable to toggle) */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '10px 14px',
          background: 'transparent', border: 'none',
          textAlign: 'left', cursor: 'pointer',
          font: 'inherit', color: 'inherit',
        }}
      >
        <span style={{
          width: 18, height: 18, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 14,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s ease',
        }}>›</span>
        <span style={{
          fontSize: 13, fontWeight: 600,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}>{order.id}</span>
        {showProjectChip && project && (
          <span style={{
            fontSize: 10, fontWeight: 600,
            padding: '2px 6px',
            background: 'rgba(0,0,0,0.04)',
            color: project.color,
            border: `1px solid ${project.color}`,
            borderRadius: 'var(--r-sm, 4px)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '0.04em',
          }}>{project.code}</span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {order.dest}
        </span>
        <span style={{
          fontSize: 11, color: order.past ? VERDICT_TOKENS.stale.color : 'var(--text-secondary)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontWeight: order.past ? 600 : 400,
        }}>{order.appt}</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
          {totalLps} LP · {skuCount} SKU{skuCount === 1 ? '' : 's'}
        </span>
        <VerdictPill verdict={verdict} />
      </button>

      {/* Body (when open) */}
      {open && (
        <div style={{
          padding: '12px 14px 14px',
          borderTop: '1px solid var(--border-subtle, #eceff5)',
          background: 'var(--bg2, #f8f9fb)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {order.lines.map((line, i) => (
              <SkuLineRow key={`${order.id}-${line.code}-${i}`} line={line} projId={order.proj} />
            ))}
          </div>
          <OrderFooter order={order} />
        </div>
      )}
    </div>
  )
}

function VerdictPill({ verdict }) {
  const t = VERDICT_TOKENS[verdict]
  return (
    <span style={{
      fontSize: 10, fontWeight: 600,
      padding: '3px 8px',
      background: t.bg,
      color: t.color,
      border: `1px solid ${t.color}`,
      borderRadius: 'var(--r-sm, 4px)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      whiteSpace: 'nowrap',
    }}>
      {t.label}
    </span>
  )
}

function SkuLineRow({ line, projId }) {
  const v = lineVerdict(line)
  const t = VERDICT_TOKENS[v]
  const verb = dateVerb(projId)
  const sortedShip = [...line.ship].sort((a, b) => a.k - b.k)
  return (
    <div style={{
      background: 'var(--bg1, #fff)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md, 8px)',
      padding: 12,
    }}>
      {/* Head */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{
          fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}>{line.code}</span>
        <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{line.desc}</span>
        {line.pack && (
          <span style={{
            fontSize: 10, color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            marginLeft: 'auto',
          }}>{line.pack}</span>
        )}
      </div>

      {/* Two columns: shipping (left) + oldest remaining (right) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
      }}>
        <ShippingColumn ship={sortedShip} verb={verb} />
        <OldestRemainingColumn rem={line.rem} verb={verb} verdict={v} />
      </div>

      {/* Verdict line */}
      <div style={{
        marginTop: 10,
        padding: '8px 10px',
        background: t.bg,
        borderLeft: `3px solid ${t.color}`,
        borderRadius: 'var(--r-sm, 4px)',
        fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.45,
      }}>
        <span style={{ fontWeight: 600, color: t.color }}>{t.label}: </span>
        {verdictCopy(line, projId)}
      </div>
    </div>
  )
}

function ShippingColumn({ ship, verb }) {
  return (
    <div>
      <div style={{
        fontSize: 9, color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.08em', marginBottom: 6,
      }}>SHIPPING ON THIS ORDER · OLDEST FIRST</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ship.map((s, idx) => (
          <DateChip
            key={`${s.k}-${idx}`}
            seq={idx + 1}
            date={s.date}
            lps={s.lps}
            cases={s.cases}
            codes={s.codes}
            lot={s.lot}
            verb={verb}
            isOldest={idx === 0}
          />
        ))}
      </div>
    </div>
  )
}

function DateChip({ seq, date, lps, cases, codes, lot, verb, isOldest }) {
  const moreCount = (codes?.length || 0) > 6 ? codes.length - 6 : 0
  const visibleCodes = (codes || []).slice(0, 6)
  return (
    <div style={{
      padding: '6px 8px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm, 4px)',
      background: 'var(--bg2, #f8f9fb)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontSize: 9, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}>#{seq}</span>
        <span style={{
          fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}>{verb} {date}</span>
        {isOldest && (
          <span style={{
            fontSize: 9, fontWeight: 600,
            padding: '1px 5px',
            background: 'rgba(160, 120, 24, 0.12)',
            color: 'var(--amber, #a07818)',
            borderRadius: 2,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          }}>oldest</span>
        )}
        <span style={{
          fontSize: 11, color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          marginLeft: 'auto',
        }}>{lps} LP · {cases} cs</span>
      </div>
      {(visibleCodes.length > 0 || lot) && (
        <div style={{
          marginTop: 4,
          display: 'flex', flexWrap: 'wrap', gap: 3,
          fontSize: 9, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        }}>
          {lot && <span style={{ padding: '1px 4px', background: 'var(--bg1, #fff)', border: '1px solid var(--border)', borderRadius: 2 }}>lot {lot}</span>}
          {visibleCodes.map(c => (
            <span key={c} style={{ padding: '1px 4px', background: 'var(--bg1, #fff)', border: '1px solid var(--border)', borderRadius: 2 }}>{c}</span>
          ))}
          {moreCount > 0 && (
            <span style={{ padding: '1px 4px', color: 'var(--text-dim)' }}>+{moreCount} more LPs</span>
          )}
        </div>
      )}
    </div>
  )
}

function OldestRemainingColumn({ rem, verb, verdict }) {
  const t = VERDICT_TOKENS[verdict]
  return (
    <div>
      <div style={{
        fontSize: 9, color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.08em', marginBottom: 6,
      }}>OLDEST REMAINING · NOT ON ANY ORDER</div>
      <div style={{
        padding: 8,
        border: `1px solid ${t.color}`,
        borderRadius: 'var(--r-sm, 4px)',
        background: t.bg,
        minHeight: 56,
      }}>
        {!rem || rem.lps === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            None — fully cleared
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                fontSize: 12, fontWeight: 600,
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              }}>{verb} {rem.date}</span>
              {rem.hold && (
                <span style={{
                  fontSize: 9, fontWeight: 600,
                  padding: '1px 5px',
                  background: 'rgba(42, 114, 184, 0.15)',
                  color: 'var(--blue, #2a72b8)',
                  borderRadius: 2,
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                }}>⏸ {rem.holdType || 'HOLD'}</span>
              )}
            </div>
            <div style={{
              fontSize: 11, color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              marginTop: 2,
            }}>{rem.lps} LP · {rem.cases} cs available{rem.lot ? ` · lot ${rem.lot}` : ''}</div>
          </>
        )}
      </div>
    </div>
  )
}

function OrderFooter({ order }) {
  const project = getProject(order.proj)
  const parts = []
  if (project) parts.push(`format: ${project.dateFormat}`)
  if (order.allocBy) parts.push(`allocated by ${order.allocBy}`)
  parts.push(`status: ${order.status}`)
  return (
    <div style={{
      marginTop: 10,
      paddingTop: 8,
      borderTop: '1px solid var(--border-subtle, #eceff5)',
      fontSize: 10, color: 'var(--text-dim)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      letterSpacing: '0.04em',
    }}>
      {parts.join('  ·  ')}
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
