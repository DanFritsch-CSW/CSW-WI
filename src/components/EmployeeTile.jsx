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
  breakOverride,
  onBreakSave,
  onBreakClear,
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

  // Break panel state
  const [breaksExpanded, setBreaksExpanded] = useState(false)
  const [brk1Time, setBrk1Time] = useState('')
  const [brk1Min, setBrk1Min]   = useState('15')
  const [lunchTime, setLunchTime] = useState('')
  const [lunchMin, setLunchMin]   = useState('30')
  const [brk2Time, setBrk2Time] = useState('')
  const [brk2Min, setBrk2Min]   = useState('15')

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

  // Break override availability — hidden for carryover (read-only)
  const hasBreakOverride = !!breakOverride
  const canEditBreaks    = !isCarryover && typeof onBreakSave === 'function'

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

  // When opening the break panel, seed inputs from existing override (or blank if none).
  useEffect(() => {
    if (breaksExpanded) {
      if (breakOverride) {
        setBrk1Time(decToTimeStr(breakOverride.first_break_at))
        setBrk1Min(String(breakOverride.first_break_minutes))
        setLunchTime(decToTimeStr(breakOverride.lunch_at))
        setLunchMin(String(breakOverride.lunch_minutes))
        setBrk2Time(decToTimeStr(breakOverride.second_break_at))
        setBrk2Min(String(breakOverride.second_break_minutes))
      } else {
        setBrk1Time(''); setBrk1Min('15')
        setLunchTime(''); setLunchMin('30')
        setBrk2Time(''); setBrk2Min('15')
      }
    }
  }, [breaksExpanded, breakOverride])

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

  function toggleBreaks(e) {
    e.stopPropagation()
    if (!canEditBreaks) return
    setBreaksExpanded(v => !v)
  }

  const breakSaveEnabled = !!(brk1Time && lunchTime && brk2Time &&
    Number(brk1Min) > 0 && Number(lunchMin) > 0 && Number(brk2Min) > 0)

  function handleBreakSave(e) {
    e.stopPropagation()
    if (!breakSaveEnabled) return
    onBreakSave?.(employee.id, {
      firstBreakAt:        timeStrToDec(brk1Time),
      firstBreakMinutes:   Number(brk1Min),
      lunchAt:             timeStrToDec(lunchTime),
      lunchMinutes:        Number(lunchMin),
      secondBreakAt:       timeStrToDec(brk2Time),
      secondBreakMinutes:  Number(brk2Min),
    })
    setBreaksExpanded(false)
  }

  function handleBreakClear(e) {
    e.stopPropagation()
    onBreakClear?.(employee.id)
    setBreaksExpanded(false)
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
        isSpecialProject  ? ' emp-special-project' : ''}${
        breaksExpanded    ? ' emp-tile-expanded' : ''}`}
      title={employee.name}
      {...attributes}
      {...(isCarryover ? {} : listeners)}
    >
      <div className="emp-tile-main">
        <div className="emp-avatar" style={{ background: color, opacity: (isOnLoan || isCarryover) ? 0.45 : 0.9 }}>
          {initials(employee.name)}
        </div>
        <div className="emp-info">
          <div className="emp-name">
            {employee.name}
            {hasBreakOverride && !breaksExpanded && (
              <span className="emp-break-badge" title="Custom break schedule">⏱</span>
            )}
          </div>
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
          <>
            {canEditBreaks && (
              <button
                className={`emp-break-chevron${breaksExpanded ? ' emp-break-chevron--open' : ''}${hasBreakOverride ? ' emp-break-chevron--active' : ''}`}
                onClick={toggleBreaks}
                onPointerDown={e => e.stopPropagation()}
                title={hasBreakOverride ? 'Custom break schedule (click to edit)' : 'Set custom break schedule'}
              >
                {breaksExpanded ? '▴' : '▾'}
              </button>
            )}
            <svg className="drag-handle" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="2" width="2" height="2" rx="1"/>
              <rect x="6" y="2" width="2" height="2" rx="1"/>
              <rect x="2" y="5" width="2" height="2" rx="1"/>
              <rect x="6" y="5" width="2" height="2" rx="1"/>
              <rect x="2" y="8" width="2" height="2" rx="1"/>
              <rect x="6" y="8" width="2" height="2" rx="1"/>
            </svg>
          </>
        )}
      </div>

      {/* Break override expansion panel */}
      {breaksExpanded && (
        <div className="emp-break-panel" onPointerDown={e => e.stopPropagation()}>
          <div className="emp-break-panel-title">
            Custom break schedule
            <span className="emp-break-panel-help">All three required</span>
          </div>
          <div className="emp-break-row">
            <span className="emp-break-row-label">First break</span>
            <input
              type="time"
              className="emp-break-time"
              value={brk1Time}
              onChange={e => setBrk1Time(e.target.value)}
            />
            <span className="emp-break-for">for</span>
            <input
              type="number"
              className="emp-break-min"
              min="1" max="120"
              value={brk1Min}
              onChange={e => setBrk1Min(e.target.value)}
            />
            <span className="emp-break-min-unit">min</span>
          </div>
          <div className="emp-break-row">
            <span className="emp-break-row-label">Lunch</span>
            <input
              type="time"
              className="emp-break-time"
              value={lunchTime}
              onChange={e => setLunchTime(e.target.value)}
            />
            <span className="emp-break-for">for</span>
            <input
              type="number"
              className="emp-break-min"
              min="1" max="120"
              value={lunchMin}
              onChange={e => setLunchMin(e.target.value)}
            />
            <span className="emp-break-min-unit">min</span>
          </div>
          <div className="emp-break-row">
            <span className="emp-break-row-label">Second break</span>
            <input
              type="time"
              className="emp-break-time"
              value={brk2Time}
              onChange={e => setBrk2Time(e.target.value)}
            />
            <span className="emp-break-for">for</span>
            <input
              type="number"
              className="emp-break-min"
              min="1" max="120"
              value={brk2Min}
              onChange={e => setBrk2Min(e.target.value)}
            />
            <span className="emp-break-min-unit">min</span>
          </div>
          <div className="emp-break-actions">
            <button
              className="emp-break-save"
              onClick={handleBreakSave}
              disabled={!breakSaveEnabled}
              title={breakSaveEnabled ? 'Save break override' : 'Fill all three break times'}
            >
              Save
            </button>
            {hasBreakOverride && (
              <button className="emp-break-clear" onClick={handleBreakClear} title="Remove override (use facility default)">
                Clear
              </button>
            )}
            <button className="emp-break-cancel" onClick={toggleBreaks}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
