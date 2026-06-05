import { useState, useEffect } from 'react'

function decToTimeStr(dec) {
  const norm = ((Number(dec) % 24) + 24) % 24
  const h = Math.floor(norm)
  const m = Math.round((norm - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function timeStrToDec(t) {
  const [h, m] = (t || '00:00').split(':').map(Number)
  return h + m / 60
}

/**
 * Modal for editing a single employee's custom break schedule.
 *
 * Props:
 *   employee       — { id, name, originalId? } (required)
 *   breakOverride  — existing override row from breaksMap, or null/undefined
 *   onSave(payload) — called with normalized payload (clock-decimal hours +
 *                     integer minutes); does NOT auto-close the modal
 *   onClear()       — only renders Clear button when breakOverride is truthy
 *   onCancel()      — close without saving
 *
 * All three break windows are required to save. Once saved, the override
 * applies to this employee on every date until cleared (no date scope).
 */
export default function BreakOverrideModal({ employee, breakOverride, onSave, onClear, onCancel }) {
  const [brk1Time,  setBrk1Time]  = useState('')
  const [brk1Min,   setBrk1Min]   = useState('15')
  const [lunchTime, setLunchTime] = useState('')
  const [lunchMin,  setLunchMin]  = useState('30')
  const [brk2Time,  setBrk2Time]  = useState('')
  const [brk2Min,   setBrk2Min]   = useState('15')

  // Seed inputs from existing override when modal opens (or breakOverride changes).
  useEffect(() => {
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
  }, [breakOverride])

  // ESC dismisses
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const saveEnabled = !!(brk1Time && lunchTime && brk2Time &&
    Number(brk1Min) > 0 && Number(lunchMin) > 0 && Number(brk2Min) > 0)

  function handleSave() {
    if (!saveEnabled) return
    onSave?.({
      firstBreakAt:        timeStrToDec(brk1Time),
      firstBreakMinutes:   Number(brk1Min),
      lunchAt:             timeStrToDec(lunchTime),
      lunchMinutes:        Number(lunchMin),
      secondBreakAt:       timeStrToDec(brk2Time),
      secondBreakMinutes:  Number(brk2Min),
    })
  }

  return (
    <div className="modal-overlay" onPointerDown={e => e.stopPropagation()}>
      <div className="modal-box modal-box--breaks">
        <div className="modal-header">
          <span className="modal-title">Break Schedule</span>
          <button className="modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="break-modal-subtitle">
          <strong>{employee.name}</strong>
          {breakOverride && <span className="break-modal-active-pill">Override Active</span>}
        </div>

        <div className="break-modal-form">
          <div className="break-modal-row">
            <span className="break-modal-row-label">First break</span>
            <input type="time" className="break-modal-time"
              value={brk1Time} onChange={e => setBrk1Time(e.target.value)} />
            <span className="break-modal-for">for</span>
            <input type="number" className="break-modal-min" min="1" max="120"
              value={brk1Min} onChange={e => setBrk1Min(e.target.value)} />
            <span className="break-modal-min-unit">min</span>
          </div>
          <div className="break-modal-row">
            <span className="break-modal-row-label">Lunch</span>
            <input type="time" className="break-modal-time"
              value={lunchTime} onChange={e => setLunchTime(e.target.value)} />
            <span className="break-modal-for">for</span>
            <input type="number" className="break-modal-min" min="1" max="120"
              value={lunchMin} onChange={e => setLunchMin(e.target.value)} />
            <span className="break-modal-min-unit">min</span>
          </div>
          <div className="break-modal-row">
            <span className="break-modal-row-label">Second break</span>
            <input type="time" className="break-modal-time"
              value={brk2Time} onChange={e => setBrk2Time(e.target.value)} />
            <span className="break-modal-for">for</span>
            <input type="number" className="break-modal-min" min="1" max="120"
              value={brk2Min} onChange={e => setBrk2Min(e.target.value)} />
            <span className="break-modal-min-unit">min</span>
          </div>
        </div>

        <div className="break-modal-help">
          All three break times are required. Once saved, this schedule applies to
          this employee on every date until cleared.
        </div>

        <div className="modal-actions break-modal-actions">
          {breakOverride && (
            <button className="modal-btn-clear" onClick={onClear} title="Remove override (use facility default)">
              Clear Override
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="modal-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="modal-btn-submit" onClick={handleSave} disabled={!saveEnabled}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
