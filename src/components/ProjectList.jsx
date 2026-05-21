// inventoryData: array of { name, lps } | null
// When provided (MAD only), renders side-by-side layout:
//   left  — appointments table (project / est drops / inb / out / tot)
//   right — active inventory table (project / active LPs)
// Both columns cap at 15 rows visible; overflow scrolls independently.

export default function ProjectList({ projects, projectDrops = {}, color, inventoryData = null }) {
  if (!projects?.length) return null

  // Include named projects that have appointments OR EST drops (e.g. BossBites before first appointment)
  const named      = projects.filter(p => p.name && (p.tot > 0 || (projectDrops[p.name] ?? 0) > 0))
  const unassigned = projects.filter(p => !p.name && p.tot > 0)
  const unassignedInb = unassigned.reduce((s, p) => s + p.inb, 0)
  const unassignedOut = unassigned.reduce((s, p) => s + p.out, 0)
  const unassignedTot = unassigned.reduce((s, p) => s + p.tot, 0)
  const maxTot = Math.max(...named.map(p => p.tot), unassignedTot, 1)

  const CSW_SUFFIXES = [
    ' - CSW-Madison', ' - CSW-Franksville', ' - CSW-Kenosha',
    ' - CSW-Wisconsin Rapids', ' - CSW-Eau Claire',
    '-CSW-Madison', ' - Madison',
  ]
  function stripSuffix(name) {
    if (!name) return name
    for (const s of CSW_SUFFIXES) {
      if (name.endsWith(s)) return name.slice(0, -s.length)
    }
    return name
  }

  function fmtDrops(val) {
    const n = Number(val) || 0
    return n > 0 ? n : '—'
  }

  const isSplit = inventoryData !== null

  if (isSplit) {
    const invRows    = inventoryData ?? []
    const invLoading = inventoryData === null

    return (
      <div className="project-list project-list--split">
        {/* ── Left: Appointments ── */}
        <div className="project-list-col project-list-col--appt">
          <div className="project-list-header project-list-header--appt">
            <span>Project</span>
            <span style={{ textAlign: 'right' }}>Drops</span>
            <span style={{ textAlign: 'right' }}>Inb</span>
            <span style={{ textAlign: 'right' }}>Out</span>
            <span style={{ textAlign: 'right' }}>Tot</span>
          </div>
          <div className="project-list-body">
            {named.map((p, i) => {
              const estVal = projectDrops[p.name] ?? 0
              return (
                <div key={i} className="project-row project-row--appt">
                  <div className="project-bar-wrap">
                    <div className="project-bar">
                      <div className="project-bar-fill" style={{ width: `${(p.tot / maxTot) * 100}%`, background: color }} />
                    </div>
                    <span className="project-name">{stripSuffix(p.name)}</span>
                  </div>
                  <span className="project-num">{fmtDrops(estVal)}</span>
                  <span className="project-num">{p.inb}</span>
                  <span className="project-num">{p.out}</span>
                  <span className="project-num" style={{ color }}>{p.tot || '—'}</span>
                </div>
              )
            })}
            {unassignedTot > 0 && (
              <div className="project-row project-row--appt project-row--unassigned">
                <div className="project-bar-wrap">
                  <div className="project-bar">
                    <div className="project-bar-fill project-bar-fill--unassigned" style={{ width: `${(unassignedTot / maxTot) * 100}%` }} />
                  </div>
                  <span className="project-name project-name--unassigned">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 5, flexShrink: 0, position: 'relative', top: 1 }}>
                      <path d="M8 1.5L14.5 13.5H1.5L8 1.5Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
                      <path d="M8 6.5V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
                    </svg>
                    {unassignedTot === 1 ? '1 unassigned' : `${unassignedTot} unassigned`}
                  </span>
                </div>
                <span className="project-num project-num--unassigned">—</span>
                <span className="project-num project-num--unassigned">{unassignedInb || '—'}</span>
                <span className="project-num project-num--unassigned">{unassignedOut || '—'}</span>
                <span className="project-num project-num--unassigned">{unassignedTot}</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Divider ── */}
        <div className="project-list-divider" />

        {/* ── Right: Active Inventory ── */}
        <div className="project-list-col project-list-col--inv">
          <div className="project-list-header project-list-header--inv">
            <span>Project</span>
            <span style={{ textAlign: 'right' }}>Active LPs</span>
          </div>
          <div className="project-list-body">
            {invLoading && <div className="project-inv-loading">Loading…</div>}
            {!invLoading && invRows.length === 0 && <div className="project-inv-loading">No inventory data</div>}
            {!invLoading && invRows.map((r, i) => (
              <div key={i} className="project-row project-row--inv">
                <span className="project-name">{r.name}</span>
                <span className="project-num project-num--lp">{r.lps.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ── Default single-column layout (all other facilities) ──
  return (
    <div className="project-list">
      <div className="project-list-header">
        <span>Project</span>
        <span style={{ textAlign: 'right' }}>Est Drops</span>
        <span style={{ textAlign: 'right' }}>Inbound</span>
        <span style={{ textAlign: 'right' }}>Outbound</span>
        <span style={{ textAlign: 'right' }}>Total</span>
      </div>
      {named.map((p, i) => {
        const estVal = projectDrops[p.name] ?? 0
        return (
          <div key={i} className="project-row">
            <div className="project-bar-wrap">
              <div className="project-bar">
                <div className="project-bar-fill" style={{ width: `${(p.tot / maxTot) * 100}%`, background: color }} />
              </div>
              <span className="project-name">{p.name}</span>
            </div>
            <span className="project-num">{fmtDrops(estVal)}</span>
            <span className="project-num">{p.inb || '—'}</span>
            <span className="project-num">{p.out || '—'}</span>
            <span className="project-num" style={{ color: p.tot ? color : 'var(--text-dim)' }}>{p.tot || '—'}</span>
          </div>
        )
      })}
      {unassignedTot > 0 && (
        <div className="project-row project-row--unassigned">
          <div className="project-bar-wrap">
            <div className="project-bar">
              <div className="project-bar-fill project-bar-fill--unassigned" style={{ width: `${(unassignedTot / maxTot) * 100}%` }} />
            </div>
            <span className="project-name project-name--unassigned">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ marginRight: 5, flexShrink: 0, position: 'relative', top: 1 }}>
                <path d="M8 1.5L14.5 13.5H1.5L8 1.5Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <path d="M8 6.5V9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
              </svg>
              {unassignedTot === 1 ? '1 unassigned appointment' : `${unassignedTot} unassigned appointments`}
            </span>
          </div>
          <span className="project-num project-num--unassigned">—</span>
          <span className="project-num project-num--unassigned">{unassignedInb || '—'}</span>
          <span className="project-num project-num--unassigned">{unassignedOut || '—'}</span>
          <span className="project-num project-num--unassigned">{unassignedTot}</span>
        </div>
      )}
    </div>
  )
}
