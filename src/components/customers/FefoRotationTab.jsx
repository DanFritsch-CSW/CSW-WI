import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FEFO_PROJECTS, getProject, dateVerb,
  orderVerdict, lineVerdict, compareByVerdict, verdictCopy,
  bannerCounts, kpiRow, rollupByProject,
  dayLabel, daySubLabel,
  VERDICT_TOKENS, SEVERITY_TOKENS, UNDATED_TOKEN,
  lineSeverity, orderSeverity, orderMaxDaysOlder, lineDaysOlder,
  undatedLotsInView,
  fefoOrderList, fetchLiveFefoOrdersBatch,
} from '../../lib/fefo.js'

// FEFO Rotation tab — always live from Datex, batched.

const ALL_PROJECT_IDS = FEFO_PROJECTS.map(p => p.id)

export default function FefoRotationTab() {
  const [day, setDay] = useState(0)
  const [proj, setProj] = useState('all')
  const [openOrders, setOpenOrders] = useState(() => new Set())

  const [liveResult, setLiveResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refetchTick, setRefetchTick] = useState(0)
  // Init to -1 so the initial mount (refetchTick=0) doesn't early-return
  // as "already fetched" and skip the fetch. Bug from PR #66 refetch impl.
  const fetchedRef = useRef(-1)

  useEffect(() => {
    if (fetchedRef.current === refetchTick) return
    fetchedRef.current = refetchTick
    setLoading(true)
    fetchLiveFefoOrdersBatch(ALL_PROJECT_IDS)
      .then(result => { setLiveResult(result); setLoading(false) })
      .catch(err => {
        setLiveResult({
          ordersByProject: {}, errorsByProject: {},
          source: 'mock', error: err.message || 'unknown',
        })
        setLoading(false)
      })
  }, [refetchTick])

  const refetch = () => setRefetchTick(t => t + 1)

  const scopedProjectIds = proj === 'all' ? ALL_PROJECT_IDS : [proj]
  const errorsByProject = liveResult?.errorsByProject || {}
  const ordersByProject = liveResult?.ordersByProject || {}
  const failedScoped = scopedProjectIds.filter(pid => errorsByProject[pid])
  const succeededScoped = scopedProjectIds.filter(pid => !errorsByProject[pid])
  const allFailed = !loading && succeededScoped.length === 0

  const mockOrders = useMemo(() => fefoOrderList(), [])

  const visible = useMemo(() => {
    let pool
    if (allFailed) {
      pool = mockOrders.filter(o => proj === 'all' ? true : o.proj === proj)
    } else {
      pool = []
      for (const pid of scopedProjectIds) {
        const arr = ordersByProject[pid]
        if (Array.isArray(arr) && arr.length) pool.push(...arr)
      }
    }
    const filtered = pool.filter(o => o.day === day)
    return [...filtered].sort(compareByVerdict)
  }, [allFailed, mockOrders, ordersByProject, scopedProjectIds, day, proj])

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

  const banners     = useMemo(() => bannerCounts(visible),    [visible])
  const kpis        = useMemo(() => kpiRow(visible),          [visible])
  const rollup      = useMemo(() => rollupByProject(visible), [visible])
  const undatedLots = useMemo(() => undatedLotsInView(visible), [visible])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <ControlsRow
        day={day}        onDayChange={setDay}
        proj={proj}      onProjChange={setProj}
        orderCount={visible.length}
        loading={loading}
        allFailed={allFailed}
        failedScoped={failedScoped}
        liveResult={liveResult}
        onRefresh={refetch}
      />
      <Banners banners={banners} />
      <UndatedLotsBanner lots={undatedLots} />
      <KpiRow kpis={kpis} />
      {proj === 'all' && visible.length > 0 && (
        <ProjectRollup rollup={rollup} onProjClick={setProj} />
      )}
      <OrdersList
        orders={visible}
        openOrders={openOrders}
        onToggle={toggleOrder}
        showProjectChip={proj === 'all'}
        loading={loading && visible.length === 0}
        onRefetch={refetch}
      />
    </div>
  )
}

function ControlsRow({ day, onDayChange, proj, onProjChange, orderCount, loading, allFailed, failedScoped, liveResult, onRefresh }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap',
    }}>
      <DayStepper day={day} onChange={onDayChange} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <DataSourceBadge
          loading={loading}
          allFailed={allFailed}
          failedScoped={failedScoped}
          liveResult={liveResult}
        />
        <span style={{
          fontSize: 11, color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          letterSpacing: '0.06em',
        }}>
          {orderCount} {orderCount === 1 ? 'order' : 'orders'}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Refetch FEFO data"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '0.04em',
            background: 'var(--bg1, #fff)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm, 4px)',
            color: loading ? 'var(--text-dim)' : 'var(--text-primary)',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >↻ REFRESH</button>
        <ProjectSelect proj={proj} onChange={onProjChange} />
      </div>
    </div>
  )
}

function DataSourceBadge({ loading, allFailed, failedScoped, liveResult }) {
  if (loading) return <BadgeChip color="var(--text-dim, #9aaabb)" label="LOADING…" />
  if (allFailed) {
    const topErr = liveResult?.error
    const firstErrors = liveResult?.errorsByProject
      ? Object.values(liveResult.errorsByProject).filter(Boolean).slice(0, 2).join(' · ')
      : ''
    const tip = topErr || firstErrors || 'Live fetch failed'
    return <BadgeChip color="var(--red, #c0392b)" label="OFFLINE" title={`${tip}. Showing mock fixtures.`} />
  }
  if (failedScoped.length > 0) {
    const names = failedScoped.map(pid => getProject(pid)?.code).filter(Boolean).join(', ')
    return <BadgeChip color="var(--amber, #a07818)" label="PARTIAL" title={`Live but missing: ${names}. The rest are real Datex data.`} />
  }
  const ms = liveResult?.elapsedMs
  return <BadgeChip color="var(--green, #1a8a52)" label="LIVE" title={`From Datex via MotherDuck${ms ? ` · ${ms}ms` : ''}`} />
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
      <StepBtn disabled={day <= 0} onClick={() => onChange(Math.max(0, day - 1))} ariaLabel="Previous day">‹</StepBtn>
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
      <StepBtn disabled={day >= 4} onClick={() => onChange(Math.min(4, day + 1))} ariaLabel="Next day">›</StepBtn>
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

function Banners({ banners }) {
  const items = []
  if (banners.violations.length > 0) {
    const n = banners.violations.length
    const c = banners.criticalCount || 0
    const w = banners.warningCount || 0
    const split = (c > 0 || w > 0) ? ` (${c ? `${c} critical` : ''}${c && w ? ' · ' : ''}${w ? `${w} warning` : ''})` : ''
    items.push({
      key: 'v', kind: 'violation',
      title: `${n} FEFO violation${n === 1 ? '' : 's'}${split}`,
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
      body: `Older lots correctly skipped because they're on a Datex hold (QA, Food Safety, Administrative, etc.): ${banners.holds.join(', ')}. Clear the hold in Datex before it can ship in rotation.`,
    })
  }
  if (banners.blocked.length > 0) {
    items.push({
      key: 'b', kind: 'blocked',
      title: `${banners.blocked.length} lot${banners.blocked.length === 1 ? '' : 's'} in receiving / not yet put away`,
      body: `Older lots correctly skipped because they're dwelling in a non-allocatable location (receiving, staging, dock, door): ${banners.blocked.join(', ')}. Move to a pickable bin before it can ship in rotation.`,
    })
  }
  if (banners.allClean) {
    items.push({ key: 'c', kind: 'clean', title: 'All clear', body: 'Every order is pulling the oldest available lot.' })
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
              <div style={{ fontSize: 13, fontWeight: 600, color: t.color, marginBottom: 2 }}>{b.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>{b.body}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// UndatedLotsBanner (2026-07-10, Dean/Bry FEFO feedback) — "no expiration =
// red alert" per Dean. Sits at the top of each customer's view alongside the
// other banners. Deliberately separate from Banners()/VERDICT_TOKENS since
// undated lots are flag-only and don't participate in the violation/hold/
// clean verdict precedence — this never blocks an order, it just surfaces
// lots ops should go verify in Datex.
function UndatedLotsBanner({ lots }) {
  const n = lots.length
  if (n === 0) {
    return (
      <div style={{
        display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 14px',
        background: UNDATED_TOKEN.clean.bg,
        border: `1px solid ${UNDATED_TOKEN.clean.color}`,
        borderLeft: `4px solid ${UNDATED_TOKEN.clean.color}`,
        borderRadius: 'var(--r-md, 8px)',
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: UNDATED_TOKEN.clean.color }}>✓ No undated lots</span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          — every lot shipping or on hand in this view has a parseable date.
        </span>
      </div>
    )
  }
  return (
    <div style={{
      padding: '10px 14px',
      background: UNDATED_TOKEN.alert.bg,
      border: `1px solid ${UNDATED_TOKEN.alert.color}`,
      borderLeft: `4px solid ${UNDATED_TOKEN.alert.color}`,
      borderRadius: 'var(--r-md, 8px)',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: UNDATED_TOKEN.alert.color, marginBottom: 4 }}>
        ⚠ {n} lot{n === 1 ? '' : 's'} with no parseable date — verify in Datex
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>
        These lots' codes (or receipt data) couldn't be read as a real date, so they're excluded from the FEFO age comparison instead of being silently treated as oldest or newest. Confirm the real pack/expiration date in Datex and correct the lot record.
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {lots.map(l => (
          <span key={l.lot} style={{
            fontSize: 10, fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            padding: '2px 6px', background: 'var(--bg1, #fff)',
            border: `1px solid ${UNDATED_TOKEN.alert.color}`, borderRadius: 2,
            color: 'var(--text-primary)',
          }}>
            lot {l.lot}{l.order ? ` · ${l.order}` : ' · on-hand'}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dim)' }}>
        Scoped to lots tied to currently open orders in this view — not a full warehouse scan.
      </div>
    </div>
  )
}

function KpiRow({ kpis }) {
  const cells = [
    { label: 'ORDERS SHIPPING', value: kpis.orders,     color: null },
    { label: 'PALLET POSITIONS', value: kpis.lps,        color: null },
    { label: 'MATERIALS',        value: kpis.materials, color: null },
    { label: 'CRITICAL',         value: kpis.critical || 0, color: (kpis.critical || 0) > 0 ? SEVERITY_TOKENS.critical.color : 'var(--text-dim)' },
    { label: 'WARNING',          value: kpis.warning  || 0, color: (kpis.warning  || 0) > 0 ? SEVERITY_TOKENS.warning.color  : 'var(--text-dim)' },
    { label: 'STALE',            value: kpis.stale,      color: kpis.stale > 0 ? VERDICT_TOKENS.stale.color : 'var(--text-dim)' },
    { label: 'ON HOLD',          value: kpis.holds,      color: kpis.holds > 0 ? VERDICT_TOKENS.hold.color : 'var(--text-dim)' },
    { label: 'IN RECEIVING',     value: kpis.blocked  || 0, color: (kpis.blocked || 0) > 0 ? VERDICT_TOKENS.blocked.color : 'var(--text-dim)' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
      {cells.map(c => (
        <div key={c.label} style={{
          background: 'var(--bg2, #f8f9fb)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md, 8px)',
          padding: '10px 14px',
        }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.08em' }}>{c.label}</div>
          <div style={{ fontSize: 22, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginTop: 4, color: c.color || 'var(--text-primary)' }}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function ProjectRollup({ rollup, onProjClick }) {
  const visible = rollup.filter(r => r.orders > 0)
  if (!visible.length) return null
  return (
    <div>
      <SectionLabel>BY PROJECT</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, marginTop: 8 }}>
        {visible.map(r => {
          const hasCritical = (r.critical || 0) > 0
          const hasIssue = r.violations > 0 || r.stale > 0
          const flagToken = hasCritical
            ? VERDICT_TOKENS.violation
            : hasIssue ? VERDICT_TOKENS.violation : VERDICT_TOKENS.clean
          const flagText = hasCritical
            ? `${r.critical} critical`
            : r.violations > 0
              ? `${r.violations} violation${r.violations === 1 ? '' : 's'}`
              : r.stale > 0 ? `${r.stale} stale` : 'in rotation'
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
                  <div style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.06em', color: r.proj.color }}>{r.proj.code}</div>
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
                }}>{flagText}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function OrdersList({ orders, openOrders, onToggle, showProjectChip, loading, onRefetch }) {
  if (loading) {
    return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>Loading live FEFO data…</div>
  }
  if (!orders.length) {
    return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No orders scheduled for this day.</div>
  }
  return (
    <div>
      <SectionLabel>ORDERS · sorted by severity</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        {orders.map(o => (
          <OrderCard key={o.id} order={o} open={openOrders.has(o.id)} onToggle={() => onToggle(o.id)} showProjectChip={showProjectChip} onRefetch={onRefetch} />
        ))}
      </div>
    </div>
  )
}

function OrderCard({ order, open, onToggle, showProjectChip, onRefetch }) {
  const verdict = orderVerdict(order)
  const t = VERDICT_TOKENS[verdict]
  const project = getProject(order.proj)
  const totalLps = order.lines.reduce((s, l) => s + l.ship.reduce((a, b) => a + (b.lps || 0), 0), 0)
  const skuCount = order.lines.length
  const severity = verdict === 'violation' ? orderSeverity(order) : null
  const maxDays  = verdict === 'violation' ? orderMaxDaysOlder(order) : 0

  return (
    <div style={{
      background: 'var(--bg1, #fff)',
      border: '1px solid var(--border)',
      borderLeft: `4px solid ${t.color}`,
      borderRadius: 'var(--r-md, 8px)',
      overflow: 'hidden',
    }}>
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
          pointerEvents: 'none',
        }}>›</span>
        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)', pointerEvents: 'none' }}>{order.id}</span>
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
            pointerEvents: 'none',
          }}>{project.code}</span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{order.dest}</span>
        <span style={{
          fontSize: 11, color: order.past ? VERDICT_TOKENS.stale.color : 'var(--text-secondary)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontWeight: order.past ? 600 : 400,
          pointerEvents: 'none',
        }}>{order.appt}</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', pointerEvents: 'none' }}>
          {totalLps} LP · {skuCount} SKU{skuCount === 1 ? '' : 's'}
        </span>
        {severity && maxDays > 0 && <SeverityBadge severity={severity} days={maxDays} />}
        <VerdictPill verdict={verdict} />
      </button>

      {open && (
        <div style={{
          padding: '12px 14px 14px',
          borderTop: '1px solid var(--border-subtle, #eceff5)',
          background: 'var(--bg2, #f8f9fb)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {order.lines.map((line, i) => (
              <SkuLineRow key={`${order.id}-${line.code}-${i}`} line={line} projId={order.proj} onRefetch={onRefetch} />
            ))}
          </div>
          <OrderFooter order={order} />
        </div>
      )}
    </div>
  )
}

function SeverityBadge({ severity, days }) {
  const s = SEVERITY_TOKENS[severity]
  if (!s) return null
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      padding: '3px 8px',
      background: s.bg,
      color: s.color,
      border: `1px solid ${s.color}`,
      borderRadius: 'var(--r-sm, 4px)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      letterSpacing: '0.04em',
    }}>
      {days}d · {s.label}
    </span>
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
      pointerEvents: 'none',
    }}>
      {t.label}
    </span>
  )
}

function SkuLineRow({ line, projId, onRefetch }) {
  const v = lineVerdict(line)
  const t = VERDICT_TOKENS[v]
  const verb = dateVerb(projId)
  // Undated ship entries sort last — they can't be trusted as "the oldest"
  // just because their k:0 sentinel is numerically smallest (2026-07-10 fix).
  const sortedShip = [...line.ship].sort((a, b) => {
    if (!!a.dateUnknown !== !!b.dateUnknown) return a.dateUnknown ? 1 : -1
    return a.k - b.k
  })
  const sev = v === 'violation' ? lineSeverity(line) : null
  const days = v === 'violation' ? lineDaysOlder(line) : 0
  const borderColor = sev ? SEVERITY_TOKENS[sev].color : t.color
  const bg          = sev ? SEVERITY_TOKENS[sev].bg    : t.bg
  return (
    <div style={{
      background: 'var(--bg1, #fff)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md, 8px)',
      padding: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{line.code}</span>
        <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>{line.desc}</span>
        {sev && days > 0 && <SeverityBadge severity={sev} days={days} />}
        {line.pack && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginLeft: 'auto' }}>{line.pack}</span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ShippingColumn ship={sortedShip} verb={verb} />
        <OldestRemainingColumn rem={line.rem} verb={verb} verdict={v} undatedOnHand={line.undatedOnHand} />
      </div>

      <div style={{
        marginTop: 10,
        padding: '8px 10px',
        background: bg,
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: 'var(--r-sm, 4px)',
        fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.45,
      }}>
        <span style={{ fontWeight: 600, color: borderColor }}>{t.label}: </span>
        {verdictCopy(line, projId)}
      </div>

      {v === 'violation' && line.rem?.lot && (
        <DismissAction
          projectId={projId}
          lotLookupCode={line.rem.lot}
          materialCode={line.code}
          onDone={onRefetch}
        />
      )}
    </div>
  )
}

// DismissAction — inline "Dismiss lot" button + expandable form for
// violation rows. On submit, POSTs to /.netlify/functions/fefo-dismissals
// and calls onDone() so the parent re-fetches. The next fetch will drop
// this lot from REM candidates, so the row either resolves to clean or
// falls to the next-oldest lot.
function DismissAction({ projectId, lotLookupCode, materialCode, onDone }) {
  const [open, setOpen] = useState(false)
  const [days, setDays] = useState(7)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const dismissedUntil = new Date(Date.now() + days * 86400000).toISOString()
      // Best-effort user attribution from Supabase session, else 'anonymous'.
      let dismissedBy = 'anonymous'
      try {
        const mod = await import('../../lib/supabase.js')
        const { data } = await mod.supabase.auth.getUser()
        dismissedBy = data?.user?.email || 'anonymous'
      } catch { /* ignore */ }
      const res = await fetch('/.netlify/functions/fefo-dismissals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          lotLookupCode,
          materialCode,
          dismissedBy,
          dismissedUntil,
          reason: reason.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setOpen(false)
      setReason('')
      onDone?.()
    } catch (e) {
      setError(e.message || 'Failed to dismiss')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            fontSize: 11, fontWeight: 600,
            padding: '4px 10px',
            background: 'var(--bg2, #f8f9fb)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm, 4px)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '0.04em',
          }}
        >
          ✕ DISMISS LOT {lotLookupCode}
        </button>
      </div>
    )
  }

  return (
    <div style={{
      marginTop: 8,
      padding: 10,
      background: 'var(--bg2, #f8f9fb)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm, 4px)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        Suppress this lot from FEFO checks (e.g. it's a known replacement or QA-cleared).
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          For:
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            disabled={submitting}
            style={{
              marginLeft: 6, fontSize: 11,
              padding: '2px 6px',
              background: 'var(--bg1, #fff)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm, 4px)',
            }}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Reason (optional)"
          disabled={submitting}
          style={{
            flex: 1, minWidth: 160,
            fontSize: 11, padding: '4px 8px',
            background: 'var(--bg1, #fff)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm, 4px)',
          }}
        />
      </div>
      {error && (
        <div style={{ fontSize: 11, color: 'var(--red, #c0392b)' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => { setOpen(false); setReason(''); setError('') }}
          disabled={submitting}
          style={{
            fontSize: 11, fontWeight: 500,
            padding: '4px 10px',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm, 4px)',
            color: 'var(--text-secondary)',
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}
        >Cancel</button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          style={{
            fontSize: 11, fontWeight: 600,
            padding: '4px 10px',
            background: 'var(--red, #c0392b)',
            border: '1px solid var(--red, #c0392b)',
            borderRadius: 'var(--r-sm, 4px)',
            color: '#fff',
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            letterSpacing: '0.04em',
          }}
        >{submitting ? 'DISMISSING…' : 'DISMISS'}</button>
      </div>
    </div>
  )
}

function ShippingColumn({ ship, verb }) {
  const anyHold = ship.some(s => s.hold)
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.08em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>SHIPPING ON THIS ORDER · OLDEST FIRST</span>
        {anyHold && (
          <span style={{
            padding: '1px 5px',
            background: 'rgba(192, 57, 43, 0.12)',
            color: 'var(--red, #c0392b)',
            border: '1px solid var(--red, #c0392b)',
            borderRadius: 2,
            fontWeight: 600,
            letterSpacing: '0.04em',
          }}>⚠ HOLD ON ORDER</span>
        )}
      </div>
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
            isOldest={idx === 0 && !s.dateUnknown}
            hold={s.hold}
            holdType={s.holdType}
            dateUnknown={s.dateUnknown}
          />
        ))}
      </div>
    </div>
  )
}

function DateChip({ seq, date, lps, cases, codes, lot, verb, isOldest, hold, holdType, dateUnknown }) {
  const moreCount = (codes?.length || 0) > 6 ? codes.length - 6 : 0
  const visibleCodes = (codes || []).slice(0, 6)
  return (
    <div style={{
      padding: '6px 8px',
      border: hold ? '1px solid var(--red, #c0392b)' : (dateUnknown ? `1px solid ${UNDATED_TOKEN.alert.color}` : '1px solid var(--border)'),
      borderRadius: 'var(--r-sm, 4px)',
      background: hold ? 'rgba(192, 57, 43, 0.04)' : (dateUnknown ? UNDATED_TOKEN.alert.bg : 'var(--bg2, #f8f9fb)'),
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>#{seq}</span>
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{verb} {date}</span>
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
        {hold && (
          <span style={{
            fontSize: 9, fontWeight: 600,
            padding: '1px 5px',
            background: 'rgba(192, 57, 43, 0.14)',
            color: 'var(--red, #c0392b)',
            border: '1px solid var(--red, #c0392b)',
            borderRadius: 2,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          }}>⏸ {holdType || 'HOLD'}</span>
        )}
        {dateUnknown && (
          <span
            title="This lot's code couldn't be read as a real date — excluded from the FEFO age comparison. Verify in Datex."
            style={{
              fontSize: 9, fontWeight: 600,
              padding: '1px 5px',
              background: 'rgba(192, 57, 43, 0.14)',
              color: UNDATED_TOKEN.alert.color,
              border: `1px solid ${UNDATED_TOKEN.alert.color}`,
              borderRadius: 2,
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            }}
          >⚠ NO DATE</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginLeft: 'auto' }}>{lps} LP · {cases} cs</span>
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

function OldestRemainingColumn({ rem, verb, verdict, undatedOnHand }) {
  const t = VERDICT_TOKENS[verdict]
  const showLocation = rem && rem.lps > 0 && (rem.location || (rem.locations && rem.locations.length))
  const extraLocs = rem?.locations && rem.locations.length > 1 ? rem.locations.length - 1 : 0
  const hasUndated = (undatedOnHand?.length || 0) > 0
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '0.08em', marginBottom: 6 }}>OLDEST REMAINING · NOT ON ANY ORDER</div>
      <div style={{
        padding: 8,
        border: `1px solid ${t.color}`,
        borderRadius: 'var(--r-sm, 4px)',
        background: t.bg,
        minHeight: 56,
      }}>
        {!rem || rem.lps === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>None — fully cleared</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{verb} {rem.date}</span>
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
              {!rem.hold && rem.locationBlocked && (
                <span
                  title="Older lot is in a non-allocatable location (receiving, staging, dock, etc.). It won't be picked until moved to an allocatable bin."
                  style={{
                    fontSize: 9, fontWeight: 600,
                    padding: '1px 5px',
                    background: 'rgba(160, 120, 24, 0.12)',
                    color: 'var(--amber, #a07818)',
                    border: '1px solid var(--amber, #a07818)',
                    borderRadius: 2,
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  }}
                >⚑ NOT IN BIN</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', marginTop: 2 }}>{rem.lps} LP · {rem.cases} cs available{rem.lot ? ` · lot ${rem.lot}` : ''}</div>
            {showLocation && (
              <div style={{
                fontSize: 11,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                marginTop: 3,
              }}>
                📍 {rem.location || rem.locations[0]}
                {extraLocs > 0 && (
                  <span style={{ color: 'var(--text-dim)' }} title={rem.locations.join(', ')}> · +{extraLocs} more</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {hasUndated && (
        <div
          title={undatedOnHand.map(u => `lot ${u.lot} — ${u.cases} cs${u.location ? ` @ ${u.location}` : ''}`).join(' · ')}
          style={{
            marginTop: 6, fontSize: 10, color: UNDATED_TOKEN.alert.color,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          }}
        >
          ⚠ +{undatedOnHand.length} lot{undatedOnHand.length === 1 ? '' : 's'} on hand with no parseable date (excluded from this pick — verify in Datex)
        </div>
      )}
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
    }}>{parts.join('  ·  ')}</div>
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
