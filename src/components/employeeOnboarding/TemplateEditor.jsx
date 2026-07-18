import { useEffect, useState } from 'react'
import {
  fetchCurriculumValues, updateCurriculumValue,
  fetchCurriculumModules, addCurriculumModule, updateCurriculumModule, deleteCurriculumModule, swapCurriculumModuleOrder,
  fetchHrSettings, updateHrSettings,
} from '../../lib/employeeOnboardingTemplate.js'
import { MONTHS } from '../../lib/employeeOnboardingCurriculum.js'

// TemplateEditor — built 2026-07-18 per Tim/Eli feedback ("expose those
// different elements... so that I'm not the bottleneck. Love it. Eli owning
// small changes would be great."). Lets anyone edit the per-month values-
// discussion wording and the numbered training modules (title, bullets,
// objectives, resource link) without a code change. Mirrors the Customer
// Onboarding Template Editor's add/edit/delete/reorder pattern.
//
// Also hosts HR Settings (the Front conversation ID the "Notify HR" button
// posts to) — small enough not to need its own view.
export default function TemplateEditor({ onClose }) {
  const [values, setValues] = useState({})
  const [modules, setModules] = useState({ m1: [], m2: [], m3: [] })
  const [hrSettings, setHrSettings] = useState({ front_conversation_id: '', notify_enabled: false })
  const [loading, setLoading] = useState(true)

  const reload = () => {
    setLoading(true)
    Promise.all([fetchCurriculumValues(), fetchCurriculumModules(), fetchHrSettings()])
      .then(([v, m, hr]) => { setValues(v); setModules(m); setHrSettings(hr) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [])

  if (loading) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading template…</div>

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Manage Template</h3>
        <button type="button" onClick={onClose} style={smallBtnStyle}>← Back to employees</button>
      </div>

      {MONTHS.map(month => (
        <MonthTemplateSection
          key={month.key}
          month={month}
          valueRow={values[month.key]}
          onSaveValue={async (patch) => {
            setValues(prev => ({ ...prev, [month.key]: { ...prev[month.key], ...patch } }))
            await updateCurriculumValue(month.key, patch)
          }}
          moduleList={modules[month.key] || []}
          onAddModule={async (fields) => {
            const nextSort = (modules[month.key]?.at(-1)?.sortOrder ?? 0) + 1
            const row = await addCurriculumModule({ monthKey: month.key, ...fields, sortOrder: nextSort })
            setModules(prev => ({
              ...prev,
              [month.key]: [...prev[month.key], {
                key: row.module_key, id: row.id, code: row.code, title: row.title, bullets: row.bullets || [],
                objectives: row.objectives, resourceLink: row.resource_link, resourceLabel: row.resource_label, sortOrder: row.sort_order,
              }],
            }))
          }}
          onUpdateModule={async (id, patch) => {
            setModules(prev => ({
              ...prev,
              [month.key]: prev[month.key].map(m => m.id === id ? { ...m, ...patch } : m),
            }))
            const dbPatch = {}
            if ('title' in patch) dbPatch.title = patch.title
            if ('code' in patch) dbPatch.code = patch.code
            if ('bullets' in patch) dbPatch.bullets = patch.bullets
            if ('objectives' in patch) dbPatch.objectives = patch.objectives
            if ('resourceLink' in patch) dbPatch.resource_link = patch.resourceLink
            if ('resourceLabel' in patch) dbPatch.resource_label = patch.resourceLabel
            await updateCurriculumModule(id, dbPatch)
          }}
          onDeleteModule={async (id) => {
            if (!window.confirm('Delete this module? Past employees\u2019 completion records for it are kept but will no longer show in the checklist.')) return
            setModules(prev => ({ ...prev, [month.key]: prev[month.key].filter(m => m.id !== id) }))
            await deleteCurriculumModule(id)
          }}
          onReorder={async (idx, direction) => {
            const list = modules[month.key]
            const otherIdx = idx + direction
            if (otherIdx < 0 || otherIdx >= list.length) return
            const a = list[idx], b = list[otherIdx]
            const next = [...list]
            next[idx] = { ...b, sortOrder: a.sortOrder }
            next[otherIdx] = { ...a, sortOrder: b.sortOrder }
            next.sort((x, y) => x.sortOrder - y.sortOrder)
            setModules(prev => ({ ...prev, [month.key]: next }))
            await swapCurriculumModuleOrder(a, b)
          }}
        />
      ))}

      <div style={{ marginTop: 20, padding: 14, border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>HR Settings</div>
        <label style={labelStyle}>Front conversation ID to notify on "Send to HR"</label>
        <input
          defaultValue={hrSettings.front_conversation_id || ''}
          placeholder="cnv_xxxxx"
          onBlur={async (e) => {
            const v = e.target.value.trim() || null
            setHrSettings(prev => ({ ...prev, front_conversation_id: v }))
            await updateHrSettings({ front_conversation_id: v })
          }}
          style={inputStyle}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={!!hrSettings.notify_enabled}
            onChange={async (e) => {
              const v = e.target.checked
              setHrSettings(prev => ({ ...prev, notify_enabled: v }))
              await updateHrSettings({ notify_enabled: v })
            }}
          />
          Enable "Notify HR" button
        </label>
      </div>
    </div>
  )
}

function MonthTemplateSection({ month, valueRow, onSaveValue, moduleList, onAddModule, onUpdateModule, onDeleteModule, onReorder }) {
  const [showAdd, setShowAdd] = useState(false)

  return (
    <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{month.label}</div>

      <div style={{ padding: 10, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6, marginBottom: 10 }}>
        <label style={labelStyle}>Values-discussion title</label>
        <input
          defaultValue={valueRow?.title || ''}
          onBlur={(e) => onSaveValue({ title: e.target.value })}
          style={inputStyle}
        />
        <label style={labelStyle}>Bullets (one per line)</label>
        <textarea
          defaultValue={(valueRow?.bullets || []).join('\n')}
          onBlur={(e) => onSaveValue({ bullets: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
          style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
        />
      </div>

      {moduleList.map((mod, idx) => (
        <TemplateModuleRow
          key={mod.id}
          module={mod}
          isFirst={idx === 0}
          isLast={idx === moduleList.length - 1}
          onUpdate={(patch) => onUpdateModule(mod.id, patch)}
          onDelete={() => onDeleteModule(mod.id)}
          onMoveUp={() => onReorder(idx, -1)}
          onMoveDown={() => onReorder(idx, 1)}
        />
      ))}

      {showAdd ? (
        <AddModuleInline
          onCancel={() => setShowAdd(false)}
          onAdd={async (fields) => { await onAddModule(fields); setShowAdd(false) }}
        />
      ) : (
        <button type="button" onClick={() => setShowAdd(true)} style={smallBtnStyle}>+ Add module</button>
      )}
    </div>
  )
}

function TemplateModuleRow({ module, isFirst, isLast, onUpdate, onDelete, onMoveUp, onMoveDown }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ padding: '8px 10px', marginBottom: 6, background: 'var(--surface-2, #f8f8f8)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <button type="button" disabled={isFirst} onClick={onMoveUp} style={{ ...linkBtnStyle, opacity: isFirst ? 0.3 : 1 }}>▲</button>
          <button type="button" disabled={isLast} onClick={onMoveDown} style={{ ...linkBtnStyle, opacity: isLast ? 0.3 : 1 }}>▼</button>
        </div>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
          {module.code ? `${module.code} — ${module.title}` : module.title}
        </div>
        <button type="button" onClick={() => setExpanded(!expanded)} style={linkBtnStyle}>{expanded ? 'Collapse' : 'Edit'}</button>
        <button type="button" onClick={onDelete} style={{ ...linkBtnStyle, color: 'var(--danger, #dc2626)' }}>Delete</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              defaultValue={module.code || ''}
              placeholder="Code (optional, e.g. 112)"
              onBlur={(e) => onUpdate({ code: e.target.value.trim() || null })}
              style={{ ...inputStyle, width: 140 }}
            />
            <input
              defaultValue={module.title}
              placeholder="Title"
              onBlur={(e) => onUpdate({ title: e.target.value })}
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>
          <textarea
            defaultValue={(module.bullets || []).join('\n')}
            placeholder="Bullets (one per line)"
            onBlur={(e) => onUpdate({ bullets: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
            style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
          />
          <input
            defaultValue={module.objectives || ''}
            placeholder="Training objective (optional)"
            onBlur={(e) => onUpdate({ objectives: e.target.value.trim() || null })}
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              defaultValue={module.resourceLink || ''}
              placeholder="Resource link URL (optional)"
              onBlur={(e) => onUpdate({ resourceLink: e.target.value.trim() || null })}
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              defaultValue={module.resourceLabel || ''}
              placeholder="Resource label"
              onBlur={(e) => onUpdate({ resourceLabel: e.target.value.trim() || null })}
              style={{ ...inputStyle, width: 200 }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function AddModuleInline({ onCancel, onAdd }) {
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await onAdd({ code: code.trim() || null, title: title.trim(), bullets: [], objectives: null })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (optional)" style={{ ...inputStyle, width: 120 }} />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Module title" style={{ ...inputStyle, flex: 1 }} autoFocus />
      <button type="button" onClick={submit} disabled={saving || !title.trim()} style={smallBtnStyle}>{saving ? 'Adding…' : 'Add'}</button>
      <button type="button" onClick={onCancel} style={smallBtnStyle}>Cancel</button>
    </div>
  )
}

const smallBtnStyle = {
  padding: '4px 10px', fontSize: 12, borderRadius: 4,
  border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer',
}
const linkBtnStyle = {
  padding: '2px 6px', fontSize: 11, borderRadius: 4,
  border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--brand, #a07818)',
}
const labelStyle = { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, marginBottom: 4 }
const inputStyle = { width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)', boxSizing: 'border-box' }
