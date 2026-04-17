import { useState, useEffect } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchFacilitySettings, upsertFacilitySettings } from '../lib/supabase.js'

const FIELD_DEFS = [
  { key: 'hours_per_appt', label: 'Hours / Appt',       min: 0.1, max: 10, step: 0.1, hint: 'Labor hours per appointment (used to calculate required labor)' },
  { key: 'break_pct',      label: 'Break %',             min: 0,   max: 50, step: 1,   hint: 'Capacity reduction per shift due to breaks & startup time' },
  { key: 'shift1_start',   label: '1st Shift Start (hr)', min: 0,   max: 23, step: 1,   hint: 'Default start hour for 1st shift employees (0–23) when no B2E schedule is on file' },
  { key: 'shift1_hours',   label: '1st Shift Hours',     min: 1,   max: 16, step: 0.5, hint: 'Duration of a first shift in hours' },
  { key: 'shift2_start',   label: '2nd Shift Start (hr)', min: 0,   max: 23, step: 1,   hint: 'Default start hour for 2nd shift employees (0–23) when no B2E schedule is on file' },
  { key: 'shift2_hours',   label: '2nd Shift Hours',     min: 1,   max: 16, step: 0.5, hint: 'Duration of a second shift in hours' },
]

const DEFAULTS = { hours_per_appt: 1.5, break_pct: 10, shift1_start: 5, shift1_hours: 8, shift2_start: 13, shift2_hours: 8 }

function FacilitySettingsCard({ facility }) {
  const [values, setValues]   = useState(DEFAULTS)
  const [saveState, setSave]  = useState(null) // null | 'saving' | 'ok' | 'error'

  useEffect(() => {
    fetchFacilitySettings(facility.id).then(data => {
      setValues({
        hours_per_appt: data.hours_per_appt ?? DEFAULTS.hours_per_appt,
        break_pct:      data.break_pct      ?? DEFAULTS.break_pct,
        shift1_start:   data.shift1_start   ?? DEFAULTS.shift1_start,
        shift1_hours:   data.shift1_hours   ?? DEFAULTS.shift1_hours,
        shift2_start:   data.shift2_start   ?? DEFAULTS.shift2_start,
        shift2_hours:   data.shift2_hours   ?? DEFAULTS.shift2_hours,
      })
    })
  }, [facility.id])

  function handleChange(key, raw) {
    const num = parseFloat(raw)
    setValues(prev => ({ ...prev, [key]: isNaN(num) ? raw : num }))
  }

  async function handleSave() {
    setSave('saving')
    try {
      await upsertFacilitySettings(facility.id, values)
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <span className="settings-facility-dot" style={{ background: facility.color }} />
        <span className="settings-facility-name">{facility.name}</span>
        <span className="settings-facility-code">{facility.code}</span>
      </div>
      <div className="settings-fields">
        {FIELD_DEFS.map(({ key, label, min, max, step, hint }) => (
          <label key={key} className="settings-field" title={hint}>
            <span className="settings-field-label">{label}</span>
            <input
              type="number"
              className="settings-field-input"
              value={values[key]}
              min={min}
              max={max}
              step={step}
              onChange={e => handleChange(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="settings-card-footer">
        <button
          className="settings-save-btn"
          onClick={handleSave}
          disabled={saveState === 'saving'}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export default function Settings() {
  return (
    <div className="page-content">
      <div className="settings-page-header">
        <h2 className="settings-page-title">Labor Planning Settings</h2>
        <p className="settings-page-sub">Per-facility parameters used to calculate labor requirements and availability.</p>
      </div>
      <div className="settings-grid">
        {FACILITY_LIST.map(f => (
          <FacilitySettingsCard key={f.id} facility={f} />
        ))}
      </div>
    </div>
  )
}
