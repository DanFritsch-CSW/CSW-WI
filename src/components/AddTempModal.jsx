import { useState } from 'react'
import { upsertAssignment } from '../lib/supabase.js'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function timeToDecimal(timeStr) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':').map(Number)
  if (isNaN(h)) return null
  return h + (m || 0) / 60
}

function laneFromStart(startDecimal) {
  if (startDecimal === null) return 'shift1'
  if (startDecimal >= 4  && startDecimal < 8)  return 'shift1'
  if (startDecimal >= 8  && startDecimal < 12) return 'mid'
  if (startDecimal >= 12 && startDecimal < 18) return 'shift2'
  if (startDecimal >= 18 || startDecimal < 4)  return 'shift3'
  return 'shift1'
}

function computeShiftHours(startStr, endStr) {
  const start = timeToDecimal(startStr)
  const end   = timeToDecimal(endStr)
  if (start === null || end === null) return null
  let hours = end - start
  if (hours <= 0) hours += 24
  return Math.round(hours * 100) / 100
}

export default function AddTempModal({ facility, planDate, onAdd, onClose }) {
  const [name,      setName]      = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime,   setEndTime]   = useState('')
  const [saving,    setSaving]    = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)

    const employeeId   = `temp_${crypto.randomUUID()}`
    const date         = planDate || todayISO()
    const startDecimal = timeToDecimal(startTime)
    const shiftHours   = computeShiftHours(startTime, endTime)
    const lane         = laneFromStart(startDecimal)

    const assignment = {
      facility,
      employee_id:   employeeId,
      employee_name: name.trim(),
      role:          'Temp',
      lane,
      plan_date:     date,
      is_temp:       true,
      shift_start:   startDecimal,
      shift_hours:   shiftHours,
    }

    await upsertAssignment(assignment)
    onAdd({
      id:           employeeId,
      name:         name.trim(),
      role:         'Temp',
      facility,
      is_temp:      true,
      default_lane: lane,
      shift_start:  startDecimal,
      shift_hours:  shiftHours,
    })
    setSaving(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Add Temp Employee</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-form">
          <label className="modal-label">
            Name <span className="modal-required">*</span>
            <input
              className="modal-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Full name"
              autoFocus
              required
            />
          </label>

          <div style={{ display: 'flex', gap: '12px' }}>
            <label className="modal-label" style={{ flex: 1 }}>
              Shift Start
              <input
                type="time"
                className="modal-input"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
              />
            </label>
            <label className="modal-label" style={{ flex: 1 }}>
              Shift End
              <input
                type="time"
                className="modal-input"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
              />
            </label>
          </div>

          <div className="modal-actions">
            <button type="button" className="modal-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="modal-btn-submit" disabled={saving || !name.trim()}>
              {saving ? 'Adding…' : 'Add to Roster'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
