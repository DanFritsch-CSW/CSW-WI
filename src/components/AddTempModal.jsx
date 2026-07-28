import { useState } from 'react'
import { upsertAssignment } from '../lib/supabase.js'
import { CAL2_DOCK_MAP } from '../lib/constants.js'

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

// CAL-only: if the typed name matches a known CAL2_DOCK_MAP entry (e.g. a
// regular dock worker occasionally entered as a temp), pre-select the side
// that person normally works instead of leaving it on the default. Purely
// a convenience default — still fully overridable via the Side dropdown.
function dockMapSideForName(name) {
  const laneId = CAL2_DOCK_MAP[name.trim()]
  if (!laneId) return null
  return laneId.startsWith('side12') ? 'side12' : 'side35'
}

export default function AddTempModal({ facility, planDate, onAdd, onClose }) {
  const isCal = facility === 'cal'

  const [name,      setName]      = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime,   setEndTime]   = useState('')
  // CAL v2 splits every active lane into side12_*/side35_* (see
  // LANES_CAL2 in constants.js) — a temp with a plain 'shift1'/'mid'/
  // 'shift2'/'shift3' lane doesn't match any real CAL lane id, so it
  // silently never renders on the roster board (though it's still a
  // real row in roster_assignments, which is why hourly/staffed-count
  // views that read the table directly still saw it). Only relevant
  // for CAL; every other facility uses the plain lane ids as-is.
  const [side,      setSide]      = useState('side12')
  const [saving,    setSaving]    = useState(false)

  function handleNameChange(value) {
    setName(value)
    if (isCal) {
      const matchedSide = dockMapSideForName(value)
      if (matchedSide) setSide(matchedSide)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)

    const employeeId   = `temp_${crypto.randomUUID()}`
    const date         = planDate || todayISO()
    const startDecimal = timeToDecimal(startTime)
    const shiftHours   = computeShiftHours(startTime, endTime)
    const baseLane     = laneFromStart(startDecimal)
    const lane         = isCal ? `${side}_${baseLane}` : baseLane

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
              onChange={e => handleNameChange(e.target.value)}
              placeholder="Full name"
              autoFocus
              required
            />
          </label>

          {isCal && (
            <label className="modal-label">
              Side
              <select className="modal-select" value={side} onChange={e => setSide(e.target.value)}>
                <option value="side12">1-2 Side</option>
                <option value="side35">3.5 Side</option>
              </select>
            </label>
          )}

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
