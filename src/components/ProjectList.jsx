import { useState, useEffect, Fragment } from 'react'
import { fetchProjectHourlyDrops, upsertProjectDrops } from '../lib/supabase.js'

function fmtHour(h) {
  if (h === 0)  return '12am'
  if (h < 12)   return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

function HourlyEditor({ facilityId, planDate, projectName, onClose }) {
  const [vals, setVals]       = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    setLoading(true)
    fetchProjectHourlyDrops(facilityId, planDate, projectName).then(data => {
      setVals(data)
      setLoading(false)
    })
  }, [facilityId, planDate, projectName])

  const set = (h, v) => setVals(prev => ({ ...prev, [h]: Math.max(0, Number(v) || 0) }))

  const save = async () => {
    setSaving(true)
    const hourlyValues = Array.from({ length: 24 }, (_, h) => ({ h, est: vals[h] ?? 0 }))
    await upsertProjectDrops(facilityId, planDate, projectName, hourlyValues)
    setSaving(false)
    onClose()
  }

  const total = Array.from({ length: 24 }, (_, h) => vals[h] ?? 0).reduce((s, v) => s + v, 0)

  return (
    <div className="proj-hourly-editor">
      <div className="proj-hourly-header">
        <span>{projectName} — Hourly Est Drops</span>
        <button className="proj-hourly-close" onClick={onClose}>✕</button>
      </div>
      {loading ? (
        <div className="proj-hourly-loading">Loading…</div>
      ) : (
        <>
          <div className="proj-hourly-grid">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="proj-hourly-cell">
                <span className="proj-hourly-label">{fmtHour(h)}</span>
                <input
                  className="proj-hourly-input"
                  type="number"
                  min="0"
                  value={vals[h] ?? 0}
                  onChange={e => set(h, e.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="proj-hourly-footer">
            <span className="proj-hourly-total">Total: {total}</span>
            <button className="proj-hourly-cancel" onClick={onClose}>Cancel</button>
            <button className="proj-hourly-save" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function ProjectList({ projects, projectDrops = {}, color, facilityId, planDate }) {
  const [expanded, setExpanded] = useState(null)

  if (!projects?.length) return null

  const maxTot    = Math.max(...projects.map(p => p.tot), 1)
  const canExpand = Boolean(facilityId && planDate)

  const toggle = name => setExpanded(prev => prev === name ? null : name)

  return (
    <div className="project-list">
      <div className="project-list-header">
        <span>Project</span>
        <span style={{ textAlign: 'right' }}>Est Drops</span>
        <span style={{ textAlign: 'right' }}>Inbound</span>
        <span style={{ textAlign: 'right' }}>Outbound</span>
        <span style={{ textAlign: 'right' }}>Total</span>
      </div>
      {projects.map((p, i) => (
        <Fragment key={i}>
          <div className={`project-row${expanded === p.name ? ' project-row--expanded' : ''}`}>
            <div className="project-bar-wrap">
              <div className="project-bar">
                <div
                  className="project-bar-fill"
                  style={{ width: `${(p.tot / maxTot) * 100}%`, background: color }}
                />
              </div>
              <span className="project-name">{p.name}</span>
            </div>
            <span
              className={`project-num project-drops-btn${expanded === p.name ? ' project-drops-btn--active' : ''}`}
              onClick={() => canExpand && toggle(p.name)}
              title={canExpand ? 'Click to edit hourly est drops' : undefined}
            >
              {projectDrops[p.name] ?? p.drops ?? 0}
            </span>
            <span className="project-num">{p.inb}</span>
            <span className="project-num">{p.out}</span>
            <span className="project-num" style={{ color }}>{p.tot}</span>
          </div>
          {expanded === p.name && (
            <div className="project-hourly-row">
              <HourlyEditor
                facilityId={facilityId}
                planDate={planDate}
                projectName={p.name}
                onClose={() => setExpanded(null)}
              />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  )
}
