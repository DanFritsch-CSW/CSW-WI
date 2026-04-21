import { useState } from 'react'

export default function ProjectList({ projects, projectDrops = {}, onSave, color }) {
  const [expanded, setExpanded] = useState(null)
  const [editValue, setEditValue] = useState(0)
  const [saving, setSaving]       = useState(false)

  if (!projects?.length) return null

  const visible = projects.filter(p => p.tot > 0)
  const maxTot = Math.max(...visible.map(p => p.tot), 1)

  function handleRowClick(p) {
    if (expanded === p.name) {
      setExpanded(null)
      return
    }
    setExpanded(p.name)
    setEditValue(projectDrops[p.name] ?? 0)
  }

  async function handleSave(projectName) {
    setSaving(true)
    const val = Math.max(0, Math.round(editValue))
    try {
      await onSave?.(projectName, val)
      setExpanded(null)
    } finally {
      setSaving(false)
    }
  }

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
        const isOpen = expanded === p.name
        return (
          <div key={i}>
            <div
              className={`project-row${isOpen ? ' project-row--active' : ''}`}
              onClick={() => handleRowClick(p)}
              style={{ cursor: 'pointer' }}
            >
              <div className="project-bar-wrap">
                <div className="project-bar">
                  <div
                    className="project-bar-fill"
                    style={{ width: `${(p.tot / maxTot) * 100}%`, background: color }}
                  />
                </div>
                <span className="project-name">{p.name}</span>
              </div>
              <span className="project-num" style={isOpen ? { color } : {}}>{estVal}</span>
              <span className="project-num">{p.inb}</span>
              <span className="project-num">{p.out}</span>
              <span className="project-num" style={{ color }}>{p.tot}</span>
            </div>
            {isOpen && (
              <div className="project-edit-row">
                <span className="project-edit-label">Est Drops</span>
                <input
                  className="project-edit-input"
                  type="number"
                  min={0}
                  step={1}
                  value={editValue}
                  onChange={e => setEditValue(parseInt(e.target.value, 10) || 0)}
                  autoFocus
                />
                <button
                  className="project-edit-save"
                  onClick={() => handleSave(p.name)}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="project-edit-cancel"
                  onClick={() => setExpanded(null)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
