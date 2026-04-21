export default function ProjectList({ projects, projectDrops = {}, color }) {
  if (!projects?.length) return null

  const visible = projects.filter(p => p.tot > 0)
  const maxTot = Math.max(...visible.map(p => p.tot), 1)

  return (
    <div className="project-list">
      <div className="project-list-header">
        <span>Project</span>
        <span style={{ textAlign: 'right' }}>Est Drops</span>
        <span style={{ textAlign: 'right' }}>Inbound</span>
        <span style={{ textAlign: 'right' }}>Outbound</span>
        <span style={{ textAlign: 'right' }}>Total</span>
      </div>
      {visible.map((p, i) => {
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
    </div>
  )
}
