import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function avatarColor(name) {
  const palette = ['#e07b4d','#4d9de0','#3dba7e','#d4b84a','#c084fc','#e05c5c','#4dc9e0']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}

function fmtHour(h) {
  const n    = ((h % 24) + 24) % 24
  const hr   = Math.floor(n)
  const mins = Math.round((n - hr) * 60)
  const disp = hr === 0 || hr === 12 ? 12 : hr % 12
  const suf  = hr < 12 ? 'am' : 'pm'
  return `${disp}:${String(mins).padStart(2, '0')}${suf}`
}

function fmtShift(start, hours) {
  if (start == null) return null
  const end = (start + (hours ?? 8)) % 24
  return `${fmtHour(start)} – ${fmtHour(end)}`
}

export default function EmployeeTile({ employee, assignment, laneSettings, onShiftChange, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: employee.id,
  })
  const [editing, setEditing]     = useState(false)
  const [editStart, setEditStart] = useState(0)
  const [editHours, setEditHours] = useState(8)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const color  = avatarColor(employee.name)
  const isTemp = !!employee.is_temp

  const effectiveStart = assignment?.shift_start ?? laneSettings?.defaultStart ?? null
  const effectiveHours = assignment?.shift_hours ?? laneSettings?.defaultHours ?? 8
  const shiftLabel     = fmtShift(effectiveStart, effectiveHours)

  function openEdit(e) {
    e.stopPropagation()
    setEditStart(effectiveStart ?? laneSettings?.defaultStart ?? 5)
    setEditHours(effectiveHours)
    setEditing(true)
  }

  function handleSave(e) {
    e.stopPropagation()
    onShiftChange?.(editStart, editHours)
    setEditing(false)
  }

  function handleCancel(e) {
    e.stopPropagation()
    setEditing(false)
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`emp-tile${isDragging ? ' dragging' : ''}${isTemp ? ' emp-temp' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="emp-avatar" style={{ background: color }}>
        {initials(employee.name)}
      </div>
      <div className="emp-info">
        <div className="emp-name">{employee.name}</div>
        <div className="emp-role">
          {isTemp && <span className="emp-temp-badge">TEMP</span>}
          {employee.role}
        </div>
        {editing ? (
          <div className="emp-shift-edit" onPointerDown={e => e.stopPropagation()}>
            <input
              type="number"
              className="emp-shift-input"
              value={editStart}
              min={0}
              max={23}
              title="Start hour (0–23)"
              onChange={e => setEditStart(Number(e.target.value))}
            />
            <span className="emp-shift-sep">+</span>
            <input
              type="number"
              className="emp-shift-input"
              value={editHours}
              min={1}
              max={16}
              step={0.5}
              title="Hours"
              onChange={e => setEditHours(Number(e.target.value))}
            />
            <button className="emp-shift-save"   onClick={handleSave}>✓</button>
            <button className="emp-shift-cancel" onClick={handleCancel}>✕</button>
          </div>
        ) : (
          shiftLabel && (
            <div
              className="emp-shift-label"
              onClick={openEdit}
              onPointerDown={e => e.stopPropagation()}
              title="Click to edit shift hours for today"
            >
              {shiftLabel}
            </div>
          )
        )}
      </div>
      {onDelete ? (
        <button
          className="emp-delete-btn"
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Remove temp employee"
          onPointerDown={e => e.stopPropagation()}
        >×</button>
      ) : (
        <svg className="drag-handle" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <rect x="2" y="2" width="2" height="2" rx="1"/>
          <rect x="6" y="2" width="2" height="2" rx="1"/>
          <rect x="2" y="5" width="2" height="2" rx="1"/>
          <rect x="6" y="5" width="2" height="2" rx="1"/>
          <rect x="2" y="8" width="2" height="2" rx="1"/>
          <rect x="6" y="8" width="2" height="2" rx="1"/>
        </svg>
      )}
    </div>
  )
}
