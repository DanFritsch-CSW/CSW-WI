import { useState, useEffect } from 'react'
import { saveSubmission, approveSubmission, getLookupOptionsWithIds } from '../../lib/schedulingApi.js'
import StatusBadge from './StatusBadge.jsx'
import ComboBox from './ComboBox.jsx'

// Ported from front_netlify_datex/src/components/ReviewModal.jsx (2026-08-03),
// verbatim aside from updated import paths.

function formatDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function TextField({ label, name, value, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        name={name}
        value={value}
        onChange={onChange}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 transition"
      />
    </div>
  )
}

export default function ReviewModal({ submission, onClose }) {
  const [edits, setEdits] = useState({
    warehouse: submission.warehouse || '',
    carrier: submission.carrier || '',
    type: submission.type || '',
    reference_number: submission.reference_number || '',
    scheduled_arrival: submission.scheduled_arrival || '',
    scheduled_departure: submission.scheduled_departure || '',
    scheduled_dock_door: submission.scheduled_dock_door || '',
    appointment_lookup_code: submission.appointment_lookup_code || '',
    owner: submission.owner || '',
    project: submission.project || '',
    notes: submission.notes || '',
  })

  const [carriers, setCarriers] = useState([])
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [approveWarning, setApproveWarning] = useState(null)
  const [approved, setApproved] = useState(false)

  useEffect(() => {
    getLookupOptionsWithIds('carriers', undefined, { topUsed: true })
      .then((pairs) => setCarriers(pairs.map((p) => p.name)))
      .catch(() => {})
  }, [])

  const handleChange = (e) => {
    const { name, value } = e.target
    setEdits((prev) => ({ ...prev, [name]: value }))
    setSaveSuccess(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveSubmission(submission.id, edits)
      setSaveSuccess(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleApprove = async () => {
    if (!window.confirm('Approve this submission and push to Datex?')) return
    setApproving(true)
    setError(null)
    setApproveWarning(null)
    try {
      const result = await approveSubmission(submission.id, null, Object.keys(edits).length ? edits : undefined)
      if (result.warning) {
        setApproveWarning(result.warning)
        setApproved(true)
      } else {
        onClose()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setApproving(false)
    }
  }

  const canApprove = submission.status === 'pending' || submission.status === 'failed'

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      tabIndex={-1}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Review Submission</h2>
            <StatusBadge status={submission.status} />
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-6 py-4 overflow-y-auto space-y-4">
          {/* Timestamps */}
          <div className="flex flex-wrap gap-4 text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            <span>Submitted: {formatDateTime(submission.created_at)}</span>
            {submission.datex_pushed_at && <span>Pushed to Datex: {formatDateTime(submission.datex_pushed_at)}</span>}
          </div>

          {/* Datex error (read-only) */}
          {submission.datex_error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              Datex error: {submission.datex_error}
            </div>
          )}

          {/* Editable fields */}
          <div className="grid grid-cols-2 gap-4">
            <ComboBox
              label="Carrier"
              fieldKey="carrier"
              value={edits.carrier}
              options={carriers}
              onChange={(_, value) => {
                setEdits((prev) => ({ ...prev, carrier: value }))
                setSaveSuccess(false)
              }}
            />
            <TextField label="Warehouse" name="warehouse" value={edits.warehouse} onChange={handleChange} />

            {/* Type select */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                name="type"
                value={edits.type}
                onChange={handleChange}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 transition bg-white"
              >
                <option value="">—</option>
                <option value="Inbound">Inbound</option>
                <option value="Inbound/Drop">Inbound/Drop</option>
                <option value="Inbound/Lump">Inbound/Lump</option>
                <option value="Inbound/Reload">Inbound/Reload</option>
                <option value="Inbound/Work-In">Inbound/Work-In</option>
                <option value="Outbound">Outbound</option>
                <option value="Outbound/Drop">Outbound/Drop</option>
                <option value="Outbound/Lump">Outbound/Lump</option>
                <option value="Outbound/Reload">Outbound/Reload</option>
                <option value="Outbound/Work-In">Outbound/Work-In</option>
              </select>
            </div>

            <TextField label="Reference #" name="reference_number" value={edits.reference_number} onChange={handleChange} />
            <TextField label="Scheduled Arrival" name="scheduled_arrival" value={edits.scheduled_arrival} onChange={handleChange} />
            <TextField label="Scheduled Departure" name="scheduled_departure" value={edits.scheduled_departure} onChange={handleChange} />
            <TextField label="Dock Door" name="scheduled_dock_door" value={edits.scheduled_dock_door} onChange={handleChange} />
            <TextField label="Appointment Code" name="appointment_lookup_code" value={edits.appointment_lookup_code} onChange={handleChange} />
            <TextField label="Owner / Customer" name="owner" value={edits.owner} onChange={handleChange} />
            <TextField label="Project / Short Name" name="project" value={edits.project} onChange={handleChange} />
          </div>

          {/* Notes (full width) */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <textarea
              name="notes"
              value={edits.notes}
              onChange={handleChange}
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 transition resize-none"
            />
          </div>

          {/* Feedback */}
          {error && <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          {saveSuccess && <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">Edits saved.</div>}
          {approved && approveWarning && (
            <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
              <span className="font-medium">Approved with warning:</span> {approveWarning}
            </div>
          )}
          {approved && !approveWarning && (
            <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
              Approved and pushed to Datex.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50 rounded-b-xl shrink-0">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
            {approved ? 'Close' : 'Cancel'}
          </button>
          <div className="flex gap-3">
            {!approved && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving…' : 'Save edits'}
              </button>
            )}
            {canApprove && !approved && (
              <button
                onClick={handleApprove}
                disabled={approving}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {approving ? 'Approving…' : 'Approve & Push'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
