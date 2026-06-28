import { useMemo } from 'react'

// Single-day Projects table — one row per project showing Drops / Inb / Out / Total
// for the selected day. Sorted busiest-first by total. Used in the Daily view of
// FacilityPanel. The weekly equivalent (7-day grid) is ProjectList.
export default function DailyProjectList({ projects, projectDrops, color, projectFilter }) {
  const rows = useMemo(() => {
    if (!projects || projects.length === 0) return []
    return projects
      .filter(p => p.name && (!projectFilter || projectFilter(p.name)))
      .map(p => {
        const drops = Math.round(Number(projectDrops?.[p.name] ?? 0))
        const inb = Number(p.inb ?? 0)
        const out = Number(p.out ?? 0)
        return { name: p.name, drops, inb, out, total: drops + inb + out }
      })
      .filter(r => r.total > 0)
      .sort((a, b) => b.total - a.total)
  }, [projects, projectDrops, projectFilter])

  if (rows.length === 0) {
    return (
      <div className="daily-project-list daily-project-list-empty">
        <div className="dpl-empty">No projects scheduled for this day.</div>
      </div>
    )
  }

  return (
    <div className="daily-project-list">
      <div className="dpl-header">
        <div>Project</div>
        <div className="dpl-r">Drops</div>
        <div className="dpl-r">Inb</div>
        <div className="dpl-r">Out</div>
        <div className="dpl-r">Total</div>
      </div>
      {rows.map(r => (
        <div key={r.name} className="dpl-row">
          <div className="dpl-name" title={r.name}>{r.name}</div>
          <div className="dpl-num">{r.drops}</div>
          <div className="dpl-num">{r.inb}</div>
          <div className="dpl-num">{r.out}</div>
          <div className="dpl-num dpl-tot" style={color ? { color } : undefined}>{r.total}</div>
        </div>
      ))}
    </div>
  )
}
