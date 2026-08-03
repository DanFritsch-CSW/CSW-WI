import ComboBox from './ComboBox.jsx'
import { HOUR_OPTIONS, MINUTE_OPTIONS, parseTime24, buildTime24 } from '../../lib/pluginUtils.js'

// PluginLoadContainerTab — extracted from the 'loadContainer' branch of
// front_netlify_datex/src/views/PluginView.jsx (2026-08-03) as part of
// splitting that 125KB file into companion files. Pure presentational
// component — all state and handlers stay owned by the parent PluginView
// and are passed in as props, so no behavior changes from the original.

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

export default function PluginLoadContainerTab({
  contextType,
  conversationId,
  lcDraft,
  lcDraftRef,
  handleLcFieldChange,
  lookups,
  lookupsLoading,
  lcFilteredProjects,
  lcDockDoors,
  lcDockDoorsLoading,
  datexProcessing,
  lcApproved,
  lcApproveWarning,
  lcDraftCreated,
  lcApproveError,
  lcConfirming,
  setLcConfirming,
  lcApproving,
  handleLcPushClick,
  handleLcApprove,
  autoEmail,
  setAutoEmail,
}) {
  if (!conversationId) {
    return (
      <p className="mt-16 text-sm text-gray-400 text-center px-4 leading-relaxed">
        {contextType === 'noConversation'
          ? 'Open a conversation to create a load container appointment.'
          : contextType === 'multiConversations'
          ? 'Select a single conversation.'
          : 'Loading…'}
      </p>
    )
  }

  return (
    <div>
      <div className="mb-3 border border-gray-200 rounded-lg px-3 py-2 space-y-2">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Load Container</p>
        <EditableField label="Container Lookup Code" fieldKey="container_lookup_code" value={lcDraft.container_lookup_code ?? ''} onChange={handleLcFieldChange} />
      </div>

      <div className="mb-3 border border-gray-200 rounded-lg px-3 py-2 space-y-2">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Appointment</p>
        <div className="grid grid-cols-2 gap-2">
          <ComboBox small label="Warehouse" fieldKey="warehouse" value={lcDraft.warehouse ?? ''} options={lookups.warehouses} loading={lookupsLoading} onChange={handleLcFieldChange} />
          <ComboBox small label="Type" fieldKey="type" value={lcDraft.type ?? ''} options={lookups.types} loading={lookupsLoading} onChange={handleLcFieldChange} />
        </div>
        {lcDraft.type === 'Outbound/Drop' && <p className="text-xs text-amber-600">Email confirmation will show Ready Time (arrival + 2 hrs)</p>}
        <div className="grid grid-cols-2 gap-2">
          <ComboBox small label="Project" fieldKey="project" value={lcDraft.project ?? ''} options={lcFilteredProjects} loading={lookupsLoading} onChange={handleLcFieldChange} />
          <ComboBox small label="Owner" fieldKey="owner" value={lcDraft.owner ?? ''} options={lookups.owners} loading={lookupsLoading} onChange={handleLcFieldChange} />
        </div>
        <div className="grid grid-cols-[5fr_4fr_3fr] gap-1.5">
          <div>
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Arrival Date</label>
            <input
              type="date"
              value={(lcDraft.scheduled_arrival || '').split('T')[0]}
              onChange={(e) => {
                const time = (lcDraft.scheduled_arrival || '').includes('T') ? lcDraft.scheduled_arrival.split('T')[1] : ''
                handleLcFieldChange('scheduled_arrival', time ? `${e.target.value}T${time}` : e.target.value)
              }}
              className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5
                hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400
                bg-transparent focus:bg-white transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">Arrival Time</label>
            <div className="flex items-center border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-400 bg-transparent focus-within:bg-white transition-colors">
              {(() => {
                const timePart = (lcDraft.scheduled_arrival || '').includes('T') ? lcDraft.scheduled_arrival.split('T')[1] : ''
                const { h24, min } = parseTime24(timePart)
                const date = (lcDraft.scheduled_arrival || '').split('T')[0]
                return (
                  <>
                    <select
                      value={h24}
                      onChange={(e) => {
                        const t = buildTime24(e.target.value, '00')
                        if (t) handleLcFieldChange('scheduled_arrival', date ? `${date}T${t}` : t)
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
                        const cur = lcDraftRef.current.scheduled_arrival || ''
                        const curH24 = parseTime24(cur.includes('T') ? cur.split('T')[1] : '').h24 || '00'
                        const t = buildTime24(curH24, e.target.value)
                        if (t) handleLcFieldChange('scheduled_arrival', date ? `${date}T${t}` : t)
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
              value={lcDraft.appt_duration || '30'}
              onChange={(e) => handleLcFieldChange('appt_duration', e.target.value)}
              className="w-full text-xs text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5 hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-transparent focus:bg-white transition-colors cursor-pointer"
            >
              <option value="30">30 min</option>
              <option value="60">60 min</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <ComboBox small label="Dock Door" fieldKey="scheduled_dock_door" value={lcDraft.scheduled_dock_door ?? ''} options={lcDockDoors} loading={lcDockDoorsLoading} onChange={handleLcFieldChange} />
          <ComboBox small label="Carrier" fieldKey="carrier" value={lcDraft.carrier ?? ''} options={lookups.carriers} loading={lookupsLoading} onChange={handleLcFieldChange} />
        </div>
        <EditableField label="Reference #" fieldKey="reference_number" value={lcDraft.reference_number ?? ''} onChange={handleLcFieldChange} />
        <EditableField label="Appointment Code" fieldKey="appointment_lookup_code" value={lcDraft.appointment_lookup_code ?? ''} onChange={handleLcFieldChange} />
        <EditableField label="Notes" fieldKey="notes" value={lcDraft.notes ?? ''} onChange={handleLcFieldChange} />
      </div>

      {datexProcessing && (
        <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm flex items-start gap-2">
          <svg className="animate-spin h-4 w-4 shrink-0 mt-0.5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>
            <span className="font-semibold block">Submitted to Datex</span>
            <span className="text-xs text-blue-600">Push and draft creation run in the background — you can move to the next email now.</span>
          </span>
        </div>
      )}

      {lcApproved && !lcApproveWarning && (
        <div className="mb-3 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">Load container created and appointment pushed to Datex.</div>
      )}
      {lcApproveWarning && (
        <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-300 rounded-lg text-amber-800 text-sm">
          {lcApproved && <p className="font-medium">Approved — verify in Datex</p>}
          <p className={lcApproved ? 'mt-0.5 text-xs' : ''}>{lcApproveWarning}</p>
        </div>
      )}
      {lcDraftCreated && <div className="mb-3 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 font-medium">Draft reply created in Front.</div>}
      {lcApproveError && <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{lcApproveError}</div>}

      {!lcApproved &&
        !datexProcessing &&
        (lcConfirming ? (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-2">
            <p className="text-xs text-indigo-800 font-medium">Create load container and push appointment to Datex?</p>
            <div className="flex gap-2">
              <button
                onClick={handleLcApprove}
                disabled={lcApproving}
                className="flex-1 py-1.5 px-3 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {lcApproving ? 'Processing…' : 'Yes, create & push'}
              </button>
              <button
                onClick={() => setLcConfirming(false)}
                className="flex-1 py-1.5 px-3 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex flex-col items-center gap-1">
              <span className="text-xs text-gray-500 whitespace-nowrap">Auto Send Email</span>
              <button
                type="button"
                onClick={() => setAutoEmail((v) => !v)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${autoEmail ? 'bg-indigo-600' : 'bg-gray-300'}`}
                aria-pressed={autoEmail}
              >
                <span className="sr-only">Auto email</span>
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${autoEmail ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
            <button
              onClick={handleLcPushClick}
              disabled={lcApproving}
              className="flex-1 py-2.5 px-4 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {lcApproving ? 'Processing…' : 'Approve & Push to Datex'}
            </button>
          </div>
        ))}
    </div>
  )
}
