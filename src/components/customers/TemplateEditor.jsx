import { useEffect, useState } from 'react'
import {
  BUCKETS, BUCKET_COLORS,
  fetchTaskTemplate, addTemplateTask, updateTemplateTask, deleteTemplateTask, swapTemplateTaskOrder,
  fetchFrontTeammates,
} from '../../lib/onboarding.js'
import TeammatePicker from './TeammatePicker.jsx'

// Template Editor — added 2026-07-09. Edits onboarding_task_templates, the
// master checklist cloned into new customers. Changes here do NOT affect
// existing customers (frozen snapshot at creation, by design) — only
// customers created after the edit.
export default function TemplateEditor({ onClose }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [teammates, setTeammates] = useState([])

  const reload = () => {
    setLoading(true)
    fetchTaskTemplate().then(setTasks).finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [])
  useEffect(() => { fetchFrontTeammates().then(setTeammates) }, [])

  const move = async (task, direction) => {
    const sorted = [...tasks].sort((a, b) => a.sort_order - b.sort_order)
    const idx = sorted.findIndex(t => t.id === task.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= sorted.length) return
    const other = sorted[swapIdx]
    await swapTemplateTaskOrder(task, other)
    reload()
  }

  const sortedTasks = [...tasks].sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Master Template</h3>
        <button type="button" onClick={onClose} style={smallBtnStyle}>← Back to customers</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16 }}>
        Changes here apply to customers created from now on. Existing customers keep the checklist
        they were created with — editing here won't change theirs.
      </p>

      {loading && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>}

      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sortedTasks.map((t, i) => (
            <TemplateRow
              key={t.id}
              task={t}
              teammates={teammates}
              isFirst={i === 0}
              isLast={i === sortedTasks.length - 1}
              onMoveUp={() => move(t, 'up')}
              onMoveDown={() => move(t, 'down')}
              onSave={async (patch) => {
                await updateTemplateTask(t.id, patch)
                setTasks(prev => prev.map(x => x.id === t.id ? { ...x, ...patch } : x))
              }}
              onDelete={async () => {
                if (!window.confirm(`Remove "${t.label}" from the master template? Existing customers keep it — this only affects future customers.`)) return
                await deleteTemplateTask(t.id)
                setTasks(prev => prev.filter(x => x.id !== t.id))
              }}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowAdd(true)}
        style={{ ...smallBtnStyle, marginTop: 10 }}
      >
        + Add template task
      </button>

      {showAdd && (
        <AddTemplateRow
          teammates={teammates}
          nextSortOrder={(sortedTasks.at(-1)?.sort_order ?? 0) + 1}
          onClose={() => setShowAdd(false)}
          onAdded={(task) => { setTasks(prev => [...prev, task]); setShowAdd(false) }}
        />
      )}
    </div>
  )
}

function TemplateRow({ task, teammates, isFirst, isLast, onMoveUp, onMoveDown, onSave, onDelete }) {
  const [label, setLabel] = useState(task.label)
  const [bucket, setBucket] = useState(task.bucket)

  const commit = (field, value) => {
    const patchMap = {
      label: { label: value },
      bucket: { bucket: value },
    }
    onSave(patchMap[field])
  }

  const handleTeammateChange = (teammateId) => {
    if (!teammateId) {
      onSave({ default_owner_teammate_id: null, default_owner_name: null })
      return
    }
    const tm = teammates.find(t => t.teammate_id === teammateId)
    onSave({
      default_owner_teammate_id: teammateId,
      default_owner_name: tm ? (tm.first_name || tm.username) : null,
    })
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
      borderRadius: 6, background: 'var(--surface-2, #f8f8f8)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <button type="button" disabled={isFirst} onClick={onMoveUp} style={arrowBtnStyle}>▲</button>
        <button type="button" disabled={isLast} onClick={onMoveDown} style={arrowBtnStyle}>▼</button>
      </div>

      <select
        value={bucket}
        onChange={(e) => { setBucket(e.target.value); commit('bucket', e.target.value) }}
        style={{ fontSize: 11, padding: '3px 4px', color: BUCKET_COLORS[bucket], fontWeight: 700, border: 'none', background: 'transparent' }}
      >
        {BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
      </select>

      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label !== task.label && commit('label', label)}
        style={{ flex: 1, fontSize: 13, padding: '4px 8px', border: '1px solid transparent', borderRadius: 4, background: 'transparent' }}
      />

      <TeammatePicker
        teammates={teammates}
        value={task.default_owner_teammate_id}
        onChange={handleTeammateChange}
      />

      <button type="button" onClick={onDelete} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 14 }}>
        ×
      </button>
    </div>
  )
}

function AddTemplateRow({ teammates, nextSortOrder, onClose, onAdded }) {
  const [bucket, setBucket] = useState(BUCKETS[0])
  const [label, setLabel] = useState('')
  const [teammateId, setTeammateId] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!label.trim()) return
    setSaving(true)
    try {
      const tm = teammates.find(t => t.teammate_id === teammateId)
      const task = await addTemplateTask({
        bucket, label: label.trim(), sortOrder: nextSortOrder,
        ownerName: tm ? (tm.first_name || tm.username) : null,
        ownerTeammateId: teammateId || null,
      })
      onAdded(task)
    } catch (err) {
      window.alert(`Failed to add task: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      display: 'flex', gap: 6, marginTop: 8, padding: 10,
      border: '1px solid var(--border)', borderRadius: 6, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <select value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }}>
        {BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
      </select>
      <input
        placeholder="Task label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        style={{ fontSize: 12, padding: '4px 8px', flex: 1, minWidth: 140 }}
      />
      <TeammatePicker teammates={teammates} value={teammateId} onChange={setTeammateId} />
      <button type="button" onClick={submit} disabled={saving} style={smallBtnStyle}>
        {saving ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={onClose} style={smallBtnStyle}>Cancel</button>
    </div>
  )
}

const smallBtnStyle = {
  padding: '4px 10px', fontSize: 12, borderRadius: 4,
  border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer',
}
const arrowBtnStyle = {
  padding: 0, width: 16, height: 14, fontSize: 8, lineHeight: '14px',
  border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)',
}
