import { useState } from 'react'

// OtModal — asks for the number of extra hours to apply facility-wide for
// the viewed date, then hands it back to RosterBoard's handleApplyOt.
// See OT_LANE_DIRECTION in constants.js for which side of each lane's
// shift the extra time gets added to.
export default function OtModal({ onConfirm, onClose, submitting }) {
  const [hours, setHours] = useState('1')

  function handleSubmit(e) {
    e.preventDefault()
    const parsed = Number(hours)
    if (!parsed || parsed <= 0) return
    onConfirm(parsed)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Apply OT — Madison</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-form">
          <label className="modal-label">
            Extra hours for every active shift today
            <input
              className="modal-input"
              type="number"
              step="0.25"
              min="0.25"
              value={hours}
              onChange={e => setHours(e.target.value)}
              autoFocus
              required
            />
          </label>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            1st Shift / Mid stay later. 2nd Shift / 3rd Shift come in earlier.
            Applies to every employee currently in an active lane — PTO,
            Call-In, and Special Project are untouched.
          </div>

          <div className="modal-actions">
            <button type="button" className="modal-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="modal-btn-submit" disabled={submitting}>
              {submitting ? 'Applying…' : 'Apply to Everyone'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
