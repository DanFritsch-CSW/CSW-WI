import { useState } from 'react'
import { upsertAssignment } from '../lib/supabase.js'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export default function AddTempModal({ facility, planDate, onAdd, onClose }) {
  const [name, setName]   = useState('')
  const [role, setRole]   = useState('')
  const [lane, setLane]   = useState('shift1')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    const employeeId = `temp_${crypto.randomUUID()}`
    const date       = planDate || todayISO()
    const assignment = {
      facility,
      employee_id:   employeeId,
      employee_name: name.trim(),
      role:          role.trim() || 'Temp',
      lane,
      plan_date:     date,
      is_temp:       true,
    }
    await upsertAssignment(assignment)
    onAdd({ id: employeeId, name: name.trim(), role: role.trim() || 'Temp', facility, is_temp: true, default_lane: lane })
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
          <label className="modal-label">
            Role <span className="modal-optional">(optional)</span>
            <input
              className="modal-input"
              value={role}
              onChange={e => setRole(e.target.value)}
              placeholder="e.g. Associate, Receiver…"
            />
          </label>
          <label className="modal-label">
            Starting lane
            <select className="modal-select" value={lane} onChange={e => setLane(e.target.value)}>
              <option value="shift1">1st Shift</option>
              <option value="mid">Mid Shift</option>
              <option value="shift2">2nd Shift</option>
              <option value="shift3">3rd Shift</option>
            </select>
          </label>
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
