export default function ProjectList({ projects, projectDrops = {}, color }) {
  if (!projects?.length) return null

  const named = projects.filter(p => p.name && p.tot > 0)
  const unassigned = projects.filter(p => !p.name && p.tot > 0)
  const unassignedInb = unassigned.reduce((s, p) => s + p.inb, 0)
  const unassignedOut = unassigned.reduce((s, p) => s + p.out, 0)
  const unassignedTot = unassigned.reduce((s, p) => s + p.tot, 0)

  const maxTot = Math.max(...named.map(p => p.tot), unassignedTot, 1)

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
                <div
                  className="project-bar-fill"
                  style={{ width: `${(p.tot / maxTot) * 100}%`, background: color }}
                />
              </div>
              <span className="project-name">{p.name}</span>
            </div>
            <span className="project-num">{estVal}</span>
            <span className="project-num">{p.inb}</span>
            <span className="project-num">{p.out}</span>
            <span className="project-num" style={{ color }}>{p.tot}</span>
          </div>
        )
      })}
      {unassignedTot > 0 && (
        <div className="project-row project-row--unassigned">
          <div className="project-bar-wrap">
            <div className="project-bar">
              <div
                className="project-bar-fill project-bar-fill--unassigned"
                style={{ width: `${(unassignedTot / maxTot) * 100}%` }}
              />
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
