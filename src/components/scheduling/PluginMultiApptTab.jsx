import ComboBox from './ComboBox.jsx'
import { HOUR_OPTIONS, MINUTE_OPTIONS, parseTime24, buildTime24 } from '../../lib/pluginUtils.js'

// PluginMultiApptTab — extracted from the 'multi' branch of
// front_netlify_datex/src/views/PluginView.jsx (2026-08-03) as part of
// splitting that 125KB file into companion files. Pure presentational
// component — all state and handlers stay owned by the parent PluginView.

function EditableField({ label, fieldKey, value, onChange }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5
          hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400
          bg-transparent focus:bg-white transition-colors"
      />
    </div>
  )
}

export default function PluginMultiApptTab({
  contextType,
  conversationId,
  multiShared,
  handleMultiSharedChange,
  multiDrafts,
  setMultiDrafts,
  multiDraftsRef,
  handleMultiFieldChange,
  multiDockDoors,
  multiDockDoorsLoading,
  lookups,
  lookupsLoading,
  ownerProjectMap,
  multiResults,
  setMultiResults,
  multiDraftCreated,
  setMultiDraftCreated,
  multiApproveError,
  setMultiApproveError,
  multiConfirming,
  setMultiConfirming,
  multiApproving,
  handleMultiPushClick,
  handleApproveAll,
  buildEmptySlot,
}) {
  if (!conversationId) {
    return (
      <p className="mt-16 text-sm text-gray-400 text-center px-4 leading-relaxed">
        {contextType === 'noConversation' ? 'Open a conversation to schedule appointments.' : contextType === 'multiConversations' ? 'Select a single conversation.' : 'Loading…'}
      </p>
    )
  }

  return (
    <div>
      {/* Shared fields */}
      <div className="mb-3 border border-gray-200 rounded-lg px-3 py-2 space-y-2">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Shared for all appointments</p>
        <div className="grid grid-cols-2 gap-2">
          <ComboBox small label="Warehouse" fieldKey="warehouse" value={multiShared.warehouse} options={lookups.warehouses} loading={lookupsLoading} onChange={handleMultiSharedChange} />
          <ComboBox small label="Type" fieldKey="type" value={multiShared.type} options={lookups.types} loading={lookupsLoading} onChange={handleMultiSharedChange} />
        </div>
        {multiShared.type === 'Outbound/Drop' && <p className="text-xs text-amber-600">Email confirmation will show Ready Time (arrival + 2 hrs)</p>}
        <div className="grid grid-cols-2 gap-2">
          <ComboBox
            small
            label="Project"
            fieldKey="project"
            value={multiShared.project}
            options={(() => {
              if (!multiShared.owner || Object.keys(ownerProjectMap).length === 0) return lookups.projects
              const ownerProjects = ownerProjectMap[multiShared.owner.toLowerCase()]
              if (!ownerProjects?.length) return lookups.projects
              return ownerProjects
            })()}
            loading={lookupsLoading}
            onChange={handleMultiSharedChange}
          />
          <ComboBox small label="Owner" fieldKey="owner" value={multiShared.owner} options={lookups.owners} loading={lookupsLoading} onChange={handleMultiSharedChange} />
        </div>
        <p className="text-[10px] text-gray-400">Project &amp; Owner can be overridden per appointment below.</p>
      </div>

      {/* Per-appointment slots */}
      {multiDrafts.map((slotDraft, slotIdx) => (
        <div key={slotIdx} className="mb-3 border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-600">Appointment {slotIdx + 1}</span>
            {multiDrafts.length > 1 && (
              <button
                onClick={() => setMultiDrafts((prev) => prev.filter((_, j) => j !== slotIdx))}
                className="text-gray-400 hover:text-red-500 text-base leading-none transition-colors"
                title="Remove"
              >
                ×
              </button>
            )}
          </div>
          <div className="px-3 py-2 space-y-2">
            <div className="grid grid-cols-[5fr_4fr_3fr] gap-1.5">
              <div>
                <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Arrival Date</label>
                <input
                  type="date"
                  value={(slotDraft.scheduled_arrival || '').split('T')[0]}
                  onChange={(e) => {
                    const time = (slotDraft.scheduled_arrival || '').includes('T') ? slotDraft.scheduled_arrival.split('T')[1] : ''
                    handleMultiFieldChange(slotIdx, 'scheduled_arrival', time ? `${e.target.value}T${time}` : e.target.value)
                  }}
                  className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-transparent focus:bg-white transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Arrival Time</label>
                <div className="flex items-center border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-400 bg-transparent focus-within:bg-white transition-colors">
                  {(() => {
                    const timePart = (slotDraft.scheduled_arrival || '').includes('T') ? slotDraft.scheduled_arrival.split('T')[1] : ''
                    const { h24, min } = parseTime24(timePart)
                    const date = (slotDraft.scheduled_arrival || '').split('T')[0]
                    return (
                      <>
                        <select
                          value={h24}
                          onChange={(e) => {
                            const t = buildTime24(e.target.value, '00')
                            if (t) handleMultiFieldChange(slotIdx, 'scheduled_arrival', date ? `${date}T${t}` : t)
                          }}
                          className="flex-1 min-w-0 text-xs text-gray-900 bg-transparent focus:outline-none cursor-pointer"
                        >
                          <option value="">HH</option>
                          {HOUR_OPTIONS.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                        <span className="text-xs font-semibold text-gray-400 select-none px-0.5">:</span>
                        <select
                          value={min}
                          onChange={(e) => {
                            const cur = multiDraftsRef.current[slotIdx]?.scheduled_arrival || ''
                            const curH24 = parseTime24(cur.includes('T') ? cur.split('T')[1] : '').h24 || '00'
                            const t = buildTime24(curH24, e.target.value)
                            if (t) handleMultiFieldChange(slotIdx, 'scheduled_arrival', date ? `${date}T${t}` : t)
                          }}
                          className="w-12 text-xs text-gray-900 bg-transparent focus:outline-none cursor-pointer"
                        >
                          <option value="">MM</option>
                          {MINUTE_OPTIONS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </>
                    )
                  })()}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Dur.</label>
                <select
                  value={slotDraft.appt_duration || '30'}
                  onChange={(e) => handleMultiFieldChange(slotIdx, 'appt_duration', e.target.value)}
                  className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-transparent focus:bg-white transition-colors cursor-pointer"
                >
                  <option value="30">30 min</option>
                  <option value="60">60 min</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <ComboBox
                small
                label="Dock Door"
                fieldKey="scheduled_dock_door"
                value={slotDraft.scheduled_dock_door}
                options={multiDockDoors}
                loading={multiDockDoorsLoading}
                onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)}
              />
              <ComboBox small label="Carrier" fieldKey="carrier" value={slotDraft.carrier} options={lookups.carriers} loading={lookupsLoading} onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <ComboBox
                small
                label="Project"
                fieldKey="project"
                value={slotDraft.project}
                placeholder={multiShared.project ? `Shared: ${multiShared.project}` : 'Project'}
                options={(() => {
                  const owner = slotDraft.owner || multiShared.owner
                  if (!owner || Object.keys(ownerProjectMap).length === 0) return lookups.projects
                  const ownerProjects = ownerProjectMap[owner.toLowerCase()]
                  if (!ownerProjects?.length) return lookups.projects
                  return ownerProjects
                })()}
                loading={lookupsLoading}
                onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)}
              />
              <ComboBox
                small
                label="Owner"
                fieldKey="owner"
                value={slotDraft.owner}
                placeholder={multiShared.owner ? `Shared: ${multiShared.owner}` : 'Owner'}
                options={lookups.owners}
                loading={lookupsLoading}
                onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)}
              />
            </div>

            <EditableField label="Reference #" fieldKey="reference_number" value={slotDraft.reference_number} onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)} />
            <EditableField label="Appointment Code" fieldKey="appointment_lookup_code" value={slotDraft.appointment_lookup_code} onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)} />
            <EditableField label="Notes" fieldKey="notes" value={slotDraft.notes} onChange={(k, v) => handleMultiFieldChange(slotIdx, k, v)} />
          </div>
        </div>
      ))}

      {!multiResults && (
        <button
          onClick={() => setMultiDrafts((prev) => [...prev, buildEmptySlot()])}
          className="w-full py-2 px-4 mb-3 border border-dashed border-gray-300 text-gray-500 text-sm rounded-lg hover:border-indigo-300 hover:text-indigo-600 transition-colors"
        >
          + Add Appointment
        </button>
      )}

      {multiResults && (
        <div className="mb-3 space-y-1.5">
          {multiResults.map((r, i) => (
            <div key={i} className={`px-3 py-2 rounded-lg text-xs ${r.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
              <span className="font-medium">{r.ok ? '✓' : '✗'} Appt {i + 1}:</span> {r.ok ? r.lookup_code || '—' : r.error}
            </div>
          ))}
          {multiDraftCreated && <div className="px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 font-medium">Draft reply created in Front.</div>}
          {multiApproveError && <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">{multiApproveError}</div>}
          <button
            onClick={() => {
              setMultiResults(null)
              setMultiDraftCreated(false)
              setMultiApproveError(null)
              setMultiDrafts([buildEmptySlot()])
            }}
            className="w-full py-2 px-4 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Start Over
          </button>
        </div>
      )}

      {!multiResults && (
        <div className="space-y-2">
          {multiApproveError && <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs">{multiApproveError}</div>}
          {multiConfirming ? (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-2">
              <p className="text-xs text-indigo-800 font-medium">
                Create {multiDrafts.length} appointment{multiDrafts.length !== 1 ? 's' : ''} and push to Datex?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleApproveAll}
                  disabled={multiApproving}
                  className="flex-1 py-1.5 px-3 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {multiApproving ? 'Approving…' : 'Yes, approve all'}
                </button>
                <button
                  onClick={() => setMultiConfirming(false)}
                  className="flex-1 py-1.5 px-3 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleMultiPushClick}
              disabled={multiApproving || multiDrafts.length === 0}
              className="w-full py-2.5 px-4 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {multiApproving ? 'Approving…' : 'Approve All & Push to Datex'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
