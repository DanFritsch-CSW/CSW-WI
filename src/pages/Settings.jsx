import { useState, useEffect } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import { fetchFacilitySettings, upsertFacilitySettings } from '../lib/supabase.js'

// ── Labor Settings ────────────────────────────────────────────────
// Only Hours / Appt is user-configurable per facility.
// Shift start times and durations are now hardcoded constants in laborCalc.js.

const DEFAULTS = {
  hours_per_appt: 1.5,
}

function FacilitySettingsCard({ facility }) {
  const [hpa, setHpa]        = useState(DEFAULTS.hours_per_appt)
  const [saveState, setSave] = useState(null)

  useEffect(() => {
    fetchFacilitySettings(facility.id).then(data => {
      setHpa(data.hours_per_appt ?? DEFAULTS.hours_per_appt)
    })
  }, [facility.id])

  async function handleSave() {
    setSave('saving')
    try {
      await upsertFacilitySettings(facility.id, { hours_per_appt: hpa })
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
        <label className="settings-field" title="Labor hours required per appointment — drives the Labor Required calculation">
          <span className="settings-field-label">Hours / Appt</span>
          <input
            type="number"
            className="settings-field-input"
            value={hpa}
            min={0.1}
            max={10}
            step={0.1}
            onChange={e => setHpa(parseFloat(e.target.value))}
          />
        </label>
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

// ── Break Schedule Editor ─────────────────────────────────────────

const BREAK_DEFAULTS = [83, 100, 75, 100, 50, 100, 75, 100]

function BreakScheduleEditor() {
  const [facility, setFacility] = useState(FACILITY_LIST[0].id)
  const [values, setValues]     = useState(BREAK_DEFAULTS)
  const [saveState, setSave]    = useState(null)

  useEffect(() => {
    fetchFacilitySettings(facility).then(data => {
      setValues(BREAK_DEFAULTS.map((def, i) => data[`break_hour_${i + 1}`] ?? def))
    })
  }, [facility])

  function handleChange(i, raw) {
    const num = parseInt(raw, 10)
    setValues(prev => prev.map((v, j) => j === i ? (isNaN(num) ? v : Math.min(100, Math.max(0, num))) : v))
  }

  async function handleSave() {
    setSave('saving')
    const payload = Object.fromEntries(values.map((v, i) => [`break_hour_${i + 1}`, v]))
    try {
      await upsertFacilitySettings(facility, payload)
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  return (
    <div className="break-schedule-editor">
      <div className="break-schedule-controls">
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Warehouse</span>
          <select
            className="est-drops-select"
            value={facility}
            onChange={e => setFacility(e.target.value)}
          >
            {FACILITY_LIST.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="break-schedule-actions">
          <button
            className="settings-save-btn"
            onClick={handleSave}
            disabled={saveState === 'saving'}
          >
            {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save breaks'}
          </button>
          <button className="settings-save-btn" onClick={() => setValues(BREAK_DEFAULTS)}>
            Clear
          </button>
        </div>
      </div>
      <div className="break-schedule-grid">
        {values.map((v, i) => (
          <label key={i} className="break-schedule-cell">
            <span className="break-schedule-hour-label">Shift hour {i + 1}</span>
            <input
              type="number"
              className="est-drops-input"
              value={v}
              min={0}
              max={100}
              step={1}
              onChange={e => handleChange(i, e.target.value)}
            />
            <span className="break-schedule-pct-label">% availability</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────

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

      <div className="gold-line" style={{ margin: '28px 0 20px' }} />

      <div className="settings-page-header">
        <h2 className="settings-page-title">Employee Break Assumptions</h2>
        <p className="settings-page-sub">Set the % of employees available during each hour of their shift. Used to account for lunches, breaks, and startup time.</p>
      </div>
      <BreakScheduleEditor />
    </div>
  )
}
