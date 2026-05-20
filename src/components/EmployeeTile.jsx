import { useState, useEffect, useRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FACILITIES } from '../lib/constants.js'

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

function decToTimeStr(dec) {
  const norm = ((dec % 24) + 24) % 24
  const h = Math.floor(norm)
  const m = Math.round((norm - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function timeStrToDec(t) {
  const [h, m] = (t || '00:00').split(':').map(Number)
  return h + m / 60
}

function facilityCode(facId) {
  return FACILITIES[facId]?.code ?? facId?.toUpperCase() ?? '?'
}

// Time-off badge labels that come from the role field when seeded by B2E time-off
const TIME_OFF_LABELS = new Set(['PTO', 'FMLA', 'Unpaid', 'Bereave'])

export default function EmployeeTile({
  employee,
  assignment,
  laneSettings,
  onShiftChange,
  onDelete,
  onRecall,
  onSpecialProjectLabelChange,
  autoEditLabel,
  onAutoEditConsumed,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: employee.id,
  })
  const [editing, setEditing]     = useState(false)
  const [editStart, setEditStart] = useState('00:00')
  const [editEnd, setEditEnd]     = useState('00:00')

  // Special Project label editing state
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft]     = useState('')
  const labelInputRef = useRef(null)

  const style = { transform: CSS.Transform.toString(transform), transition }

  const color      = avatarColor(employee.name)
  const isTemp     = !!employee.is_temp
  const isOnLoan   = !!assignment?.on_loan_to
  const isFromLoan = !!assignment?.from_facility
  const isCarryover = !!employee.is_carryover || !!assignment?.is_carryover

  const currentLane = assignment?.lane ?? employee.default_lane
  const isSpecialProject = currentLane === 'specialProject'

  // Time-off badge: stored in role field when auto-placed in PTO lane by B2E sync
  const roleValue   = assignment?.role ?? employee.role
  const isTimeOff   = TIME_OFF_LABELS.has(roleValue)

  // Special Project label = role value when in specialProject lane
  const specialProjectLabel = isSpecialProject ? (roleValue || '') : ''

  // Auto-open label editor when employee is just dropped into Special Project
  useEffect(() => {
    if (autoEditLabel && isSpecialProject && !editingLabel) {
      setLabelDraft(specialProjectLabel)
      setEditingLabel(true)
      onAutoEditConsumed?.()
    }
  }, [autoEditLabel, isSpecialProject])

  // Focus the label input when it opens
  useEffect(() => {
    if (editingLabel && labelInputRef.current) {
      labelInputRef.current.focus()
      labelInputRef.current.select()
    }
  }, [editingLabel])

  const effectiveStart = assignment?.shift_start ?? laneSettings?.defaultStart ?? null
  const effectiveHours = assignment?.shift_hours ?? laneSettings?.defaultHours ?? 8
  const shiftLabel     = fmtShift(effectiveStart, effectiveHours)

  // End-time label for the carryover badge (renormalized start + tail hours)
  const carryoverEndLabel = isCarryover && effectiveStart != null
    ? fmtHour((Number(effectiveStart) + Number(effectiveHours ?? 0)) % 24)
    : null

  function openEdit(e) {
    e.stopPropagation()
    if (isCarryover) return
    const start = effectiveStart ?? laneSettings?.defaultStart ?? 5
    const end   = (start + effectiveHours) % 24
    setEditStart(decToTimeStr(start))
    setEditEnd(decToTimeStr(end))
    setEditing(true)
  }

  function handleSave(e) {
    e.stopPropagation()
    const startDec = timeStrToDec(editStart)
    let   endDec   = timeStrToDec(editEnd)
    let   hours    = endDec - startDec
    if (hours <= 0) hours += 24
    onShiftChange?.(startDec, Math.round(hours * 4) / 4)
    setEditing(false)
  }

  function handleCancel(e) {
    e.stopPropagation()
    setEditing(false)
  }

  function openLabelEdit(e) {
    e.stopPropagation()
    if (isCarryover) return
    setLabelDraft(specialProjectLabel)
    setEditingLabel(true)
  }

  function commitLabel() {
    onSpecialProjectLabelChange?.(employee.id, labelDraft.trim())
    setEditingLabel(false)
  }

  function cancelLabelEdit() {
    setLabelDraft(specialProjectLabel)
    setEditingLabel(false)
  }

  function handleLabelKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitLabel()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelLabelEdit()
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`emp-tile${
        isDragging        ? ' dragging'          : ''}${
        isTemp            ? ' emp-temp'          : ''}${
        isOnLoan          ? ' emp-on-loan'       : ''}${
        isFromLoan        ? ' emp-from-loan'     : ''}${
        isTimeOff         ? ' emp-time-off'      : ''}${
        isCarryover       ? ' emp-carryover'     : ''}${
        isSpecialProject  ? ' emp-special-project' : ''}`}
      title={employee.name}
      {...attributes}
      {...(isCarryover ? {} : listeners)}
    >
      <div className="emp-avatar" style={{ background: color, opacity: (isOnLoan || isCarryover) ? 0.45 : 0.9 }}>
        {initials(employee.name)}
      </div>
      <div className="emp-info">
        <div className="emp-name">{employee.name}</div>
        <div className="emp-role">
          {isTemp     && <span className="emp-temp-badge">TEMP</span>}
          {isCarryover && (
            <span className="emp-carryover-badge">↪ Until {carryoverEndLabel ?? '?'}</span>
          )}
          {isOnLoan   && <span className="emp-loan-badge emp-loan-badge--out">ON LOAN → {facilityCode(assignment.on_loan_to)}</span>}
          {isFromLoan && <span className="emp-loan-badge emp-loan-badge--in">FROM: {facilityCode(assignment.from_facility)}</span>}
          {isTimeOff  && !isOnLoan && !isFromLoan && !isSpecialProject && (
            <span className="emp-timeoff-badge">{roleValue}</span>
          )}
          {!isOnLoan && !isFromLoan && !isTimeOff && !isCarryover && !isSpecialProject && roleValue}
        </div>

        {/* Special Project label — optional, inline-editable */}
        {isSpecialProject && (
          editingLabel ? (
            <div className="emp-sp-edit" onPointerDown={e => e.stopPropagation()}>
              <input
                ref={labelInputRef}
                type="text"
                className="emp-sp-input"
                value={labelDraft}
                onChange={e => setLabelDraft(e.target.value)}
                onKeyDown={handleLabelKeyDown}
                onBlur={commitLabel}
                placeholder="e.g. Relabeling"
                maxLength={48}
              />
            </div>
          ) : (
            <div
              className={`emp-sp-label${specialProjectLabel ? '' : ' emp-sp-label--empty'}`}
              onClick={openLabelEdit}
              onPointerDown={e => e.stopPropagation()}
              title="Click to edit project note"
            >
              {specialProjectLabel || '+ add note'}
            </div>
          )
        )}

        {editing ? (
          <div className="emp-shift-edit" onPointerDown={e => e.stopPropagation()}>
            <input type="time" className="emp-shift-time" value={editStart} onChange={e => setEditStart(e.target.value)} />
            <span className="emp-shift-sep">–</span>
            <input type="time" className="emp-shift-time" value={editEnd}   onChange={e => setEditEnd(e.target.value)} />
            <button className="emp-shift-save"   onClick={handleSave}>✓</button>
            <button className="emp-shift-cancel" onClick={handleCancel}>✕</button>
          </div>
        ) : (
          shiftLabel && (
            <div
              className="emp-shift-label"
              onClick={openEdit}
              onPointerDown={e => e.stopPropagation()}
              title={isCarryover ? 'Carryover shift (read-only)' : 'Click to edit shift times'}
            >
              {shiftLabel}
            </div>
          )
        )}
      </div>
      {/* Action button: delete temp | recall loan | carryover icon | drag handle */}
      {onDelete ? (
        <button className="emp-delete-btn" onClick={e => { e.stopPropagation(); onDelete() }}
          title="Remove temp employee" onPointerDown={e => e.stopPropagation()}>×</button>
      ) : isOnLoan && onRecall ? (
        <button className="emp-delete-btn emp-recall-btn"
          onClick={e => { e.stopPropagation(); onRecall() }}
          title="Recall employee back from loan"
          onPointerDown={e => e.stopPropagation()}>↩</button>
      ) : isCarryover ? (
        <span className="emp-carryover-icon" title="Carryover from prior shift">↪</span>
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
